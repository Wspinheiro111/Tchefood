import { describe, expect, it } from 'vitest';
import { formatBrasiliaDateTime, reconcileOutcome, runReconcileDecision } from '../lib/cashbackReconcile';

// Achados da rodada 1 do GPT no PR #48.
describe('conciliação do cashback na tela', () => {
  const gen = () => 'novo';

  it('P1-01: decisão confirmada troca o id; a próxima pendência do mesmo cliente não reaproveita a anterior', () => {
    const out = reconcileOutcome({ ok: true, amount: 5, repeated: false }, 'DISCARD', 'x', gen);
    expect(out).toMatchObject({ nextRequestId: 'novo', tone: 'success', reload: true });
    expect(out.message).toMatch(/R\$\s5,00 conciliados sem devolver/);
    expect(reconcileOutcome({ ok: true, amount: 10, repeated: false }, 'RELEASE', 'x', gen).message).toMatch(/R\$\s10,00 liberados/);
  });

  it('P1-01: reenvio que a nuvem já tinha gravado não anuncia conciliação nova, troca o id e lê de novo', () => {
    const out = reconcileOutcome({ ok: true, amount: 5, repeated: true }, 'DISCARD', 'x', gen);
    expect(out).toMatchObject({ nextRequestId: 'novo', reload: true });
    expect(out.message).toContain('já estava gravada');
    expect(out.message).toContain('nada foi conciliado de novo');
  });

  it('P2-01: sem resposta da nuvem o id fica (o reenvio confere sem duplicar); recusa da nuvem também mantém o id', () => {
    const lost = reconcileOutcome({ networkError: 'Failed to fetch' }, 'RELEASE', 'x', gen);
    expect(lost).toMatchObject({ nextRequestId: 'x', tone: 'error', reload: false });
    expect(lost.message).toContain('pode ter sido gravada');
    expect(reconcileOutcome({ ok: false, error: 'PIN de gerente incorreto.' }, 'RELEASE', 'x', gen)).toEqual({
      nextRequestId: 'x', tone: 'error', message: 'PIN de gerente incorreto.', reload: false,
    });
  });

  it('P2-02: a data da retenção sai no horário de Brasília, qualquer que seja o fuso do aparelho', () => {
    // 01:30 UTC de 12/11 é 22:30 de 11/11 em São Paulo (UTC−3).
    expect(formatBrasiliaDateTime('2026-11-12T01:30:00Z')).toBe('11/11/2026, 22:30:00');
  });
});

describe('conciliação: conflito e falhas de rede (segunda auditoria da rodada 1)', () => {
  const gen = () => 'novo';

  it('P2-02: o mesmo id com outra decisão/motivo/gerente não anuncia sucesso; mostra o que está gravado, troca o id e lê de novo', () => {
    const out = reconcileOutcome({ ok: false, conflict: { decision: 'DISCARD', amount: 5, reason: 'Conferido com o cliente' } }, 'DISCARD', 'x', gen);
    expect(out).toMatchObject({ nextRequestId: 'novo', tone: 'error', reload: true });
    expect(out.message).toContain('Conferido com o cliente');
    expect(out.message).toContain('A nova não foi gravada');
  });

  async function run(send: (id: string) => Promise<never | { ok: true; amount: number; repeated: boolean }>, reload: () => Promise<unknown> = async () => {}) {
    const notes: Array<[string, string]> = [];
    const r = await runReconcileDecision({ decision: 'RELEASE', currentId: 'x', newId: gen, send, reload, notify: (t, m) => notes.push([t, m]) });
    return { r, notes };
  }

  it('P2-01: queda antes do envio ou resposta perdida depois do commit: sem rejeição, aviso de incerteza e o mesmo id', async () => {
    const { r, notes } = await run(async () => { throw new TypeError('Failed to fetch'); });
    expect(r).toEqual({ nextRequestId: 'x', done: false });
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toBe('error');
    expect(notes[0]![1]).toContain('pode ter sido gravada');
  });

  it('P2-01: falha durante a releitura (syncOnce) depois da decisão gravada: sem rejeição, avisa e fecha a pendência', async () => {
    const { r, notes } = await run(async () => ({ ok: true, amount: 10, repeated: false }), async () => { throw new Error('offline'); });
    expect(r).toEqual({ nextRequestId: 'novo', done: true });
    expect(notes.map((n) => n[0])).toEqual(['success', 'error']);
    expect(notes[1]![1]).toContain('leitura da nuvem falhou');
  });

  it('P2-01: o reenvio usa o id guardado; só a decisão confirmada troca o id', async () => {
    const ids: string[] = [];
    let first = true;
    const send = async (id: string) => {
      ids.push(id);
      if (first) { first = false; throw new Error('perdeu a resposta'); }
      return { ok: true as const, amount: 10, repeated: true };
    };
    const a = await runReconcileDecision({ decision: 'RELEASE', currentId: 'x', newId: gen, send, reload: async () => {}, notify: () => {} });
    const b = await runReconcileDecision({ decision: 'RELEASE', currentId: a.nextRequestId, newId: gen, send, reload: async () => {}, notify: () => {} });
    expect(ids).toEqual(['x', 'x']);
    expect(b).toEqual({ nextRequestId: 'novo', done: true });
  });
});
