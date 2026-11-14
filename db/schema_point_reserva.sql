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
--    contrário (nada volta a reservar sem passar pela trava da conta). Cobrança aprovada deixa de
--    reservar quando o pagamento do Mercado Pago dela é gravado e continua sem reservar se ele depois
--    for estornado ou recusado (REFUNDED, DECLINED): só o pagamento ainda PENDING não a libera
--    (segunda revisão independente, item 3).
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
--
-- Auditoria r5 (decisões do Will, 14/11/2026):
-- 4. P0-01: na loja com Point, todo pagamento fora dela (dinheiro, Stone, PagBank, Pix manual,
--    ficha rápida, retirada) pede ANTES a reserva no servidor (tchefood_claim_payment, tabela
--    payment_claims), com a conta travada e o saldo conferido, e só então cobra no aparelho. A
--    reserva aberta e ainda não paga soma junto com as cobranças da Point (reserva única, nos dois
--    sentidos): a Point não cobra por cima dela e ela não passa por cima da Point. O pagamento com a
--    mesma chave, na mesma conta e até o valor reservado, consome a reserva. Não expira por tempo.
-- 5. A reserva que não virou pagamento (maquininha recusou, operador desistiu) é liberada pelo
--    aparelho (tchefood_release_payment_claim) ou, se o aparelho sumiu, com PIN de gerente
--    (tchefood_release_payment_claim_manager). As duas deixam registro PAYMENT_CLAIM_RELEASED.
-- 6. A chave de uma cobrança da Point nunca vira reserva de pagamento, nem o contrário (TF009).
-- 7. P1-01: fim verificado da cobrança da Point (tchefood_resolve_point_charge, só a service role,
--    chamada pela Edge Function depois de ler o Mercado Pago): revisão manual que termina e aprovada
--    sem pagamento que foi estornada, com UM registro POINT_CHARGE_RESOLVED.
--
-- Códigos (SQLSTATE) das funções novas: TF001 conta não está no servidor, TF002 conta encerrada,
-- TF003 passa do saldo livre, TF004 operador fora da equipe ativa, TF005 não encontrada, TF006 dado
-- inválido ou motivo curto, TF007 não se aplica, TF008 saldo diferente do mostrado, TF009 chave já
-- usada por outro pagamento, TF010 pagamento sem a reserva que o cobre (claim_required), TF011 reserva ainda em
-- andamento no aparelho que a pediu (claim_active), TF012 saldo da conta abaixo do que está reservado
-- (reserved_exceeds_balance), TF013 pagamento com a chave de uma reserva já liberada (claim_released).
-- 8. Revisão independente (P1-B, P2-A, P3): na loja com Point (tchefood_point_store) o próprio gatilho de payments
--    exige que o pagamento aprovado fora da Point tenha a reserva aberta da mesma conta, até o valor dela e com a
--    mesma forma e credenciadora (TF010), sem confiar na lista de maquininhas do aparelho. Única exceção,
--    conferida no banco: o dinheiro do entregador no acerto da senha paga na entrega. A reserva consumida fica
--    "consumed" para sempre (estorno posterior do pagamento não a faz reservar de novo). Sem PIN, só quem pediu
--    a reserva a libera.
-- 9. Auditoria r6 (P0-01, P0-02): o aparelho ligado à nuvem pede a reserva sempre, com ou sem Point na loja (o servidor
--    decide; tchefood_claim_payment grava a reserva em qualquer loja). A reserva tem prazo de atividade
--    (active_until, relógio do banco): nasce com tchefood_claim_lease() e o aparelho que a pediu o renova
--    (tchefood_touch_payment_claim) enquanto cobra. O gerente só libera a reserva depois de ela ficar parada por
--    tchefood_claim_abandon_after() além do prazo (TF011 antes disso, com a hora em que fica liberável): não se
--    libera a reserva de uma cobrança de cartão ainda rodando em outro aparelho. Quem pediu libera a qualquer hora.
-- 10. Auditoria r6, segunda revisão (P0, falsificação): o UUID do operador vem do aparelho e não prova nada. A reserva
--    nasce com um segredo de liberação aleatório (32 bytes, 64 letras hex minúsculas) que o APARELHO gera antes de
--    pedir a reserva e manda em tchefood_claim_payment (p_release_token). Assim uma resposta perdida (prazo da
--    chamada) não perde o segredo: o reenvio da mesma chave com o mesmo segredo devolve a reserva. O banco guarda só o
--    sha256 (release_token_hash, que o aparelho não lê e que não muda) e nunca devolve o segredo. A liberação sem PIN
--    exige o segredo; sem ele, só o gerente com PIN.
-- 11. Revisão independente do banco (F2): o saldo da conta não cai abaixo do que está reservado (reservas abertas e
--    cobranças da Point abertas ou aprovadas sem pagamento). Desconto, item cancelado ou 10% retirado depois da
--    reserva deixaria o dinheiro já recebido (Point ou dinheiro reservado) sem saldo para virar pagamento. Todo
--    recálculo do total passa por UPDATE em orders (tchefood_recalc_order), então o gatilho fica ali (TF012).
-- =============================================================================

-- Prazos da reserva, num lugar só. Prazo de atividade: quanto vale cada renovação do aparelho que cobra.
CREATE OR REPLACE FUNCTION tchefood_claim_lease()
RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '90 seconds' $$;
-- Espera depois do prazo vencido até o gerente poder liberar a reserva (aparelho sumido).
CREATE OR REPLACE FUNCTION tchefood_claim_abandon_after()
RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '5 minutes' $$;

-- -----------------------------------------------------------------------------
-- 4. Reserva de pagamento fora da Point
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- A MESMA chave do pagamento que vai consumir a reserva (payments.idempotency_key).
    idempotency_key VARCHAR(50) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,50}$'),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    method VARCHAR(10) NOT NULL CHECK (method IN ('CASH', 'CREDIT', 'DEBIT', 'PIX')),
    acquirer VARCHAR(20) NOT NULL CHECK (acquirer IN ('CASH_DESK', 'STONE', 'PAGBANK')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    -- open: reserva; released: liberada sem pagamento; consumed: virou o pagamento consumed_payment_id (final:
    -- estorno ou recusa posterior desse pagamento não faz a reserva voltar).
    status VARCHAR(10) NOT NULL DEFAULT 'open',
    created_by UUID NOT NULL REFERENCES staff_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at TIMESTAMPTZ,
    released_by UUID REFERENCES staff_users(id),
    release_reason TEXT,
    release_audit_id UUID REFERENCES audit_logs(id),
    consumed_payment_id UUID REFERENCES payments(id),
    consumed_at TIMESTAMPTZ,
    -- Até quando o aparelho que pediu a reserva está cobrando com ela (relógio do banco; o gatilho fixa na criação
    -- e só tchefood_touch_payment_claim o estende).
    active_until TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + tchefood_claim_lease(),
    -- sha256 do segredo de liberação (o segredo em si nunca é gravado). NULL na reserva gravada antes dele, ou fora
    -- de tchefood_claim_payment: essa só é liberada pelo gerente.
    release_token_hash BYTEA CHECK (release_token_hash IS NULL OR octet_length(release_token_hash) = 32),
    UNIQUE (tenant_id, idempotency_key),
    -- Mesma regra de tchefood_register_payment: dinheiro é no caixa, e só dinheiro é no caixa.
    CONSTRAINT payment_claims_cash_desk_check CHECK ((method = 'CASH') = (acquirer = 'CASH_DESK'))
);
-- Banco que já rodou uma versão anterior deste arquivo: as colunas e as regras de estado que vieram depois.
ALTER TABLE payment_claims ADD COLUMN IF NOT EXISTS consumed_payment_id UUID REFERENCES payments(id);
ALTER TABLE payment_claims ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
-- Reserva já gravada antes do prazo de atividade: ganha o prazo a partir de agora (conta como em andamento).
ALTER TABLE payment_claims ADD COLUMN IF NOT EXISTS active_until TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + tchefood_claim_lease();
ALTER TABLE payment_claims ADD COLUMN IF NOT EXISTS release_token_hash BYTEA CHECK (release_token_hash IS NULL OR octet_length(release_token_hash) = 32);
ALTER TABLE payment_claims DROP CONSTRAINT IF EXISTS payment_claims_status_check;
ALTER TABLE payment_claims ADD CONSTRAINT payment_claims_status_check CHECK (status IN ('open', 'released', 'consumed'));
-- Liberada tem quem, quando, por quê e o registro; consumida tem o pagamento e a hora; aberta não tem nada disso.
ALTER TABLE payment_claims DROP CONSTRAINT IF EXISTS payment_claims_release_check;
ALTER TABLE payment_claims ADD CONSTRAINT payment_claims_release_check CHECK (
    (status = 'open' AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL AND release_audit_id IS NULL
        AND consumed_payment_id IS NULL AND consumed_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL AND release_audit_id IS NOT NULL
        AND consumed_payment_id IS NULL AND consumed_at IS NULL)
    OR (status = 'consumed' AND consumed_payment_id IS NOT NULL AND consumed_at IS NOT NULL
        AND released_at IS NULL AND released_by IS NULL AND release_reason IS NULL AND release_audit_id IS NULL));
CREATE INDEX IF NOT EXISTS idx_payment_claims_order ON payment_claims(tenant_id, order_id);
ALTER TABLE payment_claims ENABLE ROW LEVEL SECURITY;

-- O aparelho só lê as reservas da própria loja; gravar, só pelas funções abaixo (SECURITY DEFINER).
DO $$
DECLARE
    v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            EXECUTE format('REVOKE ALL ON payment_claims FROM %I', v_role);
        END IF;
    END LOOP;
    -- Leitura por coluna: o aparelho lê tudo menos release_token_hash.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT SELECT (id, tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, status, created_by, created_at,
                      released_at, released_by, release_reason, release_audit_id, consumed_payment_id, consumed_at, active_until)
            ON payment_claims TO authenticated;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payment_claims' AND policyname = 'payment_claims_tenant_read') THEN
        CREATE POLICY payment_claims_tenant_read ON payment_claims FOR SELECT USING (tenant_id = tchefood_tenant());
    END IF;
END $$;

-- Chave, conta, valor, forma, credenciadora, operador e hora não mudam. Liberada é final, e só é liberada
-- com o registro PAYMENT_CLAIM_RELEASED dela e sem pagamento aprovado com a chave. A chave de uma cobrança
-- da Point (ou de um pagamento já gravado) não vira reserva (TF009): a trava da chave é a mesma do gatilho
-- de terminal_charges, então reserva e cobrança gravadas juntas com a mesma chave não passam as duas.
CREATE OR REPLACE FUNCTION tchefood_payment_claim_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'open' THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva de pagamento nasce aberta.' USING ERRCODE = 'TF006';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = NEW.created_by AND u.tenant_id = NEW.tenant_id AND u.active) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.tenant_id = NEW.tenant_id) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta não é desta loja.' USING ERRCODE = 'TF001';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('tchefood_payment_key:' || NEW.idempotency_key, 0));
        IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é de uma cobrança da Point.', NEW.idempotency_key USING ERRCODE = 'TF009';
        END IF;
        IF EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já é de um pagamento gravado.', NEW.idempotency_key USING ERRCODE = 'TF009';
        END IF;
        -- O prazo de atividade nasce do relógio do banco, nunca do que veio na linha.
        NEW.active_until := clock_timestamp() + tchefood_claim_lease();
        RETURN NEW;
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.order_id <> OLD.order_id
       OR NEW.method <> OLD.method OR NEW.acquirer <> OLD.acquirer OR NEW.amount_cents <> OLD.amount_cents
       OR NEW.created_by <> OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.release_token_hash IS DISTINCT FROM OLD.release_token_hash THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: chave, conta, valor, forma, credenciadora, operador, hora e segredo de liberação da reserva não mudam.';
    END IF;
    IF OLD.status = 'released' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % já foi liberada e não muda mais.', OLD.idempotency_key;
    END IF;
    IF OLD.status = 'consumed' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % já virou pagamento e não muda mais.', OLD.idempotency_key USING ERRCODE = 'TF007';
    END IF;
    -- O prazo de atividade só muda pela renovação (tchefood_touch_payment_claim liga a marca com o id da reserva,
    -- só na transação dela), só para a frente e só com a reserva aberta.
    IF NEW.active_until IS DISTINCT FROM OLD.active_until
       AND (current_setting('tchefood.claim_touch', true) IS DISTINCT FROM OLD.id::text OR NEW.status <> 'open'
            OR NEW.active_until IS NULL OR NEW.active_until < OLD.active_until) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o prazo da reserva % só é renovado pelo aparelho que a pediu (tchefood_touch_payment_claim).', OLD.idempotency_key;
    END IF;
    -- Consumida: só pelo pagamento APROVADO da mesma loja, conta e chave, até o valor reservado
    -- (trg_payments_claim_consume, logo depois de o pagamento ser gravado).
    IF NEW.status = 'consumed' AND NOT EXISTS (
        SELECT 1 FROM payments p WHERE p.id = NEW.consumed_payment_id AND p.tenant_id = NEW.tenant_id AND p.order_id = NEW.order_id
           AND p.idempotency_key = NEW.idempotency_key AND p.status = 'APPROVED' AND round(p.amount * 100)::BIGINT <= NEW.amount_cents) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % só é consumida pelo pagamento aprovado dela.', OLD.idempotency_key;
    END IF;
    IF NEW.status = 'released' THEN
        IF length(trim(COALESCE(NEW.release_reason, ''))) < 3
           OR NOT EXISTS (SELECT 1 FROM audit_logs a
                           WHERE a.id = NEW.release_audit_id AND a.tenant_id = NEW.tenant_id AND a.action_type = 'PAYMENT_CLAIM_RELEASED'
                             AND a.metadata->>'claim_id' = NEW.id::text) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % só é liberada com motivo e registro (tchefood_release_payment_claim).', OLD.idempotency_key;
        END IF;
        IF EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = NEW.tenant_id AND p.idempotency_key = NEW.idempotency_key
                      AND p.order_id = NEW.order_id AND p.status = 'APPROVED') THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % já virou pagamento e não é liberada.', OLD.idempotency_key USING ERRCODE = 'TF007';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_payment_claims_guard BEFORE INSERT OR UPDATE ON payment_claims
    FOR EACH ROW EXECUTE FUNCTION tchefood_payment_claim_guard();

-- O outro sentido: a chave de uma reserva de pagamento não vira cobrança da Point (vale também para o
-- bloqueio preventivo da chave, tchefood_block_point_key). Mesma trava da chave do gatilho acima.
CREATE OR REPLACE FUNCTION tchefood_terminal_charge_key_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('tchefood_payment_key:' || NEW.idempotency_key, 0));
    IF EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = NEW.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a chave % já é de outro pagamento (dinheiro ou outra maquininha).', NEW.idempotency_key USING ERRCODE = 'TF009';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_terminal_charges_claim_key BEFORE INSERT ON terminal_charges
    FOR EACH ROW EXECUTE FUNCTION tchefood_terminal_charge_key_guard();

-- -----------------------------------------------------------------------------
-- 1. A soma reservada (reserva única: cobranças da Point + reservas de pagamento)
-- -----------------------------------------------------------------------------
-- Cobrança da Point que reserva: não terminou, ou aprovada sem o pagamento do Mercado Pago dela.
CREATE OR REPLACE FUNCTION tchefood_point_charges_reserved_cents(p_tenant UUID, p_order UUID, p_exclude_key VARCHAR)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(SUM(c.amount_cents), 0)::BIGINT FROM terminal_charges c
     WHERE c.tenant_id = p_tenant AND c.order_id = p_order
       AND c.idempotency_key IS DISTINCT FROM p_exclude_key
       AND (c.status IN ('creating', 'pending', 'at_terminal', 'manual_review')
            OR (c.status = 'approved' AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = c.idempotency_key AND p.status <> 'PENDING'
                  AND p.acquirer::text = 'MERCADO_PAGO')));
$$;

-- Reserva de pagamento ativa: aberta e sem pagamento aprovado com a chave dela NESTA conta (o pagamento a
-- consome e a marca "consumed" logo em seguida, para sempre). Sem prazo: não expira por tempo.
CREATE OR REPLACE FUNCTION tchefood_payment_claims_reserved_cents(p_tenant UUID, p_order UUID, p_exclude_key VARCHAR)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(SUM(pc.amount_cents), 0)::BIGINT FROM payment_claims pc
     WHERE pc.tenant_id = p_tenant AND pc.order_id = p_order
       AND pc.idempotency_key IS DISTINCT FROM p_exclude_key
       AND pc.status = 'open'
       AND NOT EXISTS (
           SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = pc.idempotency_key
              AND p.order_id = pc.order_id AND p.status = 'APPROVED');
$$;

CREATE OR REPLACE FUNCTION tchefood_point_reserved_cents(p_tenant UUID, p_order UUID, p_exclude_key VARCHAR)
RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT tchefood_point_charges_reserved_cents(p_tenant, p_order, p_exclude_key)
         + tchefood_payment_claims_reserved_cents(p_tenant, p_order, p_exclude_key);
$$;

-- -----------------------------------------------------------------------------
-- 2. Gatilho em payments
-- -----------------------------------------------------------------------------
-- Loja com Point (auditoria r5 P1-B), decidido no servidor: tem maquininha MERCADO_PAGO cadastrada ou já teve
-- cobrança da Point. pos_terminals não tem marca de ativa; a segunda condição fecha o caso da maquininha que
-- troca de credenciadora no cadastro com cobrança dela ainda reservando (a FK de terminal_charges não deixa
-- apagar a maquininha que já cobrou).
CREATE OR REPLACE FUNCTION tchefood_point_store(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM pos_terminals t WHERE t.tenant_id = p_tenant AND t.acquirer::text = 'MERCADO_PAGO')
        OR EXISTS (SELECT 1 FROM terminal_charges c WHERE c.tenant_id = p_tenant);
$$;

-- Dinheiro que o entregador trouxe da senha paga na entrega (acerto do entregador, settleCourier em
-- src/store/useTcheStore.ts, chave "entrega-<id da entrega>"). Só vale com a entrega conferida no banco: da mesma
-- loja e conta, paga na entrega, com entregador e entregue; em dinheiro no caixa. O prefixo da chave sozinho não
-- libera nada. Não exige a entrega ainda sem acerto: a fila do aparelho manda o pagamento antes do acerto, e a
-- chave do pagamento é única (uma entrega, um pagamento).
CREATE OR REPLACE FUNCTION tchefood_courier_cash_payment(p payments)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT p.method::text = 'CASH' AND p.acquirer::text = 'CASH_DESK' AND p.idempotency_key LIKE 'entrega-%'
       AND EXISTS (SELECT 1 FROM own_deliveries d
                    WHERE 'entrega-' || d.id::text = p.idempotency_key AND d.tenant_id = p.tenant_id AND d.order_id = p.order_id
                      AND d.pay_on_delivery AND d.courier_id IS NOT NULL AND d.status = 'DELIVERED');
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
    v_claim payment_claims%ROWTYPE;
    v_claim_found BOOLEAN;
    v_claim_ok BOOLEAN := FALSE;
    v_exclude VARCHAR;
BEGIN
    IF NEW.status <> 'APPROVED' THEN
        RETURN NEW;
    END IF;
    -- UPDATE: só confere o que pode tirar dinheiro da reserva: virar aprovado, subir o valor aprovado ou
    -- trocar de conta, de loja, de chave ou de credenciadora. Mexer em outro campo de um pagamento já
    -- aprovado não reabre a conferência.
    IF TG_OP = 'UPDATE' AND OLD.status = 'APPROVED' AND NEW.amount <= OLD.amount
       AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
       AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key AND NEW.acquirer IS NOT DISTINCT FROM OLD.acquirer
       AND NEW.method IS NOT DISTINCT FROM OLD.method THEN
        RETURN NEW;
    END IF;
    -- tchefood_register_payment já travou a conta; travar de novo na mesma transação não custa nada
    -- e protege qualquer outro caminho que grave pagamento. A trava vem antes da conferência da chave:
    -- tchefood_open_terminal_charge e tchefood_claim_payment gravam a cobrança e a reserva com a mesma
    -- conta travada, então a chave que nasce junto com este pagamento já aparece aqui.
    SELECT * INTO v_order FROM orders WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id FOR UPDATE;
    v_found := FOUND;
    IF NOT v_found AND TG_OP = 'UPDATE' THEN
        -- Pagamento aprovado que muda de loja (ou de conta) para uma conta que não é da loja dele: a
        -- reserva seria somada na loja errada.
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta do pagamento não é da loja dele.';
    END IF;
    -- A chave de uma cobrança da Point só serve ao pagamento do Mercado Pago dela (conferido por
    -- trg_payments_mercado_pago). Outro pagamento aprovado com essa chave tiraria a reserva da cobrança
    -- sem a cobrança ter sido paga. Vale no INSERT (inclusive tchefood_register_payment, do aparelho) e no UPDATE.
    IF NEW.acquirer::text <> 'MERCADO_PAGO'
       AND EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é de uma cobrança da Point; só o pagamento dela no Mercado Pago usa essa chave.', NEW.idempotency_key;
    END IF;
    -- Auditoria r5 P0-01: a reserva de pagamento (payment_claims) só é consumida pelo pagamento da mesma
    -- conta, até o valor reservado e com a mesma forma e credenciadora. Chave de reserva de outra conta, valor
    -- acima da reserva ou outra forma/credenciadora: recusado (senão a reserva de uma conta pagaria outra, ou o
    -- pagamento passaria do que foi reservado). A reserva aberta, ou já consumida por ESTE pagamento (UPDATE),
    -- cobre o pagamento.
    IF NEW.acquirer::text <> 'MERCADO_PAGO' THEN
        SELECT * INTO v_claim FROM payment_claims pc WHERE pc.tenant_id = NEW.tenant_id AND pc.idempotency_key = NEW.idempotency_key;
        v_claim_found := FOUND;
        IF v_claim_found AND v_claim.order_id <> NEW.order_id THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é da reserva de pagamento de outra conta.', NEW.idempotency_key USING ERRCODE = 'TF010';
        END IF;
        -- Segunda revisão independente (item 1), em qualquer loja: a reserva liberada (pelo gerente ou pelo aparelho)
        -- não volta a cobrir nada. O dinheiro dela, se entrou, precisa ser devolvido, não gravado.
        IF v_claim_found AND v_claim.status = 'released' THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva deste pagamento foi liberada pelo gerente; o valor não pode entrar: confira e devolva ao cliente.'
                USING ERRCODE = 'TF013', DETAIL = 'claim_released idempotency_key=' || NEW.idempotency_key;
        END IF;
        v_claim_ok := v_claim_found AND (v_claim.status = 'open'
                                         OR (v_claim.status = 'consumed' AND TG_OP = 'UPDATE' AND v_claim.consumed_payment_id = OLD.id AND OLD.id = NEW.id));
        IF v_claim_ok THEN
            IF round(NEW.amount * 100)::BIGINT > v_claim.amount_cents THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: R$ % passa do valor reservado para este pagamento (R$ %).',
                    to_char(NEW.amount, 'FM999999990.00'), to_char(v_claim.amount_cents / 100.0, 'FM999999990.00') USING ERRCODE = 'TF010';
            END IF;
            IF NEW.method::text <> v_claim.method OR NEW.acquirer::text <> v_claim.acquirer THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o pagamento (% na %) não é o que foi reservado (% na %).',
                    NEW.method, NEW.acquirer, v_claim.method, v_claim.acquirer USING ERRCODE = 'TF010';
            END IF;
            IF v_claim.status = 'open' THEN
                v_exclude := NEW.idempotency_key; -- é este pagamento que consome a própria reserva
            END IF;
        END IF;
        -- Auditoria r5 P1-B: na loja com Point o servidor exige a reserva, sem confiar na lista de maquininhas do
        -- aparelho. Única exceção, conferida no banco: o dinheiro do entregador no acerto de senha paga na entrega.
        IF NOT v_claim_ok AND tchefood_point_store(NEW.tenant_id) AND NOT tchefood_courier_cash_payment(NEW) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: loja com Point: o pagamento fora dela precisa da reserva no servidor antes de receber (chave %). Nada foi gravado: peça a reserva e receba de novo.',
                NEW.idempotency_key USING ERRCODE = 'TF010';
        END IF;
    END IF;
    IF NOT v_found THEN
        RETURN NEW; -- a conta é conferida por quem grava (tchefood_register_payment e a FK)
    END IF;
    -- Só o pagamento do Mercado Pago deixa a própria cobrança de fora da soma (é ele que a consome), e só o
    -- pagamento da reserva aberta deixa a própria reserva de fora. As chaves das duas nunca coincidem (TF009).
    IF NEW.acquirer::text = 'MERCADO_PAGO' THEN
        v_exclude := NEW.idempotency_key;
    END IF;
    v_reserved := tchefood_point_reserved_cents(NEW.tenant_id, NEW.order_id, v_exclude);
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
CREATE OR REPLACE TRIGGER trg_payments_point_reservation BEFORE INSERT OR UPDATE OF status, amount, order_id, tenant_id, idempotency_key, acquirer, method ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_point_reservation_guard();

-- Auditoria r5 P3: o pagamento aprovado que consome a reserva a marca "consumed" (com o id dele), logo depois
-- de gravado e na mesma transação. É final: se o pagamento for recusado ou estornado depois, a reserva não volta
-- a reservar nem pode ser liberada (TF007).
CREATE OR REPLACE FUNCTION tchefood_payment_claim_consume()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.status = 'APPROVED' AND NEW.acquirer::text <> 'MERCADO_PAGO' AND NEW.idempotency_key IS NOT NULL THEN
        UPDATE payment_claims
           SET status = 'consumed', consumed_payment_id = NEW.id, consumed_at = clock_timestamp()
         WHERE tenant_id = NEW.tenant_id AND idempotency_key = NEW.idempotency_key AND order_id = NEW.order_id AND status = 'open';
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER trg_payments_claim_consume AFTER INSERT OR UPDATE OF status, amount, order_id, tenant_id, idempotency_key, acquirer, method ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_payment_claim_consume();

-- 2b. Saldo da conta nunca abaixo do reservado (revisão do banco, F2). Só quando o saldo CAI: o pagamento que cobre
-- uma reserva ou cobrança já está gravado quando o recálculo roda (gatilho AFTER de payments), e a soma reservada
-- deixa de contar a reserva dele; pagamento sem reserva já é barrado no saldo livre pelo gatilho de payments. O que
-- sobra é a redução do total (desconto, item cancelado, 10% retirado) com dinheiro reservado: recusada (TF012).
CREATE OR REPLACE FUNCTION tchefood_order_reserved_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_reserved BIGINT;
BEGIN
    v_reserved := tchefood_point_reserved_cents(NEW.tenant_id, NEW.id, NULL);
    IF v_reserved > 0 AND round(NEW.remaining_balance * 100)::BIGINT < v_reserved THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: há R$ % reservado em cobrança desta comanda; conclua ou libere antes de reduzir o total.',
            to_char(v_reserved / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF012', DETAIL = 'reserved_exceeds_balance reserved_cents=' || v_reserved
                || ' remaining_cents=' || round(NEW.remaining_balance * 100)::BIGINT;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_orders_reserved_guard BEFORE UPDATE OF remaining_balance ON orders
    FOR EACH ROW WHEN (NEW.remaining_balance < OLD.remaining_balance) EXECUTE FUNCTION tchefood_order_reserved_guard();

-- -----------------------------------------------------------------------------
-- 3. Leitura do aparelho: só a conta da própria loja (tenant do token)
-- -----------------------------------------------------------------------------
-- reserved_cents = point_cents + claims_cents (a reserva única). claims: as reservas de pagamento abertas da
-- conta (quem pediu, quando, forma e credenciadora; active_until = até quando o aparelho que pediu está cobrando,
-- releasable_at = a partir de quando o gerente pode liberá-la). charges: as cobranças da Point da conta
-- que reservam, para o aparelho que não as criou mostrar e mandar conferir no Mercado Pago. has_payment:
-- há linha em payments desta loja com a chave da cobrança (qualquer estado; o aprovado do Mercado Pago tira
-- a cobrança da lista).
CREATE OR REPLACE FUNCTION tchefood_point_reservation(p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_charges JSONB;
    v_claims_list JSONB;
    v_point BIGINT;
    v_claims BIGINT;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'idempotency_key', c.idempotency_key, 'status', c.status, 'amount_cents', c.amount_cents,
               'raw_status_detail', c.raw_status_detail,
               'has_payment', EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = c.idempotency_key))
             ORDER BY c.created_at, c.idempotency_key), '[]'::jsonb)
      INTO v_charges
      FROM terminal_charges c
     WHERE c.tenant_id = v_tenant AND c.order_id = p_order
       AND (c.status IN ('creating', 'pending', 'at_terminal', 'manual_review')
            OR (c.status = 'approved' AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = c.idempotency_key AND p.status <> 'PENDING'
                  AND p.acquirer::text = 'MERCADO_PAGO')));
    -- Auditoria r5: as reservas de pagamento abertas da conta (presas de outro aparelho aparecem aqui para o
    -- gerente liberar com PIN).
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'idempotency_key', pc.idempotency_key, 'amount_cents', pc.amount_cents, 'method', pc.method, 'acquirer', pc.acquirer,
               'created_at', pc.created_at, 'created_by', pc.created_by, 'created_by_name', u.name,
               'active_until', pc.active_until, 'releasable_at', pc.active_until + tchefood_claim_abandon_after())
             ORDER BY pc.created_at, pc.idempotency_key), '[]'::jsonb)
      INTO v_claims_list
      FROM payment_claims pc LEFT JOIN staff_users u ON u.id = pc.created_by
     WHERE pc.tenant_id = v_tenant AND pc.order_id = p_order AND pc.status = 'open';
    v_point := tchefood_point_charges_reserved_cents(v_tenant, p_order, NULL);
    v_claims := tchefood_payment_claims_reserved_cents(v_tenant, p_order, NULL);
    RETURN jsonb_build_object(
        'reserved_cents', v_point + v_claims,
        'point_cents', v_point,
        'claims_cents', v_claims,
        'open_charges', jsonb_array_length(v_charges),
        'manual_review', EXISTS (SELECT 1 FROM terminal_charges c WHERE c.tenant_id = v_tenant AND c.order_id = p_order AND c.status = 'manual_review'),
        'charges', v_charges,
        'claims', v_claims_list);
END;
$$;

-- -----------------------------------------------------------------------------
-- 4b. Pedir a reserva antes de cobrar fora da Point (aparelho)
-- -----------------------------------------------------------------------------
-- Ordem das conferências: dados inválidos (TF006); operador fora da equipe ativa (TF004); chave que já é
-- reserva desta loja: devolve a mesma, sem reconferir saldo, se conta, valor, forma e credenciadora forem
-- iguais (senão TF009); chave de cobrança da Point ou de pagamento já gravado (TF009); conta travada:
-- não está no servidor (TF001), encerrada (TF002), saldo diferente do mostrado no aparelho (TF008),
-- valor acima do saldo menos a reserva única (TF003). Devolve {id, idempotency_key, status, amount_cents}:
-- status "released" quer dizer que a reserva com esta chave já foi liberada (não cobre com ela).
-- p_release_token: segredo de liberação gerado pelo aparelho, exatamente 64 letras hex minúsculas (senão TF006).
-- A reserva nova guarda só o sha256 dele. O reenvio da mesma chave só devolve a reserva com o MESMO segredo; com
-- outro, é a mesma recusa de chave em uso (TF009), sem dizer mais nada. O segredo nunca volta na resposta.
-- A assinatura antiga (7 argumentos, segredo gerado no banco) foi removida: aparelho antigo recebe 42883.
DROP FUNCTION IF EXISTS tchefood_claim_payment(VARCHAR, UUID, VARCHAR, VARCHAR, BIGINT, BIGINT, UUID);
CREATE OR REPLACE FUNCTION tchefood_claim_payment(
    p_key VARCHAR, p_order UUID, p_method VARCHAR, p_acquirer VARCHAR, p_amount_cents BIGINT,
    p_expected_balance_cents BIGINT, p_staff UUID, p_release_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_claim payment_claims%ROWTYPE;
    v_order orders%ROWTYPE;
    v_balance BIGINT;
    v_reserved BIGINT;
    v_hash BYTEA;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{1,50}$' OR p_order IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: chave ou conta da reserva inválida.' USING ERRCODE = 'TF006';
    END IF;
    IF p_method IS NULL OR p_method NOT IN ('CASH', 'CREDIT', 'DEBIT', 'PIX')
       OR p_acquirer IS NULL OR p_acquirer NOT IN ('CASH_DESK', 'STONE', 'PAGBANK')
       OR (p_method = 'CASH') <> (p_acquirer = 'CASH_DESK') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: forma de pagamento ou credenciadora inválida para a reserva.' USING ERRCODE = 'TF006';
    END IF;
    IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_expected_balance_cents IS NULL OR p_expected_balance_cents < 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: valor ou saldo da reserva inválido. Nada foi cobrado.' USING ERRCODE = 'TF006';
    END IF;
    IF p_release_token IS NULL OR p_release_token !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: segredo de liberação da reserva inválido (64 letras hex minúsculas). Nada foi cobrado.' USING ERRCODE = 'TF006';
    END IF;
    v_hash := sha256(convert_to(p_release_token, 'UTF8'));
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    -- Reenvio (a resposta se perdeu): devolve a reserva gravada sem reconferir o saldo (ele pode ter mudado
    -- de verdade, inclusive pelo próprio pagamento desta reserva).
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF FOUND THEN
        -- Outro segredo (ou reserva sem segredo) é a mesma recusa de chave em uso: não diz que a chave existe.
        IF v_claim.order_id <> p_order OR v_claim.amount_cents <> p_amount_cents OR v_claim.method <> p_method OR v_claim.acquirer <> p_acquirer
           OR v_claim.release_token_hash IS NULL OR v_claim.release_token_hash <> v_hash THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já reservou outro pagamento.', p_key USING ERRCODE = 'TF009';
        END IF;
        RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents);
    END IF;
    IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = p_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é de uma cobrança da Point.', p_key USING ERRCODE = 'TF009';
    END IF;
    IF EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = p_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já é de um pagamento gravado.', p_key USING ERRCODE = 'TF009';
    END IF;
    -- A mesma trava de tchefood_open_terminal_charge e do gatilho de payments: reserva, cobrança da Point e
    -- pagamento da mesma conta não passam juntos do saldo.
    SELECT * INTO v_order FROM orders WHERE id = p_order AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta ainda não está no servidor. Aguarde a sincronização e tente de novo.' USING ERRCODE = 'TF001';
    END IF;
    -- Dois pedidos da mesma chave: o segundo espera a conta e, ao entrar, a reserva já existe.
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF FOUND THEN
        -- Outro segredo (ou reserva sem segredo) é a mesma recusa de chave em uso: não diz que a chave existe.
        IF v_claim.order_id <> p_order OR v_claim.amount_cents <> p_amount_cents OR v_claim.method <> p_method OR v_claim.acquirer <> p_acquirer
           OR v_claim.release_token_hash IS NULL OR v_claim.release_token_hash <> v_hash THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já reservou outro pagamento.', p_key USING ERRCODE = 'TF009';
        END IF;
        RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents);
    END IF;
    IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta já está %.', CASE v_order.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END USING ERRCODE = 'TF002';
    END IF;
    v_balance := round(v_order.remaining_balance * 100)::BIGINT;
    IF v_balance <> p_expected_balance_cents THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta na nuvem tem saldo de R$ %, diferente do R$ % mostrado no aparelho. Nada foi cobrado: sincronize e tente de novo.',
            to_char(v_balance / 100.0, 'FM999999990.00'), to_char(p_expected_balance_cents / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF008';
    END IF;
    v_reserved := tchefood_point_reserved_cents(v_tenant, p_order, NULL);
    IF p_amount_cents > v_balance - v_reserved THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: R$ % passa do saldo livre da conta no servidor (R$ % livre; R$ % reservado na Point ou em outro pagamento).',
            to_char(p_amount_cents / 100.0, 'FM999999990.00'), to_char(GREATEST(v_balance - v_reserved, 0) / 100.0, 'FM999999990.00'),
            to_char(v_reserved / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF003';
    END IF;
    -- O gatilho confere de novo a chave contra cobranças da Point e pagamentos, com a chave travada.
    INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, status, created_by, release_token_hash)
    VALUES (v_tenant, p_key, p_order, p_method, p_acquirer, p_amount_cents, 'open', p_staff, v_hash)
    RETURNING * INTO v_claim;
    RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents);
END;
$$;

-- -----------------------------------------------------------------------------
-- 4c. Trocar a reserva por outra (segunda revisão independente, item 2)
-- -----------------------------------------------------------------------------
-- A maquininha respondeu com outra credenciadora (ou forma) que a reservada (o aparelho segura o recibo com
-- ACQUIRER_MISMATCH): o recibo só entra com uma reserva da credenciadora real. Numa transação só, com a conta
-- travada primeiro: confere o segredo da reserva antiga (TF004), que ela está aberta e sem pagamento (TF007),
-- libera a antiga (PAYMENT_CLAIM_RELEASED com released_via = 'reclaim' e a chave nova) e cria a nova na MESMA
-- conta, com o saldo livre contado sem a antiga (TF003). A nova segue as regras de tchefood_claim_payment
-- (segredo do aparelho, chave livre: TF009, conta aberta: TF002). Reenvio (a resposta se perdeu): antiga já
-- liberada por esta troca e a nova gravada com os mesmos dados e o mesmo segredo = devolve a mesma troca.
-- Devolve {old: {id, idempotency_key, status, release_audit_id}, new: {id, idempotency_key, status, amount_cents}}.
CREATE OR REPLACE FUNCTION tchefood_reclaim_payment(
    p_old_key VARCHAR, p_old_token TEXT, p_new_key VARCHAR, p_new_token TEXT,
    p_method VARCHAR, p_acquirer VARCHAR, p_amount_cents BIGINT, p_staff UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_old payment_claims%ROWTYPE;
    v_new payment_claims%ROWTYPE;
    v_order orders%ROWTYPE;
    v_hash BYTEA;
    v_balance BIGINT;
    v_reserved BIGINT;
    v_audit UUID;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_old_key IS NULL OR p_new_key IS NULL OR p_new_key !~ '^[A-Za-z0-9_-]{1,50}$' OR p_new_key = p_old_key THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: chave da reserva inválida (a nova precisa ser outra chave).' USING ERRCODE = 'TF006';
    END IF;
    IF p_method IS NULL OR p_method NOT IN ('CASH', 'CREDIT', 'DEBIT', 'PIX')
       OR p_acquirer IS NULL OR p_acquirer NOT IN ('CASH_DESK', 'STONE', 'PAGBANK')
       OR (p_method = 'CASH') <> (p_acquirer = 'CASH_DESK') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: forma de pagamento ou credenciadora inválida para a reserva.' USING ERRCODE = 'TF006';
    END IF;
    IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: valor da reserva inválido. Nada foi cobrado.' USING ERRCODE = 'TF006';
    END IF;
    IF p_new_token IS NULL OR p_new_token !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: segredo de liberação da reserva inválido (64 letras hex minúsculas). Nada foi cobrado.' USING ERRCODE = 'TF006';
    END IF;
    v_hash := sha256(convert_to(p_new_token, 'UTF8'));
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    SELECT * INTO v_old FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_old_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: reserva de pagamento não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF v_old.release_token_hash IS NULL OR p_old_token IS NULL
       OR sha256(convert_to(p_old_token, 'UTF8')) <> v_old.release_token_hash THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: só o aparelho que pediu a reserva a troca por outra.' USING ERRCODE = 'TF004';
    END IF;
    -- Conta primeiro (a mesma trava de tchefood_claim_payment e do gatilho de payments), depois a reserva.
    SELECT * INTO v_order FROM orders WHERE id = v_old.order_id AND tenant_id = v_tenant FOR UPDATE;
    SELECT * INTO v_old FROM payment_claims WHERE id = v_old.id FOR UPDATE;
    SELECT * INTO v_new FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_new_key;
    IF FOUND THEN
        -- Reenvio da mesma troca: devolve o que já foi gravado. Qualquer outra coisa com a chave nova é chave em uso.
        IF v_new.order_id = v_old.order_id AND v_new.method = p_method AND v_new.acquirer = p_acquirer AND v_new.amount_cents = p_amount_cents
           AND v_new.release_token_hash = v_hash AND v_old.status = 'released'
           AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.id = v_old.release_audit_id AND a.metadata->>'released_via' = 'reclaim'
                          AND a.metadata->>'new_idempotency_key' = p_new_key) THEN
            RETURN jsonb_build_object(
                'old', jsonb_build_object('id', v_old.id, 'idempotency_key', v_old.idempotency_key, 'status', v_old.status, 'release_audit_id', v_old.release_audit_id),
                'new', jsonb_build_object('id', v_new.id, 'idempotency_key', v_new.idempotency_key, 'status', v_new.status, 'amount_cents', v_new.amount_cents));
        END IF;
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já reservou outro pagamento.', p_new_key USING ERRCODE = 'TF009';
    END IF;
    IF v_old.status <> 'open' OR EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = v_old.idempotency_key
                                           AND p.order_id = v_old.order_id AND p.status = 'APPROVED') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % não está aberta (%); não há o que trocar.', p_old_key,
            CASE v_old.status WHEN 'released' THEN 'liberada' WHEN 'consumed' THEN 'já virou pagamento' ELSE 'já virou pagamento' END
            USING ERRCODE = 'TF007';
    END IF;
    IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = p_new_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é de uma cobrança da Point.', p_new_key USING ERRCODE = 'TF009';
    END IF;
    IF EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = p_new_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já é de um pagamento gravado.', p_new_key USING ERRCODE = 'TF009';
    END IF;
    IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta já está %.', CASE v_order.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END USING ERRCODE = 'TF002';
    END IF;
    -- Saldo livre sem a reserva antiga (é ela que sai).
    v_balance := round(v_order.remaining_balance * 100)::BIGINT;
    v_reserved := tchefood_point_reserved_cents(v_tenant, v_old.order_id, p_old_key);
    IF p_amount_cents > v_balance - v_reserved THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: R$ % passa do saldo livre da conta no servidor (R$ % livre; R$ % reservado na Point ou em outro pagamento).',
            to_char(p_amount_cents / 100.0, 'FM999999990.00'), to_char(GREATEST(v_balance - v_reserved, 0) / 100.0, 'FM999999990.00'),
            to_char(v_reserved / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF003';
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, v_old.order_id, p_staff, 'PAYMENT_CLAIM_RELEASED', 0, 'troca da reserva pela credenciadora da maquininha',
            jsonb_build_object('claim_id', v_old.id, 'idempotency_key', v_old.idempotency_key, 'amount_cents', v_old.amount_cents,
                               'method', v_old.method, 'acquirer', v_old.acquirer, 'created_by', v_old.created_by,
                               'claim_creator', v_old.created_by, 'released_via', 'reclaim',
                               'new_idempotency_key', p_new_key, 'new_method', p_method, 'new_acquirer', p_acquirer, 'new_amount_cents', p_amount_cents,
                               'by_manager', false, 'server_verified', true))
    RETURNING id INTO v_audit;
    UPDATE payment_claims
       SET status = 'released', released_at = clock_timestamp(), released_by = p_staff,
           release_reason = 'troca da reserva pela credenciadora da maquininha', release_audit_id = v_audit
     WHERE id = v_old.id
    RETURNING * INTO v_old;
    -- O gatilho confere de novo a chave contra cobranças da Point e pagamentos, com a chave travada.
    INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, status, created_by, release_token_hash)
    VALUES (v_tenant, p_new_key, v_old.order_id, p_method, p_acquirer, p_amount_cents, 'open', p_staff, v_hash)
    RETURNING * INTO v_new;
    RETURN jsonb_build_object(
        'old', jsonb_build_object('id', v_old.id, 'idempotency_key', v_old.idempotency_key, 'status', v_old.status, 'release_audit_id', v_old.release_audit_id),
        'new', jsonb_build_object('id', v_new.id, 'idempotency_key', v_new.idempotency_key, 'status', v_new.status, 'amount_cents', v_new.amount_cents));
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Liberar a reserva que não virou pagamento
-- -----------------------------------------------------------------------------
-- Pelo aparelho: a maquininha recusou ou o operador desistiu antes de receber. Só com o segredo de liberação que
-- o aparelho mandou a tchefood_claim_payment ao criar a reserva (p_release_token; errado, ausente, ou reserva sem segredo:
-- TF004, nada muda; outro aparelho usa a liberação com PIN de gerente). p_staff é só quem opera o aparelho agora
-- (precisa ser da equipe ativa); não prova nada sobre a reserva. Já liberada (com o segredo certo): devolve como
-- está (sem outro registro). O registro PAYMENT_CLAIM_RELEASED leva released_via = 'release_token' e
-- claim_creator = quem pediu a reserva. Consumida, ou com pagamento aprovado com a chave nesta conta: TF007. A conta é travada antes
-- da reserva (a mesma ordem do gatilho de payments): liberação e pagamento da mesma reserva ao mesmo tempo
-- esperam um pelo outro, e a liberação nunca passa por cima de um pagamento já gravado.
-- Devolve {id, idempotency_key, status, amount_cents, released_at, release_audit_id}.
-- A assinatura de 3 argumentos (sem o segredo) sai: o aparelho antigo recebe "função não existe" em vez de liberar.
DROP FUNCTION IF EXISTS tchefood_release_payment_claim(VARCHAR, UUID, TEXT);
CREATE OR REPLACE FUNCTION tchefood_release_payment_claim(p_key VARCHAR, p_staff UUID, p_release_token TEXT, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_claim payment_claims%ROWTYPE;
    v_audit UUID;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: motivo obrigatório (mínimo 3 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: reserva de pagamento não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    -- Auditoria r6 (falsificação): sem PIN, só quem tem o segredo da reserva libera. Comparação dos sha256 (o tempo
    -- não depende de quantas letras do segredo batem).
    IF v_claim.release_token_hash IS NULL OR p_release_token IS NULL
       OR sha256(convert_to(p_release_token, 'UTF8')) <> v_claim.release_token_hash THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: só o aparelho que pediu a reserva libera sem PIN; outro aparelho precisa do PIN de gerente.' USING ERRCODE = 'TF004';
    END IF;
    PERFORM 1 FROM orders o WHERE o.id = v_claim.order_id AND o.tenant_id = v_tenant FOR UPDATE;
    SELECT * INTO v_claim FROM payment_claims WHERE id = v_claim.id FOR UPDATE;
    IF v_claim.status = 'released' THEN
        RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents,
                                  'released_at', v_claim.released_at, 'release_audit_id', v_claim.release_audit_id);
    END IF;
    IF v_claim.status = 'consumed' OR EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = v_claim.idempotency_key
                  AND p.order_id = v_claim.order_id AND p.status = 'APPROVED') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % já virou pagamento e não é liberada.', p_key USING ERRCODE = 'TF007';
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, v_claim.order_id, p_staff, 'PAYMENT_CLAIM_RELEASED', 0, trim(p_reason),
            jsonb_build_object('claim_id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'amount_cents', v_claim.amount_cents,
                               'method', v_claim.method, 'acquirer', v_claim.acquirer, 'created_by', v_claim.created_by,
                               'claim_creator', v_claim.created_by, 'released_via', 'release_token',
                               'by_manager', false, 'server_verified', true))
    RETURNING id INTO v_audit;
    UPDATE payment_claims
       SET status = 'released', released_at = clock_timestamp(), released_by = p_staff, release_reason = trim(p_reason), release_audit_id = v_audit
     WHERE id = v_claim.id
    RETURNING * INTO v_claim;
    RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents,
                              'released_at', v_claim.released_at, 'release_audit_id', v_claim.release_audit_id);
END;
$$;

-- Renovação do prazo de atividade (auditoria r6 P0-02): o aparelho que pediu a reserva chama enquanto cobra (a
-- cada poucos segundos). Só com o segredo de liberação da reserva (p_release_token, o mesmo da liberação sem PIN;
-- errado, ausente ou reserva sem segredo: TF004 e nada muda): o UUID do operador não prova nada, e renovar a reserva
-- de outro aparelho deixaria o gerente sem poder liberá-la. p_staff precisa ser da equipe ativa (TF004). Reserva de
-- outra loja ou que não existe: TF005. Aberta: estende active_until para agora + tchefood_claim_lease() (relógio do
-- banco, nunca para trás). Liberada ou consumida: devolve o estado sem mudar nada (só para quem tem o segredo).
-- Trava a conta antes da reserva, na ordem da liberação e do gatilho de payments. Devolve {status, active_until}.
-- A assinatura sem o segredo sai.
DROP FUNCTION IF EXISTS tchefood_touch_payment_claim(VARCHAR, UUID);
CREATE OR REPLACE FUNCTION tchefood_touch_payment_claim(p_key VARCHAR, p_staff UUID, p_release_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_claim payment_claims%ROWTYPE;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: reserva de pagamento não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF v_claim.release_token_hash IS NULL OR p_release_token IS NULL
       OR sha256(convert_to(p_release_token, 'UTF8')) <> v_claim.release_token_hash THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: só o aparelho que pediu a reserva renova o prazo dela.' USING ERRCODE = 'TF004';
    END IF;
    PERFORM 1 FROM orders o WHERE o.id = v_claim.order_id AND o.tenant_id = v_tenant FOR UPDATE;
    SELECT * INTO v_claim FROM payment_claims WHERE id = v_claim.id FOR UPDATE;
    IF v_claim.status = 'open' THEN
        PERFORM set_config('tchefood.claim_touch', v_claim.id::text, true);
        UPDATE payment_claims SET active_until = GREATEST(active_until, clock_timestamp() + tchefood_claim_lease())
         WHERE id = v_claim.id
        RETURNING * INTO v_claim;
        PERFORM set_config('tchefood.claim_touch', '', true);
    END IF;
    RETURN jsonb_build_object('status', v_claim.status, 'active_until', v_claim.active_until);
END;
$$;

-- Reserva presa de aparelho que sumiu: PIN de gerente conferido aqui, com as regras de
-- tchefood_authorize_manager e de tchefood_authorize_point_cancel (gerente ou dono ativo da loja, 3 PINs
-- errados em 60 s bloqueiam, com a loja travada para tentativas simultâneas não passarem juntas) e motivo
-- com 10+ letras. Com pagamento aprovado: TF007, sem registro. Aberta e antes de active_until +
-- tchefood_claim_abandon_after(): TF011 (o aparelho que pediu ainda pode estar cobrando), sem conferir PIN e sem
-- registro. Já liberada: só depois do PIN conferido devolve como está, sem gravar outro registro (terceira revisão
-- P2-1: sem isso, qualquer PIN "liberava" a reserva no aparelho); a mensagem traz a hora em que fica liberável. PIN errado ou bloqueado: NULL, nada é liberado e a falha fica em audit_logs
-- (MANAGER_PIN_FAILED / MANAGER_PIN_LOCKOUT, que contam no bloqueio). Não há fonte externa a consultar: o
-- comprovante da Stone/PagBank tem o próprio fluxo (NSU do papel).
CREATE OR REPLACE FUNCTION tchefood_release_payment_claim_manager(p_key VARCHAR, p_staff UUID, p_manager_pin VARCHAR, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_claim payment_claims%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_failures INT;
    v_audit UUID;
    v_releasable TIMESTAMPTZ;
    v_checked_at TIMESTAMPTZ;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: motivo obrigatório (mínimo 10 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: reserva de pagamento não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    -- Trava do PIN da loja ANTES de qualquer trava de linha (regra da main, #50): na ordem inversa, esta liberação
    -- (conta travada, esperando o PIN) e outra autorização com PIN na mesma conta (PIN na mão, gravando o registro
    -- que aponta para a conta) esperavam uma pela outra.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
    PERFORM 1 FROM orders o WHERE o.id = v_claim.order_id AND o.tenant_id = v_tenant FOR UPDATE;
    SELECT * INTO v_claim FROM payment_claims WHERE id = v_claim.id FOR UPDATE;
    IF v_claim.status = 'consumed' OR EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = v_claim.idempotency_key
                  AND p.order_id = v_claim.order_id AND p.status = 'APPROVED') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % já virou pagamento e não é liberada.', p_key USING ERRCODE = 'TF007';
    END IF;
    -- Auditoria r6 P0-02: reserva com o aparelho ainda cobrando (prazo renovado há pouco) não é liberada pelo
    -- gerente: a cobrança de cartão pode estar rodando. Antes do PIN (a recusa não gasta tentativa).
    v_releasable := v_claim.active_until + tchefood_claim_abandon_after();
    IF v_claim.status = 'open' AND clock_timestamp() < v_releasable THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % ainda está em andamento no aparelho que a pediu; o gerente pode liberá-la a partir de % (horário de Brasília).',
            p_key, to_char(v_releasable AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS')
            USING ERRCODE = 'TF011', DETAIL = 'releasable_at=' || to_char(v_releasable AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    END IF;
    -- Janela de 60 s pelo relógio de agora (a chamada pode ter esperado pelas travas), como na main (#50); as falhas
    -- e o bloqueio são gravados com esse horário.
    v_checked_at := clock_timestamp();
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= v_checked_at - INTERVAL '60 seconds' AND a.created_at <= v_checked_at;
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, v_claim.order_id, p_staff, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', 'PAYMENT_CLAIM_RELEASED', 'idempotency_key', v_claim.idempotency_key), v_checked_at);
        RETURN NULL;
    END IF;
    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, v_claim.order_id, p_staff, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', 'PAYMENT_CLAIM_RELEASED', 'idempotency_key', v_claim.idempotency_key), v_checked_at);
        RETURN NULL;
    END IF;
    -- Terceira revisão (P2-1): a reserva já liberada só volta como está DEPOIS do PIN conferido (com PIN errado é
    -- NULL e conta no bloqueio, como as outras), sem gravar outro registro.
    IF v_claim.status = 'released' THEN
        RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents,
                                  'released_at', v_claim.released_at, 'release_audit_id', v_claim.release_audit_id);
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, v_claim.order_id, p_staff, v_manager.id, 'PAYMENT_CLAIM_RELEASED', 0, trim(p_reason),
            jsonb_build_object('claim_id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'amount_cents', v_claim.amount_cents,
                               'method', v_claim.method, 'acquirer', v_claim.acquirer, 'created_by', v_claim.created_by,
                               'by_manager', true, 'manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_audit;
    UPDATE payment_claims
       SET status = 'released', released_at = clock_timestamp(), released_by = p_staff, release_reason = trim(p_reason), release_audit_id = v_audit
     WHERE id = v_claim.id
    RETURNING * INTO v_claim;
    RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents,
                              'released_at', v_claim.released_at, 'release_audit_id', v_claim.release_audit_id);
END;
$$;

-- -----------------------------------------------------------------------------
-- 5c. Reserva liberada com o dinheiro já recebido: estornado/devolvido, com PIN de gerente
-- -----------------------------------------------------------------------------
-- A maquininha aprovou (ou o dinheiro entrou) numa reserva que foi liberada: o pagamento não entra (TF013) e o
-- valor volta ao cliente. O aparelho registra "Estornei na maquininha / devolvi" com o PIN do gerente:
-- CLAIM_RELEASED_REFUNDED, com o gerente conferido aqui (o aparelho não grava esse tipo direto:
-- tchefood_guard_point_audit). Ordem: motivo (10+ letras) e p_metadata (só refund_kind 'card'|'cash', obrigatório,
-- e payment_local_id, texto de até 100 letras, opcional; outra chave: TF006); operador da equipe ativa (TF004);
-- trava do PIN da loja (antes de qualquer linha, regra da main #50); reserva desta loja (TF005) e liberada (TF007,
-- antes do PIN: não gasta tentativa); bloqueio de 3 erros em 60 s pelo relógio de agora (MANAGER_PIN_LOCKOUT, NULL);
-- PIN de gerente ou dono ativo (MANAGER_PIN_FAILED, NULL). Com o PIN certo, um registro por reserva: a segunda chamada
-- devolve o mesmo id (sem gravar outro). Devolve o id do registro.
CREATE OR REPLACE FUNCTION tchefood_authorize_claim_refunded(
    p_key VARCHAR, p_staff UUID, p_manager_pin VARCHAR, p_reason TEXT, p_metadata JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_claim payment_claims%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_meta JSONB := COALESCE(p_metadata, '{}'::jsonb);
    v_failures INT;
    v_checked_at TIMESTAMPTZ;
    v_id UUID;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: motivo obrigatório (mínimo 10 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF jsonb_typeof(v_meta) <> 'object' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: dados do estorno inválidos (refund_kind card ou cash; payment_local_id opcional).' USING ERRCODE = 'TF006';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE k NOT IN ('refund_kind', 'payment_local_id'))
       OR jsonb_typeof(v_meta->'refund_kind') IS DISTINCT FROM 'string' OR v_meta->>'refund_kind' NOT IN ('card', 'cash')
       OR (v_meta ? 'payment_local_id' AND (jsonb_typeof(v_meta->'payment_local_id') <> 'string'
                                              OR length(v_meta->>'payment_local_id') NOT BETWEEN 1 AND 100)) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: dados do estorno inválidos (refund_kind card ou cash; payment_local_id opcional).' USING ERRCODE = 'TF006';
    END IF;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    -- Trava do PIN da loja antes de qualquer trava de linha (a mesma das outras autorizações com PIN). Ela também
    -- serializa as chamadas da mesma reserva: a segunda encontra o registro da primeira.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: reserva de pagamento não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF v_claim.status <> 'released' THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a reserva % não foi liberada (está %); não há estorno a registrar.', p_key,
            CASE v_claim.status WHEN 'open' THEN 'aberta' ELSE 'paga' END USING ERRCODE = 'TF007';
    END IF;
    v_checked_at := clock_timestamp();
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= v_checked_at - INTERVAL '60 seconds' AND a.created_at <= v_checked_at;
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, v_claim.order_id, p_staff, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', 'CLAIM_RELEASED_REFUNDED', 'idempotency_key', p_key), v_checked_at);
        RETURN NULL;
    END IF;
    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, v_claim.order_id, p_staff, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', 'CLAIM_RELEASED_REFUNDED', 'idempotency_key', p_key), v_checked_at);
        RETURN NULL;
    END IF;
    -- Um registro por reserva: o reenvio (resposta perdida) devolve o mesmo.
    SELECT a.id INTO v_id FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'CLAIM_RELEASED_REFUNDED' AND a.metadata->>'claim_id' = v_claim.id::text
     ORDER BY a.created_at LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, v_claim.order_id, p_staff, v_manager.id, 'CLAIM_RELEASED_REFUNDED', 0, trim(p_reason),
            v_meta || jsonb_build_object('claim_id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'amount_cents', v_claim.amount_cents,
                                         'method', v_claim.method, 'acquirer', v_claim.acquirer, 'release_audit_id', v_claim.release_audit_id,
                                         'manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Fim verificado da cobrança da Point (auditoria r5 P1-01)
-- -----------------------------------------------------------------------------
-- Só a service role (a Edge Function chama depois de ler o Mercado Pago). Transições aceitas:
--   manual_review → approved | rejected | cancelled | expired | refunded
--   approved → refunded, só sem pagamento APROVADO do Mercado Pago com a chave (senão TF007).
-- Numa transação: trava a cobrança; se o estado atual não é p_from_status, devolve a linha como está e não
-- grava nada (a segunda chamada é inofensiva); senão grava UM registro POINT_CHARGE_RESOLVED (de, para,
-- evidência lida no Mercado Pago, operador, motivo), liga só nesta transação a marca
-- tchefood.point_resolution com o id do registro (o gatilho da cobrança confere o registro) e grava o novo
-- estado com os campos de p_patch. p_patch aceita só os campos que o Mercado Pago informa: na saída da
-- revisão manual external_payment_id, raw_status, raw_status_detail, paid_amount_cents, card_brand,
-- authorization_code e last_four (nunca status nem external_order_id: a ordem só é ligada por attachOrder;
-- aprovada pelo ID da operação pode ficar sem ordem); no estorno da aprovada, só raw_status e
-- raw_status_detail (o comprovante fica). Aprovada continua exigindo comprovante completo (gatilho da cobrança).
-- p_evidence (objeto) sempre traz authorization_audit_id e operation_id. authorization_audit_id é o registro
-- POINT_CHARGE_RECONCILE_AUTHORIZED desta loja e desta cobrança (tchefood_authorize_point_reconcile, PIN de
-- gerente), conferido aqui e aceito para um fim só (TF006 se não confere, TF007 se já foi usado).
-- O estorno trava a cobrança: o gatilho do pagamento do Mercado Pago lê a mesma linha com FOR SHARE, então
-- estorno e pagamento juntos esperam um pelo outro (a conta não é travada aqui: terminar só libera reserva).
CREATE OR REPLACE FUNCTION tchefood_resolve_point_charge(
    p_tenant UUID, p_id UUID, p_from_status VARCHAR, p_to_status VARCHAR, p_patch JSONB,
    p_staff UUID, p_reason TEXT, p_evidence JSONB)
RETURNS terminal_charges
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
    v_patch JSONB := COALESCE(p_patch, '{}'::jsonb);
    v_allowed TEXT[];
    v_field TEXT;
    v_order UUID;
    v_audit UUID;
    v_authorization UUID;
    v_rows INT;
BEGIN
    IF NOT ((p_from_status = 'manual_review' AND p_to_status IN ('approved', 'rejected', 'cancelled', 'expired', 'refunded'))
            OR (p_from_status = 'approved' AND p_to_status = 'refunded')) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: transição de "%" para "%" não é um fim verificado.', p_from_status, p_to_status USING ERRCODE = 'TF007';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: motivo obrigatório (mínimo 10 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' OR NOT (p_evidence ? 'authorization_audit_id') OR NOT (p_evidence ? 'operation_id') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: falta o que foi lido no Mercado Pago (autorização da conferência e operação).' USING ERRCODE = 'TF006';
    END IF;
    IF jsonb_typeof(p_evidence->'authorization_audit_id') <> 'string'
       OR (p_evidence->>'authorization_audit_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: autorização da conferência inválida.' USING ERRCODE = 'TF006';
    END IF;
    v_authorization := (p_evidence->>'authorization_audit_id')::uuid;
    IF jsonb_typeof(v_patch) <> 'object' THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: campos da cobrança inválidos.' USING ERRCODE = 'TF006';
    END IF;
    -- A ordem do Mercado Pago não entra aqui: ligar a ordem é attachOrder (o gatilho não deixa trocar). Uma
    -- aprovação pelo ID da operação pode ficar sem ordem (external_order_id NULL).
    v_allowed := CASE WHEN p_from_status = 'approved' THEN ARRAY['raw_status', 'raw_status_detail']
                      ELSE ARRAY['external_payment_id', 'raw_status', 'raw_status_detail', 'paid_amount_cents',
                                 'card_brand', 'authorization_code', 'last_four'] END;
    FOR v_field IN SELECT jsonb_object_keys(v_patch) LOOP
        IF NOT v_field = ANY (v_allowed) THEN
            RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o campo % não muda no fim verificado da cobrança.', v_field USING ERRCODE = 'TF006';
        END IF;
    END LOOP;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    SELECT * INTO v_charge FROM terminal_charges WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    IF v_charge.status <> p_from_status THEN
        RETURN v_charge; -- já resolvida (ou mudou): nada a gravar
    END IF;
    IF p_from_status = 'approved' AND EXISTS (
        SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = v_charge.idempotency_key
           AND p.status = 'APPROVED' AND p.acquirer::text = 'MERCADO_PAGO') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % já virou pagamento; o estorno segue o fluxo do pagamento.', v_charge.idempotency_key USING ERRCODE = 'TF007';
    END IF;
    -- A conferência foi pedida com PIN de gerente (tchefood_authorize_point_reconcile) para ESTA cobrança, e
    -- cada pedido vale para um fim só.
    IF NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.id = v_authorization AND a.tenant_id = p_tenant AND a.action_type = 'POINT_CHARGE_RECONCILE_AUTHORIZED'
                      AND a.authorized_by_manager_id IS NOT NULL AND a.metadata->>'idempotency_key' = v_charge.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a conferência da cobrança % não foi autorizada por gerente.', v_charge.idempotency_key USING ERRCODE = 'TF006';
    END IF;
    IF EXISTS (SELECT 1 FROM audit_logs a
                WHERE a.tenant_id = p_tenant AND a.action_type = 'POINT_CHARGE_RESOLVED'
                  AND a.metadata->'evidence'->>'authorization_audit_id' = v_authorization::text) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a autorização da conferência já foi usada; peça outra.' USING ERRCODE = 'TF007';
    END IF;
    SELECT o.id INTO v_order FROM orders o WHERE o.id = v_charge.order_id AND o.tenant_id = p_tenant;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, amount_impact, reason, metadata)
    VALUES (p_tenant, v_order, p_staff, 'POINT_CHARGE_RESOLVED', 0, trim(p_reason),
            jsonb_build_object('charge_id', v_charge.id, 'idempotency_key', v_charge.idempotency_key, 'amount_cents', v_charge.amount_cents,
                               'from', p_from_status, 'to', p_to_status, 'patch', v_patch, 'evidence', p_evidence, 'server_verified', true))
    RETURNING id INTO v_audit;
    PERFORM set_config('tchefood.point_resolution', v_audit::text, true);
    UPDATE terminal_charges
       SET status = p_to_status,
           external_payment_id = CASE WHEN v_patch ? 'external_payment_id' THEN v_patch->>'external_payment_id' ELSE external_payment_id END,
           raw_status = CASE WHEN v_patch ? 'raw_status' THEN v_patch->>'raw_status' ELSE raw_status END,
           raw_status_detail = CASE WHEN v_patch ? 'raw_status_detail' THEN v_patch->>'raw_status_detail' ELSE raw_status_detail END,
           paid_amount_cents = CASE WHEN v_patch ? 'paid_amount_cents' THEN (v_patch->>'paid_amount_cents')::BIGINT ELSE paid_amount_cents END,
           card_brand = CASE WHEN v_patch ? 'card_brand' THEN v_patch->>'card_brand' ELSE card_brand END,
           authorization_code = CASE WHEN v_patch ? 'authorization_code' THEN v_patch->>'authorization_code' ELSE authorization_code END,
           last_four = CASE WHEN v_patch ? 'last_four' THEN v_patch->>'last_four' ELSE last_four END,
           updated_at = clock_timestamp()
     WHERE id = v_charge.id AND status = p_from_status
    RETURNING * INTO v_charge;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    -- A marca vale só para esta gravação.
    PERFORM set_config('tchefood.point_resolution', '', true);
    IF v_rows <> 1 THEN
        -- Desfaz o registro junto: não fica registro de um fim que não foi gravado.
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o fim verificado não foi gravado na cobrança.' USING ERRCODE = 'TF007';
    END IF;
    RETURN v_charge;
END;
$$;

-- -----------------------------------------------------------------------------
-- Permissões
-- -----------------------------------------------------------------------------
-- Aparelho (authenticated, loja do token): ler a reserva da conta, pedir e liberar reserva de pagamento.
-- Só a service role: as somas internas e o fim verificado da cobrança da Point. Gatilhos: ninguém chama.
DO $$
DECLARE
    v_fn TEXT;
BEGIN
    FOREACH v_fn IN ARRAY ARRAY[
        'tchefood_point_charges_reserved_cents(UUID, UUID, VARCHAR)',
        'tchefood_payment_claims_reserved_cents(UUID, UUID, VARCHAR)',
        'tchefood_point_reserved_cents(UUID, UUID, VARCHAR)',
        'tchefood_point_reservation_guard()',
        'tchefood_payment_claim_guard()',
        'tchefood_terminal_charge_key_guard()',
        'tchefood_payment_claim_consume()',
        'tchefood_order_reserved_guard()',
        'tchefood_point_store(UUID)',
        'tchefood_courier_cash_payment(payments)',
        'tchefood_point_reservation(UUID)',
        'tchefood_claim_payment(VARCHAR, UUID, VARCHAR, VARCHAR, BIGINT, BIGINT, UUID, TEXT)',
        'tchefood_release_payment_claim(VARCHAR, UUID, TEXT, TEXT)',
        'tchefood_release_payment_claim_manager(VARCHAR, UUID, VARCHAR, TEXT)',
        'tchefood_touch_payment_claim(VARCHAR, UUID, TEXT)',
        'tchefood_reclaim_payment(VARCHAR, TEXT, VARCHAR, TEXT, VARCHAR, VARCHAR, BIGINT, UUID)',
        'tchefood_authorize_claim_refunded(VARCHAR, UUID, VARCHAR, TEXT, JSONB)',
        'tchefood_resolve_point_charge(UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, TEXT, JSONB)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn);
        END IF;
    END LOOP;
    FOREACH v_fn IN ARRAY ARRAY[
        'tchefood_point_reservation(UUID)',
        'tchefood_claim_payment(VARCHAR, UUID, VARCHAR, VARCHAR, BIGINT, BIGINT, UUID, TEXT)',
        'tchefood_release_payment_claim(VARCHAR, UUID, TEXT, TEXT)',
        'tchefood_release_payment_claim_manager(VARCHAR, UUID, VARCHAR, TEXT)',
        'tchefood_touch_payment_claim(VARCHAR, UUID, TEXT)',
        'tchefood_reclaim_payment(VARCHAR, TEXT, VARCHAR, TEXT, VARCHAR, VARCHAR, BIGINT, UUID)',
        'tchefood_authorize_claim_refunded(VARCHAR, UUID, VARCHAR, TEXT, JSONB)'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
        END IF;
    END LOOP;
    FOREACH v_fn IN ARRAY ARRAY[
        'tchefood_point_charges_reserved_cents(UUID, UUID, VARCHAR)',
        'tchefood_payment_claims_reserved_cents(UUID, UUID, VARCHAR)',
        'tchefood_point_reserved_cents(UUID, UUID, VARCHAR)',
        'tchefood_resolve_point_charge(UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, TEXT, JSONB)'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
        END IF;
    END LOOP;
END $$;
