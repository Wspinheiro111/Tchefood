// @vitest-environment jsdom
/**
 * Auditoria GPT r10 ("a verificar 1"): uma chave do localStorage por entrada no registro de reservas, nas travas de
 * conferência e nas cobranças da Point deste aparelho. Cada mudança grava só a própria entrada: duas abas gravando
 * juntas não apagam uma a outra (a prova com duas abas de verdade é twoTabStorage.browser.test.ts). Aqui: o que é
 * gravado, a migração dos formatos antigos e a gravação que falha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN_A = 'aa'.repeat(32);
const TOKEN_B = 'bb'.repeat(32);

async function freshLedger() {
  vi.resetModules();
  return import('../lib/payments/claimLedger');
}
async function freshHolds() {
  vi.resetModules();
  return import('../lib/payments/reviewHolds');
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('claimLedger: uma chave por entrada', () => {
  it('gravar uma reserva só escreve a chave dela (nunca regrava as das outras abas)', async () => {
    const ledger = await freshLedger();
    ledger.beginLocalClaim('K-A', 'o1', TOKEN_A);
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const del = vi.spyOn(Storage.prototype, 'removeItem');
    ledger.beginLocalClaim('K-B', 'o2', TOKEN_B);
    ledger.addPendingRelease({ key: 'K-R', order_id: 'o2', reason: 'r', release_token: TOKEN_B });
    ledger.endLocalClaim('K-B');
    expect(set.mock.calls.map((c) => c[0])).toEqual(['tchefood.paymentClaims.v2:c:K-B', 'tchefood.paymentClaims.v2:r:K-R']);
    expect(del.mock.calls.map((c) => c[0])).toEqual(['tchefood.paymentClaims.v2:c:K-B']);
    expect(JSON.parse(localStorage.getItem('tchefood.paymentClaims.v2:c:K-A')!)).toMatchObject({ key: 'K-A', release_token: TOKEN_A, state: 'charging' });
  });

  it('a gravação de outra aba feita "por cima" de uma leitura antiga não apaga a reserva desta', async () => {
    const tabB = await freshLedger();
    expect(tabB.inFlightClaims()).toEqual([]);
    const tabA = await freshLedger();
    tabA.beginLocalClaim('K-A', 'o1', TOKEN_A);
    // B grava a sua reserva (um setItem na chave dela): a de A, em outra chave, não é tocada.
    tabB.beginLocalClaim('K-B', 'o2', TOKEN_B);
    const reopened = await freshLedger();
    expect(reopened.localClaim('K-A')?.release_token).toBe(TOKEN_A);
    expect(reopened.localClaim('K-B')?.release_token).toBe(TOKEN_B);
  });

  it('ordem estável pela hora (a ordem das chaves do localStorage não conta)', async () => {
    const ledger = await freshLedger();
    localStorage.setItem('tchefood.paymentClaims.v2:c:Z', JSON.stringify({ key: 'Z', order_id: 'o', started_at: '2026-11-01T10:00:00Z' }));
    localStorage.setItem('tchefood.paymentClaims.v2:c:A', JSON.stringify({ key: 'A', order_id: 'o', started_at: '2026-11-01T11:00:00Z' }));
    expect(ledger.inFlightClaims().map((c) => c.key)).toEqual(['Z', 'A']);
  });

  it('entrada corrompida ou de outra chave é ignorada (as outras valem)', async () => {
    const ledger = await freshLedger();
    ledger.beginLocalClaim('K-A', 'o1', TOKEN_A);
    localStorage.setItem('tchefood.paymentClaims.v2:c:X', '{não é json');
    localStorage.setItem('tchefood.paymentClaims.v2:c:Y', JSON.stringify({ key: 'outra', order_id: 'o' }));
    expect(ledger.inFlightClaims().map((c) => c.key)).toEqual(['K-A']);
  });

  it('migra o registro antigo (uma chave só) e só apaga a antiga depois de gravar tudo', async () => {
    localStorage.setItem('tchefood.paymentClaims.v1', JSON.stringify({
      inFlight: [{ key: 'K-old', order_id: 'o1', started_at: '2026-11-01T10:00:00Z', release_token: TOKEN_A, state: 'settled' }],
      pendingReleases: [{ key: 'K-rel', order_id: 'o1', reason: 'r', created_at: '2026-11-01T10:00:00Z', last_error: null, release_token: TOKEN_B }],
    }));
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const ledger = await freshLedger();
    expect(ledger.localClaim('K-old')?.release_token).toBe(TOKEN_A);
    expect(ledger.pendingRelease('K-rel')?.release_token).toBe(TOKEN_B);
    expect(localStorage.getItem('tchefood.paymentClaims.v1')).not.toBeNull();
    set.mockRestore();
    expect(ledger.localClaim('K-old')).toMatchObject({ state: 'settled', release_token: TOKEN_A });
    expect(localStorage.getItem('tchefood.paymentClaims.v1')).toBeNull();
    expect(JSON.parse(localStorage.getItem('tchefood.paymentClaims.v2:c:K-old')!)).toMatchObject({ release_token: TOKEN_A });
    expect(JSON.parse(localStorage.getItem('tchefood.paymentClaims.v2:r:K-rel')!)).toMatchObject({ release_token: TOKEN_B });
  });

  it('aba com a versão anterior ainda aberta grava no formato antigo: a reserva dela entra, sem apagar as novas', async () => {
    const ledger = await freshLedger();
    ledger.beginLocalClaim('K-new', 'o1', TOKEN_A);
    localStorage.setItem('tchefood.paymentClaims.v1', JSON.stringify({ inFlight: [{ key: 'K-oldtab', order_id: 'o2', started_at: '2026-11-01T10:00:00Z', release_token: TOKEN_B }], pendingReleases: [] }));
    expect(ledger.inFlightClaims().map((c) => c.key).sort()).toEqual(['K-new', 'K-oldtab']);
    expect(ledger.localClaim('K-oldtab')?.release_token).toBe(TOKEN_B);
  });

  it('gravação cheia: falso só para a reserva que não ficou gravada; a que falhou antes tenta de novo', async () => {
    const ledger = await freshLedger();
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.endsWith(':K-big')) throw new DOMException('full', 'QuotaExceededError');
      real.call(this, k, v);
    });
    expect(ledger.beginLocalClaim('K-big', 'o1', TOKEN_A)).toBe(false);
    expect(ledger.claimLedgerUnsaved()).toBe(true);
    expect(ledger.beginLocalClaim('K-small', 'o2', TOKEN_B)).toBe(true);
    expect(ledger.unsavedClaimOrders()).toEqual(['o1']);
    expect(ledger.localClaim('K-big')?.release_token).toBe(TOKEN_A);
    vi.restoreAllMocks();
    ledger.settleLocalClaim('K-small');
    expect(ledger.claimLedgerUnsaved()).toBe(false);
    const reopened = await freshLedger();
    expect(reopened.localClaim('K-big')?.release_token).toBe(TOKEN_A);
  });
});

describe('reviewHolds: uma chave por trava', () => {
  it('gravar ou tirar uma trava só mexe na chave dela', async () => {
    const holds = await freshHolds();
    holds.setReviewHold({ order_id: 'o1', amount: 1, reason: 'a', code: 'X', idempotency_key: 'k1' });
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const del = vi.spyOn(Storage.prototype, 'removeItem');
    holds.setReviewHold({ order_id: 'o1', amount: 2, reason: 'b', code: 'X', idempotency_key: 'k2' });
    holds.clearReviewHold('o1', 'k2');
    expect(set.mock.calls.map((c) => c[0])).toEqual(['tchefood.paymentReviewHolds.v3:k2']);
    expect(del.mock.calls.map((c) => c[0]).filter((k) => k.startsWith('tchefood.paymentReviewHolds.v3:'))).toEqual(['tchefood.paymentReviewHolds.v3:k2']);
    expect(holds.getReviewHoldByKey('k1')).toMatchObject({ reason: 'a' });
  });

  it('migra a lista v2 (também a de uma aba com a versão anterior) e a apaga depois de gravar', async () => {
    const holds = await freshHolds();
    holds.setReviewHold({ order_id: 'o1', amount: 1, reason: 'nova', code: 'X', idempotency_key: 'k-new' });
    localStorage.setItem('tchefood.paymentReviewHolds.v2', JSON.stringify([{ order_id: 'o2', amount: 3, reason: 'v2', code: 'X', idempotency_key: 'k-v2', created_at: '2026-11-01T10:00:00Z' }]));
    expect(holds.getReviewHoldByKey('k-v2')).toMatchObject({ reason: 'v2' });
    expect(holds.getReviewHoldByKey('k-new')).toMatchObject({ reason: 'nova' });
    expect(localStorage.getItem('tchefood.paymentReviewHolds.v2')).toBeNull();
    expect(JSON.parse(localStorage.getItem('tchefood.paymentReviewHolds.v3:k-v2')!)).toMatchObject({ order_id: 'o2' });
  });

  it('migração da v2 com a gravação falhando: a v2 fica e a trava vale', async () => {
    localStorage.setItem('tchefood.paymentReviewHolds.v2', JSON.stringify([{ order_id: 'o2', amount: 3, reason: 'v2', code: 'X', idempotency_key: 'k-v2', created_at: '2026-11-01T10:00:00Z' }]));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const holds = await freshHolds();
    expect(holds.getReviewHold('o2')).toMatchObject({ reason: 'v2' });
    expect(localStorage.getItem('tchefood.paymentReviewHolds.v2')).not.toBeNull();
  });

  it('outra aba grava uma trava (evento storage na chave dela): a tela desta aba é avisada', async () => {
    const holds = await freshHolds();
    holds.getReviewHolds('o1');
    const seen: string[] = [];
    const off = holds.subscribeReviewHolds((o) => seen.push(o));
    localStorage.setItem('tchefood.paymentReviewHolds.v3:k9', JSON.stringify({ order_id: 'o9', amount: 1, reason: 'r', code: 'X', idempotency_key: 'k9', created_at: '2026-11-01T10:00:00Z' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'tchefood.paymentReviewHolds.v3:k9' }));
    off();
    expect(seen).toContain('o9');
    expect(holds.getReviewHold('o9')).toMatchObject({ idempotency_key: 'k9' });
  });
});

describe('pointChargesHere: uma chave por cobrança', () => {
  it('lembrar e esquecer só mexem na própria chave; migra a lista antiga; entrada vencida sai', async () => {
    vi.resetModules();
    localStorage.setItem('tchefood:point-charges-here', JSON.stringify([{ key: 'k-old', orderId: 'o1', at: Date.now() }, { key: 'k-velha', orderId: 'o1', at: Date.now() - 25 * 3600_000 }]));
    const m = await import('../lib/payments/pointChargesHere');
    m.rememberPointChargeHere('k1', 'o1');
    m.rememberPointChargeHere('k2', 'o2');
    expect(m.isPointChargeHere('k-old')).toBe(true);
    expect(m.isPointChargeHere('k-velha')).toBe(false);
    expect(localStorage.getItem('tchefood:point-charges-here')).toBeNull();
    m.forgetPointChargeHere('k1');
    expect(m.isPointChargeHere('k1')).toBe(false);
    expect(m.isPointChargeHere('k2')).toBe(true);
    expect(localStorage.getItem('tchefood:point-charges-here:k-velha')).toBeNull();
  });
});
