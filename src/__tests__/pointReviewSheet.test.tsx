// @vitest-environment jsdom
/**
 * Cobrança da Point em revisão (docs/integracoes/r6-spec.md C2): "Conferir no Mercado Pago" com PIN de gerente
 * e motivo. Só a resposta do servidor (que lê o Mercado Pago) registra ou libera.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERCADO_PAGO_MANUAL_ERROR, useTcheStore } from '../store/useTcheStore';
import { clearReviewHold, getReviewHold, setReviewHold } from '../lib/payments/reviewHolds';
import { useToast } from '../components/ui';

const reconcile = vi.fn();
vi.mock('../lib/payments/pointReconcile', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/pointReconcile')>()),
  reconcilePointCharge: (...a: unknown[]) => reconcile(...a),
}));

const { ConfirmReviewedChargeSheet } = await import('../components/ConfirmReviewedChargeSheet');
const { POINT_NOT_CHARGED, POINT_REVIEW_PROCEDURE, PointReviewSheet } = await import('../components/PointReviewSheet');

const st = () => useTcheStore.getState();
const KEY = 'pk-review-1';

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

function mpHold(orderId: string) {
  const amount = st().orders.find((o) => o.id === orderId)!.remaining_balance;
  return setReviewHold({
    order_id: orderId, amount, reason: 'A maquininha não confirmou', code: 'POINT_TIMEOUT', method: 'CREDIT',
    acquirer: 'MERCADO_PAGO', terminal_id: 'mp-term', terminal_serial: 'MP-SERIAL', idempotency_key: KEY, item_ids: [],
  });
}

const approved = (cents: number) => ({
  kind: 'reply', reply: { status: 'APPROVED', nsu: '55667788', authorization_code: 'AB12CD', card_brand: 'VISA', last_four: '4321', terminal_serial: 'MP-SERIAL', amount_cents: cents, method: 'CREDIT' },
});

function fill(reason = 'Cliente mostrou a Point aprovada', operation = '') {
  if (operation) fireEvent.change(screen.getByLabelText('ID da operação (opcional)'), { target: { value: operation } });
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: reason } });
}
async function pin(p = '9999') {
  // Um clique por vez (cada dígito vê o anterior); depois espera a conferência assíncrona.
  for (const d of p) fireEvent.click(screen.getByRole('button', { name: d }));
  await act(async () => { await Promise.resolve(); });
}
const toasts = () => useToast.getState().toasts.map((t) => t.text);
const mpPayments = (orderId: string) => st().payments.filter((p) => p.order_id === orderId && p.acquirer === 'MERCADO_PAGO');

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
  reconcile.mockReset();
  useToast.setState({ toasts: [] });
});
afterEach(() => cleanup());

describe('ConfirmReviewedChargeSheet, ramo Mercado Pago', () => {
  it('o texto antigo "estorne lá e cobre de novo" saiu', () => {
    expect(MERCADO_PAGO_MANUAL_ERROR).not.toMatch(/estorne lá e cobre de novo/);
    expect(MERCADO_PAGO_MANUAL_ERROR).toMatch(/Conferir no Mercado Pago/);
  });

  it('APPROVED: registra uma vez com os dados do servidor, sem cobrar de novo, e tira a trava', async () => {
    const id = openTable();
    const hold = mpHold(id);
    const cents = Math.round(hold.amount * 100);
    reconcile.mockResolvedValue(approved(cents));
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    const view = render(<ConfirmReviewedChargeSheet open onClose={onClose} hold={hold} label="Mesa 1" onSuccess={onSuccess} />);
    fill('Cliente mostrou a Point aprovada', '123456789');
    await pin();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(reconcile.mock.calls[0]![0]).toEqual({
      idempotency_key: KEY, staff_id: st().currentUserId, manager_pin: '9999', reason_text: 'Cliente mostrou a Point aprovada', operation_id: '123456789',
    });
    const [p] = mpPayments(id);
    expect(mpPayments(id)).toHaveLength(1);
    expect(p).toMatchObject({ status: 'APPROVED', method: 'CREDIT', acquirer: 'MERCADO_PAGO', nsu: '55667788', authorization_code: 'AB12CD', card_brand: 'VISA', terminal_serial: 'MP-SERIAL', idempotency_key: KEY, amount: hold.amount });
    expect(getReviewHold(id)).toBeNull();
    expect(onClose).toHaveBeenCalled();

    // Conferir de novo (outra tela aberta com a mesma cobrança) não registra outra vez.
    view.unmount();
    render(<PointReviewSheet open onClose={() => undefined} label="Mesa 1" charge={{ order_id: id, idempotency_key: KEY, amount: hold.amount, method: 'CREDIT', terminal_id: null, item_ids: [] }} onSuccess={onSuccess} />);
    fill();
    await pin();
    await waitFor(() => expect(toasts()).toContain('Este pagamento já está registrado neste aparelho.'));
    expect(mpPayments(id)).toHaveLength(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('APPROVED com outro valor: não registra e mantém a trava', async () => {
    const id = openTable();
    const hold = mpHold(id);
    reconcile.mockResolvedValue(approved(Math.round(hold.amount * 100) + 1));
    render(<ConfirmReviewedChargeSheet open onClose={() => undefined} hold={hold} label="Mesa 1" onSuccess={() => undefined} />);
    fill();
    await pin();
    await waitFor(() => expect(screen.getByText(/diferente desta cobrança/)).toBeTruthy());
    expect(mpPayments(id)).toHaveLength(0);
    expect(getReviewHold(id)).not.toBeNull();
  });

  it('DECLINED: tira a trava e avisa que o Mercado Pago confirmou que não foi cobrado', async () => {
    const id = openTable();
    const hold = mpHold(id);
    reconcile.mockResolvedValue({ kind: 'reply', reply: { status: 'DECLINED', reason: 'Cancelada no Mercado Pago' } });
    const onReleased = vi.fn();
    render(<ConfirmReviewedChargeSheet open onClose={() => undefined} hold={hold} label="Mesa 1" onSuccess={() => undefined} onReleased={onReleased} />);
    fill();
    await pin();
    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1));
    expect(getReviewHold(id)).toBeNull();
    expect(toasts()).toContain(POINT_NOT_CHARGED);
    expect(POINT_NOT_CHARGED).toBe('O Mercado Pago confirmou que não foi cobrado. Valor liberado.');
    expect(st().payments.filter((p) => p.order_id === id)).toHaveLength(0);
  });

  it('MANUAL_REVIEW: mostra o motivo e o procedimento, e a trava continua', async () => {
    const id = openTable();
    const hold = mpHold(id);
    reconcile.mockResolvedValue({ kind: 'reply', reply: { status: 'MANUAL_REVIEW', code: 'NOT_FOUND_YET', reason: 'O Mercado Pago ainda não mostra esta cobrança.' } });
    render(<ConfirmReviewedChargeSheet open onClose={() => undefined} hold={hold} label="Mesa 1" onSuccess={() => undefined} />);
    fill();
    await pin();
    await waitFor(() => expect(screen.getByText(/O Mercado Pago ainda não mostra esta cobrança/)).toBeTruthy());
    expect(screen.getByText(POINT_REVIEW_PROCEDURE)).toBeTruthy();
    expect(getReviewHold(id)).not.toBeNull();
    expect(st().payments.filter((p) => p.order_id === id)).toHaveLength(0);
  });

  it('PIN errado: mostra o erro, não registra nem libera', async () => {
    const id = openTable();
    const hold = mpHold(id);
    reconcile.mockResolvedValue({ kind: 'pin', error: 'PIN de gerente incorreto ou bloqueado. Nada mudou.' });
    render(<ConfirmReviewedChargeSheet open onClose={() => undefined} hold={hold} label="Mesa 1" onSuccess={() => undefined} />);
    fill();
    await pin('1234');
    await waitFor(() => expect(screen.getByText('PIN de gerente incorreto ou bloqueado. Nada mudou.')).toBeTruthy());
    expect(getReviewHold(id)).not.toBeNull();
    expect(st().payments.filter((p) => p.order_id === id)).toHaveLength(0);
  });

  it('motivo curto: o PIN não manda a conferência', async () => {
    const id = openTable();
    const hold = mpHold(id);
    render(<ConfirmReviewedChargeSheet open onClose={() => undefined} hold={hold} label="Mesa 1" onSuccess={() => undefined} />);
    fill('curto');
    await pin();
    expect(reconcile).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Conferir no Mercado Pago' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
