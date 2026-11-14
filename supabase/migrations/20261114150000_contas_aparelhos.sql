-- Cópia de db/schema_contas_aparelhos.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
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
--     data), dos itens, pagamentos e entregas próprias delas, da ocupação das mesas e do
--     horário dos caixas (abertos ou fechados nas últimas 24 h).
--     Roda com o papel de quem chama (a RLS da loja vale) e só devolve a loja do token.
--  2. Duas contas na mesma mesa (dois aparelhos abriram a mesma mesa antes de um ver o
--     outro): a segunda conta é recusada (TCHEFOOD_MESA_OCUPADA). O aparelho dela passa
--     os itens para a conta que ficou na mesa (Retaguarda › Nuvem › recusados). A conta
--     aceita já ocupa a mesa na mesma transação (a mesa fica travada até o fim dela):
--     mesmo que as duas contas subam antes da atualização da mesa de cada aparelho, a
--     segunda vê a primeira e é recusada. A mesa da conta precisa ser da loja da conta
--     (TCHEFOOD_MESA_OUTRA_LOJA).
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
--  7. Item na cozinha não volta atrás (pronto/entregue) por uma atualização velha, e item
--     cancelado continua cancelado (a cópia velha passa sem reativar o item).
--  8. Os 10% retirados com PIN de gerente em outro aparelho não voltam por uma cópia velha
--     da conta: só a reativação registrada (SERVICE_FEE_RESTORED) traz a taxa de volta. Do
--     mesmo jeito, depois da reativação a cópia velha sem os 10% não tira a taxa de novo.
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
--
-- Caixas (cash_sessions) abertos ou fechados nas últimas 24 h descem só com o horário (sem
-- valores nem quem operou): a loja tem um caixa aberto por vez, aberto num aparelho só, e o
-- dinheiro recebido em outro aparelho durante esse caixa não pode virar o aviso de "dinheiro
-- recebido com o caixa fechado" (src/lib/cashRegister.ts, cashOutsideSessions).
DROP FUNCTION IF EXISTS tchefood_pull_orders();
CREATE OR REPLACE FUNCTION tchefood_pull_orders(p_order_ids JSONB DEFAULT '[]'::jsonb)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
    -- Só os elementos que são UUID entram: um id inválido na lista do aparelho (texto, número)
    -- fazia o x::uuid falhar (22P02) e toda leitura das contas falhava (auditoria interna,
    -- rodada 8 do PR #54). O CASE garante que a conversão só roda depois da conferência.
    WITH asked AS (
        SELECT CASE WHEN x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN x::uuid END AS id
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_order_ids) = 'array' THEN p_order_ids ELSE '[]'::jsonb END) x
         WHERE x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
    ), c AS (
        SELECT cs.id, cs.tenant_id, cs.status, cs.opened_at, cs.closed_at
          FROM cash_sessions cs
         WHERE cs.tenant_id = tchefood_tenant()
           AND (cs.status = 'OPEN' OR cs.closed_at >= now() - interval '24 hours')
    )
    SELECT jsonb_build_object(
        'tenant_id', tchefood_tenant(),
        'server_now', now(),
        'orders', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.opened_at, o.id) FROM o), '[]'::jsonb),
        'order_items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at, i.id) FROM i), '[]'::jsonb),
        'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id) FROM p), '[]'::jsonb),
        'own_deliveries', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at, d.id) FROM d), '[]'::jsonb),
        'tables', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM t), '[]'::jsonb),
        'cash_sessions', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.opened_at, c.id) FROM c), '[]'::jsonb));
$$;

-- Índice para as contas encerradas nas últimas 24 h da leitura acima (a mesma expressão do
-- filtro); as abertas usam idx_orders_tenant_status (auditoria interna, rodada 8 do PR #54).
CREATE INDEX IF NOT EXISTS idx_orders_tenant_recent ON orders (tenant_id, (COALESCE(closed_at, opened_at)));

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
    v_kind VARCHAR;
BEGIN
    -- A mesa precisa ser da loja da conta, em qualquer situação da conta: a chave estrangeira
    -- não confere a loja, e uma conta numa mesa de outra loja era aceita e depois travava a
    -- leitura das contas no aparelho (auditoria interna, rodada 8 do PR #54). Com o token do
    -- aparelho a RLS já esconde a mesa de outra loja; a loja também é conferida aqui para os
    -- papéis que não passam pela RLS.
    SELECT kind INTO v_kind FROM dining_tables WHERE id = NEW.table_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_MESA_OUTRA_LOJA: a mesa % não é da loja desta conta (ou não existe); a conta % não entra.', NEW.table_id, NEW.id
            USING DETAIL = json_build_object('order_id', NEW.id, 'table_id', NEW.table_id)::text;
    END IF;
    IF NEW.status NOT IN ('OPEN', 'PAYING') THEN
        RETURN NEW;
    END IF;
    -- Reenvio da mesma conta (upsert da fila): o conflito de id decide, não esta trava.
    IF EXISTS (SELECT 1 FROM orders WHERE id = NEW.id) THEN
        RETURN NEW;
    END IF;
    -- Mesa técnica (balcão, totem) não é travada: as contas dela não esperam uma pela outra
    -- (auditoria interna, rodada 8 do PR #54). O tipo é conferido de novo depois da trava.
    IF v_kind NOT IN ('TABLE', 'CARD') THEN
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

-- Ordem das travas com o barril de chopp (auditoria interna, rodada 8 do PR #54). O lançamento
-- trava a conta aqui em cima (BEFORE INSERT) e depois o barril (trg_order_items_keg, AFTER):
-- conta → barril. O cancelamento de um chopp travava o barril primeiro (trg_order_items_keg) e
-- só depois a conta (trg_order_items_recalc, que roda depois por ordem alfabética): barril →
-- conta. Um lançamento e um cancelamento na mesma conta e no mesmo barril, ao mesmo tempo,
-- davam deadlock. Agora a mudança de situação de item de barril trava a conta antes, como o
-- lançamento: a ordem é sempre conta → barril. Nada mais muda: o recálculo já travava a mesma
-- conta na mesma transação, só mais tarde. O nome com 000 roda antes dos outros gatilhos
-- BEFORE UPDATE de order_items (ordem alfabética, por byte: '0' vem antes de '_' e das letras).
CREATE OR REPLACE FUNCTION tchefood_item_keg_locks_order()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.keg_volume_ml IS NOT NULL THEN
        PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_000_keg_order_lock ON order_items;
CREATE TRIGGER trg_order_items_000_keg_order_lock BEFORE UPDATE OF status ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_item_keg_locks_order();

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

-- Item cancelado continua cancelado. A cópia velha de outro aparelho (de antes do
-- cancelamento, com a situação da cozinha) era recusada por tchefood_check_item_cancel
-- ("item cancelado não pode ser reativado") e o evento recusado segurava toda a fila desse
-- aparelho (auditoria interna, rodada 8 do PR #54). Agora a situação de cancelado (status,
-- hora, autor, motivo e is_paid) fica como está e o resto da linha passa: o item nunca é
-- reativado. O nome com 0_ roda antes de trg_order_items_cancel e dos outros gatilhos
-- BEFORE UPDATE OF status de order_items (ordem alfabética, por byte: '0' vem antes das
-- letras), então eles já veem o item cancelado.
CREATE OR REPLACE FUNCTION tchefood_item_canceled_stays()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'CANCELED' AND NEW.status <> 'CANCELED' THEN
        RAISE NOTICE 'TCHEFOOD_ITEM_CANCELADO: o item % está cancelado e continua cancelado (atualização velha com %).', OLD.id, NEW.status;
        NEW.status := OLD.status;
        NEW.canceled_at := OLD.canceled_at;
        NEW.canceled_by_user_id := OLD.canceled_by_user_id;
        NEW.cancel_reason := OLD.cancel_reason;
        NEW.is_paid := OLD.is_paid;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_0_canceled_stays ON order_items;
CREATE TRIGGER trg_order_items_0_canceled_stays BEFORE UPDATE OF status ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_item_canceled_stays();

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
    -- O caminho de volta: depois da reativação (SERVICE_FEE_RESTORED), a cópia velha de outro
    -- aparelho, ainda sem os 10%, era recusada por tchefood_require_order_audit (a última
    -- autorização é a reativação) e travava a fila desse aparelho (auditoria interna, rodada 8
    -- do PR #54). Se o último registro de 10% da conta é a reativação, a taxa fica e o resto da
    -- linha passa. Sem registro nenhum, ou com a remoção registrada por último, nada muda aqui:
    -- a conferência do PIN de gerente continua decidindo.
    IF OLD.charge_service_fee AND NOT NEW.charge_service_fee THEN
        SELECT a.action_type INTO v_last
          FROM audit_logs a
         WHERE a.order_id = NEW.id AND a.action_type IN ('SERVICE_FEE_REMOVED', 'SERVICE_FEE_RESTORED')
         ORDER BY a.server_seq DESC
         LIMIT 1;
        IF v_last = 'SERVICE_FEE_RESTORED' THEN
            RAISE NOTICE 'TCHEFOOD_TAXA: a conta % teve os 10%% reativados e continua com eles (atualização velha, sem remoção registrada depois).', OLD.id;
            NEW.charge_service_fee := TRUE;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_000_fee_stays ON orders;
CREATE TRIGGER trg_orders_000_fee_stays BEFORE UPDATE OF charge_service_fee ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_fee_stays();

-- O CPF da nota não some por uma cópia velha da conta (auditoria interna, rodada 8 do PR #54).
-- A atualização da conta manda a linha inteira, com o customer_cpf da cópia do aparelho: uma
-- cópia sem CPF (uma mudança qualquer em B, como o número de pessoas) apagaria o CPF na nuvem
-- e a NFC-e sairia sem ele. Nenhum caminho do app tira o CPF de uma conta (ele só entra na
-- abertura; a conta nova da junção nasce sem CPF por INSERT), então CPF vazio sobre CPF
-- gravado fica como estava e o resto da linha passa: a atualização não é recusada. A troca por
-- outro CPF (não vazio) passa: nada no app troca o CPF, então ela é uma correção de propósito,
-- não uma cópia velha. O nome com 000_cpf roda antes dos outros gatilhos BEFORE UPDATE de
-- orders (ordem alfabética, por byte: 'c' vem antes de 'f' de trg_orders_000_fee_stays).
CREATE OR REPLACE FUNCTION tchefood_order_cpf_stays()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NULLIF(btrim(OLD.customer_cpf), '') IS NOT NULL AND NULLIF(btrim(NEW.customer_cpf), '') IS NULL THEN
        RAISE NOTICE 'TCHEFOOD_CPF: a conta % tem CPF na nota e continua com ele (atualização velha sem CPF).', OLD.id;
        NEW.customer_cpf := OLD.customer_cpf;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orders_000_cpf_stays ON orders;
CREATE TRIGGER trg_orders_000_cpf_stays BEFORE UPDATE OF customer_cpf ON orders
    FOR EACH ROW EXECUTE FUNCTION tchefood_order_cpf_stays();

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
        REVOKE ALL ON FUNCTION tchefood_item_keg_locks_order() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_order_cpf_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_item_paid_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_item_progress_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_item_canceled_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_order_fee_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_order_table_stays() FROM PUBLIC, anon, authenticated;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 10. Acerto com o entregador pela nuvem, antes de sair dinheiro da gaveta (auditoria interna, rodada 8 do PR #54)
-- -----------------------------------------------------------------------------
-- Com as entregas descendo para todos os aparelhos, B via como "sem acerto" a entrega que A
-- tinha acabado de acertar (até a próxima leitura). Os dois acertavam e o ganho do
-- entregador saía da gaveta duas vezes. Com a loja ligada à nuvem, o acerto é como o
-- pagamento: a nuvem confirma primeiro, sem internet não há acerto.
--  a. tchefood_settle_courier() grava o acerto numa transação só: trava as entregas (FOR
--     UPDATE, em ordem fixa: dois acertos juntos esperam um pelo outro), recusa se alguma já
--     tem acerto (TCHEFOOD_ENTREGA_JA_ACERTADA, com a entrega e o acerto em DETAIL), não é
--     deste entregador e desta loja, não foi entregue, ou se o ganho não é a soma dos ganhos
--     delas (o dinheiro trazido não passa do total das contas pagas na entrega). Aceito, grava
--     o acerto (com as entregas em delivery_ids e sem sangria: cash_movement_id NULL) e marca
--     as entregas. A mesma chamada repetida (resposta perdida, ou ainda rodando) devolve o
--     acerto gravado: a conferência é repetida depois da trava, como em tchefood_record_payment.
--  b. A sangria do ganho é uma sangria comum, com PIN de gerente, que o aparelho cria só
--     depois de a nuvem aceitar o acerto (a autorização dela cita o acerto, só para consulta).
--  c. Acerto gravado direto na tabela, sem a função, é recusado (TCHEFOOD_ENTREGA_ACERTO_ONLINE),
--     e entrega só entra em acerto pela função; o reenvio igual de um acerto já gravado passa.
--  d. Cópia velha da entrega mandada por outro aparelho (etapa igual ou anterior, ou outro
--     entregador e ganho depois da saída) não é recusada: a linha fica como está no banco
--     (NOTICE) e a leitura acerta o aparelho. Antes ela era recusada e a entrega ficava
--     parada naquele aparelho. As travas de schema_entrega.sql continuam valendo.
ALTER TABLE courier_settlements ADD COLUMN IF NOT EXISTS delivery_ids UUID[];
-- A versão anterior desta seção tirava a chave estrangeira da sangria e travava a sangria do
-- acerto; a chave volta e a trava sai (bases que chegaram a aplicar aquela versão).
DROP INDEX IF EXISTS uq_courier_settlements_cash_movement;
DROP TRIGGER IF EXISTS trg_cash_movements_settlement_guard ON cash_movements;
DROP FUNCTION IF EXISTS tchefood_cash_movement_settlement_guard();
DROP TRIGGER IF EXISTS trg_courier_settlements_marks_deliveries ON courier_settlements;
DROP FUNCTION IF EXISTS tchefood_courier_settlement_marks_deliveries();
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'courier_settlements'::regclass AND conname = 'courier_settlements_cash_movement_id_fkey') THEN
        ALTER TABLE courier_settlements ADD CONSTRAINT courier_settlements_cash_movement_id_fkey
            FOREIGN KEY (cash_movement_id) REFERENCES cash_movements(id);
    END IF;
END $$;

-- Acerto: só inserção, e só pela função (que liga tchefood.courier_settle com o id do acerto).
CREATE OR REPLACE FUNCTION tchefood_courier_settlement_rules()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_mv cash_movements%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: acerto com o entregador é somente inserção.';
    END IF;
    -- Reenvio igual de um acerto já gravado: passa (ON CONFLICT DO NOTHING ignora).
    IF EXISTS (SELECT 1 FROM courier_settlements s
                WHERE s.id = NEW.id AND s.tenant_id = NEW.tenant_id AND s.courier_id = NEW.courier_id
                  AND s.deliveries = NEW.deliveries AND s.cash_collected = NEW.cash_collected
                  AND s.courier_fees = NEW.courier_fees AND s.cash_movement_id IS NOT DISTINCT FROM NEW.cash_movement_id
                  AND s.settled_by_user_id = NEW.settled_by_user_id
                  AND (NEW.delivery_ids IS NULL OR s.delivery_ids IS NOT DISTINCT FROM NEW.delivery_ids)) THEN
        RETURN NEW;
    END IF;
    IF current_setting('tchefood.courier_settle', true) IS DISTINCT FROM NEW.id::text THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA_ACERTO_ONLINE: o acerto com o entregador é gravado pela nuvem (tchefood_settle_courier), antes de sair dinheiro da gaveta.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM couriers c WHERE c.id = NEW.courier_id AND c.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entregador não é desta loja.';
    END IF;
    IF NEW.cash_movement_id IS NOT NULL THEN
        SELECT * INTO v_mv FROM cash_movements WHERE id = NEW.cash_movement_id;
        IF v_mv.id IS NULL OR v_mv.tenant_id <> NEW.tenant_id OR v_mv.type <> 'WITHDRAWAL' OR v_mv.amount <> NEW.courier_fees THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: o pagamento do entregador pela gaveta precisa ser uma sangria com o mesmo valor do ganho.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Entrega: só entra em acerto pela função, e a cópia velha de outro aparelho não volta a
-- linha atrás. O nome com 0_ roda antes de trg_own_deliveries_rules (ordem alfabética), que
-- então vê a linha já acertada e só confere o que de fato muda.
CREATE OR REPLACE FUNCTION tchefood_own_delivery_stale_stays()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_old INT := tchefood_delivery_step(OLD.status);
    v_new INT := tchefood_delivery_step(NEW.status);
BEGIN
    IF NEW.settlement_id IS DISTINCT FROM OLD.settlement_id AND OLD.settlement_id IS NULL
       AND current_setting('tchefood.courier_settle', true) IS DISTINCT FROM NEW.settlement_id::text THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA_ACERTO_ONLINE: a entrega só entra num acerto pela nuvem (tchefood_settle_courier).';
    END IF;
    -- Entrega cancelada ou acertada, e o cancelamento: ficam com as travas de schema_entrega.sql.
    IF OLD.status = 'CANCELED' OR OLD.settlement_id IS NOT NULL OR NEW.status = 'CANCELED' THEN
        RETURN NEW;
    END IF;
    IF v_new <= v_old THEN
        IF NEW.status IS DISTINCT FROM OLD.status OR NEW.courier_id IS DISTINCT FROM OLD.courier_id
           OR NEW.courier_fee IS DISTINCT FROM OLD.courier_fee OR NEW.out_at IS DISTINCT FROM OLD.out_at
           OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
            RAISE NOTICE 'TCHEFOOD_ENTREGA_COPIA_VELHA: a entrega % já está % e fica como está (atualização velha com %).', OLD.id, OLD.status, NEW.status;
        END IF;
        NEW.status := OLD.status;
        NEW.courier_id := OLD.courier_id;
        NEW.courier_fee := OLD.courier_fee;
        NEW.out_at := OLD.out_at;
        NEW.delivered_at := OLD.delivered_at;
    ELSIF OLD.status IN ('OUT', 'DELIVERED')
          AND (NEW.courier_id IS DISTINCT FROM OLD.courier_id OR NEW.courier_fee IS DISTINCT FROM OLD.courier_fee OR NEW.out_at IS DISTINCT FROM OLD.out_at) THEN
        RAISE NOTICE 'TCHEFOOD_ENTREGA_COPIA_VELHA: a entrega % saiu com outro entregador; ele e o ganho ficam como estão.', OLD.id;
        NEW.courier_id := OLD.courier_id;
        NEW.courier_fee := OLD.courier_fee;
        NEW.out_at := OLD.out_at;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_own_deliveries_0_stale_stays ON own_deliveries;
CREATE TRIGGER trg_own_deliveries_0_stale_stays BEFORE UPDATE ON own_deliveries
    FOR EACH ROW EXECUTE FUNCTION tchefood_own_delivery_stale_stays();

-- O acerto pela nuvem. Devolve a linha gravada (a mesma em toda chamada com o mesmo p_id).
CREATE OR REPLACE FUNCTION tchefood_settle_courier(
    p_id UUID, p_courier UUID, p_delivery_ids UUID[], p_cash_collected NUMERIC, p_courier_fees NUMERIC, p_staff UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_ids UUID[];
    v_row courier_settlements%ROWTYPE;
    v_taken_delivery UUID;
    v_taken_settlement UUID;
    v_found INT;
    v_fees NUMERIC;
    v_cod INT;
    v_cod_total NUMERIC;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: sem loja no acesso do aparelho.';
    END IF;
    IF p_id IS NULL OR p_courier IS NULL OR p_staff IS NULL OR p_delivery_ids IS NULL
       OR cardinality(p_delivery_ids) = 0 OR cardinality(p_delivery_ids) > 500
       OR p_cash_collected IS NULL OR p_courier_fees IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: acerto sem id, entregador, entregas, valores ou quem acertou.';
    END IF;
    v_ids := ARRAY(SELECT DISTINCT x FROM unnest(p_delivery_ids) AS x WHERE x IS NOT NULL ORDER BY x);
    IF cardinality(v_ids) <> cardinality(p_delivery_ids) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entrega repetida ou vazia na lista do acerto.';
    END IF;

    -- Mesma chamada de novo (resposta perdida): devolve o acerto gravado.
    SELECT * INTO v_row FROM courier_settlements WHERE id = p_id;
    IF FOUND THEN
        IF v_row.tenant_id <> v_tenant OR v_row.courier_id <> p_courier OR v_row.courier_fees <> p_courier_fees
           OR v_row.cash_collected <> p_cash_collected OR v_row.delivery_ids IS DISTINCT FROM v_ids THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: já existe outro acerto com este id.';
        END IF;
        RETURN to_jsonb(v_row);
    END IF;

    -- As entregas travam aqui, em ordem fixa: o segundo acerto da mesma entrega espera o primeiro.
    PERFORM 1 FROM own_deliveries d WHERE d.id = ANY(v_ids) AND d.tenant_id = v_tenant ORDER BY d.id FOR UPDATE;
    -- A mesma chamada ainda rodando quando esta chegou: ao entrar, a primeira já gravou.
    SELECT * INTO v_row FROM courier_settlements WHERE id = p_id;
    IF FOUND THEN
        IF v_row.tenant_id <> v_tenant OR v_row.courier_id <> p_courier OR v_row.courier_fees <> p_courier_fees
           OR v_row.cash_collected <> p_cash_collected OR v_row.delivery_ids IS DISTINCT FROM v_ids THEN
            RAISE EXCEPTION 'TCHEFOOD_ENTREGA: já existe outro acerto com este id.';
        END IF;
        RETURN to_jsonb(v_row);
    END IF;

    SELECT d.id, d.settlement_id INTO v_taken_delivery, v_taken_settlement FROM own_deliveries d
     WHERE d.id = ANY(v_ids) AND d.tenant_id = v_tenant AND d.settlement_id IS NOT NULL
     ORDER BY d.id LIMIT 1;
    IF v_taken_delivery IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA_JA_ACERTADA: a entrega % já foi acertada com o entregador (outro aparelho). Nada sai da gaveta por este acerto.', v_taken_delivery
            USING DETAIL = json_build_object('delivery_id', v_taken_delivery, 'settlement_id', v_taken_settlement)::text;
    END IF;
    SELECT count(*), COALESCE(sum(d.courier_fee), 0), count(*) FILTER (WHERE d.pay_on_delivery),
           COALESCE(sum(o.total_amount) FILTER (WHERE d.pay_on_delivery), 0)
      INTO v_found, v_fees, v_cod, v_cod_total
      FROM own_deliveries d LEFT JOIN orders o ON o.id = d.order_id AND o.tenant_id = v_tenant
     WHERE d.id = ANY(v_ids) AND d.tenant_id = v_tenant AND d.courier_id = p_courier AND d.status = 'DELIVERED';
    IF v_found <> cardinality(v_ids) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: só entrega entregue, deste entregador e desta loja, entra no acerto (a nuvem ainda não tem alguma como entregue?).';
    END IF;
    IF v_fees <> p_courier_fees THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: o ganho do acerto (%) não é a soma dos ganhos das entregas (%).', p_courier_fees, v_fees;
    END IF;
    -- O dinheiro trazido vira o pagamento das contas pagas na entrega, que podem ainda estar na
    -- fila do aparelho: não passa do total delas (e é zero sem nenhuma).
    IF p_cash_collected < 0 OR p_cash_collected > v_cod_total OR (v_cod = 0 AND p_cash_collected <> 0) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: o dinheiro do acerto (%) não confere com as contas pagas na entrega (até %).', p_cash_collected, v_cod_total;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM couriers c WHERE c.id = p_courier AND c.tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: entregador não é desta loja.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active
                      AND u.role::text IN ('CASHIER', 'MANAGER', 'OWNER')) THEN
        RAISE EXCEPTION 'TCHEFOOD_ENTREGA: só caixa, gerente ou proprietário ativo da loja acerta com o entregador.';
    END IF;

    PERFORM set_config('tchefood.courier_settle', p_id::text, true);
    INSERT INTO courier_settlements (id, tenant_id, courier_id, deliveries, cash_collected, courier_fees, cash_movement_id, delivery_ids, settled_by_user_id)
    VALUES (p_id, v_tenant, p_courier, cardinality(v_ids), p_cash_collected, p_courier_fees, NULL, v_ids, p_staff)
    RETURNING * INTO v_row;
    UPDATE own_deliveries SET settlement_id = p_id WHERE id = ANY(v_ids) AND tenant_id = v_tenant;
    PERFORM set_config('tchefood.courier_settle', '', true);
    RETURN to_jsonb(v_row);
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_own_delivery_stale_stays() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_settle_courier(UUID, UUID, UUID[], NUMERIC, NUMERIC, UUID) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_settle_courier(UUID, UUID, UUID[], NUMERIC, NUMERIC, UUID) TO authenticated;
    END IF;
END $$;
