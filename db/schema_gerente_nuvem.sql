-- =============================================================================
-- Tchê Food — troca de barril, saída do totem e cobrança conferida pelo gerente na nuvem
-- Aplicar depois de db/schema_autorizacao.sql (usa tchefood_check_pin de
-- db/schema_equipe.sql e audit_logs.server_seq de db/schema_expansion.sql).
-- Idempotente: pode rodar de novo.
--
-- O banco só aceita audit_log com gerente vindo de função que confere o PIN
-- (trg_audit_logs_guard). Até aqui só o cancelamento, o desconto e a remoção dos
-- 10% tinham essa função, e a fila do aparelho tinha três registros recusados:
--
--  1. Troca de barril (KEG_CHANGED): agora sobe por tchefood_change_keg(), que
--     confere o PIN, grava o barril encerrado no histórico, o audit_log e engata o
--     barril novo na mesma transação. Os números do barril encerrado (faturado,
--     desperdício, leitura) são os do servidor, não os do aparelho.
--  2. Saída do modo totem (KIOSK_EXIT): sobe por tchefood_authorize_manager(), sem
--     comanda, e só de um usuário KIOSK.
--  3. Cobrança incerta registrada pelo comprovante (CHARGE_CONFIRMED_MANUALLY):
--     sobe por tchefood_authorize_manager() e só é aceita quando o pagamento já
--     está na nuvem, aprovado, nesta comanda, com o mesmo valor e o mesmo NSU do
--     comprovante. O NSU vem do comprovante digitado; o servidor nunca cria um.
--
-- KEG_CHANGED também é aceito por tchefood_authorize_manager() (só o registro),
-- para a fila gravada antes desta versão, em que o barril já subia direto e só o
-- audit_log era recusado.
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
    v_without_order BOOLEAN := p_action_type IN ('KIOSK_EXIT', 'KEG_CHANGED');
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.';
    END IF;
    IF p_action_type NOT IN ('ITEM_CANCELED', 'SERVICE_FEE_REMOVED', 'DISCOUNT_APPLIED',
                             'CHARGE_CONFIRMED_MANUALLY', 'KIOSK_EXIT', 'KEG_CHANGED') THEN
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

    IF v_without_order THEN
        IF p_order_id IS NOT NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % não pertence a uma comanda.', p_action_type;
        END IF;
        IF COALESCE(p_amount_impact, 0) <> 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % não mexe em valor.', p_action_type;
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
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- Troca de barril vinda do aparelho. Devolve o id do barril encerrado (keg_history),
-- ou NULL se o PIN do gerente não conferir (a falha vira MANAGER_PIN_FAILED).
-- p_history_id e p_audit_id são os ids do aparelho: o reenvio devolve o já gravado.
-- p_kicked_at é a hora da troca no aparelho: os chopps lançados depois dela (que a
-- fila sobe depois) baixam do barril novo (tchefood_keg_on_item compara com tapped_at).
CREATE OR REPLACE FUNCTION tchefood_change_keg(
    p_history_id UUID,
    p_audit_id UUID,
    p_tap_id UUID,
    p_beer_name VARCHAR,
    p_capacity_ml INT,
    p_keg_cost NUMERIC,
    p_performed_by UUID,
    p_manager_pin VARCHAR,
    p_reason TEXT,
    p_kicked_at TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_tap keg_taps%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_at TIMESTAMPTZ := COALESCE(p_kicked_at, NOW());
    v_beer TEXT := trim(COALESCE(p_beer_name, ''));
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.';
    END IF;
    IF p_history_id IS NULL OR p_audit_id IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_BARRIL: troca de barril sem os ids do aparelho.';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;
    IF length(v_beer) < 3 OR length(v_beer) > 100 THEN
        RAISE EXCEPTION 'TCHEFOOD_BARRIL: informe o chopp do barril novo.';
    END IF;
    IF p_capacity_ml IS NULL OR p_capacity_ml < 5000 OR p_capacity_ml > 100000 THEN
        RAISE EXCEPTION 'TCHEFOOD_BARRIL: capacidade entre 5 L e 100 L.';
    END IF;
    IF p_keg_cost IS NULL OR p_keg_cost < 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_BARRIL: custo inválido.';
    END IF;
    IF v_at > NOW() + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'TCHEFOOD_BARRIL: hora da troca no futuro (relógio do aparelho errado).';
    END IF;

    SELECT * INTO v_tap FROM keg_taps t WHERE t.id = p_tap_id AND t.tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_BARRIL: torneira não pertence à loja.';
    END IF;
    PERFORM 1 FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = v_tenant AND u.active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: operador inválido.';
    END IF;

    v_manager := tchefood_check_pin(v_tenant, ARRAY[p_manager_pin], ARRAY['MANAGER', 'OWNER']::user_role[], NULL,
                                    p_performed_by, 'KEG_CHANGED', 'manager');
    IF v_manager.id IS NULL THEN
        RETURN NULL;
    END IF;

    -- Reenvio: a troca já está gravada (só depois da conferência do PIN).
    PERFORM 1 FROM keg_history h WHERE h.id = p_history_id AND h.tenant_id = v_tenant AND h.tap_id = p_tap_id;
    IF FOUND THEN RETURN p_history_id; END IF;

    IF v_at < v_tap.tapped_at THEN
        RAISE EXCEPTION 'TCHEFOOD_BARRIL: o barril engatado na nuvem é mais novo que esta troca.';
    END IF;

    INSERT INTO keg_history (id, tenant_id, tap_id, tap_number, beer_name, total_capacity_ml, billed_volume_ml, wasted_foam_ml,
                             measured_remaining_ml, keg_cost, tapped_at, kicked_at, kicked_by_user_id, authorized_by_manager_id)
    VALUES (p_history_id, v_tenant, v_tap.id, v_tap.tap_number, v_tap.beer_name, v_tap.total_capacity_ml, v_tap.billed_volume_ml,
            v_tap.wasted_foam_ml, v_tap.measured_remaining_ml, v_tap.keg_cost, v_tap.tapped_at, v_at, p_performed_by, v_manager.id);

    INSERT INTO audit_logs (id, tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata, created_at)
    VALUES (p_audit_id, v_tenant, NULL, p_performed_by, v_manager.id, 'KEG_CHANGED', 0, trim(p_reason),
            jsonb_build_object('tap_number', v_tap.tap_number, 'beer_before', v_tap.beer_name, 'beer_after', v_beer,
                               'billed_ml', v_tap.billed_volume_ml, 'wasted_ml', v_tap.wasted_foam_ml,
                               'measured_remaining_ml', v_tap.measured_remaining_ml, 'keg_history_id', p_history_id,
                               'client_audit_id', p_audit_id, 'manager_name', v_manager.name, 'server_verified', true),
            v_at);

    UPDATE keg_taps SET beer_name = v_beer, total_capacity_ml = p_capacity_ml, keg_cost = round(p_keg_cost, 2),
                        billed_volume_ml = 0, wasted_foam_ml = 0, measured_remaining_ml = NULL, measured_at = NULL,
                        active = TRUE, tapped_at = v_at
     WHERE id = v_tap.id;
    RETURN p_history_id;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_change_keg(UUID, UUID, UUID, VARCHAR, INT, NUMERIC, UUID, VARCHAR, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_change_keg(UUID, UUID, UUID, VARCHAR, INT, NUMERIC, UUID, VARCHAR, TEXT, TIMESTAMPTZ) TO authenticated;
    END IF;
END $$;
