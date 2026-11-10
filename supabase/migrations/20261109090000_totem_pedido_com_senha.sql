-- Cópia de db/schema_kiosk.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- TCHÊ FOOD — schema_kiosk.sql (Totem de autoatendimento e pedido no caixa)
-- Pedido com senha: o cliente (no totem) ou a atendente (no caixa) monta o
-- pedido, paga, recebe a senha e o pedido vai para o KDS e para o painel da TV.
--
-- Rode DEPOIS de db/schema.sql e db/schema_expansion.sql. Idempotente.
-- Espelho TypeScript: src/types.ts (Order.pickup_*, DiningTableKind 'KIOSK',
-- UserRole 'KIOSK', OrderItemOrigin 'KIOSK') e src/lib/kiosk.ts.
--
-- Regras:
--  1. Pedido com senha usa a mesa técnica kind = 'KIOSK' (nunca ocupada, fora do mapa).
--  2. Nasce PAYING, sem os 10% do garçom, com fulfillment_type e senha.
--  3. A senha (1 a 999) é por loja e por dia civil de Brasília; quando o app não
--     manda a senha (ou manda NULL), o banco gera com trava de linha, então dois
--     totens ao mesmo tempo nunca recebem a mesma senha.
--  4. Só a mesa KIOSK tem senha; comanda de mesa e ficha de balcão ficam NULL.
--  5. O aparelho do totem entra com um usuário próprio (role KIOSK).
-- =============================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'KIOSK';

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_kind_check;
-- CARD vem da comanda por cartão (db/schema_cartao.sql); fica aqui também para este arquivo rodar de novo numa base que já tem cartões.
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_kind_check CHECK (kind IN ('TABLE', 'COUNTER', 'KIOSK', 'CARD'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_number INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_name VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type VARCHAR(10);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_pickup_number_check;
ALTER TABLE orders ADD CONSTRAINT orders_pickup_number_check CHECK (pickup_number IS NULL OR pickup_number BETWEEN 1 AND 999);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_type_check;
-- DELIVERY vem da entrega própria (db/schema_entrega.sql); fica aqui também para este arquivo rodar de novo numa base que já tem entregas.
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_type_check CHECK (fulfillment_type IS NULL OR fulfillment_type IN ('DINE_IN', 'TAKEOUT', 'DELIVERY'));

-- Contador de senhas por loja e dia (Brasília).
CREATE TABLE IF NOT EXISTS pickup_counters (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    business_date DATE NOT NULL,
    last_number INT NOT NULL DEFAULT 0 CHECK (last_number BETWEEN 0 AND 999),
    PRIMARY KEY (tenant_id, business_date)
);

CREATE OR REPLACE FUNCTION tchefood_business_date(p_at TIMESTAMPTZ) RETURNS DATE
LANGUAGE sql IMMUTABLE AS $$ SELECT (p_at AT TIME ZONE 'America/Sao_Paulo')::date $$;

-- Próxima senha do dia; depois do 999 volta para 1 (igual a src/lib/kiosk.ts).
CREATE OR REPLACE FUNCTION tchefood_next_pickup_number(p_tenant UUID, p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_next INT;
BEGIN
    INSERT INTO pickup_counters (tenant_id, business_date, last_number)
    VALUES (p_tenant, tchefood_business_date(p_at), 1)
    ON CONFLICT (tenant_id, business_date)
    DO UPDATE SET last_number = CASE WHEN pickup_counters.last_number >= 999 THEN 1 ELSE pickup_counters.last_number + 1 END
    RETURNING last_number INTO v_next;
    RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_pickup_order_rules()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_kind VARCHAR(10);
BEGIN
    SELECT kind INTO v_kind FROM dining_tables WHERE id = NEW.table_id;
    IF v_kind = 'KIOSK' THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.fulfillment_type IS NULL THEN
                RAISE EXCEPTION 'TCHEFOOD_TOTEM: informe comer aqui (DINE_IN) ou para levar (TAKEOUT).';
            END IF;
            IF NEW.charge_service_fee THEN
                RAISE EXCEPTION 'TCHEFOOD_TOTEM: pedido com senha não cobra os 10%% do garçom.';
            END IF;
            IF NEW.status <> 'PAYING' THEN
                RAISE EXCEPTION 'TCHEFOOD_TOTEM: pedido com senha nasce aguardando pagamento (PAYING).';
            END IF;
            IF NEW.pickup_number IS NULL THEN
                NEW.pickup_number := tchefood_next_pickup_number(NEW.tenant_id, NEW.opened_at);
            END IF;
        ELSE
            IF NEW.pickup_number IS DISTINCT FROM OLD.pickup_number THEN
                RAISE EXCEPTION 'TCHEFOOD_TOTEM: a senha do pedido não muda depois de emitida.';
            END IF;
            IF NEW.charge_service_fee THEN
                RAISE EXCEPTION 'TCHEFOOD_TOTEM: pedido com senha não cobra os 10%% do garçom.';
            END IF;
        END IF;
    ELSIF NEW.pickup_number IS NOT NULL OR NEW.fulfillment_type IS NOT NULL OR NEW.pickup_name IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_TOTEM: senha só existe no pedido do totem / caixa (mesa KIOSK).';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_pickup_rules ON orders;
CREATE TRIGGER trg_orders_pickup_rules BEFORE INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_pickup_order_rules();

-- Painel / KDS: senhas pagas do dia.
CREATE INDEX IF NOT EXISTS idx_orders_pickup_today ON orders (tenant_id, opened_at) WHERE pickup_number IS NOT NULL;

ALTER TABLE pickup_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pickup_counters_tenant ON pickup_counters;
CREATE POLICY pickup_counters_tenant ON pickup_counters USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant());
