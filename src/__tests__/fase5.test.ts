import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { kegStatus } from '../lib/kegs';
import { generateTicketToken, isValidTicketToken, normalizeTicketToken, TICKET_ALPHABET } from '../lib/eventTickets';
import { cashbackEarnAmount, isCashbackDay, normalizeWhatsapp } from '../lib/loyalty';
import { computeNetWeight, encodeScaleFrame, parseScaleFrame, parseScalePayload, readStable, SimulatedScale } from '../lib/scale';
import { seedId } from '../data/seed';
import type { SelectedModifier } from '../types';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const table = (n: number) => st().tables.find((t) => t.number === n)!;
const tap = (n: number) => st().kegTaps.find((t) => t.tap_number === n)!;
const MANAGER = { managerPin: '9999', reason: 'Teste automatizado' };

function size(key: '300' | '500' | 'caneca'): SelectedModifier {
  const opt = st().modifierOptions.find((o) => o.id === seedId(`mo:tamanho-chopp:${key}`))!;
  return { group_id: opt.group_id, option_id: opt.id, name: opt.name, additional_price: opt.additional_price };
}

function openTable(n = 1) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(table(n).id, 2, null);
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}

function launchChopp(orderId: string, qty: number, mod: SelectedModifier) {
  const p = product('201');
  const r = st().addToTray({
    order_id: orderId, product_id: p.id, half_product_ids: [], quantity: qty, unit_price: p.price, modifiers: [mod],
    modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector,
  });
  if (!r.ok) throw new Error(r.error);
  const d = st().dispatchTray(orderId);
  if (!d.ok) throw new Error(d.error);
  return d.data.items;
}

function payAll(orderId: string, key = `k-${Math.random()}`) {
  const order = st().orders.find((o) => o.id === orderId)!;
  const r = st().registerPayment({
    orderId, amount: order.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
    acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [],
  });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

beforeEach(() => st().resetDemo());
afterEach(() => vi.useRealTimers());

describe('barril de chopp', () => {
  it('seed: faturado das torneiras bate com os chopps das comandas', () => {
    expect(tap(1).billed_volume_ml).toBe(4 * 500 + 2 * 300); // mesa 2: 4x 500 ml + 2x 300 ml
    expect(tap(2).billed_volume_ml).toBe(6 * 500); // mesa 22: 6x IPA 500 ml
    expect(tap(1).remaining_volume_ml).toBe(50000 - 2600 - 600);
  });

  it('volume vem da opção de tamanho e o cancelamento devolve ou vira desperdício', () => {
    const orderId = openTable();
    const before = tap(1).billed_volume_ml;
    const [caneca] = launchChopp(orderId, 2, size('caneca'));
    expect(caneca!.keg_volume_ml).toBe(1000);
    expect(tap(1).billed_volume_ml).toBe(before + 2000);

    // Cancelado antes de servir: volta para o barril.
    expect(st().cancelOrderItem(caneca!.id, MANAGER).ok).toBe(true);
    expect(tap(1).billed_volume_ml).toBe(before);
    expect(tap(1).wasted_foam_ml).toBe(600);

    // Servido e cancelado: sai do faturado e vira desperdício.
    const [copo] = launchChopp(orderId, 1, size('300'));
    st().advanceItems([copo!.id]);
    st().advanceItems([copo!.id]);
    expect(st().orderItems.find((i) => i.id === copo!.id)!.status).toBe('READY');
    expect(st().cancelOrderItem(copo!.id, MANAGER).ok).toBe(true);
    expect(tap(1).billed_volume_ml).toBe(before);
    expect(tap(1).wasted_foam_ml).toBe(900);
  });

  it('alerta vermelho quando o volume real diverge do faturado', () => {
    const ipa = kegStatus(tap(2));
    // 30 L − 26,3 L medidos = 3,7 L saíram; 3,0 L faturados + 0,4 L registrados → 0,3 L sem explicação (8,1%).
    expect(ipa.realConsumedMl).toBe(3700);
    expect(ipa.unexplainedLossMl).toBe(300);
    expect(ipa.alert).toBe('CRITICAL');
    expect(kegStatus(tap(1)).alert).toBe('OK');
    expect(st().login('7777').ok).toBe(true);
    expect(st().recordKegReading(tap(2).id, 26600).ok).toBe(true); // nova leitura: perda zerada
    expect(kegStatus(tap(2)).alert).toBe('OK');
  });

  it('troca de barril exige gerente, guarda histórico e zera contadores', () => {
    expect(st().login('7777').ok).toBe(true);
    expect(st().tapNewKeg(tap(1).id, { beer_name: 'Pilsen 30L', total_capacity_ml: 30000, keg_cost: 320 }, { managerPin: '0000', reason: 'Barril secou' }).ok).toBe(false);
    const r = st().tapNewKeg(tap(1).id, { beer_name: 'Pilsen 30L', total_capacity_ml: 30000, keg_cost: 320 }, { managerPin: '9999', reason: 'Barril secou' });
    expect(r.ok).toBe(true);
    expect(tap(1).billed_volume_ml).toBe(0);
    expect(tap(1).remaining_volume_ml).toBe(30000);
    expect(st().kegHistory[0]!.billed_volume_ml).toBe(2600);
    expect(st().auditLogs[0]!.action_type).toBe('KEG_CHANGED');
  });
});

describe('buffet a quilo (balança)', () => {
  it('quantidade e preço vêm do peso e do cadastro', () => {
    const orderId = openTable();
    const buffet = product('901');
    expect(buffet.unit).toBe('KG');
    const r = st().addWeighedToTray(orderId, buffet.id, 645, 280, 'SCALE');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.quantity).toBe(0.365);
    expect(r.data.unit_price).toBe(79.9);
    const d = st().dispatchTray(orderId);
    if (!d.ok) throw new Error(d.error);
    const item = d.data.items[0]!;
    expect(item.total_item_price).toBe(29.16);
    expect(item.weight_gross_grams).toBe(645);
    expect(item.weight_tare_grams).toBe(280);
    expect(item.status).toBe('DELIVERED');
    expect(item.notes).toContain('Peso 645 g');
  });

  it('não aceita preço forjado, peso menor que a tara nem venda sem balança', () => {
    const orderId = openTable();
    const buffet = product('901');
    const forged = st().addToTray({
      order_id: orderId, product_id: buffet.id, half_product_ids: [], quantity: 5, unit_price: 1, modifiers: [], modifiers_unit_price: 0,
      meat_doneness: null, quick_tags: [], free_notes: '', sector: buffet.sector, weight: { gross_grams: 1280, tare_grams: 280, source: 'MANUAL' },
    });
    expect(forged.ok && forged.data.quantity === 1 && forged.data.unit_price === 79.9).toBe(true);
    expect(st().addWeighedToTray(orderId, buffet.id, 200, 280, 'SCALE').ok).toBe(false);
    const noScale = st().addToTray({
      order_id: orderId, product_id: buffet.id, half_product_ids: [], quantity: 1, unit_price: 79.9, modifiers: [], modifiers_unit_price: 0,
      meat_doneness: null, quick_tags: [], free_notes: '', sector: buffet.sector,
    });
    expect(noScale.ok).toBe(false);
    expect(st().qrPlaceOrder(table(3).id, [{ product_id: buffet.id, half_product_ids: [], quantity: 1, unit_price: 79.9, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: 'NONE' }]).ok).toBe(false);
  });

  it('protocolo Toledo/Filizola: STX peso ETX, instável e sobrecarga', async () => {
    expect(parseScaleFrame(encodeScaleFrame('00645'))).toEqual({ kind: 'STABLE', grams: 645 });
    expect(parseScaleFrame([0x02, ...'0.645'.split('').map((c) => c.charCodeAt(0)), 0x03])).toEqual({ kind: 'STABLE', grams: 645 });
    expect(parseScalePayload('IIIII').kind).toBe('UNSTABLE');
    expect(parseScalePayload('SSSSS').kind).toBe('OVERLOAD');
    expect(parseScalePayload('NNNNN').kind).toBe('NEGATIVE');
    expect(parseScaleFrame([0x02, 0x30])).toBeNull();
    expect(computeNetWeight(645, 280)).toMatchObject({ netGrams: 365, quantityKg: 0.365 });
    vi.useFakeTimers();
    const p = readStable(new SimulatedScale(812));
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ kind: 'STABLE', grams: 812 });
  });
});

describe('ficha rápida (balcão & eventos)', () => {
  function sell() {
    expect(st().login('5555').ok).toBe(true);
    const r = st().createCounterSale([
      { product_id: product('201').id, quantity: 3, modifiers: [size('500')], meat_doneness: null },
      { product_id: product('313').id, quantity: 2, modifiers: [], meat_doneness: null },
    ]);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  it('venda sem mesa, sem 10%, uma ficha por unidade só depois de pago', () => {
    const tapBefore = tap(1).billed_volume_ml;
    const order = sell();
    expect(order.charge_service_fee).toBe(false);
    expect(order.total_amount).toBe(3 * 18.9 + 2 * 34.9);
    expect(tap(1).billed_volume_ml).toBe(tapBefore + 1500);
    expect(st().tables.find((t) => t.kind === 'COUNTER')!.status).toBe('FREE');
    expect(st().issueEventTickets(order.id).ok).toBe(false); // não pago
    expect(payAll(order.id).closed).toBe(true);

    const t1 = st().issueEventTickets(order.id);
    if (!t1.ok) throw new Error(t1.error);
    expect(t1.data).toHaveLength(5);
    expect(new Set(t1.data.map((t) => t.barcode_token)).size).toBe(5);
    expect(t1.data.every((t) => isValidTicketToken(t.barcode_token))).toBe(true);
    // Reimpressão devolve as MESMAS fichas (não duplica crédito).
    const t2 = st().issueEventTickets(order.id);
    expect(t2.ok && t2.data.map((t) => t.id)).toEqual(t1.data.map((t) => t.id));
    expect(st().eventTickets).toHaveLength(5);
  });

  it('resgate único: segunda leitura é recusada e o item é entregue com a última ficha', () => {
    const order = sell();
    payAll(order.id);
    const tickets = (st().issueEventTickets(order.id) as { ok: true; data: ReturnType<typeof st>['eventTickets'] }).data;
    const pastel = tickets.filter((t) => t.product_id === product('313').id);
    expect(st().redeemEventTicket(pastel[0]!.barcode_token.toLowerCase()).ok).toBe(true);
    const again = st().redeemEventTicket(pastel[0]!.barcode_token);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('JÁ USADA');
    const itemId = pastel[0]!.order_item_id;
    expect(st().orderItems.find((i) => i.id === itemId)!.status).toBe('PENDING');
    expect(st().redeemEventTicket(pastel[1]!.barcode_token).ok).toBe(true);
    expect(st().orderItems.find((i) => i.id === itemId)!.status).toBe('DELIVERED');
    // Código digitado errado (1 caractere trocado) é pego pelo dígito verificador.
    const tok = tickets[0]!.barcode_token;
    const typo = tok.slice(0, 3) + (tok[3] === 'A' ? 'B' : 'A') + tok.slice(4);
    expect(st().redeemEventTicket(typo).ok).toBe(false);
  });

  it('venda não paga só é desfeita com PIN de gerente e devolve o chopp ao barril', () => {
    const tapBefore = tap(1).billed_volume_ml;
    const order = sell();
    expect(st().voidCounterSale(order.id, { managerPin: '1234', reason: 'Cartão recusado' }).ok).toBe(false);
    expect(st().voidCounterSale(order.id, { managerPin: '9999', reason: 'Cartão recusado' }).ok).toBe(true);
    expect(st().orders.find((o) => o.id === order.id)!.status).toBe('CANCELED');
    expect(st().orderItems.filter((i) => i.order_id === order.id).every((i) => i.status === 'CANCELED')).toBe(true);
    expect(st().auditLogs.filter((l) => l.action_type === 'ITEM_CANCELED' && l.order_id === order.id)).toHaveLength(2);
    expect(tap(1).billed_volume_ml).toBe(tapBefore);
  });

  it('venda de balcão não aparece no mapa nem aceita produto pesado', () => {
    expect(st().login('5555').ok).toBe(true);
    expect(st().createCounterSale([{ product_id: product('901').id, quantity: 1, modifiers: [], meat_doneness: null }]).ok).toBe(false);
    expect(st().createCounterSale([{ product_id: product('201').id, quantity: 1.5, modifiers: [size('300')], meat_doneness: null }]).ok).toBe(false);
    expect(st().createCounterSale([{ product_id: product('201').id, quantity: 1, modifiers: [], meat_doneness: null }]).ok).toBe(false); // tamanho obrigatório
  });
});

describe('tokens antifraude', () => {
  it('16 caracteres Crockford com dígito verificador', () => {
    for (let i = 0; i < 200; i++) {
      const t = generateTicketToken();
      expect(t).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      expect(isValidTicketToken(t)).toBe(true);
    }
    expect(TICKET_ALPHABET).toHaveLength(32);
    expect(normalizeTicketToken('ab0o-il1 ')).toBe('AB0011' + '1');
  });
});

describe('cashback no WhatsApp', () => {
  function closedOrder() {
    const orderId = openTable(4);
    launchChopp(orderId, 4, size('500')); // 4 x 18,90 = 75,60 + 10% = 83,16
    payAll(orderId);
    return orderId;
  }

  it('credita 5% sem a taxa de serviço, com opt-in e uma vez por conta', () => {
    const orderId = closedOrder();
    const order = st().orders.find((o) => o.id === orderId)!;
    expect(order.total_amount).toBe(83.16);
    expect(cashbackEarnAmount(order)).toBe(3.78); // 5% de 75,60
    expect(st().earnCashback(orderId, { phone: '(55) 99999-1234', name: 'Ana', cpf: null, optIn: false }).ok).toBe(false);
    const r = st().earnCashback(orderId, { phone: '(55) 99999-1234', name: 'Ana Paula', cpf: null, optIn: true });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.customer.phone_whatsapp).toBe('5555999991234');
    expect(r.data.entry.amount).toBe(3.78);
    expect(new Date(r.data.entry.valid_from!) > new Date()).toBe(true); // só na próxima visita
    expect(st().earnCashback(orderId, { phone: '55999991234', name: null, cpf: null, optIn: true }).ok).toBe(false);
  });

  it('resgate só de terça a quinta, até 50% da conta, FIFO, e trava desconto manual', () => {
    vi.useFakeTimers({ now: new Date('2026-11-09T21:00:00-03:00'), toFake: ['Date'] }); // segunda à noite
    const first = closedOrder();
    expect(st().earnCashback(first, { phone: '55999991234', name: 'Ana', cpf: null, optIn: true }).ok).toBe(true);

    const second = openTable(6);
    launchChopp(second, 1, size('300')); // 12,90 + 1,29 = 14,19
    expect(st().redeemCashback(second, '55999991234').ok).toBe(false); // segunda-feira

    vi.setSystemTime(new Date('2026-11-10T20:00:00-03:00')); // terça
    expect(isCashbackDay(new Date())).toBe(true);
    const r = st().redeemCashback(second, '(55) 99999-1234');
    if (!r.ok) throw new Error(r.error);
    expect(r.data.amount).toBe(3.78); // cap 50% de 14,19 = 7,10 > saldo
    const order = st().orders.find((o) => o.id === second)!;
    expect(order.discount_amount).toBe(3.78);
    expect(order.total_amount).toBe(10.41);
    expect(st().auditLogs[0]!.action_type).toBe('CASHBACK_REDEEMED');
    expect(st().loyaltyCustomers[0]!.cashback_balance).toBe(0);
    // Extrato e cliente do resgate sobem presos à comanda do resgate.
    const tagged = st().outbox.filter((e) => (e.table === 'cashback_ledger' || e.table === 'loyalty_customers') && e.depends_on_order_id === second);
    expect(tagged.map((e) => `${e.table} ${e.op}`).sort()).toEqual(['cashback_ledger INSERT', 'cashback_ledger UPDATE', 'loyalty_customers UPDATE']);
    expect(st().redeemCashback(second, '55999991234').ok).toBe(false);
    expect(st().applyDiscount(second, 2, MANAGER).ok).toBe(false);
  });

  it('valida WhatsApp brasileiro', () => {
    expect(normalizeWhatsapp('(55) 99999-1234')).toBe('5555999991234');
    expect(normalizeWhatsapp('+55 51 3333-4444')).toBe('555133334444');
    expect(normalizeWhatsapp('99999-1234')).toBeNull();
    expect(normalizeWhatsapp('(55) 89999-1234')).toBeNull();
  });
});
