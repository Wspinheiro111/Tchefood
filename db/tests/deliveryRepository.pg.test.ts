/**
 * Pedidos do iFood gravados pelo servidor de polling no banco de verdade.
 *
 * Monta um Postgres igual ao Supabase (db/schema.sql + supabase/migrations), liga uma loja
 * ao merchantId do iFood de testes e roda a caixa de entrada (o mesmo código do servidor)
 * gravando pelas funções tchefood_delivery_* com o papel service_role, por um emulador do
 * PostgREST. Confere também que o app (authenticated) só lê.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeliveryConcurrencyError, DeliveryInbox } from '../../server/delivery/deliveryInbox';
import { IfoodMerchantApi } from '../../server/delivery/ifood/ifoodMerchantApi';
import { IfoodSandbox } from '../../server/delivery/ifood/ifoodSandbox';
import { SupabaseDeliveryRepository, type RestFetch } from '../../server/delivery/supabaseDeliveryRepository';
import { createSupabaseLikeDb, pgTargetFromEnv, postgrestFetch, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_delivery_repo_test';
const ROOT = join(__dirname, '..', '..');
const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ITEMS = [{ name: 'Xis Galpão', externalCode: '301', quantity: 2, unitPrice: 38.5 }];

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

const serviceFetch = () => postgrestFetch(target!, DB, { role: 'service_role' }) as unknown as RestFetch;
const appFetch = (tenant: string) => postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: tenant, sub: 'device' });

// Um simulador só: os ids de pedido dele seguem uma sequência e não podem repetir entre os testes.
let sharedSandbox: IfoodSandbox | null = null;

function setup() {
  const sandbox = (sharedSandbox ??= new IfoodSandbox());
  const api = new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
  });
  const repository = new SupabaseDeliveryRepository({ url: 'http://cloud.test', serviceRoleKey: 'service', channel: 'ifood', fetchImpl: serviceFetch() });
  const inbox = new DeliveryInbox({ adapters: [api], repository });
  return { sandbox, api, repository, inbox };
}

(target ? describe : describe.skip)('pedidos do iFood no banco real (Postgres + migrations)', () => {
  let merchantId = '';

  beforeAll(() => {
    applySchema(target!, DB);
    merchantId = new IfoodSandbox().merchantId;
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES
           ('${TENANT}', 'Flip', 'Flip Ltda', '11222333000181'),
           ('${OTHER}', 'Outra', 'Outra Ltda', '11444777000161');
         INSERT INTO delivery_integrations (tenant_id, channel, merchant_external_id) VALUES ('${TENANT}', 'ifood', '${merchantId}');`);
  });

  it('polling grava pedido, eventos e versões; repetir o evento não duplica', async () => {
    const { sandbox, api, repository, inbox } = setup();
    expect(await repository.activeMerchants()).toEqual([{ tenantId: TENANT, merchantExternalId: merchantId }]);
    const id = sandbox.placeOrder({ items: ITEMS });
    const report = await inbox.runChannel(api);
    expect(report).toMatchObject({ received: 1, acknowledged: 1 });
    expect(sql(`SELECT tenant_id || '|' || status || '|' || total_amount FROM delivery_orders WHERE external_id = '${id}'`))
      .toBe(`${TENANT}|placed|77.00`);
    expect(sql(`SELECT count(*) FROM delivery_events WHERE external_order_id = '${id}'`)).toBe('1');

    await inbox.performAction('ifood', id, 'confirm');
    await inbox.runChannel(api);
    const record = await repository.getOrder('ifood', id);
    expect(record?.order.status).toBe('confirmed');
    expect(record!.version).toBeGreaterThanOrEqual(2);
    expect(Number(sql(`SELECT count(*) FROM delivery_events WHERE external_order_id = '${id}'`))).toBe(2);

    // Mesmo evento outra vez (ack perdido): não duplica.
    const [event] = (await sql(`SELECT external_event_id FROM delivery_events WHERE external_order_id = '${id}' LIMIT 1`)).split('\n');
    await repository.recordEvent({ channel: 'ifood', externalEventId: event!, externalOrderId: id, merchantExternalId: merchantId, rawCode: 'PLC', signal: 'placed', createdAt: new Date().toISOString(), dispute: null });
    expect(Number(sql(`SELECT count(*) FROM delivery_events WHERE external_order_id = '${id}'`))).toBe(2);
    expect(await repository.hasEvent('ifood', event!)).toBe(true);
    expect((await repository.listOrders()).map((r) => r.order.externalId)).toContain(id);
  });

  it('gravação com versão velha não grava nada', async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runChannel(api);
    const stale = (await repository.getOrder('ifood', id))!;
    const fresh = (await repository.getOrder('ifood', id))!;
    fresh.needsReview = true;
    fresh.version = await repository.saveOrder(fresh);
    stale.cancellationPending = true;
    await expect(repository.saveOrder(stale)).rejects.toBeInstanceOf(DeliveryConcurrencyError);
    expect(sql(`SELECT needs_review || '|' || cancellation_pending FROM delivery_orders WHERE external_id = '${id}'`)).toBe('true|false');
    // Pedido novo repetido (outro processo gravou primeiro) também é conflito, não erro.
    const again = { ...stale, version: 0 };
    await expect(repository.saveOrder(again)).rejects.toBeInstanceOf(DeliveryConcurrencyError);
  });

  it('o dono e o total não mudam depois de gravados', async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runChannel(api);
    const record = (await repository.getOrder('ifood', id))!;
    record.order = { ...record.order, totals: { ...record.order.totals, orderCents: 1 } };
    await repository.saveOrder(record);
    expect(sql(`SELECT tenant_id || '|' || total_amount FROM delivery_orders WHERE external_id = '${id}'`)).toBe(`${TENANT}|77.00`);
  });

  it('pedido de loja não ligada é recusado e fica sem ack', async () => {
    const sandbox = new IfoodSandbox(undefined, '99999999-9999-4999-8999-999999999999');
    const api = new IfoodMerchantApi({ credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret }, baseUrl: sandbox.baseUrl, fetchImpl: sandbox.fetch });
    const repository = new SupabaseDeliveryRepository({ url: 'http://cloud.test', serviceRoleKey: 'service', channel: 'ifood', fetchImpl: serviceFetch() });
    const inbox = new DeliveryInbox({ adapters: [api], repository });
    // Pula os ids que o outro simulador já usou (a sequência é a mesma).
    for (let i = 0; i < 20; i += 1) sandbox.placeOrder({ items: ITEMS });
    const report = await inbox.runChannel(api);
    expect(report.deferred).toBeGreaterThan(0);
    expect(report.error).toMatch(/não está ligada/);
    expect(sql(`SELECT count(*) FROM delivery_orders WHERE payload->>'merchantExternalId' = '99999999-9999-4999-8999-999999999999'`)).toBe('0');
  });

  it('o app lê só os pedidos da própria loja e não grava nem chama as funções do servidor', async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runChannel(api);
    const own = await appFetch(TENANT)(`http://cloud.test/rest/v1/delivery_orders?external_id=eq.${id}&select=tenant_id`, { method: 'GET', headers: {} });
    expect(JSON.parse(await own.text())).toHaveLength(1);
    const foreign = await appFetch(OTHER)(`http://cloud.test/rest/v1/delivery_orders?external_id=eq.${id}&select=tenant_id`, { method: 'GET', headers: {} });
    expect(JSON.parse(await foreign.text())).toHaveLength(0);

    const forged = await appFetch(TENANT)('http://cloud.test/rest/v1/delivery_orders', {
      method: 'POST', headers: {},
      body: JSON.stringify({ tenant_id: TENANT, channel: 'ifood', external_id: 'forjado', display_id: '1', status: 'new', total_amount: 1, payload: {}, placed_at: new Date().toISOString() }),
    });
    expect(forged.ok).toBe(false);
    const patched = await appFetch(TENANT)(`http://cloud.test/rest/v1/delivery_orders?external_id=eq.${id}`, { method: 'PATCH', headers: {}, body: JSON.stringify({ status: 'cancelled' }) });
    expect(patched.ok).toBe(false);
    expect(sql(`SELECT status FROM delivery_orders WHERE external_id = '${id}'`)).toBe('placed');

    for (const fn of ['tchefood_delivery_save_order', 'tchefood_delivery_active_merchants', 'tchefood_delivery_record_event']) {
      const body = fn === 'tchefood_delivery_save_order' ? { p_channel: 'ifood', p_expected_version: 0, p_record: {} } : fn === 'tchefood_delivery_record_event' ? { p_event: {} } : { p_channel: 'ifood' };
      const res = await appFetch(TENANT)(`http://cloud.test/rest/v1/rpc/${fn}`, { method: 'POST', headers: {}, body: JSON.stringify(body) });
      expect(res.ok, fn).toBe(false);
    }
    const integration = await appFetch(TENANT)('http://cloud.test/rest/v1/delivery_integrations', {
      method: 'POST', headers: {}, body: JSON.stringify({ tenant_id: TENANT, channel: 'ifood', merchant_external_id: 'outro-merchant' }),
    });
    expect(integration.ok).toBe(false);
  });
});
