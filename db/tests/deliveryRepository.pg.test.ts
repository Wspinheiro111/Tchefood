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
const OTHER_MERCHANT = '88888888-8888-4888-8888-888888888888';
const MANAGER = '44444444-4444-4444-8444-444444444444';
const CASHIER = '55555555-5555-4555-8555-555555555555';
const OTHER_MANAGER = '66666666-6666-4666-8666-666666666666';
const OTHER_CASHIER = '77777777-7777-4777-8777-777777777777';
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
         INSERT INTO delivery_integrations (tenant_id, channel, merchant_external_id) VALUES ('${TENANT}', 'ifood', '${merchantId}'),
           ('${OTHER}', 'ifood', '${OTHER_MERCHANT}');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES
           ('${MANAGER}', '${TENANT}', 'Gerente', 'MANAGER', '7391'),
           ('${CASHIER}', '${TENANT}', 'Caixa', 'CASHIER', '5162'),
           ('${OTHER_MANAGER}', '${OTHER}', 'Gerente da outra', 'MANAGER', '4826'),
           ('${OTHER_CASHIER}', '${OTHER}', 'Caixa da outra', 'CASHIER', '6273');`);
  });

  it('polling grava pedido, eventos e versões; repetir o evento não duplica', async () => {
    const { sandbox, api, repository, inbox } = setup();
    expect((await repository.activeMerchants()).filter((m) => m.tenantId === TENANT)).toEqual([{ tenantId: TENANT, merchantExternalId: merchantId }]);
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

  it('merchantId com espaço ou caractere fora do padrão não entra em delivery_integrations', () => {
    expect(() => sql(`INSERT INTO delivery_integrations (tenant_id, channel, merchant_external_id) VALUES ('${TENANT}', 'ifood', 'abc ')`)).toThrow(/merchant_format/);
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

  it('a reserva do pedido de cancelamento passa pelas funções de leitura e gravação', async () => {
    const { sandbox, api, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    try {
      const id = sandbox.placeOrder({ items: ITEMS });
      await inbox.runChannel(api);
      const [reason] = await inbox.listCancellationReasons('ifood', id);
      const result = await inbox.requestCancellation('ifood', id, reason!);
      expect(result.cancellationRequest).toMatchObject({ state: 'sent', code: reason!.code });
      expect(sql(`SELECT cancellation_request->>'state' || '|' || cancellation_pending FROM delivery_orders WHERE external_id = '${id}'`)).toBe('sent|true');
      expect((await repository.getOrder('ifood', id))!.cancellationRequest).toMatchObject({ state: 'sent', code: reason!.code });
      expect((await repository.listOrders()).find((r) => r.order.externalId === id)!.cancellationRequest?.state).toBe('sent');
      // Segunda tentativa (outro aparelho): recusada pela reserva gravada no banco, sem chamar o iFood.
      await expect(inbox.requestCancellation('ifood', id, reason!)).rejects.toMatchObject({ code: 'conflict' });
      // O evento do app (CAR) zera a reserva.
      await inbox.runChannel(api);
      expect(sql(`SELECT coalesce(cancellation_request::text, 'null') FROM delivery_orders WHERE external_id = '${id}'`)).toBe('null');
    } finally {
      sandbox.autoAcceptCancellation = true;
    }
  });

  it('o app não grava registros de delivery em audit_logs; o servidor grava', async () => {
    const base = { tenant_id: TENANT, performed_by_user_id: CASHIER, reason: 'forjado', metadata: { outcome: 'sent' } };
    for (const action of ['DELIVERY_RESULT', 'DELIVERY_CANCEL', 'DELIVERY_DISPUTE', 'DELIVERY_PAUSE', 'DELIVERY_RESUME']) {
      const res = await appFetch(TENANT)('http://cloud.test/rest/v1/audit_logs', { method: 'POST', headers: {}, body: JSON.stringify({ ...base, action_type: action }) });
      expect(res.ok, action).toBe(false);
    }
    expect(sql(`SELECT count(*) FROM audit_logs WHERE reason = 'forjado'`)).toBe('0');
    // Os outros registros do aparelho seguem passando.
    const normal = await appFetch(TENANT)('http://cloud.test/rest/v1/audit_logs', { method: 'POST', headers: {}, body: JSON.stringify({ ...base, reason: 'registro normal', action_type: 'DRAWER_OPENED' }) });
    expect(normal.ok).toBe(true);
    // O servidor (service_role) grava.
    const server = await serviceFetch()('http://cloud.test/rest/v1/audit_logs', { method: 'POST', headers: {}, body: JSON.stringify({ ...base, reason: 'do servidor', action_type: 'DELIVERY_RESULT' }) });
    expect(server.ok).toBe(true);
    expect(sql(`SELECT count(*) FROM audit_logs WHERE reason = 'do servidor' AND action_type = 'DELIVERY_RESULT'`)).toBe('1');
  });

  describe('alçada de gerente (tchefood_delivery_authorize)', () => {
    const DETAILS: Record<string, unknown> = {
      DELIVERY_CANCEL: { code: '503' },
      DELIVERY_DISPUTE: { kind: 'accept' },
      DELIVERY_PAUSE: { minutes: 30, description: 'Falta de gás' },
      DELIVERY_RESUME: { pauseId: 'p-1' },
    };
    async function authorize(tenant: string, args: Record<string, unknown>) {
      const action = (args.p_action as string | undefined) ?? 'DELIVERY_CANCEL';
      const res = await appFetch(tenant)('http://cloud.test/rest/v1/rpc/tchefood_delivery_authorize', {
        method: 'POST', headers: {},
        body: JSON.stringify({
          p_channel: 'ifood', p_action: 'DELIVERY_CANCEL', p_external_order_id: null, p_merchant_external_id: null,
          p_manager_pin: '7391', p_performed_by: CASHIER, p_reason: 'Cliente desistiu', p_request_id: crypto.randomUUID(),
          p_details: DETAILS[action] ?? {}, ...args,
        }),
      });
      const text = await res.text();
      return { ok: res.ok, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
    }

    it('PIN de gerente certo grava a autorização; reenvio devolve a mesma; outro alvo com o mesmo id é conflito', async () => {
      const { sandbox, api, inbox } = setup();
      const id = sandbox.placeOrder({ items: ITEMS });
      const other = sandbox.placeOrder({ items: ITEMS });
      await inbox.runChannel(api);
      const requestId = crypto.randomUUID();
      const first = await authorize(TENANT, { p_external_order_id: id, p_request_id: requestId });
      expect(first.body).toMatchObject({ status: 'OK' });
      const auditId = first.body!.auditId as string;
      expect(sql(`SELECT action_type || '|' || authorized_by_manager_id || '|' || performed_by_user_id || '|' || (metadata->>'external_order_id') FROM audit_logs WHERE id = '${auditId}'`))
        .toBe(`DELIVERY_CANCEL|${MANAGER}|${CASHIER}|${id}`);
      const again = await authorize(TENANT, { p_external_order_id: id, p_request_id: requestId });
      expect(again.body).toMatchObject({ status: 'OK', auditId, repeated: true, lastOutcome: null });
      expect((await authorize(TENANT, { p_external_order_id: other, p_request_id: requestId })).body).toEqual({ status: 'CONFLICT' });
      // O que o gerente aprovou fica gravado; reenvio com outro motivo do iFood ou outro motivo escrito é conflito.
      expect(sql(`SELECT metadata->'details'->>'code' FROM audit_logs WHERE id = '${auditId}'`)).toBe('503');
      expect((await authorize(TENANT, { p_external_order_id: id, p_request_id: requestId, p_details: { code: '501' } })).body).toEqual({ status: 'CONFLICT' });
      expect((await authorize(TENANT, { p_external_order_id: id, p_request_id: requestId, p_reason: 'Outro motivo qualquer' })).body).toEqual({ status: 'CONFLICT' });
      expect(sql(`SELECT count(*) FROM audit_logs WHERE metadata->>'delivery_request_id' = '${requestId}'`)).toBe('1');
      // Sem o que foi aprovado (ou com formato errado para a ação), nada é autorizado.
      expect((await authorize(TENANT, { p_external_order_id: id, p_details: null })).ok).toBe(false);
      expect((await authorize(TENANT, { p_external_order_id: id, p_details: { kind: 'accept' } })).ok).toBe(false);
      expect((await authorize(TENANT, { p_action: 'DELIVERY_PAUSE', p_merchant_external_id: merchantId, p_details: { minutes: 0, description: 'x' } })).ok).toBe(false);

      // Resultado: só o servidor grava; o app não chama a função.
      const denied = await appFetch(TENANT)('http://cloud.test/rest/v1/rpc/tchefood_delivery_audit_result', {
        method: 'POST', headers: {}, body: JSON.stringify({ p_audit_id: auditId, p_outcome: 'sent', p_detail: 'x' }),
      });
      expect(denied.ok).toBe(false);
      const recorded = await serviceFetch()('http://cloud.test/rest/v1/rpc/tchefood_delivery_audit_result', {
        method: 'POST', headers: {}, body: JSON.stringify({ p_audit_id: auditId, p_outcome: 'sent', p_detail: 'HTTP 200' }),
      });
      expect(recorded.ok).toBe(true);
      expect(sql(`SELECT metadata->>'outcome' || '|' || (metadata->>'action') FROM audit_logs WHERE action_type = 'DELIVERY_RESULT' AND metadata->>'authorization_id' = '${auditId}'`))
        .toBe('sent|DELIVERY_CANCEL');
      // Reenvio depois do resultado: o servidor fica sabendo o que aconteceu com a tentativa.
      expect((await authorize(TENANT, { p_external_order_id: id, p_request_id: requestId })).body)
        .toMatchObject({ status: 'OK', auditId, repeated: true, lastOutcome: 'sent' });
    });

    it('PIN de caixa, motivo curto, pedido de outra loja e loja do app de outra loja não autorizam', async () => {
      const { sandbox, api, inbox } = setup();
      const id = sandbox.placeOrder({ items: ITEMS });
      await inbox.runChannel(api);
      const before = sql(`SELECT count(*) FROM audit_logs WHERE authorized_by_manager_id IS NOT NULL AND action_type LIKE 'DELIVERY_%'`);
      expect((await authorize(TENANT, { p_external_order_id: id, p_manager_pin: '5162' })).body).toEqual({ status: 'PIN_FAILED' });
      expect((await authorize(TENANT, { p_external_order_id: id, p_reason: 'ok' })).ok).toBe(false);
      // A outra loja, com o PIN do gerente dela, não age no pedido nem na loja do app desta.
      expect((await authorize(OTHER, { p_external_order_id: id, p_manager_pin: '4826', p_performed_by: OTHER_CASHIER })).ok).toBe(false);
      expect((await authorize(OTHER, { p_action: 'DELIVERY_PAUSE', p_merchant_external_id: merchantId, p_manager_pin: '4826', p_performed_by: OTHER_CASHIER })).ok).toBe(false);
      // Operador de outra loja também não.
      expect((await authorize(TENANT, { p_external_order_id: id, p_performed_by: OTHER_CASHIER })).ok).toBe(false);
      // Ação de pedido sem pedido, ou de loja com pedido: recusada.
      expect((await authorize(TENANT, { p_action: 'DELIVERY_PAUSE', p_external_order_id: id })).ok).toBe(false);
      expect((await authorize(TENANT, { p_action: 'ITEM_CANCELED', p_external_order_id: id })).ok).toBe(false);
      expect(sql(`SELECT count(*) FROM audit_logs WHERE authorized_by_manager_id IS NOT NULL AND action_type LIKE 'DELIVERY_%'`)).toBe(before);
      expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`))).toBeGreaterThanOrEqual(1);
      // Limpa as falhas desta loja para os próximos testes (audit_logs é só de inserção: trigger desligado só aqui).
      sql(`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable; DELETE FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'; ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable;`);
    });

    it('3 PINs errados em 60 s bloqueiam até o PIN certo (mesmo bloqueio do PIN de gerente)', async () => {
      const pause = { p_action: 'DELIVERY_PAUSE', p_merchant_external_id: OTHER_MERCHANT, p_performed_by: OTHER_CASHIER };
      for (let i = 0; i < 3; i += 1) expect((await authorize(OTHER, { ...pause, p_manager_pin: '0000' })).body).toEqual({ status: 'PIN_FAILED' });
      expect((await authorize(OTHER, { ...pause, p_manager_pin: '4826' })).body).toEqual({ status: 'PIN_LOCKED' });
      expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${OTHER}' AND action_type = 'MANAGER_PIN_LOCKOUT'`)).toBe('1');
      // A outra loja segue conferindo o PIN normalmente.
      expect((await authorize(TENANT, { p_action: 'DELIVERY_PAUSE', p_merchant_external_id: merchantId })).body).toMatchObject({ status: 'OK' });
      // As falhas pelo PIN de delivery bloqueiam também tchefood_authorize_manager (mesma contagem).
      expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${OTHER}' AND action_type = 'MANAGER_PIN_FAILED' AND created_at > NOW() - INTERVAL '60 seconds'`)).toBe('3');
    });
  });
});
