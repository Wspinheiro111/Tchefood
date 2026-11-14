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
}

const DELIVERY_STATUSES: ReadonlyArray<OwnDelivery['status']> = ['PREPARING', 'READY', 'OUT', 'DELIVERED', 'CANCELED'];
// Valores aceitos de cada campo de situação/tipo. O Record obriga a atualizar a lista quando
// o tipo ganha um valor novo (senão a leitura recusaria um valor válido, ou aceitaria um inválido).
const ITEM_STATUS: Record<ItemStatus, true> = { PENDING: true, PREPARING: true, READY: true, DELIVERED: true, CANCELED: true };
const SECTOR: Record<ProductionSector, true> = { KITCHEN: true, BAR: true, GRILL: true, DESSERT: true, NONE: true };
const ORIGIN: Record<OrderItemOrigin, true> = { WAITER: true, SMARTPOS: true, QRCODE_TABLE: true, KIOSK: true };
const WEIGHT_SOURCE: Record<WeightSource, true> = { SCALE: true, MANUAL: true };
const PAYMENT_METHOD: Record<PaymentMethod, true> = { CREDIT: true, DEBIT: true, PIX: true, VOUCHER: true, CASH: true };
const PAYMENT_STATUS: Record<PaymentStatus, true> = { PENDING: true, APPROVED: true, DECLINED: true, REFUNDED: true };
const ACQUIRER: Record<AcquirerType, true> = { STONE: true, PAGBANK: true, MOCK: true, CASH_DESK: true };
const FULFILLMENT: Record<FulfillmentType, true> = { DINE_IN: true, TAKEOUT: true, DELIVERY: true };

/** Valor de uma lista fechada; qualquer outro recusa a leitura inteira. */
function oneOf<T extends string>(v: unknown, allowed: Record<T, true>, what: string): T {
  if (typeof v !== 'string' || !Object.prototype.hasOwnProperty.call(allowed, v)) bad(`valor desconhecido em ${what}`);
  return v as T;
}

function oneOfOrNull<T extends string>(v: unknown, allowed: Record<T, true>, what: string): T | null {
  return v === null || v === undefined ? null : oneOf(v, allowed, what);
}
const ORDER_STATUSES: ReadonlyArray<Order['status']> = ['OPEN', 'PAYING', 'CLOSED', 'CANCELED'];
const TABLE_STATUSES: ReadonlyArray<DiningTable['status']> = ['FREE', 'OCCUPIED', 'WAITING_BILL', 'PAYING', 'DIRTY'];

function bad(what: string): never {
  throw new Error(`Não foi possível ler as contas da nuvem: ${what}.`);
}

function num(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) bad(`valor inválido em ${what}`);
  return n;
}

function numOrNull(v: unknown, what: string): number | null {
  return v === null || v === undefined ? null : num(v, what);
}

/** Data do servidor ("2026-11-14 03:41:59.12+00") no formato do aparelho (toISOString). */
function iso(v: unknown, what: string): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) bad(`data inválida em ${what}`);
  return new Date(t).toISOString();
}

function isoOrNull(v: unknown, what: string): string | null {
  return v === null || v === undefined ? null : iso(v, what);
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') bad(`campo vazio em ${what}`);
  return v;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function ids(v: unknown): UUID[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

type Row = Record<string, unknown>;

function toOrder(r: Row): Order {
  const status = r.status as Order['status'];
  if (!ORDER_STATUSES.includes(status)) bad('situação de conta desconhecida');
  return {
    id: str(r.id, 'orders.id'),
    tenant_id: str(r.tenant_id, 'orders.tenant_id'),
    table_id: str(r.table_id, 'orders.table_id'),
    opened_by_user_id: str(r.opened_by_user_id, 'orders.opened_by_user_id'),
    status,
    customer_count: num(r.customer_count, 'orders.customer_count'),
    customer_cpf: strOrNull(r.customer_cpf),
    subtotal_items: num(r.subtotal_items, 'orders.subtotal_items'),
    charge_service_fee: r.charge_service_fee === true,
    service_fee_pct: num(r.service_fee_pct, 'orders.service_fee_pct'),
    service_fee_amount: num(r.service_fee_amount, 'orders.service_fee_amount'),
    discount_amount: num(r.discount_amount, 'orders.discount_amount'),
    total_amount: num(r.total_amount, 'orders.total_amount'),
    paid_amount: num(r.paid_amount, 'orders.paid_amount'),
    remaining_balance: num(r.remaining_balance, 'orders.remaining_balance'),
    nfce_status: strOrNull(r.nfce_status),
    nfce_key: strOrNull(r.nfce_key),
    opened_at: iso(r.opened_at, 'orders.opened_at'),
    closed_at: isoOrNull(r.closed_at, 'orders.closed_at'),
    pickup_number: numOrNull(r.pickup_number, 'orders.pickup_number'),
    pickup_name: strOrNull(r.pickup_name),
    fulfillment_type: oneOfOrNull(r.fulfillment_type, FULFILLMENT, 'orders.fulfillment_type'),
  };
}

function toItem(r: Row): OrderItem {
  return {
    id: str(r.id, 'order_items.id'),
    order_id: str(r.order_id, 'order_items.order_id'),
    product_id: str(r.product_id, 'order_items.product_id'),
    waiter_id: str(r.waiter_id, 'order_items.waiter_id'),
    quantity: num(r.quantity, 'order_items.quantity'),
    unit_price: num(r.unit_price, 'order_items.unit_price'),
    modifiers_unit_price: num(r.modifiers_unit_price, 'order_items.modifiers_unit_price'),
    total_item_price: num(r.total_item_price, 'order_items.total_item_price'),
    meat_doneness: strOrNull(r.meat_doneness),
    notes: strOrNull(r.notes),
    sector: oneOf(r.sector, SECTOR, 'order_items.sector'),
    status: oneOf(r.status, ITEM_STATUS, 'order_items.status'),
    is_paid: r.is_paid === true,
    origin: oneOf(r.origin, ORIGIN, 'order_items.origin'),
    created_at: iso(r.created_at, 'order_items.created_at'),
    prepared_at: isoOrNull(r.prepared_at, 'order_items.prepared_at'),
    canceled_at: isoOrNull(r.canceled_at, 'order_items.canceled_at'),
    canceled_by_user_id: strOrNull(r.canceled_by_user_id),
    cancel_reason: strOrNull(r.cancel_reason),
    weight_gross_grams: numOrNull(r.weight_gross_grams, 'order_items.weight_gross_grams'),
    weight_tare_grams: numOrNull(r.weight_tare_grams, 'order_items.weight_tare_grams'),
    weight_source: oneOfOrNull(r.weight_source, WEIGHT_SOURCE, 'order_items.weight_source'),
    keg_volume_ml: numOrNull(r.keg_volume_ml, 'order_items.keg_volume_ml'),
    combo_parent_item_id: strOrNull(r.combo_parent_item_id),
    priced_at: isoOrNull(r.priced_at, 'order_items.priced_at'),
    half_product_ids: ids(r.half_product_ids),
    modifier_option_ids: ids(r.modifier_option_ids),
  };
}

function toPayment(r: Row): Payment {
  return {
    id: str(r.id, 'payments.id'),
    order_id: str(r.order_id, 'payments.order_id'),
    tenant_id: str(r.tenant_id, 'payments.tenant_id'),
    waiter_id: str(r.waiter_id, 'payments.waiter_id'),
    terminal_id: strOrNull(r.terminal_id),
    amount: num(r.amount, 'payments.amount'),
    tip_amount: num(r.tip_amount, 'payments.tip_amount'),
    method: oneOf(r.method, PAYMENT_METHOD, 'payments.method'),
    status: oneOf(r.status, PAYMENT_STATUS, 'payments.status'),
    acquirer: oneOf(r.acquirer, ACQUIRER, 'payments.acquirer'),
    acquirer_cnpj: strOrNull(r.acquirer_cnpj),
    card_brand: strOrNull(r.card_brand),
    nsu: strOrNull(r.nsu),
    authorization_code: strOrNull(r.authorization_code),
    terminal_serial: strOrNull(r.terminal_serial),
    idempotency_key: strOrNull(r.idempotency_key),
    created_at: iso(r.created_at, 'payments.created_at'),
  };
}

function toDelivery(r: Row): OwnDelivery {
  const status = r.status as OwnDelivery['status'];
  if (!DELIVERY_STATUSES.includes(status)) bad('situação de entrega desconhecida');
  return {
    id: str(r.id, 'own_deliveries.id'),
    tenant_id: str(r.tenant_id, 'own_deliveries.tenant_id'),
    order_id: str(r.order_id, 'own_deliveries.order_id'),
    customer_name: str(r.customer_name, 'own_deliveries.customer_name'),
    customer_phone: str(r.customer_phone, 'own_deliveries.customer_phone'),
    address: str(r.address, 'own_deliveries.address'),
    reference: strOrNull(r.reference),
    zone_id: str(r.zone_id, 'own_deliveries.zone_id'),
    zone_name: str(r.zone_name, 'own_deliveries.zone_name'),
    delivery_fee: num(r.delivery_fee, 'own_deliveries.delivery_fee'),
    pay_on_delivery: r.pay_on_delivery === true,
    change_for: numOrNull(r.change_for, 'own_deliveries.change_for'),
    status,
    courier_id: strOrNull(r.courier_id),
    courier_fee: numOrNull(r.courier_fee, 'own_deliveries.courier_fee'),
    out_at: isoOrNull(r.out_at, 'own_deliveries.out_at'),
    delivered_at: isoOrNull(r.delivered_at, 'own_deliveries.delivered_at'),
    settlement_id: strOrNull(r.settlement_id),
    created_at: iso(r.created_at, 'own_deliveries.created_at'),
  };
}

function toTable(r: Row): CloudTableOccupancy {
  const status = r.status as DiningTable['status'];
  if (!TABLE_STATUSES.includes(status)) bad('situação de mesa desconhecida');
  return { id: str(r.id, 'dining_tables.id'), status, current_order_id: strOrNull(r.current_order_id), updated_at: iso(r.updated_at, 'dining_tables.updated_at') };
}

function unique(rows: ReadonlyArray<{ id: string }>, what: string): void {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) bad(`${what} repetido na leitura`);
}

/**
 * Confere e converte a resposta do banco. Qualquer coisa fora do lugar (outra loja,
 * item ou pagamento de conta que não veio, linha repetida, número inválido) recusa a
 * leitura inteira: nada é aplicado pela metade.
 */
export function parseCloudOrders(body: unknown, tenantId: UUID): CloudOrders {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.orders) || !Array.isArray(b.order_items) || !Array.isArray(b.payments) || !Array.isArray(b.own_deliveries) || !Array.isArray(b.tables)) {
    bad('resposta incompleta');
  }
  if (b.tenant_id !== tenantId) bad('a resposta não é da loja deste aparelho');
  const orders = (b.orders as Row[]).map(toOrder);
  const orderItems = (b.order_items as Row[]).map(toItem);
  const payments = (b.payments as Row[]).map(toPayment);
  const ownDeliveries = (b.own_deliveries as Row[]).map(toDelivery);
  const tables = (b.tables as Row[]).map(toTable);
  unique(orders, 'conta');
  unique(orderItems, 'item');
  unique(payments, 'pagamento');
  unique(ownDeliveries, 'entrega');
  unique(tables, 'mesa');
  const orderIds = new Set(orders.map((o) => o.id));
  if (orders.some((o) => o.tenant_id !== tenantId)) bad('conta de outra loja');
  if (payments.some((p) => p.tenant_id !== tenantId)) bad('pagamento de outra loja');
  if (orderItems.some((i) => !orderIds.has(i.order_id))) bad('item de uma conta que não veio');
  if (payments.some((p) => !orderIds.has(p.order_id))) bad('pagamento de uma conta que não veio');
  if (ownDeliveries.some((d) => d.tenant_id !== tenantId)) bad('entrega de outra loja');
  if (ownDeliveries.some((d) => !orderIds.has(d.order_id))) bad('entrega de uma conta que não veio');
  if (new Set(ownDeliveries.map((d) => d.order_id)).size !== ownDeliveries.length) bad('duas entregas na mesma conta');
  return { tenant_id: tenantId, server_now: iso(b.server_now, 'server_now'), orders, orderItems, payments, ownDeliveries, tables };
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
    body: JSON.stringify({ p_order_ids: [...new Set(openHere)].slice(0, 500) }),
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
}

/**
 * Registros e contas pendentes. As ligações são as mesmas que a fila usa para manter a ordem
 * (recordKeys): item, pagamento, desconto, mesa e cashback contam como a conta. A conta com
 * cobrança em andamento na maquininha deste aparelho também fica como está.
 */
export function pendingOrderKeys(events: ReadonlyArray<SyncEvent>, chargingOrderIds: Iterable<UUID> = []): PendingOrderKeys {
  const rows = new Set<string>();
  const orders = new Set<UUID>(chargingOrderIds);
  for (const e of events) {
    for (const k of recordKeys(e)) {
      rows.add(k);
      if (k.startsWith('orders:')) orders.add(k.slice('orders:'.length));
    }
  }
  return { rows, orders };
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
 */
function mergeDeliveries(local: readonly OwnDelivery[], cloud: readonly OwnDelivery[], pending: PendingOrderKeys): OwnDelivery[] {
  const fromCloud = new Map(cloud.filter((c) => !pending.rows.has(`own_deliveries:${c.id}`)).map((c) => [c.id, c]));
  // Uma entrega por conta (order_id é UNIQUE no banco): uma linha daqui de outra id para a mesma
  // conta não fica ao lado da da nuvem, menos se ela estiver pendente.
  const cloudOrders = new Map(cloud.map((c) => [c.order_id, c.id]));
  const out: OwnDelivery[] = [];
  const seen = new Set<UUID>();
  for (const l of local) {
    seen.add(l.id);
    const c = fromCloud.get(l.id);
    if (c) out.push(c);
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
 * está pendente, ou quando ela mostra aqui uma conta aberta que a nuvem não mandou.
 */
export function mergeCloudOrders(
  local: {
    orders: readonly Order[];
    orderItems: readonly OrderItem[];
    payments: readonly Payment[];
    ownDeliveries: readonly OwnDelivery[];
    tables: readonly DiningTable[];
  },
  cloud: CloudOrders,
  pending: PendingOrderKeys,
): OrderMergeResult {
  const localById = new Map(local.orders.map((o) => [o.id, o]));
  const cloudById = new Map(cloud.orders.map((o) => [o.id, o]));
  const replaced = new Set<UUID>(cloud.orders.filter((o) => !pending.orders.has(o.id)).map((o) => o.id));

  const orders: Order[] = local.orders.map((l) => (replaced.has(l.id) ? withFiscal(cloudById.get(l.id)!, l) : l));
  for (const c of cloud.orders) if (replaced.has(c.id) && !localById.has(c.id)) orders.push(c);

  const orderItems = mergeChildren(local.orderItems, cloud.orderItems, replaced, 'order_items', pending);
  const payments = mergeChildren(local.payments, cloud.payments, replaced, 'payments', pending);
  const ownDeliveries = mergeDeliveries(local.ownDeliveries, cloud.ownDeliveries, pending);

  const occupancy = new Map(cloud.tables.map((t) => [t.id, t]));
  const tables = local.tables.map((t) => {
    const c = occupancy.get(t.id);
    if (!c) return t;
    if (pending.rows.has(`dining_tables:${t.id}`)) return t;
    if (t.current_order_id && pending.orders.has(t.current_order_id)) return t;
    // Mesa que mostra aqui uma conta aberta que a nuvem não mandou: a conta não some do mapa.
    const shown = t.current_order_id ? localById.get(t.current_order_id) : undefined;
    if (shown && ACTIVE.includes(shown.status) && !cloudById.has(shown.id) && c.current_order_id !== shown.id) return t;
    if (t.status === c.status && t.current_order_id === c.current_order_id) return t;
    return { ...t, status: c.status, current_order_id: c.current_order_id, updated_at: c.updated_at };
  });

  return { orders, orderItems, payments, ownDeliveries, tables, replaced: replaced.size };
}

/** Produto ou mesa que as contas da nuvem usam e este aparelho ainda não tem (pede a leitura dos cadastros). */
export function missingCatalog(cloud: CloudOrders, known: { productIds: Iterable<UUID>; tableIds: Iterable<UUID> }): boolean {
  const products = new Set(known.productIds);
  const tables = new Set(known.tableIds);
  return (
    cloud.orderItems.some((i) => !products.has(i.product_id) || i.half_product_ids.some((h) => !products.has(h)))
    || cloud.orders.some((o) => !tables.has(o.table_id))
  );
}
