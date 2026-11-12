import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold, getReviewHold, setReviewHold } from '../lib/payments/reviewHolds';
import { checkReceiptProof } from '../lib/payments/terminalGuard';
import { whatsappAlertText } from '../lib/reports';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const table = (n: number) => st().tables.find((t) => t.number === n)!;
const order = (id: string) => st().orders.find((o) => o.id === id)!;
const MANAGER = { managerPin: '9999', reason: 'Maquininha aprovou, conferido no comprovante' };
const RECEIPT = { nsu: '004512', authorization_code: 'a1b2c3', card_brand: 'VISA' };

function openTableWith(codes: string[]) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(table(1).id, 2, null);
  if (!r.ok) throw new Error(r.error);
  for (const code of codes) {
    const p = product(code);
    const t = st().addToTray({
      order_id: r.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
      meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector,
    });
    if (!t.ok) throw new Error(t.error);
  }
  st().dispatchTray(r.data.id);
  expect(st().startCheckout(r.data.id).ok).toBe(true);
  return r.data.id;
}

function holdFor(orderId: string, extra: Partial<Parameters<typeof setReviewHold>[0]> = {}) {
  return setReviewHold({
    order_id: orderId, amount: order(orderId).remaining_balance, reason: 'Queda no meio da cobrança', code: 'WRAPPER_EXCEPTION',
    method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'STONE-01', idempotency_key: `hold-${orderId}`, ...extra,
  });
}

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
});

describe('comprovante digitado pelo gerente', () => {
  it('só aceita NSU e autorização com formato de comprovante', () => {
    expect(checkReceiptProof({ nsu: '004512', authorization_code: 'a1b2c3' })).toEqual({ ok: true, nsu: '004512', authorization_code: 'A1B2C3' });
    expect(checkReceiptProof({ nsu: ' 1234 5678 ', authorization_code: 'X9Z1' }).ok).toBe(true);
    expect(checkReceiptProof({ nsu: '', authorization_code: 'A1B2C3' }).ok).toBe(false);
    expect(checkReceiptProof({ nsu: '12345', authorization_code: 'A1B2C3' }).ok).toBe(false);
    expect(checkReceiptProof({ nsu: '1234567890123', authorization_code: 'A1B2C3' }).ok).toBe(false);
    expect(checkReceiptProof({ nsu: '12AB56', authorization_code: 'A1B2C3' }).ok).toBe(false);
    expect(checkReceiptProof({ nsu: '000000', authorization_code: 'A1B2C3' }).ok).toBe(false);
    expect(checkReceiptProof({ nsu: '004512', authorization_code: 'AAAAAA' }).ok).toBe(false);
    expect(checkReceiptProof({ nsu: '004512', authorization_code: 'A1-B2' }).ok).toBe(false);
  });
});

describe('cobrança incerta aprovada na maquininha', () => {
  it('mesa: registra com o NSU digitado, PIN de gerente e audit_log, e fecha a conta sem nova cobrança', () => {
    const id = openTableWith(['101']);
    const amount = order(id).remaining_balance;
    holdFor(id);
    const paymentsBefore = st().payments.length;

    const r = st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, MANAGER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.closed).toBe(true);
    expect(st().payments.length).toBe(paymentsBefore + 1);
    expect(r.data.payment).toMatchObject({
      amount, method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE', acquirer_cnpj: '16501555000157', card_brand: 'VISA',
      nsu: '004512', authorization_code: 'A1B2C3', terminal_serial: 'STONE-01', idempotency_key: `hold-${id}`,
    });
    expect(order(id).status).toBe('CLOSED');
    expect(order(id).remaining_balance).toBe(0);
    expect(getReviewHold(id)).toBeNull();

    const log = st().auditLogs[0]!;
    expect(log).toMatchObject({ order_id: id, action_type: 'CHARGE_CONFIRMED_MANUALLY', amount_impact: amount, reason: MANAGER.reason });
    expect(log.authorized_by_manager_id).toBe(st().staff.find((u) => u.pin_code === '9999')!.id);
    expect(log.metadata).toMatchObject({ payment_id: r.data.payment.id, nsu: '004512', authorization_code: 'A1B2C3', review_code: 'WRAPPER_EXCEPTION' });
    // Sobe com o PIN, para o servidor conferir (tchefood_authorize_manager), depois do pagamento.
    const queuedLog = st().outbox.findIndex((e) => e.table === 'audit_logs' && (e.payload as { id: string }).id === log.id);
    expect(st().outbox[queuedLog]!.manager_pin).toBe('9999');
    expect(st().outbox.findIndex((e) => e.table === 'payments' && e.row_id === r.data.payment.id)).toBeLessThan(queuedLog);
    expect(whatsappAlertText(log, st().staff, st().tables, st().orders)).toContain('NSU 004512');
  });

  it('mesa por item: a cobrança incerta quita os mesmos itens', () => {
    const id = openTableWith(['101', '311']);
    const picanha = st().orderItems.find((i) => i.order_id === id && i.product_id === product('101').id)!;
    holdFor(id, { amount: 131.89, item_ids: [picanha.id] });
    const r = st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, MANAGER);
    expect(r.ok && r.data.closed).toBe(false);
    expect(st().orderItems.find((i) => i.id === picanha.id)!.is_paid).toBe(true);
    expect(order(id).status).toBe('PAYING');
  });

  it('sem trava, PIN errado, NSU inválido ou repetido: nada é registrado', () => {
    const id = openTableWith(['101']);
    const before = st().payments.length;
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, MANAGER)).toMatchObject({ ok: false });

    holdFor(id);
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT, nsu: '' }, MANAGER)).toMatchObject({ ok: false });
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT, nsu: '111111' }, MANAGER)).toMatchObject({ ok: false });
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT, card_brand: 'FAKE' }, MANAGER)).toMatchObject({ ok: false });
    const wrong = st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, { ...MANAGER, managerPin: '1234' });
    expect(wrong.ok).toBe(false);
    expect(st().auditLogs[0]!.action_type).toBe('MANAGER_PIN_FAILED');
    // Garçom não aprova a si mesmo.
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, { ...MANAGER, managerPin: '1111' }).ok).toBe(false);
    expect(st().payments.length).toBe(before);
    expect(getReviewHold(id)).not.toBeNull();

    // O mesmo comprovante não quita uma segunda conta.
    const p = st().payments.find((x) => x.status === 'APPROVED' && x.acquirer === 'STONE' && x.nsu);
    if (p) {
      expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT, nsu: p.nsu! }, MANAGER).ok).toBe(false);
    }
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, MANAGER).ok).toBe(true);
    const id2 = (() => {
      const r = st().openTable(table(1).id, 1, null);
      if (!r.ok) throw new Error(r.error);
      const prod = product('311');
      st().addToTray({ order_id: r.data.id, product_id: prod.id, half_product_ids: [], quantity: 1, unit_price: prod.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: prod.sector });
      st().dispatchTray(r.data.id);
      st().startCheckout(r.data.id);
      return r.data.id;
    })();
    holdFor(id2);
    const dup = st().confirmReviewedCharge({ orderId: id2, ...RECEIPT }, MANAGER);
    expect(dup).toMatchObject({ ok: false });
    expect(getReviewHold(id2)).not.toBeNull();
  });

  it('trava antiga sem forma/adquirente: o gerente informa pelo comprovante', () => {
    const id = openTableWith(['311']);
    setReviewHold({ order_id: id, amount: order(id).remaining_balance, reason: 'x', code: 'UNKNOWN_RESULT' });
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, MANAGER).ok).toBe(false);
    const r = st().confirmReviewedCharge({ orderId: id, ...RECEIPT, method: 'DEBIT', acquirer: 'PAGBANK' }, MANAGER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.payment).toMatchObject({ method: 'DEBIT', acquirer: 'PAGBANK', acquirer_cnpj: '08561701000101' });
  });

  it('a trava manda na forma e adquirente: o pedido não troca o que a maquininha cobrou', () => {
    const id = openTableWith(['311']);
    holdFor(id, { method: 'PIX', acquirer: 'STONE' });
    const r = st().confirmReviewedCharge({ orderId: id, ...RECEIPT, method: 'CREDIT', acquirer: 'PAGBANK' }, MANAGER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.payment).toMatchObject({ method: 'PIX', acquirer: 'STONE', card_brand: 'PIX' });
  });

  it('ficha rápida (balcão): fecha a venda e libera a emissão das fichas', () => {
    expect(st().login('5555').ok).toBe(true);
    const sale = st().createCounterSale([{ product_id: product('313').id, quantity: 2, modifiers: [], meat_doneness: null }]);
    if (!sale.ok) throw new Error(sale.error);
    holdFor(sale.data.id);
    const r = st().confirmReviewedCharge({ orderId: sale.data.id, ...RECEIPT }, MANAGER);
    expect(r.ok && r.data.closed).toBe(true);
    const tickets = st().issueEventTickets(sale.data.id);
    expect(tickets.ok && tickets.data.length).toBe(2);
  });

  it('senha do totem/caixa: fecha o pedido e libera para a cozinha', () => {
    expect(st().login('4444').ok).toBe(true);
    const created = st().createPickupOrder({
      lines: [{ product_id: product('301').id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' }],
      fulfillment: 'TAKEOUT', customerName: 'Ana',
    });
    if (!created.ok) throw new Error(created.error);
    holdFor(created.data.id);
    // No caixa, quem confere é a equipe (o totem só manda o cliente ao caixa).
    expect(st().login('5555').ok).toBe(true);
    const r = st().confirmReviewedCharge({ orderId: created.data.id, ...RECEIPT }, MANAGER);
    expect(r.ok && r.data.closed).toBe(true);
    expect(order(created.data.id).status).toBe('CLOSED');
  });
});

describe('cobrança incerta da Point Smart (Mercado Pago)', () => {
  it('não entra pelo comprovante digitado: o servidor só aceita a aprovação confirmada pelo Mercado Pago', async () => {
    const { MERCADO_PAGO_MANUAL_ERROR } = await import('../store/useTcheStore');
    const id = openTableWith(['101']);
    holdFor(id, { acquirer: 'MERCADO_PAGO', terminal_serial: 'NEWLAND_N950__N950NCB801293324' });
    const before = st().payments.length;
    expect(st().confirmReviewedCharge({ orderId: id, ...RECEIPT }, MANAGER)).toEqual({ ok: false, error: MERCADO_PAGO_MANUAL_ERROR });
    expect(st().payments.length).toBe(before);
    expect(getReviewHold(id)).not.toBeNull();
  });
});
