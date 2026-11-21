/**
 * Layouts de impressão para bobina térmica de 58mm (32 colunas).
 * Usados tanto pelo simulador visual quanto pelos drivers reais
 * (PlugPag printText / Stone printer), por isso são texto puro.
 */
import type { NfceIssuerAddress, DiningTable, NfceDanfePayload, NfceIssuer, Order, OrderItem, Payment, Product, StaffUser, Tenant } from '../types';
import { formatBRL, formatQty } from './money';
import { CONSULTA_URL_RS, formatAccessKey } from './nfce';

export const COLS = 32;

/** Bobina térmica: só ASCII imprimível (mesma blindagem do motor ESC/POS). */
export function ascii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '');
}
const LINE = '-'.repeat(COLS);
const DLINE = '='.repeat(COLS);

function money(v: number): string {
  return formatBRL(v).replace(/ /g, ' ');
}

export function center(text: string): string {
  const t = text.slice(0, COLS);
  const pad = Math.floor((COLS - t.length) / 2);
  return ' '.repeat(pad) + t;
}

export function leftRight(left: string, right: string): string {
  const space = COLS - right.length;
  const l = left.length > space - 1 ? left.slice(0, space - 1) : left;
  return l + ' '.repeat(Math.max(1, COLS - l.length - right.length)) + right;
}

function wrap(text: string, indent = ''): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > COLS - indent.length) {
      if (cur) out.push(indent + cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(indent + cur);
  return out;
}

/**
 * Onde consultar a nota: só imprime endereço de SEFAZ comprovado para a UF da chave (RS, cUF 43).
 * Para outra UF não inventa URL: manda consultar no portal da SEFAZ do estado emitente (o QR Code
 * da própria nota já leva ao endereço certo).
 */
function consultaLines(accessKey: string): string[] {
  if (accessKey.startsWith('43')) return [center('Consulte pela Chave de Acesso em'), center(CONSULTA_URL_RS)];
  return [center('Consulte pela Chave de Acesso'), center('no portal da SEFAZ do estado'), center('emitente ou pelo QR Code')];
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' });
}

function formatCnpj(c: string): string {
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function header(tenant: Pick<Tenant, 'name' | 'legal_name' | 'cnpj' | 'city' | 'state'>, address?: NfceIssuerAddress | null): string[] {
  const out = [center(tenant.name.toUpperCase()), ...wrap(tenant.legal_name).map(center), center(`CNPJ ${formatCnpj(tenant.cnpj)}`)];
  if (address) {
    // Nota real: endereço completo do XML autorizado.
    out.push(
      ...wrap(`${address.street}, ${address.number}${address.complement ? ` ${address.complement}` : ''}`).map(center),
      ...wrap(`${address.district} - ${address.city}/${address.state}`).map(center),
      center(`CEP ${address.zip.replace(/^(\d{5})(\d{3})$/, '$1-$2')}`),
    );
  } else {
    out.push(center(`${tenant.city}/${tenant.state}`));
  }
  return out;
}

/** Valor em reais no padrão brasileiro: vírgula decimal e ponto de milhar (R$ 1.234,50 -> 1.234,50). */
export function brMoney(value: number): string {
  const [int, dec] = value.toFixed(2).split('.');
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

/** Extrato de conferência de mesa (não é documento fiscal). */
export function conferenceLines(params: {
  tenant: Tenant;
  table: DiningTable;
  order: Order;
  items: readonly OrderItem[];
  products: readonly Product[];
  waiter: StaffUser | null;
}): string[] {
  const { order } = params;
  const active = params.items.filter((i) => i.order_id === order.id && i.status !== 'CANCELED');
  // O combo é a linha com preço; os componentes dele aparecem embaixo, sem valor.
  const valid = active.filter((i) => i.combo_parent_item_id == null);
  const lines: string[] = [
    ...header(params.tenant),
    DLINE,
    center('CONFERENCIA DE MESA'),
    center('*** NAO E DOCUMENTO FISCAL ***'),
    DLINE,
    leftRight(params.table.label.toUpperCase(), `${order.customer_count} pessoa(s)`),
    `Aberta: ${fmtDate(order.opened_at)}`,
    `Garcom: ${params.waiter?.name ?? '-'}`,
    LINE,
  ];
  for (const it of valid) {
    const p = params.products.find((x) => x.id === it.product_id);
    lines.push(...wrap(`${formatQty(it.quantity, p?.unit)} ${p?.code ?? ''} ${p?.name ?? 'Item'}`));
    for (const part of active.filter((c) => c.combo_parent_item_id === it.id)) {
      const cp = params.products.find((x) => x.id === part.product_id);
      lines.push(...wrap(`   - ${formatQty(part.quantity, cp?.unit)} ${cp?.name ?? 'Item'}`));
    }
    if (it.meat_doneness) lines.push(`   Ponto: ${it.meat_doneness}`);
    lines.push(leftRight(`   ${it.is_paid ? '[PAGO]' : ''}`, money(it.total_item_price)));
  }
  lines.push(
    LINE,
    leftRight('Subtotal', money(order.subtotal_items)),
    leftRight(order.charge_service_fee ? `Servico ${order.service_fee_pct}% (opcional)` : 'Servico (dispensado)', money(order.service_fee_amount)),
  );
  if (order.discount_amount > 0) lines.push(leftRight('Desconto', `-${money(order.discount_amount)}`));
  lines.push(DLINE, leftRight('TOTAL', money(order.total_amount)));
  if (order.paid_amount > 0) {
    lines.push(leftRight('Ja pago', money(order.paid_amount)), leftRight('SALDO A PAGAR', money(order.remaining_balance)));
  }
  if (order.customer_count > 1) {
    lines.push(LINE, leftRight(`Por pessoa (${order.customer_count})`, money(order.remaining_balance / order.customer_count)));
  }
  lines.push(LINE, center('Obrigado, tche! Volte sempre.'), center(new Date().toLocaleString('pt-BR')), '', '');
  return lines.map(ascii);
}

/** Comprovante TEF / cartão — via do cliente. */
export function cardReceiptLines(params: { tenant: Tenant; payment: Payment; tableLabel: string; maskedPan: string | null }): string[] {
  return cardReceiptRaw(params).map(ascii);
}

function cardReceiptRaw(params: { tenant: Tenant; payment: Payment; tableLabel: string; maskedPan: string | null }): string[] {
  const p = params.payment;
  const methodLabel = p.method === 'CREDIT' ? 'CREDITO A VISTA' : p.method === 'DEBIT' ? 'DEBITO' : p.method === 'PIX' ? 'PIX' : p.method;
  return [
    center(p.acquirer === 'PAGBANK' ? 'PAGBANK - MODERNINHA SMART' : p.acquirer === 'MERCADO_PAGO' ? 'MERCADO PAGO - POINT SMART' : 'STONE PAGAMENTOS'),
    center(`CNPJ ${formatCnpj(p.acquirer_cnpj ?? '')}`),
    LINE,
    center('VIA DO CLIENTE'),
    center(params.tenant.name.toUpperCase().slice(0, COLS)),
    center(`CNPJ ${formatCnpj(params.tenant.cnpj)}`),
    LINE,
    leftRight('TERMINAL', p.terminal_serial ?? '-'),
    leftRight('DATA', fmtDate(p.created_at)),
    leftRight('BANDEIRA', p.card_brand ?? '-'),
    ...(params.maskedPan ? [leftRight('CARTAO', params.maskedPan.replace(/^(\d{4})\d+(\d{4})$/, '$1 **** $2'))] : []),
    leftRight('NSU', p.nsu ?? '-'),
    leftRight('AUT (cAut)', p.authorization_code ?? '-'),
    LINE,
    center(methodLabel),
    leftRight('VALOR', money(p.amount)),
    LINE,
    center(`${params.tableLabel} - TRANSACAO APROVADA`),
    center(p.method === 'PIX' ? 'PAGAMENTO INSTANTANEO' : 'SENHA VERIFICADA'),
    '',
    '',
  ];
}

/** O que o DANFE imprime: a nota simulada (NfceDocument) ou a real (serverNfceDocument). */
export interface DanfeDoc {
  access_key: string;
  protocol: string;
  issued_at: string;
  tributos_federais: number;
  tributos_estaduais: number;
  payload: NfceDanfePayload & { numero: number; serie: number };
  /** Nota real: emitente congelado (ver NfceCloudRecord.issuer). Sem ele, usa o cadastro (demonstração). */
  issuer?: NfceIssuer;
  /** Nota real: endereço completo do emitente (XML autorizado). */
  issuer_address?: NfceIssuerAddress | null;
  /** Nota real autorizada: data/hora da autorização (dhRecbto). Demonstração: igual à emissão. */
  authorized_at?: string;
}

/** DANFE NFC-e simplificado (layout 58mm). O QR Code é desenhado à parte. */
export function danfeLines(params: {
  tenant: Tenant;
  doc: DanfeDoc;
  /** Ambiente da nota; o aviso de homologação só sai em homologação. Padrão: homologação. */
  environment?: 'homologacao' | 'producao';
  /** Nota em contingência offline, ainda sem autorização da SEFAZ. */
  contingency?: boolean;
  /** false quando os tributos aproximados não foram enviados à SEFAZ nesta nota. */
  showTributos?: boolean;
}): { top: string[]; bottom: string[] } {
  const { doc } = params;
  const homologacao = (params.environment ?? 'homologacao') === 'homologacao';
  const pl = doc.payload;
  const em = doc.issuer ?? params.tenant;
  const top: string[] = [
    ...header(em, doc.issuer_address),
    center(`IE ${em.state_registration ?? 'ISENTO'}`),
    // Contingência: a mensagem aparece logo abaixo do cabeçalho e de novo junto da identificação da nota.
    ...(params.contingency ? [LINE, center('EMITIDA EM CONTINGENCIA'), center('Pendente de autorizacao')] : []),
    LINE,
    ...wrap('DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletronica').map(center),
    LINE,
    '#  COD  DESCRICAO',
    '   QTD UN x VL UNIT       VL TOTAL',
  ];
  for (const it of pl.items) {
    top.push(...wrap(`${it.numero_item.toString().padStart(3, '0')} ${it.codigo_produto} ${it.descricao}`));
    top.push(leftRight(`   ${String(it.quantidade_comercial).replace(".", ",")} ${it.unidade_comercial} x ${brMoney(it.valor_unitario_comercial)}`, brMoney(it.valor_bruto)));
  }
  top.push(
    LINE,
    leftRight('Qtd. total de itens', pl.items.length.toString()),
    leftRight('Valor total R$', brMoney(pl.valor_produtos)),
  );
  if (pl.valor_outras_despesas > 0) top.push(leftRight('Outras despesas (servico)', brMoney(pl.valor_outras_despesas)));
  if (pl.valor_desconto > 0) top.push(leftRight('Descontos R$', brMoney(pl.valor_desconto)));
  top.push(leftRight('VALOR A PAGAR R$', brMoney(pl.valor_total)), LINE, leftRight('FORMA PAGAMENTO', 'VALOR PAGO R$'));
  const formaNome: Record<string, string> = { '01': 'Dinheiro', '03': 'Cartao de Credito', '04': 'Cartao de Debito', '10': 'Vale Alimentacao', '17': 'PIX' };
  for (const f of pl.formas_pagamento) top.push(leftRight(formaNome[f.forma_pagamento] ?? f.forma_pagamento, brMoney(f.valor_pagamento)));
  if (params.showTributos !== false) {
    top.push(
      LINE,
      ...wrap(
        `Tributos Totais Incidentes (Lei Federal 12.741/2012): Federal R$ ${brMoney(doc.tributos_federais)} Estadual R$ ${brMoney(doc.tributos_estaduais)} Fonte: IBPT`,
      ),
    );
  }
  top.push(
    LINE,
    center(`NFC-e n ${pl.numero.toString().padStart(9, '0')} Serie ${pl.serie.toString().padStart(3, '0')}`),
    center(fmtDate(doc.issued_at)),
    ...(homologacao ? [center('EMITIDA EM AMBIENTE DE HOMOLOGACAO'), center('SEM VALOR FISCAL')] : []),
    ...(params.contingency ? [center('EMITIDA EM CONTINGENCIA'), center('Pendente de autorizacao')] : []),
    LINE,
    ...consultaLines(doc.access_key),
    ...wrap(formatAccessKey(doc.access_key)).map(center),
    LINE,
    center(pl.cpf_destinatario ? `CONSUMIDOR CPF ${pl.cpf_destinatario.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')}` : 'CONSUMIDOR NAO IDENTIFICADO'),
    LINE,
  );
  if (!params.contingency && doc.protocol) top.push(center('Protocolo de Autorizacao'), center(doc.protocol), center(fmtDate(doc.authorized_at ?? doc.issued_at)));
  const bottom = ['', '', ''];
  return { top: top.map(ascii), bottom };
}
