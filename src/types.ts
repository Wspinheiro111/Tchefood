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

/** KIOSK = aparelho do totem de autoatendimento (db/schema_kiosk.sql). */
export type UserRole = 'OWNER' | 'MANAGER' | 'CASHIER' | 'WAITER' | 'KITCHEN' | 'KIOSK';
export type TableStatus = 'FREE' | 'OCCUPIED' | 'WAITING_BILL' | 'PAYING' | 'DIRTY';
export type OrderStatus = 'OPEN' | 'PAYING' | 'CLOSED' | 'CANCELED';
export type ItemStatus = 'PENDING' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELED';
export type ProductionSector = 'KITCHEN' | 'BAR' | 'GRILL' | 'DESSERT' | 'NONE';
export type PaymentMethod = 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER' | 'CASH';
export type PaymentStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'REFUNDED';
export type AcquirerType = 'STONE' | 'PAGBANK' | 'MOCK' | 'CASH_DESK';
export type OperationMode = 'SMARTPOS_EMBEDDED' | 'TEF_POS_WIRELESS';

/** Valores aceitos em order_items.origin (VARCHAR(20)). */
export type OrderItemOrigin = 'WAITER' | 'SMARTPOS' | 'QRCODE_TABLE' | 'KIOSK';

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
  /** Preço do meio a meio: o maior sabor ou a média (db/schema_dinheiro_servidor.sql). */
  half_and_half_pricing: HalfAndHalfPricing;
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
  /** Etapa 0: produto com venda nunca é apagado, só desativado (some do cardápio). */
  active: boolean;
  created_at: ISODateTime;
  // Fase 5 (schema_expansion.sql)
  /** Buffet a quilo: price é o preço do KG e a quantidade vem da balança. */
  sold_by_weight: boolean;
  /** Tara padrão do prato/recipiente, em gramas. */
  tare_weight_grams: number;
  // Combos (db/schema_combos.sql)
  /**
   * Combo: price é o preço do combo, e cada opção escolhida nos grupos do combo que
   * aponta para um produto (ModifierOption.component_product_id) vira um item de
   * produção à parte (preço zero, setor do componente), ligado ao item do combo.
   */
  is_combo: boolean;
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
  /** Volume servido por esta opção de tamanho (ex.: chopp 300/500/1000 ml). */
  volume_ml: number | null;
  /**
   * Combo: produto que esta opção coloca no pedido (ex.: "Refrigerante lata" no grupo
   * "Bebida do combo"). Só vale em produto combo; additional_price é o acréscimo da troca.
   */
  component_product_id: UUID | null;
  /** Quantas unidades do componente cada combo leva (inteiro, 1 a 20). */
  component_quantity: number;
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
  /** Etapa 0: mesa desativada some do mapa; só mesa livre pode ser desativada. */
  active: boolean;
  updated_at: ISODateTime;
  /**
   * COUNTER = mesa técnica da venda de balcão/eventos (nunca ocupada, fora do mapa).
   * KIOSK = mesa técnica dos pedidos com senha (totem e pedido no caixa), que vão para o KDS.
   * CARD = cartão de comanda numerado (o cliente anda com o cartão; a conta é como a da mesa).
   */
  kind: DiningTableKind;
}

export type DiningTableKind = 'TABLE' | 'COUNTER' | 'KIOSK' | 'CARD';

/** Pedido com senha: comer no salão ou levar. */
/** DELIVERY = entrega própria (motoboy da casa), db/schema_entrega.sql. */
export type FulfillmentType = 'DINE_IN' | 'TAKEOUT' | 'DELIVERY';

/**
 * Etapa 0 — preço por dia da semana e horário (happy hour, almoço executivo).
 * weekdays: 0 = domingo ... 6 = sábado (Date.getDay()). Horários "HH:MM" no fuso
 * do aparelho da loja. end_time < start_time = janela que vira a meia-noite.
 */
export interface PriceSchedule {
  id: UUID;
  tenant_id: UUID;
  product_id: UUID;
  name: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  price: number;
  active: boolean;
  created_at: ISODateTime;
}

/** Etapa 0 — permissões configuráveis por perfil. */
export type Permission =
  | 'MENU_MANAGE'
  | 'MENU_AVAILABILITY'
  | 'TABLES_MANAGE'
  | 'STAFF_MANAGE'
  | 'STORE_SETTINGS'
  | 'SYNC_MANAGE';

/** Exceção ao padrão de permissões (tabela role_permissions). */
export interface RolePermission {
  tenant_id: UUID;
  role: UserRole;
  permission: Permission;
  allowed: boolean;
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
  // Pedido com senha (db/schema_kiosk.sql). Null nas comandas de mesa e nas fichas de balcão.
  /** Senha chamada no painel da TV (1 a 999, reinicia todo dia). */
  pickup_number: number | null;
  /** Primeiro nome para chamar o cliente (opcional). */
  pickup_name: string | null;
  fulfillment_type: FulfillmentType | null;
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
  // Fase 5 (schema_expansion.sql)
  /** Leitura bruta da balança (gramas). Só em produtos sold_by_weight. */
  weight_gross_grams: number | null;
  weight_tare_grams: number | null;
  weight_source: WeightSource | null;
  /** Volume que cada unidade tira do barril (ml); null se não sai de torneira. */
  keg_volume_ml: number | null;
  /**
   * Combos: item de produção de um combo (preço zero) aponta para o item do combo,
   * que leva o preço e vai para a NFC-e. null em item comum e no próprio combo.
   */
  combo_parent_item_id: UUID | null;
  // Para o banco refazer a conta do preço (db/schema_dinheiro_servidor.sql)
  /** Quando o preço foi tirado do cadastro (item na bandeja); null = created_at. */
  priced_at: ISODateTime | null;
  /** Sabores do meio a meio além do produto principal. */
  half_product_ids: UUID[];
  /** Adicionais escolhidos (opções de modificador). */
  modifier_option_ids: UUID[];
}

export type WeightSource = 'SCALE' | 'MANUAL';

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
  | 'MANAGER_PIN_LOCKOUT'
  | 'KEG_CHANGED'
  | 'CASHBACK_REDEEMED'
  | 'CASHBACK_REFUNDED'
  | 'CASHBACK_REFUND_HELD'
  | 'KIOSK_EXIT'
  | 'CHARGE_CONFIRMED_MANUALLY'
  // Etapa 0 — cadastros
  | 'PRODUCT_PRICE_CHANGED'
  | 'STAFF_CREATED'
  | 'STAFF_PIN_CHANGED'
  | 'STAFF_ROLE_CHANGED'
  | 'STAFF_DEACTIVATED'
  | 'STAFF_REACTIVATED'
  | 'PERMISSION_CHANGED'
  | 'STORE_RESET'
  // Caixa (db/schema_caixa.sql)
  | 'CASH_WITHDRAWAL'
  | 'CASH_CLOSE_DIFFERENCE'
  // Item com preço diferente do cadastro aceito com PIN de gerente (db/schema_preco_gerente.sql)
  | 'PRICE_OVERRIDE';

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
  /**
   * Ordem de gravação no servidor (db/schema_expansion.sql). Dada pelo banco, nunca
   * pelo aparelho: o registro local não tem, e a fila não envia.
   */
  server_seq?: number;
}

// ---------------------------------------------------------------------------
// FASE 5 — EXPANSÃO ENTERPRISE (db/schema_expansion.sql)
// ---------------------------------------------------------------------------

export interface KegTap {
  id: UUID;
  tenant_id: UUID;
  tap_number: number;
  beer_name: string;
  total_capacity_ml: number;
  /** Faturado no caixa desde o engate (sem teto: passar da capacidade é alerta). */
  billed_volume_ml: number;
  /** Sangria, espuma e chopp servido e cancelado. */
  wasted_foam_ml: number;
  /** Coluna gerada: max(capacidade − faturado − desperdício, 0). */
  remaining_volume_ml: number;
  measured_remaining_ml: number | null;
  measured_at: ISODateTime | null;
  keg_cost: number;
  active: boolean;
  tapped_at: ISODateTime;
}

export interface KegTapProduct {
  tap_id: UUID;
  product_id: UUID;
  pour_ml: number;
}

export interface KegHistory {
  id: UUID;
  tenant_id: UUID;
  tap_id: UUID;
  tap_number: number;
  beer_name: string;
  total_capacity_ml: number;
  billed_volume_ml: number;
  wasted_foam_ml: number;
  measured_remaining_ml: number | null;
  keg_cost: number;
  tapped_at: ISODateTime;
  kicked_at: ISODateTime;
  kicked_by_user_id: UUID;
  authorized_by_manager_id: UUID;
}

export interface EventTicket {
  id: UUID;
  tenant_id: UUID;
  order_id: UUID;
  order_item_id: UUID;
  payment_id: UUID | null;
  product_id: UUID;
  product_name_snapshot: string;
  unit_price: number;
  ticket_seq: number;
  barcode_token: string;
  redeemed: boolean;
  redeemed_at: ISODateTime | null;
  redeemed_by_user_id: UUID | null;
  voided_at: ISODateTime | null;
  voided_reason: string | null;
  created_at: ISODateTime;
}

export interface LoyaltyCustomer {
  id: UUID;
  tenant_id: UUID;
  name: string | null;
  /** 55 + DDD + número, só dígitos (ex.: 5555999991234). */
  phone_whatsapp: string;
  cpf: string | null;
  whatsapp_opt_in: boolean;
  opt_in_at: ISODateTime | null;
  cashback_balance: number;
  total_spent: number;
  visits_count: number;
  last_visit_at: ISODateTime | null;
  created_at: ISODateTime;
}

/** REFUND: cashback devolvido ao cliente quando um cancelamento deixa o desconto abaixo do resgate (crédito como o EARN). */
/** HOLD: parte de um resgate que saiu da conta sem origem comprovada, retida para conciliação (sem saldo nem validade). */
/**
 * SETTLE: baixa sem resgate conciliada pelo gerente (débito explicado, sem saldo nem validade).
 * Gravado só pelo banco (tchefood_reconcile_cashback); a liberação ao cliente é um REFUND sem conta.
 */
export type CashbackEntryType = 'EARN' | 'REDEEM' | 'EXPIRE' | 'REFUND' | 'HOLD' | 'SETTLE';

export interface CashbackLedgerEntry {
  id: UUID;
  tenant_id: UUID;
  customer_id: UUID;
  order_id: UUID | null;
  entry_type: CashbackEntryType;
  amount: number;
  remaining_amount: number;
  base_amount: number | null;
  pct: number | null;
  valid_from: ISODateTime | null;
  expires_at: ISODateTime | null;
  created_by_user_id: UUID | null;
  created_at: ISODateTime;
  /** REDEEM: de quais créditos saiu (gravado pelo banco; source_id nulo = origem desconhecida). */
  redeem_sources?: CashbackRedeemSource[] | null;
  /** REFUND: de qual crédito é esta devolução (vence com ele). */
  refund_of_id?: UUID | null;
  /**
   * Só no espelho do estorno feito neste aparelho (não existe no banco): o evento da fila
   * (atualização da conta) que faz o banco gravar este estorno. Enquanto ele não subir, o
   * crédito não existe na nuvem. O estorno lido da nuvem não tem este campo.
   */
  source_event_id?: UUID;
}

export interface CashbackRedeemSource {
  source_id: UUID | null;
  amount: number;
}

// ---------------------------------------------------------------------------
// ENTREGA PRÓPRIA (db/schema_entrega.sql)
// ---------------------------------------------------------------------------

/** Bairro atendido e a taxa de entrega dele. */
export interface DeliveryZone {
  id: UUID;
  tenant_id: UUID;
  name: string;
  fee: number;
  /** Tempo estimado de entrega em minutos (mostrado ao cliente). */
  eta_minutes: number;
  active: boolean;
}

/** Entregador da casa e quanto ganha por entrega. */
export interface Courier {
  id: UUID;
  tenant_id: UUID;
  name: string;
  phone: string | null;
  fee_per_delivery: number;
  active: boolean;
}

export type OwnDeliveryStatus = 'PREPARING' | 'READY' | 'OUT' | 'DELIVERED' | 'CANCELED';

/** Entrega própria de um pedido com senha (fulfillment_type DELIVERY). */
export interface OwnDelivery {
  id: UUID;
  tenant_id: UUID;
  order_id: UUID;
  customer_name: string;
  customer_phone: string;
  address: string;
  reference: string | null;
  zone_id: UUID;
  /** Retrato do bairro e da taxa no pedido (o cadastro pode mudar depois). */
  zone_name: string;
  delivery_fee: number;
  /** Paga em dinheiro na entrega (o entregador recebe e acerta na volta). */
  pay_on_delivery: boolean;
  /** Troco para (dinheiro na entrega). */
  change_for: number | null;
  status: OwnDeliveryStatus;
  courier_id: UUID | null;
  /** Retrato do valor da entrega do entregador na saída. */
  courier_fee: number | null;
  out_at: ISODateTime | null;
  delivered_at: ISODateTime | null;
  settlement_id: UUID | null;
  created_at: ISODateTime;
}

/** Acerto com o entregador: dinheiro que ele trouxe e o que ele ganhou. */
/** Onde o cliente deu a nota: na mesa (garçom), no balcão (Ficha Rápida / caixa). */
export type ReviewSource = 'TABLE' | 'COUNTER';

/** Avaliação do cliente (nota 1 a 5) depois de pagar. Somente inserção (db/schema_avaliacoes.sql). */
export interface Review {
  id: UUID;
  tenant_id: UUID;
  order_id: UUID;
  score: 1 | 2 | 3 | 4 | 5;
  comment: string | null;
  source: ReviewSource;
  created_at: ISODateTime;
}

export interface CourierSettlement {
  id: UUID;
  tenant_id: UUID;
  courier_id: UUID;
  deliveries: number;
  /** Dinheiro das entregas pagas na entrega (vira pagamento das senhas). */
  cash_collected: number;
  /** Soma do que o entregador ganhou nas entregas acertadas. */
  courier_fees: number;
  /** Sangria do caixa que pagou o entregador (null = pago por fora). */
  cash_movement_id: UUID | null;
  settled_by_user_id: UUID;
  created_at: ISODateTime;
}

// ---------------------------------------------------------------------------
// CAIXA (db/schema_caixa.sql)
// ---------------------------------------------------------------------------

export type CashSessionStatus = 'OPEN' | 'CLOSED';

/** Turno de caixa: abre com o fundo de troco e fecha com a contagem cega. Um aberto por loja. */
export interface CashSession {
  id: UUID;
  tenant_id: UUID;
  opened_by_user_id: UUID;
  opened_at: ISODateTime;
  /** Fundo de troco colocado na gaveta na abertura. */
  opening_float: number;
  status: CashSessionStatus;
  closed_by_user_id: UUID | null;
  closed_at: ISODateTime | null;
  /** O que o operador contou na gaveta (fechamento cego: digitado antes de ver o esperado). */
  counted_cash: number | null;
  /** Fundo + vendas em dinheiro + suprimentos − sangrias. Na nuvem quem calcula é o banco. */
  expected_cash: number | null;
  /** Contado − esperado (negativo = faltou). */
  difference: number | null;
  closing_notes: string | null;
  /** Gerente que autorizou fechar com diferença. */
  closing_authorized_by_manager_id: UUID | null;
}

/** SUPPLY = suprimento (entra dinheiro); WITHDRAWAL = sangria/retirada (sai dinheiro, com PIN de gerente). */
export type CashMovementType = 'SUPPLY' | 'WITHDRAWAL';

/** Movimento de dinheiro do caixa fora das vendas. Somente inserção. */
export interface CashMovement {
  id: UUID;
  tenant_id: UUID;
  session_id: UUID;
  type: CashMovementType;
  amount: number;
  reason: string;
  performed_by_user_id: UUID;
  authorized_by_manager_id: UUID | null;
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
  /** Leitura da balança (buffet a quilo). */
  weight?: { gross_grams: number; tare_grams: number; source: WeightSource } | null;
}

/** Situação do documento NFC-e no servidor (nfce_documents.status, emit-nfce). */
export type NfceCloudStatus = 'processing' | 'authorized' | 'rejected' | 'contingency' | 'cancelled';

/** Parte do payload transmitido que o DANFE da bobina imprime (conferida ao chegar). */
export interface NfceDanfePayload {
  items: Array<{
    numero_item: number;
    codigo_produto: string;
    descricao: string;
    unidade_comercial: string;
    quantidade_comercial: number;
    valor_unitario_comercial: number;
    valor_bruto: number;
  }>;
  valor_produtos: number;
  valor_desconto: number;
  valor_outras_despesas: number;
  valor_total: number;
  formas_pagamento: Array<{ forma_pagamento: string; valor_pagamento: number }>;
  cpf_destinatario?: string;
  /** CNPJ do emitente transmitido (o mesmo da chave). */
  cnpj_emitente?: string;
}

/** Resultado da última chamada à emit-nfce que não trouxe documento. */
export type NfceCallProblem = 'invalid' | 'not_found' | 'conflict' | 'error' | 'network';

/**
 * NFC-e real de uma comanda, como a Edge Function emit-nfce respondeu. Tudo o que é
 * fiscal (chave, protocolo, número, QR Code) vem do servidor; o aparelho só guarda.
 */
export interface NfceIssuer {
  name: string;
  legal_name: string;
  /** Só letras e dígitos (14). */
  cnpj: string;
  state_registration: string | null;
  city: string;
  state: string;
}

export interface NfceCloudRecord {
  order_id: UUID;
  /** Status do documento no servidor; null enquanto não houve documento. */
  status: NfceCloudStatus | null;
  environment: 'homologacao' | 'producao' | null;
  access_key: string | null;
  protocol: string | null;
  number: number | null;
  series: string | null;
  /** QR Code assinado da SEFAZ para esta chave (já conferido). */
  qrcode_url: string | null;
  /** Caminho do DANFE na Focus (relativo ao ambiente). */
  danfe_path: string | null;
  /** data_emissao enviada à SEFAZ. */
  issued_at: ISODateTime | null;
  /** Itens, valores e pagamentos como foram transmitidos (o DANFE sai daqui). */
  payload: NfceDanfePayload | null;
  /**
   * Emitente (nome, razão social, IE, cidade) como estava no cadastro quando o documento
   * apareceu pela primeira vez. O cabeçalho do DANFE sai daqui, não do cadastro atual.
   */
  issuer?: NfceIssuer | null;
  message: string | null;
  /** null = a última chamada trouxe o documento; senão, o que deu errado nela. */
  problem: NfceCallProblem | null;
  /** Chamadas feitas pelo aparelho (para o intervalo entre consultas). */
  attempts: number;
  /** Próxima chamada automática; null = só pelo botão. */
  next_attempt_at: ISODateTime | null;
  updated_at: ISODateTime;
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
    | 'keg_taps'
    | 'keg_history'
    | 'event_tickets'
    | 'loyalty_customers'
    | 'cashback_ledger'
    // Etapa 0 — cadastros
    | 'tenants'
    | 'staff_users'
    | 'pos_terminals'
    | 'categories'
    | 'products'
    // Compras por XML
    | 'suppliers'
    | 'purchase_invoices'
    | 'purchase_invoice_items'
    | 'stock_movements'
    | 'supplier_product_links'
    | 'modifier_groups'
    | 'modifier_options'
    | 'product_modifier_groups'
    | 'price_schedules'
    | 'role_permissions'
    // Cardápio em realidade aumentada (db/schema_ar.sql)
    | 'product_ar_models'
    | 'ar_engagement_events'
    // Caixa (db/schema_caixa.sql)
    | 'cash_sessions'
    | 'cash_movements'
    // Entrega própria (db/schema_entrega.sql)
    | 'delivery_zones'
    | 'couriers'
    | 'own_deliveries'
    | 'courier_settlements'
    // Avaliações (db/schema_avaliacoes.sql)
    | 'reviews';
  /** DELETE só para linhas sem valor financeiro (vínculos e opções de adicional). */
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  row_id: UUID;
  payload: Record<string, unknown>;
  created_at: ISODateTime;
  /**
   * Só na autorização de gerente (cancelamento, desconto, remoção dos 10%, cobrança
   * incerta pelo comprovante, saída do totem, troca de barril): o PIN digitado, para
   * o servidor conferir de novo em tchefood_authorize_manager() / tchefood_change_keg().
   * Fica só neste evento da fila (nunca no audit_log) e sai do aparelho junto com ele.
   */
  manager_pin?: string;
  /**
   * Só em staff_users e role_permissions: o banco não aceita gravação direta da equipe
   * nem das permissões. O evento sobe pela função do servidor (tchefood_save_staff,
   * tchefood_set_role_permission), que confere o PIN de quem alterou e, quando a
   * mudança pede, o PIN do gerente. Como manager_pin, fica só na fila.
   */
  staff_auth?: StaffSyncAuth;
  /**
   * Só no barril encerrado (keg_history) da troca de barril: o barril novo e o
   * audit_log da troca. Sobe por tchefood_change_keg(), que confere o PIN do gerente
   * (manager_pin) e grava histórico, audit_log e barril novo juntos.
   */
  keg_change?: KegChangeSync;
  /**
   * Só no resgate de cashback (cashback_ledger REDEEM): o id do audit_log do resgate.
   * Sobe por tchefood_register_cashback_redeem(), que confere dia, saldo e teto,
   * baixa os créditos e grava resgate, audit_log e desconto da comanda juntos.
   */
  cashback_redeem?: {
    audit_id: UUID;
    /**
     * Fila convertida da versão anterior (antes da v12): os créditos podem já ter sido
     * baixados na nuvem sem o resgate. O servidor mede essa baixa e não consome de novo.
     */
    legacy_predebited?: boolean;
  };
  /**
   * Item de chopp: a torneira de onde sai. Segura o item atrás de uma troca de barril
   * recusada da mesma torneira (recordKeys). Não vai para o banco.
   */
  keg_tap_id?: UUID;
  /** Só no proprietário da loja nova: sobe por tchefood_start_store, com o usuário do QR. */
  store_start?: StoreStartSync;
  /**
   * Comanda de que esta mudança depende, quando o registro não aponta para ela: a
   * mesa mudada pelo pagamento ou fechamento (inclusive liberada, já sem
   * current_order_id) e o extrato/cliente do cashback resgatado naquela comanda. Se o pagamento ou a autorização daquela
   * comanda for recusado, a mesa fica segurada junto e não aparece livre na nuvem.
   */
  depends_on_order_id?: UUID;
  /**
   * Eventos da fila de que esta mudança depende: o resgate de cashback que usa o estorno
   * gerado neste aparelho pelo cancelamento (ou retirada dos 10%) de outra comanda espera o
   * evento que faz o banco gravar aquele estorno. Enquanto ele estiver na fila ou recusado, o
   * resgate fica segurado (flushOutbox); só ele, não as operações seguintes daquela comanda.
   * Não vai para o banco.
   */
  depends_on_event_ids?: UUID[];
}

export interface KegChangeSync {
  /** id do audit_log KEG_CHANGED no aparelho (o servidor grava com o mesmo id). */
  audit_id: UUID;
  beer_name: string;
  total_capacity_ml: number;
  keg_cost: number;
  reason: string;
}

export interface StaffSyncAuth {
  actor_id: UUID;
  /** PIN atual de quem fez a alteração (prova para o servidor de que foi essa pessoa). */
  actor_pin: string;
  /** PIN do gerente/proprietário que autorizou; null quando a mudança não pede. */
  manager_pin: string | null;
  reason: string | null;
}

export interface StoreStartSync {
  qr_user_id: UUID | null;
  reason: string;
  metadata: Record<string, unknown>;
}

/** Evento que o servidor recusou (4xx): sai da fila para não travar o resto e espera revisão. */
export interface RejectedSyncEvent {
  event: SyncEvent;
  status: number;
  message: string;
  rejected_at: ISODateTime;
}

/** Resultado padrão das ações do store que podem ser recusadas. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Cardápio em realidade aumentada (db/schema_ar.sql)
// ---------------------------------------------------------------------------

/** Um item do prato com etiqueta no 3D (ex.: "Mussarela"), na posição da vista "itens do prato". */
export interface ArComponent {
  id: UUID;
  label: string;
  detail: string | null;
  /** Posição da etiqueta no modelo, em metros: "x y z" (formato do model-viewer). */
  position: string;
  /** Direção da superfície onde a etiqueta foi presa: "x y z". */
  normal: string;
}

/** Modelo 3D de um produto do cardápio. Um por produto (product_ar_models.product_id é único). */
export interface ProductArModel {
  id: UUID;
  tenant_id: UUID;
  product_id: UUID;
  /**
   * Arquivo GLB/glTF binário (Android, computador e base do iPhone).
   * https://… na nuvem (bucket product-models), ar/… para o modelo de demonstração
   * ou idb:… para o arquivo enviado e ainda guardado só neste aparelho.
   */
  glb_url: string;
  /** USDZ opcional para o Quick Look do iPhone. Sem ele o iPhone gera o USDZ a partir do GLB. */
  usdz_url: string | null;
  /** Fator aplicado ao modelo para ficar no tamanho real (1 = o arquivo já está em metros). */
  scale_factor: number;
  /** Medidas reais do prato, em centímetros, já com o fator aplicado. NUMERIC(6,1). */
  real_width_cm: number;
  real_depth_cm: number;
  real_height_cm: number;
  /** Animação do arquivo que separa as camadas (vista "itens do prato"); null = só etiquetas. */
  explode_animation: string | null;
  components: ArComponent[];
  active: boolean;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

/** O que o cliente fez com o 3D. ADD_AFTER_VIEW = pediu o produto depois de ver o 3D. */
export type ArEngagementKind = 'VIEW_3D' | 'AR_START' | 'EXPLODE' | 'ADD_AFTER_VIEW';

export interface ArEngagementEvent {
  id: UUID;
  tenant_id: UUID;
  product_id: UUID;
  table_id: UUID | null;
  kind: ArEngagementKind;
  created_at: ISODateTime;
}
