/**
 * Entrada de NF-e de compra: conferência (sugestões) e plano de gravação.
 *
 * Funções puras (sem store): o store só aplica o plano num único set(),
 * como uma transação. Tudo o que é gravado sai do XML re-lido na confirmação,
 * nunca de valores digitados na tela, exceto as escolhas da revisão
 * (vincular / criar / ignorar e o fator de embalagem).
 */
import type {
  Category,
  Product,
  PurchaseInvoice,
  PurchaseInvoiceItem,
  StockMovement,
  Supplier,
  SupplierProductLink,
  Tenant,
  UUID,
} from '../types';
import { round3, toCents } from './money';
import {
  documentChars,
  normalizeName,
  packagingFactorFromInvoice,
  round4,
  unitCostOf,
  weightedAverageCost,
  type PurchaseNfe,
  type PurchaseNfeItem,
} from './nfeImport';

export const MAX_PACKAGING_FACTOR = 1_000_000;
/** NUMERIC(12,3) */
const MAX_STOCK_QUANTITY = 999_999_999.999;

export interface PurchaseDataSnapshot {
  tenant: Tenant;
  categories: Category[];
  products: Product[];
  suppliers: Supplier[];
  purchaseInvoices: PurchaseInvoice[];
  supplierProductLinks: SupplierProductLink[];
  stockMovements: StockMovement[];
}

export type MatchVia = 'SUPPLIER_LINK' | 'BARCODE' | 'NAME';
export type FactorSource = 'SUPPLIER_LINK' | 'INVOICE' | 'DEFAULT';

export interface PurchaseItemAnalysis {
  item: PurchaseNfeItem;
  suggestion: { product_id: UUID; via: MatchVia } | null;
  factor: number;
  factor_source: FactorSource;
}

export interface PurchaseAnalysis {
  nfe: PurchaseNfe;
  supplier: Supplier | null;
  /** Nota já importada (mesma chave). */
  duplicate: PurchaseInvoice | null;
  /** Motivo que impede importar, além de duplicidade. */
  blocker: string | null;
  items: PurchaseItemAnalysis[];
}

export type PurchaseItemDecision =
  | { n_item: number; action: 'LINK'; product_id: UUID; packaging_factor: number }
  | { n_item: number; action: 'CREATE'; packaging_factor: number; name: string; category_id: UUID; unit: string }
  | { n_item: number; action: 'IGNORE' };

/** Confere a nota contra o cadastro e sugere vínculos e fatores. Não grava nada. */
export function analyzePurchaseInvoice(data: PurchaseDataSnapshot, nfe: PurchaseNfe): PurchaseAnalysis {
  const tenantDoc = documentChars(data.tenant.cnpj);
  let blocker: string | null = null;
  if (!nfe.recipient_document) blocker = 'A NF-e não traz CNPJ/CPF de destinatário válido.';
  else if (nfe.recipient_document !== tenantDoc) blocker = `Esta NF-e é destinada a outro CNPJ/CPF (${nfe.recipient_document}), não ao estabelecimento (${tenantDoc}).`;

  const supplier = data.suppliers.find((s) => s.tenant_id === data.tenant.id && s.document === nfe.supplier.document) ?? null;
  const duplicate = data.purchaseInvoices.find((i) => i.tenant_id === data.tenant.id && i.access_key === nfe.access_key) ?? null;
  const products = data.products.filter((p) => p.tenant_id === data.tenant.id);

  const items = nfe.items.map((item): PurchaseItemAnalysis => {
    const link = supplier && item.supplier_code
      ? data.supplierProductLinks.find((l) => l.supplier_id === supplier.id && l.supplier_code === item.supplier_code && products.some((p) => p.id === l.product_id))
      : undefined;
    const invoiceFactor = packagingFactorFromInvoice(item);
    if (link) {
      // O fator lembrado só vale se a nota vier na mesma unidade comercial da última vez.
      const sameUnit = link.commercial_unit === item.commercial_unit;
      return {
        item,
        suggestion: { product_id: link.product_id, via: 'SUPPLIER_LINK' },
        factor: sameUnit ? link.packaging_factor : invoiceFactor ?? 1,
        factor_source: sameUnit ? 'SUPPLIER_LINK' : invoiceFactor ? 'INVOICE' : 'DEFAULT',
      };
    }
    let suggestion: PurchaseItemAnalysis['suggestion'] = null;
    if (item.barcode) {
      const byBarcode = products.filter((p) => p.barcode === item.barcode);
      if (byBarcode.length === 1) suggestion = { product_id: byBarcode[0]!.id, via: 'BARCODE' };
    }
    if (!suggestion) {
      const name = normalizeName(item.description);
      const byName = products.filter((p) => normalizeName(p.name) === name);
      if (byName.length === 1) suggestion = { product_id: byName[0]!.id, via: 'NAME' };
    }
    return { item, suggestion, factor: invoiceFactor ?? 1, factor_source: invoiceFactor ? 'INVOICE' : 'DEFAULT' };
  });

  return { nfe, supplier, duplicate, blocker, items };
}

export interface PurchaseImportPlan {
  supplier: Supplier;
  supplierIsNew: boolean;
  invoice: PurchaseInvoice;
  items: PurchaseInvoiceItem[];
  createdProducts: Product[];
  /** Produtos existentes com saldo e custo novos. */
  updatedProducts: Product[];
  movements: StockMovement[];
  links: SupplierProductLink[];
}

export interface PlanContext {
  userId: UUID;
  now: string;
  newId: () => UUID;
  /** Próximo código livre para produto criado na importação. */
  nextProductCode: (taken: ReadonlySet<string>) => string;
}

const VALID_UNIT = /^[A-Z0-9]{1,6}$/;

/**
 * Monta tudo o que a importação grava. Recusa (throw Error com mensagem para o usuário)
 * em qualquer inconsistência; nada é parcialmente gravado.
 */
export function planPurchaseImport(
  data: PurchaseDataSnapshot,
  nfe: PurchaseNfe,
  decisions: PurchaseItemDecision[],
  ctx: PlanContext,
): PurchaseImportPlan {
  const analysis = analyzePurchaseInvoice(data, nfe);
  if (analysis.duplicate) throw new Error(`Esta NF-e (nº ${nfe.number}) já foi importada em ${new Date(analysis.duplicate.imported_at).toLocaleString('pt-BR')}.`);
  if (analysis.blocker) throw new Error(analysis.blocker);

  // Cada item da nota precisa de exatamente uma decisão.
  const byItem = new Map<number, PurchaseItemDecision>();
  for (const d of decisions) {
    if (!nfe.items.some((i) => i.n_item === d.n_item)) throw new Error(`Decisão para um item que não existe na nota (${d.n_item}).`);
    if (byItem.has(d.n_item)) throw new Error(`Item ${d.n_item} decidido duas vezes.`);
    byItem.set(d.n_item, d);
  }
  const missing = nfe.items.filter((i) => !byItem.has(i.n_item));
  if (missing.length) throw new Error(`Decida o que fazer com ${missing.length === 1 ? 'o item' : 'os itens'} ${missing.map((i) => i.n_item).join(', ')}.`);
  if (nfe.items.every((i) => byItem.get(i.n_item)!.action === 'IGNORE')) throw new Error('Todos os itens estão ignorados; nada entraria no estoque.');

  const tenantId = data.tenant.id;
  const supplierIsNew = !analysis.supplier;
  const supplier: Supplier = analysis.supplier ?? {
    id: ctx.newId(),
    tenant_id: tenantId,
    document: nfe.supplier.document,
    legal_name: nfe.supplier.legal_name,
    trade_name: nfe.supplier.trade_name,
    state_registration: nfe.supplier.state_registration,
    city: nfe.supplier.city,
    state: nfe.supplier.state,
    created_at: ctx.now,
  };
  const invoiceId = ctx.newId();

  // Estado corrente de cada produto tocado (vários itens podem cair no mesmo produto).
  const working = new Map<UUID, Product>();
  const created: Product[] = [];
  const takenCodes = new Set(data.products.filter((p) => p.tenant_id === tenantId).map((p) => p.code));
  const items: PurchaseInvoiceItem[] = [];
  const movements: StockMovement[] = [];
  const linkByCode = new Map<string, SupplierProductLink>();

  for (const item of nfe.items) {
    const d = byItem.get(item.n_item)!;
    const base: Omit<PurchaseInvoiceItem, 'action' | 'product_id' | 'packaging_factor' | 'stock_quantity' | 'unit_cost'> = {
      id: ctx.newId(),
      invoice_id: invoiceId,
      n_item: item.n_item,
      supplier_code: item.supplier_code,
      barcode: item.barcode,
      description: item.description,
      ncm: item.ncm,
      cfop: item.cfop,
      commercial_unit: item.commercial_unit,
      commercial_quantity: item.commercial_quantity,
      commercial_unit_price: item.commercial_unit_price,
      gross_amount: item.gross_amount,
      landed_amount: item.landed_amount,
    };
    if (d.action === 'IGNORE') {
      items.push({ ...base, action: 'IGNORE', product_id: null, packaging_factor: 1, stock_quantity: 0, unit_cost: 0 });
      continue;
    }

    const factor = Number(d.packaging_factor);
    if (!Number.isFinite(factor) || !(factor > 0) || factor > MAX_PACKAGING_FACTOR || round3(factor) !== factor) {
      throw new Error(`Fator de embalagem inválido no item ${item.n_item} (use um número maior que zero, até 3 casas).`);
    }
    const stockQty = round3(item.commercial_quantity * factor);
    if (!(stockQty > 0) || stockQty > MAX_STOCK_QUANTITY) throw new Error(`Quantidade de estoque inválida no item ${item.n_item}.`);
    const unitCost = unitCostOf(item.landed_amount, stockQty);

    let product: Product;
    if (d.action === 'LINK') {
      const existing = working.get(d.product_id) ?? data.products.find((p) => p.id === d.product_id && p.tenant_id === tenantId);
      if (!existing) throw new Error(`Produto escolhido para o item ${item.n_item} não existe mais.`);
      product = existing;
    } else {
      const name = d.name.trim();
      if (name.length < 2) throw new Error(`Informe o nome do produto novo do item ${item.n_item}.`);
      const unit = normalizeUnitInput(d.unit);
      if (!unit) throw new Error(`Unidade inválida no item ${item.n_item} (ex.: UN, KG, L).`);
      if (!data.categories.some((c) => c.id === d.category_id && c.tenant_id === tenantId)) throw new Error(`Escolha a categoria do produto novo do item ${item.n_item}.`);
      const code = ctx.nextProductCode(takenCodes);
      takenCodes.add(code);
      product = {
        id: ctx.newId(),
        tenant_id: tenantId,
        category_id: d.category_id,
        code,
        name: name.slice(0, 120),
        description: null,
        price: 0,
        sector: 'NONE',
        // Fica fora da venda até o dono definir preço e liberar.
        available: false,
        requires_meat_doneness: false,
        allows_half_and_half: false,
        ncm: item.ncm ?? '21069090',
        cfop: '5102',
        csosn_cst: '102',
        unit,
        cost_price: 0,
        stock_quantity: 0,
        barcode: item.barcode,
        created_at: ctx.now,
      };
      created.push(product);
    }

    const avg = weightedAverageCost(product.stock_quantity, costBasis(product, movements, data.stockMovements), stockQty, unitCost);
    const balance = round3(product.stock_quantity + stockQty);
    const updated: Product = { ...product, stock_quantity: balance, cost_price: toCents(avg) / 100, barcode: product.barcode ?? item.barcode };
    working.set(updated.id, updated);
    const createdIdx = created.findIndex((p) => p.id === updated.id);
    if (createdIdx >= 0) created[createdIdx] = updated;

    const invoiceItem: PurchaseInvoiceItem = { ...base, action: d.action, product_id: updated.id, packaging_factor: factor, stock_quantity: stockQty, unit_cost: unitCost };
    items.push(invoiceItem);
    movements.push({
      id: ctx.newId(),
      tenant_id: tenantId,
      product_id: updated.id,
      type: 'PURCHASE_IN',
      quantity: stockQty,
      unit_cost: unitCost,
      balance_after: balance,
      avg_cost_after: avg,
      purchase_invoice_item_id: invoiceItem.id,
      performed_by_user_id: ctx.userId,
      created_at: ctx.now,
    });

    if (item.supplier_code) {
      const prev = data.supplierProductLinks.find((l) => l.supplier_id === supplier.id && l.supplier_code === item.supplier_code);
      linkByCode.set(item.supplier_code, {
        id: prev?.id ?? linkByCode.get(item.supplier_code)?.id ?? ctx.newId(),
        tenant_id: tenantId,
        supplier_id: supplier.id,
        supplier_code: item.supplier_code,
        product_id: updated.id,
        packaging_factor: factor,
        commercial_unit: item.commercial_unit,
        updated_at: ctx.now,
      });
    }
  }

  const createdIds = new Set(created.map((p) => p.id));
  const updatedProducts = [...working.values()].filter((p) => !createdIds.has(p.id));
  const stockedCents = items.filter((i) => i.action !== 'IGNORE').reduce((acc, i) => acc + toCents(i.landed_amount), 0);

  const invoice: PurchaseInvoice = {
    id: invoiceId,
    tenant_id: tenantId,
    supplier_id: supplier.id,
    access_key: nfe.access_key,
    number: nfe.number,
    series: nfe.series,
    issued_at: nfe.issued_at,
    environment: nfe.environment,
    authorization_protocol: nfe.authorization_protocol,
    products_amount: nfe.totals.products_amount,
    discount_amount: nfe.totals.discount_amount,
    freight_amount: nfe.totals.freight_amount,
    insurance_amount: nfe.totals.insurance_amount,
    other_amount: nfe.totals.other_amount,
    ipi_amount: nfe.totals.ipi_amount,
    icms_st_amount: nfe.totals.icms_st_amount,
    invoice_amount: nfe.totals.invoice_amount,
    stocked_amount: stockedCents / 100,
    items_count: nfe.items.length,
    imported_by_user_id: ctx.userId,
    imported_at: ctx.now,
  };

  return { supplier, supplierIsNew, invoice, items, createdProducts: created, updatedProducts, movements, links: [...linkByCode.values()] };
}

/**
 * Custo base do produto para a média: o custo médio com 4 casas do último movimento
 * (desta importação ou de uma anterior), para não acumular arredondamento de centavos.
 */
function costBasis(product: Product, planned: StockMovement[], history: StockMovement[]): number {
  for (let i = planned.length - 1; i >= 0; i--) {
    const m = planned[i]!;
    if (m.product_id === product.id) return m.avg_cost_after;
  }
  return preciseUnitCost(product, history);
}

/**
 * Custo médio com 4 casas: o do último movimento de estoque do produto.
 * Se o cost_price foi alterado à mão depois dele (difere em centavos), ou se não há
 * movimento, vale o cost_price.
 */
export function preciseUnitCost(product: Product, movements: StockMovement[]): number {
  let last: StockMovement | undefined;
  for (const m of movements) if (m.product_id === product.id && (!last || m.created_at >= last.created_at)) last = m;
  if (last && toCents(last.avg_cost_after) === toCents(product.cost_price)) return last.avg_cost_after;
  return round4(product.cost_price);
}

function normalizeUnitInput(value: string): string | null {
  const unit = value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.\s]/g, '').toUpperCase();
  return VALID_UNIT.test(unit) ? unit : null;
}

/** Código sequencial "C001", "C002"... para produtos criados pela compra. */
export function nextPurchaseProductCode(taken: ReadonlySet<string>): string {
  for (let n = 1; n < 100_000; n++) {
    const code = `C${n.toString().padStart(3, '0')}`;
    if (!taken.has(code)) return code;
  }
  throw new Error('Sem código livre para produto novo.');
}
