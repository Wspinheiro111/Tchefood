-- =============================================================================
-- TCHÊ FOOD — schema_caixa.sql (abrir caixa, sangria, suprimento e fechamento cego)
-- Rode DEPOIS de db/schema_gerente_nuvem.sql. Idempotente.
-- Espelho TypeScript: src/types.ts (CashSession, CashMovement) e src/lib/cashRegister.ts.
--
-- Regras:
--  1. Um caixa aberto por loja (índice único parcial). Abre com o fundo de troco (>= 0).
--  2. Suprimento (dinheiro que entra) e sangria (dinheiro que sai) são movimentos
--     somente inserção, com motivo. Só entram em caixa aberto, dentro do horário dele.
--  3. Sangria exige PIN de gerente: o audit_log CASH_WITHDRAWAL, gravado antes por
--     tchefood_authorize_manager(), precisa apontar para o movimento (movement_id),
--     com o mesmo valor e o mesmo gerente. Não dá para tirar mais do que há na gaveta.
--  4. Fechamento cego: o aparelho manda só o que foi contado. O banco calcula o
--     esperado (fundo + vendas em dinheiro aprovadas no período + suprimentos −
--     sangrias) e a diferença. Diferença diferente de zero só fecha com o audit_log
--     CASH_CLOSE_DIFFERENCE do gerente para este caixa, com a mesma diferença.
--  5. Caixa fechado não muda mais. Caixa aberto só muda para fechar.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cash_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    opened_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    opening_float NUMERIC(10,2) NOT NULL CHECK (opening_float >= 0),
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    closed_by_user_id UUID REFERENCES staff_users(id),
    closed_at TIMESTAMPTZ,
    counted_cash NUMERIC(10,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
    expected_cash NUMERIC(10,2),
    difference NUMERIC(10,2),
    closing_notes TEXT,
    closing_authorized_by_manager_id UUID REFERENCES staff_users(id),
    CONSTRAINT cash_sessions_closed_fields CHECK (
        (status = 'OPEN' AND closed_at IS NULL AND counted_cash IS NULL AND closed_by_user_id IS NULL)
        OR (status = 'CLOSED' AND closed_at IS NOT NULL AND counted_cash IS NOT NULL AND closed_by_user_id IS NOT NULL AND closed_at >= opened_at)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open ON cash_sessions (tenant_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS cash_sessions_tenant_opened ON cash_sessions (tenant_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS cash_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES cash_sessions(id),
    type VARCHAR(20) NOT NULL CHECK (type IN ('SUPPLY', 'WITHDRAWAL')),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
    performed_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    authorized_by_manager_id UUID REFERENCES staff_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cash_movements_session ON cash_movements (session_id);

-- Dinheiro esperado na gaveta de um caixa até p_until (inclusive).
CREATE OR REPLACE FUNCTION tchefood_cash_expected(p_session UUID, p_until TIMESTAMPTZ)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
    SELECT s.opening_float
         + COALESCE((SELECT sum(p.amount) FROM payments p
                      WHERE p.tenant_id = s.tenant_id AND p.method = 'CASH' AND p.status = 'APPROVED'
                        AND p.created_at >= s.opened_at AND p.created_at <= p_until), 0)
         + COALESCE((SELECT sum(CASE WHEN m.type = 'SUPPLY' THEN m.amount ELSE -m.amount END)
                       FROM cash_movements m WHERE m.session_id = s.id AND m.created_at <= p_until), 0)
      FROM cash_sessions s WHERE s.id = p_session
$$;

CREATE OR REPLACE FUNCTION tchefood_cash_movement_rules()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_session cash_sessions%ROWTYPE;
    v_audit audit_logs%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: movimento de caixa é somente inserção.';
    END IF;
    -- Reenvio da fila (resposta perdida): o mesmo movimento já gravado passa e o
    -- ON CONFLICT DO NOTHING da fila o ignora, mesmo com o caixa já fechado.
    IF EXISTS (SELECT 1 FROM cash_movements m
                WHERE m.id = NEW.id AND m.tenant_id = NEW.tenant_id AND m.session_id = NEW.session_id
                  AND m.type = NEW.type AND m.amount = NEW.amount) THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_session FROM cash_sessions s WHERE s.id = NEW.session_id FOR UPDATE;
    IF NOT FOUND OR v_session.tenant_id <> NEW.tenant_id THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: caixa não encontrado nesta loja.';
    END IF;
    IF v_session.status <> 'OPEN' OR NEW.created_at < v_session.opened_at THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: movimento fora de um caixa aberto.';
    END IF;
    IF NEW.type = 'WITHDRAWAL' THEN
        IF NEW.authorized_by_manager_id IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: sangria exige PIN de gerente.';
        END IF;
        SELECT * INTO v_audit FROM audit_logs a
         WHERE a.tenant_id = NEW.tenant_id AND a.action_type = 'CASH_WITHDRAWAL'
           AND a.authorized_by_manager_id = NEW.authorized_by_manager_id
           AND a.metadata->>'movement_id' = NEW.id::text
           AND a.amount_impact = -NEW.amount
         LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: sangria sem a autorização do gerente gravada.';
        END IF;
        IF tchefood_cash_expected(NEW.session_id, NEW.created_at) < NEW.amount THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: sangria maior que o dinheiro na gaveta.';
        END IF;
    ELSIF NEW.authorized_by_manager_id IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: suprimento não leva autorização de gerente.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cash_movements_rules ON cash_movements;
CREATE TRIGGER trg_cash_movements_rules BEFORE INSERT OR UPDATE OR DELETE ON cash_movements
    FOR EACH ROW EXECUTE FUNCTION tchefood_cash_movement_rules();

CREATE OR REPLACE FUNCTION tchefood_cash_session_rules()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_audit audit_logs%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: caixa não se apaga.';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'OPEN' THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: caixa nasce aberto.';
        END IF;
        NEW.expected_cash := NULL;
        NEW.difference := NULL;
        NEW.closing_authorized_by_manager_id := NULL;
        RETURN NEW;
    END IF;
    -- Reenvio da fila (resposta perdida): repetir a abertura ou o mesmo fechamento não muda nada.
    IF NEW.tenant_id = OLD.tenant_id AND NEW.opened_by_user_id = OLD.opened_by_user_id
       AND NEW.opened_at = OLD.opened_at AND NEW.opening_float = OLD.opening_float THEN
        IF NEW.status = 'OPEN' THEN
            RETURN OLD;
        END IF;
        IF OLD.status = 'CLOSED' AND NEW.status = 'CLOSED'
           AND NEW.closed_by_user_id IS NOT DISTINCT FROM OLD.closed_by_user_id
           AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
           AND NEW.counted_cash IS NOT DISTINCT FROM OLD.counted_cash
           AND NEW.closing_notes IS NOT DISTINCT FROM OLD.closing_notes THEN
            RETURN OLD;
        END IF;
    END IF;
    IF OLD.status = 'CLOSED' THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: caixa fechado não muda mais.';
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.opened_by_user_id <> OLD.opened_by_user_id
       OR NEW.opened_at <> OLD.opened_at OR NEW.opening_float <> OLD.opening_float THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: a abertura do caixa não muda.';
    END IF;
    IF NEW.status <> 'CLOSED' THEN
        RAISE EXCEPTION 'TCHEFOOD_CAIXA: caixa aberto só muda para fechar.';
    END IF;
    -- Fechamento cego: o esperado e a diferença são do banco, nunca do aparelho.
    NEW.expected_cash := tchefood_cash_expected(NEW.id, NEW.closed_at);
    NEW.difference := NEW.counted_cash - NEW.expected_cash;
    IF NEW.difference <> 0 THEN
        SELECT * INTO v_audit FROM audit_logs a
         WHERE a.tenant_id = NEW.tenant_id AND a.action_type = 'CASH_CLOSE_DIFFERENCE'
           AND a.metadata->>'session_id' = NEW.id::text
           AND a.amount_impact = NEW.difference
           AND a.authorized_by_manager_id IS NOT NULL
         ORDER BY a.server_seq DESC
         LIMIT 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: fechamento com diferença de % exige PIN de gerente (esperado %, contado %).',
                NEW.difference, NEW.expected_cash, NEW.counted_cash;
        END IF;
        NEW.closing_authorized_by_manager_id := v_audit.authorized_by_manager_id;
    ELSE
        NEW.closing_authorized_by_manager_id := NULL;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cash_sessions_rules ON cash_sessions;
CREATE TRIGGER trg_cash_sessions_rules BEFORE INSERT OR UPDATE OR DELETE ON cash_sessions
    FOR EACH ROW EXECUTE FUNCTION tchefood_cash_session_rules();

-- A autorização de gerente ganha a sangria e a diferença no fechamento (sem comanda).
CREATE OR REPLACE FUNCTION tchefood_authorize_manager(
    p_order_id UUID,
    p_action_type VARCHAR,
    p_manager_pin VARCHAR,
    p_performed_by UUID,
    p_reason TEXT,
    p_amount_impact NUMERIC DEFAULT 0,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_manager staff_users%ROWTYPE;
    v_performer staff_users%ROWTYPE;
    v_failures INT;
    v_id UUID;
    v_without_order BOOLEAN := p_action_type IN ('KIOSK_EXIT', 'KEG_CHANGED', 'CASH_WITHDRAWAL', 'CASH_CLOSE_DIFFERENCE');
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.';
    END IF;
    IF p_action_type NOT IN ('ITEM_CANCELED', 'SERVICE_FEE_REMOVED', 'DISCOUNT_APPLIED',
                             'CHARGE_CONFIRMED_MANUALLY', 'KIOSK_EXIT', 'KEG_CHANGED',
                             'CASH_WITHDRAWAL', 'CASH_CLOSE_DIFFERENCE') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: ação % não exige autorização.', p_action_type;
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;
    IF p_action_type = 'DISCOUNT_APPLIED' AND (
        (p_metadata->>'discount_before') IS NULL OR (p_metadata->>'discount_after') IS NULL
        OR (p_metadata->>'discount_after')::numeric <= (p_metadata->>'discount_before')::numeric) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: desconto precisa de discount_before e discount_after (maior) no metadata.';
    END IF;
    IF p_action_type = 'ITEM_CANCELED' AND (p_metadata->>'item_id') IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: cancelamento precisa do item_id no metadata.';
    END IF;

    IF v_without_order THEN
        IF p_order_id IS NOT NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % não pertence a uma comanda.', p_action_type;
        END IF;
        IF p_action_type IN ('KIOSK_EXIT', 'KEG_CHANGED') AND COALESCE(p_amount_impact, 0) <> 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % não mexe em valor.', p_action_type;
        END IF;
        -- Caixa: a autorização é presa ao movimento (sangria) ou ao fechamento.
        IF p_action_type = 'CASH_WITHDRAWAL' AND ((p_metadata->>'movement_id') IS NULL OR (p_metadata->>'session_id') IS NULL
            OR COALESCE(p_amount_impact, 0) >= 0) THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: sangria precisa de movement_id, session_id e valor negativo.';
        END IF;
        IF p_action_type = 'CASH_CLOSE_DIFFERENCE' AND (p_metadata->>'session_id') IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_CAIXA: diferença no fechamento precisa do session_id.';
        END IF;
        -- Sem comanda para travar: dois reenvios juntos esperam um pelo outro por esta trava.
        PERFORM pg_advisory_xact_lock(hashtext('tchefood_authorize_manager:' || COALESCE(p_metadata->>'client_audit_id', '')));
    ELSE
        -- Trava a comanda: dois reenvios da mesma autorização chegando juntos esperam
        -- um pelo outro, e o segundo encontra o registro do primeiro (abaixo).
        PERFORM 1 FROM orders o WHERE o.id = p_order_id AND o.tenant_id = v_tenant FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: conta não pertence ao tenant.';
        END IF;
    END IF;
    SELECT * INTO v_performer FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = v_tenant AND u.active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: operador inválido.';
    END IF;
    IF p_action_type = 'KIOSK_EXIT' AND v_performer.role <> 'KIOSK' THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: só o aparelho do totem registra a saída do totem.';
    END IF;

    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= NOW() - INTERVAL '60 seconds';
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (v_tenant, p_order_id, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas', jsonb_build_object('attempted_action', p_action_type));
        RETURN NULL;
    END IF;

    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (v_tenant, p_order_id, p_performed_by, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto', jsonb_build_object('attempted_action', p_action_type));
        RETURN NULL;
    END IF;

    -- Reenvio (a resposta se perdeu na rede): a mesma autorização do aparelho já está
    -- gravada. Devolve o registro existente em vez de duplicar o valor no relatório.
    -- Só depois da conferência do PIN, que conta no bloqueio.
    IF (p_metadata->>'client_audit_id') IS NOT NULL THEN
        SELECT a.id INTO v_id FROM audit_logs a
         WHERE a.tenant_id = v_tenant AND a.order_id IS NOT DISTINCT FROM p_order_id AND a.action_type = p_action_type
           AND a.authorized_by_manager_id IS NOT NULL
           AND a.metadata->>'client_audit_id' = p_metadata->>'client_audit_id'
         ORDER BY a.server_seq
         LIMIT 1;
        IF FOUND THEN RETURN v_id; END IF;
    END IF;

    -- Cobrança incerta: o registro só vale para o pagamento do comprovante, já gravado
    -- nesta comanda (a fila sobe o pagamento antes). O NSU é o do comprovante.
    IF p_action_type = 'CHARGE_CONFIRMED_MANUALLY' THEN
        IF (p_metadata->>'payment_id') IS NULL OR COALESCE(trim(p_metadata->>'nsu'), '') = '' THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: cobrança incerta precisa do payment_id e do NSU do comprovante no metadata.';
        END IF;
        PERFORM 1 FROM payments p
         WHERE p.id = (p_metadata->>'payment_id')::uuid AND p.order_id = p_order_id AND p.tenant_id = v_tenant
           AND p.status = 'APPROVED' AND p.nsu = p_metadata->>'nsu' AND p.amount = p_amount_impact;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: o pagamento do comprovante (NSU %) não está nesta conta com este valor.', p_metadata->>'nsu';
        END IF;
    END IF;

    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, p_order_id, p_performed_by, v_manager.id, p_action_type, COALESCE(p_amount_impact, 0), trim(p_reason),
            COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_authorize_manager(UUID, VARCHAR, VARCHAR, UUID, TEXT, NUMERIC, JSONB) TO authenticated;
    END IF;
END $$;

-- RLS multi-tenant (mesmo claim de db/schema.sql)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['cash_sessions','cash_movements'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_tenant') THEN
            EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant())', t || '_tenant', t);
        END IF;
    END LOOP;
END $$;
