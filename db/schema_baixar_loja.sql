-- =============================================================================
-- Tchê Food — aparelho novo baixa a loja da nuvem
-- Aplicar depois de db/schema_combos.sql. Idempotente: pode rodar de novo.
-- Espelho TypeScript: src/lib/sync/cloudPull.ts.
--
-- O aparelho lê o cardápio, o salão, as maquininhas e as permissões direto pelas
-- tabelas (a RLS limita à loja do token). A equipe também, mas sem pin_code: o
-- token do aparelho não lê PIN (db/schema.sql).
--
-- Só que o login por PIN é feito no aparelho, então um aparelho novo precisa dos
-- PINs. tchefood_pull_staff entrega a equipe com os PINs só para um gerente ou
-- proprietário que digitou o próprio PIN, conferido no banco com o mesmo bloqueio
-- de 3 erros em 60 s (tchefood_check_pin). Quem tem só o token do aparelho não
-- consegue os PINs.
-- =============================================================================

-- Equipe da loja com os PINs. p_staff_id é quem digitou o PIN (escolhido na lista
-- da equipe que o aparelho já leu). Devolve NULL se o PIN não conferiu.
CREATE OR REPLACE FUNCTION tchefood_pull_staff(p_staff_id UUID, p_pin VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_who staff_users%ROWTYPE;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff_id AND u.tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: pessoa não encontrada nesta loja.';
    END IF;
    -- Só gerente ou proprietário baixa a equipe (o PIN tem de ser o desta pessoa).
    v_who := tchefood_check_pin(v_tenant, ARRAY[p_pin], ARRAY['MANAGER', 'OWNER']::user_role[], p_staff_id, p_staff_id, 'STAFF_PULL', 'manager');
    IF v_who.id IS NULL THEN
        RETURN NULL;
    END IF;
    -- Fica registrado quem levou os PINs para um aparelho (e quando).
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, NULL, v_who.id, v_who.id, 'STAFF_PULL', 0, 'Equipe baixada para um aparelho',
            jsonb_build_object('server_verified', TRUE, 'device_user', NULLIF(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')));
    RETURN COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
                    'id', u.id, 'tenant_id', u.tenant_id, 'name', u.name, 'role', u.role,
                    'pin_code', u.pin_code, 'active', u.active, 'created_at', u.created_at)
                  ORDER BY u.created_at, u.id)
           FROM staff_users u WHERE u.tenant_id = v_tenant),
        '[]'::jsonb);
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_pull_staff(UUID, VARCHAR) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_pull_staff(UUID, VARCHAR) TO authenticated;
    END IF;
END $$;
