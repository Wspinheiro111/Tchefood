-- Cópia de db/schema_pin_gerente_trava.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
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
-- Aqui as duas funções conferem o PIN do mesmo jeito:
--   - trava da loja (pg_advisory_xact_lock na chave 'tchefood_manager_pin:' || loja) antes
--     de qualquer trava de linha (comanda, cliente): a mesma ordem nas duas, sem espera
--     cruzada entre a autorização numa comanda e a conciliação de uma retenção dela;
--   - janela de 60 s pelo relógio de agora (clock_timestamp) depois das travas, e as falhas
--     e o bloqueio gravados com esse horário (NOW() é o início da transação).
-- O resto de cada função é igual à versão anterior (schema_preco_gerente.sql e
-- schema_cashback_conciliacao.sql).
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
    v_checked_at TIMESTAMPTZ;
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

    -- Bloqueio de 3 erros em 60 s: a trava da loja (até o fim da transação) enfileira as
    -- conferências de PIN, com a mesma chave de tchefood_reconcile_cashback. Sem ela,
    -- tentativas simultâneas contavam as falhas antes de qualquer uma gravar a sua e todas
    -- testavam o PIN (a trava da comanda ou do client_audit_id não basta: cada tentativa
    -- pode vir com comanda ou id próprio). Vem ANTES da trava da comanda, na mesma ordem da
    -- conciliação (trava da loja, depois linhas): na ordem inversa, a conciliação de uma
    -- retenção da comanda (com a trava da loja, gravando o audit_log que aponta para a
    -- comanda) e a autorização na mesma comanda (com a comanda travada, esperando a trava da
    -- loja) esperavam uma pela outra (P1-01 da rodada 1 do GPT no PR #50).
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));

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

    -- A janela de 60 s é contada pelo relógio de agora (clock_timestamp), não pelo início da
    -- transação (NOW()): a tentativa pode ter esperado pelas travas acima. As falhas e o
    -- bloqueio são gravados com esse mesmo horário (P2-01 da rodada 1 do GPT no PR #50).
    v_checked_at := clock_timestamp();
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= v_checked_at - INTERVAL '60 seconds' AND a.created_at <= v_checked_at;
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, p_order_id, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas', jsonb_build_object('attempted_action', p_action_type), v_checked_at);
        RETURN NULL;
    END IF;

    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, p_order_id, p_performed_by, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto', jsonb_build_object('attempted_action', p_action_type), v_checked_at);
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

CREATE OR REPLACE FUNCTION tchefood_reconcile_cashback(
    p_request_id UUID, p_kind TEXT, p_customer_id UUID, p_hold_id UUID, p_decision TEXT, p_amount NUMERIC,
    p_manager_pin VARCHAR, p_performed_by UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_now TIMESTAMPTZ := tchefood_cashback_now();
    v_manager staff_users%ROWTYPE;
    v_failures INT;
    v_checked_at TIMESTAMPTZ;
    v_existing cashback_reconciliations%ROWTYPE;
    v_hold cashback_ledger%ROWTYPE;
    v_amount NUMERIC(10,2);
    v_settled UUID[] := '{}';
    v_settle_id UUID;
    v_credit_id UUID;
    v_audit_id UUID;
    v_order UUID;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_request_id IS NULL OR p_customer_id IS NULL OR p_performed_by IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: conciliação incompleta.';
    END IF;
    IF p_kind NOT IN ('HOLD', 'ORPHAN') OR p_decision NOT IN ('RELEASE', 'DISCARD') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: conciliação inválida.';
    END IF;
    IF (p_kind = 'HOLD') <> (p_hold_id IS NOT NULL) THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: devolução retida precisa do lançamento; baixa sem resgate não leva lançamento.';
    END IF;
    -- NaN passa por "> 0" no Postgres: recusa explícita, com teto finito.
    IF p_amount IS NULL OR NOT (p_amount > 0 AND p_amount < 1000000000) OR p_amount = 'NaN'::numeric OR round(p_amount, 2) <> p_amount THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: valor da conciliação inválido.';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: operador inválido.';
    END IF;

    -- PIN do gerente, com o mesmo bloqueio de tchefood_authorize_manager (3 erros em 60 s).
    -- P0-01 da rodada 1 do GPT: tentativas simultâneas contavam as falhas antes de qualquer
    -- uma gravar a sua e todas testavam o PIN. A trava da loja (até o fim da transação)
    -- enfileira as tentativas: cada uma conta as falhas já gravadas pelas anteriores.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
    -- Mesmo relógio de tchefood_authorize_manager (as duas contam as mesmas falhas): a hora
    -- de agora, depois da espera pela trava, e não o início da transação (P2-01 da rodada 1
    -- do GPT no PR #50).
    v_checked_at := clock_timestamp();
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= v_checked_at - INTERVAL '60 seconds' AND a.created_at <= v_checked_at;
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, NULL, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', 'CASHBACK_RECONCILED'), v_checked_at);
        RETURN jsonb_build_object('status', 'PIN_LOCKED');
    END IF;
    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, NULL, p_performed_by, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', 'CASHBACK_RECONCILED'), v_checked_at);
        RETURN jsonb_build_object('status', 'PIN_FAILED');
    END IF;

    -- O cliente trava aqui: o resgate (tchefood_register_cashback_redeem) trava o mesmo
    -- cliente, então a baixa sem resgate não muda entre a conferência e a decisão.
    PERFORM 1 FROM loyalty_customers c WHERE c.id = p_customer_id AND c.tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: cliente inválido.';
    END IF;

    -- Reenvio: a mesma decisão já está gravada. P2-02 da segunda auditoria da rodada 1:
    -- motivo, operador e gerente também precisam ser os mesmos; outro pedido com este id
    -- não grava nada e devolve CONFLICT com o que está gravado (a tela mostra e lê de novo).
    SELECT * INTO v_existing FROM cashback_reconciliations WHERE id = p_request_id;
    IF FOUND THEN
        IF v_existing.tenant_id <> v_tenant THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: já existe outra conciliação com este id.';
        END IF;
        IF v_existing.kind <> p_kind OR v_existing.customer_id <> p_customer_id
           OR v_existing.hold_id IS DISTINCT FROM p_hold_id OR v_existing.decision <> p_decision OR v_existing.amount <> p_amount
           OR v_existing.reason <> trim(p_reason) OR v_existing.performed_by <> p_performed_by OR v_existing.manager_id <> v_manager.id THEN
            RETURN jsonb_build_object('status', 'CONFLICT', 'reconciliation_id', v_existing.id, 'decision', v_existing.decision,
                                      'amount', v_existing.amount, 'reason', v_existing.reason);
        END IF;
        RETURN jsonb_build_object('status', 'OK', 'reconciliation_id', v_existing.id, 'amount', v_existing.amount,
                                  'credit_id', v_existing.credit_id, 'repeated', TRUE);
    END IF;

    IF p_kind = 'HOLD' THEN
        SELECT * INTO v_hold FROM cashback_ledger
         WHERE id = p_hold_id AND tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type = 'HOLD'
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: devolução retida não encontrada para este cliente nesta loja.';
        END IF;
        IF EXISTS (SELECT 1 FROM cashback_reconciliations r WHERE r.hold_id = p_hold_id) THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: esta devolução retida já foi conciliada.';
        END IF;
        v_amount := v_hold.amount;
        v_order := v_hold.order_id;
    ELSE
        v_amount := tchefood_cashback_orphan(v_tenant, p_customer_id);
        IF v_amount <= 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: este cliente não tem baixa sem resgate para conciliar.';
        END IF;
        v_settled := tchefood_cashback_pending_legacy(v_tenant, p_customer_id);
    END IF;
    IF v_amount <> p_amount THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o valor a conciliar mudou (agora R$ %). Leia as pendências de novo.', to_char(v_amount, 'FM999999990.00');
    END IF;

    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, v_order, p_performed_by, v_manager.id, 'CASHBACK_RECONCILED',
            CASE WHEN p_decision = 'RELEASE' THEN v_amount ELSE 0 END, trim(p_reason),
            jsonb_build_object('reconciliation_id', p_request_id, 'kind', p_kind, 'decision', p_decision,
                               'customer_id', p_customer_id, 'hold_id', p_hold_id, 'amount', v_amount,
                               'settled_audit_ids', to_jsonb(v_settled),
                               'manager_name', v_manager.name, 'server_verified', TRUE))
    RETURNING id INTO v_audit_id;

    IF p_kind = 'ORPHAN' THEN
        v_settle_id := gen_random_uuid();
        INSERT INTO cashback_ledger (id, tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, created_by_user_id, created_at)
        VALUES (v_settle_id, v_tenant, p_customer_id, NULL, 'SETTLE', v_amount, 0, p_performed_by, v_now);
    END IF;
    IF p_decision = 'RELEASE' THEN
        v_credit_id := gen_random_uuid();
        INSERT INTO cashback_ledger (id, tenant_id, customer_id, order_id, entry_type, amount, remaining_amount,
                                     valid_from, expires_at, created_by_user_id, created_at)
        VALUES (v_credit_id, v_tenant, p_customer_id, NULL, 'REFUND', v_amount, v_amount,
                v_now, v_now + make_interval(days => tchefood_cashback_validity_days()), p_performed_by, v_now);
    END IF;
    INSERT INTO cashback_reconciliations (id, tenant_id, customer_id, kind, hold_id, decision, amount, settle_id, credit_id,
                                          settled_audit_ids, audit_id, manager_id, performed_by, reason, created_at)
    VALUES (p_request_id, v_tenant, p_customer_id, p_kind, p_hold_id, p_decision, v_amount, v_settle_id, v_credit_id,
            v_settled, v_audit_id, v_manager.id, p_performed_by, trim(p_reason), v_now);
    PERFORM tchefood_refresh_cashback_balance(p_customer_id);
    RETURN jsonb_build_object('status', 'OK', 'reconciliation_id', p_request_id, 'amount', v_amount,
                              'credit_id', v_credit_id, 'repeated', FALSE);
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_reconcile_cashback(UUID, TEXT, UUID, UUID, TEXT, NUMERIC, VARCHAR, UUID, TEXT) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_reconcile_cashback(UUID, TEXT, UUID, UUID, TEXT, NUMERIC, VARCHAR, UUID, TEXT) TO authenticated;
    END IF;
END $$;
