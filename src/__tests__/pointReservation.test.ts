import { describe, expect, it } from 'vitest';
import { effectiveReservation, freeCents, pointReservationBlock } from '../lib/payments/pointReservation';
import { fetchPointReservation } from '../lib/sync/cloudPull';
import type { ReviewHold } from '../lib/payments/reviewHolds';

const cfg = { url: 'https://x.supabase.co/', anonKey: 'anon', accessToken: 'jwt' };
const hold = (over: Partial<ReviewHold> = {}): ReviewHold =>
  ({ order_id: 'o1', amount: 30, reason: 'sem resposta', code: 'DISPATCH_UNKNOWN', method: 'CREDIT', acquirer: 'MERCADO_PAGO', idempotency_key: 'k', item_ids: [], ...over }) as ReviewHold;

describe('reserva da Point no caixa (db/schema_point_reserva.sql)', () => {
  it('valor que cabe no saldo livre passa; o que passa dele é recusado com o aviso e o livre', () => {
    const r = effectiveReservation({ reservedCents: 6000, openCharges: 1, manualReview: false }, null);
    expect(freeCents(100, r)).toBe(4000);
    expect(pointReservationBlock(40, 100, r)).toBeNull();
    expect(pointReservationBlock(40.01, 100, r)).toMatch(/^Há uma cobrança na Point em andamento nesta conta \(R\$\s60,00 reservado\)\. Livre para este pagamento: R\$\s40,00\.$/);
    expect(pointReservationBlock(100, 50, r)).toMatch(/Livre para este pagamento: R\$\s0,00/);
  });

  it('sem reserva não bloqueia nada', () => {
    expect(effectiveReservation({ reservedCents: 0, openCharges: 0, manualReview: false }, null)).toBeNull();
    expect(pointReservationBlock(100, 100, null)).toBeNull();
  });

  it('a leitura da nuvem vale; sem ela, a cobrança incerta da Point deste aparelho reserva o valor dela', () => {
    expect(effectiveReservation({ reservedCents: 0, openCharges: 0, manualReview: false }, hold())).toBeNull();
    expect(effectiveReservation(null, hold())).toEqual({ reservedCents: 3000, openCharges: 1, manualReview: true, source: 'device' });
    // Cobrança incerta de outra maquininha não é reserva da Point (o caixa já trata pela trava de conferência).
    expect(effectiveReservation(null, hold({ acquirer: 'STONE' }))).toBeNull();
    expect(effectiveReservation(null, null)).toBeNull();
  });

  it('lê a reserva pelo RPC da loja do token e recusa resposta incompleta', async () => {
    const calls: { url: string; body?: string }[] = [];
    const ok = await fetchPointReservation(cfg, async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200, text: async () => '{"reserved_cents":5500,"open_charges":2,"manual_review":true}' };
    }, 'o1');
    expect(ok).toEqual({ reservedCents: 5500, openCharges: 2, manualReview: true });
    expect(calls).toEqual([{ url: 'https://x.supabase.co/rest/v1/rpc/tchefood_point_reservation', body: '{"p_order":"o1"}' }]);
    await expect(fetchPointReservation(cfg, async () => ({ ok: true, status: 200, text: async () => '{"reserved_cents":-1,"open_charges":0}' }), 'o1')).rejects.toThrow(/resposta incompleta/);
    await expect(fetchPointReservation(cfg, async () => ({ ok: false, status: 400, text: async () => '{"message":"TCHEFOOD_AUTH"}' }), 'o1')).rejects.toThrow(/TCHEFOOD_AUTH/);
  });
});
