/**
 * Seed Data — Galpão Crioulo / Tchê Food (Santo Ângelo/RS)
 * Churrascaria + gastrobar gaúcho com Parrilla, Salão Principal e Deck.
 *
 * Os IDs do seed são UUIDs determinísticos para que o mesmo seed possa ser
 * carregado no Supabase (db/seed.sql pode ser gerado a partir deste arquivo).
 */
import type {
  Category,
  DiningTable,
  ModifierGroup,
  ModifierOption,
  Order,
  OrderItem,
  Payment,
  PosTerminal,
  Product,
  ProductModifierGroup,
  ProductionSector,
  StaffUser,
  Tenant,
} from '../types';
import type { PrinterConfig } from '../services/printer/escposBuilder';
import { applyOrderTotals, computeItemTotal } from '../lib/money';
import { minutesAgoISO } from '../lib/ids';

let counter = 0;
const seedIds = new Map<string, string>();
/** UUID v4 válido e estável por chave lógica (ex.: "product:101"). */
export function seedId(key: string): string {
  const existing = seedIds.get(key);
  if (existing) return existing;
  counter += 1;
  const tail = counter.toString(16).padStart(12, '0');
  const id = `7c3e0000-0000-4000-8000-${tail}`;
  seedIds.set(key, id);
  return id;
}

const T = seedId('tenant:galpao');
const created = '2026-01-15T12:00:00.000Z';

export const SEED_TENANT: Tenant = {
  id: T,
  name: 'Galpão Crioulo — Tchê Food',
  legal_name: 'Galpão Crioulo Gastronomia Campeira LTDA',
  cnpj: '48291736000155',
  state_registration: '0960123456',
  city: 'Santo Ângelo',
  state: 'RS',
  default_service_fee_pct: 10,
  default_acquirer: 'STONE',
  default_mode: 'TEF_POS_WIRELESS',
  focus_nfe_token: null,
  csc_id: null,
  csc_token: null,
  created_at: created,
};

// ---------------------------------------------------------------------------
// EQUIPE (PIN)
// ---------------------------------------------------------------------------
function staff(key: string, name: string, role: StaffUser['role'], pin: string): StaffUser {
  return {
    id: seedId(`staff:${key}`),
    tenant_id: T,
    name,
    role,
    pin_code: pin,
    active: true,
    created_at: created,
  };
}

export const SEED_STAFF: StaffUser[] = [
  staff('garcom-tiao', 'Tião', 'WAITER', '1111'),
  staff('garcom-duda', 'Duda', 'WAITER', '2222'),
  staff('garcom-pedro', 'Pedro', 'WAITER', '3333'),
  staff('caixa-lu', 'Lu (Caixa)', 'CASHIER', '5555'),
  staff('cozinha-nego', 'Parrilleiro Nego', 'KITCHEN', '7777'),
  staff('dono', 'Seu Arlindo (Dono)', 'OWNER', '8888'),
  staff('gerente', 'Gerente Rafa', 'MANAGER', '9999'),
  // Usuário técnico do Cardápio QR Code: PIN não numérico, impossível de digitar no PinPad.
  staff('qrcode', 'Autoatendimento QR Code', 'WAITER', 'QRSELF'),
];
export const QR_SELF_SERVICE_USER_ID = seedId('staff:qrcode');
const WAITER_TIAO = seedId('staff:garcom-tiao');
const WAITER_DUDA = seedId('staff:garcom-duda');

// ---------------------------------------------------------------------------
// MAQUININHAS
// ---------------------------------------------------------------------------
export const SEED_TERMINALS: PosTerminal[] = [
  {
    id: seedId('pos:stone-01'),
    tenant_id: T,
    name: 'Stone Salão 01',
    serial_number: 'STONE-01',
    acquirer: 'STONE',
    mode: 'TEF_POS_WIRELESS',
    online: true,
    battery_level: 92,
  },
  {
    id: seedId('pos:stone-02'),
    tenant_id: T,
    name: 'Stone Deck 02',
    serial_number: 'STONE-02',
    acquirer: 'STONE',
    mode: 'TEF_POS_WIRELESS',
    online: true,
    battery_level: 67,
  },
  {
    id: seedId('pos:pagbank-01'),
    tenant_id: T,
    name: 'PagBank Balcão 01',
    serial_number: 'PAGBANK-01',
    acquirer: 'PAGBANK',
    mode: 'SMARTPOS_EMBEDDED',
    online: true,
    battery_level: 81,
  },
  {
    id: seedId('pos:pagbank-02'),
    tenant_id: T,
    name: 'PagBank Parrilla 02',
    serial_number: 'PAGBANK-02',
    acquirer: 'PAGBANK',
    mode: 'SMARTPOS_EMBEDDED',
    online: false,
    battery_level: 14,
  },
];

// ---------------------------------------------------------------------------
// CARDÁPIO
// ---------------------------------------------------------------------------
function category(key: string, name: string, sort: number, icon: string): Category {
  return { id: seedId(`cat:${key}`), tenant_id: T, name, sort_order: sort, icon_name: icon, active: true };
}

export const SEED_CATEGORIES: Category[] = [
  category('parrilla', 'Parrilla', 1, 'Flame'),
  category('pratos', 'Pratos da Casa', 2, 'UtensilsCrossed'),
  category('petiscos', 'Petiscos', 3, 'Drumstick'),
  category('pizzas', 'Pizzas na Lenha', 4, 'Pizza'),
  category('chopps', 'Chopps & Cervejas', 5, 'Beer'),
  category('drinks', 'Drinks', 6, 'Martini'),
  category('sem-alcool', 'Sem Álcool', 7, 'CupSoda'),
  category('sobremesas', 'Sobremesas', 8, 'IceCreamCone'),
];

interface ProductSpec {
  code: string;
  name: string;
  cat: string;
  price: number;
  sector: ProductionSector;
  description?: string;
  doneness?: boolean;
  half?: boolean;
  ncm?: string;
  unit?: string;
  available?: boolean;
  barcode?: string;
}

const PRODUCT_SPECS: ProductSpec[] = [
  // Parrilla (GRILL)
  { code: '101', name: 'Picanha na Parrilla 400g', cat: 'parrilla', price: 119.9, sector: 'GRILL', doneness: true, description: 'Picanha maturada, sal de parrilla, servida na tábua.' },
  { code: '102', name: 'Costela 12h no Fogo de Chão', cat: 'parrilla', price: 89.9, sector: 'GRILL', description: 'Costela gaúcha assada lentamente por 12 horas.' },
  { code: '103', name: 'Entrecot 350g', cat: 'parrilla', price: 94.9, sector: 'GRILL', doneness: true },
  { code: '104', name: 'Vazio (Fraldinha) 400g', cat: 'parrilla', price: 84.9, sector: 'GRILL', doneness: true },
  { code: '105', name: 'Linguiça Campeira', cat: 'parrilla', price: 39.9, sector: 'GRILL' },
  { code: '106', name: 'Coraçãozinho na Brasa', cat: 'parrilla', price: 36.9, sector: 'GRILL' },
  { code: '107', name: 'Ancho Angus 400g', cat: 'parrilla', price: 129.9, sector: 'GRILL', doneness: true, available: false },
  // Pratos (KITCHEN)
  { code: '301', name: 'Arroz Carreteiro', cat: 'pratos', price: 46.9, sector: 'KITCHEN', description: 'Carreteiro de charque com ovo frito e farofa.' },
  { code: '302', name: 'Galeto Primo Canto', cat: 'pratos', price: 69.9, sector: 'KITCHEN' },
  { code: '303', name: 'Feijão Mexido Campeiro', cat: 'pratos', price: 32.9, sector: 'KITCHEN' },
  // Petiscos (KITCHEN)
  { code: '311', name: 'Polenta Frita', cat: 'petiscos', price: 29.9, sector: 'KITCHEN' },
  { code: '312', name: 'Aipim Frito', cat: 'petiscos', price: 27.9, sector: 'KITCHEN' },
  { code: '313', name: 'Pastelzinho de Carne (8 un)', cat: 'petiscos', price: 34.9, sector: 'KITCHEN' },
  { code: '314', name: 'Bolinho de Costela (6 un)', cat: 'petiscos', price: 38.9, sector: 'KITCHEN' },
  // Pizzas (KITCHEN, meio-a-meio)
  { code: '401', name: 'Pizza Calabresa', cat: 'pizzas', price: 69.9, sector: 'KITCHEN', half: true },
  { code: '402', name: 'Pizza Portuguesa', cat: 'pizzas', price: 74.9, sector: 'KITCHEN', half: true },
  { code: '403', name: 'Pizza Quatro Queijos', cat: 'pizzas', price: 79.9, sector: 'KITCHEN', half: true },
  { code: '404', name: 'Pizza de Costela Desfiada', cat: 'pizzas', price: 89.9, sector: 'KITCHEN', half: true },
  { code: '405', name: 'Pizza Margherita', cat: 'pizzas', price: 64.9, sector: 'KITCHEN', half: true },
  // Chopps (BAR)
  { code: '201', name: 'Chopp Pilsen', cat: 'chopps', price: 12.9, sector: 'BAR', ncm: '22030000' },
  { code: '202', name: 'Chopp IPA Missioneira', cat: 'chopps', price: 18.9, sector: 'BAR', ncm: '22030000' },
  { code: '203', name: 'Cerveja Long Neck', cat: 'chopps', price: 13.9, sector: 'BAR', ncm: '22030000' },
  { code: '204', name: 'Cerveja 600ml', cat: 'chopps', price: 19.9, sector: 'BAR', ncm: '22030000' },
  // Drinks (BAR)
  { code: '211', name: 'Caipirinha', cat: 'drinks', price: 24.9, sector: 'BAR', ncm: '22089000' },
  { code: '212', name: 'Gin Tônica', cat: 'drinks', price: 32.9, sector: 'BAR', ncm: '22089000' },
  { code: '213', name: 'Quentão de Vinho', cat: 'drinks', price: 18.9, sector: 'BAR', ncm: '22042100' },
  // Sem álcool (BAR)
  { code: '221', name: 'Refrigerante Lata', cat: 'sem-alcool', price: 7.9, sector: 'BAR', ncm: '22021000', barcode: '7890000000017' },
  { code: '222', name: 'Água Mineral 500ml', cat: 'sem-alcool', price: 5.9, sector: 'BAR', ncm: '22011000' },
  { code: '223', name: 'Suco Natural', cat: 'sem-alcool', price: 12.9, sector: 'BAR', ncm: '20098990' },
  // Sobremesas (DESSERT)
  { code: '601', name: 'Sagu com Creme', cat: 'sobremesas', price: 18.9, sector: 'DESSERT' },
  { code: '602', name: 'Pudim de Leite', cat: 'sobremesas', price: 16.9, sector: 'DESSERT' },
  { code: '603', name: 'Ambrosia Gaúcha', cat: 'sobremesas', price: 17.9, sector: 'DESSERT' },
];

export const SEED_PRODUCTS: Product[] = PRODUCT_SPECS.map((p) => ({
  id: seedId(`product:${p.code}`),
  tenant_id: T,
  category_id: seedId(`cat:${p.cat}`),
  code: p.code,
  name: p.name,
  description: p.description ?? null,
  price: p.price,
  sector: p.sector,
  available: p.available ?? true,
  requires_meat_doneness: p.doneness ?? false,
  allows_half_and_half: p.half ?? false,
  ncm: p.ncm ?? '21069090',
  cfop: '5102',
  csosn_cst: '102',
  unit: p.unit ?? 'UN',
  cost_price: 0,
  stock_quantity: 0,
  barcode: p.barcode ?? null,
  created_at: created,
}));

// ---------------------------------------------------------------------------
// MODIFICADORES
// ---------------------------------------------------------------------------
function group(key: string, name: string, min: number, max: number, required: boolean): ModifierGroup {
  return { id: seedId(`mg:${key}`), tenant_id: T, name, min_selection: min, max_selection: max, required };
}
function option(groupKey: string, key: string, name: string, price: number): ModifierOption {
  return { id: seedId(`mo:${groupKey}:${key}`), group_id: seedId(`mg:${groupKey}`), name, additional_price: price };
}

export const SEED_MODIFIER_GROUPS: ModifierGroup[] = [
  group('acomp-parrilla', 'Acompanhamentos da Parrilla', 0, 3, false),
  group('molhos', 'Molhos da Casa', 0, 2, false),
  group('tamanho-chopp', 'Tamanho do Chopp', 1, 1, true),
  group('base-caipira', 'Base da Caipirinha', 1, 1, true),
  group('fruta-caipira', 'Fruta da Caipirinha', 1, 1, true),
  group('borda', 'Borda Recheada', 0, 1, false),
  group('sabor-refri', 'Sabor do Refrigerante', 1, 1, true),
];

export const SEED_MODIFIER_OPTIONS: ModifierOption[] = [
  option('acomp-parrilla', 'farofa', 'Farofa de Ovo', 9.9),
  option('acomp-parrilla', 'vinagrete', 'Vinagrete', 7.9),
  option('acomp-parrilla', 'mandioca', 'Mandioca Cozida', 12.9),
  option('acomp-parrilla', 'arroz', 'Arroz Branco', 8.9),
  option('acomp-parrilla', 'maionese', 'Maionese da Vó', 11.9),
  option('molhos', 'chimichurri', 'Chimichurri', 0),
  option('molhos', 'campeiro', 'Molho Campeiro', 0),
  option('molhos', 'alho', 'Pasta de Alho', 4.9),
  option('tamanho-chopp', '300', '300 ml', 0),
  option('tamanho-chopp', '500', '500 ml', 6),
  option('tamanho-chopp', 'caneca', 'Caneca 1 L', 16),
  option('base-caipira', 'cachaca', 'Cachaça', 0),
  option('base-caipira', 'vodka', 'Vodka', 5),
  option('base-caipira', 'sake', 'Saquê', 7),
  option('fruta-caipira', 'limao', 'Limão', 0),
  option('fruta-caipira', 'morango', 'Morango', 3),
  option('fruta-caipira', 'maracuja', 'Maracujá', 3),
  option('borda', 'catupiry', 'Borda de Catupiry', 12),
  option('borda', 'cheddar', 'Borda de Cheddar', 12),
  option('borda', 'chocolate', 'Borda de Chocolate', 14),
  option('sabor-refri', 'cola', 'Cola', 0),
  option('sabor-refri', 'guarana', 'Guaraná', 0),
  option('sabor-refri', 'laranja', 'Laranja', 0),
];

function link(code: string, groupKey: string, sort: number): ProductModifierGroup {
  return { product_id: seedId(`product:${code}`), group_id: seedId(`mg:${groupKey}`), sort_order: sort };
}

export const SEED_PRODUCT_MODIFIER_GROUPS: ProductModifierGroup[] = [
  ...['101', '102', '103', '104', '107'].flatMap((c) => [link(c, 'acomp-parrilla', 1), link(c, 'molhos', 2)]),
  link('105', 'molhos', 1),
  link('106', 'molhos', 1),
  link('201', 'tamanho-chopp', 1),
  link('202', 'tamanho-chopp', 1),
  link('211', 'base-caipira', 1),
  link('211', 'fruta-caipira', 2),
  ...['401', '402', '403', '404', '405'].map((c) => link(c, 'borda', 1)),
  link('221', 'sabor-refri', 1),
];

/** Tags de 1 toque por setor de produção. */
export const QUICK_TAGS: Record<ProductionSector, string[]> = {
  GRILL: ['Sem sal grosso', 'Capa de gordura à parte', 'Fatiado na tábua', 'Bem tostado', 'Prioridade'],
  KITCHEN: ['Sem cebola', 'Sem pimenta', 'Molho à parte', 'Sem glúten', 'Prioridade'],
  BAR: ['Gelo e limão', 'Copo congelado', 'Sem gelo', 'Pouco açúcar', 'Com adoçante'],
  DESSERT: ['Servir após prato', 'Duas colheres', 'Sem calda'],
  NONE: ['Prioridade'],
};

/** Ponto da carne (modificador obrigatório para requires_meat_doneness). */
export const MEAT_DONENESS_OPTIONS = ['Mal Passada', 'Ao Ponto Menos', 'Ao Ponto', 'Bem Passada'] as const;

// ---------------------------------------------------------------------------
// MESAS
// ---------------------------------------------------------------------------
export const AREAS = ['Salão Principal', 'Deck', 'Parrilla'] as const;

function table(n: number, area: (typeof AREAS)[number], capacity: number): DiningTable {
  return {
    id: seedId(`table:${n}`),
    tenant_id: T,
    number: n,
    label: area === 'Parrilla' ? `Balcão ${n}` : `Mesa ${n}`,
    area,
    capacity,
    status: 'FREE',
    qr_code_token: `tchefood-galpao-${n.toString().padStart(3, '0')}-${(n * 7919).toString(36)}`,
    current_order_id: null,
    updated_at: created,
  };
}

const BASE_TABLES: DiningTable[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => table(n, 'Salão Principal', n % 3 === 0 ? 6 : 4)),
  ...[21, 22, 23, 24, 25, 26].map((n) => table(n, 'Deck', n % 2 === 0 ? 8 : 4)),
  ...[31, 32, 33, 34].map((n) => table(n, 'Parrilla', 2)),
];

// ---------------------------------------------------------------------------
// COMANDAS EM ANDAMENTO
// ---------------------------------------------------------------------------
interface SeedLine {
  code: string;
  qty: number;
  status: OrderItem['status'];
  minutesAgo: number;
  doneness?: string;
  mods?: Array<[string, string]>; // [groupKey, optionKey]
  notes?: string;
  waiter?: string;
}

const productByCode = new Map(SEED_PRODUCTS.map((p) => [p.code, p]));
const optionById = new Map(SEED_MODIFIER_OPTIONS.map((o) => [o.id, o]));

function buildItem(orderId: string, line: SeedLine, idx: number): OrderItem {
  const product = productByCode.get(line.code);
  if (!product) throw new Error(`Seed: produto ${line.code} inexistente`);
  const mods = (line.mods ?? []).map(([g, o]) => {
    const opt = optionById.get(seedId(`mo:${g}:${o}`));
    if (!opt) throw new Error(`Seed: opção ${g}:${o} inexistente`);
    return opt;
  });
  const modsPrice = mods.reduce((acc, m) => acc + m.additional_price, 0);
  const noteParts = [...mods.map((m) => `+ ${m.name}`), ...(line.notes ? [line.notes] : [])];
  const createdAt = minutesAgoISO(line.minutesAgo);
  return {
    id: seedId(`item:${orderId}:${idx}`),
    order_id: orderId,
    product_id: product.id,
    waiter_id: line.waiter ?? WAITER_TIAO,
    quantity: line.qty,
    unit_price: product.price,
    modifiers_unit_price: modsPrice,
    total_item_price: computeItemTotal(line.qty, product.price, modsPrice),
    meat_doneness: line.doneness ?? null,
    notes: noteParts.length ? noteParts.join(' · ') : null,
    sector: product.sector,
    status: line.status,
    is_paid: false,
    origin: 'WAITER',
    created_at: createdAt,
    prepared_at: line.status === 'READY' || line.status === 'DELIVERED' ? minutesAgoISO(Math.max(line.minutesAgo - 15, 1)) : null,
    canceled_at: null,
    canceled_by_user_id: null,
    cancel_reason: null,
  };
}

interface SeedOrderSpec {
  table: number;
  customers: number;
  openedMinutesAgo: number;
  waiter: string;
  tableStatus: DiningTable['status'];
  lines: SeedLine[];
  payment?: { amount: number; terminal: string; brand: string; method: Payment['method'] };
}

const ORDER_SPECS: SeedOrderSpec[] = [
  {
    table: 2,
    customers: 4,
    openedMinutesAgo: 52,
    waiter: WAITER_TIAO,
    tableStatus: 'OCCUPIED',
    lines: [
      { code: '201', qty: 4, status: 'DELIVERED', minutesAgo: 50, mods: [['tamanho-chopp', '500']] },
      { code: '311', qty: 1, status: 'DELIVERED', minutesAgo: 48 },
      { code: '101', qty: 1, status: 'PREPARING', minutesAgo: 30, doneness: 'Ao Ponto Menos', mods: [['acomp-parrilla', 'farofa'], ['acomp-parrilla', 'vinagrete'], ['molhos', 'chimichurri']] },
      { code: '102', qty: 1, status: 'PREPARING', minutesAgo: 30, mods: [['acomp-parrilla', 'mandioca']] },
      { code: '201', qty: 2, status: 'PENDING', minutesAgo: 4, mods: [['tamanho-chopp', '300']], notes: 'Copo congelado' },
    ],
  },
  {
    table: 5,
    customers: 2,
    openedMinutesAgo: 18,
    waiter: WAITER_DUDA,
    tableStatus: 'OCCUPIED',
    lines: [
      { code: '211', qty: 2, status: 'READY', minutesAgo: 15, mods: [['base-caipira', 'cachaca'], ['fruta-caipira', 'limao']], notes: 'Pouco açúcar', waiter: WAITER_DUDA },
      { code: '313', qty: 1, status: 'PREPARING', minutesAgo: 12, waiter: WAITER_DUDA },
    ],
  },
  {
    table: 9,
    customers: 6,
    openedMinutesAgo: 95,
    waiter: WAITER_TIAO,
    tableStatus: 'WAITING_BILL',
    lines: [
      { code: '204', qty: 5, status: 'DELIVERED', minutesAgo: 90 },
      { code: '404', qty: 1, status: 'DELIVERED', minutesAgo: 80, notes: '1/2 Pizza de Costela Desfiada + 1/2 Pizza Calabresa' },
      { code: '104', qty: 2, status: 'DELIVERED', minutesAgo: 70, doneness: 'Ao Ponto', mods: [['acomp-parrilla', 'arroz'], ['acomp-parrilla', 'maionese']] },
      { code: '601', qty: 3, status: 'DELIVERED', minutesAgo: 25 },
    ],
  },
  {
    table: 22,
    customers: 8,
    openedMinutesAgo: 70,
    waiter: WAITER_DUDA,
    tableStatus: 'PAYING',
    lines: [
      { code: '202', qty: 6, status: 'DELIVERED', minutesAgo: 68, mods: [['tamanho-chopp', '500']], waiter: WAITER_DUDA },
      { code: '102', qty: 2, status: 'DELIVERED', minutesAgo: 60, waiter: WAITER_DUDA },
      { code: '312', qty: 2, status: 'DELIVERED', minutesAgo: 60, waiter: WAITER_DUDA },
      { code: '221', qty: 3, status: 'DELIVERED', minutesAgo: 58, mods: [['sabor-refri', 'guarana']], notes: 'Gelo e limão', waiter: WAITER_DUDA },
    ],
    payment: { amount: 150, terminal: 'pos:stone-02', brand: 'MASTERCARD', method: 'CREDIT' },
  },
  {
    table: 32,
    customers: 1,
    openedMinutesAgo: 8,
    waiter: WAITER_TIAO,
    tableStatus: 'OCCUPIED',
    lines: [
      { code: '203', qty: 1, status: 'DELIVERED', minutesAgo: 7 },
      { code: '103', qty: 1, status: 'PENDING', minutesAgo: 2, doneness: 'Mal Passada', mods: [['molhos', 'campeiro']] },
    ],
  },
];

// ---------------------------------------------------------------------------
// IMPRESSORAS TÉRMICAS POR PRAÇA (ESC/POS)
// ---------------------------------------------------------------------------
export const SEED_PRINTERS: PrinterConfig[] = [
  { id: seedId('printer:parrilla'), name: 'Impressora Parrilla (Elgin i9)', brand: 'ELGIN', model: 'i9', sector: 'GRILL', paperWidth: '80MM', connection: 'NETWORK_TCP', ipAddress: '192.168.1.201', port: 9100, beepOnPrint: true, cutPaper: true, active: true },
  { id: seedId('printer:cozinha'), name: 'Cozinha (Epson TM-T20X)', brand: 'EPSON', model: 'TM-T20X', sector: 'KITCHEN', paperWidth: '80MM', connection: 'NETWORK_TCP', ipAddress: '192.168.1.203', port: 9100, beepOnPrint: true, cutPaper: true, active: true },
  { id: seedId('printer:sobremesa'), name: 'Doceria (Bematech MP-4200)', brand: 'BEMATECH', model: 'MP-4200 TH', sector: 'DESSERT', paperWidth: '80MM', connection: 'NETWORK_TCP', ipAddress: '192.168.1.204', port: 9100, beepOnPrint: false, cutPaper: true, active: true },
  { id: seedId('printer:bar'), name: 'Bar 58mm (Mini Bluetooth)', brand: 'GENERIC_BT', model: 'MTP-II', sector: 'BAR', paperWidth: '58MM', connection: 'BLUETOOTH', macAddress: '66:22:A1:3C:7F:10', beepOnPrint: false, cutPaper: false, active: true },
  { id: seedId('printer:caixa'), name: 'Bobina Interna SmartPOS', brand: 'SMARTPOS_STONE', model: 'Stone POS Android', sector: 'CASHIER', paperWidth: '58MM', connection: 'SMARTPOS_INTERNAL', beepOnPrint: false, cutPaper: false, active: true },
];

function buildSeedState() {
  const tables = BASE_TABLES.map((t) => ({ ...t }));
  const orders: Order[] = [];
  const items: OrderItem[] = [];
  const payments: Payment[] = [];

  for (const spec of ORDER_SPECS) {
    const t = tables.find((x) => x.number === spec.table);
    if (!t) throw new Error(`Seed: mesa ${spec.table} inexistente`);
    const orderId = seedId(`order:${spec.table}`);
    const orderItems = spec.lines.map((l, idx) => buildItem(orderId, l, idx));
    items.push(...orderItems);

    if (spec.payment) {
      const terminal = SEED_TERMINALS.find((x) => x.id === seedId(spec.payment!.terminal));
      payments.push({
        id: seedId(`payment:${spec.table}:1`),
        order_id: orderId,
        tenant_id: T,
        waiter_id: spec.waiter,
        terminal_id: terminal?.id ?? null,
        amount: spec.payment.amount,
        tip_amount: 0,
        method: spec.payment.method,
        status: 'APPROVED',
        acquirer: terminal?.acquirer ?? 'STONE',
        acquirer_cnpj: terminal?.acquirer === 'PAGBANK' ? '08561701000101' : '16501555000157',
        card_brand: spec.payment.brand,
        nsu: '004815162342',
        authorization_code: 'A7K29Q',
        terminal_serial: terminal?.serial_number ?? null,
        idempotency_key: `seed-${orderId}-1`,
        created_at: minutesAgoISO(5),
      });
    }

    const base: Order = {
      id: orderId,
      tenant_id: T,
      table_id: t.id,
      opened_by_user_id: spec.waiter,
      status: spec.tableStatus === 'PAYING' ? 'PAYING' : 'OPEN',
      customer_count: spec.customers,
      customer_cpf: null,
      subtotal_items: 0,
      charge_service_fee: true,
      service_fee_pct: SEED_TENANT.default_service_fee_pct,
      service_fee_amount: 0,
      discount_amount: 0,
      total_amount: 0,
      paid_amount: 0,
      remaining_balance: 0,
      nfce_status: 'PENDING',
      nfce_key: null,
      opened_at: minutesAgoISO(spec.openedMinutesAgo),
      closed_at: null,
    };
    orders.push(applyOrderTotals(base, items, payments));
    t.status = spec.tableStatus;
    t.current_order_id = orderId;
    t.updated_at = minutesAgoISO(Math.min(spec.openedMinutesAgo, 5));
  }

  // Uma mesa aguardando limpeza para demonstrar o ciclo completo.
  const dirty = tables.find((x) => x.number === 7);
  if (dirty) dirty.status = 'DIRTY';

  return { tables, orders, items, payments };
}

export function createSeedData() {
  const dyn = buildSeedState();
  return {
    tenant: SEED_TENANT,
    staff: SEED_STAFF,
    terminals: SEED_TERMINALS,
    categories: SEED_CATEGORIES,
    products: SEED_PRODUCTS,
    modifierGroups: SEED_MODIFIER_GROUPS,
    modifierOptions: SEED_MODIFIER_OPTIONS,
    productModifierGroups: SEED_PRODUCT_MODIFIER_GROUPS,
    tables: dyn.tables,
    orders: dyn.orders,
    orderItems: dyn.items,
    payments: dyn.payments,
    auditLogs: [],
    printers: SEED_PRINTERS.map((p) => ({ ...p })),
    suppliers: [],
    purchaseInvoices: [],
    purchaseInvoiceItems: [],
    stockMovements: [],
    supplierProductLinks: [],
  };
}
