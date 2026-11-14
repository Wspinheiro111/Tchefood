/**
 * Fluxo da reserva (r7): segredo gerado no aparelho e gravado antes da chamada, nova tentativa com a mesma
 * chave e o mesmo segredo, batimento com teto, conferência antes de registrar (liberada, sem confirmação há
 * 90 s, outra adquirente) e o registro 'settled' depois do fim conhecido.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const claimPayment = vi.fn();
const touchPaymentClaim = vi.fn();
const releaseClaimAfterNoCharge = vi.fn();
vi.mock('../lib/payments/paymentClaim', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/paymentClaim')>()),
  claimPayment: (...a: unknown[]) => claimPayment(...a),
  touchPaymentClaim: (...a: unknown[]) => touchPaymentClaim(...a),
  releaseClaimAfterNoCharge: (...a: unknown[]) => releaseClaimAfterNoCharge(...a),
}));

const { CLAIM_LEASE_MS, CLAIM_RELEASED_DURING_CHARGE, CLAIM_UNCONFIRMED, startPaymentClaim, checkHoldClaim } = await import('../lib/payments/claimFlow');
const { isClaimActiveHere, localClaim, resetClaimLedger, settledClaims, beginLocalClaim, settleLocalClaim } = await import('../lib/payments/claimLedger');
const { PENDING_CHARGE_TTL_MS } = await import('../store/useTcheStore');

const INPUT = { orderId: 'o1', key: 'k-1', method: 'CREDIT' as const, acquirer: 'STONE' as const, amount: 10 };
const OPEN = { ok: true, claim: { id: 'c', idempotency_key: 'k-1', status: 'open', amount_cents: 1000 } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  resetClaimLedger();
  claimPayment.mockReset().mockResolvedValue(OPEN);
  touchPaymentClaim.mockReset().mockResolvedValue({ ok: true, status: 'open', activeUntil: null });
  releaseClaimAfterNoCharge.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const tokenOf = () => (claimPayment.mock.calls[0]![0] as { releaseToken: string }).releaseToken;

describe('startPaymentClaim: segredo da reserva (P2-1)', () => {
  it('gera 64 hex, grava chave + segredo ANTES de chamar o servidor e manda o segredo na reserva', async () => {
    let seenAtCall: unknown = null;
    claimPayment.mockImplementationOnce(async () => { seenAtCall = localClaim('k-1'); return OPEN; });
    const c = await startPaymentClaim(true, INPUT);
    expect(c.ok).toBe(true);
    expect(tokenOf()).toMatch(/^[0-9a-f]{64}$/);
    expect(seenAtCall).toMatchObject({ key: 'k-1', order_id: 'o1', release_token: tokenOf(), state: 'charging' });
    if (c.ok) c.handle.leave();
  });

  it('prazo vencido e o servidor gravou: nova tentativa com a MESMA chave e o MESMO segredo; sem vazar reserva', async () => {
    claimPayment.mockResolvedValueOnce({ ok: false, offline: true, error: 'sem resposta' }).mockResolvedValueOnce(OPEN);
    const c = await startPaymentClaim(true, INPUT);
    expect(c.ok).toBe(true);
    expect(claimPayment).toHaveBeenCalledTimes(2);
    const [a, b] = claimPayment.mock.calls.map((x) => x[0] as { key: string; releaseToken: string });
    expect(b).toEqual(a);
    expect(releaseClaimAfterNoCharge).not.toHaveBeenCalled();
    if (c.ok) c.handle.settle();
  });

  it('duas vezes sem resposta: não recebe e libera com o segredo (a reserva pode existir no servidor)', async () => {
    claimPayment.mockResolvedValue({ ok: false, offline: true, error: 'sem resposta' });
    expect(await startPaymentClaim(true, INPUT)).toEqual({ ok: false, error: 'sem resposta' });
    expect(releaseClaimAfterNoCharge).toHaveBeenCalledWith('k-1', 'o1', 'Reserva sem resposta do servidor: nada foi recebido', tokenOf());
  });

  it('recusa do servidor: não tenta de novo, não libera e limpa o registro local; exceção conta como sem resposta', async () => {
    claimPayment.mockResolvedValueOnce({ ok: false, code: 'TF003', error: 'saldo' });
    expect((await startPaymentClaim(true, INPUT)).ok).toBe(false);
    expect(claimPayment).toHaveBeenCalledTimes(1);
    expect(localClaim('k-1')).toBeNull();
    expect(releaseClaimAfterNoCharge).not.toHaveBeenCalled();
    claimPayment.mockReset().mockRejectedValue(new Error('x'));
    expect((await startPaymentClaim(true, INPUT)).ok).toBe(false);
    expect(claimPayment).toHaveBeenCalledTimes(2);
    expect(releaseClaimAfterNoCharge).toHaveBeenCalledTimes(1);
  });

  it('sem reserva exigida: nada roda', async () => {
    expect((await startPaymentClaim(false, INPUT)).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claimPayment).not.toHaveBeenCalled();
    expect(touchPaymentClaim).not.toHaveBeenCalled();
  });
});

describe('startPaymentClaim: batimento', () => {
  it('renova a cada 20 s com o segredo e para no fim (settle, noCharge ou leave)', async () => {
    for (const end of ['settle', 'noCharge', 'leave'] as const) {
      claimPayment.mockClear();
      touchPaymentClaim.mockClear();
      const c = await startPaymentClaim(true, INPUT);
      if (!c.ok) throw new Error('claim');
      expect(isClaimActiveHere('k-1')).toBe(true);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(touchPaymentClaim).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(touchPaymentClaim).toHaveBeenCalledWith('k-1', tokenOf());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(touchPaymentClaim).toHaveBeenCalledTimes(2);
      if (end === 'noCharge') c.handle.noCharge('recusou');
      else c.handle[end]();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(touchPaymentClaim).toHaveBeenCalledTimes(2);
    }
  });

  it('teto: para depois de PENDING_CHARGE_TTL_MS mesmo sem fim (P2-3)', async () => {
    const c = await startPaymentClaim(true, INPUT);
    if (!c.ok) throw new Error('claim');
    await vi.advanceTimersByTimeAsync(PENDING_CHARGE_TTL_MS + 60_000);
    const n = touchPaymentClaim.mock.calls.length;
    expect(n).toBe(Math.floor((PENDING_CHARGE_TTL_MS - 1) / 20_000));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(touchPaymentClaim).toHaveBeenCalledTimes(n);
    c.handle.leave();
  });

  it('noCharge leva o segredo da reserva para a liberação', async () => {
    const c = await startPaymentClaim(true, INPUT);
    if (!c.ok) throw new Error('claim');
    c.handle.noCharge('recusou');
    expect(releaseClaimAfterNoCharge).toHaveBeenCalledWith('k-1', 'o1', 'recusou', tokenOf());
  });

  it('settle: o registro fica como "settled" (com o segredo) para o laço manter a reserva viva', async () => {
    const c = await startPaymentClaim(true, INPUT);
    if (!c.ok) throw new Error('claim');
    c.handle.settle();
    expect(isClaimActiveHere('k-1')).toBe(false);
    expect(settledClaims()).toEqual([expect.objectContaining({ key: 'k-1', release_token: tokenOf(), state: 'settled' })]);
  });
});

describe('beforeRegister: antes de registrar a aprovação', () => {
  it('gerente liberou no meio (batimento): não registra; sem cancelar na maquininha', async () => {
    const c = await startPaymentClaim(true, INPUT);
    if (!c.ok) throw new Error('claim');
    touchPaymentClaim.mockResolvedValue({ ok: true, status: 'released', activeUntil: null });
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(touchPaymentClaim).toHaveBeenCalledTimes(1);
    expect(await c.handle.beforeRegister('STONE')).toEqual({ ok: false, code: 'CLAIM_RELEASED', reason: CLAIM_RELEASED_DURING_CHARGE });
    expect(touchPaymentClaim).toHaveBeenCalledTimes(1);
    c.handle.settle();
  });

  it('confere no servidor: aberta registra; liberada não', async () => {
    const c = await startPaymentClaim(true, INPUT);
    if (!c.ok) throw new Error('claim');
    expect(await c.handle.beforeRegister('STONE')).toEqual({ ok: true });
    touchPaymentClaim.mockResolvedValueOnce({ ok: true, status: 'released', activeUntil: null });
    expect(await c.handle.beforeRegister('STONE')).toMatchObject({ ok: false, code: 'CLAIM_RELEASED' });
    c.handle.settle();
  });

  it('sem resposta: dentro de 90 s do último batimento confirmado registra; passou de 90 s, não (P1-3)', async () => {
    const c = await startPaymentClaim(true, INPUT);
    if (!c.ok) throw new Error('claim');
    touchPaymentClaim.mockResolvedValue({ ok: false, offline: true, error: 'rede' });
    await vi.advanceTimersByTimeAsync(CLAIM_LEASE_MS - 1_000);
    expect(await c.handle.beforeRegister('STONE')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await c.handle.beforeRegister('STONE')).toEqual({ ok: false, code: 'CLAIM_UNCONFIRMED', reason: CLAIM_UNCONFIRMED });
    // Um batimento confirmado renova o prazo.
    touchPaymentClaim.mockResolvedValueOnce({ ok: true, status: 'open', activeUntil: null });
    expect(await c.handle.beforeRegister('STONE')).toEqual({ ok: true });
    c.handle.settle();
  });

  it('outra adquirente que a reservada: não registra (P2-6)', async () => {
    const c = await startPaymentClaim(true, INPUT);
    if (!c.ok) throw new Error('claim');
    expect(await c.handle.beforeRegister('PAGBANK')).toMatchObject({ ok: false, code: 'ACQUIRER_MISMATCH' });
    expect(touchPaymentClaim).not.toHaveBeenCalled();
    c.handle.settle();
  });
});

describe('checkHoldClaim: antes de registrar pelo comprovante (P1-2)', () => {
  it('aberta: segue; liberada ou TF005: released; sem resposta: não registra; sem registro local: segue', async () => {
    beginLocalClaim('k-9', 'o1', 'a'.repeat(64));
    settleLocalClaim('k-9');
    expect(await checkHoldClaim('k-9')).toEqual({ ok: true });
    expect(touchPaymentClaim).toHaveBeenLastCalledWith('k-9', 'a'.repeat(64));
    touchPaymentClaim.mockResolvedValueOnce({ ok: true, status: 'released', activeUntil: null });
    expect(await checkHoldClaim('k-9')).toMatchObject({ ok: false, released: true });
    touchPaymentClaim.mockResolvedValueOnce({ ok: false, code: 'TF005', error: 'x' });
    expect(await checkHoldClaim('k-9')).toMatchObject({ ok: false, released: true });
    touchPaymentClaim.mockResolvedValueOnce({ ok: false, offline: true, error: 'rede' });
    expect(await checkHoldClaim('k-9')).toEqual({ ok: false, released: false, error: 'Sem conexão com o servidor para conferir a reserva: tente de novo.' });
    touchPaymentClaim.mockClear();
    expect(await checkHoldClaim('k-outro')).toEqual({ ok: true });
    expect(touchPaymentClaim).not.toHaveBeenCalled();
  });
});
