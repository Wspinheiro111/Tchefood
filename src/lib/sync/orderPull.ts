/**
 * Nuvem → aparelho: contas, itens, pagamentos e ocupação das mesas.
 *
 * Com vários aparelhos na loja, cada um precisa ver a conta aberta no outro, a mesa que
 * outro garçom ocupou, o item que a cozinha marcou como pronto e a conta que o caixa
 * fechou. A nuvem manda no dinheiro: totais, pagamentos e situação da conta vêm do banco
 * (tchefood_pull_orders, db/schema_contas_aparelhos.sql), que refaz a conta a cada item e
 * pagamento. O aparelho continua trabalhando sem internet (a fila sobe depois) e só fica
 * com a versão dele de uma conta enquanto tem mudança dela que a nuvem ainda não aceitou:
 * evento na fila, evento recusado ou cobrança em andamento na maquininha deste aparelho.
 *
 * Fica como está no aparelho:
 *  - a conta com mudança daqui pendente (inteira: conta, itens e pagamentos), até subir;
 *  - a conta que a nuvem não mandou (encerrada há mais de 24 h: histórico deste aparelho;
 *    ou uma conta aberta que a nuvem não tem, que continua visível em vez de sumir);
 *  - a mesa com mudança daqui pendente, ou que mostra uma conta daqui ainda pendente.
 *
 * A entrega própria da conta desce junto (a cozinha de outro aparelho precisa saber que o
 * pedido é pago na entrega para preparar antes do pagamento); a entrega com mudança daqui
 * pendente fica como está.
 */
import type {
  AcquirerType,
  CashSession,
  DiningTable,
  FulfillmentType,
  ItemStatus,
  Order,
  OrderItem,
  OrderItemOrigin,
  OwnDelivery,
  Payment,
  PaymentMethod,
  PaymentStatus,
  ProductionSector,
  SyncEvent,
  UUID,
  WeightSource,
} from '../../types';
import { recordKeys, type FetchLike, type SyncConfig } from './supabaseSync';
import { COURIER_SETTLED_KEEP_MS, type CourierSettledRecently } from './courierSettle';

/** Ocupação da mesa como está na nuvem (o cadastro da mesa vem pela leitura dos cadastros). */
export type CloudTableOccupancy = Pick<DiningTable, 'id' | 'status' | 'current_order_id' | 'updated_at'>;

export interface CloudOrders {
  tenant_id: UUID;
  /** Relógio do servidor na hora da foto. */
  server_now: string;
  orders: Order[];
  orderItems: OrderItem[];
  payments: Payment[];
  ownDeliveries: OwnDelivery[];
  tables: CloudTableOccupancy[];
  /**
   * Caixas da loja abertos ou fechados nas últimas 24 h, só com o horário: o dinheiro recebido
   * em outro aparelho durante o caixa aberto lá não é alarme de "caixa fechado" aqui.
   * Não entram nos caixas deste aparelho (cashSessions).
   */
  cashSessions: CloudCashSession[];
  /**
   * Contas deixadas de fora da foto porque elas (ou um item, pagamento ou entrega delas) têm um
   * valor de lista fechada que esta versão do app não conhece (ex.: adquirente nova). Não estão em
   * orders/orderItems/payments/ownDeliveries; o merge deixa cada uma como está neste aparelho.
   * A mesa delas continua em tables. Aviso para a tela: skippedMessage (auditoria interna, rodada 8
   * do PR #54).
   */
  skippedOrderIds: UUID[];
}

/** Caixa como desce da nuvem: só o horário e a situação (sem valores nem quem operou). */
export type CloudCashSession = Pick<CashSession, 'id' | 'tenant_id' | 'status' | 'opened_at' | 'closed_at'>;

/** Aviso quando a leitura deixou alguma conta de lado (CloudOrders.skippedOrderIds). */
export const SKIPPED_ORDERS_MESSAGE = 'Uma conta da nuvem tem um valor que esta versão do app não conhece: atualize o app.';

/**
 * Texto para a tela ou o laço de sincronização mostrar quando a foto deixou contas de lado; null
 * quando não deixou nenhuma. A leitura deu certo (o resto foi aplicado): é um aviso, não um erro.
 */
export function skippedMessage(c: Pick<CloudOrders, 'skippedOrderIds'>): string | null {
  return c.skippedOrderIds.length > 0 ? SKIPPED_ORDERS_MESSAGE : null;
}

// Valores aceitos de cada campo de situação/tipo. O Record obriga a atualizar a lista quando
// o tipo ganha um valor novo (senão a leitura deixaria de lado uma conta válida, ou aceitaria um
// valor inválido).
const ORDER_STATUS: Record<Order['status'], true> = { OPEN: true, PAYING: true, CLOSED: true, CANCELED: true };
const DELIVERY_STATUS: Record<OwnDelivery['status'], true> = { PREPARING: true, READY: true, OUT: true, DELIVERED: true, CANCELED: true };
const ITEM_STATUS: Record<ItemStatus, true> = { PENDING: true, PREPARING: true, READY: true, DELIVERED: true, CANCELED: true };
const SECTOR: Record<ProductionSector, true> = { KITCHEN: true, BAR: true, GRILL: true, DESSERT: true, NONE: true };
const ORIGIN: Record<OrderItemOrigin, true> = { WAITER: true, SMARTPOS: true, QRCODE_TABLE: true, KIOSK: true };
const WEIGHT_SOURCE: Record<WeightSource, true> = { SCALE: true, MANUAL: true };
const PAYMENT_METHOD: Record<PaymentMethod, true> = { CREDIT: true, DEBIT: true, PIX: true, VOUCHER: true, CASH: true };
const PAYMENT_STATUS: Record<PaymentStatus, true> = { PENDING: true, APPROVED: true, DECLINED: true, REFUNDED: true };
// Lista fechada: um adquirente novo no tipo (ex.: MERCADO_PAGO do PR #49) quebra a compilação
// aqui até entrar na lista. Um aparelho com a versão antiga deixa de lado só a conta que o usa.
const ACQUIRER: Record<AcquirerType, true> = { STONE: true, PAGBANK: true, MOCK: true, CASH_DESK: true };
const FULFILLMENT: Record<FulfillmentType, true> = { DINE_IN: true, TAKEOUT: true, DELIVERY: true };
const TABLE_STATUS: Record<DiningTable['status'], true> = { FREE: true, OCCUPIED: true, WAITING_BILL: true, PAYING: true, DIRTY: true };
const CASH_STATUS: Record<CashSession['status'], true> = { OPEN: true, CLOSED: true };

function bad(what: string): never {
  throw new Error(`Não foi possível ler as contas da nuvem: ${what}.`);
}

/**
 * Valores desconhecidos de lista fechada achados numa linha. Valor desconhecido (texto que esta
 * versão do app não conhece) não recusa a leitura: deixa a conta da linha de lado (versão nova do
 * app ou do banco em outro aparelho; auditoria interna, rodada 8 do PR #54). Tipo errado continua
 * recusando a leitura inteira.
 */
type Unknowns = string[];

/**
 * Valor de uma lista fechada. Texto fora da lista é anotado em `unknown` (a conta fica de lado) e
 * volta como veio: a linha nunca sai de parseCloudOrders. Sem `unknown`, recusa a leitura.
 */
function oneOf<T extends string>(v: unknown, allowed: Record<T, true>, what: string, unknown?: Unknowns): T {
  if (typeof v !== 'string') bad(`valor inválido em ${what}`);
  if (!Object.prototype.hasOwnProperty.call(allowed, v)) {
    if (!unknown) bad(`valor desconhecido em ${what}`);
    unknown.push(what);
  }
  return v as T;
}

function oneOfOrNull<T extends string>(v: unknown, allowed: Record<T, true>, what: string, unknown: Unknowns): T | null {
  return v === null || v === undefined ? null : oneOf(v, allowed, what, unknown);
}

// Número como o banco manda: numeric e int em jsonb (to_jsonb) chegam como número; o texto
// decimal simples ("55.00") também vale. Notação científica, hexadecimal, espaços e Infinity não.
const DECIMAL = /^-?\d+(\.\d+)?$/;

function num(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) bad(`valor inválido em ${what}`);
  return n;
}

function numOrNull(v: unknown, what: string): number | null {
  return v === null || v === undefined ? null : num(v, what);
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') bad(`valor inválido em ${what}`);
  return v;
}

// Data do servidor com hora e fuso: to_jsonb(timestamptz) manda "2026-11-14T03:41:59.123456+00:00";
// o texto do Postgres, "2026-11-14 03:41:59.12+00". Sem fuso, Date.parse leria a hora local.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

/** Data do servidor no formato do aparelho (toISOString). */
function iso(v: unknown, what: string): string {
  const t = typeof v === 'string' && TIMESTAMP.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) bad(`data inválida em ${what}`);
  return new Date(t).toISOString();
}

function isoOrNull(v: unknown, what: string): string | null {
  return v === null || v === undefined ? null : iso(v, what);
}

/** Texto obrigatório e não vazio (ids e campos com CHECK de tamanho no banco). */
function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') bad(`campo vazio em ${what}`);
  return v;
}

/** Texto obrigatório que o banco aceita vazio (NOT NULL sem CHECK de tamanho). */
function text(v: unknown, what: string): string {
  if (typeof v !== 'string') bad(`valor inválido em ${what}`);
  return v;
}

function strOrNull(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') bad(`valor inválido em ${what}`);
  return v;
}

/** Lista de ids (UUID[] NOT NULL DEFAULT '{}' no banco). */
function ids(v: unknown, what: string): UUID[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`lista inválida em ${what}`);
  return [...(v as UUID[])];
}

type Row = Record<string, unknown>;

function toOrder(r: Row, u: Unknowns): Order {
  return {
    id: str(r.id, 'orders.id'),
    tenant_id: str(r.tenant_id, 'orders.tenant_id'),
    table_id: str(r.table_id, 'orders.table_id'),
    opened_by_user_id: str(r.opened_by_user_id, 'orders.opened_by_user_id'),
    status: oneOf(r.status, ORDER_STATUS, 'orders.status', u),
    customer_count: num(r.customer_count, 'orders.customer_count'),
    customer_cpf: strOrNull(r.customer_cpf, 'orders.customer_cpf'),
    subtotal_items: num(r.subtotal_items, 'orders.subtotal_items'),
    charge_service_fee: bool(r.charge_service_fee, 'orders.charge_service_fee'),
    service_fee_pct: num(r.service_fee_pct, 'orders.service_fee_pct'),
    service_fee_amount: num(r.service_fee_amount, 'orders.service_fee_amount'),
    discount_amount: num(r.discount_amount, 'orders.discount_amount'),
    total_amount: num(r.total_amount, 'orders.total_amount'),
    paid_amount: num(r.paid_amount, 'orders.paid_amount'),
    remaining_balance: num(r.remaining_balance, 'orders.remaining_balance'),
    nfce_status: strOrNull(r.nfce_status, 'orders.nfce_status'),
    nfce_key: strOrNull(r.nfce_key, 'orders.nfce_key'),
    opened_at: iso(r.opened_at, 'orders.opened_at'),
    closed_at: isoOrNull(r.closed_at, 'orders.closed_at'),
    pickup_number: numOrNull(r.pickup_number, 'orders.pickup_number'),
    pickup_name: strOrNull(r.pickup_name, 'orders.pickup_name'),
    fulfillment_type: oneOfOrNull(r.fulfillment_type, FULFILLMENT, 'orders.fulfillment_type', u),
  };
}

function toItem(r: Row, u: Unknowns): OrderItem {
  return {
    id: str(r.id, 'order_items.id'),
    order_id: str(r.order_id, 'order_items.order_id'),
    product_id: str(r.product_id, 'order_items.product_id'),
    waiter_id: str(r.waiter_id, 'order_items.waiter_id'),
    quantity: num(r.quantity, 'order_items.quantity'),
    unit_price: num(r.unit_price, 'order_items.unit_price'),
    modifiers_unit_price: num(r.modifiers_unit_price, 'order_items.modifiers_unit_price'),
    total_item_price: num(r.total_item_price, 'order_items.total_item_price'),
    meat_doneness: strOrNull(r.meat_doneness, 'order_items.meat_doneness'),
    notes: strOrNull(r.notes, 'order_items.notes'),
    sector: oneOf(r.sector, SECTOR, 'order_items.sector', u),
    status: oneOf(r.status, ITEM_STATUS, 'order_items.status', u),
    is_paid: bool(r.is_paid, 'order_items.is_paid'),
    origin: oneOf(r.origin, ORIGIN, 'order_items.origin', u),
    created_at: iso(r.created_at, 'order_items.created_at'),
    prepared_at: isoOrNull(r.prepared_at, 'order_items.prepared_at'),
    canceled_at: isoOrNull(r.canceled_at, 'order_items.canceled_at'),
    canceled_by_user_id: strOrNull(r.canceled_by_user_id, 'order_items.canceled_by_user_id'),
    cancel_reason: strOrNull(r.cancel_reason, 'order_items.cancel_reason'),
    weight_gross_grams: numOrNull(r.weight_gross_grams, 'order_items.weight_gross_grams'),
    weight_tare_grams: numOrNull(r.weight_tare_grams, 'order_items.weight_tare_grams'),
    weight_source: oneOfOrNull(r.weight_source, WEIGHT_SOURCE, 'order_items.weight_source', u),
    keg_volume_ml: numOrNull(r.keg_volume_ml, 'order_items.keg_volume_ml'),
    combo_parent_item_id: strOrNull(r.combo_parent_item_id, 'order_items.combo_parent_item_id'),
    priced_at: isoOrNull(r.priced_at, 'order_items.priced_at'),
    half_product_ids: ids(r.half_product_ids, 'order_items.half_product_ids'),
    modifier_option_ids: ids(r.modifier_option_ids, 'order_items.modifier_option_ids'),
  };
}

function toPayment(r: Row, u: Unknowns): Payment {
  return {
    id: str(r.id, 'payments.id'),
    order_id: str(r.order_id, 'payments.order_id'),
    tenant_id: str(r.tenant_id, 'payments.tenant_id'),
    waiter_id: str(r.waiter_id, 'payments.waiter_id'),
    terminal_id: strOrNull(r.terminal_id, 'payments.terminal_id'),
    amount: num(r.amount, 'payments.amount'),
    tip_amount: num(r.tip_amount, 'payments.tip_amount'),
    method: oneOf(r.method, PAYMENT_METHOD, 'payments.method', u),
    status: oneOf(r.status, PAYMENT_STATUS, 'payments.status', u),
    acquirer: oneOf(r.acquirer, ACQUIRER, 'payments.acquirer', u),
    acquirer_cnpj: strOrNull(r.acquirer_cnpj, 'payments.acquirer_cnpj'),
    card_brand: strOrNull(r.card_brand, 'payments.card_brand'),
    nsu: strOrNull(r.nsu, 'payments.nsu'),
    authorization_code: strOrNull(r.authorization_code, 'payments.authorization_code'),
    terminal_serial: strOrNull(r.terminal_serial, 'payments.terminal_serial'),
    idempotency_key: strOrNull(r.idempotency_key, 'payments.idempotency_key'),
    created_at: iso(r.created_at, 'payments.created_at'),
  };
}

function toDelivery(r: Row, u: Unknowns): OwnDelivery {
  return {
    id: str(r.id, 'own_deliveries.id'),
    tenant_id: str(r.tenant_id, 'own_deliveries.tenant_id'),
    order_id: str(r.order_id, 'own_deliveries.order_id'),
    // customer_name, customer_phone e address têm CHECK de tamanho no banco (db/schema_entrega.sql).
    customer_name: str(r.customer_name, 'own_deliveries.customer_name'),
    customer_phone: str(r.customer_phone, 'own_deliveries.customer_phone'),
    address: str(r.address, 'own_deliveries.address'),
    reference: strOrNull(r.reference, 'own_deliveries.reference'),
    zone_id: str(r.zone_id, 'own_deliveries.zone_id'),
    // zone_name é NOT NULL sem CHECK de tamanho: o banco aceita '' (auditoria interna, rodada 8 do PR #54).
    zone_name: text(r.zone_name, 'own_deliveries.zone_name'),
    delivery_fee: num(r.delivery_fee, 'own_deliveries.delivery_fee'),
    pay_on_delivery: bool(r.pay_on_delivery, 'own_deliveries.pay_on_delivery'),
    change_for: numOrNull(r.change_for, 'own_deliveries.change_for'),
    status: oneOf(r.status, DELIVERY_STATUS, 'own_deliveries.status', u),
    courier_id: strOrNull(r.courier_id, 'own_deliveries.courier_id'),
    courier_fee: numOrNull(r.courier_fee, 'own_deliveries.courier_fee'),
    out_at: isoOrNull(r.out_at, 'own_deliveries.out_at'),
    delivered_at: isoOrNull(r.delivered_at, 'own_deliveries.delivered_at'),
    settlement_id: strOrNull(r.settlement_id, 'own_deliveries.settlement_id'),
    created_at: iso(r.created_at, 'own_deliveries.created_at'),
  };
}

// Mesa e caixa não são de uma conta: valor desconhecido neles continua recusando a leitura.
function toTable(r: Row): CloudTableOccupancy {
  return {
    id: str(r.id, 'dining_tables.id'),
    status: oneOf(r.status, TABLE_STATUS, 'dining_tables.status'),
    current_order_id: strOrNull(r.current_order_id, 'dining_tables.current_order_id'),
    updated_at: iso(r.updated_at, 'dining_tables.updated_at'),
  };
}

function toCashSession(r: Row): CloudCashSession {
  const status = oneOf(r.status, CASH_STATUS, 'cash_sessions.status');
  const opened_at = iso(r.opened_at, 'cash_sessions.opened_at');
  const closed_at = isoOrNull(r.closed_at, 'cash_sessions.closed_at');
  // A mesma regra do banco (cash_sessions_closed_fields): aberto sem fechamento, fechado com
  // fechamento depois da abertura.
  if (status === 'OPEN' ? closed_at !== null : closed_at === null || closed_at < opened_at) bad('horário de caixa inválido');
  return { id: str(r.id, 'cash_sessions.id'), tenant_id: str(r.tenant_id, 'cash_sessions.tenant_id'), status, opened_at, closed_at };
}

function unique(rows: ReadonlyArray<{ id: string }>, what: string): void {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) bad(`${what} repetido na leitura`);
}

/** Converte cada linha; anota em `skip` a conta (orderId da linha) que tem valor desconhecido. */
function rows<T>(list: Row[], convert: (r: Row, u: Unknowns) => T, orderId: (t: T) => UUID, skip: Set<UUID>): T[] {
  return list.map((r) => {
    const u: Unknowns = [];
    const t = convert(r, u);
    if (u.length > 0) skip.add(orderId(t));
    return t;
  });
}

/**
 * Confere e converte a resposta do banco. Qualquer coisa fora do lugar (outra loja, item ou
 * pagamento de conta que não veio, linha repetida, tipo errado, número ou data inválidos) recusa
 * a leitura inteira: nada é aplicado pela metade. Todas as linhas são conferidas assim, também
 * as das contas deixadas de lado.
 *
 * Exceção (auditoria interna, rodada 8 do PR #54): um texto de lista fechada que esta versão do
 * app não conhece (adquirente, origem, setor, situação ou forma de pagamento novos, de uma versão
 * mais nova do app ou do banco) deixa de lado só a conta dele (conta, itens, pagamentos e
 * entrega), em skippedOrderIds. Sem isso, um valor novo pararia a leitura das contas da loja
 * inteira em todo aparelho com a versão antiga.
 */
export function parseCloudOrders(body: unknown, tenantId: UUID): CloudOrders {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.orders) || !Array.isArray(b.order_items) || !Array.isArray(b.payments) || !Array.isArray(b.own_deliveries) || !Array.isArray(b.tables) || !Array.isArray(b.cash_sessions)) {
    bad('resposta incompleta');
  }
  if (b.tenant_id !== tenantId) bad('a resposta não é da loja deste aparelho');
  const skip = new Set<UUID>();
  const orders = rows(b.orders as Row[], toOrder, (o) => o.id, skip);
  const orderItems = rows(b.order_items as Row[], toItem, (i) => i.order_id, skip);
  const payments = rows(b.payments as Row[], toPayment, (p) => p.order_id, skip);
  const ownDeliveries = rows(b.own_deliveries as Row[], toDelivery, (d) => d.order_id, skip);
  const tables = (b.tables as Row[]).map(toTable);
  const cashSessions = (b.cash_sessions as Row[]).map(toCashSession);
  unique(orders, 'conta');
  unique(orderItems, 'item');
  unique(payments, 'pagamento');
  unique(ownDeliveries, 'entrega');
  unique(tables, 'mesa');
  unique(cashSessions, 'caixa');
  const orderIds = new Set(orders.map((o) => o.id));
  if (orders.some((o) => o.tenant_id !== tenantId)) bad('conta de outra loja');
  if (payments.some((p) => p.tenant_id !== tenantId)) bad('pagamento de outra loja');
  if (orderItems.some((i) => !orderIds.has(i.order_id))) bad('item de uma conta que não veio');
  if (payments.some((p) => !orderIds.has(p.order_id))) bad('pagamento de uma conta que não veio');
  if (ownDeliveries.some((d) => d.tenant_id !== tenantId)) bad('entrega de outra loja');
  if (ownDeliveries.some((d) => !orderIds.has(d.order_id))) bad('entrega de uma conta que não veio');
  if (new Set(ownDeliveries.map((d) => d.order_id)).size !== ownDeliveries.length) bad('duas entregas na mesma conta');
  if (cashSessions.some((c) => c.tenant_id !== tenantId)) bad('caixa de outra loja');
  if (cashSessions.filter((c) => c.status === 'OPEN').length > 1) bad('dois caixas abertos na loja');
  const server_now = iso(b.server_now, 'server_now');
  const kept = <T extends { order_id: UUID }>(list: T[]) => list.filter((x) => !skip.has(x.order_id));
  return {
    tenant_id: tenantId,
    server_now,
    orders: orders.filter((o) => !skip.has(o.id)),
    orderItems: kept(orderItems),
    payments: kept(payments),
    ownDeliveries: kept(ownDeliveries),
    tables,
    cashSessions,
    skippedOrderIds: orders.filter((o) => skip.has(o.id)).map((o) => o.id),
  };
}

const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Contas que a leitura pede pelo id (em lotes de 500, reconcileWindow): as em aberto aqui e
 * as das entregas próprias ainda sem acerto aqui, em qualquer data. Assim a entrega acertada em
 * outro aparelho com a conta encerrada há mais de 24 h desce com o acerto e sai do acerto deste
 * aparelho, que senão a mandaria em todo acerto daquele entregador e seria sempre recusado
 * (Codex no PR #54). Só ids UUID: um banco ainda sem a migração recusaria a leitura inteira.
 */
export function orderIdsToReconcile(s: { orders: readonly Pick<Order, 'id' | 'status'>[]; ownDeliveries: readonly Pick<OwnDelivery, 'order_id' | 'status' | 'settlement_id'>[] }): UUID[] {
  const open = s.orders.filter((o) => o.status === 'OPEN' || o.status === 'PAYING').map((o) => o.id);
  const unsettled = s.ownDeliveries.filter((d) => d.status !== 'CANCELED' && d.settlement_id === null).map((d) => d.order_id);
  return [...new Set([...open, ...unsettled])].filter((id) => ORDER_ID_RE.test(id));
}

/** Ids por leitura (o banco lê até 500 de `p_order_ids`). */
export const RECONCILE_BATCH = 500;

/**
 * Lote de ids pedidos nesta leitura quando passam do limite (GPT, rodada 13 do PR #54): a lista
 * vai em ordem de id e cada leitura pede o lote seguinte, voltando ao começo depois do último.
 * Assim toda conta em aberto aqui e toda entrega sem acerto é pedida a cada
 * ceil(n / 500) leituras, em vez de as mesmas 500 primeiras sempre. A junção já trata a resposta
 * como parte: conta pedida que não veio fica como está e é pedida de novo no próximo giro.
 * `cursor` é a posição do próximo lote; devolve o lote e a posição seguinte.
 */
export function reconcileWindow(ids: readonly UUID[], cursor: number, size = RECONCILE_BATCH): { ids: UUID[]; next: number } {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length <= size) return { ids: sorted, next: 0 };
  const start = Number.isInteger(cursor) && cursor > 0 ? cursor % sorted.length : 0;
  const batch = [...sorted.slice(start, start + size), ...sorted.slice(0, Math.max(0, start + size - sorted.length))];
  return { ids: batch, next: (start + size) % sorted.length };
}

/**
 * Contas, itens, pagamentos e ocupação das mesas da loja do token, numa foto só do banco.
 * `openHere`: contas em aberto neste aparelho; o banco as devolve mesmo encerradas há mais
 * de 24 h (aparelho que ficou mais de um dia sem internet recebe o fechamento feito em outro).
 */
export async function fetchCloudOrders(cfg: SyncConfig, tenantId: UUID, fetchFn: FetchLike, openHere: UUID[] = []): Promise<CloudOrders> {
  const res = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/tchefood_pull_orders`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_order_ids: [...new Set(openHere)].slice(0, RECONCILE_BATCH) }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let message = text || `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // resposta sem JSON: fica o texto
    }
    throw new Error(`Não foi possível ler as contas da nuvem: ${message}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text || 'null');
  } catch {
    bad('resposta inválida');
  }
  return parseCloudOrders(body, tenantId);
}

// ---------------------------------------------------------------------------
// Aplicar sem passar por cima do que ainda não subiu deste aparelho
// ---------------------------------------------------------------------------

/** O que segura a versão deste aparelho: registros e contas com mudança pendente. */
export interface PendingOrderKeys {
  /** `${tabela}:${id}` de cada registro com evento na fila ou recusado. */
  rows: Set<string>;
  /** Contas com qualquer mudança pendente (a própria conta, item, pagamento, mesa ou cashback dela). */
  orders: Set<UUID>;
  /**
   * Contas de itens atrasados (moveLateItemsToNewOrder) cuja abertura a nuvem recusou com mesa
   * ocupada: a mesa já é de outro cliente na nuvem. A mesa que mostra uma delas aqui passa a
   * mostrar a conta da nuvem, mesmo com a conta pendente; a conta fica aqui (recusada) até ser
   * descartada ou reenviada (auditoria interna, rodada 8 do PR #54). Ausente = nenhuma.
   */
  tableTakenOrders?: ReadonlySet<UUID>;
}

/**
 * Registros e contas pendentes. As ligações são as mesmas que a fila usa para manter a ordem
 * (recordKeys): item, pagamento, desconto, mesa e cashback contam como a conta. A conta com
 * cobrança em andamento na maquininha deste aparelho também fica como está.
 */
export function pendingOrderKeys(
  events: ReadonlyArray<SyncEvent>,
  chargingOrderIds: Iterable<UUID> = [],
  tableTakenOrderIds: Iterable<UUID> = [],
): PendingOrderKeys {
  const rows = new Set<string>();
  const orders = new Set<UUID>(chargingOrderIds);
  for (const e of events) {
    for (const k of recordKeys(e)) {
      rows.add(k);
      if (k.startsWith('orders:')) orders.add(k.slice('orders:'.length));
    }
  }
  return { rows, orders, tableTakenOrders: new Set(tableTakenOrderIds) };
}

const ACTIVE: ReadonlyArray<Order['status']> = ['OPEN', 'PAYING'];

export interface OrderMergeResult {
  orders: Order[];
  orderItems: OrderItem[];
  payments: Payment[];
  ownDeliveries: OwnDelivery[];
  tables: DiningTable[];
  /** Contas trocadas pela versão da nuvem (para testes e diagnóstico). */
  replaced: number;
}

/**
 * Situação fiscal: a NFC-e deste aparelho ainda é simulação e nunca sobe; a do servidor
 * (emit-nfce) vale quando ele já tem uma. Sem nada no servidor, fica a daqui.
 */
function withFiscal(cloud: Order, local: Order | undefined): Order {
  if (!local) return cloud;
  const serverHas = cloud.nfce_status !== null && cloud.nfce_status !== 'PENDING';
  return serverHas ? cloud : { ...cloud, nfce_status: local.nfce_status, nfce_key: local.nfce_key };
}

/** Linhas filhas (itens, pagamentos): as das contas trocadas vêm da nuvem, menos as pendentes daqui. */
function mergeChildren<T extends { id: UUID; order_id: UUID }>(
  local: readonly T[],
  cloud: readonly T[],
  replaced: Set<UUID>,
  table: 'order_items' | 'payments',
  pending: PendingOrderKeys,
): T[] {
  const isPendingRow = (r: T) => pending.rows.has(`${table}:${r.id}`);
  const fromCloud = new Map(cloud.filter((c) => replaced.has(c.order_id)).map((c) => [c.id, c]));
  const out: T[] = [];
  const seen = new Set<UUID>();
  for (const l of local) {
    seen.add(l.id);
    if (isPendingRow(l)) {
      out.push(l);
      continue;
    }
    const c = fromCloud.get(l.id);
    if (c) out.push(c);
    else if (!replaced.has(l.order_id)) out.push(l);
    // Linha de conta trocada que a nuvem não tem e não está pendente: o banco não a tem, sai.
  }
  for (const c of fromCloud.values()) if (!seen.has(c.id)) out.push(c);
  return out;
}

/**
 * Entregas próprias: a da nuvem vale, menos a com mudança daqui pendente (evento na fila ou
 * recusado). A entrega que a nuvem não mandou fica (conta antiga, ou ainda não subiu).
 * Entrega que este aparelho acertou pela nuvem há pouco (recent, até COURIER_SETTLED_KEEP_MS) e
 * que a nuvem manda sem acerto fica com o acerto daqui: a foto foi lida antes de o acerto ser
 * gravado (auditoria interna, rodada 8 do PR #54).
 */
function mergeDeliveries(
  local: readonly OwnDelivery[],
  cloud: readonly OwnDelivery[],
  pending: PendingOrderKeys,
  recent: readonly CourierSettledRecently[],
  now: number,
): OwnDelivery[] {
  const settledHere = new Map<UUID, UUID>();
  for (const r of recent) if (now - r.at <= COURIER_SETTLED_KEEP_MS) for (const id of r.delivery_ids) settledHere.set(id, r.settlement_id);
  const keepSettlement = (c: OwnDelivery, l: OwnDelivery): OwnDelivery =>
    c.settlement_id === null && l.settlement_id !== null && settledHere.get(l.id) === l.settlement_id ? { ...c, settlement_id: l.settlement_id } : c;
  const fromCloud = new Map(cloud.filter((c) => !pending.rows.has(`own_deliveries:${c.id}`)).map((c) => [c.id, c]));
  // Uma entrega por conta (order_id é UNIQUE no banco): uma linha daqui de outra id para a mesma
  // conta não fica ao lado da da nuvem, menos se ela estiver pendente.
  const cloudOrders = new Map(cloud.map((c) => [c.order_id, c.id]));
  const out: OwnDelivery[] = [];
  const seen = new Set<UUID>();
  for (const l of local) {
    seen.add(l.id);
    const c = fromCloud.get(l.id);
    if (c) out.push(keepSettlement(c, l));
    else if (pending.rows.has(`own_deliveries:${l.id}`)) out.push(l);
    else if (cloudOrders.has(l.order_id) && cloudOrders.get(l.order_id) !== l.id) continue;
    else out.push(l);
  }
  for (const c of fromCloud.values()) if (!seen.has(c.id)) out.push(c);
  return out;
}

/**
 * Junta as contas da nuvem às do aparelho. Conta sem nada pendente aqui fica igual à da
 * nuvem (conta, itens e pagamentos); conta com algo pendente fica inteira como está aqui.
 * A ocupação da mesa vem da nuvem, menos quando a mesa (ou a conta que ela mostra aqui)
 * está pendente, ou quando ela mostra aqui uma conta aberta que a nuvem não mandou (a conta
 * deixada de lado na leitura, skippedOrderIds, conta como mandada: a nuvem a tem).
 * Exceção: a mesa que mostra aqui uma conta de itens atrasados recusada com mesa ocupada
 * (pending.tableTakenOrders) mostra a conta que ocupa a mesa na nuvem.
 * A mesa ocupada na nuvem por uma conta deixada de lado na leitura (skippedOrderIds, valor
 * que esta versão não conhece) também vem da nuvem: ela está ocupada de verdade, e abrir outra
 * conta nela aqui seria recusado com mesa ocupada (auditoria interna, rodada 8 do PR #54).
 */
export function mergeCloudOrders(
  local: {
    orders: readonly Order[];
    orderItems: readonly OrderItem[];
    payments: readonly Payment[];
    ownDeliveries: readonly OwnDelivery[];
    tables: readonly DiningTable[];
    /** Entregas acertadas pela nuvem há pouco neste aparelho (ausente = nenhuma). */
    courierSettledRecently?: readonly CourierSettledRecently[];
  },
  cloud: CloudOrders,
  pending: PendingOrderKeys,
  now: number = Date.now(),
): OrderMergeResult {
  const localById = new Map(local.orders.map((o) => [o.id, o]));
  const cloudById = new Map(cloud.orders.map((o) => [o.id, o]));
  const replaced = new Set<UUID>(cloud.orders.filter((o) => !pending.orders.has(o.id)).map((o) => o.id));

  const orders: Order[] = local.orders.map((l) => (replaced.has(l.id) ? withFiscal(cloudById.get(l.id)!, l) : l));
  for (const c of cloud.orders) if (replaced.has(c.id) && !localById.has(c.id)) orders.push(c);

  const orderItems = mergeChildren(local.orderItems, cloud.orderItems, replaced, 'order_items', pending);
  const payments = mergeChildren(local.payments, cloud.payments, replaced, 'payments', pending);
  const ownDeliveries = mergeDeliveries(local.ownDeliveries, cloud.ownDeliveries, pending, local.courierSettledRecently ?? [], now);

  const occupancy = new Map(cloud.tables.map((t) => [t.id, t]));
  const skipped = new Set<UUID>(cloud.skippedOrderIds ?? []);
  const tables = local.tables.map((t) => {
    const c = occupancy.get(t.id);
    if (!c) return t;
    // Conta de itens atrasados recusada com mesa ocupada: sem isto a mesa ficaria presa nela aqui
    // para sempre (ela nunca sobe), e o garçom lançaria os itens do cliente novo atrás da
    // recusa. Só quando a nuvem diz quem ocupa a mesa; com a mesa livre lá, o reenvio da conta
    // sobe (auditoria interna, rodada 8 do PR #54).
    if (t.current_order_id && pending.tableTakenOrders?.has(t.current_order_id) && c.current_order_id && c.current_order_id !== t.current_order_id) {
      return { ...t, status: c.status, current_order_id: c.current_order_id, updated_at: c.updated_at };
    }
    if (pending.rows.has(`dining_tables:${t.id}`)) return t;
    if (t.current_order_id && pending.orders.has(t.current_order_id)) return t;
    // Mesa que mostra aqui uma conta aberta que a nuvem não mandou: a conta não some do mapa.
    // A conta deixada de lado na leitura (skippedOrderIds) a nuvem tem: com a mesa livre lá ou
    // com outra conta, a mesa segue a nuvem (a conta encerrada lá não prende a mesa aqui para
    // sempre); a conta fica aqui como está (auditoria interna, rodada 8 do PR #54).
    const shown = t.current_order_id ? localById.get(t.current_order_id) : undefined;
    if (shown && ACTIVE.includes(shown.status) && !cloudById.has(shown.id) && !skipped.has(shown.id) && c.current_order_id !== shown.id) return t;
    if (t.status === c.status && t.current_order_id === c.current_order_id) return t;
    return { ...t, status: c.status, current_order_id: c.current_order_id, updated_at: c.updated_at };
  });

  return { orders, orderItems, payments, ownDeliveries, tables, replaced: replaced.size };
}

/**
 * Adicionais que os itens das contas da nuvem usam e este aparelho não tem, fora os já
 * conferidos (checked): pedem a leitura dos cadastros antes de aplicar (GPT, rodadas 6 e 7 do
 * PR #54). Conferido é o adicional que continuou faltando depois de uma leitura dos cadastros
 * que começou depois de a foto das contas que o trazia ser lida e deu certo: o adicional
 * apagado na nuvem some do cadastro deste aparelho, e o banco aceita, com PIN de gerente, item
 * com adicional que o cadastro não reconhece. Esses nunca chegam; sem a lista, a cada 10 s os
 * cadastros seriam lidos de novo. Não usa o horário do item nem o da última leitura: o item
 * vem com o relógio de outro aparelho, ou sobe atrasado de um lançamento sem internet.
 */
export function missingModifiers(cloud: CloudOrders, knownOptionIds: Iterable<UUID>, checked: ReadonlySet<UUID> = new Set()): UUID[] {
  const known = new Set(knownOptionIds);
  const out = new Set<UUID>();
  for (const i of cloud.orderItems) for (const m of i.modifier_option_ids) if (!known.has(m) && !checked.has(m)) out.add(m);
  return [...out];
}

/**
 * Sabores do meio a meio que os itens das contas da nuvem usam e este aparelho não tem, fora
 * os já conferidos (checked), com a mesma regra dos adicionais (missingModifiers): o banco
 * aceita, com PIN de gerente, item com sabor que o cadastro não reconhece (half_product_ids não
 * tem chave estrangeira), e esse sabor nunca chega. Sem a regra, a leitura das contas da loja
 * inteira ficaria parada (auditoria interna da rodada 7 do PR #54).
 */
export function missingHalves(cloud: CloudOrders, knownProductIds: Iterable<UUID>, checked: ReadonlySet<UUID> = new Set()): UUID[] {
  const known = new Set(knownProductIds);
  const out = new Set<UUID>();
  for (const i of cloud.orderItems) for (const h of i.half_product_ids) if (!known.has(h) && !checked.has(h)) out.add(h);
  return [...out];
}

/**
 * Produto (product_id) ou mesa que as contas da nuvem usam e este aparelho ainda não tem (pede
 * a leitura dos cadastros). Os dois têm chave estrangeira no banco: sempre chegam numa leitura.
 */
export function missingCatalog(cloud: CloudOrders, known: { productIds: Iterable<UUID>; tableIds: Iterable<UUID> }): boolean {
  const products = new Set(known.productIds);
  const tables = new Set(known.tableIds);
  return (
    cloud.orderItems.some((i) => !products.has(i.product_id))
    || cloud.orders.some((o) => !tables.has(o.table_id))
  );
}
