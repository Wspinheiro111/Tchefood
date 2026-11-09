/**
 * Leitura do XML da NF-e de compra (modelo 55) enviada pelo fornecedor.
 *
 * Regras portadas do Tchê Vendas (server/purchaseInboundXml.ts e server/nfeXml.ts),
 * todas fail-closed: na dúvida o arquivo é recusado, nunca "consertado".
 *  - sem DOCTYPE/ENTITY (XXE), XML bem-formado e até 4 MB;
 *  - um arquivo = uma NF-e (mais de um infNFe é recusado);
 *  - só modelo 55 e tpNF = 1 (saída do fornecedor = entrada para nós);
 *  - chave de acesso obrigatória, com modelo 55 e dígito verificador válidos
 *    (aceita CNPJ alfanumérico da IN RFB 2.229/2024);
 *  - nItem de 1 a 990, sem repetição; nunca é renumerado;
 *  - se o protNFe vier junto, ele precisa ser da mesma chave e estar autorizado (cStat 100/150);
 *  - a nota precisa ser destinada ao CNPJ do estabelecimento (checado em analyzePurchaseInvoice).
 *
 * Custo de entrada (CMV): o restaurante do Simples Nacional não recupera ICMS/IPI,
 * então o custo de cada item é o valor que efetivamente sai do caixa:
 *   vProd − vDesc + vFrete + vSeg + vOutro + vIPI + vICMSST + vFCPST
 * (todos lidos do próprio item; a NF-e já traz o frete e o desconto rateados por item).
 * O custo unitário é guardado com 4 casas para não perder centavos em embalagens grandes.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { round2, round3, toCents } from './money';

export const NFE_XML_MAX_BYTES = 4_000_000;

export interface PurchaseNfeSupplier {
  /** CNPJ (14) ou CPF (11) do emitente, só dígitos/letras maiúsculas. */
  document: string;
  legal_name: string;
  trade_name: string | null;
  state_registration: string | null;
  city: string | null;
  state: string | null;
}

export interface PurchaseNfeItem {
  /** nItem declarado no XML (o número que aparece no DANFE). */
  n_item: number;
  supplier_code: string;
  /** cEAN; null quando "SEM GTIN" ou ausente. */
  barcode: string | null;
  description: string;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  commercial_unit: string;
  commercial_quantity: number;
  commercial_unit_price: number;
  taxable_unit: string | null;
  taxable_quantity: number | null;
  gross_amount: number;
  discount_amount: number;
  freight_amount: number;
  insurance_amount: number;
  other_amount: number;
  ipi_amount: number;
  icms_st_amount: number;
  fcp_st_amount: number;
  /** Custo total do item que entra no CMV (fórmula do cabeçalho), 2 casas. */
  landed_amount: number;
  /** indTot = 1: o valor do item compõe o total da nota. indTot = 0 fica fora dos totais (ICMSTot). */
  in_invoice_total: boolean;
}

export interface PurchaseNfeTotals {
  products_amount: number;
  discount_amount: number;
  freight_amount: number;
  insurance_amount: number;
  other_amount: number;
  ipi_amount: number;
  icms_st_amount: number;
  fcp_st_amount: number;
  invoice_amount: number;
}

export interface PurchaseNfe {
  access_key: string;
  number: string;
  series: string;
  issued_at: string | null;
  environment: 'PRODUCTION' | 'HOMOLOGATION';
  authorization_protocol: string | null;
  supplier: PurchaseNfeSupplier;
  recipient_document: string | null;
  items: PurchaseNfeItem[];
  totals: PurchaseNfeTotals;
  /** Divergências não bloqueantes, mostradas na conferência. */
  warnings: string[];
}

export class NfeImportError extends Error {}

// ---------------------------------------------------------------------------
// Documentos e chave
// ---------------------------------------------------------------------------

/** Maiúsculas e dígitos, sem pontuação. */
export const documentChars = (value: unknown): string =>
  String(value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

const charValue = (char: string) => char.charCodeAt(0) - 48;

function cnpjCheckDigit(source: string, weights: number[]): number {
  const sum = source.split('').reduce((total, char, i) => total + charValue(char) * (weights[i] ?? 0), 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** CNPJ numérico ou alfanumérico (12 posições 0-9/A-Z + 2 DVs numéricos). */
export function validCnpj(cnpj: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || /^(.)\1{13}$/.test(cnpj)) return false;
  const first = cnpjCheckDigit(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = cnpjCheckDigit(cnpj.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(cnpj[12]) && second === Number(cnpj[13]);
}

export function validCpf(value: string): boolean {
  const cpf = documentChars(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const length of [9, 10]) {
    const sum = cpf.slice(0, length).split('').reduce((t, d, i) => t + Number(d) * (length + 1 - i), 0);
    const result = (sum * 10) % 11;
    if (Number(cpf[length]) !== (result === 10 ? 0 : result)) return false;
  }
  return true;
}

/** Chave de 44 posições, modelo 55, DV módulo 11 (CNPJ do emitente pode ser alfanumérico). */
export function validNfeAccessKey(key: string): boolean {
  if (!/^\d{6}[0-9A-Z]{12}\d{26}$/.test(key) || key.slice(20, 22) !== '55') return false;
  let sum = 0;
  for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1) sum += charValue(key[i]!) * weight;
  const digit = 11 - (sum % 11);
  return Number(key[43]) === (digit >= 10 ? 0 : digit);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

const isNode = (v: unknown): v is XmlNode => !!v && typeof v === 'object' && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const child = (node: unknown, key: string): XmlNode | undefined => {
  const v = isNode(node) ? node[key] : undefined;
  return isNode(v) ? v : undefined;
};
const text = (node: unknown, key: string, max = 255): string | null => {
  const v = isNode(node) ? node[key] : undefined;
  const t = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  return t ? t.slice(0, max) : null;
};
/** Código fiscal com tamanho exato; fora do tamanho vira ausente (nunca é cortado para parecer válido). */
const exactCode = (node: unknown, key: string, length: number): string | null => {
  const t = (text(node, key) ?? '').replace(/\D/g, '');
  return t.length === length ? t : null;
};

/** Decimal da NF-e (ponto como separador). Valor presente e não numérico recusa o arquivo. */
function decimal(node: unknown, key: string, label: string, required = false): number {
  const raw = text(node, key, 40);
  if (raw === null) {
    if (required) throw new NfeImportError(`XML sem ${label}; o arquivo não foi importado.`);
    return 0;
  }
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new NfeImportError(`${label} inválido no XML (${raw}); o arquivo não foi importado.`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new NfeImportError(`${label} inválido no XML (${raw}); o arquivo não foi importado.`);
  return value;
}

/** Primeiro subgrupo de um imposto (ICMS00, ICMSSN500, ...). */
const taxGroup = (tax: unknown, key: string): XmlNode => {
  const g = child(tax, key);
  if (!g) return {};
  return (Object.values(g).find(isNode) as XmlNode | undefined) ?? {};
};

/** nItem conforme o XSD: inteiro de 1 a 990, sem zeros à esquerda. */
const N_ITEM = /^(?:[1-9][0-9]?|[1-8][0-9]{2}|9[0-8][0-9]|990)$/;

const AUTHORIZED_CSTAT = new Set(['100', '150']);

/** Soma em centavos, para comparar totais sem ponto flutuante. */
const sumCents = (values: number[]) => values.reduce((acc, v) => acc + toCents(v), 0);

/**
 * Lê e valida o XML. Não grava nada; o store chama de novo na confirmação
 * para garantir que o que foi conferido é o que é gravado.
 */
export function parsePurchaseNfeXml(xml: string): PurchaseNfe {
  if (typeof xml !== 'string' || !xml.trim()) throw new NfeImportError('Arquivo vazio.');
  if (new TextEncoder().encode(xml).length > NFE_XML_MAX_BYTES) throw new NfeImportError('XML acima de 4 MB; o arquivo não foi importado.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new NfeImportError('XML recusado: contém declaração de tipo de documento.');
  if (XMLValidator.validate(xml) !== true) throw new NfeImportError('Arquivo XML inválido ou corrompido.');
  if ((xml.match(/<(?:[A-Za-z_][\w.-]*:)?infNFe[\s/>]/g) ?? []).length > 1) {
    throw new NfeImportError('O arquivo tem mais de uma NF-e; envie um XML por nota.');
  }

  const parsed = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
    parseTagValue: false,
    removeNSPrefix: true,
    processEntities: true,
  }).parse(xml) as unknown;

  const nfeProc = child(parsed, 'nfeProc');
  const nfe = child(nfeProc ?? parsed, 'NFe');
  const info = child(nfe, 'infNFe');
  if (!info) throw new NfeImportError('Arquivo não contém NF-e de compra (infNFe ausente). XML de NFC-e, CT-e ou evento não serve.');

  const ide = child(info, 'ide');
  if (text(ide, 'mod') !== '55') throw new NfeImportError('Só NF-e modelo 55 pode ser importada como compra.');
  if (text(ide, 'tpNF') !== '1') throw new NfeImportError('Esta NF-e é de entrada emitida pelo próprio fornecedor (tpNF ≠ 1); não é uma venda para você.');
  const tpAmb = text(ide, 'tpAmb');
  if (tpAmb !== '1' && tpAmb !== '2') throw new NfeImportError('NF-e sem ambiente (tpAmb) válido.');

  const rawId = text(info, '@_Id', 60) ?? '';
  if (!/^NFe\d{6}[0-9A-Z]{12}\d{26}$/.test(rawId) || !validNfeAccessKey(rawId.slice(3))) {
    throw new NfeImportError('NF-e sem chave de acesso válida; o arquivo não foi importado.');
  }
  const accessKey = rawId.slice(3);

  // Protocolo de autorização: opcional (há fornecedor que manda só o NFe), mas se vier tem que bater.
  const warnings: string[] = [];
  let protocol: string | null = null;
  const infProt = child(child(nfeProc, 'protNFe'), 'infProt');
  if (infProt) {
    if (text(infProt, 'chNFe', 60) !== accessKey) throw new NfeImportError('O protocolo de autorização é de outra chave; o arquivo não foi importado.');
    const cStat = text(infProt, 'cStat', 5) ?? '';
    if (!AUTHORIZED_CSTAT.has(cStat)) throw new NfeImportError(`NF-e não autorizada pela SEFAZ (cStat ${cStat || '?'}); o arquivo não foi importado.`);
    protocol = text(infProt, 'nProt', 20);
  } else {
    warnings.push('XML sem protocolo de autorização (protNFe). Confira a chave no portal da SEFAZ antes de confirmar.');
  }
  if (tpAmb === '2') warnings.push('NF-e de HOMOLOGAÇÃO (teste, sem valor fiscal).');

  const emit = child(info, 'emit');
  const supplierDoc = documentChars(text(emit, 'CNPJ', 20) ?? text(emit, 'CPF', 20));
  const legalName = text(emit, 'xNome', 120);
  if (!emit || !legalName || !(supplierDoc.length === 14 ? validCnpj(supplierDoc) : supplierDoc.length === 11 && validCpf(supplierDoc))) {
    throw new NfeImportError('Emitente da NF-e sem nome ou CNPJ/CPF válido.');
  }
  const enderEmit = child(emit, 'enderEmit');

  const dest = child(info, 'dest');
  const destDocs = ['CNPJ', 'CPF', 'idEstrangeiro'].filter((k) => isNode(dest) && dest[k] !== undefined);
  const recipientRaw = destDocs.length === 1 && destDocs[0] !== 'idEstrangeiro' ? documentChars(text(dest, destDocs[0]!, 20)) : '';
  // Só a forma é exigida aqui; a conferência compara com o CNPJ do estabelecimento, caractere a caractere.
  const recipientDocument = /^[0-9A-Z]{12}\d{2}$/.test(recipientRaw) || /^\d{11}$/.test(recipientRaw) ? recipientRaw : null;

  const details = asArray(info.det);
  if (!details.length) throw new NfeImportError('Nenhum item de produto foi encontrado no XML da NF-e.');
  const declared = details.map((d) => (isNode(d) ? String(d['@_nItem'] ?? '').trim() : ''));
  if (declared.some((v) => !N_ITEM.test(v)) || new Set(declared).size !== declared.length) {
    throw new NfeImportError('XML com nItem ausente, repetido ou inválido; o arquivo não foi importado.');
  }

  const items: PurchaseNfeItem[] = details.map((d, index) => {
    const prod = child(d, 'prod');
    const label = `item ${declared[index]}`;
    const description = text(prod, 'xProd', 120);
    if (!prod || !description) throw new NfeImportError(`O ${label} não tem descrição (xProd).`);
    const imposto = child(d, 'imposto');
    const icms = taxGroup(imposto, 'ICMS');
    const ipiTrib = child(child(imposto, 'IPI'), 'IPITrib');
    const quantity = round4(decimal(prod, 'qCom', `quantidade do ${label}`, true));
    if (!(quantity > 0)) throw new NfeImportError(`Quantidade zerada no ${label}.`);
    const gross = round2(decimal(prod, 'vProd', `valor do ${label}`, true));
    const discount = round2(decimal(prod, 'vDesc', `desconto do ${label}`));
    const freight = round2(decimal(prod, 'vFrete', `frete do ${label}`));
    const insurance = round2(decimal(prod, 'vSeg', `seguro do ${label}`));
    const other = round2(decimal(prod, 'vOutro', `outras despesas do ${label}`));
    const ipi = round2(decimal(ipiTrib, 'vIPI', `IPI do ${label}`));
    const icmsSt = round2(decimal(icms, 'vICMSST', `ICMS-ST do ${label}`));
    const fcpSt = round2(decimal(icms, 'vFCPST', `FCP-ST do ${label}`));
    const landedCents = toCents(gross) - toCents(discount) + toCents(freight) + toCents(insurance) + toCents(other) + toCents(ipi) + toCents(icmsSt) + toCents(fcpSt);
    if (landedCents < 0) throw new NfeImportError(`Desconto maior que o valor do ${label}.`);
    const barcode = text(prod, 'cEAN', 14);
    const taxableQty = text(prod, 'qTrib', 40);
    return {
      n_item: Number(declared[index]),
      supplier_code: text(prod, 'cProd', 60) ?? '',
      barcode: barcode && /^\d{8,14}$/.test(barcode) ? barcode : null,
      description,
      ncm: exactCode(prod, 'NCM', 8),
      cest: exactCode(prod, 'CEST', 7),
      cfop: exactCode(prod, 'CFOP', 4),
      commercial_unit: (text(prod, 'uCom', 6) ?? 'UN').toUpperCase(),
      commercial_quantity: quantity,
      commercial_unit_price: decimal(prod, 'vUnCom', `valor unitário do ${label}`),
      taxable_unit: text(prod, 'uTrib', 6)?.toUpperCase() ?? null,
      taxable_quantity: taxableQty === null ? null : round4(decimal(prod, 'qTrib', `quantidade tributável do ${label}`)),
      gross_amount: gross,
      discount_amount: discount,
      freight_amount: freight,
      insurance_amount: insurance,
      other_amount: other,
      ipi_amount: ipi,
      icms_st_amount: icmsSt,
      fcp_st_amount: fcpSt,
      landed_amount: landedCents / 100,
      in_invoice_total: text(prod, 'indTot', 1) !== '0',
    };
  });

  const tot = child(child(info, 'total'), 'ICMSTot');
  if (!tot) throw new NfeImportError('XML sem totais da nota (ICMSTot).');
  const totals: PurchaseNfeTotals = {
    products_amount: round2(decimal(tot, 'vProd', 'total dos produtos', true)),
    discount_amount: round2(decimal(tot, 'vDesc', 'total de desconto')),
    freight_amount: round2(decimal(tot, 'vFrete', 'total de frete')),
    insurance_amount: round2(decimal(tot, 'vSeg', 'total de seguro')),
    other_amount: round2(decimal(tot, 'vOutro', 'total de outras despesas')),
    ipi_amount: round2(decimal(tot, 'vIPI', 'total de IPI')),
    icms_st_amount: round2(decimal(tot, 'vST', 'total de ICMS-ST')),
    fcp_st_amount: round2(decimal(tot, 'vFCPST', 'total de FCP-ST')),
    invoice_amount: round2(decimal(tot, 'vNF', 'valor total da nota', true)),
  };

  // Os itens precisam fechar com o total da nota: se não fecham, o custo gravado estaria errado.
  // Itens com indTot = 0 não entram no ICMSTot; continuam na nota para a conferência decidir.
  const totalled = items.filter((i) => i.in_invoice_total);
  for (const i of items) if (!i.in_invoice_total) warnings.push(`O item ${i.n_item} não compõe o total da nota (indTot = 0). Confira se ele foi cobrado antes de dar entrada.`);
  if (sumCents(totalled.map((i) => i.gross_amount)) !== toCents(totals.products_amount)) {
    throw new NfeImportError('A soma dos itens não bate com o total dos produtos da nota (vProd); o arquivo não foi importado.');
  }
  const checks: Array<[keyof PurchaseNfeItem, keyof PurchaseNfeTotals, string]> = [
    ['discount_amount', 'discount_amount', 'desconto'],
    ['freight_amount', 'freight_amount', 'frete'],
    ['insurance_amount', 'insurance_amount', 'seguro'],
    ['other_amount', 'other_amount', 'outras despesas'],
    ['ipi_amount', 'ipi_amount', 'IPI'],
    ['icms_st_amount', 'icms_st_amount', 'ICMS-ST'],
  ];
  for (const [itemKey, totalKey, label] of checks) {
    if (sumCents(totalled.map((i) => i[itemKey] as number)) !== toCents(totals[totalKey])) {
      warnings.push(`O ${label} dos itens não fecha com o total da nota. O custo usa os valores de cada item.`);
    }
  }
  const landedTotal = sumCents(totalled.map((i) => i.landed_amount));
  if (landedTotal !== toCents(totals.invoice_amount)) {
    warnings.push(`O custo somado dos itens (${(landedTotal / 100).toFixed(2)}) difere do valor da nota (${totals.invoice_amount.toFixed(2)}), por exemplo por ICMS desonerado ou II. Confira.`);
  }

  return {
    access_key: accessKey,
    number: text(ide, 'nNF', 9) ?? accessKey.slice(25, 34).replace(/^0+/, ''),
    series: text(ide, 'serie', 3) ?? String(Number(accessKey.slice(22, 25))),
    issued_at: text(ide, 'dhEmi', 40) ?? text(ide, 'dEmi', 20),
    environment: tpAmb === '1' ? 'PRODUCTION' : 'HOMOLOGATION',
    authorization_protocol: protocol,
    supplier: {
      document: supplierDoc,
      legal_name: legalName,
      trade_name: text(emit, 'xFant', 120),
      state_registration: text(emit, 'IE', 20),
      city: text(enderEmit, 'xMun', 60),
      state: text(enderEmit, 'UF', 2)?.toUpperCase() ?? null,
    },
    recipient_document: recipientDocument,
    items,
    totals,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Embalagem: "10 CX com 12" entra no estoque como 120 UN
// ---------------------------------------------------------------------------

const COUNT_UNITS = new Set(['UN', 'UND', 'UNID', 'UNIDADE', 'PC', 'PCA', 'PECA']);

/** Unidade em maiúsculas, sem acento e sem ponto ("Pç." vira "PC"). */
export function normalizeUnit(value: string | null | undefined): string | null {
  const unit = value?.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.\s]/g, '').toUpperCase().slice(0, 6);
  return unit || null;
}

/**
 * Fator sugerido pela unidade tributável (regra do Tchê Vendas, shared/purchasePackaging.ts):
 * CX 10 na unidade comercial e UN 120 na tributável = 12. Litro, quilo etc. não servem
 * (a unidade tributável da cerveja é litro, e isso não diz quantas latas há na caixa).
 */
export function packagingFactorFromInvoice(item: Pick<PurchaseNfeItem, 'commercial_unit' | 'commercial_quantity' | 'taxable_unit' | 'taxable_quantity'>): number | null {
  const commercial = normalizeUnit(item.commercial_unit);
  const taxable = normalizeUnit(item.taxable_unit);
  if (!commercial || !taxable || commercial === taxable || !COUNT_UNITS.has(taxable) || COUNT_UNITS.has(commercial)) return null;
  const tq = Number(item.taxable_quantity);
  if (!(item.commercial_quantity > 0) || !(tq > 0)) return null;
  const ratio = tq / item.commercial_quantity;
  const rounded = round3(ratio);
  return rounded > 1 && rounded <= 1_000_000 && Math.abs(ratio - rounded) < 1e-6 ? rounded : null;
}

// ---------------------------------------------------------------------------
// Custo
// ---------------------------------------------------------------------------

/** Arredonda para 4 casas (custo unitário de entrada). */
export function round4(value: number): number {
  const scaled = Math.abs(value) * 10_000;
  const rounded = Math.round(scaled + Number.EPSILON * scaled);
  return (value < 0 ? -rounded : rounded) / 10_000;
}

/** Custo unitário na unidade de estoque: custo total do item ÷ quantidade que entra no estoque. */
export function unitCostOf(landedAmount: number, stockQuantity: number): number {
  if (!(stockQuantity > 0)) return 0;
  return round4(toCents(landedAmount) / 100 / stockQuantity);
}

/**
 * Custo médio ponderado depois da entrada.
 * Saldo zerado ou negativo (vendeu sem dar entrada) não pesa: o custo passa a ser o da nota.
 */
export function weightedAverageCost(currentQty: number, currentCost: number, inQty: number, inUnitCost: number): number {
  if (!(inQty > 0)) return round4(currentCost);
  if (!(currentQty > 0)) return round4(inUnitCost);
  return round4((currentQty * currentCost + inQty * inUnitCost) / (currentQty + inQty));
}

/** Nome comparável: sem acento, maiúsculo, espaços simples. */
export function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
