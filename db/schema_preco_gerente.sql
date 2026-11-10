-- =============================================================================
-- Tchê Food — preço diferente do cadastro só com PIN de gerente (P1-01)
-- Aplicar depois de schema_caixa.sql e schema_dinheiro_servidor.sql (idempotente).
--
-- Antes: o banco recalculava o preço do item e, se viesse diferente, gravava o alerta
-- PRICE_MISMATCH e aceitava a venda. Decisão do Will (10/11/2026): aceitar só com PIN
-- de gerente.
--   1. tchefood_authorize_manager aceita PRICE_OVERRIDE, preso ao item inteiro (item_id,
--      product_id, quantity, unit_price, modifiers_unit_price, half_product_ids e
--      modifier_option_ids no metadata), com o PIN conferido no servidor. Os campos são
--      conferidos e gravados já convertidos: autorização com valor inválido é recusada e
--      não fica gravada (senão a conferência do item quebraria para sempre).
--   2. tchefood_check_item_price recusa (TCHEFOOD_PRECO) o item com preço diferente,
--      o item que o servidor não consegue conferir (sabor/adicional
--      desconhecido) e só aceita com um PRICE_OVERRIDE do mesmo item e mesmo preço.
--      O PRICE_MISMATCH continua sendo gravado, agora com o gerente que autorizou.
--      Produto ou conta de outra loja: recusa genérica, sem preço nem nome na mensagem.
--   3. tchefood_expected_item_price (cópia da versão de schema_entrega.sql): a Ficha
--      Rápida segue a regra de horário, como o app (PR #27). Sem isso a venda certa
--      de happy hour no balcão seria recusada.
--      O instante do preço é o relógio do servidor (NOW), nunca o horário que o aparelho
--      manda (created_at/priced_at podem ser forjados). Venda de happy hour que só sobe
--      depois da janela fica recusada até o gerente aceitar com PIN.
-- No aparelho, o item recusado aparece em Nuvem › recusados com o campo de PIN do
-- gerente e motivo; a autorização sobe antes do item.
-- =============================================================================

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
    v_performer staff_users%ROWTYPE;
    v_failures INT;
    v_id UUID;
    v_meta JSONB := COALESCE(p_metadata, '{}'::jsonb);
    v_valid BOOLEAN;
    v_without_order BOOLEAN := p_action_type IN ('KIOSK_EXIT', 'KEG_CHANGED', 'CASH_WITHDRAWAL', 'CASH_CLOSE_DIFFERENCE');
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.';
    END IF;
    IF p_action_type NOT IN ('ITEM_CANCELED', 'SERVICE_FEE_REMOVED', 'DISCOUNT_APPLIED',
                             'CHARGE_CONFIRMED_MANUALLY', 'KIOSK_EXIT', 'KEG_CHANGED',
                             'CASH_WITHDRAWAL', 'CASH_CLOSE_DIFFERENCE', 'PRICE_OVERRIDE') THEN
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
    -- Preço diferente do cadastro: a autorização é presa ao item inteiro (id, produto,
    -- quantidade, preços, sabores e adicionais) e vem antes dele. Não mexe no valor por si:
    -- a diferença sai no PRICE_MISMATCH do item. Os campos são gravados já convertidos
    -- (o gatilho do item compara sem conversão); valor inválido recusa sem gravar nada.
    IF p_action_type = 'PRICE_OVERRIDE' THEN
        IF COALESCE(p_amount_impact, 0) <> 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_PRECO: autorização de preço não tem valor próprio (a diferença sai no alerta do item).';
        END IF;
        BEGIN
            v_meta := v_meta || jsonb_build_object(
                'item_id', (p_metadata->>'item_id')::uuid,
                'product_id', (p_metadata->>'product_id')::uuid,
                'quantity', (p_metadata->>'quantity')::numeric(10,3),
                'unit_price', (p_metadata->>'unit_price')::numeric(10,2),
                'modifiers_unit_price', (p_metadata->>'modifiers_unit_price')::numeric(10,2),
                'half_product_ids', to_jsonb(ARRAY(SELECT jsonb_array_elements_text(p_metadata->'half_product_ids'))::uuid[]),
                'modifier_option_ids', to_jsonb(ARRAY(SELECT jsonb_array_elements_text(p_metadata->'modifier_option_ids'))::uuid[]));
            v_valid := jsonb_typeof(p_metadata->'half_product_ids') = 'array'
                   AND jsonb_typeof(p_metadata->'modifier_option_ids') = 'array'
                   AND (v_meta->>'item_id') IS NOT NULL AND (v_meta->>'product_id') IS NOT NULL
                   AND (v_meta->>'quantity')::numeric > 0 AND (v_meta->>'unit_price')::numeric >= 0
                   AND (v_meta->>'modifiers_unit_price') IS NOT NULL;
        EXCEPTION WHEN others THEN
            v_valid := FALSE;
        END;
        IF NOT COALESCE(v_valid, FALSE) THEN
            RAISE EXCEPTION 'TCHEFOOD_PRECO: autorização de preço precisa de item_id, product_id, quantity, unit_price, modifiers_unit_price, half_product_ids e modifier_option_ids válidos no metadata.';
        END IF;
        PERFORM 1 FROM products pr WHERE pr.id = (v_meta->>'product_id')::uuid AND pr.tenant_id = v_tenant;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_PRECO: produto não encontrado nesta loja.';
        END IF;
    END IF;

    IF v_without_order THEN
        IF p_order_id IS NOT NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % não pertence a uma comanda.', p_action_type;
        END IF;
        IF p_action_type IN ('KIOSK_EXIT', 'KEG_CHANGED') AND COALESCE(p_amount_impact, 0) <> 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % não mexe em valor.', p_action_type;
        END IF;
        -- Caixa: a autorização é presa ao movimento (sangria) ou ao fechamento.
        IF p_action_type = 'CASH_WITHDRAWAL' AND ((p_metadata->>'movement_id') IS NULL OR (p_metadata->>'session_id') IS NULL
            OR COALESCE(p_amount_impact, 0) >= 0) THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: sangria precisa de movement_id, session_id e valor negativo.';
        END IF;
        IF p_action_type = 'CASH_CLOSE_DIFFERENCE' AND (p_metadata->>'session_id') IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: diferença no fechamento precisa do session_id.';
        END IF;
        -- Sem comanda para travar: dois reenvios juntos esperam um pelo outro por esta trava.
        PERFORM pg_advisory_xact_lock(hashtext('tchefood_authorize_manager:' || COALESCE(p_metadata->>'client_audit_id', '')));
    ELSE
        -- Trava a comanda: dois reenvios da mesma autorização chegando juntos esperam
        -- um pelo outro, e o segundo encontra o registro do primeiro (abaixo).
        PERFORM 1 FROM orders o WHERE o.id = p_order_id AND o.tenant_id = v_tenant FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: conta não pertence ao tenant.';
        END IF;
    END IF;
    SELECT * INTO v_performer FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = v_tenant AND u.active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: operador inválido.';
    END IF;
    IF p_action_type = 'KIOSK_EXIT' AND v_performer.role <> 'KIOSK' THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: só o aparelho do totem registra a saída do totem.';
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

    -- Reenvio (a resposta se perdeu na rede): a mesma autorização do aparelho já está
    -- gravada. Devolve o registro existente em vez de duplicar o valor no relatório.
    -- Só depois da conferência do PIN, que conta no bloqueio.
    IF (p_metadata->>'client_audit_id') IS NOT NULL THEN
        SELECT a.id INTO v_id FROM audit_logs a
         WHERE a.tenant_id = v_tenant AND a.order_id IS NOT DISTINCT FROM p_order_id AND a.action_type = p_action_type
           AND a.authorized_by_manager_id IS NOT NULL
           AND a.metadata->>'client_audit_id' = p_metadata->>'client_audit_id'
         ORDER BY a.server_seq
         LIMIT 1;
        IF FOUND THEN RETURN v_id; END IF;
    END IF;

    -- Cobrança incerta: o registro só vale para o pagamento do comprovante, já gravado
    -- nesta comanda (a fila sobe o pagamento antes). O NSU é o do comprovante.
    IF p_action_type = 'CHARGE_CONFIRMED_MANUALLY' THEN
        IF (p_metadata->>'payment_id') IS NULL OR COALESCE(trim(p_metadata->>'nsu'), '') = '' THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: cobrança incerta precisa do payment_id e do NSU do comprovante no metadata.';
        END IF;
        PERFORM 1 FROM payments p
         WHERE p.id = (p_metadata->>'payment_id')::uuid AND p.order_id = p_order_id AND p.tenant_id = v_tenant
           AND p.status = 'APPROVED' AND p.nsu = p_metadata->>'nsu' AND p.amount = p_amount_impact;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: o pagamento do comprovante (NSU %) não está nesta conta com este valor.', p_metadata->>'nsu';
        END IF;
    END IF;

    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, p_order_id, p_performed_by, v_manager.id, p_action_type, COALESCE(p_amount_impact, 0), trim(p_reason),
            v_meta || jsonb_build_object('manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

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
    -- Instante do preço: o relógio do servidor. O created_at/priced_at vem do aparelho e
    -- pode ser forjado (happy hour fora da janela sem PIN). Item que sobe depois da
    -- janela fica recusado e o gerente aceita com PIN (PRICE_OVERRIDE).
    v_at := NOW();

    -- Ficha Rápida (origem SMARTPOS) segue a regra de horário como a comanda: o app cobra
    -- o happy hour no balcão desde o PR #27 (createCounterSale usa effectivePrice). Antes
    -- o banco usava o preço base e, com a recusa abaixo, travaria a venda certa.
    v_prices := ARRAY[tchefood_sale_price(v_product.id, v_at)];
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
    v_legacy BOOLEAN;
    v_override audit_logs%ROWTYPE;
    v_tenant UUID;
    v_claims JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
BEGIN
    -- Reenvio da fila (upsert do mesmo item): já foi conferido na primeira vez.
    IF EXISTS (SELECT 1 FROM order_items i WHERE i.id = NEW.id) THEN
        RETURN NEW;
    END IF;
    -- Produto e conta da mesma loja de quem grava. A conferência roda antes da política de
    -- acesso (RLS) e com permissão do dono, então sem isso a mensagem de recusa mostraria o
    -- preço de outra loja. Recusa genérica, sem preço nem nome.
    SELECT o.tenant_id INTO v_tenant FROM orders o WHERE o.id = NEW.order_id;
    SELECT * INTO v_product FROM products p WHERE p.id = NEW.product_id AND p.tenant_id = v_tenant;
    IF NOT FOUND
       OR (COALESCE(v_claims->>'role', '') IN ('anon', 'authenticated') AND v_tenant IS DISTINCT FROM tchefood_tenant()) THEN
        RAISE EXCEPTION 'TCHEFOOD_PRECO: produto ou conta não encontrado nesta loja.';
    END IF;
    -- Pesado (o banco já fixa preço e quantidade) e componente de combo (preço zero, schema_combos.sql).
    IF v_product.sold_by_weight OR NEW.combo_parent_item_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_expected FROM tchefood_expected_item_price(NEW);
    IF v_expected.base IS NOT NULL
       AND v_expected.base = NEW.unit_price AND v_expected.modifiers = NEW.modifiers_unit_price THEN
        RETURN NEW;
    END IF;
    -- Item de aparelho antigo (fila gravada antes desta versão): não traz o instante do preço nem os
    -- adicionais e sabores escolhidos, então o banco não tem como refazer a conta. Registra o alerta
    -- como NÃO conferido e sem valor, em vez de um desvio que o servidor não verificou.
    v_legacy := NEW.priced_at IS NULL;
    v_impact := CASE WHEN v_legacy OR v_expected.base IS NULL THEN NULL
                     ELSE round(NEW.quantity * ((v_expected.base + v_expected.modifiers) - (NEW.unit_price + NEW.modifiers_unit_price)), 2) END;
    -- Decisão do Will (10/11/2026): item com preço diferente do cadastro, ou que o servidor
    -- não consegue conferir, só entra com PIN de gerente. A autorização (PRICE_OVERRIDE,
    -- conferida por tchefood_authorize_manager) sobe antes do item, presa ao item inteiro.
    -- Comparação em jsonb, sem conversão: o RPC já gravou os campos convertidos.
    SELECT * INTO v_override FROM audit_logs a
     WHERE a.tenant_id = v_product.tenant_id AND a.order_id = NEW.order_id AND a.action_type = 'PRICE_OVERRIDE'
       AND a.authorized_by_manager_id IS NOT NULL
       AND a.metadata->'item_id' = to_jsonb(NEW.id)
       AND a.metadata->'product_id' = to_jsonb(NEW.product_id)
       AND a.metadata->'quantity' = to_jsonb(NEW.quantity)
       AND a.metadata->'unit_price' = to_jsonb(NEW.unit_price)
       AND a.metadata->'modifiers_unit_price' = to_jsonb(NEW.modifiers_unit_price)
       AND a.metadata->'half_product_ids' = to_jsonb(COALESCE(NEW.half_product_ids, '{}'::uuid[]))
       AND a.metadata->'modifier_option_ids' = to_jsonb(COALESCE(NEW.modifier_option_ids, '{}'::uuid[]))
     ORDER BY a.server_seq
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PRECO: %', CASE
            WHEN v_legacy THEN 'item de versão antiga do app (sem o instante do preço) com preço diferente do cadastro atual. Aceite com PIN de gerente.'
            WHEN v_expected.base IS NULL THEN 'item com sabor ou adicional que o cadastro da nuvem não reconhece. Aceite com PIN de gerente.'
            ELSE format('preço do cadastro R$ %s, o aparelho mandou R$ %s. Aceite com PIN de gerente.',
                        to_char(v_expected.base + v_expected.modifiers, 'FM999999990.00'),
                        to_char(NEW.unit_price + NEW.modifiers_unit_price, 'FM999999990.00')) END;
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, whatsapp_alert_sent, metadata)
    VALUES (v_product.tenant_id, NEW.order_id, NEW.waiter_id, v_override.authorized_by_manager_id, 'PRICE_MISMATCH', COALESCE(v_impact, 0),
            CASE WHEN v_legacy THEN 'Item de versão antiga do app: sem dados para o servidor conferir o preço'
                 WHEN v_expected.base IS NULL THEN 'Item com sabor ou adicional que o cadastro da nuvem não reconhece'
                 ELSE 'Item lançado com preço diferente do cadastro da nuvem' END,
            FALSE,
            jsonb_build_object(
                'server_verified', NOT v_legacy,
                'item_id', NEW.id, 'product_id', NEW.product_id, 'product_code', v_product.code, 'quantity', NEW.quantity,
                'unit_price', NEW.unit_price, 'modifiers_unit_price', NEW.modifiers_unit_price,
                'expected_unit_price', v_expected.base, 'expected_modifiers_unit_price', v_expected.modifiers,
                'priced_at', NEW.priced_at, 'origin', NEW.origin,
                'price_override_id', v_override.id, 'override_reason', v_override.reason));
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) TO authenticated;
    END IF;
END $$;
