import {
  DeliveryMarketplaceError,
  allowedDeliveryActions,
  mergeDeliveryStatus,
  type DeliveryCancellationReason,
  type DeliveryChannelKey,
  type DeliveryEvent,
  type DeliveryMarketplaceAdapter,
  type DeliveryOrder,
  type DeliveryOrderAction,
} from "./marketplace";

// Caixa de entrada única de pedidos de delivery. Um ciclo = buscar eventos de cada app, gravar, e só então
// confirmar (ack) o que foi gravado. Regras que valem para qualquer app:
//  - Ack só depois de gravar. Se a gravação falhar, o evento volta no próximo polling: pedido nunca some.
//  - Evento repetido (o app entrega "pelo menos uma vez") é reconhecido pelo id e não duplica pedido.
//  - Status só anda para frente; evento fora de ordem não desfaz o que já aconteceu.
//  - Falha num app não trava os outros.

export type DeliveryOrderRecord = {
  order: DeliveryOrder;
  cancellationPending: boolean;
  // Precisa de olho humano: avisos do pedido, status desconhecido, ação recusada pelo app.
  needsReview: boolean;
  reviewReasons: string[];
  // false até o aviso de pedido novo (cozinha, KDS, alerta) ter sido tentado. Fica gravado junto do pedido para
  // que uma falha entre salvar o pedido e salvar o evento não pule o aviso no reprocessamento.
  newOrderNotified: boolean;
  lastEventAt: string;
  updatedAt: string;
};

// Persistência. Em produção é o Supabase (tabelas delivery_orders / delivery_events em db/schema.sql).
export interface DeliveryRepository {
  hasEvent(channel: DeliveryChannelKey, externalEventId: string): Promise<boolean>;
  // Grava o evento no histórico; repetir o mesmo id não duplica (UNIQUE no banco).
  recordEvent(event: DeliveryEvent): Promise<void>;
  getOrder(channel: DeliveryChannelKey, externalOrderId: string): Promise<DeliveryOrderRecord | null>;
  saveOrder(record: DeliveryOrderRecord): Promise<void>;
  listOrders(): Promise<DeliveryOrderRecord[]>;
}

export class InMemoryDeliveryRepository implements DeliveryRepository {
  private readonly events = new Set<string>();
  private readonly orders = new Map<string, DeliveryOrderRecord>();

  async hasEvent(channel: DeliveryChannelKey, externalEventId: string): Promise<boolean> {
    return this.events.has(`${channel}:${externalEventId}`);
  }

  async recordEvent(event: DeliveryEvent): Promise<void> {
    this.events.add(`${event.channel}:${event.externalEventId}`);
  }

  async getOrder(channel: DeliveryChannelKey, externalOrderId: string): Promise<DeliveryOrderRecord | null> {
    const record = this.orders.get(`${channel}:${externalOrderId}`);
    return record ? structuredClone(record) : null;
  }

  async saveOrder(record: DeliveryOrderRecord): Promise<void> {
    this.orders.set(`${record.order.channel}:${record.order.externalId}`, structuredClone(record));
  }

  async listOrders(): Promise<DeliveryOrderRecord[]> {
    return [...this.orders.values()]
      .map((record) => structuredClone(record))
      .sort((a, b) => b.order.createdAt.localeCompare(a.order.createdAt));
  }
}

export type DeliveryCycleReport = {
  channel: DeliveryChannelKey;
  received: number;
  duplicates: number;
  acknowledged: number;
  newOrders: string[];
  // Eventos que ficaram sem ack e voltam no próximo ciclo.
  deferred: number;
  error: string | null;
};

export type DeliveryInboxOptions = {
  adapters: readonly DeliveryMarketplaceAdapter[];
  repository: DeliveryRepository;
  // Pedido novo gravado: imprimir na cozinha, tocar alerta, mandar para o KDS.
  onNewOrder?: (record: DeliveryOrderRecord) => void | Promise<void>;
  onOrderUpdated?: (record: DeliveryOrderRecord) => void | Promise<void>;
  now?: () => Date;
};

export class DeliveryInbox {
  private readonly adapters = new Map<DeliveryChannelKey, DeliveryMarketplaceAdapter>();
  private readonly now: () => Date;
  // Um ciclo por app por vez: polling sobreposto confirmaria eventos em dobro.
  private readonly running = new Set<DeliveryChannelKey>();

  constructor(private readonly options: DeliveryInboxOptions) {
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.channel)) throw new Error(`Adapter duplicado para ${adapter.channel}.`);
      this.adapters.set(adapter.channel, adapter);
    }
    this.now = options.now ?? (() => new Date());
  }

  async runCycle(): Promise<DeliveryCycleReport[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => this.runChannel(adapter)));
  }

  async runChannel(adapter: DeliveryMarketplaceAdapter): Promise<DeliveryCycleReport> {
    const report: DeliveryCycleReport = {
      channel: adapter.channel,
      received: 0,
      duplicates: 0,
      acknowledged: 0,
      newOrders: [],
      deferred: 0,
      error: null,
    };
    if (this.running.has(adapter.channel)) return report;
    this.running.add(adapter.channel);
    try {
      const events = await adapter.pollEvents();
      report.received = events.length;
      // Ordem cronológica: PLC antes de CFM do mesmo pedido.
      const ordered = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const toAck: DeliveryEvent[] = [];
      for (const event of ordered) {
        try {
          const outcome = await this.applyEvent(adapter, event);
          if (outcome === "duplicate") report.duplicates += 1;
          if (outcome === "new_order") report.newOrders.push(event.externalOrderId);
          toAck.push(event);
        } catch (error) {
          // Não confirma: o app reenvia e tentamos de novo no próximo ciclo.
          report.deferred += 1;
          report.error = describe(error);
        }
      }
      if (toAck.length > 0) {
        await adapter.acknowledge(toAck);
        report.acknowledged = toAck.length;
      }
    } catch (error) {
      report.error = describe(error);
    } finally {
      this.running.delete(adapter.channel);
    }
    return report;
  }

  async listOrders(): Promise<DeliveryOrderRecord[]> {
    return this.options.repository.listOrders();
  }

  async performAction(channel: DeliveryChannelKey, externalOrderId: string, action: DeliveryOrderAction): Promise<DeliveryOrderRecord> {
    const adapter = this.adapter(channel);
    const record = await this.requireOrder(channel, externalOrderId);
    if (!allowedDeliveryActions(record.order, record.cancellationPending).includes(action)) {
      throw new DeliveryMarketplaceError(channel, "conflict", `Ação "${action}" não é permitida com o pedido em "${record.order.status}".`);
    }
    await adapter.performAction(externalOrderId, action);
    // O status oficial chega pelo evento do app; aqui só registramos a tentativa para a tela.
    record.updatedAt = this.now().toISOString();
    await this.options.repository.saveOrder(record);
    return record;
  }

  async listCancellationReasons(channel: DeliveryChannelKey, externalOrderId: string): Promise<DeliveryCancellationReason[]> {
    return this.adapter(channel).listCancellationReasons(externalOrderId);
  }

  async requestCancellation(
    channel: DeliveryChannelKey,
    externalOrderId: string,
    reason: DeliveryCancellationReason,
    details?: string,
  ): Promise<DeliveryOrderRecord> {
    const adapter = this.adapter(channel);
    const record = await this.requireOrder(channel, externalOrderId);
    if (["concluded", "cancelled"].includes(record.order.status)) {
      throw new DeliveryMarketplaceError(channel, "conflict", "Pedido já finalizado não pode ser cancelado.");
    }
    await adapter.requestCancellation(externalOrderId, reason, details);
    record.cancellationPending = true;
    record.updatedAt = this.now().toISOString();
    await this.options.repository.saveOrder(record);
    return record;
  }

  // -------------------------------------------------------------------------

  private adapter(channel: DeliveryChannelKey): DeliveryMarketplaceAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new DeliveryMarketplaceError(channel, "invalid_request", `App ${channel} não está ligado nesta loja.`);
    return adapter;
  }

  private async requireOrder(channel: DeliveryChannelKey, externalOrderId: string): Promise<DeliveryOrderRecord> {
    const record = await this.options.repository.getOrder(channel, externalOrderId);
    if (!record) throw new DeliveryMarketplaceError(channel, "not_found", `Pedido ${externalOrderId} não está na caixa de entrada.`);
    return record;
  }

  private async applyEvent(
    adapter: DeliveryMarketplaceAdapter,
    event: DeliveryEvent,
  ): Promise<"duplicate" | "new_order" | "updated"> {
    const repository = this.options.repository;
    let record = await repository.getOrder(event.channel, event.externalOrderId);
    if (record && (await repository.hasEvent(event.channel, event.externalEventId))) return "duplicate";
    if (!record) {
      // Primeiro evento deste pedido (normalmente "placed", mas pode ser qualquer um se o PDV ficou fora do ar):
      // busca o detalhe antes de gravar qualquer coisa, para que uma falha aqui deixe o evento sem ack.
      const order = await adapter.getOrder(event.externalOrderId);
      record = {
        order,
        cancellationPending: false,
        needsReview: order.warnings.length > 0,
        reviewReasons: [...order.warnings],
        newOrderNotified: false,
        lastEventAt: event.createdAt,
        updatedAt: this.now().toISOString(),
      };
    }
    const isNew = !record.newOrderNotified;

    // Pedido primeiro, histórico depois: se cair entre os dois, o evento é reprocessado, e aplicar o mesmo
    // evento duas vezes dá o mesmo resultado (status só anda para frente).
    applySignal(record, event);
    record.updatedAt = this.now().toISOString();
    await repository.saveOrder(record);
    await repository.recordEvent(event);

    // Falha no aviso (impressora, KDS) não desfaz o pedido gravado: vira pendência para o lojista.
    const notify = isNew ? this.options.onNewOrder : this.options.onOrderUpdated;
    try {
      await notify?.(record);
    } catch (error) {
      flag(record, `Aviso do pedido falhou (${describe(error)}): confira impressão e KDS.`);
    }
    if (isNew) record.newOrderNotified = true;
    if (isNew || record.needsReview) await repository.saveOrder(record);
    return isNew ? "new_order" : "updated";
  }
}

function applySignal(record: DeliveryOrderRecord, event: DeliveryEvent): void {
  if (event.createdAt > record.lastEventAt) record.lastEventAt = event.createdAt;
  switch (event.signal) {
    case "cancellation_requested":
      record.cancellationPending = true;
      return;
    case "cancellation_denied":
      record.cancellationPending = false;
      flag(record, "O app recusou o pedido de cancelamento: o pedido segue valendo.");
      return;
    case "unknown":
      // Códigos que não mexem no status (handshake, entregador chegando...) ficam só no histórico.
      return;
    default: {
      const before = record.order.status;
      record.order.status = mergeDeliveryStatus(before, event.signal);
      if (record.order.status === "cancelled") {
        record.cancellationPending = false;
        if (before !== "cancelled" && before !== "placed") {
          flag(record, "Pedido cancelado pelo app depois de aceito: confira se já foi preparado ou impresso.");
        }
      }
    }
  }
}

function flag(record: DeliveryOrderRecord, reason: string): void {
  record.needsReview = true;
  if (!record.reviewReasons.includes(reason)) record.reviewReasons.push(reason);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
