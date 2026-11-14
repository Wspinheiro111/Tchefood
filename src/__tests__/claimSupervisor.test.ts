/**
 * r7 P1-4 / P2-8: depois do fim conhecido, a reserva continua viva (batimento pelo laço de sincronização, a
 * partir do registro persistido) até o servidor consumir; liberada antes do pagamento chegar: alerta e trava.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginLocalClaim, localClaim, resetClaimLedger, settleLocalClaim, settledClaims } from '../lib/payments/claimLedger';
import { resetClaimSupervisor, superviseSettledClaims, type SupervisorDeps } from '../lib/payments/claimSupervisor';
import { CLAIM_RELEASED_BEFORE_PUSH } from '../lib/payments/claimFlow';
import type { Payment } from '../types';
import type { ReviewHold } from '../lib/payments/reviewHolds';

const TOKEN = 'cd'.repeat(32);
const pay = (key: string, status: Payment['status'] = 'APPROVED'): Payment => ({
  id: `p-${key}`, idempotency_key: key, status, amount: 12, method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S1',
} as unknown as Payment);

function settled(key: string, token: string | null = TOKEN) {
  beginLocalClaim(key, 'o1', token);
  settleLocalClaim(key);
}

function deps(over: Partial<SupervisorDeps> = {}) {
  const holds: Array<Omit<ReviewHold, 'created_at'>> = [];
  const alerts: string[] = [];
  const d: SupervisorDeps = {
    touch: vi.fn(async () => ({ ok: true as const, status: 'open' as const, activeUntil: null })),
    payments: () => [],
    unpushed: () => true,
    hold: () => null,
    setHold: (h) => void holds.push(h),
    alert: (t) => void alerts.push(t),
    ...over,
  };
  return { d, holds, alerts };
}

beforeEach(() => {
  resetClaimLedger();
  resetClaimSupervisor();
});

describe('superviseSettledClaims', () => {
  it('pagamento aprovado aqui: renova com o segredo (no máximo a cada 20 s) até consumed, e então sai do registro', async () => {
    settled('k-1');
    const { d } = deps({ payments: () => [pay('k-1')] });
    expect(await superviseSettledClaims(d, 1_000_000)).toBe(0);
    expect(d.touch).toHaveBeenCalledWith('k-1', TOKEN);
    expect(await superviseSettledClaims(d, 1_010_000)).toBe(0);
    expect(d.touch).toHaveBeenCalledTimes(1);
    (d.touch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 'consumed', activeUntil: null });
    expect(await superviseSettledClaims(d, 1_021_000)).toBe(1);
    expect(localClaim('k-1')).toBeNull();
  });

  it('sem rede: mantém o registro e tenta de novo; recusa definitiva (TF005/TF004) tira do registro', async () => {
    settled('k-2');
    const { d } = deps({ payments: () => [pay('k-2')], touch: vi.fn(async () => ({ ok: false as const, offline: true as const, error: 'rede' })) });
    await superviseSettledClaims(d, 0, true);
    expect(localClaim('k-2')).not.toBeNull();
    (d.touch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, code: 'TF005', error: 'x' });
    expect(await superviseSettledClaims(d, 0, true)).toBe(1);
    expect(settledClaims()).toEqual([]);
  });

  it('gerente liberou antes do pagamento chegar ao servidor: alerta, trava CLAIM_RELEASED e sai do registro', async () => {
    settled('k-3');
    const { d, holds, alerts } = deps({ payments: () => [pay('k-3')], touch: vi.fn(async () => ({ ok: true as const, status: 'released' as const, activeUntil: null })) });
    expect(await superviseSettledClaims(d, 0, true)).toBe(1);
    expect(alerts).toEqual([CLAIM_RELEASED_BEFORE_PUSH]);
    expect(holds).toEqual([expect.objectContaining({ order_id: 'o1', code: 'CLAIM_RELEASED', reason: CLAIM_RELEASED_BEFORE_PUSH, idempotency_key: 'k-3', amount: 12, acquirer: 'STONE' })]);
    expect(localClaim('k-3')).toBeNull();
  });

  it('liberada, mas o pagamento já subiu: sem alerta (o servidor decide), sai do registro', async () => {
    settled('k-4');
    const { d, alerts } = deps({ payments: () => [pay('k-4')], unpushed: () => false, touch: vi.fn(async () => ({ ok: true as const, status: 'released' as const, activeUntil: null })) });
    await superviseSettledClaims(d, 0, true);
    expect(alerts).toEqual([]);
    expect(localClaim('k-4')).toBeNull();
  });

  it('sem pagamento aprovado: com trava da chave guarda o segredo sem renovar; sem trava sai do registro', async () => {
    settled('k-5');
    settled('k-6');
    const { d } = deps({
      payments: () => [pay('k-6', 'DECLINED')],
      hold: () => ({ order_id: 'o1', amount: 1, reason: 'r', code: 'TIMEOUT', created_at: 'x', idempotency_key: 'k-5' }),
    });
    expect(await superviseSettledClaims(d, 0, true)).toBe(1);
    expect(d.touch).not.toHaveBeenCalled();
    expect(localClaim('k-5')).not.toBeNull();
    expect(localClaim('k-6')).toBeNull();
  });

  it('registros "charging" (cobrança em andamento ou app caiu no meio) não são tocados', async () => {
    beginLocalClaim('k-7', 'o1', TOKEN);
    const { d } = deps({ payments: () => [pay('k-7')] });
    expect(await superviseSettledClaims(d, 0, true)).toBe(0);
    expect(d.touch).not.toHaveBeenCalled();
    expect(localClaim('k-7')).not.toBeNull();
  });
});
