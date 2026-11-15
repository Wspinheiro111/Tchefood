import {
  DELIVERY_CHANNEL_CATALOG,
  DeliveryMarketplaceError,
  allowedDeliveryActions,
  clipDeliveryText,
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
  // O app está analisando um pedido de cancelamento (evento CAR): nada anda até a resposta.
  cancellationPending: boolean;
  // Pedido de cancelamento da loja reservado antes da chamada ao app (null = nenhum). Não trava as outras ações
  // (isso é cancellationPending); só impede um segundo pedido de cancelamento.
  cancellationRequest: DeliveryCancellationRequest | null;
  // Pedido sem o detalhe do app em vigor: pedido mínimo (sem itens nem valores) ou pedido que o app alterou depois de
  // gravado (evento de pedido alterado, cancelamento parcial aplicado), cujos itens e valores gravados estão velhos.
  // O servidor busca o detalhe de novo a cada ciclo; até lá o pedido não pode virar venda nem NFC-e. Volta a true a
  // cada alteração do app; o detalhe gravado só troca na volta para false.
  detailPending: boolean;
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
//   uncertain a chamada falhou sem resposta clara (rede, 5xx): pode ter chegado, ou não
// "uncertain" (e "sending" com mais de DISPUTE_RESPONSE_STALE_MS) não se libera sozinho, mas esperar o evento do app
// não serve: se a resposta não chegou, o app aplica a ação padrão no fim do prazo (ex.: aceita o cancelamento que a
// loja recusou). A nova tentativa vai com a conferência do gerente no Portal do Parceiro (confirmUncertainRetry).
// Repetir é seguro do lado do app: se a primeira chegou, o iFood recusa a segunda (422 DISPUTE_ALREADY_ANSWERED,
// tratado em respondToDispute).
export type DeliveryDisputeResponse = {
  decision: DeliveryDisputeDecision;
  state: "sending" | "sent" | "uncertain";
  reservedAt: string;
};

// Resposta "sending" mais velha que isto é de uma chamada que não termina mais (o adapter desiste antes: o iFood tem
// timeout de 15 s) ou de um processo que caiu: tratada como incerta.
export const DISPUTE_RESPONSE_STALE_MS = 60_000;

export type DeliveryDisputeOptions = {
  // O gerente conferiu no Portal do Parceiro que a negociação ainda não tem resposta. Só vale para repetir uma
  // resposta sem confirmação ("uncertain", ou "sending" vencida).
  confirmUncertainRetry?: boolean;
};

// Pedido que o app concluiu com o cancelamento ainda em análise (CAR sem CARF/CAN) ou com o pedido de cancelamento da
// loja ainda sem evento: o cancelamento não vale mais, mas não se sabe o que o app fez com ele.
export const CONCLUDED_WITH_PENDING_CANCELLATION =
  "O app concluiu o pedido com o cancelamento ainda em análise: confira no Portal do Parceiro antes de lançar.";

// Pedido de cancelamento da loja, reservado ANTES da chamada ao app (mesmo esquema da resposta de negociação):
// dois aparelhos ao mesmo tempo, ou uma nova tentativa depois de o banco falhar com o app já tendo aceitado,
// não mandam um segundo cancelamento.
//   sending   reservado, chamada em andamento (ou o processo caiu no meio: tratado como incerto)
//   sent      o app aceitou o pedido; falta o evento dele (CAR, CARF ou CAN), que zera a reserva
//   uncertain a chamada falhou sem resposta clara (rede, 5xx): pode ter chegado
// "sending" e "uncertain" não se liberam só pelo tempo: o prazo (CANCELLATION_RESERVATION_TTL_MS) só abre a
// possibilidade de repetir. Passado o prazo sem nenhum evento de cancelamento, a nova tentativa exige
//  1. a conferência do gerente no Portal do Parceiro (confirmUncertainRetry), porque nada na API prova que a
//     primeira chamada não foi aplicada: o detalhe do pedido do iFood (GET /orders/{id}) não traz status nem
//     cancelamento em análise, e a doc não diz o que o iFood faz com um requestCancellation repetido;
//  2. uma consulta ao detalhe do pedido no app: se a consulta falha, continua bloqueado; se ele mostra o pedido
//     cancelado, grava e não pede de novo. Com o iFood esse segundo ramo nunca roda: mapIfoodOrder sempre devolve
//     status "placed" (o detalhe não traz status). Ele fica para outro app que informe status no detalhe; no iFood a
//     única proteção contra o pedido repetido é a conferência do gerente (item 1).
// O pedido repetido fica marcado para conferência (UNCERTAIN_CANCELLATION_RETRIED).
export type DeliveryCancellationRequest = {
  state: "sending" | "sent" | "uncertain";
  reservedAt: string;
  code?: string;
};

export const CANCELLATION_RESERVATION_TTL_MS = 10 * 60_000;

// Hora (HH:mm, horário de Brasília) para as mensagens à loja.
function brasiliaTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

export const UNCERTAIN_CANCELLATION_RETRIED =
  "O pedido de cancelamento anterior ficou sem confirmação do app e foi repetido: confira no Portal do Parceiro se não há dois pedidos de cancelamento.";

export type DeliveryCancellationOptions = {
  // O gerente conferiu no Portal do Parceiro que o pedido não está cancelado nem com cancelamento em análise.
  // Só vale para repetir um pedido sem confirmação cujo prazo de reserva já passou.
  confirmUncertainRetry?: boolean;
};

// O app aceitou a chamada, mas a gravação do resultado no banco falhou depois. Não é "banco indisponível, tente
// de novo": o pedido já foi enviado e a tela precisa conferir antes de repetir.
export class DeliverySentNotSavedError extends Error {
  constructor(readonly channel: DeliveryChannelKey, readonly externalOrderId: string, readonly cause: unknown) {
    super(`Enviado ao app, mas não deu para gravar o resultado do pedido ${externalOrderId} (${describe(cause)}).`);
    this.name = "DeliverySentNotSavedError";
  }
}

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
  // Pedidos do app ainda sem o detalhe (detailPending) cuja próxima tentativa já chegou (ver deferDetail): primeiro
  // os nunca adiados, depois os de tentativa mais antiga; empate pelo pedido mais antigo. No máximo limit. Ficam de
  // fora o pedido cancelado e o recebido pelo servidor há mais de DETAIL_PENDING_MAX_AGE_DAYS dias (não viram venda; a conferência
  // fica com a pendência gravada).
  listDetailPending(channel: DeliveryChannelKey, limit: number): Promise<DeliveryOrderRecord[]>;
  // Adia a próxima tentativa de buscar o detalhe de um pedido ainda detailPending para daqui a seconds segundos
  // (relógio do banco). Não muda a versão do pedido nem mais nada nele; pedido já completo não muda. A gravação que
  // volta o pedido para detailPending zera o adiamento (a busca é logo).
  deferDetail(channel: DeliveryChannelKey, externalOrderId: string, seconds: number): Promise<void>;
}

export class InMemoryDeliveryRepository implements DeliveryRepository {
  private readonly events = new Set<string>();
  private readonly orders = new Map<string, DeliveryOrderRecord>();
  // Próxima tentativa do detalhe por pedido (detail_retry_at no banco), fora do registro: saveOrder não mexe.
  private readonly detailRetryAt = new Map<string, number>();
  // Quando o servidor gravou o pedido pela primeira vez (received_at no banco): é o que decide os 7 dias da
  // recuperação, não o horário do app (que pode vir ausente e virar 1970).
  private readonly receivedAt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

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
    const stored = this.orders.get(key);
    const storedVersion = stored?.version ?? 0;
    if (storedVersion !== record.version) throw new DeliveryConcurrencyError(record.order.channel, record.order.externalId);
    if (stored && !stored.detailPending && record.detailPending) this.detailRetryAt.delete(key);
    const version = storedVersion + 1;
    if (!stored) this.receivedAt.set(key, this.now().getTime());
    this.orders.set(key, { ...structuredClone(record), version });
    return version;
  }

  async listOrders(): Promise<DeliveryOrderRecord[]> {
    return [...this.orders.values()]
      .map((record) => structuredClone(record))
      .sort((a, b) => b.order.createdAt.localeCompare(a.order.createdAt));
  }

  async listDetailPending(channel: DeliveryChannelKey, limit: number): Promise<DeliveryOrderRecord[]> {
    const now = this.now().getTime();
    const oldest = now - DETAIL_PENDING_MAX_AGE_DAYS * 86_400_000;
    const retryAt = (record: DeliveryOrderRecord) => this.detailRetryAt.get(`${record.order.channel}:${record.order.externalId}`) ?? -Infinity;
    return [...this.orders.values()]
      .filter(
        (record) =>
          record.order.channel === channel &&
          record.detailPending &&
          record.order.status !== "cancelled" &&
          (this.receivedAt.get(`${record.order.channel}:${record.order.externalId}`) ?? now) >= oldest &&
          retryAt(record) <= now,
      )
      .sort(
        (a, b) =>
          retryAt(a) - retryAt(b) ||
          a.order.createdAt.localeCompare(b.order.createdAt) ||
          a.order.externalId.localeCompare(b.order.externalId),
      )
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async deferDetail(channel: DeliveryChannelKey, externalOrderId: string, seconds: number): Promise<void> {
    const key = `${channel}:${externalOrderId}`;
    if (!this.orders.get(key)?.detailPending) return;
    this.detailRetryAt.set(key, this.now().getTime() + seconds * 1000);
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

// Janela em que a mesma ação de status, já aceita pelo app e com o pedido no mesmo status, não é mandada de novo.
export const ACTION_RESEND_GUARD_MS = 60_000;

// Falhas em que o app com certeza não aplicou o pedido.
export const DEFINITE_FAILURES: readonly string[] = ["invalid_request", "not_found", "conflict", "auth_failed", "rate_limited"];

// Detalhe do pedido que o app recusa entregar (auth_failed, not_found, invalid_request: 4xx menos 409/429): depois de
// tantas recusas o pedido entra mesmo sem detalhe, para a loja ver e confirmar pelo portal antes que o app cancele por
// falta de confirmação. Falhas temporárias (fora do ar, limite de uso, tempo esgotado) não contam nem zeram a conta:
// só adiam. A conta é por pedido e só em memória (reiniciar o processo recomeça do zero).
export const ORDER_DETAIL_MAX_FAILURES = 10;
const PERSISTENT_DETAIL_FAILURES: readonly string[] = ["auth_failed", "not_found", "invalid_request"];

// Pedidos mínimos (detailPending) cujo detalhe é buscado de novo a cada ciclo, depois do ack: poucos, para não
// atrasar o próximo polling nem gastar o limite de uso do app.
export const DETAIL_RECOVERY_BATCH = 20;
// Tempo máximo do laço de recuperação por ciclo (o iFood espera polling a cada 30 s). Conferido antes de cada
// busca: uma busca já começada vai até o fim (ou até o timeout do adapter).
export const DETAIL_RECOVERY_BUDGET_MS = 10_000;
// Rodízio: pedido cuja busca falhou (app, detalhe de outro pedido, gravação) só volta à lista depois deste
// intervalo fixo, para que pedidos que nunca melhoram (404/403/ilegível para sempre) não ocupem todo o lote e
// deixem um pedido mínimo novo sem tentativa. Pedido nunca adiado vem antes de todos.
export const DETAIL_RETRY_DELAY_SECONDS = 5 * 60;
// Detalhe que veio de outra loja do app: só a conferência humana resolve; tenta de novo de hora em hora.
export const DETAIL_OTHER_STORE_RETRY_SECONDS = 60 * 60;
export const DETAIL_RECOVERED_REASON = "Detalhe do pedido recuperado do app: confira itens e valores.";
// Detalhe buscado de novo num pedido que já tinha itens (o app alterou o pedido depois de gravado).
export const DETAIL_REFRESHED_REASON = "Detalhe do pedido atualizado pelo app (itens e valores novos): confira antes de lançar.";
// Pedido sem detalhe mais velho que isto sai da recuperação (o banco filtra pelo horário do pedido).
export const DETAIL_PENDING_MAX_AGE_DAYS = 7;
export const ORDER_PATCHED_REASON = "O app alterou o pedido: itens e valores serão buscados de novo; confira antes de lançar.";
export const PARTIAL_CANCELLATION_APPLIED_REASON = "Cancelamento parcial aplicado pelo app: itens e valores mudaram; confira antes de lançar.";
export const PARTIAL_CANCELLATION_UNCERTAIN_REASON =
  "Negociação de cancelamento parcial venceu sem a ação padrão do app gravada: itens e valores serão buscados de novo; confira antes de lançar.";

export class DeliveryInbox {
  private readonly adapters = new Map<DeliveryChannelKey, DeliveryMarketplaceAdapter>();
  private readonly now: () => Date;
  // Um ciclo por app por vez: polling sobreposto confirmaria eventos em dobro.
  private readonly running = new Set<DeliveryChannelKey>();
  private readonly orderLocks = new Map<string, Promise<void>>();
  // Falhas seguidas do detalhe de pedido novo (auth_failed/not_found), por pedido. Só em memória: reiniciar o
  // processo recomeça a conta, o que só atrasa (nunca perde) o registro mínimo.
  private readonly detailFailures = new Map<string, number>();
  // Ação de status em andamento por pedido (clique duplo / dois toques no mesmo aparelho): a segunda é recusada
  // sem chamar o app. Vale só neste processo; o app recusa a transição repetida de qualquer forma.
  private readonly actionsInFlight = new Set<string>();
  // Ação de status que o app aceitou e cujo evento ainda não chegou (o status novo só vem com ele), por pedido: a
  // mesma ação de novo em ACTION_RESEND_GUARD_MS, com o pedido no mesmo status (e o mesmo cancelamento em análise),
  // é recusada sem chamar o app (a tela ainda mostra o botão; o app recusaria a transição repetida com um erro que
  // parece falha). Compara o status, não a versão: gravação sem evento de status (recuperação do detalhe, aviso)
  // muda a versão e não pode liberar a repetição. Só depois de sucesso, para não travar a nova tentativa depois de
  // uma falha. Só em memória (vale neste processo).
  private readonly actionsSent = new Map<
    string,
    { action: DeliveryOrderAction; at: number; status: DeliveryOrder["status"]; cancellationPending: boolean }
  >();

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
    let polled = false;
    try {
      const events = await adapter.pollEvents();
      polled = true;
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
    }
    try {
      // Depois do ack (não atrasa a confirmação dos eventos). Com o app fora do ar (polling falhou) não tenta.
      if (polled) await this.recoverPendingDetails(adapter);
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
    const key = `${channel}:${externalOrderId}`;
    if (this.actionsInFlight.has(key)) {
      throw new DeliveryMarketplaceError(channel, "conflict", "Já há uma ação em andamento para este pedido; aguarde.");
    }
    const nowMs = this.now().getTime();
    for (const [sentKey, sent] of this.actionsSent) if (sent.at + ACTION_RESEND_GUARD_MS <= nowMs) this.actionsSent.delete(sentKey);
    const sent = this.actionsSent.get(key);
    if (sent && sent.action === action && sent.status === record.order.status && sent.cancellationPending === record.cancellationPending) {
      throw new DeliveryMarketplaceError(channel, "conflict", "Ação já enviada ao app, aguardando a confirmação dele; o status muda quando ela chegar.");
    }
    this.actionsInFlight.add(key);
    try {
      await adapter.performAction(externalOrderId, action);
      // O app aceitou: a trava de 60 s vale já, antes de qualquer leitura do banco, e a ação continua "em andamento"
      // até o fim desta função. Guarda o status de antes do envio: a repetição só passa quando um evento mudar o pedido.
      this.actionsSent.set(key, {
        action,
        at: this.now().getTime(),
        status: record.order.status,
        cancellationPending: record.cancellationPending,
      });
      // O status oficial chega pelo evento do app; nada é gravado aqui, para que a resposta da ação nunca
      // sobrescreva um evento processado pelo polling enquanto a chamada estava em andamento. Se a leitura falhar,
      // a ação já foi aceita: devolve o pedido lido antes (a resposta diz actionSent) em vez de um erro que convide
      // a repetir.
      try {
        return await this.requireOrder(channel, externalOrderId);
      } catch {
        return record;
      }
    } finally {
      this.actionsInFlight.delete(key);
    }
  }

  async listCancellationReasons(channel: DeliveryChannelKey, externalOrderId: string): Promise<DeliveryCancellationReason[]> {
    return this.adapter(channel).listCancellationReasons(externalOrderId);
  }

  // Pedido de cancelamento da loja. Reservado no pedido (gravação com versão) antes de chamar o app: dois pedidos
  // ao mesmo tempo, ou uma nova tentativa depois de uma resposta incerta, não chegam ao app. Reserva sem confirmação
  // com o prazo vencido: ver DeliveryCancellationRequest (conferência do gerente + consulta ao app).
  async requestCancellation(
    channel: DeliveryChannelKey,
    externalOrderId: string,
    reason: DeliveryCancellationReason,
    details?: string,
    options: DeliveryCancellationOptions = {},
  ): Promise<DeliveryOrderRecord> {
    const adapter = this.adapter(channel);
    // Reserva sem confirmação já vencida que esta chamada conferiu no app (null = nenhuma).
    const checkedStale = await this.checkStaleCancellation(adapter, externalOrderId, options);
    const reservedAt = this.now().toISOString();
    // O que a reserva substituiu, para desfazê-la se a gravação falhar (ver reserveOrUndo) ou se o app recusar.
    let previous: DeliveryCancellationRequest | null = null;
    let flaggedRetry = false;
    // Só mexe na reserva deste pedido: se um evento de cancelamento (CAR, CARF, CAN) chegou no meio, ele manda.
    const ours = (latest: DeliveryOrderRecord) => latest.cancellationRequest?.reservedAt === reservedAt;
    // Volta ao que havia antes desta chamada: a reserva anterior (a incerta que esta repetição substituiu, ou null na
    // primeira tentativa) e, se esta chamada pôs a marca de repetição, tira a marca. needsReview é recalculado pelos
    // avisos que sobram (um evento gravado no meio pode ter pedido conferência).
    const undoReservation = (latest: DeliveryOrderRecord) => {
      if (!ours(latest)) return false;
      latest.cancellationRequest = previous;
      if (flaggedRetry) {
        latest.reviewReasons = latest.reviewReasons.filter((item) => item !== UNCERTAIN_CANCELLATION_RETRIED);
        latest.needsReview = latest.reviewReasons.length > 0;
      }
      return true;
    };
    await this.reserveOrUndo(channel, externalOrderId, (latest) => {
      previous = latest.cancellationRequest;
      flaggedRetry = false;
      if (latest.order.status === "concluded" || latest.order.status === "cancelled") {
        throw new DeliveryMarketplaceError(channel, "conflict", "Pedido já finalizado não pode ser cancelado.");
      }
      if (latest.cancellationPending) {
        throw new DeliveryMarketplaceError(channel, "conflict", "O cancelamento já foi pedido; aguarde a resposta do app.");
      }
      const current = latest.cancellationRequest;
      if (current) {
        // Só repete a reserva vencida que foi conferida acima; outra (gravada no meio) segue as regras de sempre.
        if (!this.isStaleCancellation(current) || current.reservedAt !== checkedStale) {
          throw new DeliveryMarketplaceError(
            channel,
            "conflict",
            current.state === "sent"
              ? "O cancelamento já foi pedido; aguarde a resposta do app."
              : `Já existe um pedido de cancelamento em andamento ou sem confirmação; confira o pedido no app antes de repetir. Se ele continuar sem confirmação, a repetição com a conferência do gerente vale a partir de ${brasiliaTime(Date.parse(current.reservedAt) + CANCELLATION_RESERVATION_TTL_MS)} (horário de Brasília).`,
          );
        }
        flaggedRetry = !latest.reviewReasons.includes(UNCERTAIN_CANCELLATION_RETRIED);
        flag(latest, UNCERTAIN_CANCELLATION_RETRIED);
      }
      latest.cancellationRequest = { state: "sending", reservedAt, code: reason.code };
      return true;
    }, undoReservation);
    try {
      await adapter.requestCancellation(externalOrderId, reason, details);
    } catch (error) {
      // Recusa clara do app: esta tentativa não foi aplicada e a reserva é desfeita, voltando à anterior (numa
      // repetição, a incerta continua valendo: o primeiro pedido pode ter chegado). Qualquer outra falha pode ter chegado.
      const definite = error instanceof DeliveryMarketplaceError && DEFINITE_FAILURES.includes(error.code);
      await this.updateOrder(channel, externalOrderId, (latest) => {
        if (definite) return undoReservation(latest);
        if (!ours(latest)) return false;
        latest.cancellationRequest = { ...latest.cancellationRequest!, state: "uncertain" };
        return true;
      }).catch(() => undefined);
      throw error;
    }
    try {
      return await this.updateOrder(channel, externalOrderId, (latest) => {
        if (!ours(latest)) return false;
        latest.cancellationRequest = { ...latest.cancellationRequest!, state: "sent" };
        if (latest.order.status !== "cancelled" && latest.order.status !== "concluded") latest.cancellationPending = true;
        return true;
      });
    } catch (error) {
      throw new DeliverySentNotSavedError(channel, externalOrderId, error);
    }
  }

  private isStaleCancellation(request: DeliveryCancellationRequest): boolean {
    return request.state !== "sent" && Date.parse(request.reservedAt) + CANCELLATION_RESERVATION_TTL_MS <= this.now().getTime();
  }

  // Antes de repetir um pedido de cancelamento sem confirmação e com o prazo vencido: exige a conferência do gerente e
  // consulta o pedido no app. Devolve o reservedAt da reserva conferida, ou null se não há reserva vencida (as
  // regras normais decidem depois, dentro da gravação).
  private async checkStaleCancellation(
    adapter: DeliveryMarketplaceAdapter,
    externalOrderId: string,
    options: DeliveryCancellationOptions,
  ): Promise<string | null> {
    const channel = adapter.channel;
    const stale = (await this.requireOrder(channel, externalOrderId)).cancellationRequest;
    if (!stale || !this.isStaleCancellation(stale)) return null;
    if (options.confirmUncertainRetry !== true) {
      throw new DeliveryMarketplaceError(
        channel,
        "conflict",
        "O pedido de cancelamento anterior ficou sem confirmação do app e pode ter chegado. Confira no Portal do Parceiro se o pedido já foi cancelado ou tem cancelamento em análise; se não tiver, repita confirmando que conferiu.",
      );
    }
    let detail: DeliveryOrder;
    try {
      detail = await adapter.getOrder(externalOrderId);
    } catch (error) {
      throw new DeliveryMarketplaceError(
        channel,
        "conflict",
        `Não deu para consultar o pedido no app (${describe(error)}); o cancelamento anterior segue sem confirmação. Confira no Portal do Parceiro antes de repetir.`,
      );
    }
    if (detail.status === "cancelled") {
      // O app já cancelou: grava (o evento CAN confirma depois) e não manda outro pedido.
      await this.updateOrder(channel, externalOrderId, (latest) => {
        if (latest.cancellationRequest?.reservedAt !== stale.reservedAt) return false;
        latest.order.status = mergeDeliveryStatus(latest.order.status, "cancelled");
        latest.cancellationPending = false;
        latest.cancellationRequest = null;
        return true;
      });
      throw new DeliveryMarketplaceError(channel, "conflict", "O app já mostra o pedido cancelado; nada a pedir.");
    }
    return stale.reservedAt;
  }

  // Confere a resposta contra a negociação gravada sem gravar nada nem chamar o app (o servidor usa antes de pedir
  // o PIN de gerente). A mesma conferência roda de novo, já com a reserva, em respondToDispute.
  // Devolve também o id da negociação conferida: a resposta autorizada pelo gerente vale só para ela (ver
  // expectedDisputeId em respondToDispute). expectedDisputeId é obrigatório: o id da negociação que a tela mostrou.
  async checkDisputeDecision(
    channel: DeliveryChannelKey,
    externalOrderId: string,
    decision: DeliveryDisputeDecision,
    expectedDisputeId: string,
    options: DeliveryDisputeOptions = {},
  ): Promise<{ disputeId: string; decision: DeliveryDisputeDecision }> {
    const record = await this.requireOrder(channel, externalOrderId);
    assertSameDispute(channel, record, expectedDisputeId);
    return { disputeId: record.dispute!.id, decision: resolveDisputeDecision(channel, record, decision, this.now(), options) };
  }

  // Resposta da loja a uma negociação aberta pelo app (cliente pediu cancelamento, reembolso...). A resposta é
  // reservada no pedido (gravação com versão) antes de chamar o app: duas respostas ao mesmo tempo, ou uma nova
  // tentativa depois de uma resposta incerta, não chegam ao app. O que vai ao app é a resposta conferida contra a
  // negociação gravada (motivo do aceite da lista, valor até o teto, prazo e motivo permitidos).
  // expectedDisputeId (obrigatório): a negociação que o gerente aprovou. Se o app fechou essa e abriu outra no meio
  // (polling entre a conferência e a reserva), a resposta não vai para a nova: conflito, e a tela mostra a nova.
  // options.confirmUncertainRetry: repetir uma resposta sem confirmação (ver DeliveryDisputeResponse).
  async respondToDispute(
    channel: DeliveryChannelKey,
    externalOrderId: string,
    decision: DeliveryDisputeDecision,
    expectedDisputeId: string,
    options: DeliveryDisputeOptions = {},
  ): Promise<DeliveryOrderRecord> {
    const adapter = this.adapter(channel);
    const reservedAt = this.now().toISOString();
    let disputeId = "";
    let resolved: DeliveryDisputeDecision = decision;
    // Resposta sem confirmação que esta tentativa substitui (null = primeira resposta).
    let previous: DeliveryDisputeResponse | null = null;
    // Só mexe na reserva desta resposta: se o app fechou ou trocou a negociação no meio, o evento manda.
    const ours = (latest: DeliveryOrderRecord) =>
      latest.dispute && latest.dispute.id === disputeId && latest.dispute.response?.reservedAt === reservedAt ? latest.dispute : null;
    await this.reserveOrUndo(channel, externalOrderId, (latest) => {
      assertSameDispute(channel, latest, expectedDisputeId);
      resolved = resolveDisputeDecision(channel, latest, decision, this.now(), options);
      const dispute = latest.dispute!;
      disputeId = dispute.id;
      previous = dispute.response ?? null;
      dispute.response = { decision: resolved, state: "sending", reservedAt };
      return true;
    }, (latest) => {
      const dispute = ours(latest);
      if (!dispute) return false;
      dispute.response = previous;
      return true;
    });
    try {
      await adapter.respondToDispute(disputeId, resolved);
    } catch (error) {
      // O app diz que a negociação já tinha resposta (iFood: 422 DISPUTE_ALREADY_ANSWERED, ex.: respondida pelo
      // Portal, ou a resposta anterior sem confirmação tinha chegado). A resposta DESTA tentativa não foi aplicada: a
      // reserva sai (não fica registrada como enviada), a negociação fica marcada como respondida (nada mais pode ser
      // enviado) e o desfecho vem pelo evento do app.
      if (error instanceof DeliveryMarketplaceError && error.providerCode === "DISPUTE_ALREADY_ANSWERED") {
        const retried = previous !== null;
        await this.updateOrder(channel, externalOrderId, (latest) => {
          const dispute = ours(latest);
          if (!dispute) return false;
          dispute.response = null;
          dispute.respondedAt = this.now().toISOString();
          flag(
            latest,
            retried
              ? "A negociação já tinha resposta no app (a resposta anterior do PDV pode ter chegado, ou alguém respondeu pelo Portal do Parceiro); a repetição não foi aplicada: confira o desfecho."
              : "A negociação já tinha sido respondida por fora (talvez pelo Portal do Parceiro); a resposta do PDV não foi aplicada: confira o desfecho.",
          );
          return true;
        });
        throw new DeliveryMarketplaceError(
          channel,
          "conflict",
          retried
            ? "A negociação já tinha resposta no app (a resposta anterior pode ter chegado, ou foi respondida pelo Portal do Parceiro); a repetição não foi aplicada. Confira o desfecho."
            : "A negociação já tinha sido respondida por fora (Portal do Parceiro); a resposta do PDV não foi aplicada. Confira o desfecho.",
        );
      }
      // Recusa clara do app (4xx, limite de uso): esta resposta não foi aplicada e a reserva é desfeita, voltando à
      // anterior (numa repetição, a incerta continua valendo: a primeira resposta pode ter chegado). Qualquer outra
      // falha (rede, 5xx, prazo) pode ter chegado: fica "incerta" e bloqueia novas tentativas.
      const definite = error instanceof DeliveryMarketplaceError && DEFINITE_FAILURES.includes(error.code);
      await this.updateOrder(channel, externalOrderId, (latest) => {
        const dispute = ours(latest);
        if (!dispute) return false;
        if (definite) dispute.response = previous;
        else dispute.response = { ...dispute.response!, state: "uncertain" };
        return true;
      }).catch(() => undefined);
      throw error;
    }
    try {
      return await this.updateOrder(channel, externalOrderId, (latest) => {
        const dispute = ours(latest);
        if (!dispute) return false;
        dispute.response = { ...dispute.response!, state: "sent" };
        dispute.respondedAt = this.now().toISOString();
        return true;
      });
    } catch (error) {
      throw new DeliverySentNotSavedError(channel, externalOrderId, error);
    }
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

  // Grava a reserva (antes de chamar o app). Se a gravação falhar com erro que não é de regra (DeliveryMarketplaceError
  // do próprio change) nem de versão esgotada, o banco pode ter gravado e só a resposta se perdido (timeout depois do
  // commit): desfaz a reserva DESTA chamada (undo só mexe se ela estiver lá), para que ela não bloqueie a próxima
  // tentativa como se tivesse chegado ao app. Seguro porque o app ainda não foi chamado. Falha do desfazer é engolida
  // (a reserva fica, como antes); o erro original sobe.
  private async reserveOrUndo(
    channel: DeliveryChannelKey,
    externalOrderId: string,
    reserve: (record: DeliveryOrderRecord) => boolean,
    undo: (record: DeliveryOrderRecord) => boolean,
  ): Promise<void> {
    try {
      await this.updateOrder(channel, externalOrderId, reserve);
    } catch (error) {
      if (!(error instanceof DeliveryMarketplaceError) && !(error instanceof DeliveryConcurrencyError)) {
        await this.updateOrder(channel, externalOrderId, undo).catch(() => undefined);
      }
      throw error;
    }
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
      // Detalhe que o app manda mas não dá para ler (valor negativo, campo ou itens faltando) nunca melhora: o
      // pedido entra com o mínimo que o evento traz e vai para conferência, em vez de ficar sem ack para sempre.
      const fetched = await this.fetchNewOrder(adapter, event);
      const order = fetched.order;
      // Detalhe sem a loja: vale a do evento (é ela que a prova de loja e a pausa usam).
      if (!order.merchantExternalId) order.merchantExternalId = event.merchantExternalId;
      record = {
        order,
        cancellationPending: false,
        cancellationRequest: null,
        detailPending: fetched.reason !== null,
        needsReview: order.warnings.length > 0,
        reviewReasons: [...order.warnings],
        newOrderNotified: false,
        lastCancellationEventAt: null,
        lastEventAt: event.createdAt,
        updatedAt: this.now().toISOString(),
        dispute: null,
        version: 0,
      };
      if (fetched.reason) {
        flag(
          record,
          `Detalhe do pedido ilegível no ${DELIVERY_CHANNEL_CATALOG[event.channel].label} (${fetched.reason}): confira e confirme pelo Portal do Parceiro.`,
        );
      }
    }
    const isNew = !record.newOrderNotified;

    // Ordem: pedido gravado, aviso, resultado do aviso gravado e, por último, o evento no histórico. Se qualquer
    // passo falhar, o evento fica sem ack e é reprocessado inteiro; aplicar o mesmo evento de novo dá o mesmo
    // status (só anda para frente). O aviso pode repetir nesse caso, mas nunca se perde.
    applySignal(record, event);
    // Pedido que já chega cancelado (o PDV só viu o pedido depois do CAN) não é pedido novo para a cozinha: fica
    // marcado como avisado, sem imprimir nem tocar alerta.
    const announce = isNew && record.order.status !== "cancelled";
    record.updatedAt = this.now().toISOString();
    // Conflito de versão (outro processo gravou o pedido no meio) sobe como erro: o evento fica sem ack e é
    // reaplicado no próximo ciclo em cima do pedido atualizado.
    record.version = await repository.saveOrder(record);

    // Falha no aviso (impressora, KDS) não desfaz o pedido gravado: vira pendência para o lojista.
    const notify = announce ? this.options.onNewOrder : isNew ? undefined : this.options.onOrderUpdated;
    try {
      await notify?.(record);
    } catch (error) {
      flag(record, `Aviso do pedido falhou (${describe(error)}): confira impressão e KDS.`);
    }
    if (isNew) record.newOrderNotified = true;
    if (isNew || record.needsReview) record.version = await repository.saveOrder(record);
    await repository.recordEvent(event);
    this.detailFailures.delete(`${event.channel}:${event.externalOrderId}`);
    return announce ? "new_order" : "updated";
  }

  // Pedido sem detalhe em vigor (detailPending: pedido mínimo, ou alterado pelo app): busca o detalhe no app de novo e,
  // se vier legível, grava itens, valores, cliente, pagamentos etc. sem mexer no que os eventos já fizeram (status,
  // cancelamento, negociação, pendências, aviso).
  // Qualquer falha (app, banco, conflito de versão esgotado) deixa o pedido como está e o adia
  // (DETAIL_RETRY_DELAY_SECONDS; outra loja: DETAIL_OTHER_STORE_RETRY_SECONDS), e nunca derruba o ciclo. O laço
  // para no orçamento de tempo (DETAIL_RECOVERY_BUDGET_MS) e no primeiro erro temporário do app (fora do ar,
  // limite de uso, tempo esgotado): os que sobraram ficam na vez para o próximo ciclo.
  private async recoverPendingDetails(adapter: DeliveryMarketplaceAdapter): Promise<void> {
    const channel = adapter.channel;
    let pending: DeliveryOrderRecord[];
    try {
      pending = await this.options.repository.listDetailPending(channel, DETAIL_RECOVERY_BATCH);
    } catch {
      return;
    }
    const startedAt = this.now().getTime();
    for (const candidate of pending) {
      if (this.now().getTime() - startedAt >= DETAIL_RECOVERY_BUDGET_MS) break;
      const externalId = candidate.order.externalId;
      let detail: DeliveryOrder;
      try {
        detail = await adapter.getOrder(externalId);
      } catch (error) {
        await this.deferDetail(channel, externalId, DETAIL_RETRY_DELAY_SECONDS);
        if (error instanceof DeliveryMarketplaceError && error.retryable) break;
        continue;
      }
      if (detail.channel !== channel || detail.externalId !== externalId) {
        await this.deferDetail(channel, externalId, DETAIL_RETRY_DELAY_SECONDS);
        continue;
      }
      let recovered = false;
      let otherStore = false;
      let saved: DeliveryOrderRecord;
      try {
        saved = await this.updateOrder(channel, externalId, (latest) => {
          if (!latest.detailPending) return false;
          const merchant = detail.merchantExternalId || latest.order.merchantExternalId;
          if (merchant !== latest.order.merchantExternalId) {
            // O banco recusa a troca de loja; a pendência fica para a conferência humana.
            otherStore = true;
            const reason = `O detalhe do pedido veio de outra loja do ${DELIVERY_CHANNEL_CATALOG[channel].label}: confira pelo Portal do Parceiro.`;
            if (latest.reviewReasons.includes(reason)) return false;
            flag(latest, reason);
            return true;
          }
          otherStore = false;
          // Pedido mínimo (sem itens) recuperado, ou pedido com itens que o app alterou e foi buscado de novo.
          const refreshed = latest.order.items.length > 0;
          // Cancelamento só vale pelo evento do app (que também zera reservas e negociação).
          const status = detail.status === "cancelled" ? latest.order.status : mergeDeliveryStatus(latest.order.status, detail.status);
          latest.order = { ...structuredClone(detail), channel, externalId, merchantExternalId: merchant, status };
          for (const warning of detail.warnings) flag(latest, warning);
          flag(latest, refreshed ? DETAIL_REFRESHED_REASON : DETAIL_RECOVERED_REASON);
          latest.detailPending = false;
          recovered = true;
          return true;
        });
      } catch {
        await this.deferDetail(channel, externalId, DETAIL_RETRY_DELAY_SECONDS);
        continue;
      }
      if (otherStore) await this.deferDetail(channel, externalId, DETAIL_OTHER_STORE_RETRY_SECONDS);
      if (!recovered) continue;
      try {
        await this.options.onOrderUpdated?.(saved);
      } catch {
        // Aviso de atualização é melhor esforço: o pedido recuperado já está gravado e marcado para conferência.
      }
    }
  }

  // Adiamento é melhor esforço: se o banco falhar, o pedido só volta mais cedo à lista.
  private async deferDetail(channel: DeliveryChannelKey, externalOrderId: string, seconds: number): Promise<void> {
    try {
      await this.options.repository.deferDetail(channel, externalOrderId, seconds);
    } catch {
      // Nada: o ciclo segue.
    }
  }

  // Detalhe de um pedido que o PDV ainda não conhece. Devolve o pedido do app ou, quando o detalhe não tem
  // conserto (ilegível, ou recusado em ORDER_DETAIL_MAX_FAILURES ciclos seguidos), um pedido mínimo e o motivo.
  // Qualquer outra falha sobe: o evento fica sem ack e volta no próximo ciclo.
  private async fetchNewOrder(
    adapter: DeliveryMarketplaceAdapter,
    event: DeliveryEvent,
  ): Promise<{ order: DeliveryOrder; reason: string | null }> {
    const key = `${event.channel}:${event.externalOrderId}`;
    try {
      return { order: await adapter.getOrder(event.externalOrderId), reason: null };
    } catch (error) {
      if (!(error instanceof DeliveryMarketplaceError)) throw error;
      if (error.code !== "invalid_response") {
        if (!PERSISTENT_DETAIL_FAILURES.includes(error.code)) throw error;
        const failures = (this.detailFailures.get(key) ?? 0) + 1;
        this.detailFailures.set(key, failures);
        if (failures < ORDER_DETAIL_MAX_FAILURES) throw error;
      }
      return { order: minimalOrder(event), reason: error.message };
    }
  }
}

const UNKNOWN_EVENT_TIME = new Date(0).toISOString();

function applySignal(record: DeliveryOrderRecord, event: DeliveryEvent): void {
  if (event.createdAt > record.lastEventAt) record.lastEventAt = event.createdAt;
  const isCancellationSignal = event.signal === "cancellation_requested" || event.signal === "cancellation_denied";
  if (isCancellationSignal) {
    // Evento de cancelamento atrasado (ex.: o pedido chegando depois da recusa) não reabre nada. Evento sem horário
    // (vira 1970) não dá para ordenar: vale como chegou e não mexe no último horário conhecido.
    const unknownTime = event.createdAt === UNKNOWN_EVENT_TIME;
    if (!unknownTime && record.lastCancellationEventAt !== null && event.createdAt < record.lastCancellationEventAt) return;
    if (!unknownTime) record.lastCancellationEventAt = event.createdAt;
    // O app respondeu (CAR = recebeu o pedido, CARF = recusou): a reserva do pedido da loja acabou.
    record.cancellationRequest = null;
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
      // Pedido entregue (concluído) ainda pode ter negociação (iFood: AFTER_DELIVERY, reembolso depois da entrega):
      // a negociação é gravada sem mexer no status. Pedido cancelado não tem o que negociar, mas não some calado.
      if (record.order.status === "cancelled") {
        flag(record, "O app abriu uma negociação num pedido já cancelado: confira no Portal do Parceiro.");
        return;
      }
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
      applySettlement(record, event);
      return;
    case "order_patched":
      // O app mudou itens/valores depois do pedido gravado: o detalhe gravado ficou velho. Volta a ser buscado (e a
      // venda fica bloqueada até lá). Pedido cancelado não vira venda: nada a buscar.
      if (record.order.status === "cancelled") return;
      reopenDetail(record, ORDER_PATCHED_REASON);
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
        record.cancellationRequest = null;
        record.dispute = null;
        if (before !== "cancelled" && before !== "placed") {
          flag(record, "Pedido cancelado pelo app depois de aceito: confira se já foi preparado ou impresso.");
        }
      } else if (record.order.status === "concluded" && (record.cancellationPending || record.cancellationRequest)) {
        // Concluído com o cancelamento em análise (CAR sem CARF/CAN) ou com o pedido de cancelamento da loja ainda sem
        // evento: nenhum evento de cancelamento vem mais para soltar o pedido, e a venda ficaria bloqueada para sempre.
        record.cancellationPending = false;
        record.cancellationRequest = null;
        flag(record, CONCLUDED_WITH_PENDING_CANCELLATION);
      }
    }
  }
}

// Pedido com o que o evento traz, para quando o detalhe do app não dá para usar: sem itens nem valores (a loja
// confere no portal) e com o status dado pelos eventos, como em qualquer pedido.
function minimalOrder(event: DeliveryEvent): DeliveryOrder {
  const label = DELIVERY_CHANNEL_CATALOG[event.channel].label;
  return {
    channel: event.channel,
    externalId: event.externalOrderId,
    displayId: event.externalOrderId.slice(0, 8),
    merchantExternalId: event.merchantExternalId,
    status: "placed",
    fulfillment: "delivery",
    courier: "unknown",
    scheduledFor: null,
    scheduledUntil: null,
    preparationStartAt: null,
    pickupCode: null,
    // O evento não diz se é pedido de teste; a conferência no portal resolve.
    isTest: false,
    createdAt: event.createdAt,
    customer: { name: `Cliente ${label}`, phone: null, phoneLocalizer: null, document: null },
    address: null,
    items: [],
    totals: {
      itemsCents: 0,
      deliveryFeeCents: 0,
      additionalFeesCents: 0,
      benefitsCents: 0,
      benefitsSponsoredByMarketplaceCents: 0,
      orderCents: 0,
    },
    payments: [],
    pendingCents: 0,
    notes: null,
    warnings: [],
  };
}

// Andamento/desfecho da negociação. Só o desfecho (aceita, recusada, vencida) da MESMA negociação fecha a
// negociação gravada: "alternative_replied" é a contraproposta entregue, esperando o cliente, e o fechamento de
// outra negociação (ex.: a anterior a uma contraproposta do cliente) não mexe na atual.
function applySettlement(record: DeliveryOrderRecord, event: DeliveryEvent): void {
  const settlement = event.settlement;
  if (!settlement || !settlement.disputeId || settlement.status === "unknown") {
    flag(record, `Chegou um fechamento de negociação que não deu para ler${settlement?.rawStatus ? ` (${settlement.rawStatus})` : ""}: confira no Portal do Parceiro.`);
    return;
  }
  const current = record.dispute?.id === settlement.disputeId ? record.dispute : null;
  if (settlement.status === "alternative_replied") {
    // A contraproposta chegou ao app: uma reserva incerta ou interrompida vira enviada.
    if (current?.response && current.response.state !== "sent") current.response = { ...current.response, state: "sent" };
    if (current && !current.respondedAt) current.respondedAt = event.createdAt;
    return;
  }
  if (current) record.dispute = null;
  // Cancelamento parcial aplicado (aceite sem contraproposta, ou prazo vencido com a ação padrão de aceitar): itens e
  // valores do pedido mudaram no app. O app aplica a ação padrão (timeoutAction) no vencimento: ACCEPT_CANCELLATION
  // aplica o cancelamento; REJECT_CANCELLATION e VOID não. Sem a ação padrão gravada não dá para saber: busca de novo.
  if (current?.action === "PARTIAL_CANCELLATION" && record.order.status !== "cancelled") {
    const timeoutAction = current.timeoutAction;
    if (settlement.status === "accepted" && !settlement.selectedAlternative) {
      reopenDetail(record, PARTIAL_CANCELLATION_APPLIED_REASON);
    } else if (settlement.status === "expired" && timeoutAction === "ACCEPT_CANCELLATION") {
      reopenDetail(record, PARTIAL_CANCELLATION_APPLIED_REASON);
    } else if (settlement.status === "expired" && timeoutAction !== "REJECT_CANCELLATION" && timeoutAction !== "VOID") {
      reopenDetail(record, PARTIAL_CANCELLATION_UNCERTAIN_REASON);
    }
  }
  // Reembolso ou benefício aceito muda o valor que a loja recebe do app.
  const selected = settlement.status === "accepted" ? settlement.selectedAlternative : null;
  if (selected && (selected.type === "REFUND" || selected.type === "BENEFIT")) {
    const label = selected.type === "REFUND" ? "reembolso" : "benefício";
    const amount = selected.amountCents !== null ? ` de ${formatCents(selected.amountCents)}` : "";
    flag(record, `Negociação fechada com ${label}${amount} ao cliente: confira o valor a receber do app.`);
  }
}

// Confere a resposta da loja contra a negociação gravada e devolve a resposta que vai ao app (com o tipo da proposta
// e só os campos que o app aceita). Erros: conflict (estado da negociação) ou invalid_request (dado da resposta).
// A resposta só vale para a negociação que o gerente viu: sem o id dela não há "a negociação de agora" por padrão.
function assertSameDispute(channel: DeliveryChannelKey, record: DeliveryOrderRecord, expectedDisputeId: string): void {
  if (typeof expectedDisputeId !== "string" || !expectedDisputeId) {
    throw new DeliveryMarketplaceError(channel, "invalid_request", "Informe a negociação que está respondendo.");
  }
  if (!record.dispute) throw new DeliveryMarketplaceError(channel, "conflict", "Este pedido não tem negociação aberta.");
  if (record.dispute.id !== expectedDisputeId) {
    throw new DeliveryMarketplaceError(channel, "conflict", "A negociação mudou (o app abriu outra); confira a nova antes de responder.");
  }
}

function resolveDisputeDecision(
  channel: DeliveryChannelKey,
  record: DeliveryOrderRecord,
  decision: DeliveryDisputeDecision,
  now: Date,
  options: DeliveryDisputeOptions = {},
): DeliveryDisputeDecision {
  const dispute = record.dispute;
  const invalid = (message: string) => new DeliveryMarketplaceError(channel, "invalid_request", message);
  const conflict = (message: string) => new DeliveryMarketplaceError(channel, "conflict", message);
  if (!dispute) throw conflict("Este pedido não tem negociação aberta.");
  const expired = Boolean(dispute.expiresAt && Date.parse(dispute.expiresAt) <= now.getTime());
  const response = dispute.response;
  if (dispute.respondedAt || response?.state === "sent") throw conflict("A negociação já foi respondida; aguarde o app.");
  if (response) {
    // Resposta sem confirmação: pode não ter chegado, e esperar deixa o app aplicar a ação padrão no fim do prazo.
    const unconfirmed = response.state === "uncertain" || Date.parse(response.reservedAt) + DISPUTE_RESPONSE_STALE_MS <= now.getTime();
    if (!unconfirmed) throw conflict("Já existe uma resposta em andamento; aguarde alguns segundos e confira o pedido.");
    if (!expired && options.confirmUncertainRetry !== true) {
      throw conflict(
        `A resposta anterior ficou sem confirmação do app e pode não ter chegado. Confira no Portal do Parceiro se a negociação já foi respondida; se não foi, repita confirmando que conferiu${dispute.expiresAt ? ` (prazo da negociação: ${dispute.expiresAt})` : ""}.`,
      );
    }
  }
  if (expired) throw conflict("O prazo da negociação acabou; o app aplica a decisão padrão.");
  if (decision.kind === "accept") {
    // Negociação gravada antes destes campos existirem: tratada como sem lista.
    const reasons = dispute.acceptCancellationReasons ?? [];
    if (reasons.length === 0) return { kind: "accept" };
    const reason = decision.reason?.trim();
    if (!reason) throw invalid(`Escolha o motivo do aceite: ${reasons.join(", ")}.`);
    if (!reasons.includes(reason)) throw invalid("Motivo do aceite não está entre os aceitos pelo app para esta negociação.");
    // Mesmo corte do envio (clipDeliveryText): a resposta reservada e a autorização gravam o texto que vai ao app.
    const detailReason = decision.detailReason === undefined ? undefined : clipDeliveryText(decision.detailReason, 250);
    return { kind: "accept", reason, ...(detailReason ? { detailReason } : {}) };
  }
  if (decision.kind === "reject") {
    // iFood: negociação de atraso não tem recusa (400 CANCELLATION_WHILE_NEGOTIATION_TIME_CANNOT_BE_REJECTED).
    if (dispute.handshakeType === "DELAY") {
      throw new DeliveryMarketplaceError(channel, "conflict", "Negociação de atraso não pode ser recusada: aceite ou proponha um novo prazo.");
    }
    const reason = typeof decision.reason === "string" ? clipDeliveryText(decision.reason, 250) : "";
    if (!reason) throw invalid("Informe o motivo da recusa.");
    return { kind: "reject", reason };
  }
  const alternative = dispute.alternatives.find((candidate) => candidate.id === decision.alternativeId);
  if (!alternative) throw invalid("Proposta não pertence a esta negociação.");
  if (alternative.type === "REFUND" || alternative.type === "BENEFIT") {
    const amount = decision.amountCents;
    const max = alternative.maxAmountCents ?? null;
    if (max === null || (alternative.currency ?? "BRL") !== "BRL") {
      throw invalid("O app não informou o valor máximo desta proposta; responda pelo Portal do Parceiro.");
    }
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > max) {
      throw invalid(`Valor da proposta deve ser maior que zero e no máximo ${formatCents(max)}.`);
    }
    return { kind: "alternative", alternativeId: alternative.id, alternativeType: alternative.type, amountCents: amount, currency: "BRL" };
  }
  if (alternative.type === "ADDITIONAL_TIME") {
    const minutesAllowed = alternative.allowedAdditionalTimeInMinutes ?? [];
    const reasonsAllowed = alternative.allowedAdditionalTimeReasons ?? [];
    const minutes = decision.additionalTimeInMinutes;
    const reason = decision.additionalTimeReason?.trim();
    if (typeof minutes !== "number" || !minutesAllowed.includes(minutes)) {
      throw invalid(`Escolha um dos prazos aceitos pelo app: ${minutesAllowed.join(", ") || "nenhum"} minutos.`);
    }
    if (!reason || !reasonsAllowed.includes(reason)) {
      throw invalid(`Escolha um dos motivos aceitos pelo app: ${reasonsAllowed.join(", ") || "nenhum"}.`);
    }
    return { kind: "alternative", alternativeId: alternative.id, alternativeType: alternative.type, additionalTimeInMinutes: minutes, additionalTimeReason: reason };
  }
  throw invalid("Tipo de proposta desconhecido; responda pelo Portal do Parceiro.");
}

// O detalhe gravado deixou de valer (o app alterou o pedido): volta a ser buscado pela recuperação do ciclo e, até lá,
// o pedido não vira venda. O detalhe gravado só é trocado quando a busca trouxer o novo.
function reopenDetail(record: DeliveryOrderRecord, reason: string): void {
  record.detailPending = true;
  flag(record, reason);
}

function formatCents(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function flag(record: DeliveryOrderRecord, reason: string): void {
  record.needsReview = true;
  if (!record.reviewReasons.includes(reason)) record.reviewReasons.push(reason);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
