-- =============================================================================
-- TCHÊ FOOD — schema.sql (PostgreSQL 15+ / Supabase)
-- Seção 1: modelagem do blueprint, sem alterações.
-- Seção 2: extensões necessárias às Fases 1–4 e ao módulo de impressão.
-- Seção 3: motor financeiro atômico + travas anti-fraude no banco.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SEÇÃO 1 — MODELAGEM DO BLUEPRINT
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE user_role AS ENUM ('OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN');
CREATE TYPE table_status AS ENUM ('FREE', 'OCCUPIED', 'WAITING_BILL', 'PAYING', 'DIRTY');
CREATE TYPE order_status AS ENUM ('OPEN', 'PAYING', 'CLOSED', 'CANCELED');
CREATE TYPE item_status AS ENUM ('PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELED');
CREATE TYPE production_sector AS ENUM ('KITCHEN', 'BAR', 'GRILL', 'DESSERT', 'NONE');
CREATE TYPE payment_method AS ENUM ('CREDIT', 'DEBIT', 'PIX', 'VOUCHER', 'CASH');
CREATE TYPE payment_status AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'REFUNDED');
CREATE TYPE acquirer_type AS ENUM ('STONE', 'PAGBANK', 'MOCK', 'CASH_DESK');
CREATE TYPE operation_mode AS ENUM ('SMARTPOS_EMBEDDED', 'TEF_POS_WIRELESS');

CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    legal_name VARCHAR(200) NOT NULL,
    cnpj VARCHAR(14) UNIQUE NOT NULL,
    state_registration VARCHAR(20),
    city VARCHAR(100) DEFAULT 'Santo Ângelo',
    state CHAR(2) DEFAULT 'RS',
    default_service_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00,
    default_acquirer acquirer_type NOT NULL DEFAULT 'STONE',
    default_mode operation_mode NOT NULL DEFAULT 'TEF_POS_WIRELESS',
    focus_nfe_token TEXT,
    csc_id VARCHAR(10),
    csc_token VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE staff_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    role user_role NOT NULL DEFAULT 'WAITER',
    pin_code VARCHAR(6) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, pin_code)
);

CREATE TABLE pos_terminals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL, -- Ex: "Stone Salão 01", "PagBank Balcão 02"
    serial_number VARCHAR(60) UNIQUE NOT NULL,
    acquirer acquirer_type NOT NULL,
    mode operation_mode NOT NULL DEFAULT 'TEF_POS_WIRELESS',
    online BOOLEAN NOT NULL DEFAULT TRUE,
    battery_level INT DEFAULT 95
);

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    icon_name VARCHAR(50),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    sector production_sector NOT NULL DEFAULT 'KITCHEN',
    available BOOLEAN NOT NULL DEFAULT TRUE,
    requires_meat_doneness BOOLEAN NOT NULL DEFAULT FALSE,
    allows_half_and_half BOOLEAN NOT NULL DEFAULT FALSE,
    ncm VARCHAR(8) NOT NULL DEFAULT '21069090',
    cfop VARCHAR(4) NOT NULL DEFAULT '5102',
    csosn_cst VARCHAR(4) NOT NULL DEFAULT '102',
    unit VARCHAR(6) NOT NULL DEFAULT 'UN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE modifier_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    min_selection INT NOT NULL DEFAULT 0,
    max_selection INT NOT NULL DEFAULT 1,
    required BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE modifier_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    additional_price NUMERIC(10,2) NOT NULL DEFAULT 0.00
);

CREATE TABLE dining_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    number INT NOT NULL,
    label VARCHAR(50) NOT NULL,
    area VARCHAR(50) NOT NULL DEFAULT 'Salão Principal',
    capacity INT NOT NULL DEFAULT 4,
    status table_status NOT NULL DEFAULT 'FREE',
    qr_code_token VARCHAR(64) UNIQUE,
    current_order_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, number)
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES dining_tables(id) ON DELETE RESTRICT,
    opened_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    status order_status NOT NULL DEFAULT 'OPEN',
    customer_count INT NOT NULL DEFAULT 1 CHECK (customer_count >= 1),
    customer_cpf VARCHAR(14),
    subtotal_items NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    charge_service_fee BOOLEAN NOT NULL DEFAULT TRUE,
    service_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00,
    service_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    remaining_balance NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    nfce_status VARCHAR(30) DEFAULT 'PENDING',
    nfce_key VARCHAR(44),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    waiter_id UUID NOT NULL REFERENCES staff_users(id),
    quantity NUMERIC(10,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL,
    modifiers_unit_price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    total_item_price NUMERIC(10,2) NOT NULL,
    meat_doneness VARCHAR(40),
    notes TEXT,
    sector production_sector NOT NULL,
    status item_status NOT NULL DEFAULT 'PENDING',
    is_paid BOOLEAN NOT NULL DEFAULT FALSE,
    origin VARCHAR(20) NOT NULL DEFAULT 'WAITER', -- 'WAITER', 'SMARTPOS', 'QRCODE_TABLE'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prepared_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    canceled_by_user_id UUID REFERENCES staff_users(id),
    cancel_reason TEXT
);

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    waiter_id UUID NOT NULL REFERENCES staff_users(id),
    terminal_id UUID REFERENCES pos_terminals(id),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    tip_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    method payment_method NOT NULL,
    status payment_status NOT NULL DEFAULT 'APPROVED',
    acquirer acquirer_type NOT NULL DEFAULT 'STONE',
    acquirer_cnpj VARCHAR(14),
    card_brand VARCHAR(20),
    nsu VARCHAR(50),
    authorization_code VARCHAR(50),
    terminal_serial VARCHAR(50),
    idempotency_key VARCHAR(100) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    performed_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    authorized_by_manager_id UUID REFERENCES staff_users(id),
    action_type VARCHAR(50) NOT NULL,
    amount_impact NUMERIC(10,2) DEFAULT 0.00,
    reason TEXT NOT NULL,
    whatsapp_alert_sent BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- SEÇÃO 2 — EXTENSÕES (não alteram nenhuma coluna da Seção 1)
-- -----------------------------------------------------------------------------

-- Vínculo produto ↔ grupo de modificadores (o blueprint não define a quem cada grupo pertence).
CREATE TABLE product_modifier_groups (
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    sort_order INT NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, group_id)
);

-- Impressoras térmicas ESC/POS por praça (58mm / 80mm).
CREATE TYPE printer_paper_width AS ENUM ('80MM', '58MM');
CREATE TYPE printer_connection AS ENUM ('NETWORK_TCP', 'BLUETOOTH', 'SMARTPOS_INTERNAL');
CREATE TYPE printer_sector AS ENUM ('KITCHEN', 'BAR', 'GRILL', 'DESSERT', 'CASHIER');

CREATE TABLE printers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    brand VARCHAR(30) NOT NULL,
    model VARCHAR(40) NOT NULL,
    sector printer_sector NOT NULL,
    paper_width printer_paper_width NOT NULL DEFAULT '80MM',
    connection printer_connection NOT NULL DEFAULT 'NETWORK_TCP',
    ip_address INET,
    port INT DEFAULT 9100,
    mac_address MACADDR,
    beep_on_print BOOLEAN NOT NULL DEFAULT TRUE,
    cut_paper BOOLEAN NOT NULL DEFAULT TRUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    CHECK (connection <> 'NETWORK_TCP' OR ip_address IS NOT NULL),
    CHECK (connection <> 'BLUETOOTH' OR mac_address IS NOT NULL)
);

ALTER TABLE dining_tables
    ADD CONSTRAINT dining_tables_current_order_fk FOREIGN KEY (current_order_id) REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_kds ON order_items(sector, status) WHERE status IN ('PENDING', 'PREPARING', 'READY');
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_orders_tenant_status ON orders(tenant_id, status);

-- -----------------------------------------------------------------------------
-- SEÇÃO 3 — MOTOR FINANCEIRO ATÔMICO (espelho de src/lib/money.ts)
-- -----------------------------------------------------------------------------
-- round() de NUMERIC no PostgreSQL arredonda "meio para longe do zero",
-- exatamente como toCents()/round2() no TypeScript.

CREATE OR REPLACE FUNCTION tchefood_recalc_order(p_order_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_order    orders%ROWTYPE;
    v_subtotal NUMERIC(10,2);
    v_fee      NUMERIC(10,2);
    v_discount NUMERIC(10,2);
    v_total    NUMERIC(10,2);
    v_paid     NUMERIC(10,2);
BEGIN
    SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT COALESCE(SUM(total_item_price), 0) INTO v_subtotal
      FROM order_items WHERE order_id = p_order_id AND status <> 'CANCELED';

    v_fee := CASE WHEN v_order.charge_service_fee
                  THEN round(v_subtotal * v_order.service_fee_pct / 100, 2) ELSE 0 END;
    v_discount := LEAST(GREATEST(v_order.discount_amount, 0), v_subtotal + v_fee);
    v_total := v_subtotal + v_fee - v_discount;

    SELECT COALESCE(SUM(amount), 0) INTO v_paid
      FROM payments WHERE order_id = p_order_id AND status = 'APPROVED'; -- gorjeta não abate saldo

    UPDATE orders SET
        subtotal_items     = v_subtotal,
        service_fee_amount = v_fee,
        discount_amount    = v_discount,
        total_amount       = v_total,
        paid_amount        = v_paid,
        remaining_balance  = GREATEST(v_total - v_paid, 0)
    WHERE id = p_order_id;
END;
$$;

-- total_item_price sempre derivado no banco (o cliente não consegue forjar preço).
CREATE OR REPLACE FUNCTION tchefood_item_total()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.total_item_price := round(NEW.quantity * (NEW.unit_price + NEW.modifiers_unit_price), 2);
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_order_items_total BEFORE INSERT OR UPDATE OF quantity, unit_price, modifiers_unit_price
    ON order_items FOR EACH ROW EXECUTE FUNCTION tchefood_item_total();

CREATE OR REPLACE FUNCTION tchefood_after_item_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM tchefood_recalc_order(COALESCE(NEW.order_id, OLD.order_id));
    RETURN NULL;
END;
$$;
CREATE TRIGGER trg_order_items_recalc AFTER INSERT OR UPDATE OR DELETE ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_after_item_change();
CREATE TRIGGER trg_payments_recalc AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_after_item_change();

CREATE OR REPLACE FUNCTION tchefood_after_order_flags()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.charge_service_fee IS DISTINCT FROM OLD.charge_service_fee
       OR NEW.service_fee_pct IS DISTINCT FROM OLD.service_fee_pct
       OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount THEN
        PERFORM tchefood_recalc_order(NEW.id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER trg_orders_flags AFTER UPDATE OF charge_service_fee, service_fee_pct, discount_amount ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_after_order_flags();

-- -----------------------------------------------------------------------------
-- TRAVAS ANTI-FRAUDE NO BANCO
-- -----------------------------------------------------------------------------

-- 1) Proibido DELETE físico de item já enviado à produção (todo item gravado já foi despachado).
CREATE OR REPLACE FUNCTION tchefood_block_item_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: item % não pode ser excluído. Use status CANCELED com PIN do gerente.', OLD.id;
END;
$$;
CREATE TRIGGER trg_order_items_no_delete BEFORE DELETE ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_block_item_delete();

-- 2) Cancelamento exige motivo, autor e registro em audit_logs com gerente na mesma transação.
CREATE OR REPLACE FUNCTION tchefood_check_item_cancel()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'CANCELED' AND OLD.status <> 'CANCELED' THEN
        IF NEW.cancel_reason IS NULL OR length(trim(NEW.cancel_reason)) < 5
           OR NEW.canceled_by_user_id IS NULL OR NEW.canceled_at IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: cancelamento sem motivo/autor.';
        END IF;
        IF OLD.is_paid THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: item já pago; estorne o pagamento.';
        END IF;
    END IF;
    IF OLD.status = 'CANCELED' AND NEW.status <> 'CANCELED' THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: item cancelado não pode ser reativado.';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_order_items_cancel BEFORE UPDATE OF status ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_check_item_cancel();

CREATE OR REPLACE FUNCTION tchefood_require_manager_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_ok BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM audit_logs a JOIN staff_users m ON m.id = a.authorized_by_manager_id
         WHERE a.order_id = NEW.order_id
           AND a.action_type = 'ITEM_CANCELED'
           AND a.metadata->>'item_id' = NEW.id::text
           AND m.role IN ('MANAGER', 'OWNER') AND m.active
    ) INTO v_ok;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: cancelamento do item % sem autorização de gerente em audit_logs.', NEW.id;
    END IF;
    RETURN NULL;
END;
$$;
-- DEFERRABLE: o audit_log pode ser inserido depois do UPDATE, desde que na mesma transação.
CREATE CONSTRAINT TRIGGER trg_order_items_cancel_audit AFTER UPDATE OF status ON order_items
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (NEW.status = 'CANCELED' AND OLD.status <> 'CANCELED')
    EXECUTE FUNCTION tchefood_require_manager_audit();

-- 3) Remover os 10% ou dar desconto também exige audit_log autorizado por gerente.
CREATE OR REPLACE FUNCTION tchefood_require_order_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_action TEXT; v_ok BOOLEAN;
BEGIN
    IF OLD.charge_service_fee AND NOT NEW.charge_service_fee THEN
        v_action := 'SERVICE_FEE_REMOVED';
    ELSIF NEW.discount_amount > OLD.discount_amount THEN
        v_action := 'DISCOUNT_APPLIED';
    ELSE
        RETURN NULL;
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM audit_logs a JOIN staff_users m ON m.id = a.authorized_by_manager_id
         WHERE a.order_id = NEW.id AND a.action_type = v_action
           AND a.created_at >= NOW() - INTERVAL '5 minutes'
           AND m.role IN ('MANAGER', 'OWNER') AND m.active
    ) INTO v_ok;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % sem PIN de gerente registrado em audit_logs.', v_action;
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_orders_fee_discount_audit AFTER UPDATE OF charge_service_fee, discount_amount ON orders
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tchefood_require_order_audit();

-- 4) audit_logs é imutável (append-only).
CREATE OR REPLACE FUNCTION tchefood_audit_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: audit_logs é somente inserção.';
END;
$$;
CREATE TRIGGER trg_audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION tchefood_audit_immutable();

-- 5) Fechamento automático: saldo 0,00 → conta CLOSED e mesa FREE.
CREATE OR REPLACE FUNCTION tchefood_auto_close()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.remaining_balance = 0 AND NEW.total_amount > 0 AND NEW.status IN ('OPEN', 'PAYING')
       AND NEW.paid_amount >= NEW.total_amount THEN
        UPDATE orders SET status = 'CLOSED', closed_at = NOW() WHERE id = NEW.id;
        UPDATE order_items SET is_paid = TRUE WHERE order_id = NEW.id AND status <> 'CANCELED' AND NOT is_paid;
        UPDATE dining_tables SET status = 'FREE', current_order_id = NULL, updated_at = NOW()
         WHERE id = NEW.table_id AND current_order_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER trg_orders_auto_close AFTER UPDATE OF remaining_balance ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_auto_close();

-- -----------------------------------------------------------------------------
-- RLS (Supabase) — isolamento multi-tenant pelo claim tenant_id do JWT
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_tenant() RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb->>'tenant_id', '')::uuid
$$;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['staff_users','pos_terminals','categories','products','modifier_groups',
                             'dining_tables','orders','payments','audit_logs','printers'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant())', t || '_tenant', t);
    END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_self ON tenants USING (id = tchefood_tenant());

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_items_tenant ON order_items
    USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id AND o.tenant_id = tchefood_tenant()))
    WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id AND o.tenant_id = tchefood_tenant()));

ALTER TABLE modifier_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY modifier_options_tenant ON modifier_options
    USING (EXISTS (SELECT 1 FROM modifier_groups g WHERE g.id = group_id AND g.tenant_id = tchefood_tenant()));

ALTER TABLE product_modifier_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_modifier_groups_tenant ON product_modifier_groups
    USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.tenant_id = tchefood_tenant()));

-- Realtime para KDS e mapa de mesas (só existe no Supabase)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE order_items, dining_tables, orders;
    END IF;
END $$;
