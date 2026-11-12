-- =============================================================================
-- Tchê Food — PIN de gerente: tentativas simultâneas respeitam o bloqueio
-- Aplicar depois de schema_preco_gerente.sql e schema_cashback_conciliacao.sql (idempotente).
--
-- tchefood_authorize_manager (todas as autorizações com PIN de gerente: cancelamento,
-- desconto, taxa de serviço, cobrança incerta, saída do totem, barril, sangria, fechamento
-- do caixa e preço) bloqueia o PIN depois de 3 erros em 60 s, contando os
-- MANAGER_PIN_FAILED da loja. A contagem não era serializada: 20 tentativas erradas
-- chegando juntas, cada uma com a sua comanda (ou o seu client_audit_id), contavam 0
-- falhas antes de qualquer uma gravar a sua, e as 20 testavam o PIN. O mesmo defeito que
-- o PR #48 corrigiu em tchefood_reconcile_cashback.
-- Aqui a função é a mesma de schema_preco_gerente.sql, com a trava da loja
-- (pg_advisory_xact_lock na chave 'tchefood_manager_pin:' || loja) antes da contagem. A
-- chave é a mesma da conciliação do cashback, então as duas funções esperam uma pela outra.
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
    -- O gerente também troca o desconto manual por um menor (R$ 10 → R$ 5); a troca fica
    -- registrada (no #35 é ela que libera a redução no gatilho do desconto).
    -- Os dois valores precisam ser números finitos, não negativos e diferentes. NaN e
    -- Infinity passam por "< 0" e por "=" sem recusa (NaN é maior que qualquer número no
    -- PostgreSQL), então o teto finito é conferido à parte; texto que não é número recusa igual.
    IF p_action_type = 'DISCOUNT_APPLIED' THEN
        BEGIN
            v_valid := (p_metadata->>'discount_before')::numeric >= 0
                   AND (p_metadata->>'discount_before')::numeric < 1000000000
                   AND (p_metadata->>'discount_after')::numeric >= 0
                   AND (p_metadata->>'discount_after')::numeric < 1000000000
                   AND (p_metadata->>'discount_after')::numeric <> (p_metadata->>'discount_before')::numeric;
        EXCEPTION WHEN others THEN
            v_valid := FALSE;
        END;
    END IF;
    IF p_action_type = 'DISCOUNT_APPLIED' AND NOT COALESCE(v_valid, FALSE) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: desconto precisa de discount_before e discount_after (diferentes) no metadata.';
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
                   AND (v_meta->>'modifiers_unit_price') IS NOT NULL
                   -- NaN passa no cast e é "maior" que qualquer número no Postgres: recusa explícita.
                   AND (v_meta->>'quantity')::numeric <> 'NaN'::numeric
                   AND (v_meta->>'unit_price')::numeric <> 'NaN'::numeric
                   AND (v_meta->>'modifiers_unit_price')::numeric <> 'NaN'::numeric;
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

    -- Bloqueio de 3 erros em 60 s: a trava da loja (até o fim da transação) enfileira as
    -- conferências de PIN, com a mesma chave de tchefood_reconcile_cashback. Sem ela,
    -- tentativas simultâneas contavam as falhas antes de qualquer uma gravar a sua e todas
    -- testavam o PIN (a trava da comanda ou do client_audit_id não basta: cada tentativa
    -- pode vir com comanda ou id próprio).
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
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

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) TO authenticated;
    END IF;
END $$;
