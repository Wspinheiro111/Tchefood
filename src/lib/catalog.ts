/**
 * Etapa 0 — regras puras dos cadastros (cardápio, mesas, equipe, preço por horário).
 * Tudo aqui é determinístico e testável sem o store: o store chama estas funções
 * antes de gravar, e a mesma regra vale para qualquer tela.
 */
import type {
  Category,
  DiningTable,
  ModifierGroup,
  ModifierOption,
  PriceSchedule,
  Product,
  ProductionSector,
  StaffUser,
  UserRole,
} from '../types';
import { COMBO_COMPONENT_MAX_QTY } from './combos';
import { round2, toCents } from './money';

export type Check = { ok: true } | { ok: false; error: string };
const okCheck: Check = { ok: true };
const bad = (error: string): Check => ({ ok: false, error });

export const SECTORS: ReadonlyArray<ProductionSector> = ['KITCHEN', 'GRILL', 'BAR', 'DESSERT', 'NONE'];
export const ROLES: ReadonlyArray<UserRole> = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'KIOSK'];

export const ROLE_LABEL: Record<UserRole, string> = {
  OWNER: 'Proprietário',
  MANAGER: 'Gerente',
  CASHIER: 'Caixa',
  WAITER: 'Garçom',
  KITCHEN: 'Cozinha',
  KIOSK: 'Totem (aparelho)',
};

export const SECTOR_NAME: Record<ProductionSector, string> = {
  KITCHEN: 'Cozinha',
  GRILL: 'Parrilla',
  BAR: 'Bar',
  DESSERT: 'Doceria',
  NONE: 'Sem produção',
};

/** Preço em reais com no máximo 2 casas e dentro de NUMERIC(10,2). */
function validMoney(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 && v < 100_000_000;
}

// ---------------------------------------------------------------------------
// CATEGORIAS
// ---------------------------------------------------------------------------
export function validateCategory(c: Pick<Category, 'id' | 'name' | 'sort_order'>, all: Category[]): Check {
  const name = c.name.trim();
  if (name.length < 2) return bad('Nome da categoria: mínimo 2 letras.');
  if (name.length > 80) return bad('Nome da categoria: máximo 80 letras.');
  if (!Number.isInteger(c.sort_order) || c.sort_order < 0) return bad('Ordem deve ser um número inteiro ≥ 0.');
  if (all.some((o) => o.id !== c.id && o.active && o.name.trim().toLowerCase() === name.toLowerCase())) {
    return bad(`Já existe a categoria "${name}".`);
  }
  return okCheck;
}

// ---------------------------------------------------------------------------
// PRODUTOS
// ---------------------------------------------------------------------------
/** Campos da Fase 5 (balança, CMV) e de estoque são opcionais no cadastro: sem eles, o produto mantém o que já tinha. */
type Fase5ProductFields = 'sold_by_weight' | 'tare_weight_grams' | 'cost_price' | 'stock_quantity' | 'barcode' | 'is_combo';
export type ProductDraft = Omit<Product, 'tenant_id' | 'created_at' | Fase5ProductFields> & Partial<Pick<Product, Fase5ProductFields>>;

export function validateProduct(p: ProductDraft, products: Product[], categories: Category[]): Check {
  const code = p.code.trim();
  if (!/^[0-9A-Za-z-]{1,20}$/.test(code)) return bad('Código rápido: até 20 letras ou números, sem espaço.');
  if (products.some((o) => o.id !== p.id && o.code.trim().toLowerCase() === code.toLowerCase())) {
    return bad(`O código ${code} já é usado por outro produto.`);
  }
  const name = p.name.trim();
  if (name.length < 2 || name.length > 120) return bad('Nome do produto: entre 2 e 120 letras.');
  const cat = categories.find((c) => c.id === p.category_id);
  if (!cat) return bad('Escolha a categoria.');
  if (!cat.active && p.active) return bad(`A categoria ${cat.name} está desativada.`);
  if (!validMoney(p.price) || p.price <= 0) return bad('Preço deve ser maior que zero, com até 2 casas.');
  if (!SECTORS.includes(p.sector)) return bad('Praça de produção inválida.');
  if (!/^\d{8}$/.test(p.ncm)) return bad('NCM deve ter 8 dígitos.');
  if (!/^[5-7]\d{3}$/.test(p.cfop)) return bad('CFOP de saída deve ter 4 dígitos começando por 5, 6 ou 7.');
  if (!/^\d{2,4}$/.test(p.csosn_cst)) return bad('CSOSN/CST deve ter de 2 a 4 dígitos.');
  const unit = p.unit.trim();
  if (unit.length < 1 || unit.length > 6) return bad('Unidade: de 1 a 6 letras (ex.: UN, KG).');
  if (p.is_combo) {
    if (p.sold_by_weight) return bad('Combo não é vendido por peso.');
    if (p.allows_half_and_half) return bad('Combo não tem meio-a-meio.');
  }
  return okCheck;
}

// ---------------------------------------------------------------------------
// ADICIONAIS (grupos e opções)
// ---------------------------------------------------------------------------
export function validateModifierGroup(g: Omit<ModifierGroup, 'tenant_id'>): Check {
  const name = g.name.trim();
  if (name.length < 2 || name.length > 80) return bad('Nome do grupo: entre 2 e 80 letras.');
  if (!Number.isInteger(g.min_selection) || g.min_selection < 0) return bad('Mínimo deve ser inteiro ≥ 0.');
  if (!Number.isInteger(g.max_selection) || g.max_selection < 1) return bad('Máximo deve ser inteiro ≥ 1.');
  if (g.min_selection > g.max_selection) return bad('Mínimo não pode passar do máximo.');
  if (g.required && g.max_selection < 1) return bad('Grupo obrigatório precisa permitir ao menos 1 escolha.');
  return okCheck;
}

export function validateModifierOption(o: ModifierOption, groups: ModifierGroup[], options: ModifierOption[], products: Product[] = []): Check {
  if (!groups.some((g) => g.id === o.group_id)) return bad('Grupo do adicional não encontrado.');
  if (o.component_product_id) {
    const comp = products.find((p) => p.id === o.component_product_id);
    if (!comp || !comp.active) return bad('Produto do combo não encontrado.');
    if (comp.is_combo) return bad('Um combo não entra dentro de outro combo.');
    if (comp.sold_by_weight) return bad(`${comp.name} é vendido por peso e não entra em combo.`);
    if (!Number.isInteger(o.component_quantity) || o.component_quantity < 1 || o.component_quantity > COMBO_COMPONENT_MAX_QTY) {
      return bad(`Quantidade no combo: inteiro de 1 a ${COMBO_COMPONENT_MAX_QTY}.`);
    }
  }
  const name = o.name.trim();
  if (name.length < 1 || name.length > 80) return bad('Nome do adicional: entre 1 e 80 letras.');
  if (!validMoney(o.additional_price) || o.additional_price < 0) return bad('Valor do adicional deve ser ≥ 0, com até 2 casas.');
  if (options.some((x) => x.id !== o.id && x.group_id === o.group_id && x.name.trim().toLowerCase() === name.toLowerCase())) {
    return bad(`Já existe "${name}" neste grupo.`);
  }
  return okCheck;
}

// ---------------------------------------------------------------------------
// MESAS
// ---------------------------------------------------------------------------
export type TableDraft = Pick<DiningTable, 'id' | 'number' | 'label' | 'area' | 'capacity' | 'active'>;

export function validateTable(t: TableDraft, tables: DiningTable[]): Check {
  if (!Number.isInteger(t.number) || t.number < 1 || t.number > 9999) return bad('Número da mesa: inteiro de 1 a 9999.');
  if (tables.some((o) => o.id !== t.id && o.number === t.number)) return bad(`Já existe a mesa número ${t.number}.`);
  const label = t.label.trim();
  if (label.length < 1 || label.length > 50) return bad('Nome da mesa: de 1 a 50 letras.');
  const area = t.area.trim();
  if (area.length < 2 || area.length > 50) return bad('Área: de 2 a 50 letras.');
  if (!Number.isInteger(t.capacity) || t.capacity < 1 || t.capacity > 99) return bad('Lugares: de 1 a 99.');
  const current = tables.find((o) => o.id === t.id);
  if (current && !t.active && current.status !== 'FREE') return bad(`${current.label} está em uso. Só mesa livre pode ser desativada.`);
  return okCheck;
}

// ---------------------------------------------------------------------------
// EQUIPE
// ---------------------------------------------------------------------------
export type StaffDraft = Pick<StaffUser, 'id' | 'name' | 'role' | 'pin_code' | 'active'>;

/**
 * Regras de equipe:
 *  - PIN de 4 dígitos (o mesmo teclado do login e da autorização), único na loja (o banco tem UNIQUE(tenant_id, pin_code),
 *    inclusive para inativos), e não pode ser sequência trivial.
 *  - Gerente não cria, edita nem promove proprietário ou outro gerente.
 *  - A loja nunca fica sem proprietário ativo, e ninguém desativa a si mesmo.
 */
export function validateStaff(d: StaffDraft, all: StaffUser[], actor: StaffUser): Check {
  const name = d.name.trim();
  if (name.length < 2 || name.length > 100) return bad('Nome: entre 2 e 100 letras.');
  if (!ROLES.includes(d.role)) return bad('Perfil inválido.');
  const current = all.find((o) => o.id === d.id);
  // PIN que já existia (ex.: o do seed) continua valendo; a regra vale para PIN novo ou trocado.
  const pinChanged = !current || current.pin_code !== d.pin_code;
  if (pinChanged) {
    if (!/^\d{4}$/.test(d.pin_code)) return bad('PIN deve ter 4 dígitos.');
    if (/^(\d)\1+$/.test(d.pin_code) || '0123456789'.includes(d.pin_code) || '9876543210'.includes(d.pin_code)) {
      return bad('PIN fácil demais (sequência ou dígitos repetidos).');
    }
  }
  if (all.some((o) => o.id !== d.id && o.pin_code === d.pin_code)) return bad('Este PIN já é usado por outra pessoa da equipe.');

  const self = current !== undefined && current.id === actor.id;
  if (actor.role !== 'OWNER' && !self) {
    if (d.role === 'OWNER' || d.role === 'MANAGER') return bad('Só o proprietário cadastra gerentes e proprietários.');
    if (current && (current.role === 'OWNER' || current.role === 'MANAGER') && current.id !== actor.id) {
      return bad('Só o proprietário altera gerentes e proprietários.');
    }
  }
  if (self) {
    if (!d.active) return bad('Você não pode desativar o próprio acesso.');
    if (d.role !== current.role) return bad('Você não pode mudar o próprio perfil.');
  }
  if (current && current.role === 'OWNER' && current.active && (d.role !== 'OWNER' || !d.active)) {
    const owners = all.filter((o) => o.role === 'OWNER' && o.active && o.id !== d.id);
    if (owners.length === 0) return bad('A loja precisa de ao menos um proprietário ativo.');
  }
  return okCheck;
}

// ---------------------------------------------------------------------------
// PREÇO POR HORÁRIO
// ---------------------------------------------------------------------------
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

export function parseHHMM(v: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Intervalos [início, fim) em minutos da semana (0 = domingo 00:00). */
export function scheduleIntervals(s: Pick<PriceSchedule, 'weekdays' | 'start_time' | 'end_time'>): Array<[number, number]> {
  const start = parseHHMM(s.start_time);
  const end = parseHHMM(s.end_time);
  if (start === null || end === null || start === end) return [];
  const length = end > start ? end - start : MINUTES_PER_DAY - start + end;
  const out: Array<[number, number]> = [];
  for (const d of s.weekdays) {
    const a = d * MINUTES_PER_DAY + start;
    const b = a + length;
    if (b <= MINUTES_PER_WEEK) out.push([a, b]);
    else {
      // Sábado que vira para domingo.
      out.push([a, MINUTES_PER_WEEK]);
      out.push([0, b - MINUTES_PER_WEEK]);
    }
  }
  return out;
}

function overlaps(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  return a.some(([a0, a1]) => b.some(([b0, b1]) => a0 < b1 && b0 < a1));
}

export type PriceScheduleDraft = Omit<PriceSchedule, 'tenant_id' | 'created_at'>;

export function validatePriceSchedule(s: PriceScheduleDraft, all: PriceSchedule[], products: Product[]): Check {
  if (!products.some((p) => p.id === s.product_id)) return bad('Produto não encontrado.');
  const name = s.name.trim();
  if (name.length < 2 || name.length > 60) return bad('Nome da regra: entre 2 e 60 letras (ex.: Happy hour).');
  const days = Array.from(new Set(s.weekdays));
  if (days.length === 0) return bad('Escolha ao menos um dia da semana.');
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return bad('Dia da semana inválido.');
  const start = parseHHMM(s.start_time);
  const end = parseHHMM(s.end_time);
  if (start === null || end === null) return bad('Horário no formato HH:MM (ex.: 18:00).');
  if (start === end) return bad('Início e fim não podem ser iguais.');
  if (!validMoney(s.price) || s.price <= 0) return bad('Preço deve ser maior que zero, com até 2 casas.');
  if (s.active) {
    const mine = scheduleIntervals({ ...s, weekdays: days });
    const clash = all.find((o) => o.id !== s.id && o.active && o.product_id === s.product_id && overlaps(mine, scheduleIntervals(o)));
    if (clash) return bad(`Conflita com a regra "${clash.name}" no mesmo horário.`);
  }
  return okCheck;
}

/** Minuto da semana no horário local do aparelho da loja. */
export function minuteOfWeek(at: Date): number {
  return at.getDay() * MINUTES_PER_DAY + at.getHours() * 60 + at.getMinutes();
}

/** Regra de horário que vale agora para o produto (no máximo uma: sobreposição é recusada no cadastro). */
export function activeSchedule(productId: string, schedules: PriceSchedule[], at: Date): PriceSchedule | null {
  const t = minuteOfWeek(at);
  return (
    schedules.find(
      (s) => s.active && s.product_id === productId && scheduleIntervals(s).some(([a, b]) => t >= a && t < b),
    ) ?? null
  );
}

/** Preço de venda do produto no instante informado (cadastro + regra de horário). */
export function effectivePrice(product: Pick<Product, 'id' | 'price'>, schedules: PriceSchedule[], at: Date): number {
  const rule = activeSchedule(product.id, schedules, at);
  return round2(rule ? rule.price : product.price);
}

/** Diferença de preço em centavos (para o audit_log de troca de preço). */
export function priceDeltaCents(before: number, after: number): number {
  return toCents(after) - toCents(before);
}

export const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;
