-- =============================================================================
-- Tchê Food — cardápio em realidade aumentada (3D por produto)
-- Aplicar depois de db/schema_gerente_nuvem.sql. Idempotente: pode rodar de novo.
--
--  * product_ar_models: um modelo 3D (GLB + USDZ opcional) por produto, com o fator
--    de escala para o tamanho real e as etiquetas dos itens do prato (components).
--  * ar_engagement_events: o que o cliente fez com o 3D (abriu, pôs na mesa, viu os
--    itens, pediu depois). Só INSERT: é métrica, não se edita.
--  * tchefood_ar_track(): o celular do cliente (sem login) registra pelo token do QR
--    da mesa, como o cardápio QR já identifica a mesa.
--  * Bucket público product-models no Supabase Storage: o cliente abre o 3D por link;
--    só a própria loja grava na pasta <tenant_id>/.
-- Espelhado em src/types.ts (ProductArModel, ArEngagementEvent).
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_ar_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    -- https:// (bucket ou link do dono) ou ar/… (modelo de demonstração do app).
    -- O idb:… do aparelho nunca sobe: o celular do cliente não abriria.
    glb_url TEXT NOT NULL CHECK (glb_url ~* '^(https://\S+|ar/[a-z0-9-]+\.glb)$'),
    usdz_url TEXT CHECK (usdz_url IS NULL OR usdz_url ~* '^(https://\S+|ar/[a-z0-9-]+\.usdz)$'),
    scale_factor NUMERIC(10,4) NOT NULL DEFAULT 1 CHECK (scale_factor > 0 AND scale_factor <= 1000),
    real_width_cm NUMERIC(6,1) NOT NULL CHECK (real_width_cm BETWEEN 1 AND 150),
    real_depth_cm NUMERIC(6,1) NOT NULL CHECK (real_depth_cm BETWEEN 1 AND 150),
    real_height_cm NUMERIC(6,1) NOT NULL CHECK (real_height_cm BETWEEN 0 AND 150),
    explode_animation VARCHAR(100),
    -- [{id, label, detail, position "x y z", normal "x y z"}], no máximo 12.
    components JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(components) = 'array' AND jsonb_array_length(components) <= 12),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id)
);

CREATE TABLE IF NOT EXISTS ar_engagement_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    table_id UUID REFERENCES dining_tables(id) ON DELETE SET NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('VIEW_3D','AR_START','EXPLODE','ADD_AFTER_VIEW')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ar_events_tenant_product ON ar_engagement_events (tenant_id, product_id, created_at DESC);

-- Modelo e produto da mesma loja.
CREATE OR REPLACE FUNCTION tchefood_ar_same_tenant()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_AR: produto de outra loja.';
    END IF;
    IF TG_TABLE_NAME = 'product_ar_models' THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_product_ar_models_tenant ON product_ar_models;
CREATE TRIGGER trg_product_ar_models_tenant BEFORE INSERT OR UPDATE ON product_ar_models
    FOR EACH ROW EXECUTE FUNCTION tchefood_ar_same_tenant();
DROP TRIGGER IF EXISTS trg_ar_events_tenant ON ar_engagement_events;
CREATE TRIGGER trg_ar_events_tenant BEFORE INSERT ON ar_engagement_events
    FOR EACH ROW EXECUTE FUNCTION tchefood_ar_same_tenant();

-- Métrica não se edita nem se apaga.
CREATE OR REPLACE FUNCTION tchefood_ar_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TCHEFOOD_AR: evento de engajamento não pode ser alterado.';
END;
$$;
DROP TRIGGER IF EXISTS trg_ar_events_immutable ON ar_engagement_events;
CREATE TRIGGER trg_ar_events_immutable BEFORE UPDATE OR DELETE ON ar_engagement_events
    FOR EACH ROW EXECUTE FUNCTION tchefood_ar_events_immutable();

-- RLS multi-tenant (mesmo claim de db/schema.sql)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['product_ar_models','ar_engagement_events'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_tenant') THEN
            EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant())', t || '_tenant', t);
        END IF;
    END LOOP;
END $$;

-- Celular do cliente (sem login): registra pelo token do QR da mesa.
-- Só produto ativo da mesma loja que tenha 3D ativo; devolve o id do evento ou NULL.
CREATE OR REPLACE FUNCTION tchefood_ar_track(p_qr_token VARCHAR, p_product_id UUID, p_kind VARCHAR)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_table dining_tables%ROWTYPE;
    v_id UUID;
BEGIN
    IF p_kind NOT IN ('VIEW_3D','AR_START','EXPLODE','ADD_AFTER_VIEW') THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_table FROM dining_tables WHERE qr_code_token = p_qr_token AND active;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM product_ar_models m JOIN products p ON p.id = m.product_id
        WHERE m.product_id = p_product_id AND m.tenant_id = v_table.tenant_id AND m.active AND p.active
    ) THEN
        RETURN NULL;
    END IF;
    INSERT INTO ar_engagement_events (tenant_id, product_id, table_id, kind)
    VALUES (v_table.tenant_id, p_product_id, v_table.id, p_kind)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION tchefood_ar_track(VARCHAR, UUID, VARCHAR) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT EXECUTE ON FUNCTION tchefood_ar_track(VARCHAR, UUID, VARCHAR) TO anon, authenticated;
    END IF;
END $$;

-- Supabase Storage: bucket público de leitura; gravação só na pasta da própria loja.
-- (Em Postgres sem o Supabase, como nos testes, o schema storage não existe e isto é pulado.)
DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('product-models', 'product-models', TRUE, 15728640,
            ARRAY['model/gltf-binary', 'model/vnd.usdz+zip', 'application/octet-stream'])
    ON CONFLICT (id) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'product_models_tenant_write') THEN
        EXECUTE $p$
            CREATE POLICY product_models_tenant_write ON storage.objects FOR ALL TO authenticated
            USING (bucket_id = 'product-models' AND (storage.foldername(name))[1] = tchefood_tenant()::text)
            WITH CHECK (bucket_id = 'product-models' AND (storage.foldername(name))[1] = tchefood_tenant()::text)
        $p$;
    END IF;
END $$;
