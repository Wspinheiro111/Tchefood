// @vitest-environment jsdom
/**
 * Ponta a ponta no banco real: caixa da mesa (CheckoutScreen), ficha rápida (FichaRapidaScreen), retirada
 * (chargePickupOrder), entrega própria (acerto do entregador) e sincronização (flushOutbox pelo laço,
 * ensureOrderSynced, claimSupervisor), numa loja ligada à nuvem, com a regra de que todo pagamento é
 * reservado no servidor antes (startPaymentClaim → tchefood_claim_payment).
 *
 * Todo fetch do app (reserva, batimento, liberação, leitura da reserva da Point, fila) passa pelo emulador do
 * PostgREST sobre o Postgres com db/schema.sql + supabase/migrations. Só a maquininha (createDriver) é falsa.
 * A rede pode cair: antes de chegar (`block`) ou depois de o servidor gravar (`lose`, resposta perdida).
 *
 * Em todo cenário confere, no servidor e no aparelho:
 *  - nenhum pagamento aprovado sem a reserva consumida com a mesma chave (fora o dinheiro do entregador);
 *  - nenhuma chave registrada duas vezes;
 *  - toda reserva termina liberada ou consumida;
 *  - a conta fecha no servidor com saldo zero;
 *  - o registro local de reservas fica vazio só depois de o servidor confirmar (o segredo não se perde antes).
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPaymentTerminalDriver, TerminalResult } from '../lib/payments/drivers';
import { createSupabaseLikeDb, pgTargetFromEnv, postgrestFetch, psql, psqlFile, type EmulatorLog, type PgTarget } from '../../db/tests/postgrestEmulator';

const createDriver = vi.fn();
vi.mock('../lib/payments/drivers', async (orig) => {
  const real = await orig<typeof import('../lib/payments/drivers')>();
  return { ...real, createDriver: (...a: unknown[]) => createDriver(...a) };
});

const { useTcheStore } = await import('../store/useTcheStore');
const { CheckoutScreen } = await import('../screens/CheckoutScreen');
const { FichaRapidaScreen } = await import('../screens/FichaRapidaScreen');
const { chargePickupOrder } = await import('../lib/pickupCharge');
const { syncOnce } = await import('../lib/sync/useCloudSync');
const { startPaymentClaim } = await import('../lib/payments/claimFlow');
const { claimPayment, retryPendingClaimReleases } = await import('../lib/payments/paymentClaim');
const { superviseSettledClaims, resetClaimSupervisor } = await import('../lib/payments/claimSupervisor');
const ledger = await import('../lib/payments/claimLedger');
const { clearReviewHold, getReviewHold } = await import('../lib/payments/reviewHolds');
const { useToast } = await import('../components/ui');
/** Mensagens de toast desde o começo do teste (o que o operador viu). */
const toastLog: string[] = [];
useToast.subscribe((s: { toasts: Array<{ id: unknown; kind: string; text: string }> }, prev: { toasts: Array<{ id: unknown }> }) => {
  for (const t of s.toasts) if (!prev.toasts.some((p) => p.id === t.id)) toastLog.push(`${t.kind}: ${t.text}`);
});
const toasts = () => toastLog;

const target = pgTargetFromEnv();
// Um banco por processo: outra execução da suíte ao mesmo tempo (npm test com TCHEFOOD_PG) não apaga este no meio.
const DB = `tchefood_e2e_flows_${process.pid}`;
const ROOT = join(__dirname, '..', '..');
const TENANT = '17171717-1717-4717-8717-171717171717';
const st = () => useTcheStore.getState();

const OWNER_PIN = '4826';
const MANAGER_PIN = '7391';
const CASHIER_PIN = '5162';
const MANAGER = { managerPin: MANAGER_PIN, reason: 'Teste ponta a ponta' };

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

// ---------------------------------------------------------------- rede

const emulatorLog: EmulatorLog[] = [];
const net = {
  down: false,
  /** RPCs/tabelas cuja próxima resposta se perde DEPOIS de o servidor gravar. */
  lose: [] as string[],
  /** RPCs/tabelas cujo próximo pedido não chega ao servidor. */
  block: [] as string[],
  calls: [] as string[],
};

function installFetch() {
  const base = postgrestFetch(target!, DB, { role: 'authenticated', tenant_id: TENANT, sub: 'device' }, emulatorLog);
  const fake = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
    const path = new URL(url).pathname.replace(/^\/rest\/v1\//, '');
    const name = path.replace(/^rpc\//, '');
    net.calls.push(name);
    if (net.down) throw new TypeError('Failed to fetch');
    const b = net.block.indexOf(name);
    if (b >= 0) {
      net.block.splice(b, 1);
      throw new TypeError('Failed to fetch');
    }
    const l = net.lose.indexOf(name);
    const res = await base(url, { ...init, headers: init.headers ?? {} } as never);
    if (l >= 0) {
      net.lose.splice(l, 1);
      throw new TypeError('network connection lost');
    }
    return res;
  };
  vi.stubGlobal('fetch', fake);
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

/** Uma volta do laço de sincronização (a mesma função do app), com o fetch global. */
async function syncRound() {
  await syncOnce(undefined, { forcePull: false });
}
async function expectSynced(step: string) {
  for (let i = 0; i < 4 && st().outbox.length > 0; i += 1) await syncRound();
  const rej = (st().syncRejected ?? []).map((r) => `${r.event.table}/${r.event.op}: ${r.message}`);
  expect(rej, step).toEqual([]);
  expect(st().outbox.map((e) => `${e.table}/${e.op}`), step).toEqual([]);
}
/** Laço do supervisor e das liberações pendentes, até nada mudar. */
async function settleLoops(now = Date.now()) {
  resetClaimSupervisor();
  for (let i = 0; i < 3; i += 1) {
    await retryPendingClaimReleases(undefined, now, true);
    await superviseSettledClaims(undefined, now, true);
  }
}

let productId = '';
let productPrice = 0;

interface ServerPayment { id: string; key: string; status: string; amount: string; method: string; acquirer: string }
function serverPayments(orderId: string): ServerPayment[] {
  const out = sql(`SELECT coalesce(json_agg(json_build_object('id', id, 'key', idempotency_key, 'status', status, 'amount', amount, 'method', method, 'acquirer', acquirer) ORDER BY created_at), '[]') FROM payments WHERE order_id = '${orderId}'`);
  return JSON.parse(out) as ServerPayment[];
}
function serverClaims(orderId: string): Array<{ key: string; status: string; amount_cents: number; consumed_payment_id: string | null }> {
  const out = sql(`SELECT coalesce(json_agg(json_build_object('key', idempotency_key, 'status', status, 'amount_cents', amount_cents, 'consumed_payment_id', consumed_payment_id) ORDER BY created_at), '[]') FROM payment_claims WHERE order_id = '${orderId}'`);
  return JSON.parse(out);
}
const serverOrder = (orderId: string) => sql(`SELECT status || ' ' || remaining_balance FROM orders WHERE id = '${orderId}'`);

/**
 * As invariantes de todo cenário. `courierKeys`: chaves do dinheiro do entregador (única exceção sem reserva).
 */
function expectInvariants(orderId: string, opts: { closed?: boolean } = {}) {
  const pays = serverPayments(orderId);
  const claims = serverClaims(orderId);
  const approved = pays.filter((p) => p.status === 'APPROVED');
  // Nenhuma chave aprovada duas vezes.
  const keys = approved.map((p) => p.key);
  expect(new Set(keys).size, `chaves repetidas em ${orderId}`).toBe(keys.length);
  // Todo aprovado com a reserva consumida pela mesma chave (exceto entrega-<id>).
  for (const p of approved) {
    if (p.key.startsWith('entrega-')) continue;
    const c = claims.find((x) => x.key === p.key);
    expect(c, `pagamento ${p.key} sem reserva`).toBeDefined();
    expect(c!.status, `reserva de ${p.key}`).toBe('consumed');
    expect(c!.consumed_payment_id).toBe(p.id);
    expect(c!.amount_cents).toBe(Math.round(Number(p.amount) * 100));
  }
  // Nenhuma reserva aberta sobrando.
  expect(claims.filter((c) => c.status === 'open').map((c) => c.key), 'reservas abertas').toEqual([]);
  // O aparelho: nada pendente desta conta.
  expect(ledger.inFlightClaims().filter((c) => c.order_id === orderId).map((c) => `${c.key}:${c.state}`), 'registro local').toEqual([]);
  expect(ledger.pendingReleases().filter((c) => c.order_id === orderId).map((c) => c.key), 'liberações pendentes').toEqual([]);
  // Local e servidor com os mesmos pagamentos aprovados.
  const local = st().payments.filter((p) => p.order_id === orderId && p.status === 'APPROVED').map((p) => p.idempotency_key).sort();
  expect(local).toEqual([...keys].sort());
  if (opts.closed !== false) {
    expect(serverOrder(orderId)).toBe('CLOSED 0.00');
    expect(st().orders.find((o) => o.id === orderId)!.status).toBe('CLOSED');
  }
}

function fakeDriver(acquirer: 'STONE' | 'PAGBANK', result: (amount: number) => TerminalResult | Promise<TerminalResult>) {
  const d = {
    acquirer, mode: 'SMARTPOS_EMBEDDED', terminal: null,
    charge: vi.fn(async (req: { amount: number }) => result(req.amount)),
    print: vi.fn(async () => undefined),
    abort: vi.fn(),
  };
  return d as unknown as IPaymentTerminalDriver & { charge: ReturnType<typeof vi.fn> };
}
let nsuSeq = 100000;
const approved = (acquirer: 'STONE' | 'PAGBANK' = 'STONE') => (): TerminalResult => {
  nsuSeq += 1;
  return {
    status: 'APPROVED', acquirer, acquirer_cnpj: acquirer === 'STONE' ? '16501555000157' : '08561701000101', card_brand: 'VISA', nsu: String(nsuSeq),
    authorization_code: `A${nsuSeq}`, terminal_serial: `${acquirer}-01`, terminal_id: null, masked_pan: '**** 1234',
  } as TerminalResult;
};

function openTableWith(n: number, qty = 1): string {
  login(CASHIER_PIN);
  const mesa = st().tables.find((t) => t.number === n)!;
  const order = ok(st().openTable(mesa.id, 2, null));
  for (let i = 0; i < qty; i++) {
    ok(st().addToTray({ order_id: order.id, product_id: productId, half_product_ids: [], quantity: 1, unit_price: productPrice, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: 'KITCHEN' }));
  }
  ok(st().dispatchTray(order.id));
  ok(st().startCheckout(order.id));
  return order.id;
}

const chargeButton = () => screen.getByRole('button', { name: /^(Enviar para maquininha|Cobrar na SmartPOS|Receber) R\$/ });

async function renderCheckout(orderId: string) {
  render(<CheckoutScreen orderId={orderId} onBack={() => undefined} onClosed={() => undefined} />);
  await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
}
/** A tela relê a reserva da nuvem a cada 5 s (POINT_RESERVATION_POLL_MS). */
async function waitForReservationRead() {
  const before = net.calls.filter((c) => c === 'tchefood_point_reservation').length;
  await waitFor(() => expect(net.calls.filter((c) => c === 'tchefood_point_reservation').length).toBeGreaterThan(before), { timeout: 8_000 });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}
async function clickCharge() {
  await act(async () => {
    fireEvent.click(chargeButton());
  });
}
function chooseMethod(label: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}
function freeValue(v: string) {
  fireEvent.click(screen.getByRole('button', { name: /Valor livre/ }));
  fireEvent.change(screen.getByPlaceholderText('0,00'), { target: { value: v } });
}

// ---------------------------------------------------------------- testes

(target ? describe : describe.skip)('fluxos de pagamento ponta a ponta no banco real', () => {
  beforeAll(async () => {
    applySchema(target!, DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja E2E', 'Loja E2E Ltda', '11222333000181');`);
    installFetch();
    try { localStorage.clear(); } catch { /* sem armazenamento */ }
    ledger.resetClaimLedger();
    st().resetDemo();
    useTcheStore.setState({ orders: st().orders.map((o) => (o.status === 'OPEN' || o.status === 'PAYING' ? { ...o, status: 'CLOSED' as const } : o)) });
    login('8888');
    ok(st().startNewStore(
      {
        tenant: { name: 'Bar E2E', legal_name: 'E2E Comércio Ltda', cnpj: '11.222.333/0001-81', state_registration: null, city: 'Pelotas', state: 'RS', default_service_fee_pct: 10 },
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
    const cat = ok(st().saveCategory({ name: 'Pratos', sort_order: 1, icon_name: null, active: true }));
    const p = ok(st().saveProduct({
      category_id: cat.id, code: '301', name: 'Carreteiro', description: null, price: 40, sector: 'KITCHEN', available: true, active: true,
      requires_meat_doneness: false, allows_half_and_half: false, ncm: '19022000', cfop: '5102', csosn_cst: '102', unit: 'UN',
      cost_price: 0, stock_quantity: 0, barcode: null,
    }));
    productId = p.id;
    productPrice = p.price;
    for (let n = 1; n <= 9; n++) ok(st().saveTable({ number: n, label: `Mesa ${n}`, area: 'Salão', capacity: 4, active: true }));
    await expectSynced('equipe, cardápio e mesas');
  }, 120_000);

  afterAll(() => {
    psql({ ...target!, db: 'postgres' }, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
  });

  beforeEach(() => {
    net.down = false;
    net.lose.length = 0;
    net.block.length = 0;
    net.calls.length = 0;
    toastLog.length = 0;
    createDriver.mockReset();
    resetClaimSupervisor();
  });
  afterEach(() => {
    cleanup();
  });

  it('caixa da mesa, dinheiro: reserva, registra, sobe, consome e fecha a conta zerada', async () => {
    const id = openTableWith(1);
    await renderCheckout(id);
    chooseMethod(/Dinheiro/);
    await clickCharge();
    await waitFor(() => expect(st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED')).toHaveLength(1));
    // A reserva foi pedida antes do registro; a chave é a do pagamento.
    const key = st().payments.find((p) => p.order_id === id)!.idempotency_key!;
    expect(net.calls.indexOf('tchefood_claim_payment')).toBeGreaterThanOrEqual(0);
    expect(serverClaims(id).map((c) => `${c.key}:${c.status}`)).toEqual([`${key}:open`]);
    // Antes de subir: o registro local fica (settled) com o segredo.
    expect(ledger.localClaim(key)).toMatchObject({ state: 'settled' });
    expect(ledger.localClaim(key)!.release_token).toMatch(/^[0-9a-f]{64}$/);
    // Divisão igual por 2: a segunda cota. Como o app: o laço sobe o 1º pagamento (consome a reserva) e a tela relê a
    // reserva (a cada 5 s). A 2ª cota antes disso: teste abaixo.
    await expectSynced('1º pagamento');
    expect(serverClaims(id).map((c) => c.status)).toEqual(['consumed']);
    await waitForReservationRead();
    await clickCharge();
    await waitFor(() => expect(st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED'), toasts().join(' | ')).toHaveLength(2));
    await expectSynced('pagamento e fechamento');
    await settleLoops();
    expectInvariants(id);
  }, 60_000);

  it('caixa da mesa, 2ª cota logo depois da 1ª (antes do laço subir): a reserva já paga aqui não conta duas vezes', async () => {
    // Antes (r10): CheckoutScreen.charge descontava de novo a reserva aberta do 1º pagamento (mesma chave, aprovada
    // aqui), que o saldo local já tinha descontado. Agora o caixa exclui as chaves pagas aqui (withoutClaimsPaidHere,
    // a regra de reservationExceeds) e o servidor aceita a 2ª cota (ensureOrderSynced sobe a fila antes).
    const id = openTableWith(2);
    await renderCheckout(id);
    chooseMethod(/Dinheiro/);
    await clickCharge();
    await waitFor(() => expect(st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED')).toHaveLength(1));
    await waitForReservationRead();
    await clickCharge();
    try {
      await waitFor(() => expect(st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED'), toasts().join(' | ')).toHaveLength(2), { timeout: 3_000 });
    } finally {
      // Fecha a conta pelo caminho que funciona, para não sobrar reserva.
      await expectSynced('limpeza');
      await waitForReservationRead();
      if (st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED').length < 2) await clickCharge();
      await waitFor(() => expect(st().orders.find((o) => o.id === id)!.status).toBe('CLOSED'));
      await expectSynced('limpeza 2');
      await settleLoops();
    }
  }, 60_000);

  it('2ª cota pelo fluxo de reserva (sem a tela), logo depois da 1ª: ensureOrderSynced sobe a 1ª antes e o servidor aceita', async () => {
    // O servidor e o fluxo de reserva (sem a tela) também aceitam a 2ª cota logo depois da 1ª.
    const id = openTableWith(2);
    const pay = async () => {
      const amount = st().orders.find((o) => o.id === id)!.remaining_balance / (serverPayments(id).length === 0 && st().payments.filter((p) => p.order_id === id).length === 0 ? 2 : 1);
      const key = crypto.randomUUID();
      const c = await startPaymentClaim(true, { orderId: id, key, method: 'CASH', acquirer: 'CASH_DESK', amount });
      expect(c, JSON.stringify(c)).toMatchObject({ ok: true });
      ok(st().registerPayment({ orderId: id, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [] }));
      if (c.ok) { c.handle.settle(); c.handle.leave(); }
    };
    await pay();
    expect(st().outbox.some((e) => e.table === 'payments')).toBe(true);
    await pay();
    await expectSynced('duas cotas');
    await settleLoops();
    expectInvariants(id);
  }, 60_000);

  it('caixa da mesa, dividido: dinheiro (valor livre) + Stone no resto; nada sem reserva, conta fecha zerada', async () => {
    const id = openTableWith(3, 2);
    const total = st().orders.find((o) => o.id === id)!.remaining_balance;
    await renderCheckout(id);
    freeValue('30');
    chooseMethod(/Dinheiro/);
    await clickCharge();
    await waitFor(() => expect(st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED'), toasts().join(' | ')).toHaveLength(1));
    await expectSynced('dinheiro parcial');
    await waitForReservationRead();
    // Resto na Stone (SmartPOS): reserva STONE antes da maquininha; a maquininha só é chamada com a reserva aberta.
    const seen: string[] = [];
    createDriver.mockImplementation(() => fakeDriver('STONE', () => {
      seen.push(serverClaims(id).filter((c) => c.status === 'open').map((c) => `${c.amount_cents}`).join(','));
      return approved('STONE')();
    }));
    chooseMethod(/Crédito/);
    fireEvent.click(screen.getByRole('button', { name: /SmartPOS Embarcado/ }));
    freeValue((total - 30).toFixed(2).replace('.', ','));
    await clickCharge();
    await waitFor(() => expect(st().orders.find((o) => o.id === id)!.status, toasts().join(' | ')).toBe('CLOSED'));
    expect(seen).toEqual([String(Math.round((total - 30) * 100))]);
    await expectSynced('Stone e fechamento');
    await settleLoops();
    expectInvariants(id);
    expect(serverPayments(id).map((p) => `${p.method}/${p.acquirer}`)).toEqual(['CASH/CASH_DESK', 'CREDIT/STONE']);
  }, 60_000);

  function counterSale(qty = 1): string {
    login(CASHIER_PIN);
    return ok(st().createCounterSale([{ product_id: productId, quantity: qty, modifiers: [], meat_doneness: null }])).id;
  }
  async function openSaleInFicha() {
    render(<FichaRapidaScreen />);
    const box = await screen.findByText('Vendas aguardando pagamento');
    const btns = box.parentElement!.querySelectorAll('button');
    fireEvent.click(btns[btns.length - 1]!);
  }
  const cobrar = () => screen.getByRole('button', { name: /^Cobrar R\$/ });

  it('ficha rápida: cartão recusado libera a reserva; depois dinheiro; outra venda no cartão aprovado', async () => {
    const a = counterSale();
    createDriver.mockImplementation(() => fakeDriver('STONE', () => ({ status: 'DECLINED', acquirer: 'STONE', reason: 'Saldo insuficiente', terminal_serial: 'STONE-01', terminal_id: null }) as TerminalResult));
    await openSaleInFicha();
    fireEvent.click(screen.getByRole('button', { name: /Crédito/ }));
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(serverClaims(a).map((c) => c.status), toasts().join(' | ')).toEqual(['released']), { timeout: 10_000 });
    expect(st().payments.filter((p) => p.order_id === a).map((p) => p.status)).toEqual(['DECLINED']);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(st().orders.find((o) => o.id === a)!.status, toasts().join(' | ')).toBe('CLOSED'));
    await expectSynced('ficha: recusa e dinheiro');
    await settleLoops();
    expectInvariants(a);
    expect(serverPayments(a).map((p) => p.status).sort()).toEqual(['APPROVED', 'DECLINED']);
    cleanup();

    const b = counterSale(2);
    createDriver.mockImplementation(() => fakeDriver('STONE', approved('STONE')));
    await openSaleInFicha();
    fireEvent.click(screen.getByRole('button', { name: /Crédito/ }));
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(st().orders.find((o) => o.id === b)!.status, toasts().join(' | ')).toBe('CLOSED'));
    await expectSynced('ficha: cartão');
    await settleLoops();
    expectInvariants(b);
    expect(st().eventTickets.filter((t) => t.order_id === b)).toHaveLength(2);
  }, 60_000);

  const pickupLine = () => ({ product_id: productId, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' });

  it('retirada (senha) no caixa: dinheiro e Stone pelo chargePickupOrder', async () => {
    login(CASHIER_PIN);
    const cash = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'TAKEOUT', customerName: 'Ana' }));
    const r1 = await chargePickupOrder({ orderId: cash.id, method: 'CASH', chassis: 'STONE', cashGiven: 50, kitchenPreview: false });
    expect(r1).toMatchObject({ status: 'APPROVED' });
    createDriver.mockImplementation(() => fakeDriver('STONE', approved('STONE')));
    const card = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'TAKEOUT', customerName: 'Bia' }));
    const r2 = await chargePickupOrder({ orderId: card.id, method: 'DEBIT', chassis: 'STONE', kitchenPreview: false });
    expect(r2).toMatchObject({ status: 'APPROVED' });
    await expectSynced('senhas');
    await settleLoops();
    expectInvariants(cash.id);
    expectInvariants(card.id);
  }, 60_000);

  it('entrega própria paga na entrega: dinheiro do entregador no acerto (sem reserva, entrega-<id>) fecha a conta no servidor', async () => {
    login(OWNER_PIN);
    const zone = ok(st().saveDeliveryZone({ name: 'Centro', fee: 6, eta_minutes: 30, active: true }));
    const courier = ok(st().saveCourier({ name: 'Juca', phone: '53999990000', fee_per_delivery: 5, active: true }));
    login(CASHIER_PIN);
    if (!st().cashSessions.some((c) => c.status === 'OPEN')) ok(st().openCashSession(50));
    const delivery = { customerName: 'Maria', phone: '53 98888-7777', address: 'Rua XV, 10', reference: '', zoneId: zone.id, changeFor: null };
    const onDelivery = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'DELIVERY', customerName: 'Maria', delivery: { ...delivery, payOnDelivery: true } }));
    await expectSynced('pedido de entrega');
    const d = st().ownDeliveries.find((x) => x.order_id === onDelivery.id)!;
    ok(st().setOwnDeliveryStatus(d.id, 'READY'));
    ok(st().dispatchOwnDeliveries([d.id], courier.id));
    ok(st().setOwnDeliveryStatus(d.id, 'DELIVERED'));
    // Acerto antes de a marcação de entregue subir: o pagamento espera por ela na fila.
    ok(st().settleCourier(courier.id, { payFromDrawer: true, auth: MANAGER }));
    await expectSynced('acerto');
    await settleLoops();
    expectInvariants(onDelivery.id);
    expect(serverPayments(onDelivery.id).map((p) => p.key)).toEqual([`entrega-${d.id}`]);
    expect(serverClaims(onDelivery.id)).toEqual([]);
  }, 60_000);

  it('dois aparelhos na mesma conta: com a Stone reservando o saldo todo, a reserva do outro recebe TF003; depois fecha uma vez só', async () => {
    const id = openTableWith(4);
    const total = st().orders.find((o) => o.id === id)!.remaining_balance;
    let finish!: (r: TerminalResult) => void;
    const pending = new Promise<TerminalResult>((r) => { finish = r; });
    createDriver.mockImplementation(() => fakeDriver('STONE', () => pending));
    await renderCheckout(id);
    fireEvent.click(screen.getByRole('button', { name: /SmartPOS Embarcado/ }));
    freeValue(total.toFixed(2).replace('.', ','));
    chooseMethod(/Crédito/);
    await clickCharge();
    await waitFor(() => expect(serverClaims(id).map((c) => c.status)).toEqual(['open']));
    // Aparelho B (outro operador, a mesma conta, o mesmo servidor): tenta o dinheiro do saldo todo.
    const other = await claimPayment({ orderId: id, key: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', amount: total, releaseToken: ledger.generateReleaseToken() });
    expect(other).toMatchObject({ ok: false, code: 'TF003' });
    // E 1 centavo também: o saldo livre é zero.
    const cent = await claimPayment({ orderId: id, key: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', amount: 0.01, releaseToken: ledger.generateReleaseToken() });
    expect(cent).toMatchObject({ ok: false, code: 'TF003' });
    await act(async () => { finish(approved('STONE')()); });
    await waitFor(() => expect(st().orders.find((o) => o.id === id)!.status, toasts().join(' | ')).toBe('CLOSED'));
    await expectSynced('Stone do aparelho A');
    // Depois de fechada: o outro aparelho recebe "conta fechada" (TF002) ou "sem saldo" — nunca uma reserva.
    const late = await claimPayment({ orderId: id, key: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', amount: total, releaseToken: ledger.generateReleaseToken() });
    expect(late.ok).toBe(false);
    await settleLoops();
    expectInvariants(id);
    expect(serverClaims(id)).toHaveLength(1);
  }, 60_000);

  it('rede cai no meio da reserva: resposta perdida, a nova tentativa (mesma chave e segredo) devolve a mesma reserva', async () => {
    login(CASHIER_PIN);
    const o = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'TAKEOUT', customerName: 'Rede' }));
    net.lose.push('tchefood_claim_payment');
    const r = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false });
    expect(r, toasts().join(' | ')).toMatchObject({ status: 'APPROVED' });
    expect(net.calls.filter((c) => c === 'tchefood_claim_payment')).toHaveLength(2);
    expect(serverClaims(o.id)).toHaveLength(1);
    await expectSynced('rede: resposta perdida');
    await settleLoops();
    expectInvariants(o.id);
  }, 60_000);

  it('rede cai no meio da reserva duas vezes: não recebe, libera com o segredo, e a próxima cobrança fecha', async () => {
    login(CASHIER_PIN);
    const o = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'TAKEOUT', customerName: 'Rede 2' }));
    net.lose.push('tchefood_claim_payment', 'tchefood_claim_payment');
    const r = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false });
    expect(r.status).toBe('ERROR');
    expect(st().payments.filter((p) => p.order_id === o.id)).toHaveLength(0);
    // A reserva foi criada no servidor (as respostas se perderam): a liberação com o segredo a encerra.
    await waitFor(() => expect(serverClaims(o.id).map((c) => c.status)).toEqual(['released']), { timeout: 10_000 });
    const r2 = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false });
    expect(r2, toasts().join(' | ')).toMatchObject({ status: 'APPROVED' });
    await expectSynced('rede: duas perdas');
    await settleLoops();
    // Pendência da 1ª reserva: liberada, mas "não existe" não vale aqui (a reserva existia); sai do registro.
    expectInvariants(o.id);
    expect(serverClaims(o.id).map((c) => c.status).sort()).toEqual(['consumed', 'released']);
  }, 60_000);

  it('recusa da maquininha sem internet para liberar: a liberação pendente (com o segredo) sobrevive ao reabrir o app e termina quando a rede volta', async () => {
    login(CASHIER_PIN);
    const o = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'TAKEOUT', customerName: 'Reabre' }));
    createDriver.mockImplementation(() => fakeDriver('STONE', () => {
      net.down = true; // a rede cai enquanto a maquininha recusa
      return { status: 'DECLINED', acquirer: 'STONE', reason: 'Cartão recusado', terminal_serial: 'STONE-01', terminal_id: null } as TerminalResult;
    }));
    const r = await chargePickupOrder({ orderId: o.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false });
    expect(r.status).toBe('DECLINED');
    const key = st().payments.find((p) => p.order_id === o.id)!.idempotency_key!;
    await waitFor(() => expect(ledger.pendingRelease(key)?.last_error ?? null).not.toBeNull(), { timeout: 10_000 });
    expect(serverClaims(o.id).map((c) => c.status)).toEqual(['open']);
    // "Reabrir o app": o registro está no armazenamento do aparelho, com o segredo.
    const raw = JSON.parse(localStorage.getItem('tchefood.paymentClaims.v1') ?? '{}') as { pendingReleases?: Array<{ key: string; release_token: string | null; final?: boolean }> };
    const saved = raw.pendingReleases?.find((x) => x.key === key);
    expect(saved?.release_token).toMatch(/^[0-9a-f]{64}$/);
    expect(saved?.final).toBe(false);
    // O DECLINED espera a liberação (o servidor recusaria com TF010 com a reserva aberta).
    net.down = false;
    await syncRound();
    expect(st().outbox.some((e) => e.table === 'payments' && e.row_id === st().payments.find((p) => p.idempotency_key === key)!.id)).toBe(true);
    await settleLoops(Date.now() + 60_000);
    expect(serverClaims(o.id).map((c) => c.status)).toEqual(['released']);
    expect(ledger.pendingRelease(key)).toBeNull();
    const r2 = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false });
    expect(r2, toasts().join(' | ')).toMatchObject({ status: 'APPROVED' });
    await expectSynced('reabrir: recusa e dinheiro');
    await settleLoops();
    expectInvariants(o.id);
  }, 60_000);

  it('envio do pagamento com a resposta perdida: a fila reenvia e o servidor não registra duas vezes', async () => {
    const id = openTableWith(5);
    const o = st().orders.find((x) => x.id === id)!;
    const c = await startPaymentClaim(true, { orderId: id, key: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', amount: o.remaining_balance });
    expect(c.ok).toBe(true);
    const key = ledger.inFlightClaims().find((x) => x.order_id === id)!.key;
    ok(st().registerPayment({ orderId: id, amount: o.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [] }));
    if (c.ok) { c.handle.settle(); c.handle.leave(); }
    net.lose.push('tchefood_register_payment');
    await syncRound();
    expect(st().outbox.some((e) => e.table === 'payments')).toBe(true);
    await expectSynced('reenvio');
    await settleLoops();
    expectInvariants(id);
  }, 60_000);

  it('TF010: pagamento sem reserva é recusado no aparelho e, forjado na fila, pelo servidor; nada entra', async () => {
    const id = openTableWith(6);
    const o = st().orders.find((x) => x.id === id)!;
    const input = { orderId: id, amount: o.remaining_balance, method: 'CASH' as const, status: 'APPROVED' as const, terminal_id: null, acquirer: 'CASH_DESK' as const, acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: crypto.randomUUID(), item_ids: [] };
    // O aparelho não registra pagamento sem a reserva local (registerPayment confere o registro de reservas).
    expect(st().registerPayment(input).ok).toBe(false);
    await expectSynced('conta');
    // Fila forjada / versão anterior: o servidor recusa com TF010.
    const pay = {
      id: crypto.randomUUID(), order_id: id, tenant_id: TENANT, waiter_id: st().currentUserId, terminal_id: null, amount: o.remaining_balance, tip_amount: 0,
      method: 'CASH', status: 'APPROVED', acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null,
      terminal_serial: null, idempotency_key: input.idempotency_key, created_at: new Date().toISOString(),
    };
    const res = await fetch('http://cloud.test/rest/v1/rpc/tchefood_register_payment', { method: 'POST', headers: {}, body: JSON.stringify({ p_payment: pay }) } as never);
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text).code).toBe('TF010');
    expect(serverPayments(id).filter((p) => p.status === 'APPROVED')).toEqual([]);
    expect(serverOrder(id)).not.toMatch(/^CLOSED/);
  }, 60_000);

  it('TF013: reserva liberada antes de o pagamento subir; o servidor recusa, o supervisor tira o pagamento e trava a conta', async () => {
    const id = openTableWith(7);
    const o = st().orders.find((x) => x.id === id)!;
    const c = await startPaymentClaim(true, { orderId: id, key: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', amount: o.remaining_balance });
    expect(c.ok).toBe(true);
    const lc = ledger.inFlightClaims().find((x) => x.order_id === id)!;
    ok(st().registerPayment({ orderId: id, amount: o.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: lc.key, item_ids: [] }));
    if (c.ok) { c.handle.settle(); c.handle.leave(); }
    // Liberada no servidor com o segredo deste aparelho (outra aba) antes da fila subir.
    sql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}","sub":"device"}', true);
         SELECT tchefood_release_payment_claim('${lc.key}', '${st().currentUserId}', '${lc.release_token}', 'Liberada por outra aba no teste'); COMMIT;`);
    for (let i = 0; i < 3 && st().outbox.length > 0; i += 1) await syncRound();
    expect((st().syncRejected ?? []).some((r) => r.event.table === 'payments' && r.event.payload.idempotency_key === lc.key)).toBe(true);
    await settleLoops();
    expect(serverPayments(id).filter((p) => p.status === 'APPROVED')).toEqual([]);
    expect(st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED')).toEqual([]);
    expect(getReviewHold(id)?.code).toMatch(/CLAIM_RELEASED|PAYMENT_REJECTED/);
    // O segredo continua no aparelho (para o estorno confirmado no servidor).
    expect(ledger.localClaim(lc.key)?.release_token ?? ledger.pendingRelease(lc.key)?.release_token ?? null).toMatch(/^[0-9a-f]{64}$/);
    clearReviewHold(id);
    useTcheStore.setState((s) => ({ syncRejected: (s.syncRejected ?? []).filter((r) => r.event.payload.order_id !== id) }));
  }, 60_000);

  it('desconto depois de pagamento parcial: abaixo do pago é recusado aqui; com reserva aberta, recusado aqui (leitura) e no servidor (TF012)', async () => {
    const id = openTableWith(8, 2);
    await renderCheckout(id);
    freeValue('60');
    chooseMethod(/Dinheiro/);
    await clickCharge();
    await waitFor(() => expect(st().payments.filter((p) => p.order_id === id && p.status === 'APPROVED'), toasts().join(' | ')).toHaveLength(1));
    await expectSynced('parcial');
    cleanup();
    const o = () => st().orders.find((x) => x.id === id)!;
    login(CASHIER_PIN);
    // Abaixo do já pago: recusado no aparelho (TOTAL_BELOW_PAID).
    const below = st().applyDiscount(id, o().total_amount - 50, MANAGER);
    expect(below.ok).toBe(false);
    // Reserva aberta para o resto (Stone em andamento): desconto que deixaria o saldo abaixo do reservado.
    const rest = o().remaining_balance;
    const c = await startPaymentClaim(true, { orderId: id, key: crypto.randomUUID(), method: 'CREDIT', acquirer: 'STONE', amount: rest });
    expect(c.ok).toBe(true);
    const { fetchPointReservation } = await import('../lib/sync/cloudPull');
    const { rememberServerReservation } = await import('../lib/payments/pointReservation');
    const read = await fetchPointReservation({ url: 'http://cloud.test', anonKey: 'anon', accessToken: 'jwt' }, (u, i) => fetch(u, i), id);
    rememberServerReservation(id, read.reservedCents, read.claims ?? []);
    const local = st().applyDiscount(id, 5, MANAGER);
    expect(local.ok).toBe(false);
    // Sem leitura recente (outro aparelho, leitura velha): o aparelho deixa, o servidor recusa com TF012.
    rememberServerReservation(id, 0, [], Date.now() - 120_000);
    const blind = st().applyDiscount(id, 5, MANAGER);
    expect(blind.ok).toBe(true);
    for (let i = 0; i < 3 && st().outbox.length > 0; i += 1) await syncRound();
    const rej = (st().syncRejected ?? []).filter((r) => r.event.payload?.id === id || r.event.payload?.order_id === id);
    expect(rej.map((r) => r.message).join(' ')).toMatch(/reserv/i);
    // Fim: a Stone recusa, a reserva sai. A conta fica com a recusa do desconto para o gerente resolver.
    if (c.ok) { c.handle.noCharge('teste'); c.handle.leave(); }
    await waitFor(() => expect(serverClaims(id).filter((x) => x.status === 'open')).toEqual([]), { timeout: 10_000 });
    // A recusa do desconto prende só esta conta; sai da lista para não afetar os outros cenários.
    useTcheStore.setState((s) => ({ syncRejected: (s.syncRejected ?? []).filter((r) => r.event.payload?.id !== id && r.event.payload?.order_id !== id) }));
    for (let i = 0; i < 3 && st().outbox.length > 0; i += 1) await syncRound();
  }, 60_000);

  it('sem rede nenhuma na reserva: nada no servidor; a liberação pendente "não existe" só sai depois de 3 leituras em 2 min+', async () => {
    login(CASHIER_PIN);
    const o = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'TAKEOUT', customerName: 'Sem rede' }));
    await expectSynced('pedido');
    net.block.push('tchefood_claim_payment', 'tchefood_claim_payment');
    const r = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false });
    expect(r.status).toBe('ERROR');
    expect(serverClaims(o.id)).toEqual([]);
    await waitFor(() => expect(ledger.pendingReleases().filter((x) => x.order_id === o.id)).toHaveLength(1), { timeout: 10_000 });
    const t0 = Date.now();
    await settleLoops(t0);
    expect(ledger.pendingReleases().filter((x) => x.order_id === o.id), 'ainda dentro dos 2 min').toHaveLength(1);
    await settleLoops(t0 + 180_000);
    expect(ledger.pendingReleases().filter((x) => x.order_id === o.id)).toEqual([]);
    const r2 = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false });
    expect(r2, toasts().join(' | ')).toMatchObject({ status: 'APPROVED' });
    await expectSynced('sem rede: dinheiro');
    await settleLoops();
    expectInvariants(o.id);
  }, 60_000);

  it('app cai no meio da cobrança na Stone: a reserva fica aberta (outro recebe TF003), o segredo fica; vencida, o gerente libera e a conta fecha', async () => {
    const id = openTableWith(9);
    const total = st().orders.find((o) => o.id === id)!.remaining_balance;
    createDriver.mockImplementation(() => fakeDriver('STONE', () => new Promise<TerminalResult>(() => undefined)));
    await renderCheckout(id);
    fireEvent.click(screen.getByRole('button', { name: /SmartPOS Embarcado/ }));
    freeValue(total.toFixed(2).replace('.', ','));
    chooseMethod(/Crédito/);
    await clickCharge();
    await waitFor(() => expect(serverClaims(id).map((c) => c.status)).toEqual(['open']));
    const lc = ledger.inFlightClaims().find((c) => c.order_id === id)!;
    // "App fechou": a tela sai e a memória de "rodando aqui" se perde; o registro persistido fica.
    cleanup();
    ledger.detachLocalClaim(lc.key);
    useTcheStore.setState({ pendingCharges: [] } as never);
    await settleLoops();
    expect(ledger.localClaim(lc.key)?.release_token).toBe(lc.release_token);
    expect(serverClaims(id).map((c) => c.status)).toEqual(['open']);
    const other = await claimPayment({ orderId: id, key: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', amount: total, releaseToken: ledger.generateReleaseToken() });
    expect(other).toMatchObject({ ok: false, code: 'TF003' });
    // O gerente ainda não libera (prazo + espera): TF011.
    const { releasePaymentClaimManager } = await import('../lib/payments/paymentClaim');
    login(MANAGER_PIN);
    const early = await releasePaymentClaimManager(lc.key, MANAGER_PIN, 'Maquininha sem resposta, conferi o extrato');
    expect(early).toMatchObject({ ok: false, active: true });
    // O tempo passa (prazo de 90 s + 5 min sem batimento).
    sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE payment_claims SET active_until = now() - interval '10 minutes', created_at = created_at - interval '10 minutes' WHERE idempotency_key = '${lc.key}'; COMMIT;`);
    const rel = await releasePaymentClaimManager(lc.key, MANAGER_PIN, 'Maquininha sem resposta, conferi o extrato');
    expect(rel).toMatchObject({ ok: true });
    expect(serverClaims(id).map((c) => c.status)).toEqual(['released']);
    // O registro local sai depois de 3 leituras ausentes em 2 min+.
    const t0 = Date.now();
    await settleLoops(t0);
    await settleLoops(t0 + 60_000);
    await settleLoops(t0 + 180_000);
    expect(ledger.localClaim(lc.key)).toBeNull();
    login(CASHIER_PIN);
    await renderCheckout(id);
    freeValue(total.toFixed(2).replace('.', ','));
    chooseMethod(/Dinheiro/);
    await clickCharge();
    await waitFor(() => expect(st().orders.find((o) => o.id === id)!.status, toasts().join(' | ')).toBe('CLOSED'));
    await expectSynced('depois da liberação');
    await settleLoops();
    expectInvariants(id);
  }, 60_000);

  it('laço de verdade (useCloudSync montado): pagamento sobe, a reserva é consumida e o registro local esvazia sem chamada manual', async () => {
    const { useCloudSync } = await import('../lib/sync/useCloudSync');
    function Loop() {
      useCloudSync(true);
      return null;
    }
    render(<Loop />);
    login(CASHIER_PIN);
    const o = ok(st().createPickupOrder({ lines: [pickupLine()], fulfillment: 'TAKEOUT', customerName: 'Laço' }));
    createDriver.mockImplementation(() => fakeDriver('STONE', approved('STONE')));
    const r = await chargePickupOrder({ orderId: o.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false });
    expect(r, toasts().join(' | ')).toMatchObject({ status: 'APPROVED' });
    await waitFor(() => expect(serverOrder(o.id)).toBe('CLOSED 0.00'), { timeout: 15_000 });
    await waitFor(() => expect(ledger.inFlightClaims().filter((c) => c.order_id === o.id)).toEqual([]), { timeout: 35_000, interval: 500 });
    expectInvariants(o.id);
  }, 60_000);
  it('auditoria interna 2 (P1-A): estorno da Point de um pagamento que não subiu: o estornado sobe, a conta reabre e deve no servidor e aqui, a mesa não fica livre', async () => {
    login(OWNER_PIN);
    if (!st().tables.some((t) => t.number === 10)) ok(st().saveTable({ number: 10, label: 'Mesa 10', area: 'Salão', capacity: 4, active: true }));
    const id = openTableWith(10);
    await expectSynced('conta da Point');
    const o = st().orders.find((x) => x.id === id)!;
    const cents = Math.round(o.remaining_balance * 100);
    const termId = crypto.randomUUID();
    const key = crypto.randomUUID();
    sql(`INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${termId}', '${TENANT}', 'Point E2E', 'MP-E2E', 'MERCADO_PAGO');`);
    useTcheStore.setState((s) => ({ terminals: [...s.terminals, { id: termId, tenant_id: TENANT, name: 'Point E2E', serial_number: 'MP-E2E', acquirer: 'MERCADO_PAGO', mode: 'TEF_POS_WIRELESS', online: true, battery_level: 90 } as never] }));
    // Aprovada na Point e registrada aqui; a fila (pagamento, itens pagos, conta fechada, mesa livre) ainda não subiu.
    net.down = true;
    const paid = ok(st().registerPayment({
      orderId: id, amount: o.remaining_balance, method: 'CREDIT', status: 'APPROVED', terminal_id: termId, acquirer: 'MERCADO_PAGO',
      acquirer_cnpj: '10573521000191', card_brand: 'VISA', nsu: 'PE2E1', authorization_code: 'AUT1', terminal_serial: 'MP-E2E', idempotency_key: key, item_ids: [],
    }));
    expect(paid.closed).toBe(true);
    // No servidor, a cobrança terminou estornada (o Mercado Pago provou o estorno) sem o pagamento gravado.
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
         INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, external_order_id, external_payment_id, paid_amount_cents, card_brand, authorization_code)
         VALUES ('${TENANT}', '${key}', '${id}', '${termId}', 'mercado_pago_point', 'MP-E2E', 'CREDIT', ${cents}, 'refunded', 'ORD-${key}', 'PE2E1', ${cents}, 'VISA', 'AUT1'); COMMIT;`);
    const m = st().mirrorServerPointRefund(key, 'Venda estornada na maquininha', { paymentRegistered: false });
    expect(m.ok).toBe(true);
    expect(st().orders.find((x) => x.id === id)).toMatchObject({ status: 'PAYING', remaining_balance: o.remaining_balance });
    expect(st().tables.find((t) => t.id === o.table_id)).toMatchObject({ status: 'PAYING', current_order_id: id });
    net.down = false;
    await expectSynced('estorno espelhado');
    expect(serverPayments(id).map((p) => `${p.key}:${p.status}`)).toEqual([`${key}:REFUNDED`]);
    expect(serverOrder(id)).not.toMatch(/^CLOSED/);
    expect(Number(sql(`SELECT remaining_balance FROM orders WHERE id = '${id}'`))).toBeCloseTo(o.remaining_balance, 2);
    expect(sql(`SELECT status || ' ' || COALESCE(current_order_id::text, '-') FROM dining_tables WHERE id = '${o.table_id}'`)).not.toMatch(/^FREE/);
    expect(sql(`SELECT count(*) FROM order_items WHERE order_id = '${id}' AND is_paid`)).toBe('0');
    // A conta volta a fechar pelo caminho normal (dinheiro, com reserva).
    await renderCheckout(id);
    chooseMethod(/Dinheiro/);
    freeValue(o.remaining_balance.toFixed(2));
    await waitForReservationRead();
    await clickCharge();
    await waitFor(() => expect(st().orders.find((x) => x.id === id)!.status, toasts().join(' | ')).toBe('CLOSED'));
    await expectSynced('conta paga depois do estorno');
    await waitFor(() => expect(serverOrder(id)).toBe('CLOSED 0.00'));
  }, 60_000);
});
