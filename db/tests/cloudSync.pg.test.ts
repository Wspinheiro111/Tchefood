/**
 * A fila do aparelho contra o banco de verdade.
 *
 * Monta um Postgres igual ao Supabase (db/schema.sql + supabase/migrations, papéis
 * anon/authenticated), liga uma loja nova do aparelho à loja da nuvem e sobe a fila
 * (flushOutbox, o mesmo código do app) por um emulador do PostgREST. Cada etapa da
 * operação precisa subir inteira, sem nenhum evento recusado pelo banco.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 * Sem a variável, é pulado.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADOPT_CLOUD_DISCOUNT_NEEDS_MANAGER, isRejectedItemPrice, migratePersisted, useTcheStore, type PickupLine } from '../../src/store/useTcheStore';
import { availableCashback, cashbackOrphanCents } from '../../src/lib/loyalty';
import type { CashbackLedgerEntry } from '../../src/types';
import { flushOutbox, sanitizePayload, type SyncRejection } from '../../src/lib/sync/supabaseSync';
import { fetchCashbackPending, fetchCloudCustomerCashback, fetchCloudSnapshot, fetchCloudStaff, fetchStaffPins, reconcileCashback } from '../../src/lib/sync/cloudPull';
import { syncOnce } from '../../src/lib/sync/useCloudSync';
import { useArStore } from '../../src/store/useArStore';
import { sampleNfeXml } from '../../src/data/sampleNfe';
import { setReviewHold } from '../../src/lib/payments/reviewHolds';
import { createSupabaseLikeDb, pgTargetFromEnv, postgrestFetch, psql, psqlFile, type EmulatorLog, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_cloud_sync_test';
const ROOT = join(__dirname, '..', '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const st = () => useTcheStore.getState();

const OWNER_PIN = '4826';
const MANAGER_PIN = '7391';
const CASHIER_PIN = '5162';

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

const emulatorLog: EmulatorLog[] = [];

async function sync(): Promise<SyncRejection[]> {
  const cloud = st().cloud!;
  const fetchFn = postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }, emulatorLog);
  const res = await flushOutbox(st().outbox, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token }, fetchFn, 10_000);
  st().ackSyncedEvents(res.sent);
  if (res.rejected.length) st().rejectSyncEvents(res.rejected);
  expect(res.retryLater).toBeNull();
  return res.rejected;
}

async function expectSynced(step: string) {
  const rejected = await sync();
  const detail = rejected.map((r) => {
    const ev = st().syncRejected.find((x) => x.event.id === r.eventId)?.event;
    return `${ev?.table}/${ev?.op}: ${r.message}`;
  });
  expect(detail, step).toEqual([]);
  expect(st().outbox, step).toEqual([]);
}

function login(pin: string) {
  const r = st().login(pin);
  if (!r.ok) throw new Error(r.error);
}

function ok<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function payCash(orderId: string) {
  const o = st().orders.find((x) => x.id === orderId)!;
  return ok(
    st().registerPayment({
      orderId, amount: o.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null,
      idempotency_key: `k-${Math.random()}`, item_ids: [],
    }),
  );
}

const MANAGER = { managerPin: MANAGER_PIN, reason: 'Teste com o banco real' };

/** Fixa a data do servidor para a regra do cashback (terça a quinta); null volta para NOW(). */
function setCashbackClock(at: string | null) {
  sql(`CREATE OR REPLACE FUNCTION tchefood_cashback_now() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$ SELECT ${at ? `'${at}'::timestamptz` : 'NOW()'} $$;`);
}

afterEach(() => vi.useRealTimers());

/** Requisição direta ao "PostgREST", como faria quem tem só o token do aparelho. */
async function raw(method: 'POST' | 'PATCH' | 'GET', path: string, body: unknown, prefer = 'return=minimal') {
  const fetchFn = postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' });
  const res = await fetchFn(`http://cloud.test/rest/v1/${path}`, { method, headers: { Prefer: prefer }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.text() };
}

(target ? describe : describe.skip)('fila do aparelho no banco real (Postgres + migrations)', () => {
  beforeAll(() => {
    applySchema(target!, DB);
    // A loja é criada no servidor (README: o app não cria lojas na nuvem).
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja da nuvem', 'Loja da nuvem Ltda', '11222333000181');`);
    st().resetDemo();
    useTcheStore.setState({ orders: st().orders.map((o) => (o.status === 'OPEN' || o.status === 'PAYING' ? { ...o, status: 'CLOSED' as const } : o)) });
    login('8888');
    ok(
      st().startNewStore(
        {
          tenant: { name: 'Bar do Zé', legal_name: 'Zé Comércio de Alimentos Ltda', cnpj: '11.222.333/0001-81', state_registration: null, city: 'Pelotas', state: 'RS', default_service_fee_pct: 10 },
          owner_name: 'Zé',
          owner_pin: OWNER_PIN,
          cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: TENANT },
        },
        { managerPin: '8888', reason: 'Sair da demonstração' },
      ),
    );
  });

  it('loja nova: dono, usuário do QR, maquininhas e mesas técnicas sobem', async () => {
    await expectSynced('loja nova');
    expect(sql(`SELECT count(*) FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'OWNER' AND active`)).toBe('1');
    expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'STORE_RESET' AND authorized_by_manager_id IS NOT NULL`)).toBe('1');
  });

  it('equipe: cadastro, troca de PIN e de perfil com PIN de gerente, permissão com PIN do dono', async () => {
    login(OWNER_PIN);
    const manager = ok(st().saveStaff({ name: 'Gerente Ana', role: 'MANAGER', pin_code: MANAGER_PIN, active: true }));
    const cashier = ok(st().saveStaff({ name: 'Caixa Bia', role: 'CASHIER', pin_code: '6273', active: true }));
    await expectSynced('cadastro da equipe');
    // PIN de outra pessoa e perfil: pedem PIN de gerente.
    ok(st().saveStaff({ id: cashier.id, name: 'Caixa Bia', role: 'CASHIER', pin_code: CASHIER_PIN, active: true }, MANAGER));
    ok(st().saveStaff({ id: cashier.id, name: 'Caixa Bia', role: 'WAITER', pin_code: CASHIER_PIN, active: true }, MANAGER));
    ok(st().saveStaff({ id: cashier.id, name: 'Caixa Bia', role: 'CASHIER', pin_code: CASHIER_PIN, active: true }, MANAGER));
    ok(st().setRolePermission('CASHIER', 'MENU_MANAGE', true, { managerPin: OWNER_PIN, reason: 'Caixa ajuda no cardápio' }));
    await expectSynced('troca de PIN, perfil e permissão');
    // O próprio PIN não pede gerente.
    login(MANAGER_PIN);
    ok(st().saveStaff({ id: manager.id, name: 'Gerente Ana', role: 'MANAGER', pin_code: '8352', active: true }));
    await expectSynced('troca do próprio PIN');
    ok(st().saveStaff({ id: manager.id, name: 'Gerente Ana', role: 'MANAGER', pin_code: MANAGER_PIN, active: true }));
    await expectSynced('volta do PIN');
    expect(sql(`SELECT role FROM staff_users WHERE id = '${cashier.id}'`)).toBe('CASHIER');
    expect(sql(`SELECT pin_code FROM staff_users WHERE id = '${cashier.id}'`)).toBe(CASHIER_PIN);
    expect(sql(`SELECT allowed FROM role_permissions WHERE tenant_id = '${TENANT}' AND role = 'CASHIER' AND permission = 'MENU_MANAGE'`)).toBe('t');
    expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type LIKE 'STAFF_%' AND authorized_by_manager_id IS NOT NULL`))).toBe(3);
  });

  let productId = '';
  let categoryId = '';
  it('cardápio e mesa', async () => {
    login(OWNER_PIN);
    const cat = ok(st().saveCategory({ name: 'Pratos', sort_order: 1, icon_name: null, active: true }));
    categoryId = cat.id;
    const p = ok(
      st().saveProduct({
        category_id: cat.id, code: '301', name: 'Carreteiro', description: null, price: 46.9, sector: 'KITCHEN', available: true, active: true,
        requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
        cost_price: 0, stock_quantity: 0, barcode: null,
      }),
    );
    productId = p.id;
    ok(st().saveTable({ number: 1, label: 'Mesa 1', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('cardápio e mesa');
  });

  it('comanda: lança, cancela item, desconto, tira e volta os 10%, paga e fecha', async () => {
    login(CASHIER_PIN);
    const mesa = st().tables.find((t) => t.number === 1)!;
    const order = ok(st().openTable(mesa.id, 2, null));
    const p = st().products.find((x) => x.id === productId)!;
    for (let i = 0; i < 3; i++) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    const items = ok(st().dispatchTray(order.id)).items;
    await expectSynced('abre e lança');
    ok(st().cancelOrderItem(items[0]!.id, MANAGER));
    ok(st().applyDiscount(order.id, 5, MANAGER));
    // Tira e volta os 10% com o relógio do aparelho atrasado: a remoção sobe pela
    // função (hora do servidor) e a volta com a hora do aparelho. A volta continua
    // valendo como a última, e a remoção não pode ser reaproveitada depois.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(Date.now() - 3_600_000) });
    ok(st().removeServiceFee(order.id, MANAGER));
    ok(st().restoreServiceFee(order.id));
    vi.useRealTimers();
    await expectSynced('cancelamento, desconto e 10%');
    expect(sql(`SELECT charge_service_fee FROM orders WHERE id = '${order.id}'`)).toBe('t');
    const reuse = await raw('PATCH', `orders?id=eq.${order.id}`, { charge_service_fee: false }, 'return=representation');
    expect(reuse.body).toMatch(/SERVICE_FEE_REMOVED sem PIN/);
    payCash(order.id);
    await expectSynced('pagamento');
    const local = st().orders.find((o) => o.id === order.id)!;
    expect(local.status).toBe('CLOSED');
    expect(sql(`SELECT status || ' ' || total_amount || ' ' || remaining_balance FROM orders WHERE id = '${order.id}'`)).toBe(`CLOSED ${local.total_amount.toFixed(2)} 0.00`);
    // Reenvio da mesma autorização (resposta perdida na rede): devolve o mesmo registro.
    const clientId = crypto.randomUUID();
    const authorize = () =>
      raw('POST', 'rpc/tchefood_authorize_manager', {
        p_order_id: order.id, p_action_type: 'DISCOUNT_APPLIED', p_manager_pin: MANAGER_PIN, p_performed_by: st().currentUserId,
        p_reason: 'Reenvio da fila', p_amount_impact: -1, p_metadata: { discount_before: 0, discount_after: 1, client_audit_id: clientId },
      });
    const first = await authorize();
    const again = await authorize();
    expect(first.status).toBe(200);
    expect(again.body).toBe(first.body);
    expect(sql(`SELECT count(*) FROM audit_logs WHERE metadata->>'client_audit_id' = '${clientId}'`)).toBe('1');
    // Troca do desconto por um menor fica registrada; desconto igual ao atual, não.
    const change = (before: number, after: number) => raw('POST', 'rpc/tchefood_authorize_manager', {
      p_order_id: order.id, p_action_type: 'DISCOUNT_APPLIED', p_manager_pin: MANAGER_PIN, p_performed_by: st().currentUserId,
      p_reason: 'Troca do desconto', p_amount_impact: 1, p_metadata: { discount_before: before, discount_after: after },
    });
    expect((await change(5, 4)).status).toBe(200);
    expect((await change(5, 5)).body).toContain('(diferentes)');
    // P2-01 da rodada 3 do #36: NaN, Infinity, negativo e texto não viram autorização.
    const before = sql(`SELECT count(*) FROM audit_logs WHERE reason = 'Troca do desconto'`);
    for (const [b, a] of [['NaN', 4], ['Infinity', 4], [5, 'NaN'], [5, 'Infinity'], ['-Infinity', 4], [-1, 4], ['abc', 4], [5, '1e12']] as const) {
      const r = await change(b as number, a as number);
      expect(r.status, `${b} → ${a}`).toBe(400);
      expect(r.body).toContain('(diferentes)');
    }
    expect(sql(`SELECT count(*) FROM audit_logs WHERE reason = 'Troca do desconto'`)).toBe(before);
  });

  it('cashback: ganha na conta fechada e resgata na próxima (vira desconto sem PIN de gerente)', async () => {
    const mesa = st().tables.find((t) => t.number === 1)!;
    const p = st().products.find((x) => x.id === productId)!;
    const launch = (orderId: string, qty: number) => {
      ok(st().addToTray({ order_id: orderId, product_id: p.id, half_product_ids: [], quantity: qty, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
      ok(st().dispatchTray(orderId));
    };
    // Quarta-feira: ganha. Quinta: resgata (vale do dia seguinte, de terça a quinta).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T13:00:00-03:00') });
    login(CASHIER_PIN);
    const first = ok(st().openTable(mesa.id, 1, null));
    launch(first.id, 2);
    payCash(first.id);
    ok(st().earnCashback(first.id, { phone: '55999887766', name: 'Cliente', cpf: null, optIn: true }));
    await expectSynced('cashback ganho');

    vi.setSystemTime(new Date('2026-11-12T13:00:00-03:00'));
    setCashbackClock('2026-11-12T13:05:00-03:00');
    login(CASHIER_PIN);
    const second = ok(st().openTable(mesa.id, 1, null));
    launch(second.id, 1);
    const redeemed = ok(st().redeemCashback(second.id, '55999887766'));
    expect(redeemed.amount).toBeGreaterThan(0);
    await expectSynced('cashback resgatado');
    // Gravado pela função do servidor: resgate, baixa do crédito e audit_log conferido.
    expect(sql(`SELECT amount FROM cashback_ledger WHERE order_id = '${second.id}' AND entry_type = 'REDEEM'`)).toBe(redeemed.amount.toFixed(2));
    expect(sql(`SELECT remaining_amount FROM cashback_ledger WHERE order_id = '${first.id}' AND entry_type = 'EARN'`)).toBe(
      (Math.round((Number(sql(`SELECT amount FROM cashback_ledger WHERE order_id = '${first.id}' AND entry_type = 'EARN'`)) - redeemed.amount) * 100) / 100).toFixed(2),
    );
    expect(sql(`SELECT metadata->>'server_verified' FROM audit_logs WHERE order_id = '${second.id}' AND action_type = 'CASHBACK_REDEEMED'`)).toBe('true');
    payCash(second.id);
    await expectSynced('conta com cashback paga');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${second.id}'`)).toBe(redeemed.amount.toFixed(2));
    expect(sql(`SELECT status FROM orders WHERE id = '${second.id}'`)).toBe('CLOSED');
  });

  it('travas do cashback: o token do aparelho não resgata direto, e a função confere dia, valor, conta e repetição', async () => {
    const mesa = st().tables.find((t) => t.number === 1)!;
    const p = st().products.find((x) => x.id === productId)!;
    const customer = sql(`SELECT id FROM loyalty_customers WHERE tenant_id = '${TENANT}' LIMIT 1`);
    const cashier = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'CASHIER' LIMIT 1`);
    // Crédito novo liberado (gravado pelo servidor, como se viesse de uma conta fechada).
    sql(`SET session_replication_role = replica; INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, valid_from, expires_at)
         SELECT '${TENANT}', '${customer}', o.id, 'EARN', 20, 20, '2026-11-01', '2026-12-31'
           FROM orders o WHERE o.tenant_id = '${TENANT}' AND o.status = 'CLOSED'
            AND NOT EXISTS (SELECT 1 FROM cashback_ledger c WHERE c.order_id = o.id AND c.entry_type = 'EARN') LIMIT 1;`);
    const earn = sql(`SELECT id FROM cashback_ledger WHERE customer_id = '${customer}' AND entry_type = 'EARN' AND remaining_amount = 20`);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    login(CASHIER_PIN);
    const order = ok(st().openTable(mesa.id, 1, null));
    ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order.id));
    await expectSynced('conta aberta');
    const total = Number(sql(`SELECT total_amount FROM orders WHERE id = '${order.id}'`));
    const expected = Math.min(20, Math.round(total * 50) / 100);
    const redeem = (args: Record<string, unknown>) => raw('POST', 'rpc/tchefood_register_cashback_redeem', {
      p_redeem_id: 'aaaaaaaa-0000-4000-8000-000000000001', p_audit_id: 'aaaaaaaa-0000-4000-8000-000000000002', p_order_id: order.id,
      p_customer_id: customer, p_amount: expected, p_user_id: cashier, p_created_at: '2026-11-12T19:59:00-03:00', ...args,
    });

    // Direto na tabela: resgate, baixa do saldo e expiração são recusados.
    const direct = await raw('POST', 'cashback_ledger', { tenant_id: TENANT, customer_id: customer, order_id: order.id, entry_type: 'REDEEM', amount: 5 });
    expect(direct.status).toBe(400);
    expect(direct.body).toContain('só pela função do servidor');
    expect((await raw('PATCH', `cashback_ledger?id=eq.${earn}`, { remaining_amount: 0 })).body).toContain('só baixa pela função do servidor');
    expect((await raw('POST', 'cashback_ledger', { tenant_id: TENANT, customer_id: customer, entry_type: 'EXPIRE', amount: 20 })).status).toBe(400);
    expect(sql(`SELECT remaining_amount FROM cashback_ledger WHERE id = '${earn}'`)).toBe('20.00');
    // A função antiga (sem conferir quem chama) não é do aparelho.
    expect(sql(`SELECT has_function_privilege('authenticated', 'tchefood_redeem_cashback(uuid,uuid,uuid)', 'EXECUTE')`)).toBe('f');

    // Valor diferente do que o banco calcula: recusado.
    expect((await redeem({ p_amount: expected + 1 })).body).toContain(`o servidor calcula R$ ${expected.toFixed(2)}`);
    // P0-02 do GPT: o dia é o do servidor. Sexta 00h10 no servidor e o aparelho dizendo
    // quinta 23h59: recusado, com ou sem a marca da versão anterior.
    setCashbackClock('2026-11-13T00:10:00-03:00');
    for (const legacy of [false, true]) {
      const r = await redeem({ p_created_at: '2026-11-12T23:59:00-03:00', p_legacy_predebited: legacy });
      expect(r.status, r.body).toBe(400);
      expect(r.body).toContain('terça a quinta');
    }
    setCashbackClock('2026-11-12T20:00:00-03:00');
    // O aparelho não grava o registro do resgate direto (seria prova forjada da versão anterior).
    const fakeAudit = await raw('POST', 'audit_logs', {
      id: crypto.randomUUID(), tenant_id: TENANT, order_id: order.id, performed_by_user_id: cashier, action_type: 'CASHBACK_REDEEMED',
      amount_impact: -expected, reason: 'Cashback de fidelidade resgatado', metadata: { customer_id: customer, amount: expected, discount_before: 0, discount_after: expected },
    });
    expect(fakeAudit.status).toBe(400);
    expect(fakeAudit.body).toContain('só é gravado por tchefood_register_cashback_redeem');
    // Segunda-feira (pelo relógio do servidor): recusado.
    setCashbackClock('2026-11-16T20:00:00-03:00');
    expect((await redeem({ p_created_at: null })).body).toContain('terça a quinta');
    setCashbackClock('2026-11-12T20:00:00-03:00');
    // Quem resgata tem de ser da equipe ativa da loja.
    expect((await redeem({ p_user_id: 'bbbbbbbb-0000-4000-8000-000000000009' })).body).toContain('equipe ativa');
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${order.id}'`)).toBe('0');

    // Certo: grava o resgate, baixa o crédito, grava o audit_log e o desconto.
    const okRes = await redeem({});
    expect(okRes.status).toBe(200);
    expect(Number(okRes.body)).toBe(expected);
    expect(sql(`SELECT remaining_amount FROM cashback_ledger WHERE id = '${earn}'`)).toBe((20 - expected).toFixed(2));
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order.id}'`)).toBe(expected.toFixed(2));
    // Reenvio da fila: devolve o gravado sem consumir de novo.
    expect(Number((await redeem({})).body)).toBe(expected);
    expect(sql(`SELECT remaining_amount FROM cashback_ledger WHERE id = '${earn}'`)).toBe((20 - expected).toFixed(2));
    // Segundo resgate na mesma conta, com outro id: recusado.
    expect((await redeem({ p_redeem_id: 'aaaaaaaa-0000-4000-8000-000000000003', p_audit_id: 'aaaaaaaa-0000-4000-8000-000000000004' })).body).toContain('já usou cashback');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order.id}'`)).toBe(expected.toFixed(2));
    // Fecha a conta para não atrapalhar os próximos testes.
    useTcheStore.setState({ orders: st().orders.filter((o) => o.id !== order.id), tables: st().tables.map((t) => (t.id === mesa.id ? { ...t, status: 'FREE' as const, current_order_id: null } : t)) });
    sql(`SET session_replication_role = replica; UPDATE orders SET status = 'CANCELED' WHERE id = '${order.id}'; UPDATE dining_tables SET status = 'FREE', current_order_id = NULL WHERE id = '${mesa.id}';`);
    setCashbackClock(null);
  });

  /** Abre contas novas (mesas 11 em diante) com dois itens, para os testes de cashback. */
  async function cashbackOrders(n: number, first: number) {
    login(OWNER_PIN);
    for (let i = 0; i < n; i++) ok(st().saveTable({ number: first + i, label: `Mesa ${first + i}`, area: 'Salão', capacity: 4, active: true }));
    await expectSynced('mesas do cashback');
    login(CASHIER_PIN);
    const p = st().products.find((x) => x.id === productId)!;
    const orders = Array.from({ length: n }, (_, i) => {
      const mesa = st().tables.find((t) => t.number === first + i)!;
      const order = ok(st().openTable(mesa.id, 1, null));
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
      ok(st().dispatchTray(order.id));
      return order;
    });
    await expectSynced('contas do cashback');
    return orders.map((o) => ({ id: o.id, cap: Math.round(Number(sql(`SELECT total_amount FROM orders WHERE id = '${o.id}'`)) * 50) / 100 }));
  }
  function closeCashbackOrders(ids: string[]) {
    useTcheStore.setState({
      orders: st().orders.filter((o) => !ids.includes(o.id)),
      tables: st().tables.map((t) => (t.current_order_id && ids.includes(t.current_order_id) ? { ...t, status: 'FREE' as const, current_order_id: null } : t)),
    });
    const list = ids.map((x) => `'${x}'`).join(',');
    sql(`SET session_replication_role = replica; UPDATE orders SET status = 'CANCELED' WHERE id IN (${list}); UPDATE dining_tables SET status = 'FREE', current_order_id = NULL WHERE current_order_id IN (${list});`);
  }
  /** Cliente novo da loja com créditos liberados (como se viessem de contas fechadas). */
  function cashbackCustomer(phone: string, credits: { amount: number; remaining?: number; expires: string }[], tenant = TENANT) {
    const id = crypto.randomUUID();
    sql(`INSERT INTO loyalty_customers (id, tenant_id, phone_whatsapp, name) VALUES ('${id}', '${tenant}', '${phone}', 'Cliente ${phone}');`);
    const earns = credits.map((c) => {
      const earn = crypto.randomUUID();
      sql(`SET session_replication_role = replica; INSERT INTO cashback_ledger (id, tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
           VALUES ('${earn}', '${tenant}', '${id}', 'EARN', ${c.amount}, ${c.remaining ?? c.amount}, '2026-11-01', '${c.expires}');`);
      return earn;
    });
    return { id, earns };
  }
  /** O que a versão anterior deixava na nuvem quando a internet caía no meio do resgate: o registro do resgate (sem REDEEM). */
  function legacyAudit(orderId: string, customerId: string, amount: number) {
    const id = crypto.randomUUID();
    const cashier = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'CASHIER' LIMIT 1`);
    sql(`INSERT INTO audit_logs (id, tenant_id, order_id, performed_by_user_id, action_type, amount_impact, reason, metadata)
         VALUES ('${id}', '${TENANT}', '${orderId}', '${cashier}', 'CASHBACK_REDEEMED', ${-amount}, 'Cashback de fidelidade resgatado',
                 '{"customer_id": "${customerId}", "amount": ${amount}, "discount_before": 0, "discount_after": ${amount}}');`);
    return id;
  }
  const remainingOf = (earn: string) => Number(sql(`SELECT remaining_amount FROM cashback_ledger WHERE id = '${earn}'`));
  const debit = (earn: string, v: number) => sql(`SET session_replication_role = replica; UPDATE cashback_ledger SET remaining_amount = remaining_amount - ${v} WHERE id = '${earn}';`);
  const cashbackRpc = (orderId: string, customerId: string, amount: number, args: Record<string, unknown> = {}) => raw('POST', 'rpc/tchefood_register_cashback_redeem', {
    p_redeem_id: crypto.randomUUID(), p_audit_id: crypto.randomUUID(), p_order_id: orderId, p_customer_id: customerId, p_amount: amount,
    p_user_id: sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'CASHIER' LIMIT 1`), p_created_at: '2026-11-12T19:00:00-03:00', ...args,
  });

  it('cashback entre lojas: crédito de outra loja não conta nem baixa, e lançamento cruzado novo é recusado', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [order, other] = await cashbackOrders(2, 11);
    const amount = Math.min(5, order!.cap);
    const customer = cashbackCustomer('5553988110001', [{ amount, expires: '2026-12-31' }]);
    // Outra loja com um crédito de R$ 30 que aponta (de propósito) para o cliente desta loja.
    const TENANT_B = '33333333-3333-4333-8333-333333333333';
    const cross = crypto.randomUUID();
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT_B}', 'Outra loja', 'Outra loja Ltda', '33444555000181');
         SET session_replication_role = replica;
         INSERT INTO cashback_ledger (id, tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
         VALUES ('${cross}', '${TENANT_B}', '${customer.id}', 'EARN', 30, 30, '2026-11-01', '2026-12-31');`);
    // O servidor só conta o crédito desta loja: pedir mais que ele é recusado, e o da outra loja não baixa.
    const greedy = await cashbackRpc(order!.id, customer.id, Math.min(amount + 30, order!.cap));
    if (order!.cap > amount) expect(greedy.body).toContain(`o servidor calcula R$ ${amount.toFixed(2)}`);
    expect(remainingOf(cross)).toBe(30);
    const res = await cashbackRpc(order!.id, customer.id, amount);
    expect(res.status, res.body).toBe(200);
    expect(remainingOf(customer.earns[0]!)).toBe(0);
    expect(remainingOf(cross)).toBe(30);
    // Lançamento novo com cliente ou conta de outra loja: recusado pelas chaves compostas.
    expect(() => sql(`INSERT INTO cashback_ledger (tenant_id, customer_id, entry_type, amount)
                      VALUES ('${TENANT_B}', '${customer.id}', 'REDEEM', 1);`)).toThrow(/cashback_ledger_customer_same_tenant/);
    const customerB = crypto.randomUUID();
    sql(`INSERT INTO loyalty_customers (id, tenant_id, phone_whatsapp, name) VALUES ('${customerB}', '${TENANT_B}', '5553988110009', 'Cliente B');`);
    expect(() => sql(`INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount)
                      VALUES ('${TENANT_B}', '${customerB}', '${other!.id}', 'REDEEM', 1);`)).toThrow(/cashback_ledger_order_same_tenant/);
    closeCashbackOrders([order!.id, other!.id]);
    setCashbackClock(null);
  });

  it('depois do resgate: atualização antiga da conta não apaga desconto e a do cliente não grava saldo', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [order] = await cashbackOrders(1, 31);
    expect(order!.cap).toBeGreaterThanOrEqual(7);
    const c = cashbackCustomer('5553988110006', [{ amount: 5, expires: '2026-12-31' }]);
    expect((await cashbackRpc(order!.id, c.id, 5)).status).toBe(200);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order!.id}'`)).toBe('5.00');
    // P0-01 da rodada 3: outro aparelho sobe um desconto autorizado (R$ 5 → R$ 7) antes da
    // fila deste aparelho terminar.
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -2, 'Desconto do outro aparelho', '{"discount_before": 5, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${order!.id}';`);
    const gross = sql(`SELECT subtotal_items + service_fee_amount FROM orders WHERE id = '${order!.id}'`);
    // A fila deste aparelho sobe a atualização da conta com o desconto antigo, e depois a
    // conta indo para pagamento (também com o valor antigo): as duas são recusadas como
    // conflito (rodada 5: o aparelho fica sabendo antes de cobrar) e o desconto continua R$ 7.
    const stale = await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 5 });
    expect(stale.status).toBe(400);
    expect(stale.body).toContain('TCHEFOOD_DESCONTO: o desconto desta conta na nuvem é R$ 7.00 e este aparelho mandou R$ 5.00');
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 5, status: 'PAYING' })).status).toBe(400);
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 7, status: 'PAYING' })).status).toBeLessThan(300);
    expect(sql(`SELECT discount_amount || ' ' || status FROM orders WHERE id = '${order!.id}'`)).toBe('7.00 PAYING');
    expect(sql(`SELECT total_amount = ${gross} - 7 FROM orders WHERE id = '${order!.id}'`)).toBe('t');
    expect(sql(`SELECT amount FROM cashback_ledger WHERE order_id = '${order!.id}' AND entry_type = 'REDEEM'`)).toBe('5.00');

    // P2-02 da rodada 3: o saldo exibido do cliente é do banco. A atualização do cliente que
    // sobe depois do resgate (com o saldo do aparelho) e um saldo inventado não valem.
    expect((await raw('PATCH', `loyalty_customers?id=eq.${c.id}`, { cashback_balance: 99 })).status).toBeLessThan(300);
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('0.00');
    // Crédito novo de outro aparelho (R$ 3); a atualização antiga com saldo 0 não o apaga.
    sql(`SET session_replication_role = replica; INSERT INTO cashback_ledger (tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
         VALUES ('${TENANT}', '${c.id}', 'EARN', 3, 3, '2026-11-01', '2027-12-31');`);
    sql(`SELECT tchefood_refresh_cashback_balance('${c.id}');`);
    expect((await raw('PATCH', `loyalty_customers?id=eq.${c.id}`, { cashback_balance: 0, name: 'Cliente atualizado' })).status).toBeLessThan(300);
    expect(sql(`SELECT cashback_balance || ' ' || name FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('3.00 Cliente atualizado');
    closeCashbackOrders([order!.id]);
    setCashbackClock(null);
  });

  it('gerente troca o desconto manual por um menor: o banco aceita; redução sem autorização não', async () => {
    // Achado do Codex em e5ce9cb: a trava do desconto (P0-01 da rodada 3) não pode barrar a
    // troca de R$ 10 por R$ 5 autorizada pelo gerente; senão o pagamento do valor certo é recusado.
    const [order, withCashback] = await cashbackOrders(2, 41);
    login(CASHIER_PIN);
    ok(st().applyDiscount(order!.id, 10, MANAGER));
    await expectSynced('desconto de R$ 10');
    ok(st().applyDiscount(order!.id, 5, MANAGER));
    await expectSynced('troca para R$ 5');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order!.id}'`)).toBe('5.00');
    // Atualização antiga da fila (sem autorização dessa troca): recusada, o desconto fica.
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 3 })).status).toBe(400);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order!.id}'`)).toBe('5.00');
    // Reenvio da troca já feita (R$ 10 → R$ 5) depois de outra autorização (R$ 5 → R$ 8): não vale.
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -3, 'Outro aparelho', '{"discount_before": 5, "discount_after": 8}');
         UPDATE orders SET discount_amount = 8 WHERE id = '${order!.id}';`);
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 5 })).status).toBe(400);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order!.id}'`)).toBe('8.00');
    sql(`UPDATE orders SET discount_amount = 5 WHERE id = '${order!.id}';`);
    // P2-01 da rodada 4: duas trocas na mesma transação têm o mesmo created_at; a última é a
    // da sequência do servidor (R$ 5 → R$ 4), não a de UUID maior (R$ 5 → R$ 3).
    sql(`BEGIN;
         INSERT INTO audit_logs (id, tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('ffffffff-ffff-4fff-bfff-ffffffffffff', '${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', 2, 'Primeira troca', '{"discount_before": 5, "discount_after": 3}');
         INSERT INTO audit_logs (id, tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('00000000-0000-4000-8000-000000000001', '${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', 1, 'Segunda troca', '{"discount_before": 5, "discount_after": 4}');
         COMMIT;`);
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 3 })).status).toBe(400);
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 4 })).status).toBeLessThan(300);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -1, 'Volta', '{"discount_before": 4, "discount_after": 5}');
         UPDATE orders SET discount_amount = 5 WHERE id = '${order!.id}';`);
    // A troca autorizada para menos também gasta a autorização (rodada 13, junto com o #45):
    // nem mandando o marcador zerado junto, que o gatilho do #45 devolve ao do banco.
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', 3, 'Troca para R$ 2', '{"discount_before": 5, "discount_after": 2}');`);
    const swapSeq = sql(`SELECT max(server_seq) FROM audit_logs WHERE order_id = '${order!.id}' AND action_type = 'DISCOUNT_APPLIED'`);
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 2, discount_auth_seq: 0 })).status).toBeLessThan(300);
    expect(sql(`SELECT discount_amount || ' ' || discount_auth_seq FROM orders WHERE id = '${order!.id}'`)).toBe(`2.00 ${swapSeq}`);
    // O desconto volta a R$ 5 por fora (sem gatilhos, sem autorização nova) e a mesma troca
    // (R$ 5 → R$ 2) vem de novo: a autorização já foi usada.
    sql(`SET session_replication_role = replica; UPDATE orders SET discount_amount = 5 WHERE id = '${order!.id}';`);
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 2 })).status).toBe(400);
    expect(sql(`SELECT discount_amount || ' ' || discount_auth_seq FROM orders WHERE id = '${order!.id}'`)).toBe(`5.00 ${swapSeq}`);
    // O pagamento do valor que o aparelho calcula (com R$ 5 de desconto) entra e fecha a conta.
    payCash(order!.id);
    await expectSynced('pagamento com o desconto trocado');
    expect(sql(`SELECT status || ' ' || remaining_balance FROM orders WHERE id = '${order!.id}'`)).toBe('CLOSED 0.00');

    // Conta com resgate de cashback: nem com autorização o aparelho reduz o desconto.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const c = cashbackCustomer('5553988110007', [{ amount: 5, expires: '2026-12-31' }]);
    expect((await cashbackRpc(withCashback!.id, c.id, 5)).status).toBe(200);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${withCashback!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', 2, 'Troca', '{"discount_before": 5, "discount_after": 3}');`);
    expect((await raw('PATCH', `orders?id=eq.${withCashback!.id}`, { discount_amount: 3 })).status).toBe(400);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${withCashback!.id}'`)).toBe('5.00');
    closeCashbackOrders([withCashback!.id]);
    setCashbackClock(null);
  });

  it('item cancelado deixa o bruto abaixo do desconto: o recálculo do banco limita o desconto como o app', async () => {
    // Achado do Codex em 0ed2531: a trava do desconto não pode barrar o recálculo do banco.
    const [order] = await cashbackOrders(1, 43);
    login(CASHIER_PIN);
    const gross = st().orders.find((o) => o.id === order!.id)!.subtotal_items;
    ok(st().applyDiscount(order!.id, gross, MANAGER));
    await expectSynced('desconto do valor todo');
    const item = st().orderItems.find((i) => i.order_id === order!.id && i.status !== 'CANCELED')!;
    ok(st().cancelOrderItem(item.id, MANAGER));
    await expectSynced('cancelamento do item');
    const local = st().orders.find((o) => o.id === order!.id)!;
    expect(local.discount_amount).toBe(0);
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order!.id}'`)).toBe('0.00 0.00');
    // Consumo novo depois: o saldo do banco é o mesmo do aparelho.
    const p = st().products.find((x) => x.id === productId)!;
    ok(st().addToTray({ order_id: order!.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order!.id));
    await expectSynced('consumo novo');
    const after = st().orders.find((o) => o.id === order!.id)!;
    expect(sql(`SELECT discount_amount || ' ' || remaining_balance FROM orders WHERE id = '${order!.id}'`)).toBe(`${after.discount_amount.toFixed(2)} ${after.remaining_balance.toFixed(2)}`);
    payCash(order!.id);
    await expectSynced('pagamento depois do cancelamento');
    expect(sql(`SELECT status FROM orders WHERE id = '${order!.id}'`)).toBe('CLOSED');
  });

  it('tirar os 10% de conta com desconto maior que o consumo: o desconto limitado ao novo bruto sobe', async () => {
    // Achado do Codex em b8b9106: o app limita o desconto ao bruto sem os 10% e sobe os dois
    // juntos; a trava do desconto não pode tratar isso como desconto antigo.
    const [order] = await cashbackOrders(1, 48);
    login(CASHIER_PIN);
    const before = st().orders.find((o) => o.id === order!.id)!;
    const gross = Math.round((before.subtotal_items + before.service_fee_amount) * 100) / 100;
    ok(st().applyDiscount(order!.id, gross, MANAGER));
    await expectSynced('desconto da conta inteira com os 10%');
    ok(st().removeServiceFee(order!.id, MANAGER));
    await expectSynced('tirar os 10%');
    const local = st().orders.find((o) => o.id === order!.id)!;
    expect(local.discount_amount).toBe(before.subtotal_items);
    expect(sql(`SELECT charge_service_fee || ' ' || discount_amount || ' ' || total_amount FROM orders WHERE id = '${order!.id}'`))
      .toBe(`false ${before.subtotal_items.toFixed(2)} 0.00`);
    // Reduzir abaixo do bruto sem autorização continua recusado.
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 10 })).status).toBe(400);
    closeCashbackOrders([order!.id]);
  });

  it('conta com cashback: cancelamento que deixa o desconto abaixo do cashback usado devolve a diferença ao cliente', async () => {
    // P0-01 da rodada 4 (decisão do Will: "devolva"): R$ 50 de cashback numa conta de R$ 100;
    // o cancelamento leva o bruto a R$ 30, o recálculo limita o desconto a R$ 30 e os R$ 20
    // que sobram voltam ao cliente (REFUND + CASHBACK_REFUNDED), uma vez só, mesmo com o
    // reenvio da fila depois de a internet cair antes da confirmação.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    login(OWNER_PIN);
    const product = (code: string, name: string, price: number) => ok(st().saveProduct({
      category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    const picanha = product('451', 'Picanha', 80);
    const salada = product('452', 'Salada', 20);
    ok(st().saveTable({ number: 45, label: 'Mesa 45', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('produtos e mesa');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 45)!.id, 1, null));
    for (const p of [picanha, salada]) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    ok(st().dispatchTray(order.id));
    ok(st().removeServiceFee(order.id, MANAGER));
    await expectSynced('conta de R$ 100');
    // Cliente com R$ 60 liberados em dois créditos (R$ 30 vence em 20/11, R$ 30 em 31/12),
    // na nuvem e no aparelho.
    const phone = '5553988110008';
    const c = cashbackCustomer(phone, [{ amount: 30, expires: '2026-11-20' }, { amount: 30, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarns = c.earns.map((id) => JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${id}'`)));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 60, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, ...cloudEarns.map((e) => ({ ...e, amount: 30, remaining_amount: 30 }))],
    });
    expect(ok(st().redeemCashback(order.id, phone)).amount).toBe(50);
    await expectSynced('resgate de R$ 50');
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe('50.00 50.00');

    const item = st().orderItems.find((i) => i.order_id === order.id && i.product_id === picanha.id)!;
    // Quem cancela não é quem resgatou (P2-01 da rodada 5: o estorno leva o cancelamento).
    login(OWNER_PIN);
    ok(st().cancelOrderItem(item.id, MANAGER));
    login(CASHIER_PIN);
    const pending = [...st().outbox];
    await expectSynced('cancelamento da picanha');
    // Internet caiu antes da confirmação: a fila sobe de novo os mesmos eventos.
    const cloud = st().cloud!;
    const resend = await flushOutbox(pending, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(resend.rejected).toEqual([]);

    const local = st().orders.find((o) => o.id === order.id)!;
    expect([local.discount_amount, local.total_amount]).toEqual([20, 0]);
    expect(sql(`SELECT discount_amount || ' ' || total_amount || ' ' || remaining_balance FROM orders WHERE id = '${order.id}'`)).toBe('20.00 0.00 0.00');
    // O resgate saiu R$ 30 do crédito de 20/11 e R$ 20 do de 31/12 (vence antes, sai antes).
    expect(sql(`SELECT string_agg((x->>'amount') || ' ' || (x->>'source_id'), ' | ' ORDER BY n) FROM cashback_ledger l, jsonb_array_elements(l.redeem_sources) WITH ORDINALITY AS t(x, n) WHERE l.order_id = '${order.id}' AND l.entry_type = 'REDEEM'`))
      .toBe(`30.00 ${c.earns[0]} | 20.00 ${c.earns[1]}`);
    // Decisão do Will: o estorno de R$ 30 não ganha prazo novo. Volta primeiro o que vence por
    // último: R$ 20 com a validade do crédito de 31/12 e R$ 10 com a do de 20/11. Uma vez só,
    // mesmo com o reenvio; os EARN originais não mudam.
    const refundRows = () => sql(`SELECT string_agg(amount || ' ' || remaining_amount || ' ' || to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' ' || to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' ' || (refund_of_id = '${c.earns[1]}'), ' | ' ORDER BY expires_at DESC) FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND'`);
    expect(refundRows()).toBe('20.00 20.00 2026-11-01 2026-12-31 true | 10.00 10.00 2026-11-01 2026-11-20 false');
    expect(sql(`SELECT string_agg(amount || ' ' || remaining_amount, ' | ' ORDER BY expires_at) FROM cashback_ledger WHERE id IN ('${c.earns[0]}', '${c.earns[1]}')`)).toBe('30.00 0.00 | 30.00 10.00');
    expect(sql(`SELECT count(*) || ' ' || sum(amount_impact) || ' ' || bool_and((metadata->>'server_verified')::boolean) FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'CASHBACK_REFUNDED'`)).toBe('2 30.00 true');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('40.00');
    // Cada estorno aponta o cancelamento da picanha: quem cancelou, o gerente e o registro.
    const cancelAudit = sql(`SELECT id || ' ' || performed_by_user_id || ' ' || authorized_by_manager_id FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'ITEM_CANCELED' AND metadata->>'item_id' = '${item.id}'`);
    expect(sql(`SELECT string_agg(DISTINCT (metadata->>'cause_audit_id') || ' ' || performed_by_user_id || ' ' || authorized_by_manager_id || ' ' || (metadata->>'cause') || ' ' || (metadata->>'item_cancel_audit_id' = metadata->>'cause_audit_id') || ' ' || (metadata->>'canceled_item_id') || ' ' || reason, ' | ') FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'CASHBACK_REFUNDED'`))
      .toBe(`${cancelAudit} ITEM_CANCELED true ${item.id} Cashback devolvido ao cliente (cancelamento de item deixou o desconto abaixo do cashback usado)`);
    expect(sql(`SELECT created_by_user_id <> (SELECT performed_by_user_id FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'ITEM_CANCELED' LIMIT 1) FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REDEEM'`)).toBe('t');
    // O aparelho chega ao mesmo extrato sem baixar nada da nuvem.
    const localRefunds = st().cashbackLedger.filter((e) => e.order_id === order.id && e.entry_type === 'REFUND');
    expect(localRefunds.map((e) => [e.amount, e.expires_at!.slice(0, 10), e.refund_of_id])).toEqual([[20, '2026-12-31', c.earns[1]], [10, '2026-11-20', c.earns[0]]]);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(40);

    // O aparelho não grava estorno nem o registro dele.
    const user = st().currentUserId;
    expect((await raw('POST', 'cashback_ledger', {
      id: crypto.randomUUID(), tenant_id: TENANT, customer_id: c.id, order_id: order.id, entry_type: 'REFUND', amount: 5, remaining_amount: 5,
      valid_from: '2026-11-12T20:00:00-03:00', expires_at: '2026-12-12T20:00:00-03:00', created_by_user_id: user,
    })).status).toBe(400);
    expect((await raw('POST', 'audit_logs', {
      id: crypto.randomUUID(), tenant_id: TENANT, order_id: order.id, performed_by_user_id: user, action_type: 'CASHBACK_REFUNDED',
      amount_impact: 5, reason: 'forjado', whatsapp_alert_sent: false, metadata: {},
    })).status).toBe(400);

    // Achado do Codex em b8b9106: depois do estorno, consumo novo e o aparelho sobe o
    // desconto de volta para R$ 50. O registro do resgate original não serve mais: recusa,
    // e o cliente não fica com o estorno e o desconto.
    ok(st().addToTray({ order_id: order.id, product_id: picanha.id, half_product_ids: [], quantity: 1, unit_price: picanha.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: picanha.sector }));
    ok(st().dispatchTray(order.id));
    await expectSynced('consumo novo depois do estorno');
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe('20.00 80.00');
    const reuse = await raw('PATCH', `orders?id=eq.${order.id}`, { discount_amount: 50 });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toContain('TCHEFOOD_DESCONTO: o desconto desta conta na nuvem é R$ 20.00');
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe('20.00 80.00');
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND'`)).toBe('2');

    // O crédito devolvido vale como o ganho: entra no próximo resgate (pelo FIFO do servidor).
    const [next] = await cashbackOrders(1, 46);
    const cap = next!.cap;
    expect((await cashbackRpc(next!.id, c.id, Math.min(40, cap))).status).toBe(200);
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe((40 - Math.min(40, cap)).toFixed(2));
    closeCashbackOrders([next!.id, order.id]);
    setCashbackClock(null);
  });

  it('tirar os 10% de conta com cashback: o estorno do banco tem espelho no aparelho e a leitura da nuvem acerta o extrato', async () => {
    // Achado do Codex em 4f16b9c: o estorno nasce no banco em qualquer redução do desconto,
    // mas o aparelho só espelhava o do cancelamento. R$ 100 + 10%, resgate de R$ 50; o
    // cancelamento de R$ 53 deixa R$ 51,70 (sem estorno); tirar os 10% limita o desconto a
    // R$ 47 e devolve R$ 3.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    login(OWNER_PIN);
    const product = (code: string, name: string, price: number) => ok(st().saveProduct({
      category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    const costela = product('454', 'Costela', 53);
    const arroz = product('455', 'Arroz carreteiro', 47);
    ok(st().saveTable({ number: 54, label: 'Mesa 54', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('produtos e mesa');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 54)!.id, 1, null));
    for (const p of [costela, arroz]) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    ok(st().dispatchTray(order.id));
    await expectSynced('conta de R$ 100 + 10%');
    const phone = '5553988110018';
    const c = cashbackCustomer(phone, [{ amount: 50, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 50, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 50, remaining_amount: 50 }],
    });
    expect(ok(st().redeemCashback(order.id, phone)).amount).toBe(50);
    await expectSynced('resgate de R$ 50');
    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === order.id && i.product_id === costela.id)!.id, MANAGER));
    await expectSynced('cancelamento da costela');
    const refundsOf = () => st().cashbackLedger.filter((e) => e.order_id === order.id && e.entry_type === 'REFUND');
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND'`)).toBe('0');
    expect(refundsOf()).toEqual([]);
    // Outro operador tira os 10% (P2-01 da rodada 5 do GPT): o estorno é dele, com o gerente
    // e o registro da retirada, não do cancelamento anterior nem de quem resgatou.
    login(OWNER_PIN);
    ok(st().removeServiceFee(order.id, MANAGER));
    login(CASHIER_PIN);
    await expectSynced('tirar os 10%');
    const feeAudit = sql(`SELECT id || ' ' || performed_by_user_id || ' ' || authorized_by_manager_id FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'SERVICE_FEE_REMOVED' ORDER BY server_seq DESC LIMIT 1`);
    expect(sql(`SELECT (metadata->>'cause_audit_id') || ' ' || performed_by_user_id || ' ' || authorized_by_manager_id || ' ' || (metadata->>'cause') || ' ' || (metadata->>'service_fee_audit_id' = metadata->>'cause_audit_id') || ' ' || (metadata->>'item_cancel_audit_id' IS NULL) || ' ' || reason FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'CASHBACK_REFUNDED'`))
      .toBe(`${feeAudit} SERVICE_FEE_REMOVED true true Cashback devolvido ao cliente (retirada dos 10% deixou o desconto abaixo do cashback usado)`);
    expect(sql(`SELECT count(*) FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'ITEM_CANCELED' AND performed_by_user_id::text = split_part('${feeAudit}', ' ', 2)`)).toBe('0');
    // O espelho do aparelho leva a mesma operação.
    const localFeeLog = st().auditLogs.find((l) => l.order_id === order.id && l.action_type === 'CASHBACK_REFUNDED')!;
    const localFee = st().auditLogs.find((l) => l.order_id === order.id && l.action_type === 'SERVICE_FEE_REMOVED')!;
    expect([localFeeLog.metadata?.cause, localFeeLog.metadata?.service_fee_audit_id, localFeeLog.performed_by_user_id, localFeeLog.authorized_by_manager_id].join(' '))
      .toBe(`SERVICE_FEE_REMOVED ${localFee.id} ${feeAudit.split(' ').slice(1).join(' ')}`);
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe('47.00 0.00');
    expect(sql(`SELECT string_agg(amount || ' ' || to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), ' | ') FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND'`)).toBe('3.00 2026-12-31');
    expect(refundsOf().map((e) => [e.amount, e.expires_at!.slice(0, 10)])).toEqual([[3, '2026-12-31']]);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(3);
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('3.00');

    // Achado do Codex em 634d682: o banco pode baixar outro crédito que o aparelho (crédito
    // que venceu entre o resgate e a subida) ou gravar o que o aparelho não espelha. A
    // leitura da nuvem (fila vazia) traz clientes e extrato: o espelho dá lugar ao estorno
    // do banco, e um crédito gravado por outro aparelho aparece aqui.
    const other = crypto.randomUUID();
    sql(`SET session_replication_role = replica; INSERT INTO cashback_ledger (id, tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
         VALUES ('${other}', '${TENANT}', '${c.id}', 'EARN', 4, 4, '2026-11-01', '2026-12-20'); SET session_replication_role = origin;
         SELECT tchefood_refresh_cashback_balance('${c.id}');`);
    const mirrorId = refundsOf()[0]!.id;
    await syncOnce(postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }, emulatorLog), { forcePull: true });
    expect(st().pullStatus.last_error).toBeNull();
    const cloudRefund = sql(`SELECT id FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND'`);
    expect(refundsOf().map((e) => e.id)).toEqual([cloudRefund]);
    expect(refundsOf()[0]!.id).not.toBe(mirrorId);
    expect(st().cashbackLedger.find((e) => e.id === other)?.remaining_amount).toBe(4);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(7);
    expect(availableCashback(st().cashbackLedger, c.id, new Date())).toBe(7);
    closeCashbackOrders([order.id]);
    setCashbackClock(null);
  });

  it('fila da versão anterior que caiu antes da atualização da conta: o desconto do resgate ainda sobe', async () => {
    // Achado do Codex em da2a794: a versão anterior subia o registro do resgate, as baixas e
    // o REDEEM antes da conta. Se caiu ali, a atualização da conta com o desconto ainda está
    // na fila e precisa subir; com estorno na conta, não (seria o reaproveitamento).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [a, b] = await cashbackOrders(2, 49);
    const legacyRedeem = (orderId: string, refund: boolean) => {
      const c = cashbackCustomer(`55539881100${refund ? '20' : '19'}`, [{ amount: 10, expires: '2026-12-31' }]);
      legacyAudit(orderId, c.id, 5);
      debit(c.earns[0]!, 5);
      sql(`SET session_replication_role = replica;
           INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount) VALUES ('${TENANT}', '${c.id}', '${orderId}', 'REDEEM', 5);
           ${refund ? `INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, valid_from, expires_at)
                       VALUES ('${TENANT}', '${c.id}', '${orderId}', 'REFUND', 5, 5, '2026-11-12', '2026-12-12');` : ''}`);
    };
    legacyRedeem(a!.id, false);
    legacyRedeem(b!.id, true);
    expect((await raw('PATCH', `orders?id=eq.${a!.id}`, { discount_amount: 5 })).status).toBeLessThan(300);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${a!.id}'`)).toBe('5.00');
    const reused = await raw('PATCH', `orders?id=eq.${b!.id}`, { discount_amount: 5 });
    expect(reused.status).toBe(400);
    expect(reused.body).toContain('TCHEFOOD_DESCONTO');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${b!.id}'`)).toBe('0.00');
    closeCashbackOrders([a!.id, b!.id]);
    setCashbackClock(null);
  });

  it('dois aparelhos: desconto antigo da fila vira conflito, o aparelho não cobra e adota o desconto da nuvem', async () => {
    // P1-01 da rodada 4: antes o banco ignorava a atualização antiga em silêncio e o aparelho
    // cobrava com o desconto velho (pagamento recusado depois).
    const [order] = await cashbackOrders(1, 47);
    login(CASHIER_PIN);
    ok(st().applyDiscount(order!.id, 5, MANAGER));
    await expectSynced('desconto de R$ 5');
    // Outro aparelho: desconto autorizado R$ 5 → R$ 7.
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -2, 'Outro aparelho', '{"discount_before": 5, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${order!.id}';`);
    // Este aparelho vai para o pagamento com o desconto antigo: a conta sobe e é recusada.
    ok(st().startCheckout(order!.id));
    const rejected = await sync();
    expect(rejected).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order!.id)!;
    expect(conflict.message).toContain('na nuvem é R$ 7.00');
    // Antes de cobrar o aparelho sabe do conflito e não registra o pagamento.
    const local = st().orders.find((o) => o.id === order!.id)!;
    const blocked = st().registerPayment({
      orderId: order!.id, amount: local.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `k-${Math.random()}`, item_ids: [],
    });
    expect(blocked.ok).toBe(false);
    expect(st().startCheckout(order!.id).ok).toBe(false);
    // Achado do Codex em 9b525b6: nem a maquininha começa uma cobrança nova com o valor antigo.
    const terminal = st().beginTerminalCharge(order!.id, `req-${Math.random()}`, local.remaining_balance);
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.error).toContain('use o desconto da nuvem');
    // Achado do Codex em 4f16b9c: nem desconto novo nem resgate enquanto o conflito está
    // pendente (a autorização descreveria a troca a partir do desconto velho daqui).
    expect(st().applyDiscount(order!.id, 10, MANAGER).ok).toBe(false);
    // Achado do Codex em 208789d: cobrança que começou antes da recusa ainda sem resposta. O
    // saldo não muda até a resposta ser registrada (o pagamento aprovado passaria do saldo novo).
    const charging = { request_id: `req-${Math.random()}`, order_id: order!.id, amount: local.remaining_balance, user_id: st().currentUserId!, started_at: Date.now() };
    useTcheStore.setState({ pendingCharges: [...st().pendingCharges, charging] });
    const duringCharge = st().adoptCloudDiscount(conflict.event.id);
    expect(duringCharge.ok).toBe(false);
    if (!duringCharge.ok) expect(duringCharge.error).toContain('cobrança em andamento');
    expect(st().orders.find((o) => o.id === order!.id)!.discount_amount).toBe(5);
    useTcheStore.setState({ pendingCharges: st().pendingCharges.filter((c) => c.request_id !== charging.request_id) });
    // O gerente adota o desconto da nuvem: a conta converge e o pagamento do valor certo fecha.
    expect(ok(st().adoptCloudDiscount(conflict.event.id))).toBe(7);
    await expectSynced('conta com o desconto da nuvem');
    expect(st().orders.find((o) => o.id === order!.id)!.remaining_balance.toFixed(2)).toBe(sql(`SELECT remaining_balance FROM orders WHERE id = '${order!.id}'`));
    payCash(order!.id);
    await expectSynced('pagamento depois do conflito');
    expect(sql(`SELECT status || ' ' || discount_amount FROM orders WHERE id = '${order!.id}'`)).toBe('CLOSED 7.00');
  });

  it('desconto da nuvem adotado com cancelamento na fila: a conta seguinte leva a diferença, limitada ao bruto', async () => {
    // Achado do Codex em b03d23a: trocar todas as versões da conta na fila pelo desconto da
    // nuvem (R$ 7) levava o desconto acima do bruto que um cancelamento seguinte deixou
    // (R$ 3,30), e o banco recusava o aumento sem autorização.
    login(OWNER_PIN);
    const agua = ok(st().saveProduct({
      category_id: categoryId, code: '453', name: 'Água', description: null, price: 3, sector: 'BAR', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '22011000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    await expectSynced('água');
    const [order] = await cashbackOrders(1, 52);
    login(CASHIER_PIN);
    ok(st().addToTray({ order_id: order!.id, product_id: agua.id, half_product_ids: [], quantity: 1, unit_price: 3, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: agua.sector }));
    ok(st().dispatchTray(order!.id));
    ok(st().applyDiscount(order!.id, 5, MANAGER));
    await expectSynced('água e desconto de R$ 5');
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -2, 'Outro aparelho', '{"discount_before": 5, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${order!.id}';`);
    ok(st().startCheckout(order!.id));
    expect(await sync()).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order!.id)!;
    // Na fila, atrás da recusa: o cancelamento do prato (fica só a água, R$ 3,30 com os 10%).
    const prato = st().orderItems.find((i) => i.order_id === order!.id && i.product_id === productId)!;
    ok(st().cancelOrderItem(prato.id, MANAGER));
    expect(st().orders.find((o) => o.id === order!.id)!.discount_amount).toBe(3.3);
    // Achado do Codex em cd47453: consumo novo depois do cancelamento (o desconto fica 3,30).
    // A diferença que o cancelamento já absorveu não volta na versão seguinte da conta.
    ok(st().addToTray({ order_id: order!.id, product_id: agua.id, half_product_ids: [], quantity: 2, unit_price: 3, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: agua.sector }));
    ok(st().dispatchTray(order!.id));
    expect(st().orders.find((o) => o.id === order!.id)!.discount_amount).toBe(3.3);
    expect(ok(st().adoptCloudDiscount(conflict.event.id))).toBe(7);
    await expectSynced('conta com o desconto da nuvem, o cancelamento e o consumo novo');
    const local = st().orders.find((o) => o.id === order!.id)!;
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order!.id}'`)).toBe(`${local.discount_amount.toFixed(2)} ${local.total_amount.toFixed(2)}`);
    expect(local.discount_amount).toBe(3.3);
    closeCashbackOrders([order!.id]);
  });

  it('desconto da nuvem menor adotado com cancelamento na fila: o limite ao bruto não leva a diferença do aparelho', async () => {
    // Achado do Codex em 38c5497: aparelho com R$ 7 de cashback, nuvem com R$ 5 (outro
    // aparelho reduziu e o banco estornou). O cancelamento atrás da recusa limita o desconto
    // do aparelho ao bruto de R$ 5,50; o banco fica com 5 (abaixo do bruto). Levar a diferença
    // (−2) para a versão seguinte dava 3,50, e o banco recusava a redução.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    login(OWNER_PIN);
    const product = (code: string, name: string, price: number) => ok(st().saveProduct({
      category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    const big = product('456', 'Vazio', 100);
    const small = product('457', 'Farofa', 5);
    ok(st().saveTable({ number: 55, label: 'Mesa 55', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('produtos e mesa');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 55)!.id, 1, null));
    for (const p of [big, small]) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    ok(st().dispatchTray(order.id));
    await expectSynced('conta de R$ 105 + 10%');
    const phone = '5553988119055';
    const c = cashbackCustomer(phone, [{ amount: 7, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 7, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 7, remaining_amount: 7 }],
    });
    expect(ok(st().redeemCashback(order.id, phone)).amount).toBe(7);
    await expectSynced('resgate de R$ 7');
    // Outro aparelho: a conta fica com R$ 5 na nuvem (o banco devolve R$ 2 ao cliente).
    sql(`UPDATE orders SET discount_amount = 5 WHERE id = '${order.id}';`);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order.id}'`)).toBe('5.00');
    ok(st().startCheckout(order.id));
    expect(await sync()).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order.id)!;
    expect(conflict.message).toContain('TCHEFOOD_DESCONTO');
    // Na fila, atrás da recusa: o cancelamento do vazio (fica a farofa, R$ 5,50 com os 10%).
    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === order.id && i.product_id === big.id)!.id, MANAGER));
    expect(st().orders.find((o) => o.id === order.id)!.discount_amount).toBe(5.5);
    expect(ok(st().adoptCloudDiscount(conflict.event.id))).toBe(5);
    await expectSynced('conta com o desconto menor da nuvem e o cancelamento');
    const local = st().orders.find((o) => o.id === order.id)!;
    expect(local.discount_amount).toBe(5);
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe(`${local.discount_amount.toFixed(2)} ${local.total_amount.toFixed(2)}`);
    closeCashbackOrders([order.id]);
  });

  it('conta fechada sem internet com o desconto daqui: o desconto menor da nuvem não é adotado', async () => {
    // Achado do Codex em 8f543cb: aparelho com R$ 7 de cashback fecha a conta sem internet;
    // a nuvem tem R$ 5. Adotar deixaria a conta fechada com R$ 2 de saldo, que o aparelho não
    // cobra e o banco não aceita fechar.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [order] = await cashbackOrders(1, 56);
    const phone = '5553988119056';
    const c = cashbackCustomer(phone, [{ amount: 7, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 7, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 7, remaining_amount: 7 }],
    });
    expect(ok(st().redeemCashback(order!.id, phone)).amount).toBe(7);
    await expectSynced('resgate de R$ 7');
    sql(`UPDATE orders SET discount_amount = 5 WHERE id = '${order!.id}';`);
    // Sem internet: vai para o pagamento, recebe e fecha com o desconto daqui.
    ok(st().startCheckout(order!.id));
    payCash(order!.id);
    const closed = st().orders.find((o) => o.id === order!.id)!;
    expect(closed.status).toBe('CLOSED');
    expect(await sync()).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order!.id)!;
    expect(conflict.message).toContain('na nuvem é R$ 5.00');
    const adopted = st().adoptCloudDiscount(conflict.event.id);
    expect(adopted.ok).toBe(false);
    if (!adopted.ok) expect(adopted.error).toContain('já foi fechada neste aparelho');
    const after = st().orders.find((o) => o.id === order!.id)!;
    expect([after.status, after.discount_amount, after.remaining_balance]).toEqual(['CLOSED', 7, 0]);
    expect(st().syncRejected.some((r) => r.event.id === conflict.event.id)).toBe(true);
    // Limpa o caso para os testes seguintes (na loja, o gerente confere com o cliente).
    useTcheStore.setState({ outbox: [], syncRejected: st().syncRejected.filter((r) => r.event.id !== conflict.event.id) });
    closeCashbackOrders([order!.id]);
  });

  it('duas trocas de desconto sem internet e outra na nuvem: o gerente confirma de novo e a autorização nova descreve a troca', async () => {
    // P1-01 da rodada 5 do GPT: sem internet o gerente autoriza R$ 5 e depois R$ 6; na nuvem,
    // outro aparelho deixou R$ 7. Antes, adotar a nuvem refazia a conta para R$ 8 e mandava a
    // autorização 5 → 6 sem mudar (o PIN do gerente valia para outra troca, e o banco recusava).
    const [order] = await cashbackOrders(1, 58);
    login(CASHIER_PIN);
    // As duas trocas com um minuto entre elas (não são a mesma operação para a fila).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    ok(st().applyDiscount(order!.id, 5, MANAGER));
    vi.setSystemTime(new Date('2026-11-12T20:01:00-03:00'));
    ok(st().applyDiscount(order!.id, 6, MANAGER));
    const firstAuths = st().auditLogs.filter((l) => l.order_id === order!.id && l.action_type === 'DISCOUNT_APPLIED');
    expect(firstAuths.map((l) => `${l.metadata?.discount_before}→${l.metadata?.discount_after}`).sort()).toEqual(['0→5', '5→6']);
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -7, 'Outro aparelho', '{"discount_before": 0, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${order!.id}';`);
    expect(await sync()).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order!.id)!;
    expect(conflict.message).toContain('na nuvem é R$ 7.00');
    // Sem o PIN do gerente não adota: a troca 5 → 6 da fila ficaria descrevendo outra troca.
    const withoutPin = st().adoptCloudDiscount(conflict.event.id);
    expect(withoutPin.ok).toBe(false);
    if (!withoutPin.ok) expect(withoutPin.error).toBe(ADOPT_CLOUD_DISCOUNT_NEEDS_MANAGER);
    expect(st().syncRejected.some((r) => r.event.id === conflict.event.id)).toBe(true);
    expect(ok(st().adoptCloudDiscount(conflict.event.id, MANAGER))).toBe(7);
    // A autorização original fica no histórico; a nova aponta para ela.
    const auths = st().auditLogs.filter((l) => l.order_id === order!.id && l.action_type === 'DISCOUNT_APPLIED');
    const original = auths.find((l) => l.metadata?.discount_before === 5)!;
    const renewed = auths.find((l) => l.metadata?.replaces_audit_id === original.id)!;
    expect(renewed.metadata).toMatchObject({ discount_before: 7, discount_after: 6, original_discount_before: 5, original_discount_after: 6 });
    expect(renewed.amount_impact).toBe(1);
    expect(renewed.id).not.toBe(original.id);
    expect(st().orders.find((o) => o.id === order!.id)!.discount_amount).toBe(6);
    await expectSynced('trocas reautorizadas pelo gerente');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order!.id}'`)).toBe('6.00');
    // No banco: a última autorização é a nova (R$ 7 → R$ 6), ligada à troca original, e a
    // original (R$ 5 → R$ 6) nunca subiu como autorização válida da conta.
    expect(sql(`SELECT (metadata->>'discount_before') || '→' || (metadata->>'discount_after') || ' ' || (metadata->>'replaces_audit_id')
                  FROM audit_logs WHERE order_id = '${order!.id}' AND action_type = 'DISCOUNT_APPLIED' ORDER BY server_seq DESC LIMIT 1`))
      .toBe(`7→6 ${original.id}`);
    expect(sql(`SELECT count(*) FROM audit_logs WHERE id = '${original.id}'`)).toBe('0');
    payCash(order!.id);
    await expectSynced('pagamento com o desconto reautorizado');
    expect(sql(`SELECT status || ' ' || discount_amount || ' ' || remaining_balance FROM orders WHERE id = '${order!.id}'`)).toBe('CLOSED 6.00 0.00');
  });

  it('resgate de cashback na fila atrás da recusa: adotar o desconto da nuvem refaz o valor do resgate', async () => {
    // Achado do Codex em f793339: desconto 5 aqui e 7 na nuvem; o resgate feito aqui antes de
    // a recusa aparecer pedia 50% da conta com desconto 5, e o banco (que calcula com 7)
    // recusava o valor depois de adotar o desconto da nuvem.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [order] = await cashbackOrders(1, 61);
    login(CASHIER_PIN);
    ok(st().applyDiscount(order!.id, 5, MANAGER));
    await expectSynced('desconto de R$ 5');
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -2, 'Outro aparelho', '{"discount_before": 5, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${order!.id}';`);
    const phone = '5553988119061';
    const c = cashbackCustomer(phone, [{ amount: 200, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 200, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 200, remaining_amount: 200 }],
    });
    // Sem internet: tira os 10% (a conta sobe com desconto 5 e vai ser recusada) e resgata.
    ok(st().removeServiceFee(order!.id, MANAGER));
    const gross = Math.round(st().orders.find((o) => o.id === order!.id)!.subtotal_items * 100);
    const redeemed = ok(st().redeemCashback(order!.id, phone)).amount;
    expect(redeemed).toBe(Math.round((gross - 500) / 2) / 100);
    expect(await sync()).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order!.id)!;
    expect(conflict.message).toContain('na nuvem é R$ 7.00');
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${order!.id}'`)).toBe('0');
    expect(ok(st().adoptCloudDiscount(conflict.event.id))).toBe(7);
    const amount = Math.round((gross - 700) / 2) / 100;
    expect(st().cashbackLedger.find((e) => e.order_id === order!.id && e.entry_type === 'REDEEM')!.amount).toBe(amount);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(Math.round((200 - amount) * 100) / 100);
    await expectSynced('conta com o desconto da nuvem e o resgate refeito');
    const local = st().orders.find((o) => o.id === order!.id)!;
    expect(local.discount_amount).toBe(Math.round((7 + amount) * 100) / 100);
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order!.id}'`)).toBe(`${local.discount_amount.toFixed(2)} ${local.total_amount.toFixed(2)}`);
    expect(sql(`SELECT amount FROM cashback_ledger WHERE order_id = '${order!.id}' AND entry_type = 'REDEEM'`)).toBe(amount.toFixed(2));
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe((200 - amount).toFixed(2));
    closeCashbackOrders([order!.id]);
    setCashbackClock(null);
  });

  it('resgate com o estorno de outra conta feito aqui: espera o cancelamento ser aceito, mesmo recusado', async () => {
    // P1-02 da rodada 5 do GPT: o cancelamento na conta A devolve R$ 10 ao cliente neste
    // aparelho (espelho do estorno), e a conta B usa esse crédito. Se o cancelamento de A for
    // recusado, o estorno não existe na nuvem: o resgate de B não pode subir antes.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [a, b] = await cashbackOrders(2, 59);
    const phone = '5553988119059';
    const c = cashbackCustomer(phone, [{ amount: 10, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 10, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 10, remaining_amount: 10 }],
    });
    expect(ok(st().redeemCashback(a!.id, phone)).amount).toBe(10);
    await expectSynced('resgate de R$ 10 na conta A');
    // O PIN do gerente mudou em outro aparelho: o cancelamento de A vai ser recusado.
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active AND pin_code = '${MANAGER_PIN}'`);
    sql(`UPDATE staff_users SET pin_code = '8462' WHERE id = '${manager}';`);
    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === a!.id && i.status !== 'CANCELED')!.id, MANAGER));
    const refund = st().cashbackLedger.find((e) => e.order_id === a!.id && e.entry_type === 'REFUND')!;
    expect(refund.amount).toBe(10);
    // A conta B usa o crédito do estorno (o único do cliente).
    expect(ok(st().redeemCashback(b!.id, phone)).amount).toBe(10);
    const redeemB = st().outbox.find((e) => e.table === 'cashback_ledger' && e.op === 'INSERT' && e.payload.order_id === b!.id)!;
    // O resgate espera o evento da conta A que faz o banco gravar o estorno.
    const refundEvent = st().outbox.find((e) => e.id === refund.source_event_id)!;
    expect([refundEvent.table, refundEvent.row_id]).toEqual(['orders', a!.id]);
    expect(redeemB.depends_on_event_ids).toEqual([refund.source_event_id]);
    const rejected = await sync();
    expect(rejected.map((r) => r.message)).toEqual(['O servidor não confirmou o PIN do gerente (PIN alterado ou bloqueado por tentativas).']);
    // O resgate de B não foi chamado: segue na fila, sem recusa, e nada de B mudou na nuvem.
    expect(st().outbox.some((e) => e.id === redeemB.id)).toBe(true);
    expect(st().syncRejected.some((r) => r.event.id === redeemB.id)).toBe(false);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${b!.id}'`)).toBe('0');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${b!.id}'`)).toBe('0.00');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('0.00');
    // Outra rodada com a recusa guardada (como a sincronização do app): o resgate continua esperando.
    const cloud = st().cloud!;
    const again = await flushOutbox(st().outbox, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000, st().syncRejected.map((r) => r.event));
    expect([again.sent, again.rejected]).toEqual([[], []]);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${b!.id}'`)).toBe('0');
    // O PIN volta a conferir e o cancelamento é reenviado: o estorno nasce na nuvem e o
    // resgate de B sobe depois, com o crédito do estorno.
    sql(`UPDATE staff_users SET pin_code = '${MANAGER_PIN}' WHERE id = '${manager}';`);
    st().retryRejectedSync();
    await expectSynced('cancelamento de A e resgate de B');
    expect(sql(`SELECT string_agg(entry_type || ' ' || amount || ' ' || remaining_amount, ' | ' ORDER BY created_at) FROM cashback_ledger WHERE order_id IN ('${a!.id}', '${b!.id}') AND entry_type IN ('REFUND', 'REDEEM') AND (order_id = '${b!.id}' OR entry_type = 'REFUND')`))
      .toBe('REFUND 10.00 0.00 | REDEEM 10.00 0.00');
    expect(sql(`SELECT (redeem_sources->0->>'source_id') = (SELECT id::text FROM cashback_ledger WHERE order_id = '${a!.id}' AND entry_type = 'REFUND') FROM cashback_ledger WHERE order_id = '${b!.id}' AND entry_type = 'REDEEM'`)).toBe('t');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${b!.id}'`)).toBe('10.00');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('0.00');
    // A falha de PIN deste teste não conta para o bloqueio dos testes seguintes (60 s).
    sql(`SET session_replication_role = replica; DELETE FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED' AND order_id = '${a!.id}';`);
    closeCashbackOrders([a!.id, b!.id]);
    setCashbackClock(null);
  });

  it('resgate refeito com o desconto da nuvem: o estorno da conta feito aqui é refeito junto', async () => {
    // P1-01 da rodada 6 do GPT: R$ 100 sem os 10%, desconto 5 aqui e 7 na nuvem. Sem internet:
    // resgate de R$ 47,50 e cancelamento que deixa o bruto em R$ 20. O desconto manual fica
    // (P0-02 da rodada 8): manual 5 + cashback 15, estorno local de R$ 32,50. Adotar o
    // desconto da nuvem refaz o resgate para R$ 46,50; com o manual de 7, o estorno é R$ 33,50.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    login(OWNER_PIN);
    const product = (code: string, name: string, price: number) => ok(st().saveProduct({
      category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    const maminha = product('461', 'Maminha', 80);
    const fritas = product('462', 'Fritas', 20);
    ok(st().saveTable({ number: 63, label: 'Mesa 63', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('produtos e mesa');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 63)!.id, 1, null));
    for (const p of [maminha, fritas]) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    ok(st().dispatchTray(order.id));
    ok(st().removeServiceFee(order.id, MANAGER));
    ok(st().applyDiscount(order.id, 5, MANAGER));
    await expectSynced('conta de R$ 100 com desconto de R$ 5');
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -2, 'Outro aparelho', '{"discount_before": 5, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${order.id}';`);
    const phone = '5553988119063';
    const c = cashbackCustomer(phone, [{ amount: 200, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 200, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 200, remaining_amount: 200 }],
    });
    // Sem internet: a conta vai para pagamento (sobe com desconto 5 e será recusada), resgate e cancelamento.
    ok(st().startCheckout(order.id));
    expect(ok(st().redeemCashback(order.id, phone)).amount).toBe(47.5);
    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === order.id && i.product_id === maminha.id)!.id, MANAGER));
    const localRefund = () => st().cashbackLedger.filter((e) => e.order_id === order.id && e.entry_type === 'REFUND').reduce((sum, e) => sum + Math.round(e.amount * 100), 0) / 100;
    const localRefundLogs = () => st().auditLogs.filter((l) => l.order_id === order.id && l.action_type === 'CASHBACK_REFUNDED');
    expect(localRefund()).toBe(32.5);
    expect(await sync()).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order.id)!;
    expect(conflict.message).toContain('na nuvem é R$ 7.00');
    expect(ok(st().adoptCloudDiscount(conflict.event.id))).toBe(7);
    // Espelho refeito: resgate 46,50, estorno 33,50 (com o registro do valor anterior), saldo 187.
    expect(st().cashbackLedger.find((e) => e.order_id === order.id && e.entry_type === 'REDEEM')!.amount).toBe(46.5);
    expect(localRefund()).toBe(33.5);
    expect(localRefundLogs().reduce((sum, l) => sum + Math.round(Number(l.amount_impact) * 100), 0) / 100).toBe(33.5);
    expect(localRefundLogs().every((l) => l.metadata?.amount_before_cloud_discount === 32.5 && l.metadata?.cause === 'ITEM_CANCELED')).toBe(true);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(187);
    const pending = [...st().outbox];
    await expectSynced('conta, resgate e cancelamento depois de adotar a nuvem');
    // O reenvio do cancelamento (internet caiu antes da confirmação) não repete o estorno.
    const cloud = st().cloud!;
    const cancelAt = pending.findIndex((e) => e.table === 'audit_logs' && e.payload.action_type === 'ITEM_CANCELED' && e.payload.order_id === order.id);
    expect(cancelAt).toBeGreaterThan(0);
    const resend = await flushOutbox(pending.slice(cancelAt), { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(resend.rejected).toEqual([]);
    expect(sql(`SELECT (SELECT amount FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REDEEM') || ' ' || (SELECT sum(amount) || ' ' || count(*) FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND')`))
      .toBe(`46.50 33.50 ${st().cashbackLedger.filter((e) => e.order_id === order.id && e.entry_type === 'REFUND').length}`);
    expect(sql(`SELECT sum(amount_impact) FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'CASHBACK_REFUNDED'`)).toBe('33.50');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('187.00');
    const local = st().orders.find((o) => o.id === order.id)!;
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe(`${local.discount_amount.toFixed(2)} ${local.total_amount.toFixed(2)}`);
    expect(local.discount_amount).toBe(20);
    closeCashbackOrders([order.id]);
    setCashbackClock(null);
  });

  it('resgate na fila ao adotar o desconto da nuvem, sem cancelamento: nenhum estorno é criado', async () => {
    // P1-01 da rodada 7 do GPT: o resgate na fila era procurado pelo id do evento, não pelo
    // id do registro. Conta de R$ 100 + 10%, desconto 5 aqui e 7 na nuvem. Sem internet:
    // pagamento (recusado), remoção dos 10% e resgate. Adotar a nuvem refaz o resgate para
    // R$ 46,50 sem estorno: saldo 153,50 aqui e no banco.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    login(OWNER_PIN);
    const product = (code: string, name: string, price: number) => ok(st().saveProduct({
      category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    const picanha = product('481', 'Picanha', 80);
    const arroz = product('482', 'Arroz', 20);
    ok(st().saveTable({ number: 71, label: 'Mesa 71', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('produtos e mesa');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 71)!.id, 1, null));
    for (const p of [picanha, arroz]) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    ok(st().dispatchTray(order.id));
    ok(st().applyDiscount(order.id, 5, MANAGER));
    await expectSynced('conta de R$ 100 + 10% com desconto de R$ 5');
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active LIMIT 1`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${order.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -2, 'Outro aparelho', '{"discount_before": 5, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${order.id}';`);
    const phone = '5553988119071';
    const c = cashbackCustomer(phone, [{ amount: 200, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 200, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 200, remaining_amount: 200 }],
    });
    ok(st().startCheckout(order.id));
    ok(st().removeServiceFee(order.id, MANAGER));
    expect(ok(st().redeemCashback(order.id, phone)).amount).toBe(47.5);
    expect(await sync()).toHaveLength(1);
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === order.id)!;
    expect(conflict.message).toContain('na nuvem é R$ 7.00');
    // O resgate ainda não subiu (está na fila, segurado pela conta recusada).
    expect(st().outbox.some((e) => e.table === 'cashback_ledger' && e.payload.order_id === order.id && e.payload.entry_type === 'REDEEM')).toBe(true);
    expect(ok(st().adoptCloudDiscount(conflict.event.id))).toBe(7);
    const refunds = () => st().cashbackLedger.filter((e) => e.order_id === order.id && e.entry_type === 'REFUND');
    expect(refunds()).toEqual([]);
    expect(st().auditLogs.filter((l) => l.order_id === order.id && l.action_type === 'CASHBACK_REFUNDED')).toEqual([]);
    expect(st().cashbackLedger.find((e) => e.order_id === order.id && e.entry_type === 'REDEEM')!.amount).toBe(46.5);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(153.5);
    const pending = [...st().outbox];
    await expectSynced('conta, taxa e resgate depois de adotar a nuvem');
    const cloudState = () => sql(`SELECT (SELECT string_agg(amount::text, ',') FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REDEEM') || ' '
      || (SELECT count(*) FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND') || ' '
      || (SELECT count(*) FROM audit_logs WHERE order_id = '${order.id}' AND action_type IN ('CASHBACK_REDEEMED', 'CASHBACK_REFUNDED')) || ' '
      || (SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}')`);
    expect(cloudState()).toBe('46.50 0 1 153.50');
    expect(refunds()).toEqual([]);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(153.5);
    // Reenvio de tudo (internet caiu antes da confirmação): o resgate não duplica, e a conta
    // antiga (desconto 7, de antes do resgate) é recusada sem mexer em nada.
    const cloud = st().cloud!;
    const resend = await flushOutbox(pending, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    const ordersEvents = new Set(pending.filter((e) => e.table === 'orders').map((e) => e.id));
    expect(resend.rejected.length).toBeGreaterThan(0);
    expect(resend.rejected.every((r) => ordersEvents.has(r.eventId) && r.message.startsWith('TCHEFOOD_DESCONTO'))).toBe(true);
    const redeemAgain = await flushOutbox(pending.filter((e) => e.table === 'cashback_ledger'), { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(redeemAgain.rejected).toEqual([]);
    expect(redeemAgain.sent.length).toBeGreaterThan(0);
    expect(cloudState()).toBe('46.50 0 1 153.50');
    const local = st().orders.find((o) => o.id === order.id)!;
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe(`${local.discount_amount.toFixed(2)} ${local.total_amount.toFixed(2)}`);
    closeCashbackOrders([order.id]);
    setCashbackClock(null);
  });

  it('autorização de desconto de antes do estorno do cashback não vale depois dele', async () => {
    // P0-01 (versão B) da rodada 7 do GPT: desconto 0→5 autorizado, resgate, todos os itens
    // cancelados (o desconto cai a zero e o cashback volta), itens novos. Um PATCH com
    // desconto 5 sem autorização nova não pode reaproveitar a autorização antiga.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [order] = await cashbackOrders(1, 72);
    login(CASHIER_PIN);
    ok(st().applyDiscount(order!.id, 5, MANAGER));
    const phone = '5553988119072';
    const c = cashbackCustomer(phone, [{ amount: 200, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 200, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 200, remaining_amount: 200 }],
    });
    ok(st().redeemCashback(order!.id, phone));
    await expectSynced('desconto 0→5 e resgate');
    for (const item of st().orderItems.filter((i) => i.order_id === order!.id && i.status !== 'CANCELED')) ok(st().cancelOrderItem(item.id, MANAGER));
    const cancelEvents = [...st().outbox];
    await expectSynced('todos os itens cancelados');
    expect(sql(`SELECT discount_amount || ' ' || (SELECT count(*) FROM cashback_ledger WHERE order_id = '${order!.id}' AND entry_type = 'REFUND') FROM orders WHERE id = '${order!.id}'`)).toMatch(/^0\.00 [1-9]/);
    const p = st().products.find((x) => x.id === productId)!;
    ok(st().addToTray({ order_id: order!.id, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order!.id));
    await expectSynced('itens novos');
    const snapshot = () => sql(`SELECT o.discount_amount || ' ' || o.total_amount || ' '
      || (SELECT count(*) FROM audit_logs a WHERE a.order_id = o.id AND a.action_type IN ('DISCOUNT_APPLIED', 'CASHBACK_REFUNDED', 'CASHBACK_REDEEMED')) || ' '
      || (SELECT count(*) FROM cashback_ledger l WHERE l.order_id = o.id) || ' '
      || (SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}') FROM orders o WHERE o.id = '${order!.id}'`);
    const before = snapshot();
    expect(before.split(' ')[0]).toBe('0.00');
    const reuse = await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 5 });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toContain('TCHEFOOD_');
    expect(snapshot()).toBe(before);
    // Nem quem tenta zerar o marcador da autorização já usada passa.
    expect((await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: 5, discount_auth_seq: 0 })).status).toBe(400);
    expect(snapshot()).toBe(before);
    // Autorização nova com PIN: a regra da loja não combina desconto manual com cashback.
    const fresh = st().applyDiscount(order!.id, 5, MANAGER);
    expect(fresh.ok).toBe(false);
    expect(!fresh.ok && fresh.error).toContain('já usou cashback');
    // O reenvio do cancelamento (internet caiu antes da confirmação) não repete o estorno.
    const cloud = st().cloud!;
    const resend = await flushOutbox(cancelEvents, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(resend.rejected).toEqual([]);
    expect(snapshot()).toBe(before);
    closeCashbackOrders([order!.id]);
    setCashbackClock(null);
  });

  it('resgate refeito com o desconto da nuvem passa a usar o estorno de outra conta: espera o cancelamento dela', async () => {
    // P1-02 da rodada 6 do GPT: na terça o resgate de B sai de um crédito que vence na terça à
    // noite. Na quarta, ao adotar o desconto da nuvem, o crédito venceu e o resgate refeito sai
    // do estorno local da conta A, cujo cancelamento é recusado: B espera A.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T20:00:00-03:00') });
    setCashbackClock('2026-11-10T20:00:00-03:00');
    const [a, b] = await cashbackOrders(2, 64);
    login(CASHIER_PIN);
    ok(st().applyDiscount(b!.id, 5, MANAGER));
    await expectSynced('desconto de R$ 5 em B');
    const phone = '5553988119064';
    const c = cashbackCustomer(phone, [{ amount: 10, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 10, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 10, remaining_amount: 10 }],
    });
    expect(ok(st().redeemCashback(a!.id, phone)).amount).toBe(10);
    await expectSynced('resgate de R$ 10 em A');
    // Crédito novo de R$ 60 que vence na terça às 23h.
    const earnE = crypto.randomUUID();
    sql(`SET session_replication_role = replica; INSERT INTO cashback_ledger (id, tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
         VALUES ('${earnE}', '${TENANT}', '${c.id}', 'EARN', 60, 60, '2026-11-01', '2026-11-10T23:00:00-03:00');`);
    const cloudE = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${earnE}'`));
    useTcheStore.setState({ cashbackLedger: [...st().cashbackLedger, { ...cloudE, amount: 60, remaining_amount: 60 }] });
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active AND pin_code = '${MANAGER_PIN}'`);
    sql(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, amount_impact, reason, metadata)
         VALUES ('${TENANT}', '${b!.id}', '${manager}', '${manager}', 'DISCOUNT_APPLIED', -2, 'Outro aparelho', '{"discount_before": 5, "discount_after": 7}');
         UPDATE orders SET discount_amount = 7 WHERE id = '${b!.id}';
         UPDATE staff_users SET pin_code = '8462' WHERE id = '${manager}';`);
    // Sem internet: cancelamento em A (estorno local de R$ 10, até 31/12) e resgate em B só do crédito de terça.
    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === a!.id && i.status !== 'CANCELED')!.id, MANAGER));
    const refundA = st().cashbackLedger.find((e) => e.order_id === a!.id && e.entry_type === 'REFUND')!;
    expect(refundA.amount).toBe(10);
    ok(st().startCheckout(b!.id));
    const first = ok(st().redeemCashback(b!.id, phone)).amount;
    const redeemB = () => st().outbox.find((e) => e.table === 'cashback_ledger' && e.op === 'INSERT' && e.payload.order_id === b!.id)!;
    expect(redeemB().payload.redeem_sources).toEqual([{ source_id: earnE, amount: first }]);
    expect(redeemB().depends_on_event_ids).toBeUndefined();
    // Quarta: o crédito de terça venceu.
    vi.setSystemTime(new Date('2026-11-11T20:00:00-03:00'));
    setCashbackClock('2026-11-11T20:00:00-03:00');
    const rejected = await sync();
    expect(rejected.map((r) => r.message).sort()).toEqual([
      'O servidor não confirmou o PIN do gerente (PIN alterado ou bloqueado por tentativas).',
      expect.stringContaining('na nuvem é R$ 7.00'),
    ].sort());
    const conflict = st().syncRejected.find((r) => r.event.table === 'orders' && r.event.row_id === b!.id)!;
    expect(ok(st().adoptCloudDiscount(conflict.event.id))).toBe(7);
    // O resgate refeito sai do estorno de A e espera o evento que o grava no banco.
    expect(redeemB().payload.amount).toBe(10);
    expect(redeemB().payload.redeem_sources).toEqual([{ source_id: refundA.id, amount: 10 }]);
    expect(redeemB().depends_on_event_ids).toEqual([refundA.source_event_id]);
    const cloud = st().cloud!;
    const round = await flushOutbox(st().outbox, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000, st().syncRejected.map((r) => r.event));
    st().ackSyncedEvents(round.sent);
    expect(round.rejected).toEqual([]);
    expect(round.sent).not.toContain(redeemB().id);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${b!.id}'`)).toBe('0');
    // O PIN volta a conferir e o cancelamento de A é reenviado: A e depois B sobem.
    sql(`UPDATE staff_users SET pin_code = '${MANAGER_PIN}' WHERE id = '${manager}';`);
    st().retryRejectedSync();
    await expectSynced('cancelamento de A e resgate refeito de B');
    expect(sql(`SELECT amount || ' ' || ((redeem_sources->0->>'source_id') = (SELECT id::text FROM cashback_ledger WHERE order_id = '${a!.id}' AND entry_type = 'REFUND')) FROM cashback_ledger WHERE order_id = '${b!.id}' AND entry_type = 'REDEEM'`)).toBe('10.00 true');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('0.00');
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(0);
    sql(`SET session_replication_role = replica; DELETE FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED' AND order_id = '${a!.id}';`);
    closeCashbackOrders([a!.id, b!.id]);
    setCashbackClock(null);
  });

  it('estorno de outra conta já aceito pela nuvem: o resgate sobe mesmo com outra operação daquela conta recusada', async () => {
    // P2-01 da rodada 6 do GPT: o resgate de B só espera o evento que grava o estorno de A.
    // Depois que ele subiu, uma operação recusada e independente em A não segura B.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [a, b] = await cashbackOrders(2, 66);
    const phone = '5553988119066';
    const c = cashbackCustomer(phone, [{ amount: 10, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 10, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 10, remaining_amount: 10 }],
    });
    expect(ok(st().redeemCashback(a!.id, phone)).amount).toBe(10);
    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === a!.id && i.status !== 'CANCELED')!.id, MANAGER));
    await expectSynced('resgate e cancelamento de A');
    expect(sql(`SELECT sum(amount) FROM cashback_ledger WHERE order_id = '${a!.id}' AND entry_type = 'REFUND'`)).toBe('10.00');
    // Outra operação de A, recusada (o PIN do gerente mudou em outro aparelho).
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'MANAGER' AND active AND pin_code = '${MANAGER_PIN}'`);
    sql(`UPDATE staff_users SET pin_code = '8462' WHERE id = '${manager}';`);
    ok(st().removeServiceFee(a!.id, MANAGER));
    // B resgata do estorno já gravado no banco: não espera nada de A.
    const amount = ok(st().redeemCashback(b!.id, phone)).amount;
    expect(amount).toBe(10);
    const redeemB = st().outbox.find((e) => e.table === 'cashback_ledger' && e.op === 'INSERT' && e.payload.order_id === b!.id)!;
    expect(redeemB.depends_on_event_ids).toBeUndefined();
    const rejected = await sync();
    expect(rejected.map((r) => r.message)).toEqual(['O servidor não confirmou o PIN do gerente (PIN alterado ou bloqueado por tentativas).']);
    expect(st().outbox.some((e) => e.id === redeemB.id)).toBe(false);
    expect(sql(`SELECT amount FROM cashback_ledger WHERE order_id = '${b!.id}' AND entry_type = 'REDEEM'`)).toBe('10.00');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('0.00');
    // Só a operação recusada de A (e o que depende dela) fica para o gerente.
    expect(st().syncRejected.every((r) => r.event.row_id === a!.id || r.event.payload.order_id === a!.id)).toBe(true);
    sql(`UPDATE staff_users SET pin_code = '${MANAGER_PIN}' WHERE id = '${manager}';
         SET session_replication_role = replica; DELETE FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED' AND order_id = '${a!.id}';`);
    useTcheStore.setState({ outbox: st().outbox.filter((e) => e.row_id !== a!.id && e.payload.order_id !== a!.id), syncRejected: st().syncRejected.filter((r) => r.event.row_id !== a!.id && r.event.payload.order_id !== a!.id) });
    closeCashbackOrders([a!.id, b!.id]);
    setCashbackClock(null);
  });

  it('cashback recusado pela nuvem: a conta não é cobrada nem encerrada até desfazer o cashback', async () => {
    // P0-01 da rodada 7 do GPT: aparelho na quinta 23h50, servidor já na sexta 00h10. Conta de
    // R$ 100 sem os 10%, resgate de R$ 50 sem internet; a nuvem recusa o resgate (sexta).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T23:50:00-03:00') });
    setCashbackClock('2026-11-13T00:10:00-03:00');
    login(OWNER_PIN);
    const product = (code: string, name: string, price: number) => ok(st().saveProduct({
      category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    const costela = product('471', 'Costela', 80);
    const salada = product('472', 'Salada', 20);
    ok(st().saveTable({ number: 69, label: 'Mesa 69', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('produtos e mesa');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 69)!.id, 1, null));
    for (const p of [costela, salada]) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    ok(st().dispatchTray(order.id));
    ok(st().removeServiceFee(order.id, MANAGER));
    await expectSynced('conta de R$ 100');
    const phone = '5553988119067';
    const c = cashbackCustomer(phone, [{ amount: 100, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 100, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 100, remaining_amount: 100 }],
    });
    expect(ok(st().redeemCashback(order.id, phone)).amount).toBe(50);
    expect(st().orders.find((o) => o.id === order.id)!.remaining_balance).toBe(50);
    const rejected = await sync();
    expect(rejected).toHaveLength(1);
    const refused = st().syncRejected.find((r) => r.event.table === 'cashback_ledger')!;
    expect(refused.status).toBe(400);
    expect(refused.message).toContain('terça a quinta');
    // Nenhuma cobrança pelo valor com o cashback recusado.
    const blocked = 'A nuvem recusou o cashback desta conta';
    const charges = st().pendingCharges.length;
    const payments = st().payments.length;
    const tryCash = () => st().registerPayment({
      orderId: order.id, amount: 50, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null,
      idempotency_key: `k-${Math.random()}`, item_ids: [],
    });
    for (const r of [st().startCheckout(order.id), tryCash(), st().beginTerminalCharge(order.id, `req-${Math.random()}`, 50)]) {
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain(blocked);
    }
    expect(st().pendingCharges.length).toBe(charges);
    expect(st().payments.length).toBe(payments);
    // Cancelar a costela deixa a conta zerada pelo cashback (bruto 20, estorno local de 30): não encerra.
    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === order.id && i.product_id === costela.id)!.id, MANAGER));
    expect(st().orders.find((o) => o.id === order.id)!.remaining_balance).toBe(0);
    const zero = st().closeZeroOrder(order.id);
    expect(!zero.ok && zero.error).toContain(blocked);
    expect(st().orders.find((o) => o.id === order.id)!.status).not.toBe('CLOSED');
    // Conciliação: desfazer o cashback. Conta sem desconto (R$ 20 a cobrar), crédito de volta,
    // sem estorno nem resgate aqui, e o registro do resgate fica sem valor, marcado como recusado.
    expect(ok(st().undoRejectedCashbackRedeem(refused.event.id))).toBe(50);
    const local = () => st().orders.find((o) => o.id === order.id)!;
    expect([local().discount_amount, local().total_amount, local().remaining_balance]).toEqual([0, 20, 20]);
    expect(st().cashbackLedger.filter((e) => e.order_id === order.id)).toEqual([]);
    expect(st().cashbackLedger.find((e) => e.id === c.earns[0])!.remaining_amount).toBe(100);
    expect(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance).toBe(100);
    const redeemLog = st().auditLogs.find((l) => l.order_id === order.id && l.action_type === 'CASHBACK_REDEEMED')!;
    expect([redeemLog.amount_impact, typeof redeemLog.metadata?.rejected_by_cloud]).toEqual([0, 'string']);
    expect(st().auditLogs.filter((l) => l.order_id === order.id && l.action_type === 'CASHBACK_REFUNDED')).toEqual([]);
    expect(st().syncRejected.some((r) => r.event.id === refused.event.id)).toBe(false);
    // A fila sobe sem recusa, e nuvem e aparelho ficam com a mesma conta, em centavos.
    await expectSynced('conta sem o cashback recusado');
    const cents = (v: string | number) => Math.round(Number(v) * 100);
    const cloudOrder = sql(`SELECT discount_amount || ' ' || total_amount || ' ' || remaining_balance FROM orders WHERE id = '${order.id}'`).split(' ').map(cents);
    expect(cloudOrder).toEqual([local().discount_amount, local().total_amount, local().remaining_balance].map(cents));
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${order.id}'`)).toBe('0');
    expect(cents(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`))).toBe(cents(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance));
    // Cobrança pelo valor que a nuvem reconhece: R$ 20, e a conta fecha nos dois lados.
    ok(st().startCheckout(order.id));
    payCash(order.id);
    await expectSynced('pagamento sem o cashback');
    expect(sql(`SELECT status || ' ' || paid_amount FROM orders WHERE id = '${order.id}'`)).toBe('CLOSED 20.00');
    setCashbackClock(null);
  });

  it('fila da versão anterior com o crédito já baixado: só com o registro do resgate na nuvem, sem consumir de novo', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [a, b, a1, a2] = await cashbackOrders(4, 21);
    for (const o of [a, b, a1, a2]) expect(o!.cap).toBeGreaterThanOrEqual(5);

    // P0-03 do GPT: a conta A da versão anterior baixou R$ 5 (todo o crédito) e caiu antes do REDEEM.
    const c = cashbackCustomer('5553988110002', [{ amount: 5, expires: '2026-12-31' }]);
    const auditA = legacyAudit(a!.id, c.id, 5);
    debit(c.earns[0]!, 5);
    // Outra conta (B) com a marca da versão anterior e sem prova: a baixa de A não vale para ela.
    const stolen = await cashbackRpc(b!.id, c.id, 5, { p_legacy_predebited: true });
    expect(stolen.status).toBe(400);
    expect(stolen.body).toContain('sem saldo');
    // Mesmo com o registro de A como prova, mas na conta B: não confere.
    expect((await cashbackRpc(b!.id, c.id, 5, { p_legacy_predebited: true, p_audit_id: auditA })).status).toBe(400);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${b!.id}'`)).toBe('0');
    // A sem a marca: segue a regra normal e não tem saldo.
    expect((await cashbackRpc(a!.id, c.id, 5, { p_audit_id: auditA })).body).toContain('sem saldo');
    // Crédito novo do cliente: a recuperação de A não pode consumi-lo.
    const earn2 = crypto.randomUUID();
    sql(`SET session_replication_role = replica; INSERT INTO cashback_ledger (id, tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
         VALUES ('${earn2}', '${TENANT}', '${c.id}', 'EARN', 5, 5, '2026-11-01', '2027-01-31');`);
    // A com a marca e a prova: o resgate entra com a baixa que já tinha saído.
    const recovered = await cashbackRpc(a!.id, c.id, 5, { p_legacy_predebited: true, p_audit_id: auditA });
    expect(recovered.status, recovered.body).toBe(200);
    expect(Number(recovered.body)).toBe(5);
    expect(remainingOf(earn2)).toBe(5);
    expect(remainingOf(c.earns[0]!)).toBe(0);

    // Duas contas da versão anterior com baixa parcial (créditos com validades diferentes):
    // R$ 5 baixados para resgates de R$ 4 e R$ 3. Não dá para saber de quem é: recusa as duas.
    const d = cashbackCustomer('5553988110004', [{ amount: 10, expires: '2026-11-20' }, { amount: 10, expires: '2026-12-31' }]);
    const audit1 = legacyAudit(a1!.id, d.id, 4);
    const audit2 = legacyAudit(a2!.id, d.id, 3);
    debit(d.earns[0]!, 5);
    for (const [o, audit, v] of [[a1!, audit1, 4], [a2!, audit2, 3]] as const) {
      const r = await cashbackRpc(o.id, d.id, v, { p_legacy_predebited: true, p_audit_id: audit });
      expect(r.status).toBe(400);
      expect(r.body).toContain('ambíguo');
    }
    expect(remainingOf(d.earns[0]!) + remainingOf(d.earns[1]!)).toBe(15);
    // O resto das baixas sobe (R$ 7, a soma dos dois): sem ambiguidade, cada um entra com o seu valor e nada é consumido de novo.
    debit(d.earns[0]!, 2);
    expect((await cashbackRpc(a1!.id, d.id, 4, { p_legacy_predebited: true, p_audit_id: audit1 })).status).toBe(200);
    expect((await cashbackRpc(a2!.id, d.id, 3, { p_legacy_predebited: true, p_audit_id: audit2 })).status).toBe(200);
    expect(remainingOf(d.earns[0]!) + remainingOf(d.earns[1]!)).toBe(13);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE entry_type = 'REDEEM' AND order_id IN ('${a!.id}', '${a1!.id}', '${a2!.id}')`)).toBe('3');

    // P2-01 da rodada 3: o registro antigo da conta B é do cliente C. Outro cliente (E, com
    // crédito) não pode reaproveitá-lo, com ou sem a marca: recusado e nada gravado.
    const auditB = legacyAudit(b!.id, c.id, 5);
    const e = cashbackCustomer('5553988110005', [{ amount: 5, expires: '2026-12-31' }]);
    for (const legacy of [false, true]) {
      const r = await cashbackRpc(b!.id, e.id, 5, { p_audit_id: auditB, p_legacy_predebited: legacy });
      expect(r.status, r.body).toBe(400);
      expect(r.body).toContain('não confere');
    }
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${b!.id}'`)).toBe('0');
    expect(remainingOf(e.earns[0]!)).toBe(5);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${b!.id}'`)).toBe('0.00');
    closeCashbackOrders([a!.id, b!.id, a1!.id, a2!.id]);
    setCashbackClock(null);
  });

  it('conciliação do cashback pelo gerente: baixa sem resgate e devolução retida, com PIN e motivo, só pelo servidor', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const cfg = { url: 'http://cloud.test', anonKey: 'anon', accessToken: 'token' };
    const fetchFn = postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' });
    const cashier = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND role = 'CASHIER' LIMIT 1`);
    const reason = 'Conferido com o cliente';
    const decide = (input: { kind: 'HOLD' | 'ORPHAN'; customerId: string; holdId: string | null; decision: 'RELEASE' | 'DISCARD'; amount: number; requestId?: string; managerPin?: string }) =>
      reconcileCashback(cfg, fetchFn, { requestId: crypto.randomUUID(), managerPin: MANAGER_PIN, performedBy: cashier, reason, ...input });
    const balanceOf = (id: string) => Number(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${id}'`));
    const [a1, a2, a3] = await cashbackOrders(3, 92);
    for (const o of [a1, a2, a3]) expect(o!.cap).toBeGreaterThanOrEqual(5);

    // Caso ambíguo da versão anterior: R$ 5 baixados para resgates de R$ 4 e R$ 3. Parado até o gerente conciliar.
    const d = cashbackCustomer('5553988110092', [{ amount: 10, expires: '2026-11-20' }, { amount: 10, expires: '2026-12-31' }]);
    const audit1 = legacyAudit(a1!.id, d.id, 4);
    const audit2 = legacyAudit(a2!.id, d.id, 3);
    debit(d.earns[0]!, 5);
    expect((await cashbackRpc(a1!.id, d.id, 4, { p_legacy_predebited: true, p_audit_id: audit1 })).body).toContain('ambíguo');
    let pending = await fetchCashbackPending(cfg, fetchFn);
    expect(pending.orphans.find((o) => o.customer_id === d.id)).toMatchObject({ amount: 5, pending_legacy_redeems: 2 });

    // O aparelho não grava a conciliação por fora: nem o SETTLE, nem o registro, nem a tabela.
    expect((await raw('POST', 'cashback_ledger', { id: crypto.randomUUID(), tenant_id: TENANT, customer_id: d.id, entry_type: 'SETTLE', amount: 5, remaining_amount: 0 })).status).toBe(400);
    expect((await raw('POST', 'audit_logs', { tenant_id: TENANT, performed_by_user_id: cashier, action_type: 'CASHBACK_RECONCILED', amount_impact: 0, reason, metadata: { customer_id: d.id } })).status).toBe(400);
    expect((await raw('GET', 'cashback_reconciliations?select=id', undefined)).status).toBe(403);
    expect((await raw('POST', 'cashback_reconciliations', { id: crypto.randomUUID(), tenant_id: TENANT, customer_id: d.id })).status).toBe(403);
    // PIN errado: nada muda, a tentativa fica registrada. Valor diferente do da tela: recusa. Motivo curto: recusa.
    expect(await decide({ kind: 'ORPHAN', customerId: d.id, holdId: null, decision: 'DISCARD', amount: 5, managerPin: '0000' })).toEqual({ ok: false, error: 'PIN de gerente incorreto.' });
    expect(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'MANAGER_PIN_FAILED' AND metadata->>'attempted_action' = 'CASHBACK_RECONCILED'`)).not.toBe('0');
    // A tentativa conta no bloqueio de 3 erros em 60 s: tira da janela para não bloquear os testes seguintes.
    sql(`SET session_replication_role = replica; UPDATE audit_logs SET created_at = created_at - INTERVAL '2 minutes' WHERE action_type = 'MANAGER_PIN_FAILED' AND metadata->>'attempted_action' = 'CASHBACK_RECONCILED';`);
    const stale = await decide({ kind: 'ORPHAN', customerId: d.id, holdId: null, decision: 'DISCARD', amount: 4 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toContain('mudou (agora R$ 5.00)');
    const short = await reconcileCashback(cfg, fetchFn, { requestId: crypto.randomUUID(), kind: 'ORPHAN', customerId: d.id, holdId: null, decision: 'DISCARD', amount: 5, managerPin: MANAGER_PIN, performedBy: cashier, reason: 'ok' });
    expect(short.ok).toBe(false);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE customer_id = '${d.id}' AND entry_type = 'SETTLE'`)).toBe('0');

    // Descartar: a baixa fica explicada (SETTLE), o saldo não muda e os dois resgates pendentes não entram mais.
    const discardId = crypto.randomUUID();
    expect(await decide({ requestId: discardId, kind: 'ORPHAN', customerId: d.id, holdId: null, decision: 'DISCARD', amount: 5 })).toEqual({ ok: true, amount: 5, repeated: false });
    expect(await decide({ requestId: discardId, kind: 'ORPHAN', customerId: d.id, holdId: null, decision: 'DISCARD', amount: 5 })).toEqual({ ok: true, amount: 5, repeated: true });
    // O mesmo id com outra decisão (resposta perdida e o gerente mudou de ideia): recusa.
    expect((await decide({ requestId: discardId, kind: 'ORPHAN', customerId: d.id, holdId: null, decision: 'RELEASE', amount: 5 })).ok).toBe(false);
    expect(sql(`SELECT count(*) || ' ' || sum(amount) FROM cashback_ledger WHERE customer_id = '${d.id}' AND entry_type = 'SETTLE'`)).toBe('1 5.00');
    expect(balanceOf(d.id)).toBe(15);
    expect(sql(`SELECT a.authorized_by_manager_id IS NOT NULL AND a.metadata->'settled_audit_ids' @> '["${audit1}", "${audit2}"]'::jsonb
                  FROM audit_logs a WHERE a.action_type = 'CASHBACK_RECONCILED' AND a.metadata->>'customer_id' = '${d.id}'`)).toBe('t');
    pending = await fetchCashbackPending(cfg, fetchFn);
    expect(pending.orphans.some((o) => o.customer_id === d.id)).toBe(false);
    for (const [o, audit, v] of [[a1!, audit1, 4], [a2!, audit2, 3]] as const) {
      const r = await cashbackRpc(o.id, d.id, v, { p_legacy_predebited: true, p_audit_id: audit });
      expect(r.status).toBe(400);
      expect(r.body).toContain('já foi conciliado');
    }
    // Resgate novo da versão anterior depois da conciliação: a baixa antiga já está explicada,
    // então ele baixa do saldo (não conta os R$ 5 conciliados como já baixados para ele).
    const audit3 = legacyAudit(a3!.id, d.id, 3);
    const late = await cashbackRpc(a3!.id, d.id, 3, { p_legacy_predebited: true, p_audit_id: audit3 });
    expect(late.status, late.body).toBe(200);
    expect(balanceOf(d.id)).toBe(12);
    // O aparelho vê a baixa conciliada: nada sem resgate no extrato da nuvem.
    const cloudD = await fetchCloudCustomerCashback(cfg, fetchFn, d.id);
    expect(cashbackOrphanCents(cloudD.cashbackLedger, d.id)).toBe(0);
    expect(cloudD.cashbackLedger.filter((e) => e.entry_type === 'SETTLE').map((e) => e.amount)).toEqual([5]);

    // Liberar a baixa sem resgate: SETTLE e crédito novo de R$ 3, que vale 30 dias a partir de agora.
    const e = cashbackCustomer('5553988110093', [{ amount: 10, expires: '2026-12-31' }]);
    debit(e.earns[0]!, 3);
    sql(`SELECT tchefood_refresh_cashback_balance('${e.id}')`);
    expect(balanceOf(e.id)).toBe(7);
    expect(await decide({ kind: 'ORPHAN', customerId: e.id, holdId: null, decision: 'RELEASE', amount: 3 })).toEqual({ ok: true, amount: 3, repeated: false });
    expect(sql(`SELECT amount || ' ' || remaining_amount || ' ' || (order_id IS NULL) || ' ' || to_char(valid_from AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') || ' ' || to_char(expires_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI')
                  FROM cashback_ledger WHERE customer_id = '${e.id}' AND entry_type = 'REFUND'`)).toBe('3.00 3.00 true 2026-11-12 20:00 2026-12-12 20:00');
    expect(balanceOf(e.id)).toBe(10);

    // Devolução retida (HOLD): liberar vira crédito; a mesma retenção não concilia de novo nem por outro cliente.
    const hold1 = crypto.randomUUID();
    const hold2 = crypto.randomUUID();
    sql(`INSERT INTO cashback_ledger (id, tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, created_by_user_id)
         VALUES ('${hold1}', '${TENANT}', '${e.id}', '${a1!.id}', 'HOLD', 2.5, 0, '${cashier}'), ('${hold2}', '${TENANT}', '${e.id}', '${a2!.id}', 'HOLD', 1.5, 0, '${cashier}');`);
    pending = await fetchCashbackPending(cfg, fetchFn);
    expect(pending.holds.filter((h) => h.customer_id === e.id).map((h) => [h.id, h.amount]).sort()).toEqual([[hold1, 2.5], [hold2, 1.5]].sort());
    expect((await decide({ kind: 'HOLD', customerId: d.id, holdId: hold1, decision: 'RELEASE', amount: 2.5 })).ok).toBe(false);
    expect((await decide({ kind: 'ORPHAN', customerId: e.id, holdId: hold1, decision: 'RELEASE', amount: 2.5 })).ok).toBe(false);
    expect(await decide({ kind: 'HOLD', customerId: e.id, holdId: hold1, decision: 'RELEASE', amount: 2.5 })).toEqual({ ok: true, amount: 2.5, repeated: false });
    expect(balanceOf(e.id)).toBe(12.5);
    const again = await decide({ kind: 'HOLD', customerId: e.id, holdId: hold1, decision: 'DISCARD', amount: 2.5 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('já foi conciliada');
    // Descartar a outra: sem crédito; nada mais pendente para este cliente.
    expect(await decide({ kind: 'HOLD', customerId: e.id, holdId: hold2, decision: 'DISCARD', amount: 1.5 })).toEqual({ ok: true, amount: 1.5, repeated: false });
    expect(balanceOf(e.id)).toBe(12.5);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE customer_id = '${e.id}' AND entry_type = 'REFUND'`)).toBe('2');
    pending = await fetchCashbackPending(cfg, fetchFn);
    expect(pending.holds.some((h) => h.customer_id === e.id) || pending.orphans.some((o) => o.customer_id === e.id)).toBe(false);
    expect(sql(`SELECT count(*) FROM cashback_reconciliations WHERE customer_id IN ('${d.id}', '${e.id}')`)).toBe('4');
    // Cliente de outra loja não aparece nem concilia com o token desta.
    const OTHER = '55555555-5555-4555-8555-555555555555';
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${OTHER}', 'Outra', 'Outra Ltda', '11222333000262') ON CONFLICT DO NOTHING;`);
    const f = cashbackCustomer('5553988110094', [{ amount: 10, expires: '2026-12-31' }], OTHER);
    debit(f.earns[0]!, 2);
    pending = await fetchCashbackPending(cfg, fetchFn);
    expect(pending.orphans.some((o) => o.customer_id === f.id)).toBe(false);
    expect((await decide({ kind: 'ORPHAN', customerId: f.id, holdId: null, decision: 'RELEASE', amount: 2 })).ok).toBe(false);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE customer_id = '${f.id}'`)).toBe('1');
    closeCashbackOrders([a1!.id, a2!.id, a3!.id]);
    setCashbackClock(null);
  });

  it('desconto manual antes do resgate: o cancelamento devolve o cashback e mantém o desconto manual (P0-02 da rodada 8)', async () => {
    // Critério do GPT: conta de R$ 100 sem os 10%, gerente dá R$ 10 de desconto, cliente
    // resgata R$ 45 (desconto 55); o cancelamento leva o bruto a R$ 20. O desconto manual de
    // R$ 10 fica, o cashback aplicado cai a R$ 10 e R$ 35 voltam ao cliente (não R$ 25).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    login(OWNER_PIN);
    const product = (code: string, name: string, price: number) => ok(st().saveProduct({
      category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    const costela = product('491', 'Costela', 80);
    const salada = product('492', 'Salada', 20);
    ok(st().saveTable({ number: 81, label: 'Mesa 81', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('produtos e mesa');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 81)!.id, 1, null));
    for (const p of [costela, salada]) {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    }
    ok(st().dispatchTray(order.id));
    ok(st().removeServiceFee(order.id, MANAGER));
    ok(st().applyDiscount(order.id, 10, MANAGER));
    await expectSynced('conta de R$ 100 com desconto manual de R$ 10');
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe('10.00 90.00');
    const phone = '5553988119081';
    const c = cashbackCustomer(phone, [{ amount: 60, expires: '2026-12-31' }]);
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${c.id}'`));
    const cloudEarn = JSON.parse(sql(`SELECT row_to_json(l) FROM cashback_ledger l WHERE id = '${c.earns[0]}'`));
    useTcheStore.setState({
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 60, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, { ...cloudEarn, amount: 60, remaining_amount: 60 }],
    });
    expect(ok(st().redeemCashback(order.id, phone)).amount).toBe(45);
    await expectSynced('resgate de R$ 45');
    expect(sql(`SELECT discount_amount || ' ' || total_amount FROM orders WHERE id = '${order.id}'`)).toBe('55.00 45.00');

    ok(st().cancelOrderItem(st().orderItems.find((i) => i.order_id === order.id && i.product_id === costela.id)!.id, MANAGER));
    const pending = [...st().outbox];
    await expectSynced('cancelamento da costela');
    // Reenvio da mesma fila (internet caiu antes da confirmação) e o mesmo estado mandado por
    // um segundo aparelho: nada muda.
    const cloud = st().cloud!;
    const resend = await flushOutbox(pending, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(resend.rejected).toEqual([]);
    const otherDevice = await raw('PATCH', `orders?id=eq.${order.id}`, { discount_amount: 20, total_amount: 0, remaining_balance: 0 });
    expect(otherDevice.status, otherDevice.body).toBe(204);

    const cents = (v: string | number) => Math.round(Number(v) * 100);
    const local = st().orders.find((o) => o.id === order.id)!;
    expect([local.discount_amount, local.total_amount]).toEqual([20, 0]);
    expect(sql(`SELECT discount_amount || ' ' || total_amount || ' ' || remaining_balance FROM orders WHERE id = '${order.id}'`)).toBe('20.00 0.00 0.00');
    // Banco: R$ 35 devolvidos, uma vez só, com a validade do crédito de origem; o registro
    // separa o desconto manual (10 antes e depois) do cashback aplicado (45 antes).
    expect(sql(`SELECT count(*) || ' ' || sum(amount) || ' ' || sum(remaining_amount) || ' ' || bool_and(refund_of_id = '${c.earns[0]}') || ' ' || to_char(max(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'REFUND'`))
      .toBe('1 35.00 35.00 true 2026-12-31');
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${order.id}' AND entry_type = 'HOLD'`)).toBe('0');
    expect(sql(`SELECT amount_impact || ' ' || (metadata->>'manual_discount_before') || ' ' || (metadata->>'manual_discount_after') || ' ' || (metadata->>'cashback_applied_before') || ' ' || (metadata->>'discount_before') || ' ' || (metadata->>'discount_after') FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'CASHBACK_REFUNDED'`))
      .toBe('35.00 10.00 10.00 45.00 55.00 20.00');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)).toBe('50.00');
    // Aparelho: o mesmo estorno e o mesmo saldo, em centavos, sem baixar nada da nuvem.
    const localRefunds = st().cashbackLedger.filter((e) => e.order_id === order.id && e.entry_type === 'REFUND');
    expect(localRefunds.map((e) => [cents(e.amount), e.refund_of_id, e.expires_at!.slice(0, 10)])).toEqual([[3500, c.earns[0], '2026-12-31']]);
    expect(cents(st().loyaltyCustomers.find((x) => x.id === c.id)!.cashback_balance)).toBe(cents(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${c.id}'`)));
    const localLog = st().auditLogs.find((l) => l.order_id === order.id && l.action_type === 'CASHBACK_REFUNDED')!;
    expect(cents(localLog.amount_impact)).toBe(3500);
    closeCashbackOrders([order.id]);
    setCashbackClock(null);
  });

  it('resgate antigo recuperado sem origem: o estorno não herda validade de outro crédito, fica retido para conciliação (P0-03 da rodada 8)', async () => {
    // Critério do GPT: crédito A (R$ 20, vence 20/11) e B (R$ 20, vence 31/12), os dois já
    // consumidos (B em outra conta). A conta L da versão anterior baixou A e caiu antes do
    // REDEEM; mais R$ 5 saem do crédito C (vence 31/01) na recuperação. O cancelamento de L
    // devolve tudo: os R$ 5 de C voltam com a validade de C; os R$ 20 sem origem comprovada
    // não voltam com o vencimento de B nem com 30 dias novos: ficam retidos.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [l, y] = await cashbackOrders(2, 83);
    expect(l!.cap).toBeGreaterThanOrEqual(25);
    const cust = cashbackCustomer('5553988119083', [
      { amount: 20, expires: '2026-11-20' }, { amount: 20, expires: '2026-12-31' }, { amount: 5, expires: '2027-01-31' },
    ]);
    const [aId, bId, cId] = cust.earns as [string, string, string];
    // B foi usado na conta Y (resgate já gravado na nuvem).
    debit(bId, 20);
    sql(`SET session_replication_role = replica; INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, redeem_sources, created_at)
         VALUES ('${TENANT}', '${cust.id}', '${y!.id}', 'REDEEM', 20, 0, '[{"source_id": "${bId}", "amount": 20}]', '2026-11-12T19:00:00-03:00');`);
    // L, da versão anterior: baixou A e registrou o resgate de R$ 25 sem o REDEEM.
    const auditL = legacyAudit(l!.id, cust.id, 25);
    debit(aId, 20);
    const recovered = await cashbackRpc(l!.id, cust.id, 25, { p_legacy_predebited: true, p_audit_id: auditL });
    expect(recovered.status, recovered.body).toBe(200);
    expect(sql(`SELECT redeem_sources::text FROM cashback_ledger WHERE order_id = '${l!.id}' AND entry_type = 'REDEEM'`))
      .toBe(`[{"amount": 20.00, "source_id": null}, {"amount": 5.00, "source_id": "${cId}"}]`);
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${cust.id}'`)).toBe('0.00');
    // O aparelho de L recebe a conta e o extrato da nuvem e cancela o item.
    const cloudOrder = JSON.parse(sql(`SELECT row_to_json(o) FROM orders o WHERE id = '${l!.id}'`));
    const ledgerRows = JSON.parse(sql(`SELECT json_agg(row_to_json(x)) FROM cashback_ledger x WHERE customer_id = '${cust.id}'`)) as CashbackLedgerEntry[];
    const num = (e: CashbackLedgerEntry) => ({ ...e, amount: Number(e.amount), remaining_amount: Number(e.remaining_amount),
      redeem_sources: e.redeem_sources?.map((s) => ({ ...s, amount: Number(s.amount) })) ?? null });
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${cust.id}'`));
    useTcheStore.setState({
      orders: st().orders.map((o) => (o.id === l!.id ? { ...o, discount_amount: Number(cloudOrder.discount_amount), total_amount: Number(cloudOrder.total_amount), remaining_balance: Number(cloudOrder.remaining_balance) } : o)),
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 0, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, ...ledgerRows.map(num)],
    });
    const item = st().orderItems.find((i) => i.order_id === l!.id && i.status !== 'CANCELED')!;
    ok(st().cancelOrderItem(item.id, MANAGER));
    const pending = [...st().outbox];
    await expectSynced('cancelamento da conta do resgate antigo');
    const cloud = st().cloud!;
    const resend = await flushOutbox(pending, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(resend.rejected).toEqual([]);

    // Banco: R$ 5 de C com a validade de C; R$ 20 retidos, sem validade e sem saldo.
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${l!.id}'`)).toBe('0.00');
    expect(sql(`SELECT string_agg(entry_type || ' ' || amount || ' ' || remaining_amount || ' ' || COALESCE(refund_of_id::text, '-') || ' ' || COALESCE(to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), '-'), ' | ' ORDER BY entry_type) FROM cashback_ledger WHERE order_id = '${l!.id}' AND entry_type <> 'REDEEM'`))
      .toBe(`HOLD 20.00 0.00 - - | REFUND 5.00 5.00 ${cId} 2027-01-31`);
    // Nenhum crédito com o vencimento de B (31/12) nem com 30 dias do resgate (12/12) voltou.
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${l!.id}' AND entry_type = 'REFUND' AND to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') IN ('2026-12-31', '2026-12-12', '2026-12-13')`)).toBe('0');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${cust.id}'`)).toBe('5.00');
    expect(sql(`SELECT count(*) || ' ' || sum(amount_impact) || ' ' || max(metadata->>'reconciliation') || ' ' || max(metadata->>'reason_code') FROM audit_logs WHERE order_id = '${l!.id}' AND action_type = 'CASHBACK_REFUND_HELD'`))
      .toBe('1 20.00 PENDING SOURCE_UNKNOWN');
    // Aparelho: o mesmo extrato (retido sem saldo nem validade) e o mesmo saldo.
    const local = st().cashbackLedger.filter((e) => e.order_id === l!.id && e.entry_type !== 'REDEEM')
      .map((e) => [e.entry_type, e.amount, e.remaining_amount, e.refund_of_id ?? null, e.expires_at?.slice(0, 10) ?? null]);
    expect(local.sort()).toEqual([['HOLD', 20, 0, null, null], ['REFUND', 5, 5, cId, '2027-01-31']]);
    expect(availableCashback(st().cashbackLedger, cust.id, new Date())).toBe(5);
    expect(st().loyaltyCustomers.find((x) => x.id === cust.id)!.cashback_balance).toBe(5);
    expect(st().auditLogs.filter((x) => x.order_id === l!.id && x.action_type === 'CASHBACK_REFUND_HELD').map((x) => x.amount_impact)).toEqual([20]);
    // O aparelho não grava a retenção nem o registro dela.
    const user = st().currentUserId;
    expect((await raw('POST', 'cashback_ledger', {
      id: crypto.randomUUID(), tenant_id: TENANT, customer_id: cust.id, order_id: l!.id, entry_type: 'HOLD', amount: 1, remaining_amount: 0, created_by_user_id: user,
    })).status).toBe(400);
    expect((await raw('POST', 'audit_logs', {
      id: crypto.randomUUID(), tenant_id: TENANT, order_id: l!.id, performed_by_user_id: user, action_type: 'CASHBACK_REFUND_HELD',
      amount_impact: 1, reason: 'forjado', whatsapp_alert_sent: false, metadata: {},
    })).status).toBe(400);
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${l!.id}' AND entry_type IN ('REFUND', 'HOLD')`)).toBe('2');
    closeCashbackOrders([l!.id, y!.id]);
    setCashbackClock(null);
  });

  it('retenção com origem que não existe ou é de outra loja: grava o HOLD sem FK quebrada nem vínculo cruzado (P2-01 da rodada 9)', async () => {
    // Critério do GPT: resgate recuperado com quatro origens — nula, UUID que não existe em
    // cashback_ledger, crédito de outra loja e crédito válido desta loja. O cancelamento
    // devolve tudo: só o crédito desta loja volta (com a validade dele); o resto fica retido
    // num HOLD sem refund_of_id (a FK recusaria o UUID inexistente) e os UUIDs informados
    // ficam no registro. Reenvio e segundo aparelho não duplicam nada.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
    setCashbackClock('2026-11-12T20:00:00-03:00');
    const [order] = await cashbackOrders(1, 85);
    expect(order!.cap).toBeGreaterThanOrEqual(20);
    const cust = cashbackCustomer('5553988119085', [{ amount: 20, expires: '2027-01-31' }]);
    const cId = cust.earns[0]!;
    const TENANT_D = '44444444-4444-4444-8444-444444444444';
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT_D}', 'Loja D', 'Loja D Ltda', '44555666000181');`);
    const foreign = cashbackCustomer('5553988119086', [{ amount: 5, expires: '2027-02-28' }], TENANT_D).earns[0]!;
    const ghost = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE id = '${ghost}'`)).toBe('0');
    const redeemed = await cashbackRpc(order!.id, cust.id, 20);
    expect(redeemed.status, redeemed.body).toBe(200);
    // O resgate recuperado chegou com as quatro origens (R$ 5 cada); só R$ 5 saíram de C.
    sql(`SET session_replication_role = replica;
         UPDATE cashback_ledger SET redeem_sources = '[{"source_id": null, "amount": 5}, {"source_id": "${ghost}", "amount": 5}, {"source_id": "${foreign}", "amount": 5}, {"source_id": "${cId}", "amount": 5}]'
          WHERE order_id = '${order!.id}' AND entry_type = 'REDEEM';
         UPDATE cashback_ledger SET remaining_amount = 15 WHERE id = '${cId}';
         UPDATE loyalty_customers SET cashback_balance = 15 WHERE id = '${cust.id}';`);
    const cloudOrder = JSON.parse(sql(`SELECT row_to_json(o) FROM orders o WHERE id = '${order!.id}'`));
    expect(Number(cloudOrder.discount_amount)).toBe(20);
    const ledgerRows = JSON.parse(sql(`SELECT json_agg(row_to_json(x)) FROM cashback_ledger x WHERE customer_id = '${cust.id}'`)) as CashbackLedgerEntry[];
    const num = (e: CashbackLedgerEntry) => ({ ...e, amount: Number(e.amount), remaining_amount: Number(e.remaining_amount),
      redeem_sources: e.redeem_sources?.map((x) => ({ ...x, amount: Number(x.amount) })) ?? null });
    const cloudCustomer = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${cust.id}'`));
    useTcheStore.setState({
      orders: st().orders.map((o) => (o.id === order!.id ? { ...o, discount_amount: 20, total_amount: Number(cloudOrder.total_amount), remaining_balance: Number(cloudOrder.remaining_balance) } : o)),
      loyaltyCustomers: [...st().loyaltyCustomers, { ...cloudCustomer, cashback_balance: 15, total_spent: 0, visits_count: 1 }],
      cashbackLedger: [...st().cashbackLedger, ...ledgerRows.map(num)],
    });
    const item = st().orderItems.find((i) => i.order_id === order!.id && i.status !== 'CANCELED')!;
    ok(st().cancelOrderItem(item.id, MANAGER));
    const pending = [...st().outbox];
    await expectSynced('cancelamento com origens não comprovadas');
    const cloud = st().cloud!;
    const resend = await flushOutbox(pending, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(resend.rejected).toEqual([]);
    const now = JSON.parse(sql(`SELECT row_to_json(o) FROM orders o WHERE id = '${order!.id}'`));
    const otherDevice = await raw('PATCH', `orders?id=eq.${order!.id}`, { discount_amount: Number(now.discount_amount), total_amount: Number(now.total_amount), remaining_balance: Number(now.remaining_balance) });
    expect(otherDevice.status, otherDevice.body).toBe(204);

    // Banco: R$ 5 de C com a validade de C; R$ 15 num HOLD só, sem vínculo, sem saldo, sem validade.
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order!.id}'`)).toBe('0.00');
    expect(sql(`SELECT string_agg(entry_type || ' ' || amount || ' ' || remaining_amount || ' ' || COALESCE(refund_of_id::text, '-') || ' ' || COALESCE(to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), '-'), ' | ' ORDER BY entry_type) FROM cashback_ledger WHERE order_id = '${order!.id}' AND entry_type <> 'REDEEM'`))
      .toBe(`HOLD 15.00 0.00 - - | REFUND 5.00 5.00 ${cId} 2027-01-31`);
    // Nenhum lançamento desta loja aponta para a outra loja ou para o UUID inexistente.
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE refund_of_id IN ('${foreign}', '${ghost}')`)).toBe('0');
    expect(sql(`SELECT count(*) FROM cashback_ledger WHERE tenant_id = '${TENANT_D}' AND order_id IS NOT NULL`)).toBe('0');
    expect(sql(`SELECT remaining_amount FROM cashback_ledger WHERE id = '${foreign}'`)).toBe('5.00');
    expect(sql(`SELECT cashback_balance FROM loyalty_customers WHERE id = '${cust.id}'`)).toBe('20.00');
    // Registro: um só, com os UUIDs informados para investigação.
    expect(sql(`SELECT count(*) || ' ' || sum(amount_impact) || ' ' || max(metadata->>'reason_code') || ' ' || max((metadata->'reported_source_ids')::text) FROM audit_logs WHERE order_id = '${order!.id}' AND action_type = 'CASHBACK_REFUND_HELD'`))
      .toBe(`1 15.00 SOURCE_NOT_FOUND ["${ghost}", "${foreign}"]`);
    expect(sql(`SELECT count(*) FROM audit_logs WHERE order_id = '${order!.id}' AND action_type = 'CASHBACK_REFUNDED'`)).toBe('1');
    // Aparelho: o mesmo extrato e o mesmo saldo.
    const local = st().cashbackLedger.filter((e) => e.order_id === order!.id && e.entry_type !== 'REDEEM')
      .map((e) => [e.entry_type, e.amount, e.remaining_amount, e.refund_of_id ?? null, e.expires_at?.slice(0, 10) ?? null]);
    expect(local.sort()).toEqual([['HOLD', 15, 0, null, null], ['REFUND', 5, 5, cId, '2027-01-31']]);
    expect(st().loyaltyCustomers.find((x) => x.id === cust.id)!.cashback_balance).toBe(20);
    const localHeld = st().auditLogs.filter((x) => x.order_id === order!.id && x.action_type === 'CASHBACK_REFUND_HELD');
    expect(localHeld.map((x) => [x.amount_impact, x.metadata?.reported_source_ids])).toEqual([[15, [ghost, foreign]]]);
    // Banco protege: HOLD com vínculo é recusado mesmo pelo servidor.
    expect(() => sql(`INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, refund_of_id)
                      VALUES ('${TENANT}', '${cust.id}', '${order!.id}', 'HOLD', 1, 0, '${cId}');`)).toThrow(/cashback_ledger_hold_no_link/);
    closeCashbackOrders([order!.id]);
    setCashbackClock(null);
  });

  describe('desfazer resgate da versão anterior recusado pela nuvem (P0-01 da rodada 10)', () => {
    // Critério do GPT: aparelho da versão 11 resgata sem internet; o REDEEM antigo não tem
    // redeem_sources (a migração 11 → 12 só converte a fila). A nuvem recusa (sexta). Desfazer
    // não pode somar o valor a um crédito qualquer nem deixar o crédito baixado: confere o
    // extrato do cliente na nuvem; com baixa sem resgate lá, não conclui nem apaga nada.
    const cents = (v: string | number) => Math.round(Number(v) * 100);
    const num = (e: CashbackLedgerEntry) => ({ ...e, amount: Number(e.amount), remaining_amount: Number(e.remaining_amount),
      redeem_sources: e.redeem_sources?.map((x) => ({ ...x, amount: Number(x.amount) })) ?? null });
    /** O cliente da nuvem neste aparelho, como a leitura da nuvem deixaria. */
    const loadCustomer = (customerId: string) => {
      const cc = JSON.parse(sql(`SELECT row_to_json(c) FROM loyalty_customers c WHERE id = '${customerId}'`));
      const rows = (JSON.parse(sql(`SELECT json_agg(row_to_json(x)) FROM cashback_ledger x WHERE customer_id = '${customerId}'`)) as CashbackLedgerEntry[]).map(num);
      useTcheStore.setState({
        loyaltyCustomers: [...st().loyaltyCustomers.filter((c) => c.id !== customerId), { ...cc, cashback_balance: balanceOf(rows), total_spent: 0, visits_count: 1 }],
        cashbackLedger: [...st().cashbackLedger.filter((e) => e.customer_id !== customerId), ...rows],
      });
    };
    const balanceOf = (rows: CashbackLedgerEntry[]) => rows.filter((e) => e.entry_type === 'EARN' || e.entry_type === 'REFUND').reduce((a, e) => a + Number(e.remaining_amount), 0);
    /**
     * Resgate como a versão 11 deixava: REDEEM sem redeem_sources e a fila na ordem daquela
     * versão (audit_log CASHBACK_REDEEMED, baixa dos créditos por UPDATE, REDEEM). O estado
     * passa pela migração 11 → 12 de verdade (migratePersisted), como na abertura do aparelho.
     */
    const asLegacy = (orderId: string) => {
      const redeem = st().cashbackLedger.find((e) => e.order_id === orderId && e.entry_type === 'REDEEM')!;
      const ev = st().outbox.find((e) => e.table === 'cashback_ledger' && e.row_id === redeem.id && e.cashback_redeem)!;
      const audit = st().auditLogs.find((l) => l.id === ev.cashback_redeem!.audit_id)!;
      const at = ev.created_at;
      const { redeem_sources: _src, ...v11Payload } = ev.payload;
      const debits = (redeem.redeem_sources ?? []).map((src) => {
        const credit = st().cashbackLedger.find((e) => e.id === src.source_id)!;
        return { id: crypto.randomUUID(), table: 'cashback_ledger' as const, op: 'UPDATE' as const, row_id: credit.id, payload: { ...credit }, created_at: at, depends_on_order_id: orderId };
      });
      const v11Outbox = st().outbox.flatMap((e) => (e.id !== ev.id ? [e] : [
        { id: crypto.randomUUID(), table: 'audit_logs' as const, op: 'INSERT' as const, row_id: audit.id, payload: { ...audit }, created_at: at },
        ...debits,
        { id: ev.id, table: 'cashback_ledger' as const, op: 'INSERT' as const, row_id: redeem.id, payload: v11Payload, created_at: at, depends_on_order_id: orderId },
      ]));
      const v11Ledger = st().cashbackLedger.map((e) => (e.id === redeem.id ? { ...e, redeem_sources: undefined } : e));
      const migrated = migratePersisted({ outbox: v11Outbox, syncRejected: st().syncRejected, auditLogs: st().auditLogs, cashbackLedger: v11Ledger }, 11) as {
        outbox: typeof v11Outbox; syncRejected: ReturnType<typeof st>['syncRejected']; cashbackLedger: CashbackLedgerEntry[];
      };
      const converted = migrated.outbox.find((e) => e.row_id === redeem.id)!;
      expect(converted.cashback_redeem).toEqual({ audit_id: audit.id, legacy_predebited: true });
      expect(migrated.outbox.some((e) => e.table === 'cashback_ledger' && e.op === 'UPDATE')).toBe(false);
      expect(migrated.cashbackLedger.find((e) => e.id === redeem.id)!.redeem_sources ?? null).toBeNull();
      useTcheStore.setState({ outbox: migrated.outbox, syncRejected: migrated.syncRejected, cashbackLedger: migrated.cashbackLedger });
      return redeem;
    };
    const rejectedFor = (orderId: string) => st().syncRejected.find((r) => r.event.table === 'cashback_ledger' && r.event.payload.order_id === orderId)!;
    const readCloud = (customerId: string) => {
      const cloud = st().cloud!;
      return fetchCloudCustomerCashback({ url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
        postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), customerId);
    };
    const cloudCredit = (customerId: string) => cents(sql(`SELECT COALESCE(sum(remaining_amount), 0) FROM cashback_ledger WHERE customer_id = '${customerId}' AND entry_type IN ('EARN', 'REFUND')`));
    const localCredit = (customerId: string) => cents(balanceOf(st().cashbackLedger.filter((e) => e.customer_id === customerId)));
    const snapshot = () => JSON.stringify({ o: st().orders, l: st().cashbackLedger, r: st().syncRejected, q: st().outbox, a: st().auditLogs, c: st().loyaltyCustomers });

    it('sem baixa na nuvem: crédito de R$ 10,00, resgate de R$ 5,00 recusado; o crédito volta a R$ 10,00 nos dois lados', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
      setCashbackClock('2026-11-13T10:00:00-03:00');
      // Conta de R$ 10,00 sem os 10%: o teto de 50% deixa o resgate em R$ 5,00.
      login(OWNER_PIN);
      const p = ok(st().saveProduct({
        category_id: categoryId, code: '493', name: 'Pastel', description: null, price: 10, sector: 'KITCHEN', available: true, active: true,
        requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
        cost_price: 0, stock_quantity: 0, barcode: null,
      }));
      ok(st().saveTable({ number: 87, label: 'Mesa 87', area: 'Salão', capacity: 4, active: true }));
      await expectSynced('produto e mesa');
      login(CASHIER_PIN);
      const order = ok(st().openTable(st().tables.find((t) => t.number === 87)!.id, 1, null));
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: 10, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
      ok(st().dispatchTray(order.id));
      ok(st().removeServiceFee(order.id, MANAGER));
      await expectSynced('conta de R$ 10');
      const phone = '5553988119087';
      const cust = cashbackCustomer(phone, [{ amount: 10, expires: '2026-12-31' }]);
      loadCustomer(cust.id);
      const r = ok(st().redeemCashback(order.id, phone)).amount;
      expect(cents(r)).toBe(500);
      asLegacy(order.id);
      expect(localCredit(cust.id)).toBe(500);
      expect(await sync()).toHaveLength(1);
      const refused = rejectedFor(order.id);
      expect(refused.message).toContain('terça a quinta');
      expect(cloudCredit(cust.id)).toBe(1000);
      // Sem o extrato da nuvem: não desfaz e nada muda.
      const before = snapshot();
      const offline = st().undoRejectedCashbackRedeem(refused.event.id);
      expect(!offline.ok && offline.error).toContain('versão anterior');
      expect(snapshot()).toBe(before);
      // Com o extrato da nuvem: o crédito fica com o que a nuvem tem.
      expect(ok(st().undoRejectedCashbackRedeem(refused.event.id, await readCloud(cust.id)))).toBe(r);
      expect(localCredit(cust.id)).toBe(1000);
      expect(cents(st().cashbackLedger.find((e) => e.id === cust.earns[0])!.remaining_amount)).toBe(1000);
      expect(cents(st().loyaltyCustomers.find((c) => c.id === cust.id)!.cashback_balance)).toBe(1000);
      expect(st().cashbackLedger.filter((e) => e.order_id === order.id)).toEqual([]);
      const log = st().auditLogs.find((l) => l.order_id === order.id && l.action_type === 'CASHBACK_REDEEMED')!;
      expect([log.amount_impact, log.metadata?.legacy_redeem, log.metadata?.cloud_orphan_cents, typeof log.metadata?.rejected_by_cloud]).toEqual([0, true, 0, 'string']);
      expect(st().syncRejected.some((x) => x.event.id === refused.event.id)).toBe(false);
      await expectSynced('conta sem o resgate antigo');
      expect(cloudCredit(cust.id)).toBe(1000);
      expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id = '${order.id}'`)).toBe('0');
      expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order.id}'`)).toBe('0.00');
      closeCashbackOrders([order.id]);
      setCashbackClock(null);
    });

    it('R$ 3,00 já baixados na nuvem e dois resgates antigos: não conclui, não apaga a divergência', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
      setCashbackClock('2026-11-13T10:00:00-03:00');
      const [a, b] = await cashbackOrders(2, 88);
      const phone = '5553988119088';
      const credit = Math.round((a!.cap + 3) * 100) / 100;
      const cust = cashbackCustomer(phone, [{ amount: credit, expires: '2026-12-31' }]);
      loadCustomer(cust.id);
      login(CASHIER_PIN);
      const ra = ok(st().redeemCashback(a!.id, phone)).amount;
      const rb = ok(st().redeemCashback(b!.id, phone)).amount;
      expect([ra > 0, rb > 0]).toEqual([true, true]);
      asLegacy(a!.id);
      asLegacy(b!.id);
      // A baixa de R$ 3,00 da versão 11 já tinha subido antes da internet cair.
      debit(cust.earns[0]!, 3);
      await sync();
      const refusedA = rejectedFor(a!.id);
      const refusedB = rejectedFor(b!.id);
      expect([refusedA, refusedB].every(Boolean)).toBe(true);
      const cloudBefore = sql(`SELECT json_agg(row_to_json(x) ORDER BY id) FROM cashback_ledger x WHERE customer_id = '${cust.id}'`);
      const before = snapshot();
      for (const refused of [refusedA, refusedB]) {
        const res = st().undoRejectedCashbackRedeem(refused.event.id, await readCloud(cust.id));
        expect(!res.ok && res.error).toMatch(/R\$\s3,00/);
        expect(!res.ok && res.error).toContain('gerente conciliar');
      }
      expect(snapshot()).toBe(before);
      expect(st().syncRejected.filter((x) => [refusedA.event.id, refusedB.event.id].includes(x.event.id))).toHaveLength(2);
      expect(sql(`SELECT json_agg(row_to_json(x) ORDER BY id) FROM cashback_ledger x WHERE customer_id = '${cust.id}'`)).toBe(cloudBefore);
      useTcheStore.setState({ outbox: [], syncRejected: [] });
      closeCashbackOrders([a!.id, b!.id]);
      setCashbackClock(null);
    });

    it('dois resgates antigos do mesmo cliente sem baixa na nuvem: cada um desfeito fecha com a nuvem', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T20:00:00-03:00') });
      setCashbackClock('2026-11-13T10:00:00-03:00');
      const [a, b] = await cashbackOrders(2, 90);
      const phone = '5553988119090';
      const credit = Math.round((a!.cap + 3) * 100) / 100;
      const cust = cashbackCustomer(phone, [{ amount: credit, expires: '2026-12-31' }]);
      loadCustomer(cust.id);
      login(CASHIER_PIN);
      const ra = ok(st().redeemCashback(a!.id, phone)).amount;
      const rb = ok(st().redeemCashback(b!.id, phone)).amount;
      asLegacy(a!.id);
      asLegacy(b!.id);
      await sync();
      const refusedA = rejectedFor(a!.id);
      const refusedB = rejectedFor(b!.id);
      // Desfaz A: o de B continua aplicado aqui, então sai de novo do extrato da nuvem.
      expect(ok(st().undoRejectedCashbackRedeem(refusedA.event.id, await readCloud(cust.id)))).toBe(ra);
      expect(localCredit(cust.id)).toBe(cents(credit) - cents(rb));
      expect(ok(st().undoRejectedCashbackRedeem(refusedB.event.id, await readCloud(cust.id)))).toBe(rb);
      expect(localCredit(cust.id)).toBe(cents(credit));
      await expectSynced('contas sem os resgates antigos');
      expect(cloudCredit(cust.id)).toBe(cents(credit));
      expect(sql(`SELECT count(*) FROM cashback_ledger WHERE order_id IN ('${a!.id}', '${b!.id}')`)).toBe('0');
      closeCashbackOrders([a!.id, b!.id]);
      setCashbackClock(null);
    });
  });

  it('extrato com mais de 1.000 lançamentos e crédito novo no meio da leitura: leitura consistente, sem repetir nem perder (P2-01 da rodada 11)', async () => {
    // Critério do GPT: 1.001 créditos de R$ 1,00; um crédito de R$ 100,00 entra no banco logo
    // depois da primeira requisição de cashback (na leitura em páginas, entre a página 1 e a
    // 2, com um id que ordena antes de todos). A leitura tem de ser a foto de antes ou a de
    // depois, inteira: nada repetido, nada faltando.
    const cust = cashbackCustomer('5553988119095', []);
    sql(`SET session_replication_role = replica;
         INSERT INTO cashback_ledger (tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
         SELECT '${TENANT}', '${cust.id}', 'EARN', 1, 1, '2026-11-01', '2026-12-31' FROM generate_series(1, 1001);`);
    const ids = () => sql(`SELECT string_agg(id::text, ',' ORDER BY id) FROM cashback_ledger WHERE customer_id = '${cust.id}'`).split(',');
    const before = ids();
    expect(before).toHaveLength(1001);
    const cloud = st().cloud!;
    const cfg = { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token };
    const base = postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' });
    let n = 0;
    const late = (id: string): typeof base => async (url, init) => {
      const res = await base(url, init);
      if (/cashback/.test(url) && ++n === 1) {
        sql(`SET session_replication_role = replica;
             INSERT INTO cashback_ledger (id, tenant_id, customer_id, entry_type, amount, remaining_amount, valid_from, expires_at)
             VALUES ('${id}', '${TENANT}', '${cust.id}', 'EARN', 100, 100, '2026-11-01', '2026-12-31');`);
      }
      return res;
    };
    const check = (rows: CashbackLedgerEntry[], after: string[]) => {
      const got = rows.filter((e) => e.customer_id === cust.id).map((e) => e.id);
      expect(new Set(got).size, 'lançamento repetido').toBe(got.length);
      const sorted = [...got].sort();
      expect([JSON.stringify(before), JSON.stringify(after)]).toContain(JSON.stringify(sorted));
      const total = rows.filter((e) => e.customer_id === cust.id).reduce((a, e) => a + Math.round(e.amount * 100), 0);
      expect([100100, 110100]).toContain(total);
    };
    // Conferência do desfazer (um cliente).
    const one = await fetchCloudCustomerCashback(cfg, late('00000000-0000-4000-8000-000000000001'), cust.id);
    check(one.cashbackLedger, ids());
    expect(one.loyaltyCustomers.map((c) => c.id)).toEqual([cust.id]);
    // Leitura da nuvem do aparelho (a loja toda).
    const beforeAll = ids();
    n = 0;
    const snap = await fetchCloudSnapshot(cfg, TENANT, late('00000000-0000-4000-8000-000000000002'));
    const afterAll = ids();
    const got = snap.cashbackLedger!.filter((e) => e.customer_id === cust.id).map((e) => e.id).sort();
    expect(new Set(snap.cashbackLedger!.map((e) => e.id)).size).toBe(snap.cashbackLedger!.length);
    expect([JSON.stringify(beforeAll), JSON.stringify(afterAll)]).toContain(JSON.stringify(got));
    // Só a loja do token.
    expect(snap.cashbackLedger!.every((e) => e.tenant_id === TENANT)).toBe(true);
    expect(snap.loyaltyCustomers!.every((c) => c.tenant_id === TENANT)).toBe(true);
    sql(`SET session_replication_role = replica; DELETE FROM cashback_ledger WHERE customer_id = '${cust.id}'; DELETE FROM loyalty_customers WHERE id = '${cust.id}';`);
  });

  it('balcão (Ficha Rápida) com fichas e retirada', async () => {
    login(CASHIER_PIN);
    const order = ok(st().createCounterSale([{ product_id: productId, quantity: 2, modifiers: [], meat_doneness: null }]));
    payCash(order.id);
    const tickets = ok(st().issueEventTickets(order.id));
    ok(st().redeemEventTicket(tickets[0]!.barcode_token));
    await expectSynced('ficha de balcão');
  });

  it('pedido com senha no caixa', async () => {
    login(CASHIER_PIN);
    const line: PickupLine = { product_id: productId, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' };
    const order = ok(st().createPickupOrder({ lines: [line], fulfillment: 'TAKEOUT', customerName: 'Ana' }));
    payCash(order.id);
    await expectSynced('pedido com senha');
    expect(sql(`SELECT pickup_number IS NOT NULL FROM orders WHERE id = '${order.id}'`)).toBe('t');
  });

  it('pedido com senha não pago desfeito com PIN de gerente (um cancelamento por item)', async () => {
    login(CASHIER_PIN);
    const line: PickupLine = { product_id: productId, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' };
    const order = ok(st().createPickupOrder({ lines: [line, { ...line, quantity: 2 }], fulfillment: 'DINE_IN', customerName: null }));
    await expectSynced('pedido com senha aberto');
    ok(st().voidPickupOrder(order.id, MANAGER));
    await expectSynced('pedido com senha desfeito');
    expect(sql(`SELECT status FROM orders WHERE id = '${order.id}'`)).toBe('CANCELED');
    expect(sql(`SELECT count(*) FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'ITEM_CANCELED' AND (metadata->>'server_verified')::boolean`)).toBe('2');
  });

  it('compra por XML: fornecedor, nota, itens, estoque e vínculo', async () => {
    login(OWNER_PIN);
    const xml = sampleNfeXml('11222333000181');
    ok(
      st().importPurchaseInvoice(xml, [
        { n_item: 1, action: 'LINK', product_id: productId, packaging_factor: 12 },
        { n_item: 2, action: 'CREATE', packaging_factor: 1, name: 'Picanha (peça)', category_id: categoryId, unit: 'KG' },
        { n_item: 3, action: 'IGNORE' },
      ]),
    );
    await expectSynced('compra por XML');
  });

  it('cardápio 3D: modelo do prato, métricas do cliente e registro pelo QR da mesa', async () => {
    login(OWNER_PIN);
    const ar = () => useArStore.getState();
    const draft = {
      product_id: productId, usdz_url: null, scale_factor: 1, real_width_cm: 28, real_depth_cm: 28, real_height_cm: 6,
      explode_animation: null, active: true,
      components: [{ id: crypto.randomUUID(), label: 'Charque', detail: 'Desfiado', position: '0 0.03 0', normal: '0 1 0' }],
    };
    // Arquivo ainda só no aparelho: não sobe (o celular do cliente não abriria idb:).
    ok(ar().saveArModel({ ...draft, glb_url: `idb:${crypto.randomUUID()}` }));
    expect(st().outbox.some((e) => e.table === 'product_ar_models')).toBe(false);
    // Depois do envio ao bucket, o link https sobe como INSERT.
    const model = ok(ar().setArModelUrls(productId, { glb_url: `https://cloud.test/storage/v1/object/public/product-models/${TENANT}/m.glb`, usdz_url: null }));
    ar().recordArEvent(productId, 'VIEW_3D', null);
    ar().recordArEvent(productId, 'ADD_AFTER_VIEW', null);
    await expectSynced('cardápio 3D');
    expect(sql(`SELECT jsonb_array_length(components) || '/' || real_width_cm FROM product_ar_models WHERE id = '${model.id}'`)).toBe('1/28.0');
    ok(ar().saveArModel({ ...draft, id: model.id, glb_url: model.glb_url, real_width_cm: 30 }));
    await expectSynced('cardápio 3D editado');
    expect(sql(`SELECT real_width_cm FROM product_ar_models WHERE id = '${model.id}'`)).toBe('30.0');

    // Celular do cliente, sem login: registra pelo token do QR da mesa.
    const token = sql(`SELECT qr_code_token FROM dining_tables WHERE tenant_id = '${TENANT}' AND kind = 'TABLE' AND qr_code_token IS NOT NULL LIMIT 1`);
    expect(token).not.toBe('');
    const track = (tok: string, kind: string) => psql(target!, `SET ROLE anon; SELECT tchefood_ar_track('${tok}', '${productId}', '${kind}');`, DB);
    expect(track(token, 'AR_START').out).toMatch(/^[0-9a-f-]{36}$/);
    expect(track('token-que-nao-existe', 'AR_START').out).toBe('');
    expect(track(token, 'HACK').out).toBe('');
    // anon não lê nem grava as tabelas direto.
    expect(psql(target!, `SET ROLE anon; INSERT INTO ar_engagement_events (tenant_id, product_id, kind) VALUES ('${TENANT}', '${productId}', 'VIEW_3D');`, DB).ok).toBe(false);
    expect(sql(`SELECT count(*) FROM ar_engagement_events WHERE product_id = '${productId}'`)).toBe('3');
    // Métrica não se edita.
    expect((await raw('PATCH', `ar_engagement_events?product_id=eq.${productId}`, { kind: 'AR_START' })).status).toBeGreaterThanOrEqual(400);
    // Link que não é https (ex.: idb: forjado) é recusado pelo banco.
    expect((await raw('POST', 'product_ar_models', { tenant_id: TENANT, product_id: productId, glb_url: 'idb:x', real_width_cm: 10, real_depth_cm: 10, real_height_cm: 1 })).status).toBeGreaterThanOrEqual(400);
  });

  it('travas: só o token do aparelho não grava equipe, permissão, desconto nem autorização', async () => {
    const owner = st().staff.find((u) => u.role === 'OWNER')!;
    const cashier = st().staff.find((u) => u.pin_code === CASHIER_PIN)!;
    const manager = st().staff.find((u) => u.pin_code === MANAGER_PIN)!;
    // Gravação direta em staff_users e role_permissions.
    expect((await raw('PATCH', `staff_users?id=eq.${cashier.id}`, { role: 'OWNER' })).status).toBe(403);
    expect((await raw('POST', 'staff_users', { id: crypto.randomUUID(), tenant_id: TENANT, name: 'Intruso', role: 'OWNER', pin_code: '2580' })).status).toBe(403);
    expect((await raw('POST', 'role_permissions?on_conflict=tenant_id,role,permission', { tenant_id: TENANT, role: 'WAITER', permission: 'STAFF_MANAGE', allowed: true }, 'resolution=merge-duplicates')).status).toBe(403);
    // audit_log com gerente direto na tabela.
    const forged = await raw('POST', 'audit_logs', { tenant_id: TENANT, performed_by_user_id: cashier.id, authorized_by_manager_id: manager.id, action_type: 'STAFF_ROLE_CHANGED', reason: 'forjado' });
    expect(forged.status).toBe(400);

    const rpc = (fn: string, args: Record<string, unknown>) => raw('POST', `rpc/${fn}`, args);
    const save = (over: Record<string, unknown>) =>
      rpc('tchefood_save_staff', {
        p_staff_id: cashier.id, p_name: cashier.name, p_role: 'CASHIER', p_pin: '3719', p_active: true,
        p_actor_id: manager.id, p_actor_pin: MANAGER_PIN, p_manager_pin: MANAGER_PIN, p_reason: 'Teste de trava', ...over,
      });
    // PIN do gerente errado: null, nada muda, a falha fica auditada.
    const failsBefore = Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`));
    expect(await save({ p_manager_pin: '0000' })).toEqual({ status: 200, body: 'null' });
    // Quem alterou não prova quem é (PIN de outra pessoa): null.
    expect(await save({ p_actor_pin: CASHIER_PIN })).toEqual({ status: 200, body: 'null' });
    expect(sql(`SELECT pin_code FROM staff_users WHERE id = '${cashier.id}'`)).toBe(CASHIER_PIN);
    expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`))).toBe(failsBefore + 2);
    // Gerente não promove ninguém a proprietário, nem com o próprio PIN de gerente.
    expect((await save({ p_role: 'OWNER', p_pin: CASHIER_PIN })).body).toMatch(/só o proprietário/);
    // Perfil é conferido antes da unicidade do PIN: com PIN já usado ou livre, a
    // resposta é a mesma (o gerente não descobre quais PINs existem).
    const newOwner = { p_staff_id: crypto.randomUUID(), p_name: 'Sócio', p_role: 'OWNER' };
    const taken = (await save({ ...newOwner, p_pin: OWNER_PIN })).body;
    const free = (await save({ ...newOwner, p_pin: '3719' })).body;
    expect(taken).toMatch(/só o proprietário/);
    expect(free).toBe(taken);
    // Garçom (sem STAFF_MANAGE) não cadastra, mesmo com PIN de gerente.
    const waiter = ok(st().saveStaff({ name: 'Garçom Caio', role: 'WAITER', pin_code: '6815', active: true }));
    await expectSynced('garçom');
    expect((await save({ p_actor_id: waiter.id, p_actor_pin: '6815' })).body).toMatch(/sem permissão/);
    // A loja não fica sem proprietário ativo.
    expect(
      (await save({ p_staff_id: owner.id, p_name: owner.name, p_role: 'OWNER', p_pin: owner.pin_code, p_active: false, p_actor_id: owner.id, p_actor_pin: owner.pin_code, p_manager_pin: MANAGER_PIN })).body,
    ).toMatch(/próprio acesso|proprietário ativo/);
    // PIN novo que já é de outra pessoa (todos os outros PINs certos): responde null
    // como PIN errado, sem mensagem própria, e conta no bloqueio (é a 3ª falha).
    expect(await save({ p_pin: OWNER_PIN })).toEqual({ status: 200, body: 'null' });
    expect(sql(`SELECT reason FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED' ORDER BY created_at DESC LIMIT 1`)).toBe('PIN novo recusado pelo servidor');
    expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`))).toBe(failsBefore + 3);
    // Permissão: só o proprietário, e com PIN de gerente/proprietário.
    const perm = (over: Record<string, unknown>) =>
      rpc('tchefood_set_role_permission', { p_role: 'WAITER', p_permission: 'STAFF_MANAGE', p_allowed: true, p_actor_id: owner.id, p_actor_pin: owner.pin_code, p_manager_pin: MANAGER_PIN, p_reason: 'Teste de trava', ...over });
    expect((await perm({ p_actor_id: manager.id, p_actor_pin: MANAGER_PIN })).body).toMatch(/só o proprietário/);
    expect((await perm({ p_manager_pin: '0000' })).body).toBe('null');
    expect(sql(`SELECT count(*) FROM role_permissions WHERE tenant_id = '${TENANT}' AND role = 'WAITER'`)).toBe('0');
    // Loja nova numa loja da nuvem que já tem equipe: recusada.
    expect(
      (await rpc('tchefood_start_store', { p_owner_id: crypto.randomUUID(), p_owner_name: 'Outro', p_owner_pin: '2580', p_qr_user_id: null, p_reason: 'Tentar de novo' })).body,
    ).toMatch(/já tem equipe/);
    // 3 PINs errados em 60 s bloqueiam (mesmo bloqueio da autorização de gerente).
    await save({ p_manager_pin: '0001' });
    expect(await save({})).toEqual({ status: 200, body: 'null' });
    expect(sql(`SELECT count(*) > 0 FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_LOCKOUT'`)).toBe('t');
    expect(sql(`SELECT pin_code FROM staff_users WHERE id = '${cashier.id}'`)).toBe(CASHIER_PIN);
    // Sem oráculo de PIN: chutar o PIN gravado de alguém (sem provar quem altera) nunca
    // devolve sucesso sem passar pela conferência que conta no bloqueio.
    const attempts = () => Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type IN ('MANAGER_PIN_FAILED', 'MANAGER_PIN_LOCKOUT')`));
    const ownerRow = { p_staff_id: owner.id, p_name: owner.name, p_role: 'OWNER', p_active: true, p_manager_pin: null, p_reason: null };
    const before = attempts();
    expect(await save({ ...ownerRow, p_pin: owner.pin_code, p_actor_id: cashier.id, p_actor_pin: '0000' })).toEqual({ status: 200, body: 'null' });
    expect(await save({ ...ownerRow, p_pin: '0001', p_actor_id: owner.id, p_actor_pin: '0002' })).toEqual({ status: 200, body: 'null' });
    expect((await rpc('tchefood_start_store', { p_owner_id: owner.id, p_owner_name: owner.name, p_owner_pin: '0003', p_qr_user_id: null, p_reason: 'Tentar de novo' })).body).toBe('null');
    expect(attempts()).toBe(before + 3);
    // O PIN nunca vai para o audit_log.
    // (O PIN como valor solto: dentro de um UUID aleatório, como 5867f1eb-…-88ec3525162c, não conta.)
    expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND (metadata::text ~ '(^|[^0-9a-f-])${CASHIER_PIN}([^0-9a-f-]|$)' OR metadata::text ~ '(^|[^0-9a-f-])${MANAGER_PIN}([^0-9a-f-]|$)')`)).toBe('0');
    // anon não chama as funções.
    expect(sql(`SELECT has_function_privilege('anon', 'tchefood_save_staff(uuid,text,user_role,varchar,boolean,uuid,varchar,varchar,text,timestamptz)', 'EXECUTE')`)).toBe('f');
    expect(sql(`SELECT has_function_privilege('authenticated', 'tchefood_check_pin(uuid,varchar[],user_role[],uuid,uuid,varchar,text)', 'EXECUTE')`)).toBe('f');
  });

  it('travas: desconto forjado na comanda é recusado', async () => {
    vi.useRealTimers();
    login(CASHIER_PIN);
    const mesa = st().tables.find((t) => t.number === 1)!;
    const p = st().products.find((x) => x.id === productId)!;
    const order = ok(st().openTable(mesa.id, 1, null));
    ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order.id));
    await expectSynced('comanda para o desconto forjado');
    const forged = await raw('PATCH', `orders?id=eq.${order.id}`, { discount_amount: 10 }, 'return=representation');
    expect(forged.body).toMatch(/DISCOUNT_APPLIED sem PIN/);
    const fee = await raw('PATCH', `orders?id=eq.${order.id}`, { charge_service_fee: false }, 'return=representation');
    expect(fee.body).toMatch(/SERVICE_FEE_REMOVED sem PIN/);
    const totals = await raw('PATCH', `orders?id=eq.${order.id}`, { remaining_balance: 0 }, 'return=representation');
    expect(totals.body).toMatch(/calculados pelo banco/);
    // O aparelho não escolhe a ordem de gravação.
    const seq = await raw('POST', 'audit_logs', { tenant_id: TENANT, order_id: order.id, performed_by_user_id: st().currentUserId!, action_type: 'SERVICE_FEE_RESTORED', reason: 'x', server_seq: 1 });
    expect(seq.status).toBe(400);
  });

  it('alterações de equipe da mesma loja esperam uma pela outra (regra do último proprietário)', async () => {
    vi.useRealTimers();
    // Outra transação segurando a loja: tchefood_save_staff tem de esperar por ela.
    const holder = spawn('psql', ['-h', target!.host, '-p', target!.port, '-U', target!.user, '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const done = new Promise((r) => holder.on('exit', r));
    holder.stdin.end(`BEGIN; SELECT 1 FROM tenants WHERE id = '${TENANT}' FOR UPDATE; SELECT pg_sleep(1.5); COMMIT;`);
    await new Promise((r) => setTimeout(r, 400));
    const started = Date.now();
    const res = await raw('POST', 'rpc/tchefood_save_staff', {
      p_staff_id: crypto.randomUUID(), p_name: 'Espera', p_role: 'WAITER', p_pin: '3719', p_active: true,
      p_actor_id: crypto.randomUUID(), p_actor_pin: '0000',
    });
    expect(res.body).toMatch(/operador inválido/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    await done;
  });

  /** Tira do bloqueio de 3 erros em 60 s as falhas de PIN dos testes de trava anteriores. */
  function forgetPinFailures() {
    sql(`ALTER TABLE audit_logs DISABLE TRIGGER USER;
         UPDATE audit_logs SET created_at = created_at - INTERVAL '5 minutes' WHERE action_type IN ('MANAGER_PIN_FAILED', 'MANAGER_PIN_LOCKOUT');
         ALTER TABLE audit_logs ENABLE TRIGGER USER;`);
  }

  it('troca de barril com PIN de gerente: histórico, audit_log e barril novo pela função do servidor', async () => {
    forgetPinFailures();
    const tapId = crypto.randomUUID();
    const tappedAt = new Date(Date.now() - 3_600_000).toISOString();
    sql(`INSERT INTO keg_taps (id, tenant_id, tap_number, beer_name, total_capacity_ml, billed_volume_ml, wasted_foam_ml, keg_cost, tapped_at)
         VALUES ('${tapId}', '${TENANT}', 1, 'Chopp Pilsen 50L', 50000, 42000, 1500, 480, '${tappedAt}');`);
    useTcheStore.setState((s) => ({
      kegTaps: [
        ...s.kegTaps,
        { id: tapId, tenant_id: TENANT, tap_number: 1, beer_name: 'Chopp Pilsen 50L', total_capacity_ml: 50000, billed_volume_ml: 42000,
          wasted_foam_ml: 1500, remaining_volume_ml: 6500, measured_remaining_ml: null, measured_at: null, keg_cost: 480, active: true, tapped_at: tappedAt },
      ],
    }));
    login(CASHIER_PIN);
    ok(st().recordKegReading(tapId, 4000));
    await expectSynced('leitura do barril');
    ok(st().tapNewKeg(tapId, { beer_name: 'Chopp IPA 30L', total_capacity_ml: 30000, keg_cost: 390 }, { managerPin: MANAGER_PIN, reason: 'Barril da Pilsen acabou' }));
    const history = st().kegHistory[0]!;
    await expectSynced('troca de barril');
    expect(sql(`SELECT beer_name || ' ' || billed_volume_ml || ' ' || wasted_foam_ml || ' ' || measured_remaining_ml FROM keg_history WHERE id = '${history.id}'`)).toBe('Chopp Pilsen 50L 42000 1500 4000');
    expect(sql(`SELECT beer_name || ' ' || total_capacity_ml || ' ' || billed_volume_ml || ' ' || keg_cost FROM keg_taps WHERE id = '${tapId}'`)).toBe('Chopp IPA 30L 30000 0 390.00');
    expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'KEG_CHANGED' AND (metadata->>'server_verified')::boolean AND metadata->>'keg_history_id' = '${history.id}'`)).toBe('1');
    // Reenvio (resposta perdida): devolve o mesmo barril encerrado, sem duplicar.
    const again = await raw('POST', 'rpc/tchefood_change_keg', {
      p_history_id: history.id, p_audit_id: crypto.randomUUID(), p_tap_id: tapId, p_beer_name: 'Chopp IPA 30L', p_capacity_ml: 30000, p_keg_cost: 390,
      p_performed_by: history.kicked_by_user_id, p_manager_pin: MANAGER_PIN, p_reason: 'Reenvio da fila', p_kicked_at: history.kicked_at,
    });
    expect(again.body).toBe(JSON.stringify(history.id));
    expect(sql(`SELECT count(*) FROM keg_history WHERE tap_id = '${tapId}'`)).toBe('1');
    // PIN errado: nada muda e a fila segura a torneira até o reenvio com o PIN certo.
    ok(st().tapNewKeg(tapId, { beer_name: 'Chopp Weiss 30L', total_capacity_ml: 30000, keg_cost: 400 }, { managerPin: MANAGER_PIN, reason: 'Troca para a Weiss' }));
    const ev = st().outbox.find((e) => e.table === 'keg_history')!;
    useTcheStore.setState((s) => ({ outbox: s.outbox.map((e) => (e.id === ev.id ? { ...e, manager_pin: '0000' } : e)) }));
    const rejected = await sync();
    expect(rejected.map((r) => r.eventId)).toEqual([ev.id]);
    expect(st().outbox.map((e) => e.table)).toEqual(['keg_taps']);
    expect(sql(`SELECT beer_name FROM keg_taps WHERE id = '${tapId}'`)).toBe('Chopp IPA 30L');
    ok(st().confirmRejectedAuthorization(ev.id, MANAGER_PIN));
    st().retryRejectedSync();
    await expectSynced('troca de barril reenviada com o PIN certo');
    expect(sql(`SELECT beer_name FROM keg_taps WHERE id = '${tapId}'`)).toBe('Chopp Weiss 30L');
    // Duas trocas, dois registros KEG_CHANGED conferidos pelo servidor (o reenvio não duplicou).
    expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'KEG_CHANGED'`)).toBe('2');
  });

  it('cobrança incerta registrada pelo comprovante sobe com o pagamento e o PIN do gerente', async () => {
    forgetPinFailures();
    login(OWNER_PIN);
    ok(st().saveTable({ number: 2, label: 'Mesa 2', area: 'Salão', capacity: 4, active: true }));
    login(CASHIER_PIN);
    const mesa = st().tables.find((t) => t.number === 2)!;
    const order = ok(st().openTable(mesa.id, 2, null));
    const p = st().products.find((x) => x.id === productId)!;
    ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order.id));
    ok(st().startCheckout(order.id));
    const amount = st().orders.find((o) => o.id === order.id)!.remaining_balance;
    setReviewHold({
      order_id: order.id, amount, reason: 'Queda no meio da cobrança', code: 'WRAPPER_EXCEPTION', method: 'CREDIT', acquirer: 'STONE',
      terminal_id: null, terminal_serial: 'STONE-01', idempotency_key: `hold-${order.id}`,
    });
    const pay = ok(st().confirmReviewedCharge({ orderId: order.id, nsu: '004512', authorization_code: 'A1B2C3', card_brand: 'VISA' }, MANAGER));
    await expectSynced('cobrança incerta');
    expect(sql(`SELECT status || ' ' || remaining_balance FROM orders WHERE id = '${order.id}'`)).toBe('CLOSED 0.00');
    expect(sql(`SELECT nsu FROM payments WHERE id = '${pay.payment.id}'`)).toBe('004512');
    expect(sql(`SELECT amount_impact || ' ' || (metadata->>'nsu') FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'CHARGE_CONFIRMED_MANUALLY' AND (metadata->>'server_verified')::boolean`)).toBe(`${amount.toFixed(2)} 004512`);
    // Registro sem o pagamento do comprovante (NSU diferente): recusado.
    const cashier = st().staff.find((u) => u.pin_code === CASHIER_PIN)!;
    const forged = await raw('POST', 'rpc/tchefood_authorize_manager', {
      p_order_id: order.id, p_action_type: 'CHARGE_CONFIRMED_MANUALLY', p_manager_pin: MANAGER_PIN, p_performed_by: cashier.id,
      p_reason: 'Comprovante de outra conta', p_amount_impact: amount, p_metadata: { payment_id: pay.payment.id, nsu: '999999', client_audit_id: crypto.randomUUID() },
    });
    expect(forged.status).toBe(400);
    expect(forged.body).toMatch(/pagamento do comprovante/);
  });

  it('saída do totem com PIN de gerente', async () => {
    forgetPinFailures();
    login(OWNER_PIN);
    const kiosk = ok(st().saveStaff({ name: 'Totem 1', role: 'KIOSK', pin_code: '6082', active: true }));
    await expectSynced('usuário do totem');
    login('6082');
    ok(st().exitKioskMode(MANAGER));
    await expectSynced('saída do totem');
    expect(sql(`SELECT count(*) FROM audit_logs WHERE performed_by_user_id = '${kiosk.id}' AND action_type = 'KIOSK_EXIT' AND order_id IS NULL AND (metadata->>'server_verified')::boolean`)).toBe('1');
    // Só o aparelho do totem registra a saída.
    const cashier = st().staff.find((u) => u.pin_code === CASHIER_PIN)!;
    const other = await raw('POST', 'rpc/tchefood_authorize_manager', {
      p_order_id: null, p_action_type: 'KIOSK_EXIT', p_manager_pin: MANAGER_PIN, p_performed_by: cashier.id, p_reason: 'Saída forjada', p_metadata: {},
    });
    expect(other.status).toBe(400);
    login(CASHIER_PIN);
  });

  it('combo: o combo leva o preço, os componentes sobem com preço zero e o banco recusa componente forjado', async () => {
    login(OWNER_PIN);
    const base = st().products.find((x) => x.id === productId)!;
    const refri = ok(
      st().saveProduct({
        category_id: categoryId, code: '231', name: 'Refrigerante lata', description: null, price: 7.9, sector: 'BAR', available: true, active: true,
        requires_meat_doneness: false, allows_half_and_half: false, ncm: '22021000', cfop: '5102', csosn_cst: '102', unit: 'UN',
        cost_price: 0, stock_quantity: 0, barcode: null,
      }),
    );
    const combo = ok(
      st().saveProduct({
        category_id: categoryId, code: '501', name: 'Combo Executivo', description: null, price: 49.9, sector: 'NONE', available: true, active: true,
        requires_meat_doneness: false, allows_half_and_half: false, ncm: '21069090', cfop: '5102', csosn_cst: '102', unit: 'UN',
        cost_price: 0, stock_quantity: 0, barcode: null, is_combo: true,
      }),
    );
    const prato = ok(st().saveModifierGroup({ name: 'Prato do combo', min_selection: 1, max_selection: 1, required: true }));
    const bebida = ok(st().saveModifierGroup({ name: 'Bebida do combo', min_selection: 1, max_selection: 1, required: true }));
    const optPrato = ok(st().saveModifierOption({ group_id: prato.id, name: base.name, additional_price: 0, component_product_id: base.id, component_quantity: 1 }));
    const optRefri = ok(st().saveModifierOption({ group_id: bebida.id, name: refri.name, additional_price: 0, component_product_id: refri.id, component_quantity: 2 }));
    ok(st().setProductModifierGroups(combo.id, [prato.id, bebida.id]));
    await expectSynced('cadastro do combo');
    expect(sql(`SELECT is_combo FROM products WHERE id = '${combo.id}'`)).toBe('t');

    login(CASHIER_PIN);
    const mesa = st().tables.find((t) => t.number === 2)!;
    const order = ok(st().openTable(mesa.id, 1, null));
    const mods = [optPrato, optRefri].map((o) => ({ group_id: o.group_id, option_id: o.id, name: o.name, additional_price: o.additional_price }));
    ok(st().addToTray({ order_id: order.id, product_id: combo.id, half_product_ids: [], quantity: 1, unit_price: combo.price, modifiers: mods, modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: combo.sector }));
    const sent = ok(st().dispatchTray(order.id)).items;
    expect(sent).toHaveLength(3);
    const childEvent = st().outbox.find((e) => e.table === 'order_items' && e.row_id === sent[2]!.id)!;
    const childRow = sanitizePayload(childEvent);
    await expectSynced('comanda com combo');
    expect(sql(`SELECT subtotal_items FROM orders WHERE id = '${order.id}'`)).toBe('49.90');
    expect(sql(`SELECT count(*) || ' ' || sum(quantity) FROM order_items WHERE combo_parent_item_id = '${sent[0]!.id}' AND total_item_price = 0`)).toBe('2 3.000');

    // Componente a mais (quantidade fora do cadastro) e componente com preço: recusados.
    const extra = await raw('POST', 'order_items', { ...childRow, id: crypto.randomUUID(), quantity: 5 });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatch(/não oferece este produto/);
    const priced = await raw('POST', 'order_items', { ...childRow, id: crypto.randomUUID(), unit_price: 7.9, total_item_price: 15.8 });
    expect(priced.status).toBe(400);
    expect(priced.body).toMatch(/não tem preço próprio/);
    // Combo dentro de combo: recusado no cadastro.
    const nested = await raw('PATCH', `modifier_options?id=eq.${optRefri.id}`, { component_product_id: combo.id });
    expect(nested.body).toMatch(/combo não entra dentro de outro combo/);

    // Cancelar o combo cancela os componentes (um audit_log por item, com PIN).
    forgetPinFailures();
    ok(st().cancelOrderItem(sent[0]!.id, MANAGER));
    await expectSynced('cancelamento do combo');
    expect(sql(`SELECT count(*) FROM order_items WHERE order_id = '${order.id}' AND status = 'CANCELED'`)).toBe('3');
    expect(sql(`SELECT total_amount FROM orders WHERE id = '${order.id}'`)).toBe('0.00');
  });

  it('dinheiro no servidor: preço de horário e meio a meio conferem; item com preço diferente só entra com PIN de gerente', async () => {
    forgetPinFailures();
    login(OWNER_PIN);
    const pizza = (code: string, name: string, price: number) =>
      ok(
        st().saveProduct({
          category_id: categoryId, code, name, description: null, price, sector: 'KITCHEN', available: true, active: true,
          requires_meat_doneness: false, allows_half_and_half: true, ncm: '19052090', cfop: '5102', csosn_cst: '102', unit: 'UN',
          cost_price: 0, stock_quantity: 0, barcode: null,
        }),
      );
    const calabresa = pizza('701', 'Pizza Calabresa', 60);
    const marguerita = pizza('702', 'Pizza Marguerita', 55.15);
    // Regra de horário o dia todo, todos os dias (o banco usa o fuso de São Paulo).
    ok(st().savePriceSchedule({ product_id: productId, name: 'Promoção do dia', weekdays: [0, 1, 2, 3, 4, 5, 6], start_time: '00:01', end_time: '00:00', price: 39.9, active: true }));
    st().setHalfAndHalfPricing('AVERAGE');
    ok(st().saveTable({ number: 3, label: 'Mesa 3', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('pizzas, regra de horário e meio a meio pela média');
    expect(sql(`SELECT half_and_half_pricing FROM tenants WHERE id = '${TENANT}'`)).toBe('AVERAGE');

    login(CASHIER_PIN);
    const mesa = st().tables.find((t) => t.number === 3)!;
    const order = ok(st().openTable(mesa.id, 2, null));
    const carreteiro = st().products.find((x) => x.id === productId)!;
    ok(st().addToTray({ order_id: order.id, product_id: carreteiro.id, half_product_ids: [], quantity: 2, unit_price: carreteiro.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: carreteiro.sector }));
    ok(st().addToTray({ order_id: order.id, product_id: calabresa.id, half_product_ids: [marguerita.id], quantity: 1, unit_price: 0, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: calabresa.sector }));
    const items = ok(st().dispatchTray(order.id)).items;
    expect(items.map((i) => i.unit_price)).toEqual([39.9, 57.58]); // média em centavos, arredondada
    await expectSynced('itens com preço de horário e meio a meio');
    const mismatches = () => Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'PRICE_MISMATCH'`));
    // Nada lançado pelo app até aqui (em nenhum teste) ficou diferente do cadastro.
    expect(mismatches()).toBe(0);
    expect(sql(`SELECT total_amount FROM orders WHERE id = '${order.id}'`)).toBe(st().orders.find((o) => o.id === order.id)!.total_amount.toFixed(2));

    // Item gravado direto com preço menor que o do cadastro: recusado (decisão do Will: só com PIN de gerente).
    const forgedItem = {
      id: crypto.randomUUID(), order_id: order.id, product_id: calabresa.id, waiter_id: st().currentUserId, quantity: 2, unit_price: 1, modifiers_unit_price: 0,
      sector: 'KITCHEN', status: 'PENDING', origin: 'WAITER', priced_at: new Date().toISOString(),
    };
    const forged = await raw('POST', 'order_items', forgedItem);
    expect(forged.status).toBe(400);
    expect(forged.body).toContain('preço do cadastro R$ 60.00, o aparelho mandou R$ 1.00');
    expect(sql(`SELECT count(*) FROM order_items WHERE id = '${forgedItem.id}'`)).toBe('0');
    expect(mismatches()).toBe(0);
    type PricedItem = { id: string; product_id: string; quantity: number; unit_price: number; modifiers_unit_price?: number; half_product_ids?: string[]; modifier_option_ids?: string[] };
    const overrideMeta = (item: PricedItem) => ({
      item_id: item.id, product_id: item.product_id, quantity: item.quantity, unit_price: item.unit_price,
      modifiers_unit_price: item.modifiers_unit_price ?? 0, half_product_ids: item.half_product_ids ?? [], modifier_option_ids: item.modifier_option_ids ?? [],
    });
    const authorize = (item: PricedItem, pin: string, meta: Record<string, unknown> = {}) => raw('POST', 'rpc/tchefood_authorize_manager', {
      p_order_id: order.id, p_action_type: 'PRICE_OVERRIDE', p_manager_pin: pin, p_performed_by: st().currentUserId,
      p_reason: 'Preço combinado com o cliente', p_amount_impact: 0,
      p_metadata: { ...overrideMeta(item), client_audit_id: crypto.randomUUID(), ...meta },
    });
    const overridesOf = (itemId: string) => sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'PRICE_OVERRIDE' AND metadata->>'item_id' = '${itemId}'`);
    // PIN errado não autoriza; autorização com valor próprio é recusada.
    await authorize(forgedItem, '0000');
    expect((await raw('POST', 'order_items', forgedItem)).status).toBe(400);
    const withImpact = await raw('POST', 'rpc/tchefood_authorize_manager', {
      p_order_id: order.id, p_action_type: 'PRICE_OVERRIDE', p_manager_pin: MANAGER_PIN, p_performed_by: st().currentUserId,
      p_reason: 'Preço combinado com o cliente', p_amount_impact: -50, p_metadata: overrideMeta(forgedItem),
    });
    expect(withImpact.body).toContain('não tem valor próprio');
    // Autorização com campo inválido (P2-01 do GPT): recusada e não gravada; depois uma
    // válida funciona (a gravada errada quebraria a conferência do item para sempre).
    for (const bad of [{ unit_price: 'abc' }, { quantity: 0 }, { item_id: 'não-é-uuid' }, { half_product_ids: 'x' }, { modifier_option_ids: undefined },
                       // P2-01 da rodada 2: NaN em cada campo numérico.
                       { quantity: 'NaN' }, { unit_price: 'NaN' }, { modifiers_unit_price: 'NaN' }]) {
      const r = await authorize(forgedItem, MANAGER_PIN, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toContain('válidos no metadata');
    }
    expect(overridesOf(forgedItem.id)).toBe('0');
    // Autorização de outro preço não vale para este item.
    expect((await authorize({ ...forgedItem, unit_price: 2 }, MANAGER_PIN)).status).toBe(200);
    expect((await raw('POST', 'order_items', forgedItem)).status).toBe(400);
    // P0-01 do GPT: a autorização é do item inteiro. Com o mesmo id e o mesmo preço, trocar
    // o produto, a quantidade, os sabores ou os adicionais não passa.
    expect((await authorize(forgedItem, MANAGER_PIN)).status).toBe(200);
    const group = crypto.randomUUID();
    const option = crypto.randomUUID();
    sql(`INSERT INTO modifier_groups (id, tenant_id, name) VALUES ('${group}', '${TENANT}', 'Borda');
         INSERT INTO modifier_options (id, group_id, name, additional_price) VALUES ('${option}', '${group}', 'Borda recheada', 12);
         INSERT INTO product_modifier_groups (product_id, group_id) VALUES ('${calabresa.id}', '${group}');`);
    for (const swap of [{ product_id: marguerita.id }, { quantity: 5 }, { half_product_ids: [marguerita.id] }, { modifier_option_ids: [option] }]) {
      const r = await raw('POST', 'order_items', { ...forgedItem, ...swap });
      expect(r.status, JSON.stringify(swap)).toBe(400);
      expect(r.body).toContain('TCHEFOOD_PRECO');
    }
    expect(sql(`SELECT count(*) FROM order_items WHERE id = '${forgedItem.id}'`)).toBe('0');
    // Com a autorização do gerente para este item exato: entra, e o alerta leva o gerente.
    expect((await raw('POST', 'order_items', forgedItem)).status).toBe(201);
    expect(mismatches()).toBe(1);
    expect(sql(`SELECT amount_impact || ' ' || (metadata->>'expected_unit_price') || ' ' || (authorized_by_manager_id IS NOT NULL) || ' ' || (metadata->>'server_verified') FROM audit_logs WHERE action_type = 'PRICE_MISMATCH' AND order_id = '${order.id}'`)).toBe('118.00 60.00 true true');
    // P2-02 da rodada 2: adicional que o cadastro não reconhece, com o instante do preço e a
    // autorização do gerente. Entra, mas o alerta não diz que o servidor conferiu o preço.
    const unknownItem = { ...forgedItem, id: crypto.randomUUID(), quantity: 1, unit_price: 60, modifier_option_ids: [crypto.randomUUID()] };
    const unknown = await raw('POST', 'order_items', unknownItem);
    expect(unknown.status).toBe(400);
    expect(unknown.body).toContain('não reconhece');
    expect((await authorize(unknownItem, MANAGER_PIN)).status).toBe(200);
    expect((await raw('POST', 'order_items', unknownItem)).status).toBe(201);
    expect(sql(`SELECT (metadata->>'server_verified') || ' ' || (metadata->>'expected_unit_price' IS NULL) || ' ' || (authorized_by_manager_id IS NOT NULL) FROM audit_logs WHERE action_type = 'PRICE_MISMATCH' AND metadata->>'item_id' = '${unknownItem.id}'`)).toBe('false true true');
    // Item de fila antiga (sem o instante do preço) com o preço do cadastro de agora: entra, como antes.
    const legacyOk = await raw('POST', 'order_items', {
      id: crypto.randomUUID(), order_id: order.id, product_id: calabresa.id, waiter_id: st().currentUserId, quantity: 1, unit_price: 60, modifiers_unit_price: 0,
      sector: 'KITCHEN', status: 'PENDING', origin: 'WAITER',
    });
    expect(legacyOk.status).toBe(201);
    // P0-01 da rodada 4 do GPT: a conferência do preço roda na inserção. Depois do envio, os
    // sabores e adicionais do item (que formam o preço) não mudam: com a borda de R$ 12 o
    // item custaria R$ 72 e continuaria cobrado por R$ 60.
    const sent = {
      id: crypto.randomUUID(), order_id: order.id, product_id: calabresa.id, waiter_id: st().currentUserId, quantity: 1, unit_price: 60, modifiers_unit_price: 0,
      sector: 'KITCHEN', status: 'PENDING', origin: 'WAITER', priced_at: new Date().toISOString(), half_product_ids: [] as string[], modifier_option_ids: [] as string[],
    };
    expect((await raw('POST', 'order_items', sent)).status).toBe(201);
    const snapshot = () => sql(`SELECT i.half_product_ids::text || ' ' || i.modifier_option_ids::text || ' ' || i.total_item_price || ' ' || o.total_amount || ' ' || (SELECT count(*) FROM audit_logs WHERE order_id = o.id)
                                FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.id = '${sent.id}'`);
    const before = snapshot();
    expect(before.startsWith('{} {} 60.00')).toBe(true);
    for (const change of [{ modifier_option_ids: [option] }, { half_product_ids: [marguerita.id] }]) {
      const r = await raw('PATCH', `order_items?id=eq.${sent.id}`, change);
      expect(r.status, JSON.stringify(change)).toBe(400);
      expect(r.body).toContain('TCHEFOOD_ANTIFRAUDE');
      expect(snapshot()).toBe(before);
    }
    // Reenvio do mesmo item (como a fila faz) e upsert sem mudar a composição: aceitos.
    expect((await raw('PATCH', `order_items?id=eq.${sent.id}`, sent)).status).toBeLessThan(300);
    expect((await raw('POST', 'order_items?on_conflict=id', sent, 'resolution=merge-duplicates,return=minimal')).status).toBeLessThan(300);
    // Upsert do mesmo id com outra composição: recusado.
    const upsert = await raw('POST', 'order_items?on_conflict=id', { ...sent, half_product_ids: [marguerita.id] }, 'resolution=merge-duplicates,return=minimal');
    expect(upsert.status).toBe(400);
    expect(snapshot()).toBe(before);
    // O status segue mudando (PENDING → PREPARING).
    expect((await raw('PATCH', `order_items?id=eq.${sent.id}`, { status: 'PREPARING' })).status).toBeLessThan(300);
    expect(sql(`SELECT status FROM order_items WHERE id = '${sent.id}'`)).toBe('PREPARING');
    expect(snapshot()).toBe(before);
    // Com preço diferente: só com PIN.
    const legacyItem = {
      id: crypto.randomUUID(), order_id: order.id, product_id: calabresa.id, waiter_id: st().currentUserId, quantity: 1, unit_price: 1, modifiers_unit_price: 0,
      sector: 'KITCHEN', status: 'PENDING', origin: 'WAITER',
    };
    const legacy = await raw('POST', 'order_items', legacyItem);
    expect(legacy.status).toBe(400);
    expect(legacy.body).toContain('sem o instante do preço');
    expect((await authorize(legacyItem, MANAGER_PIN)).status).toBe(200);
    expect((await raw('POST', 'order_items', legacyItem)).status).toBe(201);
    expect(sql(`SELECT amount_impact || ' ' || (metadata->>'server_verified') FROM audit_logs WHERE action_type = 'PRICE_MISMATCH' AND order_id = '${order.id}' ORDER BY created_at DESC LIMIT 1`)).toBe('0.00 false');

    // Pelo app: preço trocado em outro aparelho (este ainda tem o antigo). O item é recusado,
    // o gerente aceita com PIN em Nuvem › recusados, e a autorização sobe antes do item.
    sql(`UPDATE products SET price = 61 WHERE id = '${marguerita.id}'`);
    ok(st().addToTray({ order_id: order.id, product_id: marguerita.id, half_product_ids: [], quantity: 1, unit_price: 55.15, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: marguerita.sector }));
    const staleItem = ok(st().dispatchTray(order.id)).items[0]!;
    await sync();
    const rejected = st().syncRejected.find((r) => r.event.row_id === staleItem.id)!;
    expect(rejected.message).toContain('TCHEFOOD_PRECO');
    expect(isRejectedItemPrice(rejected)).toBe(true);
    expect(st().approveRejectedItemPrice(rejected.event.id, { managerPin: '9999', reason: 'Preço antigo da casa' }).ok).toBe(false);
    ok(st().approveRejectedItemPrice(rejected.event.id, { managerPin: MANAGER_PIN, reason: 'Preço antigo da casa' }));
    await expectSynced('item com preço aceito pelo gerente');
    expect(sql(`SELECT unit_price FROM order_items WHERE id = '${staleItem.id}'`)).toBe('55.15');
    expect(sql(`SELECT reason FROM audit_logs WHERE action_type = 'PRICE_OVERRIDE' AND metadata->>'item_id' = '${staleItem.id}' AND authorized_by_manager_id IS NOT NULL`)).toBe('Preço antigo da casa');
    sql(`UPDATE products SET price = 55.15 WHERE id = '${marguerita.id}'`);
    // Ficha Rápida no happy hour (regra de horário o dia todo no carreteiro): o app cobra
    // R$ 39,90 e o banco confere pela mesma regra, sem pedir PIN.
    const counter = ok(st().createCounterSale([{ product_id: productId, quantity: 1, modifiers: [], meat_doneness: null }]));
    expect(st().orderItems.find((i) => i.order_id === counter.id)!.unit_price).toBe(39.9);
    await expectSynced('Ficha Rápida no happy hour');
    expect(sql(`SELECT unit_price FROM order_items WHERE order_id = '${counter.id}'`)).toBe('39.90');

    // P0-02 do GPT: o instante do preço é o relógio do servidor. Promoção das 12h às 13h
    // num dia que não é hoje; item de Ficha Rápida com created_at/priced_at forjados dentro
    // dessa janela: recusado sem PIN. Pelo preço normal, entra.
    const spDay = (d: Date) => new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const past = new Date(Date.now() - 3 * 86_400_000);
    const pastSp = spDay(past);
    const promoDay = pastSp.getDay();
    const lanche = pizza('703', 'Xis Promoção', 50);
    ok(st().savePriceSchedule({ product_id: lanche.id, name: 'Almoço', weekdays: [promoDay], start_time: '12:00', end_time: '13:00', price: 20, active: true }));
    await expectSynced('promoção do almoço');
    const ymd = `${pastSp.getFullYear()}-${String(pastSp.getMonth() + 1).padStart(2, '0')}-${String(pastSp.getDate()).padStart(2, '0')}`;
    const forgedAt = new Date(`${ymd}T12:30:00-03:00`).toISOString();
    const promoItem = {
      id: crypto.randomUUID(), order_id: counter.id, product_id: lanche.id, waiter_id: st().currentUserId, quantity: 1, unit_price: 20, modifiers_unit_price: 0,
      sector: 'KITCHEN', status: 'PENDING', origin: 'SMARTPOS', priced_at: forgedAt, created_at: forgedAt,
    };
    const promo = await raw('POST', 'order_items', promoItem);
    expect(promo.status).toBe(400);
    expect(promo.body).toContain('preço do cadastro R$ 50.00, o aparelho mandou R$ 20.00');
    expect((await raw('POST', 'order_items', { ...promoItem, id: crypto.randomUUID(), unit_price: 50 })).status).toBe(201);

    // P0-01 da rodada 5 do GPT: promoção valendo agora não prova que valia na venda. Produto de
    // R$ 50 com promoção de R$ 20 em volta deste instante (todos os dias, para não depender
    // do dia); item de R$ 20 lançado há duas horas e guardado sem internet: recusado sem PIN.
    const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const almoco = pizza('704', 'Prato do Almoço', 50);
    ok(st().savePriceSchedule({ product_id: almoco.id, name: 'Agora', weekdays: allDays, start_time: hhmm(Date.now() - 30 * 60_000), end_time: hhmm(Date.now() + 60 * 60_000), price: 20, active: true }));
    // Promoção que começou há 2 minutos: item lançado 4 minutos atrás está perto do relógio
    // do servidor, mas antes da promoção.
    const recente = pizza('705', 'Prato Recém-promovido', 50);
    ok(st().savePriceSchedule({ product_id: recente.id, name: 'Começou agora', weekdays: allDays, start_time: hhmm(Date.now() - 2 * 60_000), end_time: hhmm(Date.now() + 60 * 60_000), price: 20, active: true }));
    await expectSynced('promoção valendo agora');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const lateItem = {
      id: crypto.randomUUID(), order_id: order.id, product_id: almoco.id, waiter_id: st().currentUserId, quantity: 1, unit_price: 20, modifiers_unit_price: 0,
      sector: 'KITCHEN', status: 'PENDING', origin: 'WAITER', priced_at: twoHoursAgo, created_at: twoHoursAgo,
    };
    const late = await raw('POST', 'order_items', lateItem);
    expect(late.status).toBe(400);
    expect(late.body).toContain('TCHEFOOD_PRECO: preço de promoção R$ 20.00 num item que chegou à nuvem fora da hora do lançamento (sem internet); sem a promoção, R$ 50.00');
    expect(sql(`SELECT count(*) FROM order_items WHERE id = '${lateItem.id}'`)).toBe('0');
    // O mesmo item dizendo que foi lançado agora, mas fora da janela de 5 minutos por 1 minuto: recusado.
    const sixMin = { ...lateItem, id: crypto.randomUUID(), priced_at: new Date(Date.now() - 6 * 60_000).toISOString() };
    expect((await raw('POST', 'order_items', sixMin)).status).toBe(400);
    const fourMinAgo = new Date(Date.now() - 4 * 60_000).toISOString();
    const beforeStart = { ...lateItem, id: crypto.randomUUID(), product_id: recente.id, priced_at: fourMinAgo, created_at: fourMinAgo };
    const early = await raw('POST', 'order_items', beforeStart);
    expect(early.status).toBe(400);
    expect(early.body).toContain('preço de promoção R$ 20.00');
    // Pelo preço normal, o item atrasado entra sem PIN.
    expect((await raw('POST', 'order_items', { ...lateItem, id: crypto.randomUUID(), unit_price: 50 })).status).toBe(201);
    // Com o PIN do gerente, o item atrasado entra e o alerta mostra os R$ 30 contra o preço sem promoção.
    expect((await authorize(lateItem, MANAGER_PIN)).status).toBe(200);
    expect((await raw('POST', 'order_items', lateItem)).status).toBe(201);
    expect(sql(`SELECT amount_impact || ' ' || (metadata->>'promotion_unverified') || ' ' || (metadata->>'expected_unit_price') || ' ' || (authorized_by_manager_id IS NOT NULL)
                FROM audit_logs WHERE action_type = 'PRICE_MISMATCH' AND metadata->>'item_id' = '${lateItem.id}'`)).toBe('30.00 true 50.00 true');
    // Venda legítima com internet: o app lança e sobe na hora, pelo preço da promoção, sem PIN.
    ok(st().addToTray({ order_id: order.id, product_id: almoco.id, half_product_ids: [], quantity: 1, unit_price: 20, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: almoco.sector }));
    ok(st().dispatchTray(order.id));
    const live = st().orderItems.filter((i) => i.order_id === order.id && i.product_id === almoco.id).at(-1)!;
    expect(live.unit_price).toBe(20);
    await expectSynced('promoção com internet');
    expect(sql(`SELECT unit_price FROM order_items WHERE id = '${live.id}'`)).toBe('20.00');
    expect(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'PRICE_MISMATCH' AND metadata->>'item_id' = '${live.id}'`)).toBe('0');
    // P2-01 da rodada 6 do GPT: o horário que liberou o preço de promoção não muda depois.
    const evidence = () => sql(`SELECT i.priced_at || ' ' || i.unit_price || ' ' || o.total_amount || ' '
      || (SELECT count(*) FROM audit_logs a WHERE a.order_id = o.id) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.id = '${live.id}'`);
    const sealed = evidence();
    const backdate = await raw('PATCH', `order_items?id=eq.${live.id}`, { priced_at: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    expect(backdate.status).toBe(400);
    expect(backdate.body).toContain('TCHEFOOD_ANTIFRAUDE');
    expect(evidence()).toBe(sealed);
    // Reenvio com o mesmo horário (o do aparelho) continua aceito, e o status segue mudando.
    expect((await raw('PATCH', `order_items?id=eq.${live.id}`, { priced_at: live.priced_at, unit_price: 20 })).status).toBe(204);
    expect((await raw('PATCH', `order_items?id=eq.${live.id}`, { status: 'PREPARING' })).status).toBe(204);
    expect(sql(`SELECT status FROM order_items WHERE id = '${live.id}'`)).toBe('PREPARING');
    expect(evidence()).toBe(sealed);

    // P0-03 do GPT: produto ou conta de outra loja. A recusa não mostra preço nem nome.
    const TENANT_B = '22222222-2222-4222-8222-222222222222';
    const productB = crypto.randomUUID();
    const orderB = crypto.randomUUID();
    const tableB = crypto.randomUUID();
    sql(`SET session_replication_role = replica;
         INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT_B}', 'Outra loja', 'Outra loja Ltda', '22333444000181');
         INSERT INTO categories (id, tenant_id, name) VALUES ('${productB}', '${TENANT_B}', 'Cat B');
         INSERT INTO products (id, tenant_id, category_id, code, name, price, sector) VALUES ('${productB}', '${TENANT_B}', '${productB}', 'B1', 'Segredo da Casa B', 77.77, 'KITCHEN');
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${tableB}', '${TENANT_B}', 1, 'Mesa B');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${tableB}', '${TENANT_B}', 'Dono B', 'OWNER', '9137');
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${orderB}', '${TENANT_B}', '${tableB}', '${tableB}');
         SET session_replication_role = origin;`);
    const leaks = [
      { ...promoItem, id: crypto.randomUUID(), order_id: order.id, product_id: productB, unit_price: 1, origin: 'WAITER' },
      { ...promoItem, id: crypto.randomUUID(), order_id: orderB, product_id: productB, unit_price: 1, origin: 'WAITER' },
      { ...promoItem, id: crypto.randomUUID(), order_id: orderB, product_id: calabresa.id, unit_price: 1, origin: 'WAITER' },
    ];
    for (const leak of leaks) {
      const r = await raw('POST', 'order_items', leak);
      expect(r.status).toBe(400);
      expect(r.body).not.toMatch(/77[.,]77|Segredo|60[.,]00/);
      // P2-02 da rodada 3: não é preço divergente, então não leva o prefixo do preço.
      expect(r.body).toContain('TCHEFOOD_REGISTRO_LOJA');
      expect(r.body).not.toContain('TCHEFOOD_PRECO');
      expect(sql(`SELECT count(*) FROM order_items WHERE id = '${leak.id}'`)).toBe('0');
    }
    // Autorização de preço com produto de outra loja: recusada.
    const crossAuth = await authorize({ id: crypto.randomUUID(), product_id: productB, quantity: 1, unit_price: 1 }, MANAGER_PIN);
    expect(crossAuth.status).toBe(400);
    expect(crossAuth.body).toContain('produto não encontrado nesta loja');

    // Pelo app: item de um produto que a nuvem não tem nesta loja. Fica nos recusados sem o
    // botão de aceitar o preço, e nenhuma autorização de preço entra na fila.
    login(MANAGER_PIN);
    ok(st().addToTray({ order_id: order.id, product_id: marguerita.id, half_product_ids: [], quantity: 1, unit_price: 55.15, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: marguerita.sector }));
    const strayItem = ok(st().dispatchTray(order.id)).items[0]!;
    sql(`SET session_replication_role = replica; UPDATE products SET tenant_id = '${TENANT_B}' WHERE id = '${marguerita.id}'; SET session_replication_role = origin;`);
    await sync();
    sql(`SET session_replication_role = replica; UPDATE products SET tenant_id = '${TENANT}' WHERE id = '${marguerita.id}'; SET session_replication_role = origin;`);
    const stray = st().syncRejected.find((r) => r.event.row_id === strayItem.id)!;
    expect(stray.message).toContain('TCHEFOOD_REGISTRO_LOJA');
    expect(isRejectedItemPrice(stray)).toBe(false);
    // Recusa gravada por aparelho antes desta versão (mesmo texto, prefixo antigo): também sem botão.
    expect(isRejectedItemPrice({ ...stray, message: 'TCHEFOOD_PRECO: produto ou conta não encontrado nesta loja.' })).toBe(false);
    const queued = st().outbox.length;
    expect(st().approveRejectedItemPrice(stray.event.id, { managerPin: MANAGER_PIN, reason: 'Tentativa de aceitar' }).ok).toBe(false);
    expect(st().outbox.length).toBe(queued);
    expect(st().outbox.some((e) => e.table === 'audit_logs' && (e.payload as { action_type?: string }).action_type === 'PRICE_OVERRIDE')).toBe(false);
    expect(st().syncRejected.some((r) => r.event.id === stray.event.id)).toBe(true);
  });

  it('dinheiro no servidor: pagamento só pela função, com saldo, NSU e caixa conferidos; conta só fecha zerada', async () => {
    login(CASHIER_PIN);
    const mesa = st().tables.find((t) => t.number === 3)!;
    const order = st().orders.find((o) => o.table_id === mesa.id && o.status === 'OPEN')!;
    const cashier = st().staff.find((u) => u.pin_code === CASHIER_PIN)!;
    const server = () => sql(`SELECT remaining_balance FROM orders WHERE id = '${order.id}'`);
    const pay = (over: Record<string, unknown>) => ({
      id: crypto.randomUUID(), order_id: order.id, tenant_id: TENANT, waiter_id: cashier.id, terminal_id: null, amount: 10, tip_amount: 0,
      method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE', acquirer_cnpj: null, card_brand: 'VISA', nsu: '778899', authorization_code: 'AB12',
      terminal_serial: 'STONE-01', idempotency_key: crypto.randomUUID(), created_at: new Date().toISOString(), ...over,
    });
    const rpc = (p: Record<string, unknown>) => raw('POST', 'rpc/tchefood_register_payment', { p_payment: p });

    // Gravar direto em payments: sem permissão.
    expect((await raw('POST', 'payments', pay({}))).status).toBe(403);
    // Fechar a conta com saldo: recusado.
    expect((await raw('PATCH', `orders?id=eq.${order.id}`, { status: 'CLOSED' })).body).toMatch(/ainda deve/);
    // Cartão aprovado sem NSU, dinheiro fora do caixa, valor acima do saldo: recusados.
    expect((await rpc(pay({ nsu: null }))).body).toMatch(/sem o NSU/);
    expect((await rpc(pay({ method: 'CASH', acquirer: 'STONE', nsu: null }))).body).toMatch(/caixa/);
    expect((await rpc(pay({ amount: 99999 }))).body).toMatch(/passa do saldo/);
    // Pagamento parcial com cartão; reenvio do mesmo id não duplica; o mesmo NSU não paga de novo.
    const first = pay({});
    expect((await rpc(first)).status).toBe(200);
    expect((await rpc(first)).status).toBe(200);
    expect(sql(`SELECT count(*) FROM payments WHERE id = '${first.id}'`)).toBe('1');
    expect((await rpc(pay({}))).body).toMatch(/já pagou outra conta/);
    // Hora do comprovante forjada (3 dias atrás) não escapa da trava: vale também a hora em que o servidor registrou.
    expect((await rpc(pay({ created_at: new Date(Date.now() - 3 * 86400_000).toISOString() }))).body).toMatch(/já pagou outra conta/);
    // Dois envios simultâneos do mesmo pagamento: os dois voltam 200 e só um registro entra.
    const twin = pay({ nsu: '556677', amount: 1 });
    const both = await Promise.all([rpc(twin), rpc(twin)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(sql(`SELECT count(*) FROM payments WHERE id = '${twin.id}'`)).toBe('1');
    // Recusado na maquininha: não mexe no saldo e não precisa de NSU.
    expect((await rpc(pay({ status: 'DECLINED', nsu: null, amount: 99999 }))).status).toBe(200);
    const left = server();
    expect(Number(left)).toBeGreaterThan(0);
    const cash = (amount: number) => pay({ method: 'CASH', acquirer: 'CASH_DESK', nsu: null, card_brand: null, terminal_serial: null, amount });
    // Paga tudo menos a taxa de serviço em dinheiro; dispensar a taxa e encerrar no MESMO update fecha a conta
    // (o saldo é refeito com a taxa nova, não pelo valor gravado antes).
    const fee = Number(sql(`SELECT service_fee_amount FROM orders WHERE id = '${order.id}'`));
    expect(fee).toBeGreaterThan(0);
    expect((await rpc(cash(Math.round((Number(left) - fee) * 100) / 100))).status).toBe(200);
    expect((await raw('PATCH', `orders?id=eq.${order.id}`, { status: 'CLOSED' })).body).toMatch(/ainda deve/);
    const auth = await raw('POST', 'rpc/tchefood_authorize_manager', {
      p_order_id: order.id, p_action_type: 'SERVICE_FEE_REMOVED', p_manager_pin: MANAGER_PIN, p_performed_by: st().currentUserId,
      p_reason: 'Teste da taxa dispensada', p_amount_impact: -fee, p_metadata: { client_audit_id: crypto.randomUUID() },
    });
    expect(auth.status).toBe(200);
    const waive = await raw('PATCH', `orders?id=eq.${order.id}`, { charge_service_fee: false, status: 'CLOSED' });
    expect(waive.status).toBeLessThan(300);
    expect(sql(`SELECT status || ' ' || remaining_balance FROM orders WHERE id = '${order.id}'`)).toBe('CLOSED 0.00');
    // Conta fechada não recebe mais pagamento nem reabre.
    expect((await rpc(pay({ method: 'CASH', acquirer: 'CASH_DESK', nsu: null, amount: 1 }))).body).toMatch(/fechada/);
    // Tentar reabrir (ou reenviar um evento antigo da fila) é ignorado: a conta continua fechada e nada trava.
    expect((await raw('PATCH', `orders?id=eq.${order.id}`, { status: 'OPEN' })).status).toBeLessThan(300);
    expect(sql(`SELECT status FROM orders WHERE id = '${order.id}'`)).toBe('CLOSED');
    // O aparelho ficou com a conta aberta (os pagamentos acima foram direto no servidor): fecha aqui sem subir.
    useTcheStore.setState((s) => ({
      orders: s.orders.map((o) => (o.id === order.id ? { ...o, status: 'CLOSED' as const } : o)),
      tables: s.tables.map((t) => (t.id === mesa.id ? { ...t, status: 'FREE' as const, current_order_id: null } : t)),
    }));
  });

  it('aparelho novo baixa a loja: cadastros pela RLS, equipe com PIN só com o PIN do gerente', async () => {
    forgetPinFailures();
    const cfg = { url: 'http://cloud.test', anonKey: 'anon', accessToken: 'jwt' };
    const fetchFn = postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device-2' }, emulatorLog);
    const productsBefore = Number(sql(`SELECT count(*) FROM products WHERE tenant_id = '${TENANT}'`));
    const session = st().cloud!;

    // O token do aparelho não lê PIN.
    expect((await raw('GET', 'staff_users?select=pin_code', undefined)).status).toBe(403);

    // Aparelho novo, ainda na demonstração.
    st().resetDemo();
    login('8888');
    const team = await fetchCloudStaff(cfg, fetchFn);
    const manager = team.find((u) => u.role === 'MANAGER')!;
    const cashier = team.find((u) => u.role === 'CASHIER')!;
    expect(team.length).toBeGreaterThan(3);
    expect(Object.keys(manager)).not.toContain('pin_code');
    // PIN errado, e PIN certo de quem não é gerente: nada de PIN.
    expect(await fetchStaffPins(cfg, manager.id, '0000', fetchFn)).toMatchObject({ ok: false });
    expect(await fetchStaffPins(cfg, cashier.id, CASHIER_PIN, fetchFn)).toMatchObject({ ok: false });
    forgetPinFailures();
    const pins = await fetchStaffPins(cfg, manager.id, MANAGER_PIN, fetchFn);
    if (!pins.ok) throw new Error(pins.error);
    expect(pins.staff.find((u) => u.id === cashier.id)!.pin_code).toBe(CASHIER_PIN);
    expect(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'STAFF_PULL' AND performed_by_user_id = '${manager.id}' AND metadata->>'device_user' = 'device-2'`)).toBe('1');

    const snapshot = await fetchCloudSnapshot(cfg, TENANT, fetchFn);
    expect(snapshot.tenant.name).toBe('Bar do Zé');
    expect(Object.keys(snapshot.tenant)).not.toContain('focus_nfe_token');
    expect(snapshot.products).toHaveLength(productsBefore);
    ok(st().joinCloudStore({ session, snapshot, staff: pins.staff, userId: manager.id }));
    expect(st().currentUserId).toBe(manager.id);
    expect(st().tenant.id).toBe(TENANT);
    expect(st().orders).toEqual([]);
    expect(st().outbox).toEqual([]);
    const combo = st().products.find((p) => p.code === '501')!;
    expect(combo.is_combo).toBe(true);
    expect(st().modifierOptions.some((o) => o.component_product_id && st().productModifierGroups.some((l) => l.product_id === combo.id && l.group_id === o.group_id))).toBe(true);
    expect(st().tables.every((t) => t.status === 'FREE')).toBe(true);
    // A caixa entra com o PIN dela neste aparelho.
    login(CASHIER_PIN);

    // Outro aparelho muda preço, desativa alguém e cadastra uma pessoa nova.
    const carreteiro = st().products.find((p) => p.id === productId)!;
    sql(`UPDATE products SET price = 51.90 WHERE id = '${productId}';
         UPDATE staff_users SET active = FALSE WHERE name = 'Totem 1' AND tenant_id = '${TENANT}';
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code, active) VALUES (gen_random_uuid(), '${TENANT}', 'Garçom Novo', 'WAITER', '3847', TRUE);`);
    // E este aparelho mudou outro produto ainda sem enviar.
    login(OWNER_PIN);
    const refri = st().products.find((p) => p.code === '231')!;
    const { tenant_id: _t, created_at: _c, ...refriDraft } = refri;
    ok(st().saveProduct({ ...refriDraft, price: 8.5 }));
    useTcheStore.setState({ pullStatus: { last_pull_at: null, last_error: null, cloud_staff_unknown: 0 } });
    expect(st().applyCloudSnapshot(await fetchCloudSnapshot(cfg, TENANT, fetchFn))).toMatchObject({ ok: true, data: { unknownStaff: 1 } });
    expect(st().products.find((p) => p.id === productId)!.price).toBe(51.9);
    expect(carreteiro.price).not.toBe(51.9);
    expect(st().products.find((p) => p.id === refri.id)!.price).toBe(8.5); // pendente aqui: fica
    expect(st().staff.find((u) => u.name === 'Totem 1')!.active).toBe(false);
    expect(st().pullStatus.cloud_staff_unknown).toBe(1);
    expect(st().login('3847').ok).toBe(false);
    // A fila sobe e a leitura seguinte já traz o preço deste aparelho.
    await expectSynced('produto alterado depois de baixar');
    expect(sql(`SELECT price FROM products WHERE id = '${refri.id}'`)).toBe('8.50');

    // "Atualizar equipe" com o PIN do gerente traz o garçom novo.
    login(OWNER_PIN);
    const owner = st().staff.find((u) => u.pin_code === OWNER_PIN)!;
    const again = await fetchStaffPins(cfg, owner.id, OWNER_PIN, fetchFn);
    if (!again.ok) throw new Error(again.error);
    expect(st().applyCloudStaff(again.staff)).toMatchObject({ ok: true, data: { added: 1 } });
    expect(st().pullStatus.cloud_staff_unknown).toBe(0);
    expect(st().login('3847').ok).toBe(true);
    login(CASHIER_PIN);
  });

  it('a rodada de sincronização lê a nuvem com a fila vazia', async () => {
    sql(`UPDATE products SET price = 52.90 WHERE id = '${productId}';`);
    useTcheStore.setState({ pullStatus: { last_pull_at: null, last_error: null, cloud_staff_unknown: 0 } });
    await syncOnce(postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device-2' }, emulatorLog));
    expect(st().pullStatus.last_error).toBeNull();
    expect(st().pullStatus.last_pull_at).not.toBeNull();
    expect(st().products.find((p) => p.id === productId)!.price).toBe(52.9);
    // Dentro do minuto não lê de novo; com forcePull ("Sincronizar agora") lê.
    sql(`UPDATE products SET price = 53.90 WHERE id = '${productId}';`);
    await syncOnce(postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device-2' }, emulatorLog));
    expect(st().products.find((p) => p.id === productId)!.price).toBe(52.9);
    await syncOnce(postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device-2' }, emulatorLog), { forcePull: true });
    expect(st().products.find((p) => p.id === productId)!.price).toBe(53.9);
  });

  it('caixa: abre, suprimento, sangria com PIN de gerente e fechamento com diferença conferido pelo banco', async () => {
    forgetPinFailures();
    login(CASHIER_PIN);
    const session = ok(st().openCashSession(100));
    ok(st().addCashSupply(20, 'Troco do banco'));
    await expectSynced('abertura e suprimento');
    login(OWNER_PIN);
    if (!st().tables.some((t) => t.number === 3)) ok(st().saveTable({ number: 3, label: 'Mesa 3', area: 'Salão', capacity: 4, active: true }));
    login(CASHIER_PIN);
    const mesa = st().tables.find((t) => t.number === 3)!;
    const order = ok(st().openTable(mesa.id, 2, null));
    const p = st().products.find((x) => x.id === productId)!;
    ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order.id));
    ok(st().startCheckout(order.id));
    const paid = st().orders.find((o) => o.id === order.id)!.remaining_balance;
    payCash(order.id);
    const wd = ok(st().addCashWithdrawal(50, { managerPin: MANAGER_PIN, reason: 'Depósito no banco' }));
    await expectSynced('venda em dinheiro e sangria');
    expect(sql(`SELECT authorized_by_manager_id IS NOT NULL FROM cash_movements WHERE id = '${wd.id}'`)).toBe('t');
    const expected = 100 + 20 + paid - 50;
    expect(sql(`SELECT tchefood_cash_expected('${session.id}', now())`)).toBe(expected.toFixed(2));
    // Sangria sem autorização, direto pelo token do aparelho: recusada.
    const forged = await raw('POST', 'cash_movements', {
      id: crypto.randomUUID(), tenant_id: TENANT, session_id: session.id, type: 'WITHDRAWAL', amount: 10, reason: 'Sangria forjada',
      performed_by_user_id: wd.performed_by_user_id, authorized_by_manager_id: wd.authorized_by_manager_id, created_at: new Date().toISOString(),
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    // Fecha com R$ 5 a menos: o banco calcula o esperado e a diferença sozinho.
    ok(st().closeCashSession(expected - 5, null, { managerPin: MANAGER_PIN, reason: 'Troco dado errado' }));
    await expectSynced('fechamento com diferença');
    expect(sql(`SELECT status || ' ' || expected_cash || ' ' || counted_cash || ' ' || difference || ' ' || (closing_authorized_by_manager_id IS NOT NULL) FROM cash_sessions WHERE id = '${session.id}'`)).toBe(
      `CLOSED ${expected.toFixed(2)} ${(expected - 5).toFixed(2)} -5.00 true`,
    );
    // Caixa fechado não muda mais.
    const closed = st().cashSessions.find((c) => c.id === session.id)!;
    const reopen = await raw('PATCH', `cash_sessions?id=eq.${session.id}`, { status: 'CLOSED', counted_cash: closed.counted_cash! + 5, closed_at: closed.closed_at, closed_by_user_id: closed.closed_by_user_id, closing_notes: closed.closing_notes });
    expect(reopen.status).toBeGreaterThanOrEqual(400);
    // Reenvio da fila depois de resposta perdida: abertura, movimento e fechamento iguais passam sem mudar nada.
    const { expected_cash: _e, difference: _d, closing_authorized_by_manager_id: _m, ...sentClose } = closed;
    expect((await raw('PATCH', `cash_sessions?id=eq.${session.id}`, sentClose)).status).toBeLessThan(300);
    expect((await raw('POST', 'cash_sessions?on_conflict=id', session, 'resolution=merge-duplicates,return=minimal')).status).toBeLessThan(300);
    expect((await raw('POST', 'cash_movements?on_conflict=id', wd, 'resolution=ignore-duplicates,return=minimal')).status).toBeLessThan(300);
    expect(sql(`SELECT status || ' ' || difference FROM cash_sessions WHERE id = '${session.id}'`)).toBe('CLOSED -5.00');
    expect(sql(`SELECT count(*) FROM cash_movements WHERE session_id = '${session.id}'`)).toBe('2');
  });

  it('entrega própria: taxa na conta, rota, entregue e acerto com o dinheiro no caixa e o ganho em sangria', async () => {
    login(OWNER_PIN);
    const zone = ok(st().saveDeliveryZone({ name: 'Centro', fee: 6, eta_minutes: 30, active: true }));
    const courier = ok(st().saveCourier({ name: 'Juca', phone: '53999990000', fee_per_delivery: 5, active: true }));
    login(CASHIER_PIN);
    ok(st().openCashSession(50));
    const line: PickupLine = { product_id: productId, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' };
    const delivery = { customerName: 'Maria', phone: '53 98888-7777', address: 'Rua XV de Novembro, 10', reference: '', zoneId: zone.id, changeFor: null };
    const onDelivery = ok(st().createPickupOrder({ lines: [line], fulfillment: 'DELIVERY', customerName: 'Maria', delivery: { ...delivery, payOnDelivery: true } }));
    const paidNow = ok(st().createPickupOrder({ lines: [line], fulfillment: 'DELIVERY', customerName: 'Maria', delivery: { ...delivery, payOnDelivery: false } }));
    payCash(paidNow.id);
    await expectSynced('pedidos de entrega');
    expect(sql(`SELECT count(*) FROM order_items i JOIN products p ON p.id = i.product_id WHERE p.code = 'TAXA-ENTREGA' AND i.order_id IN ('${onDelivery.id}', '${paidNow.id}')`)).toBe('2');
    // A taxa confere com a entrega: nenhum alerta de preço.
    expect(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'PRICE_MISMATCH' AND order_id IN ('${onDelivery.id}', '${paidNow.id}')`)).toBe('0');
    const [d1, d2] = [onDelivery.id, paidNow.id].map((id) => st().ownDeliveries.find((d) => d.order_id === id)!);
    for (const d of [d1!, d2!]) ok(st().setOwnDeliveryStatus(d.id, 'READY'));
    ok(st().dispatchOwnDeliveries([d1!.id, d2!.id], courier.id));
    for (const d of [d1!, d2!]) ok(st().setOwnDeliveryStatus(d.id, 'DELIVERED'));
    await expectSynced('rota e entregue');
    // Voltar de etapa direto pelo token do aparelho: recusado.
    const back = await raw('PATCH', `own_deliveries?id=eq.${d1!.id}`, { status: 'PREPARING' });
    expect(back.status).toBeGreaterThanOrEqual(400);
    // Entrega para um pedido que não é de entrega: recusada.
    const takeout = ok(st().createPickupOrder({ lines: [line], fulfillment: 'TAKEOUT', customerName: 'Ana' }));
    await expectSynced('senha para levar');
    const forged = await raw('POST', 'own_deliveries', { ...d1!, id: crypto.randomUUID(), order_id: takeout.id, status: 'PREPARING', courier_id: null, courier_fee: null, out_at: null, delivered_at: null });
    expect(forged.status).toBeGreaterThanOrEqual(400);

    const settlement = ok(st().settleCourier(courier.id, { payFromDrawer: true, auth: MANAGER }));
    await expectSynced('acerto com o entregador');
    expect(sql(`SELECT status FROM orders WHERE id = '${onDelivery.id}'`)).toBe('CLOSED');
    expect(sql(`SELECT count(*) FROM own_deliveries WHERE settlement_id = '${settlement.id}'`)).toBe('2');
    expect(sql(`SELECT m.type || ' ' || m.amount || ' ' || (m.authorized_by_manager_id IS NOT NULL) FROM courier_settlements s JOIN cash_movements m ON m.id = s.cash_movement_id WHERE s.id = '${settlement.id}'`)).toBe('WITHDRAWAL 10.00 true');
    expect(sql(`SELECT cash_collected FROM courier_settlements WHERE id = '${settlement.id}'`)).toBe(onDelivery.total_amount.toFixed(2));
    // Entrega acertada não muda; acerto não se altera; reenvios iguais passam.
    const settled = st().ownDeliveries.find((d) => d.id === d1!.id)!;
    expect((await raw('PATCH', `own_deliveries?id=eq.${d1!.id}`, { ...settled, courier_fee: 0 })).status).toBeGreaterThanOrEqual(400);
    expect((await raw('PATCH', `courier_settlements?id=eq.${settlement.id}`, { cash_collected: 0 })).status).toBeGreaterThanOrEqual(400);
    expect((await raw('PATCH', `own_deliveries?id=eq.${d1!.id}`, settled)).status).toBeLessThan(300);
    expect((await raw('POST', 'courier_settlements?on_conflict=id', settlement, 'resolution=ignore-duplicates,return=minimal')).status).toBeLessThan(300);
    // Acerto apontando para uma sangria de outro valor: recusado.
    const wrong = await raw('POST', 'courier_settlements', { ...settlement, id: crypto.randomUUID(), courier_fees: 99 });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
  });

  it('avaliação: só de conta paga, uma por conta, somente inserção', async () => {
    login(CASHIER_PIN);
    const line: PickupLine = { product_id: productId, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' };
    const order = ok(st().createPickupOrder({ lines: [line], fulfillment: 'TAKEOUT', customerName: 'Ana' }));
    payCash(order.id);
    const review = ok(st().addReview(order.id, 4, 'Muito bom', 'COUNTER'));
    await expectSynced('avaliação');
    expect(sql(`SELECT score || ' ' || comment FROM reviews WHERE order_id = '${order.id}'`)).toBe('4 Muito bom');
    expect((await raw('POST', 'reviews?on_conflict=id', review, 'resolution=ignore-duplicates,return=minimal')).status).toBeLessThan(300);
    expect((await raw('PATCH', `reviews?id=eq.${review.id}`, { score: 5 })).status).toBeGreaterThanOrEqual(400);
    const open = ok(st().createPickupOrder({ lines: [line], fulfillment: 'TAKEOUT', customerName: 'Bia' }));
    await expectSynced('senha aberta');
    const forged = await raw('POST', 'reviews', { ...review, id: crypto.randomUUID(), order_id: open.id });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    const second = await raw('POST', 'reviews', { ...review, id: crypto.randomUUID(), score: 1 });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('cartão de comanda: numeração separada das mesas, abre pelo número, fecha como mesa e volta livre', async () => {
    login(OWNER_PIN);
    const cards = ok(st().createCards(1, 3));
    expect(cards.map((c) => c.label)).toEqual(['Cartão 1', 'Cartão 2', 'Cartão 3']);
    await expectSynced('cartões cadastrados');
    // O cartão 1 convive com a Mesa 1; outro cartão 1 na mesma loja, não.
    expect(sql(`SELECT count(*) FROM dining_tables WHERE tenant_id = '${TENANT}' AND number = 1 AND kind IN ('TABLE', 'CARD')`)).toBe('2');
    const dup = await raw('POST', 'dining_tables', { ...cards[0]!, id: crypto.randomUUID() });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    const withQr = await raw('POST', 'dining_tables', { ...cards[0]!, id: crypto.randomUUID(), number: 99, qr_code_token: 'cartao-com-qr' });
    expect(withQr.status).toBeGreaterThanOrEqual(400);

    login(CASHIER_PIN);
    const order = ok(st().openCard(2));
    expect(ok(st().openCard(2)).id).toBe(order.id);
    const p = st().products.find((x) => x.id === productId)!;
    ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order.id));
    await expectSynced('cartão aberto e lançado');
    expect(sql(`SELECT status FROM dining_tables WHERE id = '${cards[1]!.id}'`)).toBe('OCCUPIED');
    payCash(order.id);
    await expectSynced('cartão pago');
    expect(sql(`SELECT o.status || ' ' || t.status || ' ' || (t.current_order_id IS NULL) FROM orders o JOIN dining_tables t ON t.id = o.table_id WHERE o.id = '${order.id}'`)).toBe('CLOSED FREE true');
    expect(st().tables.find((t) => t.id === cards[1]!.id)!.status).toBe('FREE');
  });

  it('segredos da loja: o token do aparelho não lê o token da Focus nem o CSC, mas lê e altera o cadastro', async () => {
    sql(`UPDATE tenants SET focus_nfe_token = 'focus-secreto', csc_id = '000001', csc_token = 'csc-secreto' WHERE id = '${TENANT}';`);
    for (const col of ['focus_nfe_token', 'csc_id', 'csc_token', '*']) {
      const r = await raw('GET', `tenants?select=${col}&id=eq.${TENANT}`, undefined);
      expect(r.status, col).toBe(403);
      expect(r.body).not.toContain('secreto');
    }
    // A leitura que o app faz (cloudPull) continua funcionando.
    const snap = await fetchCloudSnapshot({ url: 'http://cloud.test', anonKey: 'anon', accessToken: 'jwt' }, TENANT,
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device-2' }));
    expect(snap.tenant.cnpj).toBe('11222333000181');
    expect(JSON.stringify(snap.tenant)).not.toContain('secreto');
    // O aparelho atualiza o cadastro, e tentar gravar o segredo é recusado.
    expect((await raw('PATCH', `tenants?id=eq.${TENANT}`, { city: 'Pelotas' })).status).toBeLessThan(300);
    expect((await raw('PATCH', `tenants?id=eq.${TENANT}`, { focus_nfe_token: 'troca' })).status).toBe(403);
    expect(sql(`SELECT focus_nfe_token || ' ' || csc_token FROM tenants WHERE id = '${TENANT}'`)).toBe('focus-secreto csc-secreto');
    // anon não lê a tabela.
    expect(sql(`SELECT has_table_privilege('anon', 'tenants', 'SELECT')`)).toBe('f');
    // A Edge Function emit-nfce lê com a service role.
    expect(sql(`SET ROLE service_role; SELECT focus_nfe_token FROM tenants WHERE id = '${TENANT}';`)).toContain('focus-secreto');
  });

  it('autorização de desconto vale uma vez: depois de usada, não serve de novo na mesma conta', async () => {
    // Desconto 0→5 com PIN; o cancelamento do item leva o desconto a 0; item novo; o aparelho
    // manda 0→5 de novo sem autorização nova: recusado. Com o PIN de novo, vale (uma vez).
    login(OWNER_PIN);
    ok(st().saveTable({ number: 95, label: 'Mesa 95', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('mesa 95');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 95)!.id, 1, null));
    const p = st().products.find((x) => x.id === productId)!;
    const launch = () => {
      ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
      return ok(st().dispatchTray(order.id)).items;
    };
    const [first] = launch();
    ok(st().applyDiscount(order.id, 5, MANAGER));
    await expectSynced('desconto 0→5 autorizado');
    ok(st().cancelOrderItem(first!.id, MANAGER));
    await expectSynced('item cancelado');
    launch();
    await expectSynced('item novo');
    const snapshot = () => sql(`SELECT o.discount_amount || ' ' || o.total_amount || ' '
      || (SELECT count(*) FROM audit_logs a WHERE a.order_id = o.id AND a.action_type = 'DISCOUNT_APPLIED') FROM orders o WHERE o.id = '${order.id}'`);
    const before = snapshot();
    expect(before.split(' ')[0]).toBe('0.00');
    expect(before.split(' ')[2]).toBe('1');
    const reuse = await raw('PATCH', `orders?id=eq.${order.id}`, { discount_amount: 5 });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toContain('DISCOUNT_APPLIED sem PIN de gerente');
    expect(snapshot()).toBe(before);
    // Zerar o marcador da autorização usada junto não adianta.
    expect((await raw('PATCH', `orders?id=eq.${order.id}`, { discount_amount: 5, discount_auth_seq: 0 })).status).toBe(400);
    expect(snapshot()).toBe(before);
    expect(sql(`SELECT discount_auth_seq > 0 FROM orders WHERE id = '${order.id}'`)).toBe('t');
    // Autorização nova com PIN: vale, e o reenvio da fila (resposta perdida) não pede outra.
    const local = st().orders.find((o) => o.id === order.id)!;
    expect(local.discount_amount).toBe(0);
    ok(st().applyDiscount(order.id, 5, MANAGER));
    const pending = [...st().outbox];
    await expectSynced('desconto 0→5 com autorização nova');
    const after = snapshot();
    expect(after.split(' ')[0]).toBe('5.00');
    expect(after.split(' ')[2]).toBe('2');
    const cloud = st().cloud!;
    const resend = await flushOutbox(pending, { url: cloud.url, anonKey: cloud.anon_key, accessToken: cloud.access_token },
      postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }), 10_000);
    expect(resend.rejected).toEqual([]);
    expect(snapshot()).toBe(after);
    // Duas subidas na mesma transação com a mesma autorização: a segunda é recusada.
    const fresh = await raw('POST', 'rpc/tchefood_authorize_manager', {
      p_order_id: order.id, p_action_type: 'DISCOUNT_APPLIED', p_manager_pin: MANAGER_PIN, p_performed_by: st().currentUserId,
      p_reason: 'Troca do desconto', p_amount_impact: -2, p_metadata: { discount_before: 5, discount_after: 7 },
    });
    expect(fresh.status).toBe(200);
    const twice = psql(target!, `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"role":"authenticated","tenant_id":"${TENANT}","sub":"device"}', true);
      UPDATE orders SET discount_amount = 7 WHERE id = '${order.id}'; UPDATE orders SET discount_amount = 5 WHERE id = '${order.id}'; UPDATE orders SET discount_amount = 7 WHERE id = '${order.id}'; COMMIT;`, DB);
    expect(twice.ok).toBe(false);
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order.id}'`)).toBe('5.00');
    sql(`SET session_replication_role = replica; UPDATE orders SET status = 'CANCELED' WHERE id = '${order.id}'; UPDATE dining_tables SET status = 'FREE', current_order_id = NULL WHERE current_order_id = '${order.id}';`);
    useTcheStore.setState({
      orders: st().orders.filter((o) => o.id !== order.id),
      tables: st().tables.map((t) => (t.current_order_id === order.id ? { ...t, status: 'FREE' as const, current_order_id: null } : t)),
    });
  });

  it('conta criada com marcador de autorização forjado nasce com zero e o desconto com PIN vale (uma vez)', async () => {
    // Achado P2-01 do GPT (PR #41): o gatilho do marcador cobria só UPDATE. Um INSERT com o
    // maior BIGINT deixava toda autorização legítima "mais velha" e bloqueava o desconto.
    login(OWNER_PIN);
    ok(st().saveTable({ number: 82, label: 'Mesa 82', area: 'Salão', capacity: 4, active: true }));
    await expectSynced('mesa 82');
    login(CASHIER_PIN);
    const order = ok(st().openTable(st().tables.find((t) => t.number === 82)!.id, 1, null));
    // O aparelho adulterado manda a conta com o marcador no máximo, pelo PostgREST com o token dele.
    const MAX = '9223372036854775807';
    useTcheStore.setState({
      outbox: st().outbox.map((e) =>
        e.table === 'orders' && e.op === 'INSERT' && e.row_id === order.id ? { ...e, payload: { ...e.payload, discount_auth_seq: MAX } } : e,
      ),
    });
    expect(st().outbox.some((e) => e.table === 'orders' && e.op === 'INSERT' && e.payload.discount_auth_seq === MAX)).toBe(true);
    await expectSynced('conta aberta com marcador forjado');
    expect(sql(`SELECT discount_auth_seq FROM orders WHERE id = '${order.id}'`)).toBe('0');
    // Direto pelo PostgREST também: outra conta com o marcador no máximo nasce com zero.
    const otherId = crypto.randomUUID();
    const tableId = st().tables.find((t) => t.number === 82)!.id;
    const forged = await raw('POST', 'orders', {
      id: otherId, tenant_id: TENANT, table_id: tableId, opened_by_user_id: st().currentUserId, status: 'CANCELED', discount_auth_seq: MAX,
    });
    expect([201, 403]).toContain(forged.status);
    if (forged.status === 201) expect(sql(`SELECT discount_auth_seq FROM orders WHERE id = '${otherId}'`)).toBe('0');
    // Desconto 0→5 com PIN e motivo: vale, e o marcador fica com o server_seq da autorização usada.
    const p = st().products.find((x) => x.id === productId)!;
    ok(st().addToTray({ order_id: order.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }));
    ok(st().dispatchTray(order.id));
    await expectSynced('item lançado');
    ok(st().applyDiscount(order.id, 5, MANAGER));
    await expectSynced('desconto 0→5 com PIN na conta de marcador forjado');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${order.id}'`)).toBe('5.00');
    const usedSeq = sql(`SELECT max(server_seq) FROM audit_logs WHERE order_id = '${order.id}' AND action_type = 'DISCOUNT_APPLIED'`);
    expect(sql(`SELECT discount_auth_seq FROM orders WHERE id = '${order.id}'`)).toBe(usedSeq);
    // A mesma autorização não vale de novo: o desconto volta a 0 e o aumento é recusado. Com o
    // cashback no servidor (PR #46), o aparelho não reduz o desconto sem autorização (seria uma
    // atualização antiga da fila); o 0 vem pelo banco, como no cancelamento dos itens.
    sql(`UPDATE orders SET discount_amount = 0 WHERE id = '${order.id}'`);
    const reuse = await raw('PATCH', `orders?id=eq.${order.id}`, { discount_amount: 5 });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toContain('DISCOUNT_APPLIED sem PIN de gerente');
    expect(sql(`SELECT discount_amount || ' ' || discount_auth_seq FROM orders WHERE id = '${order.id}'`)).toBe(`0.00 ${usedSeq}`);
    sql(`SET session_replication_role = replica; UPDATE orders SET status = 'CANCELED' WHERE id = '${order.id}'; UPDATE dining_tables SET status = 'FREE', current_order_id = NULL WHERE current_order_id = '${order.id}';`);
    useTcheStore.setState({
      orders: st().orders.filter((o) => o.id !== order.id),
      tables: st().tables.map((t) => (t.current_order_id === order.id ? { ...t, status: 'FREE' as const, current_order_id: null } : t)),
    });
  });

  it('as migrations rodam de novo sem erro (supabase db push numa base que já tem tudo)', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) psqlFile(target!, join(dir, f), DB);
    expect(sql(`SELECT count(*) FROM staff_users WHERE tenant_id = '${TENANT}'`)).not.toBe('0');
  });
});
