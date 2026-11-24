-- =============================================================================
-- Tchê Food — a Point desativada na loja não recebe cobrança nova (conferido no banco, com a reserva)
-- Aplicar depois de db/schema_mercado_pago.sql e db/schema_point_reserva.sql. Idempotente: pode rodar de novo.
-- =============================================================================
-- Auditoria #59 r6 P1-01. A Edge Function point-charge lia pos_terminals.online, esperava a lista do Mercado Pago (até
-- 10 s) e só então reservava: a loja podia desativar a Point nesse intervalo e a cobrança nova ainda era reservada e
-- enviada. A conferência agora é de tchefood_open_terminal_charge, que trava a linha da maquininha (FOR SHARE) na mesma
-- transação da reserva. Só muda a conferência de cobrança NOVA (a chave já gravada devolve a cobrança que ficou, como
-- antes, sem olhar a Point). Recusa nova: TF010 (terminal_inactive na Edge Function). Todo o resto da função é o de
-- db/schema_mercado_pago.sql.
-- =============================================================================

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
    -- Auditoria 2 (segurança, P2-1): chave de outra loja (reserva, cobrança ou pagamento) é uma recusa só, a mesma de
    -- tchefood_claim_payment e do gatilho de payments (TF009, key_in_use), conferida aqui antes de qualquer coisa da
    -- conta: a loja não descobre o que outra loja fez com a chave (nem pela ordem das recusas).
    IF EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = p_key AND pc.tenant_id <> p_tenant)
       OR EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = p_key AND c.tenant_id <> p_tenant)
       OR EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = p_key AND p.tenant_id <> p_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', p_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
    END IF;
    IF EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = p_key AND pc.tenant_id = p_tenant) THEN
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
    -- Auditoria #59 r6 P1-01: cobrança NOVA só em Point ativa na loja, conferido AQUI, na mesma transação que grava a
    -- reserva. A linha da maquininha fica travada (FOR SHARE) até o fim desta transação: desativar a Point (UPDATE) espera
    -- a reserva gravar, e quem desativou antes é visto agora. A cópia lida pela Edge Function antes da conferência no
    -- Mercado Pago (até 10 s) é só um atalho. Cobrança já gravada (as duas conferências da chave acima) segue como estava.
    PERFORM 1 FROM pos_terminals t WHERE t.id = p_terminal AND t.tenant_id = p_tenant AND t.online FOR SHARE OF t;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: esta Point está desativada na loja. Nada foi cobrado: ative na aba Point Smart ou use outra maquininha.' USING ERRCODE = 'TF010';
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
        -- loja para o chamador conferir; de outra loja, não devolve nada (a recusa única da chave em uso, P2-1).
        SELECT id INTO v_id FROM terminal_charges WHERE idempotency_key = p_key AND tenant_id = p_tenant;
        IF v_id IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', p_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
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
