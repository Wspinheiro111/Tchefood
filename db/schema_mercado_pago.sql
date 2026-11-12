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
--     Toda cobrança ainda não encerrada (inclusive revisão manual) reserva o valor.
--  6. Encerrar a pedido do operador exige PIN de gerente conferido no banco
--     (tchefood_authorize_point_cancel), com registro em audit_logs.
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
    -- Hora em que a ordem foi mandada ao Mercado Pago pela primeira vez. NULL = nunca saiu daqui.
    dispatched_at TIMESTAMPTZ,
    -- Encerramento da tentativa (não é estorno): por quê, quando e, a pedido do operador, quem pediu,
    -- o gerente que autorizou e o registro em audit_logs. "timeout" e "void" são decididos pelo servidor.
    cancel_reason VARCHAR(20) CHECK (cancel_reason IN ('timeout', 'operator', 'void')),
    cancel_requested_by UUID REFERENCES staff_users(id),
    cancel_requested_at TIMESTAMPTZ,
    cancel_authorized_by UUID REFERENCES staff_users(id),
    cancel_audit_id UUID REFERENCES audit_logs(id),
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
    IF TG_OP = 'UPDATE' AND OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % já foi mandada ao Mercado Pago.', OLD.idempotency_key;
    END IF;
    -- O encerramento registrado não muda; só "por prazo" pode virar "pelo operador, com gerente".
    IF TG_OP = 'UPDATE' AND OLD.cancel_requested_at IS NOT NULL
       AND NOT (OLD.cancel_reason = 'timeout' AND NEW.cancel_reason = 'operator')
       AND (NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason OR NEW.cancel_requested_by IS DISTINCT FROM OLD.cancel_requested_by) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o encerramento da cobrança % já foi registrado.', OLD.idempotency_key;
    END IF;
    -- Pedido de encerramento: nada mais sai daqui para a maquininha.
    IF TG_OP = 'UPDATE' AND OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL AND OLD.cancel_requested_at IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % foi encerrada antes de ir à maquininha.', OLD.idempotency_key;
    END IF;
    IF NEW.cancel_reason = 'operator' AND (NEW.cancel_authorized_by IS NULL OR NEW.cancel_audit_id IS NULL OR NEW.cancel_requested_by IS NULL) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: encerramento pelo operador sem autorização de gerente.';
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
-- Reserva = toda outra cobrança desta conta que não terminou (criando, na fila, na maquininha ou
-- em revisão manual, sem limite de tempo) e as aprovadas que ainda não viraram pagamento aprovado.
-- Só libera com o fim comprovado: recusada, cancelada, expirada ou estornada no Mercado Pago, ou
-- encerramento autorizado por gerente (audit_logs). Vale para qualquer aparelho da loja.
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
    -- Quem cobra precisa ser da equipe ativa desta loja (sem operador identificado, não cobra).
    IF p_created_by IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_created_by AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
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
       AND (c.status IN ('creating', 'pending', 'at_terminal', 'manual_review')
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
-- 2d. Encerrar a pedido do operador: PIN de gerente conferido aqui, com audit_logs
-- -----------------------------------------------------------------------------
-- Chamada pela Edge Function (service role) antes de qualquer pedido ao Mercado Pago. Mesmas
-- regras de tchefood_authorize_manager: gerente ou dono ativo da loja, motivo com 5+ letras,
-- 3 PINs errados em 60 s bloqueiam (com a loja travada: tentativas simultâneas não passam juntas).
-- Devolve o id do audit_log, ou NULL quando o PIN falha ou está bloqueado (a falha fica registrada).
CREATE OR REPLACE FUNCTION tchefood_authorize_point_cancel(
    p_tenant UUID, p_key VARCHAR, p_performed_by UUID, p_manager_pin VARCHAR, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_order UUID;
    v_failures INT;
    v_id UUID;
BEGIN
    SELECT * INTO v_charge FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: motivo obrigatório (mínimo 5 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    SELECT o.id INTO v_order FROM orders o WHERE o.id = v_charge.order_id AND o.tenant_id = p_tenant;
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || p_tenant::text));
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = p_tenant AND a.action_type = 'MANAGER_PIN_FAILED' AND a.created_at >= NOW() - INTERVAL '60 seconds';
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (p_tenant, v_order, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', 'POINT_CHARGE_CANCELED', 'idempotency_key', p_key));
        RETURN NULL;
    END IF;
    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = p_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (p_tenant, v_order, p_performed_by, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', 'POINT_CHARGE_CANCELED', 'idempotency_key', p_key));
        RETURN NULL;
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (p_tenant, v_order, p_performed_by, v_manager.id, 'POINT_CHARGE_CANCELED', v_charge.amount_cents / 100.0, trim(p_reason),
            jsonb_build_object('idempotency_key', p_key, 'charge_status', v_charge.status, 'manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_id;
    UPDATE terminal_charges
       SET cancel_reason = 'operator', cancel_requested_by = p_performed_by, cancel_requested_at = NOW(),
           cancel_authorized_by = v_manager.id, cancel_audit_id = v_id, updated_at = NOW()
     WHERE id = v_charge.id AND (cancel_requested_at IS NULL OR cancel_reason = 'timeout')
       AND status NOT IN ('approved', 'rejected', 'cancelled', 'expired', 'refunded');
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION tchefood_authorize_point_cancel(UUID, VARCHAR, UUID, VARCHAR, TEXT) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION tchefood_authorize_point_cancel(UUID, VARCHAR, UUID, VARCHAR, TEXT) FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_authorize_point_cancel(UUID, VARCHAR, UUID, VARCHAR, TEXT) FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION tchefood_authorize_point_cancel(UUID, VARCHAR, UUID, VARCHAR, TEXT) TO service_role;
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
