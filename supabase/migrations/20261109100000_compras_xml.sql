-- Cópia de db/schema_purchases.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- Tchê Food — Compras por XML de NF-e (modelo 55), estoque e custo (CMV)
-- Rodar DEPOIS de db/schema.sql. Idempotente nas colunas de products
-- (cost_price é o mesmo ALTER da Fase 5; os dois scripts convivem).
-- Espelho 1:1 de src/types.ts (Supplier, PurchaseInvoice, PurchaseInvoiceItem,
-- StockMovement, SupplierProductLink).
-- =============================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity NUMERIC(12,3) NOT NULL DEFAULT 0.000;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(14);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_cost_price_check') THEN
        ALTER TABLE products ADD CONSTRAINT products_cost_price_check CHECK (cost_price >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_barcode_check') THEN
        ALTER TABLE products ADD CONSTRAINT products_barcode_check CHECK (barcode IS NULL OR barcode ~ '^[0-9]{8,14}$');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    document VARCHAR(14) NOT NULL CHECK (document ~ '^([0-9A-Z]{12}[0-9]{2}|[0-9]{11})$'),
    legal_name VARCHAR(120) NOT NULL,
    trade_name VARCHAR(120),
    state_registration VARCHAR(20),
    city VARCHAR(60),
    state CHAR(2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, document)
);

CREATE TABLE IF NOT EXISTS purchase_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    -- Chave de 44 posições, modelo 55 (posições 21-22). O DV é validado no app.
    access_key CHAR(44) NOT NULL CHECK (access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$' AND substr(access_key, 21, 2) = '55'),
    number VARCHAR(9) NOT NULL,
    series VARCHAR(3) NOT NULL,
    issued_at TIMESTAMPTZ,
    environment VARCHAR(12) NOT NULL CHECK (environment IN ('PRODUCTION', 'HOMOLOGATION')),
    authorization_protocol VARCHAR(20),
    products_amount NUMERIC(12,2) NOT NULL CHECK (products_amount >= 0),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    freight_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (freight_amount >= 0),
    insurance_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (insurance_amount >= 0),
    other_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other_amount >= 0),
    ipi_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ipi_amount >= 0),
    icms_st_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (icms_st_amount >= 0),
    invoice_amount NUMERIC(12,2) NOT NULL CHECK (invoice_amount >= 0),
    stocked_amount NUMERIC(12,2) NOT NULL CHECK (stocked_amount >= 0),
    items_count INT NOT NULL CHECK (items_count BETWEEN 1 AND 990),
    imported_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A mesma NF-e nunca entra duas vezes no estoque do mesmo estabelecimento.
    CONSTRAINT purchase_invoices_access_key_unique UNIQUE (tenant_id, access_key)
);

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    n_item INT NOT NULL CHECK (n_item BETWEEN 1 AND 990),
    supplier_code VARCHAR(60) NOT NULL,
    barcode VARCHAR(14),
    description VARCHAR(120) NOT NULL,
    ncm VARCHAR(8),
    cfop VARCHAR(4),
    commercial_unit VARCHAR(6) NOT NULL,
    commercial_quantity NUMERIC(15,4) NOT NULL CHECK (commercial_quantity > 0),
    commercial_unit_price NUMERIC(21,10) NOT NULL CHECK (commercial_unit_price >= 0),
    gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount >= 0),
    landed_amount NUMERIC(12,2) NOT NULL CHECK (landed_amount >= 0),
    action VARCHAR(6) NOT NULL CHECK (action IN ('LINK', 'CREATE', 'IGNORE')),
    product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
    packaging_factor NUMERIC(10,3) NOT NULL CHECK (packaging_factor > 0),
    stock_quantity NUMERIC(12,3) NOT NULL CHECK (stock_quantity >= 0),
    unit_cost NUMERIC(12,4) NOT NULL CHECK (unit_cost >= 0),
    UNIQUE (invoice_id, n_item),
    CHECK ((action = 'IGNORE') = (product_id IS NULL)),
    CHECK (action = 'IGNORE' OR stock_quantity > 0)
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('PURCHASE_IN')),
    quantity NUMERIC(12,3) NOT NULL CHECK (quantity <> 0),
    unit_cost NUMERIC(12,4) NOT NULL CHECK (unit_cost >= 0),
    balance_after NUMERIC(12,3) NOT NULL,
    avg_cost_after NUMERIC(12,4) NOT NULL CHECK (avg_cost_after >= 0),
    purchase_invoice_item_id UUID REFERENCES purchase_invoice_items(id) ON DELETE RESTRICT,
    performed_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (type <> 'PURCHASE_IN' OR (quantity > 0 AND purchase_invoice_item_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_id, created_at);
-- Cada item de nota gera no máximo uma entrada.
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_invoice_item_unique ON stock_movements (purchase_invoice_item_id) WHERE purchase_invoice_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_product_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    supplier_code VARCHAR(60) NOT NULL,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    packaging_factor NUMERIC(10,3) NOT NULL CHECK (packaging_factor > 0),
    commercial_unit VARCHAR(6) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, supplier_id, supplier_code)
);

-- Nota de compra, seus itens e o livro de estoque são somente inserção:
-- corrigir entrada errada é um movimento novo, nunca edição do passado.
CREATE OR REPLACE FUNCTION tchefood_purchase_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TCHEFOOD_ESTOQUE: % é somente inserção.', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_purchase_invoices_immutable ON purchase_invoices;
CREATE TRIGGER trg_purchase_invoices_immutable BEFORE UPDATE OR DELETE ON purchase_invoices
    FOR EACH ROW EXECUTE FUNCTION tchefood_purchase_immutable();
DROP TRIGGER IF EXISTS trg_purchase_invoice_items_immutable ON purchase_invoice_items;
CREATE TRIGGER trg_purchase_invoice_items_immutable BEFORE UPDATE OR DELETE ON purchase_invoice_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_purchase_immutable();
DROP TRIGGER IF EXISTS trg_stock_movements_immutable ON stock_movements;
CREATE TRIGGER trg_stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION tchefood_purchase_immutable();

-- RLS multi-tenant (mesmo claim de db/schema.sql)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['suppliers','purchase_invoices','stock_movements','supplier_product_links'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_tenant') THEN
            EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant())', t || '_tenant', t);
        END IF;
    END LOOP;
END $$;

ALTER TABLE purchase_invoice_items ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'purchase_invoice_items' AND policyname = 'purchase_invoice_items_tenant') THEN
        CREATE POLICY purchase_invoice_items_tenant ON purchase_invoice_items
            USING (EXISTS (SELECT 1 FROM purchase_invoices i WHERE i.id = invoice_id AND i.tenant_id = tchefood_tenant()))
            WITH CHECK (EXISTS (SELECT 1 FROM purchase_invoices i WHERE i.id = invoice_id AND i.tenant_id = tchefood_tenant()));
    END IF;
END $$;
