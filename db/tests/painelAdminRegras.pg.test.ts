/**
 * Regras do painel administrativo (db/schema_painel_admin.sql) acertadas na revisão interna:
 * lote do mês com loja em teste, pagamento que ativa só sem outra vencida, vencimento da
 * cobrança avulsa, CNPJ feito à mão, espaços, UF, conferência do formulário da assinatura,
 * última venda do delivery e permissões da service role.
 *
 * Contra o banco de verdade, pelo mesmo cliente da tela (admin/src/lib/api.ts) e o emulador
 * do PostgREST. Banco próprio (não divide com painelAdmin.pg.test.ts).
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AdminApiError, createAdminClient, type AdminClient, type NewStoreInput, type SubscriptionInput } from '../../admin/src/lib/api';
import { createSupabaseLikeDb, pgTargetFromEnv, postgrestFetch, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_painel_admin_regras_test';
const ROOT = join(__dirname, '..', '..');
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CFG = { url: 'http://cloud.test', anonKey: 'anon' };

function applySchema(t: PgTarget, db: string): void {
  createSupabaseLikeDb(t, db);
  psqlFile(t, join(ROOT, 'db', 'schema.sql'), db);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) psqlFile(t, join(dir, f), db);
}

function sql(q: string): string {
  const r = psql(target!, q, DB);
  if (!r.ok) throw new Error(r.message ?? 'sql');
  return r.out;
}

const admin = (): AdminClient =>
  createAdminClient(CFG, async () => 'token', postgrestFetch(target!, DB, { role: 'authenticated', sub: ADMIN, email: 'will@tchefood.test' }));

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `esperava erro ${pattern}`).toBeInstanceOf(AdminApiError);
  expect((err as AdminApiError).message).toMatch(pattern);
}

function setToday(day: string) {
  sql(`CREATE OR REPLACE FUNCTION tchefood_admin_today() RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT '${day}'::date $$;`);
}

// CNPJ válido (mesma conta de tchefood_admin_cnpj_valid) a partir de um número: cada loja do teste tem o seu.
function cnpj(n: number): string {
  const base = String(10_000_000_0000 + n).padStart(12, '0');
  const dv = (s: string, w: number[]) => {
    const r = [...s].reduce((acc, ch, i) => acc + (ch.charCodeAt(0) - 48) * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${d2}`;
}
let seq = 0;

const store = (over: Partial<NewStoreInput> = {}): NewStoreInput => ({
  name: `Loja ${++seq}`,
  legalName: `Loja ${seq} Ltda`,
  cnpj: cnpj(seq),
  city: 'Santo Ângelo',
  state: 'RS',
  planId: 'salao-pro',
  monthlyPrice: null,
  billingDay: 10,
  trialDays: 0,
  contactName: 'Maria da Silva',
  contactPhone: '(55) 99653-8255',
  contactEmail: '',
  notes: '',
  ...over,
});

const chargeOf = (tenant: string, month: string) =>
  sql(`SELECT COALESCE((SELECT due_date::text FROM store_charges WHERE tenant_id = '${tenant}' AND reference_month = '${month}' AND status <> 'CANCELLED'), 'nenhuma')`);

const subInput = async (tenant: string, over: Partial<SubscriptionInput> = {}): Promise<SubscriptionInput> => {
  const s = (await admin().store(tenant)).subscription!;
  return {
    planId: s.plan_id, monthlyPrice: String(s.monthly_price), status: s.status, billingDay: s.billing_day, trialEndsOn: s.trial_ends_on,
    contactName: s.contact_name, contactPhone: s.contact_phone, contactEmail: s.contact_email ?? '', notes: s.notes ?? '',
    reason: 'Ajuste combinado com a loja', expectedUpdatedAt: s.updated_at,
    ...over,
  };
};

(target ? describe : describe.skip)('painel administrativo: regras da revisão interna', () => {
  beforeAll(() => {
    applySchema(target!, DB);
    sql(`INSERT INTO platform_admins (user_id, email, name) VALUES ('${ADMIN}', 'will@tchefood.test', 'Will');`);
    setToday('2026-11-14');
  });

  it('lote do mês: teste que termina no mês não paga o mês, paga o seguinte; ativa paga; suspensa não', async () => {
    setToday('2026-11-14');
    const trialEndsNov30 = await admin().createStore(store({ trialDays: 16 }));
    expect((await admin().store(trialEndsNov30)).subscription!.trial_ends_on).toBe('2026-11-30');
    const trialEnded = await admin().createStore(store({ trialDays: 1 }));
    sql(`UPDATE store_subscriptions SET trial_ends_on = '2026-10-20' WHERE tenant_id = '${trialEnded}'`);
    const active = await admin().createStore(store());
    const suspended = await admin().createStore(store());
    sql(`UPDATE store_subscriptions SET status = 'SUSPENDED' WHERE tenant_id = '${suspended}'`);

    expect(await admin().generateMonth('2026-11-01')).toBe(2);
    expect(chargeOf(trialEndsNov30, '2026-11-01')).toBe('nenhuma');
    // Teste terminado em 20/10: paga novembro, vence hoje (o dia 10 já passou).
    expect(chargeOf(trialEnded, '2026-11-01')).toBe('2026-11-14');
    expect(chargeOf(active, '2026-11-01')).toBe('2026-11-14');
    expect(chargeOf(suspended, '2026-11-01')).toBe('nenhuma');

    expect(await admin().generateMonth('2026-12-01')).toBe(3);
    expect(chargeOf(trialEndsNov30, '2026-12-01')).toBe('2026-12-10');
    expect(chargeOf(trialEnded, '2026-12-01')).toBe('2026-12-10');
    expect(chargeOf(active, '2026-12-01')).toBe('2026-12-10');
    expect(chargeOf(suspended, '2026-12-01')).toBe('nenhuma');

    // Tira estas lojas dos próximos testes.
    for (const t of [trialEndsNov30, trialEnded, active, suspended]) sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${t}'`);
  });

  it('pagamento: em teste ou suspensa só vira ativa sem outra cobrança vencida em aberto', async () => {
    setToday('2026-11-14');
    for (const [initial, ref] of [['TRIAL', 'T'], ['SUSPENDED', 'S']] as const) {
      const t = await admin().createStore(store({ trialDays: initial === 'TRIAL' ? 10 : 0 }));
      if (initial === 'SUSPENDED') sql(`UPDATE store_subscriptions SET status = 'SUSPENDED' WHERE tenant_id = '${t}'`);
      // Teste já acabado (ainda TRIAL até alguém mudar): só assim outubro e novembro podem vencer à mão.
      if (initial === 'TRIAL') sql(`UPDATE store_subscriptions SET trial_ends_on = '2026-09-30' WHERE tenant_id = '${t}'`);
      expect((await admin().store(t)).subscription!.status).toBe(initial);
      const oct = await admin().createCharge(t, '2026-10-01', null, '2026-10-10', null);
      const nov = await admin().createCharge(t, '2026-11-01', null, '2026-11-10', null);
      // Dezembro em aberto, mas não vencido: não segura a ativação.
      const dec = await admin().createCharge(t, '2026-12-01', null, null, null);
      expect(sql(`SELECT due_date FROM store_charges WHERE id = '${dec}'`)).toBe('2026-12-10');

      expect(await admin().recordPayment(nov, '199.00', '2026-11-14', 'PIX', `${ref}-NOV-0001`)).toMatchObject({ subscription_status: initial, replayed: false });
      expect((await admin().store(t)).subscription!.status).toBe(initial);
      expect(await admin().recordPayment(oct, '199.00', '2026-11-14', 'PIX', `${ref}-OUT-0001`)).toMatchObject({ subscription_status: 'ACTIVE' });
      expect((await admin().store(t)).subscription!.status).toBe('ACTIVE');
      expect(sql(`SELECT status FROM store_charges WHERE id = '${dec}'`)).toBe('OPEN');
      sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${t}'`);
    }
  });

  it('cobrança avulsa sem vencimento: dia de cobrança, hoje ou o dia seguinte ao fim do teste, o que for depois', async () => {
    setToday('2026-11-14');
    // Fim do teste vence: teste até 20/11, dia de cobrança 5 -> 21/11.
    const trialLate = await admin().createStore(store({ trialDays: 6, billingDay: 5 }));
    expect(sql(`SELECT due_date FROM store_charges WHERE id = '${await admin().createCharge(trialLate, '2026-11-01', null, null, null)}'`)).toBe('2026-11-21');
    // Dia de cobrança vence: teste até 20/11, dia de cobrança 25 -> 25/11.
    const billingLate = await admin().createStore(store({ trialDays: 6, billingDay: 25 }));
    expect(sql(`SELECT due_date FROM store_charges WHERE id = '${await admin().createCharge(billingLate, '2026-11-01', null, null, null)}'`)).toBe('2026-11-25');
    // Hoje vence: teste (ainda em TRIAL) terminado em 01/11, dia de cobrança 5 -> 14/11.
    const todayLate = await admin().createStore(store({ trialDays: 6, billingDay: 5 }));
    sql(`UPDATE store_subscriptions SET trial_ends_on = '2026-11-01' WHERE tenant_id = '${todayLate}'`);
    expect(sql(`SELECT due_date FROM store_charges WHERE id = '${await admin().createCharge(todayLate, '2026-11-01', null, null, null)}'`)).toBe('2026-11-14');

    // Mês de 3 meses atrás, sem vencimento: vence hoje (antes era recusado por ficar longe do mês).
    const active = await admin().createStore(store({ billingDay: 5 }));
    const aug = await admin().createCharge(active, '2026-08-01', null, null, null);
    expect(sql(`SELECT reference_month || ' ' || due_date FROM store_charges WHERE id = '${aug}'`)).toBe('2026-08-01 2026-11-14');
    // Vencimento informado à mão longe do mês (ano digitado errado): recusado.
    await rejects(admin().createCharge(active, '2026-09-01', null, '2027-09-10', null), /vencimento longe/);
    await rejects(admin().createCharge(active, '2026-11-01', null, '2025-11-10', null), /vencimento longe/);
    expect(sql(`SELECT count(*) FROM store_charges WHERE tenant_id = '${active}'`)).toBe('1');

    for (const t of [trialLate, billingLate, todayLate, active]) sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${t}'`);
  });

  it('vencimento à mão nunca dentro do teste grátis (P2-01 da rodada 4); automático e lote sem mudança', async () => {
    setToday('2026-11-19');
    // Loja em teste até 30/11/2026, hoje 19/11: vencimento à mão em 10/11 ou 30/11 é recusado.
    const t = await admin().createStore(store({ trialDays: 11, billingDay: 10 }));
    expect((await admin().store(t)).subscription!.trial_ends_on).toBe('2026-11-30');
    await rejects(admin().createCharge(t, '2026-11-01', null, '2026-11-10', null), /depois do fim do teste \(30\/11\/2026\)/);
    await rejects(admin().createCharge(t, '2026-11-01', null, '2026-11-30', null), /depois do fim do teste/);
    expect(sql(`SELECT count(*) FROM store_charges WHERE tenant_id = '${t}'`)).toBe('0');
    expect(sql(`SELECT count(*) FROM platform_admin_audit WHERE tenant_id = '${t}' AND action = 'CHARGE_CREATED'`)).toBe('0');
    // No dia seguinte ao fim do teste é aceito.
    const nov = await admin().createCharge(t, '2026-11-01', null, '2026-12-01', null);
    expect(sql(`SELECT due_date FROM store_charges WHERE id = '${nov}'`)).toBe('2026-12-01');
    await admin().cancelCharge(nov, 'teste do vencimento automático');
    // Sem vencimento: o automático continua (dia seguinte ao fim do teste).
    const auto = await admin().createCharge(t, '2026-11-01', null, null, null);
    expect(sql(`SELECT due_date FROM store_charges WHERE id = '${auto}'`)).toBe('2026-12-01');
    // Lote de dezembro: a loja (teste terminado antes de dezembro) entra, vencendo no dia 10.
    setToday('2026-12-02');
    await admin().generateMonth('2026-12-01');
    expect(sql(`SELECT due_date FROM store_charges WHERE tenant_id = '${t}' AND reference_month = '2026-12-01' AND status = 'OPEN'`)).toBe('2026-12-10');
    // Teste acabado há muito tempo: vencimento à mão no passado continua aceito (cobrança atrasada).
    setToday('2026-11-19');
    const old = await admin().createStore(store({ trialDays: 0, billingDay: 5 }));
    const sep = await admin().createCharge(old, '2026-09-01', null, '2026-09-05', null);
    expect(sql(`SELECT due_date FROM store_charges WHERE id = '${sep}'`)).toBe('2026-09-05');
    for (const x of [t, old]) sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${x}'`);
  });

  it('loja nova: CNPJ de loja feita à mão em minúsculas bloqueia o mesmo CNPJ', async () => {
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('22222222-2222-4222-8222-222222222222', 'Feita à Mão', 'Feita à Mão Ltda', '12abc34501de35');`);
    const before = sql(`SELECT count(*) FROM tenants`);
    await rejects(admin().createStore(store({ cnpj: '12.ABC.345/01DE-35' })), /já existe loja com este CNPJ/);
    expect(sql(`SELECT count(*) FROM tenants`)).toBe(before);
  });

  it('nomes só com tabulação e quebra de linha são recusados; gravados sem elas nas pontas', async () => {
    const blank = '\t\n';
    const before = sql(`SELECT count(*) FROM tenants`);
    await rejects(admin().createStore(store({ name: blank })), /nome da loja inválido/);
    await rejects(admin().createStore(store({ legalName: blank })), /razão social inválida/);
    await rejects(admin().createStore(store({ contactName: blank })), /nome do contato/);
    expect(sql(`SELECT count(*) FROM tenants`)).toBe(before);

    const t = await admin().createStore(store({ name: '\tPizzaria Tabulada\n', legalName: '\n Pizzaria Tabulada Ltda\t', contactName: '\tAna Souza \n' }));
    const d = await admin().store(t);
    expect(d).toMatchObject({ name: 'Pizzaria Tabulada', legal_name: 'Pizzaria Tabulada Ltda' });
    expect(d.subscription!.contact_name).toBe('Ana Souza');

    // Na assinatura também.
    await rejects(admin().saveSubscription(t, await subInput(t, { contactName: blank })), /nome do contato/);
    const s = await admin().saveSubscription(t, await subInput(t, { contactName: '\n\tJoão Lima\t' }));
    expect(s.contact_name).toBe('João Lima');
    sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${t}'`);
  });

  it('UF: sigla que não existe é recusada; minúscula é aceita e gravada em maiúscula', async () => {
    await rejects(admin().createStore(store({ state: 'XX' })), /UF inválida/);
    const t = await admin().createStore(store({ state: 'rs' }));
    expect((await admin().store(t)).state).toBe('RS');
    sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${t}'`);
  });

  it('assinatura: fim do teste em até 90 dias; formulário desatualizado é recusado', async () => {
    setToday('2026-11-14');
    const t = await admin().createStore(store({ trialDays: 10 }));
    // 14/11/2026 + 90 = 12/02/2027.
    await rejects(admin().saveSubscription(t, await subInput(t, { trialEndsOn: '2027-02-13' })), /fim do teste em até 90 dias/);
    expect((await admin().saveSubscription(t, await subInput(t, { trialEndsOn: '2027-02-12' }))).trial_ends_on).toBe('2027-02-12');

    // O formulário abre; um pagamento ativa a loja; salvar o formulário aberto é recusado.
    const opened = await subInput(t, { notes: 'Contato prefere WhatsApp' });
    const charge = await admin().createCharge(t, '2026-11-01', null, null, null);
    expect(await admin().recordPayment(charge, '199.00', '2026-11-14', 'PIX', 'E2E-FORM-0001')).toMatchObject({ subscription_status: 'ACTIVE' });
    await rejects(admin().saveSubscription(t, opened), /mudou enquanto o formulário/);
    expect((await admin().store(t)).subscription).toMatchObject({ status: 'ACTIVE', notes: null });
    // Reaberto (updated_at atual): aceito.
    const fresh = await subInput(t, { notes: 'Contato prefere WhatsApp' });
    expect(fresh.status).toBe('ACTIVE');
    expect(await admin().saveSubscription(t, fresh)).toMatchObject({ status: 'ACTIVE', notes: 'Contato prefere WhatsApp' });

    // Assinatura existe e o formulário diz que não (null): recusado.
    await rejects(admin().saveSubscription(t, await subInput(t, { expectedUpdatedAt: null })), /mudou enquanto o formulário/);

    // Loja sem assinatura e o formulário traz um updated_at: recusado; com null, criada.
    const hand = '33333333-3333-4333-8333-333333333333';
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${hand}', 'Sem Assinatura', 'Sem Assinatura Ltda', '${cnpj(9000)}');`);
    const input: SubscriptionInput = {
      planId: 'bistro', monthlyPrice: '99.00', status: 'ACTIVE', billingDay: 5, trialEndsOn: null,
      contactName: 'Dono', contactPhone: '55999990000', contactEmail: '', notes: '', reason: 'Assinatura nova', expectedUpdatedAt: '2026-11-14T12:00:00+00:00',
    };
    await rejects(admin().saveSubscription(hand, input), /mudou enquanto o formulário/);
    expect(sql(`SELECT count(*) FROM store_subscriptions WHERE tenant_id = '${hand}'`)).toBe('0');
    expect(await admin().saveSubscription(hand, { ...input, expectedUpdatedAt: null })).toMatchObject({ status: 'ACTIVE', plan_id: 'bistro' });

    for (const x of [t, hand]) sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${x}'`);
  });

  it('última venda do delivery: o primeiro evento de conclusão, não o last_event_at; sem eventos, o last_event_at', async () => {
    const withEvents = '44444444-4444-4444-8444-444444444444';
    const noEvents = '55555555-5555-4555-8555-555555555555';
    const t0 = '2026-11-14T10:00:00Z'; // pedido feito
    const t1 = '2026-11-14T11:00:00Z'; // concluído
    const t2 = '2026-11-14T12:30:00Z'; // pedido de cancelamento depois da conclusão
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES
           ('${withEvents}', 'Delivery Com Eventos', 'Delivery Com Eventos Ltda', '${cnpj(9001)}'),
           ('${noEvents}', 'Delivery Sem Eventos', 'Delivery Sem Eventos Ltda', '${cnpj(9002)}');
         INSERT INTO delivery_orders (tenant_id, channel, external_id, display_id, status, total_amount, payload, placed_at, last_event_at) VALUES
           ('${withEvents}', 'ifood', 'regras-1', '2001', 'concluded', 50, '{}', '${t0}', '${t2}'),
           ('${noEvents}', 'ifood', 'regras-2', '2002', 'concluded', 50, '{}', '${t0}', '${t2}');
         INSERT INTO delivery_events (tenant_id, channel, external_event_id, external_order_id, raw_code, signal, event_created_at) VALUES
           ('${withEvents}', 'ifood', 'ev-1', 'regras-1', 'PLC', 'placed', '${t0}'),
           ('${withEvents}', 'ifood', 'ev-2', 'regras-1', 'CON', 'concluded', '${t1}'),
           ('${withEvents}', 'ifood', 'ev-3', 'regras-1', 'CAR', 'cancellation_requested', '${t2}');`);
    const ms = (iso: string | null) => (iso === null ? null : new Date(iso).getTime());
    expect(ms((await admin().store(withEvents)).last_sale_at)).toBe(ms(t1));
    expect(ms((await admin().store(noEvents)).last_sale_at)).toBe(ms(t2));
    // A lista de lojas usa a mesma regra.
    const rows = await admin().stores();
    expect(ms(rows.find((r) => r.tenant_id === withEvents)!.last_sale_at)).toBe(ms(t1));
    expect(ms(rows.find((r) => r.tenant_id === noEvents)!.last_sale_at)).toBe(ms(t2));
  });

  it('service role: não chama as funções de apoio nem grava nas tabelas do painel', () => {
    const asService = (stmt: string) => psql(target!, `BEGIN; SET LOCAL ROLE service_role; ${stmt}; ROLLBACK;`, DB);
    const log = asService(`SELECT tchefood_admin_log('${ADMIN}', NULL, NULL, 'X', NULL, '{}'::jsonb)`);
    expect(log.ok).toBe(false);
    expect(log.message).toMatch(/permission denied/);
    const ins = asService(`INSERT INTO platform_admins (user_id, email, name) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'x@x.com', 'Intruso')`);
    expect(ins.ok).toBe(false);
    expect(ins.message).toMatch(/permission denied/);
    expect(sql(`SELECT count(*) FROM platform_admins`)).toBe('1');
    expect(sql(`SELECT count(*) FROM platform_admin_audit WHERE action = 'X'`)).toBe('0');
  });

  describe('revisão interna 2', () => {
    const rpc = async (fn: string, body: unknown, db = DB) => {
      const f = postgrestFetch(target!, db, { role: 'authenticated', sub: ADMIN, email: 'will@tchefood.test' });
      const r = await f(`http://cloud.test/rest/v1/rpc/${fn}`, { method: 'POST', headers: {}, body: JSON.stringify(body) });
      return { status: r.status, body: JSON.parse((await r.text()) || 'null') as Record<string, unknown> };
    };
    const cancelAll = (...ts: string[]) => {
      for (const t of ts) sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${t}'`);
    };
    // Loja entrou no painel neste instante (created_at vem do NOW() de verdade; o teste volta no tempo).
    const createdAt = (t: string, at: string) => sql(`UPDATE store_subscriptions SET created_at = '${at}' WHERE tenant_id = '${t}'`);

    it('teste pago adiantado: a loja vira ativa e o mês do teste continua sem cobrança no lote', async () => {
      setToday('2026-01-06');
      // A: teste até 20/01, dia 28, paga fevereiro adiantado em 06/01.
      const a = await admin().createStore(store({ trialDays: 14, billingDay: 28 }));
      // B: teste até 20/01, dia 5, paga fevereiro adiantado.
      const b = await admin().createStore(store({ trialDays: 14, billingDay: 5 }));
      // C: teste de 60 dias (até 07/03), dia 28, paga janeiro adiantado.
      const c = await admin().createStore(store({ trialDays: 60, billingDay: 28 }));
      for (const t of [a, b, c]) createdAt(t, '2026-01-06T09:00:00-03:00');
      expect((await admin().store(a)).subscription!.trial_ends_on).toBe('2026-01-20');
      expect((await admin().store(c)).subscription!.trial_ends_on).toBe('2026-03-07');

      const febA = await admin().createCharge(a, '2026-02-01', null, null, null);
      expect(sql(`SELECT due_date FROM store_charges WHERE id = '${febA}'`)).toBe('2026-02-28');
      expect(await admin().recordPayment(febA, '199.00', '2026-01-06', 'PIX', 'R2-TRIAL-A-FEV')).toMatchObject({ subscription_status: 'ACTIVE' });
      const febB = await admin().createCharge(b, '2026-02-01', null, null, null);
      expect(await admin().recordPayment(febB, '199.00', '2026-01-06', 'PIX', 'R2-TRIAL-B-FEV')).toMatchObject({ subscription_status: 'ACTIVE' });
      const janC = await admin().createCharge(c, '2026-01-01', null, null, null);
      // Avulsa no mês do teste: não vence antes do fim do teste.
      expect(sql(`SELECT due_date FROM store_charges WHERE id = '${janC}'`)).toBe('2026-03-08');
      expect(await admin().recordPayment(janC, '199.00', '2026-01-06', 'PIX', 'R2-TRIAL-C-JAN')).toMatchObject({ subscription_status: 'ACTIVE' });
      for (const t of [a, b, c]) expect((await admin().store(t)).subscription).toMatchObject({ status: 'ACTIVE' });

      // Lote de janeiro em 12/01: janeiro está dentro do teste das três, mesmo ativas.
      setToday('2026-01-12');
      await admin().generateMonth('2026-01-01');
      expect(chargeOf(a, '2026-01-01')).toBe('nenhuma');
      expect(chargeOf(b, '2026-01-01')).toBe('nenhuma');
      expect(chargeOf(c, '2026-01-01')).toBe('2026-03-08'); // a avulsa paga, não outra
      expect(sql(`SELECT count(*) FROM store_charges WHERE tenant_id IN ('${a}', '${b}', '${c}') AND reference_month = '2026-01-01'`)).toBe('1');
      // Avulsa de janeiro para a loja ativa ainda no teste: não vence antes de 21/01 (dia 5 e hoje, 12/01, ficam antes).
      const janB = await admin().createCharge(b, '2026-01-01', null, null, null);
      expect(sql(`SELECT due_date FROM store_charges WHERE id = '${janB}'`)).toBe('2026-01-21');
      await admin().cancelCharge(janB, 'Lançada só para conferir');

      // Fevereiro: A e B já pagaram; C ainda em teste (até 07/03) não é cobrada.
      setToday('2026-01-25');
      await admin().generateMonth('2026-02-01');
      expect(chargeOf(a, '2026-02-01')).toBe('2026-02-28');
      expect(chargeOf(b, '2026-02-01')).toBe('2026-02-05');
      expect(sql(`SELECT string_agg(status, ',' ORDER BY status) FROM store_charges WHERE tenant_id IN ('${a}', '${b}') AND reference_month = '2026-02-01'`)).toBe('PAID,PAID');
      expect(chargeOf(c, '2026-02-01')).toBe('nenhuma');

      // Março: A e B no dia de cobrança; C não (o teste termina em março).
      setToday('2026-02-20');
      await admin().generateMonth('2026-03-01');
      expect(chargeOf(a, '2026-03-01')).toBe('2026-03-28');
      expect(chargeOf(b, '2026-03-01')).toBe('2026-03-05');
      expect(chargeOf(c, '2026-03-01')).toBe('nenhuma');

      // Abril: C paga.
      setToday('2026-03-20');
      await admin().generateMonth('2026-04-01');
      expect(chargeOf(c, '2026-04-01')).toBe('2026-04-28');

      setToday('2026-11-14');
      cancelAll(a, b, c);
    });

    it('lote de mês passado não cobra loja que entrou no painel depois do fim do mês', async () => {
      setToday('2026-11-14');
      const late = await admin().createStore(store());
      const early = await admin().createStore(store());
      // 00:30 de 01/11 em São Paulo: já é novembro. 23:30 de 31/10 em São Paulo (02:30 UTC de 01/11): ainda outubro.
      createdAt(late, '2026-11-01T00:30:00-03:00');
      createdAt(early, '2026-10-31T23:30:00-03:00');
      await admin().generateMonth('2026-10-01');
      expect(chargeOf(late, '2026-10-01')).toBe('nenhuma');
      expect(chargeOf(early, '2026-10-01')).toBe('2026-11-14');
      await admin().generateMonth('2026-11-01');
      expect(chargeOf(late, '2026-11-01')).toBe('2026-11-14');
      expect(chargeOf(early, '2026-11-01')).toBe('2026-11-14');
      cancelAll(late, early);
    });

    it('assinatura cancelada: cancela as cobranças em aberto dos meses seguintes, uma vez só', async () => {
      setToday('2026-11-14');
      const t = await admin().createStore(store());
      const oct = await admin().createCharge(t, '2026-10-01', null, null, null);
      const nov = await admin().createCharge(t, '2026-11-01', null, null, null);
      const dec = await admin().createCharge(t, '2026-12-01', null, null, null);
      const ins = (month: string) =>
        sql(`INSERT INTO store_charges (tenant_id, reference_month, amount, due_date, created_by)
             VALUES ('${t}', '${month}', 199, '${month}'::date + 9, '${ADMIN}') RETURNING id`);
      const jan = ins('2027-01-01');
      const feb = ins('2027-02-01');
      const mar = ins('2027-03-01');
      expect(await admin().recordPayment(dec, '199.00', '2026-11-14', 'PIX', 'R2-CANC-DEZ-0001')).toMatchObject({ status: 'PAID' });
      await admin().cancelCharge(mar, 'Cortesia de março');
      const statusOf = (id: string) => sql(`SELECT status FROM store_charges WHERE id = '${id}'`);

      const saved = await admin().saveSubscription(t, await subInput(t, { status: 'CANCELLED', reason: 'Loja fechou as portas' }));
      expect(saved.status).toBe('CANCELLED');
      expect([oct, nov, dec, jan, feb, mar].map(statusOf)).toEqual(['OPEN', 'OPEN', 'PAID', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
      for (const id of [jan, feb]) {
        expect(sql(`SELECT cancel_reason || '|' || cancelled_by FROM store_charges WHERE id = '${id}'`)).toBe(`Assinatura cancelada: Loja fechou as portas|${ADMIN}`);
      }
      expect(sql(`SELECT cancel_reason FROM store_charges WHERE id = '${mar}'`)).toBe('Cortesia de março');
      const audit = () =>
        sql(`SELECT COALESCE(string_agg((details->>'reference_month') || ' ' || (details->>'subscription_cancelled'), ',' ORDER BY details->>'reference_month'), '')
               FROM platform_admin_audit WHERE tenant_id = '${t}' AND action = 'CHARGE_CANCELLED' AND reason LIKE 'Assinatura cancelada:%'`);
      expect(audit()).toBe('2027-01-01 true,2027-02-01 true');
      expect(sql(`SELECT count(*) FROM platform_admin_audit WHERE tenant_id = '${t}' AND action = 'CHARGE_CANCELLED' AND charge_id IN ('${jan}', '${feb}')`)).toBe('2');

      // Salvar de novo como cancelada (já estava): não mexe em mais nada, nem em cobrança aberta nova.
      const apr = ins('2027-04-01');
      await admin().saveSubscription(t, await subInput(t, { status: 'CANCELLED', notes: 'Encerrada', reason: 'Anotação depois do cancelamento' }));
      expect(statusOf(apr)).toBe('OPEN');
      expect([oct, nov, dec].map(statusOf)).toEqual(['OPEN', 'OPEN', 'PAID']);
      expect(audit()).toBe('2027-01-01 true,2027-02-01 true');
    });

    it('conta do aparelho não muda o updated_at da assinatura: formulário aberto antes ainda salva', async () => {
      setToday('2026-11-14');
      const t = await admin().createStore(store());
      const opened = await subInput(t, { notes: 'Aberto antes da conta do aparelho' });
      const before = sql(`SELECT updated_at FROM store_subscriptions WHERE tenant_id = '${t}'`);
      const r = await rpc('tchefood_admin_reserve_device', { p_tenant: t, p_email: `r2-${t.slice(0, 8)}@aparelho.tchefood.com.br` });
      expect(r.body).toMatchObject({ status: 'PENDING' });
      const op = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      expect((await rpc('tchefood_admin_device_lock', { p_tenant: t, p_op: op })).status).toBe(200);
      expect((await rpc('tchefood_admin_confirm_device', { p_tenant: t, p_user_id: r.body.user_id, p_action: 'CREATED', p_op: op })).status).toBe(200);
      expect((await admin().store(t)).subscription).toMatchObject({ device_status: 'READY' });
      expect(sql(`SELECT updated_at FROM store_subscriptions WHERE tenant_id = '${t}'`)).toBe(before);
      expect(await admin().saveSubscription(t, opened)).toMatchObject({ notes: 'Aberto antes da conta do aparelho', device_status: 'READY' });
      cancelAll(t);
    });

    it('espaço não separável e BOM nas pontas saem; nome só com eles é recusado', async () => {
      // Direto na função (o cliente da tela já apara com String.trim, que também tira os dois).
      const createRaw = (over: Record<string, unknown>) =>
        rpc('tchefood_admin_create_store', {
          p_name: `Loja ${++seq}`, p_legal_name: `Loja ${seq} Ltda`, p_cnpj: cnpj(seq), p_city: null, p_state: null, p_plan_id: 'salao-pro',
          p_monthly_price: null, p_billing_day: 10, p_trial_days: 0, p_contact_name: 'Maria da Silva', p_contact_phone: '(55) 99653-8255',
          p_contact_email: null, p_notes: null, ...over,
        });
      const before = sql(`SELECT count(*) FROM tenants`);
      expect((await createRaw({ p_name: '\u00a0\u00a0' })).body.message).toMatch(/nome da loja inválido/);
      expect((await createRaw({ p_name: '\ufeff\u00a0' })).body.message).toMatch(/nome da loja inválido/);
      expect((await createRaw({ p_contact_name: '\u00a0A\u00a0' })).body.message).toMatch(/nome do contato/);
      expect(sql(`SELECT count(*) FROM tenants`)).toBe(before);
      const r = await createRaw({ p_name: 'Loja\u00a0', p_legal_name: '\ufeffLoja BOM Ltda\u00a0', p_contact_name: '\u00a0Ana Souza\ufeff', p_city: '\u00a0Ijuí\u00a0' });
      expect(r.status).toBe(200);
      const t = r.body as unknown as string;
      // Compara no banco: a saída do psql passa por String.trim no teste.
      expect(sql(`SELECT t.name = 'Loja' AND t.legal_name = 'Loja BOM Ltda' AND t.city = 'Ijuí' AND s.contact_name = 'Ana Souza'
                    FROM tenants t JOIN store_subscriptions s ON s.tenant_id = t.id WHERE t.id = '${t}'`)).toBe('t');
      const d = await admin().store(t);
      expect(d).toMatchObject({ name: 'Loja', legal_name: 'Loja BOM Ltda' });
      expect(sql(`SELECT tchefood_admin_trim(E'\\u00a0 Meio\\u00a0do nome \\ufeff') = E'Meio\\u00a0do nome'`)).toBe('t');
      // Na assinatura também.
      const s0 = await subInput(t);
      const save = (contact: string) =>
        rpc('tchefood_admin_save_subscription', {
          p_tenant: t, p_plan_id: s0.planId, p_monthly_price: s0.monthlyPrice, p_status: s0.status, p_billing_day: s0.billingDay, p_trial_ends_on: null,
          p_contact_name: contact, p_contact_phone: s0.contactPhone, p_contact_email: null, p_notes: null, p_reason: s0.reason, p_expected_updated_at: s0.expectedUpdatedAt,
        });
      expect((await save('\u00a0\u00a0')).body.message).toMatch(/nome do contato/);
      expect((await save('\ufeffJoão Lima\u00a0')).status).toBe(200);
      expect(sql(`SELECT contact_name = 'João Lima' FROM store_subscriptions WHERE tenant_id = '${t}'`)).toBe('t');
      cancelAll(t);
    });

    // O rascunho só existe no histórico do branch do PR (clone raso ou main depois de squash não têm).
    const draft = (() => {
      try {
        return execFileSync('git', ['show', 'c065c70:db/schema_painel_admin.sql'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    })();
    it.skipIf(draft === null)('atualização a partir do rascunho c065c70: colunas da vez do aparelho criadas e a trava funciona', async () => {
      const UP = 'tchefood_painel_admin_regras_upgrade_test';
      const old = draft!;
      createSupabaseLikeDb(target!, UP);
      try {
        psqlFile(target!, join(ROOT, 'db', 'schema.sql'), UP);
        const dir = join(ROOT, 'supabase', 'migrations');
        for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '20261114150000').sort()) psqlFile(target!, join(dir, f), UP);
        const r0 = psql(target!, old, UP);
        expect(r0.ok, r0.message ?? '').toBe(true);
        const cols = () =>
          psql(target!, `SELECT COALESCE(string_agg(column_name, ',' ORDER BY column_name), '') FROM information_schema.columns WHERE table_name = 'store_subscriptions' AND column_name LIKE 'device_op%'`, UP).out;
        expect(cols()).toBe('');
        psqlFile(target!, join(ROOT, 'db', 'schema_painel_admin.sql'), UP);
        expect(cols()).toBe('device_op_id,device_op_started_at');
        // Rodar de novo não duplica a regra das duas colunas.
        psqlFile(target!, join(ROOT, 'db', 'schema_painel_admin.sql'), UP);
        expect(
          psql(target!, `SELECT count(*) FROM pg_constraint WHERE conrelid = 'store_subscriptions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%device_op_id IS NULL%'`, UP).out,
        ).toBe('1');

        expect(psql(target!, `INSERT INTO platform_admins (user_id, email, name) VALUES ('${ADMIN}', 'will@tchefood.test', 'Will')`, UP).ok).toBe(true);
        const up = createAdminClient(CFG, async () => 'token', postgrestFetch(target!, UP, { role: 'authenticated', sub: ADMIN, email: 'will@tchefood.test' }));
        const t = await up.createStore(store());
        const opA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const opB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        expect((await rpc('tchefood_admin_device_lock', { p_tenant: t, p_op: opA }, UP)).status).toBe(200);
        expect(psql(target!, `SELECT device_op_id FROM store_subscriptions WHERE tenant_id = '${t}'`, UP).out).toBe(opA);
        expect((await rpc('tchefood_admin_device_lock', { p_tenant: t, p_op: opB }, UP)).body.message).toMatch(/outra operação/);
        // O CHECK das duas colunas vale no banco atualizado.
        const bad = psql(target!, `UPDATE store_subscriptions SET device_op_started_at = NULL WHERE tenant_id = '${t}'`, UP);
        expect(bad.ok).toBe(false);
        expect(bad.sqlstate).toBe('23514');
        expect((await rpc('tchefood_admin_device_unlock', { p_tenant: t, p_op: opA }, UP)).status).toBe(200);
        expect((await rpc('tchefood_admin_device_lock', { p_tenant: t, p_op: opB }, UP)).status).toBe(200);
      } finally {
        psql({ ...target!, db: 'postgres' }, `DROP DATABASE IF EXISTS ${UP} WITH (FORCE);`);
      }
    }, 120_000);

    it('salvar a assinatura não segura a inclusão de linhas da loja (FOR NO KEY UPDATE em tenants)', async () => {
      setToday('2026-11-14');
      const t = await admin().createStore(store());
      const updatedAt = sql(`SELECT updated_at FROM store_subscriptions WHERE tenant_id = '${t}'`);
      const claims = JSON.stringify({ role: 'authenticated', sub: ADMIN, email: 'will@tchefood.test' });
      const tag = `r2-hold-${t}`;
      const holder = spawn('psql', ['-h', target!.host, '-p', target!.port, '-U', target!.user, '-d', DB, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PGAPPNAME: tag },
      });
      let holderErr = '';
      holder.stderr.on('data', (d: Buffer) => (holderErr += d.toString()));
      const done = new Promise<number | null>((res) => holder.on('close', res));
      holder.stdin.end(`BEGIN;
        SET LOCAL ROLE authenticated;
        SELECT set_config('request.jwt.claims', '${claims}', true) \\g /dev/null
        SELECT tchefood_admin_save_subscription(p_tenant => '${t}', p_plan_id => 'salao-pro', p_monthly_price => 199, p_status => 'ACTIVE',
          p_billing_day => 10, p_trial_ends_on => NULL, p_contact_name => 'Maria da Silva', p_contact_phone => '55996538255',
          p_contact_email => '', p_notes => 'Transação segurada', p_reason => 'Teste da trava', p_expected_updated_at => '${updatedAt}') \\g /dev/null
        SELECT pg_sleep(4);
        COMMIT;`);
      // Espera a outra sessão chegar no pg_sleep (a função já rodou e a trava está com ela).
      const deadline = Date.now() + 10_000;
      while (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name = '${tag}' AND state = 'active' AND query LIKE '%pg_sleep%'`) !== '1') {
        if (Date.now() > deadline) throw new Error(`a sessão que segura não chegou no pg_sleep: ${holderErr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const t0 = Date.now();
      const ins = psql(target!, `SET lock_timeout = '1500ms'; INSERT INTO staff_users (tenant_id, name, pin_code) VALUES ('${t}', 'Garçom Novo', '9876') RETURNING name;`, DB);
      const waited = Date.now() - t0;
      expect(ins.ok, ins.message ?? '').toBe(true);
      expect(ins.out).toBe('Garçom Novo');
      expect(waited).toBeLessThan(1500);
      expect(await done).toBe(0);
      expect(holderErr).toBe('');
      expect((await admin().store(t)).subscription!.notes).toBe('Transação segurada');
      cancelAll(t);
    }, 30_000);

    it('uso da loja: regras de antes; delivery com conclusão mais tarde num pedido mais velho; fechada sem closed_at', async () => {
      // Mesmo roteiro do teste "uso da loja" de painelAdmin.pg.test.ts, com "hoje" no dia de verdade em São Paulo.
      setToday(sql(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date`));
      const HAND = '66666666-6666-4666-8666-666666666666';
      sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${HAND}', 'Uso da Loja', 'Uso da Loja Ltda', '${cnpj(9101)}');`);
      let hand = (await admin().stores()).find((x) => x.tenant_id === HAND)!;
      expect(hand).toMatchObject({ last_sale_at: null, last_order_opened_at: null, orders_7d: 0, staff_active: 0 });
      const epoch = (iso: string | null) => (iso === null ? null : Math.round(new Date(iso).getTime() / 1000));
      const dbEpoch = (expr: string) => Number(sql(`SELECT round(extract(epoch FROM (${expr})))`));
      sql(`SET session_replication_role = replica;
           INSERT INTO orders (tenant_id, table_id, opened_by_user_id, status, opened_at, closed_at) VALUES
             ('${HAND}', gen_random_uuid(), gen_random_uuid(), 'CLOSED', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'),
             ('${HAND}', gen_random_uuid(), gen_random_uuid(), 'OPEN', NOW() - INTERVAL '1 hour', NULL),
             ('${HAND}', gen_random_uuid(), gen_random_uuid(), 'PAYING', NOW() - INTERVAL '30 minutes', NULL),
             ('${HAND}', gen_random_uuid(), gen_random_uuid(), 'CANCELED', NOW(), NULL);
           INSERT INTO delivery_orders (tenant_id, channel, external_id, display_id, status, total_amount, payload, placed_at, last_event_at) VALUES
             ('${HAND}', 'ifood', 'uso-1', '1001', 'concluded', 50, '{}', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days' + INTERVAL '1 hour'),
             ('${HAND}', 'ifood', 'uso-4', '1004', 'dispatched', 50, '{}', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '1 minute'),
             ('${HAND}', 'ifood', 'uso-2', '1002', 'cancelled', 50, '{}', NOW() - INTERVAL '1 hour', NOW()),
             ('${HAND}', 'ifood', 'uso-3', '1003', 'concluded', 50, '{}', NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days');`);
      const closedAt = dbEpoch(`SELECT closed_at FROM orders WHERE tenant_id = '${HAND}' AND status = 'CLOSED'`);
      const dispatchedPlaced = dbEpoch(`SELECT placed_at FROM delivery_orders WHERE external_id = 'uso-4'`);
      hand = (await admin().stores()).find((x) => x.tenant_id === HAND)!;
      expect(epoch(hand.last_sale_at)).toBe(closedAt);
      expect(epoch(hand.last_order_opened_at)).toBe(dispatchedPlaced);
      expect(hand.orders_7d).toBe(5);
      let detail = await admin().store(HAND);
      expect(detail).toMatchObject({ last_sale_at: hand.last_sale_at, last_order_opened_at: hand.last_order_opened_at, orders_7d: 5, orders_30d: 6 });
      sql(`UPDATE delivery_orders SET status = 'concluded', last_event_at = NOW() WHERE external_id = 'uso-4'`);
      const concludedAt = dbEpoch(`SELECT last_event_at FROM delivery_orders WHERE external_id = 'uso-4'`);
      detail = await admin().store(HAND);
      expect(epoch(detail.last_sale_at)).toBe(concludedAt);
      sql(`UPDATE orders SET status = 'CANCELED' WHERE tenant_id = '${HAND}' AND status = 'PAYING'`);
      detail = await admin().store(HAND);
      expect(detail).toMatchObject({ orders_7d: 4, orders_30d: 5 });
      expect(epoch(detail.last_sale_at)).toBe(concludedAt);

      // Muitos delivery concluídos. O de last_event_at mais novo concluiu cedo (eventos depois da
      // conclusão); um pedido mais velho concluiu depois de todos os 25 mais novos.
      const MANY = '77777777-7777-4777-8777-777777777777';
      const base = '2026-11-10T12:00:00Z';
      const at = (min: number) => `'${base}'::timestamptz + INTERVAL '${min} minutes'`;
      sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${MANY}', 'Muitos Delivery', 'Muitos Delivery Ltda', '${cnpj(9102)}');
           -- Mais recente no last_event_at: feito em -240, concluído em -210, último evento em -1.
           INSERT INTO delivery_orders (tenant_id, channel, external_id, display_id, status, total_amount, payload, placed_at, last_event_at) VALUES
             ('${MANY}', 'ifood', 'many-decoy', '3000', 'concluded', 50, '{}', ${at(-240)}, ${at(-1)}),
             ('${MANY}', 'ifood', 'many-old', '3001', 'concluded', 50, '{}', ${at(-1440)}, ${at(-10)});
           INSERT INTO delivery_events (tenant_id, channel, external_event_id, external_order_id, raw_code, signal, event_created_at) VALUES
             ('${MANY}', 'ifood', 'many-ev-decoy-con', 'many-decoy', 'CON', 'concluded', ${at(-210)}),
             ('${MANY}', 'ifood', 'many-ev-decoy-car', 'many-decoy', 'CAR', 'cancellation_requested', ${at(-1)}),
             ('${MANY}', 'ifood', 'many-ev-old-con', 'many-old', 'CON', 'concluded', ${at(-30)}),
             ('${MANY}', 'ifood', 'many-ev-old-con2', 'many-old', 'CON', 'concluded', ${at(-20)}),
             ('${MANY}', 'ifood', 'many-ev-old-car', 'many-old', 'CAR', 'cancellation_requested', ${at(-10)});
           INSERT INTO delivery_orders (tenant_id, channel, external_id, display_id, status, total_amount, payload, placed_at, last_event_at)
           SELECT '${MANY}', 'ifood', 'many-new-' || i, (4000 + i)::text, 'concluded', 50, '{}', ${at(-180)} + i * INTERVAL '1 minute', ${at(-120)} - i * INTERVAL '1 minute'
             FROM generate_series(1, 25) i;`);
      const expected = dbEpoch(at(-30));
      expect(epoch((await admin().store(MANY)).last_sale_at)).toBe(expected);
      expect(epoch((await admin().stores()).find((x) => x.tenant_id === MANY)!.last_sale_at)).toBe(expected);

      // Conta fechada sem closed_at: vale a abertura (e passa da fechada com closed_at mais velho).
      const NULLCLOSE = '88888888-8888-4888-8888-888888888888';
      sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${NULLCLOSE}', 'Fechada Sem Hora', 'Fechada Sem Hora Ltda', '${cnpj(9103)}');
           SET session_replication_role = replica;
           INSERT INTO orders (tenant_id, table_id, opened_by_user_id, status, opened_at, closed_at) VALUES
             ('${NULLCLOSE}', gen_random_uuid(), gen_random_uuid(), 'CLOSED', ${at(-360)}, ${at(-300)}),
             ('${NULLCLOSE}', gen_random_uuid(), gen_random_uuid(), 'CLOSED', ${at(-120)}, NULL),
             ('${NULLCLOSE}', gen_random_uuid(), gen_random_uuid(), 'OPEN', ${at(-60)}, NULL);`);
      expect(epoch((await admin().store(NULLCLOSE)).last_sale_at)).toBe(dbEpoch(at(-120)));
      expect(epoch((await admin().stores()).find((x) => x.tenant_id === NULLCLOSE)!.last_sale_at)).toBe(dbEpoch(at(-120)));
      // Só a fechada sem closed_at: também vale a abertura.
      sql(`UPDATE orders SET status = 'CANCELED' WHERE tenant_id = '${NULLCLOSE}' AND closed_at IS NOT NULL`);
      expect(epoch((await admin().store(NULLCLOSE)).last_sale_at)).toBe(dbEpoch(at(-120)));
      setToday('2026-11-14');
    });
  });

  describe('revisão interna 3', () => {
    const cancelAll = (...ts: string[]) => {
      for (const t of ts) sql(`UPDATE store_subscriptions SET status = 'CANCELLED' WHERE tenant_id = '${t}'`);
    };
    const decRows = (t: string) =>
      sql(`SELECT COALESCE(string_agg(status || ':' || cancelled_with_subscription, ',' ORDER BY created_at, id), '')
             FROM store_charges WHERE tenant_id = '${t}' AND reference_month = '2026-12-01'`);
    const trialOf = async (t: string) => (await admin().store(t)).subscription!.trial_ends_on;

    it('loja cancelada que volta: o lote refaz o mês cancelado junto com a assinatura, não o cancelado pelo admin', async () => {
      setToday('2026-11-14');
      const back = await admin().createStore(store());
      const courtesy = await admin().createStore(store());
      await admin().generateMonth('2026-12-01');
      expect(decRows(back)).toBe('OPEN:false');
      expect(decRows(courtesy)).toBe('OPEN:false');

      // Cortesia: o admin cancela dezembro desta loja.
      const decCourtesy = sql(`SELECT id FROM store_charges WHERE tenant_id = '${courtesy}' AND reference_month = '2026-12-01'`);
      await admin().cancelCharge(decCourtesy, 'Cortesia de dezembro');

      for (const round of [1, 2]) {
        for (const t of [back, courtesy]) {
          expect(await admin().saveSubscription(t, await subInput(t, { status: 'CANCELLED', reason: `Loja pediu para sair ${round}` }))).toMatchObject({ status: 'CANCELLED' });
        }
        expect(decRows(back)).toBe(Array(round).fill('CANCELLED:true').join(','));
        for (const t of [back, courtesy]) {
          expect(await admin().saveSubscription(t, await subInput(t, { status: 'ACTIVE', reason: `Loja voltou ${round}` }))).toMatchObject({ status: 'ACTIVE' });
        }
        await admin().generateMonth('2026-12-01');
        // Lote de novo no mesmo dia: não duplica.
        await admin().generateMonth('2026-12-01');
        expect(decRows(back)).toBe([...Array(round).fill('CANCELLED:true'), 'OPEN:false'].join(','));
        expect(chargeOf(back, '2026-12-01')).toBe('2026-12-10');
        expect(sql(`SELECT count(*) FROM store_charges WHERE tenant_id = '${back}' AND reference_month = '2026-12-01' AND status = 'OPEN'`)).toBe('1');
        // Cancelada pelo admin: o lote não desfaz a cortesia.
        expect(decRows(courtesy)).toBe('CANCELLED:false');
        expect(chargeOf(courtesy, '2026-12-01')).toBe('nenhuma');
      }
      cancelAll(back, courtesy);
    });

    it('assinatura fora do teste: fim do teste em até 90 dias; não nasce, não estica, só antecipa', async () => {
      setToday('2026-11-14');
      // Ativa sem data de teste: data de ano errado recusada; data válida não é gravada.
      const active = await admin().createStore(store());
      expect(await trialOf(active)).toBeNull();
      await rejects(admin().saveSubscription(active, await subInput(active, { status: 'ACTIVE', trialEndsOn: '2036-11-30' })), /fim do teste em até 90 dias/);
      expect(await trialOf(active)).toBeNull();
      expect((await admin().saveSubscription(active, await subInput(active, { trialEndsOn: '2026-12-20' }))).trial_ends_on).toBeNull();
      expect(await trialOf(active)).toBeNull();

      // Tirada do teste à mão: o teste acaba hoje.
      const manual = await admin().createStore(store({ trialDays: 36 }));
      expect(await admin().saveSubscription(manual, await subInput(manual, { status: 'ACTIVE' }))).toMatchObject({ status: 'ACTIVE', trial_ends_on: '2026-11-14' });

      // Ativa com teste até 20/12 (virou ativa pelo pagamento adiantado, que não mexe na data):
      // mais tarde fica 20/12; sem data fica 20/12; mais cedo é aceito.
      const paid = await admin().createStore(store({ trialDays: 36 }));
      expect(await trialOf(paid)).toBe('2026-12-20');
      sql(`UPDATE store_subscriptions SET status = 'ACTIVE' WHERE tenant_id = '${paid}'`);
      await rejects(admin().saveSubscription(paid, await subInput(paid, { trialEndsOn: '2036-11-30' })), /fim do teste em até 90 dias/);
      expect((await admin().saveSubscription(paid, await subInput(paid, { trialEndsOn: '2027-01-10' }))).trial_ends_on).toBe('2026-12-20');
      expect((await admin().saveSubscription(paid, await subInput(paid, { trialEndsOn: null }))).trial_ends_on).toBe('2026-12-20');
      expect((await admin().saveSubscription(paid, await subInput(paid, { trialEndsOn: '2026-12-01' }))).trial_ends_on).toBe('2026-12-01');
      expect((await admin().saveSubscription(paid, await subInput(paid, { trialEndsOn: '2026-12-20' }))).trial_ends_on).toBe('2026-12-01');

      // Assinatura nova fora do teste: a data informada não é gravada.
      const hand = '99999999-9999-4999-8999-999999999999';
      sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${hand}', 'Nova Ativa', 'Nova Ativa Ltda', '${cnpj(9300)}');`);
      const input: SubscriptionInput = {
        planId: 'bistro', monthlyPrice: '99.00', status: 'ACTIVE', billingDay: 5, trialEndsOn: '2026-12-20',
        contactName: 'Dono', contactPhone: '55999990000', contactEmail: '', notes: '', reason: 'Assinatura nova', expectedUpdatedAt: null,
      };
      expect(await admin().saveSubscription(hand, input)).toMatchObject({ status: 'ACTIVE', trial_ends_on: null });
      expect(sql(`SELECT COALESCE(trial_ends_on::text, 'null') FROM store_subscriptions WHERE tenant_id = '${hand}'`)).toBe('null');
      cancelAll(active, manual, paid, hand);
    });

    it('pagamento adiantado de mais de um mês: aceito até 3 meses antes do mês da cobrança', async () => {
      setToday('2027-01-05');
      const t = await admin().createStore(store({ trialDays: 0, billingDay: 10 }));
      sql(`UPDATE store_subscriptions SET created_at = '2026-11-01' WHERE tenant_id = '${t}'`);
      const feb = await admin().createCharge(t, '2027-02-01', null, null, null);
      // Pix de 15/12 que pagou janeiro e fevereiro juntos.
      await rejects(admin().recordPayment(feb, '199.00', '2026-10-31', 'PIX', 'E2E-ANTIGO-1'), /muito antes do mês/);
      expect(await admin().recordPayment(feb, '199.00', '2026-12-15', 'PIX', 'E2E-ADIANTADO-1')).toMatchObject({ subscription_status: 'ACTIVE' });
      setToday('2026-11-14');
      cancelAll(t);
    });

    it('cobrança avulsa sem vencimento de loja ativa ainda no teste: dia seguinte ao fim do teste, nunca depois de hoje + 91', async () => {
      setToday('2026-11-14');
      const t = await admin().createStore(store({ trialDays: 36, billingDay: 10 }));
      sql(`UPDATE store_subscriptions SET status = 'ACTIVE' WHERE tenant_id = '${t}'`); // pagou adiantado
      // Tentativa de esticar o teste (ano digitado errado), aceita ou recusada: o vencimento não passa de hoje + 91.
      await admin().saveSubscription(t, await subInput(t, { trialEndsOn: '2036-11-30' })).catch(() => null);
      const dec = await admin().createCharge(t, '2026-12-01', null, null, null);
      const due = sql(`SELECT due_date FROM store_charges WHERE id = '${dec}'`);
      expect(due).toBe('2026-12-21');
      expect(due <= '2027-02-13').toBe(true);

      // Teste no limite (hoje + 90 = 12/02/2027): o vencimento é hoje + 91, não mais.
      const edge = await admin().createStore(store({ trialDays: 90, billingDay: 10 }));
      expect(await trialOf(edge)).toBe('2027-02-12');
      sql(`UPDATE store_subscriptions SET status = 'ACTIVE' WHERE tenant_id = '${edge}'`); // pagou adiantado
      await admin().saveSubscription(edge, await subInput(edge, { trialEndsOn: '2036-11-30' })).catch(() => null);
      const decEdge = await admin().createCharge(edge, '2026-12-01', null, null, null);
      expect(sql(`SELECT due_date FROM store_charges WHERE id = '${decEdge}'`)).toBe('2027-02-13');
      cancelAll(t, edge);
    });
  });
});
