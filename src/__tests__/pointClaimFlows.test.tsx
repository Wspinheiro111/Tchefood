// @vitest-environment jsdom
/**
 * Reserva antes de receber numa loja com Point (docs/integracoes/r6-spec.md C1/C3): caixa da mesa, ficha
 * rápida e retirada pedem a reserva no servidor ANTES de registrar o dinheiro ou mandar para a maquininha;
 * sem resposta não recebem; recusa libera a reserva; revisão manual a mantém. Sem leitura da reserva da
 * nuvem, o caixa da mesa não recebe.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold, getReviewHold, setReviewHold } from '../lib/payments/reviewHolds';
import { addPendingRelease, beginLocalClaim, isClaimActiveHere, localClaim, resetClaimLedger, settleLocalClaim } from '../lib/payments/claimLedger';
import type { IPaymentTerminalDriver, TerminalResult } from '../lib/payments/drivers';
import type { PosTerminal } from '../types';

const claimLog: string[] = [];
const claimPayment = vi.fn();
const releasePaymentClaim = vi.fn();
const releasePaymentClaimManager = vi.fn();
const fetchPointReservation = vi.fn();
const createDriver = vi.fn();
const touchPaymentClaim = vi.fn();
const authorizeClaimRefunded = vi.fn();
const reclaimPayment = vi.fn();

vi.mock('../lib/payments/paymentClaim', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/paymentClaim')>()),
  claimPayment: (...a: unknown[]) => claimPayment(...a),
  releaseClaimAfterNoCharge: (...a: unknown[]) => releasePaymentClaim(...a),
  releasePaymentClaimManager: (...a: unknown[]) => releasePaymentClaimManager(...a),
  touchPaymentClaim: (...a: unknown[]) => touchPaymentClaim(...a),
  authorizeClaimRefunded: (...a: unknown[]) => authorizeClaimRefunded(...a),
  reclaimPayment: (...a: unknown[]) => reclaimPayment(...a),
}));
vi.mock('../lib/sync/cloudPull', async (orig) => ({
  ...(await orig<typeof import('../lib/sync/cloudPull')>()),
  fetchPointReservation: (...a: unknown[]) => fetchPointReservation(...a),
}));
vi.mock('../lib/sync/useCloudSync', async (orig) => ({
  ...(await orig<typeof import('../lib/sync/useCloudSync')>()),
  freshCloudConfig: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' }),
}));
vi.mock('../lib/payments/drivers', async (orig) => {
  const real = await orig<typeof import('../lib/payments/drivers')>();
  return { ...real, createDriver: (...a: unknown[]) => createDriver(...a) };
});

const { CheckoutScreen } = await import('../screens/CheckoutScreen');
const { FichaRapidaScreen } = await import('../screens/FichaRapidaScreen');
const { chargePickupOrder } = await import('../lib/pickupCharge');

const st = () => useTcheStore.getState();
const MP_TERMINAL: PosTerminal = { id: 'mp-term', tenant_id: 'x', name: 'Point Salão', serial_number: 'MP-SERIAL', acquirer: 'MERCADO_PAGO', mode: 'TEF_POS_WIRELESS', online: true, battery_level: 90 };
const CLAIM_OK = (key: string, cents: number) => ({ ok: true, claim: { id: 'c1', idempotency_key: key, status: 'open', amount_cents: cents } });
const NO_RESERVATION = { reservedCents: 0, openCharges: 0, manualReview: false, charges: [] };

function fakeDriver(acquirer: 'STONE' | 'PAGBANK' | 'MERCADO_PAGO', result: TerminalResult | Promise<TerminalResult>) {
  const d = {
    acquirer, mode: 'TEF_POS_WIRELESS', terminal: null,
    charge: vi.fn(async () => { claimLog.push('charge'); return result; }),
    print: vi.fn(async () => undefined),
    abort: vi.fn(),
  };
  return d as unknown as IPaymentTerminalDriver & { charge: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
}
const declined = (acquirer: 'STONE' | 'MERCADO_PAGO' = 'STONE'): TerminalResult => ({ status: 'DECLINED', acquirer, reason: 'Saldo insuficiente', terminal_serial: 'S1', terminal_id: null });
const review: TerminalResult = { status: 'MANUAL_REVIEW', acquirer: 'STONE', reason: 'Sem resposta', failure_code: 'TIMEOUT', terminal_serial: 'S1', terminal_id: null };

/** Sem nuvem configurada (demonstração local), com Point na lista local: não pede reserva. */
function localOnly() {
  act(() => {
    useTcheStore.setState({ terminals: [...st().terminals, MP_TERMINAL], cloud: null } as never);
  });
}

function withPoint(point = true, pulled = true) {
  act(() => {
    useTcheStore.setState({
      terminals: point ? [...st().terminals, MP_TERMINAL] : st().terminals,
      pullStatus: { last_pull_at: pulled ? '2026-11-14T10:00:00Z' : null, last_error: null, cloud_staff_unknown: 0 },
      cloud: { url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9_999_999_999, tenant_id: st().tenant.id },
    } as never);
  });
}

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
  return r.data.id;
}

const chargeButton = () => screen.getByRole('button', { name: /^(Enviar para maquininha|Cobrar na SmartPOS|Receber) R\$/ });
const payments = (orderId: string) => st().payments.filter((p) => p.order_id === orderId);

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
  claimLog.length = 0;
  claimPayment.mockReset();
  releasePaymentClaim.mockReset().mockResolvedValue({ ok: true });
  authorizeClaimRefunded.mockReset().mockResolvedValue({ ok: true, auditId: '11111111-2222-4333-8444-555555555555' });
  reclaimPayment.mockReset().mockImplementation(async (i: { newKey: string; amount: number }) => ({ ok: true, claim: { id: 'c', idempotency_key: i.newKey, status: 'open', amount_cents: Math.round(i.amount * 100) } }));
  releasePaymentClaimManager.mockReset().mockResolvedValue({ ok: true });
  resetClaimLedger();
  fetchPointReservation.mockReset().mockResolvedValue(NO_RESERVATION);
  createDriver.mockReset();
  touchPaymentClaim.mockReset().mockResolvedValue({ ok: true, status: 'open', activeUntil: null });
});
afterEach(() => {
  cleanup();
});

describe('caixa da mesa (CheckoutScreen) numa loja com Point', () => {
  it('dinheiro: reserva no servidor com a chave do pagamento ANTES de registrar', async () => {
    const id = openTable();
    withPoint();
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => {
      claimLog.push(`claim:${payments(id).length}`);
      return CLAIM_OK(input.key, Math.round(input.amount * 100));
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(payments(id)).toHaveLength(1));
    expect(claimLog).toEqual(['claim:0']);
    const input = claimPayment.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ orderId: id, method: 'CASH', acquirer: 'CASH_DESK', amount: payments(id)[0]!.amount });
    expect(input.key).toBe(payments(id)[0]!.idempotency_key);
  });

  it('dinheiro sem internet: bloqueia com o aviso e não registra nada', async () => {
    const id = openTable();
    withPoint();
    claimPayment.mockResolvedValue({ ok: false, offline: true, error: 'Sem internet: com a Point na loja, só dá para receber com o servidor confirmando. Tente de novo quando voltar a conexão.' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    // Sem resposta: uma nova tentativa com a mesma chave e o mesmo segredo; depois, libera com o segredo.
    await waitFor(() => expect(releasePaymentClaim).toHaveBeenCalledTimes(1));
    expect(claimPayment).toHaveBeenCalledTimes(2);
    expect(payments(id)).toHaveLength(0);
  });

  it('outra maquininha: reserva antes de mandar; recusa libera a reserva', async () => {
    const id = openTable();
    withPoint();
    const driver = fakeDriver('STONE', declined());
    createDriver.mockReturnValue(driver);
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => { claimLog.push('claim'); return CLAIM_OK(input.key, Math.round(input.amount * 100)); });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(releasePaymentClaim).toHaveBeenCalledTimes(1));
    expect(claimLog).toEqual(['claim', 'charge']);
    const key = (claimPayment.mock.calls[0]![0] as { key: string }).key;
    expect(claimPayment.mock.calls[0]![0]).toMatchObject({ method: 'CREDIT', acquirer: 'STONE' });
    expect(releasePaymentClaim.mock.calls[0]![0]).toBe(key);
    expect(payments(id).map((p) => [p.status, p.idempotency_key])).toEqual([['DECLINED', key]]);
  });

  it('outra maquininha sem internet: não manda para a maquininha', async () => {
    const id = openTable();
    withPoint();
    const driver = fakeDriver('STONE', declined());
    createDriver.mockReturnValue(driver);
    claimPayment.mockResolvedValue({ ok: false, offline: true, error: 'Sem internet' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(2));
    expect(driver.charge).not.toHaveBeenCalled();
    expect(st().pendingCharges).toHaveLength(0);
  });

  it('revisão manual na outra maquininha mantém a reserva (não libera)', async () => {
    const id = openTable();
    withPoint();
    createDriver.mockReturnValue(fakeDriver('STONE', review));
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => CLAIM_OK(input.key, Math.round(input.amount * 100)));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(getReviewHold(id)).not.toBeNull());
    expect(releasePaymentClaim).not.toHaveBeenCalled();
  });

  it('cobrança na própria Point não pede reserva à parte (a cobrança é a reserva) e mostra "Cancelar cobrança" com PIN de gerente', async () => {
    const id = openTable();
    withPoint();
    let finish: (r: TerminalResult) => void = () => undefined;
    const driver = fakeDriver('MERCADO_PAGO', new Promise<TerminalResult>((r) => { finish = r; }));
    createDriver.mockReturnValue(driver);
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Point Salão/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(driver.charge).toHaveBeenCalledTimes(1));
    expect(claimPayment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar cobrança' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Descreva o motivo…'), { target: { value: 'Cliente desistiu' } });
    for (const d of '9999') fireEvent.click(within(dialog).getByRole('button', { name: d }));
    const req = driver.charge.mock.calls[0]![0] as { request_id: string };
    expect(driver.abort).toHaveBeenCalledWith(req.request_id, { manager_pin: '9999', reason: 'Cliente desistiu' });
    await act(async () => { finish(declined('MERCADO_PAGO')); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancelar cobrança' })).toBeNull());
  });

  it('sem leitura da reserva na nuvem: mostra "Sem leitura da nuvem" e não recebe', async () => {
    const id = openTable();
    withPoint();
    fetchPointReservation.mockRejectedValue(new Error('rede'));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect(screen.getByText('Sem leitura da nuvem')).toBeTruthy());
    expect((chargeButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(chargeButton()); });
    expect(claimPayment).not.toHaveBeenCalled();
    expect(payments(id)).toHaveLength(0);
  });

  it('a reserva da nuvem ainda barra o valor reservado antes de pedir a reserva', async () => {
    const id = openTable();
    withPoint();
    const remaining = st().orders.find((o) => o.id === id)!.remaining_balance;
    fetchPointReservation.mockResolvedValue({ reservedCents: Math.round(remaining * 100), openCharges: 1, manualReview: false, charges: [] });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect(screen.getByText('Há uma cobrança na Point em andamento nesta conta')).toBeTruthy());
    await act(async () => { fireEvent.click(chargeButton()); });
    expect(claimPayment).not.toHaveBeenCalled();
    expect(payments(id)).toHaveLength(0);
  });

  it('cobrança da Point de outro aparelho em revisão: "Resolver cobrança da Point" abre a conferência', async () => {
    const id = openTable();
    withPoint();
    fetchPointReservation.mockResolvedValue({
      reservedCents: 1000, openCharges: 1, manualReview: true,
      charges: [{ idempotencyKey: 'pk-outro', status: 'manual_review', amountCents: 1000, rawStatusDetail: 'DISPATCH_UNKNOWN', hasPayment: false }],
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resolver cobrança da Point' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conferir no Mercado Pago' })).toBeTruthy();
  });

  it('aparelho sem nuvem (demonstração local): nada muda (sem reserva e sem bloqueio pela leitura da nuvem)', async () => {
    const id = openTable();
    localOnly();
    fetchPointReservation.mockRejectedValue(new Error('rede'));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(payments(id)).toHaveLength(1));
    expect(claimPayment).not.toHaveBeenCalled();
    expect(screen.queryByText('Sem leitura da nuvem')).toBeNull();
  });
});

describe('ficha rápida numa loja com Point', () => {
  function counterSale(): string {
    expect(st().login('1111').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const r = st().createCounterSale([{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null }]);
    if (!r.ok) throw new Error(r.error);
    return r.data.id;
  }
  function openSale() {
    render(<FichaRapidaScreen />);
    const box = screen.getByText('Vendas aguardando pagamento').parentElement!;
    fireEvent.click(within(box).getAllByRole('button')[0]!);
  }
  const cobrar = () => screen.getByRole('button', { name: /^Cobrar R\$/ });

  it('dinheiro: reserva antes de registrar; sem internet não registra', async () => {
    const id = counterSale();
    withPoint();
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' });
    openSale();
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(2));
    expect(payments(id)).toHaveLength(0);

    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => {
      claimLog.push(`claim:${payments(id).length}`);
      return CLAIM_OK(input.key, Math.round(input.amount * 100));
    });
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(payments(id)).toHaveLength(1));
    expect(claimLog).toEqual(['claim:0']);
    expect((claimPayment.mock.calls[2]![0] as { key: string }).key).toBe(payments(id)[0]!.idempotency_key);
  });

  it('SmartPOS: reserva antes da maquininha e recusa libera', async () => {
    const id = counterSale();
    withPoint();
    createDriver.mockReturnValue(fakeDriver('PAGBANK', declined()));
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => { claimLog.push('claim'); return CLAIM_OK(input.key, Math.round(input.amount * 100)); });
    openSale();
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(releasePaymentClaim).toHaveBeenCalledTimes(1));
    expect(claimLog).toEqual(['claim', 'charge']);
    expect(claimPayment.mock.calls[0]![0]).toMatchObject({ orderId: id, acquirer: 'PAGBANK' });
  });
});

describe('retirada (chargePickupOrder) numa loja com Point', () => {
  function pickupOrder() {
    expect(st().login('4444').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const r = st().createPickupOrder({ lines: [{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' }], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    if (!r.ok) throw new Error(r.error);
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    return r.data;
  }

  it('dinheiro: reserva antes de registrar; sem internet é ERROR sem pagamento', async () => {
    const o = pickupOrder();
    withPoint();
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' });
    expect(await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false })).toEqual({ status: 'ERROR', reason: 'Sem internet' });
    expect(payments(o.id)).toHaveLength(0);
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => {
      claimLog.push(`claim:${payments(o.id).length}`);
      return CLAIM_OK(input.key, Math.round(input.amount * 100));
    });
    expect((await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false })).status).toBe('APPROVED');
    expect(claimLog).toEqual(['claim:0']);
    expect((claimPayment.mock.calls[2]![0] as { key: string }).key).toBe(payments(o.id)[0]!.idempotency_key);
  });

  it('maquininha: recusa libera; revisão manual mantém', async () => {
    const o = pickupOrder();
    withPoint();
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => { claimLog.push('claim'); return CLAIM_OK(input.key, Math.round(input.amount * 100)); });
    createDriver.mockReturnValue(fakeDriver('STONE', declined()));
    expect((await chargePickupOrder({ orderId: o.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false })).status).toBe('DECLINED');
    expect(claimLog).toEqual(['claim', 'charge']);
    expect(releasePaymentClaim).toHaveBeenCalledTimes(1);
    createDriver.mockReturnValue(fakeDriver('STONE', review));
    expect((await chargePickupOrder({ orderId: o.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false })).status).toBe('MANUAL_REVIEW');
    expect(releasePaymentClaim).toHaveBeenCalledTimes(1);
    clearReviewHold(o.id);
  });

  it('aparelho sem nuvem: não pede reserva', async () => {
    const o = pickupOrder();
    localOnly();
    expect((await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false })).status).toBe('APPROVED');
    expect(claimPayment).not.toHaveBeenCalled();
  });
});

const claimsOf = (list: Array<{ key: string; cents: number; releasableAt?: string | null }>) => ({
  reservedCents: list.reduce((a, c) => a + c.cents, 0), openCharges: 0, manualReview: false, claimsCents: list.reduce((a, c) => a + c.cents, 0), charges: [],
  claims: list.map((c) => ({ idempotencyKey: c.key, amountCents: c.cents, method: 'CASH', acquirer: 'CASH_DESK', createdAt: '2026-11-14T10:00:00Z', createdBy: 's1', createdByName: 'Tião', activeUntil: null, releasableAt: c.releasableAt ?? null })),
});
function managerRelease(reason = 'Não recebi nenhum dinheiro', pin = '9999') {
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Motivo'), { target: { value: reason } });
  for (const d of pin) fireEvent.click(within(dialog).getByRole('button', { name: d }));
}

describe('revisão independente: reservas presas, conferência do extrato, falha fechada', () => {
  it('Checkout: reserva aberta de outro aparelho aparece com "Liberar reserva" (PIN de gerente, motivo 10+, aviso)', async () => {
    const id = openTable();
    withPoint();
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-preso', cents: 1500 }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Liberar reserva' }));
    expect(screen.getByText(/Use só se o pagamento NÃO aconteceu: nenhum dinheiro foi recebido e a maquininha não mostra aprovação/)).toBeTruthy();
    managerRelease();
    await waitFor(() => expect(releasePaymentClaimManager).toHaveBeenCalledWith('k-preso', '9999', 'Não recebi nenhum dinheiro'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Liberar reserva' })).toBeNull());
  });

  it('PIN recusado: mostra o erro e a reserva continua na lista', async () => {
    const id = openTable();
    withPoint();
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-preso', cents: 1500 }]));
    releasePaymentClaimManager.mockResolvedValue({ ok: false, pin: true, error: 'PIN de gerente incorreto ou bloqueado. Nada foi liberado.' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Liberar reserva' }));
    managerRelease('Não recebi nenhum dinheiro', '1234');
    await waitFor(() => expect(screen.getByText('PIN de gerente incorreto ou bloqueado. Nada foi liberado.')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'Liberar reserva' }).length).toBeGreaterThan(0);
  });

  it('a lista não oferece a reserva com pagamento registrado aqui nem a da trava de conferência', async () => {
    const id = openTable();
    withPoint();
    const p = st().registerPayment({ orderId: id, amount: 1, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'k-pago', item_ids: [] });
    expect(p.ok).toBe(true);
    setReviewHold({ order_id: id, amount: 2, reason: 'sem resposta', code: 'X', method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S', idempotency_key: 'k-trava' });
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-pago', cents: 100 }, { key: 'k-trava', cents: 200 }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect(fetchPointReservation).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: 'Liberar reserva' })).toBeNull();
  });

  it('erro no meio da cobrança: o registro local fica e a reserva aparece como "deste aparelho"', async () => {
    const id = openTable();
    withPoint();
    const driver = fakeDriver('STONE', declined());
    driver.charge.mockImplementation(async () => { throw new Error('ponte nativa caiu'); });
    createDriver.mockReturnValue(driver);
    let key = '';
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => { key = input.key; return CLAIM_OK(input.key, Math.round(input.amount * 100)); });
    const view = render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); await Promise.resolve(); });
    await waitFor(() => expect(driver.charge).toHaveBeenCalled());
    expect(localClaim(key)).toMatchObject({ key, order_id: id });
    expect(releasePaymentClaim).not.toHaveBeenCalled();
    view.unmount();
    fetchPointReservation.mockResolvedValue(claimsOf([{ key, cents: 500 }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText(/Este aparelho reservou e não viu a cobrança terminar/)).toBeTruthy();
  });

  it('"Conferi no extrato" (Stone) com Point: libera a reserva pelo gerente e só então tira a trava', async () => {
    const id = openTable();
    withPoint();
    setReviewHold({ order_id: id, amount: 2, reason: 'sem resposta', code: 'X', method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S', idempotency_key: 'k-trava' });
    releasePaymentClaimManager.mockResolvedValueOnce({ ok: false, error: 'Sem internet' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    managerRelease('Extrato da Stone sem a venda');
    await waitFor(() => expect(screen.getByText('Sem internet')).toBeTruthy());
    expect(getReviewHold(id)).not.toBeNull();
    // Reserva liberada (ou que não existia: a função devolve ok): a trava sai.
    managerRelease('Extrato da Stone sem a venda');
    await waitFor(() => expect(getReviewHold(id)).toBeNull());
    expect(releasePaymentClaimManager).toHaveBeenLastCalledWith('k-trava', '9999', 'Extrato da Stone sem a venda');
  });

  it('"Conferi no extrato": reserva que o servidor não tem (TF005) só tira a trava com o PIN do gerente conferido aqui', async () => {
    const id = openTable();
    withPoint();
    setReviewHold({ order_id: id, amount: 2, reason: 'sem resposta', code: 'X', method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S', idempotency_key: 'k-sumiu' });
    releasePaymentClaimManager.mockResolvedValue({ ok: true, notFound: true });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    managerRelease('Extrato da Stone sem a venda', '1234');
    await waitFor(() => expect(screen.getByText(/PIN de gerente inválido/)).toBeTruthy());
    expect(getReviewHold(id)).not.toBeNull();
    managerRelease('Extrato da Stone sem a venda', '9999');
    await waitFor(() => expect(getReviewHold(id)).toBeNull());
  });

  it('"Conferi no extrato" sem nuvem tira a trava como antes', async () => {
    const id = openTable();
    localOnly();
    setReviewHold({ order_id: id, amount: 2, reason: 'sem resposta', code: 'X', method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S', idempotency_key: 'k-trava' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    expect(getReviewHold(id)).toBeNull();
    expect(releasePaymentClaimManager).not.toHaveBeenCalled();
  });

  it('ligado à nuvem sem ter lido as maquininhas: o dinheiro pede a reserva', async () => {
    const id = openTable();
    withPoint(false, false);
    claimPayment.mockResolvedValue({ ok: false, code: 'TF010', error: 'Esta loja tem a Point: o pagamento precisa da reserva no servidor.' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(1));
    expect(payments(id)).toHaveLength(0);
  });

  it('Ficha (cartão): reserva recusada ou sem internet não chama a maquininha', async () => {
    expect(st().login('1111').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const sale = st().createCounterSale([{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null }]);
    if (!sale.ok) throw new Error(sale.error);
    withPoint();
    const driver = fakeDriver('STONE', declined());
    createDriver.mockReturnValue(driver);
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, code: 'TF003', error: 'saldo livre' });
    render(<FichaRapidaScreen />);
    const box = screen.getByText('Vendas aguardando pagamento').parentElement!;
    fireEvent.click(within(box).getAllByRole('button')[0]!);
    const cobrar = () => screen.getByRole('button', { name: /^Cobrar R\$/ });
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(2));
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(3));
    expect(driver.charge).not.toHaveBeenCalled();
    expect(st().pendingCharges).toHaveLength(0);
    expect(payments(sale.data.id)).toHaveLength(0);
  });

  it('retirada (cartão): reserva recusada ou sem internet não chama a maquininha', async () => {
    expect(st().login('4444').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const r = st().createPickupOrder({ lines: [{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' }], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    if (!r.ok) throw new Error(r.error);
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    withPoint();
    const driver = fakeDriver('STONE', declined());
    createDriver.mockReturnValue(driver);
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, code: 'TF010', error: 'Esta loja tem a Point: o pagamento precisa da reserva no servidor.' });
    expect(await chargePickupOrder({ orderId: r.data.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false })).toEqual({ status: 'ERROR', reason: 'Sem internet' });
    expect(await chargePickupOrder({ orderId: r.data.id, method: 'DEBIT', chassis: 'STONE', kitchenPreview: false })).toEqual({ status: 'ERROR', reason: 'Esta loja tem a Point: o pagamento precisa da reserva no servidor.' });
    expect(driver.charge).not.toHaveBeenCalled();
    expect(st().pendingCharges).toHaveLength(0);
  });
});

const approved = (acquirer: 'STONE' | 'PAGBANK'): TerminalResult => ({
  status: 'APPROVED', acquirer, acquirer_cnpj: '00.000.000/0001-00', card_brand: 'VISA', nsu: '123', authorization_code: 'A1',
  terminal_serial: 'S1', terminal_id: null, masked_pan: null, mode: 'TEF_POS_WIRELESS',
} as TerminalResult);

type Outcome = 'recusada' | 'sem internet' | 'falhou';
const OUTCOMES: Outcome[] = ['recusada', 'sem internet', 'falhou'];
function failClaim(o: Outcome) {
  if (o === 'recusada') claimPayment.mockResolvedValue({ ok: false, code: 'TF010', error: 'Esta loja tem a Point: o pagamento precisa da reserva no servidor.' });
  else if (o === 'sem internet') claimPayment.mockResolvedValue({ ok: false, offline: true, error: 'Sem internet' });
  else claimPayment.mockRejectedValue(new Error('erro inesperado'));
}
/** Sem resposta (ou exceção): uma nova tentativa com a mesma chave e o mesmo segredo. */
const attempts = (o: Outcome) => (o === 'recusada' ? 1 : 2);
const MATRIX = (['CASH', 'STONE', 'PAGBANK'] as const).flatMap((m) => OUTCOMES.map((o) => [m, o] as const));

describe('r7 P0-01: lista de maquininhas velha (sem Point aqui, já sincronizada) ainda pede a reserva', () => {
  it.each(MATRIX)('caixa da mesa · %s · reserva %s: bloqueia, sem maquininha e sem pagamento', async (method, outcome) => {
    const id = openTable();
    withPoint(false, true);
    failClaim(outcome);
    const driver = fakeDriver(method === 'CASH' ? 'STONE' : method, approved(method === 'CASH' ? 'STONE' : method));
    createDriver.mockReturnValue(driver);
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    if (method === 'CASH') fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(attempts(outcome)));
    await act(async () => { await Promise.resolve(); });
    expect(driver.charge).not.toHaveBeenCalled();
    expect(payments(id)).toHaveLength(0);
    expect(st().pendingCharges).toHaveLength(0);
  });

  it.each(MATRIX)('ficha rápida · %s · reserva %s: bloqueia, sem maquininha e sem pagamento', async (method, outcome) => {
    expect(st().login('1111').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const sale = st().createCounterSale([{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null }]);
    if (!sale.ok) throw new Error(sale.error);
    withPoint(false, true);
    failClaim(outcome);
    const driver = fakeDriver(method === 'CASH' ? 'STONE' : method, approved(method === 'CASH' ? 'STONE' : method));
    createDriver.mockReturnValue(driver);
    render(<FichaRapidaScreen />);
    const box = screen.getByText('Vendas aguardando pagamento').parentElement!;
    fireEvent.click(within(box).getAllByRole('button')[0]!);
    if (method === 'CASH') fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Cobrar R\$/ })); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(attempts(outcome)));
    await act(async () => { await Promise.resolve(); });
    expect(driver.charge).not.toHaveBeenCalled();
    expect(payments(sale.data.id)).toHaveLength(0);
  });

  it.each(MATRIX)('retirada · %s · reserva %s: ERROR, sem maquininha e sem pagamento', async (method, outcome) => {
    expect(st().login('4444').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const r = st().createPickupOrder({ lines: [{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' }], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    if (!r.ok) throw new Error(r.error);
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    withPoint(false, true);
    failClaim(outcome);
    const driver = fakeDriver(method === 'CASH' ? 'STONE' : method, approved(method === 'CASH' ? 'STONE' : method));
    createDriver.mockReturnValue(driver);
    const out = await chargePickupOrder({ orderId: r.data.id, method: method === 'CASH' ? 'CASH' : 'CREDIT', chassis: method === 'PAGBANK' ? 'PAGBANK' : 'STONE', kitchenPreview: false });
    expect(out.status).toBe('ERROR');
    expect(claimPayment).toHaveBeenCalledTimes(attempts(outcome));
    expect(claimPayment.mock.calls[0]![0]).toMatchObject({ acquirer: method === 'CASH' ? 'CASH_DESK' : method });
    expect(driver.charge).not.toHaveBeenCalled();
    expect(payments(r.data.id)).toHaveLength(0);
  });
});

describe('r7 P0-02: gerente liberou a reserva durante a cobrança', () => {
  const okClaim = () => claimPayment.mockImplementation(async (input: { key: string; amount: number }) => CLAIM_OK(input.key, Math.round(input.amount * 100)));

  it('caixa da mesa: a maquininha aprovou, mas não registra; trava a conta e avisa para estornar', async () => {
    const id = openTable();
    withPoint();
    okClaim();
    createDriver.mockReturnValue(fakeDriver('STONE', approved('STONE')));
    touchPaymentClaim.mockResolvedValue({ ok: true, status: 'released', activeUntil: null });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(getReviewHold(id)).not.toBeNull());
    expect(getReviewHold(id)).toMatchObject({ code: 'CLAIM_RELEASED', reason: 'A reserva foi liberada pelo gerente durante a cobrança: confira e estorne na maquininha' });
    expect(payments(id)).toHaveLength(0);
    expect(releasePaymentClaim).not.toHaveBeenCalled();
    expect((await screen.findAllByText(/A reserva foi liberada pelo gerente durante a cobrança/)).length).toBeGreaterThan(0);
  });

  it('ficha rápida e retirada: mesma regra (sem registro, trava CLAIM_RELEASED)', async () => {
    expect(st().login('1111').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const sale = st().createCounterSale([{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null }]);
    if (!sale.ok) throw new Error(sale.error);
    withPoint();
    okClaim();
    createDriver.mockReturnValue(fakeDriver('PAGBANK', approved('PAGBANK')));
    touchPaymentClaim.mockResolvedValue({ ok: true, status: 'released', activeUntil: null });
    render(<FichaRapidaScreen />);
    const box = screen.getByText('Vendas aguardando pagamento').parentElement!;
    fireEvent.click(within(box).getAllByRole('button')[0]!);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Cobrar R\$/ })); });
    await waitFor(() => expect(getReviewHold(sale.data.id)).toMatchObject({ code: 'CLAIM_RELEASED' }));
    expect(payments(sale.data.id).filter((x) => x.status === 'APPROVED')).toHaveLength(0);
    cleanup();

    st().logout();
    expect(st().login('4444').ok).toBe(true);
    const r = st().createPickupOrder({ lines: [{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' }], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    if (!r.ok) throw new Error(r.error);
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    createDriver.mockReturnValue(fakeDriver('STONE', approved('STONE')));
    expect(await chargePickupOrder({ orderId: r.data.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false })).toEqual({
      status: 'MANUAL_REVIEW', reason: 'A reserva foi liberada pelo gerente durante a cobrança: confira e estorne na maquininha',
    });
    expect(getReviewHold(r.data.id)).toMatchObject({ code: 'CLAIM_RELEASED' });
    expect(payments(r.data.id)).toHaveLength(0);
    clearReviewHold(r.data.id);
  });

  it('reserva com batimento recente (liberável no futuro): "Em andamento (outro aparelho)" e botão desligado', async () => {
    const id = openTable();
    withPoint();
    const later = new Date(Date.now() + 4 * 60_000);
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-rodando', cents: 900, releasableAt: later.toISOString() }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    const hhmm = later.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    expect(await screen.findByText(`Em andamento (outro aparelho) — liberável às ${hhmm} (horário de Brasília)`)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Liberar reserva' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('TF011 do servidor ao liberar: mostra a mensagem e a reserva continua', async () => {
    const id = openTable();
    withPoint();
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-preso', cents: 1500, releasableAt: new Date(Date.now() - 60_000).toISOString() }]));
    releasePaymentClaimManager.mockResolvedValue({ ok: false, active: true, error: 'Reserva em andamento (outro aparelho): ainda não pode ser liberada.' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Liberar reserva' }));
    managerRelease();
    expect(await screen.findByText('Reserva em andamento (outro aparelho): ainda não pode ser liberada.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Liberar reserva' }).length).toBeGreaterThan(0);
  });
});

describe('r7 P2-01 e release_token na lista de reservas', () => {
  it('pagamento RECUSADO aqui com a chave não esconde a reserva', async () => {
    const id = openTable();
    withPoint();
    st().registerPayment({ orderId: id, amount: 1, method: 'CREDIT', status: 'DECLINED', terminal_id: null, acquirer: 'STONE', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: 'S1', idempotency_key: 'k-recusado', item_ids: [] });
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-recusado', cents: 100 }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(((await screen.findByRole('button', { name: 'Liberar reserva' })) as HTMLButtonElement).disabled).toBe(false);
  });

  it('liberação pendente com o código: mostra o erro, nunca o código, e o gerente pode liberar', async () => {
    const id = openTable();
    withPoint();
    addPendingRelease({ key: 'k-pend', order_id: id, reason: 'recusou', release_token: 'segredo-zz-123', last_error: 'Sem internet' });
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-pend', cents: 300 }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText(/a liberação automática ainda não chegou ao servidor \(Sem internet\)/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('segredo-zz-123');
    const btn = screen.getByRole('button', { name: 'Liberar reserva' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('sem o código (repetição idempotente, registro perdido): a lista diz que só o gerente libera, e libera', async () => {
    const id = openTable();
    withPoint();
    addPendingRelease({ key: 'k-sem', order_id: id, reason: 'recusou', release_token: null, last_error: 'x' });
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-sem', cents: 300 }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText('Nada foi cobrado, mas este aparelho não tem o código desta reserva: só o gerente libera.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Liberar reserva' }));
    managerRelease();
    await waitFor(() => expect(releasePaymentClaimManager).toHaveBeenCalledWith('k-sem', '9999', 'Não recebi nenhum dinheiro'));
  });

  it('recusa na maquininha: o código da reserva vai para a liberação e não aparece na tela', async () => {
    const id = openTable();
    withPoint();
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => CLAIM_OK(input.key, Math.round(input.amount * 100)));
    createDriver.mockReturnValue(fakeDriver('STONE', declined()));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(releasePaymentClaim).toHaveBeenCalledTimes(1));
    const token = (claimPayment.mock.calls[0]![0] as { releaseToken: string }).releaseToken;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(releasePaymentClaim.mock.calls[0]![3]).toBe(token);
    expect(document.body.innerHTML).not.toContain(token);
  });
});

describe('r7 revisão: trava CLAIM_RELEASED, comprovante, adquirente, aviso e retirada', () => {
  const releasedHold = (orderId: string, key = 'k-liberada') => setReviewHold({
    order_id: orderId, amount: 5, reason: 'A reserva foi liberada pelo gerente durante a cobrança: confira e estorne na maquininha', code: 'CLAIM_RELEASED',
    method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S1', idempotency_key: key,
  });
  function managerAuth(reason: string, pin = '9999') {
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Descreva o motivo…'), { target: { value: reason } });
    for (const d of pin) fireEvent.click(within(dialog).getByRole('button', { name: d }));
  }

  it('caixa da mesa: com CLAIM_RELEASED nem dinheiro recebe; sem "registrar comprovante"; "Estornei / devolvi" com PIN: o servidor registra primeiro; sem resposta a trava fica', async () => {
    const id = openTable();
    withPoint();
    setReviewHoldState(id);
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect(fetchPointReservation).toHaveBeenCalled());
    expect((chargeButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(chargeButton()); });
    expect(claimPayment).not.toHaveBeenCalled();
    expect(payments(id)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Maquininha aprovou: registrar comprovante' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conferi no extrato: não foi cobrado' })).toBeNull();
    expect(screen.getByText(/Estorne \(cancele a venda\) na maquininha/)).toBeTruthy();
    const outboxBefore = st().outbox.length;
    // Sem resposta do servidor: a trava fica.
    authorizeClaimRefunded.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem conexão com o servidor.' });
    fireEvent.click(screen.getByRole('button', { name: 'Estornei / devolvi' }));
    managerAuth('Venda estornada na maquininha Stone');
    expect(await screen.findByText('Sem conexão com o servidor.')).toBeTruthy();
    expect(getReviewHold(id)).toMatchObject({ code: 'CLAIM_RELEASED' });
    for (const d of '9999') fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: d }));
    // O PIN completo confirma (como nas outras autorizações de gerente).
    await waitFor(() => expect(getReviewHold(id)).toBeNull());
    expect(authorizeClaimRefunded).toHaveBeenLastCalledWith('k-liberada', '9999', 'Venda estornada na maquininha Stone', { refund_kind: 'card' }, undefined);
    expect(st().auditLogs[0]).toMatchObject({ action_type: 'CLAIM_RELEASED_REFUNDED', order_id: id, reason: 'Venda estornada na maquininha Stone' });
    expect(st().auditLogs[0]!.metadata).toMatchObject({ server_audit_id: '11111111-2222-4333-8444-555555555555' });
    // Não sobe pela fila: o servidor já gravou o audit_log dele.
    expect(st().outbox.length).toBe(outboxBefore);
    // O registro pelo comprovante também recusa direto na loja.
    releasedHold(id);
    expect(st().confirmReviewedCharge({ orderId: id, nsu: '123456', authorization_code: 'AB12', card_brand: null, method: 'CREDIT', acquirer: 'STONE' }, { managerPin: '9999', reason: 'Maquininha aprovou, conferido' }).ok).toBe(false);
    clearReviewHold(id);
  });
  function setReviewHoldState(orderId: string) { releasedHold(orderId); }

  it('ficha rápida: com CLAIM_RELEASED não há "Cobrar" nem comprovante, só o estorno', async () => {
    expect(st().login('1111').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const sale = st().createCounterSale([{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null }]);
    if (!sale.ok) throw new Error(sale.error);
    withPoint();
    releasedHold(sale.data.id);
    render(<FichaRapidaScreen />);
    const box = screen.getByText('Vendas aguardando pagamento').parentElement!;
    fireEvent.click(within(box).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    expect(screen.queryByRole('button', { name: /^Cobrar R\$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Maquininha aprovou: registrar comprovante' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Estornei / devolvi' })).toBeTruthy();
    expect(claimPayment).not.toHaveBeenCalled();
    clearReviewHold(sale.data.id);
  });

  async function openReceiptAndSubmit() {
    fireEvent.click(screen.getByRole('button', { name: 'Maquininha aprovou: registrar comprovante' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Só números'), { target: { value: '445566' } });
    fireEvent.change(within(dialog).getByPlaceholderText('Letras e números'), { target: { value: 'AB12CD' } });
    for (const d of '9999') fireEvent.click(within(dialog).getByRole('button', { name: d }));
  }

  it('registrar comprovante confere a reserva antes: liberada vira CLAIM_RELEASED sem registrar; sem resposta recusa; aberta registra', async () => {
    const id = openTable();
    withPoint();
    beginLocalClaim('k-falhou', id, 'ef'.repeat(32));
    settleLocalClaim('k-falhou');
    setReviewHold({ order_id: id, amount: 5, reason: 'Aprovado na maquininha, mas não registrado', code: 'REGISTER_FAILED', method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S1', idempotency_key: 'k-falhou' });

    touchPaymentClaim.mockResolvedValueOnce({ ok: false, offline: true, error: 'rede' });
    const view = render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await openReceiptAndSubmit();
    expect(await screen.findByText('Sem conexão com o servidor para conferir a reserva: tente de novo.')).toBeTruthy();
    expect(touchPaymentClaim).toHaveBeenCalledWith('k-falhou', 'ef'.repeat(32));
    expect(payments(id)).toHaveLength(0);
    view.unmount();

    touchPaymentClaim.mockResolvedValueOnce({ ok: true, status: 'released', activeUntil: null });
    const v2 = render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await openReceiptAndSubmit();
    await waitFor(() => expect(getReviewHold(id)).toMatchObject({ code: 'CLAIM_RELEASED' }));
    expect(payments(id)).toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Estornei / devolvi' })).toBeTruthy();
    v2.unmount();

    setReviewHold({ order_id: id, amount: 5, reason: 'Aprovado na maquininha, mas não registrado', code: 'REGISTER_FAILED', method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S1', idempotency_key: 'k-falhou' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await openReceiptAndSubmit();
    await waitFor(() => expect(payments(id).filter((x) => x.status === 'APPROVED')).toHaveLength(1));
    expect(getReviewHold(id)).toBeNull();
  });

  it('P1-1 outra adquirente: PIN errado não troca a reserva; troca já pedida não confere a antiga e repete a mesma troca', async () => {
    const id = openTable();
    withPoint();
    const amount = st().orders.find((o) => o.id === id)!.remaining_balance;
    beginLocalClaim('k-velha', id, 'ef'.repeat(32));
    settleLocalClaim('k-velha');
    setReviewHold({ order_id: id, amount, reason: 'outra adquirente', code: 'ACQUIRER_MISMATCH', method: 'CREDIT', acquirer: 'PAGBANK', terminal_id: null, terminal_serial: 'S1', idempotency_key: 'k-velha' });
    const view = render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Maquininha aprovou: registrar comprovante' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Só números'), { target: { value: '445566' } });
    fireEvent.change(within(dialog).getByPlaceholderText('Letras e números'), { target: { value: 'AB12CD' } });
    for (const d of '1234') fireEvent.click(within(dialog).getByRole('button', { name: d }));
    expect(await screen.findByText(/PIN de gerente inválido/)).toBeTruthy();
    expect(reclaimPayment).not.toHaveBeenCalled();
    expect(touchPaymentClaim).not.toHaveBeenCalled();
    view.unmount();

    // Primeira troca ficou sem resposta: a chave nova fica na trava. Na volta, a antiga (já liberada pela troca) não é conferida.
    reclaimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'rede' }).mockResolvedValueOnce({ ok: false, offline: true, error: 'rede' });
    const v2 = render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await openReceiptAndSubmit();
    await waitFor(() => expect(reclaimPayment).toHaveBeenCalledTimes(2));
    const first = reclaimPayment.mock.calls[0]![0] as { newKey: string; newToken: string };
    await waitFor(() => expect(getReviewHold(id)?.reclaim_key).toBe(first.newKey));
    v2.unmount();
    touchPaymentClaim.mockClear();
    touchPaymentClaim.mockResolvedValue({ ok: true, status: 'released', activeUntil: null });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await openReceiptAndSubmit();
    await waitFor(() => expect(payments(id).filter((x) => x.status === 'APPROVED')).toHaveLength(1));
    expect(touchPaymentClaim).not.toHaveBeenCalledWith('k-velha', expect.anything());
    const last = reclaimPayment.mock.calls.at(-1)![0] as { newKey: string; newToken: string };
    expect([last.newKey, last.newToken]).toEqual([first.newKey, first.newToken]);
    expect(payments(id)[0]).toMatchObject({ idempotency_key: first.newKey, acquirer: 'PAGBANK' });
    expect(getReviewHold(id)).toBeNull();
  });

  it('a maquininha aprova por outra adquirente que a reservada: não registra, trava ACQUIRER_MISMATCH', async () => {
    const id = openTable();
    withPoint();
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => CLAIM_OK(input.key, Math.round(input.amount * 100)));
    createDriver.mockReturnValue(fakeDriver('STONE', approved('PAGBANK')));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(getReviewHold(id)).toMatchObject({ code: 'ACQUIRER_MISMATCH' }));
    expect(payments(id)).toHaveLength(0);
    clearReviewHold(id);
  });

  it('só reservas de pagamento (sem Point): o aviso diz "pagamento reservado aguardando envio ao servidor"', async () => {
    const id = openTable();
    withPoint();
    fetchPointReservation.mockResolvedValue({ ...claimsOf([{ key: 'k-x', cents: 300 }]), pointCents: 0 });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText('Há um pagamento reservado aguardando envio ao servidor')).toBeTruthy();
    expect(screen.queryByText('Há uma cobrança na Point em andamento nesta conta')).toBeNull();
  });

  it('reserva deste aparelho com batimento recente: "Em andamento" sem "(outro aparelho)"', async () => {
    const id = openTable();
    withPoint();
    beginLocalClaim('k-minha', id, 'aa'.repeat(32));
    const { detachLocalClaim } = await import('../lib/payments/claimLedger');
    detachLocalClaim('k-minha');
    const later = new Date(Date.now() + 4 * 60_000);
    fetchPointReservation.mockResolvedValue(claimsOf([{ key: 'k-minha', cents: 900, releasableAt: later.toISOString() }]));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    const hhmm = later.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    expect(await screen.findByText(`Em andamento — liberável às ${hhmm} (horário de Brasília)`)).toBeTruthy();
  });

  it('trava criada fora da tela (laço de sincronização) aparece na hora', async () => {
    const id = openTable();
    withPoint();
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Estornei / devolvi' })).toBeNull();
    act(() => { releasedHold(id); });
    expect(await screen.findByRole('button', { name: 'Estornei / devolvi' })).toBeTruthy();
    clearReviewHold(id);
  });

  function pickupOrderFor() {
    expect(st().login('4444').ok).toBe(true);
    const p = st().products.find((x) => x.code === '222')!;
    const r = st().createPickupOrder({ lines: [{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' }], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    if (!r.ok) throw new Error(r.error);
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    return r.data;
  }

  it('retirada: batimento vê a liberação no meio da cobrança; a aprovação não é registrada e nada é cancelado na maquininha', async () => {
    const o = pickupOrderFor();
    withPoint();
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => CLAIM_OK(input.key, Math.round(input.amount * 100)));
    let finish: (r: TerminalResult) => void = () => undefined;
    const driver = fakeDriver('STONE', new Promise<TerminalResult>((r) => { finish = r; }));
    createDriver.mockReturnValue(driver);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const run = chargePickupOrder({ orderId: o.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false });
      await vi.waitFor(() => expect(driver.charge).toHaveBeenCalled());
      touchPaymentClaim.mockResolvedValue({ ok: true, status: 'released', activeUntil: null });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(touchPaymentClaim).toHaveBeenCalledTimes(1);
      finish(approved('STONE'));
      expect(await run).toEqual({ status: 'MANUAL_REVIEW', reason: 'A reserva foi liberada pelo gerente durante a cobrança: confira e estorne na maquininha' });
      expect(touchPaymentClaim).toHaveBeenCalledTimes(1);
      expect(driver.abort).not.toHaveBeenCalled();
      expect(payments(o.id)).toHaveLength(0);
      expect(getReviewHold(o.id)).toMatchObject({ code: 'CLAIM_RELEASED' });
    } finally {
      vi.useRealTimers();
      clearReviewHold(o.id);
    }
  });

  it('retirada em dinheiro com erro inesperado no registro: o batimento para (leave) e o registro local fica', async () => {
    const o = pickupOrderFor();
    withPoint();
    let key = '';
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => { key = input.key; return CLAIM_OK(input.key, Math.round(input.amount * 100)); });
    const original = st().registerPayment;
    useTcheStore.setState({ registerPayment: () => { throw new Error('banco local caiu'); } } as never);
    try {
      await expect(chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false })).rejects.toThrow('banco local caiu');
    } finally {
      useTcheStore.setState({ registerPayment: original } as never);
    }
    expect(isClaimActiveHere(key)).toBe(false);
    expect(localClaim(key)).toMatchObject({ key, state: 'charging' });
  });
});
