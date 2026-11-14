-- Cópia de db/schema_delivery_servidor.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- Tchê Food — pedidos de apps de delivery gravados pelo servidor de polling
-- Aplicar depois de schema.sql (idempotente).
--
-- O servidor de polling (server/delivery/ifood/ifoodServer.ts) é o único que grava em
-- delivery_orders / delivery_events: ele usa a chave service_role e só estas funções.
-- O app (papel authenticated) continua lendo pelo RLS da loja, mas não grava mais nessas
-- tabelas: um pedido do iFood forjado pelo aparelho viraria venda e nota fiscal.
--
-- Controle de versão: dois processos (o polling e uma ação feita na tela) podem ler o mesmo
-- pedido ao mesmo tempo. Cada gravação diz qual versão leu; se outra gravação passou na
-- frente, nada é gravado e a função devolve NULL. O servidor relê e tenta de novo (ação da
-- tela) ou deixa o evento sem ack para o próximo polling (evento do app).
-- =============================================================================

ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS dispute JSONB;
-- Pedido de cancelamento da loja reservado antes da chamada ao app ({state, reservedAt, code}; ver
-- DeliveryCancellationRequest em server/delivery/deliveryInbox.ts). NULL = nenhum.
ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS cancellation_request JSONB;
ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_version_positive;
ALTER TABLE delivery_orders ADD CONSTRAINT delivery_orders_version_positive CHECK (version >= 1);
-- merchantId cadastrado à mão: só letras, números e hífen (o polling ignora, com aviso no log, um id fora disso;
-- NOT VALID para não travar a migração se já houver linha errada — o servidor ignora essa loja até corrigir).
ALTER TABLE delivery_integrations DROP CONSTRAINT IF EXISTS delivery_integrations_merchant_format;
ALTER TABLE delivery_integrations ADD CONSTRAINT delivery_integrations_merchant_format
    CHECK (merchant_external_id ~ '^[A-Za-z0-9-]{1,64}$') NOT VALID;

-- O app só lê. (Os privilégios padrão do Supabase dão tudo para anon/authenticated.)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON delivery_orders, delivery_events, delivery_integrations FROM anon, authenticated;
        REVOKE ALL ON delivery_orders, delivery_events, delivery_integrations FROM anon;
    END IF;
END $$;

-- Loja do Tchê Food dona de um merchantId do app (só integração ativa).
CREATE OR REPLACE FUNCTION tchefood_delivery_tenant(p_channel delivery_channel, p_merchant VARCHAR)
RETURNS UUID
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT tenant_id FROM delivery_integrations
     WHERE channel = p_channel AND merchant_external_id = p_merchant AND active
$$;

-- Lojas que o polling deve buscar (header x-polling-merchants do iFood).
CREATE OR REPLACE FUNCTION tchefood_delivery_active_merchants(p_channel delivery_channel)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('tenantId', tenant_id, 'merchantExternalId', merchant_external_id)
                              ORDER BY merchant_external_id), '[]'::jsonb)
      FROM delivery_integrations
     WHERE channel = p_channel AND active
$$;

CREATE OR REPLACE FUNCTION tchefood_delivery_record_json(o delivery_orders)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT jsonb_build_object(
        'order', o.payload || jsonb_build_object('status', o.status::text),
        'cancellationPending', o.cancellation_pending,
        'cancellationRequest', o.cancellation_request,
        'needsReview', o.needs_review,
        'reviewReasons', to_jsonb(o.review_reasons),
        'newOrderNotified', o.new_order_notified,
        'lastCancellationEventAt', o.last_cancellation_event_at,
        'lastEventAt', o.last_event_at,
        'updatedAt', o.updated_at,
        'dispute', o.dispute,
        'version', o.version,
        'tenantId', o.tenant_id)
$$;

CREATE OR REPLACE FUNCTION tchefood_delivery_get_order(p_channel delivery_channel, p_external_id VARCHAR)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT tchefood_delivery_record_json(o) FROM delivery_orders o
     WHERE o.channel = p_channel AND o.external_id = p_external_id
$$;

-- Pedidos abertos e os das últimas 24 h (para a conferência do servidor).
CREATE OR REPLACE FUNCTION tchefood_delivery_list_orders(p_channel delivery_channel, p_limit INTEGER)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT COALESCE(jsonb_agg(tchefood_delivery_record_json(q) ORDER BY q.placed_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM delivery_orders o
             WHERE o.channel = p_channel
               AND (o.status NOT IN ('concluded', 'cancelled') OR o.placed_at > NOW() - INTERVAL '24 hours')
             ORDER BY o.placed_at DESC
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)) q
$$;

CREATE OR REPLACE FUNCTION tchefood_delivery_has_event(p_channel delivery_channel, p_external_event_id VARCHAR)
RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM delivery_events WHERE channel = p_channel AND external_event_id = p_external_event_id)
$$;

-- Grava o pedido se a versão gravada ainda for p_expected_version (0 = pedido novo).
-- Devolve a nova versão, ou NULL quando outra gravação passou na frente (nada é gravado).
CREATE OR REPLACE FUNCTION tchefood_delivery_save_order(p_channel delivery_channel, p_expected_version INTEGER, p_record JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_order JSONB := p_record->'order';
    v_external VARCHAR := v_order->>'externalId';
    v_tenant UUID;
    v_version INTEGER;
    v_total NUMERIC;
BEGIN
    IF v_order IS NULL OR jsonb_typeof(v_order) <> 'object' OR v_external IS NULL OR v_external = ''
       OR v_order->>'channel' IS DISTINCT FROM p_channel::text THEN
        RAISE EXCEPTION 'Pedido de delivery inválido.' USING ERRCODE = '22023';
    END IF;
    IF p_expected_version IS NULL OR p_expected_version < 0 THEN
        RAISE EXCEPTION 'Versão inválida.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_order->'totals'->'orderCents') <> 'number' THEN
        RAISE EXCEPTION 'Pedido de delivery sem total.' USING ERRCODE = '22023';
    END IF;
    v_total := (v_order->'totals'->>'orderCents')::NUMERIC;
    IF v_total < 0 OR v_total <> trunc(v_total) THEN
        RAISE EXCEPTION 'Total do pedido inválido.' USING ERRCODE = '22023';
    END IF;

    IF p_expected_version = 0 THEN
        v_tenant := tchefood_delivery_tenant(p_channel, v_order->>'merchantExternalId');
        IF v_tenant IS NULL THEN
            RAISE EXCEPTION 'Loja % do app % não está ligada a nenhuma loja do Tchê Food.', v_order->>'merchantExternalId', p_channel
                USING ERRCODE = 'P0002';
        END IF;
        INSERT INTO delivery_orders (tenant_id, channel, external_id, display_id, status, cancellation_pending, needs_review,
                                     review_reasons, new_order_notified, last_cancellation_event_at, total_amount, payload,
                                     placed_at, last_event_at, updated_at, dispute, cancellation_request, version)
        VALUES (v_tenant, p_channel, v_external, left(COALESCE(v_order->>'displayId', ''), 20),
                (v_order->>'status')::delivery_order_status,
                COALESCE((p_record->>'cancellationPending')::BOOLEAN, FALSE),
                COALESCE((p_record->>'needsReview')::BOOLEAN, FALSE),
                ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_record->'reviewReasons', '[]'::jsonb))),
                COALESCE((p_record->>'newOrderNotified')::BOOLEAN, FALSE),
                (p_record->>'lastCancellationEventAt')::TIMESTAMPTZ,
                v_total / 100, v_order - 'status',
                (v_order->>'createdAt')::TIMESTAMPTZ, (p_record->>'lastEventAt')::TIMESTAMPTZ, NOW(),
                NULLIF(p_record->'dispute', 'null'::jsonb), NULLIF(p_record->'cancellationRequest', 'null'::jsonb), 1)
        ON CONFLICT (channel, external_id) DO NOTHING
        RETURNING version INTO v_version;
        RETURN v_version;
    END IF;

    -- O dono (tenant), o total e o pedido do app não mudam depois de gravados: o detalhe do pedido é imutável.
    UPDATE delivery_orders
       SET status = (v_order->>'status')::delivery_order_status,
           cancellation_pending = COALESCE((p_record->>'cancellationPending')::BOOLEAN, FALSE),
           needs_review = COALESCE((p_record->>'needsReview')::BOOLEAN, FALSE),
           review_reasons = ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_record->'reviewReasons', '[]'::jsonb))),
           new_order_notified = COALESCE((p_record->>'newOrderNotified')::BOOLEAN, FALSE),
           last_cancellation_event_at = (p_record->>'lastCancellationEventAt')::TIMESTAMPTZ,
           last_event_at = (p_record->>'lastEventAt')::TIMESTAMPTZ,
           dispute = NULLIF(p_record->'dispute', 'null'::jsonb),
           cancellation_request = NULLIF(p_record->'cancellationRequest', 'null'::jsonb),
           updated_at = NOW(),
           version = version + 1
     WHERE channel = p_channel AND external_id = v_external AND version = p_expected_version
    RETURNING version INTO v_version;
    RETURN v_version;
END $$;

-- Histórico de eventos; repetir o mesmo id não duplica. A loja vem do pedido (ou do merchantId).
CREATE OR REPLACE FUNCTION tchefood_delivery_record_event(p_event JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_channel delivery_channel := (p_event->>'channel')::delivery_channel;
    v_tenant UUID;
BEGIN
    IF COALESCE(p_event->>'externalEventId', '') = '' OR COALESCE(p_event->>'externalOrderId', '') = '' THEN
        RAISE EXCEPTION 'Evento de delivery inválido.' USING ERRCODE = '22023';
    END IF;
    SELECT tenant_id INTO v_tenant FROM delivery_orders
     WHERE channel = v_channel AND external_id = p_event->>'externalOrderId';
    IF v_tenant IS NULL THEN
        v_tenant := tchefood_delivery_tenant(v_channel, p_event->>'merchantExternalId');
    END IF;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Evento % sem loja do Tchê Food.', p_event->>'externalEventId' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO delivery_events (tenant_id, channel, external_event_id, external_order_id, raw_code, signal, event_created_at)
    VALUES (v_tenant, v_channel, p_event->>'externalEventId', p_event->>'externalOrderId', left(p_event->>'rawCode', 40),
            left(p_event->>'signal', 30), (p_event->>'createdAt')::TIMESTAMPTZ)
    ON CONFLICT (channel, external_event_id) DO NOTHING;
END $$;

-- -----------------------------------------------------------------------------
-- Alçada de gerente nas ações do iFood que mexem em dinheiro ou na loja
-- (cancelar, responder negociação, pausar e retomar). O servidor chama esta função com o
-- JWT do app ANTES de chamar o iFood: a loja é a da sessão (tchefood_tenant), o pedido ou o
-- merchantId precisa ser dessa loja, o PIN é de gerente/dono ativo e conta no mesmo bloqueio
-- de 3 erros em 60 s de tchefood_authorize_manager (mesma trava e mesmos registros
-- MANAGER_PIN_FAILED / MANAGER_PIN_LOCKOUT). A autorização vira um audit_log com gerente, com o
-- que o gerente aprovou em metadata.details (p_details: cancelamento {code}, negociação
-- {kind, alternativeId?}, pausa {minutes, description}, retomada {pauseId}).
-- Devolve {"status": "OK", "auditId", "repeated"} ou {"status": "PIN_FAILED" | "PIN_LOCKED" | "CONFLICT"}.
-- repeated = TRUE: reenvio de uma tentativa já autorizada; o servidor NÃO chama o app de novo.
-- lastOutcome (só no reenvio): resultado já gravado da tentativa; "failed" = nada chegou ao app.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_logs_delivery_request
    ON audit_logs (tenant_id, (metadata->>'delivery_request_id')) WHERE metadata ? 'delivery_request_id';

-- A assinatura ganhou p_details: a versão antiga (sem ele) sai antes, senão ficariam as duas.
DROP FUNCTION IF EXISTS tchefood_delivery_authorize(delivery_channel, VARCHAR, VARCHAR, VARCHAR, VARCHAR, UUID, TEXT, UUID);

CREATE OR REPLACE FUNCTION tchefood_delivery_authorize(
    p_channel delivery_channel,
    p_action VARCHAR,
    p_external_order_id VARCHAR,
    p_merchant_external_id VARCHAR,
    p_manager_pin VARCHAR,
    p_performed_by UUID,
    p_reason TEXT,
    p_request_id UUID,
    p_details JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_manager staff_users%ROWTYPE;
    v_existing audit_logs%ROWTYPE;
    v_failures INT;
    v_checked_at TIMESTAMPTZ;
    v_id UUID;
    v_order_action BOOLEAN := p_action IN ('DELIVERY_CANCEL', 'DELIVERY_DISPUTE');
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: sessão sem tenant.' USING ERRCODE = '42501';
    END IF;
    IF p_action IS NULL OR p_action NOT IN ('DELIVERY_CANCEL', 'DELIVERY_DISPUTE', 'DELIVERY_PAUSE', 'DELIVERY_RESUME') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: ação % não é de delivery.', p_action USING ERRCODE = '22023';
    END IF;
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: falta o id da tentativa.' USING ERRCODE = '22023';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: motivo obrigatório (mínimo 5 caracteres).' USING ERRCODE = '22023';
    END IF;
    IF p_details IS NULL OR jsonb_typeof(p_details) <> 'object' OR NOT COALESCE(CASE p_action
           WHEN 'DELIVERY_CANCEL' THEN jsonb_typeof(p_details->'code') = 'string'
           WHEN 'DELIVERY_DISPUTE' THEN p_details->>'kind' IN ('accept', 'reject', 'alternative')
                AND (p_details->>'kind' <> 'alternative' OR jsonb_typeof(p_details->'alternativeId') = 'string')
           WHEN 'DELIVERY_PAUSE' THEN jsonb_typeof(p_details->'minutes') = 'number'
                AND jsonb_typeof(p_details->'description') = 'string'
                AND (p_details->>'minutes')::NUMERIC BETWEEN 1 AND 1440
           WHEN 'DELIVERY_RESUME' THEN jsonb_typeof(p_details->'pauseId') = 'string'
       END, FALSE) THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: detalhes de % inválidos.', p_action USING ERRCODE = '22023';
    END IF;
    IF v_order_action THEN
        IF COALESCE(p_external_order_id, '') = '' OR p_merchant_external_id IS NOT NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % é de um pedido.', p_action USING ERRCODE = '22023';
        END IF;
        PERFORM 1 FROM delivery_orders o
         WHERE o.channel = p_channel AND o.external_id = p_external_order_id AND o.tenant_id = v_tenant;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: pedido não pertence a esta loja.' USING ERRCODE = '42501';
        END IF;
    ELSE
        IF COALESCE(p_merchant_external_id, '') = '' OR p_external_order_id IS NOT NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: % é da loja no app.', p_action USING ERRCODE = '22023';
        END IF;
        PERFORM 1 FROM delivery_integrations i
         WHERE i.channel = p_channel AND i.merchant_external_id = p_merchant_external_id AND i.tenant_id = v_tenant AND i.active;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: loja do app não pertence a esta loja.' USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Mesma trava de tchefood_authorize_manager: as conferências de PIN da loja entram em fila.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));

    PERFORM 1 FROM staff_users u WHERE u.id = p_performed_by AND u.tenant_id = v_tenant AND u.active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: operador inválido.' USING ERRCODE = '42501';
    END IF;

    v_checked_at := clock_timestamp();
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= v_checked_at - INTERVAL '60 seconds' AND a.created_at <= v_checked_at;
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, p_performed_by, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', p_action), v_checked_at);
        RETURN jsonb_build_object('status', 'PIN_LOCKED');
    END IF;

    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, p_performed_by, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', p_action), v_checked_at);
        RETURN jsonb_build_object('status', 'PIN_FAILED');
    END IF;

    -- Reenvio da mesma tentativa (resposta perdida): devolve a autorização já gravada, se for a mesma ação,
    -- no mesmo alvo, pelo mesmo gerente e operador, com o mesmo motivo e os mesmos detalhes aprovados.
    -- Diferente disso é conflito (nada é gravado).
    SELECT * INTO v_existing FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.authorized_by_manager_id IS NOT NULL
       AND a.metadata->>'delivery_request_id' = p_request_id::text
       AND a.metadata ? 'delivery_request_id'
     ORDER BY a.server_seq
     LIMIT 1;
    IF FOUND THEN
        IF v_existing.action_type = p_action
           AND v_existing.metadata->>'external_order_id' IS NOT DISTINCT FROM p_external_order_id
           AND v_existing.metadata->>'merchant_external_id' IS NOT DISTINCT FROM p_merchant_external_id
           AND v_existing.authorized_by_manager_id = v_manager.id
           AND v_existing.performed_by_user_id = p_performed_by
           AND v_existing.reason = trim(p_reason)
           AND v_existing.metadata->'details' IS NOT DISTINCT FROM p_details THEN
            -- Último resultado gravado desta tentativa (sent / failed / uncertain), ou NULL se a primeira
            -- requisição ainda está chamando o app (ou não conseguiu gravar o resultado).
            RETURN jsonb_build_object('status', 'OK', 'auditId', v_existing.id, 'repeated', TRUE,
                'lastOutcome', (SELECT r.metadata->>'outcome' FROM audit_logs r
                                 WHERE r.tenant_id = v_tenant AND r.action_type = 'DELIVERY_RESULT'
                                   AND r.metadata->>'authorization_id' = v_existing.id::text
                                 ORDER BY r.server_seq DESC LIMIT 1));
        END IF;
        RETURN jsonb_build_object('status', 'CONFLICT');
    END IF;

    INSERT INTO audit_logs (tenant_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata, created_at)
    VALUES (v_tenant, p_performed_by, v_manager.id, p_action, trim(p_reason),
            jsonb_build_object('channel', p_channel, 'external_order_id', p_external_order_id,
                               'merchant_external_id', p_merchant_external_id, 'delivery_request_id', p_request_id,
                               'details', p_details),
            v_checked_at)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('status', 'OK', 'auditId', v_id, 'repeated', FALSE);
END $$;

-- Resultado da chamada ao app para uma autorização acima (audit_logs é só de inserção: outro registro).
-- Só o servidor grava, um resultado por chamada (o app não insere DELIVERY_*: tchefood_guard_audit_insert abaixo).
CREATE OR REPLACE FUNCTION tchefood_delivery_audit_result(p_audit_id UUID, p_outcome VARCHAR, p_detail TEXT)
RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_auth audit_logs%ROWTYPE;
BEGIN
    IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'failed', 'uncertain') THEN
        RAISE EXCEPTION 'Resultado inválido.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_auth FROM audit_logs a
     WHERE a.id = p_audit_id AND a.authorized_by_manager_id IS NOT NULL
       AND a.action_type IN ('DELIVERY_CANCEL', 'DELIVERY_DISPUTE', 'DELIVERY_PAUSE', 'DELIVERY_RESUME')
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Autorização de delivery % não existe.', p_audit_id USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO audit_logs (tenant_id, performed_by_user_id, action_type, reason, metadata)
    VALUES (v_auth.tenant_id, v_auth.performed_by_user_id, 'DELIVERY_RESULT', left(COALESCE(p_detail, p_outcome), 500),
            v_auth.metadata || jsonb_build_object('authorization_id', p_audit_id, 'action', v_auth.action_type, 'outcome', p_outcome));
END $$;

-- O aparelho não grava os registros de delivery direto: a autorização sai de tchefood_delivery_authorize e o
-- resultado de tchefood_delivery_audit_result (servidor). Versão de schema_cashback_conciliacao.sql + o bloqueio
-- de DELIVERY_*. As funções SECURITY DEFINER rodam como o dono e seguem gravando; o service_role também.
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
    IF NEW.action_type IN ('DELIVERY_RESULT', 'DELIVERY_CANCEL', 'DELIVERY_DISPUTE', 'DELIVERY_PAUSE', 'DELIVERY_RESUME')
       AND current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: registros de delivery só são gravados pelo servidor do delivery.';
    END IF;
    RETURN NEW;
END;
$$;

-- Só o servidor (service_role) chama estas funções.
DO $$
DECLARE f TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        RETURN;
    END IF;
    FOREACH f IN ARRAY ARRAY[
        'tchefood_delivery_tenant(delivery_channel, VARCHAR)',
        'tchefood_delivery_active_merchants(delivery_channel)',
        'tchefood_delivery_record_json(delivery_orders)',
        'tchefood_delivery_get_order(delivery_channel, VARCHAR)',
        'tchefood_delivery_list_orders(delivery_channel, INTEGER)',
        'tchefood_delivery_has_event(delivery_channel, VARCHAR)',
        'tchefood_delivery_save_order(delivery_channel, INTEGER, JSONB)',
        'tchefood_delivery_record_event(JSONB)',
        'tchefood_delivery_audit_result(UUID, VARCHAR, TEXT)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END LOOP;
    -- A autorização de gerente é chamada pelo app (papel authenticated), pelo servidor, com o JWT da sessão.
    REVOKE ALL ON FUNCTION tchefood_delivery_authorize(delivery_channel, VARCHAR, VARCHAR, VARCHAR, VARCHAR, UUID, TEXT, UUID, JSONB) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION tchefood_delivery_authorize(delivery_channel, VARCHAR, VARCHAR, VARCHAR, VARCHAR, UUID, TEXT, UUID, JSONB) TO authenticated;
END $$;
