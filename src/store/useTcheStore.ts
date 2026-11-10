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
  CashMovement,
  CashSession,
  Courier,
  CourierSettlement,
  Review,
  ReviewSource,
  DeliveryZone,
  OwnDelivery,
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
  PurchaseInvoice,
  PurchaseInvoiceItem,
  RolePermission,
  StaffUser,
  StockMovement,
  Supplier,
  SupplierProductLink,
  SyncEvent,
  Tenant,
  TrayItem,
  UUID,
  RejectedSyncEvent,
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
  validateCardRange,
  type PriceScheduleDraft,
  type ProductDraft,
  type StaffDraft,
  type TableDraft,
} from '../lib/catalog';
import { can, PERMISSION_LABEL } from '../lib/permissions';
import { nowISO, stableUuid, uuid } from '../lib/ids';
import { MAX_REVIEW_COMMENT } from '../lib/reviews';
import { idbStorage } from '../lib/idbStorage';
import { createSeedData, DEMO_TENANT_ID, isQrSelfService, KIOSK_TABLE_ID, QR_SELF_SERVICE_PIN, SEED_STAFF, SEED_TENANT } from '../data/seed';
import { nextPickupNumber, sanitizePickupName } from '../lib/kiosk';
import { clearReviewHold, getReviewHold } from '../lib/payments/reviewHolds';
import { checkReceiptProof } from '../lib/payments/terminalGuard';
import { ACQUIRER_CNPJ } from '../lib/payments/drivers';
import { buildAccessKey } from '../lib/nfce';
import type { PrinterConfig } from '../services/printer/escposBuilder';
import { NfeImportError, parsePurchaseNfeXml } from '../lib/nfeImport';
import { nextPurchaseProductCode, planPurchaseImport, type PurchaseImportPlan, type PurchaseItemDecision } from '../lib/purchaseImport';
import { comboChildrenOf, comboComponents, comboNeedsDoneness, expandComboItem } from '../lib/combos';
import { adaptTable, MERGE, mergeRows, mergeStaffWithoutPins, mergeStaffWithPins, pendingRowKeys, type CloudSnapshot } from '../lib/sync/cloudPull';
import { applyKegCancel, applyKegSale, resolveKegVolume, withRemaining } from '../lib/kegs';
import { generateTicketToken, isValidTicketToken, normalizeTicketToken } from '../lib/eventTickets';
import { computeNetWeight } from '../lib/scale';
import { cashSummary, closingDifference, validCashAmount } from '../lib/cashRegister';
import { normalizePhone, validateCourier, validateDeliveryInput, validateZone, type DeliveryAddressInput } from '../lib/ownDelivery';
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

/** Bandeiras que o gerente pode marcar ao registrar o comprovante (null = não informada). */
export const RECEIPT_CARD_BRANDS: ReadonlyArray<string> = ['VISA', 'MASTERCARD', 'ELO', 'AMEX', 'HIPERCARD'];

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

/**
 * Cobrança incerta (MANUAL_REVIEW) que o comprovante da maquininha mostra
 * aprovada. NSU e autorização são digitados do papel, nunca gerados. Forma e
 * adquirente vêm da trava; só são aceitos aqui quando a trava é antiga e não os tem.
 */
export interface ReviewedChargeInput {
  orderId: UUID;
  nsu: string;
  authorization_code: string;
  card_brand: string | null;
  method?: 'CREDIT' | 'DEBIT' | 'PIX';
  acquirer?: 'STONE' | 'PAGBANK';
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
  /** Obrigatório na entrega própria (fulfillment DELIVERY). */
  delivery?: DeliveryAddressInput;
}

/** Código do produto técnico da taxa de entrega (fora do cardápio). */
export const DELIVERY_FEE_CODE = 'TAXA-ENTREGA';

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
  suppliers: Supplier[];
  purchaseInvoices: PurchaseInvoice[];
  purchaseInvoiceItems: PurchaseInvoiceItem[];
  stockMovements: StockMovement[];
  supplierProductLinks: SupplierProductLink[];
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
  /** Caixa (db/schema_caixa.sql): turnos de caixa e movimentos de suprimento/sangria. */
  cashSessions: CashSession[];
  cashMovements: CashMovement[];
  /** Entrega própria (db/schema_entrega.sql). */
  deliveryZones: DeliveryZone[];
  couriers: Courier[];
  ownDeliveries: OwnDelivery[];
  courierSettlements: CourierSettlement[];
  /** Avaliações dos clientes (db/schema_avaliacoes.sql). */
  reviews: Review[];
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

export interface PullStatus {
  last_pull_at: string | null;
  last_error: string | null;
  /** Pessoas ativas na equipe da nuvem que este aparelho ainda não tem (entram com "Atualizar equipe"). */
  cloud_staff_unknown: number;
}

export const EMPTY_PULL_STATUS: PullStatus = { last_pull_at: null, last_error: null, cloud_staff_unknown: 0 };

export interface JoinCloudStoreInput {
  session: CloudSession;
  snapshot: CloudSnapshot;
  /** Equipe com os PINs, entregue pelo servidor depois de conferir o PIN de quem está entrando. */
  staff: StaffUser[];
  /** Gerente ou proprietário que confirmou com o PIN: entra logado. */
  userId: UUID;
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
  /** Combo: produto que a opção coloca no pedido (null = adicional comum). Ausente = mantém. */
  component_product_id?: UUID | null;
  component_quantity?: number;
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
  /** Eventos que a nuvem recusou: fora da fila (não travam o resto) até alguém reenviar. */
  syncRejected: RejectedSyncEvent[];
  managerPinFailures: number;
  managerPinLockedUntil: number | null;
  soundEnabled: boolean;
  hydrated: boolean;
  /** Sequencial de numeração da NFC-e (série 1) deste aparelho emissor. */
  nfceSeq: number;
  /** Abre o simulador 80mm vs 58mm a cada despacho para produção. */
  showPrintSimulator: boolean;
  cloud: CloudSession | null;
  syncStatus: SyncStatus;
  /** Nuvem → aparelho: última leitura dos cadastros (ver src/lib/sync/cloudPull.ts). */
  pullStatus: PullStatus;
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
  /**
   * Registra a cobrança incerta que a maquininha aprovou (NSU + autorização do comprovante,
   * PIN de gerente, audit_log) sem cobrar de novo. Libera a trava e fecha a conta se quitou.
   */
  confirmReviewedCharge: (input: ReviewedChargeInput, auth: ManagerAuthInput) => ActionResult<PaymentOutcome>;

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

  // Compras / estoque
  /** Importa a NF-e de compra (XML) com as decisões da conferência. Só gerente/proprietário. */
  importPurchaseInvoice: (xml: string, decisions: PurchaseItemDecision[]) => ActionResult<PurchaseImportPlan>;
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
  /** Cria os cartões de comanda numerados de `from` a `to` (pula os que já existem). */
  createCards: (from: number, to: number) => ActionResult<DiningTable[]>;
  /** Ativa ou desativa um cartão (perdido ou quebrado); só cartão livre é desativado. */
  setCardActive: (cardId: UUID, active: boolean) => ActionResult<DiningTable>;
  /** Abre a conta do cartão pelo número (1 pessoa); se já estiver em uso, devolve a conta aberta. */
  openCard: (number: number) => ActionResult<Order>;
  saveStaff: (draft: Omit<StaffDraft, 'id'> & { id?: UUID }, auth?: ManagerAuthInput) => ActionResult<StaffUser>;
  setRolePermission: (role: StaffUser['role'], permission: Permission, allowed: boolean, auth: ManagerAuthInput) => ActionResult<RolePermission>;
  updateTenant: (draft: TenantDraft) => ActionResult<Tenant>;
  startNewStore: (input: NewStoreInput, auth: ManagerAuthInput) => ActionResult<Tenant>;

  // Etapa 0 — nuvem
  setCloudSession: (session: CloudSession | null) => ActionResult;
  /** Aparelho novo: troca os dados deste aparelho pelos cadastros da loja da nuvem. */
  joinCloudStore: (input: JoinCloudStoreInput) => ActionResult<Tenant>;
  /** Aplica os cadastros lidos da nuvem; o que ainda não subiu daqui fica como está. */
  applyCloudSnapshot: (snapshot: CloudSnapshot) => ActionResult<{ unknownStaff: number }>;
  /** Equipe com PIN vinda do servidor ("Atualizar equipe"). */
  applyCloudStaff: (staff: StaffUser[]) => ActionResult<{ added: number }>;
  setPullError: (message: string) => void;
  ackSyncedEvents: (eventIds: UUID[]) => void;
  setSyncError: (message: string | null, blockedEventId: UUID | null) => void;
  /** Tira da fila os eventos recusados pela nuvem e guarda em syncRejected. */
  rejectSyncEvents: (rejections: Array<{ eventId: UUID; status: number; message: string }>) => void;
  /** Devolve os recusados para o começo da fila, na ordem original, para nova tentativa. */
  retryRejectedSync: () => void;
  /**
   * Autorização de gerente recusada (fila antiga sem PIN, ou PIN trocado em outro
   * aparelho antes de subir): o mesmo gerente digita o PIN atual e o evento fica
   * pronto para Reenviar recusados (o servidor confere outra vez, com o bloqueio).
   */
  confirmRejectedAuthorization: (eventId: UUID, managerPin: string) => ActionResult;

  // Caixa
  /** Abre o caixa com o fundo de troco. Um caixa aberto por loja. */
  openCashSession: (openingFloat: number) => ActionResult<CashSession>;
  /** Suprimento: dinheiro que entra na gaveta (troco do banco, por exemplo). */
  addCashSupply: (amount: number, reason: string) => ActionResult<CashMovement>;
  /** Nota do cliente (1 a 5) para uma conta já paga. Uma por conta. */
  addReview: (orderId: UUID, score: number, comment: string, source: ReviewSource) => ActionResult<Review>;
  /** Sangria: dinheiro que sai da gaveta. PIN de gerente + motivo; nunca mais do que há na gaveta. */
  addCashWithdrawal: (amount: number, auth: ManagerAuthInput) => ActionResult<CashMovement>;
  /**
   * Fechamento cego: recebe só o que foi contado. Com diferença (sobra ou falta),
   * só fecha com PIN de gerente + motivo (auth); sem auth devolve o erro com a diferença.
   */
  closeCashSession: (countedCash: number, notes: string | null, auth: ManagerAuthInput | null) => ActionResult<CashSession>;

  // Entrega própria
  saveDeliveryZone: (draft: Pick<DeliveryZone, 'name' | 'fee' | 'eta_minutes' | 'active'> & { id?: UUID }) => ActionResult<DeliveryZone>;
  saveCourier: (draft: Pick<Courier, 'name' | 'phone' | 'fee_per_delivery' | 'active'> & { id?: UUID }) => ActionResult<Courier>;
  /** Pronto (saiu da cozinha) ou entregue. */
  setOwnDeliveryStatus: (deliveryId: UUID, status: 'READY' | 'DELIVERED') => ActionResult<OwnDelivery>;
  /** Entregador sai com as entregas escolhidas (rota). */
  dispatchOwnDeliveries: (deliveryIds: UUID[], courierId: UUID) => ActionResult<OwnDelivery[]>;
  /** Cancela a entrega de um pedido ainda não pago (PIN de gerente; desfaz a senha). */
  cancelOwnDelivery: (deliveryId: UUID, auth: ManagerAuthInput) => ActionResult;
  /**
   * Acerto do entregador: as senhas pagas na entrega recebem o pagamento em dinheiro
   * e, com payFromDrawer, o que ele ganhou sai do caixa como sangria (PIN de gerente).
   */
  settleCourier: (courierId: UUID, opts: { payFromDrawer: boolean; auth: ManagerAuthInput | null }) => ActionResult<CourierSettlement>;
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
    syncRejected: [],
    managerPinFailures: 0,
    managerPinLockedUntil: null,
    soundEnabled: true,
    hydrated: false,
    nfceSeq: 1000,
    showPrintSimulator: true,
    cloud: null,
    pendingCharges: [],
    syncStatus: { last_success_at: null, last_error: null, last_error_at: null, blocked_event_id: null },
    pullStatus: EMPTY_PULL_STATUS,
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

/**
 * Evento de item. O item de chopp leva a torneira (keg_tap_id): no banco ele baixa o
 * barril engatado (tchefood_keg_on_item), então não pode subir antes de uma troca de
 * barril recusada da mesma torneira, senão o volume cairia no barril velho.
 */
function itemEvent(op: SyncEvent['op'], item: OrderItem, links: readonly KegTapProduct[]): SyncEvent {
  const ev = syncEvent('order_items', op, item);
  const link = item.keg_volume_ml ? links.find((l) => l.product_id === item.product_id) : undefined;
  return link ? { ...ev, keg_tap_id: link.tap_id } : ev;
}

/**
 * Salvar de novo a mesma pessoa/permissão substitui o que a nuvem não pode aceitar
 * daquele registro. O evento novo leva o estado completo da linha, então:
 *  - qualquer evento RECUSADO do mesmo registro sai dos recusados (o servidor não
 *    gravou nada dele; ex.: PIN repetido por dois aparelhos, corrigido agora na
 *    tela Equipe). Sem isso, o recusado seguraria o novo para sempre;
 *  - na fila, só o evento antigo sem staff_auth (gravado antes desta versão) sai,
 *    porque o servidor sempre o recusaria. Os outros da fila sobem antes do novo,
 *    cada um com a sua autorização e o seu audit_log.
 * O proprietário da loja nova (store_start) nunca é substituído.
 */
function isSameRecord(e: SyncEvent, replacement: SyncEvent): boolean {
  return e.table === replacement.table && e.row_id === replacement.row_id && !e.store_start;
}

function withSupersededLegacy(s: TcheState, event: SyncEvent): Pick<TcheState, 'outbox' | 'syncRejected'> {
  return {
    outbox: [...s.outbox.filter((e) => !(isSameRecord(e, event) && !e.staff_auth)), event],
    syncRejected: (s.syncRejected ?? []).filter((r) => !isSameRecord(r.event, event)),
  };
}

/** Mesa mudada pelo pagamento ou fechamento de uma comanda: o envio dela depende daquela comanda. */
function tableEventForOrder(table: DiningTable, orderId: UUID): SyncEvent {
  return { ...syncEvent('dining_tables', 'UPDATE', table), depends_on_order_id: orderId };
}

/**
 * audit_log de autorização de gerente para a fila: leva o PIN digitado para o servidor
 * conferir de novo (tchefood_authorize_manager). O PIN não entra no audit_log.
 */
function managerAuthEvent(log: AuditLog, managerPin: string | null): SyncEvent {
  const event = syncEvent('audit_logs', 'INSERT', log);
  // Sem gerente (ex.: resgate de cashback), o audit_log sobe direto, sem RPC.
  return managerPin === null ? event : { ...event, manager_pin: managerPin };
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
/** Perfis que operam o caixa (abrir, suprimento, sangria, fechar). */
export const CASH_ROLES: ReadonlyArray<StaffUser['role']> = ['CASHIER', 'MANAGER', 'OWNER'];

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
          data: halves.length ? halfAndHalfPrice([salePrice(product), ...halves.map(salePrice)], get().tenant.half_and_half_pricing) : salePrice(product),
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
        log: AuditLog | AuditLog[],
        managerPin: string | null,
      ): Partial<TcheState> => {
        const ts = nowISO();
        const logs = Array.isArray(log) ? log : [log];
        const settled = settleIfPaid(s, recalculated, orderItems, ts);
        const changed = settled.closed
          ? settled.orderItems.filter((i, idx) => i !== s.orderItems[idx])
          : changedItems;
        // Componentes de combo sobem antes do combo: cancelar o combo (que tem o preço)
        // pode zerar a conta, e o banco então fecha a comanda e dá como pagos os itens
        // ainda ativos, recusando o cancelamento dos componentes que viesse depois.
        const allChanged = [...changed.filter((i) => i.combo_parent_item_id != null), ...changed.filter((i) => i.combo_parent_item_id == null)];
        return {
          orderItems: settled.orderItems,
          nfceSeq: settled.nfceSeq,
          orders: s.orders.map((o) => (o.id === recalculated.id ? settled.order : o)),
          tables: settled.table ? s.tables.map((t) => (t.id === settled.table!.id ? settled.table! : t)) : s.tables,
          auditLogs: [...[...logs].reverse(), ...s.auditLogs],
          outbox: [
            ...s.outbox,
            // O audit_log sobe antes: o banco recusa o ajuste sem a autorização já gravada.
            ...logs.map((l) => managerAuthEvent(l, managerPin)),
            ...allChanged.map((i) => itemEvent('UPDATE', i, s.kegTapProducts)),
            syncEvent('orders', 'UPDATE', settled.order),
            ...(settled.table ? [tableEventForOrder(settled.table, recalculated.id)] : []),
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
      /**
       * Produto técnico "Taxa de entrega" (e a categoria inativa dele), criado na primeira
       * entrega com taxa. Fica fora do cardápio (inativo) e da cozinha (setor NONE).
       */
      /** A senha de entrega foi desfeita: a entrega em andamento sai do quadro junto. */
      const cancelDeliveryOf = (orderId: UUID): void => {
        const d = get().ownDeliveries.find((x) => x.order_id === orderId);
        if (!d || d.status === 'DELIVERED' || d.status === 'CANCELED') return;
        const updated: OwnDelivery = { ...d, status: 'CANCELED' };
        set((s) => ({
          ownDeliveries: s.ownDeliveries.map((x) => (x.id === d.id ? updated : x)),
          outbox: [...s.outbox, syncEvent('own_deliveries', 'UPDATE', updated)],
        }));
      };

      const ensureDeliveryFeeProduct = (s0: TcheState): { category: Category | null; product: Product | null } => {
        if (s0.products.some((p) => p.code === DELIVERY_FEE_CODE)) return { category: null, product: null };
        const existingCat = s0.categories.find((c) => c.name === 'Taxas (fora do cardápio)');
        const category: Category | null = existingCat
          ? null
          : { id: stableUuid(`taxas:${s0.tenant.id}`), tenant_id: s0.tenant.id, name: 'Taxas (fora do cardápio)', sort_order: 999, icon_name: null, active: false };
        // Id fixo por loja: dois aparelhos que criem ao mesmo tempo mandam o mesmo registro.
        const product: Product = {
          id: stableUuid(`taxa-entrega:${s0.tenant.id}`),
          tenant_id: s0.tenant.id,
          category_id: existingCat?.id ?? category!.id,
          code: DELIVERY_FEE_CODE,
          name: 'Taxa de entrega',
          description: 'Taxa do bairro na entrega própria (valor vem do cadastro do bairro).',
          price: 0,
          sold_by_weight: false,
          is_combo: false,
          tare_weight_grams: 0,
          cost_price: 0,
          stock_quantity: 0,
          barcode: null,
          sector: 'NONE',
          available: true,
          active: false,
          requires_meat_doneness: false,
          allows_half_and_half: false,
          ncm: '00000000',
          cfop: '5102',
          csosn_cst: '102',
          unit: 'UN',
          created_at: nowISO(),
        };
        return { category, product };
      };

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
            auditLogs: [...[...logs].reverse(), ...s.auditLogs],
            outbox: [
              ...s.outbox,
              // As autorizações sobem antes, pela RPC que confere o PIN: o banco só aceita
              // o cancelamento de cada item com o audit_log dele já gravado.
              ...logs.map((l) => managerAuthEvent(l, auth.managerPin)),
              ...[...canceled.values()].map((i) => itemEvent('UPDATE', i, s.kegTapProducts)),
              syncEvent('orders', 'UPDATE', updated),
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
          if ((product.requires_meat_doneness || comboNeedsDoneness(product, draft.modifiers, get())) && !draft.meat_doneness) {
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
          // Combo: os itens escolhidos precisam estar no cardápio agora (a cozinha recebe cada um).
          const comps = comboComponents(product, draft.modifiers, get());
          if (!comps.ok) return comps;
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
          const newItems: OrderItem[] = [];
          for (const t of pending) {
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
            const built: OrderItem = {
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
              combo_parent_item_id: null,
              // O preço foi tirado do cadastro quando o item entrou na bandeja.
              priced_at: t.added_at,
              half_product_ids: [...t.half_product_ids],
              modifier_option_ids: t.modifiers.map((m) => m.option_id),
            };
            if (!product) return fail('Produto não encontrado.');
            // Combo: o item do combo leva o preço; cada escolha vira um item na praça dela.
            const expanded = expandComboItem(built, product, t.modifiers, get());
            if (!expanded.ok) return expanded;
            newItems.push(...expanded.data);
          }

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
                ...newItems.map((i) => itemEvent('INSERT', i, s.kegTapProducts)),
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
            outbox: [...s.outbox, itemEvent('UPDATE', updated, s.kegTapProducts)],
          }));
          return { ok: true, data: undefined };
        },

        cancelOrderItem: (itemId, auth) => {
          const item = get().orderItems.find((i) => i.id === itemId);
          if (!item) return fail('Item não encontrado.');
          if (item.status === 'CANCELED') return fail('Item já cancelado.');
          if (item.is_paid) return fail('Item já pago. Estorno deve ser feito pelo módulo de pagamentos.');
          if (item.combo_parent_item_id) return fail('Este item faz parte de um combo. Cancele o combo inteiro.');
          const orderRes = findEditableOrder(item.order_id);
          if (!orderRes.ok) return orderRes;
          const order = orderRes.data;
          if (activeCharge(order.id)) return fail(CHARGE_LOCK_ERROR);

          // Simula o novo total antes de autorizar: não pode ficar abaixo do já pago.
          const ts = nowISO();
          const user = currentUser()!;
          const cancel = (i: OrderItem): OrderItem => ({
            ...i,
            status: 'CANCELED',
            canceled_at: ts,
            canceled_by_user_id: user?.id ?? null,
            cancel_reason: auth.reason.trim(),
          });
          const canceledItem = cancel(item);
          // Combo: os componentes saem junto (o banco pede um audit_log por item cancelado).
          const comboParts = comboChildrenOf(item.id, get().orderItems).filter((c) => c.status !== 'CANCELED');
          const canceledParts = comboParts.map(cancel);
          const canceledById = new Map([canceledItem, ...canceledParts].map((c) => [c.id, c]));
          const simulatedItems = get().orderItems.map((i) => canceledById.get(i.id) ?? i);
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
              ...(comboParts.length ? { combo_items: comboParts.map((c) => c.id) } : {}),
            },
          });
          const partLogs = comboParts.map((part) => {
            const partProduct = get().products.find((p) => p.id === part.product_id);
            return buildAudit({
              order_id: order.id,
              performed_by_user_id: user.id,
              authorized_by_manager_id: manager.id,
              action_type: 'ITEM_CANCELED',
              // O valor saiu da conta no combo; o componente tem preço zero.
              amount_impact: 0,
              reason: auth.reason.trim(),
              metadata: {
                table: tableLabel(order.table_id),
                item_id: part.id,
                combo_item_id: item.id,
                product_code: partProduct?.code ?? null,
                product_name: partProduct?.name ?? null,
                quantity: part.quantity,
                item_total: 0,
                item_status_before: part.status,
                sector: part.sector,
                waiter_name: user.name,
                manager_name: manager.name,
              },
            });
          });

          set((s) => {
            const orderItems = s.orderItems.map((i) => canceledById.get(i.id) ?? i);
            const current = s.orders.find((o) => o.id === order.id)!;
            const recalculated = applyOrderTotals(current, orderItems, s.payments);
            let kegTaps = s.kegTaps;
            for (const id of canceledById.keys()) {
              const before = s.orderItems.find((i) => i.id === id);
              if (before) kegTaps = applyKegCancel(kegTaps, s.kegTapProducts, before);
            }
            const patch = commitAdjustment(s, recalculated, orderItems, [...canceledById.values()], [log, ...partLogs], auth.managerPin);
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
            return commitAdjustment(s, recalculated, s.orderItems, [], log, auth.managerPin);
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
            return commitAdjustment(s, recalculated, s.orderItems, [], log, auth.managerPin);
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
                ...changedItems.map((i) => itemEvent('UPDATE', i, s.kegTapProducts)),
                syncEvent('orders', 'UPDATE', recalculated),
                ...(updatedTable ? [tableEventForOrder(updatedTable, order.id)] : []),
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
            outbox: [...s.outbox, syncEvent('orders', 'UPDATE', closed), ...(freed ? [tableEventForOrder(freed, orderId)] : [])],
          }));
          return { ok: true, data: closed };
        },

        endTerminalCharge: (requestId) => set((s) => ({ pendingCharges: s.pendingCharges.filter((c) => c.request_id !== requestId) })),

        confirmReviewedCharge: (input, auth) => {
          const hold = getReviewHold(input.orderId);
          if (!hold) return fail('Não há cobrança sem confirmação para esta conta.');
          const res = findEditableOrder(input.orderId);
          if (!res.ok) return res;
          const order = res.data;
          if (activeCharge(order.id)) return fail(CHARGE_LOCK_ERROR);
          const method = hold.method ?? input.method;
          const acquirer = hold.acquirer ?? input.acquirer;
          if (method !== 'CREDIT' && method !== 'DEBIT' && method !== 'PIX') return fail('Informe a forma de pagamento que aparece no comprovante.');
          if (acquirer !== 'STONE' && acquirer !== 'PAGBANK') return fail('Informe a maquininha (Stone ou PagBank) do comprovante.');
          if (input.card_brand !== null && !RECEIPT_CARD_BRANDS.includes(input.card_brand)) return fail('Bandeira do cartão inválida.');
          const proof = checkReceiptProof({ nsu: input.nsu, authorization_code: input.authorization_code });
          if (!proof.ok) return fail(proof.error);
          // O mesmo comprovante não pode quitar duas contas.
          const reused = get().payments.find((p) => p.status === 'APPROVED' && p.acquirer === acquirer && p.nsu === proof.nsu);
          if (reused) return fail(`O NSU ${proof.nsu} já está registrado em outro pagamento. Confira o comprovante.`);
          const amount = round2(hold.amount);
          if (!(amount > 0) || toCents(amount) > toCents(order.remaining_balance)) return fail('Valor da cobrança incerta maior que o saldo restante.');
          const user = currentUser();
          if (!user) return fail('Sessão expirada.');

          const authRes = authorizeManager(auth, { orderId: order.id, action: 'CHARGE_CONFIRMED_MANUALLY' });
          if (!authRes.ok) return authRes;
          const manager = authRes.data;

          const pay = get().registerPayment({
            orderId: order.id,
            amount,
            method,
            status: 'APPROVED',
            terminal_id: hold.terminal_id ?? null,
            acquirer,
            acquirer_cnpj: ACQUIRER_CNPJ[acquirer],
            card_brand: method === 'PIX' ? 'PIX' : input.card_brand,
            nsu: proof.nsu,
            authorization_code: proof.authorization_code,
            terminal_serial: hold.terminal_serial || null,
            idempotency_key: hold.idempotency_key ?? uuid(),
            item_ids: hold.item_ids ?? [],
          });
          if (!pay.ok) return pay;

          const log = buildAudit({
            order_id: order.id,
            performed_by_user_id: user.id,
            authorized_by_manager_id: manager.id,
            action_type: 'CHARGE_CONFIRMED_MANUALLY',
            amount_impact: amount,
            reason: auth.reason.trim(),
            metadata: {
              table: tableLabel(order.table_id),
              pickup_number: order.pickup_number ?? null,
              payment_id: pay.data.payment.id,
              method,
              acquirer,
              nsu: proof.nsu,
              authorization_code: proof.authorization_code,
              card_brand: pay.data.payment.card_brand,
              terminal_serial: pay.data.payment.terminal_serial,
              review_code: hold.code,
              review_reason: hold.reason,
              review_started_at: hold.created_at,
              order_closed: pay.data.closed,
              operator_name: user.name,
              manager_name: manager.name,
            },
          });
          // Sobe por tchefood_authorize_manager, depois do pagamento: o servidor confere o
          // PIN e que o pagamento com este NSU já está na conta.
          set((s) => ({ auditLogs: [log, ...s.auditLogs], outbox: [...s.outbox, managerAuthEvent(log, auth.managerPin)] }));
          clearReviewHold(order.id);
          return pay;
        },

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
            outbox: [...s.outbox, ...updated.map((u) => itemEvent('UPDATE', u, s.kegTapProducts))],
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
            if ((product.requires_meat_doneness || comboNeedsDoneness(product, d.modifiers, s0)) && !d.meat_doneness) return fail(`Escolha o ponto de ${product.name}.`);
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
            const expanded = expandComboItem(
              {
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
                combo_parent_item_id: null,
                priced_at: ts,
                half_product_ids: [...d.half_product_ids],
                modifier_option_ids: d.modifiers.map((m) => m.option_id),
              },
              product,
              d.modifiers,
              s0,
            );
            if (!expanded.ok) return expanded;
            newItems.push(...expanded.data);
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
                ...newItems.map((i) => itemEvent('INSERT', i, s.kegTapProducts)),
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
            if ((product.requires_meat_doneness || comboNeedsDoneness(product, line.modifiers, s0)) && !line.meat_doneness) return fail(`Escolha o ponto de ${product.name}.`);
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
            const expanded = expandComboItem(
              {
                id: uuid(),
                order_id: order.id,
                product_id: product.id,
                waiter_id: user.id,
                quantity: line.quantity,
                // Preço sempre do cadastro (com a regra de horário, como na comanda), nunca do aparelho.
                unit_price: effectivePrice(product, s0.priceSchedules, new Date(ts)),
                modifiers_unit_price: mods,
                total_item_price: computeItemTotal(line.quantity, effectivePrice(product, s0.priceSchedules, new Date(ts)), mods),
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
                combo_parent_item_id: null,
                priced_at: ts,
                half_product_ids: [],
                modifier_option_ids: line.modifiers.map((m) => m.option_id),
              },
              product,
              line.modifiers,
              s0,
            );
            if (!expanded.ok) return expanded;
            items.push(...expanded.data);
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
                ...items.map((i) => itemEvent('INSERT', i, s.kegTapProducts)),
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
            // Combo: sai uma ficha por componente (cada um é retirado na praça dele), não do combo.
            if (product?.is_combo && comboChildrenOf(item.id, s0.orderItems).length > 0) continue;
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
                ...(delivered ? [itemEvent('UPDATE', delivered, s.kegTapProducts)] : []),
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
          if (input.fulfillment !== 'DINE_IN' && input.fulfillment !== 'TAKEOUT' && input.fulfillment !== 'DELIVERY') return fail('Escolha comer aqui, para levar ou entrega.');
          if (input.fulfillment === 'DELIVERY' && (!input.delivery || !COUNTER_ROLES.includes(user.role))) return fail('Entrega própria é lançada no caixa, com o endereço.');
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
            if ((product.requires_meat_doneness || comboNeedsDoneness(product, d.modifiers, s0)) && !d.meat_doneness) return fail(`Escolha o ponto de ${product.name}.`);
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
            const expanded = expandComboItem(
              {
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
                combo_parent_item_id: null,
                priced_at: ts,
                half_product_ids: [...d.half_product_ids],
                modifier_option_ids: d.modifiers.map((m) => m.option_id),
              },
              product,
              d.modifiers,
              s0,
            );
            if (!expanded.ok) return expanded;
            items.push(...expanded.data);
          }
          // Entrega própria: a taxa do bairro entra como item da conta (produto técnico,
          // fora do cardápio e da cozinha) e a entrega nasce em preparo.
          let delivery: OwnDelivery | null = null;
          let feeCatalog: { category: Category | null; product: Product | null } = { category: null, product: null };
          if (input.fulfillment === 'DELIVERY') {
            const d = input.delivery!;
            const zone = s0.deliveryZones.find((z) => z.id === d.zoneId && z.active);
            const itemsTotal = applyOrderTotals(order, items, []).total_amount;
            const err = validateDeliveryInput(d, s0.deliveryZones, round2(itemsTotal + (zone?.fee ?? 0)));
            if (err || !zone) return fail(err ?? 'Escolha o bairro da entrega.');
            if (zone.fee > 0) {
              feeCatalog = ensureDeliveryFeeProduct(s0);
              const feeProduct = feeCatalog.product ?? s0.products.find((p) => p.code === DELIVERY_FEE_CODE)!;
              items.push({
                id: uuid(),
                order_id: order.id,
                product_id: feeProduct.id,
                waiter_id: user.id,
                quantity: 1,
                unit_price: zone.fee,
                modifiers_unit_price: 0,
                total_item_price: zone.fee,
                meat_doneness: null,
                notes: `Entrega: ${zone.name}`,
                sector: 'NONE',
                // Taxa não vai para a cozinha.
                status: 'DELIVERED',
                is_paid: false,
                origin: 'WAITER',
                created_at: ts,
                prepared_at: ts,
                canceled_at: null,
                canceled_by_user_id: null,
                cancel_reason: null,
                weight_gross_grams: null,
                weight_tare_grams: null,
                weight_source: null,
                keg_volume_ml: null,
                combo_parent_item_id: null,
                priced_at: ts,
                half_product_ids: [],
                modifier_option_ids: [],
              });
            }
            delivery = {
              id: uuid(),
              tenant_id: s0.tenant.id,
              order_id: order.id,
              customer_name: d.customerName.trim().slice(0, 60),
              customer_phone: normalizePhone(d.phone)!,
              address: d.address.trim().slice(0, 160),
              reference: d.reference.trim().slice(0, 120) || null,
              zone_id: zone.id,
              zone_name: zone.name,
              delivery_fee: zone.fee,
              pay_on_delivery: d.payOnDelivery,
              change_for: d.payOnDelivery && d.changeFor !== null ? round2(d.changeFor) : null,
              status: 'PREPARING',
              courier_id: null,
              courier_fee: null,
              out_at: null,
              delivered_at: null,
              settlement_id: null,
              created_at: ts,
            };
            if (!order.pickup_name) order.pickup_name = sanitizePickupName(delivery.customer_name);
          }
          const recalculated = applyOrderTotals(order, items, []);
          if (!(recalculated.total_amount > 0)) return fail('Pedido sem valor.');
          set((s) => {
            const kegTaps = applyKegSale(s.kegTaps, s.kegTapProducts, items);
            return {
              orders: [...s.orders, recalculated],
              orderItems: [...s.orderItems, ...items],
              categories: feeCatalog.category ? [...s.categories, feeCatalog.category] : s.categories,
              products: feeCatalog.product ? [...s.products, feeCatalog.product] : s.products,
              ownDeliveries: delivery ? [delivery, ...s.ownDeliveries] : s.ownDeliveries,
              kegTaps,
              outbox: [
                ...s.outbox,
                ...(feeCatalog.category ? [syncEvent('categories', 'INSERT', feeCatalog.category)] : []),
                ...(feeCatalog.product ? [syncEvent('products', 'INSERT', feeCatalog.product)] : []),
                syncEvent('orders', 'INSERT', recalculated),
                // A entrega sobe antes dos itens: o banco confere o preço da taxa pela entrega (schema_entrega.sql).
                ...(delivery ? [syncEvent('own_deliveries', 'INSERT', delivery)] : []),
                ...items.map((i) => itemEvent('INSERT', i, s.kegTapProducts)),
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
          const voided = voidTechnicalSale(orderId, auth, 'KIOSK');
          if (voided.ok) cancelDeliveryOf(orderId);
          return voided;
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
            outbox: [...s.outbox, managerAuthEvent(exitLog, auth.managerPin)],
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
            // A troca sobe inteira por tchefood_change_keg (histórico + audit_log + barril
            // novo), com o PIN para o servidor conferir. O UPDATE da torneira vem depois
            // e fica segurado se a troca for recusada (recordKeys).
            outbox: [
              ...s.outbox,
              {
                ...syncEvent('keg_history', 'INSERT', history),
                manager_pin: auth.managerPin,
                keg_change: { audit_id: log.id, beer_name: beer, total_capacity_ml: capacity, keg_cost: cost, reason: auth.reason.trim() },
              },
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
              // discount_before/discount_after: o banco só aceita o aumento do desconto da
              // comanda que bate com este resgate (mesma regra do DISCOUNT_APPLIED).
              metadata: {
                table: tableLabel(order.table_id),
                customer_id: customer.id,
                phone,
                amount,
                discount_before: order.discount_amount,
                discount_after: round2(order.discount_amount + amount),
              },
            }),
            whatsapp_alert_sent: false,
          };
          set((s) => {
            const current = s.orders.find((o) => o.id === orderId)!;
            const recalculated = applyOrderTotals({ ...current, discount_amount: round2(current.discount_amount + amount) }, s.orderItems, s.payments);
            const patch = commitAdjustment(s, recalculated, s.orderItems, [], log, null);
            // O resgate sobe por tchefood_register_cashback_redeem, que confere a regra no
            // banco, baixa os créditos e grava o audit_log e o desconto da comanda. Por isso
            // o audit_log e a baixa dos créditos não sobem sozinhos, e o resgate vai antes da
            // atualização da comanda (que então já encontra o desconto gravado).
            const [, ...orderEvents] = patch.outbox!.slice(s.outbox.length);
            return {
              ...patch,
              auditLogs: patch.auditLogs,
              cashbackLedger: ledger,
              loyaltyCustomers: s.loyaltyCustomers.map((c) => (c.id === customer.id ? updatedCustomer : c)),
              outbox: [
                ...s.outbox,
                { ...syncEvent('cashback_ledger', 'INSERT', entry), depends_on_order_id: orderId, cashback_redeem: { audit_id: log.id } },
                ...orderEvents,
                { ...syncEvent('loyalty_customers', 'UPDATE', updatedCustomer), depends_on_order_id: orderId },
              ],
            };
          });
          return { ok: true, data: { amount, customer: updatedCustomer } };
        },

        setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
        setHalfAndHalfPricing: (rule) => {
          // Regra da loja: sobe para a nuvem, que confere o preço do item com ela.
          const tenant: Tenant = { ...get().tenant, half_and_half_pricing: rule };
          set((s) => ({ tenant, outbox: [...s.outbox, syncEvent('tenants', 'UPDATE', tenant)] }));
        },

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
            is_combo: draft.is_combo ?? existing?.is_combo ?? false,
            tare_weight_grams: draft.tare_weight_grams ?? existing?.tare_weight_grams ?? 0,
            cost_price: draft.cost_price ?? existing?.cost_price ?? 0,
            // Estoque só muda por movimento (compra/venda), nunca pelo cadastro.
            stock_quantity: existing?.stock_quantity ?? 0,
            barcode: draft.barcode ?? existing?.barcode ?? null,
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
            component_product_id: draft.component_product_id !== undefined ? draft.component_product_id : existing?.component_product_id ?? null,
            component_quantity: draft.component_quantity ?? existing?.component_quantity ?? 1,
          };
          const check = validateModifierOption(row, state.modifierGroups, state.modifierOptions, state.products);
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

        createCards: (from, to) => {
          const perm = requirePermission('TABLES_MANAGE');
          if (!perm.ok) return perm;
          const check = validateCardRange(from, to);
          if (!check.ok) return check;
          const state = get();
          const taken = new Set(state.tables.filter((t) => t.kind === 'CARD').map((t) => t.number));
          const ts = nowISO();
          const rows: DiningTable[] = [];
          for (let n = from; n <= to; n++) {
            if (taken.has(n)) continue;
            rows.push({
              id: uuid(),
              tenant_id: state.tenant.id,
              number: n,
              label: `Cartão ${n}`,
              area: 'Cartões',
              capacity: 1,
              status: 'FREE',
              qr_code_token: null,
              current_order_id: null,
              active: true,
              updated_at: ts,
              kind: 'CARD',
            });
          }
          if (rows.length === 0) return fail('Esses cartões já estão cadastrados.');
          set((s) => ({ tables: [...s.tables, ...rows], outbox: [...s.outbox, ...rows.map((r) => syncEvent('dining_tables', 'INSERT', r))] }));
          return { ok: true, data: rows };
        },

        setCardActive: (cardId, active) => {
          const perm = requirePermission('TABLES_MANAGE');
          if (!perm.ok) return perm;
          const card = get().tables.find((t) => t.id === cardId && t.kind === 'CARD');
          if (!card) return fail('Cartão não encontrado.');
          if (!active && card.status !== 'FREE') return fail(`${card.label} está com conta aberta. Feche a conta antes de desativar.`);
          const updated: DiningTable = { ...card, active, updated_at: nowISO() };
          set((s) => ({ tables: s.tables.map((t) => (t.id === card.id ? updated : t)), outbox: [...s.outbox, syncEvent('dining_tables', 'UPDATE', updated)] }));
          return { ok: true, data: updated };
        },

        openCard: (number) => {
          const card = get().tables.find((t) => t.kind === 'CARD' && t.number === number);
          if (!card) return fail(`Cartão ${number} não cadastrado.`);
          if (!card.active) return fail(`${card.label} está desativado (perdido ou quebrado).`);
          if (card.current_order_id) {
            const open = get().orders.find((o) => o.id === card.current_order_id);
            if (open) return { ok: true, data: open };
          }
          return get().openTable(card.id, 1, null);
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
          // No servidor, equipe só muda por tchefood_save_staff: confere o PIN de quem alterou
          // e o do gerente, grava a pessoa e os audit_logs juntos. Por isso os logs não sobem à parte.
          // Troca do próprio PIN que a nuvem recusou (ex.: PIN já usado em outro aparelho):
          // o PIN novo já está no aparelho, mas na nuvem continua o anterior. A correção
          // prova quem é com o PIN que a nuvem ainda conhece, o do recusado mais antigo.
          const cloudPin = (get().syncRejected ?? [])
            .filter((r) => r.event.table === 'staff_users' && r.event.row_id === actor.id && r.event.staff_auth?.actor_id === actor.id)
            .sort((x, y) => x.event.created_at.localeCompare(y.event.created_at))[0]?.event.staff_auth?.actor_pin;
          const staffEvent: SyncEvent = {
            ...syncEvent('staff_users', existing ? 'UPDATE' : 'INSERT', row),
            staff_auth: {
              actor_id: actor.id,
              actor_pin: cloudPin ?? actor.pin_code,
              manager_pin: manager ? auth!.managerPin : null,
              reason: manager ? reason : null,
            },
          };
          set((s) => ({
            staff: existing ? s.staff.map((u) => (u.id === row.id ? row : u)) : [...s.staff, row],
            auditLogs: [...logs, ...s.auditLogs],
            ...withSupersededLegacy(s, staffEvent),
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
          // Sobe por tchefood_set_role_permission (confere os PINs e grava o audit_log junto).
          const event: SyncEvent = {
            ...permissionEvent(row),
            staff_auth: { actor_id: user.id, actor_pin: user.pin_code, manager_pin: auth.managerPin, reason: auth.reason.trim() },
          };
          set((s) => ({
            rolePermissions: [...s.rolePermissions.filter((r) => !(r.role === role && r.permission === permission)), row],
            auditLogs: [log, ...s.auditLogs],
            ...withSupersededLegacy(s, event),
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
          const rejectedCount = (state.syncRejected ?? []).length;
          if (state.cloud && rejectedCount > 0) {
            return fail(`Há ${rejectedCount} evento(s) recusado(s) pela nuvem. Resolva e reenvie antes de iniciar uma loja nova.`);
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
            half_and_half_pricing: state.tenant.half_and_half_pricing,
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
            cashSessions: [],
            cashMovements: [],
            deliveryZones: [],
            couriers: [],
            ownDeliveries: [],
            courierSettlements: [],
            reviews: [],
            tray: [],
            outbox: [
              syncEvent('tenants', 'UPDATE', tenant),
              // Proprietário, usuário do QR e o STORE_RESET sobem juntos por tchefood_start_store
              // (só numa loja da nuvem ainda sem equipe).
              {
                ...syncEvent('staff_users', 'INSERT', owner),
                store_start: { qr_user_id: qrUser.id, reason: log.reason, metadata: log.metadata ?? {} },
              },
              ...terminals.map((t) => syncEvent('pos_terminals', 'INSERT', t)),
              syncEvent('dining_tables', 'INSERT', counter),
              syncEvent('dining_tables', 'INSERT', kiosk),
            ],
            currentUserId: owner.id,
            cloud: linkedCloud ?? null,
            managerPinFailures: 0,
            managerPinLockedUntil: null,
            nfceSeq: 1,
            syncStatus: { last_success_at: null, last_error: null, last_error_at: null, blocked_event_id: null },
            pullStatus: EMPTY_PULL_STATUS,
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

        joinCloudStore: ({ session, snapshot, staff, userId }) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (user.role !== 'OWNER') return fail('Só o proprietário troca a loja deste aparelho.');
          const state = get();
          // As contas de exemplo da demonstração não seguram: são apagadas junto.
          if (state.tenant.id !== DEMO_TENANT_ID && state.orders.some((o) => o.status === 'OPEN' || o.status === 'PAYING')) {
            return fail('Há contas abertas. Feche todas antes de trocar a loja deste aparelho.');
          }
          if (state.cloud && state.outbox.length > 0) {
            return fail(`Ainda há ${state.outbox.length} evento(s) sem enviar para a nuvem. Sincronize antes.`);
          }
          if (state.cloud && (state.syncRejected ?? []).length > 0) {
            return fail('Há eventos recusados pela nuvem. Resolva e reenvie antes de trocar a loja deste aparelho.');
          }
          const tenantId = snapshot.tenant.id;
          if (session.tenant_id !== tenantId) return fail('Os dados baixados não são da loja desta conta.');
          if (staff.some((u) => u.tenant_id !== tenantId)) return fail('A equipe baixada não é da loja desta conta.');
          const who = staff.find((u) => u.id === userId);
          if (!who || !who.active || !isManagerRole(who.role)) return fail('Quem confirma precisa ser gerente ou proprietário ativo da loja.');

          const ts = nowISO();
          const tables = snapshot.tables.map((t) => adaptTable(t, undefined));
          // Loja sem a mesa técnica do balcão ou do totem (criada antes delas): cria e sobe.
          const extraTables: DiningTable[] = [
            ...(tables.some((t) => t.kind === 'COUNTER') ? [] : [counterTable(tenantId)]),
            ...(tables.some((t) => t.kind === 'KIOSK') ? [] : [kioskTable(tenantId)]),
          ];
          const tenant: Tenant = { ...snapshot.tenant, focus_nfe_token: null, csc_id: null, csc_token: null };
          set({
            tenant,
            staff: [...staff],
            terminals: [...snapshot.terminals],
            categories: [...snapshot.categories],
            products: [...snapshot.products],
            modifierGroups: [...snapshot.modifierGroups],
            modifierOptions: [...snapshot.modifierOptions],
            productModifierGroups: [...snapshot.productModifierGroups],
            priceSchedules: [...snapshot.priceSchedules],
            rolePermissions: [...snapshot.rolePermissions],
            suppliers: [...snapshot.suppliers],
            supplierProductLinks: [...snapshot.supplierProductLinks],
            purchaseInvoices: [...snapshot.purchaseInvoices],
            deliveryZones: [...snapshot.deliveryZones],
            couriers: [...snapshot.couriers],
            ownDeliveries: [],
            courierSettlements: [],
            reviews: [],
            tables: [...tables, ...extraTables],
            orders: [],
            orderItems: [],
            payments: [],
            auditLogs: [],
            printers: [],
            purchaseInvoiceItems: [],
            stockMovements: [],
            kegTaps: [],
            kegTapProducts: [],
            kegHistory: [],
            eventTickets: [],
            loyaltyCustomers: [],
            cashbackLedger: [],
            tray: [],
            pendingCharges: [],
            outbox: extraTables.map((t) => syncEvent('dining_tables', 'INSERT', t)),
            syncRejected: [],
            currentUserId: who.id,
            cloud: session,
            managerPinFailures: 0,
            managerPinLockedUntil: null,
            nfceSeq: 1,
            syncStatus: { last_success_at: null, last_error: null, last_error_at: null, blocked_event_id: null },
            pullStatus: { last_pull_at: ts, last_error: null, cloud_staff_unknown: 0 },
          });
          return { ok: true, data: tenant };
        },

        applyCloudSnapshot: (snapshot) => {
          const state = get();
          if (!state.cloud || snapshot.tenant.id !== state.tenant.id || state.cloud.tenant_id !== state.tenant.id) {
            return fail('Os dados da nuvem não são da loja deste aparelho.');
          }
          const pending = pendingRowKeys([...state.outbox, ...(state.syncRejected ?? []).map((r) => r.event)]);
          const tenant: Tenant = pending.has(`tenants:${state.tenant.id}`) ? state.tenant : { ...state.tenant, ...snapshot.tenant };
          const team = mergeStaffWithoutPins(state.staff, snapshot.staff, pending);
          const currentStillActive = team.staff.some((u) => u.id === state.currentUserId && u.active);
          set({
            tenant,
            staff: team.staff,
            terminals: mergeRows(state.terminals, snapshot.terminals, pending, MERGE.terminals),
            categories: mergeRows(state.categories, snapshot.categories, pending, MERGE.categories),
            products: mergeRows(state.products, snapshot.products, pending, MERGE.products),
            modifierGroups: mergeRows(state.modifierGroups, snapshot.modifierGroups, pending, MERGE.modifierGroups),
            modifierOptions: mergeRows(state.modifierOptions, snapshot.modifierOptions, pending, MERGE.modifierOptions),
            productModifierGroups: mergeRows(state.productModifierGroups, snapshot.productModifierGroups, pending, MERGE.productModifierGroups),
            priceSchedules: mergeRows(state.priceSchedules, snapshot.priceSchedules, pending, MERGE.priceSchedules),
            tables: mergeRows(state.tables, snapshot.tables, pending, MERGE.tables),
            rolePermissions: mergeRows(state.rolePermissions, snapshot.rolePermissions, pending, MERGE.rolePermissions),
            suppliers: mergeRows(state.suppliers, snapshot.suppliers, pending, MERGE.suppliers),
            supplierProductLinks: mergeRows(state.supplierProductLinks, snapshot.supplierProductLinks, pending, MERGE.supplierProductLinks),
            purchaseInvoices: mergeRows(state.purchaseInvoices, snapshot.purchaseInvoices, pending, MERGE.purchaseInvoices),
            deliveryZones: mergeRows(state.deliveryZones, snapshot.deliveryZones, pending, MERGE.deliveryZones),
            couriers: mergeRows(state.couriers, snapshot.couriers, pending, MERGE.couriers),
            // Desativado em outro aparelho: sai da sessão aqui também.
            currentUserId: currentStillActive ? state.currentUserId : null,
            pullStatus: { last_pull_at: nowISO(), last_error: null, cloud_staff_unknown: team.unknown },
          });
          return { ok: true, data: { unknownStaff: team.unknown } };
        },

        applyCloudStaff: (cloudStaff) => {
          const state = get();
          if (cloudStaff.some((u) => u.tenant_id !== state.tenant.id)) return fail('A equipe baixada não é da loja deste aparelho.');
          const pending = pendingRowKeys([...state.outbox, ...(state.syncRejected ?? []).map((r) => r.event)]);
          const before = new Set(state.staff.map((u) => u.id));
          const staff = mergeStaffWithPins(state.staff, cloudStaff, pending);
          const currentStillActive = staff.some((u) => u.id === state.currentUserId && u.active);
          set({
            staff,
            currentUserId: currentStillActive ? state.currentUserId : null,
            pullStatus: { ...(state.pullStatus ?? EMPTY_PULL_STATUS), cloud_staff_unknown: 0 },
          });
          return { ok: true, data: { added: staff.filter((u) => !before.has(u.id)).length } };
        },

        setPullError: (message) => set((s) => ({ pullStatus: { ...(s.pullStatus ?? EMPTY_PULL_STATUS), last_error: message } })),

        ackSyncedEvents: (eventIds) => {
          if (eventIds.length === 0) return;
          const done = new Set(eventIds);
          set((s) => ({
            outbox: s.outbox.filter((e) => !done.has(e.id)),
            syncStatus: { last_success_at: nowISO(), last_error: null, last_error_at: null, blocked_event_id: null },
          }));
        },

        rejectSyncEvents: (rejections) => {
          if (rejections.length === 0) return;
          const byId = new Map(rejections.map((r) => [r.eventId, r]));
          const at = nowISO();
          set((s) => ({
            outbox: s.outbox.filter((e) => !byId.has(e.id)),
            syncRejected: [
              ...(s.syncRejected ?? []),
              ...s.outbox
                .filter((e) => byId.has(e.id))
                .map((event) => ({ event, status: byId.get(event.id)!.status, message: byId.get(event.id)!.message, rejected_at: at })),
            ],
          }));
        },

        retryRejectedSync: () =>
          set((s) => {
            const back = (s.syncRejected ?? []).map((r) => r.event);
            if (back.length === 0) return {};
            // Voltam na frente: são mais antigos que tudo o que entrou na fila depois.
            back.sort((a, b) => a.created_at.localeCompare(b.created_at));
            return { outbox: [...back, ...s.outbox], syncRejected: [] };
          }),

        confirmRejectedAuthorization: (eventId, managerPin) => {
          const rejected = (get().syncRejected ?? []).find((r) => r.event.id === eventId);
          if (!rejected) return fail('Evento recusado não encontrado.');
          const ev = rejected.event;
          const p = ev.payload;
          const kegChange = ev.table === 'keg_history' && ev.keg_change != null;
          if (!kegChange && (ev.table !== 'audit_logs' || typeof p.authorized_by_manager_id !== 'string')) {
            return fail('Este evento não espera PIN de gerente.');
          }
          if (!/^[0-9]{4}$/.test(managerPin)) return fail('O PIN tem 4 dígitos.');
          // Vale para a fila antiga (sem PIN) e para PIN trocado em outro aparelho
          // antes de a fila subir. O PIN atual pode ainda não estar neste aparelho
          // (a nuvem não desce a equipe), então quem confere é o servidor, com o
          // bloqueio de 3 erros. Aqui só se recusa o PIN de OUTRO gerente conhecido.
          const local = get().staff.find((u) => u.active && MANAGER_ROLES.includes(u.role) && u.pin_code === managerPin);
          if (local && local.id !== p.authorized_by_manager_id) {
            const who = get().staff.find((u) => u.id === p.authorized_by_manager_id)?.name ?? 'outro gerente';
            return fail(`Esta autorização foi dada por ${who}. Digite o PIN atual dessa pessoa.`);
          }
          set((s) => ({
            syncRejected: (s.syncRejected ?? []).map((r) =>
              r.event.id === eventId ? { ...r, event: { ...r.event, manager_pin: managerPin } } : r,
            ),
          }));
          return { ok: true, data: undefined };
        },

        openCashSession: (openingFloat) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!CASH_ROLES.includes(user.role)) return fail('Só caixa, gerente ou proprietário abre o caixa.');
          if (!validCashAmount(openingFloat, true)) return fail('Informe o fundo de troco (pode ser R$ 0,00).');
          if (get().cashSessions.some((c) => c.status === 'OPEN')) return fail('Já existe um caixa aberto.');
          const session: CashSession = {
            id: uuid(),
            tenant_id: get().tenant.id,
            opened_by_user_id: user.id,
            opened_at: nowISO(),
            opening_float: round2(openingFloat),
            status: 'OPEN',
            closed_by_user_id: null,
            closed_at: null,
            counted_cash: null,
            expected_cash: null,
            difference: null,
            closing_notes: null,
            closing_authorized_by_manager_id: null,
          };
          let duplicated = false;
          set((s) => {
            // Dois toques seguidos não abrem dois caixas.
            if (s.cashSessions.some((c) => c.status === 'OPEN')) {
              duplicated = true;
              return {};
            }
            return { cashSessions: [session, ...s.cashSessions], outbox: [...s.outbox, syncEvent('cash_sessions', 'INSERT', session)] };
          });
          if (duplicated) return fail('Já existe um caixa aberto.');
          return { ok: true, data: session };
        },

        addCashSupply: (amount, reason) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!CASH_ROLES.includes(user.role)) return fail('Só caixa, gerente ou proprietário movimenta o caixa.');
          const open = get().cashSessions.find((c) => c.status === 'OPEN');
          if (!open) return fail('Abra o caixa primeiro.');
          if (!validCashAmount(amount)) return fail('Informe um valor maior que zero.');
          const why = reason.trim();
          if (why.length < MIN_REASON_LENGTH) return fail(`Informe o motivo (mínimo ${MIN_REASON_LENGTH} caracteres).`);
          const movement: CashMovement = {
            id: uuid(),
            tenant_id: get().tenant.id,
            session_id: open.id,
            type: 'SUPPLY',
            amount: round2(amount),
            reason: why,
            performed_by_user_id: user.id,
            authorized_by_manager_id: null,
            created_at: nowISO(),
          };
          set((s) => ({ cashMovements: [...s.cashMovements, movement], outbox: [...s.outbox, syncEvent('cash_movements', 'INSERT', movement)] }));
          return { ok: true, data: movement };
        },

        addCashWithdrawal: (amount, auth) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!CASH_ROLES.includes(user.role)) return fail('Só caixa, gerente ou proprietário movimenta o caixa.');
          const open = get().cashSessions.find((c) => c.status === 'OPEN');
          if (!open) return fail('Abra o caixa primeiro.');
          if (!validCashAmount(amount)) return fail('Informe um valor maior que zero.');
          const inDrawer = cashSummary(open, get().payments, get().cashMovements).expected;
          if (toCents(amount) > toCents(inDrawer)) return fail(`Não há esse valor na gaveta. Esperado agora: ${formatBRL(inDrawer)}.`);
          const authRes = authorizeManager(auth, { orderId: null, action: 'CASH_WITHDRAWAL' });
          if (!authRes.ok) return authRes;
          const ts = nowISO();
          const movement: CashMovement = {
            id: uuid(),
            tenant_id: get().tenant.id,
            session_id: open.id,
            type: 'WITHDRAWAL',
            amount: round2(amount),
            reason: auth.reason.trim(),
            performed_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
            created_at: ts,
          };
          const log: AuditLog = {
            id: uuid(),
            tenant_id: get().tenant.id,
            order_id: null,
            performed_by_user_id: user.id,
            authorized_by_manager_id: authRes.data.id,
            action_type: 'CASH_WITHDRAWAL',
            amount_impact: -movement.amount,
            reason: movement.reason,
            whatsapp_alert_sent: false,
            metadata: { movement_id: movement.id, session_id: open.id },
            created_at: ts,
          };
          set((s) => ({
            cashMovements: [...s.cashMovements, movement],
            auditLogs: [log, ...s.auditLogs],
            // A autorização sobe antes: o banco só aceita a sangria com ela já gravada.
            outbox: [...s.outbox, managerAuthEvent(log, auth.managerPin), syncEvent('cash_movements', 'INSERT', movement)],
          }));
          return { ok: true, data: movement };
        },

        closeCashSession: (countedCash, notes, auth) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!CASH_ROLES.includes(user.role)) return fail('Só caixa, gerente ou proprietário fecha o caixa.');
          const open = get().cashSessions.find((c) => c.status === 'OPEN');
          if (!open) return fail('Não há caixa aberto.');
          if (!validCashAmount(countedCash, true)) return fail('Informe quanto dinheiro foi contado na gaveta.');
          const ts = nowISO();
          const summary = cashSummary(open, get().payments, get().cashMovements, new Date(ts));
          const diff = closingDifference(countedCash, summary.expected);
          let log: AuditLog | null = null;
          let managerId: UUID | null = null;
          if (diff !== 0) {
            if (!auth) {
              return fail(`${diff < 0 ? 'Faltou' : 'Sobrou'} ${formatBRL(Math.abs(diff))} no caixa. Conte de novo ou chame o gerente para fechar com a diferença.`);
            }
            const authRes = authorizeManager(auth, { orderId: null, action: 'CASH_CLOSE_DIFFERENCE' });
            if (!authRes.ok) return authRes;
            managerId = authRes.data.id;
            log = {
              id: uuid(),
              tenant_id: get().tenant.id,
              order_id: null,
              performed_by_user_id: user.id,
              authorized_by_manager_id: managerId,
              action_type: 'CASH_CLOSE_DIFFERENCE',
              amount_impact: diff,
              reason: auth.reason.trim(),
              // Falta grande no caixa vai para o alerta do proprietário, como os cancelamentos.
              whatsapp_alert_sent: diff < 0,
              metadata: { session_id: open.id, expected_cash: summary.expected, counted_cash: round2(countedCash) },
              created_at: ts,
            };
          }
          const closed: CashSession = {
            ...open,
            status: 'CLOSED',
            closed_by_user_id: user.id,
            closed_at: ts,
            counted_cash: round2(countedCash),
            expected_cash: summary.expected,
            difference: diff,
            closing_notes: notes?.trim() || null,
            closing_authorized_by_manager_id: managerId,
          };
          let stale = false;
          set((s) => {
            if (!s.cashSessions.some((c) => c.id === open.id && c.status === 'OPEN')) {
              stale = true;
              return {};
            }
            return {
              cashSessions: s.cashSessions.map((c) => (c.id === open.id ? closed : c)),
              auditLogs: log ? [log, ...s.auditLogs] : s.auditLogs,
              outbox: [...s.outbox, ...(log ? [managerAuthEvent(log, auth!.managerPin)] : []), syncEvent('cash_sessions', 'UPDATE', closed)],
            };
          });
          if (stale) return fail('Este caixa já foi fechado.');
          return { ok: true, data: closed };
        },

        addReview: (orderId, score, comment, source) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          const order = get().orders.find((o) => o.id === orderId);
          if (!order || order.status !== 'CLOSED') return fail('Só dá para avaliar uma conta já paga.');
          if (!Number.isInteger(score) || score < 1 || score > 5) return fail('Escolha uma nota de 1 a 5.');
          if (get().reviews.some((r) => r.order_id === orderId)) return fail('Esta conta já foi avaliada.');
          const text = comment.trim().slice(0, MAX_REVIEW_COMMENT);
          const review: Review = {
            id: uuid(),
            tenant_id: get().tenant.id,
            order_id: orderId,
            score: score as Review['score'],
            comment: text || null,
            source,
            created_at: nowISO(),
          };
          set((s) => ({ reviews: [review, ...s.reviews], outbox: [...s.outbox, syncEvent('reviews', 'INSERT', review)] }));
          return { ok: true, data: review };
        },

        saveDeliveryZone: (draft) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!isManagerRole(user.role)) return fail('Só gerente ou proprietário cadastra bairros.');
          const err = validateZone(draft);
          if (err) return fail(err);
          const existing = draft.id ? get().deliveryZones.find((z) => z.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Bairro não encontrado.');
          const name = draft.name.trim();
          if (get().deliveryZones.some((z) => z.id !== draft.id && z.name.toLowerCase() === name.toLowerCase())) return fail('Já existe um bairro com esse nome.');
          const row: DeliveryZone = { id: existing?.id ?? uuid(), tenant_id: get().tenant.id, name, fee: round2(draft.fee), eta_minutes: draft.eta_minutes, active: draft.active };
          set((s) => ({
            deliveryZones: existing ? s.deliveryZones.map((z) => (z.id === row.id ? row : z)) : [...s.deliveryZones, row],
            outbox: [...s.outbox, syncEvent('delivery_zones', existing ? 'UPDATE' : 'INSERT', row)],
          }));
          return { ok: true, data: row };
        },

        saveCourier: (draft) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!isManagerRole(user.role)) return fail('Só gerente ou proprietário cadastra entregadores.');
          const err = validateCourier(draft);
          if (err) return fail(err);
          const existing = draft.id ? get().couriers.find((c) => c.id === draft.id) : undefined;
          if (draft.id && !existing) return fail('Entregador não encontrado.');
          const row: Courier = {
            id: existing?.id ?? uuid(),
            tenant_id: get().tenant.id,
            name: draft.name.trim(),
            phone: draft.phone ? normalizePhone(draft.phone) : null,
            fee_per_delivery: round2(draft.fee_per_delivery),
            active: draft.active,
          };
          set((s) => ({
            couriers: existing ? s.couriers.map((c) => (c.id === row.id ? row : c)) : [...s.couriers, row],
            outbox: [...s.outbox, syncEvent('couriers', existing ? 'UPDATE' : 'INSERT', row)],
          }));
          return { ok: true, data: row };
        },

        setOwnDeliveryStatus: (deliveryId, status) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!COUNTER_ROLES.includes(user.role)) return fail('Seu perfil não mexe nas entregas.');
          const d = get().ownDeliveries.find((x) => x.id === deliveryId);
          if (!d) return fail('Entrega não encontrada.');
          const order = get().orders.find((o) => o.id === d.order_id);
          if (status === 'READY') {
            if (d.status !== 'PREPARING') return fail('Só entrega em preparo fica pronta.');
            // Paga antes (no caixa) só sai da cozinha depois de paga; paga na entrega já está na cozinha.
            if (!d.pay_on_delivery && order?.status !== 'CLOSED') return fail('Pedido ainda não foi pago no caixa.');
          } else if (d.status !== 'OUT') return fail('Só entrega que saiu pode ser marcada como entregue.');
          const updated: OwnDelivery = { ...d, status, delivered_at: status === 'DELIVERED' ? nowISO() : d.delivered_at };
          set((s) => ({
            ownDeliveries: s.ownDeliveries.map((x) => (x.id === d.id ? updated : x)),
            outbox: [...s.outbox, syncEvent('own_deliveries', 'UPDATE', updated)],
          }));
          return { ok: true, data: updated };
        },

        dispatchOwnDeliveries: (deliveryIds, courierId) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!COUNTER_ROLES.includes(user.role)) return fail('Seu perfil não mexe nas entregas.');
          const courier = get().couriers.find((c) => c.id === courierId && c.active);
          if (!courier) return fail('Escolha o entregador.');
          const ids = [...new Set(deliveryIds)];
          if (ids.length === 0) return fail('Escolha as entregas da rota.');
          const list = ids.map((id) => get().ownDeliveries.find((d) => d.id === id));
          if (list.some((d) => !d || d.status !== 'READY')) return fail('Só entregas prontas saem para entrega.');
          const ts = nowISO();
          const updated = list.map((d) => ({ ...d!, status: 'OUT' as const, courier_id: courier.id, courier_fee: courier.fee_per_delivery, out_at: ts }));
          const byId = new Map(updated.map((d) => [d.id, d]));
          set((s) => ({
            ownDeliveries: s.ownDeliveries.map((d) => byId.get(d.id) ?? d),
            outbox: [...s.outbox, ...updated.map((d) => syncEvent('own_deliveries', 'UPDATE', d))],
          }));
          return { ok: true, data: updated };
        },

        cancelOwnDelivery: (deliveryId, auth) => {
          const d = get().ownDeliveries.find((x) => x.id === deliveryId);
          if (!d) return fail('Entrega não encontrada.');
          if (d.status === 'DELIVERED' || d.status === 'CANCELED') return fail('Entrega já encerrada.');
          const order = get().orders.find((o) => o.id === d.order_id);
          if (order && order.status !== 'CLOSED' && order.status !== 'CANCELED') {
            // Conta em aberto: desfaz a senha (PIN de gerente, itens auditados) e a entrega sai junto.
            const voided = get().voidPickupOrder(d.order_id, auth);
            if (!voided.ok) return voided;
          } else {
            // Conta já paga (ou já desfeita no caixa): só a entrega sai do quadro, com PIN de gerente.
            // O estorno do dinheiro, se houver, é feito à parte no caixa.
            const authRes = authorizeManager(auth, { orderId: d.order_id, action: 'ITEM_CANCELED' });
            if (!authRes.ok) return authRes;
          }
          cancelDeliveryOf(d.order_id);
          return { ok: true, data: undefined };
        },

        settleCourier: (courierId, opts) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!CASH_ROLES.includes(user.role)) return fail('Só caixa, gerente ou proprietário acerta com o entregador.');
          const courier = get().couriers.find((c) => c.id === courierId);
          if (!courier) return fail('Entregador não encontrado.');
          const own = get().ownDeliveries.filter((d) => d.courier_id === courierId && d.status === 'DELIVERED' && d.settlement_id === null);
          if (own.length === 0) return fail('Nenhuma entrega para acertar.');
          const feesCents = own.reduce((a, d) => a + toCents(d.courier_fee ?? 0), 0);
          if (opts.payFromDrawer && feesCents > 0) {
            const open = get().cashSessions.find((c) => c.status === 'OPEN');
            if (!open) return fail('Abra o caixa para pagar o entregador com o dinheiro da gaveta.');
            if (!opts.auth) return fail('Pagar o entregador pelo caixa é sangria: precisa do PIN do gerente.');
          }
          // O PIN da sangria é conferido antes de receber qualquer conta: PIN errado não deixa acerto pela metade.
          const withdrawalAuth = opts.payFromDrawer && feesCents > 0
            ? {
                managerPin: opts.auth!.managerPin,
                reason: opts.auth!.reason.trim().length >= MIN_REASON_LENGTH ? opts.auth!.reason : `Acerto do entregador ${courier.name}`,
              }
            : null;
          if (withdrawalAuth) {
            const pre = authorizeManager(withdrawalAuth, { orderId: null, action: 'CASH_WITHDRAWAL' });
            if (!pre.ok) return pre;
          }
          // 1) O dinheiro que o entregador trouxe vira o pagamento de cada senha paga na entrega.
          // Senha já recebida numa tentativa anterior deste acerto (que parou no meio) não paga de novo,
          // mas o dinheiro dela conta no acerto (pela chave entrega-<id> do pagamento).
          for (const d of own) {
            if (!d.pay_on_delivery) continue;
            const order = get().orders.find((o) => o.id === d.order_id);
            if (!order || order.status !== 'PAYING' || !(order.remaining_balance > 0)) continue;
            const amount = order.remaining_balance;
            const r = get().registerPayment({
              orderId: order.id,
              amount,
              method: 'CASH',
              status: 'APPROVED',
              terminal_id: null,
              acquirer: 'CASH_DESK',
              acquirer_cnpj: null,
              card_brand: null,
              nsu: null,
              authorization_code: null,
              terminal_serial: null,
              idempotency_key: `entrega-${d.id}`,
              item_ids: [],
            });
            if (!r.ok) return fail(`Senha ${order.pickup_number ?? ''}: ${r.error} Acerto parado; as anteriores já foram recebidas.`);
          }
          const keys = new Set(own.filter((d) => d.pay_on_delivery).map((d) => `entrega-${d.id}`));
          const cashCents = get().payments
            .filter((p) => p.status === 'APPROVED' && p.idempotency_key !== null && keys.has(p.idempotency_key))
            .reduce((a, p) => a + toCents(p.amount), 0);
          // 2) O ganho do entregador sai da gaveta (sangria com PIN de gerente).
          let movementId: UUID | null = null;
          if (opts.payFromDrawer && feesCents > 0) {
            const wd = get().addCashWithdrawal(fromCentsLocal(feesCents), withdrawalAuth!);
            if (!wd.ok) return fail(`${wd.error} As senhas já foram recebidas; pague o entregador e acerte de novo sem a gaveta.`);
            movementId = wd.data.id;
          }
          const settlement: CourierSettlement = {
            id: uuid(),
            tenant_id: get().tenant.id,
            courier_id: courierId,
            deliveries: own.length,
            cash_collected: fromCentsLocal(cashCents),
            courier_fees: fromCentsLocal(feesCents),
            cash_movement_id: movementId,
            settled_by_user_id: user.id,
            created_at: nowISO(),
          };
          const ids = new Set(own.map((d) => d.id));
          const settledRows = own.map((d) => ({ ...d, settlement_id: settlement.id }));
          set((s) => ({
            courierSettlements: [settlement, ...s.courierSettlements],
            ownDeliveries: s.ownDeliveries.map((d) => (ids.has(d.id) ? { ...d, settlement_id: settlement.id } : d)),
            outbox: [...s.outbox, syncEvent('courier_settlements', 'INSERT', settlement), ...settledRows.map((d) => syncEvent('own_deliveries', 'UPDATE', d))],
          }));
          return { ok: true, data: settlement };
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

        importPurchaseInvoice: (xml, decisions) => {
          const user = currentUser();
          if (!user) return fail('Sessão expirada. Faça login novamente.');
          if (!MANAGER_ROLES.includes(user.role)) return fail('Só gerente ou proprietário pode dar entrada em nota de compra.');
          let plan: PurchaseImportPlan;
          try {
            // O XML é lido de novo aqui: o que entra no estoque é o que está na nota, não o que estava na tela.
            const nfe = parsePurchaseNfeXml(xml);
            const s = get();
            plan = planPurchaseImport(
              {
                tenant: s.tenant,
                categories: s.categories,
                products: s.products,
                suppliers: s.suppliers,
                purchaseInvoices: s.purchaseInvoices,
                supplierProductLinks: s.supplierProductLinks,
                stockMovements: s.stockMovements,
              },
              nfe,
              decisions,
              { userId: user.id, now: nowISO(), newId: uuid, nextProductCode: nextPurchaseProductCode },
            );
          } catch (e) {
            return fail(e instanceof NfeImportError || e instanceof Error ? e.message : 'Falha ao ler o XML.');
          }
          const p = plan;
          let duplicated = false;
          set((s) => {
            // Mesma checagem dentro do set(): duas confirmações seguidas não gravam a nota duas vezes.
            if (s.purchaseInvoices.some((i) => i.tenant_id === p.invoice.tenant_id && i.access_key === p.invoice.access_key)) {
              duplicated = true;
              return {};
            }
            const updatedById = new Map(p.updatedProducts.map((u) => [u.id, u]));
            const linkIds = new Set(p.links.map((l) => l.id));
            const existingLinkIds = new Set(s.supplierProductLinks.map((l) => l.id));
            return {
              suppliers: p.supplierIsNew ? [...s.suppliers, p.supplier] : s.suppliers,
              products: [...s.products.map((prod) => updatedById.get(prod.id) ?? prod), ...p.createdProducts],
              purchaseInvoices: [p.invoice, ...s.purchaseInvoices],
              purchaseInvoiceItems: [...s.purchaseInvoiceItems, ...p.items],
              stockMovements: [...s.stockMovements, ...p.movements],
              supplierProductLinks: [...s.supplierProductLinks.filter((l) => !linkIds.has(l.id)), ...p.links],
              outbox: [
                ...s.outbox,
                ...(p.supplierIsNew ? [syncEvent('suppliers', 'INSERT', p.supplier)] : []),
                ...p.createdProducts.map((prod) => syncEvent('products', 'INSERT', prod)),
                ...p.updatedProducts.map((prod) => syncEvent('products', 'UPDATE', prod)),
                syncEvent('purchase_invoices', 'INSERT', p.invoice),
                ...p.items.map((i) => syncEvent('purchase_invoice_items', 'INSERT', i)),
                ...p.movements.map((m) => syncEvent('stock_movements', 'INSERT', m)),
                ...p.links.map((l) => syncEvent('supplier_product_links', existingLinkIds.has(l.id) ? 'UPDATE' : 'INSERT', l)),
              ],
            };
          });
          if (duplicated) return fail('Esta NF-e já foi importada.');
          return { ok: true, data: p };
        },
      };
    },
    {
      name: 'tchefood-state-v1',
      // v2 = Etapa 0 (cadastros e nuvem); v3 = Fase 5 (barril, fichas, balança, cashback);
      // v4 = totem / pedido com senha; v5 = compras por XML (estoque, código de barras);
      // v6 = combos; v7 = nuvem → aparelho (pullStatus);
      // v8 = caixa (abertura, sangria, suprimento, fechamento); v9 = preço conferido pelo servidor;
      // v10 = entrega própria; v11 = avaliações dos clientes; v12 = resgate de cashback pela função do servidor.
      version: 12,
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
  let out: Record<string, unknown> = st;
  if (version < 4) {
    // Totem: comandas ganham os campos de senha (null) e a loja ganha a mesa técnica KIOSK.
    out = migrateToKiosk(st as Partial<TcheState>) as Record<string, unknown>;
  }
  if (version < 5) {
    // Compras por XML: produtos ganham estoque e código de barras; listas de compra vazias.
    if (Array.isArray(out.products)) {
      out.products = (out.products as Array<Record<string, unknown>>).map((p) => ({
        ...p,
        cost_price: typeof p.cost_price === 'number' ? p.cost_price : 0,
        stock_quantity: typeof p.stock_quantity === 'number' ? p.stock_quantity : 0,
        barcode: typeof p.barcode === 'string' ? p.barcode : null,
      }));
    }
    for (const key of ['suppliers', 'purchaseInvoices', 'purchaseInvoiceItems', 'stockMovements', 'supplierProductLinks']) {
      if (!Array.isArray(out[key])) out[key] = [];
    }
  }
  if (version < 6) {
    // Combos: nada vira combo sozinho; opções e itens ficam como eram.
    const fill = (key: string, f: (r: Record<string, unknown>) => Record<string, unknown>) => {
      if (Array.isArray(out[key])) out[key] = (out[key] as Array<Record<string, unknown>>).map(f);
    };
    fill('products', (p) => ({ ...p, is_combo: p.is_combo === true }));
    fill('modifierOptions', (o) => ({
      ...o,
      component_product_id: typeof o.component_product_id === 'string' ? o.component_product_id : null,
      component_quantity: typeof o.component_quantity === 'number' ? o.component_quantity : 1,
    }));
    fill('orderItems', (i) => ({ ...i, combo_parent_item_id: typeof i.combo_parent_item_id === 'string' ? i.combo_parent_item_id : null }));
  }
  if (version < 7) {
    out.pullStatus = out.pullStatus ?? EMPTY_PULL_STATUS;
  }
  if (version < 8) {
    // Caixa: listas vazias (a loja abre o primeiro caixa depois da atualização).
    for (const key of ['cashSessions', 'cashMovements']) {
      if (!Array.isArray(out[key])) out[key] = [];
    }
  }
  if (version < 9) {
    // A regra do meio a meio deixa de ser do aparelho e passa a ser da loja.
    const rule = out.halfAndHalfPricing === 'AVERAGE' ? 'AVERAGE' : 'HIGHEST';
    if (out.tenant && typeof out.tenant === 'object') {
      const t = out.tenant as Record<string, unknown>;
      const migrated: Record<string, unknown> = { ...t, half_and_half_pricing: t.half_and_half_pricing === 'AVERAGE' || t.half_and_half_pricing === 'HIGHEST' ? t.half_and_half_pricing : rule };
      out.tenant = migrated;
      // Loja já ligada à nuvem com "média": o banco nasce com "maior preço" e o próximo download
      // trocaria a regra em silêncio. Sobe a regra do aparelho antes.
      if (out.cloud && migrated.half_and_half_pricing === 'AVERAGE' && typeof migrated.id === 'string') {
        const queue = Array.isArray(out.outbox) ? (out.outbox as unknown[]) : [];
        out.outbox = [...queue, syncEvent('tenants', 'UPDATE', migrated as { id: UUID })];
      }
    }
    delete out.halfAndHalfPricing;
    if (Array.isArray(out.orderItems)) {
      out.orderItems = (out.orderItems as Array<Record<string, unknown>>).map((i) => ({
        ...i,
        priced_at: typeof i.priced_at === 'string' ? i.priced_at : null,
        half_product_ids: Array.isArray(i.half_product_ids) ? i.half_product_ids : [],
        modifier_option_ids: Array.isArray(i.modifier_option_ids) ? i.modifier_option_ids : [],
      }));
    }
  }
  if (version < 10) {
    // Entrega própria: a loja cadastra bairros e entregadores depois da atualização.
    for (const key of ['deliveryZones', 'couriers', 'ownDeliveries', 'courierSettlements']) {
      if (!Array.isArray(out[key])) out[key] = [];
    }
  }
  if (version < 11) {
    if (!Array.isArray(out.reviews)) out.reviews = [];
  }
  if (version < 12) {
    const auditLogs = Array.isArray(out.auditLogs) ? (out.auditLogs as AuditLog[]) : [];
    const outbox = Array.isArray(out.outbox) ? (out.outbox as SyncEvent[]) : [];
    const rejected = Array.isArray(out.syncRejected) ? (out.syncRejected as RejectedSyncEvent[]) : [];
    const queued = migrateCashbackRedeemQueue([...rejected.map((r) => r.event), ...outbox], auditLogs);
    const rejectedIds = new Set(rejected.map((r) => r.event.id));
    out.syncRejected = rejected.flatMap((r) => {
      const ev = queued.find((e) => e.id === r.event.id);
      return ev ? [{ ...r, event: ev }] : [];
    });
    out.outbox = queued.filter((e) => !rejectedIds.has(e.id));
  }
  return out;
}

/**
 * Fila gravada antes da v12: o resgate de cashback subia em três partes (audit_log
 * CASHBACK_REDEEMED, baixa dos créditos por UPDATE e o REDEEM). Agora sobe numa chamada
 * (tchefood_register_cashback_redeem), que faz as três no banco. O REDEEM ganha o id do
 * audit_log do resgate; o audit_log e as baixas ainda na fila saem dela (o banco recusaria
 * a baixa direta). Se o audit_log já tinha subido, a função usa o que está gravado; se
 * parte das baixas já tinha subido, a função só conta esse crédito como já baixado com a
 * prova na nuvem (o audit_log deste resgate, desta conta, cliente e valor) e sem dúvida de
 * a qual resgate ele pertence; senão recusa e o gerente concilia (legacy_predebited).
 */
export function migrateCashbackRedeemQueue(events: SyncEvent[], auditLogs: AuditLog[]): SyncEvent[] {
  const redeems = events.filter((e) => e.table === 'cashback_ledger' && e.op === 'INSERT' && e.payload.entry_type === 'REDEEM' && !e.cashback_redeem);
  if (!redeems.length) return events;
  const orderIds = new Set(redeems.map((e) => String(e.payload.order_id)));
  const auditFor = (orderId: string) =>
    events.find((e) => e.table === 'audit_logs' && e.op === 'INSERT' && e.payload.action_type === 'CASHBACK_REDEEMED' && e.payload.order_id === orderId)?.row_id ??
    auditLogs.find((l) => l.action_type === 'CASHBACK_REDEEMED' && l.order_id === orderId)?.id;
  return events.flatMap((e) => {
    if (e.table === 'cashback_ledger' && e.op === 'UPDATE' && e.depends_on_order_id && orderIds.has(e.depends_on_order_id)) return [];
    if (e.table === 'audit_logs' && e.op === 'INSERT' && e.payload.action_type === 'CASHBACK_REDEEMED' && orderIds.has(String(e.payload.order_id))) return [];
    if (redeems.includes(e)) {
      const audit = auditFor(String(e.payload.order_id));
      // As baixas dos créditos subiam ANTES do resgate: se parte delas já subiu, o
      // servidor encontra essa baixa sem resgate do cliente e não a consome de novo.
      return [audit ? { ...e, cashback_redeem: { audit_id: audit, legacy_predebited: true } } : e];
    }
    return [e];
  });
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
