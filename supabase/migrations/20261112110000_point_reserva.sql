-- Cópia de db/schema_point_reserva.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
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
-- 2. Gatilho em payments (BEFORE INSERT): pagamento aprovado só entra até o saldo da conta
--    menos a reserva das outras cobranças da Point. A conta é travada (FOR UPDATE) antes da
--    soma: tchefood_open_terminal_charge trava a mesma linha, então cobrança nova e pagamento
--    na mesma conta não passam juntos do saldo. Cobrança que termina (recusada, cancelada,
--    expirada, estornada) deixa de reservar; nunca acontece o contrário (nada volta a reservar
--    sem passar pela trava da conta).
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
                SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = c.idempotency_key AND p.status = 'APPROVED')));
$$;

CREATE OR REPLACE FUNCTION tchefood_point_reservation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_balance NUMERIC(10,2);
    v_reserved BIGINT;
    v_free BIGINT;
BEGIN
    IF NEW.status <> 'APPROVED' THEN
        RETURN NEW;
    END IF;
    -- tchefood_register_payment já travou a conta; travar de novo na mesma transação não custa nada
    -- e protege qualquer outro caminho que grave pagamento.
    SELECT remaining_balance INTO v_balance FROM orders WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NEW; -- a conta é conferida por quem grava (tchefood_register_payment e a FK)
    END IF;
    v_reserved := tchefood_point_reserved_cents(NEW.tenant_id, NEW.order_id, NEW.idempotency_key);
    IF v_reserved = 0 THEN
        RETURN NEW;
    END IF;
    v_free := round(v_balance * 100)::BIGINT - v_reserved;
    IF round(NEW.amount * 100)::BIGINT > v_free THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: há uma cobrança na Point em andamento nesta conta (R$ % reservado). Livre para este pagamento: R$ %.',
            to_char(v_reserved / 100.0, 'FM999999990.00'), to_char(GREATEST(v_free, 0) / 100.0, 'FM999999990.00');
    END IF;
    RETURN NEW;
END;
$$;

-- CREATE OR REPLACE: reaplicar o arquivo não deixa a tabela um instante sem o gatilho.
CREATE OR REPLACE TRIGGER trg_payments_point_reservation BEFORE INSERT ON payments
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
                SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = c.idempotency_key AND p.status = 'APPROVED')));
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
