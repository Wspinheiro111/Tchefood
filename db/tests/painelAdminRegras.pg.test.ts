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
});
