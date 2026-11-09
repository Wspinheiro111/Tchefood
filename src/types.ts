/**
 * Tchê Food — Tipos de domínio.
 * Espelho 1:1 do schema.sql (db/schema.sql). Nomes de entidades e campos
 * são mantidos idênticos aos do PostgreSQL (snake_case) para que o mesmo
 * objeto trafegue sem mapeamento entre Zustand, IndexedDB e Supabase.
 *
 * Convenções:
 *  - UUID      -> string
 *  - NUMERIC   -> number (sempre arredondado em 2 casas; quantidade em 3)
 *  - TIMESTAMPTZ -> string ISO-8601
 *  - JSONB     -> Record<string, unknown>
 */

// ---------------------------------------------------------------------------
// ENUMS (CREATE TYPE ...)
// ---------------------------------------------------------------------------

export type UserRole = 'OWNER' | 'MANAGER' | 'CASHIER' | 'WAITER' | 'KITCHEN';
export type TableStatus = 'FREE' | 'OCCUPIED' | 'WAITING_BILL' | 'PAYING' | 'DIRTY';
export type OrderStatus = 'OPEN' | 'PAYING' | 'CLOSED' | 'CANCELED';
export type ItemStatus = 'PENDING' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELED';
export type ProductionSector = 'KITCHEN' | 'BAR' | 'GRILL' | 'DESSERT' | 'NONE';
export type PaymentMethod = 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER' | 'CASH';
export type PaymentStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'REFUNDED';
export type AcquirerType = 'STONE' | 'PAGBANK' | 'MOCK' | 'CASH_DESK';
export type OperationMode = 'SMARTPOS_EMBEDDED' | 'TEF_POS_WIRELESS';

/** Valores aceitos em order_items.origin (VARCHAR(20)). */
export type OrderItemOrigin = 'WAITER' | 'SMARTPOS' | 'QRCODE_TABLE';

export type UUID = string;
export type ISODateTime = string;

// ---------------------------------------------------------------------------
// TABELAS
// ---------------------------------------------------------------------------

export interface Tenant {
  id: UUID;
  name: string;
  legal_name: string;
  cnpj: string;
  state_registration: string | null;
  city: string;
  state: string;
  default_service_fee_pct: number;
  default_acquirer: AcquirerType;
  default_mode: OperationMode;
  focus_nfe_token: string | null;
  csc_id: string | null;
  csc_token: string | null;
  created_at: ISODateTime;
}

export interface StaffUser {
  id: UUID;
  tenant_id: UUID;
  name: string;
  role: UserRole;
  pin_code: string;
  active: boolean;
  created_at: ISODateTime;
}

export interface PosTerminal {
  id: UUID;
  tenant_id: UUID;
  name: string;
  serial_number: string;
  acquirer: AcquirerType;
  mode: OperationMode;
  online: boolean;
  battery_level: number | null;
}

export interface Category {
  id: UUID;
  tenant_id: UUID;
  name: string;
  sort_order: number;
  icon_name: string | null;
  active: boolean;
}

export interface Product {
  id: UUID;
  tenant_id: UUID;
  category_id: UUID;
  code: string;
  name: string;
  description: string | null;
  price: number;
  sector: ProductionSector;
  available: boolean;
  requires_meat_doneness: boolean;
  allows_half_and_half: boolean;
  ncm: string;
  cfop: string;
  csosn_cst: string;
  unit: string;
  /**
   * Custo unitário (CMV) em reais, NUMERIC(10,2). Mesmo campo da Fase 5.
   * A importação de XML grava aqui o custo médio ponderado arredondado em 2 casas;
   * o custo com 4 casas fica em stock_movements.unit_cost / avg_cost_after.
   */
  cost_price: number;
  /** Saldo em estoque na unidade do produto (unit), NUMERIC(12,3). */
  stock_quantity: number;
  /** GTIN/EAN do produto (cEAN da NF-e), usado para casar itens de compra. */
  barcode: string | null;
  created_at: ISODateTime;
}

export interface ModifierGroup {
  id: UUID;
  tenant_id: UUID;
  name: string;
  min_selection: number;
  max_selection: number;
  required: boolean;
}

export interface ModifierOption {
  id: UUID;
  group_id: UUID;
  name: string;
  additional_price: number;
}

/**
 * Tabela de vínculo produto ↔ grupo de modificadores.
 * O blueprint define modifier_groups e modifier_options, mas não diz a qual
 * produto cada grupo pertence; esta tabela de junção está em
 * db/schema.sql na seção "EXTENSÕES DA FASE 1".
 */
export interface ProductModifierGroup {
  product_id: UUID;
  group_id: UUID;
  sort_order: number;
}

export interface DiningTable {
  id: UUID;
  tenant_id: UUID;
  number: number;
  label: string;
  area: string;
  capacity: number;
  status: TableStatus;
  qr_code_token: string | null;
  current_order_id: UUID | null;
  updated_at: ISODateTime;
}

export interface Order {
  id: UUID;
  tenant_id: UUID;
  table_id: UUID;
  opened_by_user_id: UUID;
  status: OrderStatus;
  customer_count: number;
  customer_cpf: string | null;
  subtotal_items: number;
  charge_service_fee: boolean;
  service_fee_pct: number;
  service_fee_amount: number;
  discount_amount: number;
  total_amount: number;
  paid_amount: number;
  remaining_balance: number;
  nfce_status: string | null;
  nfce_key: string | null;
  opened_at: ISODateTime;
  closed_at: ISODateTime | null;
}

export interface OrderItem {
  id: UUID;
  order_id: UUID;
  product_id: UUID;
  waiter_id: UUID;
  quantity: number;
  unit_price: number;
  modifiers_unit_price: number;
  total_item_price: number;
  meat_doneness: string | null;
  notes: string | null;
  sector: ProductionSector;
  status: ItemStatus;
  is_paid: boolean;
  origin: OrderItemOrigin;
  created_at: ISODateTime;
  prepared_at: ISODateTime | null;
  canceled_at: ISODateTime | null;
  canceled_by_user_id: UUID | null;
  cancel_reason: string | null;
}

export interface Payment {
  id: UUID;
  order_id: UUID;
  tenant_id: UUID;
  waiter_id: UUID;
  terminal_id: UUID | null;
  amount: number;
  tip_amount: number;
  method: PaymentMethod;
  status: PaymentStatus;
  acquirer: AcquirerType;
  acquirer_cnpj: string | null;
  card_brand: string | null;
  nsu: string | null;
  authorization_code: string | null;
  terminal_serial: string | null;
  idempotency_key: string | null;
  created_at: ISODateTime;
}

// ---------------------------------------------------------------------------
// COMPRAS E ESTOQUE (db/schema_purchases.sql)
// ---------------------------------------------------------------------------

export interface Supplier {
  id: UUID;
  tenant_id: UUID;
  /** CNPJ (14) ou CPF (11), sem máscara. UNIQUE(tenant_id, document). */
  document: string;
  legal_name: string;
  trade_name: string | null;
  state_registration: string | null;
  city: string | null;
  state: string | null;
  created_at: ISODateTime;
}

/** NF-e de compra importada. UNIQUE(tenant_id, access_key) impede importar a mesma nota duas vezes. */
export interface PurchaseInvoice {
  id: UUID;
  tenant_id: UUID;
  supplier_id: UUID;
  access_key: string;
  number: string;
  series: string;
  issued_at: ISODateTime | null;
  environment: 'PRODUCTION' | 'HOMOLOGATION';
  authorization_protocol: string | null;
  products_amount: number;
  discount_amount: number;
  freight_amount: number;
  insurance_amount: number;
  other_amount: number;
  ipi_amount: number;
  icms_st_amount: number;
  invoice_amount: number;
  /** Soma do custo dos itens que entraram no estoque (itens ignorados ficam fora). */
  stocked_amount: number;
  items_count: number;
  imported_by_user_id: UUID;
  imported_at: ISODateTime;
}

export type PurchaseItemAction = 'LINK' | 'CREATE' | 'IGNORE';

export interface PurchaseInvoiceItem {
  id: UUID;
  invoice_id: UUID;
  n_item: number;
  supplier_code: string;
  barcode: string | null;
  description: string;
  ncm: string | null;
  cfop: string | null;
  commercial_unit: string;
  commercial_quantity: number;
  commercial_unit_price: number;
  gross_amount: number;
  /** Custo total do item (produto − desconto + frete + seguro + outras + IPI + ICMS-ST + FCP-ST). */
  landed_amount: number;
  action: PurchaseItemAction;
  product_id: UUID | null;
  /** Quantas unidades de estoque vêm em cada unidade comercial (CX com 12 = 12). */
  packaging_factor: number;
  stock_quantity: number;
  /** Custo por unidade de estoque, NUMERIC(12,4). */
  unit_cost: number;
}

export type StockMovementType = 'PURCHASE_IN';

/** Livro de estoque: só INSERT (o saldo do produto é a soma dos movimentos). */
export interface StockMovement {
  id: UUID;
  tenant_id: UUID;
  product_id: UUID;
  type: StockMovementType;
  quantity: number;
  unit_cost: number;
  balance_after: number;
  avg_cost_after: number;
  purchase_invoice_item_id: UUID | null;
  performed_by_user_id: UUID;
  created_at: ISODateTime;
}

/** Vínculo "código do fornecedor → produto", lembrado para as próximas notas. */
export interface SupplierProductLink {
  id: UUID;
  tenant_id: UUID;
  supplier_id: UUID;
  supplier_code: string;
  product_id: UUID;
  packaging_factor: number;
  commercial_unit: string;
  updated_at: ISODateTime;
}

/** Tipos de ação gravados em audit_logs.action_type (VARCHAR(50)). */
export type AuditActionType =
  | 'ITEM_CANCELED'
  | 'SERVICE_FEE_REMOVED'
  | 'SERVICE_FEE_RESTORED'
  | 'DISCOUNT_APPLIED'
  | 'MANAGER_PIN_FAILED'
  | 'MANAGER_PIN_LOCKOUT';

export interface AuditLog {
  id: UUID;
  tenant_id: UUID;
  order_id: UUID | null;
  performed_by_user_id: UUID;
  authorized_by_manager_id: UUID | null;
  action_type: AuditActionType;
  amount_impact: number;
  reason: string;
  whatsapp_alert_sent: boolean;
  metadata: Record<string, unknown> | null;
  created_at: ISODateTime;
}

// ---------------------------------------------------------------------------
// TIPOS DE APLICAÇÃO (não persistidos no PostgreSQL)
// ---------------------------------------------------------------------------

/** Regra de preço de pizza meio-a-meio (configurável por estabelecimento). */
export type HalfAndHalfPricing = 'HIGHEST' | 'AVERAGE';

/** Modificador escolhido na hora do lançamento. */
export interface SelectedModifier {
  group_id: UUID;
  option_id: UUID;
  name: string;
  additional_price: number;
}

/**
 * Item na bandeja de despacho: ainda NÃO foi enviado à produção.
 * Pode ser removido livremente. Ao despachar vira OrderItem (status PENDING)
 * e a partir daí só pode ser cancelado com PIN do gerente.
 */
export interface TrayItem {
  tray_id: UUID;
  order_id: UUID;
  product_id: UUID;
  /** Sabores adicionais no meio-a-meio (o produto principal é product_id). */
  half_product_ids: UUID[];
  quantity: number;
  unit_price: number;
  modifiers: SelectedModifier[];
  modifiers_unit_price: number;
  meat_doneness: string | null;
  quick_tags: string[];
  free_notes: string;
  sector: ProductionSector;
  added_at: ISODateTime;
}

/** Evento da fila offline-first, pronto para ser enviado ao Supabase. */
export interface SyncEvent {
  id: UUID;
  table:
    | 'orders'
    | 'order_items'
    | 'dining_tables'
    | 'audit_logs'
    | 'payments'
    | 'products'
    | 'suppliers'
    | 'purchase_invoices'
    | 'purchase_invoice_items'
    | 'stock_movements'
    | 'supplier_product_links';
  op: 'INSERT' | 'UPDATE';
  row_id: UUID;
  payload: Record<string, unknown>;
  created_at: ISODateTime;
}

/** Resultado padrão das ações do store que podem ser recusadas. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };
