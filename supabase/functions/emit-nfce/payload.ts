/**
 * Monta o payload Focus NFe (NFC-e modelo 65, SEFAZ-RS) a partir das linhas do banco.
 *
 * Regras portadas do Tchê Vendas (server/nfceFoundation.ts e server/nfceService.ts):
 * - Valores do Postgres (NUMERIC) chegam como texto: tudo é convertido para centavos
 *   antes de qualquer conta. "12.50" + "1.00" nunca vira "12.501.00".
 * - Taxa de serviço vai em valor_outras_despesas (vOutro) e o desconto em valor_desconto
 *   (vDesc), rateados item a item pelos maiores restos — a mesma regra de src/lib/nfce.ts.
 *   A SEFAZ confere o total contra a soma dos itens (rejeições 564/610/629).
 * - Pagamento integrado (tipo_integracao 1) só com prova da maquininha: CNPJ da
 *   credenciadora com DV válido e coerente com o adquirente gravado no pagamento, e
 *   código de autorização. Sem prova, sai como não integrado (2). Nunca se inventa
 *   CNPJ ou autorização: MOCK, caixa ou adquirente desconhecido não viram PagBank.
 * - Pix na maquininha sai como não integrado (2), como no Tchê Vendas: o CNPJ do grupo
 *   seria o da instituição que recebeu o Pix, que não conferimos.
 * - data_emissao no fuso de São Paulo (-03:00), nunca em UTC.
 */

export type Numeric = string | number;

export interface TenantRow {
  id: string;
  cnpj: string;
  state: string | null;
  focus_nfe_token: string | null;
}

export interface OrderRow {
  id: string;
  tenant_id: string;
  status: string;
  customer_cpf: string | null;
  subtotal_items: Numeric;
  service_fee_amount: Numeric;
  discount_amount: Numeric;
  total_amount: Numeric;
  remaining_balance: Numeric;
  charge_service_fee: boolean;
  service_fee_pct: Numeric;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  quantity: Numeric;
  unit_price: Numeric;
  modifiers_unit_price: Numeric;
  total_item_price: Numeric;
  meat_doneness: string | null;
  status: string;
}

export interface ProductRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  ncm: string;
  cfop: string;
  csosn_cst: string;
  unit: string;
}

export type PaymentMethod = 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER' | 'CASH';
export type Acquirer = 'STONE' | 'PAGBANK' | 'MOCK' | 'CASH_DESK';

export interface PaymentRow {
  id: string;
  order_id: string;
  tenant_id: string;
  amount: Numeric;
  method: PaymentMethod;
  status: string;
  acquirer: Acquirer;
  acquirer_cnpj: string | null;
  card_brand: string | null;
  authorization_code: string | null;
}

export interface NfceSource {
  tenant: TenantRow;
  order: OrderRow;
  items: OrderItemRow[];
  products: ProductRow[];
  payments: PaymentRow[];
}

/** CNPJ das credenciadoras, conferidos pelo DV. Só esses adquirentes podem sair como integrados. */
export const ACQUIRER_CNPJ: Readonly<Record<'STONE' | 'PAGBANK', string>> = {
  STONE: '16501555000157', // Stone Instituição de Pagamento S.A.
  PAGBANK: '08561701000101', // PagSeguro Internet Instituição de Pagamento S.A. (PagBank)
};

/** tPag. Vale (VOUCHER) é vale-refeição (11) no restaurante, nunca "crédito loja" (05). */
export const NFCE_PAYMENT_CODE: Readonly<Record<PaymentMethod, string>> = {
  CASH: '01',
  CREDIT: '03',
  DEBIT: '04',
  VOUCHER: '11',
  PIX: '17',
};

/** Meios em que o grupo de cartão (tipo_integracao) é obrigatório na NFC-e. */
const CARD_GROUP_CODES = new Set(['03', '04', '17']);
/** Meios que podem sair como integrados (cartão); Pix fica não integrado. */
const INTEGRATED_CODES = new Set(['03', '04']);

const CARD_BRANDS: Array<[RegExp, string]> = [
  [/^VISA/, '01'],
  [/^(MASTER|MAESTRO)/, '02'],
  [/^(AMEX|AMERICAN)/, '03'],
  [/^ELO/, '06'],
  [/^HIPERCARD/, '07'],
];

export class NfceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NfceValidationError';
  }
}

function fail(message: string): never {
  throw new NfceValidationError(message);
}

/** Converte NUMERIC (texto ou número) para centavos inteiros, sem passar por float acumulado. */
export function toCents(value: Numeric | null | undefined, field: string): number {
  const text = typeof value === 'number' ? value.toFixed(2) : String(value ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,}))?$/.exec(text);
  if (!match) fail(`Valor inválido em ${field}: "${String(value)}".`);
  const [, sign, int, frac = ''] = match;
  const padded = (frac + '000').slice(0, 3);
  let cents = Number(int) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1; // meio para longe do zero, como round() do Postgres
  return sign ? -cents : cents;
}

/** Quantidade NUMERIC(10,3) em milésimos. */
export function toMillis(value: Numeric, field: string): number {
  const text = typeof value === 'number' ? value.toFixed(3) : String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) fail(`Quantidade inválida em ${field}: "${String(value)}".`);
  return Number(match[1]) * 1000 + Number(((match[2] ?? '') + '000').slice(0, 3));
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** Rateio pelos maiores restos (mesma regra de src/lib/money.ts allocateCents). */
export function allocateCents(totalCents: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalCents === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let rest = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floors[order[k]!.i]! += 1;
  return floors;
}

export function digits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

/** CNPJ com DV (aceita o alfanumérico da NT 2025.001); recusa sequência repetida. */
export function validCnpj(value: string): boolean {
  const cnpj = value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || /^(.)\1{13}$/.test(cnpj)) return false;
  const dv = (source: string, weights: number[]) => {
    const sum = source.split('').reduce((t, c, i) => t + (c.charCodeAt(0) - 48) * weights[i]!, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const first = dv(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = dv(cnpj.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(cnpj[12]) && second === Number(cnpj[13]);
}

export function validCpf(value: string): boolean {
  const cpf = digits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (len: number) => {
    const sum = cpf.slice(0, len).split('').reduce((t, c, i) => t + Number(c) * (len + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

export function cardBrandCode(brand: string | null | undefined): string | null {
  const name = String(brand ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!name) return null;
  return CARD_BRANDS.find(([pattern]) => pattern.test(name))?.[1] ?? '99';
}

/** Instante no horário de Brasília com offset -03:00 (o Brasil não tem horário de verão desde 2019). */
export function fiscalIssuedAt(date: Date = new Date()): string {
  const local = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 19)}-03:00`;
}

/** Referência Focus determinística por comanda: só letras e números (o UUID perde os hífens). */
export function nfceReference(orderId: string): string {
  const id = orderId.toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(id)) fail('Identificador da comanda inválido para a referência NFC-e.');
  return `tchefood${id}`;
}

export interface FocusPaymentGroup {
  forma_pagamento: string;
  valor_pagamento: number;
  indicador_pagamento: 0;
  tipo_integracao?: 1 | 2;
  cnpj_credenciadora?: string;
  bandeira_operadora?: string;
  numero_autorizacao?: string;
}

/** Grupo da forma de pagamento. Integrado só com prova completa e coerente da maquininha. */
export function paymentGroup(payment: PaymentRow): FocusPaymentGroup {
  const code = NFCE_PAYMENT_CODE[payment.method];
  if (!code) fail(`Meio de pagamento ${String(payment.method)} sem código NFC-e.`);
  const group: FocusPaymentGroup = {
    forma_pagamento: code,
    valor_pagamento: fromCents(toCents(payment.amount, `pagamento ${payment.id}`)),
    indicador_pagamento: 0,
  };
  if (!CARD_GROUP_CODES.has(code)) return group;
  if (!INTEGRATED_CODES.has(code)) return { ...group, tipo_integracao: 2 };

  const acquirer = payment.acquirer;
  const expected = acquirer === 'STONE' || acquirer === 'PAGBANK' ? ACQUIRER_CNPJ[acquirer] : null;
  const recorded = digits(payment.acquirer_cnpj);
  const authorization = String(payment.authorization_code ?? '').trim();
  const proven =
    expected !== null && recorded === expected && validCnpj(recorded) && /^[A-Za-z0-9]{1,20}$/.test(authorization);
  if (!proven) return { ...group, tipo_integracao: 2 };
  const brand = cardBrandCode(payment.card_brand);
  return {
    ...group,
    tipo_integracao: 1,
    cnpj_credenciadora: recorded,
    numero_autorizacao: authorization,
    ...(brand ? { bandeira_operadora: brand } : {}),
  };
}

export interface FocusItem {
  numero_item: number;
  codigo_produto: string;
  descricao: string;
  codigo_ncm: string;
  cfop: string;
  unidade_comercial: string;
  quantidade_comercial: number;
  valor_unitario_comercial: number;
  unidade_tributavel: string;
  quantidade_tributavel: number;
  valor_unitario_tributavel: number;
  valor_bruto: number;
  valor_desconto?: number;
  valor_outras_despesas?: number;
  icms_origem: 0;
  icms_situacao_tributaria: string;
}

export interface FocusNfcePayload {
  natureza_operacao: 'VENDA AO CONSUMIDOR';
  data_emissao: string;
  tipo_documento: 1;
  local_destino: 1;
  consumidor_final: 1;
  presenca_comprador: 1;
  modalidade_frete: 9;
  cnpj_emitente: string;
  cpf_destinatario?: string;
  indicador_inscricao_estadual_destinatario?: 9;
  valor_produtos: number;
  valor_desconto: number;
  valor_outras_despesas: number;
  valor_total: number;
  items: FocusItem[];
  formas_pagamento: FocusPaymentGroup[];
  informacoes_adicionais_contribuinte?: string;
}

/**
 * Valida a comanda fechada e monta o payload. Qualquer divergência de centavo bloqueia a
 * emissão com NfceValidationError: é melhor não emitir do que emitir nota que a SEFAZ
 * rejeita ou, pior, nota com valor diferente do que foi cobrado.
 */
export function buildNfcePayload(source: NfceSource, issuedAt: string = fiscalIssuedAt()): FocusNfcePayload {
  const { tenant, order } = source;
  if (order.tenant_id !== tenant.id) fail('Comanda não pertence ao emitente.');
  if (order.status !== 'CLOSED') fail('Só comanda fechada (CLOSED) pode emitir NFC-e.');
  if (toCents(order.remaining_balance, 'saldo restante') !== 0) fail('Comanda com saldo em aberto não emite NFC-e.');
  const cnpj = tenant.cnpj.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!validCnpj(cnpj)) fail('CNPJ do emitente inválido.');
  if ((tenant.state ?? '').toUpperCase() !== 'RS') fail('Emissor configurado só para SEFAZ-RS.');

  const productById = new Map(source.products.map((p) => [p.id, p]));
  const items = source.items.filter((i) => i.order_id === order.id && i.status !== 'CANCELED');
  if (!items.length) fail('A comanda não tem itens válidos para a NFC-e.');

  const itemCents = items.map((item, idx) => {
    const unit = toCents(item.unit_price, `item ${idx + 1}`) + toCents(item.modifiers_unit_price, `item ${idx + 1}`);
    const qty = toMillis(item.quantity, `item ${idx + 1}`);
    if (qty <= 0) fail(`Quantidade inválida no item ${idx + 1}.`);
    const stored = toCents(item.total_item_price, `item ${idx + 1}`);
    // Mesmo cálculo do trigger trg_order_items_total: round(q * (unit + mods), 2).
    const recomputed = Math.round((qty * unit) / 1000);
    if (stored !== recomputed) fail(`Item ${idx + 1}: total gravado ${fromCents(stored)} diverge de quantidade × preço (${fromCents(recomputed)}).`);
    return { unit, qty, total: stored };
  });

  const subtotal = itemCents.reduce((s, i) => s + i.total, 0);
  const fee = toCents(order.service_fee_amount, 'taxa de serviço');
  const discount = toCents(order.discount_amount, 'desconto');
  const total = toCents(order.total_amount, 'total');
  if (subtotal !== toCents(order.subtotal_items, 'subtotal')) fail('Subtotal da comanda diverge da soma dos itens.');
  if (fee < 0 || discount < 0) fail('Taxa de serviço e desconto não podem ser negativos.');
  if (subtotal + fee - discount !== total) fail('Total da comanda diverge de itens + taxa de serviço − desconto.');
  if (total <= 0) fail('Total da NFC-e precisa ser positivo.');

  const payments = source.payments.filter((p) => p.order_id === order.id && p.status === 'APPROVED');
  if (!payments.length) fail('Comanda sem pagamento aprovado.');
  if (payments.some((p) => p.tenant_id !== tenant.id)) fail('Pagamento de outro emitente na comanda.');
  const paid = payments.reduce((s, p) => s + toCents(p.amount, `pagamento ${p.id}`), 0);
  if (paid !== total) fail(`Pagamentos aprovados (${fromCents(paid)}) diferentes do total da comanda (${fromCents(total)}).`);

  const weights = itemCents.map((i) => i.total);
  const feeShares = allocateCents(fee, weights);
  const discountShares = allocateCents(discount, weights);

  const nfItems: FocusItem[] = items.map((item, idx) => {
    const product = productById.get(item.product_id);
    if (!product || product.tenant_id !== tenant.id) fail(`Produto do item ${idx + 1} não encontrado no cadastro do emitente.`);
    const ncm = digits(product.ncm);
    const cfop = digits(product.cfop);
    const icms = digits(product.csosn_cst);
    if (!/^\d{8}$/.test(ncm)) fail(`NCM inválido no item ${idx + 1} (${product.name}).`);
    if (!/^\d{4}$/.test(cfop)) fail(`CFOP inválido no item ${idx + 1} (${product.name}).`);
    if (!/^\d{2,3}$/.test(icms)) fail(`CST/CSOSN inválido no item ${idx + 1} (${product.name}).`);
    const { unit, qty, total: gross } = itemCents[idx]!;
    if (discountShares[idx]! > gross) fail(`Desconto maior que o valor do item ${idx + 1}.`);
    const unitValue = fromCents(unit);
    const quantity = qty / 1000;
    const un = (product.unit || 'UN').trim().slice(0, 6);
    const description = [product.name, item.meat_doneness ? `(${item.meat_doneness})` : ''].filter(Boolean).join(' ');
    const row: FocusItem = {
      numero_item: idx + 1,
      codigo_produto: (product.code?.trim() || product.id.slice(0, 8)).slice(0, 60),
      descricao: description.trim().slice(0, 120),
      codigo_ncm: ncm,
      cfop,
      unidade_comercial: un,
      quantidade_comercial: quantity,
      valor_unitario_comercial: unitValue,
      unidade_tributavel: un,
      quantidade_tributavel: quantity,
      valor_unitario_tributavel: unitValue,
      valor_bruto: fromCents(gross),
      icms_origem: 0,
      icms_situacao_tributaria: icms,
    };
    if (discountShares[idx]! > 0) row.valor_desconto = fromCents(discountShares[idx]!);
    if (feeShares[idx]! > 0) row.valor_outras_despesas = fromCents(feeShares[idx]!);
    return row;
  });

  const payload: FocusNfcePayload = {
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    data_emissao: issuedAt,
    tipo_documento: 1,
    local_destino: 1,
    consumidor_final: 1,
    presenca_comprador: 1,
    modalidade_frete: 9,
    cnpj_emitente: cnpj,
    valor_produtos: fromCents(subtotal),
    valor_desconto: fromCents(discount),
    valor_outras_despesas: fromCents(fee),
    valor_total: fromCents(total),
    items: nfItems,
    formas_pagamento: payments.map(paymentGroup),
  };

  if (order.customer_cpf) {
    if (!validCpf(order.customer_cpf)) fail('CPF do consumidor inválido.');
    payload.cpf_destinatario = digits(order.customer_cpf);
    payload.indicador_inscricao_estadual_destinatario = 9;
  }
  if (fee > 0) {
    payload.informacoes_adicionais_contribuinte = `Taxa de servico ${String(order.service_fee_pct)}% em outras despesas.`;
  }
  return payload;
}

/** JSON com chaves ordenadas: hash estável do payload congelado. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}
