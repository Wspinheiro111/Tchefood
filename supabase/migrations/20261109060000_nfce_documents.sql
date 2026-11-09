-- ============================================================================
-- TCHÊ FOOD — DOCUMENTOS NFC-e (Focus NFe / SEFAZ-RS)
-- Usado pela Edge Function supabase/functions/emit-nfce.
-- Um documento por comanda; a referência Focus é determinística (tchefood + uuid sem hífens).
-- ============================================================================

CREATE TABLE IF NOT EXISTS nfce_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
    reference VARCHAR(120) NOT NULL UNIQUE CHECK (reference ~ '^[A-Za-z0-9]{1,120}$'),
    environment VARCHAR(12) NOT NULL CHECK (environment IN ('homologacao', 'producao')),
    status VARCHAR(12) NOT NULL CHECK (status IN ('processing', 'authorized', 'rejected', 'contingency', 'cancelled')),
    payload JSONB,
    payload_hash CHAR(64),
    access_key VARCHAR(44),
    protocol VARCHAR(80),
    number INT,
    series VARCHAR(3),
    qrcode_url TEXT,
    danfe_path TEXT,
    xml_path TEXT,
    sefaz_status VARCHAR(12),
    sefaz_message TEXT,
    offline_contingency BOOLEAN NOT NULL DEFAULT FALSE,
    transmissions INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Autorizada só com prova: chave e protocolo da SEFAZ.
    CONSTRAINT nfce_authorized_has_protocol CHECK (status <> 'authorized' OR (access_key IS NOT NULL AND protocol IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_nfce_documents_tenant_status ON nfce_documents(tenant_id, status);

-- Máquina de estados no banco (espelho de canTransition em focus.ts): nada regride de
-- autorizada, e documento fiscal nunca é apagado.
CREATE OR REPLACE FUNCTION tchefood_nfce_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: documento NFC-e % não pode ser excluído.', OLD.id;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'processing'  AND NEW.status IN ('authorized', 'rejected', 'contingency')) OR
        (OLD.status = 'rejected'    AND NEW.status IN ('processing', 'authorized', 'contingency')) OR
        (OLD.status = 'contingency' AND NEW.status IN ('processing', 'authorized', 'rejected')) OR
        (OLD.status = 'authorized'  AND NEW.status = 'cancelled')
    ) THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: transição NFC-e inválida % -> %.', OLD.status, NEW.status;
    END IF;
    IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.environment IS DISTINCT FROM OLD.environment THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: identidade do documento NFC-e é imutável.';
    END IF;
    IF OLD.status IN ('authorized', 'cancelled') AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.access_key IS DISTINCT FROM OLD.access_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: NFC-e autorizada não pode ter payload ou chave alterados.';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_nfce_guard ON nfce_documents;
CREATE TRIGGER trg_nfce_guard BEFORE UPDATE OR DELETE ON nfce_documents
    FOR EACH ROW EXECUTE FUNCTION tchefood_nfce_guard();

-- O app só lê (RLS por tenant); só a Edge Function (service role) escreve.
ALTER TABLE nfce_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nfce_documents_tenant_read ON nfce_documents;
CREATE POLICY nfce_documents_tenant_read ON nfce_documents FOR SELECT USING (tenant_id = tchefood_tenant());
