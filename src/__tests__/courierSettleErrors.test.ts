// Acerto pela nuvem: texto técnico do banco/PostgREST não chega ao operador, e resposta com
// número nulo não vira zero (auditoria do PR #54).
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../lib/sync/supabaseSync';
import { COURIER_SETTLE_PIN_REFUSED, parseSettlementRow, settleCourierInCloud } from '../lib/sync/courierSettle';

const cfg = { url: 'http://cloud.test', anonKey: 'anon', accessToken: 'jwt' };
const req = { id: 'a1', courier_id: 'c1', delivery_ids: ['d1'], cash_collected: 0, courier_fees: 7, staff_id: 'u1', staff_pin: '5555', payments: [] };
const reply = (status: number, body: unknown): FetchLike => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1', tenant_id: 't1', courier_id: 'c1', settled_by_user_id: 'u1',
  deliveries: 1, cash_collected: 0, courier_fees: 7, cash_movement_id: null, delivery_ids: ['d1'], created_at: '2026-11-15T10:00:00Z',
  ...over,
});

describe('acerto pela nuvem: mensagens para o operador', () => {
  it('PGRST202 (função não encontrada) não aparece em inglês; segue recusa definitiva', async () => {
    const r = await settleCourierInCloud(cfg, req, reply(404, {
      code: 'PGRST202', message: 'Could not find the function public.tchefood_settle_courier(p_id) in the schema cache', details: null, hint: null,
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refused).toBe(true);
    expect(r.message).not.toMatch(/Could not find|schema cache/);
    expect(r.message).toMatch(/404/);
    expect(r.message).toMatch(/PGRST202/);
    expect(r.message).toMatch(/Atualize o aplicativo ou fale com o suporte/);
    expect(r.code).toBeUndefined();
  });

  it('22P02 (uuid inválido) também vira texto genérico em português', async () => {
    const r = await settleCourierInCloud(cfg, req, reply(400, { code: '22P02', message: 'invalid input syntax for type uuid: "x"' }));
    expect(r).toMatchObject({ ok: false, refused: true });
    if (r.ok) return;
    expect(r.message).not.toMatch(/invalid input syntax/);
    expect(r.message).toMatch(/400.*22P02/);
  });

  it('resposta 4xx sem JSON não mostra o corpo cru', async () => {
    const r = await settleCourierInCloud(cfg, req, reply(400, '<html>Bad Request</html>'));
    expect(r).toMatchObject({ ok: false, refused: true });
    if (r.ok) return;
    expect(r.message).not.toMatch(/html|Bad Request/);
    expect(r.message).toMatch(/400/);
  });

  it('recusa TCHEFOOD_* continua com o texto do banco, sem o código', async () => {
    const r = await settleCourierInCloud(cfg, req, reply(400, { message: 'TCHEFOOD_ENTREGA: a entrega ainda não foi entregue.' }));
    expect(r).toMatchObject({ ok: false, refused: true, code: 'TCHEFOOD_ENTREGA', message: 'A entrega ainda não foi entregue.' });
  });

  it('5xx segue como sem confirmação (não definitiva)', async () => {
    const r = await settleCourierInCloud(cfg, req, reply(503, { message: 'upstream connect error' }));
    expect(r).toEqual({ ok: false, refused: false, message: 'A nuvem não confirmou o acerto (erro 503).' });
  });

  it('PIN recusado: texto diz o que fazer', () => {
    expect(COURIER_SETTLE_PIN_REFUSED).toBe('A nuvem recusou o PIN de quem está acertando. Saia e entre de novo com o seu PIN atual.');
  });
});

describe('parseSettlementRow: número nulo ou vazio não vira zero', () => {
  it('aceita número e texto numérico', () => {
    expect(parseSettlementRow(row())).toMatchObject({ deliveries: 1, cash_collected: 0, courier_fees: 7 });
    expect(parseSettlementRow(row({ cash_collected: '12.50', courier_fees: '7', deliveries: '1' }))).toMatchObject({ deliveries: 1, cash_collected: 12.5, courier_fees: 7 });
  });

  for (const field of ['cash_collected', 'courier_fees', 'deliveries'] as const) {
    for (const bad of [null, undefined, '', '  ', true, []] as unknown[]) {
      it(`${field} = ${JSON.stringify(bad)} é resposta inválida`, () => {
        expect(parseSettlementRow(row({ [field]: bad }))).toBeNull();
      });
    }
  }

  it('settleCourierInCloud trata cash_collected nulo como resposta inválida', async () => {
    const r = await settleCourierInCloud(cfg, req, reply(200, row({ cash_collected: null })));
    expect(r).toEqual({ ok: false, refused: false, message: 'Resposta inválida da nuvem ao acerto.' });
  });
});
