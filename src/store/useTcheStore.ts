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
  ModifierGroup,
  ModifierOption,
  Order,
  OrderItem,
  Payment,
  PosTerminal,
  Product,
  ProductModifierGroup,
  StaffUser,
  SyncEvent,
  Tenant,
  TrayItem,
  UUID,
} from '../types';
import { applyOrderTotals, computeItemTotal, halfAndHalfPrice, round2, round3, toCents } from '../lib/money';
import { nowISO, uuid } from '../lib/ids';
import { idbStorage } from '../lib/idbStorage';
import { createSeedData, QR_SELF_SERVICE_USER_ID } from '../data/seed';
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
}

export type TcheState = DataSlice & DeviceSlice & Actions;

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
    pendingCharges: [],
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
/** Perfis que operam o bar (sangria, leitura do barril). */
const BAR_ROLES: ReadonlyArray<StaffUser['role']> = ['KITCHEN', 'CASHIER', 'MANAGER', 'OWNER'];

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
          tray: settled.closed ? s.tray.filter((t) => t.order_id !== recalculated.id) : s.tray,
          auditLogs: [log, ...s.auditLogs],
          outbox: [
            ...s.outbox,
            ...allChanged.map((i) => syncEvent('order_items', 'UPDATE', i)),
            syncEvent('orders', 'UPDATE', settled.order),
            syncEvent('audit_logs', 'INSERT', log),
            ...(settled.table ? [syncEvent('dining_tables', 'UPDATE', settled.table)] : []),
          ],
        };
      };

      /**
       * Resolve o meio a meio a partir do cadastro (nunca confia no preço do aparelho):
       * valida os sabores e aplica a regra de preço configurada.
       */
      const resolveHalfAndHalf = (product: Product, halfIds: readonly UUID[]): ActionResult<{ unitPrice: number; note: string | null }> => {
        if (halfIds.length === 0) return { ok: true, data: { unitPrice: product.price, note: null } };
        if (!product.allows_half_and_half) return fail(`${product.name} não aceita meio a meio.`);
        const halves: Product[] = [];
        for (const id of halfIds) {
          const h = get().products.find((p) => p.id === id);
          if (!h || !h.available || !h.allows_half_and_half || h.id === product.id || h.category_id !== product.category_id) {
            return fail('Sabor do meio a meio inválido.');
          }
          halves.push(h);
        }
        const unitPrice = halfAndHalfPrice([product.price, ...halves.map((h) => h.price)], get().halfAndHalfPricing);
        const note = `1/2 ${product.name} + ${halves.map((h) => `1/2 ${h.name}`).join(' + ')}`;
        return { ok: true, data: { unitPrice, note } };
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
          if (!product) return fail('Produto não encontrado.');
          if (!product.available) return fail(`${product.name} está em falta.`);
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
            unit_price: round2(draft.unit_price),
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
              outbox: [...s.outbox, syncEvent('orders', 'UPDATE', recalculated), syncEvent('audit_logs', 'INSERT', log)],
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
          const qrUser = s0.staff.find((u) => u.id === QR_SELF_SERVICE_USER_ID);
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
            };
          }
          const products = s0.products;
          const newItems: OrderItem[] = [];
          for (const d of drafts) {
            const product = products.find((p) => p.id === d.product_id);
            if (!product || !product.available) return fail('Produto indisponível.');
            if (product.sold_by_weight) return fail(`${product.name} é pesado no buffet. Chame o garçom.`);
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
            const half = resolveHalfAndHalf(product, d.half_product_ids);
            if (!half.ok) return half;
            const unitPrice = half.data.unitPrice;
            const noteParts = [
              ...(half.data.note ? [half.data.note] : []),
              ...d.modifiers.map((m) => `+ ${m.name}`),
              ...d.quick_tags,
              ...(d.free_notes.trim() ? [d.free_notes.trim()] : []),
            ];
            newItems.push({
              id: uuid(),
              order_id: order.id,
              product_id: product.id,
              waiter_id: qrUser.id,
              quantity: qty,
              unit_price: unitPrice,
              modifiers_unit_price: fromCentsLocal(modsCents),
              total_item_price: computeItemTotal(qty, unitPrice, fromCentsLocal(modsCents)),
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

        voidCounterSale: (orderId, auth) => {
          const res = findEditableOrder(orderId);
          if (!res.ok) return res;
          const order = res.data;
          const table = get().tables.find((t) => t.id === order.table_id);
          if (table?.kind !== 'COUNTER') return fail('Só vendas de balcão podem ser desfeitas aqui.');
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
                counter_sale_voided: true,
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
        },

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

        resetDemo: () => set({ ...initialData(), ...initialDevice(), hydrated: true }),
      };
    },
    {
      name: 'tchefood-state-v1',
      // v2 = Fase 5 (barril, fichas, balança, cashback). Os dados da demonstração
      // são recriados a partir do seed porque produtos, mesas e itens ganharam
      // colunas obrigatórias; impressoras e preferências do aparelho são mantidas.
      version: 2,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<TcheState>;
        if (version >= 2) return p as TcheState;
        return {
          ...p,
          ...createSeedData(),
          printers: p.printers ?? createSeedData().printers,
          tray: [],
          outbox: [],
          pendingCharges: [],
          currentUserId: null,
        } as TcheState;
      },
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => {
        // Persistimos dados + estado do aparelho; funções e flag de hidratação ficam de fora.
        const { hydrated: _h, ...rest } = s;
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (typeof v !== 'function') data[k] = v;
        return data as Partial<TcheState>;
      },
      onRehydrateStorage: () => () => {
        useTcheStore.setState({ hydrated: true });
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Seletores puros (reutilizados pelas telas)
// ---------------------------------------------------------------------------
export function selectCurrentUser(s: TcheState): StaffUser | null {
  return s.staff.find((u) => u.id === s.currentUserId) ?? null;
}

export function isManagerRole(role: StaffUser['role'] | undefined): boolean {
  return role === 'MANAGER' || role === 'OWNER';
}
