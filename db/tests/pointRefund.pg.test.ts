/**
 * Estorno da cobrança da Point com pagamento registrado (auditoria GPT r9 P1-01) com o repositório da Edge Function de verdade
 * (supabase/functions/point-charge/repository.ts) contra o banco de verdade: as RPCs
 * tchefood_authorize_point_reconcile e tchefood_refund_point_payment com os nomes de argumento e a evidência que o código
 * manda; sem prova do Mercado Pago, nada é gravado.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PaymentTerminalChargeResult, PaymentTerminalProvider } from '../../server/shared/paymentTerminal';
import { refundCharge, type ChargeContext, type PointPaymentDetails, type TerminalChargeRow } from '../../supabase/functions/point-charge/charge';
import { supabaseChargeStore, type SupabaseLike } from '../../supabase/functions/point-charge/repository';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_point_refund_' + process.pid;
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


  const seedPaid = (over: Record<string, string | number | null> = {}) => {
    const key = seedCharge({ status: 'approved', raw_status_detail: 'accredited', external_payment_id: '123456789', paid_amount_cents: 2450, authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242', ...over });
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
         INSERT INTO payments (order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key, nsu, authorization_code, card_brand)
         VALUES ('${ORDER}', '${TENANT}', '${STAFF}', 24.50, 'CREDIT', 'APPROVED', 'MERCADO_PAGO', ${lit(key)}, '123456789', 'A1B2C3', 'MASTERCARD'); COMMIT;`);
    return key;
  };
  const payStatus = (key: string) => sql(`SELECT status FROM payments WHERE idempotency_key = ${lit(key)};`);
  const REQ = (key: string) => ({ idempotency_key: key, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: REASON });
  const refunded = (key: string, over: Partial<PointPaymentDetails> = {}) => approvedPayment({ status: 'refunded', externalReference: key, ...over });

  it('refund de ponta a ponta: cobrança refunded + pagamento REFUNDED, UM POINT_PAYMENT_REFUNDED; repetição não grava', async () => {
    const key = seedPaid();
    const ctx = context(() => { throw new Error('não lê ordem'); }, () => refunded(key));
    expect(await refundCharge(ctx, REQ(key))).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
    expect(charge(key)).toMatchObject({ status: 'refunded', raw_status: 'payment_refunded', raw_status_detail: 'PAYMENT_REFUNDED' });
    expect(payStatus(key)).toBe('REFUNDED');
    expect(audits(key, 'POINT_PAYMENT_REFUNDED')).toBe(1);
    const ev = JSON.parse(sql(`SELECT metadata->'evidence' FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND metadata->>'idempotency_key' = ${lit(key)};`));
    expect(ev).toMatchObject({ mp_payment_id: '123456789', mp_amount_cents: 2450, mp_external_reference: key, mp_status: 'refunded', operation_id: '123456789' });
    expect(await refundCharge(ctx, REQ(key))).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
    expect(audits(key, 'POINT_PAYMENT_REFUNDED')).toBe(1);
    expect(audits(key, 'POINT_CHARGE_RECONCILE_AUTHORIZED')).toBe(1);
  });

  it('chargeback / não estornado: nada gravado além do registro do PIN', async () => {
    for (const p of [{ status: 'charged_back', statusDetail: 'settled' }, { status: 'approved' }]) {
      const key = seedPaid();
      const ctx = context(() => { throw new Error('x'); }, () => refunded(key, p));
      expect(await refundCharge(ctx, REQ(key))).toMatchObject({ status: 'MANUAL_REVIEW' });
      expect(charge(key).status).toBe('approved');
      expect(payStatus(key)).toBe('APPROVED');
      expect(audits(key, 'POINT_PAYMENT_REFUNDED')).toBe(0);
    }
  });

  it('o banco recusa prova que não confere (pagamento registrado com outro NSU) e autorização reutilizada', async () => {
    const key = seedPaid();
    sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE payments SET nsu = '111' WHERE idempotency_key = ${lit(key)}; COMMIT;`);
    const ctx = context(() => { throw new Error('x'); }, () => refunded(key));
    await expect(refundCharge(ctx, REQ(key))).rejects.toMatchObject({ code: 'refund_refused', httpStatus: 409 });
    expect(charge(key).status).toBe('approved');
    expect(payStatus(key)).toBe('APPROVED');
    const store = supabaseChargeStore(serviceDb(), TENANT);
    const k2 = seedPaid();
    const auth = (await store.authorizeReconcile({ idempotency_key: k2, performed_by: STAFF, manager_pin: MANAGER_PIN, reason: REASON }))!;
    const row = (await store.findByKey(k2))!;
    const evidence = { authorization_audit_id: auth, operation_id: '123456789', mp_payment_id: '123456789', mp_amount_cents: 2450, mp_external_reference: k2, mp_status: 'refunded' };
    expect((await store.refundPayment(row, { raw_status: 'payment_refunded' }, { staff: STAFF, reason: REASON, evidence })).status).toBe('refunded');
    await expect(store.refundPayment(row, {}, { staff: STAFF, reason: REASON, evidence: { ...evidence, mp_status: 'charged_back' } })).rejects.toMatchObject({ code: 'invalid_reason' });
    const k3 = seedPaid();
    const row3 = (await store.findByKey(k3))!;
    await expect(store.refundPayment(row3, {}, { staff: STAFF, reason: REASON, evidence: { ...evidence, mp_external_reference: k3 } })).rejects.toMatchObject({ code: 'invalid_reason' }); // autorização de outra cobrança
  });

  it('sem pagamento registrado: 409 antes do PIN', async () => {
    const key = seedCharge({ status: 'approved', raw_status_detail: 'accredited', external_payment_id: '123456789', paid_amount_cents: 2450, authorization_code: 'A1B2C3', card_brand: 'MASTERCARD' });
    const ctx = context(() => { throw new Error('x'); }, () => refunded(key));
    await expect(refundCharge(ctx, REQ(key))).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
    expect(audits(key, 'POINT_CHARGE_RECONCILE_AUTHORIZED')).toBe(0);
  });
});
