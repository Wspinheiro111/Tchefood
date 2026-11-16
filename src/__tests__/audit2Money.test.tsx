// @vitest-environment jsdom
/** Auditoria interna 2 do PR #49 (revisor de dinheiro): cada achado conferido com o teste que falhava antes. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hoisted = vi.hoisted(() => ({ deps: null as unknown }));
vi.mock('../lib/payments/pointReconcile', async (orig) => {
  const real = await orig<typeof import('../lib/payments/pointReconcile')>();
  return { ...real, defaultReconcileDeps: () => (hoisted.deps ?? real.defaultReconcileDeps()) as never };
});
import { useTcheStore } from '../store/useTcheStore';
import { useToast } from '../components/ui';
import { clearReviewHold } from '../lib/payments/reviewHolds';
import { computeItemsShare } from '../lib/money';
import { currentShiftPeriod, pointRefundsInShift } from '../lib/reports';
import { POINT_REFUND_ITEMS_PAID, PointRefunds, submitPointRefund } from '../components/PointRefund';
import { NFCE_REFUNDED_WARNING, NfceViewer } from '../screens/NfceViewer';
import { CheckoutScreen } from '../screens/CheckoutScreen';
import { ManagerAuthSheet, MAX_REASON_LENGTH } from '../components/ManagerAuthSheet';
import { ReleaseClaimSheet } from '../components/StuckClaims';
import type { ReconcileDeps } from '../lib/payments/pointReconcile';
import type { Payment } from '../types';

const st = () => useTcheStore.getState();

function openWithItems(qty = 2, extra = false) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(st().tables.find((t) => t.number === 1)!.id, 2, null);
  if (!r.ok) throw new Error(r.error);
  const orderId = r.data.id;
  const add = (code: string, q: number) => {
    const p = st().products.find((x) => x.code === code) ?? st().products[1]!;
    st().addToTray({ order_id: orderId, product_id: p.id, half_product_ids: [], quantity: q, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
      meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector });
  };
  add('101', qty);
  if (extra) add('102', 1);
  st().dispatchTray(orderId);
  return orderId;
}

function payPoint(orderId: string, amount: number, key: string, itemIds: string[] = []) {
  const r = st().registerPayment({
    orderId, amount, method: 'CREDIT', status: 'APPROVED', terminal_id: null, acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
    card_brand: 'VISA', nsu: `nsu-${key}`, authorization_code: 'A1', terminal_serial: 'N1', idempotency_key: key, item_ids: itemIds,
  });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** Resposta do servidor ao pedido de estorno (point-charge, ação refund). */
function refundDeps(paymentRegistered?: boolean): ReconcileDeps {
  return {
    config: async () => ({ url: 'https://x.supabase.co', anonKey: 'a', accessToken: 't' }),
    fetch: (async (_u: string, init: { body: string }) => {
      const key = (JSON.parse(init.body) as { idempotency_key: string }).idempotency_key;
      const body = { status: 'DECLINED', code: 'REFUNDED', idempotency_key: key, reason: 'estornada', ...(paymentRegistered === undefined ? {} : { payment_registered: paymentRegistered }) };
      return { status: 200, text: async () => JSON.stringify(body) };
    }) as never,
    timer: () => new Promise(() => undefined),
  } as ReconcileDeps;
}

const caused = () => st().outbox.filter((e) => (e.table === 'orders' && e.payload.status === 'CLOSED') || (e.table === 'dining_tables' && e.payload.status === 'FREE'));

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
});
afterEach(() => cleanup());

describe('P1-A: estorno espelhado de pagamento que o servidor nunca recebeu', () => {
  it('payment_registered=false: o fechamento, os itens pagos e a mesa livre saem da fila; a conta reabre; a inclusão sobe estornada', async () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    useTcheStore.setState({ outbox: [] });
    expect(payPoint(orderId, order.remaining_balance, 'k-a').closed).toBe(true);
    expect(caused().length).toBeGreaterThan(0);
    const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-a')!, '9999', 'venda estornada na maquininha', refundDeps(false));
    expect(r.ok).toBe(true);
    const after = st().orders.find((o) => o.id === orderId)!;
    expect(after.status).toBe('PAYING');
    expect(after.remaining_balance).toBe(order.remaining_balance);
    expect(st().tables.find((t) => t.id === order.table_id)).toMatchObject({ status: 'PAYING', current_order_id: orderId });
    expect(st().orderItems.filter((i) => i.order_id === orderId).every((i) => !i.is_paid)).toBe(true);
    expect(caused()).toEqual([]);
    const inserts = st().outbox.filter((e) => e.table === 'payments' && e.op === 'INSERT');
    expect(inserts.map((e) => e.payload.status)).toEqual(['REFUNDED']);
    // Estado atual de conta e mesa sobe depois da inclusão.
    const last = st().outbox.filter((e) => e.table === 'orders').at(-1)!;
    expect(last.payload.status).toBe('PAYING');
    expect(st().outbox.findIndex((e) => e === inserts[0])).toBeLessThan(st().outbox.findIndex((e) => e === last));
  });

  it('inclusão nos recusados: volta para a fila estornada, o fechamento recusado sai dos recusados', () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    useTcheStore.setState({ outbox: [] });
    payPoint(orderId, order.remaining_balance, 'k-r');
    useTcheStore.setState((s) => ({ syncRejected: s.outbox.map((event) => ({ event, status: 400, message: 'TF007', rejected_at: new Date().toISOString() })), outbox: [] }));
    const m = st().mirrorServerPointRefund('k-r', 'venda estornada', { paymentRegistered: false });
    expect(m.ok).toBe(true);
    expect(st().syncRejected).toEqual([]);
    expect(st().outbox[0]).toMatchObject({ table: 'payments', op: 'INSERT', payload: { status: 'REFUNDED' } });
    expect(caused()).toEqual([]);
    expect(st().orders.find((o) => o.id === orderId)!.status).toBe('PAYING');
  });

  it('payment_registered=true na resposta: mesmo com a inclusão ainda na fila daqui, não desfaz (o servidor tem o pagamento)', async () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    useTcheStore.setState({ outbox: [] });
    payPoint(orderId, order.remaining_balance, 'k-q');
    const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-q')!, '9999', 'venda estornada na maquininha', refundDeps(true));
    expect(r.ok).toBe(true);
    // GPT r10 (P1-01): a conta fechada reabre (como no servidor); o pagamento estornado fica (não desfaz).
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'PAYING', closed_at: null });
    expect(st().payments.find((p) => p.idempotency_key === 'k-q')!.status).toBe('REFUNDED');
  });

  it('payment_registered=true: o servidor tem o pagamento; conta fechada reabre (GPT r10, P1-01)', () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    useTcheStore.setState({ outbox: [] });
    payPoint(orderId, order.remaining_balance, 'k-t');
    const m = st().mirrorServerPointRefund('k-t', 'venda estornada', { paymentRegistered: true });
    expect(m.ok && m.data.reopened).toBe(true);
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'PAYING', closed_at: null });
  });
});

describe('P2-B (GPT r10): itens do pagamento estornado voltam a não pagos, como no servidor', () => {
  it('com paid_item_ids: os itens voltam a dever e não há aviso', async () => {
    const orderId = openWithItems(1, true);
    const order = st().orders.find((o) => o.id === orderId)!;
    const items = st().orderItems.filter((i) => i.order_id === orderId);
    const share = computeItemsShare(order, [items[0]!], items).share;
    payPoint(orderId, share, 'k-b', [items[0]!.id]);
    useTcheStore.setState({ outbox: [] }); // já no servidor
    const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-b')!, '9999', 'venda estornada na maquininha', refundDeps(true));
    expect(r.ok && r.data.itemsStayPaid).toBe(false);
    expect(st().orderItems.find((i) => i.id === items[0]!.id)!.is_paid).toBe(false);
    render(<CheckoutScreen orderId={orderId} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Por item/ }));
    expect(screen.queryByText(POINT_REFUND_ITEMS_PAID)).toBeNull();
  });

  it('pagamento antigo (sem paid_item_ids): os itens seguem pagos e o "por item" mostra o aviso', async () => {
    const orderId = openWithItems(1, true);
    const order = st().orders.find((o) => o.id === orderId)!;
    const items = st().orderItems.filter((i) => i.order_id === orderId);
    payPoint(orderId, computeItemsShare(order, [items[0]!], items).share, 'k-b', [items[0]!.id]);
    useTcheStore.setState({ outbox: [], payments: st().payments.map((p) => (p.idempotency_key === 'k-b' ? { ...p, paid_item_ids: undefined } : p)) });
    const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-b')!, '9999', 'venda estornada na maquininha', refundDeps(true));
    expect(r.ok && r.data.itemsStayPaid).toBe(true);
    expect(st().orderItems.find((i) => i.id === items[0]!.id)!.is_paid).toBe(true);
    render(<CheckoutScreen orderId={orderId} onBack={() => undefined} onClosed={() => undefined} />);
    expect(screen.queryByText(POINT_REFUND_ITEMS_PAID)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Por item/ }));
    expect(screen.getByText(POINT_REFUND_ITEMS_PAID)).toBeTruthy();
  });
});

describe('P2-B na tela de estorno', () => {
  it('o estorno com itens que seguem pagos (pagamento antigo, sem paid_item_ids) avisa o operador', async () => {
    const orderId = openWithItems(1, true);
    const order = st().orders.find((o) => o.id === orderId)!;
    const items = st().orderItems.filter((i) => i.order_id === orderId);
    payPoint(orderId, computeItemsShare(order, [items[0]!], items).share, 'k-bt', [items[0]!.id]);
    useTcheStore.setState({ outbox: [], payments: st().payments.map((p) => (p.idempotency_key === 'k-bt' ? { ...p, paid_item_ids: undefined } : p)) });
    useToast.setState({ toasts: [] } as never);
    hoisted.deps = refundDeps(true);
    try {
      render(<PointRefunds payments={st().payments} />);
      fireEvent.click(screen.getByRole('button', { name: 'Registrar estorno' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Venda estornada na maquininha' }));
      for (const d of ['9', '9', '9', '9']) fireEvent.click(within(dialog).getByRole('button', { name: d }));
      await waitFor(() => expect(useToast.getState().toasts.map((t: { text: string }) => t.text)).toContain(POINT_REFUND_ITEMS_PAID));
    } finally {
      hoisted.deps = null;
    }
  });
});

describe('P2-E: estorno de venda de outro dia e conciliação', () => {
  const mp = (id: string, daysAgo: number, over: Partial<Payment> = {}): Payment => ({
    id, order_id: 'o1', amount: 50, method: 'CREDIT', status: 'APPROVED', terminal_id: null, acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
    card_brand: 'VISA', nsu: `NSU${id}`, authorization_code: 'A1', terminal_serial: 'N1', idempotency_key: `k-${id}`, item_ids: [],
    created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), ...over,
  } as Payment);

  it('sem nuvem: lista os deste aparelho, sem limite de dias (GPT r10, P1-02), com busca', () => {
    render(<PointRefunds payments={[mp('ontem', 1), mp('velho', 40), mp('hoje', 0, { amount: 12.34 })]} />);
    expect(screen.getAllByRole('button', { name: 'Registrar estorno' })).toHaveLength(3);
    expect(screen.getByText(/NSUvelho/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Buscar/), { target: { value: 'NSUontem' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(screen.getAllByRole('button', { name: 'Registrar estorno' })).toHaveLength(1);
    expect(screen.getByText(/NSUontem/)).toBeTruthy();
  });

  it('"Estornos Mercado Pago": estornados no turno pela hora do registro do estorno', () => {
    const period = currentShiftPeriod();
    const old = mp('old', 3, { status: 'REFUNDED' });
    const today = mp('today', 0, { status: 'REFUNDED', amount: 20 });
    const log = { id: 'l1', action_type: 'POINT_PAYMENT_REFUNDED', created_at: new Date().toISOString(), metadata: { payment_id: 'old' } } as never;
    expect(pointRefundsInShift([old, today, mp('ok', 0)], [log], period)).toEqual({ total: 70, count: 2 });
    expect(pointRefundsInShift([old], [], period)).toEqual({ total: 0, count: 0 });
  });
});

describe('P2-C: NFC-e reimpressa depois do estorno', () => {
  it('avisa que a nota foi emitida com o pagamento estornado', () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    payPoint(orderId, order.remaining_balance, 'k-c');
    expect(st().orders.find((o) => o.id === orderId)!.nfce_key).toBeTruthy();
    render(<NfceViewer orderId={orderId} onClose={() => undefined} />);
    expect(screen.queryByText(NFCE_REFUNDED_WARNING)).toBeNull();
    cleanup();
    st().mirrorServerPointRefund('k-c', 'venda estornada', { paymentRegistered: true });
    render(<NfceViewer orderId={orderId} onClose={() => undefined} />);
    expect(screen.getByText(NFCE_REFUNDED_WARNING)).toBeTruthy();
  });
});

describe('motivo até 500 caracteres (o servidor recusa acima)', () => {
  it('as folhas de PIN de gerente limitam o motivo', () => {
    expect(MAX_REASON_LENGTH).toBe(500);
    render(<ManagerAuthSheet open onClose={() => undefined} title="t" summary="s" confirmLabel="ok" onSubmit={() => ({ ok: true, data: undefined })} onSuccess={() => undefined} />);
    const box = screen.getByLabelText('Motivo obrigatório') as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    fireEvent.change(box, { target: { value: 'x'.repeat(600) } });
    expect(box.value).toHaveLength(500);
    cleanup();
    render(<ReleaseClaimSheet open onClose={() => undefined} claimKey="k" summary="s" onReleased={() => undefined} />);
    expect((within(screen.getByRole('dialog')).getByLabelText('Motivo') as HTMLTextAreaElement).maxLength).toBe(500);
  });
});
