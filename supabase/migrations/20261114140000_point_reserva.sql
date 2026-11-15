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
--    Auditoria r4 P0-01: só consome a reserva o pagamento APROVADO do Mercado Pago com a chave
--    da cobrança (conferido com ela por trg_payments_mercado_pago). Dinheiro, Pix ou outra
--    maquininha com a mesma chave não consome nada (e nem entra: ver o gatilho).
-- 2. Gatilho em payments (BEFORE INSERT OR UPDATE OF status, amount, order_id, tenant_id,
--    idempotency_key, acquirer): pagamento
--    aprovado só entra até o saldo da conta menos a reserva das outras cobranças da Point. A
--    conta é travada (FOR UPDATE) antes da soma: tchefood_open_terminal_charge trava a mesma
--    linha, então cobrança nova e pagamento na mesma conta não passam juntos do saldo. Cobrança
--    que termina (recusada, cancelada, expirada, estornada) deixa de reservar; nunca acontece o
--    contrário (nada volta a reservar sem passar pela trava da conta). Cobrança aprovada só deixa de
--    reservar com o pagamento APROVADO do Mercado Pago dela (conferido por trg_payments_mercado_pago) ou
--    quando ela mesma sai de "approved" pela resolução (tchefood_resolve_point_charge: estornada). Pagamento
--    PENDING, DECLINED ou REFUNDED com a chave não libera nada; o gatilho do Mercado Pago só aceita DECLINED
--    com a cobrança recusada/cancelada/expirada e REFUNDED com a cobrança estornada (auditoria r7 P0-01).
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
-- 7d. Auditoria interna 1 (concorrência F1): o reenvio do pagamento APROVADO do Mercado Pago que já foi estornado
--    (mesmo id, conta, forma, credenciadora, valor, NSU e chave) devolve o id sem gravar (tchefood_register_payment
--    redefinida aqui com essa conferência).
-- 7c. GPT r9: pagamento APROVADO só sai de aprovado pelo estorno verificado do Mercado Pago (item 7b); qualquer
--    outra mudança de status por UPDATE (DECLINED, PENDING, REFUNDED fora do Mercado Pago), de qualquer papel, é TF007.
--    Vale só para UPDATE: DELETE da linha pela service role ou pelo dono do banco continua possível (como na main;
--    o aparelho não apaga pagamento). O estorno
--    fora do Mercado Pago (Stone, PagBank, dinheiro) não tem caminho no sistema, como na main; fica decisão do Will.
-- 7b. GPT r9 P1-01: aprovada COM pagamento registrado é estornada por tchefood_refund_point_payment (só a service
--    role, PIN de gerente pela conferência e estorno provado no Mercado Pago): cobrança e pagamento juntos, com UM
--    registro POINT_PAYMENT_REFUNDED; a conta fechada continua fechada, com o saldo devolvido.
--
-- Códigos (SQLSTATE) das funções novas: TF001 conta não está no servidor, TF002 conta encerrada,
-- TF003 passa do saldo livre, TF004 operador fora da equipe ativa, TF005 não encontrada, TF006 dado
-- inválido ou motivo curto, TF007 não se aplica, TF008 saldo diferente do mostrado, TF009 chave já
-- usada por outro pagamento, TF010 pagamento sem a reserva que o cobre (claim_required), TF011 reserva ainda em
-- andamento no aparelho que a pediu (claim_active), TF012 saldo da conta abaixo do que está reservado
-- (reserved_exceeds_balance), TF013 pagamento com a chave de uma reserva já liberada (claim_released).
-- 8. Revisão independente (P1-B, P2-A, P3): na loja com Point o próprio gatilho de payments (desde a auditoria r7, em
--    toda loja: item 12)
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
-- 12. Auditoria r7 P1-01 (decisão do Will: toda loja na nuvem exige a reserva): o TF010 vale em toda loja, com ou sem
--    Point. Todo pagamento aprovado fora do Mercado Pago precisa da reserva aberta que confere com ele (mesma conta,
--    até o valor dela, mesma forma e credenciadora). Única exceção, conferida no banco: o dinheiro do entregador no
--    acerto da senha paga na entrega. tchefood_point_store, que só servia para isso, sai.
-- 13. Auditoria r7 P0-01: cobrança aprovada só deixa de reservar com o pagamento APROVADO do Mercado Pago dela ou com o
--    estorno resolvido (item 2).
-- 14. Auditoria r8 P1-01: a chave é conferida em todo status do pagamento, com a conta e depois a chave travadas (a
--    mesma ordem da abertura da cobrança). Fora do Mercado Pago: a chave de uma cobrança da Point é recusada em qualquer
--    status (TF009 key_in_use); só aprovado ou recusado entra (PENDING e REFUNDED: TF007; o aparelho não grava esses);
--    o recusado com a chave de uma reserva desta loja só entra com a reserva já liberada e da mesma conta (forma e
--    credenciadora podem ser outras: auditoria interna F1); com a reserva aberta ou consumida, ou de outra conta,
--    TF010 (auditoria interna 3 P1-01: o recusado ocuparia a chave, única em payments, e o aprovado da reserva
--    aberta nunca entraria). Chave de reserva, cobrança ou pagamento de outra loja: TF009 key_in_use, a mesma recusa
--    em todo status (auditoria interna F3). Não move dinheiro. Pagamento PENDING do Mercado Pago também não entra (TF007).
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
        -- Revisão r8 (item 3): a chave do pagamento é única no banco todo (payments.idempotency_key), então a reserva
        -- não nasce com a chave de uma reserva de OUTRA loja (nunca seria consumida: 23505), nem de uma cobrança ou de
        -- um pagamento de qualquer loja. Uma recusa só, sem dizer de quem é a chave.
        IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key)
           OR EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key)
           OR EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = NEW.idempotency_key AND pc.tenant_id <> NEW.tenant_id) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', NEW.idempotency_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
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
    -- Revisão r8 (itens 1 e 2): já existe cobrança com a chave (desta loja ou de outra): a linha nova vai cair no
    -- conflito da chave, e quem grava decide (ON CONFLICT de tchefood_open_terminal_charge e tchefood_block_point_key:
    -- devolve a desta loja, ou a recusa única da chave em uso para a de outra loja, sem dizer o que há com a chave). As conferências abaixo
    -- só valem para a chave ainda sem cobrança; a trava da chave já foi pega, na mesma ordem.
    IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key) THEN
        RETURN NEW;
    END IF;
    -- Auditoria 2 (segurança, P2-1): reserva ou pagamento de outra loja com a chave é a recusa única da chave em uso
    -- (TF009, key_in_use, a mesma de tchefood_claim_payment e do gatilho de payments); só a desta loja diz qual é.
    IF EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = NEW.idempotency_key AND pc.tenant_id <> NEW.tenant_id)
       OR EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key AND p.tenant_id <> NEW.tenant_id) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', NEW.idempotency_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
    END IF;
    IF EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = NEW.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a chave % já é de outro pagamento (dinheiro ou outra maquininha).', NEW.idempotency_key USING ERRCODE = 'TF009';
    END IF;
    -- Revisão r8 (F1): chave que já tem pagamento gravado (de qualquer forma ou status) não vira cobrança. Senão o
    -- pagamento antigo ocuparia a chave (única em payments) e o pagamento aprovado da cobrança nunca entraria.
    IF EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a chave % já é de um pagamento gravado.', NEW.idempotency_key
            USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
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
                SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = c.idempotency_key AND p.status = 'APPROVED'
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
-- Auditoria r7 P1-01: a reserva vale em toda loja, então a função que dizia se a loja tinha Point
-- (tchefood_point_store) não serve mais a ninguém e sai.
DROP FUNCTION IF EXISTS tchefood_point_store(UUID);

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
    -- GPT r9 (a verificar b): pagamento APROVADO só deixa de ser aprovado pelo estorno verificado do Mercado Pago
    -- (tchefood_refund_point_payment: REFUNDED, conferido com a marca pelo gatilho do Mercado Pago). Qualquer outra
    -- saída por UPDATE (para DECLINED, PENDING, ou REFUNDED fora do Mercado Pago), de qualquer papel, inclusive service
    -- role e dono do banco, tiraria dinheiro do pago sem registro: TF007. (DELETE não passa por aqui: continua como na main.) Estorno fora do Mercado Pago não tem caminho no
    -- sistema (como na main); fica decisão do Will.
    IF TG_OP = 'UPDATE' AND OLD.status = 'APPROVED' AND NEW.status <> 'APPROVED'
       AND NOT (NEW.status = 'REFUNDED' AND NEW.acquirer::text = 'MERCADO_PAGO' AND OLD.acquirer::text = 'MERCADO_PAGO') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: pagamento aprovado não vira "%" (só o estorno verificado do Mercado Pago tira um pagamento aprovado).', NEW.status
            USING ERRCODE = 'TF007', DETAIL = 'approved_is_final';
    END IF;
    -- Auditoria r8 P1-01: a chave é conferida em TODO status, antes de sair pelo status. Pagamento recusado,
    -- pendente ou estornado com a chave de uma cobrança da Point ocuparia a chave (única em payments) e o
    -- pagamento aprovado do Mercado Pago dela nunca entraria. Mesma ordem de travas de tchefood_open_terminal_charge
    -- e tchefood_terminal_charge_key_guard (conta, depois a chave): cobrança e pagamento com a mesma chave ao mesmo
    -- tempo esperam um pelo outro e o segundo encontra o primeiro.
    IF NEW.status <> 'APPROVED' THEN
        -- UPDATE que não muda status, forma nem credenciadora não reabre nada (chave, conta e loja não mudam:
        -- trg_payments_identity_guard).
        IF TG_OP = 'UPDATE' AND NEW.status = OLD.status AND NEW.acquirer = OLD.acquirer AND NEW.method = OLD.method THEN
            RETURN NEW;
        END IF;
        PERFORM 1 FROM orders WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id FOR UPDATE;
        PERFORM pg_advisory_xact_lock(hashtextextended('tchefood_payment_key:' || NEW.idempotency_key, 0));
        IF NEW.acquirer::text <> 'MERCADO_PAGO' THEN
            -- Auditoria interna F2: a reserva com a chave é procurada primeiro nesta loja (chave repetida entre lojas,
            -- de antes da conferência da chave em todo o banco, não pega a linha de outra loja).
            SELECT * INTO v_claim FROM payment_claims pc WHERE pc.tenant_id = NEW.tenant_id AND pc.idempotency_key = NEW.idempotency_key;
            v_claim_found := FOUND;
            -- Auditoria interna F3: chave de reserva (sem reserva desta loja com ela), cobrança ou pagamento de OUTRA
            -- loja é uma recusa só (TF009, key_in_use, a mesma mensagem), conferida aqui com a chave travada, antes de a
            -- unicidade de payments.idempotency_key responder (23505): a loja não descobre para que outra loja usa a chave.
            IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key AND c.tenant_id <> NEW.tenant_id)
               OR EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key AND p.tenant_id <> NEW.tenant_id AND p.id <> NEW.id)
               OR (NOT v_claim_found
                   AND EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = NEW.idempotency_key AND pc.tenant_id <> NEW.tenant_id)) THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', NEW.idempotency_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
            END IF;
            IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key AND c.tenant_id = NEW.tenant_id) THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é de uma cobrança da Point; só o pagamento dela no Mercado Pago usa essa chave.', NEW.idempotency_key
                    USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
            END IF;
            -- Fora do Mercado Pago o aparelho só grava aprovado ou recusado (registerPayment: APPROVED | DECLINED; o
            -- pagamento retirado no aparelho fica REFUNDED só lá e o INSERT dele sai da fila). PENDING e REFUNDED não entram.
            IF NEW.status <> 'DECLINED' THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: pagamento % fora do Mercado Pago não é gravado no servidor (só aprovado ou recusado).', NEW.status
                    USING ERRCODE = 'TF007';
            END IF;
            -- O recusado com a chave de uma reserva desta loja é o registro da recusa daquela cobrança: só entra com a
            -- reserva já liberada (a recusa libera a reserva e o registro dela sobe depois) e da mesma conta.
            -- Auditoria interna F1: forma e credenciadora podem vir diferentes da reserva (a maquininha respondeu por
            -- outra credenciadora, o retorno nativo da Stone, o simulador). Auditoria interna 3 P1-01: com a reserva
            -- ABERTA o recusado ocuparia a chave (única em payments) e o aprovado dela nunca entraria (23505), com a
            -- reserva aberta para sempre; consumida, a chave já é do pagamento dela. As duas: TF010 (o aparelho tira da
            -- fila o recusado com TF010 sem parar o resto). Recusado sem reserva nenhuma com a chave também entra (app
            -- sem nuvem antes).
            -- No UPDATE (pagamento antigo que vira recusado) a chave já é desta linha: não ocupa nada novo, vale só a conta.
            IF v_claim_found AND (v_claim.order_id <> NEW.order_id OR (TG_OP = 'INSERT' AND v_claim.status <> 'released')) THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o recusado não entra com a chave % (reserva %).', NEW.idempotency_key,
                    CASE WHEN v_claim.order_id <> NEW.order_id THEN 'de outra conta' WHEN v_claim.status = 'open' THEN 'ainda aberta'
                         ELSE 'já paga' END
                    USING ERRCODE = 'TF010';
            END IF;
        END IF;
        -- Auditoria interna (fuzzer, item 3): outro pagamento com a chave (desta loja ou de outra): TF009 key_in_use com a
        -- chave travada, antes de a unicidade de payments.idempotency_key responder 23505 (dois recusados, ou duas linhas
        -- do Mercado Pago para a mesma cobrança). Depois das recusas acima: a reserva paga com a chave continua TF010.
        IF EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key AND p.id <> NEW.id) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', NEW.idempotency_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
        END IF;
        RETURN NEW; -- o do Mercado Pago é conferido por trg_payments_mercado_pago
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
    -- Auditoria r8 P1-01: a chave trava depois da conta, como na abertura da cobrança.
    PERFORM pg_advisory_xact_lock(hashtextextended('tchefood_payment_key:' || NEW.idempotency_key, 0));
    IF NOT v_found AND TG_OP = 'UPDATE' THEN
        -- Pagamento aprovado que muda de loja (ou de conta) para uma conta que não é da loja dele: a
        -- reserva seria somada na loja errada.
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta do pagamento não é da loja dele.';
    END IF;
    -- Auditoria interna (fuzzer, item 3): outro pagamento com a chave (desta loja ou de outra): TF009 key_in_use com a
    -- chave travada, antes de a unicidade de payments.idempotency_key responder 23505 (dois recusados, ou duas linhas
    -- do Mercado Pago para a mesma cobrança).
    IF EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key AND p.id <> NEW.id) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', NEW.idempotency_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
    END IF;
    -- Auditoria interna F3 (estendida ao aprovado, decisão do coordenador): fora do Mercado Pago, chave de cobrança
    -- ou pagamento de OUTRA loja, ou de reserva de outra loja sem reserva desta loja com ela, é a mesma recusa do
    -- recusado (TF009, key_in_use, mesma mensagem), antes da cobrança desta loja e da reserva obrigatória: a loja não
    -- descobre para que outra loja usa a chave.
    IF NEW.acquirer::text <> 'MERCADO_PAGO'
       AND (EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key AND c.tenant_id <> NEW.tenant_id)
            OR EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = NEW.idempotency_key AND p.tenant_id <> NEW.tenant_id AND p.id <> NEW.id)
            OR (NOT EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = NEW.idempotency_key AND pc.tenant_id = NEW.tenant_id)
                AND EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = NEW.idempotency_key AND pc.tenant_id <> NEW.tenant_id))) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', NEW.idempotency_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
    END IF;
    -- A chave de uma cobrança da Point só serve ao pagamento do Mercado Pago dela (conferido por
    -- trg_payments_mercado_pago). Outro pagamento aprovado com essa chave tiraria a reserva da cobrança
    -- sem a cobrança ter sido paga. Vale no INSERT (inclusive tchefood_register_payment, do aparelho) e no UPDATE.
    IF NEW.acquirer::text <> 'MERCADO_PAGO'
       AND EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = NEW.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % é de uma cobrança da Point; só o pagamento dela no Mercado Pago usa essa chave.', NEW.idempotency_key
            USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
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
        -- Auditoria r7 P1-01 (decisão do Will: toda loja na nuvem exige a reserva): em qualquer loja, todo pagamento
        -- aprovado fora do Mercado Pago precisa da reserva aberta que confere com ele, sem confiar no aparelho.
        -- Única exceção, conferida no banco: o dinheiro do entregador no acerto de senha paga na entrega.
        IF NOT v_claim_ok AND NOT tchefood_courier_cash_payment(NEW) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o pagamento precisa da reserva no servidor antes de receber (chave %). Nada foi gravado: peça a reserva e receba de novo.',
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
-- Revisão r8 (F2): o pagamento gravado não muda de chave, de conta nem de loja (qualquer credenciadora). Trocar a
-- chave de um pagamento aprovado que já consumiu a reserva dele consumiria uma segunda reserva aberta; nenhum caminho
-- do app faz isso (payments não tem UPDATE para o aparelho, e as funções do banco só inserem). Roda antes dos outros
-- gatilhos BEFORE de payments (ordem alfabética: identity < mercado_pago < point_reservation).
CREATE OR REPLACE FUNCTION tchefood_payment_identity_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o pagamento gravado não muda de chave, de conta nem de loja.'
            USING ERRCODE = 'TF007', DETAIL = 'payment_identity_immutable id=' || OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_payments_identity_guard BEFORE UPDATE OF idempotency_key, order_id, tenant_id ON payments
    FOR EACH ROW EXECUTE FUNCTION tchefood_payment_identity_guard();

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
-- Auditoria interna (fuzzer, item 1): o total também não fica abaixo do que já foi pago. Desconto ou item cancelado
-- numa conta com pagamento aprovado e nada reservado deixava o pago acima do total (a conta fechava com total menor
-- que o pago, ou ficava aberta com total zero). Com algo reservado, a conferência do reservado (saldo, que não fica
-- negativo, contra o reservado) já recusa antes, com a mensagem de sempre. Para reduzir abaixo do pago, estorne antes
-- (o pagamento estornado sai do pago). Só quando o total desce: o pagamento que sobe o pago já é conferido contra o
-- saldo (tchefood_register_payment e o gatilho de payments). Item já marcado pago continua recusado antes
-- (tchefood_check_item_cancel); o desconto do cashback é limitado ao saldo. Conta sem itens com o total gravado à
-- mão (só em teste) tem o total zerado pelo recálculo no pagamento: agora esse pagamento é recusado.
CREATE OR REPLACE FUNCTION tchefood_order_reserved_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_reserved BIGINT;
    v_total BIGINT := round(NEW.total_amount * 100)::BIGINT;
    v_paid BIGINT := round(NEW.paid_amount * 100)::BIGINT;
BEGIN
    v_reserved := tchefood_point_reserved_cents(NEW.tenant_id, NEW.id, NULL);
    IF v_reserved > 0 AND round(NEW.remaining_balance * 100)::BIGINT < v_reserved THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: há R$ % reservado em cobrança desta comanda; conclua ou libere antes de reduzir o total.',
            to_char(v_reserved / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF012', DETAIL = 'reserved_exceeds_balance reserved_cents=' || v_reserved
                || ' remaining_cents=' || round(NEW.remaining_balance * 100)::BIGINT;
    END IF;
    -- O reservado já foi conferido acima (o saldo cobre o reservado); aqui, o pago.
    IF NEW.total_amount < OLD.total_amount AND v_total < v_paid THEN
        -- Auditoria interna 1: fora do Mercado Pago não há estorno no sistema; a mensagem não manda estornar.
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o total não pode ficar abaixo do já pago (R$ %); ficaria R$ %. Ajuste de outra forma ou chame o gerente.',
            to_char(v_paid / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00')
            USING ERRCODE = 'TF012', DETAIL = 'total_below_paid paid_cents=' || v_paid || ' total_cents=' || v_total;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_orders_reserved_guard BEFORE UPDATE OF remaining_balance, total_amount ON orders
    FOR EACH ROW WHEN (NEW.remaining_balance < OLD.remaining_balance OR NEW.total_amount < OLD.total_amount)
    EXECUTE FUNCTION tchefood_order_reserved_guard();

-- Auditoria interna (fuzzer, item 2): item mudado (PATCH order_items: trava o item, depois a conta no recálculo) e o
-- pagamento que quita a conta (trava a conta, depois os itens para marcar is_paid) esperavam um pelo outro (40P01).
-- O fechamento marca só os itens livres (FOR NO KEY UPDATE SKIP LOCKED: a trava de chave das FKs não atrapalha) e o
-- item que estava travado é marcado pela própria transação que o mudou, depois do recálculo (com a conta travada),
-- se a conta ficou fechada. A gravação de is_paid passa pelo recálculo de novo, que não muda nada.
CREATE OR REPLACE FUNCTION tchefood_auto_close()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.remaining_balance = 0 AND NEW.total_amount > 0 AND NEW.status IN ('OPEN', 'PAYING')
       AND NEW.paid_amount >= NEW.total_amount THEN
        UPDATE orders SET status = 'CLOSED', closed_at = NOW() WHERE id = NEW.id;
        UPDATE order_items SET is_paid = TRUE
         WHERE id IN (SELECT i.id FROM order_items i
                       WHERE i.order_id = NEW.id AND i.status <> 'CANCELED' AND NOT i.is_paid
                       FOR NO KEY UPDATE SKIP LOCKED);
        UPDATE dining_tables SET status = 'FREE', current_order_id = NULL, updated_at = NOW()
         WHERE id = NEW.table_id AND current_order_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_after_item_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM tchefood_recalc_order(COALESCE(NEW.order_id, OLD.order_id));
    -- O item que o fechamento pulou (estava travado por esta transação): marcado aqui, só no UPDATE de item que já
    -- existia (item novo numa conta fechada não vira pago).
    -- (IFs aninhados: o mesmo gatilho roda em payments, onde NEW não tem is_paid e status é outro tipo.)
    IF TG_TABLE_NAME = 'order_items' AND TG_OP = 'UPDATE' THEN
        UPDATE order_items i SET is_paid = TRUE
         WHERE i.id = NEW.id AND NOT i.is_paid AND i.status <> 'CANCELED'
           AND EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id AND o.status = 'CLOSED');
    END IF;
    RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Leitura do aparelho: só a conta da própria loja (tenant do token)
-- -----------------------------------------------------------------------------
-- reserved_cents = point_cents + claims_cents (a reserva única). claims: as reservas de pagamento abertas da
-- conta (quem pediu, quando, forma e credenciadora; active_until = até quando o aparelho que pediu está cobrando,
-- releasable_at = a partir de quando o gerente pode liberá-la). charges: as cobranças da Point da conta
-- que reservam, para o aparelho que não as criou mostrar e mandar conferir no Mercado Pago. created_at: hora gravada
-- da cobrança (relógio do banco). stale (auditoria interna 3 P1-02): a cobrança tem mais de
-- tchefood_point_charge_timeout() (o prazo de espera do cartão de point-charge, SERVER_TIMEOUT_MS) pelo relógio do
-- banco; só a idade, em qualquer estado da lista (quem mostra decide; o aparelho que não criou a cobrança só oferece
-- "Resolver" para a aberta antiga). Aprovada sem pagamento (auditoria 2): stale só depois de
-- tchefood_claim_abandon_after() (5 min) contados da aprovação (updated_at, gravado por point-charge ao aprovar), não
-- da criação: o aparelho que cobrou pode estar sem rede com o pagamento na fila. has_payment:
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
               'created_at', c.created_at,
               -- Auditoria 2 (aprovada sem pagamento): a aprovada conta da hora da aprovação (updated_at; nada mais muda a
               -- aprovada antes do pagamento ou do fim verificado) mais tchefood_claim_abandon_after(), o mesmo prazo do
               -- aparelho sumido das reservas: o pagamento pode estar na fila do aparelho que cobrou, sem rede. A aberta
               -- segue com o prazo de espera do cartão.
               'stale', CASE WHEN c.status = 'approved'
                             THEN clock_timestamp() >= c.updated_at + tchefood_claim_abandon_after()
                             ELSE clock_timestamp() >= c.created_at + tchefood_point_charge_timeout() END,
               -- Revisão r8 (F1): a mesma regra da soma e de point-charge (hasRegisteredPayment): só o APROVADO do Mercado Pago.
               'has_payment', EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = c.idempotency_key
                                         AND p.status = 'APPROVED' AND p.acquirer::text = 'MERCADO_PAGO'))
             ORDER BY c.created_at, c.idempotency_key), '[]'::jsonb)
      INTO v_charges
      FROM terminal_charges c
     WHERE c.tenant_id = v_tenant AND c.order_id = p_order
       AND (c.status IN ('creating', 'pending', 'at_terminal', 'manual_review')
            OR (c.status = 'approved' AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.tenant_id = v_tenant AND p.idempotency_key = c.idempotency_key AND p.status = 'APPROVED'
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
-- Ordem das conferências: dados inválidos (TF006); reenvio exato (auditoria interna P3-6: reserva desta loja com
-- a mesma chave, conta, valor, forma, credenciadora e o MESMO segredo) devolve a reserva gravada antes de conferir
-- o operador: o segredo prova que é o mesmo pedido do mesmo aparelho, e o operador desativado entre a primeira
-- tentativa e o reenvio não faz o aparelho largar o segredo de uma reserva viva; operador fora da equipe ativa
-- (TF004); chave que já é reserva desta loja: devolve a mesma, sem reconferir saldo, se conta, valor, forma e
-- credenciadora forem iguais (senão TF009); chave de cobrança da Point ou de pagamento já gravado (TF009); conta travada:
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
    -- Auditoria interna P3-6: reenvio exato (mesmos termos e mesmo segredo) devolve a reserva antes de conferir o
    -- operador. Leitura só: os termos e o segredo de uma reserva não mudam (gatilho de payment_claims). Qualquer
    -- outra coisa segue a ordem de sempre (operador primeiro).
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF FOUND AND v_claim.order_id = p_order AND v_claim.amount_cents = p_amount_cents AND v_claim.method = p_method
       AND v_claim.acquirer = p_acquirer AND v_claim.release_token_hash = v_hash THEN
        RETURN jsonb_build_object('id', v_claim.id, 'idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'amount_cents', v_claim.amount_cents);
    END IF;
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
    -- Revisão r8 (item 3): chave de cobrança, de pagamento ou de reserva de outra loja: uma recusa só, sem dizer de
    -- quem é (o gatilho de payment_claims confere de novo com a chave travada).
    IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = p_key)
       OR EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = p_key)
       OR EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = p_key AND pc.tenant_id <> v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', p_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
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
-- liberada por esta troca e a nova gravada com os mesmos dados e o mesmo segredo = devolve a mesma troca. Esse
-- reenvio exato (com os dois segredos certos) é conferido antes do operador (auditoria interna P3-6, como em
-- tchefood_claim_payment); o resto confere o operador primeiro (TF004).
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
    -- Auditoria interna P3-6: reenvio exato da troca (os dois segredos certos, a nova com os mesmos termos e a
    -- antiga liberada por esta troca) devolve o que foi gravado antes de conferir o operador. Leitura só: liberada é
    -- final e termos e segredos não mudam.
    SELECT * INTO v_old FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_old_key;
    IF FOUND AND v_old.status = 'released' AND v_old.release_token_hash IS NOT NULL AND p_old_token IS NOT NULL
       AND sha256(convert_to(p_old_token, 'UTF8')) = v_old.release_token_hash THEN
        SELECT * INTO v_new FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_new_key;
        IF FOUND AND v_new.order_id = v_old.order_id AND v_new.method = p_method AND v_new.acquirer = p_acquirer
           AND v_new.amount_cents = p_amount_cents AND v_new.release_token_hash = v_hash
           AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.id = v_old.release_audit_id AND a.metadata->>'released_via' = 'reclaim'
                          AND a.metadata->>'new_idempotency_key' = p_new_key) THEN
            RETURN jsonb_build_object(
                'old', jsonb_build_object('id', v_old.id, 'idempotency_key', v_old.idempotency_key, 'status', v_old.status, 'release_audit_id', v_old.release_audit_id),
                'new', jsonb_build_object('id', v_new.id, 'idempotency_key', v_new.idempotency_key, 'status', v_new.status, 'amount_cents', v_new.amount_cents));
        END IF;
    END IF;
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
    -- Revisão r8 (item 3): a mesma conferência de tchefood_claim_payment para a chave nova.
    IF EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = p_new_key)
       OR EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = p_new_key)
       OR EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.idempotency_key = p_new_key AND pc.tenant_id <> v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a chave % já está em uso (outra reserva, cobrança ou pagamento).', p_new_key USING ERRCODE = 'TF009', DETAIL = 'key_in_use';
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
-- (precisa ser da equipe ativa); não prova nada sobre a reserva. Auditoria interna P3-6: operador desta loja que foi
-- desativado ainda libera com o segredo certo (o segredo prova que é o aparelho que pediu a reserva; sem isso o
-- valor fica preso até o gerente liberar com PIN), e o registro leva operator_inactive = true. Operador desativado
-- sem a reserva ou com o segredo errado: TF004, como antes. Renovar o prazo (tchefood_touch_payment_claim) continua
-- pedindo operador ativo: a reserva expira e o gerente a libera. Já liberada (com o segredo certo): devolve como
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
    v_inactive BOOLEAN;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(trim(p_reason)) > 500 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: motivo obrigatório (de 3 a 500 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    v_inactive := NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active);
    SELECT * INTO v_claim FROM payment_claims WHERE tenant_id = v_tenant AND idempotency_key = p_key;
    IF NOT FOUND THEN
        IF v_inactive THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
        END IF;
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: reserva de pagamento não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    -- Auditoria r6 (falsificação): sem PIN, só quem tem o segredo da reserva libera. Comparação dos sha256 (o tempo
    -- não depende de quantas letras do segredo batem).
    IF v_claim.release_token_hash IS NULL OR p_release_token IS NULL
       OR sha256(convert_to(p_release_token, 'UTF8')) <> v_claim.release_token_hash THEN
        IF v_inactive THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
        END IF;
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
                               'by_manager', false, 'server_verified', true)
            || CASE WHEN v_inactive THEN jsonb_build_object('operator_inactive', true) ELSE '{}'::jsonb END)
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
-- de outro aparelho deixaria o gerente sem poder liberá-la. p_staff precisa ser da equipe ativa (TF004; auditoria
-- interna P3-6: operador desativado não renova, mesmo com o segredo; a liberação com o segredo continua). Reserva de
-- outra loja ou que não existe: TF005. Aberta: estende active_until para agora + tchefood_claim_lease() (relógio do
-- banco, nunca para trás). Liberada ou consumida: devolve o estado sem mudar nada (só para quem tem o segredo).
-- Trava a conta antes da reserva, na ordem da liberação e do gatilho de payments. Devolve {idempotency_key, status,
-- active_until} (revisão r8: a chave volta junto para o aparelho conferir que a resposta é da reserva que ele renovou).
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
    RETURN jsonb_build_object('idempotency_key', v_claim.idempotency_key, 'status', v_claim.status, 'active_until', v_claim.active_until);
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
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 OR length(trim(p_reason)) > 500 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: motivo obrigatório (de 10 a 500 caracteres).' USING ERRCODE = 'TF006';
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
-- antes do PIN: não gasta tentativa; DETAIL 'claim_open' para aberta e 'claim_consumed' para paga, auditoria interna P3-7); bloqueio de 3 erros em 60 s pelo relógio de agora (MANAGER_PIN_LOCKOUT, NULL);
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
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 OR length(trim(p_reason)) > 500 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: motivo obrigatório (de 10 a 500 caracteres).' USING ERRCODE = 'TF006';
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
            CASE v_claim.status WHEN 'open' THEN 'aberta' ELSE 'paga' END
            USING ERRCODE = 'TF007', DETAIL = CASE v_claim.status WHEN 'open' THEN 'claim_open' ELSE 'claim_consumed' END;
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
-- p_evidence (objeto) sempre traz authorization_audit_id e operation_id; no estorno da aprovada (auditoria interna 1)
-- também mp_status (ou payment_status) = 'refunded' e mp_amount_refunded_cents (número) = valor da cobrança (TF006 se não). authorization_audit_id é o registro
-- POINT_CHARGE_RECONCILE_AUTHORIZED desta loja e desta cobrança (tchefood_authorize_point_reconcile, PIN de
-- gerente), conferido aqui e aceito para um fim só (TF006 se não confere, TF007 se já foi usado).
-- Travas na ordem do pagamento (auditoria interna F4): a conta da cobrança (FOR UPDATE), depois a cobrança
-- (FOR UPDATE). tchefood_register_payment trava a conta e o gatilho do Mercado Pago lê a cobrança com FOR SHARE;
-- na ordem inversa (cobrança e depois o registro em audit_logs, que pede FOR KEY SHARE na conta) os dois
-- esperavam um pelo outro (40P01). Estorno e pagamento juntos continuam esperando um pelo outro.
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
    -- Auditoria interna 1: motivo de 10 a 500 caracteres (texto livre gravado em audit_logs).
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 OR length(trim(p_reason)) > 500 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: motivo obrigatório (de 10 a 500 caracteres).' USING ERRCODE = 'TF006';
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
    -- Conta antes da cobrança (a conta da cobrança não muda: gatilho de terminal_charges).
    SELECT c.order_id INTO v_order FROM terminal_charges c WHERE c.id = p_id AND c.tenant_id = p_tenant;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    PERFORM 1 FROM orders o WHERE o.id = v_order AND o.tenant_id = p_tenant FOR UPDATE;
    SELECT * INTO v_charge FROM terminal_charges WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
    IF v_charge.status <> p_from_status THEN
        RETURN v_charge; -- já resolvida (ou mudou): nada a gravar
    END IF;
    IF p_from_status = 'approved' AND EXISTS (
        SELECT 1 FROM payments p WHERE p.tenant_id = p_tenant AND p.idempotency_key = v_charge.idempotency_key
           AND p.status = 'APPROVED' AND p.acquirer::text = 'MERCADO_PAGO') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % já virou pagamento; o estorno segue o fluxo do pagamento (tchefood_refund_point_payment).', v_charge.idempotency_key USING ERRCODE = 'TF007';
    END IF;
    -- A conferência foi pedida com PIN de gerente (tchefood_authorize_point_reconcile) para ESTA cobrança, e
    -- cada pedido vale para um fim só.
    IF NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.id = v_authorization AND a.tenant_id = p_tenant AND a.action_type = 'POINT_CHARGE_RECONCILE_AUTHORIZED'
                      AND a.authorized_by_manager_id IS NOT NULL AND a.metadata->>'idempotency_key' = v_charge.idempotency_key) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a conferência da cobrança % não foi autorizada por gerente.', v_charge.idempotency_key USING ERRCODE = 'TF006';
    END IF;
    IF EXISTS (SELECT 1 FROM audit_logs a
                WHERE a.tenant_id = p_tenant AND a.action_type IN ('POINT_CHARGE_RESOLVED', 'POINT_PAYMENT_REFUNDED')
                  AND a.metadata->'evidence'->>'authorization_audit_id' = v_authorization::text) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a autorização da conferência já foi usada; peça outra.' USING ERRCODE = 'TF007';
    END IF;
    -- Auditoria interna 1: a autorização é recente (relógio do banco).
    IF NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.id = v_authorization AND a.created_at >= clock_timestamp() - tchefood_point_authorization_ttl()) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a autorização da conferência da cobrança % venceu; peça outra.', v_charge.idempotency_key
            USING ERRCODE = 'TF006', DETAIL = 'authorization_expired';
    END IF;
    -- Auditoria interna 1: aprovada que vira estornada só com o estorno total lido no Mercado Pago: mp_status
    -- 'refunded' e mp_amount_refunded_cents (transaction_amount_refunded) igual ao valor. 'cancelled' só existe antes
    -- da aprovação (numa cobrança aprovada é contradição); estorno parcial não tem caminho. TF006.
    -- O status lido vem em mp_status ou, na evidência da conferência (orderEvidence/paymentEvidence da Edge Function),
    -- em payment_status; vale o primeiro presente.
    IF p_from_status = 'approved' AND (
           COALESCE(p_evidence->'mp_status', p_evidence->'payment_status') IS NULL
        OR jsonb_typeof(COALESCE(p_evidence->'mp_status', p_evidence->'payment_status')) <> 'string'
        OR COALESCE(p_evidence->>'mp_status', p_evidence->>'payment_status') <> 'refunded'
        OR jsonb_typeof(p_evidence->'mp_amount_refunded_cents') IS DISTINCT FROM 'number'
        OR (p_evidence->>'mp_amount_refunded_cents')::NUMERIC <> v_charge.amount_cents) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o Mercado Pago não mostra o estorno total da cobrança % (status refunded e valor estornado igual ao valor).', v_charge.idempotency_key
            USING ERRCODE = 'TF006';
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
-- 7b. Estorno verificado do pagamento da Point já registrado (GPT r9 P1-01)
-- -----------------------------------------------------------------------------
-- Antes: o pagamento do Mercado Pago só virava REFUNDED com a cobrança já estornada, e a cobrança aprovada só
-- virava estornada sem pagamento APROVADO com a chave. Pagamento registrado nunca chegava a estornado.
-- tchefood_refund_point_payment (só a service role; a Edge Function chama depois de provar o estorno no Mercado
-- Pago: mesmo pagamento, valor e referência, status refunded ou cancelled, chargeback nunca), numa transação:
--   * trava do PIN da loja, depois a conta da cobrança (FOR UPDATE), depois a cobrança (FOR UPDATE), depois o
--     pagamento: a ordem de tchefood_authorize_point_reconcile, do fim verificado e do registro do pagamento;
--   * cobrança "refunded" (já estornada, por esta ou outra chamada): devolve a linha como está, nada gravado;
--     outro estado que não "approved": TF007;
--   * exige o pagamento APROVADO do Mercado Pago com a chave nesta loja (sem ele: TF007, o fim verificado,
--     tchefood_resolve_point_charge, é que estorna a cobrança sem pagamento);
--   * p_evidence (objeto): authorization_audit_id (registro POINT_CHARGE_RECONCILE_AUTHORIZED desta cobrança, com
--     gerente, de tchefood_authorize_point_reconcile, aceito para um fim só: o mesmo id não serve a um
--     POINT_CHARGE_RESOLVED nem a outro estorno, TF007), operation_id, e o que foi lido no Mercado Pago:
--     mp_payment_id (= external_payment_id da cobrança e nsu do pagamento), mp_amount_cents (= valor da cobrança),
--     mp_amount_refunded_cents (transaction_amount_refunded do Mercado Pago, = valor da cobrança: só estorno total),
--     mp_external_reference (= chave), mp_status ('refunded'; auditoria interna 1: 'cancelled' só existe antes da
--     aprovação). Não confere: TF006. A autorização tem até tchefood_point_authorization_ttl() (10 min, relógio do
--     banco) e foi pedida com a cobrança já aprovada (TF006, DETAIL authorization_expired). Motivo de 10 a 500;
--   * p_patch: só raw_status e raw_status_detail (o comprovante fica);
--   * grava UM registro POINT_PAYMENT_REFUNDED (só o servidor grava: tchefood_guard_point_audit), liga só nesta
--     transação tchefood.point_resolution com o id dele (os gatilhos da cobrança e do pagamento conferem o
--     registro: UPDATE isolado ou forjado continua recusado), grava a cobrança "refunded" e o pagamento
--     REFUNDED. O recálculo da conta (gatilho de payments) tira o valor do pago.
-- Conta aberta: o saldo volta e ela segue aberta. GPT r10 P1-01 (decisão: o estorno total reabre a conta fechada):
-- conta FECHADA volta a PAYING (closed_at NULL), com o saldo devolvido em remaining_balance; o mesmo registro
-- POINT_PAYMENT_REFUNDED guarda order_reopened = true e previous_closed_at, e é ele (marca tchefood.point_resolution) que
-- deixa o gatilho de fechamento (tchefood_order_close_guard, abaixo) aceitar a reabertura. A mesa não muda: a conta
-- reaberta é cobrada pela lista de contas (a mesa já está livre ou com outra conta). Depois, o caixa cobra de novo
-- (reserva e pagamento de sempre) ou o gerente encerra como venda devolvida (tchefood_close_refunded_order).
-- Conta cancelada não muda (não há pagamento aprovado em conta cancelada pelos caminhos do sistema).
CREATE OR REPLACE FUNCTION tchefood_refund_point_payment(
    p_tenant UUID, p_id UUID, p_staff UUID, p_reason TEXT, p_patch JSONB, p_evidence JSONB)
RETURNS terminal_charges
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_charge terminal_charges%ROWTYPE;
    v_payment payments%ROWTYPE;
    v_patch JSONB := COALESCE(p_patch, '{}'::jsonb);
    v_field TEXT;
    v_order UUID;
    v_audit UUID;
    v_authorization UUID;
    v_manager UUID;
    v_rows INT;
    v_order_status VARCHAR;
    v_closed_at TIMESTAMPTZ;
BEGIN
    -- Auditoria interna 1: motivo de 10 a 500 caracteres (texto livre gravado em audit_logs).
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 OR length(trim(p_reason)) > 500 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: motivo obrigatório (de 10 a 500 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object'
       OR NOT (p_evidence ?& ARRAY['authorization_audit_id', 'operation_id', 'mp_payment_id', 'mp_amount_cents', 'mp_amount_refunded_cents',
                                   'mp_external_reference', 'mp_status']) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: falta o que foi lido no Mercado Pago (autorização, operação, pagamento, valor, valor estornado, referência e status).' USING ERRCODE = 'TF006';
    END IF;
    IF jsonb_typeof(p_evidence->'authorization_audit_id') <> 'string'
       OR (p_evidence->>'authorization_audit_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: autorização da conferência inválida.' USING ERRCODE = 'TF006';
    END IF;
    v_authorization := (p_evidence->>'authorization_audit_id')::uuid;
    IF jsonb_typeof(p_evidence->'mp_payment_id') <> 'string' OR jsonb_typeof(p_evidence->'mp_external_reference') <> 'string'
       OR jsonb_typeof(p_evidence->'mp_amount_cents') <> 'number' OR jsonb_typeof(p_evidence->'mp_amount_refunded_cents') <> 'number'
       OR jsonb_typeof(p_evidence->'mp_status') <> 'string' OR (p_evidence->>'mp_status') <> 'refunded' THEN
        -- Auditoria interna 1: só "refunded" prova o estorno do pagamento registrado ("cancelled" só acontece antes da
        -- aprovação; num pagamento aprovado é contradição). Chargeback (charged_back) e qualquer outro status também não.
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o Mercado Pago não mostra o pagamento estornado.' USING ERRCODE = 'TF006';
    END IF;
    IF jsonb_typeof(v_patch) <> 'object' THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: campos da cobrança inválidos.' USING ERRCODE = 'TF006';
    END IF;
    FOR v_field IN SELECT jsonb_object_keys(v_patch) LOOP
        IF NOT v_field = ANY (ARRAY['raw_status', 'raw_status_detail']) THEN
            RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o campo % não muda no estorno da cobrança.', v_field USING ERRCODE = 'TF006';
        END IF;
    END LOOP;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = p_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    -- Travas: PIN da loja, conta, cobrança, pagamento (a conta da cobrança não muda: gatilho de terminal_charges).
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || p_tenant::text));
    SELECT c.order_id INTO v_order FROM terminal_charges c WHERE c.id = p_id AND c.tenant_id = p_tenant;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    SELECT o.status, o.closed_at INTO v_order_status, v_closed_at FROM orders o WHERE o.id = v_order AND o.tenant_id = p_tenant FOR UPDATE;
    SELECT * INTO v_charge FROM terminal_charges WHERE id = p_id AND tenant_id = p_tenant FOR UPDATE;
    IF v_charge.status = 'refunded' THEN
        RETURN v_charge; -- já estornada: a repetição devolve a mesma linha e não grava nada
    END IF;
    IF v_charge.status <> 'approved' THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança está "%"; só a aprovada é estornada.', v_charge.status USING ERRCODE = 'TF007';
    END IF;
    SELECT * INTO v_payment FROM payments p
     WHERE p.tenant_id = p_tenant AND p.idempotency_key = v_charge.idempotency_key AND p.acquirer::text = 'MERCADO_PAGO' AND p.status = 'APPROVED'
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a cobrança % não tem pagamento registrado; o estorno dela é pelo fim verificado.', v_charge.idempotency_key
            USING ERRCODE = 'TF007';
    END IF;
    SELECT a.authorized_by_manager_id INTO v_manager FROM audit_logs a
     WHERE a.id = v_authorization AND a.tenant_id = p_tenant AND a.action_type = 'POINT_CHARGE_RECONCILE_AUTHORIZED'
       AND a.authorized_by_manager_id IS NOT NULL AND a.metadata->>'idempotency_key' = v_charge.idempotency_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o estorno da cobrança % não foi autorizado por gerente.', v_charge.idempotency_key USING ERRCODE = 'TF006';
    END IF;
    IF EXISTS (SELECT 1 FROM audit_logs a
                WHERE a.tenant_id = p_tenant AND a.action_type IN ('POINT_CHARGE_RESOLVED', 'POINT_PAYMENT_REFUNDED')
                  AND a.metadata->'evidence'->>'authorization_audit_id' = v_authorization::text) THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a autorização da conferência já foi usada; peça outra.' USING ERRCODE = 'TF007';
    END IF;
    -- Auditoria interna 1: a autorização é recente (relógio do banco) e foi pedida com a cobrança já aprovada.
    IF NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.id = v_authorization
                      AND a.created_at >= clock_timestamp() - tchefood_point_authorization_ttl()
                      AND a.metadata->>'charge_status' = 'approved') THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: a autorização do estorno da cobrança % venceu ou é de antes da aprovação; peça outra.', v_charge.idempotency_key
            USING ERRCODE = 'TF006', DETAIL = 'authorization_expired';
    END IF;
    IF (p_evidence->>'mp_payment_id') IS DISTINCT FROM v_charge.external_payment_id
       OR v_payment.nsu IS DISTINCT FROM v_charge.external_payment_id
       OR (p_evidence->>'mp_external_reference') <> v_charge.idempotency_key
       OR (p_evidence->>'mp_amount_cents')::NUMERIC <> v_charge.amount_cents
       -- Auditoria interna 1: estorno total (transaction_amount_refunded do Mercado Pago = valor). O parcial (o
       -- Mercado Pago mantém approved, partially_refunded) não tem caminho no sistema.
       OR (p_evidence->>'mp_amount_refunded_cents')::NUMERIC <> v_charge.amount_cents
       OR round(v_payment.amount * 100) <> v_charge.amount_cents THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o estorno lido no Mercado Pago não confere com a cobrança % (pagamento, valor ou referência).', v_charge.idempotency_key
            USING ERRCODE = 'TF006';
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (p_tenant, v_order, p_staff, v_manager, 'POINT_PAYMENT_REFUNDED', 0, trim(p_reason),
            jsonb_build_object('charge_id', v_charge.id, 'payment_id', v_payment.id, 'idempotency_key', v_charge.idempotency_key,
                               'amount_cents', v_charge.amount_cents, 'from', 'approved', 'to', 'refunded', 'patch', v_patch,
                               'evidence', p_evidence, 'server_verified', true,
                               'order_reopened', v_order_status = 'CLOSED', 'previous_closed_at', v_closed_at))
    RETURNING id INTO v_audit;
    PERFORM set_config('tchefood.point_resolution', v_audit::text, true);
    UPDATE terminal_charges
       SET status = 'refunded',
           raw_status = CASE WHEN v_patch ? 'raw_status' THEN v_patch->>'raw_status' ELSE raw_status END,
           raw_status_detail = CASE WHEN v_patch ? 'raw_status_detail' THEN v_patch->>'raw_status_detail' ELSE raw_status_detail END,
           updated_at = clock_timestamp()
     WHERE id = v_charge.id AND status = 'approved'
    RETURNING * INTO v_charge;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 1 THEN
        UPDATE payments SET status = 'REFUNDED' WHERE id = v_payment.id AND status = 'APPROVED';
        GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;
    -- GPT r10 P1-01: a conta fechada reabre (o recálculo do gatilho de payments já devolveu o saldo).
    IF v_rows = 1 AND v_order_status = 'CLOSED' THEN
        UPDATE orders SET status = 'PAYING', closed_at = NULL WHERE id = v_order AND tenant_id = p_tenant AND status = 'CLOSED';
        GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;
    -- A marca vale só para estas gravações.
    PERFORM set_config('tchefood.point_resolution', '', true);
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'TCHEFOOD_COBRANCA: o estorno não foi gravado na cobrança e no pagamento.' USING ERRCODE = 'TF007';
    END IF;
    RETURN v_charge;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7d. Reenvio do pagamento já estornado (auditoria interna 1, revisão de concorrência F1)
-- -----------------------------------------------------------------------------
-- O pagamento APROVADO do Mercado Pago pode virar REFUNDED (tchefood_refund_point_payment). O aparelho que perdeu
-- a resposta do INSERT e reenvia o mesmo pagamento (mesmo id, APROVADO) depois do estorno recebia "já existe outro
-- pagamento com este id" para sempre. Esse caso exato é reenvio: a linha gravada está REFUNDED com o registro
-- POINT_PAYMENT_REFUNDED dela, e o reenvio traz o mesmo id, conta, forma, credenciadora, valor, NSU, chave e
-- maquininha (terminal_id e terminal_serial, GPT r10): devolve o id sem gravar nada. Fora disso, as regras de sempre
-- de db/schema_dinheiro_servidor.sql (mesma loja, conta, valor e status) e, no reenvio com o mesmo status (GPT r10,
-- a verificar 5), também a mesma chave, forma, credenciadora, NSU, autorização e maquininha (senão TF006
-- replay_mismatch; na main esses campos não eram comparados). tchefood_register_payment é a de lá, só com essa
-- conferência trocada.
CREATE OR REPLACE FUNCTION tchefood_payment_replay_ok(p_existing payments, p_incoming payments, p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF p_existing.tenant_id <> p_tenant OR p_existing.order_id <> p_incoming.order_id OR p_existing.amount <> p_incoming.amount THEN
        RETURN FALSE;
    END IF;
    IF p_existing.status = p_incoming.status THEN
        -- GPT r10 (a verificar 5): o mesmo id com outro pagamento (outra chave, forma, credenciadora, NSU, autorização
        -- ou maquininha) não é reenvio: recusa (TF006, replay_mismatch), para o aparelho não achar que o pagamento
        -- diferente dele foi gravado. Vazio, só espaço e NULL são o mesmo (o aparelho manda null).
        IF NULLIF(btrim(p_incoming.idempotency_key), '') IS DISTINCT FROM NULLIF(btrim(p_existing.idempotency_key), '')
           OR p_incoming.method IS DISTINCT FROM p_existing.method
           OR p_incoming.acquirer IS DISTINCT FROM p_existing.acquirer
           OR NULLIF(btrim(p_incoming.nsu), '') IS DISTINCT FROM NULLIF(btrim(p_existing.nsu), '')
           OR NULLIF(btrim(p_incoming.authorization_code), '') IS DISTINCT FROM NULLIF(btrim(p_existing.authorization_code), '')
           OR p_incoming.terminal_id IS DISTINCT FROM p_existing.terminal_id
           OR NULLIF(btrim(p_incoming.terminal_serial), '') IS DISTINCT FROM NULLIF(btrim(p_existing.terminal_serial), '') THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: já existe outro pagamento com este id (chave, forma, credenciadora, NSU, autorização ou maquininha diferente).'
                USING ERRCODE = 'TF006', DETAIL = 'replay_mismatch';
        END IF;
        RETURN TRUE;
    END IF;
    RETURN p_existing.status = 'REFUNDED' AND p_incoming.status = 'APPROVED'
       AND p_existing.acquirer::text = 'MERCADO_PAGO' AND p_incoming.acquirer IS NOT DISTINCT FROM p_existing.acquirer
       AND p_incoming.method IS NOT DISTINCT FROM p_existing.method
       AND p_incoming.nsu IS NOT DISTINCT FROM p_existing.nsu
       AND p_incoming.idempotency_key IS NOT DISTINCT FROM p_existing.idempotency_key
       -- GPT r10 (a verificar 5): a mesma maquininha também.
       AND p_incoming.terminal_id IS NOT DISTINCT FROM p_existing.terminal_id
       AND p_incoming.terminal_serial IS NOT DISTINCT FROM p_existing.terminal_serial
       AND EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.tenant_id = p_tenant AND a.action_type = 'POINT_PAYMENT_REFUNDED'
                      AND a.metadata->>'payment_id' = p_existing.id::text);
END;
$$;

CREATE OR REPLACE FUNCTION tchefood_register_payment(p_payment JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_pay payments%ROWTYPE;
    v_existing payments%ROWTYPE;
    v_order orders%ROWTYPE;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    v_pay := jsonb_populate_record(NULL::payments, p_payment);
    IF v_pay.id IS NULL OR v_pay.order_id IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: pagamento sem id ou sem conta.';
    END IF;
    IF v_pay.tenant_id IS DISTINCT FROM v_tenant THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: pagamento de outra loja.';
    END IF;

    -- Reenvio da fila: o mesmo pagamento já está gravado.
    SELECT * INTO v_existing FROM payments WHERE id = v_pay.id;
    IF FOUND THEN
        IF NOT tchefood_payment_replay_ok(v_existing, v_pay, v_tenant) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: já existe outro pagamento com este id.';
        END IF;
        RETURN v_existing.id;
    END IF;

    -- A conta trava aqui: dois pagamentos da mesma conta não passam juntos do saldo.
    SELECT * INTO v_order FROM orders WHERE id = v_pay.order_id AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: conta não encontrada nesta loja.';
    END IF;
    -- Dois envios do mesmo pagamento ao mesmo tempo: o segundo espera a conta e, ao entrar, o primeiro
    -- já gravou. Confere de novo para devolver o gravado em vez de recusar um reenvio legítimo.
    SELECT * INTO v_existing FROM payments WHERE id = v_pay.id;
    IF FOUND THEN
        IF NOT tchefood_payment_replay_ok(v_existing, v_pay, v_tenant) THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: já existe outro pagamento com este id.';
        END IF;
        RETURN v_existing.id;
    END IF;
    IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta já está %.', CASE v_order.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = v_pay.waiter_id AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: quem recebeu não é da equipe ativa da loja.';
    END IF;
    IF v_pay.terminal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pos_terminals t WHERE t.id = v_pay.terminal_id AND t.tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: maquininha não é desta loja.';
    END IF;
    IF v_pay.amount IS NULL OR v_pay.amount <= 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: valor do pagamento deve ser maior que zero.';
    END IF;
    IF COALESCE(v_pay.tip_amount, 0) < 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: gorjeta negativa.';
    END IF;

    IF v_pay.status = 'APPROVED' THEN
        IF v_pay.amount > v_order.remaining_balance THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: R$ % passa do saldo da conta no servidor (R$ %).', v_pay.amount, v_order.remaining_balance;
        END IF;
        IF v_pay.method = 'CASH' THEN
            IF v_pay.acquirer <> 'CASH_DESK' THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: dinheiro é registrado no caixa (CASH_DESK).';
            END IF;
        ELSE
            IF v_pay.acquirer = 'CASH_DESK' THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: % aprovado precisa da credenciadora da maquininha.', v_pay.method;
            END IF;
            IF v_pay.nsu IS NULL OR length(trim(v_pay.nsu)) = 0 THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: % aprovado sem o NSU do comprovante.', v_pay.method;
            END IF;
            -- Dois aparelhos com o mesmo comprovante em contas diferentes: o travamento da conta
            -- (acima) não os serializa, então o comprovante também trava a transação.
            PERFORM pg_advisory_xact_lock(hashtextextended(
                v_tenant::text || '|' || v_pay.acquirer || '|' || COALESCE(v_pay.terminal_serial, '') || '|' || v_pay.nsu, 0));
            IF EXISTS (
                SELECT 1 FROM payments p
                 WHERE p.tenant_id = v_tenant AND p.status = 'APPROVED' AND p.acquirer = v_pay.acquirer
                   AND p.nsu = v_pay.nsu AND COALESCE(p.terminal_serial, '') = COALESCE(v_pay.terminal_serial, '')
                   AND (p.registered_at > NOW() - INTERVAL '24 hours'
                        OR (p.created_at > COALESCE(v_pay.created_at, NOW()) - INTERVAL '24 hours'
                            AND p.created_at < COALESCE(v_pay.created_at, NOW()) + INTERVAL '24 hours'))
            ) THEN
                RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o NSU % já pagou outra conta (mesma credenciadora e maquininha).', v_pay.nsu;
            END IF;
        END IF;
    END IF;

    INSERT INTO payments (id, order_id, tenant_id, waiter_id, terminal_id, amount, tip_amount, method, status, acquirer,
                          acquirer_cnpj, card_brand, nsu, authorization_code, terminal_serial, idempotency_key, created_at)
    VALUES (v_pay.id, v_pay.order_id, v_tenant, v_pay.waiter_id, v_pay.terminal_id, v_pay.amount, COALESCE(v_pay.tip_amount, 0),
            v_pay.method, v_pay.status, v_pay.acquirer, v_pay.acquirer_cnpj, v_pay.card_brand, v_pay.nsu, v_pay.authorization_code,
            v_pay.terminal_serial, v_pay.idempotency_key, COALESCE(v_pay.created_at, NOW()));
    RETURN v_pay.id;
END;
$$;


-- -----------------------------------------------------------------------------
-- 7e. Conta estornada: reabertura e encerramento como venda devolvida (GPT r10 P1-01)
-- -----------------------------------------------------------------------------
-- Decisão (estorno total reabre a conta): tchefood_refund_point_payment devolve a conta FECHADA a PAYING. O caixa cobra
-- de novo, ou o gerente encerra como venda devolvida (tchefood_close_refunded_order): a conta fecha com saldo e o
-- valor baixado fica no registro ORDER_REFUNDED_WRITE_OFF (amount_impact e metadata.written_off_cents), que os
-- relatórios somam. Fora dessas duas exceções, a regra da main (db/schema_dinheiro_servidor.sql): conta só fecha ou
-- cancela com saldo zero e conta encerrada não reabre (o UPDATE é ignorado).
--   * CLOSED → PAYING só com tchefood.point_resolution apontando para o registro POINT_PAYMENT_REFUNDED desta conta
--     com order_reopened = true (gravado na mesma transação pelo estorno) e saldo maior que zero;
--   * OPEN/PAYING → CLOSED com saldo só com tchefood.order_write_off apontando para o registro ORDER_REFUNDED_WRITE_OFF
--     desta conta com written_off_cents igual ao saldo (o aparelho não grava esse registro: tchefood_guard_point_audit).
CREATE OR REPLACE FUNCTION tchefood_order_close_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_subtotal NUMERIC(10,2);
    v_fee      NUMERIC(10,2);
    v_discount NUMERIC(10,2);
    v_paid     NUMERIC(10,2);
    v_remaining NUMERIC(10,2);
    v_flag TEXT;
BEGIN
    IF NEW.status IN ('CLOSED', 'CANCELED') AND OLD.status IN ('OPEN', 'PAYING') THEN
        -- O mesmo UPDATE que encerra a conta pode trazer a taxa de serviço ou o desconto novos
        -- (quitar com a gorjeta dispensada, por exemplo). Os totais gravados só são refeitos DEPOIS
        -- (trg_orders_flags), então o saldo é calculado aqui com os valores que estão chegando,
        -- pela mesma regra de tchefood_recalc_order.
        SELECT COALESCE(SUM(total_item_price), 0) INTO v_subtotal
          FROM order_items WHERE order_id = OLD.id AND status <> 'CANCELED';
        v_fee := CASE WHEN NEW.charge_service_fee THEN round(v_subtotal * NEW.service_fee_pct / 100, 2) ELSE 0 END;
        v_discount := LEAST(GREATEST(NEW.discount_amount, 0), v_subtotal + v_fee);
        SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments WHERE order_id = OLD.id AND status = 'APPROVED';
        v_remaining := GREATEST(v_subtotal + v_fee - v_discount - v_paid, 0);
        IF v_remaining <> 0 AND NEW.status = 'CLOSED' THEN
            -- GPT r10 P1-01: venda devolvida, encerrada pelo gerente (tchefood_close_refunded_order).
            v_flag := COALESCE(current_setting('tchefood.order_write_off', true), '');
            IF v_flag ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               AND EXISTS (SELECT 1 FROM audit_logs a
                            WHERE a.id = v_flag::uuid AND a.tenant_id = OLD.tenant_id AND a.order_id = OLD.id
                              AND a.action_type = 'ORDER_REFUNDED_WRITE_OFF'
                              AND a.metadata->>'written_off_cents' = round(v_remaining * 100)::BIGINT::text) THEN
                RETURN NEW;
            END IF;
        END IF;
        IF v_remaining <> 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_ANTIFRAUDE: a conta % ainda deve R$ % no servidor e não pode ser %.',
                OLD.id, v_remaining, CASE NEW.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END;
        END IF;
    END IF;
    IF OLD.status IN ('CLOSED', 'CANCELED') AND NEW.status IN ('OPEN', 'PAYING') THEN
        -- GPT r10 P1-01: a conta fechada reaberta pelo estorno total do pagamento da Point.
        IF OLD.status = 'CLOSED' AND NEW.status = 'PAYING' AND OLD.remaining_balance > 0 THEN
            v_flag := COALESCE(current_setting('tchefood.point_resolution', true), '');
            IF v_flag ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               AND EXISTS (SELECT 1 FROM audit_logs a
                            WHERE a.id = v_flag::uuid AND a.tenant_id = OLD.tenant_id AND a.order_id = OLD.id
                              AND a.action_type = 'POINT_PAYMENT_REFUNDED' AND a.metadata->>'order_reopened' = 'true') THEN
                RETURN NEW;
            END IF;
        END IF;
        -- Não reabre. Em vez de recusar com erro, o UPDATE é ignorado: o reenvio de um evento antigo da
        -- fila (o aparelho caiu antes de confirmar o lote) volta a ser inofensivo e não trava os eventos
        -- seguintes da conta; quem tenta reabrir de propósito continua sem conseguir.
        RAISE NOTICE 'TCHEFOOD_ANTIFRAUDE: a conta % já foi encerrada e não reabre (atualização ignorada).', OLD.id;
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

-- Encerramento da venda devolvida (aparelho, loja do token), com PIN de gerente:
-- tchefood_close_refunded_order(p_order, p_staff, p_manager_pin, p_reason, p_client_audit_id) RETURNS JSONB
-- {audit_id, order_id, status: 'CLOSED', written_off_cents}; PIN errado ou bloqueado: NULL (MANAGER_PIN_FAILED /
-- MANAGER_PIN_LOCKOUT, as regras de tchefood_authorize_manager: gerente ou dono ativo, 3 erros em 60 s pelo relógio de
-- agora, trava do PIN da loja antes de qualquer linha). Ordem: motivo de 10 a 500 e p_client_audit_id (TF006);
-- operador da equipe ativa (TF004); trava do PIN; conta desta loja (TF005); reenvio (o mesmo p_client_audit_id nesta
-- conta já encerrou): depois do PIN conferido devolve o mesmo resultado, sem gravar nada; senão, antes do PIN (não
-- gasta tentativa): conta OPEN/PAYING (TF007 order_not_open), saldo maior que zero (TF007 nothing_to_write_off), nada
-- reservado (reserva aberta ou cobrança da Point em andamento: TF012 reserved), e o saldo inteiro coberto pelos
-- pagamentos ESTORNADOS do Mercado Pago da conta (saldo <= soma deles; senão TF007 balance_not_refunded). Grava
-- ORDER_REFUNDED_WRITE_OFF (amount_impact = valor baixado, metadata written_off_cents, refunded_cents,
-- client_audit_id, manager_name) e encerra a conta CLOSED com o saldo (marca tchefood.order_write_off só nesta
-- transação); a mesa da conta, se ainda for dela, fica livre, como no fechamento automático.
CREATE OR REPLACE FUNCTION tchefood_close_refunded_order(
    p_order UUID, p_staff UUID, p_manager_pin TEXT, p_reason TEXT, p_client_audit_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_order orders%ROWTYPE;
    v_manager staff_users%ROWTYPE;
    v_failures INT;
    v_checked_at TIMESTAMPTZ;
    v_replay audit_logs%ROWTYPE;
    v_remaining BIGINT;
    v_refunded BIGINT;
    v_audit UUID;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 10 OR length(trim(p_reason)) > 500 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: motivo obrigatório (de 10 a 500 caracteres).' USING ERRCODE = 'TF006';
    END IF;
    IF p_client_audit_id IS NULL OR p_order IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: falta a conta ou o id do registro do aparelho.' USING ERRCODE = 'TF006';
    END IF;
    IF p_staff IS NULL OR NOT EXISTS (SELECT 1 FROM staff_users u WHERE u.id = p_staff AND u.tenant_id = v_tenant AND u.active) THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: operador não é da equipe ativa desta loja.' USING ERRCODE = 'TF004';
    END IF;
    -- Trava do PIN da loja antes de qualquer linha (regra da main, #50), depois a conta.
    PERFORM pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || v_tenant::text));
    SELECT * INTO v_order FROM orders WHERE id = p_order AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: conta não encontrada nesta loja.' USING ERRCODE = 'TF005';
    END IF;
    SELECT * INTO v_replay FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.order_id = p_order AND a.action_type = 'ORDER_REFUNDED_WRITE_OFF'
       AND a.metadata->>'client_audit_id' = p_client_audit_id::text
     ORDER BY a.server_seq LIMIT 1;
    IF NOT FOUND THEN
        IF v_order.status NOT IN ('OPEN', 'PAYING') THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta já está %.', CASE v_order.status WHEN 'CLOSED' THEN 'fechada' ELSE 'cancelada' END
                USING ERRCODE = 'TF007', DETAIL = 'order_not_open';
        END IF;
        v_remaining := round(v_order.remaining_balance * 100)::BIGINT;
        IF v_remaining <= 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: a conta não tem saldo a baixar.' USING ERRCODE = 'TF007', DETAIL = 'nothing_to_write_off';
        END IF;
        IF tchefood_point_reserved_cents(v_tenant, p_order, NULL) > 0 THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: há pagamento em andamento nesta conta (reserva ou cobrança da Point); conclua ou libere antes.'
                USING ERRCODE = 'TF012', DETAIL = 'reserved';
        END IF;
        SELECT COALESCE(SUM(round(p.amount * 100)), 0)::BIGINT INTO v_refunded FROM payments p
         WHERE p.tenant_id = v_tenant AND p.order_id = p_order AND p.status = 'REFUNDED' AND p.acquirer::text = 'MERCADO_PAGO';
        IF v_remaining > v_refunded THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: o saldo da conta (R$ %) não é só do estorno da Point (R$ % estornado); cobre o restante.',
                to_char(v_remaining / 100.0, 'FM999999990.00'), to_char(v_refunded / 100.0, 'FM999999990.00')
                USING ERRCODE = 'TF007', DETAIL = 'balance_not_refunded';
        END IF;
    END IF;
    v_checked_at := clock_timestamp();
    SELECT count(*) INTO v_failures FROM audit_logs a
     WHERE a.tenant_id = v_tenant AND a.action_type = 'MANAGER_PIN_FAILED'
       AND a.created_at >= v_checked_at - INTERVAL '60 seconds' AND a.created_at <= v_checked_at;
    IF v_failures >= 3 THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, p_order, p_staff, 'MANAGER_PIN_LOCKOUT', 'PIN de gerente bloqueado por excesso de tentativas',
                jsonb_build_object('attempted_action', 'ORDER_REFUNDED_WRITE_OFF'), v_checked_at);
        RETURN NULL;
    END IF;
    SELECT * INTO v_manager FROM staff_users m
     WHERE m.tenant_id = v_tenant AND m.pin_code = p_manager_pin AND m.active AND m.role IN ('MANAGER', 'OWNER');
    IF NOT FOUND THEN
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
        VALUES (v_tenant, p_order, p_staff, 'MANAGER_PIN_FAILED', 'PIN de gerente incorreto',
                jsonb_build_object('attempted_action', 'ORDER_REFUNDED_WRITE_OFF'), v_checked_at);
        RETURN NULL;
    END IF;
    IF v_replay.id IS NOT NULL THEN
        RETURN jsonb_build_object('audit_id', v_replay.id, 'order_id', p_order, 'status', v_order.status,
                                  'written_off_cents', (v_replay.metadata->>'written_off_cents')::BIGINT);
    END IF;
    INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
    VALUES (v_tenant, p_order, p_staff, v_manager.id, 'ORDER_REFUNDED_WRITE_OFF', v_remaining / 100.0, trim(p_reason),
            jsonb_build_object('written_off_cents', v_remaining, 'refunded_cents', v_refunded, 'client_audit_id', p_client_audit_id,
                               'previous_status', v_order.status, 'manager_name', v_manager.name, 'server_verified', true))
    RETURNING id INTO v_audit;
    PERFORM set_config('tchefood.order_write_off', v_audit::text, true);
    UPDATE orders SET status = 'CLOSED', closed_at = NOW() WHERE id = p_order AND tenant_id = v_tenant;
    PERFORM set_config('tchefood.order_write_off', '', true);
    UPDATE dining_tables SET status = 'FREE', current_order_id = NULL, updated_at = NOW()
     WHERE id = v_order.table_id AND current_order_id = p_order;
    RETURN jsonb_build_object('audit_id', v_audit, 'order_id', p_order, 'status', 'CLOSED', 'written_off_cents', v_remaining);
END;
$$;

-- -----------------------------------------------------------------------------
-- 7f. Lista dos pagamentos da Point (GPT r10 P1-02), só leitura, loja do token
-- -----------------------------------------------------------------------------
-- tchefood_list_point_payments(p_from, p_to, p_search, p_cursor, p_limit) RETURNS JSONB {items, next_cursor}:
-- só pagamentos do Mercado Pago (acquirer MERCADO_PAGO) da loja do token, de p_from (inclusive) a p_to (exclusive),
-- qualquer um NULL = sem limite (sem prazo escondido: pagamento de meses atrás aparece). p_search (opcional) acha
-- por parte do NSU, da chave ou do id da ordem do Mercado Pago (external_order_id da cobrança), ou pelo valor
-- (12.50 ou 12,50). Ordem: created_at e id, do mais novo; p_cursor é o next_cursor da página anterior
-- ("<created_at ISO>|<id>"; inválido: TF006). p_limit de 1 a 200 (padrão 50; fora disso: TF006). items: payment_id,
-- order_id, charge_id, idempotency_key, amount, method, nsu, authorization_code, status, created_at e, para o
-- estornado, refunded_at (hora do servidor do registro POINT_PAYMENT_REFUNDED), refund_audit_id e
-- refunded_by_manager_id. Nada de segredo (nem token de reserva, nem dados do Mercado Pago além desses).
CREATE OR REPLACE FUNCTION tchefood_list_point_payments(
    p_from TIMESTAMPTZ, p_to TIMESTAMPTZ, p_search TEXT, p_cursor TEXT, p_limit INT DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tenant UUID := tchefood_tenant();
    v_limit INT := COALESCE(p_limit, 50);
    v_cursor_at TIMESTAMPTZ;
    v_cursor_id UUID;
    v_search TEXT := NULLIF(trim(COALESCE(p_search, '')), '');
    v_like TEXT;
    v_amount TEXT;
    v_rows JSONB;
    v_count INT;
    v_last JSONB;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'TCHEFOOD_AUTH: token sem loja (tenant_id).';
    END IF;
    IF v_limit < 1 OR v_limit > 200 THEN
        RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: p_limit de 1 a 200.' USING ERRCODE = 'TF006';
    END IF;
    IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
        BEGIN
            v_cursor_at := split_part(p_cursor, '|', 1)::TIMESTAMPTZ;
            v_cursor_id := split_part(p_cursor, '|', 2)::UUID;
        EXCEPTION WHEN others THEN
            v_cursor_at := NULL;
        END;
        IF v_cursor_at IS NULL OR v_cursor_id IS NULL THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: cursor inválido.' USING ERRCODE = 'TF006';
        END IF;
    END IF;
    IF v_search IS NOT NULL THEN
        IF length(v_search) > 100 THEN
            RAISE EXCEPTION 'TCHEFOOD_PAGAMENTO: busca de até 100 caracteres.' USING ERRCODE = 'TF006';
        END IF;
        v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
        v_amount := replace(v_search, ',', '.');
    END IF;
    WITH page AS (
        SELECT p.id, p.order_id, p.idempotency_key, p.amount, p.method, p.nsu, p.authorization_code, p.status, p.created_at,
               c.id AS charge_id, r.id AS refund_audit_id, r.created_at AS refunded_at, r.authorized_by_manager_id AS refunded_by_manager_id
          FROM payments p
          LEFT JOIN terminal_charges c ON c.tenant_id = p.tenant_id AND c.idempotency_key = p.idempotency_key
          LEFT JOIN LATERAL (SELECT a.id, a.created_at, a.authorized_by_manager_id FROM audit_logs a
                              WHERE a.tenant_id = p.tenant_id AND a.action_type = 'POINT_PAYMENT_REFUNDED'
                                AND a.metadata->>'payment_id' = p.id::text
                              ORDER BY a.server_seq LIMIT 1) r ON p.status = 'REFUNDED'
         WHERE p.tenant_id = v_tenant AND p.acquirer::text = 'MERCADO_PAGO'
           AND (p_from IS NULL OR p.created_at >= p_from)
           AND (p_to IS NULL OR p.created_at < p_to)
           AND (v_cursor_at IS NULL OR (p.created_at, p.id) < (v_cursor_at, v_cursor_id))
           AND (v_search IS NULL
                OR p.nsu ILIKE v_like OR p.idempotency_key ILIKE v_like OR c.external_order_id ILIKE v_like
                OR to_char(p.amount, 'FM999999990.00') = v_amount OR p.amount::text = v_amount)
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT v_limit + 1)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'payment_id', id, 'order_id', order_id, 'charge_id', charge_id, 'idempotency_key', idempotency_key,
               'amount', amount, 'method', method, 'nsu', nsu, 'authorization_code', authorization_code, 'status', status,
               'created_at', created_at, 'refunded_at', refunded_at, 'refund_audit_id', refund_audit_id,
               'refunded_by_manager_id', refunded_by_manager_id) ORDER BY created_at DESC, id DESC), '[]'::jsonb), count(*)
      INTO v_rows, v_count
      FROM page;
    IF v_count > v_limit THEN
        v_rows := v_rows - v_limit; -- tira o item a mais (só servia para saber se há próxima página)
        v_last := v_rows->(v_limit - 1);
        RETURN jsonb_build_object('items', v_rows,
                                  'next_cursor', (v_last->>'created_at') || '|' || (v_last->>'payment_id'));
    END IF;
    RETURN jsonb_build_object('items', v_rows, 'next_cursor', NULL);
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
        'tchefood_payment_identity_guard()',
        'tchefood_order_reserved_guard()',
        'tchefood_courier_cash_payment(payments)',
        'tchefood_point_reservation(UUID)',
        'tchefood_claim_payment(VARCHAR, UUID, VARCHAR, VARCHAR, BIGINT, BIGINT, UUID, TEXT)',
        'tchefood_release_payment_claim(VARCHAR, UUID, TEXT, TEXT)',
        'tchefood_release_payment_claim_manager(VARCHAR, UUID, VARCHAR, TEXT)',
        'tchefood_touch_payment_claim(VARCHAR, UUID, TEXT)',
        'tchefood_reclaim_payment(VARCHAR, TEXT, VARCHAR, TEXT, VARCHAR, VARCHAR, BIGINT, UUID)',
        'tchefood_authorize_claim_refunded(VARCHAR, UUID, VARCHAR, TEXT, JSONB)',
        'tchefood_resolve_point_charge(UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, TEXT, JSONB)',
        'tchefood_refund_point_payment(UUID, UUID, UUID, TEXT, JSONB, JSONB)',
        'tchefood_payment_replay_ok(payments, payments, UUID)',
        'tchefood_close_refunded_order(UUID, UUID, TEXT, TEXT, UUID)',
        'tchefood_list_point_payments(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INT)'] LOOP
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
        'tchefood_authorize_claim_refunded(VARCHAR, UUID, VARCHAR, TEXT, JSONB)',
        'tchefood_close_refunded_order(UUID, UUID, TEXT, TEXT, UUID)',
        'tchefood_list_point_payments(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INT)'] LOOP
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
        'tchefood_resolve_point_charge(UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, TEXT, JSONB)',
        'tchefood_refund_point_payment(UUID, UUID, UUID, TEXT, JSONB, JSONB)'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
        END IF;
    END LOOP;
END $$;
