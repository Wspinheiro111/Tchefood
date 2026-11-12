/**
 * Nuvem → aparelho: o aparelho baixa os cadastros da loja.
 *
 *  - Aparelho novo ("Baixar a loja desta conta"): lê a equipe sem PIN, um gerente ou
 *    proprietário escolhe o próprio nome e digita o PIN, o servidor confere e entrega
 *    a equipe com os PINs (tchefood_pull_staff, db/schema_baixar_loja.sql). Aí o
 *    aparelho troca os dados dele pelos da loja.
 *  - Aparelho já ligado: a cada minuto, com a fila vazia, lê de novo os cadastros e
 *    aplica o que mudou em outro aparelho. Registro com mudança deste aparelho ainda
 *    na fila (ou recusada) fica como está aqui: a mudança local sobe primeiro.
 *
 * O que vem: loja (sem token Focus nem CSC), equipe, maquininhas, categorias,
 * produtos, adicionais e vínculos, preços por horário, mesas (sem a ocupação),
 * permissões, fornecedores e vínculos de compra, e o cashback (clientes e extrato:
 * o banco decide de quais créditos sai cada resgate e grava os estornos, então o saldo
 * daqui é acertado pelo da nuvem). Contas, pagamentos e barris ficam em cada aparelho
 * (a nuvem recebe, mas ainda não manda de volta).
 */
import type {
  CashbackLedgerEntry,
  Category,
  Courier,
  DeliveryZone,
  DiningTable,
  LoyaltyCustomer,
  ModifierGroup,
  ModifierOption,
  PosTerminal,
  PriceSchedule,
  Product,
  ProductModifierGroup,
  PurchaseInvoice,
  RolePermission,
  StaffUser,
  Supplier,
  SupplierProductLink,
  SyncEvent,
  Tenant,
} from '../../types';
import type { FetchLike, SyncConfig } from './supabaseSync';

/** Loja sem os segredos (o servidor é a fonte do token Focus e do CSC). */
export type CloudTenant = Omit<Tenant, 'focus_nfe_token' | 'csc_id' | 'csc_token'>;
/** Equipe como o token do aparelho lê: sem PIN. */
export type CloudStaff = Omit<StaffUser, 'pin_code'>;

export interface CloudSnapshot {
  tenant: CloudTenant;
  staff: CloudStaff[];
  terminals: PosTerminal[];
  categories: Category[];
  products: Product[];
  modifierGroups: ModifierGroup[];
  modifierOptions: ModifierOption[];
  productModifierGroups: ProductModifierGroup[];
  priceSchedules: PriceSchedule[];
  tables: DiningTable[];
  rolePermissions: RolePermission[];
  suppliers: Supplier[];
  supplierProductLinks: SupplierProductLink[];
  /** Notas de compra já importadas: sem elas um aparelho novo importaria a mesma NF-e de novo e somaria o estoque duas vezes. */
  purchaseInvoices: PurchaseInvoice[];
  /** Entrega própria: bairros com taxa e entregadores. */
  deliveryZones: DeliveryZone[];
  couriers: Courier[];
  /** Cashback: clientes (saldo calculado pelo banco) e extrato. Opcional só para snapshots montados à mão. */
  loyaltyCustomers?: LoyaltyCustomer[];
  cashbackLedger?: CashbackLedgerEntry[];
}

const TENANT_COLUMNS = ['id', 'name', 'legal_name', 'cnpj', 'state_registration', 'city', 'state', 'default_service_fee_pct', 'default_acquirer', 'default_mode', 'created_at', 'half_and_half_pricing'] as const;
const STAFF_COLUMNS = ['id', 'tenant_id', 'name', 'role', 'active', 'created_at'] as const;

/** Colunas lidas de cada tabela (as mesmas dos tipos em src/types.ts) e a ordem estável da paginação. */
const TABLES = {
  terminals: { table: 'pos_terminals', order: 'id', columns: ['id', 'tenant_id', 'name', 'serial_number', 'acquirer', 'mode', 'online', 'battery_level'] },
  categories: { table: 'categories', order: 'id', columns: ['id', 'tenant_id', 'name', 'sort_order', 'icon_name', 'active'] },
  products: {
    table: 'products',
    order: 'id',
    columns: [
      'id', 'tenant_id', 'category_id', 'code', 'name', 'description', 'price', 'sector', 'available', 'requires_meat_doneness', 'allows_half_and_half',
      'ncm', 'cfop', 'csosn_cst', 'unit', 'cost_price', 'stock_quantity', 'barcode', 'active', 'created_at', 'sold_by_weight', 'tare_weight_grams', 'is_combo',
    ],
  },
  modifierGroups: { table: 'modifier_groups', order: 'id', columns: ['id', 'tenant_id', 'name', 'min_selection', 'max_selection', 'required'] },
  modifierOptions: { table: 'modifier_options', order: 'id', columns: ['id', 'group_id', 'name', 'additional_price', 'volume_ml', 'component_product_id', 'component_quantity'] },
  productModifierGroups: { table: 'product_modifier_groups', order: 'product_id,group_id', columns: ['product_id', 'group_id', 'sort_order'] },
  priceSchedules: { table: 'price_schedules', order: 'id', columns: ['id', 'tenant_id', 'product_id', 'name', 'weekdays', 'start_time', 'end_time', 'price', 'active', 'created_at'] },
  tables: { table: 'dining_tables', order: 'id', columns: ['id', 'tenant_id', 'number', 'label', 'area', 'capacity', 'status', 'qr_code_token', 'current_order_id', 'active', 'updated_at', 'kind'] },
  rolePermissions: { table: 'role_permissions', order: 'role,permission', columns: ['tenant_id', 'role', 'permission', 'allowed', 'updated_at'] },
  suppliers: { table: 'suppliers', order: 'id', columns: ['id', 'tenant_id', 'document', 'legal_name', 'trade_name', 'state_registration', 'city', 'state', 'created_at'] },
  supplierProductLinks: {
    table: 'supplier_product_links',
    order: 'id',
    columns: ['id', 'tenant_id', 'supplier_id', 'supplier_code', 'product_id', 'packaging_factor', 'commercial_unit', 'updated_at'],
  },
  purchaseInvoices: {
    table: 'purchase_invoices',
    order: 'id',
    columns: [
      'id', 'tenant_id', 'supplier_id', 'access_key', 'number', 'series', 'issued_at', 'environment', 'authorization_protocol', 'products_amount',
      'discount_amount', 'freight_amount', 'insurance_amount', 'other_amount', 'ipi_amount', 'icms_st_amount', 'invoice_amount', 'stocked_amount',
      'items_count', 'imported_by_user_id', 'imported_at',
    ],
  },
  deliveryZones: { table: 'delivery_zones', order: 'id', columns: ['id', 'tenant_id', 'name', 'fee', 'eta_minutes', 'active'] },
  couriers: { table: 'couriers', order: 'id', columns: ['id', 'tenant_id', 'name', 'phone', 'fee_per_delivery', 'active'] },
} as const;


/** Linhas por página (o Supabase limita a 1000 por padrão). */
export const PULL_PAGE_SIZE = 1000;

function headers(cfg: SyncConfig): Record<string, string> {
  return { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' };
}

function root(cfg: SyncConfig): string {
  return `${cfg.url.replace(/\/+$/, '')}/rest/v1`;
}

async function readError(res: { status: number; text: () => Promise<string> }): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { message?: string };
    return j.message ?? `HTTP ${res.status}`;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

async function getAll<T>(cfg: SyncConfig, fetchFn: FetchLike, table: string, columns: readonly string[], order: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PULL_PAGE_SIZE) {
    const q = `select=${columns.join(',')}&order=${order}&limit=${PULL_PAGE_SIZE}&offset=${offset}`;
    const res = await fetchFn(`${root(cfg)}/${table}?${q}`, { method: 'GET', headers: headers(cfg) });
    if (!res.ok) throw new Error(`Não foi possível ler ${table} da nuvem: ${await readError(res)}`);
    const page = JSON.parse(await res.text()) as T[];
    out.push(...page);
    if (page.length < PULL_PAGE_SIZE) return out;
  }
}

/** Equipe da loja sem PIN (para escolher quem confirma com o PIN). */
export function fetchCloudStaff(cfg: SyncConfig, fetchFn: FetchLike): Promise<CloudStaff[]> {
  return getAll<CloudStaff>(cfg, fetchFn, 'staff_users', STAFF_COLUMNS, 'id');
}

/** Todos os cadastros da loja do token. */
export async function fetchCloudSnapshot(cfg: SyncConfig, tenantId: string, fetchFn: FetchLike): Promise<CloudSnapshot> {
  const tenants = await getAll<CloudTenant>(cfg, fetchFn, 'tenants', TENANT_COLUMNS, 'id');
  const tenant = tenants.find((t) => t.id === tenantId);
  if (!tenant) throw new Error('A loja desta conta não foi encontrada na nuvem.');
  const read = <K extends keyof typeof TABLES>(k: K) => getAll<CloudSnapshot[K][number]>(cfg, fetchFn, TABLES[k].table, TABLES[k].columns, TABLES[k].order);
  const staff = await fetchCloudStaff(cfg, fetchFn);
  const terminals = await read('terminals');
  const categories = await read('categories');
  const products = await read('products');
  const modifierGroups = await read('modifierGroups');
  const modifierOptions = await read('modifierOptions');
  const productModifierGroups = await read('productModifierGroups');
  const priceSchedules = await read('priceSchedules');
  const tables = await read('tables');
  const rolePermissions = await read('rolePermissions');
  const suppliers = await read('suppliers');
  const supplierProductLinks = await read('supplierProductLinks');
  const purchaseInvoices = await read('purchaseInvoices');
  const deliveryZones = await read('deliveryZones');
  const couriers = await read('couriers');
  const cashback = await readCashback(cfg, fetchFn, null);
  return {
    tenant,
    staff,
    terminals: terminals as PosTerminal[],
    categories: categories as Category[],
    products: products as Product[],
    modifierGroups: modifierGroups as ModifierGroup[],
    modifierOptions: modifierOptions as ModifierOption[],
    productModifierGroups: productModifierGroups as ProductModifierGroup[],
    priceSchedules: priceSchedules as PriceSchedule[],
    tables: tables as DiningTable[],
    rolePermissions: rolePermissions as RolePermission[],
    suppliers: suppliers as Supplier[],
    supplierProductLinks: supplierProductLinks as SupplierProductLink[],
    purchaseInvoices: purchaseInvoices as PurchaseInvoice[],
    deliveryZones: (deliveryZones as DeliveryZone[]).map((z) => ({ ...z, fee: Number(z.fee) })),
    couriers: (couriers as Courier[]).map((c) => ({ ...c, fee_per_delivery: Number(c.fee_per_delivery) })),
    ...cashback,
  };
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Cashback como veio do PostgREST (numeric em texto) com os valores em número. */
function cashbackRows(loyaltyCustomers: LoyaltyCustomer[], cashbackLedger: CashbackLedgerEntry[]): CloudCashback {
  return {
    loyaltyCustomers: loyaltyCustomers.map((c) => ({
      ...c, cashback_balance: Number(c.cashback_balance), total_spent: Number(c.total_spent), visits_count: Number(c.visits_count),
    })),
    cashbackLedger: cashbackLedger.map((e) => ({
      ...e,
      amount: Number(e.amount),
      remaining_amount: Number(e.remaining_amount),
      base_amount: numOrNull(e.base_amount),
      pct: numOrNull(e.pct),
      redeem_sources: e.redeem_sources ? e.redeem_sources.map((x) => ({ source_id: x.source_id, amount: Number(x.amount) })) : null,
    })),
  };
}

export type CloudCashback = { loyaltyCustomers: LoyaltyCustomer[]; cashbackLedger: CashbackLedgerEntry[] };

/**
 * Clientes e extrato de cashback numa leitura só do banco (tchefood_cashback_snapshot: um
 * SELECT, uma foto), não em páginas: a leitura paginada podia repetir um lançamento e
 * perder outro quando um crédito entrava no meio (P2-01 da rodada 11 do GPT). Lançamento
 * repetido na resposta é recusado em vez de aceito em silêncio.
 */
async function readCashback(cfg: SyncConfig, fetchFn: FetchLike, customerId: string | null): Promise<CloudCashback> {
  const res = await fetchFn(`${root(cfg)}/rpc/tchefood_cashback_snapshot`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ p_customer_id: customerId }),
  });
  if (!res.ok) throw new Error(`Não foi possível ler o cashback da nuvem: ${await readError(res)}`);
  const body = JSON.parse((await res.text()) || 'null') as { loyalty_customers?: LoyaltyCustomer[]; cashback_ledger?: CashbackLedgerEntry[] } | null;
  if (!body || !Array.isArray(body.loyalty_customers) || !Array.isArray(body.cashback_ledger)) {
    throw new Error('Não foi possível ler o cashback da nuvem: resposta incompleta.');
  }
  for (const rows of [body.loyalty_customers, body.cashback_ledger] as { id: string }[][]) {
    if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('Não foi possível ler o cashback da nuvem: lançamento repetido na leitura.');
  }
  return cashbackRows(body.loyalty_customers, body.cashback_ledger);
}

/**
 * Cadastro e extrato de cashback de um cliente, lidos agora da nuvem. Usado para conferir
 * um resgate da versão anterior do aparelho (sem redeem_sources) antes de desfazê-lo.
 */
export function fetchCloudCustomerCashback(cfg: SyncConfig, fetchFn: FetchLike, customerId: string): Promise<CloudCashback> {
  return readCashback(cfg, fetchFn, customerId);
}

export type CashbackPendingHold = { id: string; customer_id: string; customer_name: string | null; phone: string; order_id: string | null; amount: number; created_at: string };
export type CashbackPendingOrphan = { customer_id: string; customer_name: string | null; phone: string; amount: number; pending_legacy_redeems: number };
export type CashbackPending = { holds: CashbackPendingHold[]; orphans: CashbackPendingOrphan[] };

/** Cashback que o gerente precisa conciliar: devoluções retidas (HOLD) e baixas sem resgate, lidas agora da nuvem. */
export async function fetchCashbackPending(cfg: SyncConfig, fetchFn: FetchLike): Promise<CashbackPending> {
  const res = await fetchFn(`${root(cfg)}/rpc/tchefood_cashback_reconciliation_pending`, { method: 'POST', headers: headers(cfg), body: '{}' });
  if (!res.ok) throw new Error(`Não foi possível ler o cashback a conciliar: ${await readError(res)}`);
  const body = JSON.parse((await res.text()) || 'null') as { holds?: CashbackPendingHold[]; orphans?: CashbackPendingOrphan[] } | null;
  if (!body || !Array.isArray(body.holds) || !Array.isArray(body.orphans)) throw new Error('Não foi possível ler o cashback a conciliar: resposta incompleta.');
  return {
    holds: body.holds.map((h) => ({ ...h, amount: Number(h.amount) })),
    orphans: body.orphans.map((o) => ({ ...o, amount: Number(o.amount), pending_legacy_redeems: Number(o.pending_legacy_redeems) })),
  };
}

export type CashbackReconcileInput = {
  /** Id da decisão, gerado uma vez por decisão: o reenvio com o mesmo id não repete nada. */
  requestId: string;
  kind: 'HOLD' | 'ORPHAN';
  customerId: string;
  holdId: string | null;
  decision: 'RELEASE' | 'DISCARD';
  /** O valor que a tela mostrou; se a pendência mudou, o servidor recusa. */
  amount: number;
  managerPin: string;
  performedBy: string;
  reason: string;
};
export type CashbackReconcileResult = { ok: true; amount: number; repeated: boolean } | { ok: false; error: string };

/** Decisão do gerente sobre uma pendência de cashback. A regra (PIN, valor, crédito, auditoria) roda no servidor. */
export async function reconcileCashback(cfg: SyncConfig, fetchFn: FetchLike, input: CashbackReconcileInput): Promise<CashbackReconcileResult> {
  const res = await fetchFn(`${root(cfg)}/rpc/tchefood_reconcile_cashback`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({
      p_request_id: input.requestId, p_kind: input.kind, p_customer_id: input.customerId, p_hold_id: input.holdId,
      p_decision: input.decision, p_amount: input.amount, p_manager_pin: input.managerPin, p_performed_by: input.performedBy, p_reason: input.reason,
    }),
  });
  if (!res.ok) return { ok: false, error: `A nuvem recusou: ${await readError(res)}` };
  const body = JSON.parse((await res.text()) || 'null') as { status?: string; amount?: number | string; repeated?: boolean } | null;
  if (body?.status === 'PIN_FAILED') return { ok: false, error: 'PIN de gerente incorreto.' };
  if (body?.status === 'PIN_LOCKED') return { ok: false, error: 'PIN bloqueado por excesso de tentativas. Aguarde um minuto.' };
  if (body?.status !== 'OK') return { ok: false, error: 'A nuvem não confirmou a conciliação.' };
  return { ok: true, amount: Number(body.amount), repeated: !!body.repeated };
}

export type StaffPinsResult = { ok: true; staff: StaffUser[] } | { ok: false; error: string };

/** Equipe com os PINs: o servidor confere o PIN do gerente/proprietário (com o bloqueio de 3 erros). */
export async function fetchStaffPins(cfg: SyncConfig, staffId: string, pin: string, fetchFn: FetchLike): Promise<StaffPinsResult> {
  const res = await fetchFn(`${root(cfg)}/rpc/tchefood_pull_staff`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ p_staff_id: staffId, p_pin: pin }),
  });
  if (!res.ok) return { ok: false, error: `A nuvem recusou: ${await readError(res)}` };
  const body = JSON.parse((await res.text()) || 'null') as StaffUser[] | null;
  if (!body) return { ok: false, error: 'PIN não confere (ou bloqueado por excesso de tentativas). Só gerente ou proprietário baixa a equipe.' };
  return { ok: true, staff: body };
}

// ---------------------------------------------------------------------------
// Aplicar o que veio da nuvem sem passar por cima do que ainda não subiu
// ---------------------------------------------------------------------------

type RowKey = string;

/** Chave do registro de um evento da fila (a mesma de row_id). */
export function eventRowKey(e: Pick<SyncEvent, 'table' | 'row_id'>): RowKey {
  return `${e.table}:${e.row_id}`;
}

/** Registros com mudança deste aparelho ainda não aceita pela nuvem (na fila ou recusada). */
export function pendingRowKeys(events: ReadonlyArray<Pick<SyncEvent, 'table' | 'row_id'>>): Set<RowKey> {
  return new Set(events.map(eventRowKey));
}

interface MergeSpec<T> {
  table: SyncEvent['table'];
  key: (row: T) => string;
  /** Linha que sumiu da nuvem e não está pendente aqui: sai do aparelho (só vínculos e opções, que a nuvem apaga). */
  dropMissing: boolean;
  /** Ajusta a linha da nuvem antes de entrar (ex.: a mesa mantém a ocupação deste aparelho). */
  adapt?: (cloud: T, local: T | undefined) => T;
}

export function mergeRows<T>(local: readonly T[], cloud: readonly T[], pending: Set<RowKey>, spec: MergeSpec<T>): T[] {
  const isPending = (row: T) => pending.has(`${spec.table}:${spec.key(row)}`);
  const cloudByKey = new Map(cloud.map((r) => [spec.key(r), r]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const l of local) {
    const k = spec.key(l);
    seen.add(k);
    const c = cloudByKey.get(k);
    if (isPending(l)) out.push(l);
    else if (c) out.push(spec.adapt ? spec.adapt(c, l) : c);
    else if (!spec.dropMissing) out.push(l);
  }
  for (const c of cloud) {
    const k = spec.key(c);
    // Apagado aqui e o DELETE ainda na fila: continua apagado.
    if (seen.has(k) || isPending(c)) continue;
    out.push(spec.adapt ? spec.adapt(c, undefined) : c);
  }
  return out;
}

/** A mesa vem da nuvem só com o cadastro: a ocupação é de cada aparelho (contas ainda não descem). */
export function adaptTable(cloud: DiningTable, local: DiningTable | undefined): DiningTable {
  // Mesa com conta aberta aqui continua ativa mesmo que outro aparelho a tenha desativado
  // (lá estava livre): senão ela some do mapa e a conta fica sem entrada para cobrar.
  return local
    ? { ...cloud, status: local.status, current_order_id: local.current_order_id, updated_at: local.updated_at, active: local.status === 'FREE' ? cloud.active : local.active }
    : { ...cloud, status: 'FREE', current_order_id: null };
}

export const MERGE = {
  terminals: { table: 'pos_terminals', key: (r: PosTerminal) => r.id, dropMissing: false },
  categories: { table: 'categories', key: (r: Category) => r.id, dropMissing: false },
  products: { table: 'products', key: (r: Product) => r.id, dropMissing: false },
  modifierGroups: { table: 'modifier_groups', key: (r: ModifierGroup) => r.id, dropMissing: false },
  modifierOptions: { table: 'modifier_options', key: (r: ModifierOption) => r.id, dropMissing: true },
  productModifierGroups: { table: 'product_modifier_groups', key: (r: ProductModifierGroup) => `${r.product_id}:${r.group_id}`, dropMissing: true },
  priceSchedules: { table: 'price_schedules', key: (r: PriceSchedule) => r.id, dropMissing: false },
  tables: { table: 'dining_tables', key: (r: DiningTable) => r.id, dropMissing: false, adapt: adaptTable },
  rolePermissions: { table: 'role_permissions', key: (r: RolePermission) => `${r.tenant_id}:${r.role}:${r.permission}`, dropMissing: false },
  suppliers: { table: 'suppliers', key: (r: Supplier) => r.id, dropMissing: false },
  supplierProductLinks: { table: 'supplier_product_links', key: (r: SupplierProductLink) => r.id, dropMissing: false },
  purchaseInvoices: { table: 'purchase_invoices', key: (r: PurchaseInvoice) => r.id, dropMissing: false },
  deliveryZones: { table: 'delivery_zones', key: (r: DeliveryZone) => r.id, dropMissing: false },
  couriers: { table: 'couriers', key: (r: Courier) => r.id, dropMissing: false },
} satisfies { [K in keyof typeof TABLES]: MergeSpec<CloudSnapshot[K][number]> };

/**
 * Cashback vindo da nuvem: o banco é quem decide de quais créditos sai cada resgate e
 * grava os estornos (inclusive os que o aparelho não espelha), então clientes e extrato
 * da nuvem substituem os daqui. Fica como está o cliente com mudança daqui ainda não
 * aceita (resgate, crédito, cadastro ou conta com cashback na fila ou recusada). O
 * estorno local é só espelho (nunca sobe): sai quando o cliente é acertado pela nuvem.
 */
export function mergeCashback(
  local: { loyaltyCustomers: readonly LoyaltyCustomer[]; cashbackLedger: readonly CashbackLedgerEntry[] },
  cloud: { loyaltyCustomers: readonly LoyaltyCustomer[]; cashbackLedger: readonly CashbackLedgerEntry[] },
  pendingEvents: ReadonlyArray<Pick<SyncEvent, 'table' | 'row_id' | 'payload'>>,
): { loyaltyCustomers: LoyaltyCustomer[]; cashbackLedger: CashbackLedgerEntry[] } {
  const pendingOrders = new Set(pendingEvents.filter((e) => e.table === 'orders').map((e) => e.row_id));
  const kept = new Set<string>();
  for (const e of pendingEvents) {
    if (e.table === 'loyalty_customers') kept.add(e.row_id);
    if (e.table === 'cashback_ledger' && typeof e.payload.customer_id === 'string') kept.add(e.payload.customer_id);
  }
  for (const l of local.cashbackLedger) if (l.order_id && pendingOrders.has(l.order_id)) kept.add(l.customer_id);
  const customers = mergeRows(local.loyaltyCustomers, cloud.loyaltyCustomers, new Set([...kept].map((id) => `loyalty_customers:${id}`)), {
    table: 'loyalty_customers', key: (r: LoyaltyCustomer) => r.id, dropMissing: false,
  });
  const ledger = [
    // P2-01 da rodada 7 do GPT: sem nada do cliente na fila ou recusado, o extrato da nuvem
    // substitui todo o daqui (crédito ou resgate que só existe aqui não fica como saldo).
    ...local.cashbackLedger.filter((l) => kept.has(l.customer_id)),
    ...cloud.cashbackLedger.filter((c) => !kept.has(c.customer_id)),
  ];
  return { loyaltyCustomers: customers, cashbackLedger: ledger };
}

/**
 * Equipe vinda da nuvem sem PIN: nome, perfil e ativo de quem este aparelho já
 * conhece (o PIN daqui fica). Quem é novo na nuvem só entra com o PIN, pelo botão
 * "Atualizar equipe" (gerente).
 */
export function mergeStaffWithoutPins(local: readonly StaffUser[], cloud: readonly CloudStaff[], pending: Set<RowKey>): { staff: StaffUser[]; unknown: number } {
  const byId = new Map(cloud.map((c) => [c.id, c]));
  const staff = local.map((l) => {
    const c = byId.get(l.id);
    if (!c || pending.has(`staff_users:${l.id}`)) return l;
    return { ...l, name: c.name, role: c.role, active: c.active };
  });
  const known = new Set(local.map((l) => l.id));
  const unknown = cloud.filter((c) => !known.has(c.id) && c.active).length;
  return { staff, unknown };
}

/** Equipe com PIN (do servidor) aplicada sobre a do aparelho, sem passar por cima do que está pendente. */
export function mergeStaffWithPins(local: readonly StaffUser[], cloud: readonly StaffUser[], pending: Set<RowKey>): StaffUser[] {
  return mergeRows(local, cloud, pending, { table: 'staff_users', key: (r) => r.id, dropMissing: false });
}
