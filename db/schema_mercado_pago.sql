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
--  4. Cobrança nova só para conta aberta da loja e dentro do saldo do servidor,
--     com a conta travada (tchefood_open_terminal_charge, só a service role).
--  5. Cobrança em estado final não muda mais (resposta atrasada não rebaixa
--     aprovado) e aprovado exige comprovante completo.
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
    -- Encerramento da tentativa (não é estorno): quem pediu, por quê e quando.
    cancel_reason VARCHAR(20) CHECK (cancel_reason IN ('timeout', 'operator')),
    cancel_requested_by UUID REFERENCES staff_users(id),
    cancel_requested_at TIMESTAMPTZ,
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
-- 2b. Estado final não muda; aprovado só com comprovante completo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_terminal_charge_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IN ('approved', 'rejected', 'cancelled', 'expired', 'refunded') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % já está "%" e não muda mais.', OLD.idempotency_key, OLD.status;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.idempotency_key <> OLD.idempotency_key OR NEW.tenant_id <> OLD.tenant_id OR NEW.order_id <> OLD.order_id
       OR NEW.terminal_id <> OLD.terminal_id OR NEW.method <> OLD.method OR NEW.amount_cents <> OLD.amount_cents
       OR NEW.external_terminal_id <> OLD.external_terminal_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: conta, maquininha, forma e valor da cobrança não mudam.';
    END IF;
    IF NEW.status = 'approved' AND (NEW.external_payment_id IS NULL OR NEW.authorization_code IS NULL OR NEW.card_brand IS NULL
       OR NEW.paid_amount_cents IS DISTINCT FROM NEW.amount_cents) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: aprovado sem comprovante completo (pagamento, autorização, bandeira e valor pago).';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_terminal_charges_final ON terminal_charges;
CREATE TRIGGER trg_terminal_charges_final BEFORE INSERT OR UPDATE ON terminal_charges
    FOR EACH ROW EXECUTE FUNCTION tchefood_terminal_charge_guard();

-- -----------------------------------------------------------------------------
-- 2c. Abrir cobrança: conta aberta da loja, dentro do saldo, com a conta travada
-- -----------------------------------------------------------------------------
-- Reserva = outras cobranças desta conta ainda em andamento (abertas nos últimos 15 minutos)
-- ou aprovadas que ainda não viraram pagamento aprovado. Revisão manual não reserva: quem
-- confere no app do Mercado Pago decide se cobra de novo (a trava de revisão do app segura).
CREATE OR REPLACE FUNCTION tchefood_open_terminal_charge(
    p_tenant UUID, p_key VARCHAR, p_order UUID, p_terminal UUID, p_external_terminal VARCHAR,
    p_method VARCHAR, p_amount_cents BIGINT, p_created_by UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_order orders%ROWTYPE;
    v_id UUID;
    v_reserved BIGINT;
    v_balance BIGINT;
BEGIN
    SELECT id INTO v_id FROM terminal_charges WHERE idempotency_key = p_key;
    IF FOUND THEN
        RETURN v_id; -- reenvio: o chamador confere se é o mesmo pedido
    END IF;
    SELECT * INTO v_order FROM orders WHERE id = p_order AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a conta ainda não está no servidor. Aguarde a sincronização e cobre de novo.' USING ERRCODE = 'TF001';
    END IF;
    -- Dois envios da mesma chave: o segundo espera a conta e, ao entrar, a cobrança já existe.
    SELECT id INTO v_id FROM terminal_charges WHERE idempotency_key = p_key;
    IF FOUND THEN
        RETURN v_id;
    END IF;
    IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a conta já está %.', CASE v_order.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END USING ERRCODE = 'TF002';
    END IF;
    SELECT COALESCE(SUM(c.amount_cents), 0) INTO v_reserved FROM terminal_charges c
     WHERE c.tenant_id = p_tenant AND c.order_id = p_order
       AND ((c.status IN ('creating', 'pending', 'at_terminal') AND c.created_at > NOW() - INTERVAL '15 minutes')
            OR (c.status = 'approved' AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = c.idempotency_key AND p.status = 'APPROVED')));
    v_balance := round(v_order.remaining_balance * 100)::BIGINT;
    IF p_amount_cents > v_balance - v_reserved THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: R$ % passa do saldo da conta no servidor (R$ % livre).',
            to_char(p_amount_cents / 100.0, 'FM999999990.00'), to_char(GREATEST(v_balance - v_reserved, 0) / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF003';
    END IF;
    INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, created_by)
    VALUES (p_tenant, p_key, p_order, p_terminal, 'mercado_pago_point', p_external_terminal, p_method, p_amount_cents, 'creating', p_created_by)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID) FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID) FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID) TO service_role;
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
       OR v_charge.external_terminal_id IS DISTINCT FROM NEW.terminal_serial
       OR v_charge.card_brand IS DISTINCT FROM NEW.card_brand::text
       OR NEW.acquirer_cnpj IS DISTINCT FROM '10573521000191' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o pagamento não confere com a cobrança aprovada no Mercado Pago (conta, maquininha, forma, valor, bandeira, CNPJ da credenciadora ou comprovante).';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_mercado_pago ON payments;
CREATE TRIGGER trg_payments_mercado_pago BEFORE INSERT OR UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_mercado_pago_payment_guard();
