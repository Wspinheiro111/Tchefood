-- =============================================================================
-- Tchê Food — a cobrança aberta na Point Smart reserva o saldo para qualquer forma de pagamento
-- Aplicar depois de db/schema_mercado_pago.sql. Idempotente: pode rodar de novo.
-- Espelho TypeScript: src/lib/payments/pointReservation.ts (aviso e trava no caixa).
-- =============================================================================
-- Decisão do Will (12/11/2026): enquanto houver cobrança da Point em andamento numa conta
-- (criando, na fila, na maquininha, em revisão manual, ou aprovada e ainda sem o pagamento
-- registrado), o valor dela não pode ser pago de novo em dinheiro, Pix, outra maquininha ou
-- outra cobrança. Antes, só uma cobrança nova na Point respeitava a reserva
-- (tchefood_open_terminal_charge); dinheiro e outra maquininha entravam pelo saldo cheio.
--
-- 1. tchefood_point_reserved_cents: a soma reservada, com a MESMA regra de
--    tchefood_open_terminal_charge (db/schema_mercado_pago.sql). Uma cobrança pode ser deixada
--    de fora pela chave: é o pagamento da própria cobrança aprovada, que consome a reserva dela.
--    Auditoria r4 P0-01: só consome a reserva o pagamento APROVADO do Mercado Pago com a chave
--    da cobrança (conferido com ela por trg_payments_mercado_pago). Dinheiro, Pix ou outra
--    maquininha com a mesma chave não consome nada (e nem entra: ver o gatilho).
-- 2. Gatilho em payments (BEFORE INSERT OR UPDATE OF status, amount, order_id, tenant_id,
--    idempotency_key, acquirer): pagamento
--    aprovado só entra até o saldo da conta menos a reserva das outras cobranças da Point. A
--    conta é travada (FOR UPDATE) antes da soma: tchefood_open_terminal_charge trava a mesma
--    linha, então cobrança nova e pagamento na mesma conta não passam juntos do saldo. Cobrança
--    que termina (recusada, cancelada, expirada, estornada) deixa de reservar; nunca acontece o
--    contrário (nada volta a reservar sem passar pela trava da conta).
--    Auditoria r4 P0-01: o UPDATE também passa pela conferência quando o pagamento VIRA aprovado,
--    quando o valor aprovado sobe, quando ele muda de conta, de loja, de chave ou de credenciadora.
--    Conta de outra loja é recusada no UPDATE. No INSERT e no UPDATE, só o pagamento do Mercado Pago
--    (conferido com a cobrança aprovada por trg_payments_mercado_pago) usa a chave de uma cobrança
--    da Point e deixa a própria cobrança de fora da soma: dinheiro, Pix ou outra maquininha aprovado
--    com essa chave é recusado, senão "consumiria" a reserva dela. No UPDATE, o saldo gravado em
--    orders já desconta o próprio pagamento (o recálculo roda AFTER, sobre o OLD): a conta é
--    refeita sem a linha (total da conta menos os OUTROS pagamentos aprovados), para o valor
--    dela não ser contado duas vezes.
-- 3. tchefood_point_reservation(conta): o aparelho lê a reserva da conta da própria loja
--    para mostrar "há uma cobrança na Point em andamento nesta conta" e não aceitar o valor
--    reservado antes de mandar para o servidor.
-- =============================================================================

CREATE OR REPLACE FUNCTION tchefood_point_reserved_cents(p_tenant UUID, p_order UUID, p_exclude_key VARCHAR)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(SUM(c.amount_cents), 0)::BIGINT FROM terminal_charges c
     WHERE c.tenant_id = p_tenant AND c.order_id = p_order
       AND c.idempotency_key IS DISTINCT FROM p_exclude_key
       AND (c.status IN ('creating', 'pending', 'at_terminal', 'manual_review')
            OR (c.status = 'approved' AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = c.idempotency_key AND p.status = 'APPROVED'
                  AND p.acquirer::text = 'MERCADO_PAGO')));
$$;

CREATE OR REPLACE FUNCTION tchefood_point_reservation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_order orders%ROWTYPE;
    v_balance NUMERIC(10,2);
    v_others NUMERIC(10,2);
    v_reserved BIGINT;
    v_free BIGINT;
    v_found BOOLEAN;
BEGIN
    IF NEW.status <> 'APPROVED' THEN
        RETURN NEW;
    END IF;
    -- UPDATE: só confere o que pode tirar dinheiro da reserva: virar aprovado, subir o valor aprovado ou
    -- trocar de conta, de loja, de chave ou de credenciadora. Mexer em outro campo de um pagamento já
    -- aprovado não reabre a conferência.
    IF TG_OP = 'UPDATE' AND OLD.status = 'APPROVED' AND NEW.amount <= OLD.amount
       AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
       AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key AND NEW.acquirer IS NOT DISTINCT FROM OLD.acquirer THEN
        RETURN NEW;
    END IF;
    -- tchefood_register_payment já travou a conta; travar de novo na mesma transação não custa nada
    -- e protege qualquer outro caminho que grave pagamento. A trava vem antes da conferência da chave:
    -- tchefood_open_terminal_charge grava a cobrança com a mesma conta travada, então a chave que nasce
    -- junto com este pagamento já aparece aqui.
    SELECT * INTO v_order FROM orders WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id FOR UPDATE;
    v_found := FOUND;
    -- A chave de uma cobrança da Point só serve ao pagamento do Mercado Pago dela (conferido por
    -- trg_payments_mercado_pago). Outro pagamento aprovado com essa chave tiraria a reserva da cobrança
    -- sem a cobrança ter sido paga. Vale no INSERT (inclusive tchefood_register_payment, do aparelho) e no UPDATE.
    IF NEW.acquirer::text <> 'MERCADO_PAGO'
       AND EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é de uma cobrança da Point; só o pagamento dela no Mercado Pago usa essa chave.', NEW.idempotency_key;
    END IF;
    IF NOT v_found THEN
        IF TG_OP = 'UPDATE' THEN
            -- Pagamento aprovado que muda de loja (ou de conta) para uma conta que não é da loja dele: a
            -- reserva seria somada na loja errada.
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta do pagamento não é da loja dele.';
        END IF;
        RETURN NEW; -- a conta é conferida por quem grava (tchefood_register_payment e a FK)
    END IF;
    -- Só o pagamento do Mercado Pago deixa a própria cobrança de fora da soma (é ele que a consome).
    v_reserved := tchefood_point_reserved_cents(NEW.tenant_id, NEW.order_id,
        CASE WHEN NEW.acquirer::text = 'MERCADO_PAGO' THEN NEW.idempotency_key END);
    IF v_reserved = 0 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        v_balance := v_order.remaining_balance;
    ELSE
        -- O saldo gravado já desconta esta linha se ela era aprovada nesta conta (o recálculo de
        -- trg_payments_recalc roda AFTER, sobre o OLD). Refaz sem ela: total da conta menos os OUTROS
        -- pagamentos aprovados, a mesma conta de tchefood_recalc_order (db/schema.sql).
        SELECT COALESCE(SUM(p.amount), 0) INTO v_others FROM payments p
         WHERE p.order_id = NEW.order_id AND p.status = 'APPROVED' AND p.id <> OLD.id;
        v_balance := GREATEST(v_order.total_amount - v_others, 0);
    END IF;
    v_free := round(v_balance * 100)::BIGINT - v_reserved;
    IF round(NEW.amount * 100)::BIGINT > v_free THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: há uma cobrança na Point em andamento nesta conta (R$ % reservado). Livre para este pagamento: R$ %.',
            to_char(v_reserved / 100.0, 'FM999999990.00'), to_char(GREATEST(v_free, 0) / 100.0, 'FM999999990.00');
    END IF;
    RETURN NEW;
END;
$$;

-- CREATE OR REPLACE: reaplicar o arquivo não deixa a tabela um instante sem o gatilho (e troca a versão
-- antiga, só de INSERT, por esta, que também confere o UPDATE).
CREATE OR REPLACE TRIGGER trg_payments_point_reservation BEFORE INSERT OR UPDATE OF status, amount, order_id, tenant_id, idempotency_key, acquirer ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_point_reservation_guard();

-- Leitura do aparelho: só a conta da própria loja (tenant do token).
CREATE OR REPLACE FUNCTION tchefood_point_reservation(p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_open INT;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    SELECT COUNT(*)::INT INTO v_open FROM terminal_charges c
     WHERE c.tenant_id = v_tenant AND c.order_id = p_order
       AND (c.status IN ('creating', 'pending', 'at_terminal', 'manual_review')
            OR (c.status = 'approved' AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = c.idempotency_key AND p.status = 'APPROVED'
                  AND p.acquirer::text = 'MERCADO_PAGO')));
    RETURN jsonb_build_object(
        'reserved_cents', tchefood_point_reserved_cents(v_tenant, p_order, NULL),
        'open_charges', v_open,
        'manual_review', EXISTS (SELECT 1 FROM terminal_charges c WHERE c.tenant_id = v_tenant AND c.order_id = p_order AND c.status = 'manual_review'));
END;
$$;

DO $$
BEGIN
    REVOKE ALL ON FUNCTION tchefood_point_reserved_cents(UUID, UUID, VARCHAR) FROM PUBLIC;
    REVOKE ALL ON FUNCTION tchefood_point_reservation_guard() FROM PUBLIC;
    REVOKE ALL ON FUNCTION tchefood_point_reservation(UUID) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION tchefood_point_reserved_cents(UUID, UUID, VARCHAR) FROM anon;
        REVOKE ALL ON FUNCTION tchefood_point_reservation(UUID) FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_point_reserved_cents(UUID, UUID, VARCHAR) FROM authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_point_reservation(UUID) TO authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION tchefood_point_reserved_cents(UUID, UUID, VARCHAR) TO service_role;
        GRANT EXECUTE ON FUNCTION tchefood_point_reservation(UUID) TO service_role;
    END IF;
END $$;
