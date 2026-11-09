-- ============================================================================
-- TCHÊ FOOD — ETAPA 0: cadastros pela tela e sincronização do aparelho
--  * products.active / dining_tables.active: nada com venda é apagado, só desativado.
--  * price_schedules: preço por dia da semana e horário.
--  * role_permissions: exceções ao padrão de permissões por perfil.
--  * Hook de access token: copia app_metadata.tenant_id para o claim tenant_id,
--    que o RLS (tchefood_tenant()) já usa.
-- Espelhado em db/schema.sql, Seção 4.
-- ============================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- Código rápido único por loja (a tela já recusa duplicado; o banco garante).
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_tenant_code ON products(tenant_id, lower(code));

-- Mesa ocupada não pode ser desativada.
CREATE OR REPLACE FUNCTION tchefood_table_deactivate_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.active AND NOT NEW.active AND NEW.status <> 'FREE' THEN
        RAISE EXCEPTION 'TCHEFOOD_CADASTRO: mesa % está em uso e não pode ser desativada.', NEW.label;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dining_tables_deactivate ON dining_tables;
CREATE TRIGGER trg_dining_tables_deactivate BEFORE UPDATE OF active ON dining_tables
    FOR EACH ROW EXECUTE FUNCTION tchefood_table_deactivate_guard();

-- Produto e mesa nunca são apagados (podem estar em contas e notas fiscais).
CREATE OR REPLACE FUNCTION tchefood_block_catalog_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TCHEFOOD_CADASTRO: % não pode ser apagado; desative.', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_products_no_delete ON products;
CREATE TRIGGER trg_products_no_delete BEFORE DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION tchefood_block_catalog_delete();
DROP TRIGGER IF EXISTS trg_dining_tables_no_delete ON dining_tables;
CREATE TRIGGER trg_dining_tables_no_delete BEFORE DELETE ON dining_tables
    FOR EACH ROW EXECUTE FUNCTION tchefood_block_catalog_delete();
DROP TRIGGER IF EXISTS trg_staff_users_no_delete ON staff_users;
CREATE TRIGGER trg_staff_users_no_delete BEFORE DELETE ON staff_users
    FOR EACH ROW EXECUTE FUNCTION tchefood_block_catalog_delete();

CREATE TABLE IF NOT EXISTS price_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    name VARCHAR(60) NOT NULL,
    weekdays SMALLINT[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]),
    start_time CHAR(5) NOT NULL CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_time CHAR(5) NOT NULL CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    price NUMERIC(10,2) NOT NULL CHECK (price > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (start_time <> end_time)
);
CREATE INDEX IF NOT EXISTS idx_price_schedules_product ON price_schedules(product_id) WHERE active;

DO $$ BEGIN
    CREATE TYPE app_permission AS ENUM ('MENU_MANAGE', 'MENU_AVAILABILITY', 'TABLES_MANAGE', 'STAFF_MANAGE', 'STORE_SETTINGS', 'SYNC_MANAGE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS role_permissions (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role user_role NOT NULL CHECK (role <> 'OWNER'),
    permission app_permission NOT NULL,
    allowed BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, role, permission)
);

ALTER TABLE price_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_schedules_tenant ON price_schedules;
CREATE POLICY price_schedules_tenant ON price_schedules
    USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_permissions_tenant ON role_permissions;
CREATE POLICY role_permissions_tenant ON role_permissions
    USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant());

-- Grava pelo aparelho (upsert) exige WITH CHECK nas tabelas que só tinham USING.
DROP POLICY IF EXISTS modifier_options_tenant ON modifier_options;
CREATE POLICY modifier_options_tenant ON modifier_options
    USING (EXISTS (SELECT 1 FROM modifier_groups g WHERE g.id = group_id AND g.tenant_id = tchefood_tenant()))
    WITH CHECK (EXISTS (SELECT 1 FROM modifier_groups g WHERE g.id = group_id AND g.tenant_id = tchefood_tenant()));
DROP POLICY IF EXISTS product_modifier_groups_tenant ON product_modifier_groups;
CREATE POLICY product_modifier_groups_tenant ON product_modifier_groups
    USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.tenant_id = tchefood_tenant()))
    WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.tenant_id = tchefood_tenant()));

-- O aparelho atualiza os dados cadastrais da loja, mas nunca o token Focus nem o CSC.
CREATE OR REPLACE FUNCTION tchefood_tenant_secrets_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('request.jwt.claims', true) IS NOT NULL
       AND coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') = 'authenticated' THEN
        NEW.focus_nfe_token := OLD.focus_nfe_token;
        NEW.csc_id := OLD.csc_id;
        NEW.csc_token := OLD.csc_token;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tenants_secrets ON tenants;
CREATE TRIGGER trg_tenants_secrets BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION tchefood_tenant_secrets_guard();

-- Hook de access token do Supabase Auth: claim tenant_id = app_metadata.tenant_id.
-- Ativar em Authentication > Hooks > Customize Access Token, função public.tchefood_access_token_hook.
CREATE OR REPLACE FUNCTION public.tchefood_access_token_hook(event JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
    claims JSONB := event->'claims';
    tenant TEXT := event->'claims'->'app_metadata'->>'tenant_id';
BEGIN
    IF tenant IS NOT NULL AND tenant <> '' THEN
        claims := jsonb_set(claims, '{tenant_id}', to_jsonb(tenant));
    END IF;
    RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION public.tchefood_access_token_hook(JSONB) TO supabase_auth_admin;
        REVOKE EXECUTE ON FUNCTION public.tchefood_access_token_hook(JSONB) FROM authenticated, anon, public;
    END IF;
END $$;
