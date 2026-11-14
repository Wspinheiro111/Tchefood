/**
 * Conferência da cobrança da Point (auditoria r5 P1-01) com o repositório da Edge Function de verdade
 * (supabase/functions/point-charge/repository.ts) contra o banco de verdade: as RPCs
 * tchefood_authorize_point_reconcile e tchefood_resolve_point_charge com os nomes de argumento, o patch e a
 * evidência que o código manda, e o gatilho que recusa sair da revisão manual por UPDATE direto.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PaymentTerminalChargeResult, PaymentTerminalProvider } from '../../server/shared/paymentTerminal';
import { ChargeRefusedError, reconcileCharge, type ChargeContext, type PointPaymentDetails, type TerminalChargeRow } from '../../supabase/functions/point-charge/charge';
import { CHARGE_COLUMNS, supabaseChargeStore, type SupabaseLike } from '../../supabase/functions/point-charge/repository';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_point_reconcile_test';
const ROOT = join(__dirname, '..', '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const MANAGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TABLE = '33333333-3333-4333-8333-333333333333';
const ORDER = '44444444-4444-4444-8444-444444444444';
const TERMINAL = '55555555-5555-4555-8555-555555555555';
const MP_ID = 'NEWLAND_N950__N950NCB801293324';
const MANAGER_PIN = '8642';
const REASON = 'conferido no app do Mercado Pago';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function applySchema(t: PgTarget, db: string): void {
  createSupabaseLikeDb(t, db);
  psqlFile(t, join(ROOT, 'db', 'schema.sql'), db);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) psqlFile(t, join(dir, f), db);
}

function sql(q: string): string {
  const r = psql(target!, q, DB);
  if (!r.ok) throw new Error(r.message ?? 'sql');
  return r.out;
}

/** Roda como a service role (é o papel da Edge Function). */
function asService(stmt: string) {
  return psql(target!, `BEGIN; SET LOCAL ROLE service_role; ${stmt} COMMIT;`, DB);
}

/**
 * SupabaseLike mínimo sobre psql, como o PostgREST com a service role: rpc com argumentos nomeados (os tipos vêm
 * do pg_proc, e argumento que não existe é recusado como no PostgREST) e o query builder que o repositório usa.
 */
function serviceDb(): SupabaseLike {
  const quoteValue = (v: unknown) => (v === null ? 'NULL' : lit(typeof v === 'string' ? v : JSON.stringify(v)));
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const sig = psql(target!, `SELECT array_to_string(p.proargnames, ',') || '|' || array_to_string(ARRAY(SELECT format_type(x, NULL) FROM unnest(p.proargtypes) x), ',')
                                   FROM pg_proc p WHERE p.proname = ${lit(fn)} AND p.pronamespace = 'public'::regnamespace;`, DB);
      if (!sig.ok || !sig.out) return { data: null, error: { message: `Could not find the function public.${fn}`, code: 'PGRST202' } };
      const [namesRaw, typesRaw] = sig.out.split('|');
      const names = namesRaw!.split(',');
      const types = typesRaw!.split(',');
      const unknown = Object.keys(args).filter((k) => !names.includes(k));
      if (unknown.length) return { data: null, error: { message: `Could not find the function public.${fn}(${Object.keys(args).join(', ')})`, code: 'PGRST202' } };
      const list = Object.entries(args).map(([k, v]) => {
        const ty = types[names.indexOf(k)]!;
        return `"${k}" => ${v === null ? `NULL::${ty}` : `${lit(typeof v === 'string' ? v : JSON.stringify(v))}::${ty}`}`;
      });
      const r = asService(`SELECT to_jsonb(public."${fn}"(${list.join(', ')}));`);
      if (!r.ok) return { data: null, error: { message: r.message ?? 'erro', code: r.sqlstate ?? undefined } };
      const line = r.out.split('\n').filter(Boolean).pop() ?? '';
      const data = line === '' ? null : JSON.parse(line);
      // RETURNS terminal_charges com status diferente do pedido devolve a linha; linha toda nula = sem linha.
      return { data: data && typeof data === 'object' && !Array.isArray(data) && Object.values(data).every((x) => x === null) ? null : data, error: null };
    },
    from(table: string) {
      const where: string[] = [];
      let columns = '*';
      let patch: Record<string, unknown> | null = null;
      const q = {
        select(cols: string) { columns = cols; return q; },
        update(p: Record<string, unknown>) { patch = p; return q; },
        eq(col: string, v: unknown) { where.push(`"${col}" = ${quoteValue(v)}`); return q; },
        is(col: string, v: null) { where.push(`"${col}" IS ${v === null ? 'NULL' : 'NOT NULL'}`); return q; },
        not(col: string, op: string, list: string) {
          if (op !== 'in') throw new Error(`filtro não suportado: ${op}`);
          where.push(`NOT ("${col}" IN (${list.replace(/^\(|\)$/g, '').split(',').map((x) => lit(x)).join(', ')}))`);
          return q;
        },
        async maybeSingle() {
          const cond = where.length ? ` WHERE ${where.join(' AND ')}` : '';
          const cols = columns === '*' ? '*' : columns.split(',').map((c) => `"${c.trim()}"`).join(', ');
          const stmt = patch
            ? `WITH u AS (UPDATE public."${table}" SET ${Object.entries(patch).map(([k, v]) => `"${k}" = ${quoteValue(v)}`).join(', ')}${cond} RETURNING ${cols}) SELECT coalesce(jsonb_agg(to_jsonb(u)), '[]') FROM u;`
            : `SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]') FROM (SELECT ${cols} FROM public."${table}"${cond}) s;`;
          const r = asService(stmt);
          if (!r.ok) return { data: null, error: { message: r.message ?? 'erro', code: r.sqlstate ?? undefined } };
          const rows = JSON.parse(r.out.split('\n').filter(Boolean).pop() ?? '[]') as unknown[];
          if (rows.length > 1) return { data: null, error: { message: 'mais de uma linha' } };
          return { data: rows[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
}

let seq = 0;
/** Cobrança gravada direto (sem gatilhos) no estado pedido. */
function seedCharge(over: Record<string, string | number | null> = {}): string {
  seq += 1;
  const key = `reconcile-${seq}`;
  const row: Record<string, string | number | null> = {
    tenant_id: TENANT, idempotency_key: key, order_id: ORDER, terminal_id: TERMINAL, provider: 'mercado_pago_point', external_terminal_id: MP_ID,
    method: 'CREDIT', amount_cents: 2450, status: 'manual_review', external_order_id: `ORD-${seq}`, raw_status: 'processed', raw_status_detail: 'PAYMENT_NOT_APPROVED',
    created_by: STAFF, dispatched_at: '2026-11-14T12:00:00Z', dispatch_attempts: 1, ...over,
  };
  const cols = Object.keys(row);
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO terminal_charges (${cols.join(', ')}) VALUES (${cols.map((c) => (row[c] === null ? 'NULL' : lit(String(row[c])))).join(', ')});
       COMMIT;`);
  return key;
}

function approvedOrder(key: string, orderId: string, over: Partial<PaymentTerminalChargeResult> = {}): PaymentTerminalChargeResult {
  return {
    provider: 'mercado_pago_point', externalOrderId: orderId, externalPaymentId: '123456789', externalTransactionId: 'PAY01', externalReference: key,
    externalTerminalId: MP_ID, status: 'approved', rawStatus: 'processed', rawStatusDetail: 'accredited', amountCents: 2450, paidAmountCents: 2450,
    paymentMethodId: 'master', paymentMethodType: 'credit_card', installments: 1, ...over,
  };
}

function context(get: () => PaymentTerminalChargeResult, payment: (id: string) => PointPaymentDetails): ChargeContext {
  const provider: PaymentTerminalProvider = {
    key: 'mercado_pago_point', createRetryPolicy: 'same_key', approvalIdentity: 'reference_and_terminal', supportedMethods: ['credit', 'debit', 'pix'],
    listTerminals: async () => [], createCharge: async () => { throw new Error('não cria'); }, getCharge: async () => get(),
    cancelCharge: async () => ({ outcome: 'cancellation_pending', charge: null }), findChargeByReference: async () => null,
  };
  return { store: supabaseChargeStore(serviceDb(), TENANT), provider, payments: { getPayment: async (id) => payment(id) } };
}

const approvedPayment = (over: Partial<PointPaymentDetails> = {}): PointPaymentDetails => ({
  id: '123456789', status: 'approved', amountCents: 2450, paymentMethodId: 'master', paymentTypeId: 'credit_card', authorizationCode: 'A1B2C3', lastFour: '4242', installments: 1, ...over,
});

const charge = (key: string) => JSON.parse(sql(`SELECT to_jsonb(c) FROM terminal_charges c WHERE idempotency_key = ${lit(key)};`)) as TerminalChargeRow;
const audits = (key: string, action: string) => Number(sql(`SELECT count(*) FROM audit_logs WHERE action_type = ${lit(action)} AND metadata->>'idempotency_key' = ${lit(key)};`));

describe.skipIf(!target)('point-charge: conferência no Mercado Pago com o banco real (auditoria r5)', () => {
  beforeAll(() => {
    applySchema(target!, DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja', 'Loja Ltda', '11222333000181');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF}', '${TENANT}', 'Caixa', 'CASHIER', '5162'),
                ('${MANAGER}', '${TENANT}', 'Gerente', 'MANAGER', '${MANAGER_PIN}');
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${TABLE}', '${TENANT}', 1, 'Mesa 1');
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${TERMINAL}', '${TENANT}', 'Point Smart', '${MP_ID}', 'MERCADO_PAGO');
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER}', '${TENANT}', '${TABLE}', '${STAFF}');`);
    sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE orders SET total_amount = 100000, remaining_balance = 100000 WHERE id = '${ORDER}'; COMMIT;`);
  }, 120_000);

  it('o repositório lê a cobrança com as colunas da tabela', async () => {
    const key = seedCharge();
    const row = await supabaseChargeStore(serviceDb(), TENANT).findByKey(key);
    expect(row).toMatchObject({ idempotency_key: key, status: 'manual_review', amount_cents: 2450 });
    expect(Object.keys(row!).sort()).toEqual(CHARGE_COLUMNS.split(',').map((c) => c.trim()).sort());
  });

  it('authorizeReconcile: argumentos certos; PIN errado = null; PIN certo = id do registro; recusas viram ChargeRefusedError', async () => {
    const key = seedCharge();
    const store = supabaseChargeStore(serviceDb(), TENANT);
    expect(await store.authorizeReconcile({ idempotency_key: key, performed_by: STAFF, manager_pin: '0000', reason: REASON })).toBeNull();
    const id = await store.authorizeReconcile({ idempotency_key: key, performed_by: STAFF, manager_pin: MANAGER_PIN, reason: REASON });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(audits(key, 'POINT_CHARGE_RECONCILE_AUTHORIZED')).toBe(1);
    expect(charge(key).status).toBe('manual_review'); // só pede a conferência
    await expect(store.authorizeReconcile({ idempotency_key: key, performed_by: STAFF, manager_pin: MANAGER_PIN, reason: 'curto' })).rejects.toMatchObject({ code: 'invalid_reason' });
    await expect(store.authorizeReconcile({ idempotency_key: 'nao-existe', performed_by: STAFF, manager_pin: MANAGER_PIN, reason: REASON })).rejects.toMatchObject({ code: 'not_found' });
    const done = seedCharge({ status: 'rejected' });
    await expect(store.authorizeReconcile({ idempotency_key: done, performed_by: STAFF, manager_pin: MANAGER_PIN, reason: REASON })).rejects.toBeInstanceOf(ChargeRefusedError);
  });

  it('reconcileCharge de ponta a ponta: revisão manual → aprovada pelo fim verificado, UM registro; a autorização não serve duas vezes', async () => {
    const key = seedCharge();
    const ctx = context(() => approvedOrder(key, charge(key).external_order_id!), () => approvedPayment());
    expect(await reconcileCharge(ctx, { idempotency_key: key, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: REASON })).toMatchObject({
      status: 'APPROVED', nsu: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242',
    });
    expect(charge(key)).toMatchObject({ status: 'approved', external_payment_id: '123456789', paid_amount_cents: 2450, raw_status_detail: 'accredited' });
    expect(audits(key, 'POINT_CHARGE_RESOLVED')).toBe(1);
    // Mesma autorização numa segunda gravação (aprovada → estornada): o banco recusa (TF007 → not_applicable).
    const authId = sql(`SELECT metadata->'evidence'->>'authorization_audit_id' FROM audit_logs WHERE action_type = 'POINT_CHARGE_RESOLVED' AND metadata->>'idempotency_key' = ${lit(key)};`);
    const store = supabaseChargeStore(serviceDb(), TENANT);
    const approved = (await store.findByKey(key))!;
    await expect(store.resolve(approved, 'refunded', { raw_status: 'refunded' }, { staff: STAFF, reason: REASON, evidence: { authorization_audit_id: authId, operation_id: null } }))
      .rejects.toMatchObject({ code: 'not_applicable' });
    expect(charge(key).status).toBe('approved');
    // Autorização de OUTRA cobrança: recusada (TF006).
    const other = seedCharge();
    const row = (await store.findByKey(other))!;
    await expect(store.resolve(row, 'cancelled', { raw_status: 'canceled' }, { staff: STAFF, reason: REASON, evidence: { authorization_audit_id: authId, operation_id: null } }))
      .rejects.toMatchObject({ code: 'invalid_reason' });
    expect(charge(other).status).toBe('manual_review');
  });

  it('aprovada sem pagamento registrado e estornada no Mercado Pago: refunded com só raw_status/raw_status_detail; segunda conferência 409', async () => {
    const key = seedCharge({ status: 'approved', raw_status_detail: 'accredited', external_payment_id: '123456789', paid_amount_cents: 2450, authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242' });
    const ctx = context(() => approvedOrder(key, charge(key).external_order_id!), () => approvedPayment({ status: 'refunded' }));
    expect(await reconcileCharge(ctx, { idempotency_key: key, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: REASON })).toMatchObject({ status: 'DECLINED' });
    expect(charge(key)).toMatchObject({ status: 'refunded', raw_status: 'payment_refunded', raw_status_detail: 'PAYMENT_REFUNDED', authorization_code: 'A1B2C3', external_payment_id: '123456789' });
    await expect(reconcileCharge(ctx, { idempotency_key: key, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: REASON })).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
    expect(audits(key, 'POINT_CHARGE_RESOLVED')).toBe(1);
  });

  it('o estorno da aprovada com outro campo no patch é recusado pelo banco (o código nunca manda)', async () => {
    const key = seedCharge({ status: 'approved', raw_status_detail: 'accredited', external_payment_id: '123456789', paid_amount_cents: 2450, authorization_code: 'A1B2C3', card_brand: 'MASTERCARD' });
    const store = supabaseChargeStore(serviceDb(), TENANT);
    const auth = (await store.authorizeReconcile({ idempotency_key: key, performed_by: STAFF, manager_pin: MANAGER_PIN, reason: REASON }))!;
    const row = (await store.findByKey(key))!;
    await expect(store.resolve(row, 'refunded', { raw_status: 'refunded', authorization_code: 'X' }, { staff: STAFF, reason: REASON, evidence: { authorization_audit_id: auth, operation_id: null } }))
      .rejects.toMatchObject({ code: 'invalid_reason' });
    expect(charge(key).status).toBe('approved');
  });

  it('Mercado Pago inconclusivo: nada gravado além do registro do PIN', async () => {
    const key = seedCharge();
    const ctx = context(() => { throw new Error('fora do ar'); }, () => approvedPayment());
    expect(await reconcileCharge(ctx, { idempotency_key: key, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: REASON })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
    expect(charge(key).status).toBe('manual_review');
    expect(audits(key, 'POINT_CHARGE_RESOLVED')).toBe(0);
  });

  it('o gatilho recusa tirar da revisão manual pelo update do repositório (qualquer estado); outras colunas e a ordem podem mudar', async () => {
    const store = supabaseChargeStore(serviceDb(), TENANT);
    for (const status of ['approved', 'rejected', 'cancelled', 'pending', 'at_terminal'] as const) {
      const key = seedCharge();
      const row = (await store.findByKey(key))!;
      await expect(store.update(row, { status })).rejects.toThrow(/revisão manual|confirmação do Mercado Pago/);
      expect(charge(key).status).toBe('manual_review');
    }
    const key = seedCharge({ external_order_id: null });
    const row = (await store.findByKey(key))!;
    expect((await store.update(row, { raw_status: 'x' })).raw_status).toBe('x');
    expect((await store.attachOrder(row, 'ORD-LIGADA')).external_order_id).toBe('ORD-LIGADA');
  });
});
