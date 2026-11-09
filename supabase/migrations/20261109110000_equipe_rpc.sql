-- Cópia de db/schema_equipe.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- TCHÊ FOOD — schema_equipe.sql (equipe, permissões e loja nova pelo servidor)
--
-- Rode DEPOIS de db/schema.sql, db/schema_expansion.sql, db/schema_kiosk.sql e
-- db/schema_purchases.sql. Idempotente (CREATE OR REPLACE / DROP ... IF EXISTS).
-- Cópia em supabase/migrations/20261109110000_equipe_rpc.sql.
--
-- Por quê: no Supabase o aparelho (papel authenticated) não lê pin_code nem grava
-- staff_users, e audit_log com gerente só nasce em função do servidor. Então o
-- cadastro de equipe, a troca de PIN/perfil/acesso, a troca de permissão e a loja
-- nova eram recusados pelo banco e travavam a fila. Estas funções conferem os PINs
-- no banco e gravam a mudança junto com o audit_log, na mesma transação.
--
-- Regras (espelho de src/lib/catalog.ts validateStaff e src/store saveStaff,
-- setRolePermission e startNewStore):
--  1. Quem faz a mudança (p_actor_id) prova que é ele com o próprio PIN
--     (p_actor_pin). Só o token do aparelho não basta para mexer em equipe.
--  2. Trocar o PIN de outra pessoa, mudar perfil, desativar ou reativar pede PIN de
--     gerente ou proprietário e motivo. Trocar só o próprio PIN não pede.
--  3. Gerente não cadastra nem altera gerente/proprietário; ninguém desativa a si
--     mesmo nem muda o próprio perfil; a loja nunca fica sem proprietário ativo
--     (as alterações de equipe de uma loja são feitas uma de cada vez).
--  4. PIN novo ou trocado: 4 dígitos, sem sequência nem dígitos repetidos, único na loja.
--     O PIN nunca vai para o audit_log. A unicidade só é conferida depois de todas
--     as regras de perfil e do PIN de gerente, e uma colisão conta no bloqueio
--     como tentativa errada (sem mensagem própria), para não virar oráculo de PIN.
--  5. Permissão por perfil: só o proprietário muda, com PIN de gerente/proprietário
--     e motivo. O aparelho não grava mais role_permissions direto.
--  6. Loja nova: só numa loja da nuvem ainda sem equipe. Cria o proprietário, o
--     usuário técnico do Cardápio QR e o audit_log STORE_RESET.
--  7. PIN errado conta no mesmo bloqueio de tchefood_authorize_manager (3 erros em
--     60 s) e fica em audit_logs; a função devolve NULL (sem RAISE, para o registro
--     da falha não ser desfeito).
--  8. Reenvio da mesma mudança (a resposta se perdeu na rede) não grava nada de
--     novo e devolve sucesso, mas só depois da prova de PIN: a comparação com o
--     PIN gravado nunca acontece antes de uma conferência que conta no bloqueio
--     (senão a função viraria um oráculo de PIN sem limite de tentativas).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Permissão por perfil (espelho de src/lib/permissions.ts DEFAULT_PERMISSIONS).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_can(p_tenant UUID, p_role user_role, p_permission app_permission)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_allowed BOOLEAN;
BEGIN
    IF p_role = 'OWNER' THEN RETURN TRUE; END IF;
    SELECT r.allowed INTO v_allowed FROM role_permissions r
     WHERE r.tenant_id = p_tenant AND r.role = p_role AND r.permission = p_permission;
    IF FOUND THEN RETURN v_allowed; END IF;
    RETURN CASE p_permission
        WHEN 'MENU_MANAGE' THEN p_role IN ('MANAGER')
        WHEN 'MENU_AVAILABILITY' THEN p_role IN ('MANAGER', 'CASHIER', 'KITCHEN')
        WHEN 'TABLES_MANAGE' THEN p_role IN ('MANAGER')
        WHEN 'STAFF_MANAGE' THEN p_role IN ('MANAGER')
        WHEN 'STORE_SETTINGS' THEN FALSE
        WHEN 'SYNC_MANAGE' THEN p_role IN ('MANAGER')
        ELSE FALSE
    END;
END;
$$;

-- -----------------------------------------------------------------------------
-- Conferência de PIN com o bloqueio de tchefood_authorize_manager.
-- Devolve a pessoa (ou NULL, gravando MANAGER_PIN_FAILED / MANAGER_PIN_LOCKOUT).
-- p_expected: quando informado, o PIN precisa ser exatamente desta pessoa.
-- p_pins: PINs aceitos como prova (um só, ou o antigo e o novo no reenvio da troca
-- do próprio PIN). Nenhum confere = uma falha no bloqueio.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS tchefood_check_pin(UUID, VARCHAR, user_role[], UUID, UUID, VARCHAR, TEXT);
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
DECLARE v_user staff_users%ROWTYPE; v_failures INT;
BEGIN
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = p_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= NOW() - INTERVAL '60 seconds';
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (p_tenant, NULL, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', p_action, 'pin_of', p_pin_of));
        RETURN NULL;
    END IF;
    SELECT * INTO v_user FROM staff_users u
     WHERE u.tenant_id = p_tenant AND u.pin_code = ANY (p_pins) AND u.active AND u.role = ANY (p_roles)
       AND (p_expected IS NULL OR u.id = p_expected);
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (p_tenant, NULL, p_performed_by, 'MANAGER_PIN_FAILED',
                CASE p_pin_of WHEN 'actor' THEN 'PIN de quem fez a alteração não confere' ELSE 'PIN de gerente incorreto' END,
                jsonb_build_object('attempted_action', p_action, 'pin_of', p_pin_of));
        RETURN NULL;
    END IF;
    RETURN v_user;
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_valid_new_pin(p_pin VARCHAR) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_pin ~ '^[0-9]{4}$'
       AND p_pin !~ '^(.)\1+$'
       AND strpos('0123456789', p_pin) = 0
       AND strpos('9876543210', p_pin) = 0
$$;

-- PIN do usuário técnico do Cardápio QR (src/data/seed.ts QR_SELF_SERVICE_PIN).
CREATE OR REPLACE FUNCTION tchefood_qr_self_service_pin() RETURNS VARCHAR
LANGUAGE sql IMMUTABLE AS $$ SELECT 'QRSELF'::varchar $$;

-- -----------------------------------------------------------------------------
-- Cadastro e alteração de equipe.
-- Devolve o id da pessoa, ou NULL se um PIN não conferiu.
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
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (v_tenant, NULL, v_actor.id, 'MANAGER_PIN_FAILED', 'PIN novo recusado pelo servidor',
                jsonb_build_object('attempted_action', v_action, 'pin_of', 'new_pin'));
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
-- Permissão por perfil. Devolve TRUE, ou NULL se um PIN não conferiu.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_set_role_permission(
    p_role user_role,
    p_permission app_permission,
    p_allowed BOOLEAN,
    p_actor_id UUID,
    p_actor_pin VARCHAR,
    p_manager_pin VARCHAR,
    p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_actor staff_users%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_before BOOLEAN;
    v_current BOOLEAN;
BEGIN
    IF v_tenant IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.'; END IF;
    IF p_role = 'OWNER' THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: o proprietário sempre tem todas as permissões.'; END IF;
    IF p_allowed IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: informe se a permissão fica ligada ou desligada.'; END IF;

    -- Reenvio: a loja já tem exatamente esta exceção gravada.
    SELECT r.allowed INTO v_current FROM role_permissions r
     WHERE r.tenant_id = v_tenant AND r.role = p_role AND r.permission = p_permission;
    IF FOUND AND v_current = p_allowed THEN RETURN TRUE; END IF;

    SELECT * INTO v_actor FROM staff_users u WHERE u.id = p_actor_id AND u.tenant_id = v_tenant AND u.active;
    IF NOT FOUND OR v_actor.role <> 'OWNER' THEN RAISE EXCEPTION 'TCHEFOOD_EQUIPE: só o proprietário muda permissões.'; END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;
    IF tchefood_check_pin(v_tenant, ARRAY[p_actor_pin], ARRAY['OWNER']::user_role[], v_actor.id, v_actor.id, 'PERMISSION_CHANGED', 'actor') IS NULL THEN
        RETURN NULL;
    END IF;
    v_manager := tchefood_check_pin(v_tenant, ARRAY[p_manager_pin], ARRAY['MANAGER', 'OWNER']::user_role[], NULL, v_actor.id, 'PERMISSION_CHANGED', 'manager');
    IF v_manager.id IS NULL THEN RETURN NULL; END IF;

    v_before := tchefood_can(v_tenant, p_role, p_permission);
    INSERT INTO role_permissions (tenant_id, role, permission, allowed, updated_at)
    VALUES (v_tenant, p_role, p_permission, p_allowed, NOW())
    ON CONFLICT (tenant_id, role, permission) DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = EXCLUDED.updated_at;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, whatsapp_alert_sent, metadata)
    VALUES (v_tenant, NULL, v_actor.id, v_manager.id, 'PERMISSION_CHANGED', 0, trim(p_reason), FALSE,
            jsonb_build_object('role', p_role, 'permission', p_permission, 'allowed_before', v_before, 'allowed_after', p_allowed,
                               'manager_name', v_manager.name, 'server_verified', true));
    RETURN TRUE;
END;
$$;

-- -----------------------------------------------------------------------------
-- Loja nova: primeiro proprietário e usuário do Cardápio QR numa loja da nuvem
-- ainda sem equipe. Devolve o id do proprietário.
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

-- -----------------------------------------------------------------------------
-- Privilégios no Supabase: o aparelho chama as funções; não grava equipe nem
-- permissões direto. As funções internas não são chamáveis pela API.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON staff_users FROM anon, authenticated;
        GRANT SELECT (id, tenant_id, name, role, active, created_at) ON staff_users TO authenticated;
        REVOKE INSERT, UPDATE, DELETE ON role_permissions FROM anon, authenticated;
        GRANT SELECT ON role_permissions TO authenticated;

        REVOKE ALL ON FUNCTION tchefood_check_pin(UUID, VARCHAR[], user_role[], UUID, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_can(UUID, user_role, app_permission) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_save_staff(UUID, TEXT, user_role, VARCHAR, BOOLEAN, UUID, VARCHAR, VARCHAR, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_save_staff(UUID, TEXT, user_role, VARCHAR, BOOLEAN, UUID, VARCHAR, VARCHAR, TEXT, TIMESTAMPTZ) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_set_role_permission(user_role, app_permission, BOOLEAN, UUID, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_set_role_permission(user_role, app_permission, BOOLEAN, UUID, VARCHAR, VARCHAR, TEXT) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_start_store(UUID, TEXT, VARCHAR, UUID, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_start_store(UUID, TEXT, VARCHAR, UUID, TEXT, JSONB, TIMESTAMPTZ) TO authenticated;
    END IF;
END $$;
