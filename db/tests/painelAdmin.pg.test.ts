/**
 * Painel administrativo (db/schema_painel_admin.sql) contra o banco de verdade, pelo mesmo
 * cliente da tela (admin/src/lib/api.ts) e o emulador do PostgREST.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AdminApiError, createAdminClient, type AdminClient, type NewStoreInput } from '../../admin/src/lib/api';
import { createSupabaseLikeDb, pgTargetFromEnv, postgrestFetch, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_painel_admin_test';
const ROOT = join(__dirname, '..', '..');
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HAND_TENANT = '11111111-1111-4111-8111-111111111111';
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

function clientFor(claims: Record<string, unknown>): AdminClient {
  return createAdminClient(CFG, async () => 'token', postgrestFetch(target!, DB, claims));
}

const admin = () => clientFor({ role: 'authenticated', sub: ADMIN, email: 'will@tchefood.test' });

async function rejects(p: Promise<unknown>, pattern: RegExp, status?: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `esperava erro ${pattern}`).toBeInstanceOf(AdminApiError);
  expect((err as AdminApiError).message).toMatch(pattern);
  if (status) expect((err as AdminApiError).status).toBe(status);
}

function setToday(day: string) {
  sql(`CREATE OR REPLACE FUNCTION tchefood_admin_today() RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT '${day}'::date $$;`);
}

const store = (over: Partial<NewStoreInput> = {}): NewStoreInput => ({
  name: 'Lancheria do Teste',
  legalName: 'Lancheria do Teste Ltda',
  cnpj: '11.444.777/0001-61',
  city: 'Santo Ângelo',
  state: 'RS',
  planId: 'salao-pro',
  monthlyPrice: null,
  billingDay: 10,
  trialDays: 15,
  contactName: 'Maria da Silva',
  contactPhone: '(55) 99653-8255',
  contactEmail: 'maria@exemplo.com',
  notes: '',
  ...over,
});

(target ? describe : describe.skip)('painel administrativo no banco real', () => {
  let tenant = '';

  beforeAll(() => {
    applySchema(target!, DB);
    sql(`INSERT INTO platform_admins (user_id, email, name) VALUES ('${ADMIN}', 'will@tchefood.test', 'Will');`);
    // Loja criada à mão no Supabase (como a do piloto), sem assinatura.
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${HAND_TENANT}', 'Flip Teste', 'Flip Teste Ltda', '11222333000181');`);
    setToday('2026-11-14');
  });

  it('só admin ativo, com token sem loja, chama o painel; tabelas fechadas para todos os tokens', async () => {
    expect((await admin().me()).name).toBe('Will');
    // Token do aparelho da loja: mesmo com o sub do admin, não é admin.
    await rejects(clientFor({ role: 'authenticated', sub: ADMIN, tenant_id: HAND_TENANT }).me(), /acesso restrito/, 403);
    await rejects(clientFor({ role: 'authenticated', sub: ADMIN, app_metadata: { tenant_id: HAND_TENANT } }).stores(), /acesso restrito/, 403);
    await rejects(clientFor({ role: 'authenticated', sub: OTHER_USER }).overview(), /acesso restrito/, 403);
    await rejects(clientFor({ role: 'anon' }).stores(), /acesso restrito/, 403);
    await rejects(clientFor({ role: 'authenticated', sub: 'nao-e-uuid' }).me(), /acesso restrito/, 403);
    await rejects(clientFor({ role: 'authenticated', sub: OTHER_USER }).createStore(store()), /acesso restrito/, 403);

    for (const claims of [
      { role: 'authenticated', sub: ADMIN },
      { role: 'authenticated', sub: 'device', tenant_id: HAND_TENANT },
    ]) {
      const f = postgrestFetch(target!, DB, claims);
      for (const table of ['platform_admins', 'store_subscriptions', 'store_charges', 'platform_admin_audit', 'platform_plans']) {
        const r = await f(`http://cloud.test/rest/v1/${table}?select=*`, { method: 'GET', headers: {} });
        expect(r.status, `${table} GET`).toBe(403);
      }
      const ins = await f('http://cloud.test/rest/v1/platform_admins', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: OTHER_USER, email: 'x@x.com', name: 'Intruso' }),
      });
      expect(ins.status).toBe(403);
    }
    // Funções de apoio não são chamáveis de fora.
    const f = postgrestFetch(target!, DB, { role: 'authenticated', sub: ADMIN });
    const r = await f('http://cloud.test/rest/v1/rpc/tchefood_admin_log', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ p_admin: ADMIN, p_tenant: null, p_charge: null, p_action: 'X', p_reason: null, p_details: {} }),
    });
    expect(r.status).toBe(403);

    // Admin desativado perde o acesso.
    sql(`UPDATE platform_admins SET active = FALSE WHERE user_id = '${ADMIN}'`);
    await rejects(admin().me(), /acesso restrito/, 403);
    sql(`UPDATE platform_admins SET active = TRUE WHERE user_id = '${ADMIN}'`);
  });

  it('loja nova: CNPJ conferido, loja e assinatura em teste juntas, com histórico; CNPJ repetido recusado', async () => {
    await rejects(admin().createStore(store({ cnpj: '11.444.777/0001-62' })), /CNPJ inválido/);
    await rejects(admin().createStore(store({ cnpj: '11111111111111' })), /CNPJ inválido/);
    await rejects(admin().createStore(store({ billingDay: 31 })), /dia de cobrança entre 1 e 28/);
    await rejects(admin().createStore(store({ contactPhone: '9965' })), /telefone/);
    await rejects(admin().createStore(store({ planId: 'nao-existe' })), /plano inválido/);
    expect(sql(`SELECT count(*) FROM tenants`)).toBe('1');

    tenant = await admin().createStore(store());
    const detail = await admin().store(tenant);
    expect(detail.cnpj).toBe('11444777000161');
    expect(detail.subscription).toMatchObject({ status: 'TRIAL', plan_id: 'salao-pro', monthly_price: 199, billing_day: 10, trial_ends_on: '2026-11-29', contact_phone: '55996538255' });
    expect(detail.audit.map((a) => a.action)).toEqual(['STORE_CREATED']);
    expect(detail.audit[0]!.admin_name).toBe('Will');

    await rejects(admin().createStore(store({ name: 'Outra' })), /já existe loja com este CNPJ/);
    expect(sql(`SELECT count(*) FROM tenants`)).toBe('2');

    // Sem dias de teste: começa ativa, com o preço negociado.
    const active = await admin().createStore(store({ cnpj: '12345678000195', name: 'Churrascaria Ativa', trialDays: 0, monthlyPrice: '149.90' }));
    expect((await admin().store(active)).subscription).toMatchObject({ status: 'ACTIVE', monthly_price: 149.9, trial_ends_on: null });
  });

  it('loja feita à mão no Supabase aparece sem assinatura; assinatura criada com motivo', async () => {
    const rows = await admin().stores();
    const hand = rows.find((r) => r.tenant_id === HAND_TENANT)!;
    expect(hand.subscription).toBeNull();
    expect((await admin().overview()).stores.without_subscription).toBe(1);

    const input = {
      planId: 'bistro', monthlyPrice: '0.00', status: 'ACTIVE' as const, billingDay: 5, trialEndsOn: null,
      contactName: 'Dono do Flip', contactPhone: '55999990000', contactEmail: '', notes: 'Piloto', reason: '',
    };
    await rejects(admin().saveSubscription(HAND_TENANT, input), /motivo/);
    const sub = await admin().saveSubscription(HAND_TENANT, { ...input, reason: 'Piloto gratuito combinado' });
    expect(sub).toMatchObject({ status: 'ACTIVE', monthly_price: 0, plan_id: 'bistro' });
    await rejects(admin().saveSubscription(HAND_TENANT, { ...input, status: 'TRIAL', reason: 'Volta ao teste' }), /fim do teste/);
    const audit = (await admin().store(HAND_TENANT)).audit;
    expect(audit[0]).toMatchObject({ action: 'SUBSCRIPTION_CREATED', reason: 'Piloto gratuito combinado' });
    // Cortesia (preço zero) não entra na geração do mês.
  });

  it('cobrança: uma por mês, pagamento só com o valor exato e referência; pagar ativa a loja em teste; reenvio não duplica', async () => {
    await rejects(admin().createCharge(tenant, '2026-11-01', '0', null, null), /valor da cobrança inválido/);
    await rejects(admin().createCharge(tenant, '2026-11-01', null, null, 'http://inseguro.com'), /https/);
    const chargeId = await admin().createCharge(tenant, '2026-11-14', null, null, 'https://www.asaas.com/i/abc');
    let charge = (await admin().store(tenant)).charges[0]!;
    expect(charge).toMatchObject({ id: chargeId, reference_month: '2026-11-01', amount: 199, due_date: '2026-11-10', status: 'OPEN' });
    await rejects(admin().createCharge(tenant, '2026-11-20', null, null, null), /já existe cobrança deste mês/);

    // Vencida (vence 10/11, hoje 14/11): conta como vencida e entra na lista do dia com 4 dias de atraso.
    const ov = await admin().overview();
    expect(ov).toMatchObject({ overdue_count: 1, overdue_amount: 199, open_amount: 199, open_count: 1 });
    const due = await admin().chargesDue(3);
    expect(due.find((d) => d.id === chargeId)).toMatchObject({ days_late: 4, contact_phone: '55996538255', store_name: 'Lancheria do Teste' });

    await rejects(admin().recordPayment(chargeId, '199.01', '2026-11-13', 'PIX', 'E123456789'), /diferente do valor da cobrança/);
    await rejects(admin().recordPayment(chargeId, '190.00', '2026-11-13', 'PIX', 'E123456789'), /diferente do valor da cobrança/);
    await rejects(admin().recordPayment(chargeId, '199.00', '2026-11-13', 'PIX', ' ab '), /referência/);
    await rejects(admin().recordPayment(chargeId, '199.00', '2026-11-15', 'PIX', 'E123456789'), /futura/);
    await rejects(admin().recordPayment(chargeId, '199.00', '2026-11-13', 'CHEQUE' as never, 'E123456789'), /forma de pagamento/);
    expect(sql(`SELECT status FROM store_charges WHERE id = '${chargeId}'`)).toBe('OPEN');

    const paid = await admin().recordPayment(chargeId, '199.00', '2026-11-13', 'PIX', 'E123456789');
    expect(paid).toMatchObject({ status: 'PAID', subscription_status: 'ACTIVE', replayed: false });
    // Resposta perdida: o mesmo pagamento de novo devolve o que já foi gravado.
    expect(await admin().recordPayment(chargeId, '199.00', '2026-11-13', 'PIX', 'e123456789')).toMatchObject({ replayed: true });
    await rejects(admin().recordPayment(chargeId, '199.00', '2026-11-13', 'PIX', 'OUTRA-REF'), /já foi paga com outros dados/);
    expect(sql(`SELECT count(*) FROM platform_admin_audit WHERE action = 'CHARGE_PAID'`)).toBe('1');

    charge = (await admin().store(tenant)).charges[0]!;
    expect(charge).toMatchObject({ status: 'PAID', paid_amount: 199, payment_method: 'PIX', payment_reference: 'E123456789', paid_on: '2026-11-13' });
    expect((await admin().store(tenant)).subscription!.status).toBe('ACTIVE');
    expect(await admin().overview()).toMatchObject({ overdue_count: 0, open_amount: 0, received_this_month: 199, mrr: 199 + 149.9 });

    // Paga não é cancelada nem alterada, nem pelo dono do banco direto.
    await rejects(admin().cancelCharge(chargeId, 'Cliente pediu'), /só cobrança em aberto/);
    expect(psql(target!, `UPDATE store_charges SET amount = 1 WHERE id = '${chargeId}'`, DB).message).toMatch(/já está fechada/);
    expect(psql(target!, `DELETE FROM store_charges WHERE id = '${chargeId}'`, DB).message).toMatch(/não é apagada/);

    // A mesma referência não quita outra cobrança.
    const dec = await admin().createCharge(tenant, '2026-12-01', null, null, null);
    await rejects(admin().recordPayment(dec, '199.00', '2026-11-14', 'PIX', 'E123456789'), /já quitou outra cobrança/);
    // Cobrança em aberto: valor e vencimento não mudam direto; cancelamento pede motivo.
    expect(psql(target!, `UPDATE store_charges SET amount = 1 WHERE id = '${dec}'`, DB).message).toMatch(/não mudam/);
    await rejects(admin().cancelCharge(dec, 'ok'), /motivo/);
    await admin().cancelCharge(dec, 'Lançada por engano');
    await rejects(admin().recordPayment(dec, '199.00', '2026-11-14', 'PIX', 'E999'), /cancelada não recebe/);
    // Cancelada pode ser refeita no mesmo mês.
    expect(await admin().createCharge(tenant, '2026-12-01', '99.00', '2026-12-05', null)).toMatch(/^[0-9a-f-]{36}$/);

    // Histórico só cresce.
    expect(psql(target!, `UPDATE platform_admin_audit SET reason = 'x'`, DB).message).toMatch(/só recebe linhas novas/);
    expect(psql(target!, `DELETE FROM platform_admin_audit`, DB).message).toMatch(/só recebe linhas novas/);
    expect(psql(target!, `TRUNCATE platform_admin_audit`, DB).message).toMatch(/só recebe linhas novas/);
  });

  it('loja suspensa volta a ativa ao pagar; cancelada não gera cobrança', async () => {
    const sub = (await admin().store(tenant)).subscription!;
    const base = {
      planId: sub.plan_id, monthlyPrice: '199.00', billingDay: sub.billing_day, trialEndsOn: sub.trial_ends_on,
      contactName: sub.contact_name, contactPhone: sub.contact_phone, contactEmail: sub.contact_email ?? '', notes: '',
    };
    await admin().saveSubscription(tenant, { ...base, status: 'SUSPENDED', reason: 'Atraso de janeiro' });
    const jan = await admin().createCharge(tenant, '2027-01-01', null, null, null);
    setToday('2027-01-20');
    expect(await admin().recordPayment(jan, '199.00', '2027-01-20', 'BOLETO', '00190000090')).toMatchObject({ subscription_status: 'ACTIVE' });
    await admin().saveSubscription(tenant, { ...base, status: 'CANCELLED', reason: 'Loja fechou' });
    await rejects(admin().createCharge(tenant, '2027-02-01', null, null, null), /cancelada não gera cobrança/);
    setToday('2026-11-14');
  });

  it('cobranças do mês em lote: só lojas ativas com preço, sem repetir', async () => {
    const created = await admin().generateMonth('2027-03-15');
    // Ativas com preço: só a "Churrascaria Ativa" (a do teste foi cancelada; o Flip é cortesia).
    expect(created).toBe(1);
    expect(await admin().generateMonth('2027-03-01')).toBe(0);
    const row = sql(`SELECT amount || ' ' || due_date FROM store_charges c JOIN tenants t ON t.id = c.tenant_id WHERE t.cnpj = '12345678000195' AND reference_month = '2027-03-01'`);
    expect(row).toBe('149.90 2027-03-10');
  });

  it('conta do aparelho: reserva repetida devolve a mesma; confirmação só com o id reservado', async () => {
    const active = sql(`SELECT id FROM tenants WHERE cnpj = '12345678000195'`);
    await rejects(admin().store('00000000-0000-4000-8000-000000000000'), /não encontrada/);
    const f = postgrestFetch(target!, DB, { role: 'authenticated', sub: ADMIN });
    const call = async (fn: string, body: unknown) => {
      const r = await f(`http://cloud.test/rest/v1/rpc/${fn}`, { method: 'POST', headers: {}, body: JSON.stringify(body) });
      return { status: r.status, body: JSON.parse((await r.text()) || 'null') as Record<string, unknown> };
    };
    expect((await call('tchefood_admin_reserve_device', { p_tenant: active, p_email: 'will@tchefood.test' })).body.message).toMatch(/admin do painel/);
    const r1 = await call('tchefood_admin_reserve_device', { p_tenant: active, p_email: 'Loja-12345678000195@aparelho.tchefood.com.br' });
    expect(r1.body).toMatchObject({ email: 'loja-12345678000195@aparelho.tchefood.com.br', status: 'PENDING' });
    const r2 = await call('tchefood_admin_reserve_device', { p_tenant: active, p_email: 'outro@x.com' });
    expect(r2.body.user_id).toBe(r1.body.user_id);
    // Outra loja não pega o mesmo e-mail.
    expect((await call('tchefood_admin_reserve_device', { p_tenant: HAND_TENANT, p_email: 'loja-12345678000195@aparelho.tchefood.com.br' })).body.message).toMatch(/já é de outra loja/);
    // Troca da reserva pendente (e-mail recusado pelo Auth): só com o id reservado.
    expect((await call('tchefood_admin_reserve_device', { p_tenant: active, p_email: 'novo@x.com', p_replace_user_id: OTHER_USER })).body.message).toMatch(/reserva da conta do aparelho mudou/);
    const r3 = await call('tchefood_admin_reserve_device', { p_tenant: active, p_email: 'novo@x.com', p_replace_user_id: r1.body.user_id });
    expect(r3.body).toMatchObject({ email: 'novo@x.com', status: 'PENDING' });
    expect(r3.body.user_id).not.toBe(r1.body.user_id);
    expect(sql(`SELECT details->>'replaced_email' FROM platform_admin_audit WHERE action = 'DEVICE_ACCOUNT_RESERVED' ORDER BY created_at DESC LIMIT 1`)).toBe('loja-12345678000195@aparelho.tchefood.com.br');
    // O e-mail antigo fica livre para outra loja.
    expect((await call('tchefood_admin_confirm_device', { p_tenant: active, p_user_id: r1.body.user_id, p_action: 'CREATED' })).body.message).toMatch(/não confere/);
    const r4 = await call('tchefood_admin_reserve_device', { p_tenant: active, p_email: 'Loja-12345678000195@aparelho.tchefood.com.br', p_replace_user_id: r3.body.user_id });
    expect(r4.body.email).toBe('loja-12345678000195@aparelho.tchefood.com.br');
    r1.body.user_id = r4.body.user_id;
    expect((await call('tchefood_admin_confirm_device', { p_tenant: active, p_user_id: OTHER_USER, p_action: 'CREATED' })).body.message).toMatch(/não confere/);
    expect((await call('tchefood_admin_confirm_device', { p_tenant: active, p_user_id: r1.body.user_id, p_action: 'CREATED' })).status).toBe(200);
    expect((await admin().store(active)).subscription).toMatchObject({ device_status: 'READY', device_email: 'loja-12345678000195@aparelho.tchefood.com.br' });
    // Conta pronta nunca é trocada.
    expect((await call('tchefood_admin_reserve_device', { p_tenant: active, p_email: 'x@y.com', p_replace_user_id: r1.body.user_id })).body.message).toMatch(/reserva da conta do aparelho mudou/);
    // O token do aparelho não reserva conta.
    const dev = postgrestFetch(target!, DB, { role: 'authenticated', sub: 'device', tenant_id: active });
    const r = await dev('http://cloud.test/rest/v1/rpc/tchefood_admin_reserve_device', { method: 'POST', headers: {}, body: JSON.stringify({ p_tenant: active, p_email: 'a@b.com' }) });
    expect(r.status).toBe(403);
  });

  it('uso da loja: última venda e pedidos dos últimos 7 dias', async () => {
    const rows = await admin().stores();
    const hand = rows.find((x) => x.tenant_id === HAND_TENANT)!;
    expect(hand).toMatchObject({ last_order_at: null, orders_7d: 0, staff_active: 0 });
  });
});
