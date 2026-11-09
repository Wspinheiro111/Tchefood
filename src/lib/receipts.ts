/**
 * Layouts de impressão para bobina térmica de 58mm (32 colunas).
 * Usados tanto pelo simulador visual quanto pelos drivers reais
 * (PlugPag printText / Stone printer), por isso são texto puro.
 */
import type { DiningTable, Order, OrderItem, Payment, Product, StaffUser, Tenant } from '../types';
import { formatBRL, formatQty } from './money';
import type { NfceDocument } from './nfce';
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

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatCnpj(c: string): string {
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function header(tenant: Tenant): string[] {
  return [center(tenant.name.toUpperCase()), ...wrap(tenant.legal_name).map(center), center(`CNPJ ${formatCnpj(tenant.cnpj)}`), center(`${tenant.city}/${tenant.state}`)];
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
    center(p.acquirer === 'PAGBANK' ? 'PAGBANK - MODERNINHA SMART' : 'STONE PAGAMENTOS'),
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

/** DANFE NFC-e simplificado (layout 58mm). O QR Code é desenhado à parte. */
export function danfeLines(params: { tenant: Tenant; doc: NfceDocument }): { top: string[]; bottom: string[] } {
  const { doc } = params;
  const pl = doc.payload;
  const top: string[] = [
    ...header(params.tenant),
    center(`IE ${params.tenant.state_registration ?? 'ISENTO'}`),
    LINE,
    ...wrap('DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletronica').map(center),
    LINE,
    '#  COD  DESCRICAO',
    '   QTD UN x VL UNIT       VL TOTAL',
  ];
  for (const it of pl.items) {
    top.push(...wrap(`${it.numero_item.toString().padStart(3, '0')} ${it.codigo_produto} ${it.descricao}`));
    top.push(leftRight(`   ${it.quantidade_comercial} ${it.unidade_comercial} x ${it.valor_unitario_comercial.toFixed(2)}`, it.valor_bruto.toFixed(2)));
  }
  top.push(
    LINE,
    leftRight('Qtd. total de itens', pl.items.length.toString()),
    leftRight('Valor total R$', pl.valor_produtos.toFixed(2)),
  );
  if (pl.valor_outras_despesas > 0) top.push(leftRight('Outras despesas (servico)', pl.valor_outras_despesas.toFixed(2)));
  if (pl.valor_desconto > 0) top.push(leftRight('Descontos R$', pl.valor_desconto.toFixed(2)));
  top.push(leftRight('VALOR A PAGAR R$', pl.valor_total.toFixed(2)), LINE, leftRight('FORMA PAGAMENTO', 'VALOR PAGO R$'));
  const formaNome: Record<string, string> = { '01': 'Dinheiro', '03': 'Cartao de Credito', '04': 'Cartao de Debito', '10': 'Vale Alimentacao', '17': 'PIX' };
  for (const f of pl.formas_pagamento) top.push(leftRight(formaNome[f.forma_pagamento] ?? f.forma_pagamento, f.valor_pagamento.toFixed(2)));
  top.push(
    LINE,
    ...wrap(
      `Tributos Totais Incidentes (Lei Federal 12.741/2012): Federal R$ ${doc.tributos_federais.toFixed(2)} Estadual R$ ${doc.tributos_estaduais.toFixed(2)} Fonte: IBPT`,
    ),
    LINE,
    center(`NFC-e n ${pl.numero.toString().padStart(9, '0')} Serie ${pl.serie.toString().padStart(3, '0')}`),
    center(fmtDate(doc.issued_at)),
    center('EMITIDA EM AMBIENTE DE HOMOLOGACAO'),
    center('SEM VALOR FISCAL'),
    LINE,
    center('Consulte pela Chave de Acesso em'),
    center(CONSULTA_URL_RS),
    ...wrap(formatAccessKey(doc.access_key)).map(center),
    LINE,
    center(pl.cpf_destinatario ? `CONSUMIDOR CPF ${pl.cpf_destinatario.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')}` : 'CONSUMIDOR NAO IDENTIFICADO'),
    LINE,
    center('Protocolo de Autorizacao'),
    center(doc.protocol),
    center(fmtDate(doc.issued_at)),
  );
  const bottom = ['', center('Tche Food SmartPOS - tpIntegra 1'), '', ''];
  return { top: top.map(ascii), bottom };
}
