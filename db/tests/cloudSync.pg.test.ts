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
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTcheStore, type PickupLine } from '../../src/store/useTcheStore';
import { flushOutbox, type SyncRejection } from '../../src/lib/sync/supabaseSync';
import { sampleNfeXml } from '../../src/data/sampleNfe';
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

afterEach(() => vi.useRealTimers());

/** Requisição direta ao "PostgREST", como faria quem tem só o token do aparelho. */
async function raw(method: 'POST' | 'PATCH', path: string, body: unknown, prefer = 'return=minimal') {
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
    ok(st().removeServiceFee(order.id, MANAGER));
    ok(st().restoreServiceFee(order.id));
    await expectSynced('cancelamento, desconto e 10%');
    payCash(order.id);
    await expectSynced('pagamento');
    const local = st().orders.find((o) => o.id === order.id)!;
    expect(local.status).toBe('CLOSED');
    expect(sql(`SELECT status || ' ' || total_amount || ' ' || remaining_balance FROM orders WHERE id = '${order.id}'`)).toBe(`CLOSED ${local.total_amount.toFixed(2)} 0.00`);
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
    login(CASHIER_PIN);
    const second = ok(st().openTable(mesa.id, 1, null));
    launch(second.id, 1);
    const redeemed = ok(st().redeemCashback(second.id, '55999887766'));
    expect(redeemed.amount).toBeGreaterThan(0);
    await expectSynced('cashback resgatado');
    payCash(second.id);
    await expectSynced('conta com cashback paga');
    expect(sql(`SELECT discount_amount FROM orders WHERE id = '${second.id}'`)).toBe(redeemed.amount.toFixed(2));
    expect(sql(`SELECT status FROM orders WHERE id = '${second.id}'`)).toBe('CLOSED');
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
    expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND (metadata::text LIKE '%${CASHIER_PIN}%' OR metadata::text LIKE '%${MANAGER_PIN}%')`)).toBe('0');
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
  });

  it('as migrations rodam de novo sem erro (supabase db push numa base que já tem tudo)', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) psqlFile(target!, join(dir, f), DB);
    expect(sql(`SELECT count(*) FROM staff_users WHERE tenant_id = '${TENANT}'`)).not.toBe('0');
  });
});
