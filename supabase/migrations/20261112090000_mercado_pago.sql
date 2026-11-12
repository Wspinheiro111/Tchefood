-- Cópia de db/schema_mercado_pago.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- TCHÊ FOOD — schema_mercado_pago.sql (cobrança na Point Smart pela nuvem)
-- Rode DEPOIS de db/schema_segredos.sql. Idempotente.
-- Espelho TypeScript: src/types.ts (AcquirerType) e supabase/functions/point-charge/charge.ts.
--
-- Fluxo: o app pede a cobrança à Edge Function point-charge. A função guarda a
-- cobrança em terminal_charges, manda a ordem para a Point Smart pela API do
-- Mercado Pago e reconsulta o resultado. Só a função (service role) escreve aqui.
--
-- Regras:
--  1. O token do Mercado Pago fica em payment_provider_secrets, sem nenhum acesso
--     para anon/authenticated (o aparelho nunca lê o token).
--  2. terminal_charges: o aparelho só lê as cobranças da própria loja.
--  3. Pagamento aprovado com acquirer MERCADO_PAGO só entra em payments se a
--     cobrança correspondente estiver aprovada em terminal_charges, com a mesma
--     loja, conta, maquininha, forma, valor e o ID do pagamento do Mercado Pago no
--     NSU. O aparelho não consegue gravar uma aprovação que o Mercado Pago não deu.
-- =============================================================================

ALTER TYPE acquirer_type ADD VALUE IF NOT EXISTS 'MERCADO_PAGO';

-- -----------------------------------------------------------------------------
-- 1. Token do Mercado Pago por loja (só a service role lê)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_provider_secrets (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider VARCHAR(30) NOT NULL CHECK (provider IN ('mercado_pago_point')),
    access_token TEXT NOT NULL CHECK (length(trim(access_token)) > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, provider)
);
ALTER TABLE payment_provider_secrets ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Cobranças enviadas à maquininha pela nuvem
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terminal_charges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Mesma chave do pagamento (payments.idempotency_key) e da ordem no Mercado Pago (X-Idempotency-Key).
    -- Até 50 caracteres: o cancelamento usa a mesma chave com o sufixo "-cancel" (limite de 64 do Mercado Pago).
    idempotency_key VARCHAR(50) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,50}$'),
    -- Sem FK: a conta pode ainda estar na fila do aparelho quando a cobrança começa.
    order_id UUID NOT NULL,
    terminal_id UUID NOT NULL REFERENCES pos_terminals(id),
    provider VARCHAR(30) NOT NULL CHECK (provider IN ('mercado_pago_point')),
    external_terminal_id VARCHAR(100) NOT NULL,
    method VARCHAR(10) NOT NULL CHECK (method IN ('CREDIT', 'DEBIT')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    status VARCHAR(20) NOT NULL CHECK (status IN ('creating', 'pending', 'at_terminal', 'approved', 'rejected',
                                                  'cancelled', 'expired', 'refunded', 'manual_review')),
    external_order_id VARCHAR(100),
    external_payment_id VARCHAR(50),
    raw_status VARCHAR(50),
    raw_status_detail VARCHAR(80),
    paid_amount_cents BIGINT,
    card_brand VARCHAR(20),
    authorization_code VARCHAR(50),
    last_four VARCHAR(4),
    created_by UUID REFERENCES staff_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_terminal_charges_order ON terminal_charges(tenant_id, order_id);
ALTER TABLE terminal_charges ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            EXECUTE format('REVOKE ALL ON payment_provider_secrets FROM %I', v_role);
            EXECUTE format('REVOKE ALL ON terminal_charges FROM %I', v_role);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT SELECT ON terminal_charges TO authenticated;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'terminal_charges' AND policyname = 'terminal_charges_tenant_read') THEN
        CREATE POLICY terminal_charges_tenant_read ON terminal_charges FOR SELECT USING (tenant_id = tchefood_tenant());
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Aprovação do Mercado Pago só com a cobrança aprovada no servidor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_mercado_pago_payment_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
BEGIN
    IF NEW.acquirer::text <> 'MERCADO_PAGO' OR NEW.status <> 'APPROVED' THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_charge FROM terminal_charges c
     WHERE c.idempotency_key = NEW.idempotency_key AND c.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: Mercado Pago aprovado sem a cobrança no servidor (chave %).', NEW.idempotency_key;
    END IF;
    IF v_charge.status <> 'approved' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a cobrança do Mercado Pago está "%" no servidor, não aprovada.', v_charge.status;
    END IF;
    IF v_charge.order_id <> NEW.order_id
       OR v_charge.terminal_id IS DISTINCT FROM NEW.terminal_id
       OR v_charge.method <> NEW.method::text
       OR v_charge.amount_cents <> round(NEW.amount * 100)
       OR v_charge.paid_amount_cents IS DISTINCT FROM v_charge.amount_cents
       OR v_charge.external_payment_id IS DISTINCT FROM NEW.nsu
       OR v_charge.authorization_code IS DISTINCT FROM NEW.authorization_code
       OR v_charge.external_terminal_id IS DISTINCT FROM NEW.terminal_serial THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o pagamento não confere com a cobrança aprovada no Mercado Pago (conta, maquininha, forma, valor ou comprovante).';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_mercado_pago ON payments;
CREATE TRIGGER trg_payments_mercado_pago BEFORE INSERT OR UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_mercado_pago_payment_guard();
