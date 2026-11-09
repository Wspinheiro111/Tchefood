-- =============================================================================
-- TCHÊ FOOD — schema_expansion.sql (Fase 5 · Expansão Enterprise)
-- Barril de chopp, fichas de eventos antifraude, buffet a quilo (balança) e
-- CRM de cashback no WhatsApp.
--
-- Rode DEPOIS de db/schema.sql. O script é idempotente: pode ser executado de
-- novo sem erro (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
--
-- Espelho TypeScript: src/types.ts (mesmos nomes de tabela e coluna) e
-- src/lib/kegs.ts, src/lib/eventTickets.ts, src/lib/loyalty.ts, src/lib/scale.ts.
--
-- Correções em relação ao rascunho original (ver PR da Fase 5):
--  1. Barril: o gatilho só descontava no INSERT. Item cancelado nunca devolvia
--     o volume e o barril ficava "mais vazio" do que o faturado. Agora o
--     cancelamento antes de servir devolve ao barril e o cancelamento depois de
--     servir vira desperdício registrado (o chopp já saiu da torneira).
--  2. Barril: 500 ml fixo por unidade. Copo de 300 ml, caneca de 500 ml e
--     caneca de 1 L saem do mesmo barril; o volume vem da opção de tamanho
--     (modifier_options.volume_ml) ou do vínculo produto↔torneira (pour_ml) e
--     fica gravado no item (order_items.keg_volume_ml).
--  3. Barril: um produto ligado a duas torneiras ativas descontava das duas.
--     Agora cada produto sai de exatamente uma torneira (UNIQUE product_id).
--  4. Barril: GREATEST(0, ...) escondia venda acima da capacidade, que é
--     justamente o sinal de fraude/erro. O faturado é acumulado sem teto
--     (billed_volume_ml) e o restante estimado é coluna gerada.
--  5. Barril: troca de barril não tinha histórico. keg_history guarda o
--     aproveitamento de cada barril encerrado.
--  6. Fichas: payment_id ON DELETE CASCADE apagaria fichas impressas. Agora é
--     RESTRICT, a ficha aponta para o item vendido e o resgate é atômico
--     (uma ficha só pode ser resgatada uma vez, nem por dois caixas ao mesmo
--     tempo).
--  7. CRM: saldo de cashback era um número editável sem histórico. Agora é um
--     extrato imutável (cashback_ledger) com validade, regra de terça a quinta
--     e resgate FIFO; WhatsApp só com opt-in registrado (LGPD).
--  8. Segurança: as tabelas novas não tinham RLS. No Supabase isso expõe os
--     dados de todos os restaurantes para qualquer chave anon. Todas entram no
--     isolamento por tenant_id.
--  9. Balança: o preço e a quantidade do item pesado vinham do aparelho. O
--     banco agora recalcula quantity = (bruto − tara) / 1000 e usa o preço do
--     quilo do cadastro.
-- 10. Desconto/10%: a versão do rascunho voltava a usar a janela de 5 minutos da
--     autorização, que a Etapa 0 já tinha trocado (a fila offline sobe depois).
--     Agora vale a regra da Etapa 0, com a exceção do cashback presa ao mesmo
--     discount_before/discount_after.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. BUFFET A QUILO (BALANÇA) + CUSTO (CMV)
-- -----------------------------------------------------------------------------
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS sold_by_weight BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tare_weight_grams INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0.00;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tare_check;
ALTER TABLE products ADD CONSTRAINT products_tare_check CHECK (tare_weight_grams BETWEEN 0 AND 5000);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_cost_check;
ALTER TABLE products ADD CONSTRAINT products_cost_check CHECK (cost_price >= 0);
-- Produto pesado é vendido em KG na NFC-e (uCom = KG, qCom com 3 casas).
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_weight_unit_check;
ALTER TABLE products ADD CONSTRAINT products_weight_unit_check CHECK (NOT sold_by_weight OR unit = 'KG');

-- Leitura da balança gravada no item (auditoria do peso).
ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS weight_gross_grams INT,
    ADD COLUMN IF NOT EXISTS weight_tare_grams INT,
    ADD COLUMN IF NOT EXISTS weight_source VARCHAR(10),
    ADD COLUMN IF NOT EXISTS keg_volume_ml INT;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_weight_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_weight_check CHECK (
    (weight_gross_grams IS NULL AND weight_tare_grams IS NULL AND weight_source IS NULL)
    OR (weight_gross_grams > 0 AND weight_tare_grams >= 0 AND weight_gross_grams > weight_tare_grams
        AND weight_source IN ('SCALE', 'MANUAL'))
);
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_keg_volume_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_keg_volume_check CHECK (keg_volume_ml IS NULL OR keg_volume_ml > 0);

-- Item pesado: quantidade e preço SEMPRE derivados do peso e do cadastro.
-- Nome com "00" para rodar antes de trg_order_items_total (ordem alfabética).
CREATE OR REPLACE FUNCTION tchefood_weighed_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_product products%ROWTYPE;
BEGIN
    SELECT * INTO v_product FROM products WHERE id = NEW.product_id;
    IF v_product.sold_by_weight THEN
        IF NEW.weight_gross_grams IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_BALANCA: % é vendido por peso; informe a leitura da balança.', v_product.name;
        END IF;
        NEW.quantity := round((NEW.weight_gross_grams - NEW.weight_tare_grams)::numeric / 1000, 3);
        NEW.unit_price := v_product.price;
        NEW.modifiers_unit_price := 0;
    ELSIF NEW.weight_gross_grams IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_BALANCA: % não é vendido por peso.', v_product.name;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_00_weight ON order_items;
CREATE TRIGGER trg_order_items_00_weight BEFORE INSERT OR UPDATE OF quantity, unit_price, weight_gross_grams, weight_tare_grams
    ON order_items FOR EACH ROW EXECUTE FUNCTION tchefood_weighed_item();

-- -----------------------------------------------------------------------------
-- 2. VENDA DE BALCÃO / EVENTOS (sem abrir mesa)
-- -----------------------------------------------------------------------------
-- orders.table_id é NOT NULL no blueprint. A venda de balcão usa uma "mesa"
-- técnica do tipo COUNTER, que nunca é ocupada e não aparece no mapa.
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'TABLE';
-- Só cria a regra se ainda não existe: schema_kiosk.sql a amplia com 'KIOSK' e rodar
-- este arquivo de novo (supabase db push) não pode voltar à regra antiga.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_tables_kind_check') THEN
        ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_kind_check CHECK (kind IN ('TABLE', 'COUNTER'));
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. TORNEIRAS E BARRIS DE CHOPP (ANTI-DESPERDÍCIO)
-- -----------------------------------------------------------------------------
-- Volume por opção de tamanho (300 ml / 500 ml / 1 L) de um mesmo chopp.
ALTER TABLE modifier_options ADD COLUMN IF NOT EXISTS volume_ml INT;
ALTER TABLE modifier_options DROP CONSTRAINT IF EXISTS modifier_options_volume_check;
ALTER TABLE modifier_options ADD CONSTRAINT modifier_options_volume_check CHECK (volume_ml IS NULL OR volume_ml > 0);

CREATE TABLE IF NOT EXISTS keg_taps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tap_number INT NOT NULL CHECK (tap_number > 0),
    beer_name VARCHAR(100) NOT NULL,                       -- Ex.: "Chopp Pilsen 50L"
    total_capacity_ml INT NOT NULL DEFAULT 50000 CHECK (total_capacity_ml > 0),
    -- Faturado no caixa desde o engate. Sem teto: passar da capacidade é alerta.
    billed_volume_ml INT NOT NULL DEFAULT 0,
    -- Sangria, espuma e chopp servido e cancelado (registrado, com motivo).
    wasted_foam_ml INT NOT NULL DEFAULT 0 CHECK (wasted_foam_ml >= 0),
    -- Estimativa pelo caixa: capacidade − faturado − desperdício registrado.
    remaining_volume_ml INT GENERATED ALWAYS AS (GREATEST(total_capacity_ml - billed_volume_ml - wasted_foam_ml, 0)) STORED,
    -- Volume real medido (fluxômetro ou pesagem do barril) e quando.
    measured_remaining_ml INT CHECK (measured_remaining_ml IS NULL OR measured_remaining_ml >= 0),
    measured_at TIMESTAMPTZ,
    keg_cost NUMERIC(10,2) NOT NULL DEFAULT 480.00 CHECK (keg_cost >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    tapped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, tap_number)
);

-- Quais produtos saem de cada torneira e quanto cada unidade tira do barril.
CREATE TABLE IF NOT EXISTS keg_tap_products (
    tap_id UUID NOT NULL REFERENCES keg_taps(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    pour_ml INT NOT NULL DEFAULT 500 CHECK (pour_ml > 0),
    PRIMARY KEY (tap_id, product_id),
    UNIQUE (product_id)                                     -- cada produto sai de UMA torneira
);

-- Barris encerrados (troca de barril): aproveitamento de cada um.
CREATE TABLE IF NOT EXISTS keg_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tap_id UUID NOT NULL REFERENCES keg_taps(id) ON DELETE CASCADE,
    tap_number INT NOT NULL,
    beer_name VARCHAR(100) NOT NULL,
    total_capacity_ml INT NOT NULL,
    billed_volume_ml INT NOT NULL,
    wasted_foam_ml INT NOT NULL,
    measured_remaining_ml INT,
    keg_cost NUMERIC(10,2) NOT NULL,
    tapped_at TIMESTAMPTZ NOT NULL,
    kicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    kicked_by_user_id UUID NOT NULL REFERENCES staff_users(id),
    authorized_by_manager_id UUID NOT NULL REFERENCES staff_users(id)
);
CREATE INDEX IF NOT EXISTS idx_keg_history_tap ON keg_history(tap_id, kicked_at DESC);

-- Resolve o volume servido no lançamento (a opção de tamanho vence o padrão da torneira).
CREATE OR REPLACE FUNCTION tchefood_keg_item_volume()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_pour INT;
BEGIN
    IF NEW.keg_volume_ml IS NULL THEN
        SELECT l.pour_ml INTO v_pour FROM keg_tap_products l WHERE l.product_id = NEW.product_id;
        NEW.keg_volume_ml := v_pour;  -- NULL quando o produto não sai de torneira
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_keg_volume ON order_items;
CREATE TRIGGER trg_order_items_keg_volume BEFORE INSERT ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_keg_item_volume();

-- Baixa (venda) e devolução/desperdício (cancelamento) no barril da torneira.
-- Só mexe no barril engatado quando o item foi lançado (created_at >= tapped_at):
-- cancelar um chopp do barril anterior não "enche" o barril novo.
CREATE OR REPLACE FUNCTION tchefood_keg_on_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_ml INT;
BEGIN
    IF NEW.keg_volume_ml IS NULL THEN RETURN NULL; END IF;
    v_ml := round(NEW.quantity * NEW.keg_volume_ml)::INT;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'CANCELED' THEN
            UPDATE keg_taps t SET billed_volume_ml = t.billed_volume_ml + v_ml
              FROM keg_tap_products l
             WHERE l.product_id = NEW.product_id AND l.tap_id = t.id AND t.active AND NEW.created_at >= t.tapped_at;
        END IF;
    ELSIF NEW.status = 'CANCELED' AND OLD.status <> 'CANCELED' THEN
        IF OLD.status IN ('PENDING', 'PREPARING') THEN
            -- Ainda não saiu da torneira: volta para o barril.
            UPDATE keg_taps t SET billed_volume_ml = t.billed_volume_ml - v_ml
              FROM keg_tap_products l
             WHERE l.product_id = NEW.product_id AND l.tap_id = t.id AND t.active AND NEW.created_at >= t.tapped_at;
        ELSE
            -- Já foi tirado (READY/DELIVERED): deixa de ser faturado e vira desperdício.
            UPDATE keg_taps t SET billed_volume_ml = t.billed_volume_ml - v_ml,
                                  wasted_foam_ml = t.wasted_foam_ml + v_ml
              FROM keg_tap_products l
             WHERE l.product_id = NEW.product_id AND l.tap_id = t.id AND t.active AND NEW.created_at >= t.tapped_at;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_deduct_keg_on_item ON order_items;  -- nome do rascunho original
DROP TRIGGER IF EXISTS trg_order_items_keg ON order_items;
CREATE TRIGGER trg_order_items_keg AFTER INSERT OR UPDATE OF status ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_keg_on_item();
DROP FUNCTION IF EXISTS deduct_keg_volume_on_sale();

-- Troca de barril: guarda o encerrado no histórico e zera os contadores.
-- Zerar contadores esconde perdas, por isso exige gerente e vira audit_log.
CREATE OR REPLACE FUNCTION tchefood_tap_new_keg(
    p_tap_id UUID, p_beer_name VARCHAR, p_capacity_ml INT, p_keg_cost NUMERIC,
    p_user_id UUID, p_manager_id UUID, p_reason TEXT
) RETURNS keg_taps LANGUAGE plpgsql AS $$
DECLARE v_tap keg_taps%ROWTYPE; v_ok BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM staff_users m WHERE m.id = p_manager_id AND m.role IN ('MANAGER', 'OWNER') AND m.active) INTO v_ok;
    IF NOT v_ok THEN RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: troca de barril exige gerente.'; END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: informe o motivo da troca.'; END IF;

    SELECT * INTO v_tap FROM keg_taps WHERE id = p_tap_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Torneira % não encontrada.', p_tap_id; END IF;

    INSERT INTO keg_history (tenant_id, tap_id, tap_number, beer_name, total_capacity_ml, billed_volume_ml, wasted_foam_ml,
                             measured_remaining_ml, keg_cost, tapped_at, kicked_by_user_id, authorized_by_manager_id)
    VALUES (v_tap.tenant_id, v_tap.id, v_tap.tap_number, v_tap.beer_name, v_tap.total_capacity_ml, v_tap.billed_volume_ml,
            v_tap.wasted_foam_ml, v_tap.measured_remaining_ml, v_tap.keg_cost, v_tap.tapped_at, p_user_id, p_manager_id);

    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tap.tenant_id, NULL, p_user_id, p_manager_id, 'KEG_CHANGED', 0, trim(p_reason),
            jsonb_build_object('tap_number', v_tap.tap_number, 'beer_before', v_tap.beer_name, 'beer_after', p_beer_name,
                               'billed_ml', v_tap.billed_volume_ml, 'wasted_ml', v_tap.wasted_foam_ml,
                               'measured_remaining_ml', v_tap.measured_remaining_ml));

    UPDATE keg_taps SET beer_name = p_beer_name, total_capacity_ml = p_capacity_ml, keg_cost = p_keg_cost,
                        billed_volume_ml = 0, wasted_foam_ml = 0, measured_remaining_ml = NULL, measured_at = NULL,
                        active = TRUE, tapped_at = NOW()
     WHERE id = p_tap_id RETURNING * INTO v_tap;
    RETURN v_tap;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. FICHAS INDIVIDUAIS DE BALCÃO / BAILES E EVENTOS (BOBINA 58mm)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
    payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT,
    product_id UUID NOT NULL REFERENCES products(id),
    product_name_snapshot VARCHAR(120) NOT NULL,
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    ticket_seq INT NOT NULL CHECK (ticket_seq > 0),          -- 1..quantidade do item
    -- Código antifraude impresso na bobina: 15 caracteres aleatórios (75 bits,
    -- alfabeto Crockford sem I/L/O/U) + 1 dígito verificador.
    barcode_token VARCHAR(24) UNIQUE NOT NULL CHECK (barcode_token ~ '^[0-9A-HJKMNP-TV-Z]{16}$'),
    redeemed BOOLEAN NOT NULL DEFAULT FALSE,
    redeemed_at TIMESTAMPTZ,
    redeemed_by_user_id UUID REFERENCES staff_users(id),
    voided_at TIMESTAMPTZ,
    voided_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_item_id, ticket_seq),
    CHECK ((redeemed AND redeemed_at IS NOT NULL AND redeemed_by_user_id IS NOT NULL)
           OR (NOT redeemed AND redeemed_at IS NULL AND redeemed_by_user_id IS NULL)),
    CHECK (NOT (redeemed AND voided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_event_tickets_order ON event_tickets(order_id);

-- Emissão: só para venda paga, uma ficha por unidade inteira do item.
CREATE OR REPLACE FUNCTION tchefood_ticket_issue_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_order orders%ROWTYPE; v_item order_items%ROWTYPE;
BEGIN
    SELECT * INTO v_order FROM orders WHERE id = NEW.order_id;
    SELECT * INTO v_item FROM order_items WHERE id = NEW.order_item_id;
    IF v_item.order_id IS DISTINCT FROM NEW.order_id OR v_item.product_id IS DISTINCT FROM NEW.product_id THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: item não pertence à venda.';
    END IF;
    IF v_order.status <> 'CLOSED' OR v_order.remaining_balance <> 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: ficha só é impressa depois da venda paga.';
    END IF;
    IF v_item.status = 'CANCELED' THEN RAISE EXCEPTION 'TCHEFOOD_FICHA: item cancelado.'; END IF;
    IF v_item.quantity <> trunc(v_item.quantity) OR NEW.ticket_seq > v_item.quantity THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: % ficha(s) no máximo para este item.', trunc(v_item.quantity);
    END IF;
    IF NEW.unit_price <> v_item.unit_price + v_item.modifiers_unit_price THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: valor da ficha diferente do item vendido.';
    END IF;
    IF NEW.redeemed OR NEW.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: ficha nasce em aberto.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_event_tickets_issue ON event_tickets;
CREATE TRIGGER trg_event_tickets_issue BEFORE INSERT ON event_tickets
    FOR EACH ROW EXECUTE FUNCTION tchefood_ticket_issue_check();

-- Depois de impressa: nada muda além de resgatar (uma vez) ou anular (se não resgatada).
CREATE OR REPLACE FUNCTION tchefood_ticket_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: ficha impressa não pode ser apagada; anule com motivo.';
    END IF;
    IF NEW.barcode_token <> OLD.barcode_token OR NEW.unit_price <> OLD.unit_price OR NEW.order_item_id <> OLD.order_item_id
       OR NEW.product_id <> OLD.product_id OR NEW.ticket_seq <> OLD.ticket_seq THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: dados da ficha são imutáveis.';
    END IF;
    IF OLD.redeemed AND (NOT NEW.redeemed OR NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at) THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: ficha já resgatada em %.', OLD.redeemed_at;
    END IF;
    IF OLD.voided_at IS NOT NULL AND (NEW.redeemed OR NEW.voided_at IS DISTINCT FROM OLD.voided_at) THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: ficha anulada.';
    END IF;
    IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL AND (NEW.voided_reason IS NULL OR length(trim(NEW.voided_reason)) < 5) THEN
        RAISE EXCEPTION 'TCHEFOOD_FICHA: informe o motivo da anulação.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_event_tickets_guard ON event_tickets;
CREATE TRIGGER trg_event_tickets_guard BEFORE UPDATE OR DELETE ON event_tickets
    FOR EACH ROW EXECUTE FUNCTION tchefood_ticket_guard();

-- Resgate atômico no balcão: duas leituras simultâneas do mesmo código, só uma passa.
-- Quando todas as fichas do item são resgatadas, o item vira DELIVERED.
CREATE OR REPLACE FUNCTION tchefood_redeem_ticket(p_token VARCHAR, p_user_id UUID)
RETURNS event_tickets LANGUAGE plpgsql AS $$
DECLARE v_ticket event_tickets%ROWTYPE; v_open INT;
BEGIN
    UPDATE event_tickets SET redeemed = TRUE, redeemed_at = NOW(), redeemed_by_user_id = p_user_id
     WHERE barcode_token = upper(p_token) AND NOT redeemed AND voided_at IS NULL
     RETURNING * INTO v_ticket;
    IF NOT FOUND THEN
        SELECT * INTO v_ticket FROM event_tickets WHERE barcode_token = upper(p_token);
        IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_FICHA: código % não existe.', p_token; END IF;
        IF v_ticket.voided_at IS NOT NULL THEN RAISE EXCEPTION 'TCHEFOOD_FICHA: ficha anulada (%).', v_ticket.voided_reason; END IF;
        RAISE EXCEPTION 'TCHEFOOD_FICHA: ficha já resgatada em %.', v_ticket.redeemed_at;
    END IF;
    SELECT count(*) INTO v_open FROM event_tickets
     WHERE order_item_id = v_ticket.order_item_id AND NOT redeemed AND voided_at IS NULL;
    IF v_open = 0 THEN
        UPDATE order_items SET status = 'DELIVERED', prepared_at = COALESCE(prepared_at, NOW())
         WHERE id = v_ticket.order_item_id AND status <> 'CANCELED';
    END IF;
    RETURN v_ticket;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. CRM DE FIDELIDADE E CASHBACK (WHATSAPP)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loyalty_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(120),
    phone_whatsapp VARCHAR(20) NOT NULL CHECK (phone_whatsapp ~ '^55[1-9][0-9][0-9]{8,9}$'), -- 55 + DDD + número, só dígitos
    cpf VARCHAR(11) CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
    -- LGPD + política do WhatsApp Business: só mensagem com consentimento registrado.
    whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    opt_in_at TIMESTAMPTZ,
    cashback_balance NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (cashback_balance >= 0), -- cache do extrato
    total_spent NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    visits_count INT NOT NULL DEFAULT 0,
    last_visit_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, phone_whatsapp),
    CHECK (NOT whatsapp_opt_in OR opt_in_at IS NOT NULL)
);

-- Extrato imutável do cashback. EARN tem validade e saldo próprio (consumido FIFO).
CREATE TABLE IF NOT EXISTS cashback_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES loyalty_customers(id) ON DELETE RESTRICT,
    order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('EARN', 'REDEEM', 'EXPIRE')),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    remaining_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (remaining_amount >= 0),
    base_amount NUMERIC(10,2),
    pct NUMERIC(5,2),
    valid_from TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES staff_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_id, entry_type),                         -- um crédito e um resgate por conta
    CHECK (entry_type <> 'EARN' OR (valid_from IS NOT NULL AND expires_at > valid_from AND remaining_amount <= amount)),
    CHECK (entry_type = 'EARN' OR remaining_amount = 0)
);
CREATE INDEX IF NOT EXISTS idx_cashback_ledger_customer ON cashback_ledger(customer_id, created_at);

-- Regras do programa (iguais a src/lib/loyalty.ts).
CREATE OR REPLACE FUNCTION tchefood_cashback_pct() RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$ SELECT 5.00::numeric $$;
CREATE OR REPLACE FUNCTION tchefood_cashback_validity_days() RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT 30 $$;
CREATE OR REPLACE FUNCTION tchefood_cashback_max_usage_pct() RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$ SELECT 50.00::numeric $$;
-- Resgate só de terça (2) a quinta (4), no fuso de Brasília: enche o salão nos dias fracos.
CREATE OR REPLACE FUNCTION tchefood_is_cashback_day(p_at TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXTRACT(ISODOW FROM p_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 2 AND 4
$$;

-- Base do cashback: consumo sem os 10% do garçom e já com desconto.
CREATE OR REPLACE FUNCTION tchefood_cashback_base(p_order orders) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(p_order.total_amount - p_order.service_fee_amount, 0)
$$;

-- Saldo disponível agora (créditos já liberados e não vencidos).
CREATE OR REPLACE FUNCTION tchefood_cashback_available(p_customer_id UUID, p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(remaining_amount), 0) FROM cashback_ledger
     WHERE customer_id = p_customer_id AND entry_type = 'EARN' AND valid_from <= p_at AND expires_at > p_at
$$;

CREATE OR REPLACE FUNCTION tchefood_refresh_cashback_balance(p_customer_id UUID)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE loyalty_customers SET cashback_balance =
        (SELECT COALESCE(SUM(remaining_amount), 0) FROM cashback_ledger
          WHERE customer_id = p_customer_id AND entry_type = 'EARN' AND expires_at > NOW())
     WHERE id = p_customer_id
$$;

-- Crédito: só de conta encerrada e no valor exato da regra.
CREATE OR REPLACE FUNCTION tchefood_cashback_ledger_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_order orders%ROWTYPE; v_expected NUMERIC(10,2);
BEGIN
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
DROP TRIGGER IF EXISTS trg_cashback_ledger_check ON cashback_ledger;
CREATE TRIGGER trg_cashback_ledger_check BEFORE INSERT ON cashback_ledger
    FOR EACH ROW EXECUTE FUNCTION tchefood_cashback_ledger_check();

-- Extrato é append-only; só o saldo restante de um crédito pode diminuir (resgate FIFO).
CREATE OR REPLACE FUNCTION tchefood_cashback_ledger_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'TCHEFOOD_CASHBACK: extrato é somente inserção.'; END IF;
    IF NEW.amount <> OLD.amount OR NEW.entry_type <> OLD.entry_type OR NEW.customer_id <> OLD.customer_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.remaining_amount > OLD.remaining_amount THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: extrato é somente inserção.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cashback_ledger_guard ON cashback_ledger;
CREATE TRIGGER trg_cashback_ledger_guard BEFORE UPDATE OR DELETE ON cashback_ledger
    FOR EACH ROW EXECUTE FUNCTION tchefood_cashback_ledger_guard();

CREATE OR REPLACE FUNCTION tchefood_cashback_after_ledger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM tchefood_refresh_cashback_balance(NEW.customer_id);
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_cashback_ledger_balance ON cashback_ledger;
CREATE TRIGGER trg_cashback_ledger_balance AFTER INSERT OR UPDATE ON cashback_ledger
    FOR EACH ROW EXECUTE FUNCTION tchefood_cashback_after_ledger();

-- Resgate do cashback na conta aberta: vira desconto (vDesc na NFC-e), consome
-- os créditos mais antigos primeiro e grava audit_log CASHBACK_REDEEMED.
CREATE OR REPLACE FUNCTION tchefood_redeem_cashback(p_customer_id UUID, p_order_id UUID, p_user_id UUID)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE
    v_order orders%ROWTYPE; v_customer loyalty_customers%ROWTYPE;
    v_available NUMERIC(10,2); v_cap NUMERIC(10,2); v_amount NUMERIC(10,2); v_left NUMERIC(10,2); v_take NUMERIC(10,2);
    r RECORD;
BEGIN
    IF NOT tchefood_is_cashback_day(NOW()) THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: cashback só pode ser usado de terça a quinta.';
    END IF;
    SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND OR v_order.status NOT IN ('OPEN', 'PAYING') THEN RAISE EXCEPTION 'TCHEFOOD_CASHBACK: conta não está aberta.'; END IF;
    SELECT * INTO v_customer FROM loyalty_customers WHERE id = p_customer_id FOR UPDATE;
    IF NOT FOUND OR v_customer.tenant_id <> v_order.tenant_id THEN RAISE EXCEPTION 'TCHEFOOD_CASHBACK: cliente inválido.'; END IF;
    IF EXISTS (SELECT 1 FROM cashback_ledger WHERE order_id = p_order_id AND entry_type = 'REDEEM') THEN
        RAISE EXCEPTION 'TCHEFOOD_CASHBACK: esta conta já usou cashback.';
    END IF;

    v_available := tchefood_cashback_available(p_customer_id, NOW());
    v_cap := round(v_order.total_amount * tchefood_cashback_max_usage_pct() / 100, 2);
    v_amount := LEAST(v_available, v_cap, v_order.remaining_balance);
    IF v_amount <= 0 THEN RAISE EXCEPTION 'TCHEFOOD_CASHBACK: sem saldo disponível.'; END IF;

    v_left := v_amount;
    FOR r IN SELECT id, remaining_amount FROM cashback_ledger
              WHERE customer_id = p_customer_id AND entry_type = 'EARN' AND remaining_amount > 0
                AND valid_from <= NOW() AND expires_at > NOW()
              ORDER BY expires_at, created_at FOR UPDATE LOOP
        EXIT WHEN v_left <= 0;
        v_take := LEAST(r.remaining_amount, v_left);
        UPDATE cashback_ledger SET remaining_amount = remaining_amount - v_take WHERE id = r.id;
        v_left := v_left - v_take;
    END LOOP;

    INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, created_by_user_id)
    VALUES (v_order.tenant_id, p_customer_id, p_order_id, 'REDEEM', v_amount, p_user_id);
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact,
                            reason, whatsapp_alert_sent, metadata)
    VALUES (v_order.tenant_id, p_order_id, p_user_id, NULL, 'CASHBACK_REDEEMED', -v_amount,
            'Cashback de fidelidade resgatado', FALSE,
            jsonb_build_object('customer_id', p_customer_id, 'phone', v_customer.phone_whatsapp, 'amount', v_amount,
                               'discount_before', v_order.discount_amount, 'discount_after', v_order.discount_amount + v_amount));
    UPDATE orders SET discount_amount = discount_amount + v_amount WHERE id = p_order_id;
    RETURN v_amount;
END;
$$;

-- O desconto da conta continua exigindo gerente, EXCETO quando o aumento é
-- exatamente o cashback resgatado (registrado no extrato e em audit_logs).
-- Mesma regra da Etapa 0 (db/schema.sql, seção 4): a autorização fica presa à
-- operação, sem janela de 5 minutos, porque a fila offline pode subir horas depois.
--  - remover os 10%: o último registro de 10% da comanda (pela ordem de gravação no
--    servidor, server_seq) tem de ser SERVICE_FEE_REMOVED autorizado por gerente ativo;
--  - desconto: o último DISCOUNT_APPLIED da comanda tem de ser exatamente desta
--    mudança (discount_before = valor atual, discount_after = valor novo), ou o
--    aumento tem de ser o cashback desta conta: REDEEM no extrato com o valor do
--    aumento e audit_log CASHBACK_REDEEMED com o mesmo discount_before/discount_after.
--  - um UPDATE que tira os 10% e aumenta o desconto precisa das duas autorizações.
-- Ordem real de gravação dos audit_logs no servidor. created_at é a hora do
-- aparelho (a fila offline sobe horas depois, e o aparelho escolhe esse valor),
-- enquanto as autorizações gravadas por função ficam com a hora do servidor:
-- comparar as duas deixaria um SERVICE_FEE_RESTORED antigo perder para a remoção
-- que veio antes dele. server_seq é dado pelo banco e não aceita valor do cliente
-- (GENERATED ALWAYS), e a fila sobe na ordem em que as ações aconteceram.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS server_seq BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE INDEX IF NOT EXISTS idx_audit_logs_order_seq ON audit_logs(order_id, server_seq DESC);

CREATE OR REPLACE FUNCTION tchefood_require_order_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_ok BOOLEAN;
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
        SELECT ((a.metadata->>'discount_before')::NUMERIC = OLD.discount_amount
                AND (a.metadata->>'discount_after')::NUMERIC = NEW.discount_amount
                AND m.role IN ('MANAGER', 'OWNER') AND m.active)
          INTO v_ok
          FROM audit_logs a LEFT JOIN staff_users m ON m.id = a.authorized_by_manager_id
         WHERE a.order_id = NEW.id AND a.action_type = 'DISCOUNT_APPLIED'
         ORDER BY a.server_seq DESC
         LIMIT 1;
        IF NOT COALESCE(v_ok, FALSE) THEN
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
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: DISCOUNT_APPLIED sem PIN de gerente registrado em audit_logs.';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. RLS (Supabase) — as tabelas novas entram no isolamento por tenant
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['keg_taps', 'keg_history', 'event_tickets', 'loyalty_customers', 'cashback_ledger'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
        EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = tchefood_tenant()) WITH CHECK (tenant_id = tchefood_tenant())', t || '_tenant', t);
    END LOOP;
END $$;

ALTER TABLE keg_tap_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS keg_tap_products_tenant ON keg_tap_products;
CREATE POLICY keg_tap_products_tenant ON keg_tap_products
    USING (EXISTS (SELECT 1 FROM keg_taps k WHERE k.id = tap_id AND k.tenant_id = tchefood_tenant()))
    WITH CHECK (EXISTS (SELECT 1 FROM keg_taps k WHERE k.id = tap_id AND k.tenant_id = tchefood_tenant()));

-- Realtime: monitor de barris no bar e resgate de fichas entre maquininhas.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'keg_taps') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE keg_taps;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'event_tickets') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE event_tickets;
        END IF;
    END IF;
END $$;
