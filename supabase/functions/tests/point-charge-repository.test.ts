import { describe, expect, it } from 'vitest';
import { ChargeRefusedError, type TerminalChargeRow } from '../point-charge/charge.ts';
import { supabaseChargeStore, type SupabaseLike } from '../point-charge/repository.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROW: TerminalChargeRow = {
  id: 'r1', tenant_id: TENANT, idempotency_key: 'k1', order_id: 'o', terminal_id: 't', provider: 'mercado_pago_point', external_terminal_id: 'MP',
  method: 'CREDIT', amount_cents: 1000, status: 'at_terminal', external_order_id: 'ORD', external_payment_id: null, raw_status: null, raw_status_detail: null,
  paid_amount_cents: null, card_brand: null, authorization_code: null, last_four: null, created_by: null, cancel_reason: null, cancel_requested_by: null, cancel_requested_at: null,
  dispatched_at: null, cancel_authorized_by: null, cancel_audit_id: null, created_at: '2026-11-12T10:00:00Z',
};

/** Query builder falso: grava a cadeia de filtros e responde o que o teste mandar. */
function fakeDb(answers: { update?: unknown; select?: unknown; rpc?: { data: unknown; error: { message: string; code?: string } | null } }) {
  const chains: string[][] = [];
  const db: SupabaseLike = {
    from(table: string) {
      const chain: string[] = [`from:${table}`];
      chains.push(chain);
      let kind = 'select';
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'insert', 'is']) {
        q[m] = (...args: unknown[]) => {
          chain.push(`${m}:${args.map((a) => (a === null ? 'null' : typeof a === 'object' ? 'obj' : String(a))).join(',')}`);
          return q;
        };
      }
      q.update = (patch: unknown) => {
        kind = 'update';
        chain.push(`update:${JSON.stringify(Object.keys(patch as object).sort())}`);
        return q;
      };
      q.maybeSingle = async () => ({ data: kind === 'update' ? (answers.update ?? null) : (answers.select ?? null), error: null });
      return q;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      chains.push([`rpc:${fn}`, JSON.stringify(Object.keys(args).sort())]);
      return answers.rpc ?? { data: 'id', error: null };
    },
  };
  return { db, chains };
}

describe('point-charge: repositório (auditoria r1 P0-02 e P1-02)', () => {
  it('update só grava com o estado lido e fora dos estados finais', async () => {
    const { db, chains } = fakeDb({ update: { ...ROW, status: 'approved' } });
    const r = await supabaseChargeStore(db, TENANT).update(ROW, { status: 'approved' });
    expect(r.status).toBe('approved');
    expect(chains[0]).toEqual(expect.arrayContaining(['eq:id,r1', `eq:tenant_id,${TENANT}`, 'eq:status,at_terminal', 'not:status,in,(approved,rejected,cancelled,expired,refunded)']));
  });

  it('outra consulta passou na frente: não grava e devolve a linha atual', async () => {
    const { db, chains } = fakeDb({ update: null, select: { ...ROW, status: 'approved', amount_cents: '1000' } });
    const r = await supabaseChargeStore(db, TENANT).update(ROW, { status: 'at_terminal' });
    expect(r).toMatchObject({ status: 'approved', amount_cents: 1000 });
    expect(chains).toHaveLength(2);
    expect(chains[1]).toEqual(expect.arrayContaining(['eq:idempotency_key,k1']));
  });

  it('insert abre a cobrança pela função do banco com a conta travada', async () => {
    const { db, chains } = fakeDb({ select: ROW });
    const { id: _id, created_at: _c, ...fresh } = { ...ROW, status: 'creating' as const };
    await supabaseChargeStore(db, TENANT).insert(fresh);
    expect(chains[0]).toEqual(['rpc:tchefood_open_terminal_charge', JSON.stringify(['p_amount_cents', 'p_created_by', 'p_external_terminal', 'p_key', 'p_method', 'p_order', 'p_tenant', 'p_terminal'])]);
  });

  it.each([
    ['TF001', 'order_not_found'],
    ['TF002', 'order_closed'],
    ['TF003', 'over_balance'],
  ])('recusa do banco %s vira ChargeRefusedError(%s) sem o prefixo', async (code, mapped) => {
    const { db } = fakeDb({ rpc: { data: null, error: { code, message: 'TCHEFOOD_COBRANCA: explicação' } } });
    const { id: _id, created_at: _c, ...fresh } = ROW;
    const err = await supabaseChargeStore(db, TENANT).insert(fresh).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChargeRefusedError);
    expect(err).toMatchObject({ code: mapped, message: 'explicação' });
  });

  it('outro erro do banco não vira recusa', async () => {
    const { db } = fakeDb({ rpc: { data: null, error: { code: '57014', message: 'timeout' } } });
    const { id: _id, created_at: _c, ...fresh } = ROW;
    await expect(supabaseChargeStore(db, TENANT).insert(fresh)).rejects.not.toBeInstanceOf(ChargeRefusedError);
  });

  it('r2 P1-02: marcar o envio só com "creating", nunca enviada e sem encerramento (um UPDATE condicionado)', async () => {
    const { db, chains } = fakeDb({ update: null });
    expect(await supabaseChargeStore(db, TENANT).claimDispatch({ ...ROW, status: 'creating' })).toBeNull();
    expect(chains[0]).toEqual(expect.arrayContaining(['eq:status,creating', 'is:dispatched_at,null', 'is:cancel_requested_at,null', 'eq:id,r1']));
  });

  it('r2 P1-01: PIN de gerente conferido pela função do banco; recusas viram ChargeRefusedError', async () => {
    const ok = fakeDb({ rpc: { data: 'audit-1', error: null } });
    const input = { idempotency_key: 'k1', performed_by: 'u', manager_pin: '1234', reason: 'cliente desistiu' };
    expect(await supabaseChargeStore(ok.db, TENANT).authorizeCancel(input)).toBe('audit-1');
    expect(ok.chains[0]).toEqual(['rpc:tchefood_authorize_point_cancel', JSON.stringify(['p_key', 'p_manager_pin', 'p_performed_by', 'p_reason', 'p_tenant'])]);
    const wrong = fakeDb({ rpc: { data: null, error: null } });
    expect(await supabaseChargeStore(wrong.db, TENANT).authorizeCancel(input)).toBeNull();
    const staff = fakeDb({ rpc: { data: null, error: { code: 'TF004', message: 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' } } });
    await expect(supabaseChargeStore(staff.db, TENANT).authorizeCancel(input)).rejects.toMatchObject({ code: 'invalid_staff' });
  });
});
