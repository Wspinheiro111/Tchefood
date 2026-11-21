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
import type { NfceDanfePayload, NfceIssuer, NfceIssuerAddress, Order, OrderItem, Payment, Product, Tenant } from '../types';
import type { DanfeDoc } from './receipts';
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
    // CNPJ alfanumérico (NT 2025.001): valor do caractere = código ASCII - 48 (0-9 → 0-9, A-Z → 17-42).
    sum += (key43.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const mod = sum % 11;
  const dv = mod < 2 ? 0 : 11 - mod;
  return dv.toString();
}

/**
 * Chave de acesso de 44 posições com o DV (módulo 11) conferido. Não corrige nem reconstrói a chave:
 * só diz se ela é aceitável. Aceita letras só nas posições do CNPJ (NT 2025.001).
 */
export function isValidAccessKey(key: string | null | undefined): key is string {
  if (!key || !/^\d{6}[0-9A-Z]{12}\d{26}$/.test(key)) return false;
  return accessKeyCheckDigit(key.slice(0, 43)) === key[43];
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
 * Estrutura do parâmetro p do QR Code NFC-e (sem recalcular assinatura/CSC): versão 2 online
 * chave|2|tpAmb|cIdToken|cHashQRCode (5 campos, hash hexadecimal de 40), versão 2 offline (contingência)
 * chave|2|tpAmb|dia|vNF|digVal|cIdToken|cHashQRCode (8), versão 3 chave|3|tpAmb (3). Sem campos extras.
 */
function qrParamsStructureOk(parts: string[], accessKey: string): boolean {
  const hash = (v: string | undefined) => /^[0-9A-Fa-f]{40}$/.test(v ?? '');
  // tpEmis da chave (posição 34): 1 = normal (online), 9 = contingência offline. A modalidade do QR tem de combinar.
  const tpEmis = accessKey[34];
  const online = parts.length === 5 || (parts[1] === '3' && parts.length === 3);
  if (online ? tpEmis !== '1' : tpEmis !== '9') return false;
  if (parts[1] === '2') {
    if (parts.length === 5) return /^\d{1,6}$/.test(parts[3] ?? '') && hash(parts[4]);
    if (parts.length === 8) {
      // digVal = DigestValue (28 caracteres base64) em hexadecimal: exatamente 56 hex.
      return /^\d{2}$/.test(parts[3] ?? '') && /^\d+(\.\d{1,2})?$/.test(parts[4] ?? '') && /^[0-9A-Fa-f]{56}$/.test(parts[5] ?? '') && /^\d{1,6}$/.test(parts[6] ?? '') && hash(parts[7]);
    }
    return false;
  }
  if (parts[1] !== '3' || !/^[12]$/.test(parts[2] ?? '')) return false;
  if (parts.length === 3) return true;
  // 3.0 offline (NT 2025.001): 8 campos, com identificação do destinatário e assinatura. O leiaute exato dos campos
  // extras não foi conferido com fixture oficial: aqui só se exige presença, charset seguro e tamanho.
  return parts.length === 8 && parts.slice(3).every((v) => /^[A-Za-z0-9+/=_.-]{1,400}$/.test(v));
}

/**
 * Portais de consulta NFC-e (destino do QR Code) por cUF da chave. Só entra UF com endereço oficial
 * conferido; as demais não imprimem QR próprio (o DANFE oficial da Focus cobre). RS é a UF do piloto.
 */
export const NFCE_QR_PORTALS: Readonly<Record<string, { host: string; path: string }>> = {
  '43': { host: 'www.sefaz.rs.gov.br', path: '/nfce/nfce-com.aspx' },
};

/**
 * Portado do Tchê Vendas (server/danfceQrCode.ts): só aceita como QR Code do
 * DANFE uma URL http(s) de SEFAZ (.gov.br) cujo parâmetro p começa pela chave
 * de acesso DESTA NFC-e. Um endereço de consulta (sem p), de outra nota ou de
 * outro domínio nunca vira QR Code impresso.
 */
export function isValidNfceQrCodeContent(
  content: string | null | undefined,
  accessKey: string | null | undefined,
  environment?: 'homologacao' | 'producao' | null,
): content is string {
  if (!content || content.length > 1000 || /[\s<>"']/.test(content)) return false;
  // Chave pode ter letras nas posições do CNPJ alfanumérico do emitente (NT 2025.001).
  const key = (accessKey ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^NFE/, '');
  if (!isValidAccessKey(key)) return false;
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    return false;
  }
  // Só o portal de consulta NFC-e da UF da chave (HTTPS, host e caminho exatos). Conferência de endereço
  // e de estrutura, não prova criptográfica da assinatura do QR Code.
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const portal = NFCE_QR_PORTALS[key.slice(0, 2)];
  if (!portal || url.hostname.toLowerCase() !== portal.host || url.pathname.toLowerCase() !== portal.path) return false;
  // p lido cru: searchParams decodificaria '+' (válido em assinatura base64) como espaço.
  const rawP = /[?&]p=([^&#]*)/.exec(url.search)?.[1];
  let p: string | null = null;
  try {
    p = rawP ? decodeURIComponent(rawP) : null;
  } catch {
    return false;
  }
  if (!p) return false;
  const parts = p.split('|');
  if (parts[0] !== key) return false;
  // Nas versões do QR Code com tpAmb (chave|versão|tpAmb|...), o ambiente do QR precisa ser o da nota.
  // Versão 2: chave|2|tpAmb|cIdToken|hash (5 campos); versão 3: chave|3|tpAmb (3). QR sem versão ou tpAmb (p=CHAVE|2) não vale quando o ambiente da nota é conhecido.
  if (!qrParamsStructureOk(parts, key)) return false;
  if (environment && parts[2] !== (environment === 'producao' ? '1' : '2')) return false;
  return true;
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
  payload: NfceDanfePayload | null;
  issuer?: NfceIssuer | null;
  issuer_address?: NfceIssuerAddress | null;
  authorized_at?: string | null;
  environment?: 'homologacao' | 'producao' | null;
}

/**
 * DANFE da NFC-e real, montado só com o que o servidor devolveu: o payload transmitido
 * (itens, valores, pagamentos, CPF) mais chave, protocolo, número, série, data de emissão
 * e QR Code. Nada vem do cadastro atual do aparelho, que pode ter mudado depois da nota.
 * Só para autorizada (com protocolo) ou contingência, com QR Code da SEFAZ para esta
 * chave; senão null (não imprime). Tributos aproximados não foram enviados: ficam zero e o
 * DANFE não os mostra (showTributos: false).
 */
export function serverNfceDocument(server: ServerNfceFields): (DanfeDoc & { qr_url: string }) | null {
  const authorized = server.status === 'authorized';
  if (!authorized && server.status !== 'contingency') return null;
  const key = server.access_key;
  if (!key || !isValidNfceQrCodeContent(server.qrcode_url, key, server.environment) || !server.issued_at || !server.payload) return null;
  if (authorized && !server.protocol) return null;
  const parsed = parseAccessKey(key);
  // Número, série e modelo devolvidos precisam ser os da chave (modelo 65 = NFC-e).
  if (parsed.modelo !== '65') return null;
  if (server.number !== null && server.number !== parsed.numero) return null;
  if (server.series !== null && (!/^\d{1,3}$/.test(server.series) || Number(server.series) !== parsed.serie)) return null;
  // Emitente: o CNPJ transmitido e o congelado precisam ser os da chave; senão, só o DANFE da Focus.
  if (!server.issuer || server.issuer.cnpj !== parsed.cnpj || server.payload.cnpj_emitente !== parsed.cnpj) return null;
  // IE ausente no cadastro não prova "ISENTO": sem a IE comprovada a bobina não imprime (DANFE oficial da Focus).
  if (!server.issuer.state_registration) return null;
  // Endereço completo do emitente (XML autorizado) e hora real da autorização: sem eles não imprime,
  // fica o DANFE oficial da Focus. Nada é reconstruído a partir do cadastro ou da data de emissão.
  const address = server.issuer_address;
  if (!address || !address.street || !address.number || !address.district || !address.city || !address.state || !/^\d{8}$/.test(address.zip)) return null;
  if (authorized && (!server.authorized_at || Number.isNaN(Date.parse(server.authorized_at)))) return null;
  return {
    access_key: key,
    protocol: authorized ? server.protocol! : '',
    issued_at: server.issued_at,
    qr_url: server.qrcode_url!,
    tributos_federais: 0,
    tributos_estaduais: 0,
    issuer: server.issuer,
    issuer_address: address,
    ...(authorized ? { authorized_at: server.authorized_at! } : {}),
    payload: {
      ...server.payload,
      numero: parsed.numero,
      serie: parsed.serie,
    },
  };
}
