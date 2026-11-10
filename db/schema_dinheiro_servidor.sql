-- =============================================================================
-- Tchê Food — gravações de dinheiro conferidas pelo servidor
-- Aplicar depois de db/schema_baixar_loja.sql. Idempotente: pode rodar de novo.
-- Espelho TypeScript: src/lib/sync/supabaseSync.ts (buildPaymentRequest) e
-- src/lib/catalog.ts / src/lib/money.ts (preço do item).
--
-- 1. Pagamento só entra por tchefood_register_payment: o aparelho não grava, não
--    altera nem apaga linha de payments direto. A função confere no banco:
--     - a conta é da loja do token e está aberta;
--     - quem recebeu é da equipe ativa; a maquininha (se houver) é da loja;
--     - pagamento aprovado não passa do saldo que o BANCO calculou;
--     - dinheiro é no caixa (CASH_DESK); cartão e PIX aprovados têm o NSU do
--       comprovante (o NSU nunca é inventado) e o mesmo NSU da mesma credenciadora
--       e maquininha não paga duas contas em 24 h (contados pelo relógio do servidor
--       e também pela hora do comprovante);
--     - reenvio do mesmo pagamento (mesmo id) devolve o que já está gravado.
-- 2. Conta só vira CLOSED ou CANCELED com saldo zero no banco (o fechamento normal
--    é o automático, quando os pagamentos zeram o saldo).
-- 3. Preço do item: o banco recalcula o preço de cadastro (com a regra de horário
--    no instante em que o item foi precificado, a regra do meio a meio da loja e os
--    adicionais escolhidos) e, se o item chegou com outro preço, grava o alerta
--    PRICE_MISMATCH no audit_log com a diferença. A venda não é travada: a diferença
--    só aparece com app adulterado ou com preço trocado em outro aparelho há menos
--    de um minuto (antes de este aparelho baixar o cadastro novo).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Colunas novas
-- -----------------------------------------------------------------------------
-- Regra do meio a meio é da loja (antes era só do aparelho).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS half_and_half_pricing VARCHAR(10) NOT NULL DEFAULT 'HIGHEST';
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_half_and_half_pricing_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_half_and_half_pricing_check CHECK (half_and_half_pricing IN ('HIGHEST', 'AVERAGE'));

-- O que o banco precisa para refazer a conta do preço do item.
-- Quando o servidor registrou o pagamento (o aparelho não escolhe): é a base da trava de comprovante repetido.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS priced_at TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS half_product_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS modifier_option_ids UUID[] NOT NULL DEFAULT '{}';

-- -----------------------------------------------------------------------------
-- 1. Pagamento pela função do servidor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_register_payment(p_payment JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_pay payments%ROWTYPE;
    v_existing payments%ROWTYPE;
    v_order orders%ROWTYPE;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    v_pay := jsonb_populate_record(NULL::payments, p_payment);
    IF v_pay.id IS NULL OR v_pay.order_id IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: pagamento sem id ou sem conta.';
    END IF;
    IF v_pay.tenant_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: pagamento de outra loja.';
    END IF;

    -- Reenvio da fila: o mesmo pagamento já está gravado.
    SELECT * INTO v_existing FROM payments WHERE id = v_pay.id;
    IF FOUND THEN
        IF v_existing.tenant_id <> v_tenant OR v_existing.order_id <> v_pay.order_id
           OR v_existing.amount <> v_pay.amount OR v_existing.status <> v_pay.status THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: já existe outro pagamento com este id.';
        END IF;
        RETURN v_existing.id;
    END IF;

    -- A conta trava aqui: dois pagamentos da mesma conta não passam juntos do saldo.
    SELECT * INTO v_order FROM orders WHERE id = v_pay.order_id AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: conta não encontrada nesta loja.';
    END IF;
    -- Dois envios do mesmo pagamento ao mesmo tempo: o segundo espera a conta e, ao entrar, o primeiro
    -- já gravou. Confere de novo para devolver o gravado em vez de recusar um reenvio legítimo.
    SELECT * INTO v_existing FROM payments WHERE id = v_pay.id;
    IF FOUND THEN
        IF v_existing.tenant_id <> v_tenant OR v_existing.order_id <> v_pay.order_id
           OR v_existing.amount <> v_pay.amount OR v_existing.status <> v_pay.status THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: já existe outro pagamento com este id.';
        END IF;
        RETURN v_existing.id;
    END IF;
    IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta já está %.', CASE v_order.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = v_pay.waiter_id AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: quem recebeu não é da equipe ativa da loja.';
    END IF;
    IF v_pay.terminal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pos_terminals t WHERE t.id = v_pay.terminal_id AND t.tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: maquininha não é desta loja.';
    END IF;
    IF v_pay.amount IS NULL OR v_pay.amount <= 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: valor do pagamento deve ser maior que zero.';
    END IF;
    IF COALESCE(v_pay.tip_amount, 0) < 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: gorjeta negativa.';
    END IF;

    IF v_pay.status = 'APPROVED' THEN
        IF v_pay.amount > v_order.remaining_balance THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: R$ % passa do saldo da conta no servidor (R$ %).', v_pay.amount, v_order.remaining_balance;
        END IF;
        IF v_pay.method = 'CASH' THEN
            IF v_pay.acquirer <> 'CASH_DESK' THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: dinheiro é registrado no caixa (CASH_DESK).';
            END IF;
        ELSE
            IF v_pay.acquirer = 'CASH_DESK' THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: % aprovado precisa da credenciadora da maquininha.', v_pay.method;
            END IF;
            IF v_pay.nsu IS NULL OR length(trim(v_pay.nsu)) = 0 THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: % aprovado sem o NSU do comprovante.', v_pay.method;
            END IF;
            -- Dois aparelhos com o mesmo comprovante em contas diferentes: o travamento da conta
            -- (acima) não os serializa, então o comprovante também trava a transação.
            PERFORM pg_advisory_xact_lock(hashtextextended(
                v_tenant::text || '|' || v_pay.acquirer || '|' || COALESCE(v_pay.terminal_serial, '') || '|' || v_pay.nsu, 0));
            IF EXISTS (
                SELECT 1 FROM payments p
                 WHERE p.tenant_id = v_tenant AND p.status = 'APPROVED' AND p.acquirer = v_pay.acquirer
                   AND p.nsu = v_pay.nsu AND COALESCE(p.terminal_serial, '') = COALESCE(v_pay.terminal_serial, '')
                   AND (p.registered_at > NOW() - INTERVAL '24 hours'
                        OR (p.created_at > COALESCE(v_pay.created_at, NOW()) - INTERVAL '24 hours'
                            AND p.created_at < COALESCE(v_pay.created_at, NOW()) + INTERVAL '24 hours'))
            ) THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o NSU % já pagou outra conta (mesma credenciadora e maquininha).', v_pay.nsu;
            END IF;
        END IF;
    END IF;

    INSERT INTO payments (id, order_id, tenant_id, waiter_id, terminal_id, amount, tip_amount, method, status, acquirer,
                          acquirer_cnpj, card_brand, nsu, authorization_code, terminal_serial, idempotency_key, created_at)
    VALUES (v_pay.id, v_pay.order_id, v_tenant, v_pay.waiter_id, v_pay.terminal_id, v_pay.amount, COALESCE(v_pay.tip_amount, 0),
            v_pay.method, v_pay.status, v_pay.acquirer, v_pay.acquirer_cnpj, v_pay.card_brand, v_pay.nsu, v_pay.authorization_code,
            v_pay.terminal_serial, v_pay.idempotency_key, COALESCE(v_pay.created_at, NOW()));
    RETURN v_pay.id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Conta só fecha ou cancela com saldo zero no banco
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_order_close_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_subtotal NUMERIC(10,2);
    v_fee      NUMERIC(10,2);
    v_discount NUMERIC(10,2);
    v_paid     NUMERIC(10,2);
    v_remaining NUMERIC(10,2);
BEGIN
    IF NEW.status IN ('CLOSED', 'CANCELED') AND OLD.status IN ('OPEN', 'PAYING') THEN
        -- O mesmo UPDATE que encerra a conta pode trazer a taxa de serviço ou o desconto novos
        -- (quitar com a gorjeta dispensada, por exemplo). Os totais gravados só são refeitos DEPOIS
        -- (trg_orders_flags), então o saldo é calculado aqui com os valores que estão chegando,
        -- pela mesma regra de tchefood_recalc_order.
        SELECT COALESCE(SUM(total_item_price), 0) INTO v_subtotal
          FROM order_items WHERE order_id = OLD.id AND status <> 'CANCELED';
        v_fee := CASE WHEN NEW.charge_service_fee THEN round(v_subtotal * NEW.service_fee_pct / 100, 2) ELSE 0 END;
        v_discount := LEAST(GREATEST(NEW.discount_amount, 0), v_subtotal + v_fee);
        SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments WHERE order_id = OLD.id AND status = 'APPROVED';
        v_remaining := GREATEST(v_subtotal + v_fee - v_discount - v_paid, 0);
        IF v_remaining <> 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: a conta % ainda deve R$ % no servidor e não pode ser %.',
                OLD.id, v_remaining, CASE NEW.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END;
        END IF;
    END IF;
    IF OLD.status IN ('CLOSED', 'CANCELED') AND NEW.status IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: a conta % já foi encerrada e não reabre.', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_close_guard ON orders;
CREATE TRIGGER trg_orders_close_guard BEFORE UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_close_guard();

-- -----------------------------------------------------------------------------
-- 3. Preço do item conferido pelo cadastro
-- -----------------------------------------------------------------------------
-- Preço de venda do produto num instante (cadastro + regra de horário), no fuso da
-- loja (America/Sao_Paulo). Mesma regra de src/lib/catalog.ts: janela que vira a
-- meia-noite continua no dia seguinte; no máximo uma regra ativa por horário.
CREATE OR REPLACE FUNCTION tchefood_sale_price(p_product_id UUID, p_at TIMESTAMPTZ)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_local TIMESTAMP := p_at AT TIME ZONE 'America/Sao_Paulo';
    v_minute INT := EXTRACT(DOW FROM v_local)::int * 1440 + EXTRACT(HOUR FROM v_local)::int * 60 + EXTRACT(MINUTE FROM v_local)::int;
    v_price NUMERIC;
    s RECORD;
    v_start INT; v_end INT; v_len INT; v_a INT; v_b INT; d INT;
BEGIN
    SELECT price INTO v_price FROM products WHERE id = p_product_id;
    FOR s IN SELECT * FROM price_schedules ps WHERE ps.product_id = p_product_id AND ps.active LOOP
        v_start := split_part(s.start_time, ':', 1)::int * 60 + split_part(s.start_time, ':', 2)::int;
        v_end := split_part(s.end_time, ':', 1)::int * 60 + split_part(s.end_time, ':', 2)::int;
        CONTINUE WHEN v_start = v_end;
        v_len := CASE WHEN v_end > v_start THEN v_end - v_start ELSE 1440 - v_start + v_end END;
        FOREACH d IN ARRAY s.weekdays LOOP
            v_a := d * 1440 + v_start;
            v_b := v_a + v_len;
            IF (v_minute >= v_a AND v_minute < LEAST(v_b, 10080))
               OR (v_b > 10080 AND v_minute < v_b - 10080) THEN
                RETURN round(s.price, 2);
            END IF;
        END LOOP;
    END LOOP;
    RETURN round(v_price, 2);
END;
$$;

-- Preço unitário esperado (base + adicionais) do item, ou NULL se não dá para conferir
-- (produto, sabor ou adicional que não é desta loja / deste produto).
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

CREATE OR REPLACE FUNCTION tchefood_check_item_price()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_product products%ROWTYPE;
    v_expected RECORD;
    v_impact NUMERIC;
BEGIN
    -- Reenvio da fila (upsert do mesmo item): já foi conferido na primeira vez.
    IF EXISTS (SELECT 1 FROM order_items i WHERE i.id = NEW.id) THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_product FROM products WHERE id = NEW.product_id;
    -- Pesado (o banco já fixa preço e quantidade) e componente de combo (preço zero, schema_combos.sql).
    IF NOT FOUND OR v_product.sold_by_weight OR NEW.combo_parent_item_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_expected FROM tchefood_expected_item_price(NEW);
    IF v_expected.base IS NOT NULL
       AND v_expected.base = NEW.unit_price AND v_expected.modifiers = NEW.modifiers_unit_price THEN
        RETURN NEW;
    END IF;
    v_impact := CASE WHEN v_expected.base IS NULL THEN NULL
                     ELSE round(NEW.quantity * ((v_expected.base + v_expected.modifiers) - (NEW.unit_price + NEW.modifiers_unit_price)), 2) END;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, amount_impact, reason, whatsapp_alert_sent, metadata)
    VALUES (v_product.tenant_id, NEW.order_id, NEW.waiter_id, 'PRICE_MISMATCH', COALESCE(v_impact, 0),
            CASE WHEN v_expected.base IS NULL THEN 'Item com sabor ou adicional que o cadastro da nuvem não reconhece'
                 ELSE 'Item lançado com preço diferente do cadastro da nuvem' END,
            FALSE,
            jsonb_build_object(
                'server_verified', TRUE,
                'item_id', NEW.id, 'product_id', NEW.product_id, 'product_code', v_product.code, 'quantity', NEW.quantity,
                'unit_price', NEW.unit_price, 'modifiers_unit_price', NEW.modifiers_unit_price,
                'expected_unit_price', v_expected.base, 'expected_modifiers_unit_price', v_expected.modifiers,
                'priced_at', NEW.priced_at, 'origin', NEW.origin));
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_01_price ON order_items;
CREATE TRIGGER trg_order_items_01_price BEFORE INSERT ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_check_item_price();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE INSERT, UPDATE, DELETE ON payments FROM anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_register_payment(JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_register_payment(JSONB) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_sale_price(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_expected_item_price(order_items) FROM PUBLIC, anon, authenticated;
    END IF;
END $$;
