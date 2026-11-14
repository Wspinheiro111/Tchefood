/**
 * r7 P1-4 / P2-8: depois do fim conhecido, a reserva continua viva (batimento pelo laço de sincronização, a
 * partir do registro persistido) até o servidor consumir; liberada antes do pagamento chegar: alerta e trava.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginLocalClaim, detachLocalClaim, localClaim, resetClaimLedger, settleLocalClaim, settledClaims } from '../lib/payments/claimLedger';
import { ABSENT_SPAN_MS, REJECTED_REASON, resetClaimSupervisor, superviseSettledClaims, WITHDRAWN_REASON, type SupervisorDeps } from '../lib/payments/claimSupervisor';
import { clearReviewHold, getReviewHolds, setReviewHold } from '../lib/payments/reviewHolds';
import { CLAIM_RELEASED_BEFORE_PUSH } from '../lib/payments/claimFlow';
import type { Payment } from '../types';
import type { ReviewHold } from '../lib/payments/reviewHolds';

const TOKEN = 'cd'.repeat(32);
const pay = (key: string, status: Payment['status'] = 'APPROVED', method: Payment['method'] = 'CREDIT'): Payment => ({
  id: `p-${key}`, idempotency_key: key, status, amount: 12, method, acquirer: method === 'CASH' ? 'CASH_DESK' : 'STONE', terminal_id: null, terminal_serial: 'S1',
} as unknown as Payment);

function settled(key: string, token: string | null = TOKEN) {
  beginLocalClaim(key, 'o1', token);
  settleLocalClaim(key);
}

function deps(over: Partial<SupervisorDeps> = {}) {
  const holds: Array<Omit<ReviewHold, 'created_at'>> = [];
  const alerts: string[] = [];
  const withdrawn: Array<[string, string]> = [];
  const d: SupervisorDeps = {
    touch: vi.fn(async () => ({ ok: true as const, status: 'open' as const, activeUntil: null })),
    payments: () => [],
    unpushed: () => true,
    rejected: () => null,
    withdraw: (k, r) => { withdrawn.push([k, r]); return { nfceIssued: false }; },
    hold: () => null,
    setHold: (h) => void holds.push(h),
    alert: (t) => void alerts.push(t),
    openClaimKeys: vi.fn(async () => new Set<string>()),
    ...over,
  };
  return { d, holds, alerts, withdrawn };
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
    // P2-3: recusa com código com o pagamento ainda na fila (ou recusado): guarda o registro.
    (d.touch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, code: 'TF005', error: 'x' });
    expect(await superviseSettledClaims(d, 0, true)).toBe(0);
    expect(localClaim('k-2')).not.toBeNull();
    d.unpushed = () => false;
    d.rejected = () => 'recusado'; // recusado também é "fora do servidor": o primeiro passo (sem tocar) cuida
    d.rejected = () => null;
    // Já no servidor: a recusa tira do registro.
    (d.touch as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ ok: false, code: 'TF005', error: 'x' });
    expect(await superviseSettledClaims(d, 0, true)).toBe(1);
    expect(settledClaims()).toEqual([]);
  });

  it('gerente liberou antes do pagamento chegar ao servidor: alerta, trava CLAIM_RELEASED, tira o pagamento da conta e sai do registro', async () => {
    settled('k-3');
    const { d, holds, alerts, withdrawn } = deps({ payments: () => [pay('k-3')], touch: vi.fn(async () => ({ ok: true as const, status: 'released' as const, activeUntil: null })) });
    expect(await superviseSettledClaims(d, 0, true)).toBe(1);
    const reason = `${CLAIM_RELEASED_BEFORE_PUSH}: o pagamento foi retirado desta conta. Estorne na maquininha.`;
    expect(alerts).toEqual([reason]);
    expect(holds).toEqual([expect.objectContaining({ order_id: 'o1', code: 'CLAIM_RELEASED', reason, refund: 'TERMINAL', idempotency_key: 'k-3', amount: 12, acquirer: 'STONE' })]);
    expect(withdrawn).toEqual([['k-3', WITHDRAWN_REASON]]);
    expect(localClaim('k-3')).toBeNull();
  });

  it('P1-2: conta com NFC-e já emitida: o texto da trava pede o cancelamento da nota', async () => {
    settled('k-nf');
    const { d, holds } = deps({ payments: () => [pay('k-nf')], touch: vi.fn(async () => ({ ok: true as const, status: 'released' as const, activeUntil: null })), withdraw: () => ({ nfceIssued: true }) });
    await superviseSettledClaims(d, 0, true);
    expect(holds[0]!.reason).toMatch(/Estorne na maquininha\. NFC-e já emitida: cancele a nota\.$/);
  });

  it('dinheiro liberado antes de subir: o texto manda devolver o dinheiro (sem maquininha)', async () => {
    settled('k-3c');
    const { d, holds } = deps({ payments: () => [pay('k-3c', 'APPROVED', 'CASH')], touch: vi.fn(async () => ({ ok: true as const, status: 'released' as const, activeUntil: null })) });
    await superviseSettledClaims(d, 0, true);
    expect(holds[0]).toEqual(expect.objectContaining({ code: 'CLAIM_RELEASED', refund: 'CASH', reason: expect.stringContaining('Devolva o dinheiro ao cliente (o pagamento não entrou no servidor).') }));
    expect(holds[0]!.acquirer).toBeUndefined();
  });

  it('P1-A: pagamento recusado pelo servidor (syncRejected): trava PAYMENT_REJECTED com a mensagem, tira da conta, guarda o segredo e não renova mais', async () => {
    settled('k-r');
    const { d, holds, alerts, withdrawn } = deps({ payments: () => [pay('k-r')], rejected: () => 'TF012 reservado maior que o saldo' });
    expect(await superviseSettledClaims(d, 0, true)).toBe(0);
    expect(d.touch).not.toHaveBeenCalled();
    expect(holds).toEqual([expect.objectContaining({ code: 'PAYMENT_REJECTED', idempotency_key: 'k-r', reason: expect.stringContaining('TF012 reservado maior que o saldo') })]);
    expect(alerts).toHaveLength(1);
    expect(withdrawn).toEqual([['k-r', REJECTED_REASON]]);
    // O segredo fica (libera a reserva antes de confirmar o estorno); com o pagamento fora da conta e a trava, não renova.
    expect(localClaim('k-r')).toMatchObject({ release_token: TOKEN });
    d.payments = () => [pay('k-r', 'REFUNDED')];
    d.hold = () => ({ ...holds[0]!, created_at: 'x' });
    await superviseSettledClaims(d, 0, true);
    expect(d.touch).not.toHaveBeenCalled();
    expect(localClaim('k-r')).not.toBeNull();
  });

  it('P1-A: liberada e o pagamento recusado (já fora da fila): também trava e tira da conta', async () => {
    settled('k-rr');
    let rejectedNow = false;
    const touch = vi.fn(async () => { rejectedNow = true; return { ok: true as const, status: 'released' as const, activeUntil: null }; });
    const { d, holds, withdrawn } = deps({ payments: () => [pay('k-rr')], unpushed: () => false, rejected: () => (rejectedNow ? 'recusado' : null), touch });
    await superviseSettledClaims(d, 0, true);
    expect(holds).toEqual([expect.objectContaining({ code: 'CLAIM_RELEASED', idempotency_key: 'k-rr' })]);
    expect(withdrawn).toEqual([['k-rr', WITHDRAWN_REASON]]);
  });

  it('P1/P2-D: a trava do supervisor é por chave e não apaga a revisão manual da mesma conta', async () => {
    clearReviewHold('o1');
    setReviewHold({ order_id: 'o1', amount: 5, reason: 'conferir', code: 'MANUAL_REVIEW', idempotency_key: 'k-man' });
    settled('k-d');
    const { d } = deps({ payments: () => [pay('k-d')], touch: vi.fn(async () => ({ ok: true as const, status: 'released' as const, activeUntil: null })), setHold: (h) => void setReviewHold(h) });
    await superviseSettledClaims(d, 0, true);
    expect(getReviewHolds('o1').map((h) => [h.idempotency_key, h.code]).sort()).toEqual([['k-d', 'CLAIM_RELEASED'], ['k-man', 'MANUAL_REVIEW']]);
    clearReviewHold('o1', 'k-d');
    expect(getReviewHolds('o1').map((h) => h.code)).toEqual(['MANUAL_REVIEW']);
    clearReviewHold('o1');
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
      hold: (k) => (k === 'k-5' ? { order_id: 'o1', amount: 1, reason: 'r', code: 'TIMEOUT', created_at: 'x', idempotency_key: 'k-5' } : null),
    });
    expect(await superviseSettledClaims(d, 0, true)).toBe(1);
    expect(d.touch).not.toHaveBeenCalled();
    expect(localClaim('k-5')).not.toBeNull();
    expect(localClaim('k-6')).toBeNull();
  });

  it('registros "charging" com a cobrança rodando aqui não são tocados nem lidos', async () => {
    beginLocalClaim('k-7', 'o1', TOKEN);
    const { d } = deps({ payments: () => [pay('k-7')] });
    expect(await superviseSettledClaims(d, 0, true)).toBe(0);
    expect(d.touch).not.toHaveBeenCalled();
    expect(d.openClaimKeys).not.toHaveBeenCalled();
    expect(localClaim('k-7')).not.toBeNull();
  });

  it('P3: "charging" de app que caiu: lê sem renovar; sai só depois de 3 leituras ausentes em 2 min ou mais', async () => {
    beginLocalClaim('k-8', 'o1', TOKEN);
    detachLocalClaim('k-8');
    let open = new Set<string>(['k-8']);
    const { d } = deps({ openClaimKeys: vi.fn(async () => open) });
    await superviseSettledClaims(d, 0, true);
    expect(d.touch).not.toHaveBeenCalled();
    expect(localClaim('k-8')?.absent_count ?? 0).toBe(0);
    open = new Set();
    await superviseSettledClaims(d, 1_000, true);
    await superviseSettledClaims(d, 2_000, true);
    await superviseSettledClaims(d, 3_000, true);
    expect(localClaim('k-8')).not.toBeNull(); // 3 leituras, mas em menos de 2 min
    expect(await superviseSettledClaims(d, 1_000 + ABSENT_SPAN_MS, true)).toBe(1);
    expect(localClaim('k-8')).toBeNull();
  });

  it('P3: presente de novo zera a contagem; sem leitura do servidor (null) não conta', async () => {
    beginLocalClaim('k-9', 'o1', TOKEN);
    detachLocalClaim('k-9');
    let open: Set<string> | null = new Set();
    const { d } = deps({ openClaimKeys: vi.fn(async () => open) });
    await superviseSettledClaims(d, 0, true);
    await superviseSettledClaims(d, 60_000, true);
    open = new Set(['k-9']);
    await superviseSettledClaims(d, 100_000, true);
    open = null;
    await superviseSettledClaims(d, 200_000, true);
    open = new Set();
    await superviseSettledClaims(d, 300_000, true);
    expect(localClaim('k-9')).toEqual(expect.objectContaining({ absent_count: 1, absent_first_at: 300_000 }));
  });
});
