-- Cópia de db/schema_entrega.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- TCHÊ FOOD — schema_entrega.sql (entrega própria: bairros, entregadores, acerto)
-- Rode DEPOIS de db/schema_caixa.sql e db/schema_dinheiro_servidor.sql. Idempotente.
-- Espelho TypeScript: src/types.ts (DeliveryZone, Courier, OwnDelivery,
-- CourierSettlement) e src/lib/ownDelivery.ts.
--
-- Regras:
--  1. O pedido de entrega é uma senha (mesa KIOSK) com fulfillment_type DELIVERY.
--     A taxa do bairro é um item da conta (produto técnico TAXA-ENTREGA).
--  2. A entrega só anda para a frente: PREPARING → READY → OUT → DELIVERED;
--     CANCELED a partir de qualquer etapa antes de entregue. Cliente, endereço,
--     taxa e forma de pagamento não mudam depois de lançados.
--  3. Saiu para entrega (OUT) exige entregador e o ganho dele gravado.
--  4. Acerto com o entregador é somente inserção. A entrega acertada aponta para
--     o acerto do mesmo entregador e não muda mais. Se o ganho saiu da gaveta, o
--     acerto aponta para a sangria (cash_movements) com o mesmo valor.
--  5. Reenvio da fila (resposta perdida) com os mesmos dados passa sem erro.
-- =============================================================================

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_type_check CHECK (fulfillment_type IS NULL OR fulfillment_type IN ('DINE_IN', 'TAKEOUT', 'DELIVERY'));

CREATE TABLE IF NOT EXISTS delivery_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(60) NOT NULL CHECK (length(trim(name)) >= 2),
    fee NUMERIC(10,2) NOT NULL CHECK (fee >= 0 AND fee <= 200),
    eta_minutes INT NOT NULL CHECK (eta_minutes BETWEEN 5 AND 240),
    active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_zones_name ON delivery_zones (tenant_id, lower(name));

CREATE TABLE IF NOT EXISTS couriers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(60) NOT NULL CHECK (length(trim(name)) >= 2),
    phone VARCHAR(11) CHECK (phone IS NULL OR phone ~ '^[0-9]{10,11}$'),
    fee_per_delivery NUMERIC(10,2) NOT NULL CHECK (fee_per_delivery >= 0 AND fee_per_delivery <= 200),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS courier_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    courier_id UUID NOT NULL REFERENCES couriers(id),
    deliveries INT NOT NULL CHECK (deliveries > 0),
    cash_collected NUMERIC(10,2) NOT NULL CHECK (cash_collected >= 0),
    courier_fees NUMERIC(10,2) NOT NULL CHECK (courier_fees >= 0),
    cash_movement_id UUID REFERENCES cash_movements(id),
    settled_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS courier_settlements_courier ON courier_settlements (courier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS own_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
    customer_name VARCHAR(60) NOT NULL CHECK (length(trim(customer_name)) >= 2),
    customer_phone VARCHAR(11) NOT NULL CHECK (customer_phone ~ '^[0-9]{10,11}$'),
    address VARCHAR(160) NOT NULL CHECK (length(trim(address)) >= 5),
    reference VARCHAR(120),
    zone_id UUID NOT NULL REFERENCES delivery_zones(id),
    zone_name VARCHAR(60) NOT NULL,
    delivery_fee NUMERIC(10,2) NOT NULL CHECK (delivery_fee >= 0),
    pay_on_delivery BOOLEAN NOT NULL,
    change_for NUMERIC(10,2) CHECK (change_for IS NULL OR (pay_on_delivery AND change_for > 0)),
    status VARCHAR(10) NOT NULL DEFAULT 'PREPARING' CHECK (status IN ('PREPARING', 'READY', 'OUT', 'DELIVERED', 'CANCELED')),
    courier_id UUID REFERENCES couriers(id),
    courier_fee NUMERIC(10,2) CHECK (courier_fee IS NULL OR courier_fee >= 0),
    out_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    settlement_id UUID REFERENCES courier_settlements(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT own_deliveries_out_fields CHECK (
        status NOT IN ('OUT', 'DELIVERED') OR (courier_id IS NOT NULL AND courier_fee IS NOT NULL AND out_at IS NOT NULL)
    ),
    CONSTRAINT own_deliveries_delivered_fields CHECK (status <> 'DELIVERED' OR delivered_at IS NOT NULL),
    CONSTRAINT own_deliveries_settled_fields CHECK (settlement_id IS NULL OR status = 'DELIVERED')
);
CREATE INDEX IF NOT EXISTS own_deliveries_board ON own_deliveries (tenant_id, status, created_at DESC);

-- Etapa de cada status, para só deixar andar para a frente.
CREATE OR REPLACE FUNCTION tchefood_delivery_step(p_status VARCHAR) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_status WHEN 'PREPARING' THEN 1 WHEN 'READY' THEN 2 WHEN 'OUT' THEN 3 WHEN 'DELIVERED' THEN 4 ELSE 0 END
$$;

CREATE OR REPLACE FUNCTION tchefood_own_delivery_rules()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_kind VARCHAR(10);
    v_order orders%ROWTYPE;
    v_settlement courier_settlements%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entrega não se apaga; cancele.';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO v_order FROM orders WHERE id = NEW.order_id;
        SELECT kind INTO v_kind FROM dining_tables WHERE id = v_order.table_id;
        IF v_order.id IS NULL OR v_order.tenant_id <> NEW.tenant_id OR v_kind IS DISTINCT FROM 'KIOSK' OR v_order.fulfillment_type IS DISTINCT FROM 'DELIVERY' THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: a entrega precisa de um pedido com senha marcado como entrega.';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM delivery_zones z WHERE z.id = NEW.zone_id AND z.tenant_id = NEW.tenant_id) THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: bairro não é desta loja.';
        END IF;
        IF NEW.status <> 'PREPARING' OR NEW.courier_id IS NOT NULL OR NEW.settlement_id IS NOT NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: a entrega nasce em preparo, sem entregador.';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE. Reenvio igual ao que já está gravado: nada muda.
    IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN OLD;
    END IF;
    IF OLD.settlement_id IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entrega já acertada com o entregador não muda.';
    END IF;
    IF OLD.status = 'CANCELED' THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entrega cancelada não muda.';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.order_id <> OLD.order_id OR NEW.customer_name <> OLD.customer_name
       OR NEW.customer_phone <> OLD.customer_phone OR NEW.address <> OLD.address OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.zone_id <> OLD.zone_id OR NEW.zone_name <> OLD.zone_name OR NEW.delivery_fee <> OLD.delivery_fee
       OR NEW.pay_on_delivery <> OLD.pay_on_delivery OR NEW.change_for IS DISTINCT FROM OLD.change_for OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: cliente, endereço, taxa e pagamento não mudam depois de lançados.';
    END IF;
    IF NEW.status = 'CANCELED' THEN
        IF OLD.status = 'DELIVERED' THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entrega já entregue não se cancela.';
        END IF;
    ELSIF NEW.status <> OLD.status AND tchefood_delivery_step(NEW.status) <> tchefood_delivery_step(OLD.status) + 1 THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: a entrega anda uma etapa por vez (% → %).', OLD.status, NEW.status;
    END IF;
    -- Entregador e ganho só se definem ao sair; depois não mudam.
    IF OLD.status IN ('OUT', 'DELIVERED') AND (NEW.courier_id IS DISTINCT FROM OLD.courier_id OR NEW.courier_fee IS DISTINCT FROM OLD.courier_fee OR NEW.out_at IS DISTINCT FROM OLD.out_at) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entregador e ganho não mudam depois que a entrega saiu.';
    END IF;
    IF NEW.courier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM couriers c WHERE c.id = NEW.courier_id AND c.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entregador não é desta loja.';
    END IF;
    IF NEW.settlement_id IS NOT NULL THEN
        SELECT * INTO v_settlement FROM courier_settlements WHERE id = NEW.settlement_id;
        IF v_settlement.id IS NULL OR v_settlement.tenant_id <> NEW.tenant_id OR v_settlement.courier_id IS DISTINCT FROM NEW.courier_id THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: o acerto precisa ser do mesmo entregador da entrega.';
        END IF;
        IF OLD.status <> 'DELIVERED' THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: só entrega entregue entra no acerto.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_own_deliveries_rules ON own_deliveries;
CREATE TRIGGER trg_own_deliveries_rules BEFORE INSERT OR UPDATE OR DELETE ON own_deliveries
    FOR EACH ROW EXECUTE FUNCTION tchefood_own_delivery_rules();

CREATE OR REPLACE FUNCTION tchefood_courier_settlement_rules()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_mv cash_movements%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: acerto com o entregador é somente inserção.';
    END IF;
    -- Reenvio da fila: o mesmo acerto já gravado passa (ON CONFLICT DO NOTHING ignora).
    IF EXISTS (SELECT 1 FROM courier_settlements s
                WHERE s.id = NEW.id AND s.tenant_id = NEW.tenant_id AND s.courier_id = NEW.courier_id
                  AND s.cash_collected = NEW.cash_collected AND s.courier_fees = NEW.courier_fees) THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM couriers c WHERE c.id = NEW.courier_id AND c.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entregador não é desta loja.';
    END IF;
    IF NEW.cash_movement_id IS NOT NULL THEN
        SELECT * INTO v_mv FROM cash_movements WHERE id = NEW.cash_movement_id;
        IF v_mv.id IS NULL OR v_mv.tenant_id <> NEW.tenant_id OR v_mv.type <> 'WITHDRAWAL' OR v_mv.amount <> NEW.courier_fees THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: o pagamento do entregador pela gaveta precisa ser uma sangria com o mesmo valor do ganho.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_courier_settlements_rules ON courier_settlements;
CREATE TRIGGER trg_courier_settlements_rules BEFORE INSERT OR UPDATE OR DELETE ON courier_settlements
    FOR EACH ROW EXECUTE FUNCTION tchefood_courier_settlement_rules();

-- Preço do item conferido pelo servidor (db/schema_dinheiro_servidor.sql), agora com a
-- taxa de entrega: igual à função de lá, mais o caso do produto TAXA-ENTREGA. Este arquivo
-- vem depois e a substitui (src/__tests__/migrations.test.ts confere a ordem).
CREATE OR REPLACE FUNCTION tchefood_expected_item_price(p_item order_items)
RETURNS TABLE (base NUMERIC, modifiers NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_product products%ROWTYPE;
    v_rule VARCHAR;
    v_at TIMESTAMPTZ;
    v_prices NUMERIC[];
    v_half UUID;
    v_mods NUMERIC;
    v_count INT;
BEGIN
    SELECT * INTO v_product FROM products WHERE id = p_item.product_id;
    IF NOT FOUND THEN RETURN; END IF;
    -- Taxa de entrega própria: o preço é a taxa do bairro gravada na entrega da conta
    -- (a entrega sobe antes dos itens). Sem entrega, o banco não tem como conferir.
    IF v_product.code = 'TAXA-ENTREGA' THEN
        SELECT d.delivery_fee, 0::NUMERIC INTO base, modifiers FROM own_deliveries d
         WHERE d.order_id = p_item.order_id AND d.tenant_id = v_product.tenant_id;
        IF FOUND AND COALESCE(array_length(p_item.modifier_option_ids, 1), 0) = 0 AND COALESCE(array_length(p_item.half_product_ids, 1), 0) = 0 THEN
            RETURN NEXT;
        END IF;
        RETURN;
    END IF;
    SELECT t.half_and_half_pricing INTO v_rule FROM tenants t WHERE t.id = v_product.tenant_id;
    -- Instante do preço: quando o item foi para a bandeja, dentro de 12 h antes do envio
    -- e nunca no futuro (relógio do aparelho adiantado não vale).
    v_at := LEAST(GREATEST(COALESCE(p_item.priced_at, p_item.created_at, NOW()), COALESCE(p_item.created_at, NOW()) - INTERVAL '12 hours'), NOW());

    -- Ficha Rápida (origem SMARTPOS) cobra o preço do cadastro sem a regra de horário,
    -- como o app faz hoje (createCounterSale).
    IF p_item.origin = 'SMARTPOS' THEN
        v_prices := ARRAY[round(v_product.price, 2)];
    ELSE
        v_prices := ARRAY[tchefood_sale_price(v_product.id, v_at)];
    END IF;
    FOREACH v_half IN ARRAY COALESCE(p_item.half_product_ids, '{}') LOOP
        IF NOT EXISTS (SELECT 1 FROM products h WHERE h.id = v_half AND h.tenant_id = v_product.tenant_id AND h.allows_half_and_half)
           OR NOT v_product.allows_half_and_half THEN
            RETURN;
        END IF;
        v_prices := v_prices || tchefood_sale_price(v_half, v_at);
    END LOOP;
    IF array_length(v_prices, 1) > 1 THEN
        base := CASE WHEN v_rule = 'AVERAGE'
                     THEN round((SELECT sum(round(x * 100)) FROM unnest(v_prices) x) / array_length(v_prices, 1)) / 100
                     ELSE (SELECT max(round(x, 2)) FROM unnest(v_prices) x) END;
    ELSE
        base := v_prices[1];
    END IF;

    -- Adicionais: só opções de grupos ligados ao produto.
    SELECT count(*), COALESCE(sum(o.additional_price), 0) INTO v_count, v_mods
      FROM unnest(COALESCE(p_item.modifier_option_ids, '{}')) AS sel(id)
      JOIN modifier_options o ON o.id = sel.id
      JOIN product_modifier_groups l ON l.group_id = o.group_id AND l.product_id = v_product.id;
    IF v_count <> COALESCE(array_length(p_item.modifier_option_ids, 1), 0) THEN RETURN; END IF;
    modifiers := round(v_mods, 2);
    RETURN NEXT;
END;
$$;

-- RLS multi-tenant (mesmo claim de db/schema.sql)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['delivery_zones','couriers','own_deliveries','courier_settlements'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_tenant') THEN
            EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant())', t || '_tenant', t);
        END IF;
    END LOOP;
END $$;
