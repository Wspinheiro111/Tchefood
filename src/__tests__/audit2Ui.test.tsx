// @vitest-environment jsdom
/** Auditoria interna 2 do PR #49 (revisor de telas): cada achado conferido com o teste que falhava antes. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold, getReviewHold } from '../lib/payments/reviewHolds';
import { resetClaimLedger } from '../lib/payments/claimLedger';
import { useToast } from '../components/ui';
import type { IPaymentTerminalDriver, TerminalResult } from '../lib/payments/drivers';
import type { Payment, PosTerminal } from '../types';
import { RESERVED_EXCEEDS_BALANCE } from '../lib/payments/pointReservation';

const claimPayment = vi.fn();
const releasePaymentClaim = vi.fn();
const fetchPointReservation = vi.fn();
const createDriver = vi.fn();
const touchPaymentClaim = vi.fn();
const refundPointPayment = vi.fn();
const reconcilePointCharge = vi.fn();
const pointPaymentOnServer = vi.fn();
const releaseManager = vi.fn();

vi.mock('../lib/payments/paymentClaim', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/paymentClaim')>()),
  claimPayment: (...a: unknown[]) => claimPayment(...a),
  releaseClaimAfterNoCharge: (...a: unknown[]) => releasePaymentClaim(...a),
  touchPaymentClaim: (...a: unknown[]) => touchPaymentClaim(...a),
  releasePaymentClaimManager: (...a: unknown[]) => releaseManager(...a),
}));
vi.mock('../lib/payments/pointReconcile', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/pointReconcile')>()),
  refundPointPayment: (...a: unknown[]) => refundPointPayment(...a),
  reconcilePointCharge: (...a: unknown[]) => reconcilePointCharge(...a),
  pointPaymentOnServer: (...a: unknown[]) => pointPaymentOnServer(...a),
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
const { PickupCounterScreen } = await import('../screens/PickupCounterScreen');
const { rememberServerReservation, reservationExceeds } = await import('../lib/payments/pointReservation');
const { PointRefunds } = await import('../components/PointRefund');
const { ManagerAuthSheet } = await import('../components/ManagerAuthSheet');
const { CLAIM_ERRORS, MANAGER_RELEASE_REFUSED } = await import('../lib/payments/paymentClaim');
const { ReleaseClaimSheet, RELEASE_NOT_FOUND } = await import('../components/StuckClaims');
const { rememberPointChargeHere } = await import('../lib/payments/pointChargesHere');

const st = () => useTcheStore.getState();
const MP_TERMINAL: PosTerminal = { id: 'mp-term', tenant_id: 'x', name: 'Point Salão', serial_number: 'MP-SERIAL', acquirer: 'MERCADO_PAGO', mode: 'TEF_POS_WIRELESS', online: true, battery_level: 90 };
const NO_RESERVATION = { reservedCents: 0, openCharges: 0, manualReview: false, charges: [], claims: [] };
const toasts = () => useToast.getState().toasts.map((t: { text?: string; message?: string }) => t.text ?? t.message ?? JSON.stringify(t));

function fakeDriver(acquirer: 'STONE' | 'MERCADO_PAGO', result: TerminalResult | Promise<TerminalResult>) {
  return {
    acquirer, mode: 'TEF_POS_WIRELESS', terminal: null,
    charge: vi.fn(async () => result), print: vi.fn(async () => undefined), abort: vi.fn(),
  } as unknown as IPaymentTerminalDriver & { charge: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
}

function withCloud(point = true) {
  act(() => {
    useTcheStore.setState({
      terminals: point ? [...st().terminals, MP_TERMINAL] : st().terminals,
      pullStatus: { last_pull_at: '2026-11-14T10:00:00Z', last_error: null, cloud_staff_unknown: 0 },
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
    order_id: r.data.id, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
    meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector,
  });
  if (!t.ok) throw new Error(t.error);
  st().dispatchTray(r.data.id);
  expect(st().startCheckout(r.data.id).ok).toBe(true);
  return r.data.id;
}

const chargeButton = () => screen.getByRole('button', { name: /^(Enviar para maquininha|Cobrar na SmartPOS|Receber) R\$/ });

beforeEach(() => {
  st().resetDemo();
  try { localStorage.clear(); } catch { /* sem armazenamento */ }
  for (const o of st().orders) clearReviewHold(o.id);
  claimPayment.mockReset().mockImplementation(async (i: { key: string; amount: number }) => ({ ok: true, claim: { id: 'c', idempotency_key: i.key, status: 'open', amount_cents: Math.round(i.amount * 100) } }));
  releasePaymentClaim.mockReset().mockResolvedValue({ ok: true });
  touchPaymentClaim.mockReset().mockResolvedValue({ ok: true, status: 'open', activeUntil: null });
  fetchPointReservation.mockReset().mockResolvedValue(NO_RESERVATION);
  createDriver.mockReset();
  refundPointPayment.mockReset();
  resetClaimLedger();
  useToast.setState({ toasts: [] } as never);
});
afterEach(() => cleanup());

function mpPayment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-mp-1', order_id: 'o1', amount: 50, method: 'CREDIT', status: 'APPROVED', terminal_id: 'mp-term', acquirer: 'MERCADO_PAGO',
    acquirer_cnpj: '10573521000191', card_brand: 'VISA', nsu: '123456', authorization_code: 'A1B2C3', terminal_serial: 'MP-SERIAL',
    idempotency_key: 'mp-key-1', item_ids: [], created_at: new Date().toISOString(), ...over,
  } as Payment;
}


function pointCharge(over: Record<string, unknown>) {
  return { idempotencyKey: 'k', status: 'approved', amountCents: 1000, rawStatusDetail: null, hasPayment: false, stale: false, ...over };
}

describe('auditoria 2 — telas', () => {
  it('P1: aprovada sem pagamento de outro aparelho, antes do prazo: sem "Resolver"; texto de espera', async () => {
    const id = openTable();
    withCloud();
    fetchPointReservation.mockResolvedValue({ reservedCents: 1000, pointCents: 1000, claimsCents: 0, openCharges: 1, manualReview: false, charges: [pointCharge({ idempotencyKey: 'aparelho-A' })], claims: [] });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText(/aguardando o pagamento do aparelho que cobrou/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resolver cobrança da Point' })).toBeNull();
  });

  it('P1: aprovada sem pagamento e vencida (stale): "Resolver" aparece', async () => {
    const id = openTable();
    withCloud();
    fetchPointReservation.mockResolvedValue({ reservedCents: 1000, pointCents: 1000, claimsCents: 0, openCharges: 1, manualReview: false, charges: [pointCharge({ idempotencyKey: 'aparelho-A', stale: true })], claims: [] });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Resolver cobrança da Point' })).toBeTruthy();
    expect(screen.getByText(/aprovada sem pagamento registrado/)).toBeTruthy();
  });

  it('P1/P2-3: aprovada sem pagamento, cobrança iniciada neste aparelho (app recarregado antes do registro): "Resolver" já', async () => {
    const id = openTable();
    withCloud();
    rememberPointChargeHere('minha', id);
    fetchPointReservation.mockResolvedValue({ reservedCents: 1000, pointCents: 1000, claimsCents: 0, openCharges: 1, manualReview: false, charges: [pointCharge({ idempotencyKey: 'minha' })], claims: [] });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText(/aprovada neste aparelho, sem pagamento registrado/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resolver cobrança da Point' })).toBeTruthy();
  });

  it('P2-1: Point aprovada aqui, antes de a fila subir: não conta de novo, sem "Resolver", e a 2a cota passa', async () => {
    const id = openTable();
    withCloud();
    const total = st().orders.find((o) => o.id === id)!.remaining_balance;
    const half = Math.round(total * 50) / 100;
    const r = st().registerPayment({
      orderId: id, amount: half, method: 'CREDIT', status: 'APPROVED', terminal_id: 'mp-term', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
      card_brand: 'VISA', nsu: '999', authorization_code: 'AB12', terminal_serial: 'MP-SERIAL', idempotency_key: 'mine-approved', item_ids: [],
    });
    expect(r.ok).toBe(true);
    fetchPointReservation.mockResolvedValue({
      reservedCents: Math.round(half * 100), pointCents: Math.round(half * 100), claimsCents: 0, openCharges: 1, manualReview: false,
      charges: [pointCharge({ idempotencyKey: 'mine-approved', amountCents: Math.round(half * 100), stale: true })], claims: [],
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(fetchPointReservation).toHaveBeenCalled());
    expect(screen.queryByText('Há uma cobrança na Point em andamento nesta conta')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolver cobrança da Point' })).toBeNull();
    await act(async () => { fireEvent.click(chargeButton()); });
    expect(claimPayment).toHaveBeenCalledTimes(1);
    expect(toasts().join('\n')).not.toMatch(/Livre para este pagamento/);
  });

  it('P2-1: com outra reserva na conta, a própria aprovada (paga aqui) não aparece na lista nem com "Resolver"', async () => {
    const id = openTable();
    withCloud();
    const total = st().orders.find((o) => o.id === id)!.remaining_balance;
    const half = Math.round(total * 50) / 100;
    st().registerPayment({
      orderId: id, amount: half, method: 'CREDIT', status: 'APPROVED', terminal_id: 'mp-term', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
      card_brand: 'VISA', nsu: '999', authorization_code: 'AB12', terminal_serial: 'MP-SERIAL', idempotency_key: 'mine-approved', item_ids: [],
    });
    fetchPointReservation.mockResolvedValue({
      reservedCents: Math.round(half * 100) + 500, pointCents: Math.round(half * 100) + 500, claimsCents: 0, openCharges: 2, manualReview: false,
      charges: [pointCharge({ idempotencyKey: 'mine-approved', amountCents: Math.round(half * 100), stale: true }), pointCharge({ idempotencyKey: 'outro', status: 'at_terminal', amountCents: 500 })], claims: [],
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText(/cobrando em outro aparelho/)).toBeTruthy();
    expect(screen.queryByText(/aprovada sem pagamento registrado/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolver cobrança da Point' })).toBeNull();
  });

  it('sobra 1: desconto depois da Point aprovada aqui (fila ainda não subiu) não é recusado pela própria cobrança', async () => {
    const id = openTable();
    withCloud();
    const total = st().orders.find((o) => o.id === id)!.remaining_balance;
    const half = Math.round(total * 50) / 100;
    st().registerPayment({
      orderId: id, amount: half, method: 'CREDIT', status: 'APPROVED', terminal_id: 'mp-term', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
      card_brand: 'VISA', nsu: '999', authorization_code: 'AB12', terminal_serial: 'MP-SERIAL', idempotency_key: 'mine-approved', item_ids: [],
    });
    fetchPointReservation.mockResolvedValue({
      reservedCents: Math.round(half * 100), pointCents: Math.round(half * 100), claimsCents: 0, openCharges: 1, manualReview: false,
      charges: [pointCharge({ idempotencyKey: 'mine-approved', amountCents: Math.round(half * 100) })], claims: [],
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect(fetchPointReservation).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    const r = st().applyDiscount(id, 1, { managerPin: '9999', reason: 'desconto de teste' });
    expect(r.ok ? 'ok' : r.error).toBe('ok');
  });

  it('sobra 1: a cobrança aprovada de outro aparelho continua contando no desconto', async () => {
    const id = openTable();
    withCloud();
    const cents = Math.round(st().orders.find((o) => o.id === id)!.remaining_balance * 100);
    fetchPointReservation.mockResolvedValue({
      reservedCents: cents, pointCents: cents, claimsCents: 0, openCharges: 1, manualReview: false,
      charges: [pointCharge({ idempotencyKey: 'aparelho-A', amountCents: cents })], claims: [],
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect(fetchPointReservation).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    const r = st().applyDiscount(id, 1, { managerPin: '9999', reason: 'desconto de teste' });
    expect(r.ok ? 'ok' : r.error).toBe(RESERVED_EXCEEDS_BALANCE);
  });

  it('sobra 1: só a cobrança aprovada é descontada pela chave paga aqui', () => {
    rememberServerReservation('o-x', 3000, [], 1_000, [{ idempotencyKey: 'k-ok', amountCents: 2000, status: 'approved' }, { idempotencyKey: 'k-open', amountCents: 1000, status: 'at_terminal' }]);
    expect(reservationExceeds('o-x', 15, new Set(['k-ok']), 1_000)).toBeNull();
    expect(reservationExceeds('o-x', 5, new Set(['k-ok', 'k-open']), 1_000)).toBe(RESERVED_EXCEEDS_BALANCE);
    expect(reservationExceeds('o-x', 15, new Set(), 1_000)).toBe(RESERVED_EXCEEDS_BALANCE);
  });

  it('sobra 2: retirada (senha) mostra a recusa do Mercado Pago em português, sem repetir', async () => {
    expect(st().login('1111').ok).toBe(true);
    const p = st().products.find((x) => x.code === '101')!;
    const o = st().createPickupOrder({ lines: [{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, half_product_ids: [], quick_tags: [], free_notes: '' }], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    expect(o.ok).toBe(true);
    act(() => useTcheStore.setState({ cloud: null } as never));
    createDriver.mockReturnValue(fakeDriver('STONE', { status: 'DECLINED', acquirer: 'STONE', reason: 'Transação recusada (cc_rejected_insufficient_amount).', terminal_serial: 'S', terminal_id: null }));
    render(<PickupCounterScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Cobrar R\$/ })); });
    await waitFor(() => expect(toasts().join('\n')).toContain('❌ Transação recusada: saldo ou limite insuficiente.'));
  });

  it('sobra 2: ficha rápida mostra a recusa do Mercado Pago em português, sem repetir', async () => {
    expect(st().login('1111').ok).toBe(true);
    const p = st().products.find((x) => x.code === '101')!;
    const sale = st().createCounterSale([{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null }]);
    expect(sale.ok).toBe(true);
    act(() => useTcheStore.setState({ cloud: null } as never));
    createDriver.mockReturnValue(fakeDriver('STONE', { status: 'DECLINED', acquirer: 'STONE', reason: 'Transação recusada (cc_rejected_insufficient_amount).', terminal_serial: 'S', terminal_id: null }));
    render(<FichaRapidaScreen />);
    const box = await screen.findByText('Vendas aguardando pagamento');
    const btns = box.parentElement!.querySelectorAll('button');
    fireEvent.click(btns[btns.length - 1]!);
    fireEvent.click(screen.getByRole('button', { name: /Crédito/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Cobrar R\$/ })); });
    await waitFor(() => expect(toasts().join('\n')).toContain('❌ Transação recusada: saldo ou limite insuficiente.'));
  });

  it('P2-2: código do servidor vira texto; o código só como detalhe', async () => {
    const id = openTable();
    withCloud();
    fetchPointReservation.mockResolvedValue({
      reservedCents: 1000, openCharges: 1, manualReview: true,
      charges: [pointCharge({ status: 'manual_review', rawStatusDetail: 'ORDER_ID_CHANGED' })], claims: [],
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText(/em revisão: o Mercado Pago devolveu duas ordens/)).toBeTruthy();
    expect(screen.queryByText(/\(ORDER_ID_CHANGED\)/)).toBeNull();
    expect(screen.getByText('código ORDER_ID_CHANGED')).toBeTruthy();
  });

  it('P2-2: recusa do Mercado Pago sem repetir "Transação recusada" e sem o código cru', async () => {
    const id = openTable();
    withCloud();
    const reason = 'Transação recusada (cc_rejected_insufficient_amount).';
    createDriver.mockReturnValue(fakeDriver('MERCADO_PAGO', { status: 'DECLINED', acquirer: 'MERCADO_PAGO', reason, terminal_serial: 'MP-SERIAL', terminal_id: 'mp-term', server_confirmed: true } as TerminalResult));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(toasts().join('\n')).toContain('❌ Transação recusada: saldo ou limite insuficiente.'));
    expect(toasts().join('\n')).not.toMatch(/cc_rejected|recusada: Transação recusada/);
  });

  it('P2-2: trava sem cartão em 2 min: título em português, código só como detalhe', async () => {
    const id = openTable();
    withCloud();
    createDriver.mockReturnValue(fakeDriver('MERCADO_PAGO', { status: 'MANUAL_REVIEW', acquirer: 'MERCADO_PAGO', reason: 'A maquininha não confirmou o pagamento nem o cancelamento. Confira no app do Mercado Pago antes de cobrar de novo.', failure_code: 'POINT_TIMEOUT', terminal_serial: 'MP-SERIAL', terminal_id: 'mp-term' }));
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    await waitFor(() => expect(getReviewHold(id)).not.toBeNull());
    expect(await screen.findByText(/sem confirmação: a maquininha não respondeu a tempo/)).toBeTruthy();
    expect(screen.queryByText(/\(POINT_TIMEOUT\)/)).toBeNull();
  });

  it('P2-3: recarregado no meio da própria cobrança: "deste aparelho", não "outro aparelho"', async () => {
    const id = openTable();
    withCloud();
    rememberPointChargeHere('minha-antes-do-reload', id);
    fetchPointReservation.mockResolvedValue({
      reservedCents: 1000, pointCents: 1000, openCharges: 1, manualReview: false,
      charges: [pointCharge({ idempotencyKey: 'minha-antes-do-reload', status: 'at_terminal' })], claims: [],
    });
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    expect(await screen.findByText(/cobrança deste aparelho na maquininha \(o app foi reaberto\)/)).toBeTruthy();
    expect(screen.queryByText(/cobrando em outro aparelho/)).toBeNull();
  });

  it('P2-3: a cobrança grava a chave ao enviar e apaga ao terminar', async () => {
    const id = openTable();
    withCloud();
    let finish!: (r: TerminalResult) => void;
    const driver = fakeDriver('MERCADO_PAGO', new Promise<TerminalResult>((r) => { finish = r; }));
    createDriver.mockReturnValue(driver);
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    const key = (driver.charge.mock.calls[0]![0] as { idempotency_key: string }).idempotency_key;
    expect(localStorage.getItem(`tchefood:point-charges-here:${key}`)).toContain(key);
    await act(async () => { finish({ status: 'DECLINED', acquirer: 'MERCADO_PAGO', reason: 'Transação recusada.', terminal_serial: 'MP-SERIAL', terminal_id: 'mp-term', server_confirmed: true } as TerminalResult); });
    expect(localStorage.getItem(`tchefood:point-charges-here:${key}`)).toBeNull();
  });

  it('P2-4: motivo de 5-9 letras deixa o estorno da Point desligado e o PIN fica', async () => {
    expect(st().login('1111').ok).toBe(true);
    render(<PointRefunds payments={[mpPayment()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Registrar estorno' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'estorno' } });
    for (const d of ['1', '2', '3', '4']) fireEvent.click(within(dialog).getByRole('button', { name: d }));
    expect((within(dialog).getByRole('button', { name: 'Conferir e registrar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/mínimo 10 caracteres/)).toBeTruthy();
    expect(refundPointPayment).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'estorno na maquininha' } });
    // o PIN digitado ficou: completar o motivo liga o botão sem digitar de novo
    expect((within(dialog).getByRole('button', { name: 'Conferir e registrar' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('P2-5: "Cancelar cobrança" com PIN recusado no servidor avisa a tela', async () => {
    const id = openTable();
    withCloud();
    let finish!: (r: TerminalResult) => void;
    const driver = fakeDriver('MERCADO_PAGO', new Promise<TerminalResult>((r) => { finish = r; }));
    createDriver.mockReturnValue(driver);
    render(<CheckoutScreen orderId={id} onBack={() => undefined} onClosed={() => undefined} />);
    await waitFor(() => expect((chargeButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(chargeButton()); });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar cobrança' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cliente desistiu' }));
    for (const d of ['0', '0', '0', '0']) fireEvent.click(within(dialog).getByRole('button', { name: d }));
    expect(driver.abort).toHaveBeenCalledTimes(1);
    const auth = driver.abort.mock.calls[0]![1] as { onRefused?: (m: string) => void };
    act(() => auth.onRefused?.('PIN incorreto'));
    expect(toasts().join('\n')).toMatch(/PIN recusado/);
    await act(async () => { finish({ status: 'DECLINED', acquirer: 'MERCADO_PAGO', reason: 'Transação recusada.', terminal_serial: 'MP-SERIAL', terminal_id: 'mp-term', server_confirmed: true } as TerminalResult); });
  });

  it('P2-6: TF003 não fala de Point', () => {
    expect(CLAIM_ERRORS.TF003).not.toMatch(/Point/);
  });

  it('P2-7: motivo e PIN do gerente com rótulo acessível', () => {
    render(<ManagerAuthSheet open onClose={() => undefined} title="t" summary="s" confirmLabel="ok" onSubmit={() => ({ ok: true, data: undefined })} onSuccess={() => undefined} />);
    expect(screen.getByLabelText('Motivo obrigatório').tagName).toBe('TEXTAREA');
    expect(screen.getByRole('group', { name: 'PIN do gerente' })).toBeTruthy();
    cleanup();
    render(<ReleaseClaimSheet open onClose={() => undefined} claimKey="k" summary="s" onReleased={() => undefined} />);
    expect(screen.getByRole('group', { name: 'PIN do gerente' })).toBeTruthy();
  });

  it('P2-8: TF005 ao liberar diz que não havia reserva; recusa desconhecida não mostra o texto do PostgREST', async () => {
    expect(st().login('1111').ok).toBe(true);
    const real = await vi.importActual<typeof import('../lib/payments/paymentClaim')>('../lib/payments/paymentClaim');
    const respond = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body, headers: new Headers() });
    const deps = (status: number, body: unknown) => ({
      staff: async () => 'staff-1', config: async () => ({ url: 'https://x.supabase.co', anonKey: 'a', accessToken: 't' }),
      fetch: async () => respond(status, body), timer: () => new Promise<void>(() => undefined), prepareOrder: async () => ({ ok: true }),
    });
    const unknown = await real.releasePaymentClaimManager('k', '1234', 'motivo bem longo', deps(400, { code: 'XX000', message: 'duplicate key value violates unique constraint "foo"' }) as never);
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.error).toContain(MANAGER_RELEASE_REFUSED);
    expect(!unknown.ok && unknown.error).not.toMatch(/duplicate key/);
    expect(RELEASE_NOT_FOUND).toMatch(/não havia reserva no servidor/i);
    // TF005 na tela: o PIN é conferido aqui e o aviso não diz "Reserva liberada"
    releaseManager.mockResolvedValue({ ok: true, notFound: true });
    const released = vi.fn();
    render(<ReleaseClaimSheet open onClose={() => undefined} claimKey="k" summary="s" onReleased={released} />);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'cliente pagou de outro jeito' } });
    for (const d of ['9', '9', '9', '9']) fireEvent.click(screen.getByRole('button', { name: d }));
    await waitFor(() => expect(released).toHaveBeenCalled());
    expect(toasts().join('\n')).toContain(RELEASE_NOT_FOUND);
    expect(toasts().join('\n')).not.toMatch(/Reserva liberada no servidor/);
  });
});
