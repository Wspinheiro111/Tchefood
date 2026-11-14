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
ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_version_positive;
ALTER TABLE delivery_orders ADD CONSTRAINT delivery_orders_version_positive CHECK (version >= 1);

-- O app só lê. (Os privilégios padrão do Supabase dão tudo para anon/authenticated.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON delivery_orders, delivery_events, delivery_integrations FROM anon, authenticated;
REVOKE ALL ON delivery_orders, delivery_events, delivery_integrations FROM anon;

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
                                     placed_at, last_event_at, updated_at, dispute, version)
        VALUES (v_tenant, p_channel, v_external, left(COALESCE(v_order->>'displayId', ''), 20),
                (v_order->>'status')::delivery_order_status,
                COALESCE((p_record->>'cancellationPending')::BOOLEAN, FALSE),
                COALESCE((p_record->>'needsReview')::BOOLEAN, FALSE),
                ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_record->'reviewReasons', '[]'::jsonb))),
                COALESCE((p_record->>'newOrderNotified')::BOOLEAN, FALSE),
                (p_record->>'lastCancellationEventAt')::TIMESTAMPTZ,
                v_total / 100, v_order - 'status',
                (v_order->>'createdAt')::TIMESTAMPTZ, (p_record->>'lastEventAt')::TIMESTAMPTZ, NOW(),
                NULLIF(p_record->'dispute', 'null'::jsonb), 1)
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

-- Só o servidor (service_role) chama estas funções.
DO $$
DECLARE f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'tchefood_delivery_tenant(delivery_channel, VARCHAR)',
        'tchefood_delivery_active_merchants(delivery_channel)',
        'tchefood_delivery_record_json(delivery_orders)',
        'tchefood_delivery_get_order(delivery_channel, VARCHAR)',
        'tchefood_delivery_list_orders(delivery_channel, INTEGER)',
        'tchefood_delivery_has_event(delivery_channel, VARCHAR)',
        'tchefood_delivery_save_order(delivery_channel, INTEGER, JSONB)',
        'tchefood_delivery_record_event(JSONB)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END LOOP;
END $$;
