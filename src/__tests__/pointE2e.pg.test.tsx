// @vitest-environment jsdom
/**
 * Point Smart ponta a ponta no banco real, do cadastro à conta fechada:
 *  - cadastro pela tela (aba Point Smart): a maquininha sobe para pos_terminals e a conferência no Mercado Pago
 *    (ação "terminals") mostra "Pronta";
 *  - cobrança pelo caixa da mesa (CheckoutScreen) com o driver de verdade (MercadoPagoPointDriver): a conta sobe
 *    antes (ensureOrderSynced), o servidor grava a cobrança (a reserva da Point) e outro aparelho não recebe por
 *    cima (TF003); aprovada pelo Mercado Pago, o pagamento sobe e a conta fecha zerada no servidor;
 *  - cartão recusado: nada pago, a reserva sai e o dinheiro fecha a conta;
 *  - "Cancelar cobrança" com o PIN do gerente: o servidor confere o PIN, cancela no Mercado Pago, nada pago;
 *  - revisão manual: o Mercado Pago não confirma; a reserva fica; o gerente confere no Mercado Pago (PIN + motivo),
 *    o servidor lê a aprovação e o pagamento entra uma vez só.
 *
 * O aparelho fala com o emulador do PostgREST (db/tests/postgrestEmulator) e com a Edge Function point-charge
 * emulada aqui com o código de verdade (charge.ts + repository.ts sobre a service role, db/tests/serviceDb). Só o
 * Mercado Pago é falso (estado de cada ordem controlado pelo teste).
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentTerminalChargeResult, PaymentTerminalProvider, PaymentTerminalTransactionStatus } from '../../server/shared/paymentTerminal';
import { ChargeInputError, cancelCharge, pollCharge, reconcileCharge, startCharge, validateCancel, validateReconcile, voidCharge, type ChargeContext, type PointPaymentDetails } from '../../supabase/functions/point-charge/charge';
import { supabaseChargeStore } from '../../supabase/functions/point-charge/repository';
import { listStoreTerminals } from '../../supabase/functions/point-charge/terminals';
import { createSupabaseLikeDb, pgTargetFromEnv, postgrestFetch, psql, psqlFile, type PgTarget } from '../../db/tests/postgrestEmulator';
import { serviceDb } from '../../db/tests/serviceDb';

const createDriver = vi.fn();
vi.mock('../lib/payments/drivers', async (orig) => {
  const real = await orig<typeof import('../lib/payments/drivers')>();
  return { ...real, createDriver: (...a: unknown[]) => createDriver(...a) };
});

const { useTcheStore } = await import('../store/useTcheStore');
const { CheckoutScreen } = await import('../screens/CheckoutScreen');
const { PointAdmin } = await import('../screens/admin/PointAdmin');
const { syncOnce, ensureOrderSynced, freshCloudConfig } = await import('../lib/sync/useCloudSync');
const { claimPayment } = await import('../lib/payments/paymentClaim');
const { MercadoPagoPointDriver } = await import('../lib/payments/mercadoPagoPointDriver');
const ledger = await import('../lib/payments/claimLedger');
const { getReviewHold } = await import('../lib/payments/reviewHolds');
const { useToast } = await import('../components/ui');

const toastLog: string[] = [];
useToast.subscribe((s: { toasts: Array<{ id: unknown; kind: string; text: string }> }, prev: { toasts: Array<{ id: unknown }> }) => {
  for (const t of s.toasts) if (!prev.toasts.some((p) => p.id === t.id)) toastLog.push(`${t.kind}: ${t.text}`);
});

const target = pgTargetFromEnv();
const DB = `tchefood_point_e2e_${process.pid}`;
const ROOT = join(__dirname, '..', '..');
const TENANT = '18181818-1818-4818-8818-181818181818';
const MP_ID = 'NEWLAND_N950__N950NCB801293324';
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

// ---------------------------------------------------------------- Mercado Pago falso

interface MpOrder { id: string; key: string; amountCents: number; method: 'credit' | 'debit'; status: PaymentTerminalTransactionStatus; paymentId: string | null }
const mp = {
  orders: [] as MpOrder[],
  /** Estado com que a próxima ordem nasce. */
  onCreate: 'at_terminal' as PaymentTerminalTransactionStatus,
  terminals: [{ id: MP_ID, mode: 'pdv' as const }],
  calls: [] as string[],
};
const orderByKey = (key: string) => mp.orders.find((o) => o.key === key)!;
function setOrder(key: string, status: PaymentTerminalTransactionStatus) {
  const o = orderByKey(key);
  o.status = status;
  if (status === 'approved') o.paymentId = String(900000 + mp.orders.indexOf(o));
}
function mpResult(o: MpOrder): PaymentTerminalChargeResult {
  const paid = o.status === 'approved';
  return {
    provider: 'mercado_pago_point', externalOrderId: o.id, externalPaymentId: paid ? o.paymentId : null, externalTransactionId: paid ? `PAY-${o.id}` : null,
    externalReference: o.key, externalTerminalId: MP_ID, status: o.status, rawStatus: o.status === 'approved' ? 'processed' : o.status, rawStatusDetail: paid ? 'accredited' : null,
    amountCents: o.amountCents, paidAmountCents: paid ? o.amountCents : null, paymentMethodId: paid ? 'master' : null,
    paymentMethodType: paid ? (o.method === 'credit' ? 'credit_card' : 'debit_card') : null, installments: paid ? 1 : null,
  };
}
const provider: PaymentTerminalProvider = {
  key: 'mercado_pago_point', createRetryPolicy: 'same_key', approvalIdentity: 'reference_and_terminal', supportedMethods: ['credit', 'debit', 'pix'],
  listTerminals: async () => mp.terminals.map((t) => ({ provider: 'mercado_pago_point', externalTerminalId: t.id, operatingMode: t.mode, externalStoreId: null, externalPosId: null })),
  createCharge: async (req) => {
    mp.calls.push(`create:${req.externalReference}`);
    let o = mp.orders.find((x) => x.key === req.externalReference);
    if (!o) {
      o = { id: `ORD${String(mp.orders.length + 1).padStart(8, '0')}`, key: req.externalReference, amountCents: req.amountCents, method: req.method === 'debit' ? 'debit' : 'credit', status: mp.onCreate, paymentId: null };
      mp.orders.push(o);
    }
    return mpResult(o);
  },
  getCharge: async (id) => mpResult(mp.orders.find((o) => o.id === id)!),
  cancelCharge: async (id) => {
    mp.calls.push(`cancel:${id}`);
    const o = mp.orders.find((x) => x.id === id)!;
    if (o.status === 'pending' || o.status === 'at_terminal') o.status = 'cancelled';
    return { outcome: 'cancelled', charge: mpResult(o) };
  },
  findChargeByReference: async (ref) => {
    const o = mp.orders.find((x) => x.key === ref);
    return o ? mpResult(o) : null;
  },
};
const payments = {
  getPayment: async (id: string): Promise<PointPaymentDetails> => {
    const o = mp.orders.find((x) => x.paymentId === id)!;
    return {
      id, status: 'approved', amountCents: o.amountCents, paymentMethodId: 'master', paymentTypeId: o.method === 'credit' ? 'credit_card' : 'debit_card',
      authorizationCode: `AUT${id.slice(-4)}`, lastFour: '4242', installments: 1, externalReference: o.key, orderId: o.id,
    };
  },
};

// ---------------------------------------------------------------- Edge Function point-charge emulada

/** O despacho de supabase/functions/point-charge/index.ts, com a loja já provada (a do JWT do aparelho). */
async function pointChargeFunction(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const ctx: ChargeContext = { store: supabaseChargeStore(serviceDb(target!, DB), TENANT), provider, payments };
  const terminalRow = (id: unknown) => {
    const out = sql(`SELECT coalesce((SELECT to_jsonb(t) FROM (SELECT id, tenant_id, serial_number, acquirer FROM pos_terminals WHERE id::text = ${`'${String(id).replace(/'/g, "''")}'`} AND tenant_id = '${TENANT}') t)::text, 'null')`);
    return JSON.parse(out) as { id: string; tenant_id: string; serial_number: string; acquirer: string } | null;
  };
  try {
    switch (body.action) {
      case 'terminals':
        return { status: 200, body: await listStoreTerminals(provider) };
      case 'create': {
        const t = terminalRow(body.terminal_id);
        if (!t) return { status: 404, body: { error: 'not_found', message: 'Maquininha não encontrada nesta loja.' } };
        return { status: 200, body: await startCharge(ctx, t, body as never) };
      }
      case 'status': {
        const row = await ctx.store.findByKey(String(body.idempotency_key));
        if (!row) return { status: 404, body: { error: 'not_found', message: 'Cobrança não encontrada nesta loja.' } };
        return { status: 200, body: await pollCharge(ctx, row) };
      }
      case 'cancel': {
        validateCancel(body as never);
        const row = await ctx.store.findByKey(String(body.idempotency_key));
        if (row) return { status: 200, body: await cancelCharge(ctx, row, body as never) };
        const t = terminalRow(body.terminal_id);
        if (!t) return { status: 404, body: { error: 'not_found', message: 'Maquininha não encontrada nesta loja.' } };
        return { status: 200, body: await voidCharge(ctx, t, body as never) };
      }
      case 'reconcile': {
        validateReconcile(body as never);
        const row = await ctx.store.findByKey(String(body.idempotency_key));
        if (!row) return { status: 404, body: { error: 'not_found', message: 'Cobrança não encontrada nesta loja.' } };
        return { status: 200, body: await reconcileCharge(ctx, body as never) };
      }
      default:
        return { status: 400, body: { error: 'action', message: 'Ação inválida.' } };
    }
  } catch (error) {
    if (error instanceof ChargeInputError) return { status: error.httpStatus, body: { error: error.code, message: error.message } };
    throw error;
  }
}

// ---------------------------------------------------------------- rede

const net = { calls: [] as string[] };
function installFetch() {
  const rest = postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' });
  vi.stubGlobal('fetch', async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
    const path = new URL(url).pathname;
    if (path === '/functions/v1/point-charge') {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      net.calls.push(`point-charge:${String(body.action)}`);
      const out = await pointChargeFunction(body);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
    }
    net.calls.push(path.replace(/^\/rest\/v1\/(rpc\/)?/, ''));
    return rest(url, { ...init, headers: init.headers ?? {} } as never);
  });
}

/** O driver de verdade, com a mesma ligação do createDriver do app; só a espera entre consultas é curta. */
function realPointDriver(params: { terminal: import('../types').PosTerminal | null; mode: import('../types').OperationMode }) {
  return new MercadoPagoPointDriver(params.mode, params.terminal, {
    config: () => freshCloudConfig(),
    fetch: (u, init) => fetch(u, init),
    sleep: () => new Promise((r) => setTimeout(r, 25)),
    now: () => performance.now(),
    timer: (ms) => new Promise((r) => setTimeout(r, ms)),
    operator: async () => st().currentUserId,
    prepareOrder: (orderId) => ensureOrderSynced(orderId),
  });
}

// ---------------------------------------------------------------- helpers

function login(pin: string) {
  const r = st().login(pin);
  if (!r.ok) throw new Error(r.error);
}
function ok<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function expectSynced(step: string) {
  for (let i = 0; i < 4 && st().outbox.length > 0; i += 1) await syncOnce(undefined, { forcePull: false });
  expect((st().syncRejected ?? []).map((r) => `${r.event.table}/${r.event.op}: ${r.message}`), step).toEqual([]);
  expect(st().outbox.map((e) => `${e.table}/${e.op}`), step).toEqual([]);
}

let productId = '';
let productPrice = 0;

function openTableWith(n: number): string {
  login(CASHIER_PIN);
  const mesa = st().tables.find((t) => t.number === n)!;
  const order = ok(st().openTable(mesa.id, 1, null));
  ok(st().addToTray({ order_id: order.id, product_id: productId, half_product_ids: [], quantity: 1, unit_price: productPrice, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: 'KITCHEN' }));
  ok(st().dispatchTray(order.id));
  ok(st().startCheckout(order.id));
  return order.id;
}

const chargeButton = () => screen.getByRole('button', { name: /^(Enviar para maquininha|Receber) R\$/ });
async function renderCheckout(orderId: string) {
  render(<CheckoutScreen orderId={orderId} onBack={() => undefined} onClosed={() => undefined} />);
  await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
}
async function chargeOnPoint() {
  fireEvent.click(screen.getByRole('button', { name: /TEF POS Sem Fio/ }));
  fireEvent.click(screen.getByRole('button', { name: /Point Caixa/ }));
  fireEvent.click(screen.getByRole('button', { name: /Crédito/ }));
  await act(async () => { fireEvent.click(chargeButton()); });
}

interface ServerCharge { key: string; status: string; amount_cents: number; cancel_authorized_by: string | null }
const serverCharges = (orderId: string): ServerCharge[] =>
  JSON.parse(sql(`SELECT coalesce(json_agg(json_build_object('key', idempotency_key, 'status', status, 'amount_cents', amount_cents, 'cancel_authorized_by', cancel_authorized_by) ORDER BY created_at), '[]') FROM terminal_charges WHERE order_id = '${orderId}'`));
const serverPayments = (orderId: string): Array<{ key: string; status: string; acquirer: string; amount: number }> =>
  JSON.parse(sql(`SELECT coalesce(json_agg(json_build_object('key', idempotency_key, 'status', status, 'acquirer', acquirer, 'amount', amount) ORDER BY created_at), '[]') FROM payments WHERE order_id = '${orderId}'`));
const serverOrder = (orderId: string) => sql(`SELECT status || ' ' || remaining_balance FROM orders WHERE id = '${orderId}'`);
const localApproved = (orderId: string) => st().payments.filter((p) => p.order_id === orderId && p.status === 'APPROVED');

/** Outro aparelho tenta receber o saldo todo em dinheiro: a reserva da Point no servidor recusa (TF003). */
async function otherDeviceCashIsRefused(orderId: string) {
  const total = st().orders.find((o) => o.id === orderId)!.remaining_balance;
  const other = await claimPayment({ orderId, key: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', amount: total, releaseToken: ledger.generateReleaseToken() });
  expect(other).toMatchObject({ ok: false, code: 'TF003' });
}

// ---------------------------------------------------------------- testes

(target ? describe : describe.skip)('Point Smart ponta a ponta no banco real', () => {
  beforeAll(async () => {
    applySchema(target!, DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja Point', 'Loja Point Ltda', '11222333000181');`);
    installFetch();
    try { localStorage.clear(); } catch { /* sem armazenamento */ }
    ledger.resetClaimLedger();
    st().resetDemo();
    useTcheStore.setState({ orders: st().orders.map((o) => (o.status === 'OPEN' || o.status === 'PAYING' ? { ...o, status: 'CLOSED' as const } : o)) });
    login('8888');
    ok(st().startNewStore(
      {
        tenant: { name: 'Bar Point', legal_name: 'Point Comércio Ltda', cnpj: '11.222.333/0001-81', state_registration: null, city: 'Santo Ângelo', state: 'RS', default_service_fee_pct: 0 },
        owner_name: 'Dona',
        owner_pin: OWNER_PIN,
        cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: TENANT },
      },
      { managerPin: '8888', reason: 'Sair da demonstração' },
    ));
    await expectSynced('loja nova');
    login(OWNER_PIN);
    ok(st().saveStaff({ name: 'Gerente Ana', role: 'MANAGER', pin_code: MANAGER_PIN, active: true }));
    ok(st().saveStaff({ name: 'Caixa Bia', role: 'CASHIER', pin_code: CASHIER_PIN, active: true }));
    const cat = ok(st().saveCategory({ name: 'Lanches', sort_order: 1, icon_name: null, active: true }));
    const p = ok(st().saveProduct({
      category_id: cat.id, code: '101', name: 'Xis', description: null, price: 32.5, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '16025000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    productId = p.id;
    productPrice = p.price;
    for (let n = 1; n <= 4; n++) ok(st().saveTable({ number: n, label: `Mesa ${n}`, area: 'Salão', capacity: 4, active: true }));
    await expectSynced('equipe, cardápio e mesas');
    createDriver.mockImplementation((params: { terminal: import('../types').PosTerminal | null; mode: import('../types').OperationMode }) => {
      if (params.terminal?.acquirer !== 'MERCADO_PAGO') throw new Error('o teste só cobra na Point');
      return realPointDriver(params);
    });
  }, 120_000);

  afterAll(() => {
    psql({ ...target!, db: 'postgres' }, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
  });
  beforeEach(() => {
    net.calls.length = 0;
    mp.calls.length = 0;
    mp.onCreate = 'at_terminal';
    toastLog.length = 0;
  });
  afterEach(() => cleanup());

  it('cadastro pela tela: a Point sobe para a nuvem e a conferência no Mercado Pago mostra "Pronta"', async () => {
    login(OWNER_PIN);
    mp.terminals = [{ id: MP_ID, mode: 'standalone' as never }];
    render(<PointAdmin />);
    fireEvent.change(screen.getByPlaceholderText(/NEWLAND/), { target: { value: MP_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar Point' }));
    await expectSynced('cadastro da Point');
    expect(sql(`SELECT name || '|' || serial_number || '|' || acquirer || '|' || online FROM pos_terminals WHERE serial_number = '${MP_ID}' AND tenant_id = '${TENANT}'`)).toBe(`Point Caixa|${MP_ID}|MERCADO_PAGO|true`);
    const row = () => screen.getByTestId(`point-${MP_ID}`);
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByText('Fora do modo PDV')).toBeTruthy());
    mp.terminals = [{ id: MP_ID, mode: 'pdv' }];
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByText('Pronta')).toBeTruthy());
    expect(net.calls.filter((c) => c === 'point-charge:terminals')).toHaveLength(2);
    // Desativar e reativar no caixa sobe como UPDATE da mesma linha.
    const toggle = () => within(row()).getByRole('switch', { name: /Ativa no caixa/ });
    fireEvent.click(toggle());
    await expectSynced('Point desativada');
    expect(sql(`SELECT online FROM pos_terminals WHERE serial_number = '${MP_ID}'`)).toBe('f');
    fireEvent.click(toggle());
    await expectSynced('Point reativada');
    expect(sql(`SELECT count(*) || '|' || bool_and(online) FROM pos_terminals WHERE serial_number = '${MP_ID}'`)).toBe('1|true');
  }, 60_000);

  it('aprovada: reserva no servidor (outro aparelho não recebe por cima), Mercado Pago aprova, o pagamento sobe e a conta fecha zerada', async () => {
    const id = openTableWith(1);
    await renderCheckout(id);
    await chargeOnPoint();
    await waitFor(() => expect(serverCharges(id).map((c) => c.status)).toEqual(['at_terminal']), { timeout: 10_000 });
    const [charge] = serverCharges(id);
    expect(charge!.amount_cents).toBe(Math.round(productPrice * 100));
    // A conta subiu antes de cobrar (ensureOrderSynced) e a cobrança é a reserva da conta no servidor.
    expect(net.calls.indexOf('point-charge:create')).toBeGreaterThan(-1);
    await otherDeviceCashIsRefused(id);
    expect(screen.getByRole('button', { name: 'Cancelar cobrança' })).toBeTruthy();
    setOrder(charge!.key, 'approved');
    await waitFor(() => expect(localApproved(id), toastLog.join(' | ')).toHaveLength(1), { timeout: 10_000 });
    expect(localApproved(id)[0]).toMatchObject({ acquirer: 'MERCADO_PAGO', method: 'CREDIT', idempotency_key: charge!.key, terminal_serial: MP_ID, card_brand: 'MASTERCARD' });
    await expectSynced('pagamento da Point');
    expect(serverCharges(id).map((c) => c.status)).toEqual(['approved']);
    expect(serverPayments(id)).toEqual([{ key: charge!.key, status: 'APPROVED', acquirer: 'MERCADO_PAGO', amount: productPrice }]);
    expect(serverOrder(id)).toBe('CLOSED 0.00');
    expect(st().orders.find((o) => o.id === id)!.status).toBe('CLOSED');
    expect(mp.calls.filter((c) => c.startsWith('create:'))).toEqual([`create:${charge!.key}`]);
  }, 60_000);

  it('cartão recusado: nada pago, a reserva da Point sai e o dinheiro fecha a conta', async () => {
    const id = openTableWith(2);
    await renderCheckout(id);
    await chargeOnPoint();
    await waitFor(() => expect(serverCharges(id).map((c) => c.status)).toEqual(['at_terminal']), { timeout: 10_000 });
    setOrder(serverCharges(id)[0]!.key, 'rejected');
    await waitFor(() => expect(serverCharges(id).map((c) => c.status)).toEqual(['rejected']), { timeout: 10_000 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancelar cobrança' })).toBeNull());
    expect(localApproved(id)).toEqual([]);
    expect(getReviewHold(id)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(localApproved(id), toastLog.join(' | ')).toHaveLength(1), { timeout: 10_000 });
    await expectSynced('dinheiro depois da recusa');
    expect(serverPayments(id).filter((p) => p.status === 'APPROVED').map((p) => p.acquirer)).toEqual(['CASH_DESK']);
    expect(serverOrder(id)).toBe('CLOSED 0.00');
  }, 60_000);

  it('"Cancelar cobrança" com o PIN do gerente: o servidor confere o PIN e cancela no Mercado Pago; nada pago', async () => {
    const id = openTableWith(3);
    await renderCheckout(id);
    await chargeOnPoint();
    await waitFor(() => expect(serverCharges(id).map((c) => c.status)).toEqual(['at_terminal']), { timeout: 10_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar cobrança' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Descreva o motivo…'), { target: { value: 'Cliente desistiu' } });
    for (const d of MANAGER_PIN) fireEvent.click(within(dialog).getByRole('button', { name: d }));
    await waitFor(() => expect(serverCharges(id).map((c) => c.status)).toEqual(['cancelled']), { timeout: 10_000 });
    const manager = sql(`SELECT id FROM staff_users WHERE tenant_id = '${TENANT}' AND pin_code = '${MANAGER_PIN}'`);
    expect(serverCharges(id)[0]!.cancel_authorized_by).toBe(manager);
    expect(mp.calls.some((c) => c.startsWith('cancel:'))).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancelar cobrança' })).toBeNull());
    expect(localApproved(id)).toEqual([]);
    expect(serverPayments(id).filter((p) => p.status === 'APPROVED')).toEqual([]);
    expect(serverOrder(id)).not.toMatch(/^CLOSED/);
  }, 60_000);

  it('revisão manual: o Mercado Pago não confirma, a reserva fica; o gerente confere no Mercado Pago e o pagamento entra uma vez só', async () => {
    mp.onCreate = 'manual_review';
    const id = openTableWith(4);
    await renderCheckout(id);
    await chargeOnPoint();
    await waitFor(() => expect(serverCharges(id).map((c) => c.status)).toEqual(['manual_review']), { timeout: 10_000 });
    await waitFor(() => expect(getReviewHold(id)).toMatchObject({ acquirer: 'MERCADO_PAGO' }), { timeout: 10_000 });
    const key = serverCharges(id)[0]!.key;
    expect(getReviewHold(id)!.idempotency_key).toBe(key);
    expect(localApproved(id)).toEqual([]);
    // A cobrança em revisão segura o saldo no servidor: outro aparelho não recebe por cima.
    await otherDeviceCashIsRefused(id);
    // O cliente mostra a Point aprovada; no Mercado Pago a ordem está paga.
    setOrder(key, 'approved');
    login(MANAGER_PIN);
    fireEvent.click(await screen.findByRole('button', { name: 'Conferir no Mercado Pago' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Motivo'), { target: { value: 'Cliente mostrou a Point aprovada' } });
    for (const d of MANAGER_PIN) fireEvent.click(within(dialog).getByRole('button', { name: d }));
    await waitFor(() => expect(localApproved(id), toastLog.join(' | ')).toHaveLength(1), { timeout: 10_000 });
    expect(localApproved(id)[0]).toMatchObject({ acquirer: 'MERCADO_PAGO', idempotency_key: key });
    expect(getReviewHold(id)).toBeNull();
    await expectSynced('pagamento conferido');
    expect(serverCharges(id).map((c) => c.status)).toEqual(['approved']);
    expect(serverPayments(id).filter((p) => p.status === 'APPROVED').map((p) => p.key)).toEqual([key]);
    expect(serverOrder(id)).toBe('CLOSED 0.00');
    expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND metadata->>'idempotency_key' = '${key}'`))).toBeGreaterThan(0);
  }, 60_000);
});
