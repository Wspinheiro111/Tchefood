/**
 * Motor Fiscal NFC-e Modelo 65 — padrão Focus NFe / SEFAZ-RS.
 *
 * - Chave de acesso de 44 dígitos com DV módulo 11.
 * - Taxa de serviço rateada como "valor_outras_despesas" (vOutro) e desconto
 *   como "valor_desconto" (vDesc) item a item, por maiores restos, para que
 *   vNF == total_amount da comanda == Σ formas_pagamento.
 * - Cada pagamento aprovado da rachadinha vira uma entrada em formas_pagamento
 *   com tipo_integracao = 1 (tpIntegra — pagamento integrado TEF/SmartPOS).
 */
import type { Order, OrderItem, Payment, Product, Tenant } from '../types';
import { allocateCents, fromCents, toCents } from './money';
import { sha1Hex } from './sha1';

export const UF_CODE_RS = '43';
export const NFCE_SERIE = 1;
/** 2 = homologação. Trocar para 1 apenas com certificado e CSC de produção. */
export const NFCE_TP_AMB = 2;
const DEMO_CSC_ID = '000001';
const DEMO_CSC = 'TCHEFOOD-CSC-HOMOLOGACAO-0001';

export const FORMA_PAGAMENTO: Record<Payment['method'], string> = {
  CASH: '01',
  CREDIT: '03',
  DEBIT: '04',
  VOUCHER: '10',
  PIX: '17',
};

export const BANDEIRA_OPERADORA: Record<string, string> = {
  VISA: '01',
  MASTERCARD: '02',
  ELO: '06',
  PIX: '99',
};

/** Alíquotas aproximadas (Lei 12.741/2012 — tabela IBPT, estimativa) por prefixo de NCM. */
const IBPT_APROX: Array<{ prefix: string; federal: number; estadual: number }> = [
  { prefix: '2203', federal: 20.03, estadual: 25.0 }, // cervejas e chopps
  { prefix: '2208', federal: 21.48, estadual: 25.0 }, // destilados
  { prefix: '2204', federal: 18.33, estadual: 25.0 }, // vinhos
  { prefix: '2202', federal: 15.38, estadual: 17.0 }, // refrigerantes
  { prefix: '2201', federal: 9.25, estadual: 17.0 }, // água
  { prefix: '2009', federal: 9.25, estadual: 17.0 }, // sucos
  { prefix: '', federal: 13.45, estadual: 12.0 }, // preparações alimentícias (21069090)
];

function ibptFor(ncm: string) {
  return IBPT_APROX.find((r) => ncm.startsWith(r.prefix)) ?? IBPT_APROX[IBPT_APROX.length - 1]!;
}

/** DV da chave de acesso: módulo 11 com pesos 2..9 da direita para a esquerda. */
export function accessKeyCheckDigit(key43: string): string {
  let weight = 2;
  let sum = 0;
  for (let i = key43.length - 1; i >= 0; i--) {
    sum += Number(key43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const mod = sum % 11;
  const dv = mod < 2 ? 0 : 11 - mod;
  return dv.toString();
}

export function buildAccessKey(params: { cnpj: string; issuedAt: Date; number: number; cNF?: string }): string {
  const aamm = `${params.issuedAt.getFullYear().toString().slice(2)}${(params.issuedAt.getMonth() + 1).toString().padStart(2, '0')}`;
  const cNF = (params.cNF ?? Math.floor(Math.random() * 1e8).toString()).padStart(8, '0');
  const key43 =
    UF_CODE_RS +
    aamm +
    params.cnpj.padStart(14, '0') +
    '65' +
    NFCE_SERIE.toString().padStart(3, '0') +
    params.number.toString().padStart(9, '0') +
    '1' + // tpEmis normal
    cNF;
  return key43 + accessKeyCheckDigit(key43);
}

export function parseAccessKey(key: string) {
  return {
    uf: key.slice(0, 2),
    aamm: key.slice(2, 6),
    cnpj: key.slice(6, 20),
    modelo: key.slice(20, 22),
    serie: Number(key.slice(22, 25)),
    numero: Number(key.slice(25, 34)),
    tpEmis: key.slice(34, 35),
    cNF: key.slice(35, 43),
    dv: key.slice(43, 44),
  };
}

export function formatAccessKey(key: string): string {
  return key.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** Protocolo de autorização SEFAZ-RS (15 dígitos: 1 + cUF + AA + sequencial). */
export function buildProtocol(key: string): string {
  const p = parseAccessKey(key);
  return `1${UF_CODE_RS}${p.aamm.slice(0, 2)}${p.numero.toString().padStart(10, '0')}`;
}

/** URL do QR Code de consulta NFC-e v2 (online) da SEFAZ-RS. */
export function buildConsultaQrUrl(key: string, tenant: Pick<Tenant, 'csc_id' | 'csc_token'>): string {
  const cscId = (tenant.csc_id ?? DEMO_CSC_ID).replace(/^0+/, '') || '1';
  const csc = tenant.csc_token ?? DEMO_CSC;
  const base = `${key}|2|${NFCE_TP_AMB}|${cscId}`;
  const hash = sha1Hex(base + csc);
  return `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${base}|${hash}`;
}

export const CONSULTA_URL_RS = 'www.sefaz.rs.gov.br/nfce/consulta';

/**
 * Portado do Tchê Vendas (server/danfceQrCode.ts): só aceita como QR Code do
 * DANFE uma URL http(s) de SEFAZ (.gov.br) cujo parâmetro p começa pela chave
 * de acesso DESTA NFC-e. Um endereço de consulta (sem p), de outra nota ou de
 * outro domínio nunca vira QR Code impresso.
 */
export function isValidNfceQrCodeContent(content: string | null | undefined, accessKey: string | null | undefined): content is string {
  if (!content || content.length > 1000 || /[\s<>"']/.test(content)) return false;
  // Chave pode ter letras nas posições do CNPJ alfanumérico do emitente (NT 2025.001).
  const key = (accessKey ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^NFE/, '');
  if (!/^\d{6}[0-9A-Z]{12}\d{26}$/.test(key)) return false;
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password || !/(^|\.)gov\.br$/i.test(url.hostname)) return false;
  const p = url.searchParams.get('p');
  return Boolean(p) && p!.split('|')[0] === key;
}

/** Extrai o QR Code assinado do XML autorizado (infNFeSupl/qrCode), quando a Focus devolver o XML. */
export function extractNfceQrCodeFromXml(xml: string): string | null {
  const supl = /<(?:\w+:)?infNFeSupl\b[^>]*>([\s\S]*?)<\/(?:\w+:)?infNFeSupl>/.exec(xml);
  if (!supl) return null;
  const qr = /<(?:\w+:)?qrCode\b[^>]*>([\s\S]*?)<\/(?:\w+:)?qrCode>/.exec(supl[1] ?? '');
  if (!qr) return null;
  const raw = (qr[1] ?? '').trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  const value = (cdata ? cdata[1] ?? '' : raw.replace(/&amp;/g, '&')).trim();
  return value || null;
}

export interface FocusNfceItem {
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
  icms_origem: number;
  icms_situacao_tributaria: string;
  valor_total_tributos: number;
}

export interface FocusNfcePagamento {
  forma_pagamento: string;
  valor_pagamento: number;
  tipo_integracao?: number;
  cnpj_credenciadora?: string;
  bandeira_operadora?: string;
  numero_autorizacao?: string;
}

export interface FocusNfcePayload {
  natureza_operacao: 'VENDA AO CONSUMIDOR';
  data_emissao: string;
  tipo_documento: 1;
  presenca_comprador: 1;
  modalidade_frete: 9;
  local_destino: 1;
  consumidor_final: 1;
  finalidade_emissao: 1;
  serie: number;
  numero: number;
  cnpj_emitente: string;
  nome_emitente: string;
  nome_fantasia_emitente: string;
  inscricao_estadual_emitente: string | null;
  municipio_emitente: string;
  uf_emitente: string;
  regime_tributario_emitente: 1;
  cpf_destinatario?: string;
  valor_produtos: number;
  valor_desconto: number;
  valor_outras_despesas: number;
  valor_total: number;
  valor_total_tributos: number;
  informacoes_adicionais_contribuinte: string;
  items: FocusNfceItem[];
  formas_pagamento: FocusNfcePagamento[];
}

export interface NfceDocument {
  ref: string;
  access_key: string;
  protocol: string;
  issued_at: string;
  qr_url: string;
  tributos_federais: number;
  tributos_estaduais: number;
  payload: FocusNfcePayload;
}

export function buildNfce(params: {
  tenant: Tenant;
  order: Order;
  items: readonly OrderItem[];
  payments: readonly Payment[];
  products: readonly Product[];
  tableLabel: string;
}): NfceDocument | null {
  const { tenant, order } = params;
  if (!order.nfce_key) return null;
  // Componente de combo (preço zero) não é linha da nota: o combo é o item vendido.
  const items = params.items.filter((i) => i.order_id === order.id && i.status !== 'CANCELED' && i.combo_parent_item_id == null);
  const payments = params.payments.filter((p) => p.order_id === order.id && p.status === 'APPROVED');
  const itemCents = items.map((i) => toCents(i.total_item_price));
  const otherShares = allocateCents(toCents(order.service_fee_amount), itemCents);
  const discountShares = allocateCents(toCents(order.discount_amount), itemCents);

  let fed = 0;
  let est = 0;
  const nfItems: FocusNfceItem[] = items.map((it, idx) => {
    const product = params.products.find((p) => p.id === it.product_id);
    const ncm = product?.ncm ?? '21069090';
    const rates = ibptFor(ncm);
    const liquidCents = itemCents[idx]! + otherShares[idx]! - discountShares[idx]!;
    const fedCents = Math.round((liquidCents * rates.federal) / 100);
    const estCents = Math.round((liquidCents * rates.estadual) / 100);
    fed += fedCents;
    est += estCents;
    const unit = fromCents(toCents(it.unit_price) + toCents(it.modifiers_unit_price));
    const descr = [product?.name ?? 'ITEM', it.meat_doneness ? `(${it.meat_doneness})` : ''].filter(Boolean).join(' ');
    const row: FocusNfceItem = {
      numero_item: idx + 1,
      codigo_produto: product?.code ?? it.product_id.slice(0, 8),
      descricao: descr.toUpperCase().slice(0, 120),
      codigo_ncm: ncm,
      cfop: product?.cfop ?? '5102',
      unidade_comercial: product?.unit ?? 'UN',
      quantidade_comercial: it.quantity,
      valor_unitario_comercial: unit,
      unidade_tributavel: product?.unit ?? 'UN',
      quantidade_tributavel: it.quantity,
      valor_unitario_tributavel: unit,
      valor_bruto: it.total_item_price,
      icms_origem: 0,
      icms_situacao_tributaria: product?.csosn_cst ?? '102',
      valor_total_tributos: fromCents(fedCents + estCents),
    };
    if (discountShares[idx]! > 0) row.valor_desconto = fromCents(discountShares[idx]!);
    if (otherShares[idx]! > 0) row.valor_outras_despesas = fromCents(otherShares[idx]!);
    return row;
  });

  const formas: FocusNfcePagamento[] = payments.map((p) => {
    const forma: FocusNfcePagamento = { forma_pagamento: FORMA_PAGAMENTO[p.method], valor_pagamento: p.amount };
    if (p.method !== 'CASH') {
      forma.tipo_integracao = 1;
      if (p.acquirer_cnpj) forma.cnpj_credenciadora = p.acquirer_cnpj;
      forma.bandeira_operadora = BANDEIRA_OPERADORA[(p.card_brand ?? '').toUpperCase()] ?? '99';
      if (p.authorization_code) forma.numero_autorizacao = p.authorization_code;
    }
    return forma;
  });

  const key = order.nfce_key;
  const parsed = parseAccessKey(key);
  const issuedAt = order.closed_at ?? new Date().toISOString();
  const payload: FocusNfcePayload = {
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    data_emissao: issuedAt,
    tipo_documento: 1,
    presenca_comprador: 1,
    modalidade_frete: 9,
    local_destino: 1,
    consumidor_final: 1,
    finalidade_emissao: 1,
    serie: parsed.serie,
    numero: parsed.numero,
    cnpj_emitente: tenant.cnpj,
    nome_emitente: tenant.legal_name,
    nome_fantasia_emitente: tenant.name,
    inscricao_estadual_emitente: tenant.state_registration,
    municipio_emitente: tenant.city,
    uf_emitente: tenant.state,
    regime_tributario_emitente: 1,
    valor_produtos: order.subtotal_items,
    valor_desconto: order.discount_amount,
    valor_outras_despesas: order.service_fee_amount,
    valor_total: order.total_amount,
    valor_total_tributos: fromCents(fed + est),
    informacoes_adicionais_contribuinte: `${params.tableLabel} | Taxa de serviço ${order.charge_service_fee ? `${order.service_fee_pct}%` : 'dispensada'} | Tchê Food SmartPOS`,
    items: nfItems,
    formas_pagamento: formas,
  };
  if (order.customer_cpf) payload.cpf_destinatario = order.customer_cpf;

  return {
    ref: `tchefood-${order.id}`,
    access_key: key,
    protocol: buildProtocol(key),
    issued_at: issuedAt,
    qr_url: buildConsultaQrUrl(key, tenant),
    tributos_federais: fromCents(fed),
    tributos_estaduais: fromCents(est),
    payload,
  };
}

/** O que o servidor (emit-nfce) devolveu de uma NFC-e real; ver NfceCloudRecord em types.ts. */
export interface ServerNfceFields {
  status: 'processing' | 'authorized' | 'rejected' | 'contingency' | 'cancelled' | null;
  access_key: string | null;
  protocol: string | null;
  number: number | null;
  series: string | null;
  qrcode_url: string | null;
  issued_at: string | null;
}

/**
 * DANFE da NFC-e real: itens, valores e pagamentos da comanda (os mesmos que o servidor
 * leu do banco) com chave, protocolo, número, série, data de emissão e QR Code do
 * servidor. Nada fiscal é calculado aqui. Só para autorizada (com protocolo) ou
 * contingência, e só com QR Code da SEFAZ para esta chave; senão null (não imprime).
 */
export function serverNfceDocument(local: NfceDocument, server: ServerNfceFields): NfceDocument | null {
  const authorized = server.status === 'authorized';
  if (!authorized && server.status !== 'contingency') return null;
  const key = server.access_key;
  if (!key || !isValidNfceQrCodeContent(server.qrcode_url, key) || !server.issued_at) return null;
  if (authorized && !server.protocol) return null;
  const parsed = parseAccessKey(key);
  return {
    ...local,
    access_key: key,
    protocol: authorized ? server.protocol! : '',
    issued_at: server.issued_at,
    qr_url: server.qrcode_url!,
    payload: {
      ...local.payload,
      data_emissao: server.issued_at,
      numero: server.number ?? parsed.numero,
      serie: server.series ? Number(server.series) : parsed.serie,
    },
  };
}
