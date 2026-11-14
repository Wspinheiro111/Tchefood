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
import { localClaim, resetClaimLedger } from '../lib/payments/claimLedger';
import type { IPaymentTerminalDriver, TerminalResult } from '../lib/payments/drivers';
import type { PosTerminal } from '../types';

const claimLog: string[] = [];
const claimPayment = vi.fn();
const releasePaymentClaim = vi.fn();
const releasePaymentClaimManager = vi.fn();
const fetchPointReservation = vi.fn();
const createDriver = vi.fn();

vi.mock('../lib/payments/paymentClaim', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/paymentClaim')>()),
  claimPayment: (...a: unknown[]) => claimPayment(...a),
  releaseClaimAfterNoCharge: (...a: unknown[]) => releasePaymentClaim(...a),
  releasePaymentClaimManager: (...a: unknown[]) => releasePaymentClaimManager(...a),
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
  releasePaymentClaimManager.mockReset().mockResolvedValue({ ok: true });
  resetClaimLedger();
  fetchPointReservation.mockReset().mockResolvedValue(NO_RESERVATION);
  createDriver.mockReset();
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
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(1));
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

  it('loja sem Point: nada muda (sem reserva e sem bloqueio pela leitura da nuvem)', async () => {
    const id = openTable();
    withPoint(false);
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
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' });
    openSale();
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(1));
    expect(payments(id)).toHaveLength(0);

    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => {
      claimLog.push(`claim:${payments(id).length}`);
      return CLAIM_OK(input.key, Math.round(input.amount * 100));
    });
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(payments(id)).toHaveLength(1));
    expect(claimLog).toEqual(['claim:0']);
    expect((claimPayment.mock.calls[1]![0] as { key: string }).key).toBe(payments(id)[0]!.idempotency_key);
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
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' });
    expect(await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false })).toEqual({ status: 'ERROR', reason: 'Sem internet' });
    expect(payments(o.id)).toHaveLength(0);
    claimPayment.mockImplementation(async (input: { key: string; amount: number }) => {
      claimLog.push(`claim:${payments(o.id).length}`);
      return CLAIM_OK(input.key, Math.round(input.amount * 100));
    });
    expect((await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false })).status).toBe('APPROVED');
    expect(claimLog).toEqual(['claim:0']);
    expect((claimPayment.mock.calls[1]![0] as { key: string }).key).toBe(payments(o.id)[0]!.idempotency_key);
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

  it('loja sem Point: não pede reserva', async () => {
    const o = pickupOrder();
    withPoint(false);
    expect((await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', kitchenPreview: false })).status).toBe('APPROVED');
    expect(claimPayment).not.toHaveBeenCalled();
  });
});

const claimsOf = (list: Array<{ key: string; cents: number }>) => ({
  reservedCents: list.reduce((a, c) => a + c.cents, 0), openCharges: 0, manualReview: false, claimsCents: list.reduce((a, c) => a + c.cents, 0), charges: [],
  claims: list.map((c) => ({ idempotencyKey: c.key, amountCents: c.cents, method: 'CASH', acquirer: 'CASH_DESK', createdAt: '2026-11-14T10:00:00Z', createdBy: 's1', createdByName: 'Tião' })),
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

  it('"Conferi no extrato" em loja sem Point tira a trava como antes', async () => {
    const id = openTable();
    withPoint(false);
    setReviewHold({ order_id: id, amount: 2, reason: 'sem resposta', code: 'X', method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S', idempotency_key: 'k-trava' });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    expect(getReviewHold(id)).toBeNull();
    expect(releasePaymentClaimManager).not.toHaveBeenCalled();
  });

  it('falha fechada: ligado à nuvem sem ter lido as maquininhas, o dinheiro pede a reserva', async () => {
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
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, code: 'TF003', error: 'saldo livre' });
    render(<FichaRapidaScreen />);
    const box = screen.getByText('Vendas aguardando pagamento').parentElement!;
    fireEvent.click(within(box).getAllByRole('button')[0]!);
    const cobrar = () => screen.getByRole('button', { name: /^Cobrar R\$/ });
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(cobrar()); });
    await waitFor(() => expect(claimPayment).toHaveBeenCalledTimes(2));
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
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'Sem internet' }).mockResolvedValueOnce({ ok: false, code: 'TF010', error: 'Esta loja tem a Point: o pagamento precisa da reserva no servidor.' });
    expect(await chargePickupOrder({ orderId: r.data.id, method: 'CREDIT', chassis: 'STONE', kitchenPreview: false })).toEqual({ status: 'ERROR', reason: 'Sem internet' });
    expect(await chargePickupOrder({ orderId: r.data.id, method: 'DEBIT', chassis: 'STONE', kitchenPreview: false })).toEqual({ status: 'ERROR', reason: 'Esta loja tem a Point: o pagamento precisa da reserva no servidor.' });
    expect(driver.charge).not.toHaveBeenCalled();
    expect(st().pendingCharges).toHaveLength(0);
  });
});
