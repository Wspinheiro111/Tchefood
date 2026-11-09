import { afterEach, describe, expect, it } from 'vitest';
import { shiftKpis, shiftStart } from '../lib/reports';
import { StonePosDriver } from '../lib/payments/drivers';
import type { Order, Payment } from '../types';

const g = globalThis as unknown as { window?: Record<string, unknown> };
afterEach(() => { delete g.window; });

describe('KPIs do turno', () => {
  it('turno vira às 05:00 e ignora pagamentos e contas de turnos anteriores', () => {
    const now = new Date(2026, 10, 9, 23, 0);
    expect(shiftStart(now).getHours()).toBe(5);
    expect(shiftStart(new Date(2026, 10, 10, 2, 0)).getDate()).toBe(9);
    const since = shiftStart(now);
    const yesterday = new Date(2026, 10, 8, 22, 0).toISOString();
    const today = new Date(2026, 10, 9, 21, 0).toISOString();
    const pay = (amount: number, created_at: string) => ({ amount, status: 'APPROVED', created_at }) as Payment;
    const ord = (closed_at: string, total: number) => ({ status: 'CLOSED', closed_at, opened_at: closed_at, total_amount: total, service_fee_amount: 10, remaining_balance: 0 }) as Order;
    const k = shiftKpis([ord(yesterday, 300), ord(today, 110)], [pay(300, yesterday), pay(110, today)], since);
    expect(k.grossRevenue).toBe(110);
    expect(k.closedOrders).toBe(1);
    expect(k.averageTicket).toBe(110);
    expect(k.serviceFeeTotal).toBe(10);
  });
});

describe('Stone nativa', () => {
  it('entrega cada resultado à cobrança de origem e recusa uma segunda em paralelo', async () => {
    const sent: Array<{ request_id: string }> = [];
    g.window = { StoneBridge: { pay: (json: string) => sent.push(JSON.parse(json)) } };
    const d = new StonePosDriver('SMARTPOS_EMBEDDED', null);
    const base = { idempotency_key: 'k', method: 'CREDIT' as const, table_label: 'Mesa 1', description: 'x' };
    const p1 = d.charge({ ...base, request_id: 'r1', amount: 10, order_id: 'o1' });
    const p2 = await d.charge({ ...base, request_id: 'r2', amount: 20, order_id: 'o2' });
    expect(p2.status).toBe('DECLINED');
    expect(sent).toHaveLength(1);
    const cb = g.window.onStoneResult as (r: unknown) => void;
    cb({ request_id: 'outra', status: 'APPROVED' }); // resultado sem cobrança correspondente é ignorado
    cb({ request_id: 'r1', status: 'APPROVED', acquirer: 'STONE', nsu: '123456' });
    await expect(p1).resolves.toMatchObject({ status: 'APPROVED', nsu: '123456' });
  });
});

describe('DANFE e bandeja', () => {
  it('ESC/POS gera o QR Code nativo (GS ( k) com o tamanho certo', async () => {
    const { UniversalEscPosBuilder } = await import('../services/printer/escposBuilder');
    const data = 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=123';
    const bytes = Array.from(new UniversalEscPosBuilder('58MM').qrCode(data).toBytes());
    const store = bytes.findIndex((b, i) => b === 0x1d && bytes[i + 1] === 0x28 && bytes[i + 2] === 0x6b && bytes[i + 5] === 0x31 && bytes[i + 6] === 0x50);
    expect(store).toBeGreaterThan(-1);
    expect(bytes[store + 3]! + bytes[store + 4]! * 256).toBe(data.length + 3);
  });

  it('DANFE vai para a bobina interna com QR quando existe ponte nativa', async () => {
    const { printDocument } = await import('../lib/payments/drivers');
    const sent: string[] = [];
    g.window = { SmartPosNative: { printInternalEscPos: (b64: string) => { sent.push(b64); return JSON.stringify({ success: true }); } } };
    expect(printDocument({ title: 'DANFE', lines: ['NFC-e'], qr: 'https://x', footer: ['fim'], chassis: 'STONE' })).toBe('NATIVE');
    expect(atob(sent[0]!)).toContain('https://x');
  });

  it('não recebe pagamento com itens na bandeja sem enviar', async () => {
    const { useTcheStore } = await import('../store/useTcheStore');
    const st = useTcheStore.getState;
    st().resetDemo();
    st().login('1111');
    const t = st().tables.find((x) => x.number === 1)!;
    const o = st().openTable(t.id, 1, null);
    if (!o.ok) throw new Error(o.error);
    const p = st().products.find((x) => x.code === '311')!;
    const draft = { order_id: o.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector };
    st().addToTray(draft);
    st().dispatchTray(o.data.id);
    st().addToTray(draft);
    const pay = st().registerPayment({ orderId: o.data.id, amount: 1, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'z', item_ids: [] });
    expect(pay.ok).toBe(false);
    expect(st().beginTerminalCharge(o.data.id, 'r', 1).ok).toBe(false);
  });
});

describe('conta zerada sem pagamento', () => {
  it('cancelar tudo ou dar 100% de desconto permite encerrar e liberar a mesa', async () => {
    const { useTcheStore } = await import('../store/useTcheStore');
    const st = useTcheStore.getState;
    const auth = { managerPin: '9999', reason: 'Cortesia da casa ao cliente' };
    for (const mode of ['cancel', 'discount'] as const) {
      st().resetDemo();
      st().login('1111');
      const t = st().tables.find((x) => x.number === 1)!;
      const o = st().openTable(t.id, 1, null);
      if (!o.ok) throw new Error(o.error);
      const p = st().products.find((x) => x.code === '311')!;
      st().addToTray({ order_id: o.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
      st().dispatchTray(o.data.id);
      expect(st().closeZeroOrder(o.data.id).ok).toBe(false); // ainda tem saldo
      if (mode === 'cancel') {
        const item = st().orderItems.find((i) => i.order_id === o.data.id)!;
        expect(st().cancelOrderItem(item.id, auth).ok).toBe(true);
      } else {
        const ord = st().orders.find((x) => x.id === o.data.id)!;
        expect(st().applyDiscount(o.data.id, ord.subtotal_items + ord.service_fee_amount, auth).ok).toBe(true);
      }
      const r = st().closeZeroOrder(o.data.id);
      expect(r.ok && r.data.status).toBe(mode === 'cancel' ? 'CANCELED' : 'CLOSED');
      expect(st().tables.find((x) => x.id === t.id)!.status).toBe('FREE');
    }
  });
});

describe('PagBank em TEF POS Sem Fio', () => {
  it('não usa a ponte PlugPag local quando o modo é sem fio', async () => {
    const { PagBankPlugPagDriver } = await import('../lib/payments/drivers');
    let called = false;
    g.window = { PlugPagBridge: { doPayment: () => { called = true; return JSON.stringify({ result: 0 }); } } };
    const d = new PagBankPlugPagDriver('TEF_POS_WIRELESS', null);
    void d.charge({ request_id: 'r', idempotency_key: 'k', amount: 10, method: 'CREDIT', table_label: 'Mesa 1', order_id: 'o', description: 'x' });
    expect(called).toBe(false);
  });
});
