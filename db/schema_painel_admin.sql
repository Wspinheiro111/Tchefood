-- =============================================================================
-- Tchê Food — painel administrativo da plataforma (lojas, planos e mensalidades)
-- Aplicar depois de schema.sql e das outras migrations (idempotente).
--
-- Quem usa: a equipe do Tchê Food (o Will), não as lojas. O painel (pasta admin/) entra
-- com uma conta do Supabase Auth SEM tenant_id e chama só as funções tchefood_admin_*
-- abaixo. Decisão do Will (14/11/2026): Tchê Food e Tchê Vendas ficam separados, então o
-- cadastro e a cobrança das lojas do Tchê Food moram aqui, e não no Tchê Vendas Control.
--
-- Regras:
--   - Admin = linha ativa em platform_admins com o user_id do JWT (claim sub). Token com
--     tenant_id (o token de um aparelho de loja) nunca é admin, mesmo com o sub na lista.
--   - As tabelas novas não são lidas nem gravadas direto por anon/authenticated (RLS ligado
--     e sem GRANT): tudo passa pelas funções, que conferem o admin e gravam a auditoria.
--   - Mensalidade paga = valor exato da cobrança, com a forma e a referência do pagamento
--     (id do Pix, nosso número do boleto, recibo). A mesma referência não paga duas
--     cobranças. Pagar tira a loja de teste ou suspensa e põe em ativa (no Tchê Vendas o
--     pagamento não mexia na licença: a loja paga ficava em teste).
--   - Vencida = cobrança em aberto com vencimento antes de hoje (fuso de São Paulo). Cobrança
--     que ainda não venceu é "a receber", não inadimplência.
--   - Cobrança paga ou cancelada não muda mais; histórico (platform_admin_audit) só recebe
--     linhas novas.
--   - Esta versão não bloqueia a loja por atraso (os dias de carência ainda não foram
--     decididos) e não fala com o Asaas: o link do boleto/Pix é colado na cobrança e o
--     pagamento é registrado à mão.
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_admins (
    user_id UUID PRIMARY KEY,
    email VARCHAR(200) NOT NULL,
    name VARCHAR(100) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_plans (
    id VARCHAR(30) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    monthly_price NUMERIC(10,2) NOT NULL CHECK (monthly_price > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 0
);

-- Os planos da landing (landing/src/lib/config.ts).
INSERT INTO platform_plans (id, name, monthly_price, sort_order) VALUES
    ('bistro', 'Bistrô & Lancheria', 99.00, 1),
    ('salao-pro', 'Churrascaria & Salão Pro', 199.00, 2),
    ('rede-eventos', 'Rede & Eventos', 299.00, 3)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS store_subscriptions (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
    plan_id VARCHAR(30) NOT NULL REFERENCES platform_plans(id),
    -- Preço desta loja (começa no do plano; pode ser negociado). Zero = cortesia.
    monthly_price NUMERIC(10,2) NOT NULL CHECK (monthly_price >= 0 AND monthly_price <= 100000),
    status VARCHAR(12) NOT NULL CHECK (status IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED')),
    billing_day SMALLINT NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
    trial_ends_on DATE,
    contact_name VARCHAR(100) NOT NULL CHECK (length(btrim(contact_name)) >= 2),
    -- Só dígitos, com DDD (e DDI 55 opcional): vira o link do WhatsApp.
    contact_phone VARCHAR(13) NOT NULL CHECK (contact_phone ~ '^(55)?[1-9][0-9]{9,10}$'),
    contact_email VARCHAR(200),
    notes TEXT,
    -- Conta do Supabase Auth do aparelho (criada pela função admin-device-account).
    -- PENDING = id reservado, conta ainda não confirmada; READY = conta criada.
    device_user_id UUID UNIQUE,
    device_email VARCHAR(200) UNIQUE,
    device_status VARCHAR(10) CHECK (device_status IN ('PENDING', 'READY')),
    -- Operação em andamento na conta do aparelho (criar ou trocar senha): uma por vez por
    -- loja, para duas chamadas ao mesmo tempo não devolverem duas senhas diferentes.
    device_op_id UUID,
    device_op_started_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status <> 'TRIAL' OR trial_ends_on IS NOT NULL),
    CHECK ((device_user_id IS NULL) = (device_status IS NULL) AND (device_user_id IS NULL) = (device_email IS NULL)),
    CHECK ((device_op_id IS NULL) = (device_op_started_at IS NULL))
);

CREATE TABLE IF NOT EXISTS store_charges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES store_subscriptions(tenant_id) ON DELETE RESTRICT,
    -- Mês de referência: sempre o dia 1.
    reference_month DATE NOT NULL CHECK (EXTRACT(DAY FROM reference_month) = 1),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0 AND amount <= 100000),
    due_date DATE NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAID', 'CANCELLED')),
    payment_link VARCHAR(500) CHECK (payment_link IS NULL OR payment_link ~ '^https://[^\s]+$'),
    paid_on DATE,
    paid_amount NUMERIC(10,2),
    payment_method VARCHAR(15) CHECK (payment_method IN ('PIX', 'BOLETO', 'CARTAO', 'TRANSFERENCIA', 'DINHEIRO')),
    payment_reference VARCHAR(120),
    paid_at TIMESTAMPTZ,
    paid_by UUID,
    cancel_reason TEXT,
    cancelled_at TIMESTAMPTZ,
    cancelled_by UUID,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((status = 'PAID') = (paid_on IS NOT NULL AND paid_amount IS NOT NULL AND payment_method IS NOT NULL
                                AND payment_reference IS NOT NULL AND paid_at IS NOT NULL AND paid_by IS NOT NULL)),
    CHECK (status <> 'PAID' OR paid_amount = amount),
    CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
-- Uma cobrança por loja e mês (a cancelada não conta: pode ser refeita).
CREATE UNIQUE INDEX IF NOT EXISTS store_charges_one_per_month ON store_charges (tenant_id, reference_month) WHERE status <> 'CANCELLED';
-- A mesma referência de pagamento não paga duas cobranças.
-- Um comprovante quita uma cobrança só, qualquer que seja a forma registrada (o mesmo E2E
-- de Pix lançado como TRANSFERENCIA em outra cobrança também é recusado).
DROP INDEX IF EXISTS store_charges_payment_reference;
CREATE UNIQUE INDEX IF NOT EXISTS store_charges_payment_reference_once ON store_charges (lower(payment_reference)) WHERE status = 'PAID';
CREATE INDEX IF NOT EXISTS store_charges_open_due ON store_charges (due_date) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS platform_admin_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL,
    tenant_id UUID,
    charge_id UUID,
    action VARCHAR(40) NOT NULL,
    reason TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS platform_admin_audit_tenant ON platform_admin_audit (tenant_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Travas: cobrança fechada não muda; histórico só cresce.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_admin_charges_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: cobrança não é apagada; cancele com motivo' USING ERRCODE = '42501';
    END IF;
    IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: cobrança % já está fechada (%)', OLD.id, OLD.status USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.reference_month <> OLD.reference_month OR NEW.amount <> OLD.amount
       OR NEW.due_date <> OLD.due_date OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
       OR NEW.id <> OLD.id THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: valor, mês e vencimento da cobrança não mudam; cancele e crie outra' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_store_charges_guard ON store_charges;
CREATE TRIGGER trg_store_charges_guard BEFORE UPDATE OR DELETE ON store_charges
    FOR EACH ROW EXECUTE FUNCTION tchefood_admin_charges_guard();
-- TRUNCATE não passa pelo gatilho por linha: trava à parte (cobranças e assinaturas).
DROP TRIGGER IF EXISTS trg_store_charges_truncate ON store_charges;
CREATE TRIGGER trg_store_charges_truncate BEFORE TRUNCATE ON store_charges
    FOR EACH STATEMENT EXECUTE FUNCTION tchefood_admin_charges_guard();
DROP TRIGGER IF EXISTS trg_store_subscriptions_truncate ON store_subscriptions;
CREATE TRIGGER trg_store_subscriptions_truncate BEFORE TRUNCATE ON store_subscriptions
    FOR EACH STATEMENT EXECUTE FUNCTION tchefood_admin_charges_guard();

CREATE OR REPLACE FUNCTION tchefood_admin_audit_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'TCHEFOOD_ADMIN: o histórico do painel só recebe linhas novas' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_platform_admin_audit_guard ON platform_admin_audit;
CREATE TRIGGER trg_platform_admin_audit_guard BEFORE UPDATE OR DELETE ON platform_admin_audit
    FOR EACH ROW EXECUTE FUNCTION tchefood_admin_audit_guard();
DROP TRIGGER IF EXISTS trg_platform_admin_audit_truncate ON platform_admin_audit;
CREATE TRIGGER trg_platform_admin_audit_truncate BEFORE TRUNCATE ON platform_admin_audit
    FOR EACH STATEMENT EXECUTE FUNCTION tchefood_admin_audit_guard();

-- Só pelas funções: nem o aparelho (authenticated com tenant_id) nem o anon tocam nas tabelas.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_audit ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON platform_admins, platform_plans, store_subscriptions, store_charges, platform_admin_audit
            FROM PUBLIC, anon, authenticated;
    END IF;
    -- A service role (usada só para o Auth na função admin-device-account) não esvazia nem
    -- escreve direto no histórico e nas cobranças.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE TRUNCATE ON platform_admins, platform_plans, store_subscriptions, store_charges, platform_admin_audit FROM service_role;
        REVOKE INSERT, UPDATE, DELETE ON platform_admin_audit, store_charges FROM service_role;
    END IF;
END $$;

-- Uso da loja no painel (última venda e pedidos nos últimos dias, por loja).
CREATE INDEX IF NOT EXISTS idx_orders_tenant_opened ON orders (tenant_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_tenant_placed ON delivery_orders (tenant_id, placed_at DESC);

-- -----------------------------------------------------------------------------
-- Apoio
-- -----------------------------------------------------------------------------

-- Hoje no fuso da loja (São Paulo). Função própria para o teste poder fixar a data.
CREATE OR REPLACE FUNCTION tchefood_admin_today() RETURNS DATE LANGUAGE sql STABLE AS $$
    SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
$$;

-- Quem chama precisa ser admin ativo, com token sem loja.
CREATE OR REPLACE FUNCTION tchefood_admin_require() RETURNS platform_admins
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_claims JSONB; v_sub TEXT; v_admin platform_admins%ROWTYPE;
BEGIN
    BEGIN
        v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    EXCEPTION WHEN others THEN
        v_claims := NULL;
    END;
    IF v_claims IS NULL OR jsonb_typeof(v_claims) <> 'object' OR COALESCE(v_claims->>'role', '') <> 'authenticated' THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: acesso restrito à equipe do Tchê Food' USING ERRCODE = '42501';
    END IF;
    -- Token de aparelho de loja nunca é admin.
    IF NULLIF(v_claims->>'tenant_id', '') IS NOT NULL
       OR (jsonb_typeof(v_claims->'app_metadata') = 'object' AND NULLIF(v_claims->'app_metadata'->>'tenant_id', '') IS NOT NULL) THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: acesso restrito à equipe do Tchê Food' USING ERRCODE = '42501';
    END IF;
    v_sub := v_claims->>'sub';
    IF v_sub IS NULL OR v_sub !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: acesso restrito à equipe do Tchê Food' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_admin FROM platform_admins a WHERE a.user_id = v_sub::uuid AND a.active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: acesso restrito à equipe do Tchê Food' USING ERRCODE = '42501';
    END IF;
    RETURN v_admin;
END;
$$;

-- CNPJ com os dois dígitos verificadores, numérico ou alfanumérico (Receita Federal,
-- IN RFB 2.229/2024): 12 posições de 0-9 ou A-Z e 2 dígitos verificadores numéricos. O valor
-- de cada posição é o código ASCII menos 48 (0-9 valem 0-9, A vale 17, ..., Z vale 42).
-- Espera o valor já normalizado (sem pontuação, letras maiúsculas).
CREATE OR REPLACE FUNCTION tchefood_admin_cnpj_valid(p_cnpj TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE w1 INT[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2]; w2 INT[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
        s INT; d1 INT; d2 INT; i INT;
BEGIN
    IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' OR p_cnpj ~ '^(.)\1{13}$' THEN RETURN FALSE; END IF;
    s := 0;
    FOR i IN 1..12 LOOP s := s + (ascii(substr(p_cnpj, i, 1)) - 48) * w1[i]; END LOOP;
    d1 := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
    s := 0;
    FOR i IN 1..13 LOOP s := s + (ascii(substr(p_cnpj, i, 1)) - 48) * w2[i]; END LOOP;
    d2 := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
    RETURN substr(p_cnpj, 13, 1)::int = d1 AND substr(p_cnpj, 14, 1)::int = d2;
END;
$$;

-- Normaliza o CNPJ digitado: tira pontos, barra, traço e espaços, e passa letras para maiúsculas.
CREATE OR REPLACE FUNCTION tchefood_admin_clean_cnpj(p_cnpj TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT upper(regexp_replace(COALESCE(p_cnpj, ''), '[^0-9A-Za-z]', '', 'g'))
$$;

-- Vencimento de um mês: o dia de cobrança da loja dentro do mês de referência.
CREATE OR REPLACE FUNCTION tchefood_admin_due_date(p_month DATE, p_billing_day INT) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
    SELECT (date_trunc('month', p_month)::date + (p_billing_day - 1))
$$;

-- Início de um dia de São Paulo, como instante (para as janelas de 7 e 30 dias do painel).
CREATE OR REPLACE FUNCTION tchefood_admin_day_start(p_day DATE) RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
    SELECT (p_day::timestamp AT TIME ZONE 'America/Sao_Paulo')
$$;

-- Vendas da loja para os indicadores de uso: pedidos do salão/balcão não cancelados e pedidos
-- de delivery (iFood) não cancelados.
CREATE OR REPLACE FUNCTION tchefood_admin_sales(p_tenant UUID) RETURNS TABLE (at TIMESTAMPTZ) LANGUAGE sql STABLE
SET search_path = public, pg_temp AS $$
    SELECT o.opened_at FROM orders o WHERE o.tenant_id = p_tenant AND o.status <> 'CANCELED'
    UNION ALL
    SELECT d.placed_at FROM delivery_orders d WHERE d.tenant_id = p_tenant AND d.status <> 'cancelled'
$$;

-- Mês de cobrança aceito: de 12 meses atrás até o mês que vem (evita 1990 por engano).
CREATE OR REPLACE FUNCTION tchefood_admin_check_month(p_month DATE) RETURNS VOID LANGUAGE plpgsql STABLE AS $$
DECLARE v_now DATE := date_trunc('month', tchefood_admin_today())::date;
BEGIN
    IF p_month IS NULL OR p_month < (v_now - INTERVAL '12 months')::date OR p_month > (v_now + INTERVAL '1 month')::date THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: mês da cobrança fora do período aceito (até 12 meses atrás ou o mês que vem)';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_admin_log(p_admin UUID, p_tenant UUID, p_charge UUID, p_action TEXT, p_reason TEXT, p_details JSONB)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    INSERT INTO platform_admin_audit (admin_user_id, tenant_id, charge_id, action, reason, details)
    VALUES (p_admin, p_tenant, p_charge, p_action, NULLIF(btrim(p_reason), ''), COALESCE(p_details, '{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION tchefood_admin_clean_phone(p_phone TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g')
$$;

CREATE OR REPLACE FUNCTION tchefood_admin_check_email(p_email TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v TEXT := lower(btrim(COALESCE(p_email, '')));
BEGIN
    IF v = '' THEN RETURN NULL; END IF;
    IF length(v) > 200 OR v !~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: e-mail inválido: %', p_email;
    END IF;
    RETURN v;
END;
$$;

-- Dia de cobrança, nome e telefone do contato (mensagens claras antes dos CHECKs da tabela).
CREATE OR REPLACE FUNCTION tchefood_admin_check_contact(p_billing_day INT, p_contact_name TEXT, p_contact_phone TEXT)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF p_billing_day IS NULL OR p_billing_day < 1 OR p_billing_day > 28 THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: dia de cobrança entre 1 e 28';
    END IF;
    IF length(btrim(COALESCE(p_contact_name, ''))) < 2 OR length(btrim(p_contact_name)) > 100 THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: informe o nome do contato da loja';
    END IF;
    -- DDD + número (10 ou 11 dígitos), ou o mesmo com o DDI 55 na frente (12 ou 13).
    IF tchefood_admin_clean_phone(p_contact_phone) !~ '^(55)?[1-9][0-9]{9,10}$' THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: telefone do contato com DDD (10 ou 11 dígitos, ou 55 + DDD + número)';
    END IF;
END;
$$;

-- Assinatura em JSON (para o histórico e para a tela).
CREATE OR REPLACE FUNCTION tchefood_admin_subscription_json(s store_subscriptions) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'plan_id', s.plan_id, 'monthly_price', s.monthly_price, 'status', s.status, 'billing_day', s.billing_day,
        'trial_ends_on', s.trial_ends_on, 'contact_name', s.contact_name, 'contact_phone', s.contact_phone,
        'contact_email', s.contact_email, 'notes', s.notes, 'device_email', s.device_email,
        'device_status', s.device_status, 'created_at', s.created_at, 'updated_at', s.updated_at)
$$;

-- -----------------------------------------------------------------------------
-- Leitura
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tchefood_admin_me() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE;
BEGIN
    v_admin := tchefood_admin_require();
    RETURN jsonb_build_object('user_id', v_admin.user_id, 'email', v_admin.email, 'name', v_admin.name, 'today', tchefood_admin_today());
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_admin_plans() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM tchefood_admin_require();
    RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'monthly_price', p.monthly_price, 'active', p.active)
                                      ORDER BY p.sort_order, p.id) FROM platform_plans p), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_admin_overview() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_today DATE; v_month DATE;
BEGIN
    PERFORM tchefood_admin_require();
    v_today := tchefood_admin_today();
    v_month := date_trunc('month', v_today)::date;
    RETURN jsonb_build_object(
        'today', v_today,
        'stores', jsonb_build_object(
            'trial', (SELECT count(*) FROM store_subscriptions WHERE status = 'TRIAL'),
            'active', (SELECT count(*) FROM store_subscriptions WHERE status = 'ACTIVE'),
            'suspended', (SELECT count(*) FROM store_subscriptions WHERE status = 'SUSPENDED'),
            'cancelled', (SELECT count(*) FROM store_subscriptions WHERE status = 'CANCELLED'),
            'without_subscription', (SELECT count(*) FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM store_subscriptions s WHERE s.tenant_id = t.id))),
        -- Receita mensal recorrente: preço das lojas ativas.
        'mrr', (SELECT COALESCE(sum(monthly_price), 0) FROM store_subscriptions WHERE status = 'ACTIVE'),
        'open_amount', (SELECT COALESCE(sum(amount), 0) FROM store_charges WHERE status = 'OPEN'),
        'open_count', (SELECT count(*) FROM store_charges WHERE status = 'OPEN'),
        'overdue_amount', (SELECT COALESCE(sum(amount), 0) FROM store_charges WHERE status = 'OPEN' AND due_date < v_today),
        'overdue_count', (SELECT count(*) FROM store_charges WHERE status = 'OPEN' AND due_date < v_today),
        'received_this_month', (SELECT COALESCE(sum(paid_amount), 0) FROM store_charges WHERE status = 'PAID' AND paid_on >= v_month AND paid_on <= v_today),
        -- Testes que terminam de hoje até daqui a 7 dias; os que já terminaram contam à parte.
        'trials_ending_7d', (SELECT count(*) FROM store_subscriptions
                              WHERE status = 'TRIAL' AND trial_ends_on >= v_today AND trial_ends_on <= v_today + 7),
        'trials_expired', (SELECT count(*) FROM store_subscriptions WHERE status = 'TRIAL' AND trial_ends_on < v_today));
END;
$$;

-- Lojas, com as que ainda não têm assinatura (criadas à mão no Supabase, como a do piloto).
CREATE OR REPLACE FUNCTION tchefood_admin_stores() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_today DATE;
BEGIN
    PERFORM tchefood_admin_require();
    v_today := tchefood_admin_today();
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'tenant_id', t.id, 'name', t.name, 'legal_name', t.legal_name, 'cnpj', t.cnpj, 'city', t.city, 'state', t.state,
                   'created_at', t.created_at,
                   'subscription', CASE WHEN s.tenant_id IS NULL THEN NULL ELSE tchefood_admin_subscription_json(s) END,
                   'open_count', c.open_count, 'open_amount', c.open_amount,
                   'overdue_count', c.overdue_count, 'overdue_amount', c.overdue_amount, 'oldest_overdue_due', c.oldest_overdue_due,
                   'last_order_at', u.last_order_at, 'orders_7d', u.orders_7d,
                   'staff_active', (SELECT count(*) FROM staff_users su WHERE su.tenant_id = t.id AND su.active))
                 ORDER BY t.name, t.id)
          FROM tenants t
          LEFT JOIN store_subscriptions s ON s.tenant_id = t.id
          LEFT JOIN LATERAL (
              SELECT count(*) FILTER (WHERE sc.status = 'OPEN') AS open_count,
                     COALESCE(sum(sc.amount) FILTER (WHERE sc.status = 'OPEN'), 0) AS open_amount,
                     count(*) FILTER (WHERE sc.status = 'OPEN' AND sc.due_date < v_today) AS overdue_count,
                     COALESCE(sum(sc.amount) FILTER (WHERE sc.status = 'OPEN' AND sc.due_date < v_today), 0) AS overdue_amount,
                     min(sc.due_date) FILTER (WHERE sc.status = 'OPEN' AND sc.due_date < v_today) AS oldest_overdue_due
                FROM store_charges sc WHERE sc.tenant_id = t.id) c ON TRUE
          LEFT JOIN LATERAL (
              SELECT max(x.at) AS last_order_at, count(*) FILTER (WHERE x.at >= tchefood_admin_day_start(v_today - 6)) AS orders_7d
                FROM tchefood_admin_sales(t.id) x) u ON TRUE), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_admin_store(p_tenant UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_t tenants%ROWTYPE; v_s store_subscriptions%ROWTYPE;
BEGIN
    PERFORM tchefood_admin_require();
    SELECT * INTO v_t FROM tenants WHERE id = p_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: loja não encontrada'; END IF;
    SELECT * INTO v_s FROM store_subscriptions WHERE tenant_id = p_tenant;
    RETURN jsonb_build_object(
        'tenant_id', v_t.id, 'name', v_t.name, 'legal_name', v_t.legal_name, 'cnpj', v_t.cnpj, 'city', v_t.city, 'state', v_t.state,
        'created_at', v_t.created_at,
        'subscription', CASE WHEN v_s.tenant_id IS NULL THEN NULL ELSE tchefood_admin_subscription_json(v_s) END,
        'charges', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'id', c.id, 'reference_month', c.reference_month, 'amount', c.amount, 'due_date', c.due_date,
                        'status', c.status, 'payment_link', c.payment_link, 'paid_on', c.paid_on, 'paid_amount', c.paid_amount,
                        'payment_method', c.payment_method, 'payment_reference', c.payment_reference,
                        'cancel_reason', c.cancel_reason, 'created_at', c.created_at)
                      ORDER BY c.reference_month DESC, c.created_at DESC)
                      FROM store_charges c WHERE c.tenant_id = p_tenant), '[]'::jsonb),
        'audit', COALESCE((SELECT jsonb_agg(x.j ORDER BY x.created_at DESC) FROM (
                      SELECT a.created_at, jsonb_build_object('action', a.action, 'reason', a.reason, 'details', a.details,
                             'created_at', a.created_at, 'admin_name', pa.name) AS j
                        FROM platform_admin_audit a LEFT JOIN platform_admins pa ON pa.user_id = a.admin_user_id
                       WHERE a.tenant_id = p_tenant ORDER BY a.created_at DESC LIMIT 50) x), '[]'::jsonb),
        'last_order_at', (SELECT max(x.at) FROM tchefood_admin_sales(p_tenant) x),
        'orders_7d', (SELECT count(*) FROM tchefood_admin_sales(p_tenant) x WHERE x.at >= tchefood_admin_day_start(tchefood_admin_today() - 6)),
        'orders_30d', (SELECT count(*) FROM tchefood_admin_sales(p_tenant) x WHERE x.at >= tchefood_admin_day_start(tchefood_admin_today() - 29)),
        'staff_active', (SELECT count(*) FROM staff_users su WHERE su.tenant_id = p_tenant AND su.active));
END;
$$;

-- Cobranças em aberto que vencem até daqui a p_days dias, e as vencidas (tela "Cobranças do dia").
CREATE OR REPLACE FUNCTION tchefood_admin_charges_due(p_days INT DEFAULT 3) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_today DATE;
BEGIN
    PERFORM tchefood_admin_require();
    IF p_days IS NULL OR p_days < 0 OR p_days > 31 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: prazo inválido'; END IF;
    v_today := tchefood_admin_today();
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', c.id, 'tenant_id', c.tenant_id, 'store_name', t.name, 'reference_month', c.reference_month,
                   'amount', c.amount, 'due_date', c.due_date, 'days_late', GREATEST(v_today - c.due_date, 0),
                   'payment_link', c.payment_link, 'contact_name', s.contact_name, 'contact_phone', s.contact_phone,
                   'subscription_status', s.status)
                 ORDER BY c.due_date, t.name, c.id)
          FROM store_charges c
          JOIN store_subscriptions s ON s.tenant_id = c.tenant_id
          JOIN tenants t ON t.id = c.tenant_id
         WHERE c.status = 'OPEN' AND c.due_date <= v_today + p_days), '[]'::jsonb);
END;
$$;

-- -----------------------------------------------------------------------------
-- Lojas e assinaturas
-- -----------------------------------------------------------------------------

-- Loja nova: a linha em tenants e a assinatura (em teste por p_trial_days dias, ou ativa
-- com 0), na mesma transação. A conta do aparelho é criada depois, pela função
-- admin-device-account.
CREATE OR REPLACE FUNCTION tchefood_admin_create_store(
    p_name TEXT, p_legal_name TEXT, p_cnpj TEXT, p_city TEXT, p_state TEXT,
    p_plan_id TEXT, p_monthly_price NUMERIC, p_billing_day INT, p_trial_days INT,
    p_contact_name TEXT, p_contact_phone TEXT, p_contact_email TEXT, p_notes TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_plan platform_plans%ROWTYPE; v_cnpj TEXT; v_id UUID; v_s store_subscriptions%ROWTYPE;
        v_price NUMERIC;
BEGIN
    v_admin := tchefood_admin_require();
    v_cnpj := tchefood_admin_clean_cnpj(p_cnpj);
    IF NOT tchefood_admin_cnpj_valid(v_cnpj) THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: CNPJ inválido'; END IF;
    IF length(btrim(COALESCE(p_name, ''))) < 2 OR length(btrim(p_name)) > 150 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: nome da loja inválido'; END IF;
    IF length(btrim(COALESCE(p_legal_name, ''))) < 2 OR length(btrim(p_legal_name)) > 200 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: razão social inválida'; END IF;
    IF p_state IS NOT NULL AND upper(btrim(p_state)) !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: UF inválida'; END IF;
    IF length(btrim(COALESCE(p_city, ''))) > 100 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: cidade com até 100 caracteres'; END IF;
    IF p_trial_days IS NULL OR p_trial_days < 0 OR p_trial_days > 90 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: dias de teste entre 0 e 90'; END IF;
    PERFORM tchefood_admin_check_contact(p_billing_day, p_contact_name, p_contact_phone);
    SELECT * INTO v_plan FROM platform_plans WHERE id = p_plan_id AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: plano inválido'; END IF;
    v_price := COALESCE(p_monthly_price, v_plan.monthly_price);
    IF v_price < 0 OR v_price > 100000 OR v_price <> round(v_price, 2) THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: preço inválido'; END IF;
    IF EXISTS (SELECT 1 FROM tenants WHERE cnpj = v_cnpj) THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: já existe loja com este CNPJ'; END IF;

    INSERT INTO tenants (name, legal_name, cnpj, city, state)
    VALUES (btrim(p_name), btrim(p_legal_name), v_cnpj, COALESCE(NULLIF(btrim(p_city), ''), 'Santo Ângelo'), COALESCE(upper(btrim(p_state)), 'RS'))
    RETURNING id INTO v_id;

    INSERT INTO store_subscriptions (tenant_id, plan_id, monthly_price, status, billing_day, trial_ends_on,
                                     contact_name, contact_phone, contact_email, notes)
    VALUES (v_id, v_plan.id, v_price, CASE WHEN p_trial_days > 0 THEN 'TRIAL' ELSE 'ACTIVE' END, p_billing_day,
            CASE WHEN p_trial_days > 0 THEN tchefood_admin_today() + p_trial_days END,
            btrim(COALESCE(p_contact_name, '')), tchefood_admin_clean_phone(p_contact_phone), tchefood_admin_check_email(p_contact_email),
            NULLIF(btrim(p_notes), ''))
    RETURNING * INTO v_s;

    PERFORM tchefood_admin_log(v_admin.user_id, v_id, NULL, 'STORE_CREATED', NULL,
        jsonb_build_object('name', btrim(p_name), 'cnpj', v_cnpj, 'subscription', tchefood_admin_subscription_json(v_s)));
    RETURN v_id;
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'TCHEFOOD_ADMIN: já existe loja com este CNPJ';
WHEN check_violation THEN
    RAISE EXCEPTION 'TCHEFOOD_ADMIN: dados da assinatura inválidos (dia de cobrança 1 a 28, telefone com DDD, contato)';
END;
$$;

-- Cria ou altera a assinatura (também para loja criada à mão no Supabase). Motivo obrigatório.
CREATE OR REPLACE FUNCTION tchefood_admin_save_subscription(
    p_tenant UUID, p_plan_id TEXT, p_monthly_price NUMERIC, p_status TEXT, p_billing_day INT, p_trial_ends_on DATE,
    p_contact_name TEXT, p_contact_phone TEXT, p_contact_email TEXT, p_notes TEXT, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_plan platform_plans%ROWTYPE; v_old store_subscriptions%ROWTYPE; v_new store_subscriptions%ROWTYPE;
        v_existed BOOLEAN;
BEGIN
    v_admin := tchefood_admin_require();
    IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: informe o motivo da alteração'; END IF;
    PERFORM 1 FROM tenants WHERE id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: loja não encontrada'; END IF;
    SELECT * INTO v_plan FROM platform_plans WHERE id = p_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: plano inválido'; END IF;
    IF p_monthly_price IS NULL OR p_monthly_price < 0 OR p_monthly_price > 100000 OR p_monthly_price <> round(p_monthly_price, 2) THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: preço inválido';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED') THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: situação inválida'; END IF;
    IF p_status = 'TRIAL' AND p_trial_ends_on IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: loja em teste precisa da data de fim do teste'; END IF;
    PERFORM tchefood_admin_check_contact(p_billing_day, p_contact_name, p_contact_phone);

    SELECT * INTO v_old FROM store_subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
    v_existed := FOUND;
    IF v_existed THEN
        UPDATE store_subscriptions SET
            plan_id = v_plan.id, monthly_price = p_monthly_price, status = p_status, billing_day = p_billing_day,
            trial_ends_on = CASE WHEN p_status = 'TRIAL' THEN p_trial_ends_on ELSE COALESCE(p_trial_ends_on, v_old.trial_ends_on) END,
            contact_name = btrim(COALESCE(p_contact_name, '')), contact_phone = tchefood_admin_clean_phone(p_contact_phone),
            contact_email = tchefood_admin_check_email(p_contact_email), notes = NULLIF(btrim(p_notes), ''), updated_at = NOW()
         WHERE tenant_id = p_tenant RETURNING * INTO v_new;
    ELSE
        INSERT INTO store_subscriptions (tenant_id, plan_id, monthly_price, status, billing_day, trial_ends_on,
                                         contact_name, contact_phone, contact_email, notes)
        VALUES (p_tenant, v_plan.id, p_monthly_price, p_status, p_billing_day, p_trial_ends_on,
                btrim(COALESCE(p_contact_name, '')), tchefood_admin_clean_phone(p_contact_phone), tchefood_admin_check_email(p_contact_email),
                NULLIF(btrim(p_notes), ''))
        RETURNING * INTO v_new;
    END IF;

    PERFORM tchefood_admin_log(v_admin.user_id, p_tenant, NULL,
        CASE WHEN v_existed THEN 'SUBSCRIPTION_UPDATED' ELSE 'SUBSCRIPTION_CREATED' END, p_reason,
        jsonb_build_object('before', CASE WHEN v_existed THEN tchefood_admin_subscription_json(v_old) END,
                           'after', tchefood_admin_subscription_json(v_new)));
    RETURN tchefood_admin_subscription_json(v_new);
EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'TCHEFOOD_ADMIN: dados da assinatura inválidos (dia de cobrança 1 a 28, telefone com DDD, contato)';
END;
$$;

-- -----------------------------------------------------------------------------
-- Cobranças
-- -----------------------------------------------------------------------------

-- Cobrança de um mês. Sem valor, usa o preço da loja; sem vencimento, o dia de cobrança.
CREATE OR REPLACE FUNCTION tchefood_admin_create_charge(
    p_tenant UUID, p_reference_month DATE, p_amount NUMERIC, p_due_date DATE, p_payment_link TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_s store_subscriptions%ROWTYPE; v_month DATE; v_amount NUMERIC; v_due DATE; v_id UUID;
        v_link TEXT;
BEGIN
    v_admin := tchefood_admin_require();
    SELECT * INTO v_s FROM store_subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: a loja ainda não tem assinatura'; END IF;
    IF v_s.status = 'CANCELLED' THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: assinatura cancelada não gera cobrança'; END IF;
    IF p_reference_month IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: informe o mês da cobrança'; END IF;
    v_month := date_trunc('month', p_reference_month)::date;
    PERFORM tchefood_admin_check_month(v_month);
    v_amount := COALESCE(p_amount, v_s.monthly_price);
    IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 100000 OR v_amount <> round(v_amount, 2) THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: valor da cobrança inválido';
    END IF;
    -- Sem vencimento informado: o dia de cobrança do mês, mas nunca antes de hoje (cobrança
    -- criada no meio do mês não nasce vencida).
    v_due := COALESCE(p_due_date, GREATEST(tchefood_admin_due_date(v_month, v_s.billing_day), tchefood_admin_today()));
    IF v_due < v_month - 31 OR v_due > (v_month + INTERVAL '2 months')::date THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: vencimento longe do mês da cobrança';
    END IF;
    v_link := NULLIF(btrim(COALESCE(p_payment_link, '')), '');
    IF v_link IS NOT NULL AND (v_link !~ '^https://[^\s]+$' OR length(v_link) > 500) THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: link de pagamento precisa começar com https://';
    END IF;
    IF EXISTS (SELECT 1 FROM store_charges WHERE tenant_id = p_tenant AND reference_month = v_month AND status <> 'CANCELLED') THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: já existe cobrança deste mês para a loja';
    END IF;
    INSERT INTO store_charges (tenant_id, reference_month, amount, due_date, payment_link, created_by)
    VALUES (p_tenant, v_month, v_amount, v_due, v_link, v_admin.user_id)
    RETURNING id INTO v_id;
    PERFORM tchefood_admin_log(v_admin.user_id, p_tenant, v_id, 'CHARGE_CREATED', NULL,
        jsonb_build_object('reference_month', v_month, 'amount', v_amount, 'due_date', v_due, 'payment_link', v_link));
    RETURN v_id;
END;
$$;

-- Cobranças do mês para as lojas ativas com preço e as em teste cujo teste termina até o fim
-- do mês, que ainda não têm cobrança do mês (nem cancelada: cancelar é decisão do admin, como
-- uma cortesia, e o lote não a desfaz; refazer é pela cobrança avulsa). O vencimento é o dia
-- de cobrança, mas nunca antes de hoje nem antes do fim do teste.
CREATE OR REPLACE FUNCTION tchefood_admin_generate_month(p_reference_month DATE) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_month DATE; v_s RECORD; v_count INT := 0; v_id UUID; v_due DATE;
BEGIN
    v_admin := tchefood_admin_require();
    IF p_reference_month IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: informe o mês'; END IF;
    v_month := date_trunc('month', p_reference_month)::date;
    PERFORM tchefood_admin_check_month(v_month);
    FOR v_s IN SELECT * FROM store_subscriptions
                WHERE monthly_price > 0
                  AND (status = 'ACTIVE' OR (status = 'TRIAL' AND trial_ends_on < (v_month + INTERVAL '1 month')::date))
                ORDER BY tenant_id FOR UPDATE LOOP
        IF NOT EXISTS (SELECT 1 FROM store_charges WHERE tenant_id = v_s.tenant_id AND reference_month = v_month) THEN
            v_due := GREATEST(tchefood_admin_due_date(v_month, v_s.billing_day), tchefood_admin_today(),
                              CASE WHEN v_s.status = 'TRIAL' THEN v_s.trial_ends_on + 1 END);
            INSERT INTO store_charges (tenant_id, reference_month, amount, due_date, created_by)
            VALUES (v_s.tenant_id, v_month, v_s.monthly_price, v_due, v_admin.user_id)
            RETURNING id INTO v_id;
            PERFORM tchefood_admin_log(v_admin.user_id, v_s.tenant_id, v_id, 'CHARGE_CREATED', NULL,
                jsonb_build_object('reference_month', v_month, 'amount', v_s.monthly_price, 'due_date', v_due, 'batch', TRUE,
                                   'subscription_status', v_s.status));
            v_count := v_count + 1;
        END IF;
    END LOOP;
    RETURN v_count;
END;
$$;

-- Pagamento recebido: valor exato da cobrança, forma e referência obrigatórias. Reenvio do
-- mesmo pagamento (resposta perdida) devolve a cobrança já paga sem gravar de novo.
CREATE OR REPLACE FUNCTION tchefood_admin_record_payment(
    p_charge UUID, p_paid_amount NUMERIC, p_paid_on DATE, p_method TEXT, p_reference TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_tenant UUID; v_c store_charges%ROWTYPE; v_s store_subscriptions%ROWTYPE;
        v_ref TEXT; v_activated BOOLEAN := FALSE;
BEGIN
    v_admin := tchefood_admin_require();
    v_ref := btrim(COALESCE(p_reference, ''));
    IF length(v_ref) < 4 OR length(v_ref) > 120 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: informe a referência do pagamento (id do Pix, nosso número, recibo)'; END IF;
    IF p_method IS NULL OR p_method NOT IN ('PIX', 'BOLETO', 'CARTAO', 'TRANSFERENCIA', 'DINHEIRO') THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: forma de pagamento inválida';
    END IF;
    IF p_paid_on IS NULL OR p_paid_on > tchefood_admin_today() THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: data do pagamento inválida (não pode ser futura)'; END IF;
    -- (o limite de data antiga é conferido abaixo, com o mês da cobrança)

    -- Trava a assinatura antes da cobrança (mesma ordem de tchefood_admin_create_charge).
    SELECT tenant_id INTO v_tenant FROM store_charges WHERE id = p_charge;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: cobrança não encontrada'; END IF;
    SELECT * INTO v_s FROM store_subscriptions WHERE tenant_id = v_tenant FOR UPDATE;
    SELECT * INTO v_c FROM store_charges WHERE id = p_charge FOR UPDATE;

    IF v_c.status = 'PAID' THEN
        IF v_c.paid_amount = p_paid_amount AND v_c.paid_on = p_paid_on AND v_c.payment_method = p_method
           AND lower(v_c.payment_reference) = lower(v_ref) THEN
            RETURN jsonb_build_object('charge_id', v_c.id, 'status', v_c.status, 'subscription_status', v_s.status, 'replayed', TRUE);
        END IF;
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: esta cobrança já foi paga com outros dados';
    END IF;
    IF v_c.status <> 'OPEN' THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: cobrança cancelada não recebe pagamento'; END IF;
    IF p_paid_on < (v_c.reference_month - INTERVAL '31 days')::date THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: data do pagamento muito antes do mês da cobrança';
    END IF;
    IF p_paid_amount IS NULL OR p_paid_amount <> v_c.amount THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: valor pago (%) diferente do valor da cobrança (%)', p_paid_amount, v_c.amount;
    END IF;
    IF EXISTS (SELECT 1 FROM store_charges WHERE status = 'PAID' AND lower(payment_reference) = lower(v_ref)) THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: esta referência de pagamento já quitou outra cobrança';
    END IF;

    UPDATE store_charges SET status = 'PAID', paid_on = p_paid_on, paid_amount = p_paid_amount, payment_method = p_method,
                             payment_reference = v_ref, paid_at = NOW(), paid_by = v_admin.user_id
     WHERE id = p_charge;

    -- Em teste vira ativa no primeiro pagamento. Suspensa só volta a ativa se não sobrar outra
    -- cobrança vencida em aberto (pagar outubro com novembro vencido não reativa).
    IF v_s.status = 'TRIAL' OR (v_s.status = 'SUSPENDED' AND NOT EXISTS (
           SELECT 1 FROM store_charges o WHERE o.tenant_id = v_tenant AND o.id <> p_charge AND o.status = 'OPEN'
              AND o.due_date < tchefood_admin_today())) THEN
        UPDATE store_subscriptions SET status = 'ACTIVE', updated_at = NOW() WHERE tenant_id = v_tenant;
        v_activated := TRUE;
    END IF;

    PERFORM tchefood_admin_log(v_admin.user_id, v_tenant, p_charge, 'CHARGE_PAID', NULL,
        jsonb_build_object('amount', p_paid_amount, 'paid_on', p_paid_on, 'method', p_method, 'reference', v_ref,
                           'reference_month', v_c.reference_month,
                           'subscription_before', v_s.status, 'subscription_after', CASE WHEN v_activated THEN 'ACTIVE' ELSE v_s.status END));
    RETURN jsonb_build_object('charge_id', p_charge, 'status', 'PAID',
                              'subscription_status', CASE WHEN v_activated THEN 'ACTIVE' ELSE v_s.status END, 'replayed', FALSE);
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'TCHEFOOD_ADMIN: esta referência de pagamento já quitou outra cobrança';
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_admin_cancel_charge(p_charge UUID, p_reason TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_tenant UUID; v_c store_charges%ROWTYPE;
BEGIN
    v_admin := tchefood_admin_require();
    IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: informe o motivo do cancelamento'; END IF;
    SELECT tenant_id INTO v_tenant FROM store_charges WHERE id = p_charge;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: cobrança não encontrada'; END IF;
    PERFORM 1 FROM store_subscriptions WHERE tenant_id = v_tenant FOR UPDATE;
    SELECT * INTO v_c FROM store_charges WHERE id = p_charge FOR UPDATE;
    IF v_c.status <> 'OPEN' THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: só cobrança em aberto é cancelada (esta está %)', v_c.status; END IF;
    UPDATE store_charges SET status = 'CANCELLED', cancel_reason = btrim(p_reason), cancelled_at = NOW(), cancelled_by = v_admin.user_id
     WHERE id = p_charge;
    PERFORM tchefood_admin_log(v_admin.user_id, v_tenant, p_charge, 'CHARGE_CANCELLED', p_reason,
        jsonb_build_object('reference_month', v_c.reference_month, 'amount', v_c.amount, 'due_date', v_c.due_date));
END;
$$;

-- -----------------------------------------------------------------------------
-- Conta do aparelho (usadas pela função admin-device-account, com o token do admin)
-- -----------------------------------------------------------------------------

-- Reserva o id e o e-mail da conta do aparelho. Repetir devolve a mesma reserva (a função
-- cria a conta no Auth com este id; se cair no meio, a próxima chamada continua dela).
-- p_replace_user_id troca uma reserva PENDING por outra (id e e-mail novos): a função
-- admin-device-account só manda depois de conferir que a conta com o id reservado não
-- existe no Auth (ex.: o e-mail já era de outra conta e a criação foi recusada). Só troca
-- se a reserva ainda for a mesma e ainda estiver PENDING; conta pronta nunca é trocada.
DROP FUNCTION IF EXISTS tchefood_admin_reserve_device(UUID, TEXT);
CREATE OR REPLACE FUNCTION tchefood_admin_reserve_device(p_tenant UUID, p_email TEXT, p_replace_user_id UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_s store_subscriptions%ROWTYPE; v_email TEXT; v_id UUID;
BEGIN
    v_admin := tchefood_admin_require();
    SELECT * INTO v_s FROM store_subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: crie a assinatura da loja antes da conta do aparelho'; END IF;
    IF p_replace_user_id IS NOT NULL THEN
        IF v_s.device_status IS DISTINCT FROM 'PENDING' OR v_s.device_user_id IS DISTINCT FROM p_replace_user_id THEN
            RAISE EXCEPTION 'TCHEFOOD_ADMIN: a reserva da conta do aparelho mudou; abra a loja de novo';
        END IF;
    ELSIF v_s.device_user_id IS NOT NULL THEN
        RETURN jsonb_build_object('user_id', v_s.device_user_id, 'email', v_s.device_email, 'status', v_s.device_status);
    END IF;
    v_email := tchefood_admin_check_email(p_email);
    IF v_email IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: informe o e-mail da conta do aparelho'; END IF;
    IF EXISTS (SELECT 1 FROM platform_admins WHERE lower(email) = v_email) THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: este e-mail é de um admin do painel';
    END IF;
    v_id := gen_random_uuid();
    UPDATE store_subscriptions SET device_user_id = v_id, device_email = v_email, device_status = 'PENDING', updated_at = NOW()
     WHERE tenant_id = p_tenant;
    PERFORM tchefood_admin_log(v_admin.user_id, p_tenant, NULL, 'DEVICE_ACCOUNT_RESERVED', NULL,
        jsonb_build_object('user_id', v_id, 'email', v_email,
                           'replaced_user_id', p_replace_user_id, 'replaced_email', CASE WHEN p_replace_user_id IS NOT NULL THEN v_s.device_email END));
    RETURN jsonb_build_object('user_id', v_id, 'email', v_email, 'status', 'PENDING');
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'TCHEFOOD_ADMIN: este e-mail já é de outra loja';
END;
$$;

-- Uma operação por vez na conta do aparelho de cada loja. A função admin-device-account
-- pega a vez (p_op = id sorteado por chamada) antes de mexer no Auth e só confirma com a
-- mesma vez; a segunda chamada ao mesmo tempo recebe 55P03 (409 na função) e não gera
-- senha. A vez expira em 10 minutos, mais que o tempo máximo de uma Edge Function (400 s),
-- para uma função que caiu no meio não travar a loja para sempre.
CREATE OR REPLACE FUNCTION tchefood_admin_device_lock(p_tenant UUID, p_op UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_s store_subscriptions%ROWTYPE;
BEGIN
    PERFORM tchefood_admin_require();
    IF p_op IS NULL THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: operação inválida'; END IF;
    SELECT * INTO v_s FROM store_subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: crie a assinatura da loja antes da conta do aparelho'; END IF;
    IF v_s.device_op_id IS NOT NULL AND v_s.device_op_id <> p_op AND v_s.device_op_started_at > NOW() - INTERVAL '10 minutes' THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: outra operação na conta do aparelho desta loja está em andamento; aguarde e abra a loja de novo'
            USING ERRCODE = '55P03';
    END IF;
    UPDATE store_subscriptions SET device_op_id = p_op, device_op_started_at = NOW() WHERE tenant_id = p_tenant;
END;
$$;

-- Devolve a vez quando a operação falhou antes de confirmar (só a própria operação devolve).
CREATE OR REPLACE FUNCTION tchefood_admin_device_unlock(p_tenant UUID, p_op UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM tchefood_admin_require();
    UPDATE store_subscriptions SET device_op_id = NULL, device_op_started_at = NULL
     WHERE tenant_id = p_tenant AND device_op_id = p_op;
END;
$$;

-- Conta criada no Auth (ou senha trocada): marca a conta como pronta, devolve a vez e grava
-- no histórico. Recusa se a vez não for mais desta operação (expirou e outra pegou).
DROP FUNCTION IF EXISTS tchefood_admin_confirm_device(UUID, UUID, TEXT);
CREATE OR REPLACE FUNCTION tchefood_admin_confirm_device(p_tenant UUID, p_user_id UUID, p_action TEXT, p_op UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin platform_admins%ROWTYPE; v_s store_subscriptions%ROWTYPE;
BEGIN
    v_admin := tchefood_admin_require();
    IF p_action IS NULL OR p_action NOT IN ('CREATED', 'PASSWORD_RESET') THEN RAISE EXCEPTION 'TCHEFOOD_ADMIN: ação inválida'; END IF;
    SELECT * INTO v_s FROM store_subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND OR v_s.device_user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: conta do aparelho não confere com a da loja';
    END IF;
    IF (p_action = 'CREATED' AND v_s.device_status <> 'PENDING') OR (p_action = 'PASSWORD_RESET' AND v_s.device_status <> 'READY') THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: a conta do aparelho mudou de estado; abra a loja de novo';
    END IF;
    IF p_op IS NULL OR v_s.device_op_id IS DISTINCT FROM p_op THEN
        RAISE EXCEPTION 'TCHEFOOD_ADMIN: outra operação assumiu a conta do aparelho; abra a loja de novo' USING ERRCODE = '55P03';
    END IF;
    UPDATE store_subscriptions SET device_status = 'READY', device_op_id = NULL, device_op_started_at = NULL, updated_at = NOW()
     WHERE tenant_id = p_tenant;
    PERFORM tchefood_admin_log(v_admin.user_id, p_tenant, NULL,
        CASE p_action WHEN 'CREATED' THEN 'DEVICE_ACCOUNT_CREATED' ELSE 'DEVICE_PASSWORD_RESET' END, NULL,
        jsonb_build_object('user_id', p_user_id, 'email', v_s.device_email));
END;
$$;

-- -----------------------------------------------------------------------------
-- Permissões: as funções de apoio só por dentro; as do painel para authenticated (o admin
-- é conferido dentro de cada uma).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION tchefood_admin_charges_guard() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_audit_guard() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_today() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_require() FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_cnpj_valid(TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_clean_cnpj(TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_due_date(DATE, INT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_check_month(DATE) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_day_start(DATE) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_sales(UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_log(UUID, UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_clean_phone(TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_check_email(TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_check_contact(INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION tchefood_admin_subscription_json(store_subscriptions) FROM PUBLIC, anon, authenticated;

        REVOKE ALL ON FUNCTION tchefood_admin_me() FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_plans() FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_overview() FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_stores() FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_store(UUID) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_charges_due(INT) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_create_store(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, INT, INT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_save_subscription(UUID, TEXT, NUMERIC, TEXT, INT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_create_charge(UUID, DATE, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_generate_month(DATE) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_record_payment(UUID, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_cancel_charge(UUID, TEXT) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_reserve_device(UUID, TEXT, UUID) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_device_lock(UUID, UUID) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_device_unlock(UUID, UUID) FROM PUBLIC, anon;
        REVOKE ALL ON FUNCTION tchefood_admin_confirm_device(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION tchefood_admin_me() TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_plans() TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_overview() TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_stores() TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_store(UUID) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_charges_due(INT) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_create_store(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, INT, INT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_save_subscription(UUID, TEXT, NUMERIC, TEXT, INT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_create_charge(UUID, DATE, NUMERIC, DATE, TEXT) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_generate_month(DATE) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_record_payment(UUID, NUMERIC, DATE, TEXT, TEXT) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_cancel_charge(UUID, TEXT) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_reserve_device(UUID, TEXT, UUID) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_device_lock(UUID, UUID) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_device_unlock(UUID, UUID) TO authenticated;
        GRANT EXECUTE ON FUNCTION tchefood_admin_confirm_device(UUID, UUID, TEXT, UUID) TO authenticated;
    END IF;
END $$;
