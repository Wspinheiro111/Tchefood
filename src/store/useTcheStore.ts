/**
 * Estado global do Tchê Food (Zustand + persistência IndexedDB).
 *
 * Regras de ouro:
 *  1. Toda mutação financeira acontece em UM único set(): os itens, a comanda
 *     recalculada, a mesa, o audit_log e o evento da fila offline mudam juntos
 *     (atômico, como uma transação PostgreSQL).
 *  2. O recálculo usa computeOrderTotals(), cópia fiel da função
 *     tchefood_recalc_order() do schema.sql.
 *  3. Nenhum OrderItem é removido do array depois de despachado. Cancelamento
 *     = status 'CANCELED' + canceled_at/by/reason + audit_log.
 *  4. A validação do PIN de gerente acontece AQUI, nunca só na interface.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  ActionResult,
  AuditActionType,
  AuditLog,
  CashbackLedgerEntry,
  Category,
  DiningTable,
  EventTicket,
  KegHistory,
  KegTap,
  KegTapProduct,
  LoyaltyCustomer,
  SelectedModifier,
  WeightSource,
  HalfAndHalfPricing,
  FulfillmentType,
  ModifierGroup,
  ModifierOption,
  Order,
  OrderItem,
  Payment,
  Permission,
  PosTerminal,
  PriceSchedule,
  Product,
  ProductModifierGroup,
  RolePermission,
  StaffUser,
  SyncEvent,
  Tenant,
  TrayItem,
  UUID,
} from '../types';
import { applyOrderTotals, computeItemTotal, formatBRL, halfAndHalfPrice, round2, round3, toCents } from '../lib/money';
import {
  effectivePrice,
  validateCategory,
  validateModifierGroup,
  validateModifierOption,
  validatePriceSchedule,
  validateProduct,
  validateStaff,
  validateTable,
  type PriceScheduleDraft,
  type ProductDraft,
  type StaffDraft,
  type TableDraft,
} from '../lib/catalog';
import { can, PERMISSION_LABEL } from '../lib/permissions';
import { nowISO, uuid } from '../lib/ids';
import { idbStorage } from '../lib/idbStorage';
import { createSeedData, isQrSelfService, KIOSK_TABLE_ID, QR_SELF_SERVICE_PIN, SEED_STAFF, SEED_TENANT } from '../data/seed';
import { nextPickupNumber, sanitizePickupName } from '../lib/kiosk';
import { getReviewHold } from '../lib/payments/reviewHolds';
import { buildAccessKey } from '../lib/nfce';
import type { PrinterConfig } from '../services/printer/escposBuilder';
import { applyKegCancel, applyKegSale, resolveKegVolume, withRemaining } from '../lib/kegs';
import { generateTicketToken, isValidTicketToken, normalizeTicketToken } from '../lib/eventTickets';
import { computeNetWeight } from '../lib/scale';
import {
  availableCashback,
  balanceCashback,
  CASHBACK_DAYS_LABEL,
  CASHBACK_PCT,
  cashbackBase,
  cashbackEarnAmount,
  cashbackUsable,
  cashbackValidity,
  consumeCashbackFifo,
  isCashbackDay,
  normalizeWhatsapp,
} from '../lib/loyalty';

export const MANAGER_PIN_MAX_ATTEMPTS = 3;
export const MANAGER_PIN_LOCK_MS = 60_000;
export const MIN_REASON_LENGTH = 5;
/** Cobrança na maquininha sem resposta após este tempo é considerada abandonada. */
export const PENDING_CHARGE_TTL_MS = 5 * 60_000;

/** Cobrança enviada à maquininha e ainda sem resposta: trava a conta até voltar. */
export interface PendingCharge {
  request_id: string;
  order_id: UUID;
  amount: number;
  user_id: UUID;
  started_at: number;
}

/** Início da mensagem do Cardápio QR quando o preço do carrinho ficou diferente do atual. */
export const QR_PRICE_CHANGED = 'Preço atualizado:';

const MANAGER_ROLES: ReadonlyArray<StaffUser['role']> = ['MANAGER', 'OWNER'];

export interface ManagerAuthInput {
  managerPin: string;
  reason: string;
}

export interface PaymentInput {
  orderId: UUID;
  amount: number;
  tip_amount?: number;
  method: Payment['method'];
  status: 'APPROVED' | 'DECLINED';
  terminal_id: UUID | null;
  acquirer: Payment['acquirer'];
  acquirer_cnpj: string | null;
  card_brand: string | null;
  nsu: string | null;
  authorization_code: string | null;
  terminal_serial: string | null;
  idempotency_key: string;
  /** Modo "por item consumido": itens que serão marcados is_paid = true. */
  item_ids: UUID[];
  /** request_id da cobrança em andamento na maquininha que originou este pagamento. */
  charge_request_id?: string | null;
}

export interface PaymentOutcome {
  payment: Payment;
  order: Order;
  closed: boolean;
}

/** Linha da venda de balcão (Ficha Rápida): unidades inteiras, uma ficha por unidade. */
export interface CounterLine {
  product_id: UUID;
  quantity: number;
  modifiers: SelectedModifier[];
  meat_doneness: string | null;
}

/** Linha do pedido com senha (totem ou caixa). Mesmo formato do lançamento da comanda. */
export interface PickupLine {
  product_id: UUID;
  quantity: number;
  modifiers: SelectedModifier[];
  meat_doneness: string | null;
  half_product_ids: UUID[];
  quick_tags: string[];
  free_notes: string;
}

export interface PickupOrderInput {
  lines: PickupLine[];
  fulfillment: FulfillmentType;
  customerName: string | null;
}

export interface LoyaltyInput {
  phone: string;
  name: string | null;
  cpf: string | null;
  optIn: boolean;
}

export interface CashbackEarnOutcome {
  customer: LoyaltyCustomer;
  entry: CashbackLedgerEntry;
  balance: number;
}

/** Venda de balcão sem resposta definitiva da maquininha (aguarda conferência). */
export const COUNTER_EVENT_LABEL = 'Ficha de Balcão';

export interface DispatchSummary {
  count: number;
  sectors: OrderItem['sector'][];
  items: OrderItem[];
}

interface DataSlice {
  tenant: Tenant;
  staff: StaffUser[];
  terminals: PosTerminal[];
  categories: Category[];
  products: Product[];
  modifierGroups: ModifierGroup[];
  modifierOptions: ModifierOption[];
  productModifierGroups: ProductModifierGroup[];
  tables: DiningTable[];
  orders: Order[];
  orderItems: OrderItem[];
  payments: Payment[];
  auditLogs: AuditLog[];
  printers: PrinterConfig[];
  // Fase 5
  kegTaps: KegTap[];
  kegTapProducts: KegTapProduct[];
  kegHistory: KegHistory[];
  eventTickets: EventTicket[];
  loyaltyCustomers: LoyaltyCustomer[];
  cashbackLedger: CashbackLedgerEntry[];
  /** Etapa 0 — preço por dia/horário. */
  priceSchedules: PriceSchedule[];
  /** Etapa 0 — exceções ao padrão de permissões por perfil. */
  rolePermissions: RolePermission[];
}

/** Sessão do aparelho na nuvem (Supabase Auth). Tokens ficam só neste aparelho. */
export interface CloudSession {
  url: string;
  anon_key: string;
  email: string;
  access_token: string;
  refresh_token: string;
  /** Epoch em segundos (campo expires_at do Supabase Auth). */
  expires_at: number;
  tenant_id: UUID;
}

export interface SyncStatus {
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  /** Evento que o servidor recusou (fica parado na fila até ser resolvido). */
  blocked_event_id: UUID | null;
}

export interface CategoryDraft {
  id?: UUID;
  name: string;
  sort_order: number;
  icon_name: string | null;
  active: boolean;
}

export interface ModifierGroupDraft {
  id?: UUID;
  name: string;
  min_selection: number;
  max_selection: number;
  required: boolean;
}

export interface ModifierOptionDraft {
  id?: UUID;
  group_id: UUID;
  name: string;
  additional_price: number;
}

export interface TenantDraft {
  name: string;
  legal_name: string;
  cnpj: string;
  state_registration: string | null;
  city: string;
  state: string;
  default_service_fee_pct: number;
}

export interface NewStoreInput {
  tenant: TenantDraft;
  owner_name: string;
  owner_pin: string;
  /**
   * Conta da nuvem já validada (login feito) a que a loja nova fica ligada.
   * Assim o aparelho de demonstração vira a loja real da conta: o id da loja
   * passa a ser o tenant_id da conta.
   */
  cloud?: CloudSession;
}

interface DeviceSlice {
  currentUserId: UUID | null;
  tray: TrayItem[];
  outbox: SyncEvent[];
  managerPinFailures: number;
  managerPinLockedUntil: number | null;
  soundEnabled: boolean;
  halfAndHalfPricing: HalfAndHalfPricing;
  hydrated: boolean;
  /** Sequencial de numeração da NFC-e (série 1) deste aparelho emissor. */
  nfceSeq: number;
  /** Abre o simulador 80mm vs 58mm a cada despacho para produção. */
  showPrintSimulator: boolean;
  cloud: CloudSession | null;
  syncStatus: SyncStatus;
  /** Cobranças em andamento na maquininha (persistidas para sobreviver a recarga). */
  pendingCharges: PendingCharge[];
}

interface Actions {
  login: (pin: string) => ActionResult<StaffUser>;
  logout: () => ActionResult;

  openTable: (tableId: UUID, customerCount: number, customerCpf: string | null) => ActionResult<Order>;
  releaseTable: (tableId: UUID) => ActionResult;
  updateCustomerCount: (orderId: UUID, count: number) => ActionResult;
  requestBill: (orderId: UUID) => ActionResult;
  resumeService: (orderId: UUID) => ActionResult;

  addToTray: (item: Omit<TrayItem, 'tray_id' | 'added_at'>) => ActionResult<TrayItem>;
  updateTrayQty: (trayId: UUID, quantity: number) => void;
  removeFromTray: (trayId: UUID) => void;
  clearTray: (orderId: UUID) => void;
  dispatchTray: (orderId: UUID) => ActionResult<DispatchSummary>;
  markItemDelivered: (itemId: UUID) => ActionResult;

  cancelOrderItem: (itemId: UUID, auth: ManagerAuthInput) => ActionResult<AuditLog>;
  removeServiceFee: (orderId: UUID, auth: ManagerAuthInput) => ActionResult<AuditLog>;
  restoreServiceFee: (orderId: UUID) => ActionResult<AuditLog>;
  applyDiscount: (orderId: UUID, amount: number, auth: ManagerAuthInput) => ActionResult<AuditLog>;

  // Fase 2 — fechamento / rachadinha
  startCheckout: (orderId: UUID) => ActionResult;
  registerPayment: (input: PaymentInput) => ActionResult<PaymentOutcome>;
  /** Reserva a conta enquanto a maquininha processa: bloqueia descontos, cancelamentos e outros pagamentos. */
  beginTerminalCharge: (orderId: UUID, requestId: string, amount: number) => ActionResult;
  /** Encerra conta zerada sem nenhum pagamento (tudo cancelado ou 100% de desconto) e libera a mesa. */
  closeZeroOrder: (orderId: UUID) => ActionResult<Order>;
  endTerminalCharge: (requestId: string) => void;

  // Fase 3 — KDS e QR Code
  advanceItemStatus: (itemId: UUID) => ActionResult<OrderItem>;
  advanceItems: (itemIds: UUID[]) => ActionResult<OrderItem[]>;
  qrPlaceOrder: (tableId: UUID, drafts: Array<Omit<TrayItem, 'tray_id' | 'added_at' | 'order_id'>>) => ActionResult<DispatchSummary>;
  qrRequestBill: (tableId: UUID) => ActionResult;

  // Módulo de impressoras ESC/POS
  upsertPrinter: (printer: PrinterConfig) => ActionResult<PrinterConfig>;
  removePrinter: (printerId: string) => void;
  setShowPrintSimulator: (v: boolean) => void;

  // Fase 5 — Buffet a quilo (balança)
  addWeighedToTray: (orderId: UUID, productId: UUID, grossGrams: number, tareGrams: number, source: WeightSource) => ActionResult<TrayItem>;

  // Fase 5 — Ficha Rápida / Balcão & Eventos
  createCounterSale: (lines: CounterLine[]) => ActionResult<Order>;
  /** Desiste de uma venda de balcão ainda não paga (PIN de gerente: os itens viram CANCELED auditados). */
  voidCounterSale: (orderId: UUID, auth: ManagerAuthInput) => ActionResult;
  /** Emite (ou devolve as já emitidas) as fichas de uma venda de balcão paga. Idempotente. */
  issueEventTickets: (orderId: UUID) => ActionResult<EventTicket[]>;
  redeemEventTicket: (rawToken: string) => ActionResult<EventTicket>;

  // Totem de autoatendimento / pedido no caixa (pedido com senha que vai ao KDS depois de pago)
  createPickupOrder: (input: PickupOrderInput) => ActionResult<Order>;
  /** Desiste de um pedido com senha ainda não pago (PIN de gerente, itens auditados). */
  voidPickupOrder: (orderId: UUID, auth: ManagerAuthInput) => ActionResult;
  /** Fecha o modo totem neste aparelho (PIN de gerente; fica no audit_log). */
  exitKioskMode: (auth: ManagerAuthInput) => ActionResult;

  // Fase 5 — Barris de chopp
  registerKegWaste: (tapId: UUID, ml: number, reason: string) => ActionResult<KegTap>;
  recordKegReading: (tapId: UUID, remainingMl: number) => ActionResult<KegTap>;
  tapNewKeg: (tapId: UUID, keg: { beer_name: string; total_capacity_ml: number; keg_cost: number }, auth: ManagerAuthInput) => ActionResult<KegTap>;

  // Fase 5 — CRM de cashback
  earnCashback: (orderId: UUID, input: LoyaltyInput) => ActionResult<CashbackEarnOutcome>;
  redeemCashback: (orderId: UUID, phone: string) => ActionResult<{ amount: number; customer: LoyaltyCustomer }>;

  setSoundEnabled: (enabled: boolean) => void;
  setHalfAndHalfPricing: (rule: HalfAndHalfPricing) => void;
  resetDemo: () => void;

  // Etapa 0 — cadastros
  saveCategory: (draft: CategoryDraft) => ActionResult<Category>;
  saveProduct: (draft: Omit<ProductDraft, 'id'> & { id?: UUID }) => ActionResult<Product>;
  setProductAvailable: (productId: UUID, available: boolean) => ActionResult<Product>;
  saveModifierGroup: (draft: ModifierGroupDraft) => ActionResult<ModifierGroup>;
  saveModifierOption: (draft: ModifierOptionDraft) => ActionResult<ModifierOption>;
  removeModifierOption: (optionId: UUID) => ActionResult;
  setProductModifierGroups: (productId: UUID, groupIds: UUID[]) => ActionResult;
  savePriceSchedule: (draft: Omit<PriceScheduleDraft, 'id'> & { id?: UUID }) => ActionResult<PriceSchedule>;
  saveTable: (draft: Omit<TableDraft, 'id'> & { id?: UUID }) => ActionResult<DiningTable>;
  saveStaff: (draft: Omit<StaffDraft, 'id'> & { id?: UUID }, auth?: ManagerAuthInput) => ActionResult<StaffUser>;
  setRolePermission: (role: StaffUser['role'], permission: Permission, allowed: boolean, auth: ManagerAuthInput) => ActionResult<RolePermission>;
  updateTenant: (draft: TenantDraft) => ActionResult<Tenant>;
  startNewStore: (input: NewStoreInput, auth: ManagerAuthInput) => ActionResult<Tenant>;

  // Etapa 0 — nuvem
  setCloudSession: (session: CloudSession | null) => ActionResult;
  ackSyncedEvents: (eventIds: UUID[]) => void;
  setSyncError: (message: string | null, blockedEventId: UUID | null) => void;
}

export type TcheState = DataSlice & DeviceSlice & Actions;

export function migrateToKiosk(p: Partial<TcheState>): Partial<TcheState> {
  const orders = (p.orders ?? []).map((o) => ({ ...o, pickup_number: o.pickup_number ?? null, pickup_name: o.pickup_name ?? null, fulfillment_type: o.fulfillment_type ?? null }));
  const tables = p.tables ?? [];
  const staff = p.staff ?? [];
  const tenantId = p.tenant?.id ?? SEED_TENANT.id;
  // O usuário de demonstração do totem (PIN 4444) só entra na loja de demonstração;
  // numa loja real o totem é cadastrado na Equipe.
  const isDemo = tenantId === SEED_TENANT.id;
  const kioskUsers = isDemo ? SEED_STAFF.filter((u) => u.role === 'KIOSK' && !staff.some((x) => x.id === u.id)) : [];
  return {
    ...p,
    orders,
    tables: tables.some((t) => t.kind === 'KIOSK') ? tables : [...tables, kioskTable(tenantId, isDemo ? KIOSK_TABLE_ID : uuid())],
    staff: [...staff, ...kioskUsers],
  };
}

/** Mesa técnica dos pedidos com senha (totem e pedido no caixa) de uma loja. */
export function kioskTable(tenantId: UUID, id: UUID = uuid()): DiningTable {
  return {
    id,
    tenant_id: tenantId,
    number: 950,
    label: 'Totem / Pedido no caixa',
    area: 'Totem',
    capacity: 1,
    status: 'FREE',
    qr_code_token: null,
    current_order_id: null,
    active: true,
    updated_at: nowISO(),
    kind: 'KIOSK',
  };
}

function initialData(): DataSlice {
  return createSeedData();
}

function initialDevice(): DeviceSlice {
  return {
    currentUserId: null,
    tray: [],
    outbox: [],
    managerPinFailures: 0,
    managerPinLockedUntil: null,
    soundEnabled: true,
    halfAndHalfPricing: 'HIGHEST',
    hydrated: false,
    nfceSeq: 1000,
    showPrintSimulator: true,
    cloud: null,
    pendingCharges: [],
    syncStatus: { last_success_at: null, last_error: null, last_error_at: null, blocked_event_id: null },
  };
}

/** Linha de vínculo produto ↔ grupo não tem id próprio; a fila usa a chave composta. */
function linkEvent(op: 'INSERT' | 'DELETE', link: ProductModifierGroup): SyncEvent {
  return {
    id: uuid(),
    table: 'product_modifier_groups',
    op,
    row_id: `${link.product_id}:${link.group_id}`,
    payload: { ...link } as unknown as Record<string, unknown>,
    created_at: nowISO(),
  };
}

function permissionEvent(row: RolePermission): SyncEvent {
  return {
    id: uuid(),
    table: 'role_permissions',
    op: 'UPDATE',
    row_id: `${row.tenant_id}:${row.role}:${row.permission}`,
    payload: { ...row } as unknown as Record<string, unknown>,
    created_at: nowISO(),
  };
}

function syncEvent(table: SyncEvent['table'], op: SyncEvent['op'], row: { id: UUID }): SyncEvent {
  return {
    id: uuid(),
    table,
    op,
    row_id: row.id,
    payload: { ...row } as Record<string, unknown>,
    created_at: nowISO(),
  };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const fromCentsLocal = (c: number) => c / 100;

const EDITABLE_ORDER_STATUSES: ReadonlyArray<Order['status']> = ['OPEN', 'PAYING'];

/** "Peso 645 g − tara 280 g = 0,365 kg" (vai para a nota do item e para a cozinha). */
export function weightNote(w: { gross_grams: number; tare_grams: number; source: WeightSource }): string {
  const kg = ((w.gross_grams - w.tare_grams) / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 3 });
  return `Peso ${w.gross_grams} g − tara ${w.tare_grams} g = ${kg} kg${w.source === 'MANUAL' ? ' (peso digitado)' : ''}`;
}

function changedTaps(before: readonly KegTap[], after: readonly KegTap[]): KegTap[] {
  return after.filter((t, i) => t !== before[i]);
}

/** Perfis que vendem no balcão e conferem fichas. */
const COUNTER_ROLES: ReadonlyArray<StaffUser['role']> = ['WAITER', 'CASHIER', 'MANAGER', 'OWNER'];
/** Quem lança pedido com senha: o aparelho do totem e a equipe do caixa/balcão. */
const PICKUP_ROLES: ReadonlyArray<StaffUser['role']> = ['KIOSK', ...COUNTER_ROLES];
/** Perfis que operam o bar (sangria, leitura do barril). */
const BAR_ROLES: ReadonlyArray<StaffUser['role']> = ['KITCHEN', 'CASHIER', 'MANAGER', 'OWNER'];

function validateTenantDraft(d: TenantDraft): { ok: true } | { ok: false; error: string } {
  if (d.name.trim().length < 2) return { ok: false, error: 'Informe o nome fantasia da loja.' };
  if (d.legal_name.trim().length < 2) return { ok: false, error: 'Informe a razão social.' };
  if (!/^\d{14}$/.test(d.cnpj.replace(/\D/g, ''))) return { ok: false, error: 'CNPJ deve ter 14 dígitos.' };
  if (!isValidCnpj(d.cnpj.replace(/\D/g, ''))) return { ok: false, error: 'CNPJ inválido (dígito verificador).' };
  if (d.city.trim().length < 2) return { ok: false, error: 'Informe a cidade.' };
  if (!/^[A-Z]{2}$/.test(d.state.trim().toUpperCase())) return { ok: false, error: 'UF deve ter 2 letras.' };
  const fee = d.default_service_fee_pct;
  if (!Number.isFinite(fee) || fee < 0 || fee > 20) return { ok: false, error: 'Taxa de serviço entre 0% e 20%.' };
  if (Math.abs(fee * 100 - Math.round(fee * 100)) > 1e-6) return { ok: false, error: 'Taxa de serviço com no máximo 2 casas decimais.' };
  return { ok: true };
}

function cleanTenantDraft(d: TenantDraft): TenantDraft {
  return {
    name: d.name.trim(),
    legal_name: d.legal_name.trim(),
    cnpj: d.cnpj.replace(/\D/g, ''),
    state_registration: d.state_registration?.replace(/\D/g, '') || null,
    city: d.city.trim(),
    state: d.state.trim().toUpperCase(),
    default_service_fee_pct: round2(d.default_service_fee_pct),
  };
}

/** Dígitos verificadores do CNPJ (módulo 11). */
export function isValidCnpj(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + w * Number(cnpj[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

export const useTcheStore = create<TcheState>()(
  persist(
    (set, get) => {
      // -----------------------------------------------------------------------
      // Helpers internos
      // -----------------------------------------------------------------------
      const currentUser = (): StaffUser | null => {
        const id = get().currentUserId;
        return get().staff.find((s) => s.id === id && s.active) ?? null;
      };

      /**
       * Valida o PIN de gerente com bloqueio progressivo.
       * Falhas e bloqueios também viram audit_logs (tentativa de fraude).
       */
      const authorizeManager = (
        auth: ManagerAuthInput,
        context: { orderId: UUID | null; action: AuditActionType },
      ): ActionResult<StaffUser> => {
        const user = currentUser();
        if (!user) return fail('Sessão expirada. Faça login novamente.');

        const reason = auth.reason.trim();
        if (reason.length < MIN_REASON_LENGTH) {
          return fail(`Informe o motivo (mínimo ${MIN_REASON_LENGTH} caracteres).`);
        }

        const state = get();
        const now = Date.now();
        if (state.managerPinLockedUntil && state.managerPinLockedUntil > now) {
          const secs = Math.ceil((state.managerPinLockedUntil - now) / 1000);
          return fail(`PIN de gerente bloqueado. Aguarde ${secs}s.`);
        }

        const manager = state.staff.find(
          (s) => s.active && MANAGER_ROLES.includes(s.role) && s.pin_code === auth.managerPin,
        );
        if (manager) {
          if (state.managerPinFailures > 0 || state.managerPinLockedUntil) {
            set({ managerPinFailures: 0, managerPinLockedUntil: null });
          }
          return { ok: true, data: manager };
        }

        const failures = state.managerPinFailures + 1;
        const locked = failures >= MANAGER_PIN_MAX_ATTEMPTS;
        const log: AuditLog = {
          id: uuid(),
          tenant_id: state.tenant.id,
          order_id: context.orderId,
          performed_by_user_id: user.id,
          authorized_by_manager_id: null,
          action_type: locked ? 'MANAGER_PIN_LOCKOUT' : 'MANAGER_PIN_FAILED',
          amount_impact: 0,
          reason: `PIN de gerente incorreto ao tentar ${context.action}. Motivo informado: ${reason}`,
          whatsapp_alert_sent: locked,
          metadata: { attempted_action: context.action, attempt: failures },
          created_at: nowISO(),
        };
        set((s) => ({
          managerPinFailures: locked ? 0 : failures,
          managerPinLockedUntil: locked ? now + MANAGER_PIN_LOCK_MS : null,
          auditLogs: [log, ...s.auditLogs],
          outbox: [...s.outbox, syncEvent('audit_logs', 'INSERT', log)],
        }));
        return fail(
          locked
            ? `PIN incorreto ${MANAGER_PIN_MAX_ATTEMPTS}x. Bloqueado por ${MANAGER_PIN_LOCK_MS / 1000}s e proprietário alertado.`
            : `PIN de gerente inválido (${failures}/${MANAGER_PIN_MAX_ATTEMPTS}).`,
        );
      };

      const findEditableOrder = (orderId: UUID): ActionResult<Order> => {
        const order = get().orders.find((o) => o.id === orderId);
        if (!order) return fail('Comanda não encontrada.');
        if (!EDITABLE_ORDER_STATUSES.includes(order.status)) return fail('Comanda já encerrada.');
        return { ok: true, data: order };
      };

      /** Usuário logado com a permissão pedida (padrão + exceções da loja). */
      const requirePermission = (permission: Permission): ActionResult<StaffUser> => {
        const user = currentUser();
        if (!user) return fail('Sessão expirada. Faça login novamente.');
        if (!can(user.role, permission, get().rolePermissions)) {
          return fail(`Seu perfil não tem acesso a: ${PERMISSION_LABEL[permission]}.`);
        }
        return { ok: true, data: user };
      };

      /** audit_log de cadastro: não é alerta de fraude, então não dispara WhatsApp. */
      const catalogAudit = (
        params: Pick<AuditLog, 'performed_by_user_id' | 'authorized_by_manager_id' | 'action_type' | 'reason' | 'metadata'>,
      ): AuditLog => ({
        id: uuid(),
        tenant_id: get().tenant.id,
        order_id: null,
        amount_impact: 0,
        whatsapp_alert_sent: false,
        created_at: nowISO(),
        ...params,
      });

      /** Preço de venda agora (cadastro + regra de horário). */
      const salePrice = (product: Product): number => effectivePrice(product, get().priceSchedules, new Date());

      /** Preço base do item: cadastro + regra de horário, e a regra do meio a meio quando houver sabores. */
      const basePriceFor = (product: Product, halfIds: UUID[]): ActionResult<number> => {
        const halves: Product[] = [];
        for (const hid of halfIds) {
          const h = get().products.find((p) => p.id === hid);
          if (!h || !h.active) return fail('Sabor do meio-a-meio não encontrado.');
          if (!h.available) return fail(`${h.name} está em falta.`);
          if (!product.allows_half_and_half || !h.allows_half_and_half) return fail(`${h.name} não pode ser servido meio-a-meio.`);
          halves.push(h);
        }
        return {
          ok: true,
          data: halves.length ? halfAndHalfPrice([salePrice(product), ...halves.map(salePrice)], get().halfAndHalfPricing) : salePrice(product),
        };
      };

      /** Cobrança em andamento na maquininha para a conta (ignora as abandonadas). */
      const activeCharge = (orderId: UUID): PendingCharge | null =>
        get().pendingCharges.find((c) => c.order_id === orderId && Date.now() - c.started_at < PENDING_CHARGE_TTL_MS) ?? null;

      const CHARGE_LOCK_ERROR = 'Há uma cobrança em andamento na maquininha para esta mesa. Aguarde a resposta.';

      /**
       * Encerra a conta quando o saldo chega a zero com algo já pago: CLOSED,
       * NFC-e autorizada, itens quitados e mesa livre. Usado tanto pelo
       * pagamento quanto pelos ajustes autorizados que zeram o saldo.
       */
      const settleIfPaid = (
        s: TcheState,
        recalculated: Order,
        orderItems: OrderItem[],
        ts: string,
      ): { order: Order; orderItems: OrderItem[]; nfceSeq: number; table: DiningTable | null; closed: boolean } => {
        if (toCents(recalculated.paid_amount) <= 0 || toCents(recalculated.remaining_balance) !== 0) {
          return { order: recalculated, orderItems, nfceSeq: s.nfceSeq, table: null, closed: false };
        }
        const nfceSeq = s.nfceSeq + 1;
        const table = s.tables.find((t) => t.id === recalculated.table_id);
        return {
          order: {
            ...recalculated,
            status: 'CLOSED',
            closed_at: ts,
            nfce_status: 'AUTORIZADA',
            nfce_key: buildAccessKey({ cnpj: s.tenant.cnpj, issuedAt: new Date(ts), number: nfceSeq }),
          },
          orderItems: orderItems.map((i) => (i.order_id === recalculated.id && i.status !== 'CANCELED' ? { ...i, is_paid: true } : i)),
          nfceSeq,
          table: table ? { ...table, status: 'FREE', current_order_id: null, updated_at: ts } : null,
          closed: true,
        };
      };

      /**
       * Um ajuste que vai encerrar a conta não pode descartar itens ainda na bandeja:
       * o operador precisa enviar ou remover antes.
       */
      const blocksSettleWithTray = (simulated: Order): string | null =>
        toCents(simulated.paid_amount) > 0 && toCents(simulated.remaining_balance) === 0 && get().tray.some((t) => t.order_id === simulated.id)
          ? 'Este ajuste quita a conta, mas há itens na bandeja não enviados. Envie ou remova antes.'
          : null;

      /** Resultado de um ajuste financeiro: aplica totais e encerra se o saldo zerou. */
      const commitAdjustment = (
        s: TcheState,
        recalculated: Order,
        orderItems: OrderItem[],
        changedItems: OrderItem[],
        log: AuditLog,
      ): Partial<TcheState> => {
        const ts = nowISO();
        const settled = settleIfPaid(s, recalculated, orderItems, ts);
        const allChanged = settled.closed
          ? settled.orderItems.filter((i, idx) => i !== s.orderItems[idx])
          : changedItems;
        return {
          orderItems: settled.orderItems,
          nfceSeq: settled.nfceSeq,
          orders: s.orders.map((o) => (o.id === recalculated.id ? settled.order : o)),
          tables: settled.table ? s.tables.map((t) => (t.id === settled.table!.id ? settled.table! : t)) : s.tables,
          auditLogs: [log, ...s.auditLogs],
          outbox: [
            ...s.outbox,
            // O audit_log sobe antes: o banco recusa o ajuste sem a autorização já gravada.
            syncEvent('audit_logs', 'INSERT', log),
            ...allChanged.map((i) => syncEvent('order_items', 'UPDATE', i)),
            syncEvent('orders', 'UPDATE', settled.order),
            ...(settled.table ? [syncEvent('dining_tables', 'UPDATE', settled.table)] : []),
          ],
        };
      };

      const tableLabel = (tableId: UUID): string => get().tables.find((t) => t.id === tableId)?.label ?? '?';

      const buildAudit = (
        params: Omit<AuditLog, 'id' | 'tenant_id' | 'created_at' | 'whatsapp_alert_sent'>,
      ): AuditLog => ({
        id: uuid(),
        tenant_id: get().tenant.id,
        created_at: nowISO(),
        // Fase 1: o alerta é simulado no app; o disparo real (WhatsApp/painel) chega na Fase 4.
        whatsapp_alert_sent: true,
        ...params,
      });

      /**
       * Desiste de uma venda técnica ainda sem pagamento (ficha de balcão ou pedido com senha):
       * PIN de gerente, itens CANCELED com um audit_log cada, conta CANCELED.
       */
      const voidTechnicalSale = (orderId: UUID, auth: ManagerAuthInput, kind: 'COUNTER' | 'KIOSK'): ActionResult => {
        const res = findEditableOrder(orderId);
        if (!res.ok) return res;
        const order = res.data;
        const table = get().tables.find((t) => t.id === order.table_id);
        if (table?.kind !== kind) return fail(kind === 'COUNTER' ? 'Só vendas de balcão podem ser desfeitas aqui.' : 'Só pedidos com senha podem ser desfeitos aqui.');
        if (activeCharge(orderId)) return fail(CHARGE_LOCK_ERROR);
        if (toCents(order.paid_amount) > 0) return fail('Venda já tem pagamento aprovado. Estorne pela maquininha.');
        const authRes = authorizeManager(auth, { orderId, action: 'ITEM_CANCELED' });
        if (!authRes.ok) return authRes;
        const user = currentUser()!;
        const manager = authRes.data;
        const ts = nowISO();
        const reason = auth.reason.trim();
        const targets = get().orderItems.filter((i) => i.order_id === orderId && i.status !== 'CANCELED');
        // Um audit_log por item: o banco exige o vínculo item ↔ autorização do gerente.
        const logs = targets.map((item) => {
          const product = get().products.find((p) => p.id === item.product_id);
          return buildAudit({
            order_id: orderId,
            performed_by_user_id: user.id,
            authorized_by_manager_id: manager.id,
            action_type: 'ITEM_CANCELED',
            amount_impact: -item.total_item_price,
            reason,
            metadata: {
              table: table.label,
              item_id: item.id,
              product_code: product?.code ?? null,
              product_name: product?.name ?? null,
              quantity: item.quantity,
              item_total: item.total_item_price,
              item_status_before: item.status,
              ...(kind === 'COUNTER' ? { counter_sale_voided: true } : { kiosk_order_voided: true, pickup_number: order.pickup_number }),
              waiter_name: user.name,
              manager_name: manager.name,
            },
          });
        });
        set((s) => {
          let kegTaps = s.kegTaps;
          const canceled = new Map<UUID, OrderItem>();
          for (const item of targets) {
            kegTaps = applyKegCancel(kegTaps, s.kegTapProducts, item);
            canceled.set(item.id, { ...item, status: 'CANCELED', canceled_at: ts, canceled_by_user_id: user.id, cancel_reason: reason });
          }
          const orderItems = s.orderItems.map((i) => canceled.get(i.id) ?? i);
          const current = s.orders.find((o) => o.id === orderId)!;
          const updated: Order = { ...applyOrderTotals(current, orderItems, s.payments), status: 'CANCELED', closed_at: ts, nfce_status: null };
          return {
            orderItems,
            kegTaps,
            orders: s.orders.map((o) => (o.id === orderId ? updated : o)),
            auditLogs: [...logs.reverse(), ...s.auditLogs],
            outbox: [
              ...s.outbox,
              ...[...canceled.values()].map((i) => syncEvent('order_items', 'UPDATE', i)),
              syncEvent('orders', 'UPDATE', updated),
              ...logs.map((l) => syncEvent('audit_logs', 'INSERT', l)),
              ...changedTaps(s.kegTaps, kegTaps).map((k) => syncEvent('keg_taps', 'UPDATE', k)),
            ],
          };
        });
        return { ok: true, data: undefined };
      };

      // -----------------------------------------------------------------------
      // Ações públicas
      // -----------------------------------------------------------------------
      return {
        ...initialData(),
        ...initialDevice(),

        login: (pin) => {
          const user = get().staff.find((s) => s.active && s.pin_code === pin);
          if (!user) return fail('PIN não reconhecido.');
          if (user.pin_code.length !== pin.length) return fail('PIN não reconhecido.');
          set({ currentUserId: user.id });
          return { ok: true, data: user };
        },

        logout: () => {
          const uid = get().currentUserId;
          if (get().pendingCharges.some((c) => c.user_id === uid && Date.now() - c.started_at < PENDING_CHARGE_TTL_MS)) {
            return fail('Há uma cobrança em andamento na maquininha. Aguarde a resposta antes de sair.');
          }
          set({ currentUserId: null });
          return { ok: true, data: undefined };
        },

        openTable: (tableId, customerCount, customerCpf) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const table = get().tables.find((t) => t.id === tableId);
          if (!table) return fail('Mesa não encontrada.');
          if (table.status !== 'FREE') return fail(`${table.label} não está livre.`);
          const count = Math.floor(customerCount);
          if (!Number.isFinite(count) || count < 1) return fail('Informe ao menos 1 pessoa.');
          const cpf = customerCpf ? customerCpf.replace(/\D/g, '') : null;
          if (cpf && cpf.length !== 11) return fail('CPF deve ter 11 dígitos.');

          const ts = nowISO();
          const tenant = get().tenant;
          const order: Order = {
            id: uuid(),
            tenant_id: tenant.id,
            table_id: table.id,
            opened_by_user_id: user.id,
            status: 'OPEN',
            customer_count: count,
            customer_cpf: cpf,
            subtotal_items: 0,
            charge_service_fee: true,
            service_fee_pct: tenant.default_service_fee_pct,
            service_fee_amount: 0,
            discount_amount: 0,
            total_amount: 0,
            paid_amount: 0,
            remaining_balance: 0,
            nfce_status: 'PENDING',
            nfce_key: null,
            opened_at: ts,
            closed_at: null,
            pickup_number: null,
            pickup_name: null,
            fulfillment_type: null,
          };
          const updatedTable: DiningTable = { ...table, status: 'OCCUPIED', current_order_id: order.id, updated_at: ts };
          set((s) => ({
            orders: [...s.orders, order],
            tables: s.tables.map((t) => (t.id === table.id ? updatedTable : t)),
            outbox: [...s.outbox, syncEvent('orders', 'INSERT', order), syncEvent('dining_tables', 'UPDATE', updatedTable)],
          }));
          return { ok: true, data: order };
        },

        releaseTable: (tableId) => {
          const table = get().tables.find((t) => t.id === tableId);
          if (!table) return fail('Mesa não encontrada.');
          if (table.status !== 'DIRTY') return fail('Só é possível liberar mesas aguardando limpeza.');
          const updated: DiningTable = { ...table, status: 'FREE', current_order_id: null, updated_at: nowISO() };
          set((s) => ({
            tables: s.tables.map((t) => (t.id === tableId ? updated : t)),
            outbox: [...s.outbox, syncEvent('dining_tables', 'UPDATE', updated)],
          }));
          return { ok: true, data: undefined };
        },

        updateCustomerCount: (orderId, count) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const n = Math.floor(count);
          if (n < 1 || n > 99) return fail('Quantidade de pessoas inválida.');
          const updated = { ...res.data, customer_count: n };
          set((s) => ({
            orders: s.orders.map((o) => (o.id === orderId ? updated : o)),
            outbox: [...s.outbox, syncEvent('orders', 'UPDATE', updated)],
          }));
          return { ok: true, data: undefined };
        },

        requestBill: (orderId) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (get().tray.some((t) => t.order_id === orderId)) {
            return fail('Há itens na bandeja não enviados. Envie ou remova antes de pedir a conta.');
          }
          const table = get().tables.find((t) => t.id === order.table_id);
          if (!table) return fail('Mesa não encontrada.');
          if (table.status !== 'OCCUPIED') return fail('A mesa precisa estar ocupada.');
          const updated: DiningTable = { ...table, status: 'WAITING_BILL', updated_at: nowISO() };
          set((s) => ({
            tables: s.tables.map((t) => (t.id === table.id ? updated : t)),
            outbox: [...s.outbox, syncEvent('dining_tables', 'UPDATE', updated)],
          }));
          return { ok: true, data: undefined };
        },

        resumeService: (orderId) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const table = get().tables.find((t) => t.id === res.data.table_id);
          if (!table) return fail('Mesa não encontrada.');
          if (table.status !== 'WAITING_BILL') return { ok: true, data: undefined };
          const updated: DiningTable = { ...table, status: 'OCCUPIED', updated_at: nowISO() };
          set((s) => ({
            tables: s.tables.map((t) => (t.id === table.id ? updated : t)),
            outbox: [...s.outbox, syncEvent('dining_tables', 'UPDATE', updated)],
          }));
          return { ok: true, data: undefined };
        },

        addToTray: (draft) => {
          const res = findEditableOrder(draft.order_id);
          if (!res.ok) return res;
          const product = get().products.find((p) => p.id === draft.product_id);
          if (!product || !product.active) return fail('Produto não encontrado.');
          if (!product.available) return fail(`${product.name} está em falta.`);
          // Preço base sempre do cadastro (com regra de horário), nunca o que a tela mandou.
          const base = basePriceFor(product, draft.half_product_ids);
          if (!base.ok) return base;
          const basePrice = base.data;
          if (product.requires_meat_doneness && !draft.meat_doneness) {
            return fail('Ponto da carne é obrigatório.');
          }
          const qty = round3(draft.quantity);
          if (!(qty > 0)) return fail('Quantidade deve ser maior que zero.');
          if (product.sold_by_weight) {
            // Item pesado: quantidade e preço vêm da balança e do cadastro (igual ao trigger do banco).
            const w = draft.weight;
            if (!w) return fail(`${product.name} é vendido por peso. Use a balança.`);
            const net = computeNetWeight(w.gross_grams, w.tare_grams);
            if ('error' in net) return fail(net.error);
            const item: TrayItem = {
              ...draft,
              half_product_ids: [],
              modifiers: [],
              modifiers_unit_price: 0,
              quantity: round3(net.quantityKg),
              unit_price: product.price,
              sector: product.sector,
              weight: { ...w },
              tray_id: uuid(),
              added_at: nowISO(),
            };
            set((s) => ({ tray: [...s.tray, item] }));
            return { ok: true, data: item };
          }
          if (draft.weight) return fail(`${product.name} não é vendido por peso.`);

          // Validação de grupos obrigatórios / limites (mesma regra do modal).
          const groups = get()
            .productModifierGroups.filter((l) => l.product_id === product.id)
            .map((l) => get().modifierGroups.find((g) => g.id === l.group_id))
            .filter((g): g is ModifierGroup => Boolean(g));
          for (const g of groups) {
            const chosen = draft.modifiers.filter((m) => m.group_id === g.id).length;
            const min = g.required ? Math.max(1, g.min_selection) : g.min_selection;
            if (chosen < min) return fail(`Escolha ${g.name}.`);
            if (chosen > g.max_selection) return fail(`${g.name}: máximo ${g.max_selection}.`);
          }
          // Preço dos modificadores sempre recalculado a partir do cadastro.
          const options = get().modifierOptions;
          let modsCents = 0;
          for (const m of draft.modifiers) {
            const opt = options.find((o) => o.id === m.option_id && o.group_id === m.group_id);
            if (!opt) return fail('Modificador inválido.');
            modsCents += toCents(opt.additional_price);
          }

          const item: TrayItem = {
            ...draft,
            quantity: qty,
            unit_price: round2(basePrice),
            modifiers_unit_price: modsCents / 100,
            sector: product.sector,
            tray_id: uuid(),
            added_at: nowISO(),
          };
          set((s) => ({ tray: [...s.tray, item] }));
          return { ok: true, data: item };
        },

        updateTrayQty: (trayId, quantity) => {
          const qty = round3(quantity);
          set((s) => ({
            tray:
              qty > 0
                ? // Prato pesado não muda de quantidade na mão: remove e pesa de novo.
                  s.tray.map((t) => (t.tray_id === trayId && !t.weight ? { ...t, quantity: qty } : t))
                : s.tray.filter((t) => t.tray_id !== trayId),
          }));
        },

        removeFromTray: (trayId) => set((s) => ({ tray: s.tray.filter((t) => t.tray_id !== trayId) })),

        clearTray: (orderId) => set((s) => ({ tray: s.tray.filter((t) => t.order_id !== orderId) })),

        dispatchTray: (orderId) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const pending = get().tray.filter((t) => t.order_id === orderId);
          if (pending.length === 0) return fail('Bandeja vazia.');

          const ts = nowISO();
          const products = get().products;
          const newItems: OrderItem[] = pending.map((t) => {
            const product = products.find((p) => p.id === t.product_id);
            const halfNames = t.half_product_ids
              .map((id) => products.find((p) => p.id === id)?.name)
              .filter((n): n is string => Boolean(n));
            const noteParts = [
              ...(halfNames.length && product ? [`1/2 ${product.name} + ${halfNames.map((n) => `1/2 ${n}`).join(' + ')}`] : []),
              ...(t.weight ? [weightNote(t.weight)] : []),
              ...t.modifiers.map((m) => `+ ${m.name}`),
              ...t.quick_tags,
              ...(t.free_notes.trim() ? [t.free_notes.trim()] : []),
            ];
            return {
              id: uuid(),
              order_id: orderId,
              product_id: t.product_id,
              waiter_id: user.id,
              quantity: t.quantity,
              unit_price: t.unit_price,
              modifiers_unit_price: t.modifiers_unit_price,
              total_item_price: computeItemTotal(t.quantity, t.unit_price, t.modifiers_unit_price),
              meat_doneness: t.meat_doneness,
              notes: noteParts.length ? noteParts.join(' · ') : null,
              sector: t.sector,
              // Prato pesado já está com o cliente (ele se serve no buffet): não vai para a produção.
              status: t.weight ? 'DELIVERED' : 'PENDING',
              is_paid: false,
              origin: 'WAITER',
              created_at: ts,
              prepared_at: null,
              canceled_at: null,
              canceled_by_user_id: null,
              cancel_reason: null,
              weight_gross_grams: t.weight?.gross_grams ?? null,
              weight_tare_grams: t.weight?.tare_grams ?? null,
              weight_source: t.weight?.source ?? null,
              keg_volume_ml: resolveKegVolume(t.product_id, t.modifiers, get().kegTapProducts, get().modifierOptions),
            };
          });

          set((s) => {
            const orderItems = [...s.orderItems, ...newItems];
            const order = s.orders.find((o) => o.id === orderId)!;
            const recalculated = applyOrderTotals(order, orderItems, s.payments);
            const table = s.tables.find((t) => t.id === order.table_id);
            // Novo pedido numa mesa que pediu a conta volta a "ocupada".
            const updatedTable =
              table && table.status === 'WAITING_BILL' ? { ...table, status: 'OCCUPIED' as const, updated_at: ts } : null;
            const kegTaps = applyKegSale(s.kegTaps, s.kegTapProducts, newItems);
            return {
              orderItems,
              kegTaps,
              orders: s.orders.map((o) => (o.id === orderId ? recalculated : o)),
              tables: updatedTable ? s.tables.map((t) => (t.id === updatedTable.id ? updatedTable : t)) : s.tables,
              tray: s.tray.filter((t) => t.order_id !== orderId),
              outbox: [
                ...s.outbox,
                ...newItems.map((i) => syncEvent('order_items', 'INSERT', i)),
                ...changedTaps(s.kegTaps, kegTaps).map((k) => syncEvent('keg_taps', 'UPDATE', k)),
                syncEvent('orders', 'UPDATE', recalculated),
                ...(updatedTable ? [syncEvent('dining_tables', 'UPDATE', updatedTable)] : []),
              ],
            };
          });

          const sectors = Array.from(new Set(newItems.map((i) => i.sector)));
          return { ok: true, data: { count: newItems.length, sectors, items: newItems } };
        },

        markItemDelivered: (itemId) => {
          const item = get().orderItems.find((i) => i.id === itemId);
          if (!item) return fail('Item não encontrado.');
          if (item.status !== 'READY') return fail('Só itens prontos podem ser entregues.');
          const updated: OrderItem = { ...item, status: 'DELIVERED' };
          set((s) => ({
            orderItems: s.orderItems.map((i) => (i.id === itemId ? updated : i)),
            outbox: [...s.outbox, syncEvent('order_items', 'UPDATE', updated)],
          }));
          return { ok: true, data: undefined };
        },

        cancelOrderItem: (itemId, auth) => {
          const item = get().orderItems.find((i) => i.id === itemId);
          if (!item) return fail('Item não encontrado.');
          if (item.status === 'CANCELED') return fail('Item já cancelado.');
          if (item.is_paid) return fail('Item já pago. Estorno deve ser feito pelo módulo de pagamentos.');
          const orderRes = findEditableOrder(item.order_id);
          if (!orderRes.ok) return orderRes;
          const order = orderRes.data;
          if (activeCharge(order.id)) return fail(CHARGE_LOCK_ERROR);

          // Simula o novo total antes de autorizar: não pode ficar abaixo do já pago.
          const ts = nowISO();
          const user = currentUser()!;
          const canceledItem: OrderItem = {
            ...item,
            status: 'CANCELED',
            canceled_at: ts,
            canceled_by_user_id: user?.id ?? null,
            cancel_reason: auth.reason.trim(),
          };
          const simulatedItems = get().orderItems.map((i) => (i.id === itemId ? canceledItem : i));
          const simulated = applyOrderTotals(order, simulatedItems, get().payments);
          if (toCents(simulated.total_amount) < toCents(order.paid_amount)) {
            return fail('Cancelamento deixaria a conta abaixo do valor já pago. Estorne um pagamento primeiro.');
          }
          const trayBlock = blocksSettleWithTray(simulated);
          if (trayBlock) return fail(trayBlock);

          const authRes = authorizeManager(auth, { orderId: order.id, action: 'ITEM_CANCELED' });
          if (!authRes.ok) return authRes;
          const manager = authRes.data;

          const product = get().products.find((p) => p.id === item.product_id);
          const log = buildAudit({
            order_id: order.id,
            performed_by_user_id: user.id,
            authorized_by_manager_id: manager.id,
            action_type: 'ITEM_CANCELED',
            amount_impact: round2(simulated.total_amount - order.total_amount),
            reason: auth.reason.trim(),
            metadata: {
              table: tableLabel(order.table_id),
              item_id: item.id,
              product_code: product?.code ?? null,
              product_name: product?.name ?? null,
              quantity: item.quantity,
              item_total: item.total_item_price,
              item_status_before: item.status,
              sector: item.sector,
              waiter_name: user.name,
              manager_name: manager.name,
            },
          });

          set((s) => {
            const orderItems = s.orderItems.map((i) => (i.id === itemId ? canceledItem : i));
            const current = s.orders.find((o) => o.id === order.id)!;
            const recalculated = applyOrderTotals(current, orderItems, s.payments);
            const before = s.orderItems.find((i) => i.id === itemId)!;
            const kegTaps = applyKegCancel(s.kegTaps, s.kegTapProducts, before);
            const patch = commitAdjustment(s, recalculated, orderItems, [canceledItem], log);
            return {
              ...patch,
              kegTaps,
              outbox: [...patch.outbox!, ...changedTaps(s.kegTaps, kegTaps).map((k) => syncEvent('keg_taps', 'UPDATE', k))],
            };
          });
          return { ok: true, data: log };
        },

        removeServiceFee: (orderId, auth) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (!order.charge_service_fee) return fail('A taxa de serviço já foi removida.');
          if (activeCharge(orderId)) return fail(CHARGE_LOCK_ERROR);
          const simulated = applyOrderTotals({ ...order, charge_service_fee: false }, get().orderItems, get().payments);
          if (toCents(simulated.total_amount) < toCents(order.paid_amount)) {
            return fail('Remover a taxa deixaria a conta abaixo do valor já pago.');
          }
          const trayBlock = blocksSettleWithTray(simulated);
          if (trayBlock) return fail(trayBlock);
          const authRes = authorizeManager(auth, { orderId, action: 'SERVICE_FEE_REMOVED' });
          if (!authRes.ok) return authRes;
          const user = currentUser()!;
          const log = buildAudit({
            order_id: orderId,
            performed_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
            action_type: 'SERVICE_FEE_REMOVED',
            amount_impact: round2(simulated.total_amount - order.total_amount),
            reason: auth.reason.trim(),
            metadata: {
              table: tableLabel(order.table_id),
              service_fee_pct: order.service_fee_pct,
              service_fee_amount_before: order.service_fee_amount,
              waiter_name: user.name,
              manager_name: authRes.data.name,
            },
          });
          set((s) => {
            const current = s.orders.find((o) => o.id === orderId)!;
            const recalculated = applyOrderTotals({ ...current, charge_service_fee: false }, s.orderItems, s.payments);
            return commitAdjustment(s, recalculated, s.orderItems, [], log);
          });
          return { ok: true, data: log };
        },

        restoreServiceFee: (orderId) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (order.charge_service_fee) return fail('A taxa de serviço já está ativa.');
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          // Reativar a taxa aumenta a cobrança: não exige PIN, mas fica registrado.
          set((s) => {
            const current = s.orders.find((o) => o.id === orderId)!;
            const recalculated = applyOrderTotals({ ...current, charge_service_fee: true }, s.orderItems, s.payments);
            const log = buildAudit({
              order_id: orderId,
              performed_by_user_id: user.id,
              authorized_by_manager_id: null,
              action_type: 'SERVICE_FEE_RESTORED',
              amount_impact: round2(recalculated.total_amount - current.total_amount),
              reason: 'Taxa de serviço reativada pelo garçom.',
              metadata: { table: tableLabel(current.table_id), waiter_name: user.name },
            });
            return {
              orders: s.orders.map((o) => (o.id === orderId ? recalculated : o)),
              auditLogs: [{ ...log, whatsapp_alert_sent: false }, ...s.auditLogs],
              outbox: [...s.outbox, syncEvent('audit_logs', 'INSERT', log), syncEvent('orders', 'UPDATE', recalculated)],
            };
          });
          return { ok: true, data: get().auditLogs[0]! };
        },

        applyDiscount: (orderId, amount, auth) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          const discount = round2(amount);
          if (!(discount > 0)) return fail('Informe um desconto maior que zero.');
          if (activeCharge(orderId)) return fail(CHARGE_LOCK_ERROR);
          // O desconto manual substitui o valor; com cashback já abatido ele apagaria o resgate.
          if (get().cashbackLedger.some((e) => e.order_id === orderId && e.entry_type === 'REDEEM')) {
            return fail('Esta conta já usou cashback. Desconto manual não pode ser combinado.');
          }
          const gross = round2(order.subtotal_items + order.service_fee_amount);
          if (toCents(discount) > toCents(gross)) return fail('Desconto maior que o valor da conta.');
          const simulated = applyOrderTotals({ ...order, discount_amount: discount }, get().orderItems, get().payments);
          if (toCents(simulated.total_amount) < toCents(order.paid_amount)) {
            return fail('Desconto deixaria a conta abaixo do valor já pago.');
          }
          const trayBlock = blocksSettleWithTray(simulated);
          if (trayBlock) return fail(trayBlock);
          const authRes = authorizeManager(auth, { orderId, action: 'DISCOUNT_APPLIED' });
          if (!authRes.ok) return authRes;
          const user = currentUser()!;
          const log = buildAudit({
            order_id: orderId,
            performed_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
            action_type: 'DISCOUNT_APPLIED',
            amount_impact: round2(simulated.total_amount - order.total_amount),
            reason: auth.reason.trim(),
            metadata: {
              table: tableLabel(order.table_id),
              discount_before: order.discount_amount,
              discount_after: discount,
              waiter_name: user.name,
              manager_name: authRes.data.name,
            },
          });
          set((s) => {
            const current = s.orders.find((o) => o.id === orderId)!;
            const recalculated = applyOrderTotals({ ...current, discount_amount: discount }, s.orderItems, s.payments);
            return commitAdjustment(s, recalculated, s.orderItems, [], log);
          });
          return { ok: true, data: log };
        },

        startCheckout: (orderId) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (get().tray.some((t) => t.order_id === orderId)) {
            return fail('Há itens na bandeja não enviados. Envie ou remova antes de cobrar.');
          }
          if (order.remaining_balance <= 0) return fail('Conta sem saldo a cobrar.');
          const table = get().tables.find((t) => t.id === order.table_id);
          if (!table) return fail('Mesa não encontrada.');
          const ts = nowISO();
          const updatedOrder: Order = { ...order, status: 'PAYING' };
          const updatedTable: DiningTable = { ...table, status: 'PAYING', updated_at: ts };
          set((s) => ({
            orders: s.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
            tables: s.tables.map((t) => (t.id === table.id ? updatedTable : t)),
            outbox: [...s.outbox, syncEvent('orders', 'UPDATE', updatedOrder), syncEvent('dining_tables', 'UPDATE', updatedTable)],
          }));
          return { ok: true, data: undefined };
        },

        registerPayment: (input) => {
          const res = findEditableOrder(input.orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (input.status === 'APPROVED' && get().tray.some((t) => t.order_id === order.id)) {
            return fail('Há itens na bandeja não enviados. Envie ou remova antes de cobrar.');
          }
          const lock = activeCharge(order.id);
          const fromLockedCharge = Boolean(lock && input.charge_request_id && lock.request_id === input.charge_request_id);
          if (lock && !fromLockedCharge) return fail(CHARGE_LOCK_ERROR);
          // A maquininha já cobrou: o pagamento pertence a quem iniciou a cobrança,
          // mesmo que a sessão tenha mudado nesse meio-tempo.
          const user = fromLockedCharge ? get().staff.find((u) => u.id === lock!.user_id) ?? null : currentUser();
          if (!user) return fail('Sessão expirada.');
          const amount = round2(input.amount);
          if (!(amount > 0)) return fail('Valor do pagamento deve ser maior que zero.');
          if (get().payments.some((p) => p.idempotency_key === input.idempotency_key)) {
            return fail('Transação duplicada (idempotency_key já registrada).');
          }
          if (input.status === 'APPROVED' && toCents(amount) > toCents(order.remaining_balance)) {
            return fail('Valor maior que o saldo restante da mesa.');
          }
          const items = get().orderItems;
          for (const id of input.item_ids) {
            const it = items.find((i) => i.id === id);
            if (!it || it.order_id !== order.id) return fail('Item selecionado não pertence à mesa.');
            if (it.status === 'CANCELED') return fail('Item cancelado não pode ser pago.');
            if (it.is_paid) return fail('Item já está pago.');
          }

          const ts = nowISO();
          const payment: Payment = {
            id: uuid(),
            order_id: order.id,
            tenant_id: get().tenant.id,
            waiter_id: user.id,
            terminal_id: input.terminal_id,
            amount,
            tip_amount: round2(input.tip_amount ?? 0),
            method: input.method,
            status: input.status,
            acquirer: input.acquirer,
            acquirer_cnpj: input.acquirer_cnpj,
            card_brand: input.card_brand,
            nsu: input.nsu,
            authorization_code: input.authorization_code,
            terminal_serial: input.terminal_serial,
            idempotency_key: input.idempotency_key,
            created_at: ts,
          };

          let outcome: PaymentOutcome | null = null;
          set((s) => {
            const payments = [...s.payments, payment];
            const paidIds = new Set(input.status === 'APPROVED' ? input.item_ids : []);
            let orderItems = paidIds.size
              ? s.orderItems.map((i) => (paidIds.has(i.id) ? { ...i, is_paid: true } : i))
              : s.orderItems;
            const current = s.orders.find((o) => o.id === order.id)!;
            let recalculated = applyOrderTotals(current, orderItems, payments);
            const table = s.tables.find((t) => t.id === current.table_id);
            let nfceSeq = s.nfceSeq;
            let updatedTable: DiningTable | null = null;
            let closed = false;
            if (input.status === 'APPROVED') {
              const settled = settleIfPaid(s, recalculated, orderItems, ts);
              closed = settled.closed;
              recalculated = settled.order;
              orderItems = settled.orderItems;
              nfceSeq = settled.nfceSeq;
              updatedTable = settled.table;
            }
            if (input.status === 'APPROVED' && !closed) {
              recalculated = { ...recalculated, status: 'PAYING' };
              if (table && table.status !== 'PAYING') updatedTable = { ...table, status: 'PAYING', updated_at: ts };
            }
            outcome = { payment, order: recalculated, closed };
            const changedItems = orderItems.filter((i, idx) => i !== s.orderItems[idx]);
            return {
              payments,
              orderItems,
              nfceSeq,
              pendingCharges: fromLockedCharge ? s.pendingCharges.filter((c) => c.request_id !== input.charge_request_id) : s.pendingCharges,
              orders: s.orders.map((o) => (o.id === order.id ? recalculated : o)),
              tables: updatedTable ? s.tables.map((t) => (t.id === updatedTable!.id ? updatedTable! : t)) : s.tables,
              outbox: [
                ...s.outbox,
                syncEvent('payments', 'INSERT', payment),
                ...changedItems.map((i) => syncEvent('order_items', 'UPDATE', i)),
                syncEvent('orders', 'UPDATE', recalculated),
                ...(updatedTable ? [syncEvent('dining_tables', 'UPDATE', updatedTable)] : []),
              ],
            };
          });
          return { ok: true, data: outcome! };
        },

        beginTerminalCharge: (orderId, requestId, amount) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          if (activeCharge(orderId)) return fail(CHARGE_LOCK_ERROR);
          if (get().tray.some((t) => t.order_id === orderId)) return fail('Há itens na bandeja não enviados. Envie ou remova antes de cobrar.');
          const value = round2(amount);
          if (!(value > 0) || toCents(value) > toCents(res.data.remaining_balance)) return fail('Valor maior que o saldo restante da mesa.');
          set((s) => ({
            pendingCharges: [
              ...s.pendingCharges.filter((c) => c.order_id !== orderId),
              { request_id: requestId, order_id: orderId, amount: value, user_id: user.id, started_at: Date.now() },
            ],
          }));
          return { ok: true, data: undefined };
        },

        closeZeroOrder: (orderId) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (toCents(order.remaining_balance) !== 0 || toCents(order.paid_amount) !== 0) return fail('Só contas zeradas e sem pagamento podem ser encerradas assim.');
          if (activeCharge(orderId)) return fail(CHARGE_LOCK_ERROR);
          if (get().tray.some((t) => t.order_id === orderId)) return fail('Há itens na bandeja não enviados. Envie ou remova antes de encerrar.');
          const ts = nowISO();
          const hasItems = get().orderItems.some((i) => i.order_id === orderId && i.status !== 'CANCELED');
          // Nada consumido: conta cancelada, sem NFC-e. Consumo com 100% de desconto
          // (já autorizado por gerente): conta fechada, NFC-e fica pendente para o fiscal.
          const closed: Order = hasItems
            ? { ...order, status: 'CLOSED', closed_at: ts, nfce_status: 'PENDING' }
            : { ...order, status: 'CANCELED', closed_at: ts, nfce_status: 'DISPENSADA' };
          const table = get().tables.find((t) => t.id === order.table_id);
          const freed: DiningTable | null = table && table.current_order_id === orderId ? { ...table, status: 'FREE', current_order_id: null, updated_at: ts } : null;
          set((s) => ({
            orders: s.orders.map((o) => (o.id === orderId ? closed : o)),
            tables: freed ? s.tables.map((t) => (t.id === freed.id ? freed : t)) : s.tables,
            outbox: [...s.outbox, syncEvent('orders', 'UPDATE', closed), ...(freed ? [syncEvent('dining_tables', 'UPDATE', freed)] : [])],
          }));
          return { ok: true, data: closed };
        },

        endTerminalCharge: (requestId) => set((s) => ({ pendingCharges: s.pendingCharges.filter((c) => c.request_id !== requestId) })),

        advanceItemStatus: (itemId) => {
          const res = get().advanceItems([itemId]);
          if (!res.ok) return res;
          return { ok: true, data: res.data[0]! };
        },

        advanceItems: (itemIds) => {
          const next: Record<OrderItem['status'], OrderItem['status'] | null> = {
            PENDING: 'PREPARING',
            PREPARING: 'READY',
            READY: 'DELIVERED',
            DELIVERED: null,
            CANCELED: null,
          };
          const ts = nowISO();
          const targets = get().orderItems.filter((i) => itemIds.includes(i.id) && next[i.status]);
          if (targets.length === 0) return fail('Nenhum item para avançar.');
          const updated = targets.map((i) => {
            const status = next[i.status]!;
            return { ...i, status, prepared_at: status === 'READY' ? ts : i.prepared_at };
          });
          const byId = new Map(updated.map((u) => [u.id, u]));
          set((s) => ({
            orderItems: s.orderItems.map((i) => byId.get(i.id) ?? i),
            outbox: [...s.outbox, ...updated.map((u) => syncEvent('order_items', 'UPDATE', u))],
          }));
          return { ok: true, data: updated };
        },

        qrPlaceOrder: (tableId, drafts) => {
          if (drafts.length === 0) return fail('Carrinho vazio.');
          const s0 = get();
          const table = s0.tables.find((t) => t.id === tableId);
          if (!table) return fail('Mesa não encontrada.');
          if (table.status === 'DIRTY') return fail('Mesa em limpeza. Chame o garçom.');
          if (table.status === 'PAYING') return fail('Conta em fechamento. Chame o garçom para novos pedidos.');
          const qrUser = s0.staff.find((u) => isQrSelfService(u) && u.active);
          if (!qrUser) return fail('Autoatendimento indisponível.');
          const ts = nowISO();
          let order = table.current_order_id ? s0.orders.find((o) => o.id === table.current_order_id) : undefined;
          const newOrder = !order;
          if (!order) {
            order = {
              id: uuid(),
              tenant_id: s0.tenant.id,
              table_id: table.id,
              opened_by_user_id: qrUser.id,
              status: 'OPEN',
              customer_count: 1,
              customer_cpf: null,
              subtotal_items: 0,
              charge_service_fee: true,
              service_fee_pct: s0.tenant.default_service_fee_pct,
              service_fee_amount: 0,
              discount_amount: 0,
              total_amount: 0,
              paid_amount: 0,
              remaining_balance: 0,
              nfce_status: 'PENDING',
              nfce_key: null,
              opened_at: ts,
              closed_at: null,
              pickup_number: null,
              pickup_name: null,
              fulfillment_type: null,
            };
          }
          const products = s0.products;
          const newItems: OrderItem[] = [];
          for (const d of drafts) {
            const product = products.find((p) => p.id === d.product_id);
            if (!product || !product.active || !product.available) return fail('Produto indisponível.');
            if (product.sold_by_weight) return fail(`${product.name} é pesado no buffet. Chame o garçom.`);
            const base = basePriceFor(product, d.half_product_ids);
            if (!base.ok) return base;
            const price = base.data;
            if (product.requires_meat_doneness && !d.meat_doneness) return fail(`Escolha o ponto de ${product.name}.`);
            let modsCents = 0;
            for (const m of d.modifiers) {
              const opt = s0.modifierOptions.find((o) => o.id === m.option_id && o.group_id === m.group_id);
              if (!opt) return fail('Adicional inválido.');
              modsCents += toCents(opt.additional_price);
            }
            const groups = s0.productModifierGroups
              .filter((l) => l.product_id === product.id)
              .map((l) => s0.modifierGroups.find((g) => g.id === l.group_id))
              .filter((g): g is ModifierGroup => Boolean(g));
            for (const g of groups) {
              const chosen = d.modifiers.filter((m) => m.group_id === g.id).length;
              const min = g.required ? Math.max(1, g.min_selection) : g.min_selection;
              if (chosen < min || chosen > g.max_selection) return fail(`${product.name}: verifique ${g.name}.`);
            }
            const qty = round3(d.quantity);
            if (!(qty > 0)) return fail('Quantidade inválida.');
            // Sabor do meio a meio precisa ser outro produto da mesma categoria.
            if (d.half_product_ids.some((id) => { const h = products.find((p) => p.id === id); return !h || h.id === product.id || h.category_id !== product.category_id; })) {
              return fail('Sabor do meio a meio inválido.');
            }
            // O cliente confirma o preço que viu. Se a regra de horário (ou o cadastro) mudou
            // desde que ele montou o carrinho, o pedido não sai com outro valor sem ele ver.
            if (toCents(d.unit_price) !== toCents(price) || toCents(d.modifiers_unit_price) !== modsCents) {
              return fail(`${QR_PRICE_CHANGED} ${product.name} agora custa ${formatBRL(price)}${modsCents > 0 ? ` + ${formatBRL(fromCentsLocal(modsCents))} de adicionais` : ''}. Confira o pedido e envie de novo.`);
            }
            const halfNames = d.half_product_ids.map((id) => products.find((p) => p.id === id)?.name).filter((n): n is string => Boolean(n));
            const noteParts = [
              ...(halfNames.length ? [`1/2 ${product.name} + ${halfNames.map((n) => `1/2 ${n}`).join(' + ')}`] : []),
              ...d.modifiers.map((m) => `+ ${m.name}`),
              ...d.quick_tags, ...(d.free_notes.trim() ? [d.free_notes.trim()] : [])];
            newItems.push({
              id: uuid(),
              order_id: order.id,
              product_id: product.id,
              waiter_id: qrUser.id,
              quantity: qty,
              unit_price: price,
              modifiers_unit_price: fromCentsLocal(modsCents),
              total_item_price: computeItemTotal(qty, price, fromCentsLocal(modsCents)),
              meat_doneness: d.meat_doneness,
              notes: noteParts.length ? noteParts.join(' · ') : null,
              sector: product.sector,
              status: 'PENDING',
              is_paid: false,
              origin: 'QRCODE_TABLE',
              created_at: ts,
              prepared_at: null,
              canceled_at: null,
              canceled_by_user_id: null,
              cancel_reason: null,
              weight_gross_grams: null,
              weight_tare_grams: null,
              weight_source: null,
              keg_volume_ml: resolveKegVolume(product.id, d.modifiers, s0.kegTapProducts, s0.modifierOptions),
            });
          }
          const baseOrder = order;
          set((s) => {
            const orderItems = [...s.orderItems, ...newItems];
            const current = newOrder ? baseOrder : s.orders.find((o) => o.id === baseOrder.id)!;
            const recalculated = applyOrderTotals(current, orderItems, s.payments);
            const updatedTable: DiningTable = {
              ...table,
              status: 'OCCUPIED',
              current_order_id: recalculated.id,
              updated_at: ts,
            };
            const kegTaps = applyKegSale(s.kegTaps, s.kegTapProducts, newItems);
            return {
              orderItems,
              kegTaps,
              orders: newOrder ? [...s.orders, recalculated] : s.orders.map((o) => (o.id === recalculated.id ? recalculated : o)),
              tables: s.tables.map((t) => (t.id === table.id ? updatedTable : t)),
              outbox: [
                ...s.outbox,
                ...(newOrder ? [syncEvent('orders', 'INSERT', recalculated)] : [syncEvent('orders', 'UPDATE', recalculated)]),
                ...newItems.map((i) => syncEvent('order_items', 'INSERT', i)),
                syncEvent('dining_tables', 'UPDATE', updatedTable),
                ...changedTaps(s.kegTaps, kegTaps).map((k) => syncEvent('keg_taps', 'UPDATE', k)),
              ],
            };
          });
          const sectors = Array.from(new Set(newItems.map((i) => i.sector)));
          return { ok: true, data: { count: newItems.length, sectors, items: newItems } };
        },

        qrRequestBill: (tableId) => {
          const table = get().tables.find((t) => t.id === tableId);
          if (!table || !table.current_order_id) return fail('Mesa sem consumo.');
          if (table.status === 'WAITING_BILL') return { ok: true, data: undefined };
          if (table.status !== 'OCCUPIED') return fail('A conta já está sendo fechada.');
          const updated: DiningTable = { ...table, status: 'WAITING_BILL', updated_at: nowISO() };
          set((s) => ({
            tables: s.tables.map((t) => (t.id === tableId ? updated : t)),
            outbox: [...s.outbox, syncEvent('dining_tables', 'UPDATE', updated)],
          }));
          return { ok: true, data: undefined };
        },

        upsertPrinter: (printer) => {
          if (!printer.name.trim()) return fail('Informe o nome da impressora.');
          if (printer.connection === 'NETWORK_TCP' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(printer.ipAddress ?? '')) return fail('IP inválido (ex.: 192.168.1.200).');
          if (printer.connection === 'BLUETOOTH' && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(printer.macAddress ?? '')) return fail('MAC inválido (ex.: 66:22:A1:3C:7F:10).');
          const clean: PrinterConfig = { ...printer, name: printer.name.trim(), port: printer.connection === 'NETWORK_TCP' ? printer.port || 9100 : undefined };
          set((s) => ({
            printers: s.printers.some((p) => p.id === clean.id) ? s.printers.map((p) => (p.id === clean.id ? clean : p)) : [...s.printers, clean],
          }));
          return { ok: true, data: clean };
        },
        removePrinter: (printerId) => set((s) => ({ printers: s.printers.filter((p) => p.id !== printerId) })),
        setShowPrintSimulator: (v) => set({ showPrintSimulator: v }),

        // ---------------------------------------------------------------------
        // Fase 5 — Buffet a quilo
        // ---------------------------------------------------------------------
        addWeighedToTray: (orderId, productId, grossGrams, tareGrams, source) => {
          const product = get().products.find((p) => p.id === productId);
          if (!product) return fail('Produto não encontrado.');
          if (!product.sold_by_weight) return fail(`${product.name} não é vendido por peso.`);
          return get().addToTray({
            order_id: orderId,
            product_id: product.id,
            half_product_ids: [],
            quantity: 1,
            unit_price: product.price,
            modifiers: [],
            modifiers_unit_price: 0,
            meat_doneness: null,
            quick_tags: [],
            free_notes: '',
            sector: product.sector,
            weight: { gross_grams: Math.round(grossGrams), tare_grams: Math.round(tareGrams), source },
          });
        },

        // ---------------------------------------------------------------------
        // Fase 5 — Ficha Rápida / Balcão & Eventos
        // ---------------------------------------------------------------------
        createCounterSale: (lines) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          if (!COUNTER_ROLES.includes(user.role)) return fail('Seu perfil não vende no balcão.');
          if (lines.length === 0) return fail('Toque nos produtos para montar a venda.');
          const s0 = get();
          const counter = s0.tables.find((t) => t.kind === 'COUNTER');
          if (!counter) return fail('Balcão não configurado.');
          const ts = nowISO();
          const order: Order = {
            id: uuid(),
            tenant_id: s0.tenant.id,
            table_id: counter.id,
            opened_by_user_id: user.id,
            status: 'PAYING',
            customer_count: 1,
            customer_cpf: null,
            subtotal_items: 0,
            // Balcão / evento não cobra os 10% do garçom.
            charge_service_fee: false,
            service_fee_pct: s0.tenant.default_service_fee_pct,
            service_fee_amount: 0,
            discount_amount: 0,
            total_amount: 0,
            paid_amount: 0,
            remaining_balance: 0,
            nfce_status: 'PENDING',
            nfce_key: null,
            opened_at: ts,
            closed_at: null,
            pickup_number: null,
            pickup_name: null,
            fulfillment_type: null,
          };
          const items: OrderItem[] = [];
          for (const line of lines) {
            const product = s0.products.find((p) => p.id === line.product_id);
            if (!product || !product.available) return fail('Produto indisponível.');
            if (product.sold_by_weight) return fail(`${product.name} é vendido por peso: lance pela balança na comanda.`);
            if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) return fail('Quantidade inválida (1 a 99 fichas por item).');
            if (product.requires_meat_doneness && !line.meat_doneness) return fail(`Escolha o ponto de ${product.name}.`);
            const groups = s0.productModifierGroups
              .filter((l) => l.product_id === product.id)
              .map((l) => s0.modifierGroups.find((g) => g.id === l.group_id))
              .filter((g): g is ModifierGroup => Boolean(g));
            for (const g of groups) {
              const chosen = line.modifiers.filter((m) => m.group_id === g.id).length;
              const min = g.required ? Math.max(1, g.min_selection) : g.min_selection;
              if (chosen < min || chosen > g.max_selection) return fail(`${product.name}: verifique ${g.name}.`);
            }
            let modsCents = 0;
            for (const m of line.modifiers) {
              const opt = s0.modifierOptions.find((o) => o.id === m.option_id && o.group_id === m.group_id);
              if (!opt) return fail('Adicional inválido.');
              modsCents += toCents(opt.additional_price);
            }
            const mods = fromCentsLocal(modsCents);
            const notes = [...(line.meat_doneness ? [line.meat_doneness] : []), ...line.modifiers.map((m) => `+ ${m.name}`)];
            items.push({
              id: uuid(),
              order_id: order.id,
              product_id: product.id,
              waiter_id: user.id,
              quantity: line.quantity,
              // Preço sempre do cadastro, nunca do aparelho.
              unit_price: product.price,
              modifiers_unit_price: mods,
              total_item_price: computeItemTotal(line.quantity, product.price, mods),
              meat_doneness: line.meat_doneness,
              notes: notes.length ? notes.join(' · ') : null,
              sector: product.sector,
              // Fica PENDING até a ficha ser resgatada no balcão (não entra no KDS).
              status: 'PENDING',
              is_paid: false,
              origin: 'SMARTPOS',
              created_at: ts,
              prepared_at: null,
              canceled_at: null,
              canceled_by_user_id: null,
              cancel_reason: null,
              weight_gross_grams: null,
              weight_tare_grams: null,
              weight_source: null,
              keg_volume_ml: resolveKegVolume(product.id, line.modifiers, s0.kegTapProducts, s0.modifierOptions),
            });
          }
          const recalculated = applyOrderTotals(order, items, []);
          if (!(recalculated.total_amount > 0)) return fail('Venda sem valor.');
          set((s) => {
            const kegTaps = applyKegSale(s.kegTaps, s.kegTapProducts, items);
            return {
              orders: [...s.orders, recalculated],
              orderItems: [...s.orderItems, ...items],
              kegTaps,
              outbox: [
                ...s.outbox,
                syncEvent('orders', 'INSERT', recalculated),
                ...items.map((i) => syncEvent('order_items', 'INSERT', i)),
                ...changedTaps(s.kegTaps, kegTaps).map((k) => syncEvent('keg_taps', 'UPDATE', k)),
              ],
            };
          });
          return { ok: true, data: recalculated };
        },

        voidCounterSale: (orderId, auth) => voidTechnicalSale(orderId, auth, 'COUNTER'),

        issueEventTickets: (orderId) => {
          const s0 = get();
          const order = s0.orders.find((o) => o.id === orderId);
          if (!order) return fail('Venda não encontrada.');
          const table = s0.tables.find((t) => t.id === order.table_id);
          if (table?.kind !== 'COUNTER') return fail('Fichas só existem na venda de balcão.');
          if (order.status !== 'CLOSED' || toCents(order.remaining_balance) !== 0) return fail('Ficha só é impressa depois da venda paga.');
          const existing = s0.eventTickets.filter((t) => t.order_id === orderId);
          if (existing.length > 0) return { ok: true, data: existing };
          const payment = [...s0.payments].reverse().find((p) => p.order_id === orderId && p.status === 'APPROVED') ?? null;
          const ts = nowISO();
          const used = new Set(s0.eventTickets.map((t) => t.barcode_token));
          const tickets: EventTicket[] = [];
          for (const item of s0.orderItems.filter((i) => i.order_id === orderId && i.status !== 'CANCELED')) {
            const product = s0.products.find((p) => p.id === item.product_id);
            const name = product ? `${product.name}${item.notes ? ` (${item.notes.replace(/\+ /g, '')})` : ''}` : 'Item';
            for (let seq = 1; seq <= item.quantity; seq++) {
              let token = generateTicketToken();
              while (used.has(token)) token = generateTicketToken();
              used.add(token);
              tickets.push({
                id: uuid(),
                tenant_id: s0.tenant.id,
                order_id: orderId,
                order_item_id: item.id,
                payment_id: payment?.id ?? null,
                product_id: item.product_id,
                product_name_snapshot: name.slice(0, 120),
                unit_price: round2(item.unit_price + item.modifiers_unit_price),
                ticket_seq: seq,
                barcode_token: token,
                redeemed: false,
                redeemed_at: null,
                redeemed_by_user_id: null,
                voided_at: null,
                voided_reason: null,
                created_at: ts,
              });
            }
          }
          set((s) => ({
            eventTickets: [...s.eventTickets, ...tickets],
            outbox: [...s.outbox, ...tickets.map((t) => syncEvent('event_tickets', 'INSERT', t))],
          }));
          return { ok: true, data: tickets };
        },

        redeemEventTicket: (rawToken) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const token = normalizeTicketToken(rawToken);
          if (!isValidTicketToken(token)) return fail('Código inválido. Confira os 16 caracteres impressos na ficha.');
          const ticket = get().eventTickets.find((t) => t.barcode_token === token);
          if (!ticket) return fail('Ficha não encontrada neste estabelecimento.');
          if (ticket.voided_at) return fail(`Ficha anulada: ${ticket.voided_reason ?? ''}`.trim());
          if (ticket.redeemed) {
            const who = get().staff.find((u) => u.id === ticket.redeemed_by_user_id)?.name ?? '?';
            const when = new Date(ticket.redeemed_at!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            return fail(`FICHA JÁ USADA às ${when} (${who}). Não entregue.`);
          }
          const ts = nowISO();
          const redeemed: EventTicket = { ...ticket, redeemed: true, redeemed_at: ts, redeemed_by_user_id: user.id };
          set((s) => {
            const eventTickets = s.eventTickets.map((t) => (t.id === ticket.id ? redeemed : t));
            const open = eventTickets.some((t) => t.order_item_id === ticket.order_item_id && !t.redeemed && !t.voided_at);
            const item = s.orderItems.find((i) => i.id === ticket.order_item_id);
            const delivered: OrderItem | null =
              !open && item && item.status !== 'CANCELED' && item.status !== 'DELIVERED'
                ? { ...item, status: 'DELIVERED', prepared_at: item.prepared_at ?? ts }
                : null;
            return {
              eventTickets,
              orderItems: delivered ? s.orderItems.map((i) => (i.id === delivered.id ? delivered : i)) : s.orderItems,
              outbox: [
                ...s.outbox,
                syncEvent('event_tickets', 'UPDATE', redeemed),
                ...(delivered ? [syncEvent('order_items', 'UPDATE', delivered)] : []),
              ],
            };
          });
          return { ok: true, data: redeemed };
        },

        // ---------------------------------------------------------------------
        // Totem de autoatendimento / pedido no caixa
        // ---------------------------------------------------------------------
        createPickupOrder: (input) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          if (!PICKUP_ROLES.includes(user.role)) return fail('Seu perfil não lança pedido com senha.');
          if (input.lines.length === 0) return fail('Escolha pelo menos um item.');
          if (input.fulfillment !== 'DINE_IN' && input.fulfillment !== 'TAKEOUT') return fail('Escolha comer aqui ou para levar.');
          const s0 = get();
          const kiosk = s0.tables.find((t) => t.kind === 'KIOSK');
          if (!kiosk) return fail('Totem não configurado.');
          const ts = nowISO();
          const order: Order = {
            id: uuid(),
            tenant_id: s0.tenant.id,
            table_id: kiosk.id,
            opened_by_user_id: user.id,
            // Nasce aguardando pagamento: só vai para a cozinha depois de pago.
            status: 'PAYING',
            customer_count: 1,
            customer_cpf: null,
            subtotal_items: 0,
            // Autoatendimento e retirada no balcão não cobram os 10% do garçom.
            charge_service_fee: false,
            service_fee_pct: s0.tenant.default_service_fee_pct,
            service_fee_amount: 0,
            discount_amount: 0,
            total_amount: 0,
            paid_amount: 0,
            remaining_balance: 0,
            nfce_status: 'PENDING',
            nfce_key: null,
            opened_at: ts,
            closed_at: null,
            pickup_number: nextPickupNumber(s0.orders.filter((o) => o.table_id === kiosk.id), new Date(ts)),
            pickup_name: sanitizePickupName(input.customerName),
            fulfillment_type: input.fulfillment,
          };
          const items: OrderItem[] = [];
          for (const d of input.lines) {
            const product = s0.products.find((p) => p.id === d.product_id);
            if (!product || !product.active || !product.available) return fail('Produto indisponível.');
            if (product.sold_by_weight) return fail(`${product.name} é pesado no buffet: peça no balcão.`);
            if (!Number.isInteger(d.quantity) || d.quantity < 1 || d.quantity > 99) return fail('Quantidade inválida (1 a 99).');
            if (product.requires_meat_doneness && !d.meat_doneness) return fail(`Escolha o ponto de ${product.name}.`);
            const groups = s0.productModifierGroups
              .filter((l) => l.product_id === product.id)
              .map((l) => s0.modifierGroups.find((g) => g.id === l.group_id))
              .filter((g): g is ModifierGroup => Boolean(g));
            for (const g of groups) {
              const chosen = d.modifiers.filter((m) => m.group_id === g.id).length;
              const min = g.required ? Math.max(1, g.min_selection) : g.min_selection;
              if (chosen < min || chosen > g.max_selection) return fail(`${product.name}: verifique ${g.name}.`);
            }
            let modsCents = 0;
            for (const m of d.modifiers) {
              const opt = s0.modifierOptions.find((o) => o.id === m.option_id && o.group_id === m.group_id);
              if (!opt) return fail('Adicional inválido.');
              if (!groups.some((g) => g.id === opt.group_id)) return fail('Adicional não pertence ao produto.');
              modsCents += toCents(opt.additional_price);
            }
            // Sabor do meio a meio precisa ser outro produto da mesma categoria.
            const halves = d.half_product_ids.map((id) => s0.products.find((p) => p.id === id));
            if (halves.some((h) => !h || h.id === product.id || h.category_id !== product.category_id)) {
              return fail('Sabor do meio a meio inválido.');
            }
            // Preço sempre do cadastro (com regra de horário), nunca do aparelho.
            const base = basePriceFor(product, d.half_product_ids);
            if (!base.ok) return base;
            const unitPrice = base.data;
            const mods = fromCentsLocal(modsCents);
            const halfNote = halves.length ? `1/2 ${product.name} + ${halves.map((h) => `1/2 ${h!.name}`).join(' + ')}` : null;
            const noteParts = [
              ...(halfNote ? [halfNote] : []),
              ...d.modifiers.map((m) => `+ ${m.name}`),
              ...d.quick_tags,
              ...(d.free_notes.trim() ? [d.free_notes.trim().slice(0, 140)] : []),
            ];
            items.push({
              id: uuid(),
              order_id: order.id,
              product_id: product.id,
              waiter_id: user.id,
              quantity: d.quantity,
              unit_price: unitPrice,
              modifiers_unit_price: mods,
              total_item_price: computeItemTotal(d.quantity, unitPrice, mods),
              meat_doneness: d.meat_doneness,
              notes: noteParts.length ? noteParts.join(' · ') : null,
              sector: product.sector,
              // PENDING, mas o KDS só mostra depois que a conta fecha (pago).
              status: 'PENDING',
              is_paid: false,
              origin: user.role === 'KIOSK' ? 'KIOSK' : 'WAITER',
              created_at: ts,
              prepared_at: null,
              canceled_at: null,
              canceled_by_user_id: null,
              cancel_reason: null,
              weight_gross_grams: null,
              weight_tare_grams: null,
              weight_source: null,
              keg_volume_ml: resolveKegVolume(product.id, d.modifiers, s0.kegTapProducts, s0.modifierOptions),
            });
          }
          const recalculated = applyOrderTotals(order, items, []);
          if (!(recalculated.total_amount > 0)) return fail('Pedido sem valor.');
          set((s) => {
            const kegTaps = applyKegSale(s.kegTaps, s.kegTapProducts, items);
            return {
              orders: [...s.orders, recalculated],
              orderItems: [...s.orderItems, ...items],
              kegTaps,
              outbox: [
                ...s.outbox,
                syncEvent('orders', 'INSERT', recalculated),
                ...items.map((i) => syncEvent('order_items', 'INSERT', i)),
                ...changedTaps(s.kegTaps, kegTaps).map((k) => syncEvent('keg_taps', 'UPDATE', k)),
              ],
            };
          });
          return { ok: true, data: recalculated };
        },

        voidPickupOrder: (orderId, auth) => {
          // Cobrança incerta pode ter sido aprovada: cancelar agora sumiria com um pedido pago.
          if (getReviewHold(orderId)) {
            return fail('Há uma cobrança sem confirmação nesta senha. Confira o extrato da maquininha antes de cancelar.');
          }
          return voidTechnicalSale(orderId, auth, 'KIOSK');
        },

        exitKioskMode: (auth) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          if (user.role !== 'KIOSK') return fail('Este aparelho não está em modo totem.');
          if (get().pendingCharges.some((c) => c.user_id === user.id && Date.now() - c.started_at < PENDING_CHARGE_TTL_MS)) {
            return fail('Há uma cobrança em andamento na maquininha. Aguarde a resposta antes de sair.');
          }
          const authRes = authorizeManager(auth, { orderId: null, action: 'KIOSK_EXIT' });
          if (!authRes.ok) return authRes;
          const log = buildAudit({
            order_id: null,
            performed_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
            action_type: 'KIOSK_EXIT',
            amount_impact: 0,
            reason: auth.reason.trim(),
            metadata: { device_user: user.name, manager_name: authRes.data.name },
          });
          const exitLog: AuditLog = { ...log, whatsapp_alert_sent: false };
          set((s) => ({
            currentUserId: null,
            auditLogs: [exitLog, ...s.auditLogs],
            outbox: [...s.outbox, syncEvent('audit_logs', 'INSERT', exitLog)],
          }));
          return { ok: true, data: undefined };
        },

        // ---------------------------------------------------------------------
        // Fase 5 — Barris de chopp
        // ---------------------------------------------------------------------
        registerKegWaste: (tapId, ml, reason) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          if (!BAR_ROLES.includes(user.role)) return fail('Só o bar, o caixa ou a gerência registram desperdício.');
          const tap = get().kegTaps.find((t) => t.id === tapId);
          if (!tap || !tap.active) return fail('Torneira não encontrada.');
          const value = Math.round(ml);
          if (!(value > 0) || value > tap.total_capacity_ml) return fail('Volume inválido.');
          if (reason.trim().length < MIN_REASON_LENGTH) return fail(`Informe o motivo (mínimo ${MIN_REASON_LENGTH} caracteres).`);
          const updated = withRemaining({ ...tap, wasted_foam_ml: tap.wasted_foam_ml + value });
          set((s) => ({
            kegTaps: s.kegTaps.map((t) => (t.id === tapId ? updated : t)),
            outbox: [...s.outbox, syncEvent('keg_taps', 'UPDATE', updated)],
          }));
          return { ok: true, data: updated };
        },

        recordKegReading: (tapId, remainingMl) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          if (!BAR_ROLES.includes(user.role)) return fail('Só o bar, o caixa ou a gerência registram a leitura.');
          const tap = get().kegTaps.find((t) => t.id === tapId);
          if (!tap || !tap.active) return fail('Torneira não encontrada.');
          const value = Math.round(remainingMl);
          if (!Number.isFinite(value) || value < 0 || value > tap.total_capacity_ml) return fail(`Leitura deve estar entre 0 e ${tap.total_capacity_ml / 1000} L.`);
          const updated = withRemaining({ ...tap, measured_remaining_ml: value, measured_at: nowISO() });
          set((s) => ({
            kegTaps: s.kegTaps.map((t) => (t.id === tapId ? updated : t)),
            outbox: [...s.outbox, syncEvent('keg_taps', 'UPDATE', updated)],
          }));
          return { ok: true, data: updated };
        },

        tapNewKeg: (tapId, keg, auth) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const tap = get().kegTaps.find((t) => t.id === tapId);
          if (!tap) return fail('Torneira não encontrada.');
          const beer = keg.beer_name.trim();
          if (beer.length < 3) return fail('Informe o chopp do barril novo.');
          const capacity = Math.round(keg.total_capacity_ml);
          if (!(capacity >= 5000 && capacity <= 100000)) return fail('Capacidade entre 5 L e 100 L.');
          const cost = round2(keg.keg_cost);
          if (!(cost >= 0)) return fail('Custo inválido.');
          const authRes = authorizeManager(auth, { orderId: null, action: 'KEG_CHANGED' });
          if (!authRes.ok) return authRes;
          const ts = nowISO();
          const history: KegHistory = {
            id: uuid(),
            tenant_id: tap.tenant_id,
            tap_id: tap.id,
            tap_number: tap.tap_number,
            beer_name: tap.beer_name,
            total_capacity_ml: tap.total_capacity_ml,
            billed_volume_ml: tap.billed_volume_ml,
            wasted_foam_ml: tap.wasted_foam_ml,
            measured_remaining_ml: tap.measured_remaining_ml,
            keg_cost: tap.keg_cost,
            tapped_at: tap.tapped_at,
            kicked_at: ts,
            kicked_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
          };
          const log = buildAudit({
            order_id: null,
            performed_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
            action_type: 'KEG_CHANGED',
            amount_impact: 0,
            reason: auth.reason.trim(),
            metadata: {
              tap_number: tap.tap_number,
              beer_before: tap.beer_name,
              beer_after: beer,
              billed_ml: tap.billed_volume_ml,
              wasted_ml: tap.wasted_foam_ml,
              measured_remaining_ml: tap.measured_remaining_ml,
              manager_name: authRes.data.name,
            },
          });
          const updated = withRemaining({
            ...tap,
            beer_name: beer,
            total_capacity_ml: capacity,
            keg_cost: cost,
            billed_volume_ml: 0,
            wasted_foam_ml: 0,
            measured_remaining_ml: null,
            measured_at: null,
            active: true,
            tapped_at: ts,
          });
          set((s) => ({
            kegTaps: s.kegTaps.map((t) => (t.id === tapId ? updated : t)),
            kegHistory: [history, ...s.kegHistory],
            auditLogs: [{ ...log, whatsapp_alert_sent: false }, ...s.auditLogs],
            outbox: [
              ...s.outbox,
              syncEvent('keg_history', 'INSERT', history),
              syncEvent('audit_logs', 'INSERT', log),
              syncEvent('keg_taps', 'UPDATE', updated),
            ],
          }));
          return { ok: true, data: updated };
        },

        // ---------------------------------------------------------------------
        // Fase 5 — CRM de cashback
        // ---------------------------------------------------------------------
        earnCashback: (orderId, input) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const order = get().orders.find((o) => o.id === orderId);
          if (!order) return fail('Conta não encontrada.');
          if (order.status !== 'CLOSED') return fail('O cashback é creditado depois da conta paga.');
          if (get().cashbackLedger.some((e) => e.order_id === orderId && e.entry_type === 'EARN')) {
            return fail('Esta conta já gerou cashback.');
          }
          const phone = normalizeWhatsapp(input.phone);
          if (!phone) return fail('WhatsApp inválido. Use DDD + número, ex.: (55) 99999-1234.');
          const cpf = input.cpf ? input.cpf.replace(/\D/g, '') : null;
          if (cpf && cpf.length !== 11) return fail('CPF deve ter 11 dígitos.');
          if (!input.optIn) return fail('Peça a autorização do cliente para receber mensagens no WhatsApp (LGPD).');
          const amount = cashbackEarnAmount(order);
          if (!(amount > 0)) return fail('Conta sem valor para gerar cashback.');
          const now = new Date();
          const ts = now.toISOString();
          const tenantId = get().tenant.id;
          const existing = get().loyaltyCustomers.find((c) => c.phone_whatsapp === phone);
          const validity = cashbackValidity(now);
          const entry: CashbackLedgerEntry = {
            id: uuid(),
            tenant_id: tenantId,
            customer_id: existing?.id ?? uuid(),
            order_id: orderId,
            entry_type: 'EARN',
            amount,
            remaining_amount: amount,
            base_amount: cashbackBase(order),
            pct: CASHBACK_PCT,
            valid_from: validity.valid_from,
            expires_at: validity.expires_at,
            created_by_user_id: user.id,
            created_at: ts,
          };
          const ledger = [...get().cashbackLedger, entry];
          const customer: LoyaltyCustomer = {
            id: entry.customer_id,
            tenant_id: tenantId,
            name: input.name?.trim() || existing?.name || null,
            phone_whatsapp: phone,
            cpf: cpf ?? existing?.cpf ?? null,
            whatsapp_opt_in: true,
            opt_in_at: existing?.whatsapp_opt_in ? existing.opt_in_at : ts,
            cashback_balance: balanceCashback(ledger, entry.customer_id, now),
            total_spent: round2((existing?.total_spent ?? 0) + order.total_amount),
            visits_count: (existing?.visits_count ?? 0) + 1,
            last_visit_at: ts,
            created_at: existing?.created_at ?? ts,
          };
          set((s) => ({
            cashbackLedger: [...s.cashbackLedger, entry],
            loyaltyCustomers: existing ? s.loyaltyCustomers.map((c) => (c.id === customer.id ? customer : c)) : [...s.loyaltyCustomers, customer],
            outbox: [
              ...s.outbox,
              syncEvent('loyalty_customers', existing ? 'UPDATE' : 'INSERT', customer),
              syncEvent('cashback_ledger', 'INSERT', entry),
            ],
          }));
          return { ok: true, data: { customer, entry, balance: customer.cashback_balance } };
        },

        redeemCashback: (orderId, rawPhone) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (activeCharge(orderId)) return fail(CHARGE_LOCK_ERROR);
          const now = new Date();
          if (!isCashbackDay(now)) return fail(`Cashback só pode ser usado de ${CASHBACK_DAYS_LABEL}.`);
          if (get().cashbackLedger.some((e) => e.order_id === orderId && e.entry_type === 'REDEEM')) return fail('Esta conta já usou cashback.');
          const phone = normalizeWhatsapp(rawPhone);
          if (!phone) return fail('WhatsApp inválido.');
          const customer = get().loyaltyCustomers.find((c) => c.phone_whatsapp === phone);
          if (!customer) return fail('Cliente não cadastrado no programa de cashback.');
          const available = availableCashback(get().cashbackLedger, customer.id, now);
          if (!(available > 0)) return fail('Sem cashback liberado para hoje (o crédito vale a partir do dia seguinte à visita).');
          const amount = cashbackUsable(available, order);
          if (!(amount > 0)) return fail('Conta sem saldo para abater.');
          const ts = now.toISOString();
          const entry: CashbackLedgerEntry = {
            id: uuid(),
            tenant_id: order.tenant_id,
            customer_id: customer.id,
            order_id: orderId,
            entry_type: 'REDEEM',
            amount,
            remaining_amount: 0,
            base_amount: null,
            pct: null,
            valid_from: null,
            expires_at: null,
            created_by_user_id: user.id,
            created_at: ts,
          };
          let ledger: CashbackLedgerEntry[];
          try {
            ledger = [...consumeCashbackFifo(get().cashbackLedger, customer.id, amount, now), entry];
          } catch (e) {
            return fail((e as Error).message);
          }
          const updatedCustomer: LoyaltyCustomer = { ...customer, cashback_balance: balanceCashback(ledger, customer.id, now) };
          const log: AuditLog = {
            ...buildAudit({
              order_id: orderId,
              performed_by_user_id: user.id,
              authorized_by_manager_id: null,
              action_type: 'CASHBACK_REDEEMED',
              amount_impact: -amount,
              reason: 'Cashback de fidelidade resgatado',
              metadata: { table: tableLabel(order.table_id), customer_id: customer.id, phone, amount },
            }),
            whatsapp_alert_sent: false,
          };
          set((s) => {
            const current = s.orders.find((o) => o.id === orderId)!;
            const recalculated = applyOrderTotals({ ...current, discount_amount: round2(current.discount_amount + amount) }, s.orderItems, s.payments);
            const changedLedger = ledger.filter((e, i) => e !== s.cashbackLedger[i] && e.entry_type === 'EARN');
            const patch = commitAdjustment(s, recalculated, s.orderItems, [], log);
            return {
              ...patch,
              auditLogs: patch.auditLogs,
              cashbackLedger: ledger,
              loyaltyCustomers: s.loyaltyCustomers.map((c) => (c.id === customer.id ? updatedCustomer : c)),
              outbox: [
                ...patch.outbox!,
                ...changedLedger.map((e) => syncEvent('cashback_ledger', 'UPDATE', e)),
                syncEvent('cashback_ledger', 'INSERT', entry),
                syncEvent('loyalty_customers', 'UPDATE', updatedCustomer),
              ],
            };
          });
          return { ok: true, data: { amount, customer: updatedCustomer } };
        },

        setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
        setHalfAndHalfPricing: (rule) => set({ halfAndHalfPricing: rule }),

        // ---------------------------------------------------------------------
        // Etapa 0 — cadastros
        // ---------------------------------------------------------------------
        saveCategory: (draft) => {
          const perm = requirePermission('MENU_MANAGE');
          if (!perm.ok) return perm;
          const state = get();
          const existing = draft.id ? state.categories.find((c) => c.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Categoria não encontrada.');
          const row: Category = {
            id: existing?.id ?? uuid(),
            tenant_id: state.tenant.id,
            name: draft.name.trim(),
            sort_order: Math.floor(draft.sort_order),
            icon_name: draft.icon_name?.trim() || null,
            active: draft.active,
          };
          const check = validateCategory(row, state.categories);
          if (!check.ok) return check;
          if (existing && existing.active && !row.active) {
            const live = state.products.filter((p) => p.category_id === row.id && p.active);
            if (live.length > 0) return fail(`Desative ou mova os ${live.length} produto(s) de ${existing.name} antes.`);
          }
          set((s) => ({
            categories: existing ? s.categories.map((c) => (c.id === row.id ? row : c)) : [...s.categories, row],
            outbox: [...s.outbox, syncEvent('categories', existing ? 'UPDATE' : 'INSERT', row)],
          }));
          return { ok: true, data: row };
        },

        saveProduct: (draft) => {
          const perm = requirePermission('MENU_MANAGE');
          if (!perm.ok) return perm;
          const user = perm.data;
          const state = get();
          const existing = draft.id ? state.products.find((p) => p.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Produto não encontrado.');
          const row: Product = {
            id: existing?.id ?? uuid(),
            tenant_id: state.tenant.id,
            category_id: draft.category_id,
            code: draft.code.trim(),
            name: draft.name.trim(),
            description: draft.description?.trim() || null,
            price: round2(draft.price),
            sold_by_weight: draft.sold_by_weight ?? existing?.sold_by_weight ?? false,
            tare_weight_grams: draft.tare_weight_grams ?? existing?.tare_weight_grams ?? 0,
            cost_price: draft.cost_price ?? existing?.cost_price ?? 0,
            sector: draft.sector,
            available: draft.available,
            active: draft.active,
            requires_meat_doneness: draft.requires_meat_doneness,
            allows_half_and_half: draft.allows_half_and_half,
            ncm: draft.ncm.trim(),
            cfop: draft.cfop.trim(),
            csosn_cst: draft.csosn_cst.trim(),
            unit: draft.unit.trim().toUpperCase(),
            created_at: existing?.created_at ?? nowISO(),
          };
          const check = validateProduct(row, state.products, state.categories);
          if (!check.ok) return check;
          // Mudança de preço não mexe em item já lançado (OrderItem guarda unit_price) e fica auditada.
          const priceChanged = existing && toCents(existing.price) !== toCents(row.price);
          const log = priceChanged
            ? catalogAudit({
                performed_by_user_id: user.id,
                authorized_by_manager_id: null,
                action_type: 'PRODUCT_PRICE_CHANGED',
                reason: `Preço de ${row.code} ${row.name} alterado no cadastro.`,
                metadata: { product_id: row.id, product_code: row.code, price_before: existing.price, price_after: row.price, user_name: user.name },
              })
            : null;
          set((s) => ({
            products: existing ? s.products.map((p) => (p.id === row.id ? row : p)) : [...s.products, row],
            auditLogs: log ? [log, ...s.auditLogs] : s.auditLogs,
            outbox: [
              ...s.outbox,
              syncEvent('products', existing ? 'UPDATE' : 'INSERT', row),
              ...(log ? [syncEvent('audit_logs', 'INSERT', log)] : []),
            ],
          }));
          return { ok: true, data: row };
        },

        setProductAvailable: (productId, available) => {
          const perm = requirePermission('MENU_AVAILABILITY');
          if (!perm.ok) return perm;
          const product = get().products.find((p) => p.id === productId);
          if (!product || !product.active) return fail('Produto não encontrado.');
          if (product.available === available) return { ok: true, data: product };
          const row: Product = { ...product, available };
          set((s) => ({
            products: s.products.map((p) => (p.id === productId ? row : p)),
            outbox: [...s.outbox, syncEvent('products', 'UPDATE', row)],
          }));
          return { ok: true, data: row };
        },

        saveModifierGroup: (draft) => {
          const perm = requirePermission('MENU_MANAGE');
          if (!perm.ok) return perm;
          const state = get();
          const existing = draft.id ? state.modifierGroups.find((g) => g.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Grupo não encontrado.');
          const row: ModifierGroup = {
            id: existing?.id ?? uuid(),
            tenant_id: state.tenant.id,
            name: draft.name.trim(),
            min_selection: draft.min_selection,
            max_selection: draft.max_selection,
            required: draft.required,
          };
          const check = validateModifierGroup(row);
          if (!check.ok) return check;
          const optionCount = state.modifierOptions.filter((o) => o.group_id === row.id).length;
          if (existing && optionCount > 0 && Math.max(1, row.min_selection) > optionCount && row.required) {
            return fail(`O grupo tem ${optionCount} opção(ões); o mínimo não pode ser maior.`);
          }
          set((s) => ({
            modifierGroups: existing ? s.modifierGroups.map((g) => (g.id === row.id ? row : g)) : [...s.modifierGroups, row],
            outbox: [...s.outbox, syncEvent('modifier_groups', existing ? 'UPDATE' : 'INSERT', row)],
          }));
          return { ok: true, data: row };
        },

        saveModifierOption: (draft) => {
          const perm = requirePermission('MENU_MANAGE');
          if (!perm.ok) return perm;
          const state = get();
          const existing = draft.id ? state.modifierOptions.find((o) => o.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Adicional não encontrado.');
          const row: ModifierOption = {
            id: existing?.id ?? uuid(),
            group_id: existing?.group_id ?? draft.group_id,
            name: draft.name.trim(),
            additional_price: round2(draft.additional_price),
            volume_ml: existing?.volume_ml ?? null,
          };
          const check = validateModifierOption(row, state.modifierGroups, state.modifierOptions);
          if (!check.ok) return check;
          set((s) => ({
            modifierOptions: existing ? s.modifierOptions.map((o) => (o.id === row.id ? row : o)) : [...s.modifierOptions, row],
            outbox: [...s.outbox, syncEvent('modifier_options', existing ? 'UPDATE' : 'INSERT', row)],
          }));
          return { ok: true, data: row };
        },

        removeModifierOption: (optionId) => {
          const perm = requirePermission('MENU_MANAGE');
          if (!perm.ok) return perm;
          const state = get();
          const option = state.modifierOptions.find((o) => o.id === optionId);
          if (!option) return fail('Adicional não encontrado.');
          const group = state.modifierGroups.find((g) => g.id === option.group_id);
          const remaining = state.modifierOptions.filter((o) => o.group_id === option.group_id && o.id !== optionId).length;
          if (group?.required && remaining < Math.max(1, group.min_selection)) {
            return fail(`${group.name} é obrigatório e ficaria sem opções suficientes.`);
          }
          // Item já lançado guarda o nome do adicional no texto; apagar a opção não muda conta nenhuma.
          set((s) => ({
            modifierOptions: s.modifierOptions.filter((o) => o.id !== optionId),
            outbox: [...s.outbox, { ...syncEvent('modifier_options', 'DELETE', option) }],
          }));
          return { ok: true, data: undefined };
        },

        setProductModifierGroups: (productId, groupIds) => {
          const perm = requirePermission('MENU_MANAGE');
          if (!perm.ok) return perm;
          const state = get();
          if (!state.products.some((p) => p.id === productId)) return fail('Produto não encontrado.');
          const unique = Array.from(new Set(groupIds));
          if (unique.some((gid) => !state.modifierGroups.some((g) => g.id === gid))) return fail('Grupo de adicionais não encontrado.');
          const before = state.productModifierGroups.filter((l) => l.product_id === productId);
          const after: ProductModifierGroup[] = unique.map((group_id, i) => ({ product_id: productId, group_id, sort_order: i + 1 }));
          const removed = before.filter((b) => !after.some((a) => a.group_id === b.group_id));
          const upserted = after.filter((a) => {
            const b = before.find((x) => x.group_id === a.group_id);
            return !b || b.sort_order !== a.sort_order;
          });
          set((s) => ({
            productModifierGroups: [...s.productModifierGroups.filter((l) => l.product_id !== productId), ...after],
            outbox: [...s.outbox, ...removed.map((l) => linkEvent('DELETE', l)), ...upserted.map((l) => linkEvent('INSERT', l))],
          }));
          return { ok: true, data: undefined };
        },

        savePriceSchedule: (draft) => {
          const perm = requirePermission('MENU_MANAGE');
          if (!perm.ok) return perm;
          const state = get();
          const existing = draft.id ? state.priceSchedules.find((x) => x.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Regra de preço não encontrada.');
          const row: PriceSchedule = {
            id: existing?.id ?? uuid(),
            tenant_id: state.tenant.id,
            product_id: existing?.product_id ?? draft.product_id,
            name: draft.name.trim(),
            weekdays: Array.from(new Set(draft.weekdays)).sort((a, b) => a - b),
            start_time: draft.start_time,
            end_time: draft.end_time,
            price: round2(draft.price),
            active: draft.active,
            created_at: existing?.created_at ?? nowISO(),
          };
          const check = validatePriceSchedule(row, state.priceSchedules, state.products);
          if (!check.ok) return check;
          set((s) => ({
            priceSchedules: existing ? s.priceSchedules.map((x) => (x.id === row.id ? row : x)) : [...s.priceSchedules, row],
            outbox: [...s.outbox, syncEvent('price_schedules', existing ? 'UPDATE' : 'INSERT', row)],
          }));
          return { ok: true, data: row };
        },

        saveTable: (draft) => {
          const perm = requirePermission('TABLES_MANAGE');
          if (!perm.ok) return perm;
          const state = get();
          const existing = draft.id ? state.tables.find((t) => t.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Mesa não encontrada.');
          if (existing?.kind === 'COUNTER') return fail('O balcão da Ficha Rápida é técnico e não é editado.');
          const candidate: TableDraft = {
            id: existing?.id ?? uuid(),
            number: draft.number,
            label: draft.label.trim(),
            area: draft.area.trim(),
            capacity: draft.capacity,
            active: draft.active,
          };
          const check = validateTable(candidate, state.tables);
          if (!check.ok) return check;
          const row: DiningTable = existing
            ? { ...existing, ...candidate, updated_at: nowISO() }
            : {
                ...candidate,
                tenant_id: state.tenant.id,
                status: 'FREE',
                qr_code_token: `tchefood-${uuid().replace(/-/g, '')}`,
                current_order_id: null,
                updated_at: nowISO(),
                kind: 'TABLE',
              };
          set((s) => ({
            tables: existing ? s.tables.map((t) => (t.id === row.id ? row : t)) : [...s.tables, row],
            outbox: [...s.outbox, syncEvent('dining_tables', existing ? 'UPDATE' : 'INSERT', row)],
          }));
          return { ok: true, data: row };
        },

        saveStaff: (draft, auth) => {
          const perm = requirePermission('STAFF_MANAGE');
          if (!perm.ok) return perm;
          const actor = perm.data;
          const state = get();
          const existing = draft.id ? state.staff.find((u) => u.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Pessoa não encontrada.');
          if (existing && isQrSelfService(existing)) return fail('O usuário do cardápio QR é técnico e não é editado.');
          const candidate: StaffDraft = {
            id: existing?.id ?? uuid(),
            name: draft.name.trim(),
            role: draft.role,
            pin_code: draft.pin_code.trim(),
            active: draft.active,
          };
          const check = validateStaff(candidate, state.staff, actor);
          if (!check.ok) return check;

          // Troca de PIN de outra pessoa, de perfil ou de acesso pede PIN de gerente e motivo.
          const changes: AuditActionType[] = [];
          if (existing) {
            if (existing.pin_code !== candidate.pin_code) changes.push('STAFF_PIN_CHANGED');
            if (existing.role !== candidate.role) changes.push('STAFF_ROLE_CHANGED');
            if (existing.active && !candidate.active) changes.push('STAFF_DEACTIVATED');
            if (!existing.active && candidate.active) changes.push('STAFF_REACTIVATED');
          }
          const ownPinOnly = existing?.id === actor.id && changes.length === 1 && changes[0] === 'STAFF_PIN_CHANGED';
          let manager: StaffUser | null = null;
          let reason = existing ? 'Cadastro atualizado.' : `Cadastro de ${candidate.name} como ${candidate.role}.`;
          if (changes.length > 0 && !ownPinOnly) {
            if (!auth) return fail('Informe o PIN de gerente e o motivo para esta alteração.');
            const authRes = authorizeManager(auth, { orderId: null, action: changes[0]! });
            if (!authRes.ok) return authRes;
            manager = authRes.data;
            reason = auth.reason.trim();
          } else if (ownPinOnly) {
            reason = 'Troca do próprio PIN.';
          }

          const row: StaffUser = existing
            ? { ...existing, ...candidate }
            : { ...candidate, tenant_id: state.tenant.id, created_at: nowISO() };
          const actions: AuditActionType[] = existing ? changes : ['STAFF_CREATED'];
          const logs = actions.map((action_type) =>
            catalogAudit({
              performed_by_user_id: actor.id,
              authorized_by_manager_id: manager?.id ?? null,
              action_type,
              reason,
              // O PIN nunca vai para o log, nem o antigo nem o novo.
              metadata: {
                staff_id: row.id,
                staff_name: row.name,
                role_before: existing?.role ?? null,
                role_after: row.role,
                active_after: row.active,
                actor_name: actor.name,
                manager_name: manager?.name ?? null,
              },
            }),
          );
          set((s) => ({
            staff: existing ? s.staff.map((u) => (u.id === row.id ? row : u)) : [...s.staff, row],
            auditLogs: [...logs, ...s.auditLogs],
            outbox: [
              ...s.outbox,
              syncEvent('staff_users', existing ? 'UPDATE' : 'INSERT', row),
              ...logs.map((l) => syncEvent('audit_logs', 'INSERT', l)),
            ],
          }));
          return { ok: true, data: row };
        },

        setRolePermission: (role, permission, allowed, auth) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (user.role !== 'OWNER') return fail('Só o proprietário muda permissões.');
          if (role === 'OWNER') return fail('O proprietário sempre tem todas as permissões.');
          const authRes = authorizeManager(auth, { orderId: null, action: 'PERMISSION_CHANGED' });
          if (!authRes.ok) return authRes;
          const state = get();
          const before = can(role, permission, state.rolePermissions);
          const row: RolePermission = { tenant_id: state.tenant.id, role, permission, allowed, updated_at: nowISO() };
          const log = catalogAudit({
            performed_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
            action_type: 'PERMISSION_CHANGED',
            reason: auth.reason.trim(),
            metadata: { role, permission, allowed_before: before, allowed_after: allowed },
          });
          set((s) => ({
            rolePermissions: [...s.rolePermissions.filter((r) => !(r.role === role && r.permission === permission)), row],
            auditLogs: [log, ...s.auditLogs],
            outbox: [...s.outbox, permissionEvent(row), syncEvent('audit_logs', 'INSERT', log)],
          }));
          return { ok: true, data: row };
        },

        updateTenant: (draft) => {
          const perm = requirePermission('STORE_SETTINGS');
          if (!perm.ok) return perm;
          const check = validateTenantDraft(draft);
          if (!check.ok) return check;
          const row: Tenant = { ...get().tenant, ...cleanTenantDraft(draft) };
          set((s) => ({ tenant: row, outbox: [...s.outbox, syncEvent('tenants', 'UPDATE', row)] }));
          return { ok: true, data: row };
        },

        startNewStore: (input, auth) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (user.role !== 'OWNER') return fail('Só o proprietário inicia uma loja nova neste aparelho.');
          const state = get();
          if (state.orders.some((o) => o.status === 'OPEN' || o.status === 'PAYING')) {
            return fail('Há contas abertas. Feche todas antes de iniciar uma loja nova.');
          }
          if (state.cloud && state.outbox.length > 0) {
            return fail(`Ainda há ${state.outbox.length} evento(s) sem enviar para a nuvem. Sincronize antes.`);
          }
          const check = validateTenantDraft(input.tenant);
          if (!check.ok) return check;
          const authRes = authorizeManager(auth, { orderId: null, action: 'STORE_RESET' });
          if (!authRes.ok) return authRes;
          if (authRes.data.role !== 'OWNER') return fail('Use o PIN do proprietário para iniciar uma loja nova.');

          const linkedCloud = input.cloud ?? state.cloud;
          const tenantId = linkedCloud?.tenant_id ?? uuid();
          const ts = nowISO();
          const tenant: Tenant = {
            ...cleanTenantDraft(input.tenant),
            id: tenantId,
            default_acquirer: state.tenant.default_acquirer,
            default_mode: state.tenant.default_mode,
            focus_nfe_token: null,
            csc_id: null,
            csc_token: null,
            created_at: ts,
          };
          const owner: StaffUser = {
            id: uuid(),
            tenant_id: tenantId,
            name: input.owner_name.trim(),
            role: 'OWNER',
            pin_code: input.owner_pin.trim(),
            active: true,
            created_at: ts,
          };
          const ownerCheck = validateStaff(owner, [], { ...owner });
          if (!ownerCheck.ok) return ownerCheck;
          const terminals: PosTerminal[] = state.terminals.map((t) => ({ ...t, id: uuid(), tenant_id: tenantId }));
          // Cada loja tem o seu usuário técnico do Cardápio QR (id próprio, mesmo PIN não digitável).
          const qrUser: StaffUser = {
            id: uuid(),
            tenant_id: tenantId,
            name: 'Autoatendimento QR Code',
            role: 'WAITER',
            pin_code: QR_SELF_SERVICE_PIN,
            active: true,
            created_at: ts,
          };
          const log: AuditLog = {
            id: uuid(),
            tenant_id: tenantId,
            order_id: null,
            performed_by_user_id: owner.id,
            authorized_by_manager_id: owner.id,
            action_type: 'STORE_RESET',
            amount_impact: 0,
            reason: auth.reason.trim(),
            whatsapp_alert_sent: false,
            metadata: { previous_tenant_id: state.tenant.id, previous_tenant_name: state.tenant.name },
            created_at: ts,
          };
          // Balcão da Ficha Rápida (Fase 5) da loja nova.
          const counter = counterTable(tenantId);
          const kiosk = kioskTable(tenantId);
          set({
            tenant,
            staff: [owner, qrUser],
            // As maquininhas deste aparelho continuam cadastradas (sem elas o modo TEF POS
            // Sem Fio não cobraria cartão), com id novo e enviadas à nuvem antes de qualquer pagamento.
            terminals,
            categories: [],
            products: [],
            modifierGroups: [],
            modifierOptions: [],
            productModifierGroups: [],
            tables: [counter, kiosk],
            orders: [],
            orderItems: [],
            payments: [],
            auditLogs: [log],
            printers: [],
            priceSchedules: [],
            rolePermissions: [],
            kegTaps: [],
            kegTapProducts: [],
            kegHistory: [],
            eventTickets: [],
            loyaltyCustomers: [],
            cashbackLedger: [],
            tray: [],
            outbox: [
              syncEvent('tenants', 'UPDATE', tenant),
              syncEvent('staff_users', 'INSERT', owner),
              syncEvent('staff_users', 'INSERT', qrUser),
              ...terminals.map((t) => syncEvent('pos_terminals', 'INSERT', t)),
              syncEvent('dining_tables', 'INSERT', counter),
              syncEvent('dining_tables', 'INSERT', kiosk),
              syncEvent('audit_logs', 'INSERT', log),
            ],
            currentUserId: owner.id,
            cloud: linkedCloud ?? null,
            managerPinFailures: 0,
            managerPinLockedUntil: null,
            nfceSeq: 1,
            syncStatus: { last_success_at: null, last_error: null, last_error_at: null, blocked_event_id: null },
          });
          return { ok: true, data: tenant };
        },

        // ---------------------------------------------------------------------
        // Etapa 0 — nuvem
        // ---------------------------------------------------------------------
        setCloudSession: (session) => {
          if (session && session.tenant_id !== get().tenant.id) {
            return fail('Esta conta da nuvem é de outra loja. Use a conta desta loja ou inicie uma loja nova.');
          }
          set({ cloud: session });
          return { ok: true, data: undefined };
        },

        ackSyncedEvents: (eventIds) => {
          if (eventIds.length === 0) return;
          const done = new Set(eventIds);
          set((s) => ({
            outbox: s.outbox.filter((e) => !done.has(e.id)),
            syncStatus: { last_success_at: nowISO(), last_error: null, last_error_at: null, blocked_event_id: null },
          }));
        },

        setSyncError: (message, blockedEventId) =>
          set((s) => ({
            syncStatus: {
              ...s.syncStatus,
              last_error: message,
              last_error_at: message ? nowISO() : null,
              blocked_event_id: blockedEventId,
            },
          })),

        resetDemo: () => set({ ...initialData(), ...initialDevice(), hydrated: true }),
      };
    },
    {
      name: 'tchefood-state-v1',
      // v2 = Etapa 0 (cadastros e nuvem); v3 = Fase 5 (barril, fichas, balança, cashback);
      // v4 = totem / pedido com senha.
      version: 4,
      migrate: (persisted, version) => migratePersisted(persisted, version) as TcheState,
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => {
        // Persistimos dados + estado do aparelho; funções e flag de hidratação ficam de fora.
        const { hydrated: _h, ...rest } = s;
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (typeof v !== 'function') data[k] = v;
        return data as Partial<TcheState>;
      },
      onRehydrateStorage: () => () => {
        // Com o fallback síncrono (localStorage), este callback roda ainda dentro de
        // create(), antes de useTcheStore existir; adiamos para depois da atribuição.
        queueMicrotask(() => useTcheStore.setState({ hydrated: true }));
      },
    },
  ),
);

export function migratePersisted(persisted: unknown, version: number): unknown {
  if (!persisted || typeof persisted !== 'object') return persisted;
  const st = { ...(persisted as Record<string, unknown>) };
  if (version < 2) {
    if (Array.isArray(st.products)) st.products = (st.products as Product[]).map((p) => ({ ...p, active: p.active ?? true }));
    if (Array.isArray(st.tables)) st.tables = (st.tables as DiningTable[]).map((t) => ({ ...t, active: t.active ?? true }));
    st.priceSchedules = Array.isArray(st.priceSchedules) ? st.priceSchedules : [];
    st.rolePermissions = Array.isArray(st.rolePermissions) ? st.rolePermissions : [];
    st.cloud = st.cloud ?? null;
    st.syncStatus = st.syncStatus ?? { last_success_at: null, last_error: null, last_error_at: null, blocked_event_id: null };
  }
  if (version < 3) {
    // Fase 5: colunas novas com valor neutro (nada da loja é apagado) e a mesa técnica do balcão.
    if (Array.isArray(st.products)) {
      st.products = (st.products as Product[]).map((p) => ({ ...p, sold_by_weight: p.sold_by_weight ?? false, tare_weight_grams: p.tare_weight_grams ?? 0, cost_price: p.cost_price ?? 0 }));
    }
    if (Array.isArray(st.modifierOptions)) {
      st.modifierOptions = (st.modifierOptions as ModifierOption[]).map((o) => ({ ...o, volume_ml: o.volume_ml ?? null }));
    }
    if (Array.isArray(st.orderItems)) {
      st.orderItems = (st.orderItems as OrderItem[]).map((i) => ({
        ...i,
        weight_gross_grams: i.weight_gross_grams ?? null,
        weight_tare_grams: i.weight_tare_grams ?? null,
        weight_source: i.weight_source ?? null,
        keg_volume_ml: i.keg_volume_ml ?? null,
      }));
    }
    if (Array.isArray(st.tables)) {
      const tables = (st.tables as DiningTable[]).map((t) => ({ ...t, kind: t.kind ?? 'TABLE' }));
      const tenantId = (st.tenant as Tenant | undefined)?.id ?? tables[0]?.tenant_id;
      if (tenantId && !tables.some((t) => t.kind === 'COUNTER')) tables.push(counterTable(tenantId));
      st.tables = tables;
    }
    for (const key of ['kegTaps', 'kegTapProducts', 'kegHistory', 'eventTickets', 'loyaltyCustomers', 'cashbackLedger'] as const) {
      st[key] = Array.isArray(st[key]) ? st[key] : [];
    }
  }
  if (version < 4) {
    // Totem: comandas ganham os campos de senha (null) e a loja ganha a mesa técnica KIOSK.
    return migrateToKiosk(st as Partial<TcheState>);
  }
  return st;
}

/** Mesa técnica da venda de balcão (Ficha Rápida) de uma loja. */
export function counterTable(tenantId: UUID): DiningTable {
  return {
    id: uuid(),
    tenant_id: tenantId,
    number: 900,
    label: 'Balcão / Eventos',
    area: 'Balcão & Eventos',
    capacity: 1,
    status: 'FREE',
    qr_code_token: null,
    current_order_id: null,
    active: true,
    updated_at: nowISO(),
    kind: 'COUNTER',
  };
}

/** Permissão do usuário logado (padrão + exceções da loja). */
export function selectCan(s: TcheState, permission: Permission): boolean {
  const user = s.staff.find((u) => u.id === s.currentUserId && u.active);
  return can(user?.role, permission, s.rolePermissions);
}

// ---------------------------------------------------------------------------
// Seletores puros (reutilizados pelas telas)
// ---------------------------------------------------------------------------
export function selectCurrentUser(s: TcheState): StaffUser | null {
  return s.staff.find((u) => u.id === s.currentUserId) ?? null;
}

export function isManagerRole(role: StaffUser['role'] | undefined): boolean {
  return role === 'MANAGER' || role === 'OWNER';
}
