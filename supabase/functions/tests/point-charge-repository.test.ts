import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChargeRefusedError, type TerminalChargeRow } from '../point-charge/charge.ts';
import { supabaseChargeStore, type SupabaseLike } from '../point-charge/repository.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROW: TerminalChargeRow = {
  id: 'r1', tenant_id: TENANT, idempotency_key: 'k1', order_id: 'o', terminal_id: 't', provider: 'mercado_pago_point', external_terminal_id: 'MP',
  method: 'CREDIT', amount_cents: 1000, status: 'at_terminal', external_order_id: 'ORD', external_payment_id: null, raw_status: null, raw_status_detail: null,
  paid_amount_cents: null, card_brand: null, authorization_code: null, last_four: null, created_by: null, cancel_reason: null, cancel_requested_by: null, cancel_requested_at: null,
  dispatched_at: null, dispatch_lease_until: null, dispatch_attempts: 0, cancel_authorized_by: null, cancel_audit_id: null, created_at: '2026-11-12T10:00:00Z',
};

/** Query builder falso: grava a cadeia de filtros e responde o que o teste mandar. */
function fakeDb(answers: { update?: unknown; select?: unknown; rpc?: { data: unknown; error: { message: string; code?: string } | null } }) {
  const chains: string[][] = [];
  /** Argumentos de cada chamada de função do banco, na ordem. */
  const rpcArgs: Record<string, unknown>[] = [];
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
      rpcArgs.push(args);
      return answers.rpc ?? { data: 'id', error: null };
    },
  };
  return { db, chains, rpcArgs };
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
    const { db, chains, rpcArgs } = fakeDb({ select: ROW });
    const { id: _id, created_at: _c, ...fresh } = { ...ROW, status: 'creating' as const };
    await supabaseChargeStore(db, TENANT).insert(fresh, 4321);
    expect(chains[0]).toEqual(['rpc:tchefood_open_terminal_charge', JSON.stringify(['p_amount_cents', 'p_created_by', 'p_expected_balance_cents', 'p_external_terminal', 'p_key', 'p_method', 'p_order', 'p_tenant', 'p_terminal'])]);
    // r4 P1-01: o saldo que o aparelho mostra vai para o banco conferir.
    expect(rpcArgs[0]).toMatchObject({ p_tenant: TENANT, p_key: 'k1', p_amount_cents: 1000, p_expected_balance_cents: 4321 });
  });

  it.each([
    ['TF001', 'order_not_found'],
    ['TF002', 'order_closed'],
    ['TF003', 'over_balance'],
    ['TF008', 'balance_mismatch'],
    ['TF009', 'key_in_use'],
  ])('recusa do banco %s vira ChargeRefusedError(%s) sem o prefixo', async (code, mapped) => {
    const { db } = fakeDb({ rpc: { data: null, error: { code, message: 'TCHEFOOD_COBRANCA: explicação' } } });
    const { id: _id, created_at: _c, ...fresh } = ROW;
    const err = await supabaseChargeStore(db, TENANT).insert(fresh, 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChargeRefusedError);
    expect(err).toMatchObject({ code: mapped, message: 'explicação' });
  });

  it('outro erro do banco não vira recusa', async () => {
    const { db } = fakeDb({ rpc: { data: null, error: { code: '57014', message: 'timeout' } } });
    const { id: _id, created_at: _c, ...fresh } = ROW;
    await expect(supabaseChargeStore(db, TENANT).insert(fresh, 1000)).rejects.not.toBeInstanceOf(ChargeRefusedError);
  });

  it('r3 P1-02: a posse do envio é dada pela função do banco; 0 = não ganhou; ganhou = linha com o número da posse', async () => {
    const none = fakeDb({ rpc: { data: 0, error: null } });
    expect(await supabaseChargeStore(none.db, TENANT).claimDispatch({ ...ROW, status: 'creating' }, 30_000)).toBeNull();
    expect(none.chains).toEqual([['rpc:tchefood_claim_point_dispatch', JSON.stringify(['p_id', 'p_lease_ms', 'p_tenant'])]]);
    const won = fakeDb({ rpc: { data: 2, error: null } });
    expect(await supabaseChargeStore(won.db, TENANT).claimDispatch({ ...ROW, status: 'creating', dispatch_attempts: 1 }, 30_000)).toMatchObject({ id: 'r1', dispatch_attempts: 2 });
    // Só a função do banco: nenhuma leitura entre a posse e a barreira.
    expect(won.chains).toHaveLength(1);
    for (const data of [null, 'x', 1.5, -1]) {
      const odd = fakeDb({ rpc: { data, error: null } });
      expect(await supabaseChargeStore(odd.db, TENANT).claimDispatch({ ...ROW, status: 'creating' }, 30_000)).toBeNull();
    }
    const down = fakeDb({ rpc: { data: null, error: { message: 'timeout' } } });
    await expect(supabaseChargeStore(down.db, TENANT).claimDispatch({ ...ROW, status: 'creating' }, 30_000)).rejects.toThrow('posse do envio');
  });

  it('r3 2ª revisão: a barreira antes do envio é uma chamada só ao banco, com o número da posse; só 1 e 2 liberam', async () => {
    const first = fakeDb({ rpc: { data: 1, error: null } });
    expect(await supabaseChargeStore(first.db, TENANT).beginDispatch({ ...ROW, status: 'creating', dispatch_attempts: 3 }, 30_000, true)).toBe(1);
    expect(first.chains).toEqual([['rpc:tchefood_begin_point_dispatch', JSON.stringify(['p_allow_first', 'p_attempt', 'p_id', 'p_lease_ms', 'p_tenant'])]]);
    expect(first.rpcArgs[0]).toEqual({ p_tenant: TENANT, p_id: 'r1', p_attempt: 3, p_lease_ms: 30_000, p_allow_first: true });
    // r4 P1-02: a consulta pede a barreira sem primeiro envio, e um 1 vindo do banco não libera.
    const poll = fakeDb({ rpc: { data: 1, error: null } });
    expect(await supabaseChargeStore(poll.db, TENANT).beginDispatch({ ...ROW, status: 'creating', dispatch_attempts: 3 }, 30_000, false)).toBe(0);
    expect(poll.rpcArgs[0]).toMatchObject({ p_allow_first: false });
    expect(await supabaseChargeStore(fakeDb({ rpc: { data: 2, error: null } }).db, TENANT).beginDispatch(ROW, 30_000, false)).toBe(2);
    expect(await supabaseChargeStore(fakeDb({ rpc: { data: 2, error: null } }).db, TENANT).beginDispatch(ROW, 30_000, true)).toBe(2);
    expect(await supabaseChargeStore(fakeDb({ rpc: { data: '2', error: null } }).db, TENANT).beginDispatch(ROW, 30_000, true)).toBe(2);
    for (const data of [0, null, 3, -1, 'x', false]) {
      expect(await supabaseChargeStore(fakeDb({ rpc: { data, error: null } }).db, TENANT).beginDispatch(ROW, 30_000, true)).toBe(0);
    }
    // Banco fora do ar não libera o envio: a chamada falha.
    const down = fakeDb({ rpc: { data: null, error: { message: 'timeout' } } });
    await expect(supabaseChargeStore(down.db, TENANT).beginDispatch(ROW, 30_000, true)).rejects.toThrow('marcar o envio');
  });

  it('r3 2ª revisão: a ordem é ligada sem condição de estado lido, só se ainda não há ordem e a cobrança não é final', async () => {
    const ok = fakeDb({ update: { ...ROW, status: 'manual_review', external_order_id: 'ORD9' } });
    expect(await supabaseChargeStore(ok.db, TENANT).attachOrder({ ...ROW, status: 'creating', external_order_id: null }, 'ORD9')).toMatchObject({ status: 'manual_review', external_order_id: 'ORD9' });
    expect(ok.chains[0]).toEqual(expect.arrayContaining([`update:${JSON.stringify(['external_order_id', 'updated_at'])}`, 'eq:id,r1', `eq:tenant_id,${TENANT}`, 'is:external_order_id,null', 'not:status,in,(approved,rejected,cancelled,expired,refunded)']));
    expect(ok.chains[0]!.some((c) => c.startsWith('eq:status'))).toBe(false);
    // Já tinha ordem (ou terminou): não grava e devolve o que está lá.
    const kept = fakeDb({ update: null, select: { ...ROW, external_order_id: 'ORD' } });
    expect((await supabaseChargeStore(kept.db, TENANT).attachOrder({ ...ROW, external_order_id: null }, 'ORD9')).external_order_id).toBe('ORD');
    expect(kept.chains).toHaveLength(2);
  });

  it('r3 2ª e 3ª revisão: recusa do primeiro envio só vale para a posse desta chamada, em "creating" e sem ordem; não existe devolução de posse', async () => {
    const rej = fakeDb({ update: { ...ROW, status: 'rejected', raw_status: 'create_failed:terminal_busy' } });
    expect((await supabaseChargeStore(rej.db, TENANT).rejectFirstSend({ ...ROW, status: 'creating', dispatch_attempts: 1 }, 'terminal_busy')).status).toBe('rejected');
    expect(rej.chains[0]).toEqual(expect.arrayContaining(['eq:id,r1', `eq:tenant_id,${TENANT}`, 'eq:status,creating', 'eq:dispatch_attempts,1', 'is:external_order_id,null']));
    // Outra posse já foi dada: nada é gravado e volta a linha atual.
    const lost = fakeDb({ update: null, select: { ...ROW, status: 'creating', dispatch_attempts: 2 } });
    expect(await supabaseChargeStore(lost.db, TENANT).rejectFirstSend({ ...ROW, status: 'creating', dispatch_attempts: 1 }, 'terminal_busy')).toMatchObject({ status: 'creating', dispatch_attempts: 2 });
    // Terceira revisão: a posse nunca é devolvida antes da hora; o repositório nem tem como.
    expect('releaseDispatch' in supabaseChargeStore(fakeDb({}).db, TENANT)).toBe(false);
    // Nenhum método do repositório grava dispatch_lease_until direto: só as funções do banco mexem na posse.
    expect(lost.chains.concat(rej.chains).every((c) => !c.some((x) => x.startsWith('update') && x.includes('dispatch_lease_until')))).toBe(true);
  });

  it('r3 2ª revisão: revisão manual do envio sem resposta e encerramento por prazo são decididos pelo banco', async () => {
    const settle = fakeDb({ rpc: { data: true, error: null }, select: { ...ROW, status: 'manual_review', raw_status_detail: 'DISPATCH_UNKNOWN' } });
    expect((await supabaseChargeStore(settle.db, TENANT).settleDispatch({ ...ROW, status: 'creating' })).status).toBe('manual_review');
    expect(settle.chains[0]).toEqual(['rpc:tchefood_settle_point_dispatch', JSON.stringify(['p_id', 'p_tenant'])]);
    // Fora das condições (false): devolve a linha como está, sem gravar nada por fora.
    const not = fakeDb({ rpc: { data: false, error: null }, select: { ...ROW, status: 'creating' } });
    expect((await supabaseChargeStore(not.db, TENANT).settleDispatch({ ...ROW, status: 'creating' })).status).toBe('creating');
    expect(not.chains.every((c) => !c.some((x) => x.startsWith('update')))).toBe(true);

    const early = fakeDb({ rpc: { data: 0, error: null } });
    expect(await supabaseChargeStore(early.db, TENANT).requestTimeoutCancel(ROW, 120_000)).toBeNull();
    expect(early.chains).toEqual([['rpc:tchefood_request_point_timeout', JSON.stringify(['p_id', 'p_tenant', 'p_wait_ms'])]]);
    for (const data of [1, 2]) {
      const ok = fakeDb({ rpc: { data, error: null }, select: { ...ROW, cancel_reason: 'timeout', cancel_requested_at: '2026-11-12T10:02:00Z' } });
      expect(await supabaseChargeStore(ok.db, TENANT).requestTimeoutCancel(ROW, 120_000)).toMatchObject({ cancel_reason: 'timeout' });
      expect(ok.chains.every((c) => !c.some((x) => x.startsWith('update')))).toBe(true);
    }
    // Resposta estranha do banco não vira "prazo vencido" nem "cedo demais": é erro.
    for (const data of [null, 3, 'x']) {
      await expect(supabaseChargeStore(fakeDb({ rpc: { data, error: null } }).db, TENANT).requestTimeoutCancel(ROW, 120_000)).rejects.toThrow('Resposta inesperada');
    }
    // true não é 1: a barreira só libera o envio com os números 1 e 2.
    for (const data of [true, null, 3, 'x']) {
      expect(await supabaseChargeStore(fakeDb({ rpc: { data, error: null } }).db, TENANT).beginDispatch({ ...ROW, status: 'creating', dispatch_attempts: 1 }, 30_000, true)).toBe(0);
    }
    const gone = fakeDb({ rpc: { data: null, error: { code: 'TF005', message: 'TCHEFOOD_COBRANCA: cobrança não encontrada nesta loja.' } } });
    await expect(supabaseChargeStore(gone.db, TENANT).requestTimeoutCancel(ROW, 120_000)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('r3 P1-01: o bloqueio da chave passa pela função do banco (operador conferido, registro gravado)', async () => {
    const ok = fakeDb({ select: { ...ROW, status: 'cancelled', raw_status: 'voided_before_send' } });
    const { id: _id, created_at: _c, ...fresh } = { ...ROW, cancel_requested_by: 'u' };
    expect((await supabaseChargeStore(ok.db, TENANT).insertVoid(fresh)).raw_status).toBe('voided_before_send');
    expect(ok.chains[0]).toEqual(['rpc:tchefood_block_point_key', JSON.stringify(['p_amount_cents', 'p_external_terminal', 'p_key', 'p_method', 'p_order', 'p_requested_by', 'p_tenant', 'p_terminal'])]);
    const staff = fakeDb({ rpc: { data: null, error: { code: 'TF004', message: 'TCHEFOOD_COBRANCA: operador não é da equipe ativa desta loja.' } } });
    await expect(supabaseChargeStore(staff.db, TENANT).insertVoid(fresh)).rejects.toMatchObject({ code: 'invalid_staff' });
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
    const done = fakeDb({ rpc: { data: null, error: { code: 'TF007', message: 'TCHEFOOD_COBRANCA: a cobrança já está "approved"; não há o que encerrar.' } } });
    await expect(supabaseChargeStore(done.db, TENANT).authorizeCancel(input)).rejects.toMatchObject({ code: 'not_applicable' });
  });

  it('r5: PIN da conferência pela função própria (não encerra a cobrança); recusas viram ChargeRefusedError', async () => {
    const ok = fakeDb({ rpc: { data: 'audit-9', error: null } });
    const input = { idempotency_key: 'k1', performed_by: 'u', manager_pin: '1234', reason: 'conferido no app do MP' };
    expect(await supabaseChargeStore(ok.db, TENANT).authorizeReconcile(input)).toBe('audit-9');
    expect(ok.chains[0]).toEqual(['rpc:tchefood_authorize_point_reconcile', JSON.stringify(['p_key', 'p_manager_pin', 'p_reason', 'p_staff', 'p_tenant'])]);
    expect(ok.rpcArgs[0]).toEqual({ p_tenant: TENANT, p_key: 'k1', p_staff: 'u', p_manager_pin: '1234', p_reason: 'conferido no app do MP' });
    expect(await supabaseChargeStore(fakeDb({ rpc: { data: null, error: null } }).db, TENANT).authorizeReconcile(input)).toBeNull();
    for (const [code, mapped] of [['TF004', 'invalid_staff'], ['TF005', 'not_found'], ['TF006', 'invalid_reason'], ['TF007', 'not_applicable']] as const) {
      const refused = fakeDb({ rpc: { data: null, error: { code, message: 'TCHEFOOD_COBRANCA: x' } } });
      await expect(supabaseChargeStore(refused.db, TENANT).authorizeReconcile(input)).rejects.toMatchObject({ code: mapped });
    }
    await expect(supabaseChargeStore(fakeDb({ rpc: { data: null, error: { message: 'boom' } } }).db, TENANT).authorizeReconcile(input)).rejects.not.toBeInstanceOf(ChargeRefusedError);
  });

  it('r5: fim verificado pela função do banco com o estado lido, o patch e a evidência; devolve a linha que o banco devolveu', async () => {
    const resolved = { ...ROW, status: 'refunded', amount_cents: '1000' };
    const { db, chains, rpcArgs } = fakeDb({ rpc: { data: resolved, error: null } });
    const patch = { raw_status: 'refunded', raw_status_detail: 'ORDER_REFUNDED' };
    const evidence = { source: 'mercado_pago_order', external_order_id: 'ORD' };
    const r = await supabaseChargeStore(db, TENANT).resolve({ ...ROW, status: 'approved' }, 'refunded', patch, { staff: 'u', reason: 'conferido no app do MP', evidence });
    expect(r).toMatchObject({ status: 'refunded', amount_cents: 1000 });
    expect(chains).toHaveLength(1);
    expect(chains[0]).toEqual(['rpc:tchefood_resolve_point_charge', JSON.stringify(['p_evidence', 'p_from_status', 'p_id', 'p_patch', 'p_reason', 'p_staff', 'p_tenant', 'p_to_status'])]);
    expect(rpcArgs[0]).toEqual({ p_tenant: TENANT, p_id: 'r1', p_from_status: 'approved', p_to_status: 'refunded', p_patch: patch, p_staff: 'u', p_reason: 'conferido no app do MP', p_evidence: evidence });
  });

  it('r5: fim verificado sem linha na resposta relê a cobrança; erro do banco não vira linha', async () => {
    const empty = fakeDb({ rpc: { data: null, error: null }, select: { ...ROW, status: 'manual_review' } });
    const r = await supabaseChargeStore(empty.db, TENANT).resolve({ ...ROW, status: 'manual_review' }, 'cancelled', {}, { staff: 'u', reason: 'conferido no app do MP', evidence: {} });
    expect(r.status).toBe('manual_review');
    expect(empty.chains[1]).toEqual(expect.arrayContaining(['from:terminal_charges', 'eq:idempotency_key,k1']));
    const broken = fakeDb({ rpc: { data: null, error: { message: 'TCHEFOOD_COBRANCA: transição não aceita' } } });
    await expect(supabaseChargeStore(broken.db, TENANT).resolve(ROW, 'approved', {}, { staff: 'u', reason: 'x', evidence: {} })).rejects.toThrow('transição não aceita');
  });

  it('r5: pagamento registrado = APPROVED do Mercado Pago com a chave, na loja', async () => {
    const found = fakeDb({ select: { id: 'p1' } });
    expect(await supabaseChargeStore(found.db, TENANT).hasRegisteredPayment('k1')).toBe(true);
    expect(found.chains[0]).toEqual(['from:payments', 'select:id', `eq:tenant_id,${TENANT}`, 'eq:idempotency_key,k1', 'eq:status,APPROVED', 'eq:acquirer,MERCADO_PAGO']);
    expect(await supabaseChargeStore(fakeDb({ select: null }).db, TENANT).hasRegisteredPayment('k1')).toBe(false);
  });

  it('r6: os argumentos de cada RPC do repositório são os da assinatura em db/*.sql (sem banco)', async () => {
    const sqlText = ['schema_mercado_pago.sql', 'schema_point_reserva.sql'].map((f) => readFileSync(join(__dirname, '..', '..', '..', 'db', f), 'utf8')).join('\n');
    const params = (fn: string): string[] => {
      const all = [...sqlText.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(([^)]*)\\)`, 'g'))];
      expect(all.length, fn).toBeGreaterThan(0);
      // A última definição é a que vale (os arquivos são aplicados em ordem).
      return all[all.length - 1]![1]!.split(',').map((p) => p.trim().split(/\s+/)[0]!).filter(Boolean).sort();
    };
    const { db, rpcArgs, chains } = fakeDb({ select: ROW, rpc: { data: 'audit-1', error: null } });
    const store = supabaseChargeStore(db, TENANT);
    const { id: _id, created_at: _c, ...fresh } = ROW;
    const input = { idempotency_key: 'k1', performed_by: 'u', manager_pin: '1234', reason: 'conferido no app do MP' };
    await store.insert(fresh, 1000);
    await store.insertVoid({ ...fresh, cancel_requested_by: 'u' });
    await store.claimDispatch(ROW, 30_000);
    await store.beginDispatch(ROW, 30_000, true);
    await store.settleDispatch(ROW);
    await store.authorizeCancel(input);
    await store.authorizeReconcile(input);
    await store.resolve({ ...ROW, status: 'manual_review' }, 'cancelled', {}, { staff: 'u', reason: 'conferido no app do MP', evidence: { authorization_audit_id: 'a', operation_id: null } });
    const fakeTimeout = fakeDb({ select: ROW, rpc: { data: 1, error: null } });
    await supabaseChargeStore(fakeTimeout.db, TENANT).requestTimeoutCancel(ROW, 120_000);
    const calls = [...chains, ...fakeTimeout.chains].filter((c) => c[0]!.startsWith('rpc:'));
    const args = [...rpcArgs, ...fakeTimeout.rpcArgs];
    expect(calls.map((c) => c[0])).toEqual(expect.arrayContaining(['rpc:tchefood_authorize_point_reconcile', 'rpc:tchefood_resolve_point_charge', 'rpc:tchefood_request_point_timeout']));
    calls.forEach((c, i) => expect(Object.keys(args[i]!).sort(), c[0]).toEqual(params(c[0]!.slice(4))));
  });
});
