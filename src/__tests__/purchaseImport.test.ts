import { beforeEach, describe, expect, it } from 'vitest';
import { migratePersisted, useTcheStore } from '../store/useTcheStore';
import {
  NfeImportError,
  packagingFactorFromInvoice,
  parsePurchaseNfeXml,
  validNfeAccessKey,
  weightedAverageCost,
} from '../lib/nfeImport';
import { analyzePurchaseInvoice, type PurchaseItemDecision } from '../lib/purchaseImport';
import { SAMPLE_NFE_ACCESS_KEY, sampleNfeXml } from '../data/sampleNfe';

const st = () => useTcheStore.getState();
const refri = () => st().products.find((p) => p.code === '221')!;
const firstCategory = () => st().categories[0]!.id;

const decisions = (overrides: Partial<Record<number, PurchaseItemDecision>> = {}): PurchaseItemDecision[] => [
  overrides[1] ?? { n_item: 1, action: 'LINK', product_id: refri().id, packaging_factor: 12 },
  overrides[2] ?? { n_item: 2, action: 'CREATE', packaging_factor: 1, name: 'Picanha (peça)', category_id: firstCategory(), unit: 'KG' },
  overrides[3] ?? { n_item: 3, action: 'IGNORE' },
];

beforeEach(() => {
  st().resetDemo();
  expect(st().login('9999').ok).toBe(true); // gerente
});

describe('leitura do XML da NF-e', () => {
  it('lê chave, fornecedor, itens e custo de entrada', () => {
    const nfe = parsePurchaseNfeXml(sampleNfeXml());
    expect(nfe.access_key).toBe(SAMPLE_NFE_ACCESS_KEY);
    expect(nfe.number).toBe('4521');
    expect(nfe.authorization_protocol).toBe('143260000045210');
    expect(nfe.supplier.document).toBe('11222333000181');
    expect(nfe.items).toHaveLength(3);
    const [lata, picanha, carvao] = nfe.items;
    // produto + frete + ICMS-ST
    expect(lata!.landed_amount).toBe(89.6);
    expect(lata!.barcode).toBe('7890000000017');
    // produto − desconto + frete
    expect(picanha!.landed_amount).toBe(990);
    expect(picanha!.barcode).toBeNull();
    expect(carvao!.landed_amount).toBe(90);
    expect(nfe.totals.invoice_amount).toBe(1169.6);
    expect(nfe.warnings).toEqual([]);
  });

  it('valida a chave de acesso pelo dígito verificador', () => {
    expect(validNfeAccessKey(SAMPLE_NFE_ACCESS_KEY)).toBe(true);
    expect(validNfeAccessKey(SAMPLE_NFE_ACCESS_KEY.slice(0, 43) + '5')).toBe(false);
    // NFC-e (modelo 65) não é nota de compra
    expect(validNfeAccessKey(SAMPLE_NFE_ACCESS_KEY.replace(/^(.{20})55/, '$165'))).toBe(false);
  });

  const reject = (xml: string, message: RegExp) => expect(() => parsePurchaseNfeXml(xml)).toThrowError(message);

  it('recusa XML com DOCTYPE/ENTITY (XXE)', () => {
    reject(sampleNfeXml().replace('<nfeProc', '<!DOCTYPE x [<!ENTITY a "b">]><nfeProc'), /declaração de tipo/);
  });

  it('recusa chave com DV errado', () => {
    const bad = SAMPLE_NFE_ACCESS_KEY.slice(0, 43) + '0';
    reject(sampleNfeXml().replace(`NFe${SAMPLE_NFE_ACCESS_KEY}`, `NFe${bad}`), /chave de acesso válida/);
  });

  it('recusa NFC-e e nota que não é de saída do fornecedor', () => {
    reject(sampleNfeXml().replace('<mod>55</mod>', '<mod>65</mod>'), /modelo 55/);
    reject(sampleNfeXml().replace('<tpNF>1</tpNF>', '<tpNF>0</tpNF>'), /tpNF/);
  });

  it('recusa nota não autorizada ou com protocolo de outra chave', () => {
    reject(sampleNfeXml().replace('<cStat>100</cStat>', '<cStat>110</cStat>'), /não autorizada/);
    reject(sampleNfeXml().replace(`<chNFe>${SAMPLE_NFE_ACCESS_KEY}</chNFe>`, '<chNFe>43261111222333000181550010000045221123456780</chNFe>'), /outra chave/);
  });

  it('aceita NF-e sem protocolo, com aviso', () => {
    const xml = sampleNfeXml().replace(/<protNFe[\s\S]*<\/protNFe>/, '');
    const nfe = parsePurchaseNfeXml(xml);
    expect(nfe.authorization_protocol).toBeNull();
    expect(nfe.warnings.join(' ')).toMatch(/sem protocolo/);
  });

  it('recusa nItem repetido e item que não fecha com o total', () => {
    reject(sampleNfeXml().replace('<det nItem="2">', '<det nItem="1">'), /nItem/);
    reject(sampleNfeXml().replace('<vProd>998.75</vProd>', '<vProd>998.76</vProd>'), /não bate/);
  });

  it('item com indTot = 0 fica fora da conferência do total, mas continua na nota', () => {
    const xml = sampleNfeXml()
      .replace('<vUnTrib>22.5000000000</vUnTrib><indTot>1</indTot>', '<vUnTrib>22.5000000000</vUnTrib><indTot>0</indTot>')
      .replace('<vProd>1165.55</vProd>', '<vProd>1075.55</vProd>')
      .replace('<vNF>1169.60</vNF>', '<vNF>1079.60</vNF>');
    const nfe = parsePurchaseNfeXml(xml);
    expect(nfe.items).toHaveLength(3);
    expect(nfe.items[2]!.in_invoice_total).toBe(false);
    expect(nfe.warnings).toEqual([expect.stringMatching(/item 3 não compõe o total/)]);
  });

  it('recusa valor não numérico em vez de tratar como zero', () => {
    reject(sampleNfeXml().replace('<vDesc>18.75</vDesc>', '<vDesc>18,75</vDesc>'), /desconto do item 2 inválido/);
  });

  it('recusa arquivo com duas NF-e', () => {
    const one = sampleNfeXml().match(/<NFe [\s\S]*<\/NFe>/)![0];
    reject(`<lote>${one}${one}</lote>`, /mais de uma NF-e/);
  });

  it('erros são NfeImportError', () => {
    expect(() => parsePurchaseNfeXml('<a>')).toThrowError(NfeImportError);
  });
});

describe('embalagem e custo médio', () => {
  it('sugere o fator pela unidade tributável só para contagem', () => {
    expect(packagingFactorFromInvoice({ commercial_unit: 'CX', commercial_quantity: 2, taxable_unit: 'UN', taxable_quantity: 24 })).toBe(12);
    expect(packagingFactorFromInvoice({ commercial_unit: 'CX', commercial_quantity: 2, taxable_unit: 'L', taxable_quantity: 8.4 })).toBeNull();
    expect(packagingFactorFromInvoice({ commercial_unit: 'KG', commercial_quantity: 12.5, taxable_unit: 'KG', taxable_quantity: 12.5 })).toBeNull();
  });

  it('custo médio ponderado; saldo zerado ou negativo não pesa', () => {
    expect(weightedAverageCost(10, 4, 10, 6)).toBe(5);
    expect(weightedAverageCost(0, 4, 10, 6)).toBe(6);
    expect(weightedAverageCost(-3, 4, 10, 6)).toBe(6);
  });
});

describe('conferência', () => {
  it('casa o refrigerante pelo EAN e sugere o fator 12', () => {
    const s = st();
    const a = analyzePurchaseInvoice({ ...s }, parsePurchaseNfeXml(sampleNfeXml()));
    expect(a.blocker).toBeNull();
    expect(a.duplicate).toBeNull();
    expect(a.items[0]!.suggestion).toEqual({ product_id: refri().id, via: 'BARCODE' });
    expect(a.items[0]!.factor).toBe(12);
    expect(a.items[0]!.factor_source).toBe('INVOICE');
    expect(a.items[1]!.suggestion).toBeNull();
  });

  it('bloqueia nota destinada a outro CNPJ', () => {
    const a = analyzePurchaseInvoice({ ...st() }, parsePurchaseNfeXml(sampleNfeXml('11222333000181')));
    expect(a.blocker).toMatch(/outro CNPJ/);
    const r = st().importPurchaseInvoice(sampleNfeXml('11222333000181'), decisions());
    expect(r.ok).toBe(false);
  });
});

describe('importação para o estoque', () => {
  it('dá entrada, calcula custo, cria produto fora da venda e grava a nota', () => {
    const r = st().importPurchaseInvoice(sampleNfeXml(), decisions());
    if (!r.ok) throw new Error(r.error);
    const s = st();
    // 2 CX × 12 = 24 latas; 89,60 / 24 = 3,7333
    expect(refri().stock_quantity).toBe(24);
    expect(refri().cost_price).toBe(3.73);
    const picanha = s.products.find((p) => p.name === 'Picanha (peça)')!;
    expect(picanha.available).toBe(false);
    expect(picanha.unit).toBe('KG');
    expect(picanha.ncm).toBe('02013000');
    expect(picanha.stock_quantity).toBe(12.5);
    expect(picanha.cost_price).toBe(79.2);
    expect(s.products.some((p) => p.name.includes('CARVAO'))).toBe(false);

    expect(s.purchaseInvoices).toHaveLength(1);
    expect(s.purchaseInvoices[0]!.stocked_amount).toBe(1079.6); // 89,60 + 990,00 (carvão ignorado)
    expect(s.purchaseInvoiceItems).toHaveLength(3);
    expect(s.stockMovements).toHaveLength(2);
    expect(s.stockMovements[0]!.unit_cost).toBe(3.7333);
    expect(s.suppliers).toHaveLength(1);
    expect(s.supplierProductLinks.map((l) => l.supplier_code).sort()).toEqual(['CARNE-PIC-KG', 'REF-350-12']);
    const tables = s.outbox.map((e) => e.table);
    expect(tables).toContain('purchase_invoices');
    expect(tables).toContain('stock_movements');
  });

  it('não importa a mesma nota duas vezes', () => {
    expect(st().importPurchaseInvoice(sampleNfeXml(), decisions()).ok).toBe(true);
    const again = st().importPurchaseInvoice(sampleNfeXml(), decisions());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/já foi importada/);
    expect(refri().stock_quantity).toBe(24);
    expect(st().purchaseInvoices).toHaveLength(1);
    expect(analyzePurchaseInvoice({ ...st() }, parsePurchaseNfeXml(sampleNfeXml())).duplicate).not.toBeNull();
  });

  it('lembra o vínculo do fornecedor na próxima nota e faz a média do custo', () => {
    expect(st().importPurchaseInvoice(sampleNfeXml(), decisions()).ok).toBe(true);
    // Segunda nota do mesmo fornecedor (outra chave), lata mais cara.
    const key2 = '43261111222333000181550010000045221123456780';
    const key43 = key2.slice(0, 43);
    let sum = 0;
    for (let i = 42, w = 2; i >= 0; i--, w = w === 9 ? 2 : w + 1) sum += Number(key43[i]) * w;
    const dv = 11 - (sum % 11);
    const key = key43 + (dv >= 10 ? 0 : dv);
    const xml2 = sampleNfeXml().split(SAMPLE_NFE_ACCESS_KEY).join(key).replace('<nNF>4521</nNF>', '<nNF>4522</nNF>');
    const a = analyzePurchaseInvoice({ ...st() }, parsePurchaseNfeXml(xml2));
    expect(a.items[0]!.suggestion?.via).toBe('SUPPLIER_LINK');
    expect(a.items[0]!.factor_source).toBe('SUPPLIER_LINK');
    const picanha = st().products.find((p) => p.name === 'Picanha (peça)')!;
    expect(a.items[1]!.suggestion).toEqual({ product_id: picanha.id, via: 'SUPPLIER_LINK' });
    const r = st().importPurchaseInvoice(xml2, decisions({ 2: { n_item: 2, action: 'LINK', product_id: picanha.id, packaging_factor: 1 } }));
    if (!r.ok) throw new Error(r.error);
    expect(refri().stock_quantity).toBe(48);
    expect(refri().cost_price).toBe(3.73);
    expect(st().products.find((p) => p.id === picanha.id)!.stock_quantity).toBe(25);
  });

  it('exige decisão para todos os itens e fator válido', () => {
    expect(st().importPurchaseInvoice(sampleNfeXml(), decisions().slice(0, 2)).ok).toBe(false);
    const bad = st().importPurchaseInvoice(sampleNfeXml(), decisions({ 1: { n_item: 1, action: 'LINK', product_id: refri().id, packaging_factor: 0 } }));
    expect(bad.ok).toBe(false);
    expect(st().stockMovements).toHaveLength(0);
  });

  it('garçom e caixa não dão entrada', () => {
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    const r = st().importPurchaseInvoice(sampleNfeXml(), decisions());
    expect(r.ok).toBe(false);
    expect(st().purchaseInvoices).toHaveLength(0);
  });
});

describe('migração do estado salvo', () => {
  it('v4 → v5 preenche custo, estoque e tabelas novas', () => {
    const migrated = migratePersisted({ products: [{ id: 'x', name: 'A' }] }, 4) as Record<string, unknown>;
    expect(migrated.products).toEqual([{ id: 'x', name: 'A', cost_price: 0, stock_quantity: 0, barcode: null }]);
    expect(migrated.purchaseInvoices).toEqual([]);
    expect(migrated.stockMovements).toEqual([]);
  });
});
