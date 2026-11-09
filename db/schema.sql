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
    default_service_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (default_service_fee_pct BETWEEN 0 AND 100),
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
    service_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (service_fee_pct BETWEEN 0 AND 100),
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
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    -- Adicional pode ser negativo (ex.: "sem queijo"), mas o item nunca vale menos que zero:
    -- item com preço negativo funcionaria como desconto sem PIN do gerente.
    modifiers_unit_price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    CONSTRAINT order_items_effective_price_check CHECK (unit_price + modifiers_unit_price >= 0),
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
-- Dispara em QUALQUER update: total_item_price nunca aceita valor vindo do cliente.
CREATE TRIGGER trg_order_items_total BEFORE INSERT OR UPDATE
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
DECLARE v_action TEXT; v_ok BOOLEAN; v_actions TEXT[] := ARRAY[]::TEXT[];
BEGIN
    -- Cada mudança protegida é conferida por conta própria: um UPDATE que tira os
    -- 10% E aumenta o desconto precisa das duas autorizações.
    IF OLD.charge_service_fee AND NOT NEW.charge_service_fee THEN
        v_actions := array_append(v_actions, 'SERVICE_FEE_REMOVED'::TEXT);
    END IF;
    IF NEW.discount_amount > OLD.discount_amount THEN
        v_actions := array_append(v_actions, 'DISCOUNT_APPLIED'::TEXT);
    END IF;
    FOREACH v_action IN ARRAY v_actions LOOP
        -- A autorização vale só para a mudança exata que o gerente aprovou: no desconto,
        -- discount_before/discount_after do audit_log precisam bater com OLD/NEW, então
        -- uma aprovação pequena não serve para aumentar o desconto de novo.
        SELECT EXISTS (
            SELECT 1 FROM audit_logs a JOIN staff_users m ON m.id = a.authorized_by_manager_id
             WHERE a.order_id = NEW.id AND a.action_type = v_action
               AND a.created_at >= NOW() - INTERVAL '5 minutes'
               AND m.role IN ('MANAGER', 'OWNER') AND m.active
               AND (v_action <> 'DISCOUNT_APPLIED' OR (
                    (a.metadata->>'discount_before')::numeric = OLD.discount_amount
                AND (a.metadata->>'discount_after')::numeric = NEW.discount_amount))
        ) INTO v_ok;
        IF NOT v_ok THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % sem PIN de gerente registrado em audit_logs.', v_action;
        END IF;
    END LOOP;
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

-- -----------------------------------------------------------------------------
-- AUTORIZAÇÃO DE GERENTE VALIDADA NO SERVIDOR
-- O cliente nunca grava a "prova" da autorização: o audit_log com gerente só
-- nasce dentro de tchefood_authorize_manager(), que confere o PIN no banco.
-- Fluxo de sincronização: chame a RPC primeiro e depois faça o UPDATE do item
-- ou da conta na mesma transação/janela de 5 minutos exigida pelos gatilhos.
-- -----------------------------------------------------------------------------

-- Papéis de cliente do Supabase (anon/authenticated) não podem inserir
-- audit_log com authorized_by_manager_id: só a função SECURITY DEFINER pode.
CREATE OR REPLACE FUNCTION tchefood_guard_audit_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authorized_by_manager_id IS NOT NULL AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: autorização de gerente só pode ser registrada por tchefood_authorize_manager().';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_audit_logs_guard BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION tchefood_guard_audit_insert();

-- Confere o PIN do gerente do próprio tenant, com bloqueio após 3 erros em 60s,
-- e grava o audit_log autorizado. Retorna o id do audit_log, ou NULL se o PIN falhar
-- (a falha também vira audit_log MANAGER_PIN_FAILED / MANAGER_PIN_LOCKOUT).
CREATE OR REPLACE FUNCTION tchefood_authorize_manager(
    p_order_id UUID,
    p_action_type VARCHAR,
    p_manager_pin VARCHAR,
    p_performed_by UUID,
    p_reason TEXT,
    p_amount_impact NUMERIC DEFAULT 0,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_manager staff_users%ROWTYPE;
    v_failures INT;
    v_id UUID;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.';
    END IF;
    IF p_action_type NOT IN ('ITEM_CANCELED', 'SERVICE_FEE_REMOVED', 'DISCOUNT_APPLIED') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: ação % não exige autorização.', p_action_type;
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;
    IF p_action_type = 'DISCOUNT_APPLIED' AND (
        (p_metadata->>'discount_before') IS NULL OR (p_metadata->>'discount_after') IS NULL
        OR (p_metadata->>'discount_after')::numeric <= (p_metadata->>'discount_before')::numeric) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: desconto precisa de discount_before e discount_after (maior) no metadata.';
    END IF;
    IF p_action_type = 'ITEM_CANCELED' AND (p_metadata->>'item_id') IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: cancelamento precisa do item_id no metadata.';
    END IF;
    PERFORM 1 FROM orders o WHERE o.id = p_order_id AND o.tenant_id = v_tenant;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: conta não pertence ao tenant.';
    END IF;
    PERFORM 1 FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = v_tenant AND u.active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: operador inválido.';
    END IF;

    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= NOW() - INTERVAL '60 seconds';
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (v_tenant, p_order_id, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas', jsonb_build_object('attempted_action', p_action_type));
        RETURN NULL;
    END IF;

    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (v_tenant, p_order_id, p_performed_by, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto', jsonb_build_object('attempted_action', p_action_type));
        RETURN NULL;
    END IF;

    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, p_order_id, p_performed_by, v_manager.id, p_action_type, COALESCE(p_amount_impact, 0), trim(p_reason),
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- No Supabase: o cliente não lê PINs nem altera cargos. Cadastro de equipe é
-- feito pela retaguarda com service_role; o app só vê os campos públicos.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON staff_users FROM anon, authenticated;
        GRANT SELECT (id, tenant_id, name, role, active, created_at) ON staff_users TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) TO authenticated;
    END IF;
END $$;

-- Item já gravado (despachado) não muda de preço, quantidade nem produto: a única
-- forma de reduzir a conta por item é o cancelamento autorizado. Assim o cliente
-- não zera o unit_price nem baixa a quantidade para escapar das travas.
CREATE OR REPLACE FUNCTION tchefood_lock_item_financials()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.unit_price IS DISTINCT FROM OLD.unit_price
       OR NEW.modifiers_unit_price IS DISTINCT FROM OLD.modifiers_unit_price
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: item % já enviado não pode ter preço, quantidade ou produto alterados. Cancele com PIN do gerente e lance de novo.', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_order_items_lock_financials BEFORE UPDATE ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_lock_item_financials();

-- O percentual dos 10% é fixado quando a conta abre (vem do tenant). Mudá-lo numa
-- conta existente reduziria a taxa sem PIN do gerente; para dispensar a taxa o
-- caminho é charge_service_fee = false, que exige SERVICE_FEE_REMOVED.
CREATE OR REPLACE FUNCTION tchefood_lock_service_fee_pct()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.service_fee_pct IS DISTINCT FROM OLD.service_fee_pct THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: percentual da taxa de serviço da conta % não pode ser alterado depois de aberta.', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_orders_lock_service_fee_pct BEFORE UPDATE OF service_fee_pct ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_lock_service_fee_pct();

-- Totais da conta (subtotal, 10%, total, pago, saldo) só mudam pelo recálculo do
-- banco (tchefood_recalc_order), que roda dentro de outro gatilho. Um UPDATE direto
-- do cliente (profundidade 1) não pode mexer neles, então não dá para zerar o saldo
-- e disparar o fechamento automático sem pagamento. Conta nova sempre nasce zerada.
CREATE OR REPLACE FUNCTION tchefood_lock_order_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.subtotal_items := 0;
        NEW.service_fee_amount := 0;
        NEW.total_amount := 0;
        NEW.paid_amount := 0;
        NEW.remaining_balance := 0;
        RETURN NEW;
    END IF;
    IF NEW.subtotal_items IS DISTINCT FROM OLD.subtotal_items
       OR NEW.service_fee_amount IS DISTINCT FROM OLD.service_fee_amount
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.paid_amount IS DISTINCT FROM OLD.paid_amount
       OR NEW.remaining_balance IS DISTINCT FROM OLD.remaining_balance THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: totais da conta % são calculados pelo banco e não podem ser gravados direto.', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_orders_lock_totals BEFORE INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_lock_order_totals();

-- -----------------------------------------------------------------------------
-- SEÇÃO 4 — ETAPA 0 (cópia de supabase/migrations/20261109070000_etapa0_cadastros.sql)
-- -----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- Código rápido único por loja (a tela já recusa duplicado; o banco garante).
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_tenant_code ON products(tenant_id, lower(code));

-- Mesa ocupada não pode ser desativada.
CREATE OR REPLACE FUNCTION tchefood_table_deactivate_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.active AND NOT NEW.active AND NEW.status <> 'FREE' THEN
        RAISE EXCEPTION 'TCHEFOOD_CADASTRO: mesa % está em uso e não pode ser desativada.', NEW.label;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dining_tables_deactivate ON dining_tables;
CREATE TRIGGER trg_dining_tables_deactivate BEFORE UPDATE OF active ON dining_tables
    FOR EACH ROW EXECUTE FUNCTION tchefood_table_deactivate_guard();

-- Produto e mesa nunca são apagados (podem estar em contas e notas fiscais).
CREATE OR REPLACE FUNCTION tchefood_block_catalog_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TCHEFOOD_CADASTRO: % não pode ser apagado; desative.', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_products_no_delete ON products;
CREATE TRIGGER trg_products_no_delete BEFORE DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION tchefood_block_catalog_delete();
DROP TRIGGER IF EXISTS trg_dining_tables_no_delete ON dining_tables;
CREATE TRIGGER trg_dining_tables_no_delete BEFORE DELETE ON dining_tables
    FOR EACH ROW EXECUTE FUNCTION tchefood_block_catalog_delete();
DROP TRIGGER IF EXISTS trg_staff_users_no_delete ON staff_users;
CREATE TRIGGER trg_staff_users_no_delete BEFORE DELETE ON staff_users
    FOR EACH ROW EXECUTE FUNCTION tchefood_block_catalog_delete();

CREATE TABLE IF NOT EXISTS price_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    name VARCHAR(60) NOT NULL,
    weekdays SMALLINT[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]),
    start_time CHAR(5) NOT NULL CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_time CHAR(5) NOT NULL CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    price NUMERIC(10,2) NOT NULL CHECK (price > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (start_time <> end_time)
);
CREATE INDEX IF NOT EXISTS idx_price_schedules_product ON price_schedules(product_id) WHERE active;

DO $$ BEGIN
    CREATE TYPE app_permission AS ENUM ('MENU_MANAGE', 'MENU_AVAILABILITY', 'TABLES_MANAGE', 'STAFF_MANAGE', 'STORE_SETTINGS', 'SYNC_MANAGE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS role_permissions (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role user_role NOT NULL CHECK (role <> 'OWNER'),
    permission app_permission NOT NULL,
    allowed BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, role, permission)
);

ALTER TABLE price_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_schedules_tenant ON price_schedules;
CREATE POLICY price_schedules_tenant ON price_schedules
    USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_permissions_tenant ON role_permissions;
CREATE POLICY role_permissions_tenant ON role_permissions
    USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant());

-- Grava pelo aparelho (upsert) exige WITH CHECK nas tabelas que só tinham USING.
DROP POLICY IF EXISTS modifier_options_tenant ON modifier_options;
CREATE POLICY modifier_options_tenant ON modifier_options
    USING (EXISTS (SELECT 1 FROM modifier_groups g WHERE g.id = group_id AND g.tenant_id = tchefood_tenant()))
    WITH CHECK (EXISTS (SELECT 1 FROM modifier_groups g WHERE g.id = group_id AND g.tenant_id = tchefood_tenant()));
DROP POLICY IF EXISTS product_modifier_groups_tenant ON product_modifier_groups;
CREATE POLICY product_modifier_groups_tenant ON product_modifier_groups
    USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.tenant_id = tchefood_tenant()))
    WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.tenant_id = tchefood_tenant()));

-- O aparelho atualiza os dados cadastrais da loja, mas nunca o token Focus nem o CSC.
CREATE OR REPLACE FUNCTION tchefood_tenant_secrets_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('request.jwt.claims', true) IS NOT NULL
       AND coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') = 'authenticated' THEN
        NEW.focus_nfe_token := OLD.focus_nfe_token;
        NEW.csc_id := OLD.csc_id;
        NEW.csc_token := OLD.csc_token;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tenants_secrets ON tenants;
CREATE TRIGGER trg_tenants_secrets BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION tchefood_tenant_secrets_guard();

-- Fila offline: a autorização do gerente (audit_log) pode subir horas depois de dada,
-- e a atualização da comanda pode subir numa tentativa seguinte. Em vez da janela de
-- 5 minutos (que recusaria esse reenvio para sempre), a autorização fica presa à
-- própria operação:
--  - remover os 10%: o último registro de 10% da comanda tem de ser SERVICE_FEE_REMOVED
--    (depois de restaurar, uma nova remoção precisa de nova autorização);
--  - desconto: o último DISCOUNT_APPLIED da comanda tem de ser exatamente desta
--    mudança (discount_before = valor atual, discount_after = valor novo).
CREATE OR REPLACE FUNCTION tchefood_require_order_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_ok BOOLEAN := FALSE; v_action TEXT;
BEGIN
    IF OLD.charge_service_fee AND NOT NEW.charge_service_fee THEN
        v_action := 'SERVICE_FEE_REMOVED';
        SELECT (a.action_type = 'SERVICE_FEE_REMOVED' AND m.role IN ('MANAGER', 'OWNER') AND m.active)
          INTO v_ok
          FROM audit_logs a LEFT JOIN staff_users m ON m.id = a.authorized_by_manager_id
         WHERE a.order_id = NEW.id AND a.action_type IN ('SERVICE_FEE_REMOVED', 'SERVICE_FEE_RESTORED')
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1;
    ELSIF NEW.discount_amount > OLD.discount_amount THEN
        v_action := 'DISCOUNT_APPLIED';
        SELECT ((a.metadata->>'discount_before')::NUMERIC = OLD.discount_amount
                AND (a.metadata->>'discount_after')::NUMERIC = NEW.discount_amount
                AND m.role IN ('MANAGER', 'OWNER') AND m.active)
          INTO v_ok
          FROM audit_logs a LEFT JOIN staff_users m ON m.id = a.authorized_by_manager_id
         WHERE a.order_id = NEW.id AND a.action_type = 'DISCOUNT_APPLIED'
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1;
    ELSE
        RETURN NULL;
    END IF;
    IF NOT COALESCE(v_ok, FALSE) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % sem PIN de gerente registrado em audit_logs.', v_action;
    END IF;
    RETURN NULL;
END;
$$;

-- Hook de access token do Supabase Auth: claim tenant_id = app_metadata.tenant_id.
-- Ativar em Authentication > Hooks > Customize Access Token, função public.tchefood_access_token_hook.
CREATE OR REPLACE FUNCTION public.tchefood_access_token_hook(event JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
    claims JSONB := event->'claims';
    tenant TEXT := event->'claims'->'app_metadata'->>'tenant_id';
BEGIN
    IF tenant IS NOT NULL AND tenant <> '' THEN
        claims := jsonb_set(claims, '{tenant_id}', to_jsonb(tenant));
    END IF;
    RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION public.tchefood_access_token_hook(JSONB) TO supabase_auth_admin;
        REVOKE EXECUTE ON FUNCTION public.tchefood_access_token_hook(JSONB) FROM authenticated, anon, public;
    END IF;
END $$;
