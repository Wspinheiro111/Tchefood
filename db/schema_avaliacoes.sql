-- =============================================================================
-- TCHÊ FOOD — schema_avaliacoes.sql (nota do cliente, 1 a 5, depois de pagar)
-- Rode DEPOIS de db/schema_entrega.sql. Idempotente.
-- Espelho TypeScript: src/types.ts (Review) e src/lib/reviews.ts.
--
-- Regras:
--  1. Uma avaliação por conta, da mesma loja, só de conta já paga (CLOSED).
--  2. Nota de 1 a 5; comentário opcional de até 280 caracteres.
--  3. Somente inserção. Reenvio da fila com os mesmos dados passa sem erro.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
    score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment VARCHAR(280),
    source VARCHAR(10) NOT NULL CHECK (source IN ('TABLE', 'COUNTER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reviews_tenant_created ON reviews (tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION tchefood_review_rules()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TCHEFOOD_AVALIACAO: avaliação é somente inserção.';
    END IF;
    -- Reenvio da fila: a mesma avaliação já gravada passa (ON CONFLICT DO NOTHING ignora).
    IF EXISTS (SELECT 1 FROM reviews r WHERE r.id = NEW.id AND r.tenant_id = NEW.tenant_id AND r.order_id = NEW.order_id AND r.score = NEW.score) THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.tenant_id = NEW.tenant_id AND o.status = 'CLOSED') THEN
        RAISE EXCEPTION 'TCHEFOOD_AVALIACAO: só conta paga desta loja recebe avaliação.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reviews_rules ON reviews;
CREATE TRIGGER trg_reviews_rules BEFORE INSERT OR UPDATE OR DELETE ON reviews
    FOR EACH ROW EXECUTE FUNCTION tchefood_review_rules();

-- RLS multi-tenant (mesmo claim de db/schema.sql)
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'reviews' AND policyname = 'reviews_tenant') THEN
        CREATE POLICY reviews_tenant ON reviews USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant());
    END IF;
END $$;
