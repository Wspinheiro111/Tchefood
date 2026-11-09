import { useTcheStore } from '../store/useTcheStore';
import type { PaymentMethod } from '../types';
import { round2, toCents } from './money';
import { uuid } from './ids';
import { createDriver, useTerminalBus, type Chassis, type ChargeRequest } from './payments/drivers';
import { getReviewHold, setReviewHold } from './payments/reviewHolds';
import { cardReceiptLines } from './receipts';
import { formatPickupNumber, pickupReceipt } from './kiosk';
import { routeDispatch, usePrintPreview } from '../services/printer/printerService';

// Cobrança do pedido com senha (totem e caixa) com as mesmas regras de maquininha das mesas:
// trava da conta durante a cobrança, idempotência, aprovação só com prova completa e
// resultado incerto vira conferência manual (nunca inventa NSU nem cobra de novo sozinho).

export type PickupChargeResult =
  | { status: 'APPROVED'; change: number }
  | { status: 'DECLINED'; reason: string }
  | { status: 'MANUAL_REVIEW'; reason: string }
  | { status: 'ERROR'; reason: string };

export async function chargePickupOrder(params: {
  orderId: string;
  method: Exclude<PaymentMethod, 'VOUCHER'>;
  chassis: Chassis;
  /** Dinheiro: valor entregue pelo cliente (0 = exato). */
  cashGiven?: number;
  /** No totem a prévia do ticket da cozinha não abre na tela do cliente. */
  kitchenPreview?: boolean;
}): Promise<PickupChargeResult> {
  const preview = params.kitchenPreview ?? true;
  const s = useTcheStore.getState();
  const order = s.orders.find((o) => o.id === params.orderId);
  if (!order) return { status: 'ERROR', reason: 'Pedido não encontrado.' };
  if (order.status !== 'PAYING') return { status: 'ERROR', reason: 'Pedido já encerrado.' };
  const amount = order.remaining_balance;
  const idempotency_key = uuid();
  const label = `Senha ${formatPickupNumber(order.pickup_number)}`;

  if (params.method === 'CASH') {
    const given = round2(params.cashGiven ?? 0);
    if (given > 0 && toCents(given) < toCents(amount)) return { status: 'ERROR', reason: 'Valor recebido menor que o total.' };
    const r = s.registerPayment({ orderId: order.id, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key, item_ids: [] });
    if (!r.ok) return { status: 'ERROR', reason: r.error };
    finishPaidPickup(order.id, params.chassis, null, r.data.payment.id, preview);
    return { status: 'APPROVED', change: given > amount ? round2(given - amount) : 0 };
  }

  if (getReviewHold(order.id)) return { status: 'MANUAL_REVIEW', reason: 'Há uma cobrança sem confirmação. Confira o extrato da maquininha antes de cobrar de novo.' };
  const driver = createDriver({ terminal: null, chassis: params.chassis, mode: 'SMARTPOS_EMBEDDED' });
  const req: ChargeRequest = {
    request_id: uuid(),
    idempotency_key,
    amount,
    method: params.method,
    table_label: label,
    order_id: order.id,
    description: 'Totem / pedido no caixa',
  };
  const lock = s.beginTerminalCharge(order.id, req.request_id, amount);
  if (!lock.ok) return { status: 'ERROR', reason: lock.error };
  try {
    const result = await driver.charge(req);
    const st = useTcheStore.getState();
    if (result.status === 'MANUAL_REVIEW') {
      setReviewHold({ order_id: order.id, amount, reason: result.reason, code: result.failure_code });
      return { status: 'MANUAL_REVIEW', reason: result.reason };
    }
    if (result.status === 'DECLINED') {
      st.registerPayment({ orderId: order.id, amount, method: params.method, status: 'DECLINED', terminal_id: result.terminal_id, acquirer: result.acquirer, acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: result.terminal_serial, idempotency_key, item_ids: [], charge_request_id: req.request_id });
      return { status: 'DECLINED', reason: result.reason };
    }
    const r = st.registerPayment({
      orderId: order.id, amount, method: params.method, status: 'APPROVED', terminal_id: result.terminal_id, acquirer: result.acquirer, acquirer_cnpj: result.acquirer_cnpj,
      card_brand: result.card_brand, nsu: result.nsu, authorization_code: result.authorization_code, terminal_serial: result.terminal_serial,
      idempotency_key, item_ids: [], charge_request_id: req.request_id,
    });
    if (!r.ok) {
      // A maquininha aprovou mas o registro falhou: trata como conferência manual, nunca cobra de novo.
      setReviewHold({ order_id: order.id, amount, reason: `Aprovado na maquininha, mas não registrado: ${r.error}`, code: 'REGISTER_FAILED' });
      return { status: 'MANUAL_REVIEW', reason: r.error };
    }
    finishPaidPickup(order.id, params.chassis, result.masked_pan, r.data.payment.id, preview);
    return { status: 'APPROVED', change: 0 };
  } finally {
    useTcheStore.getState().endTerminalCharge(req.request_id);
  }
}

/** Pago: comprovante do cartão, senha do cliente e ticket da cozinha (o KDS já mostra sozinho). */
export function finishPaidPickup(orderId: string, chassis: Chassis, maskedPan: string | null, paymentId: string | null, kitchenPreview = true) {
  const s = useTcheStore.getState();
  const order = s.orders.find((o) => o.id === orderId);
  if (!order) return;
  const payment = paymentId ? s.payments.find((p) => p.id === paymentId) : undefined;
  const label = `Senha ${formatPickupNumber(order.pickup_number)}`;
  if (payment && payment.method !== 'CASH') {
    useTerminalBus.getState().enqueuePrint({ title: 'Comprovante TEF', lines: cardReceiptLines({ tenant: s.tenant, payment, tableLabel: label, maskedPan }), chassis });
  }
  printPickupReceipt(orderId, chassis);
  printPickupKitchen(orderId, kitchenPreview);
}

export function printPickupReceipt(orderId: string, chassis: Chassis) {
  const s = useTcheStore.getState();
  const order = s.orders.find((o) => o.id === orderId);
  if (!order) return;
  const r = pickupReceipt({ tenant: s.tenant, order, items: s.orderItems, productName: (id) => s.products.find((p) => p.id === id)?.name ?? 'Item' });
  useTerminalBus.getState().enqueuePrint({ title: `Senha ${r.headline}`, headline: r.headline, lines: r.lines, footer: r.footer, chassis });
}

/** Ticket de produção das praças com a SENHA no lugar da mesa. Só depois de pago. */
export function printPickupKitchen(orderId: string, preview = true) {
  const s = useTcheStore.getState();
  const order = s.orders.find((o) => o.id === orderId);
  if (!order || order.status !== 'CLOSED') return;
  const items = s.orderItems.filter((i) => i.order_id === orderId && i.status !== 'CANCELED' && i.sector !== 'NONE');
  if (items.length === 0) return;
  const number = formatPickupNumber(order.pickup_number);
  const label = [`Senha ${number}`, order.fulfillment_type === 'TAKEOUT' ? 'PARA LEVAR' : 'COMER AQUI', order.pickup_name].filter(Boolean).join(' · ');
  const tickets = routeDispatch({ items, printers: s.printers, products: s.products, staff: s.staff, tableLabel: label, tableNumber: order.pickup_number ?? 0, headline: `SENHA ${number}` });
  const failed = tickets.filter((t) => t.delivery.via === 'NATIVE' && !t.delivery.ok);
  if (failed.length > 0) {
    // Falha de impressão aparece para a equipe; no totem o KDS já mostra o pedido.
    if (preview) usePrintPreview.getState().show(s.showPrintSimulator ? tickets : failed);
    return;
  }
  if (preview && s.showPrintSimulator && tickets.some((t) => t.delivery.via === 'SIMULATOR')) usePrintPreview.getState().show(tickets);
}
