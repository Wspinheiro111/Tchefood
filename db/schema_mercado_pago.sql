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
--     O aparelho manda o saldo que mostrou (p_expected_balance_cents, obrigatório):
--     saldo da nuvem diferente = TF008 e nada é cobrado (sincronizar e cobrar de novo).
--     Reenvio da mesma chave devolve a cobrança já gravada, mesmo que o saldo tenha mudado.
--  6. Encerrar a pedido do operador exige PIN de gerente conferido no banco
--     (tchefood_authorize_point_cancel), com registro em audit_logs.
--  5. Cobrança em estado final não muda mais (resposta atrasada não rebaixa
--     aprovado) e aprovado exige comprovante completo.
--  7. Um pedido por vez fala com o Mercado Pago (posse do envio com prazo,
--     tchefood_claim_point_dispatch, e barreira imediatamente antes da chamada,
--     tchefood_begin_point_dispatch); depois do pedido de encerramento ninguém
--     ganha a posse nem passa da barreira. Só a criação pode fazer o PRIMEIRO
--     envio (p_allow_first); uma consulta de estado só repete envio que já saiu.
--  9. Envio sem resposta nunca vira recusa por tempo nem por PIN: vai para
--     revisão manual (tchefood_settle_point_dispatch) e segue reservando o saldo.
--  8. Chave nunca gravada só é bloqueada por operador ativo da loja, com
--     registro (tchefood_block_point_key). Não é cancelamento.
-- 10. Auditoria r5 P1-01 (decisão do Will, 14/11/2026): cobrança em revisão manual só
--     sai dela, e aprovada sem pagamento só vira estornada, com a leitura do Mercado
--     Pago feita pelo servidor (tchefood_resolve_point_charge, db/schema_point_reserva.sql,
--     com UM registro POINT_CHARGE_RESOLVED em audit_logs). O gatilho da cobrança recusa
--     essas mudanças por qualquer outro caminho. PIN de gerente e tempo não liberam: o PIN
--     só pede a conferência (tchefood_authorize_point_reconcile, com registro), e o fim
--     verificado exige esse registro na evidência.
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
    -- Hora em que o primeiro envio ao Mercado Pago começou (tchefood_begin_point_dispatch, imediatamente antes
    -- da chamada). NULL = nenhum envio saiu daqui, mesmo que alguém já tenha pedido a posse.
    dispatched_at TIMESTAMPTZ,
    -- Envio em andamento: só quem tem a posse (até dispatch_lease_until, relógio do banco) fala com o Mercado
    -- Pago; os outros pedidos só acompanham. dispatch_attempts conta as posses dadas.
    dispatch_lease_until TIMESTAMPTZ,
    dispatch_attempts INT NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
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
-- Banco que já rodou uma versão anterior deste arquivo (antes do merge): as colunas e a lista de motivos
-- que vieram depois entram aqui, para os gatilhos e funções abaixo não ficarem sem elas.
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS dispatch_lease_until TIMESTAMPTZ;
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS dispatch_attempts INT NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0);
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(20);
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS cancel_requested_by UUID REFERENCES staff_users(id);
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS cancel_authorized_by UUID REFERENCES staff_users(id);
ALTER TABLE terminal_charges ADD COLUMN IF NOT EXISTS cancel_audit_id UUID REFERENCES audit_logs(id);
ALTER TABLE terminal_charges DROP CONSTRAINT IF EXISTS terminal_charges_cancel_reason_check;
ALTER TABLE terminal_charges ADD CONSTRAINT terminal_charges_cancel_reason_check CHECK (cancel_reason IN ('timeout', 'operator', 'void'));
-- Motivo e hora do encerramento andam juntos: não existe um sem o outro.
ALTER TABLE terminal_charges DROP CONSTRAINT IF EXISTS terminal_charges_cancel_pair_check;
ALTER TABLE terminal_charges ADD CONSTRAINT terminal_charges_cancel_pair_check CHECK ((cancel_reason IS NULL) = (cancel_requested_at IS NULL));
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
-- Auditoria r5 P1-01: o fim verificado no Mercado Pago (tchefood_resolve_point_charge) é o único caminho
-- para sair da revisão manual (para aprovada, recusada, cancelada, expirada ou estornada) e para a aprovada
-- virar estornada. A função grava antes o registro POINT_CHARGE_RESOLVED e liga, só na transação dela, a
-- marca tchefood.point_resolution com o id desse registro. O gatilho só aceita a mudança se o registro
-- existe e é desta cobrança, com o mesmo "de" e "para". Revisão manual que volta para criando, na fila ou
-- na maquininha também é recusada: senão sairia dela em dois passos sem a leitura do Mercado Pago.
CREATE OR REPLACE FUNCTION tchefood_terminal_charge_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_flag TEXT;
    v_resolution BOOLEAN := FALSE;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
       AND ((OLD.status = 'manual_review' AND NEW.status IN ('approved', 'rejected', 'cancelled', 'expired', 'refunded'))
            OR (OLD.status = 'approved' AND NEW.status = 'refunded')) THEN
        v_flag := current_setting('tchefood.point_resolution', true);
        IF v_flag ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND EXISTS (SELECT 1 FROM audit_logs a
                        WHERE a.id = v_flag::uuid AND a.tenant_id = OLD.tenant_id AND a.action_type = 'POINT_CHARGE_RESOLVED'
                          AND a.metadata->>'charge_id' = OLD.id::text
                          AND a.metadata->>'from' = OLD.status AND a.metadata->>'to' = NEW.status) THEN
            v_resolution := TRUE;
        ELSE
            RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % só passa de "%" para "%" com a confirmação do Mercado Pago lida pelo servidor.',
                OLD.idempotency_key, OLD.status, NEW.status;
        END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'manual_review' AND NEW.status <> 'manual_review' AND NOT v_resolution THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % está em revisão manual e só sai dela com a confirmação do Mercado Pago lida pelo servidor.', OLD.idempotency_key;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status IN ('approved', 'rejected', 'cancelled', 'expired', 'refunded') AND NOT v_resolution THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % já está "%" e não muda mais.', OLD.idempotency_key, OLD.status;
    END IF;
    -- Aprovada que vira estornada: só o estado e o que o Mercado Pago disse mudam; o comprovante fica.
    IF v_resolution AND OLD.status = 'approved'
       AND (NEW.external_order_id IS DISTINCT FROM OLD.external_order_id OR NEW.external_payment_id IS DISTINCT FROM OLD.external_payment_id
            OR NEW.paid_amount_cents IS DISTINCT FROM OLD.paid_amount_cents OR NEW.card_brand IS DISTINCT FROM OLD.card_brand
            OR NEW.authorization_code IS DISTINCT FROM OLD.authorization_code OR NEW.last_four IS DISTINCT FROM OLD.last_four
            OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.dispatch_lease_until IS DISTINCT FROM OLD.dispatch_lease_until
            OR NEW.dispatch_attempts IS DISTINCT FROM OLD.dispatch_attempts
            OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason OR NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at
            OR NEW.cancel_requested_by IS DISTINCT FROM OLD.cancel_requested_by OR NEW.cancel_authorized_by IS DISTINCT FROM OLD.cancel_authorized_by
            OR NEW.cancel_audit_id IS DISTINCT FROM OLD.cancel_audit_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o estorno da cobrança % não muda o comprovante nem o envio.', OLD.idempotency_key;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.idempotency_key <> OLD.idempotency_key OR NEW.tenant_id <> OLD.tenant_id OR NEW.order_id <> OLD.order_id
       OR NEW.terminal_id <> OLD.terminal_id OR NEW.method <> OLD.method OR NEW.amount_cents <> OLD.amount_cents
       OR NEW.external_terminal_id <> OLD.external_terminal_id OR NEW.provider <> OLD.provider
       OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: conta, maquininha, forma, valor e operador da cobrança não mudam.';
    END IF;
    -- A hora gravada da cobrança é a base do prazo de espera: não muda.
    IF TG_OP = 'UPDATE' AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a hora da cobrança % não muda.', OLD.idempotency_key;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % já foi mandada ao Mercado Pago.', OLD.idempotency_key;
    END IF;
    -- O encerramento registrado não some nem muda (motivo, hora, quem pediu, gerente e registro); a única
    -- troca aceita é "por prazo" virar "pelo operador, com gerente", uma vez.
    IF TG_OP = 'UPDATE' AND OLD.cancel_requested_at IS NOT NULL THEN
        IF NEW.cancel_requested_at IS NULL OR NEW.cancel_reason IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o encerramento da cobrança % já foi registrado.', OLD.idempotency_key;
        END IF;
        IF NOT (OLD.cancel_reason IS NOT DISTINCT FROM 'timeout' AND NEW.cancel_reason IS NOT DISTINCT FROM 'operator')
           AND (NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
                OR NEW.cancel_requested_by IS DISTINCT FROM OLD.cancel_requested_by OR NEW.cancel_authorized_by IS DISTINCT FROM OLD.cancel_authorized_by
                OR NEW.cancel_audit_id IS DISTINCT FROM OLD.cancel_audit_id) THEN
            RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o encerramento da cobrança % já foi registrado.', OLD.idempotency_key;
        END IF;
    END IF;
    -- Pedido de encerramento: nada mais sai daqui para a maquininha. Nem primeiro envio, nem nova posse,
    -- nem posse esticada.
    IF TG_OP = 'UPDATE' AND OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL AND OLD.cancel_requested_at IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % foi encerrada antes de ir à maquininha.', OLD.idempotency_key;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.cancel_requested_at IS NOT NULL
       AND (NEW.dispatch_attempts > OLD.dispatch_attempts
            OR (NEW.dispatch_lease_until IS NOT NULL AND (OLD.dispatch_lease_until IS NULL OR NEW.dispatch_lease_until > OLD.dispatch_lease_until))) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % tem encerramento pedido e não é mais enviada.', OLD.idempotency_key;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.dispatch_attempts < OLD.dispatch_attempts THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a contagem de envios da cobrança % não volta.', OLD.idempotency_key;
    END IF;
    -- A ordem do Mercado Pago ligada à cobrança não é trocada por outra.
    IF TG_OP = 'UPDATE' AND OLD.external_order_id IS NOT NULL AND NEW.external_order_id IS DISTINCT FROM OLD.external_order_id THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % já tem ordem no Mercado Pago.', OLD.idempotency_key;
    END IF;
    IF NEW.cancel_reason = 'operator' AND (NEW.cancel_authorized_by IS NULL OR NEW.cancel_audit_id IS NULL OR NEW.cancel_requested_by IS NULL) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: encerramento pelo operador sem autorização de gerente.';
    END IF;
    IF NEW.status = 'approved' AND (NULLIF(btrim(NEW.external_payment_id), '') IS NULL OR NULLIF(btrim(NEW.authorization_code), '') IS NULL
       OR NULLIF(btrim(NEW.card_brand), '') IS NULL
       OR NEW.paid_amount_cents IS DISTINCT FROM NEW.amount_cents) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: aprovado sem comprovante completo (pagamento, autorização, bandeira e valor pago).';
    END IF;
    RETURN NEW;
END;
$$;

-- CREATE OR REPLACE: reaplicar o arquivo não deixa a tabela um instante sem o gatilho.
CREATE OR REPLACE TRIGGER trg_terminal_charges_final BEFORE INSERT OR UPDATE ON terminal_charges
    FOR EACH ROW EXECUTE FUNCTION tchefood_terminal_charge_guard();

-- -----------------------------------------------------------------------------
-- 2c. Abrir cobrança: conta aberta da loja, dentro do saldo, com a conta travada
-- -----------------------------------------------------------------------------
-- Reserva = toda outra cobrança desta conta que não terminou (criando, na fila, na maquininha ou
-- em revisão manual, sem limite de tempo) e as aprovadas que ainda não viraram pagamento aprovado
-- do Mercado Pago com a chave delas (dinheiro ou outra maquininha com a mesma chave não libera nada).
-- Só libera com o fim comprovado no Mercado Pago: recusada, cancelada, expirada ou estornada. PIN de
-- gerente e tempo passado não liberam cobrança de resultado desconhecido (ela fica em revisão manual).
-- Vale para qualquer aparelho da loja.
-- Auditoria r5 P0-01: a reserva também soma os pagamentos fora da Point já reservados no servidor e ainda
-- não registrados (payment_claims: dinheiro, outra maquininha, Pix manual). A soma é a de
-- tchefood_point_reserved_cents (db/schema_point_reserva.sql), a mesma do gatilho de payments.
-- Auditoria r4 P1-01: o saldo da conta é conferido aqui, no servidor. p_expected_balance_cents é o saldo
-- que o aparelho mostrou ao operador (obrigatório). Com a conta travada, saldo da nuvem diferente =
-- TF008 e nada é gravado: o operador sincroniza e cobra de novo. O reenvio da MESMA chave devolve a
-- cobrança já gravada sem conferir o saldo de novo (o saldo pode ter mudado de verdade depois da
-- criação, inclusive pelo pagamento desta mesma cobrança).
-- A assinatura antiga (sem o saldo) sai: ninguém abre cobrança sem mandar o saldo.
DROP FUNCTION IF EXISTS tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID);
CREATE OR REPLACE FUNCTION tchefood_open_terminal_charge(
    p_tenant UUID, p_key VARCHAR, p_order UUID, p_terminal UUID, p_external_terminal VARCHAR,
    p_method VARCHAR, p_amount_cents BIGINT, p_created_by UUID, p_expected_balance_cents BIGINT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_order orders%ROWTYPE;
    v_id UUID;
    v_reserved BIGINT;
    v_balance BIGINT;
BEGIN
    -- Sem o saldo que o aparelho mostrou não há o que conferir: recusa antes de qualquer coisa.
    IF p_expected_balance_cents IS NULL OR p_expected_balance_cents < 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o aparelho não mandou o saldo da conta. Nada foi cobrado: sincronize e cobre de novo.' USING ERRCODE = 'TF008';
    END IF;
    -- Quem cobra precisa ser da equipe ativa desta loja (sem operador identificado, não cobra).
    IF p_created_by IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_created_by AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    -- A maquininha precisa ser desta loja.
    IF NOT EXISTS (SELECT 1 FROM pos_terminals t WHERE t.id = p_terminal AND t.tenant_id = p_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: maquininha não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    SELECT id INTO v_id FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant;
    IF FOUND THEN
        RETURN v_id; -- reenvio: o chamador confere se é o mesmo pedido
    END IF;
    -- Auditoria r5 P0-01: a chave de uma reserva de pagamento fora da Point (payment_claims,
    -- db/schema_point_reserva.sql) não vira cobrança da Point. O gatilho da cobrança confere de novo na
    -- gravação, com a chave travada (duas gravações juntas da mesma chave não passam).
    IF EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = p_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a chave % já é de outro pagamento (dinheiro ou outra maquininha).', p_key USING ERRCODE = 'TF009';
    END IF;
    SELECT * INTO v_order FROM orders WHERE id = p_order AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a conta ainda não está no servidor. Aguarde a sincronização e cobre de novo.' USING ERRCODE = 'TF001';
    END IF;
    -- Dois envios da mesma chave: o segundo espera a conta e, ao entrar, a cobrança já existe.
    SELECT id INTO v_id FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant;
    IF FOUND THEN
        RETURN v_id;
    END IF;
    IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a conta já está %.', CASE v_order.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END USING ERRCODE = 'TF002';
    END IF;
    -- Saldo conferido com a conta travada: o que o operador viu é o que está na nuvem agora.
    v_balance := round(v_order.remaining_balance * 100)::BIGINT;
    IF v_balance <> p_expected_balance_cents THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a conta na nuvem tem saldo de R$ %, diferente do R$ % mostrado no aparelho. Nada foi cobrado: sincronize e cobre de novo.',
            to_char(v_balance / 100.0, 'FM999999990.00'), to_char(p_expected_balance_cents / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF008';
    END IF;
    -- Reserva única (auditoria r5 P0-01): as outras cobranças da Point que reservam E as reservas de
    -- pagamento fora da Point ainda não pagas (payment_claims), pela mesma função do gatilho de payments.
    v_reserved := tchefood_point_reserved_cents(p_tenant, p_order, NULL);
    IF p_amount_cents > v_balance - v_reserved THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: R$ % passa do saldo da conta no servidor (R$ % livre).',
            to_char(p_amount_cents / 100.0, 'FM999999990.00'), to_char(GREATEST(v_balance - v_reserved, 0) / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF003';
    END IF;
    INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, created_by)
    VALUES (p_tenant, p_key, p_order, p_terminal, 'mercado_pago_point', p_external_terminal, p_method, p_amount_cents, 'creating', p_created_by)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        -- A chave foi gravada no meio (bloqueio preventivo com outra conta, ou outra loja): devolve a desta
        -- loja para o chamador conferir; de outra loja, não devolve nada.
        SELECT id INTO v_id FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant;
        IF v_id IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_COBRANCA: chave de cobrança indisponível.' USING ERRCODE = 'TF005';
        END IF;
    END IF;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID, BIGINT) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID, BIGINT) FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID, BIGINT) FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION tchefood_open_terminal_charge(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID, BIGINT) TO service_role;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2d. Encerrar a pedido do operador: PIN de gerente conferido aqui, com audit_logs
-- -----------------------------------------------------------------------------
-- Chamada pela Edge Function (service role) antes de qualquer pedido ao Mercado Pago. Mesmas
-- regras de tchefood_authorize_manager: gerente ou dono ativo da loja, motivo com 5+ letras,
-- 3 PINs errados em 60 s bloqueiam (com a loja travada: tentativas simultâneas não passam juntas).
-- A cobrança fica travada (FOR UPDATE) da leitura à gravação, então o resultado é um destes:
--   * autorização aplicada: grava UM audit_log POINT_CHARGE_CANCELED e marca a cobrança; devolve o id;
--   * já autorizada: devolve o id do audit_log da primeira autorização, sem conferir PIN nem gravar outro;
--   * não se aplica (cobrança em estado final): TF007, sem audit_log;
--   * PIN errado ou bloqueado: NULL (a falha fica em audit_logs).
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
    v_rows INT;
BEGIN
    SELECT * INTO v_charge FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: motivo obrigatório (mínimo 5 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF v_charge.status IN ('approved', 'rejected', 'cancelled', 'expired', 'refunded') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança já está "%"; não há o que encerrar.', v_charge.status USING ERRCODE = 'TF007';
    END IF;
    IF v_charge.cancel_reason = 'operator' AND v_charge.cancel_audit_id IS NOT NULL THEN
        RETURN v_charge.cancel_audit_id; -- mesma intenção, repetida: vale a primeira autorização
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
       SET cancel_reason = 'operator', cancel_requested_by = p_performed_by, cancel_requested_at = clock_timestamp(),
           cancel_authorized_by = v_manager.id, cancel_audit_id = v_id, updated_at = NOW()
     WHERE id = v_charge.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        -- Desfaz o audit_log junto: não fica registro de encerramento que não marcou a cobrança.
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o encerramento não foi gravado na cobrança.' USING ERRCODE = 'TF007';
    END IF;
    RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2d'. Pedir a conferência no Mercado Pago (auditoria r5 P1-01): PIN de gerente, sem liberar nada
-- -----------------------------------------------------------------------------
-- Decisão do Will (14/11/2026): PIN de gerente + motivo só PEDEM a conferência e ficam registrados; nunca
-- liberam a cobrança sozinhos. Chamada pela Edge Function (service role) antes de ler o Mercado Pago (ação
-- reconcile). Mesmas regras de PIN de tchefood_authorize_point_cancel (gerente ou dono ativo da loja,
-- 3 PINs errados em 60 s bloqueiam, com a loja travada) e motivo com 10+ letras. Não muda a cobrança: grava
-- UM audit_log POINT_CHARGE_RECONCILE_AUTHORIZED e devolve o id dele, que o fim verificado
-- (tchefood_resolve_point_charge) exige na evidência e aceita uma vez só.
--   * cobrança não encontrada nesta loja: TF005; operador fora da equipe ativa: TF004; motivo curto: TF006;
--   * cobrança que não está em revisão manual nem aprovada: TF007, sem audit_log;
--   * PIN errado ou bloqueado: NULL (a falha fica em audit_logs e conta no bloqueio).
CREATE OR REPLACE FUNCTION tchefood_authorize_point_reconcile(
    p_tenant UUID, p_key VARCHAR, p_staff UUID, p_manager_pin VARCHAR, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_order UUID;
    v_failures INT;
    v_id UUID;
BEGIN
    SELECT * INTO v_charge FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: motivo obrigatório (mínimo 10 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF v_charge.status NOT IN ('manual_review', 'approved') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança está "%"; não há o que conferir.', v_charge.status USING ERRCODE = 'TF007';
    END IF;
    SELECT o.id INTO v_order FROM orders o WHERE o.id = v_charge.order_id AND o.tenant_id = p_tenant;
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || p_tenant::text));
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = p_tenant AND a.action_type = 'MANAGER_PIN_FAILED' AND a.created_at >= NOW() - INTERVAL '60 seconds';
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (p_tenant, v_order, p_staff, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', 'POINT_CHARGE_RECONCILE_AUTHORIZED', 'idempotency_key', p_key));
        RETURN NULL;
    END IF;
    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = p_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (p_tenant, v_order, p_staff, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', 'POINT_CHARGE_RECONCILE_AUTHORIZED', 'idempotency_key', p_key));
        RETURN NULL;
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (p_tenant, v_order, p_staff, v_manager.id, 'POINT_CHARGE_RECONCILE_AUTHORIZED', 0, trim(p_reason),
            jsonb_build_object('idempotency_key', p_key, 'charge_id', v_charge.id, 'charge_status', v_charge.status,
                               'manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2e. Posse do envio: um pedido por vez fala com o Mercado Pago
-- -----------------------------------------------------------------------------
-- Três passos, todos com o relógio do banco e um UPDATE só cada (pedidos simultâneos não passam juntos):
-- A hora é clock_timestamp() (a de agora), não NOW() (a do início da transação): quem esperou a trava da
-- linha decide com a hora de depois da espera.
--   1. tchefood_claim_point_dispatch: pede a posse. Só para cobrança "creating", sem ordem, sem pedido de
--      encerramento, sem outra posse em vigor e até 8 posses. Devolve o número da posse ou 0.
--   2. tchefood_begin_point_dispatch: a barreira IMEDIATAMENTE antes da chamada ao Mercado Pago. Só passa se
--      a posse ainda for a do chamador, estiver em vigor e não houver pedido de encerramento; marca o
--      primeiro envio (dispatched_at) e renova a posse a partir de agora. Devolve 1 (primeiro envio: nada
--      saiu antes), 2 (repetição) ou 0 (não mande).
--      Auditoria r4 P1-02: p_allow_first (obrigatório) diz se o chamador pode fazer o PRIMEIRO envio. Só a
--      criação da cobrança pode (true); a consulta de estado manda false e, com nada enviado ainda
--      (dispatched_at NULL), recebe 0 sem nada mudar (nem hora do envio, nem posse). Repetição de um envio
--      que já saiu continua valendo para os dois.
--   3. tchefood_settle_point_dispatch: encerramento pedido, envio já saiu, posse vencida e nenhuma ordem:
--      resultado desconhecido vira revisão manual (segue reservando o saldo). Nunca vira recusa.
CREATE OR REPLACE FUNCTION tchefood_claim_point_dispatch(p_tenant UUID, p_id UUID, p_lease_ms INT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
BEGIN
    IF p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 600000 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: prazo de posse inválido.';
    END IF;
    -- Trava a linha primeiro: a conferência e o prazo da posse usam a hora de depois da espera.
    SELECT * INTO v_charge FROM terminal_charges WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND OR v_charge.status <> 'creating' OR v_charge.external_order_id IS NOT NULL OR v_charge.cancel_requested_at IS NOT NULL
       OR (v_charge.dispatch_lease_until IS NOT NULL AND v_charge.dispatch_lease_until > clock_timestamp())
       OR v_charge.dispatch_attempts >= 8 THEN
        RETURN 0;
    END IF;
    UPDATE terminal_charges
       SET dispatch_lease_until = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0),
           dispatch_attempts = dispatch_attempts + 1, updated_at = clock_timestamp()
     WHERE id = v_charge.id;
    RETURN v_charge.dispatch_attempts + 1;
END;
$$;

-- A assinatura antiga (sem p_allow_first) sai: nenhum chamador marca o primeiro envio sem dizer que pode.
DROP FUNCTION IF EXISTS tchefood_begin_point_dispatch(UUID, UUID, INT, INT);
CREATE OR REPLACE FUNCTION tchefood_begin_point_dispatch(p_tenant UUID, p_id UUID, p_attempt INT, p_lease_ms INT, p_allow_first BOOLEAN)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
BEGIN
    IF p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 600000 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: prazo de posse inválido.';
    END IF;
    IF p_allow_first IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a barreira do envio precisa saber se pode fazer o primeiro envio.';
    END IF;
    SELECT * INTO v_charge FROM terminal_charges WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND OR v_charge.status <> 'creating' OR v_charge.external_order_id IS NOT NULL OR v_charge.cancel_requested_at IS NOT NULL
       OR v_charge.dispatch_attempts IS DISTINCT FROM p_attempt OR v_charge.dispatch_lease_until IS NULL OR v_charge.dispatch_lease_until <= clock_timestamp() THEN
        RETURN 0;
    END IF;
    -- Consulta de estado nunca começa o primeiro envio: sem nada enviado, não manda e não grava nada.
    IF v_charge.dispatched_at IS NULL AND NOT p_allow_first THEN
        RETURN 0;
    END IF;
    UPDATE terminal_charges
       SET dispatched_at = COALESCE(dispatched_at, clock_timestamp()),
           dispatch_lease_until = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0), updated_at = clock_timestamp()
     WHERE id = v_charge.id;
    RETURN CASE WHEN v_charge.dispatched_at IS NULL THEN 1 ELSE 2 END;
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_settle_point_dispatch(p_tenant UUID, p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_rows INT;
BEGIN
    UPDATE terminal_charges
       SET status = 'manual_review', raw_status = 'dispatch_unknown', raw_status_detail = 'DISPATCH_UNKNOWN', updated_at = clock_timestamp()
     WHERE id = p_id AND tenant_id = p_tenant AND status = 'creating' AND external_order_id IS NULL
       AND cancel_requested_at IS NOT NULL AND dispatched_at IS NOT NULL
       AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= clock_timestamp());
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END;
$$;

-- Encerramento por prazo: quem decide é o relógio do banco, contra a hora gravada da cobrança (também do
-- banco). Um UPDATE só, com a linha travada: dois pedidos juntos gravam um encerramento.
-- Devolve 0 (cedo demais, nada gravado), 1 (pedido gravado agora) ou 2 (já havia pedido, ou a cobrança
-- já terminou: nada a gravar).
CREATE OR REPLACE FUNCTION tchefood_request_point_timeout(p_tenant UUID, p_id UUID, p_wait_ms INT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
BEGIN
    IF p_wait_ms IS NULL OR p_wait_ms < 60000 OR p_wait_ms > 3600000 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: prazo de espera inválido.';
    END IF;
    SELECT * INTO v_charge FROM terminal_charges WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF v_charge.status IN ('approved', 'rejected', 'cancelled', 'expired', 'refunded') OR v_charge.cancel_requested_at IS NOT NULL THEN
        RETURN 2;
    END IF;
    IF clock_timestamp() < v_charge.created_at + make_interval(secs => p_wait_ms / 1000.0) THEN
        RETURN 0;
    END IF;
    UPDATE terminal_charges
       SET cancel_reason = 'timeout', cancel_requested_by = NULL, cancel_requested_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = v_charge.id;
    RETURN 1;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2f. Bloqueio preventivo da chave que nunca foi gravada (não é cancelamento)
-- -----------------------------------------------------------------------------
-- Depois de uma criação sem resposta, o aparelho precisa de prova de que nada vai à maquininha. Sem
-- cobrança gravada não há o que cancelar nem prazo a conferir: grava-se o bloqueio da chave, e uma criação
-- atrasada com a mesma chave encontra a cobrança encerrada. Exige operador da equipe ativa da loja e deixa
-- registro em audit_logs (POINT_KEY_BLOCKED). Chave já gravada: devolve a cobrança que ficou, sem mexer.
CREATE OR REPLACE FUNCTION tchefood_block_point_key(
    p_tenant UUID, p_key VARCHAR, p_order UUID, p_terminal UUID, p_external_terminal VARCHAR,
    p_method VARCHAR, p_amount_cents BIGINT, p_requested_by UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id UUID;
    v_order UUID;
BEGIN
    IF p_requested_by IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_requested_by AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pos_terminals t WHERE t.id = p_terminal AND t.tenant_id = p_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: maquininha não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    -- Mesma ordem de travas de tchefood_open_terminal_charge (conta, depois a chave): a criação e o bloqueio
    -- da mesma chave ao mesmo tempo esperam um pelo outro, sem travamento mútuo. A conta pode ainda não ter subido.
    SELECT o.id INTO v_order FROM orders o WHERE o.id = p_order AND o.tenant_id = p_tenant FOR UPDATE;
    INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents,
                                  status, raw_status, cancel_reason, cancel_requested_by, cancel_requested_at)
    VALUES (p_tenant, p_key, p_order, p_terminal, 'mercado_pago_point', p_external_terminal, p_method, p_amount_cents,
            'cancelled', 'voided_before_send', 'void', p_requested_by, NOW())
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        -- A criação gravou primeiro (ou a chave já estava bloqueada): devolve a que ficou, só desta loja.
        SELECT id INTO v_id FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant;
        IF v_id IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
        END IF;
        RETURN v_id;
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, amount_impact, reason, metadata)
    VALUES (p_tenant, v_order, p_requested_by, 'POINT_KEY_BLOCKED', 0, 'Chave bloqueada antes do envio à maquininha (nada foi cobrado)',
            jsonb_build_object('idempotency_key', p_key, 'amount_cents', p_amount_cents, 'method', p_method));
    RETURN v_id;
END;
$$;

-- Os registros da Point em audit_logs (encerramento autorizado, bloqueio de chave, fim verificado e
-- liberação de reserva) só são gravados pelas funções do servidor. O aparelho (anon/authenticated) não
-- consegue forjar um.
CREATE OR REPLACE FUNCTION tchefood_guard_point_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Auditoria r5: também o fim verificado da cobrança e a liberação da reserva de pagamento
    -- (tchefood_resolve_point_charge e tchefood_release_payment_claim*, db/schema_point_reserva.sql).
    IF NEW.action_type IN ('POINT_CHARGE_CANCELED', 'POINT_KEY_BLOCKED', 'POINT_CHARGE_RECONCILE_AUTHORIZED',
                           'POINT_CHARGE_RESOLVED', 'PAYMENT_CLAIM_RELEASED')
       AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: registro da Point só é gravado pelo servidor.';
    END IF;
    RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER trg_audit_logs_point BEFORE INSERT OR UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION tchefood_guard_point_audit();

DO $$
DECLARE
    v_fn TEXT;
BEGIN
    FOREACH v_fn IN ARRAY ARRAY[
        'tchefood_authorize_point_cancel(UUID, VARCHAR, UUID, VARCHAR, TEXT)',
        'tchefood_authorize_point_reconcile(UUID, VARCHAR, UUID, VARCHAR, TEXT)',
        'tchefood_claim_point_dispatch(UUID, UUID, INT)',
        'tchefood_begin_point_dispatch(UUID, UUID, INT, INT, BOOLEAN)',
        'tchefood_settle_point_dispatch(UUID, UUID)',
        'tchefood_request_point_timeout(UUID, UUID, INT)',
        'tchefood_block_point_key(UUID, VARCHAR, UUID, UUID, VARCHAR, VARCHAR, BIGINT, UUID)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
        END IF;
    END LOOP;
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
    -- FOR SHARE (auditoria r5 P1-01): o estorno verificado (tchefood_resolve_point_charge) trava a mesma
    -- cobrança antes de conferir que ela não tem pagamento. Pagamento e estorno juntos esperam um pelo outro:
    -- ou o pagamento entra e o estorno é recusado (TF007), ou o estorno grava e o pagamento encontra a
    -- cobrança estornada.
    SELECT * INTO v_charge FROM terminal_charges c
     WHERE c.idempotency_key = NEW.idempotency_key AND c.tenant_id = NEW.tenant_id
     FOR SHARE;
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

-- CREATE OR REPLACE: reaplicar o arquivo não deixa a tabela um instante sem o gatilho.
CREATE OR REPLACE TRIGGER trg_payments_mercado_pago BEFORE INSERT OR UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_mercado_pago_payment_guard();
