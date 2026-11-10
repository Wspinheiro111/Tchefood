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
           AND jsonb_typeof(a.metadata->'amount') = 'number' AND (a.metadata->>'amount')::numeric = p_amount
           AND a.amount_impact = -p_amount AND a.performed_by_user_id = p_user_id) THEN
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

-- Autorização de gerente (cópia da versão de schema_caixa.sql): passa a aceitar a troca
-- do desconto manual por um menor, que antes era recusada e deixava a redução sem registro.
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
    -- O gerente também troca o desconto manual por um menor (R$ 10 → R$ 5): a troca fica
    -- registrada e é ela que libera a redução em tchefood_orders_keep_discount.
    IF p_action_type = 'DISCOUNT_APPLIED' AND (
        (p_metadata->>'discount_before') IS NULL OR (p_metadata->>'discount_after') IS NULL
        OR (p_metadata->>'discount_before')::numeric < 0 OR (p_metadata->>'discount_after')::numeric < 0
        OR (p_metadata->>'discount_after')::numeric = (p_metadata->>'discount_before')::numeric) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: desconto precisa de discount_before e discount_after (diferentes) no metadata.';
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

-- Desconto da conta: só cresce por autorização (DISCOUNT_APPLIED) ou pela função do
-- cashback. O aparelho só o reduz quando o gerente troca o desconto manual por um menor:
-- a última DISCOUNT_APPLIED da conta, de gerente ativo, com discount_before/discount_after
-- iguais ao valor do banco e ao novo. Qualquer outra redução é uma atualização antiga da
-- fila (feita antes de outro desconto chegar à nuvem) e apagaria o desconto já gravado:
-- o banco mantém o valor dele. Conta com resgate de cashback não reduz (o app também não
-- deixa combinar desconto manual com cashback).
CREATE OR REPLACE FUNCTION tchefood_orders_keep_discount()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_ok BOOLEAN;
BEGIN
    -- Profundidade > 1: o recálculo do banco (tchefood_recalc_order, dentro de outro gatilho)
    -- limita o desconto ao bruto da conta quando um item é cancelado; não é a fila do aparelho.
    IF current_user IN ('anon', 'authenticated') AND pg_trigger_depth() = 1
       AND NEW.discount_amount < OLD.discount_amount THEN
        SELECT (a.metadata->>'discount_before')::NUMERIC = OLD.discount_amount
           AND (a.metadata->>'discount_after')::NUMERIC = NEW.discount_amount
           AND m.role IN ('MANAGER', 'OWNER') AND m.active
          INTO v_ok
          FROM audit_logs a LEFT JOIN staff_users m ON m.id = a.authorized_by_manager_id AND m.tenant_id = a.tenant_id
         WHERE a.order_id = NEW.id AND a.tenant_id = NEW.tenant_id AND a.action_type = 'DISCOUNT_APPLIED'
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1;
        IF NOT COALESCE(v_ok, false) OR EXISTS (
            SELECT 1 FROM cashback_ledger l
             WHERE l.order_id = NEW.id AND l.tenant_id = NEW.tenant_id AND l.entry_type = 'REDEEM') THEN
            NEW.discount_amount := OLD.discount_amount;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_00_keep_discount ON orders;
CREATE TRIGGER trg_orders_00_keep_discount BEFORE UPDATE OF discount_amount ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_orders_keep_discount();

-- Saldo exibido do cliente (cache do extrato): o banco calcula, o valor do aparelho não
-- vale. Sem isso, a atualização do cliente que sobe depois do resgate gravaria o saldo
-- antigo do aparelho por cima de um crédito novo de outro aparelho.
CREATE OR REPLACE FUNCTION tchefood_refresh_cashback_balance(p_customer_id UUID)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE loyalty_customers c SET cashback_balance =
        (SELECT COALESCE(SUM(l.remaining_amount), 0) FROM cashback_ledger l
          WHERE l.tenant_id = c.tenant_id AND l.customer_id = c.id AND l.entry_type = 'EARN' AND l.expires_at > NOW())
     WHERE c.id = p_customer_id
$$;
CREATE OR REPLACE FUNCTION tchefood_loyalty_balance_from_ledger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    NEW.cashback_balance := (SELECT COALESCE(SUM(l.remaining_amount), 0) FROM cashback_ledger l
                              WHERE l.tenant_id = NEW.tenant_id AND l.customer_id = NEW.id
                                AND l.entry_type = 'EARN' AND l.expires_at > NOW());
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_loyalty_customers_balance ON loyalty_customers;
CREATE TRIGGER trg_loyalty_customers_balance BEFORE INSERT OR UPDATE ON loyalty_customers
    FOR EACH ROW EXECUTE FUNCTION tchefood_loyalty_balance_from_ledger();

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
        REVOKE ALL ON FUNCTION tchefood_loyalty_balance_from_ledger() FROM PUBLIC, anon, authenticated;
        REVOKE DELETE ON cashback_ledger FROM anon, authenticated;
    END IF;
END $$;
