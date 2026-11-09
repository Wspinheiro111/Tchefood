-- Cópia de db/schema_autorizacao.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- Tchê Food — autorização de gerente: reenvio sem duplicar
-- Aplicar depois de db/schema_equipe.sql (usa audit_logs.server_seq, de
-- db/schema_expansion.sql). Idempotente: pode rodar de novo.
--
-- A fila do aparelho reenvia um evento quando a resposta da nuvem se perde. Para a
-- autorização de gerente (cancelamento, desconto, remoção dos 10%), o reenvio
-- chamava tchefood_authorize_manager de novo e gravava um segundo audit_log com o
-- mesmo valor. Agora a função reconhece o client_audit_id (id do registro no
-- aparelho, que a sincronização manda no metadata) e devolve o registro já gravado.
-- O PIN continua sendo conferido antes, com o mesmo bloqueio de 3 erros em 60 s.
-- O resto da função é igual ao de db/schema.sql.
-- =============================================================================

-- Busca do reenvio.
CREATE INDEX IF NOT EXISTS idx_audit_logs_client_audit_id
    ON audit_logs (order_id, (metadata->>'client_audit_id'))
    WHERE metadata ? 'client_audit_id';

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
    -- Trava a comanda: dois reenvios da mesma autorização chegando juntos esperam
    -- um pelo outro, e o segundo encontra o registro do primeiro (abaixo).
    PERFORM 1 FROM orders o WHERE o.id = p_order_id AND o.tenant_id = v_tenant FOR UPDATE;
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

    -- Reenvio (a resposta se perdeu na rede): a mesma autorização do aparelho já está
    -- gravada. Devolve o registro existente em vez de duplicar o valor no relatório.
    -- Só depois da conferência do PIN, que conta no bloqueio.
    IF (p_metadata->>'client_audit_id') IS NOT NULL THEN
        SELECT a.id INTO v_id FROM audit_logs a
         WHERE a.tenant_id = v_tenant AND a.order_id = p_order_id AND a.action_type = p_action_type
           AND a.authorized_by_manager_id IS NOT NULL
           AND a.metadata->>'client_audit_id' = p_metadata->>'client_audit_id'
         ORDER BY a.server_seq
         LIMIT 1;
        IF FOUND THEN RETURN v_id; END IF;
    END IF;

    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, p_order_id, p_performed_by, v_manager.id, p_action_type, COALESCE(p_amount_impact, 0), trim(p_reason),
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('manager_name', v_manager.name, 'server_verified', true))
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
