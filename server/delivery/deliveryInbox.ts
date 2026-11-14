import {
  DeliveryMarketplaceError,
  allowedDeliveryActions,
  mergeDeliveryStatus,
  type DeliveryCancellationReason,
  type DeliveryChannelKey,
  type DeliveryDispute,
  type DeliveryDisputeDecision,
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
  // Horário do último evento de cancelamento (pedido/recusa) aplicado; evento mais antigo que ele é ignorado.
  lastCancellationEventAt: string | null;
  lastEventAt: string;
  updatedAt: string;
  // Negociação aberta pelo app esperando resposta da loja (null = nenhuma). respondedAt preenchido = a loja já
  // respondeu e aguarda o app fechar (evento "dispute_settled").
  dispute: (DeliveryDispute & { openedAt: string; respondedAt: string | null; response?: DeliveryDisputeResponse | null }) | null;
  // Versão da gravação (controle otimista): 0 = pedido ainda não gravado. Quem grava com versão velha recebe
  // DeliveryConcurrencyError e precisa reler; assim dois processos (polling e ação da tela) nunca se sobrescrevem.
  version: number;
};

// Resposta da loja a uma negociação, reservada ANTES da chamada ao app: só uma resposta por negociação chega ao
// app, mesmo com dois pedidos ao mesmo tempo ou com o banco falhando depois que o app aceitou.
//   sending   reservada, chamada em andamento (ou o processo caiu no meio: tratada como incerta)
//   sent      o app aceitou a resposta; falta o evento que fecha a negociação
//   uncertain a chamada falhou sem resposta clara (rede, 5xx): pode ter chegado; só o evento do app (ou o prazo)
//             resolve, nunca uma nova tentativa
export type DeliveryDisputeResponse = {
  decision: DeliveryDisputeDecision;
  state: "sending" | "sent" | "uncertain";
  reservedAt: string;
};

export class DeliveryConcurrencyError extends Error {
  constructor(readonly channel: DeliveryChannelKey, readonly externalOrderId: string) {
    super(`Pedido ${externalOrderId} foi alterado por outro processo; tente de novo.`);
    this.name = "DeliveryConcurrencyError";
  }
}

// Persistência. Em produção é o Supabase (tabelas delivery_orders / delivery_events em db/schema.sql).
export interface DeliveryRepository {
  hasEvent(channel: DeliveryChannelKey, externalEventId: string): Promise<boolean>;
  // Grava o evento no histórico; repetir o mesmo id não duplica (UNIQUE no banco).
  recordEvent(event: DeliveryEvent): Promise<void>;
  getOrder(channel: DeliveryChannelKey, externalOrderId: string): Promise<DeliveryOrderRecord | null>;
  // Grava só se a versão gravada ainda for record.version (0 = inserir); devolve a nova versão. Versão diferente
  // = DeliveryConcurrencyError, sem gravar nada.
  saveOrder(record: DeliveryOrderRecord): Promise<number>;
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

  async saveOrder(record: DeliveryOrderRecord): Promise<number> {
    const key = `${record.order.channel}:${record.order.externalId}`;
    const storedVersion = this.orders.get(key)?.version ?? 0;
    if (storedVersion !== record.version) throw new DeliveryConcurrencyError(record.order.channel, record.order.externalId);
    const version = storedVersion + 1;
    this.orders.set(key, { ...structuredClone(record), version });
    return version;
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
  // Eventos confirmados sem pedido que não deu para ler (ids, para o log do servidor investigar).
  discarded: string[];
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

// Falhas em que o app com certeza não aplicou o pedido.
const DEFINITE_FAILURES: readonly string[] = ["invalid_request", "not_found", "conflict", "auth_failed", "rate_limited"];

export class DeliveryInbox {
  private readonly adapters = new Map<DeliveryChannelKey, DeliveryMarketplaceAdapter>();
  private readonly now: () => Date;
  // Um ciclo por app por vez: polling sobreposto confirmaria eventos em dobro.
  private readonly running = new Set<DeliveryChannelKey>();
  private readonly orderLocks = new Map<string, Promise<void>>();

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
      discarded: [],
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
      // Pedido com evento que falhou neste ciclo: os eventos seguintes dele também ficam sem ack, para voltarem
      // juntos e na ordem (ex.: HSD que falhou não pode ser aplicado depois do HSS que fecha a negociação).
      const blockedOrders = new Set<string>();
      for (const event of ordered) {
        // Evento sem pedido (ou que não deu para ler): confirmado e ignorado, senão volta para sempre no polling.
        if (!event.externalOrderId) {
          if (event.malformed) report.discarded.push(`${event.externalEventId} (${event.rawCode})`);
          toAck.push(event);
          continue;
        }
        if (blockedOrders.has(event.externalOrderId)) {
          report.deferred += 1;
          continue;
        }
        try {
          const outcome = await this.applyEvent(adapter, event);
          if (outcome === "duplicate") report.duplicates += 1;
          if (outcome === "new_order") report.newOrders.push(event.externalOrderId);
          toAck.push(event);
        } catch (error) {
          // Não confirma: o app reenvia e tentamos de novo no próximo ciclo.
          blockedOrders.add(event.externalOrderId);
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
    // O status oficial chega pelo evento do app; nada é gravado aqui, para que a resposta da ação nunca
    // sobrescreva um evento processado pelo polling enquanto a chamada estava em andamento.
    return this.requireOrder(channel, externalOrderId);
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
    if (record.cancellationPending) {
      throw new DeliveryMarketplaceError(channel, "conflict", "O cancelamento já foi pedido; aguarde a resposta do app.");
    }
    const cancellationSeenBefore = record.lastCancellationEventAt;
    await adapter.requestCancellation(externalOrderId, reason, details);
    // Relê o pedido depois da resposta: o polling pode ter gravado eventos (até o próprio cancelamento) enquanto
    // a chamada estava em andamento, e a foto lida antes não pode sobrescrever isso.
    return this.updateOrder(channel, externalOrderId, (latest) => {
      // Se o polling aplicou algum evento de cancelamento (recusa ou confirmação) durante a chamada, ele manda.
      const cancellationAdvanced = latest.lastCancellationEventAt !== cancellationSeenBefore;
      if (cancellationAdvanced || latest.order.status === "cancelled" || latest.order.status === "concluded") return false;
      latest.cancellationPending = true;
      return true;
    });
  }

  // Resposta da loja a uma negociação aberta pelo app (cliente pediu cancelamento, reembolso...). A resposta é
  // reservada no pedido (gravação com versão) antes de chamar o app: duas respostas ao mesmo tempo, ou uma nova
  // tentativa depois de uma resposta incerta, não chegam ao app.
  async respondToDispute(channel: DeliveryChannelKey, externalOrderId: string, decision: DeliveryDisputeDecision): Promise<DeliveryOrderRecord> {
    const adapter = this.adapter(channel);
    const reservedAt = this.now().toISOString();
    let disputeId = "";
    await this.updateOrder(channel, externalOrderId, (latest) => {
      const dispute = latest.dispute;
      if (!dispute) throw new DeliveryMarketplaceError(channel, "conflict", "Este pedido não tem negociação aberta.");
      if (dispute.respondedAt || dispute.response) {
        throw new DeliveryMarketplaceError(
          channel,
          "conflict",
          dispute.response?.state === "sent" || dispute.respondedAt
            ? "A negociação já foi respondida; aguarde o app."
            : "Já existe uma resposta em andamento ou sem confirmação; aguarde o app fechar a negociação.",
        );
      }
      if (dispute.expiresAt && Date.parse(dispute.expiresAt) <= this.now().getTime()) {
        throw new DeliveryMarketplaceError(channel, "conflict", "O prazo da negociação acabou; o app aplica a decisão padrão.");
      }
      if (decision.kind === "alternative" && !dispute.alternatives.some((alternative) => alternative.id === decision.alternativeId)) {
        throw new DeliveryMarketplaceError(channel, "invalid_request", "Proposta não pertence a esta negociação.");
      }
      disputeId = dispute.id;
      dispute.response = { decision, state: "sending", reservedAt };
      return true;
    });
    // Só mexe na reserva desta resposta: se o app fechou ou trocou a negociação no meio, o evento manda.
    const ours = (latest: DeliveryOrderRecord) =>
      latest.dispute && latest.dispute.id === disputeId && latest.dispute.response?.reservedAt === reservedAt ? latest.dispute : null;
    try {
      await adapter.respondToDispute(disputeId, decision);
    } catch (error) {
      // Recusa clara do app (4xx, limite de uso): nada foi aplicado e a reserva é desfeita. Qualquer outra falha
      // (rede, 5xx, prazo) pode ter chegado: fica "incerta" e bloqueia novas tentativas.
      const definite = error instanceof DeliveryMarketplaceError && DEFINITE_FAILURES.includes(error.code);
      await this.updateOrder(channel, externalOrderId, (latest) => {
        const dispute = ours(latest);
        if (!dispute) return false;
        if (definite) dispute.response = null;
        else dispute.response = { ...dispute.response!, state: "uncertain" };
        return true;
      }).catch(() => undefined);
      throw error;
    }
    return this.updateOrder(channel, externalOrderId, (latest) => {
      const dispute = ours(latest);
      if (!dispute) return false;
      dispute.response = { ...dispute.response!, state: "sent" };
      dispute.respondedAt = this.now().toISOString();
      return true;
    });
  }

  // -------------------------------------------------------------------------

  // Relê, altera e grava com controle de versão; se outro processo gravou no meio, relê e tenta de novo.
  // change devolve false quando não há nada a gravar.
  private async updateOrder(
    channel: DeliveryChannelKey,
    externalOrderId: string,
    change: (record: DeliveryOrderRecord) => boolean,
  ): Promise<DeliveryOrderRecord> {
    return this.withOrderLock(channel, externalOrderId, async () => {
      for (let attempt = 0; ; attempt += 1) {
        const latest = await this.requireOrder(channel, externalOrderId);
        if (!change(latest)) return latest;
        latest.updatedAt = this.now().toISOString();
        try {
          latest.version = await this.options.repository.saveOrder(latest);
          return latest;
        } catch (error) {
          if (!(error instanceof DeliveryConcurrencyError) || attempt >= 4) throw error;
        }
      }
    });
  }

  // Serializa leitura-alteração-gravação de um mesmo pedido dentro deste processo.
  private async withOrderLock<T>(channel: DeliveryChannelKey, externalOrderId: string, work: () => Promise<T>): Promise<T> {
    const key = `${channel}:${externalOrderId}`;
    const previous = this.orderLocks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.orderLocks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.orderLocks.get(key) === tail) this.orderLocks.delete(key);
    }
  }

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
    return this.withOrderLock(event.channel, event.externalOrderId, () => this.applyEventLocked(adapter, event));
  }

  private async applyEventLocked(
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
        lastCancellationEventAt: null,
        lastEventAt: event.createdAt,
        updatedAt: this.now().toISOString(),
        dispute: null,
        version: 0,
      };
    }
    const isNew = !record.newOrderNotified;

    // Ordem: pedido gravado, aviso, resultado do aviso gravado e, por último, o evento no histórico. Se qualquer
    // passo falhar, o evento fica sem ack e é reprocessado inteiro; aplicar o mesmo evento de novo dá o mesmo
    // status (só anda para frente). O aviso pode repetir nesse caso, mas nunca se perde.
    applySignal(record, event);
    record.updatedAt = this.now().toISOString();
    // Conflito de versão (outro processo gravou o pedido no meio) sobe como erro: o evento fica sem ack e é
    // reaplicado no próximo ciclo em cima do pedido atualizado.
    record.version = await repository.saveOrder(record);

    // Falha no aviso (impressora, KDS) não desfaz o pedido gravado: vira pendência para o lojista.
    const notify = isNew ? this.options.onNewOrder : this.options.onOrderUpdated;
    try {
      await notify?.(record);
    } catch (error) {
      flag(record, `Aviso do pedido falhou (${describe(error)}): confira impressão e KDS.`);
    }
    if (isNew) record.newOrderNotified = true;
    if (isNew || record.needsReview) record.version = await repository.saveOrder(record);
    await repository.recordEvent(event);
    return isNew ? "new_order" : "updated";
  }
}

function applySignal(record: DeliveryOrderRecord, event: DeliveryEvent): void {
  if (event.createdAt > record.lastEventAt) record.lastEventAt = event.createdAt;
  const isCancellationSignal = event.signal === "cancellation_requested" || event.signal === "cancellation_denied";
  if (isCancellationSignal) {
    // Evento de cancelamento atrasado (ex.: o pedido chegando depois da recusa) não reabre nada.
    if (record.lastCancellationEventAt !== null && event.createdAt < record.lastCancellationEventAt) return;
    record.lastCancellationEventAt = event.createdAt;
  }
  switch (event.signal) {
    case "cancellation_requested":
      if (record.order.status !== "cancelled" && record.order.status !== "concluded") record.cancellationPending = true;
      return;
    case "cancellation_denied":
      record.cancellationPending = false;
      flag(record, "O app recusou o pedido de cancelamento: o pedido segue valendo.");
      return;
    case "customer_cancellation_requested":
      if (record.order.status !== "cancelled" && record.order.status !== "concluded") {
        flag(record, "O cliente pediu o cancelamento pelo app: confira a negociação ou o Portal do Parceiro.");
      }
      return;
    case "customer_cancellation_accepted":
    case "customer_cancellation_denied":
      // O resultado vale pelo status: se aceito, o evento "cancelled" chega em seguida.
      return;
    case "dispute_opened":
      if (record.order.status === "cancelled" || record.order.status === "concluded") return;
      if (!event.dispute) {
        flag(record, "O app abriu uma negociação sem identificação: responda pelo Portal do Parceiro.");
        return;
      }
      // Negociação repetida (mesmo id) não apaga a resposta já dada.
      if (record.dispute?.id === event.dispute.id) return;
      record.dispute = { ...event.dispute, openedAt: event.createdAt, respondedAt: null, response: null };
      flag(
        record,
        `O cliente abriu uma negociação${event.dispute.action ? ` (${event.dispute.action})` : ""}: responda${event.dispute.expiresAt ? ` até ${event.dispute.expiresAt}` : " logo"}, senão o app decide sozinho.`,
      );
      return;
    case "dispute_settled":
      record.dispute = null;
      return;
    case "unknown":
      // Códigos que não mexem no status (entregador chegando, troca de endereço...) ficam só no histórico.
      // Evento que não deu para ler é diferente: pode ser um cancelamento ou uma negociação.
      if (event.malformed) {
        flag(record, `Chegou um evento do app que não deu para ler (código ${event.rawCode || "?"}): confira o pedido no Portal do Parceiro.`);
      }
      return;
    default: {
      const before = record.order.status;
      record.order.status = mergeDeliveryStatus(before, event.signal);
      if (record.order.status === "cancelled") {
        record.cancellationPending = false;
        record.dispute = null;
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
