-- =============================================================================
-- Tchê Food — resgate do cashback só pela função do servidor
-- Aplicar depois de db/schema_expansion.sql (achado P0-03 da auditoria GPT).
--
-- Antes: o aparelho gravava o REDEEM direto em cashback_ledger e baixava o saldo dos
-- créditos por UPDATE. O gatilho de inserção só conferia o EARN, então o banco não
-- conferia dia permitido, teto de 50% nem saldo do resgate.
--
-- Agora:
--  - REDEEM, EXPIRE e a baixa do saldo de um EARN só são gravados por função do
--    servidor (SECURITY DEFINER). O token do aparelho (anon/authenticated) é recusado.
--  - tchefood_register_cashback_redeem: mesma regra da tela e de tchefood_redeem_cashback
--    (terça a quinta em Brasília, crédito liberado, teto de 50% do total, saldo da
--    conta), com trava da conta e do cliente, idempotente pelo id do resgate. O valor é
--    calculado pelo banco e precisa bater com o do aparelho, senão é recusado.
--  - Dia permitido, saldo e hora do resgate pelo relógio do servidor; a hora do aparelho
--    só fica registrada. Resgate feito sem internet que sobe fora de terça a quinta é
--    recusado e fica em Nuvem › recusados.
--  - Tudo filtrado pela loja da sessão, e o lançamento só aponta para cliente e conta da
--    própria loja (chaves compostas).
--  - Fila da versão anterior com o crédito já baixado: só com prova na nuvem (abaixo).
-- =============================================================================

-- O aparelho grava o crédito (EARN, conferido abaixo); resgate e expiração não.
CREATE OR REPLACE FUNCTION tchefood_cashback_ledger_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_order orders%ROWTYPE; v_expected NUMERIC(10,2);
BEGIN
    IF NEW.entry_type <> 'EARN' AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: resgate de cashback só pela função do servidor (tchefood_register_cashback_redeem).';
    END IF;
    IF NEW.entry_type = 'EARN' THEN
        SELECT * INTO v_order FROM orders WHERE id = NEW.order_id;
        IF NOT FOUND OR v_order.status <> 'CLOSED' THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: crédito só para conta encerrada.';
        END IF;
        v_expected := round(tchefood_cashback_base(v_order) * tchefood_cashback_pct() / 100, 2);
        IF NEW.amount <> v_expected OR NEW.remaining_amount <> NEW.amount THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: crédito esperado R$ %.', v_expected;
        END IF;
        IF NEW.valid_from <= NEW.created_at - INTERVAL '1 minute' THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: cashback vale a partir da próxima visita.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- O extrato continua somente inserção; baixar o saldo de um crédito é só do servidor.
CREATE OR REPLACE FUNCTION tchefood_cashback_ledger_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'TCHEFOOD_CASHBACK: extrato é somente inserção.'; END IF;
    IF NEW.amount <> OLD.amount OR NEW.entry_type <> OLD.entry_type OR NEW.customer_id <> OLD.customer_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.remaining_amount > OLD.remaining_amount THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: extrato é somente inserção.';
    END IF;
    IF NEW.remaining_amount <> OLD.remaining_amount AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o saldo do crédito só baixa pela função do servidor (tchefood_register_cashback_redeem).';
    END IF;
    RETURN NEW;
END;
$$;

-- Relógio do resgate. É NOW(); existe à parte só para o teste com o banco real poder
-- fixar a data (a regra de terça a quinta depende do dia).
CREATE OR REPLACE FUNCTION tchefood_cashback_now() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$ SELECT NOW() $$;

-- Resgate da fila de um aparelho da versão anterior (p_legacy_predebited). Naquela versão
-- a fila subia, nesta ordem: o audit_log CASHBACK_REDEEMED, a baixa dos créditos (UPDATE)
-- e o REDEEM. Se a internet caiu no meio, parte do crédito já saiu da nuvem sem o REDEEM.
-- A marca do aparelho sozinha não libera nada. O servidor só conta a baixa como já feita
-- quando há prova na nuvem:
--   - o audit_log daquele resgate (p_audit_id) gravado pela versão anterior, da mesma loja,
--     conta, cliente e valor, e ainda sem REDEEM;
--   - a baixa sem resgate do cliente (soma de amount - remaining dos EARN menos a soma dos
--     REDEEM, só desta loja) pertence sem dúvida a esse resgate: ele é o único pendente do
--     cliente, ou a baixa é exatamente a soma dos pendentes.
-- Ambíguo (vários pendentes e uma baixa parcial): recusa; fica em Nuvem › recusados para
-- o gerente conciliar. Sem prova: segue a regra normal, sem nada já baixado.
-- O aparelho não grava mais CASHBACK_REDEEMED direto (tchefood_guard_audit_insert), então
-- a prova só pode ser da versão anterior.
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
           AND jsonb_typeof(a.metadata->'amount') = 'number' AND (a.metadata->>'amount')::numeric = p_amount) THEN
        v_legacy := TRUE;
        SELECT GREATEST(
                 COALESCE((SELECT SUM(amount - remaining_amount) FROM cashback_ledger
                            WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type = 'EARN'), 0)
               - COALESCE((SELECT SUM(amount) FROM cashback_ledger
                            WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type = 'REDEEM'), 0), 0)
          INTO v_orphan;
        SELECT count(*), COALESCE(SUM(CASE WHEN jsonb_typeof(a.metadata->'amount') = 'number' THEN (a.metadata->>'amount')::numeric END), 0)
          INTO v_pending_count, v_pending_sum
          FROM audit_logs a
         WHERE a.tenant_id = v_tenant AND a.action_type = 'CASHBACK_REDEEMED' AND a.authorized_by_manager_id IS NULL
           AND COALESCE(a.metadata->>'server_verified', '') <> 'true'
           AND a.metadata->>'customer_id' = p_customer_id::text
           AND NOT EXISTS (SELECT 1 FROM cashback_ledger c WHERE c.tenant_id = v_tenant AND c.order_id = a.order_id AND c.entry_type = 'REDEEM');
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
     WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type = 'EARN'
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
    FOR r IN SELECT id, remaining_amount FROM cashback_ledger
              WHERE tenant_id = v_tenant AND customer_id = p_customer_id AND entry_type = 'EARN' AND remaining_amount > 0
                AND valid_from <= v_at AND expires_at > v_at
              ORDER BY expires_at, created_at FOR UPDATE LOOP
        EXIT WHEN v_left <= 0;
        v_take := LEAST(r.remaining_amount, v_left);
        UPDATE cashback_ledger SET remaining_amount = remaining_amount - v_take WHERE id = r.id;
        v_left := v_left - v_take;
    END LOOP;

    INSERT INTO cashback_ledger (id, tenant_id, customer_id, order_id, entry_type, amount, created_by_user_id, created_at)
    VALUES (p_redeem_id, v_tenant, p_customer_id, p_order_id, 'REDEEM', v_amount, p_user_id, v_at);

    -- Fila de versão anterior: o audit_log do resgate pode já ter subido sozinho.
    SELECT * INTO v_audit FROM audit_logs WHERE id = p_audit_id;
    IF FOUND THEN
        IF v_audit.tenant_id <> v_tenant OR v_audit.order_id IS DISTINCT FROM p_order_id OR v_audit.action_type <> 'CASHBACK_REDEEMED'
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

-- O audit_log do resgate só nasce na função acima: o aparelho não grava CASHBACK_REDEEMED
-- direto (seria uma prova forjada de resgate da versão anterior). Mantém a trava de
-- schema.sql (autorização de gerente só por tchefood_authorize_manager).
CREATE OR REPLACE FUNCTION tchefood_guard_audit_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authorized_by_manager_id IS NOT NULL AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: autorização de gerente só pode ser registrada por tchefood_authorize_manager().';
    END IF;
    IF NEW.action_type = 'CASHBACK_REDEEMED' AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o registro do resgate só é gravado por tchefood_register_cashback_redeem.';
    END IF;
    RETURN NEW;
END;
$$;

-- Crédito, resgate e expiração presos à loja: cliente e conta do lançamento são da mesma
-- loja do lançamento. NOT VALID: vale para todo lançamento novo ou alterado; o que já
-- existe não é reprovado (as consultas acima filtram pela loja de qualquer forma).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loyalty_customers_tenant_id_id_key') THEN
        ALTER TABLE loyalty_customers ADD CONSTRAINT loyalty_customers_tenant_id_id_key UNIQUE (tenant_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_tenant_id_id_key') THEN
        ALTER TABLE orders ADD CONSTRAINT orders_tenant_id_id_key UNIQUE (tenant_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashback_ledger_customer_same_tenant') THEN
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_customer_same_tenant
            FOREIGN KEY (tenant_id, customer_id) REFERENCES loyalty_customers (tenant_id, id) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashback_ledger_order_same_tenant') THEN
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_order_same_tenant
            FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_register_cashback_redeem(UUID, UUID, UUID, UUID, NUMERIC, UUID, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_register_cashback_redeem(UUID, UUID, UUID, UUID, NUMERIC, UUID, TIMESTAMPTZ, BOOLEAN) TO authenticated;
        -- A função antiga roda com o papel de quem chama e agora é recusada pelo gatilho: fica só para o servidor.
        REVOKE ALL ON FUNCTION tchefood_redeem_cashback(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_cashback_now() FROM PUBLIC, anon, authenticated;
        REVOKE DELETE ON cashback_ledger FROM anon, authenticated;
    END IF;
END $$;
