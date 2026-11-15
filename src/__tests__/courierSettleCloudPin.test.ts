// Acerto com o entregador pela nuvem: o PIN de quem acertou vai junto e a recusa dele é
// definitiva; pagamento de conta paga na entrega ainda na fila segura o acerto (GPT, rodada 10 do PR #54).
import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore, type PickupLine } from '../store/useTcheStore';
import type { FetchLike } from '../lib/sync/supabaseSync';
import { COURIER_SETTLE_PIN_REFUSED, settleCourierInCloud } from '../lib/sync/courierSettle';

const st = () => useTcheStore.getState();
const cfg = { url: 'http://cloud.test', anonKey: 'anon', accessToken: 'jwt' };
const req = { id: 'a1', courier_id: 'c1', delivery_ids: ['d1'], cash_collected: 0, courier_fees: 7, staff_id: 'u1', staff_pin: '5555' };

beforeEach(() => {
  st().resetDemo();
  expect(st().login('5555').ok).toBe(true);
});

describe('acerto pela nuvem: PIN de quem acertou (GPT, rodada 10 do PR #54)', () => {
  it('manda o PIN e trata {"error":"TCHEFOOD_PIN_RECUSADO"} como recusa definitiva', async () => {
    let sent: Record<string, unknown> = {};
    const fetchFn: FetchLike = async (_url, init) => {
      sent = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ error: 'TCHEFOOD_PIN_RECUSADO' }) };
    };
    const r = await settleCourierInCloud(cfg, req, fetchFn);
    expect(sent).toMatchObject({ p_staff: 'u1', p_staff_pin: '5555' });
    expect(r).toEqual({ ok: false, refused: true, message: COURIER_SETTLE_PIN_REFUSED, code: 'TCHEFOOD_PIN_RECUSADO' });
  });

  it('a loja manda o PIN de quem está no aparelho; recusa do PIN: nada sai da gaveta e o acerto não fica pendente', async () => {
    const zone = st().deliveryZones.find((z) => z.name === 'Centro')!;
    const line: PickupLine = { product_id: st().products.find((p) => p.code === '301')!.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' };
    const o = st().createPickupOrder({
      lines: [line], fulfillment: 'DELIVERY', customerName: 'Maria',
      delivery: { customerName: 'Maria', phone: '(55) 99653-8255', address: 'Rua 1', reference: '', zoneId: zone.id, payOnDelivery: true, changeFor: null },
    });
    if (!o.ok) throw new Error(o.error);
    const d = st().ownDeliveries.find((x) => x.order_id === o.data.id)!;
    const courier = st().couriers[0]!;
    expect(st().setOwnDeliveryStatus(d.id, 'READY').ok).toBe(true);
    expect(st().dispatchOwnDeliveries([d.id], courier.id).ok).toBe(true);
    expect(st().setOwnDeliveryStatus(d.id, 'DELIVERED').ok).toBe(true);
    useTcheStore.setState((s) => ({
      cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: s.tenant.id },
      outbox: [],
    }));
    const pin = st().staff.find((u) => u.id === st().currentUserId)!.pin_code;
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      return { ok: true, status: 200, text: async () => JSON.stringify({ error: 'TCHEFOOD_PIN_RECUSADO' }) };
    };
    const payments = st().payments.length;
    const r = await st().settleCourierOnline(courier.id, { payFromDrawer: false, auth: null, fetchFn });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ p_staff: st().currentUserId, p_staff_pin: pin });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/A nuvem recusou o PIN de quem está acertando\. Saia e entre de novo com o seu PIN atual\..*Nada saiu da gaveta/) });
    expect(st().courierSettlePending ?? []).toEqual([]);
    expect(st().payments).toHaveLength(payments);
    expect(st().ownDeliveries.find((x) => x.id === d.id)!.settlement_id).toBeNull();

    // Pagamento da conta paga na entrega ainda na fila: o acerto espera (a nuvem tem outro saldo).
    const pay = st().registerPayment({
      orderId: o.data.id, amount: 1, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'k-parcial', item_ids: [],
    });
    if (!pay.ok) throw new Error(pay.error);
    useTcheStore.setState((s) => ({ outbox: s.outbox.filter((e) => e.table === 'payments') }));
    expect(st().outbox.length).toBeGreaterThan(0);
    const held = await st().settleCourierOnline(courier.id, { payFromDrawer: false, auth: null, fetchFn });
    expect(held).toMatchObject({ ok: false, error: expect.stringMatching(/A nuvem ainda não recebeu todas as contas pagas na entrega/) });
    expect(bodies).toHaveLength(1);
  });
});
