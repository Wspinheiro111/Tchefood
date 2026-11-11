-- =============================================================================
-- Tchê Food — autorização de desconto vale uma vez (conta sem cashback)
-- =============================================================================
-- Achado do Claude na rodada 7 do PR #35 (mesma fraqueza que o GPT apontou na conta com
-- cashback; o Will pediu a correção em PR próprio, 11/11/2026): tchefood_require_order_audit
-- aceitava o aumento do desconto pela última DISCOUNT_APPLIED da conta sempre que ela
-- conferia com o valor antes e depois. Depois de usada, a mesma autorização servia de novo:
-- desconto 0→5 autorizado; o cancelamento dos itens leva o desconto a 0 (o banco limita ao
-- bruto); itens novos; o aparelho manda 0→5 de novo, sem PIN, e o banco aceitava.
--
-- Agora orders.discount_auth_seq guarda a sequência do servidor (audit_logs.server_seq) da
-- última autorização de aumento de desconto usada na conta. Uma autorização só vale se for
-- mais nova que ela; ao valer, passa a ser a usada. O aparelho (anon/authenticated) não
-- altera o marcador. Reenvio da mesma atualização da conta não é aumento (o desconto já é
-- aquele) e não pede nada.
-- Aplicar depois de schema_expansion.sql. Idempotente.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_auth_seq BIGINT NOT NULL DEFAULT 0;

-- O marcador só muda pelo banco (gatilho abaixo, um nível de gatilho a mais).
CREATE OR REPLACE FUNCTION tchefood_orders_keep_discount_auth_seq()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated') AND pg_trigger_depth() = 1 THEN
        NEW.discount_auth_seq := OLD.discount_auth_seq;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_keep_discount_auth_seq ON orders;
CREATE TRIGGER trg_orders_keep_discount_auth_seq BEFORE UPDATE OF discount_auth_seq ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_orders_keep_discount_auth_seq();

-- Cópia da versão de schema_expansion.sql; muda só o aumento do desconto.
CREATE OR REPLACE FUNCTION tchefood_require_order_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_ok BOOLEAN;
    v_seq BIGINT;
    v_used BIGINT;
BEGIN
    IF OLD.charge_service_fee AND NOT NEW.charge_service_fee THEN
        v_ok := FALSE;
        SELECT (a.action_type = 'SERVICE_FEE_REMOVED' AND m.role IN ('MANAGER', 'OWNER') AND m.active)
          INTO v_ok
          FROM audit_logs a LEFT JOIN staff_users m ON m.id = a.authorized_by_manager_id
         WHERE a.order_id = NEW.id AND a.action_type IN ('SERVICE_FEE_REMOVED', 'SERVICE_FEE_RESTORED')
         ORDER BY a.server_seq DESC
         LIMIT 1;
        IF NOT COALESCE(v_ok, FALSE) THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: SERVICE_FEE_REMOVED sem PIN de gerente registrado em audit_logs.';
        END IF;
    END IF;
    IF NEW.discount_amount > OLD.discount_amount THEN
        v_ok := FALSE;
        -- O marcador lido da tabela agora (gatilho adiado, no fim da transação): dois aumentos
        -- na mesma transação não usam a mesma autorização.
        SELECT o.discount_auth_seq INTO v_used FROM orders o WHERE o.id = NEW.id;
        SELECT ((a.metadata->>'discount_before')::NUMERIC = OLD.discount_amount
                AND (a.metadata->>'discount_after')::NUMERIC = NEW.discount_amount
                AND m.role IN ('MANAGER', 'OWNER') AND m.active
                AND a.server_seq > COALESCE(v_used, 0)),
               a.server_seq
          INTO v_ok, v_seq
          FROM audit_logs a LEFT JOIN staff_users m ON m.id = a.authorized_by_manager_id
         WHERE a.order_id = NEW.id AND a.action_type = 'DISCOUNT_APPLIED'
         ORDER BY a.server_seq DESC
         LIMIT 1;
        IF COALESCE(v_ok, FALSE) THEN
            UPDATE orders SET discount_auth_seq = v_seq WHERE id = NEW.id;
        ELSE
            SELECT EXISTS (
                SELECT 1 FROM cashback_ledger c
                  JOIN audit_logs a ON a.order_id = c.order_id AND a.action_type = 'CASHBACK_REDEEMED'
                 WHERE c.order_id = NEW.id AND c.entry_type = 'REDEEM'
                   AND c.amount = NEW.discount_amount - OLD.discount_amount
                   AND (a.metadata->>'discount_before')::NUMERIC = OLD.discount_amount
                   AND (a.metadata->>'discount_after')::NUMERIC = NEW.discount_amount
            ) INTO v_ok;
        END IF;
        IF NOT COALESCE(v_ok, FALSE) THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: DISCOUNT_APPLIED sem PIN de gerente registrado em audit_logs (ou a autorização já foi usada nesta conta).';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
