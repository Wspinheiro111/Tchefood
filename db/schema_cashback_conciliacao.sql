-- =============================================================================
-- Tchê Food — conciliação do cashback pelo gerente (decisão do Will, 12/11/2026)
-- =============================================================================
-- O PR #46 deixou dois casos para o gerente conciliar com o cliente:
--   - devolução retida (HOLD): parte de um estorno sem origem comprovada, fora do saldo;
--   - baixa sem resgate: crédito baixado por aparelho da versão anterior sem o REDEEM
--     (soma de amount - remaining dos EARN/REFUND menos os REDEEM, a mesma conta de
--     tchefood_register_cashback_redeem). Enquanto existe, o desfazer de resgate da versão
--     anterior recusa e o resgate ambíguo fica parado.
-- Aqui o gerente decide cada um, com PIN e motivo, e a regra roda no servidor
-- (tchefood_reconcile_cashback):
--   - Liberar: o valor volta ao cliente como crédito novo (REFUND sem conta), que vale
--     CASHBACK_VALIDITY_DAYS (30) dias a partir da liberação. A origem não é conhecida,
--     então não há validade antiga para herdar; o prazo começa quando o gerente libera.
--   - Descartar: o valor não volta (o gerente confirmou com o cliente que ele já foi usado).
--   - Baixa sem resgate, nos dois casos, ganha um lançamento SETTLE do mesmo valor (débito
--     explicado, sem saldo e sem validade), e a baixa sem resgate do cliente volta a zero.
--     Os resgates pendentes da versão anterior daquele cliente (registro do resgate na nuvem
--     sem o REDEEM) ficam marcados como conciliados e não entram mais: a baixa deles já
--     foi decidida pelo gerente.
-- Cada decisão grava um audit_log CASHBACK_RECONCILED com o gerente e o motivo, e uma
-- linha em cashback_reconciliations. O extrato continua somente inserção.
-- Aplicar depois de schema_cashback_servidor.sql. Idempotente.

DO $$
BEGIN
    IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'cashback_ledger_entry_type_refund')) NOT LIKE '%SETTLE%' THEN
        ALTER TABLE cashback_ledger DROP CONSTRAINT cashback_ledger_entry_type_refund;
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_entry_type_refund
            CHECK (entry_type IN ('EARN', 'REDEEM', 'EXPIRE', 'REFUND', 'HOLD', 'SETTLE'));
    END IF;
    -- SETTLE: débito sem saldo (remaining 0, pela restrição cashback_ledger_debit_no_balance),
    -- sem validade, sem conta e sem vínculo.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashback_ledger_settle_shape') THEN
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_settle_shape
            CHECK (entry_type <> 'SETTLE' OR (valid_from IS NULL AND expires_at IS NULL AND order_id IS NULL
                                               AND refund_of_id IS NULL AND redeem_sources IS NULL AND amount > 0));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS cashback_reconciliations (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    customer_id UUID NOT NULL,
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('HOLD', 'ORPHAN')),
    hold_id UUID UNIQUE REFERENCES cashback_ledger(id),
    decision VARCHAR(10) NOT NULL CHECK (decision IN ('RELEASE', 'DISCARD')),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    settle_id UUID REFERENCES cashback_ledger(id),
    credit_id UUID REFERENCES cashback_ledger(id),
    settled_audit_ids UUID[] NOT NULL DEFAULT '{}',
    audit_id UUID NOT NULL REFERENCES audit_logs(id),
    manager_id UUID NOT NULL REFERENCES staff_users(id),
    performed_by UUID NOT NULL REFERENCES staff_users(id),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES loyalty_customers (tenant_id, id),
    CHECK ((kind = 'HOLD') = (hold_id IS NOT NULL)),
    CHECK ((kind = 'ORPHAN') = (settle_id IS NOT NULL)),
    CHECK ((decision = 'RELEASE') = (credit_id IS NOT NULL))
);
-- Só pelas funções abaixo: o aparelho não lê nem grava a tabela direto.
ALTER TABLE cashback_reconciliations ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON cashback_reconciliations FROM PUBLIC, anon, authenticated;
    END IF;
END $$;

-- Registro de resgate da versão anterior já conciliado pelo gerente.
CREATE OR REPLACE FUNCTION tchefood_cashback_audit_settled(p_tenant UUID, p_audit_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM cashback_reconciliations r
                    WHERE r.tenant_id = p_tenant AND p_audit_id = ANY (r.settled_audit_ids));
$$;

-- Conta com resgate da versão anterior já conciliado pelo gerente (P0-02 da segunda
-- auditoria da rodada 1 do GPT no PR #48): o estado fica no banco (a conciliação guarda
-- os registros, e cada registro a sua conta), não no id que o aparelho manda.
CREATE OR REPLACE FUNCTION tchefood_cashback_order_settled(p_tenant UUID, p_order_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM cashback_reconciliations r
                     JOIN audit_logs a ON a.id = ANY (r.settled_audit_ids)
                    WHERE r.tenant_id = p_tenant AND a.tenant_id = p_tenant AND a.order_id = p_order_id);
$$;

-- Baixa sem resgate do cliente: crédito baixado (EARN/REFUND, amount - remaining) que
-- nenhum REDEEM nem SETTLE explica. Só desta loja.
CREATE OR REPLACE FUNCTION tchefood_cashback_orphan(p_tenant UUID, p_customer_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT GREATEST(
             COALESCE((SELECT SUM(amount - remaining_amount) FROM cashback_ledger
                        WHERE tenant_id = p_tenant AND customer_id = p_customer_id AND entry_type IN ('EARN', 'REFUND')), 0)
           - COALESCE((SELECT SUM(amount) FROM cashback_ledger
                        WHERE tenant_id = p_tenant AND customer_id = p_customer_id AND entry_type IN ('REDEEM', 'SETTLE')), 0), 0)::NUMERIC(10,2);
$$;

-- Resgates pendentes da versão anterior do cliente: registro do resgate gravado pelo
-- aparelho antigo, sem o REDEEM da conta e ainda não conciliado.
CREATE OR REPLACE FUNCTION tchefood_cashback_pending_legacy(p_tenant UUID, p_customer_id UUID)
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(array_agg(a.id ORDER BY a.server_seq), '{}')
      FROM audit_logs a
     WHERE a.tenant_id = p_tenant AND a.action_type = 'CASHBACK_REDEEMED' AND a.authorized_by_manager_id IS NULL
       AND COALESCE(a.metadata->>'server_verified', '') <> 'true'
       AND a.metadata->>'customer_id' = p_customer_id::text
       AND NOT EXISTS (SELECT 1 FROM cashback_ledger c WHERE c.tenant_id = p_tenant AND c.order_id = a.order_id AND c.entry_type = 'REDEEM')
       AND NOT tchefood_cashback_audit_settled(p_tenant, a.id);
$$;

-- Cópia da versão de schema_cashback_servidor.sql com a conciliação: a baixa sem resgate
-- desconta os SETTLE, e resgate da versão anterior já conciliado é recusado e não conta
-- entre os pendentes.
CREATE OR REPLACE FUNCTION tchefood_register_cashback_redeem(
    p_redeem_id UUID, p_audit_id UUID, p_order_id UUID, p_customer_id UUID,
    p_amount NUMERIC, p_user_id UUID, p_created_at TIMESTAMPTZ, p_legacy_predebited BOOLEAN DEFAULT FALSE)
RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_existing cashback_ledger%ROWTYPE;
    v_order orders%ROWTYPE;
    v_customer loyalty_customers%ROWTYPE;
    v_audit audit_logs%ROWTYPE;
    -- Dia, saldo e hora do resgate: o relógio do servidor. A hora do aparelho
    -- (p_created_at) pode ser forjada e só fica registrada no audit_log.
    v_at TIMESTAMPTZ := tchefood_cashback_now();
    v_available NUMERIC(10,2); v_cap NUMERIC(10,2); v_amount NUMERIC(10,2); v_left NUMERIC(10,2); v_take NUMERIC(10,2);
    v_sources JSONB := '[]'::jsonb;
    v_predebited NUMERIC(10,2) := 0; v_from_predebit NUMERIC(10,2) := 0;
    v_orphan NUMERIC(10,2); v_pending_count INT; v_pending_sum NUMERIC(10,2); v_legacy BOOLEAN := FALSE;
    r RECORD;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_redeem_id IS NULL OR p_audit_id IS NULL OR p_order_id IS NULL OR p_customer_id IS NULL OR p_user_id IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: resgate incompleto.';
    END IF;

    -- A conta trava aqui: dois resgates da mesma conta (ou do mesmo cliente em contas
    -- diferentes, pela trava do cliente logo abaixo) não passam juntos.
    SELECT * INTO v_order FROM orders WHERE id = p_order_id AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: conta não encontrada nesta loja.';
    END IF;

    -- Reenvio da fila: o mesmo resgate já está gravado.
    SELECT * INTO v_existing FROM cashback_ledger WHERE id = p_redeem_id;
    IF FOUND THEN
        IF v_existing.tenant_id <> v_tenant OR v_existing.entry_type <> 'REDEEM' OR v_existing.order_id IS DISTINCT FROM p_order_id
           OR v_existing.customer_id <> p_customer_id OR v_existing.amount <> p_amount THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: já existe outro lançamento com este id.';
        END IF;
        RETURN v_existing.amount;
    END IF;

    IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: conta não está aberta.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_user_id AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: quem resgatou não é da equipe ativa da loja.';
    END IF;
    SELECT * INTO v_customer FROM loyalty_customers WHERE id = p_customer_id AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: cliente inválido.';
    END IF;
    IF EXISTS (SELECT 1 FROM cashback_ledger WHERE tenant_id = v_tenant AND order_id = p_order_id AND entry_type = 'REDEEM') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: esta conta já usou cashback.';
    END IF;
    -- Resgate da versão anterior que o gerente já conciliou (a baixa sem resgate dele foi
    -- confirmada ou devolvida em Nuvem › Cashback para conciliar): não entra mais.
    IF tchefood_cashback_audit_settled(v_tenant, p_audit_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: este resgate da versão anterior já foi conciliado pelo gerente. Desfaça o cashback desta conta.';
    END IF;
    -- A mesma conta com ids novos também não: a conciliação já decidiu o cashback dela.
    IF tchefood_cashback_order_settled(v_tenant, p_order_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: esta conta tem resgate da versão anterior já conciliado pelo gerente; cashback novo nela não entra. Desfaça o cashback desta conta.';
    END IF;
    IF NOT tchefood_is_cashback_day(v_at) THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: cashback só pode ser usado de terça a quinta.';
    END IF;

    -- Versão anterior: baixa já feita, só com prova (ver o comentário da função).
    IF COALESCE(p_legacy_predebited, FALSE) AND EXISTS (
        SELECT 1 FROM audit_logs a
         WHERE a.id = p_audit_id AND a.tenant_id = v_tenant AND a.order_id = p_order_id
           AND a.action_type = 'CASHBACK_REDEEMED' AND a.authorized_by_manager_id IS NULL
           AND COALESCE(a.metadata->>'server_verified', '') <> 'true'
           AND a.metadata->>'customer_id' = p_customer_id::text
           AND jsonb_typeof(a.metadata->'amount') = 'number' AND (a.metadata->>'amount')::numeric = p_amount
           AND a.amount_impact = -p_amount AND a.performed_by_user_id = p_user_id) THEN
        v_legacy := TRUE;
        SELECT GREATEST(
                 COALESCE((SELECT SUM(amount - remaining_amount) FROM cashback_ledger
                            WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type IN ('EARN', 'REFUND')), 0)
               - COALESCE((SELECT SUM(amount) FROM cashback_ledger
                            WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type IN ('REDEEM', 'SETTLE')), 0), 0)
          INTO v_orphan;
        SELECT count(*), COALESCE(SUM(CASE WHEN jsonb_typeof(a.metadata->'amount') = 'number' THEN (a.metadata->>'amount')::numeric END), 0)
          INTO v_pending_count, v_pending_sum
          FROM audit_logs a
         WHERE a.tenant_id = v_tenant AND a.action_type = 'CASHBACK_REDEEMED' AND a.authorized_by_manager_id IS NULL
           AND COALESCE(a.metadata->>'server_verified', '') <> 'true'
           AND a.metadata->>'customer_id' = p_customer_id::text
           AND NOT EXISTS (SELECT 1 FROM cashback_ledger c WHERE c.tenant_id = v_tenant AND c.order_id = a.order_id AND c.entry_type = 'REDEEM')
           AND NOT tchefood_cashback_audit_settled(v_tenant, a.id);
        IF v_orphan <= 0 THEN
            v_predebited := 0;
        ELSIF v_pending_count = 1 THEN
            v_predebited := LEAST(v_orphan, p_amount);
        ELSIF v_orphan = v_pending_sum THEN
            v_predebited := p_amount;
        ELSE
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: resgate da versão anterior ambíguo (R$ % de crédito baixado para % resgates sem registro). O gerente precisa conciliar.', v_orphan, v_pending_count;
        END IF;
    END IF;

    -- Saldo liberado agora, só desta loja.
    SELECT COALESCE(SUM(remaining_amount), 0) INTO v_available FROM cashback_ledger
     WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type IN ('EARN', 'REFUND')
       AND valid_from <= v_at AND expires_at > v_at;
    v_available := v_available + v_predebited;
    v_cap := round(v_order.total_amount * tchefood_cashback_max_usage_pct() / 100, 2);
    v_amount := LEAST(v_available, v_cap, v_order.remaining_balance);
    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: sem saldo disponível.';
    END IF;
    IF v_legacy THEN
        -- O aparelho antigo calculou o valor com o saldo daquela hora: vale o dele, desde
        -- que não passe do que o servidor permite agora.
        IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_amount THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o servidor permite no máximo R$ % de cashback para esta conta, o aparelho mandou R$ %.', v_amount, p_amount;
        END IF;
        v_amount := p_amount;
    ELSIF p_amount IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o servidor calcula R$ % de cashback para esta conta, o aparelho mandou R$ %.', v_amount, p_amount;
    END IF;

    -- O que já saiu na versão anterior não sai de novo; o resto, do crédito que vence antes.
    v_from_predebit := LEAST(v_predebited, v_amount);
    v_left := v_amount - v_from_predebit;
    -- A parte já baixada na versão anterior não tem origem conhecida (source_id nulo).
    IF v_from_predebit > 0 THEN
        v_sources := v_sources || jsonb_build_array(jsonb_build_object('source_id', NULL, 'amount', v_from_predebit));
    END IF;
    FOR r IN SELECT id, remaining_amount FROM cashback_ledger
              WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type IN ('EARN', 'REFUND') AND remaining_amount > 0
                AND valid_from <= v_at AND expires_at > v_at
              ORDER BY expires_at, created_at FOR UPDATE LOOP
        EXIT WHEN v_left <= 0;
        v_take := LEAST(r.remaining_amount, v_left);
        UPDATE cashback_ledger SET remaining_amount = remaining_amount - v_take WHERE id = r.id;
        v_sources := v_sources || jsonb_build_array(jsonb_build_object('source_id', r.id, 'amount', v_take));
        v_left := v_left - v_take;
    END LOOP;

    INSERT INTO cashback_ledger (id, tenant_id, customer_id, order_id, entry_type, amount, created_by_user_id, created_at, redeem_sources)
    VALUES (p_redeem_id, v_tenant, p_customer_id, p_order_id, 'REDEEM', v_amount, p_user_id, v_at, v_sources);

    -- Fila de versão anterior: o audit_log do resgate pode já ter subido sozinho.
    -- Só vale reaproveitar o registro que já passou pela conferência da versão anterior
    -- acima (mesma loja, conta, cliente, valor e operador); qualquer outro com este id é recusado.
    SELECT * INTO v_audit FROM audit_logs WHERE id = p_audit_id;
    IF FOUND THEN
        IF NOT v_legacy OR v_audit.tenant_id <> v_tenant OR v_audit.order_id IS DISTINCT FROM p_order_id OR v_audit.action_type <> 'CASHBACK_REDEEMED'
           OR (v_audit.metadata->>'discount_before')::NUMERIC IS DISTINCT FROM v_order.discount_amount
           OR (v_audit.metadata->>'discount_after')::NUMERIC IS DISTINCT FROM v_order.discount_amount + v_amount THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o registro do resgate não confere com esta conta.';
        END IF;
    ELSE
        INSERT INTO audit_logs (id, tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact,
                                reason, whatsapp_alert_sent, metadata, created_at)
        VALUES (p_audit_id, v_tenant, p_order_id, p_user_id, NULL, 'CASHBACK_REDEEMED', -v_amount,
                'Cashback de fidelidade resgatado', FALSE,
                jsonb_build_object('customer_id', p_customer_id, 'phone', v_customer.phone_whatsapp, 'amount', v_amount,
                                   'discount_before', v_order.discount_amount, 'discount_after', v_order.discount_amount + v_amount,
                                   'server_verified', TRUE, 'legacy_predebited', v_from_predebit, 'device_created_at', p_created_at),
                v_at);
    END IF;
    UPDATE orders SET discount_amount = discount_amount + v_amount WHERE id = p_order_id;
    RETURN v_amount;
END;
$$;


-- Pendências da loja para a tela do gerente (Nuvem › Cashback para conciliar).
CREATE OR REPLACE FUNCTION tchefood_cashback_reconciliation_pending()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    RETURN jsonb_build_object(
        'holds', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', h.id, 'customer_id', h.customer_id, 'customer_name', c.name, 'phone', c.phone_whatsapp,
                       'order_id', h.order_id, 'amount', h.amount, 'created_at', h.created_at)
                     ORDER BY h.created_at, h.id)
              FROM cashback_ledger h JOIN loyalty_customers c ON c.tenant_id = h.tenant_id AND c.id = h.customer_id
             WHERE h.tenant_id = v_tenant AND h.entry_type = 'HOLD'
               AND NOT EXISTS (SELECT 1 FROM cashback_reconciliations r WHERE r.hold_id = h.id)), '[]'::jsonb),
        'orphans', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'customer_id', c.id, 'customer_name', c.name, 'phone', c.phone_whatsapp, 'amount', o.amount,
                       'pending_legacy_redeems', cardinality(tchefood_cashback_pending_legacy(v_tenant, c.id)))
                     ORDER BY c.id)
              FROM loyalty_customers c
             CROSS JOIN LATERAL (SELECT tchefood_cashback_orphan(v_tenant, c.id) AS amount) o
             WHERE c.tenant_id = v_tenant AND o.amount > 0), '[]'::jsonb));
END;
$$;

-- Decisão do gerente. p_request_id é o id da conciliação gerado pelo aparelho: o reenvio
-- (resposta perdida) devolve a mesma decisão sem repetir nada. p_amount é o valor que a
-- tela mostrou: se a pendência mudou desde a leitura, recusa (a tela lê de novo).
-- PIN errado ou bloqueado não levanta erro (o registro da tentativa fica gravado, como em
-- tchefood_authorize_manager): devolve status PIN_FAILED ou PIN_LOCKED.
CREATE OR REPLACE FUNCTION tchefood_reconcile_cashback(
    p_request_id UUID, p_kind TEXT, p_customer_id UUID, p_hold_id UUID, p_decision TEXT, p_amount NUMERIC,
    p_manager_pin VARCHAR, p_performed_by UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_now TIMESTAMPTZ := tchefood_cashback_now();
    v_manager staff_users%ROWTYPE;
    v_failures INT;
    v_existing cashback_reconciliations%ROWTYPE;
    v_hold cashback_ledger%ROWTYPE;
    v_amount NUMERIC(10,2);
    v_settled UUID[] := '{}';
    v_settle_id UUID;
    v_credit_id UUID;
    v_audit_id UUID;
    v_order UUID;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_request_id IS NULL OR p_customer_id IS NULL OR p_performed_by IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: conciliação incompleta.';
    END IF;
    IF p_kind NOT IN ('HOLD', 'ORPHAN') OR p_decision NOT IN ('RELEASE', 'DISCARD') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: conciliação inválida.';
    END IF;
    IF (p_kind = 'HOLD') <> (p_hold_id IS NOT NULL) THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: devolução retida precisa do lançamento; baixa sem resgate não leva lançamento.';
    END IF;
    -- NaN passa por "> 0" no Postgres: recusa explícita, com teto finito.
    IF p_amount IS NULL OR NOT (p_amount > 0 AND p_amount < 1000000000) OR p_amount = 'NaN'::numeric OR round(p_amount, 2) <> p_amount THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: valor da conciliação inválido.';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: operador inválido.';
    END IF;

    -- PIN do gerente, com o mesmo bloqueio de tchefood_authorize_manager (3 erros em 60 s).
    -- P0-01 da rodada 1 do GPT: tentativas simultâneas contavam as falhas antes de qualquer
    -- uma gravar a sua e todas testavam o PIN. A trava da loja (até o fim da transação)
    -- enfileira as tentativas: cada uma conta as falhas já gravadas pelas anteriores.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= NOW() - INTERVAL '60 seconds';
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (v_tenant, NULL, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', 'CASHBACK_RECONCILED'));
        RETURN jsonb_build_object('status', 'PIN_LOCKED');
    END IF;
    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES (v_tenant, NULL, p_performed_by, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', 'CASHBACK_RECONCILED'));
        RETURN jsonb_build_object('status', 'PIN_FAILED');
    END IF;

    -- O cliente trava aqui: o resgate (tchefood_register_cashback_redeem) trava o mesmo
    -- cliente, então a baixa sem resgate não muda entre a conferência e a decisão.
    PERFORM 1 FROM loyalty_customers c WHERE c.id = p_customer_id AND c.tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: cliente inválido.';
    END IF;

    -- Reenvio: a mesma decisão já está gravada. P2-02 da segunda auditoria da rodada 1:
    -- motivo, operador e gerente também precisam ser os mesmos; outro pedido com este id
    -- não grava nada e devolve CONFLICT com o que está gravado (a tela mostra e lê de novo).
    SELECT * INTO v_existing FROM cashback_reconciliations WHERE id = p_request_id;
    IF FOUND THEN
        IF v_existing.tenant_id <> v_tenant THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: já existe outra conciliação com este id.';
        END IF;
        IF v_existing.kind <> p_kind OR v_existing.customer_id <> p_customer_id
           OR v_existing.hold_id IS DISTINCT FROM p_hold_id OR v_existing.decision <> p_decision OR v_existing.amount <> p_amount
           OR v_existing.reason <> trim(p_reason) OR v_existing.performed_by <> p_performed_by OR v_existing.manager_id <> v_manager.id THEN
            RETURN jsonb_build_object('status', 'CONFLICT', 'reconciliation_id', v_existing.id, 'decision', v_existing.decision,
                                      'amount', v_existing.amount, 'reason', v_existing.reason);
        END IF;
        RETURN jsonb_build_object('status', 'OK', 'reconciliation_id', v_existing.id, 'amount', v_existing.amount,
                                  'credit_id', v_existing.credit_id, 'repeated', TRUE);
    END IF;

    IF p_kind = 'HOLD' THEN
        SELECT * INTO v_hold FROM cashback_ledger
         WHERE id = p_hold_id AND tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type = 'HOLD'
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: devolução retida não encontrada para este cliente nesta loja.';
        END IF;
        IF EXISTS (SELECT 1 FROM cashback_reconciliations r WHERE r.hold_id = p_hold_id) THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: esta devolução retida já foi conciliada.';
        END IF;
        v_amount := v_hold.amount;
        v_order := v_hold.order_id;
    ELSE
        v_amount := tchefood_cashback_orphan(v_tenant, p_customer_id);
        IF v_amount <= 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: este cliente não tem baixa sem resgate para conciliar.';
        END IF;
        v_settled := tchefood_cashback_pending_legacy(v_tenant, p_customer_id);
    END IF;
    IF v_amount <> p_amount THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o valor a conciliar mudou (agora R$ %). Leia as pendências de novo.', to_char(v_amount, 'FM999999990.00');
    END IF;

    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, v_order, p_performed_by, v_manager.id, 'CASHBACK_RECONCILED',
            CASE WHEN p_decision = 'RELEASE' THEN v_amount ELSE 0 END, trim(p_reason),
            jsonb_build_object('reconciliation_id', p_request_id, 'kind', p_kind, 'decision', p_decision,
                               'customer_id', p_customer_id, 'hold_id', p_hold_id, 'amount', v_amount,
                               'settled_audit_ids', to_jsonb(v_settled),
                               'manager_name', v_manager.name, 'server_verified', TRUE))
    RETURNING id INTO v_audit_id;

    IF p_kind = 'ORPHAN' THEN
        v_settle_id := gen_random_uuid();
        INSERT INTO cashback_ledger (id, tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, created_by_user_id, created_at)
        VALUES (v_settle_id, v_tenant, p_customer_id, NULL, 'SETTLE', v_amount, 0, p_performed_by, v_now);
    END IF;
    IF p_decision = 'RELEASE' THEN
        v_credit_id := gen_random_uuid();
        INSERT INTO cashback_ledger (id, tenant_id, customer_id, order_id, entry_type, amount, remaining_amount,
                                     valid_from, expires_at, created_by_user_id, created_at)
        VALUES (v_credit_id, v_tenant, p_customer_id, NULL, 'REFUND', v_amount, v_amount,
                v_now, v_now + make_interval(days => tchefood_cashback_validity_days()), p_performed_by, v_now);
    END IF;
    INSERT INTO cashback_reconciliations (id, tenant_id, customer_id, kind, hold_id, decision, amount, settle_id, credit_id,
                                          settled_audit_ids, audit_id, manager_id, performed_by, reason, created_at)
    VALUES (p_request_id, v_tenant, p_customer_id, p_kind, p_hold_id, p_decision, v_amount, v_settle_id, v_credit_id,
            v_settled, v_audit_id, v_manager.id, p_performed_by, trim(p_reason), v_now);
    PERFORM tchefood_refresh_cashback_balance(p_customer_id);
    RETURN jsonb_build_object('status', 'OK', 'reconciliation_id', p_request_id, 'amount', v_amount,
                              'credit_id', v_credit_id, 'repeated', FALSE);
END;
$$;

-- O aparelho não grava o registro da conciliação direto (só a função acima).
CREATE OR REPLACE FUNCTION tchefood_guard_audit_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authorized_by_manager_id IS NOT NULL AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: autorização de gerente só pode ser registrada por tchefood_authorize_manager().';
    END IF;
    IF NEW.action_type = 'CASHBACK_REDEEMED' AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o registro do resgate só é gravado por tchefood_register_cashback_redeem.';
    END IF;
    IF NEW.action_type IN ('CASHBACK_REFUNDED', 'CASHBACK_REFUND_HELD') AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o estorno do cashback só é gravado pelo banco, no cancelamento do item.';
    END IF;
    IF NEW.action_type = 'CASHBACK_RECONCILED' AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: a conciliação do cashback só é gravada por tchefood_reconcile_cashback.';
    END IF;
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_cashback_audit_settled(UUID, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_cashback_order_settled(UUID, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_cashback_orphan(UUID, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_cashback_pending_legacy(UUID, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_cashback_reconciliation_pending() FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_cashback_reconciliation_pending() TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_reconcile_cashback(UUID, TEXT, UUID, UUID, TEXT, NUMERIC, VARCHAR, UUID, TEXT) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_reconcile_cashback(UUID, TEXT, UUID, UUID, TEXT, NUMERIC, VARCHAR, UUID, TEXT) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_register_cashback_redeem(UUID, UUID, UUID, UUID, NUMERIC, UUID, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_register_cashback_redeem(UUID, UUID, UUID, UUID, NUMERIC, UUID, TIMESTAMPTZ, BOOLEAN) TO authenticated;
    END IF;
END $$;
