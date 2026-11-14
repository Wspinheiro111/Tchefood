-- =============================================================================
-- Tchê Food — PIN da equipe: tentativas simultâneas respeitam o bloqueio
-- Aplicar depois de schema_equipe.sql, schema_gerente_nuvem.sql e schema_baixar_loja.sql
-- (idempotente).
--
-- tchefood_check_pin confere o PIN de quem altera a equipe, do gerente nas alterações de
-- equipe e de permissão, do proprietário no reenvio da loja nova, do gerente na troca de
-- barril (tchefood_change_keg) e de quem baixa a equipe para um aparelho novo
-- (tchefood_pull_staff). Ela bloqueia o PIN depois de 3 erros em 60 s, contando os
-- MANAGER_PIN_FAILED da loja, mas a contagem não era serializada: tentativas erradas
-- chegando juntas contavam 0 falhas antes de qualquer uma gravar a sua, e todas testavam
-- o PIN. O mesmo defeito que o PR #48 corrigiu em tchefood_reconcile_cashback e o PR #50
-- corrige em tchefood_authorize_manager.
-- A correção segue a delas:
--   - trava da loja (pg_advisory_xact_lock na chave 'tchefood_manager_pin:' || loja, a
--     mesma das outras duas) antes de contar as falhas, até o fim da transação;
--   - quem trava linhas antes de conferir o PIN pega a trava do PIN primeiro:
--     tchefood_save_staff e tchefood_start_store travam a linha da loja (e a pessoa), e
--     tchefood_reconcile_cashback, com a trava do PIN, pede essas linhas pelas FKs do
--     audit_log. Na ordem antiga (loja travada, esperando a trava do PIN) as duas
--     esperavam uma pela outra. Por isso as duas funções são redefinidas aqui, iguais à
--     versão de schema_equipe.sql a não ser pela trava no começo e pelo horário da
--     falha do PIN novo repetido. tchefood_change_keg trava a torneira antes do PIN, mas
--     nenhuma função com a trava do PIN pede a torneira; tchefood_pull_staff e
--     tchefood_set_role_permission não travam linha antes do PIN;
--   - janela de 60 s pelo relógio de agora (clock_timestamp) depois da trava, e as
--     falhas e o bloqueio gravados com esse horário (NOW() é o início da transação, que
--     pode ter esperado pela trava).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Conferência de PIN com o bloqueio de 3 erros em 60 s (mesma assinatura e mesmo
-- retorno de schema_equipe.sql).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_check_pin(
    p_tenant UUID,
    p_pins VARCHAR[],
    p_roles user_role[],
    p_expected UUID,
    p_performed_by UUID,
    p_action VARCHAR,
    p_pin_of TEXT
) RETURNS staff_users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user staff_users%ROWTYPE; v_failures INT; v_checked_at TIMESTAMPTZ;
BEGIN
    -- Enfileira as conferências de PIN da loja (a mesma chave de tchefood_authorize_manager
    -- e tchefood_reconcile_cashback). A trava é da transação e reentrante: quem já a pegou
    -- (tchefood_save_staff, tchefood_start_store) não espera de novo.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || p_tenant::text));
    v_checked_at := clock_timestamp();
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = p_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= v_checked_at - INTERVAL '60 seconds' AND a.created_at <= v_checked_at;
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (p_tenant, NULL, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', p_action, 'pin_of', p_pin_of), v_checked_at);
        RETURN NULL;
    END IF;
    SELECT * INTO v_user FROM staff_users u
     WHERE u.tenant_id = p_tenant AND u.pin_code = ANY (p_pins) AND u.active AND u.role = ANY (p_roles)
       AND (p_expected IS NULL OR u.id = p_expected);
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (p_tenant, NULL, p_performed_by, 'MANAGER_PIN_FAILED',
                CASE p_pin_of WHEN 'actor' THEN 'PIN de quem fez a alteração não confere' ELSE 'PIN de gerente incorreto' END,
                jsonb_build_object('attempted_action', p_action, 'pin_of', p_pin_of), v_checked_at);
        RETURN NULL;
    END IF;
    RETURN v_user;
END;
$$;

-- -----------------------------------------------------------------------------
-- Cadastro e alteração de equipe (schema_equipe.sql), com a trava do PIN primeiro.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_save_staff(
    p_staff_id UUID,
    p_name TEXT,
    p_role user_role,
    p_pin VARCHAR,
    p_active BOOLEAN,
    p_actor_id UUID,
    p_actor_pin VARCHAR,
    p_manager_pin VARCHAR DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_created_at TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_name TEXT := trim(coalesce(p_name, ''));
    v_existing staff_users%ROWTYPE;
    v_is_new BOOLEAN;
    v_actor staff_users%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_self BOOLEAN;
    v_changes TEXT[] := ARRAY[]::TEXT[];
    v_own_pin_only BOOLEAN;
    v_reason TEXT;
    v_action TEXT;
BEGIN
    IF v_tenant IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.'; END IF;
    IF p_staff_id IS NULL OR p_role IS NULL OR p_pin IS NULL OR p_active IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_EQUIPE: cadastro incompleto.';
    END IF;

    -- Trava do PIN da loja ANTES da trava da loja e da pessoa (abaixo): é a mesma ordem de
    -- tchefood_reconcile_cashback, que tem a trava do PIN e, ao gravar o audit_log, pede a
    -- linha da loja e a do operador pelas FKs. Na ordem inversa (loja travada, esperando a
    -- trava do PIN em tchefood_check_pin) as duas esperavam uma pela outra.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
    -- Uma alteração de equipe por vez na loja: sem isso, dois aparelhos rebaixando
    -- cada um um proprietário diferente passariam juntos pela regra do último
    -- proprietário ativo (cada um trava só a própria linha e vê o outro ativo).
    PERFORM 1 FROM tenants WHERE id = v_tenant FOR UPDATE;
    SELECT * INTO v_existing FROM staff_users WHERE id = p_staff_id FOR UPDATE;
    v_is_new := NOT FOUND;
    IF NOT v_is_new AND v_existing.tenant_id <> v_tenant THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: pessoa não pertence a esta loja.';
    END IF;
    SELECT * INTO v_actor FROM staff_users u WHERE u.id = p_actor_id AND u.tenant_id = v_tenant AND u.active;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: operador inválido.'; END IF;

    IF NOT v_is_new THEN
        IF v_existing.pin_code IS DISTINCT FROM p_pin THEN v_changes := array_append(v_changes, 'STAFF_PIN_CHANGED'); END IF;
        IF v_existing.role IS DISTINCT FROM p_role THEN v_changes := array_append(v_changes, 'STAFF_ROLE_CHANGED'); END IF;
        IF v_existing.active AND NOT p_active THEN v_changes := array_append(v_changes, 'STAFF_DEACTIVATED'); END IF;
        IF NOT v_existing.active AND p_active THEN v_changes := array_append(v_changes, 'STAFF_REACTIVATED'); END IF;
    END IF;
    v_action := CASE WHEN v_is_new THEN 'STAFF_CREATED' WHEN cardinality(v_changes) > 0 THEN v_changes[1] ELSE 'STAFF_UPDATED' END;

    -- 1) Quem altera prova que é ele. No reenvio da troca do próprio PIN, o PIN
    --    gravado já é o novo (p_pin), então ele também vale como prova.
    IF tchefood_check_pin(v_tenant,
                          CASE WHEN p_actor_id = p_staff_id THEN ARRAY[p_actor_pin, p_pin] ELSE ARRAY[p_actor_pin] END,
                          enum_range(NULL::user_role), v_actor.id, v_actor.id, v_action, 'actor') IS NULL THEN
        RETURN NULL;
    END IF;
    -- Reenvio: a mudança já está gravada (só depois da prova acima).
    IF NOT v_is_new AND v_existing.name = v_name AND v_existing.role = p_role
       AND v_existing.pin_code = p_pin AND v_existing.active = p_active THEN
        RETURN v_existing.id;
    END IF;
    IF NOT tchefood_can(v_tenant, v_actor.role, 'STAFF_MANAGE') THEN
        RAISE EXCEPTION 'TCHEFOOD_EQUIPE: sem permissão para cadastrar equipe.';
    END IF;

    -- 2) Validações do cadastro (validateStaff) e de quem pode mexer em quem.
    --    Tudo isto vem antes de olhar se o PIN novo já existe na equipe: quem não
    --    pode cadastrar aquele perfil nunca chega a perguntar ao banco por PINs.
    IF NOT v_is_new AND v_existing.pin_code = tchefood_qr_self_service_pin() THEN
        RAISE EXCEPTION 'TCHEFOOD_EQUIPE: o usuário do cardápio QR é técnico e não é editado.';
    END IF;
    IF length(v_name) < 2 OR length(v_name) > 100 THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: nome entre 2 e 100 letras.'; END IF;
    v_self := NOT v_is_new AND v_existing.id = v_actor.id;
    IF v_actor.role <> 'OWNER' AND NOT v_self THEN
        IF p_role IN ('OWNER', 'MANAGER') THEN
            RAISE EXCEPTION 'TCHEFOOD_EQUIPE: só o proprietário cadastra gerentes e proprietários.';
        END IF;
        IF NOT v_is_new AND v_existing.role IN ('OWNER', 'MANAGER') THEN
            RAISE EXCEPTION 'TCHEFOOD_EQUIPE: só o proprietário altera gerentes e proprietários.';
        END IF;
    END IF;
    IF v_self THEN
        IF NOT p_active THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: você não pode desativar o próprio acesso.'; END IF;
        IF p_role <> v_existing.role THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: você não pode mudar o próprio perfil.'; END IF;
    END IF;
    IF NOT v_is_new AND v_existing.role = 'OWNER' AND v_existing.active AND (p_role <> 'OWNER' OR NOT p_active)
       AND NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.tenant_id = v_tenant AND u.role = 'OWNER' AND u.active AND u.id <> v_existing.id) THEN
        RAISE EXCEPTION 'TCHEFOOD_EQUIPE: a loja precisa de ao menos um proprietário ativo.';
    END IF;
    IF (v_is_new OR v_existing.pin_code <> p_pin) AND NOT tchefood_valid_new_pin(p_pin) THEN
        RAISE EXCEPTION 'TCHEFOOD_EQUIPE: PIN deve ter 4 dígitos, sem sequência nem dígitos repetidos.';
    END IF;

    -- 3) PIN de gerente para o que não é só o próprio PIN.
    v_own_pin_only := v_self AND v_changes = ARRAY['STAFF_PIN_CHANGED'];
    IF cardinality(v_changes) > 0 AND NOT v_own_pin_only THEN
        IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
        END IF;
        v_manager := tchefood_check_pin(v_tenant, ARRAY[p_manager_pin], ARRAY['MANAGER', 'OWNER']::user_role[], NULL, v_actor.id, v_action, 'manager');
        IF v_manager.id IS NULL THEN RETURN NULL; END IF;
        v_reason := trim(p_reason);
    ELSIF v_own_pin_only THEN
        v_reason := 'Troca do próprio PIN.';
    ELSIF v_is_new THEN
        v_reason := format('Cadastro de %s como %s.', v_name, p_role);
    ELSE
        v_reason := 'Cadastro atualizado.';
    END IF;

    -- 4) PIN novo repetido. Saber que um PIN "já existe" ajuda a adivinhar o PIN
    --    de outra pessoa, então a colisão conta no bloqueio como uma tentativa
    --    errada (MANAGER_PIN_FAILED, que fica gravado: NULL em vez de erro) e não
    --    tem mensagem própria. O app já recusa PIN repetido antes de enfileirar;
    --    aqui só chega por corrida entre aparelhos ou requisição forjada.
    IF EXISTS (SELECT 1 FROM staff_users u WHERE u.tenant_id = v_tenant AND u.pin_code = p_pin AND u.id <> p_staff_id) THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, NULL, v_actor.id, 'MANAGER_PIN_FAILED', 'PIN novo recusado pelo servidor',
                jsonb_build_object('attempted_action', v_action, 'pin_of', 'new_pin'), clock_timestamp());
        RETURN NULL;
    END IF;

    IF v_is_new THEN
        INSERT INTO staff_users (id, tenant_id, name, role, pin_code, active, created_at)
        VALUES (p_staff_id, v_tenant, v_name, p_role, p_pin, p_active, COALESCE(p_created_at, NOW()));
        v_changes := ARRAY['STAFF_CREATED'];
    ELSE
        UPDATE staff_users SET name = v_name, role = p_role, pin_code = p_pin, active = p_active WHERE id = p_staff_id;
    END IF;

    -- O PIN nunca vai para o log, nem o antigo nem o novo.
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, whatsapp_alert_sent, metadata)
    SELECT v_tenant, NULL, v_actor.id, v_manager.id, c, 0, v_reason, FALSE,
           jsonb_build_object('staff_id', p_staff_id, 'staff_name', v_name,
                              'role_before', CASE WHEN v_is_new THEN NULL ELSE v_existing.role END, 'role_after', p_role,
                              'active_after', p_active, 'actor_name', v_actor.name, 'manager_name', v_manager.name,
                              'server_verified', true)
      FROM unnest(v_changes) AS c;
    RETURN p_staff_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Loja nova (schema_equipe.sql), com a trava do PIN primeiro.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_start_store(
    p_owner_id UUID,
    p_owner_name TEXT,
    p_owner_pin VARCHAR,
    p_qr_user_id UUID,
    p_reason TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_created_at TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_name TEXT := trim(coalesce(p_owner_name, ''));
    v_owner staff_users%ROWTYPE;
    v_ts TIMESTAMPTZ := COALESCE(p_created_at, NOW());
BEGIN
    IF v_tenant IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.'; END IF;
    -- Trava do PIN da loja antes da trava da linha da loja (mesma ordem de tchefood_save_staff
    -- e tchefood_reconcile_cashback): o reenvio confere o PIN em tchefood_check_pin.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
    -- Uma loja nova por vez: trava a linha da loja.
    PERFORM 1 FROM tenants WHERE id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: loja não encontrada na nuvem.'; END IF;

    -- Reenvio: o mesmo proprietário já foi criado por esta chamada. O PIN é conferido
    -- por tchefood_check_pin (conta no bloqueio), nunca comparado direto.
    SELECT * INTO v_owner FROM staff_users WHERE id = p_owner_id;
    IF FOUND THEN
        IF v_owner.tenant_id <> v_tenant OR v_owner.role <> 'OWNER'
           OR NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.tenant_id = v_tenant AND a.action_type = 'STORE_RESET' AND a.authorized_by_manager_id = p_owner_id) THEN
            RAISE EXCEPTION 'TCHEFOOD_EQUIPE: este proprietário já existe na nuvem.';
        END IF;
        IF tchefood_check_pin(v_tenant, ARRAY[p_owner_pin], ARRAY['OWNER']::user_role[], p_owner_id, p_owner_id, 'STORE_RESET', 'actor') IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN p_owner_id;
    END IF;
    IF EXISTS (SELECT 1 FROM staff_users WHERE tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_EQUIPE: a loja na nuvem já tem equipe cadastrada. Loja nova só numa conta de loja vazia.';
    END IF;
    IF length(v_name) < 2 OR length(v_name) > 100 THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: nome entre 2 e 100 letras.'; END IF;
    IF NOT tchefood_valid_new_pin(p_owner_pin) THEN
        RAISE EXCEPTION 'TCHEFOOD_EQUIPE: PIN deve ter 4 dígitos, sem sequência nem dígitos repetidos.';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;

    INSERT INTO staff_users (id, tenant_id, name, role, pin_code, active, created_at)
    VALUES (p_owner_id, v_tenant, v_name, 'OWNER', p_owner_pin, TRUE, v_ts);
    IF p_qr_user_id IS NOT NULL THEN
        INSERT INTO staff_users (id, tenant_id, name, role, pin_code, active, created_at)
        VALUES (p_qr_user_id, v_tenant, 'Autoatendimento QR Code', 'WAITER', tchefood_qr_self_service_pin(), TRUE, v_ts);
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, whatsapp_alert_sent, metadata)
    VALUES (v_tenant, NULL, p_owner_id, p_owner_id, 'STORE_RESET', 0, trim(p_reason), FALSE,
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('server_verified', true));
    RETURN p_owner_id;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_check_pin(UUID, VARCHAR[], user_role[], UUID, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_save_staff(UUID, TEXT, user_role, VARCHAR, BOOLEAN, UUID, VARCHAR, VARCHAR, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_save_staff(UUID, TEXT, user_role, VARCHAR, BOOLEAN, UUID, VARCHAR, VARCHAR, TEXT, TIMESTAMPTZ) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_start_store(UUID, TEXT, VARCHAR, UUID, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_start_store(UUID, TEXT, VARCHAR, UUID, TEXT, JSONB, TIMESTAMPTZ) TO authenticated;
    END IF;
END $$;
