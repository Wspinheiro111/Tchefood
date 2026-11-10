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
import { useTcheStore, type PickupLine } from '../../src/store/useTcheStore';
import { flushOutbox, sanitizePayload, type SyncRejection } from '../../src/lib/sync/supabaseSync';
import { fetchCloudSnapshot, fetchCloudStaff, fetchStaffPins } from '../../src/lib/sync/cloudPull';
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

  it('as migrations rodam de novo sem erro (supabase db push numa base que já tem tudo)', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) psqlFile(target!, join(dir, f), DB);
    expect(sql(`SELECT count(*) FROM staff_users WHERE tenant_id = '${TENANT}'`)).not.toBe('0');
  });
});
