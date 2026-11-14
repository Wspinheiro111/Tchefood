// @vitest-environment jsdom
/**
 * r7 P2-9: tela de verdade até a rede. Só a rede (fetch), a sessão, a subida da conta, a leitura da reserva e
 * a maquininha são de mentira: reserva, liberação (releaseClaimAfterNoCharge) e o registro local são os reais.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold } from '../lib/payments/reviewHolds';
import { localClaim, pendingReleases, resetClaimLedger, settledClaims } from '../lib/payments/claimLedger';
import type { IPaymentTerminalDriver, TerminalResult } from '../lib/payments/drivers';

const fetchPointReservation = vi.fn();
const createDriver = vi.fn();
vi.mock('../lib/sync/cloudPull', async (orig) => ({
  ...(await orig<typeof import('../lib/sync/cloudPull')>()),
  fetchPointReservation: (...a: unknown[]) => fetchPointReservation(...a),
}));
vi.mock('../lib/sync/useCloudSync', async (orig) => ({
  ...(await orig<typeof import('../lib/sync/useCloudSync')>()),
  freshCloudConfig: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' }),
  ensureOrderSynced: async (orderId: string) => {
    const o = useTcheStore.getState().orders.find((x) => x.id === orderId)!;
    return { ok: true, balance_cents: Math.round(o.remaining_balance * 100) };
  },
}));
vi.mock('../lib/payments/drivers', async (orig) => {
  const real = await orig<typeof import('../lib/payments/drivers')>();
  return { ...real, createDriver: (...a: unknown[]) => createDriver(...a) };
});

const { CheckoutScreen } = await import('../screens/CheckoutScreen');

type Call = { fn: string; body: Record<string, unknown> };
const calls: Call[] = [];
/** Resposta por RPC; 'drop' = a rede caiu (o servidor pode ter gravado). */
let handlers: Record<string, (body: Record<string, unknown>, n: number) => 'drop' | { status: number; body: unknown }> = {};

function claimOk(body: Record<string, unknown>) {
  return { status: 200, body: { id: 'c1', idempotency_key: body.p_key, status: 'open', amount_cents: body.p_amount_cents } };
}

const st = () => useTcheStore.getState();
function openTable(): string {
  expect(st().login('1111').ok).toBe(true);
  const table = st().tables.find((t) => t.number === 1)!;
  const r = st().openTable(table.id, 2, null);
  if (!r.ok) throw new Error(r.error);
  const p = st().products.find((x) => x.code === '101')!;
  const t = st().addToTray({
    order_id: r.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
    meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector,
  });
  if (!t.ok) throw new Error(t.error);
  st().dispatchTray(r.data.id);
  expect(st().startCheckout(r.data.id).ok).toBe(true);
  act(() => {
    useTcheStore.setState({
      pullStatus: { last_pull_at: '2026-11-14T10:00:00Z', last_error: null, cloud_staff_unknown: 0 },
      cloud: { url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9_999_999_999, tenant_id: st().tenant.id },
    } as never);
  });
  return r.data.id;
}
const chargeButton = () => screen.getByRole('button', { name: /^(Enviar para maquininha|Cobrar na SmartPOS|Receber) R\$/ });
const payments = (orderId: string) => st().payments.filter((p) => p.order_id === orderId);
const declined: TerminalResult = { status: 'DECLINED', acquirer: 'STONE', reason: 'Saldo insuficiente', terminal_serial: 'S1', terminal_id: null };
function driverWith(result: TerminalResult) {
  return { acquirer: 'STONE', mode: 'TEF_POS_WIRELESS', terminal: null, charge: vi.fn(async () => result), print: vi.fn(async () => undefined), abort: vi.fn() } as unknown as IPaymentTerminalDriver & { charge: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
  resetClaimLedger();
  calls.length = 0;
  handlers = {};
  fetchPointReservation.mockReset().mockResolvedValue({ reservedCents: 0, openCharges: 0, manualReview: false, charges: [], claims: [] });
  createDriver.mockReset();
  const counts: Record<string, number> = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    const fn = String(url).split('/rpc/')[1] ?? String(url);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ fn, body });
    counts[fn] = (counts[fn] ?? 0) + 1;
    const h = handlers[fn];
    const out = h ? h(body, counts[fn]!) : { status: 200, body: {} };
    if (out === 'drop') throw new TypeError('Failed to fetch');
    return { ok: out.status < 300, status: out.status, text: async () => JSON.stringify(out.body) };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rpc = (fn: string) => calls.filter((c) => c.fn === fn);

describe('caixa da mesa até a rede', () => {
  it('recusa na maquininha: a liberação real vai com o MESMO segredo da reserva e o registro local fica limpo', async () => {
    const id = openTable();
    handlers.tchefood_claim_payment = (b) => claimOk(b);
    handlers.tchefood_release_payment_claim = (b) => ({ status: 200, body: { id: 'c1', idempotency_key: b.p_key, status: 'released' } });
    createDriver.mockReturnValue(driverWith(declined));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(rpc('tchefood_release_payment_claim')).toHaveLength(1));
    const claim = rpc('tchefood_claim_payment')[0]!.body;
    const release = rpc('tchefood_release_payment_claim')[0]!.body;
    expect(claim.p_release_token).toMatch(/^[0-9a-f]{64}$/);
    expect(release).toMatchObject({ p_key: claim.p_key, p_release_token: claim.p_release_token });
    await waitFor(() => expect(localClaim(String(claim.p_key))).toBeNull());
    expect(pendingReleases()).toEqual([]);
    expect(document.body.innerHTML).not.toContain(String(claim.p_release_token));
  });

  it('prazo da reserva vence, mas o servidor gravou: a nova tentativa usa a mesma chave e o mesmo segredo; sem reserva vazada', async () => {
    const id = openTable();
    handlers.tchefood_claim_payment = (b, n) => (n === 1 ? 'drop' : claimOk(b));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(payments(id)).toHaveLength(1));
    const [a, b] = rpc('tchefood_claim_payment').map((c) => c.body);
    expect(b).toEqual(a);
    expect(payments(id)[0]!.idempotency_key).toBe(a!.p_key);
    expect(rpc('tchefood_release_payment_claim')).toHaveLength(0);
    // Pago aqui: o registro fica 'settled' (com o segredo) para o laço manter a reserva até o servidor consumir.
    expect(settledClaims()).toEqual([expect.objectContaining({ key: a!.p_key, release_token: a!.p_release_token })]);
  });

  it('duas vezes sem resposta: não recebe e a reserva que o servidor possa ter gravado é liberada com o segredo (pendente sem rede)', async () => {
    const id = openTable();
    handlers.tchefood_claim_payment = () => 'drop';
    handlers.tchefood_release_payment_claim = () => 'drop';
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(pendingReleases()).toHaveLength(1), { timeout: 8_000 });
    const claim = rpc('tchefood_claim_payment')[0]!.body;
    expect(rpc('tchefood_claim_payment')).toHaveLength(2);
    expect(pendingReleases()[0]).toMatchObject({ key: claim.p_key, release_token: claim.p_release_token, final: false });
    expect(rpc('tchefood_release_payment_claim').every((c) => c.body.p_release_token === claim.p_release_token)).toBe(true);
    expect(payments(id)).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain(String(claim.p_release_token));
  }, 12_000);
});
