-- =============================================================================
-- Tchê Food — contas e mesas descem da nuvem para todos os aparelhos
-- Aplicar depois de db/schema_pin_equipe_trava.sql (e de todas as anteriores). Idempotente.
-- Espelho TypeScript: src/lib/sync/orderPull.ts.
--
-- Com 3 ou 4 aparelhos na loja, cada um precisa ver as contas abertas nos outros, a
-- mesa ocupada por outro garçom e a conta que o caixa já fechou. O banco é a fonte da
-- verdade do dinheiro: totais, pagamentos e situação da conta vêm daqui e o aparelho só
-- fica com a versão dele enquanto tem mudança da conta ainda não aceita (fila ou recusa).
--
--  1. tchefood_pull_orders(): uma foto só (um SELECT) das contas em aberto, das
--     encerradas nas últimas 24 h, das que o aparelho ainda tem em aberto (de qualquer
--     data), dos itens, pagamentos e entregas próprias delas e da ocupação das mesas.
--     Roda com o papel de quem chama (a RLS da loja vale) e só devolve a loja do token.
--  2. Duas contas na mesma mesa (dois aparelhos abriram a mesma mesa antes de um ver o
--     outro): a segunda conta é recusada (TCHEFOOD_MESA_OCUPADA). O aparelho dela passa
--     os itens para a conta que ficou na mesa (Retaguarda › Nuvem › recusados). A conta
--     aceita já ocupa a mesa na mesma transação (a mesa fica travada até o fim dela):
--     mesmo que as duas contas subam antes da atualização da mesa de cada aparelho, a
--     segunda vê a primeira e é recusada.
--  3. Mesa com conta aberta não é liberada nem apontada para outra conta por um evento
--     velho da fila de outro aparelho: a ocupação fica como está e o resto da linha
--     (cadastro) passa. Do mesmo jeito, uma mesa não volta a apontar para uma conta já
--     encerrada. O evento é aceito (não trava a fila) e a próxima leitura acerta o aparelho.
--  4. Conta encerrada (fechada ou cancelada) libera a mesa que aponta para ela no próprio
--     banco, como o fechamento pelo saldo (tchefood_auto_close) já fazia. Antes, a conta
--     encerrada pelo UPDATE da conta (conta zerada, taxa dispensada no fechamento) só
--     liberava a mesa quando o evento da mesa chegava; agora que a mesa desce para todos
--     os aparelhos, ela não pode ficar ocupada por uma conta encerrada. As mesas que já
--     estão assim são liberadas ao aplicar este arquivo.
--  5. Item novo não entra em conta já encerrada em outro aparelho (TCHEFOOD_CONTA_ENCERRADA):
--     o aparelho passa os itens para uma conta nova da mesa.
--  6. Item pago não volta a "não pago" por uma atualização velha de outro aparelho.
--  7. Item na cozinha não volta atrás (pronto/entregue) por uma atualização velha.
--  8. Os 10% retirados com PIN de gerente em outro aparelho não voltam por uma cópia velha
--     da conta: só a reativação registrada (SERVICE_FEE_RESTORED) traz a taxa de volta.
--  9. A conta não troca de mesa por UPDATE (o app não tem troca de mesa): a trava de uma conta
--     por mesa vale no INSERT e não pode ser contornada depois.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Leitura das contas e da ocupação das mesas
-- -----------------------------------------------------------------------------
-- As colunas são as dos tipos em src/types.ts (Order, OrderItem, Payment, OwnDelivery): nada além
-- delas desce, para o aparelho não reenviar numa atualização uma coluna que não conhece.
--
-- p_order_ids: contas que o aparelho tem em aberto. Elas descem como estão no banco mesmo
-- encerradas há mais de 24 h: um aparelho que ficou mais de um dia sem internet recebe o
-- fechamento feito em outro aparelho e libera a mesa (Codex no PR #54). Até 500 ids.
--
-- Entrega própria (own_deliveries) desce com a conta: a cozinha de outro aparelho só
-- prepara antes do pagamento o pedido de entrega paga na entrega, e sabe disso pela
-- entrega (Codex no PR #54).
DROP FUNCTION IF EXISTS tchefood_pull_orders();
CREATE OR REPLACE FUNCTION tchefood_pull_orders(p_order_ids JSONB DEFAULT '[]'::jsonb)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
    WITH asked AS (
        SELECT x::uuid AS id
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_order_ids) = 'array' THEN p_order_ids ELSE '[]'::jsonb END) x
         LIMIT 500
    ), o AS (
        SELECT id, tenant_id, table_id, opened_by_user_id, status, customer_count, customer_cpf, subtotal_items,
               charge_service_fee, service_fee_pct, service_fee_amount, discount_amount, total_amount, paid_amount,
               remaining_balance, nfce_status, nfce_key, opened_at, closed_at, pickup_number, pickup_name, fulfillment_type
          FROM orders
         WHERE tenant_id = tchefood_tenant()
           AND (status IN ('OPEN', 'PAYING') OR COALESCE(closed_at, opened_at) >= now() - interval '24 hours'
                OR id IN (SELECT id FROM asked))
    ), i AS (
        SELECT it.id, it.order_id, it.product_id, it.waiter_id, it.quantity, it.unit_price, it.modifiers_unit_price,
               it.total_item_price, it.meat_doneness, it.notes, it.sector, it.status, it.is_paid, it.origin, it.created_at,
               it.prepared_at, it.canceled_at, it.canceled_by_user_id, it.cancel_reason, it.weight_gross_grams,
               it.weight_tare_grams, it.weight_source, it.keg_volume_ml, it.combo_parent_item_id, it.priced_at,
               it.half_product_ids, it.modifier_option_ids
          FROM order_items it JOIN o ON o.id = it.order_id
    ), p AS (
        SELECT pa.id, pa.order_id, pa.tenant_id, pa.waiter_id, pa.terminal_id, pa.amount, pa.tip_amount, pa.method,
               pa.status, pa.acquirer, pa.acquirer_cnpj, pa.card_brand, pa.nsu, pa.authorization_code, pa.terminal_serial,
               pa.idempotency_key, pa.created_at
          FROM payments pa JOIN o ON o.id = pa.order_id
         WHERE pa.tenant_id = tchefood_tenant()
    ), d AS (
        SELECT od.id, od.tenant_id, od.order_id, od.customer_name, od.customer_phone, od.address, od.reference,
               od.zone_id, od.zone_name, od.delivery_fee, od.pay_on_delivery, od.change_for, od.status, od.courier_id,
               od.courier_fee, od.out_at, od.delivered_at, od.settlement_id, od.created_at
          FROM own_deliveries od JOIN o ON o.id = od.order_id
         WHERE od.tenant_id = tchefood_tenant()
    ), t AS (
        SELECT id, status, current_order_id, updated_at
          FROM dining_tables
         WHERE tenant_id = tchefood_tenant()
    )
    SELECT jsonb_build_object(
        'tenant_id', tchefood_tenant(),
        'server_now', now(),
        'orders', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.opened_at, o.id) FROM o), '[]'::jsonb),
        'order_items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at, i.id) FROM i), '[]'::jsonb),
        'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id) FROM p), '[]'::jsonb),
        'own_deliveries', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at, d.id) FROM d), '[]'::jsonb),
        'tables', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM t), '[]'::jsonb));
$$;

-- -----------------------------------------------------------------------------
-- 2. Uma conta aberta por mesa
-- -----------------------------------------------------------------------------
-- A mesa técnica (balcão, totem) nunca aponta para uma conta (current_order_id fica
-- NULL), então ela continua aceitando várias contas ao mesmo tempo.
CREATE OR REPLACE FUNCTION tchefood_order_table_free_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_table dining_tables%ROWTYPE;
    v_holder orders%ROWTYPE;
BEGIN
    IF NEW.status NOT IN ('OPEN', 'PAYING') THEN
        RETURN NEW;
    END IF;
    -- Reenvio da mesma conta (upsert da fila): o conflito de id decide, não esta trava.
    IF EXISTS (SELECT 1 FROM orders WHERE id = NEW.id) THEN
        RETURN NEW;
    END IF;
    -- A trava da mesa vale até o fim da transação: duas contas novas na mesma mesa passam
    -- aqui uma de cada vez, e a segunda já vê a primeira ocupando a mesa (gatilho abaixo).
    SELECT * INTO v_table FROM dining_tables WHERE id = NEW.table_id FOR UPDATE;
    IF NOT FOUND OR v_table.kind NOT IN ('TABLE', 'CARD') OR v_table.current_order_id IS NULL OR v_table.current_order_id = NEW.id THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_holder FROM orders WHERE id = v_table.current_order_id;
    IF FOUND AND v_holder.status IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_MESA_OCUPADA: % já está com outra conta aberta (aberta em outro aparelho). Passe os itens desta conta para a conta da mesa em Retaguarda › Nuvem.',
            v_table.label
            USING DETAIL = jsonb_build_object('table_id', v_table.id, 'holder_order_id', v_holder.id)::text;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_table_free ON orders;
CREATE TRIGGER trg_orders_table_free BEFORE INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_table_free_guard();

-- A conta aberta aceita ocupa a mesa (ou o cartão) na mesma transação. A atualização da
-- mesa que o aparelho manda logo depois chega com a mesma conta e só confirma a situação.
CREATE OR REPLACE FUNCTION tchefood_order_reserve_table()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('OPEN', 'PAYING') THEN
        UPDATE dining_tables t SET status = 'OCCUPIED', current_order_id = NEW.id, updated_at = NOW()
         WHERE t.id = NEW.table_id AND t.tenant_id = NEW.tenant_id AND t.kind IN ('TABLE', 'CARD')
           AND (t.current_order_id IS NULL
                OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = t.current_order_id AND o.status IN ('OPEN', 'PAYING')));
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_reserve_table ON orders;
CREATE TRIGGER trg_orders_reserve_table AFTER INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_reserve_table();

-- -----------------------------------------------------------------------------
-- 3. Ocupação da mesa não volta atrás por evento velho
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_table_occupancy_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_old_active BOOLEAN := FALSE;
    v_new orders%ROWTYPE;
BEGIN
    IF NEW.current_order_id IS NOT DISTINCT FROM OLD.current_order_id THEN
        -- Mesma conta: só a situação muda (ocupada, aguardando a conta). Conta já encerrada
        -- não deixa a mesa ocupada de novo.
        -- Com a conta aberta, a mesa só fica numa situação de mesa ocupada (ocupada, aguardando
        -- a conta, pagando): um evento velho que só troca a situação para livre ou suja, com a
        -- mesma conta, não libera a mesa (GPT, rodada 1 do PR #54).
        IF NEW.current_order_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status
           AND (NEW.status NOT IN ('OCCUPIED', 'WAITING_BILL', 'PAYING')
                OR NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.current_order_id AND status IN ('OPEN', 'PAYING'))) THEN
            RAISE NOTICE 'TCHEFOOD_MESA: a mesa % aponta para a conta % e a situação % não vale para ela; a situação fica como está.', OLD.id, NEW.current_order_id, NEW.status;
            NEW.status := OLD.status;
            NEW.updated_at := OLD.updated_at;
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.current_order_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM orders WHERE id = OLD.current_order_id AND status IN ('OPEN', 'PAYING')) INTO v_old_active;
    END IF;
    IF v_old_active THEN
        -- Conta aberta na mesa: nem liberar nem trocar de conta (aparelho que ainda não viu a conta).
        RAISE NOTICE 'TCHEFOOD_MESA: mesa % está com a conta % aberta; a ocupação fica como está.', OLD.id, OLD.current_order_id;
        NEW.status := OLD.status;
        NEW.current_order_id := OLD.current_order_id;
        NEW.updated_at := OLD.updated_at;
        RETURN NEW;
    END IF;
    IF NEW.current_order_id IS NOT NULL THEN
        SELECT * INTO v_new FROM orders WHERE id = NEW.current_order_id;
        IF NOT FOUND OR v_new.status NOT IN ('OPEN', 'PAYING') OR v_new.table_id <> NEW.id OR v_new.tenant_id <> NEW.tenant_id THEN
            -- Conta encerrada, de outra mesa ou inexistente: a mesa não passa a apontar para ela.
            RAISE NOTICE 'TCHEFOOD_MESA: conta % não está aberta nesta mesa; a ocupação da mesa % fica como está.', NEW.current_order_id, OLD.id;
            NEW.status := OLD.status;
            NEW.current_order_id := OLD.current_order_id;
            NEW.updated_at := OLD.updated_at;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dining_tables_occupancy ON dining_tables;
CREATE TRIGGER trg_dining_tables_occupancy BEFORE UPDATE OF status, current_order_id ON dining_tables
    FOR EACH ROW EXECUTE FUNCTION tchefood_table_occupancy_guard();

-- -----------------------------------------------------------------------------
-- 4. Conta encerrada libera a mesa
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_order_closed_frees_table()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('CLOSED', 'CANCELED') AND OLD.status IN ('OPEN', 'PAYING') THEN
        UPDATE dining_tables SET status = 'FREE', current_order_id = NULL, updated_at = NOW()
         WHERE id = NEW.table_id AND current_order_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_closed_frees_table ON orders;
CREATE TRIGGER trg_orders_closed_frees_table AFTER UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_closed_frees_table();

-- Mesas que já apontam para uma conta encerrada (ou que não existe mais): ficam livres.
UPDATE dining_tables t SET status = 'FREE', current_order_id = NULL, updated_at = NOW()
 WHERE t.current_order_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = t.current_order_id AND o.status IN ('OPEN', 'PAYING'));

-- -----------------------------------------------------------------------------
-- 5. Item novo não entra em conta já encerrada
-- -----------------------------------------------------------------------------
-- Com a conta aberta em dois aparelhos, A pode lançar um item enquanto B recebe a conta
-- toda: o item de A chegaria depois do fechamento, refaria o saldo e a conta ficaria
-- fechada devendo, com a mesa livre (Codex no PR #54). A conta é travada antes da
-- conferência (o pagamento que fecha a conta trava a mesma linha), então o item ou entra
-- antes do fechamento ou é recusado. O aparelho passa os itens recusados para uma conta
-- nova da mesa (Retaguarda › Nuvem › recusados). O reenvio de um item que já entrou (a
-- resposta se perdeu) não é recusado: a linha já existe e nada muda no saldo.
CREATE OR REPLACE FUNCTION tchefood_item_order_open_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status VARCHAR;
BEGIN
    IF EXISTS (SELECT 1 FROM order_items WHERE id = NEW.id) THEN
        RETURN NEW;
    END IF;
    SELECT status INTO v_status FROM orders WHERE id = NEW.order_id FOR UPDATE;
    IF v_status IN ('CLOSED', 'CANCELED') THEN
        RAISE EXCEPTION 'TCHEFOOD_CONTA_ENCERRADA: a conta % já foi % em outro aparelho; o item não entra nela.',
            NEW.order_id, CASE v_status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END
            USING DETAIL = json_build_object('order_id', NEW.order_id, 'status', v_status)::text;
    END IF;
    RETURN NEW;
END;
$$;
-- O nome com 000 roda antes dos outros gatilhos BEFORE INSERT de order_items (ordem alfabética):
-- a conta fica travada antes de qualquer outra conferência do item.
DROP TRIGGER IF EXISTS trg_order_items_000_order_open ON order_items;
CREATE TRIGGER trg_order_items_000_order_open BEFORE INSERT ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_item_order_open_guard();

-- -----------------------------------------------------------------------------
-- 6. Item pago não volta a "não pago"
-- -----------------------------------------------------------------------------
-- A atualização de cozinha de um aparelho manda o item inteiro, com o is_paid da cópia
-- dele. Se outro aparelho recebeu esse item antes de a cópia chegar, o is_paid = false
-- velho desmarcaria o pagamento por item (Codex no PR #54). Nenhum caminho do app nem do
-- banco desmarca um item pago (estorno é pelo pagamento), então o item fica pago e o resto
-- da linha (situação na cozinha) passa: a atualização não é recusada.
CREATE OR REPLACE FUNCTION tchefood_item_paid_stays()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.is_paid AND NOT NEW.is_paid THEN
        RAISE NOTICE 'TCHEFOOD_ITEM_PAGO: o item % já está pago e continua pago (atualização velha).', OLD.id;
        NEW.is_paid := TRUE;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_paid_stays ON order_items;
CREATE TRIGGER trg_order_items_paid_stays BEFORE UPDATE OF is_paid ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_item_paid_stays();

-- -----------------------------------------------------------------------------
-- 7. Item na cozinha não volta atrás
-- -----------------------------------------------------------------------------
-- O pagamento (e outras atualizações) de um aparelho manda o item inteiro, com a situação
-- da cópia dele. Se a cozinha de outro aparelho já marcou o item pronto ou entregue, a
-- cópia velha (PENDING) devolveria o item à fila da cozinha (Codex no PR #54). O app só
-- avança o item (PENDING → PREPARING → READY → DELIVERED), então a situação e a hora de
-- pronto mais adiantadas ficam, e o resto da linha passa: a atualização não é recusada.
-- Cancelamento (CANCELED) continua com as travas de schema.sql.
CREATE OR REPLACE FUNCTION tchefood_item_progress_stays()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_old INT := array_position(ARRAY['PENDING', 'PREPARING', 'READY', 'DELIVERED'], OLD.status::text);
    v_new INT := array_position(ARRAY['PENDING', 'PREPARING', 'READY', 'DELIVERED'], NEW.status::text);
BEGIN
    IF v_old IS NOT NULL AND v_new IS NOT NULL AND v_new < v_old THEN
        RAISE NOTICE 'TCHEFOOD_ITEM_COZINHA: o item % já está % e não volta para % (atualização velha).', OLD.id, OLD.status, NEW.status;
        NEW.status := OLD.status;
    END IF;
    IF OLD.prepared_at IS NOT NULL AND NEW.prepared_at IS NULL THEN
        NEW.prepared_at := OLD.prepared_at;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_progress_stays ON order_items;
CREATE TRIGGER trg_order_items_progress_stays BEFORE UPDATE OF status, prepared_at ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_item_progress_stays();

-- -----------------------------------------------------------------------------
-- 8. Os 10% retirados não voltam por uma cópia velha da conta
-- -----------------------------------------------------------------------------
-- A atualização da conta manda a linha inteira, com o charge_service_fee da cópia do
-- aparelho. Se A tirou os 10% com PIN de gerente e B ainda tem a cópia de antes, uma
-- mudança qualquer em B (pessoas na mesa, bandeja) devolveria a taxa e aumentaria a conta
-- sem ninguém pedir (Codex no PR #54). A reativação do app sempre registra
-- SERVICE_FEE_RESTORED antes da conta (restoreServiceFee), então a taxa só volta quando o
-- último registro de 10% da conta (ordem de gravação no servidor, server_seq, como em
-- tchefood_require_order_audit) é essa reativação. Senão a taxa fica como está e o resto
-- da linha passa: a atualização não é recusada. O nome com 000 roda antes de
-- trg_orders_00_keep_discount, que confere o desconto com a taxa que vai ficar.
CREATE OR REPLACE FUNCTION tchefood_order_fee_stays()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_last TEXT;
BEGIN
    IF NOT OLD.charge_service_fee AND NEW.charge_service_fee THEN
        SELECT a.action_type INTO v_last
          FROM audit_logs a
         WHERE a.order_id = NEW.id AND a.action_type IN ('SERVICE_FEE_REMOVED', 'SERVICE_FEE_RESTORED')
         ORDER BY a.server_seq DESC
         LIMIT 1;
        IF v_last IS DISTINCT FROM 'SERVICE_FEE_RESTORED' THEN
            RAISE NOTICE 'TCHEFOOD_TAXA: a conta % está sem os 10%% e continua sem (atualização velha, sem reativação registrada).', OLD.id;
            NEW.charge_service_fee := FALSE;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_000_fee_stays ON orders;
CREATE TRIGGER trg_orders_000_fee_stays BEFORE UPDATE OF charge_service_fee ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_fee_stays();

-- -----------------------------------------------------------------------------
-- 9. A conta não troca de mesa
-- -----------------------------------------------------------------------------
-- A trava de uma conta aberta por mesa (seção 2) confere a mesa no INSERT. Um UPDATE (ou
-- upsert) que mudasse table_id levaria uma conta para a mesa de outra sem passar pela trava,
-- e a mesa antiga continuaria apontando para ela (GPT, rodada 2 do PR #54). O app não troca
-- conta de mesa (a conta nasce na mesa e fica nela), então a troca é recusada; o reenvio com
-- a mesma mesa passa.
CREATE OR REPLACE FUNCTION tchefood_order_table_stays()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.table_id IS DISTINCT FROM OLD.table_id THEN
        RAISE EXCEPTION 'TCHEFOOD_MESA_TROCA: a conta % é da mesa % e não muda de mesa.', OLD.id, OLD.table_id
            USING DETAIL = json_build_object('order_id', OLD.id, 'table_id', OLD.table_id)::text;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_000_table_stays ON orders;
CREATE TRIGGER trg_orders_000_table_stays BEFORE UPDATE OF table_id ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_table_stays();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_order_closed_frees_table() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_pull_orders(JSONB) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_pull_orders(JSONB) TO authenticated;
        REVOKE ALL ON FUNCTION tchefood_order_table_free_guard() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_order_reserve_table() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_table_occupancy_guard() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_item_order_open_guard() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_item_paid_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_item_progress_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_order_fee_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_order_table_stays() FROM PUBLIC, anon, authenticated;
    END IF;
END $$;
