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
--  - Cancelamento de item que deixa o desconto abaixo do cashback usado devolve a
--    diferença ao cliente (REFUND + audit_log CASHBACK_REFUNDED, só pelo banco). O valor
--    devolvido vence junto com o crédito de onde saiu (decisão do Will, 10/11/2026: o
--    cashback vale 30 dias de quando foi gerado, com ou sem cancelamento).
-- =============================================================================

-- De onde saiu cada resgate (redeem_sources: [{source_id, amount}], gravado só pela função
-- do resgate) e de qual crédito é cada estorno (refund_of_id). É o que faz o estorno herdar
-- a validade do crédito original.
ALTER TABLE cashback_ledger ADD COLUMN IF NOT EXISTS redeem_sources JSONB;
ALTER TABLE cashback_ledger ADD COLUMN IF NOT EXISTS refund_of_id UUID REFERENCES cashback_ledger(id);

-- O aparelho grava o crédito (EARN, conferido abaixo); resgate e expiração não.
CREATE OR REPLACE FUNCTION tchefood_cashback_ledger_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_order orders%ROWTYPE; v_expected NUMERIC(10,2);
BEGIN
    IF NEW.entry_type <> 'EARN' AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: resgate de cashback só pela função do servidor (tchefood_register_cashback_redeem).';
    END IF;
    IF NEW.entry_type = 'EARN' THEN
        IF NEW.redeem_sources IS NOT NULL OR NEW.refund_of_id IS NOT NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_CASHBACK: crédito não leva origem de resgate nem de estorno.';
        END IF;
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
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.remaining_amount > OLD.remaining_amount
       OR NEW.redeem_sources IS DISTINCT FROM OLD.redeem_sources OR NEW.refund_of_id IS DISTINCT FROM OLD.refund_of_id THEN
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
    IF NEW.action_type IN ('CASHBACK_REFUNDED', 'CASHBACK_REFUND_HELD') AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: o estorno do cashback só é gravado pelo banco, no cancelamento do item.';
    END IF;
    RETURN NEW;
END;
$$;

-- Autorização de gerente: igual à de schema_preco_gerente.sql (PR #36: PRICE_OVERRIDE
-- preso ao item inteiro e a troca do desconto manual por um menor, que libera a redução em
-- tchefood_orders_keep_discount). Repetida aqui para valer em qualquer ordem de aplicação.
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
    v_meta JSONB := COALESCE(p_metadata, '{}'::jsonb);
    v_valid BOOLEAN;
    v_without_order BOOLEAN := p_action_type IN ('KIOSK_EXIT', 'KEG_CHANGED', 'CASH_WITHDRAWAL', 'CASH_CLOSE_DIFFERENCE');
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.';
    END IF;
    IF p_action_type NOT IN ('ITEM_CANCELED', 'SERVICE_FEE_REMOVED', 'DISCOUNT_APPLIED',
                             'CHARGE_CONFIRMED_MANUALLY', 'KIOSK_EXIT', 'KEG_CHANGED',
                             'CASH_WITHDRAWAL', 'CASH_CLOSE_DIFFERENCE', 'PRICE_OVERRIDE') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: ação % não exige autorização.', p_action_type;
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).';
    END IF;
    -- O gerente também troca o desconto manual por um menor (R$ 10 → R$ 5); a troca fica
    -- registrada (no #35 é ela que libera a redução no gatilho do desconto).
    -- Os dois valores precisam ser números finitos, não negativos e diferentes. NaN e
    -- Infinity passam por "< 0" e por "=" sem recusa (NaN é maior que qualquer número no
    -- PostgreSQL), então o teto finito é conferido à parte; texto que não é número recusa igual.
    IF p_action_type = 'DISCOUNT_APPLIED' THEN
        BEGIN
            v_valid := (p_metadata->>'discount_before')::numeric >= 0
                   AND (p_metadata->>'discount_before')::numeric < 1000000000
                   AND (p_metadata->>'discount_after')::numeric >= 0
                   AND (p_metadata->>'discount_after')::numeric < 1000000000
                   AND (p_metadata->>'discount_after')::numeric <> (p_metadata->>'discount_before')::numeric;
        EXCEPTION WHEN others THEN
            v_valid := FALSE;
        END;
    END IF;
    IF p_action_type = 'DISCOUNT_APPLIED' AND NOT COALESCE(v_valid, FALSE) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: desconto precisa de discount_before e discount_after (diferentes) no metadata.';
    END IF;
    IF p_action_type = 'ITEM_CANCELED' AND (p_metadata->>'item_id') IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: cancelamento precisa do item_id no metadata.';
    END IF;
    -- Preço diferente do cadastro: a autorização é presa ao item inteiro (id, produto,
    -- quantidade, preços, sabores e adicionais) e vem antes dele. Não mexe no valor por si:
    -- a diferença sai no PRICE_MISMATCH do item. Os campos são gravados já convertidos
    -- (o gatilho do item compara sem conversão); valor inválido recusa sem gravar nada.
    IF p_action_type = 'PRICE_OVERRIDE' THEN
        IF COALESCE(p_amount_impact, 0) <> 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_PRECO: autorização de preço não tem valor próprio (a diferença sai no alerta do item).';
        END IF;
        BEGIN
            v_meta := v_meta || jsonb_build_object(
                'item_id', (p_metadata->>'item_id')::uuid,
                'product_id', (p_metadata->>'product_id')::uuid,
                'quantity', (p_metadata->>'quantity')::numeric(10,3),
                'unit_price', (p_metadata->>'unit_price')::numeric(10,2),
                'modifiers_unit_price', (p_metadata->>'modifiers_unit_price')::numeric(10,2),
                'half_product_ids', to_jsonb(ARRAY(SELECT jsonb_array_elements_text(p_metadata->'half_product_ids'))::uuid[]),
                'modifier_option_ids', to_jsonb(ARRAY(SELECT jsonb_array_elements_text(p_metadata->'modifier_option_ids'))::uuid[]));
            v_valid := jsonb_typeof(p_metadata->'half_product_ids') = 'array'
                   AND jsonb_typeof(p_metadata->'modifier_option_ids') = 'array'
                   AND (v_meta->>'item_id') IS NOT NULL AND (v_meta->>'product_id') IS NOT NULL
                   AND (v_meta->>'quantity')::numeric > 0 AND (v_meta->>'unit_price')::numeric >= 0
                   AND (v_meta->>'modifiers_unit_price') IS NOT NULL
                   -- NaN passa no cast e é "maior" que qualquer número no Postgres: recusa explícita.
                   AND (v_meta->>'quantity')::numeric <> 'NaN'::numeric
                   AND (v_meta->>'unit_price')::numeric <> 'NaN'::numeric
                   AND (v_meta->>'modifiers_unit_price')::numeric <> 'NaN'::numeric;
        EXCEPTION WHEN others THEN
            v_valid := FALSE;
        END;
        IF NOT COALESCE(v_valid, FALSE) THEN
            RAISE EXCEPTION 'TCHEFOOD_PRECO: autorização de preço precisa de item_id, product_id, quantity, unit_price, modifiers_unit_price, half_product_ids e modifier_option_ids válidos no metadata.';
        END IF;
        PERFORM 1 FROM products pr WHERE pr.id = (v_meta->>'product_id')::uuid AND pr.tenant_id = v_tenant;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_PRECO: produto não encontrado nesta loja.';
        END IF;
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
            v_meta || jsonb_build_object('manager_name', v_manager.name, 'server_verified', true))
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
-- cashback. O aparelho só o reduz quando o gerente troca o desconto manual por um menor,
-- ou quando o limita ao novo bruto da conta (tirar os 10% de uma conta com desconto maior
-- que o consumo). Qualquer outra redução vinda do aparelho é uma atualização antiga da fila
-- (feita antes de outro desconto chegar à nuvem) e apagaria o desconto já gravado: o banco
-- recusa.
-- P0-01 da rodada 7 do GPT: a autorização de desconto vale uma vez. orders.discount_auth_seq
-- guarda a sequência (server_seq) da última DISCOUNT_APPLIED usada nesta conta; só uma
-- autorização mais nova libera outra troca. Assim a autorização 0 → 5 já aplicada não volta a
-- valer quando o desconto cai a 0 (itens cancelados, estorno do cashback) e o aparelho manda 5
-- de novo. O aparelho não grava a coluna (o gatilho mantém a do banco).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_auth_seq BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION tchefood_orders_keep_discount()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_ok BOOLEAN;
    v_auth_seq BIGINT;
    v_redeemed NUMERIC(10,2);
    v_subtotal NUMERIC(10,2);
    v_fee NUMERIC(10,2);
BEGIN
    IF current_user IN ('anon', 'authenticated') AND pg_trigger_depth() = 1 THEN
        NEW.discount_auth_seq := OLD.discount_auth_seq;
    END IF;
    IF NEW.discount_amount = OLD.discount_amount THEN
        RETURN NEW;
    END IF;
    -- Profundidade > 1: o recálculo do banco (tchefood_recalc_order, dentro de outro gatilho)
    -- limita o desconto ao bruto da conta quando um item é cancelado. Em conta com cashback,
    -- o que o desconto perder abaixo do cashback consumido volta para o cliente
    -- (tchefood_orders_cashback_refund, depois da atualização). A função do resgate roda
    -- como dona do banco (não é o aparelho).
    IF pg_trigger_depth() > 1 OR current_user NOT IN ('anon', 'authenticated') THEN
        RETURN NEW;
    END IF;
    SELECT COALESCE(SUM(l.amount), 0) INTO v_redeemed FROM cashback_ledger l
     WHERE l.order_id = NEW.id AND l.tenant_id = NEW.tenant_id AND l.entry_type = 'REDEEM';
    -- A última DISCOUNT_APPLIED da conta (pela sequência do servidor), de gerente ativo,
    -- conferindo com o valor do banco e o novo, ainda não usada nesta conta e mais nova que o
    -- último resgate ou estorno do cashback da conta (autorização de antes do estorno não
    -- vale depois dele).
    SELECT (a.metadata->>'discount_before')::NUMERIC = OLD.discount_amount
       AND (a.metadata->>'discount_after')::NUMERIC = NEW.discount_amount
       AND m.role IN ('MANAGER', 'OWNER') AND m.active
       AND a.server_seq > OLD.discount_auth_seq
       AND a.server_seq > COALESCE((SELECT max(c.server_seq) FROM audit_logs c
                                     WHERE c.tenant_id = NEW.tenant_id AND c.order_id = NEW.id
                                       AND c.action_type IN ('CASHBACK_REDEEMED', 'CASHBACK_REFUNDED', 'CASHBACK_REFUND_HELD')), 0),
           a.server_seq
      INTO v_ok, v_auth_seq
      FROM audit_logs a LEFT JOIN staff_users m ON m.id = a.authorized_by_manager_id AND m.tenant_id = a.tenant_id
     WHERE a.order_id = NEW.id AND a.tenant_id = NEW.tenant_id AND a.action_type = 'DISCOUNT_APPLIED'
     ORDER BY a.server_seq DESC
     LIMIT 1;
    IF NEW.discount_amount > OLD.discount_amount THEN
        -- Aumento em conta com cashback: o desconto do cashback só entra pela função do
        -- resgate. Sem esta trava, depois de um estorno o aparelho subia o desconto de volta
        -- e a conferência de tchefood_require_order_audit aceitava pelo registro do resgate
        -- original (antes/depois iguais de novo): o cliente ficava com o estorno e o desconto.
        -- Exceção: fila da versão anterior que subiu o REDEEM e o registro do resgate, mas
        -- caiu antes da atualização da conta. Ela traz o aumento que bate com esse registro
        -- (gravado pelo aparelho antigo, sem server_verified) e com o REDEEM, e só vale se a
        -- conta nunca teve estorno.
        IF v_redeemed > 0 AND NOT COALESCE(v_ok, false) AND NOT (
            NOT EXISTS (SELECT 1 FROM cashback_ledger r WHERE r.tenant_id = NEW.tenant_id AND r.order_id = NEW.id AND r.entry_type IN ('REFUND', 'HOLD'))
            AND EXISTS (SELECT 1 FROM cashback_ledger c JOIN audit_logs a ON a.tenant_id = c.tenant_id AND a.order_id = c.order_id
                         WHERE c.tenant_id = NEW.tenant_id AND c.order_id = NEW.id AND c.entry_type = 'REDEEM'
                           AND c.amount = NEW.discount_amount - OLD.discount_amount
                           AND a.action_type = 'CASHBACK_REDEEMED' AND a.authorized_by_manager_id IS NULL
                           AND COALESCE(a.metadata->>'server_verified', '') <> 'true'
                           AND (a.metadata->>'discount_before')::NUMERIC = OLD.discount_amount
                           AND (a.metadata->>'discount_after')::NUMERIC = NEW.discount_amount)) THEN
            RAISE EXCEPTION 'TCHEFOOD_DESCONTO: o desconto desta conta na nuvem é R$ % e este aparelho mandou R$ % (outro aparelho ou o cashback mudou a conta). Use o desconto da nuvem antes de cobrar.',
                to_char(OLD.discount_amount, 'FM999999990.00'), to_char(NEW.discount_amount, 'FM999999990.00');
        END IF;
        -- Sem cashback, o aumento é conferido por tchefood_require_order_audit (PIN de gerente).
        IF COALESCE(v_ok, false) THEN NEW.discount_auth_seq := v_auth_seq; END IF;
        RETURN NEW;
    END IF;
    -- Redução que só limita o desconto ao bruto que a conta terá com esta mesma atualização
    -- (os 10% vindo junto, pela regra de tchefood_recalc_order): é o que o banco faria no
    -- recálculo, então não apaga nada. A retirada dos 10% é conferida pelo seu gatilho.
    SELECT COALESCE(SUM(total_item_price), 0) INTO v_subtotal
      FROM order_items WHERE order_id = NEW.id AND status <> 'CANCELED';
    v_fee := CASE WHEN NEW.charge_service_fee THEN round(v_subtotal * NEW.service_fee_pct / 100, 2) ELSE 0 END;
    IF NEW.discount_amount = LEAST(OLD.discount_amount, v_subtotal + v_fee) THEN
        RETURN NEW;
    END IF;
    -- Outra redução: só com a troca autorizada e nunca em conta com cashback. Qualquer outra
    -- é um conflito: o aparelho tem um desconto antigo. Recusa (em vez de ignorar) para o
    -- aparelho saber antes de cobrar; a fila segura o resto da conta e o gerente adota o
    -- desconto da nuvem em Nuvem › recusados.
    IF NOT COALESCE(v_ok, false) OR v_redeemed > 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_DESCONTO: o desconto desta conta na nuvem é R$ % e este aparelho mandou R$ % (outro aparelho ou o cashback mudou a conta). Use o desconto da nuvem antes de cobrar.',
            to_char(OLD.discount_amount, 'FM999999990.00'), to_char(NEW.discount_amount, 'FM999999990.00');
    END IF;
    NEW.discount_auth_seq := v_auth_seq;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_00_keep_discount ON orders;
CREATE TRIGGER trg_orders_00_keep_discount BEFORE UPDATE OF discount_amount, discount_auth_seq ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_orders_keep_discount();

-- Estorno do cashback (decisão do Will, 10/11/2026: "devolva"). Quando o cancelamento de
-- item deixa o desconto da conta abaixo do cashback que ela consumiu, a diferença volta
-- para o cliente como lançamento REFUND: crédito com saldo próprio. O EARN original não é
-- tocado (o extrato continua somente inserção). Cada estorno grava um audit_log
-- CASHBACK_REFUNDED.
-- Validade (decisão do Will, 10/11/2026): o cashback vale 30 dias de quando foi gerado,
-- com ou sem cancelamento. O estorno não ganha prazo novo: cada parte volta com o
-- valid_from e o expires_at do crédito de onde saiu (redeem_sources do resgate). Parte de
-- crédito já vencido volta vencida (fica no extrato, não entra no saldo). Volta primeiro
-- o crédito que vence por último (desfaz o resgate na ordem inversa da baixa).
-- Parte sem origem comprovada (P0-03 da rodada 8 do GPT: parte já baixada por aparelho da
-- versão anterior, source_id NULL, ou crédito de origem não encontrado nesta loja): não
-- volta ao saldo, nem com a validade de outro crédito nem com prazo novo. Fica retida para
-- conciliação: lançamento HOLD (sem saldo e sem validade, fora do saldo do cliente)
-- e audit_log CASHBACK_REFUND_HELD com o valor e o motivo. O gerente confere com o cliente.
-- O HOLD não aponta para crédito nenhum (refund_of_id NULL, P2-01 da rodada 9 do GPT): um
-- UUID que não existe quebraria a FK e um de outra loja seria vínculo cruzado; os UUIDs
-- informados no resgate ficam em metadata.reported_source_ids.
-- Desconto manual (P0-02 da rodada 8 do GPT): o desconto da conta é o manual mais o
-- cashback ainda aplicado (resgatado − já devolvido ou retido). Quando o desconto cai, o
-- desconto manual fica (até o novo desconto) e o cashback é que absorve a queda: devolve
-- (cashback aplicado antes) − (novo desconto − manual que fica). Ex.: bruto 100, manual
-- 10, resgate 45 (desconto 55); cancelamento deixa o bruto em 20: manual 10, cashback 10,
-- devolve 35.
-- Idempotente: o valor sai do extrato e do desconto antes/depois, com a conta travada; o
-- reenvio do mesmo cancelamento não muda o desconto (o gatilho só roda quando o desconto
-- cai) e não estorna de novo. Gatilho (não função chamável): o aparelho não consegue pedir estorno
-- com um valor seu.
CREATE OR REPLACE FUNCTION tchefood_orders_cashback_refund()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_redeem cashback_ledger%ROWTYPE;
    v_refunded NUMERIC(10,2);
    v_amount NUMERIC(10,2);
    v_left NUMERIC(10,2);
    v_back NUMERIC(10,2);
    v_take NUMERIC(10,2);
    v_from TIMESTAMPTZ;
    v_until TIMESTAMPTZ;
    v_refund_id UUID;
    v_user UUID;
    v_manager UUID;
    v_cause TEXT;
    v_cause_audit UUID;
    v_item UUID;
    v_now TIMESTAMPTZ := NOW();
    v_applied NUMERIC(10,2);
    v_manual_before NUMERIC(10,2);
    v_manual_after NUMERIC(10,2);
    v_unproven NUMERIC;
    v_unproven_ids JSONB;
    s RECORD;
BEGIN
    SELECT * INTO v_redeem FROM cashback_ledger
     WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id AND entry_type = 'REDEEM';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT COALESCE(SUM(amount), 0) INTO v_refunded FROM cashback_ledger
     WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id AND entry_type IN ('REFUND', 'HOLD');
    -- Cashback ainda aplicado na conta e o desconto manual que fica (P0-02 da rodada 8).
    v_applied := GREATEST(v_redeem.amount - v_refunded, 0);
    v_manual_before := GREATEST(OLD.discount_amount - v_applied, 0);
    v_manual_after := LEAST(v_manual_before, GREATEST(NEW.discount_amount, 0));
    v_amount := v_applied - (NEW.discount_amount - v_manual_after);
    IF v_amount <= 0 THEN RETURN NULL; END IF;
    -- O que provocou o estorno (P2-01 da rodada 5 do GPT), com o operador e o gerente dele:
    --  - retirada dos 10% nesta mesma atualização: o SERVICE_FEE_REMOVED mais recente da
    --    conta (é ele que libera a retirada, pela sequência do servidor);
    --  - cancelamento de item: o recálculo do banco roda dentro do cancelamento, que marca
    --    o item (tchefood_cashback_mark_cancel); vale o ITEM_CANCELED desse item. Sem ele
    --    ainda gravado (o registro pode vir depois na mesma transação), quem cancelou o item.
    -- Sem causa conhecida, fica o operador do resgate e a causa nula.
    IF OLD.charge_service_fee AND NOT NEW.charge_service_fee THEN
        v_cause := 'SERVICE_FEE_REMOVED';
        SELECT a.id, a.performed_by_user_id, a.authorized_by_manager_id INTO v_cause_audit, v_user, v_manager
          FROM audit_logs a
         WHERE a.tenant_id = NEW.tenant_id AND a.order_id = NEW.id AND a.action_type = 'SERVICE_FEE_REMOVED'
         ORDER BY a.server_seq DESC LIMIT 1;
    ELSE
        BEGIN
            v_item := NULLIF(current_setting('tchefood.cashback_cancel_item', true), '')::uuid;
        EXCEPTION WHEN others THEN
            v_item := NULL;
        END;
        IF v_item IS NOT NULL THEN
            v_cause := 'ITEM_CANCELED';
            SELECT a.id, a.performed_by_user_id, a.authorized_by_manager_id INTO v_cause_audit, v_user, v_manager
              FROM audit_logs a
             WHERE a.tenant_id = NEW.tenant_id AND a.order_id = NEW.id AND a.action_type = 'ITEM_CANCELED'
               AND a.metadata->>'item_id' = v_item::text
             ORDER BY a.server_seq DESC LIMIT 1;
            IF v_user IS NULL THEN
                SELECT i.canceled_by_user_id INTO v_user FROM order_items i WHERE i.id = v_item AND i.order_id = NEW.id;
            END IF;
        END IF;
    END IF;
    v_user := COALESCE(v_user, v_redeem.created_by_user_id);
    v_left := v_amount;
    -- Origem comprovada = crédito desta loja, com validade (refund_of_id aponta para ele).
    -- O que não tem origem comprovada (source_id NULL, UUID que não existe no extrato ou
    -- que é de outra loja: P2-01 da rodada 9 do GPT) vira um único balde de retenção
    -- (HOLD) com refund_of_id NULL, para não violar a FK nem ligar o estorno a um
    -- lançamento de outra loja; os UUIDs informados ficam em audit_logs.metadata
    -- (reported_source_ids). Os HOLD desta conta somados dão o que o balde já reteve, e
    -- é isso que deixa o reenvio idempotente.
    FOR s IN
        SELECT (x->>'source_id')::uuid AS source_id, (x->>'amount')::numeric AS taken,
               l.id AS proven_id, l.valid_from, l.expires_at, l.created_at
          FROM jsonb_array_elements(COALESCE(v_redeem.redeem_sources,
                 jsonb_build_array(jsonb_build_object('source_id', NULL, 'amount', v_redeem.amount)))) x
          LEFT JOIN cashback_ledger l ON l.id = (x->>'source_id')::uuid AND l.tenant_id = NEW.tenant_id
                                     AND l.valid_from IS NOT NULL AND l.expires_at IS NOT NULL
         WHERE l.id IS NOT NULL
         ORDER BY l.expires_at DESC, l.created_at DESC
    LOOP
        EXIT WHEN v_left <= 0;
        SELECT COALESCE(SUM(amount), 0) INTO v_back FROM cashback_ledger
         WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id AND entry_type = 'REFUND'
           AND refund_of_id = s.proven_id;
        v_take := LEAST(s.taken - v_back, v_left);
        CONTINUE WHEN v_take <= 0;
        v_from := s.valid_from;
        v_until := s.expires_at;
        INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount,
                                     valid_from, expires_at, created_by_user_id, created_at, refund_of_id)
        VALUES (NEW.tenant_id, v_redeem.customer_id, NEW.id, 'REFUND', v_take, v_take,
                v_from, v_until, v_user, v_now, s.proven_id)
        RETURNING id INTO v_refund_id;
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact,
                                reason, whatsapp_alert_sent, metadata, created_at)
        VALUES (NEW.tenant_id, NEW.id, v_user, v_manager, 'CASHBACK_REFUNDED', v_take,
                CASE v_cause
                    WHEN 'SERVICE_FEE_REMOVED' THEN 'Cashback devolvido ao cliente (retirada dos 10% deixou o desconto abaixo do cashback usado)'
                    WHEN 'ITEM_CANCELED' THEN 'Cashback devolvido ao cliente (cancelamento de item deixou o desconto abaixo do cashback usado)'
                    ELSE 'Cashback devolvido ao cliente (o desconto da conta ficou abaixo do cashback usado)' END, FALSE,
                jsonb_build_object('customer_id', v_redeem.customer_id, 'amount', v_take, 'redeem_id', v_redeem.id,
                                   'refund_id', v_refund_id, 'refund_of_id', s.proven_id,
                                   'expires_at', v_until, 'already_expired', v_until <= v_now,
                                   'redeemed', v_redeem.amount, 'refunded_before', v_refunded,
                                   'cashback_applied_before', v_applied,
                                   'manual_discount_before', v_manual_before, 'manual_discount_after', v_manual_after,
                                   'discount_before', OLD.discount_amount, 'discount_after', NEW.discount_amount,
                                   'cause', v_cause, 'cause_audit_id', v_cause_audit,
                                   'item_cancel_audit_id', CASE WHEN v_cause = 'ITEM_CANCELED' THEN v_cause_audit END,
                                   'canceled_item_id', CASE WHEN v_cause = 'ITEM_CANCELED' THEN v_item END,
                                   'service_fee_audit_id', CASE WHEN v_cause = 'SERVICE_FEE_REMOVED' THEN v_cause_audit END,
                                   'server_verified', TRUE),
                v_now);
        v_refunded := v_refunded + v_take;
        v_left := v_left - v_take;
    END LOOP;
    IF v_left > 0 THEN
        SELECT COALESCE(SUM((x->>'amount')::numeric), 0),
               COALESCE(jsonb_agg(x->'source_id' ORDER BY ord) FILTER (WHERE x->>'source_id' IS NOT NULL), '[]'::jsonb)
          INTO v_unproven, v_unproven_ids
          FROM jsonb_array_elements(COALESCE(v_redeem.redeem_sources,
                 jsonb_build_array(jsonb_build_object('source_id', NULL, 'amount', v_redeem.amount)))) WITH ORDINALITY AS t(x, ord)
         WHERE NOT EXISTS (SELECT 1 FROM cashback_ledger l
                            WHERE l.id = (x->>'source_id')::uuid AND l.tenant_id = NEW.tenant_id
                              AND l.valid_from IS NOT NULL AND l.expires_at IS NOT NULL);
        SELECT COALESCE(SUM(amount), 0) INTO v_back FROM cashback_ledger
         WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id AND entry_type = 'HOLD';
        v_take := LEAST(v_unproven - v_back, v_left);
        IF v_take > 0 THEN
            INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount,
                                         valid_from, expires_at, created_by_user_id, created_at, refund_of_id)
            VALUES (NEW.tenant_id, v_redeem.customer_id, NEW.id, 'HOLD', v_take, 0,
                    NULL, NULL, v_user, v_now, NULL)
            RETURNING id INTO v_refund_id;
            INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact,
                                    reason, whatsapp_alert_sent, metadata, created_at)
            VALUES (NEW.tenant_id, NEW.id, v_user, v_manager, 'CASHBACK_REFUND_HELD', v_take,
                    'Cashback a devolver retido para conciliação: o crédito de onde saiu não está comprovado (resgate da versão anterior do aparelho). Não volta ao saldo até o gerente conferir com o cliente.',
                    FALSE,
                    jsonb_build_object('customer_id', v_redeem.customer_id, 'amount', v_take, 'redeem_id', v_redeem.id,
                                       'hold_id', v_refund_id, 'refund_of_id', NULL,
                                       'reported_source_ids', v_unproven_ids,
                                       'reconciliation', 'PENDING',
                                       'reason_code', CASE WHEN jsonb_array_length(v_unproven_ids) = 0 THEN 'SOURCE_UNKNOWN' ELSE 'SOURCE_NOT_FOUND' END,
                                       'redeemed', v_redeem.amount, 'refunded_before', v_refunded,
                                       'cashback_applied_before', v_applied,
                                       'manual_discount_before', v_manual_before, 'manual_discount_after', v_manual_after,
                                       'discount_before', OLD.discount_amount, 'discount_after', NEW.discount_amount,
                                       'cause', v_cause, 'cause_audit_id', v_cause_audit,
                                       'server_verified', TRUE),
                    v_now);
            v_refunded := v_refunded + v_take;
            v_left := v_left - v_take;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
-- Marca, na transação, o item cujo cancelamento vai recalcular a conta: o estorno do
-- cashback (acima) sabe qual cancelamento o provocou. Só marca; não muda nada do item.
CREATE OR REPLACE FUNCTION tchefood_cashback_mark_cancel()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'CANCELED' AND OLD.status IS DISTINCT FROM 'CANCELED' THEN
        PERFORM set_config('tchefood.cashback_cancel_item', NEW.id::text, true);
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_cashback_mark_cancel ON order_items;
CREATE TRIGGER trg_order_items_cashback_mark_cancel BEFORE UPDATE OF status ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_cashback_mark_cancel();

DROP TRIGGER IF EXISTS trg_orders_cashback_refund ON orders;
CREATE TRIGGER trg_orders_cashback_refund AFTER UPDATE OF discount_amount ON orders
    FOR EACH ROW WHEN (NEW.discount_amount < OLD.discount_amount)
    EXECUTE FUNCTION tchefood_orders_cashback_refund();

-- Extrato aceita o REFUND: crédito com validade e saldo próprio (como o EARN), vários por
-- conta (um por cancelamento). Um crédito e um resgate por conta continuam valendo. As
-- restrições originais (schema_expansion.sql) têm nome gerado pelo banco: são achadas
-- pela definição e trocadas pelas de nome fixo, uma vez só.
DO $$
DECLARE r RECORD;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashback_ledger_entry_type_refund') THEN
        FOR r IN SELECT conname FROM pg_constraint
                  WHERE conrelid = 'cashback_ledger'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%entry_type%' LOOP
            EXECUTE format('ALTER TABLE cashback_ledger DROP CONSTRAINT %I', r.conname);
        END LOOP;
        FOR r IN SELECT c.conname FROM pg_constraint c
                  WHERE c.conrelid = 'cashback_ledger'::regclass AND c.contype = 'u'
                    AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                          WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['entry_type', 'order_id'] LOOP
            EXECUTE format('ALTER TABLE cashback_ledger DROP CONSTRAINT %I', r.conname);
        END LOOP;
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_entry_type_refund
            CHECK (entry_type IN ('EARN', 'REDEEM', 'EXPIRE', 'REFUND'));
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_credit_validity
            CHECK (entry_type NOT IN ('EARN', 'REFUND') OR (valid_from IS NOT NULL AND expires_at > valid_from AND remaining_amount <= amount));
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_debit_no_balance
            CHECK (entry_type IN ('EARN', 'REFUND') OR remaining_amount = 0);
    END IF;
END $$;
-- Devolução retida para conciliação (HOLD, P0-03 da rodada 8 do GPT): sem saldo
-- (remaining_amount 0, pela restrição acima) e sem validade; não entra no saldo do cliente.
DO $$
BEGIN
    IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'cashback_ledger_entry_type_refund')) NOT LIKE '%HOLD%' THEN
        ALTER TABLE cashback_ledger DROP CONSTRAINT cashback_ledger_entry_type_refund;
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_entry_type_refund
            CHECK (entry_type IN ('EARN', 'REDEEM', 'EXPIRE', 'REFUND', 'HOLD'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashback_ledger_hold_no_validity') THEN
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_hold_no_validity
            CHECK (entry_type <> 'HOLD' OR (valid_from IS NULL AND expires_at IS NULL));
    END IF;
    -- HOLD não aponta para crédito nenhum (P2-01 da rodada 9 do GPT): a origem não está
    -- comprovada; o UUID informado no resgate fica só em audit_logs.metadata.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashback_ledger_hold_no_link') THEN
        ALTER TABLE cashback_ledger ADD CONSTRAINT cashback_ledger_hold_no_link
            CHECK (entry_type <> 'HOLD' OR refund_of_id IS NULL);
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS cashback_ledger_one_earn_redeem_per_order
    ON cashback_ledger (order_id, entry_type) WHERE entry_type IN ('EARN', 'REDEEM', 'EXPIRE');

-- Saldo exibido do cliente (cache do extrato): o banco calcula, o valor do aparelho não
-- vale. Sem isso, a atualização do cliente que sobe depois do resgate gravaria o saldo
-- antigo do aparelho por cima de um crédito novo de outro aparelho.
CREATE OR REPLACE FUNCTION tchefood_refresh_cashback_balance(p_customer_id UUID)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE loyalty_customers c SET cashback_balance =
        (SELECT COALESCE(SUM(l.remaining_amount), 0) FROM cashback_ledger l
          WHERE l.tenant_id = c.tenant_id AND l.customer_id = c.id AND l.entry_type IN ('EARN', 'REFUND') AND l.expires_at > NOW())
     WHERE c.id = p_customer_id
$$;
CREATE OR REPLACE FUNCTION tchefood_loyalty_balance_from_ledger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    NEW.cashback_balance := (SELECT COALESCE(SUM(l.remaining_amount), 0) FROM cashback_ledger l
                              WHERE l.tenant_id = NEW.tenant_id AND l.customer_id = NEW.id
                                AND l.entry_type IN ('EARN', 'REFUND') AND l.expires_at > NOW());
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

-- Leitura do cashback pelo aparelho (P2-01 da rodada 11 do GPT): clientes e extrato num
-- único SELECT, então numa única foto do banco. A leitura em páginas (limit/offset, uma
-- requisição por página) podia repetir um lançamento e perder outro quando um crédito
-- entrava no meio, e o aparelho trocava o extrato dele por essa leitura. Roda com o papel
-- de quem chama (a RLS da loja vale) e só devolve a loja do token. p_customer_id
-- restringe a um cliente (conferência do desfazer de resgate da versão anterior).
CREATE OR REPLACE FUNCTION tchefood_cashback_snapshot(p_customer_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
    WITH c AS (
        SELECT id, tenant_id, name, phone_whatsapp, cpf, whatsapp_opt_in, opt_in_at, cashback_balance, total_spent,
               visits_count, last_visit_at, created_at
          FROM loyalty_customers
         WHERE tenant_id = tchefood_tenant() AND (p_customer_id IS NULL OR id = p_customer_id)
    ), l AS (
        SELECT id, tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, base_amount, pct, valid_from,
               expires_at, created_by_user_id, created_at, redeem_sources, refund_of_id
          FROM cashback_ledger
         WHERE tenant_id = tchefood_tenant() AND (p_customer_id IS NULL OR customer_id = p_customer_id)
    )
    SELECT jsonb_build_object(
        'loyalty_customers', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM c), '[]'::jsonb),
        'cashback_ledger', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM l), '[]'::jsonb));
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_register_cashback_redeem(UUID, UUID, UUID, UUID, NUMERIC, UUID, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_register_cashback_redeem(UUID, UUID, UUID, UUID, NUMERIC, UUID, TIMESTAMPTZ, BOOLEAN) TO authenticated;
        -- A função antiga roda com o papel de quem chama e agora é recusada pelo gatilho: fica só para o servidor.
        REVOKE ALL ON FUNCTION tchefood_redeem_cashback(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_cashback_now() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_loyalty_balance_from_ledger() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_orders_cashback_refund() FROM PUBLIC, anon, authenticated;
        REVOKE DELETE ON cashback_ledger FROM anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_cashback_snapshot(UUID) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_cashback_snapshot(UUID) TO authenticated;
    END IF;
END $$;
