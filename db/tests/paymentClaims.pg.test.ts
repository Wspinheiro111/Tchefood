/**
 * Auditoria r5 no banco de verdade (db/schema_point_reserva.sql e db/schema_mercado_pago.sql):
 *  - P0-01: na loja com Point, o pagamento fora dela pede antes a reserva no servidor (payment_claims,
 *    tchefood_claim_payment). Reserva e cobrança da Point somam numa reserva única, nos dois sentidos,
 *    com a conta travada; o pagamento com a chave da reserva a consome; a liberação deixa registro.
 *  - P1-01: a cobrança da Point em revisão manual (e a aprovada sem pagamento que foi estornada) só termina
 *    pelo fim verificado no Mercado Pago (tchefood_resolve_point_charge), com a conferência pedida com PIN
 *    de gerente (tchefood_authorize_point_reconcile). O UPDATE direto continua recusado.
 *  - Revisão P1-B/P2-A/P3: na loja com Point o próprio banco exige a reserva do pagamento aprovado fora dela (TF010),
 *    sem confiar na lista de maquininhas do aparelho; única exceção, conferida no banco, o dinheiro do entregador.
 *    Sem PIN só quem pediu a reserva a libera (TF004). A reserva paga fica "consumed" para sempre (TF007).
 *  - Auditoria r6 P0-01/P0-02: a reserva vale em qualquer loja da nuvem (com ou sem Point); tem prazo de atividade
 *    (active_until) que o aparelho que a pediu renova, e o gerente só a libera depois do prazo vencido mais a espera
 *    (TF011 antes).
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget, type PsqlResult } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_payment_claims_test';
const ROOT = join(__dirname, '..', '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
// Loja só para os PINs errados: o bloqueio por tentativas é por loja e não pode atrapalhar os outros testes.
const PIN_TENANT = '12121212-1212-4212-8212-121212121212';
const STAFF = '22222222-2222-4222-8222-222222222222';
const STAFF_B = '23232323-2323-4323-8323-232323232323';
const MANAGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INACTIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PIN_STAFF = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const PIN_MANAGER = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const TABLE = '33333333-3333-4333-8333-333333333333';
const OTHER_TABLE = '34343434-3434-4434-8434-343434343434';
const PIN_TABLE = '35353535-3535-4535-8535-353535353535';
const TERMINAL = '55555555-5555-4555-8555-555555555555';
const STONE_TERMINAL = '66666666-6666-4666-8666-666666666666';
const PIN_TERMINAL = '67676767-6767-4767-8767-676767676767';
const MP_ID = 'NEWLAND_N950__N950NCB801293324';
const MANAGER_PIN = '8642';
const PIN_MANAGER_PIN = '4321';
const STONE_CNPJ = '16501555000157';
// Loja que começa sem Point (para ver o banco passar a exigir a reserva quando a Point chega).
const LATE_TENANT = '14141414-1414-4414-8414-141414141414';
const LATE_STAFF = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const LATE_TABLE = '36363636-3636-4636-8636-363636363636';
// Entrega própria (senha paga na entrega): mesa técnica do totem, bairro e entregador da loja.
const KIOSK_TABLE = '37373737-3737-4737-8737-373737373737';
const ZONE = '38383838-3838-4838-8838-383838383838';
const COURIER = '39393939-3939-4939-8939-393939393939';

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

/** Roda como o aparelho (papel authenticated com o tenant no JWT). */
function asDevice(q: string, tenant = TENANT): PsqlResult {
  return psql(target!, `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${tenant}"}', true); ${q}; COMMIT;`, DB);
}
function asRole(role: string, q: string): PsqlResult {
  return psql(target!, `BEGIN; SET LOCAL ROLE ${role}; ${q}; COMMIT;`, DB);
}
/** "sqlstate|DETAIL" da recusa de um SELECT de uma função só, rodado como o aparelho (sem erro: "ok|"). */
function detailOf(q: string, tenant = TENANT): string {
  const r = asDevice(`DO $d$ DECLARE c TEXT := 'ok'; d TEXT := ''; BEGIN
      BEGIN PERFORM ${q.replace(/^SELECT /, '')};
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS c = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL; END;
      PERFORM set_config('tchefood.test_err', c || '|' || d, true); END $d$;
    SELECT current_setting('tchefood.test_err')`, tenant);
  if (!r.ok) throw new Error(r.message ?? 'detailOf');
  return r.out.split('\n').pop() ?? '';
}
const last = (r: PsqlResult) => r.out.split('\n').pop() ?? '';
const json = <T = Record<string, unknown>>(r: PsqlResult): T => {
  if (!r.ok) throw new Error(r.message ?? 'json');
  return JSON.parse(last(r)) as T;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uma sessão psql de verdade, com a entrada aberta. */
function session() {
  const child = spawn('psql', ['-h', target!.host, '-p', target!.port, '-U', target!.user, '-d', DB, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { err += String(d); });
  const done = new Promise<string>((resolve, reject) => {
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `psql saiu com ${code}`))));
  });
  done.catch(() => undefined);
  return { send: (text: string) => child.stdin.write(`${text}\n`), end: (text = '') => child.stdin.end(`${text}\n`), output: () => out, done };
}

async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Não aconteceu em ${ms} ms: ${what}`);
    await pause(25);
  }
}

function waiting(): number {
  return Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${DB}' AND wait_event_type = 'Lock'`));
}

let lastOverlap = 0;

/**
 * Disputa pela MESMA linha, na ordem dada (mesmo método de mercadoPago.pg.test.ts): uma sessão trava a linha,
 * cada comando entra numa sessão própria e só o seguinte entra depois que o banco mostra o anterior parado na
 * trava. Com todos esperando, a trava é solta e eles passam na ordem de chegada.
 */
async function contend(lock: string, queries: string[]): Promise<string[]> {
  const before = waiting();
  const holder = session();
  holder.send(`BEGIN; ${lock}; SELECT 'held';`);
  await until('trava da linha', () => holder.output().includes('held'));
  const runs: Promise<string>[] = [];
  try {
    for (let i = 0; i < queries.length; i += 1) {
      const s = session();
      s.end(queries[i]);
      runs.push(s.done);
      await until(`sessão ${i + 1} esperando a linha`, () => waiting() === before + i + 1);
    }
    lastOverlap = waiting() - before;
  } finally {
    holder.end('COMMIT;');
  }
  await holder.done;
  return (await Promise.all(runs)).map((out) => out.split('\n').pop() ?? '');
}

/** Roda q e devolve 'ok' ou 'recusado <SQLSTATE>: <mensagem>' (a sessão não cai). */
const tryFn = `CREATE FUNCTION pg_temp.t(q text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE q; RETURN 'ok'; EXCEPTION WHEN others THEN RETURN 'recusado ' || SQLSTATE || ': ' || SQLERRM; END $f$;`;
const deviceQ = (q: string, tenant = TENANT) =>
  `${tryFn} BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${tenant}"}', true);
   SELECT pg_temp.t($q$${q}$q$); COMMIT;`;
const ownerQ = (q: string) => `${tryFn} SELECT pg_temp.t($q$${q}$q$);`;

let seq = 0;
/** Conta de verdade com saldo `balance` (um item, sem 10%): aceita vários pagamentos e fecha no zero. */
function withItems(balance: number, tenant = TENANT, _table = TABLE, staff = STAFF): string {
  seq += 1;
  const id = `f0f0f0f0-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${id}', '${tenant}', test_fresh_table('${tenant}'), '${staff}');
       BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
       VALUES ('${id}', gen_random_uuid(), '${staff}', 1, ${balance}, ${balance}, 'NONE');
       UPDATE orders SET charge_service_fee = false, subtotal_items = ${balance}, total_amount = ${balance}, paid_amount = 0, remaining_balance = ${balance} WHERE id = '${id}';
       COMMIT;`);
  return id;
}
const bal = (order: string) => Number(sql(`SELECT round(remaining_balance * 100)::bigint FROM orders WHERE id = '${order}'`));
const key = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;

/** Segredo de liberação que o aparelho gera para cada chave antes de pedir a reserva (64 hex minúsculas). */
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const tokens = new Map<string, string>();
const tokenFor = (k: string) => {
  if (!tokens.has(k)) tokens.set(k, newToken());
  return tokens.get(k)!;
};
const claimed = new Set<string>();
/** Segredo de uma reserva criada pelos testes, como literal SQL (NULL se a chave nunca virou reserva por aqui). */
const tok = (k: string) => (claimed.has(k) ? `'${tokens.get(k)}'` : 'NULL');
const claimQ = (k: string, order: string, method: string, acquirer: string, cents: number, expected: number | string, staff = STAFF, token: string = `'${tokenFor(k)}'`) =>
  `SELECT tchefood_claim_payment('${k}', '${order}', '${method}', '${acquirer}', ${cents}, ${expected}, '${staff}', ${token})`;
const claim = (k: string, order: string, method: string, acquirer: string, cents: number, expected?: number | string, staff = STAFF, tenant = TENANT) => {
  const r = asDevice(claimQ(k, order, method, acquirer, cents, expected ?? bal(order), staff), tenant);
  if (r.ok) claimed.add(k);
  return r;
};
const cash = (k: string, order: string, cents: number, expected?: number) => claim(k, order, 'CASH', 'CASH_DESK', cents, expected);
const stoneClaim = (k: string, order: string, cents: number, expected?: number) => claim(k, order, 'CREDIT', 'STONE', cents, expected);

const openPointQ = (k: string, order: string, cents: number, expected: number) =>
  `SELECT tchefood_open_terminal_charge('${TENANT}', '${k}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}', ${expected})`;
const openPoint = (k: string, order: string, cents: number, expected?: number) => psql(target!, `${openPointQ(k, order, cents, expected ?? bal(order))};`, DB);

const payment = (order: string, amount: number, over: Record<string, unknown> = {}) => JSON.stringify({
  id: crypto.randomUUID(), order_id: order, tenant_id: TENANT, waiter_id: STAFF, terminal_id: null, amount, tip_amount: 0,
  method: 'CASH', status: 'APPROVED', acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null,
  terminal_serial: null, idempotency_key: crypto.randomUUID(), created_at: new Date().toISOString(), ...over,
});
const stonePayment = (order: string, amount: number, over: Record<string, unknown> = {}) => payment(order, amount, {
  method: 'CREDIT', acquirer: 'STONE', acquirer_cnpj: STONE_CNPJ, terminal_id: STONE_TERMINAL, terminal_serial: 'STONE-01',
  card_brand: 'VISA', nsu: `R${crypto.randomUUID().slice(0, 8)}`, authorization_code: 'A12345', ...over,
});
const registerQ = (j: string) => `SELECT tchefood_register_payment('${j}'::jsonb)`;
/** Pagamento do aparelho sem reserva (o aparelho com a lista de maquininhas velha, ou a loja sem Point). */
const register = (j: string, tenant = TENANT) => asDevice(registerQ(j), tenant);
/**
 * O caminho do aparelho na loja com Point: a reserva (tchefood_claim_payment, saldo que o aparelho viu) e o
 * pagamento com a chave dela, num comando só (reserva recusada = nada gravado).
 */
const payQ = (j: string, expected: number) => {
  const p = JSON.parse(j) as { idempotency_key: string; order_id: string; method: string; acquirer: string; amount: number; waiter_id: string };
  return `WITH c AS MATERIALIZED (SELECT ${claimQ(p.idempotency_key, p.order_id, p.method, p.acquirer, Math.round(p.amount * 100), expected, p.waiter_id).replace(/^SELECT /, '')} AS r)
          SELECT tchefood_register_payment('${j}'::jsonb) FROM c`;
};
const pay = (j: string, tenant = TENANT) => asDevice(payQ(j, bal((JSON.parse(j) as { order_id: string }).order_id)), tenant);
/** Reserva gravada direto (dono do banco), sem a conferência de saldo de tchefood_claim_payment. */
/**
 * Prazo de atividade vencido há `ago` (o aparelho parou de renovar). Só para montar o cenário: o gatilho não deixa
 * mudar active_until fora da renovação, então vai sem os gatilhos (session_replication_role = replica).
 */
const idle = (k: string, ago = '5 minutes 1 second') =>
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE payment_claims SET active_until = clock_timestamp() - INTERVAL '${ago}' WHERE idempotency_key = '${k}'; COMMIT;`);
const rawClaim = (k: string, order: string, method: string, acquirer: string, cents: number, staff = STAFF, tenant = TENANT) =>
  sql(`INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
       VALUES ('${tenant}', '${k}', '${order}', '${method}', '${acquirer}', ${cents}, '${staff}') RETURNING id;`);

type Reservation = { reserved_cents: number; point_cents: number; claims_cents: number; open_charges: number; manual_review: boolean;
  charges: { idempotency_key: string; status: string; amount_cents: number; raw_status_detail: string | null; has_payment: boolean;
    created_at: string; stale: boolean }[];
  claims: { idempotency_key: string; amount_cents: number; method: string; acquirer: string; created_at: string; created_by: string; created_by_name: string | null;
    active_until: string; releasable_at: string }[] };
const reservation = (order: string, tenant = TENANT) => json<Reservation>(asDevice(`SELECT tchefood_point_reservation('${order}')`, tenant));
const claimField = (k: string, expr: string) => sql(`SELECT ${expr} FROM payment_claims WHERE idempotency_key = '${k}'`);
const audits = (action: string, metaKey: string, value: string) =>
  Number(sql(`SELECT count(*) FROM audit_logs WHERE action_type = '${action}' AND metadata->>'${metaKey}' = '${value}'`));

/** Cobrança da Point gravada direto (como a Edge Function grava), no estado pedido. */
function charge(order: string, status: string, cents = 1000, over: Record<string, string | number | null> = {}): { key: string; id: string } {
  const k = key('ch');
  const receipt: Record<string, string | number> = status === 'approved'
    ? { external_payment_id: `P${seq}${k.slice(-4)}`, paid_amount_cents: cents, card_brand: 'VISA', authorization_code: 'AUT1' } : {};
  const row: Record<string, string | number | null> = {
    tenant_id: TENANT, idempotency_key: k, order_id: order, terminal_id: TERMINAL, provider: 'mercado_pago_point',
    external_terminal_id: MP_ID, method: 'CREDIT', amount_cents: cents, status, external_order_id: `ORD-${k}`, ...receipt, ...over,
  };
  const cols = Object.keys(row);
  const vals = cols.map((c) => (row[c] === null ? 'NULL' : typeof row[c] === 'number' ? String(row[c]) : `'${row[c]}'`));
  const id = sql(`INSERT INTO terminal_charges (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id;`);
  return { key: k, id };
}
const chargeField = (id: string, expr: string) => sql(`SELECT ${expr} FROM terminal_charges WHERE id = '${id}'`);

/** Pagamento do Mercado Pago igual à cobrança aprovada (gravado direto, como no outro teste). */
function mpPayment(id: string, status = 'APPROVED', paymentId: string = crypto.randomUUID()): PsqlResult {
  return psql(target!, `${mpPaymentQ(id, status, paymentId)};`, DB);
}
/** O INSERT de mpPayment, como texto (para rodar numa sessão própria). */
function mpPaymentQ(id: string, status = 'APPROVED', paymentId: string = crypto.randomUUID()): string {
  const c = sql(`SELECT order_id || '|' || amount_cents || '|' || COALESCE(external_payment_id, '') || '|' || COALESCE(authorization_code, '') || '|' || idempotency_key FROM terminal_charges WHERE id = '${id}'`).split('|');
  return `INSERT INTO payments (id, order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, acquirer_cnpj, card_brand, nsu, authorization_code, terminal_serial, idempotency_key)
                        VALUES ('${paymentId}', '${c[0]}', '${TENANT}', '${STAFF}', '${TERMINAL}', ${Number(c[1]) / 100}, 'CREDIT', '${status}', 'MERCADO_PAGO', '10573521000191', 'VISA', NULLIF('${c[2]}', ''), NULLIF('${c[3]}', ''), '${MP_ID}', '${c[4]}')`;
}

/** Pagamento PENDING do Mercado Pago antigo (de antes da auditoria r8, que não o deixa mais entrar), gravado sem os gatilhos. */
function legacyMpPending(id: string): string {
  const paymentId = crypto.randomUUID();
  const c = sql(`SELECT order_id || '|' || amount_cents || '|' || idempotency_key FROM terminal_charges WHERE id = '${id}'`).split('|');
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO payments (id, order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, acquirer_cnpj, terminal_serial, idempotency_key)
       VALUES ('${paymentId}', '${c[0]}', '${TENANT}', '${STAFF}', '${TERMINAL}', ${Number(c[1]) / 100}, 'CREDIT', 'PENDING', 'MERCADO_PAGO', '10573521000191', '${MP_ID}', '${c[2]}'); COMMIT;`);
  return paymentId;
}

/** Pedido de conferência com PIN de gerente (como a Edge Function faz antes de ler o Mercado Pago). */
const reconcile = (k: string, pin = MANAGER_PIN, tenant = TENANT, staff = STAFF, reason = 'conferir no Mercado Pago') =>
  psql(target!, `SELECT tchefood_authorize_point_reconcile('${tenant}', '${k}', '${staff}', '${pin}', '${reason}');`, DB);
const authorized = (k: string) => {
  const r = reconcile(k);
  expect(r.out, r.message ?? '').toMatch(/^[0-9a-f-]{36}$/);
  return r.out;
};
const resolveQ = (id: string, from: string, to: string, patch: string, evidence: string, reason = 'conferido no Mercado Pago', staff = STAFF, tenant = TENANT) =>
  `SELECT status FROM tchefood_resolve_point_charge('${tenant}', '${id}', '${from}', '${to}', '${patch}'::jsonb, '${staff}', '${reason}', '${evidence}'::jsonb)`;
/** Estorno total lido no Mercado Pago (auditoria interna 1), para o fim verificado da aprovada → estornada. */
const refundRead = (id: string) => `"mp_status":"refunded","mp_amount_refunded_cents":${sql(`SELECT amount_cents FROM terminal_charges WHERE id = '${id}'`)}`;
const resolve = (id: string, from: string, to: string, patch = '{}', evidence?: string) =>
  psql(target!, `${resolveQ(id, from, to, patch, evidence ?? `{"authorization_audit_id":"${authorized(sql(`SELECT idempotency_key FROM terminal_charges WHERE id = '${id}'`))}","operation_id":"op-1",${from === 'approved' ? refundRead(id) : '"mp_status":"x"'}}`)};`, DB);
/**
 * Estorno verificado do pagamento registrado (GPT r9 P1-01, tchefood_refund_point_payment) com a prova lida no Mercado
 * Pago igual à cobrança; `over` troca campos da prova; authorization: id do pedido de conferência com PIN.
 */
const refundEvidence = (id: string, authorization: string, over: Record<string, unknown> = {}) => {
  const [k, pid, cents] = sql(`SELECT idempotency_key || '|' || COALESCE(external_payment_id, '') || '|' || amount_cents FROM terminal_charges WHERE id = '${id}'`).split('|');
  return JSON.stringify({ authorization_audit_id: authorization, operation_id: null, mp_payment_id: pid, mp_amount_cents: Number(cents),
    mp_external_reference: k, mp_status: 'refunded', mp_amount_refunded_cents: Number(cents), ...over });
};
const refundQ = (id: string, evidence: string, patch = '{"raw_status":"refunded","raw_status_detail":"refunded"}', staff = STAFF, tenant = TENANT, reason = 'estorno conferido no Mercado Pago') =>
  `SELECT status FROM tchefood_refund_point_payment('${tenant}', '${id}', '${staff}', '${reason}', '${patch}'::jsonb, '${evidence}'::jsonb)`;
const refundPoint = (id: string, over: Record<string, unknown> = {}, authorization?: string) =>
  psql(target!, `BEGIN; SET LOCAL ROLE service_role; ${refundQ(id, refundEvidence(id, authorization ?? authorized(sql(`SELECT idempotency_key FROM terminal_charges WHERE id = '${id}'`)), over))}; COMMIT;`, DB);
const receiptPatch = (cents: number, nsu = `N${crypto.randomUUID().slice(0, 6)}`) =>
  `{"external_payment_id":"${nsu}","paid_amount_cents":${cents},"card_brand":"VISA","authorization_code":"AUTR1","raw_status":"processed","raw_status_detail":"accredited"}`;

describe.skipIf(!target)('auditoria r5: reserva de pagamento e fim verificado da Point no banco real', () => {
  beforeAll(() => {
    applySchema(target!, DB);
    // Uma mesa nova por conta (PR #54): duas contas abertas na mesma mesa são recusadas (TCHEFOOD_MESA_OCUPADA).
    sql(`CREATE SEQUENCE IF NOT EXISTS test_table_seq START 1000;
         CREATE OR REPLACE FUNCTION test_fresh_table(p_tenant UUID) RETURNS UUID LANGUAGE sql AS $$
           INSERT INTO dining_tables (tenant_id, number, label) SELECT p_tenant, n, 'Mesa ' || n FROM (SELECT nextval('test_table_seq')::int AS n) s RETURNING id $$;`);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja', 'Loja Ltda', '11222333000181'), ('${OTHER}', 'Outra', 'Outra Ltda', '11444777000161'),
                ('${PIN_TENANT}', 'Loja do PIN', 'Loja do PIN Ltda', '11555666000172');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF}', '${TENANT}', 'Caixa', 'CASHIER', '5162'),
                ('${STAFF_B}', '${TENANT}', 'Caixa 2', 'CASHIER', '5163'),
                ('${MANAGER}', '${TENANT}', 'Gerente', 'MANAGER', '${MANAGER_PIN}'), ('${OTHER_STAFF}', '${OTHER}', 'Caixa da outra', 'CASHIER', '5162'),
                ('${PIN_STAFF}', '${PIN_TENANT}', 'Caixa do PIN', 'CASHIER', '5164'), ('${PIN_MANAGER}', '${PIN_TENANT}', 'Gerente do PIN', 'MANAGER', '${PIN_MANAGER_PIN}');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code, active) VALUES ('${INACTIVE}', '${TENANT}', 'Saiu', 'CASHIER', '7777', false);
         INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${LATE_TENANT}', 'Loja sem Point', 'Loja sem Point Ltda', '11666777000183');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${LATE_STAFF}', '${LATE_TENANT}', 'Caixa da loja nova', 'CASHIER', '5165');
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${LATE_TABLE}', '${LATE_TENANT}', 1, 'Mesa 1');
         INSERT INTO dining_tables (id, tenant_id, number, label, kind) VALUES ('${KIOSK_TABLE}', '${TENANT}', 950, 'Totem', 'KIOSK');
         INSERT INTO delivery_zones (id, tenant_id, name, fee, eta_minutes) VALUES ('${ZONE}', '${TENANT}', 'Centro', 5, 30);
         INSERT INTO couriers (id, tenant_id, name, fee_per_delivery) VALUES ('${COURIER}', '${TENANT}', 'Entregador', 4);
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${TABLE}', '${TENANT}', 1, 'Mesa 1'), ('${OTHER_TABLE}', '${OTHER}', 1, 'Mesa 1'),
                ('${PIN_TABLE}', '${PIN_TENANT}', 1, 'Mesa 1');
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${TERMINAL}', '${TENANT}', 'Point Smart', '${MP_ID}', 'MERCADO_PAGO'),
                ('${STONE_TERMINAL}', '${TENANT}', 'Stone 01', 'STONE-01', 'STONE'), ('${PIN_TERMINAL}', '${PIN_TENANT}', 'Point do PIN', 'PIN-POINT', 'MERCADO_PAGO');`);
  }, 120_000);

  describe('A2: tchefood_claim_payment', () => {
    it('reserva dinheiro: devolve {id, idempotency_key, status, amount_cents}; a reserva aparece na leitura e soma com a Point', () => {
      const order = withItems(100);
      const k = key('cash');
      const r = json(cash(k, order, 6000));
      // O segredo de liberação é do aparelho: nunca volta na resposta; o banco guarda só o sha256 dele.
      expect(Object.keys(r).sort()).toEqual(['amount_cents', 'id', 'idempotency_key', 'status']);
      expect(r).toMatchObject({ idempotency_key: k, status: 'open', amount_cents: 6000 });
      expect(claimField(k, `encode(release_token_hash, 'hex') = encode(sha256(convert_to('${tokens.get(k)}', 'UTF8')), 'hex')`)).toBe('t');
      expect(json(cash(k, order, 6000))).toEqual(r);
      expect(claimField(k, `tenant_id || '|' || order_id || '|' || method || '|' || acquirer || '|' || created_by`)).toBe(`${TENANT}|${order}|CASH|CASH_DESK|${STAFF}`);
      const read = reservation(order);
      expect(read).toMatchObject({ reserved_cents: 6000, point_cents: 0, claims_cents: 6000, open_charges: 0, manual_review: false, charges: [] });
      // Revisão: a leitura lista as reservas abertas (quem pediu, quando, forma e credenciadora).
      expect(read.claims).toEqual([{ idempotency_key: k, amount_cents: 6000, method: 'CASH', acquirer: 'CASH_DESK',
        created_at: read.claims[0].created_at, created_by: STAFF, created_by_name: 'Caixa',
        active_until: read.claims[0].active_until, releasable_at: read.claims[0].releasable_at }]);
      // r6: prazo de atividade de 90 s desde a reserva; liberável pelo gerente 5 min depois do prazo.
      expect(Date.parse(read.claims[0].active_until) - Date.parse(read.claims[0].created_at)).toBeGreaterThanOrEqual(90_000);
      expect(Date.parse(read.claims[0].active_until) - Date.parse(read.claims[0].created_at)).toBeLessThan(95_000);
      expect(Date.parse(read.claims[0].releasable_at) - Date.parse(read.claims[0].active_until)).toBe(300_000);
      expect(Date.parse(read.claims[0].created_at)).toBe(Date.parse(claimField(k, `to_jsonb(created_at) #>> '{}'`)));
      // A Point vê os R$ 40,00 livres (o saldo da conta não mudou: a reserva não é pagamento).
      expect(openPoint(key('pt'), order, 4001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      const pk = key('pt');
      expect(openPoint(pk, order, 4000).ok).toBe(true);
      const after = reservation(order);
      expect(after).toMatchObject({ reserved_cents: 10000, point_cents: 4000, claims_cents: 6000, open_charges: 1 });
      expect(after.charges).toEqual([{ idempotency_key: pk, status: 'creating', amount_cents: 4000, raw_status_detail: null, has_payment: false,
        created_at: expect.any(String), stale: false }]);
      // E outra reserva não passa da reserva única.
      expect(cash(key('cash'), order, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
    });

    it('segredo gerado pelo aparelho: reenvio com o mesmo segredo devolve a reserva; com outro, TF009 sem dizer mais nada', () => {
      const order = withItems(100);
      const k = key('ctok');
      const first = json(cash(k, order, 2000));
      // Mesmo segredo (a resposta da primeira chamada se perdeu): a mesma reserva, sem criar outra.
      expect(json(cash(k, order, 2000))).toEqual(first);
      // Outro segredo com os mesmos dados: a mesma recusa (e mensagem) de chave já usada com outros dados.
      const other = asDevice(claimQ(k, order, 'CASH', 'CASH_DESK', 2000, bal(order), STAFF, `'${newToken()}'`));
      const otherData = cash(k, order, 2001);
      expect(other).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(otherData).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(other.message).toBe(otherData.message);
      expect(other.message).not.toMatch(/segredo/i);
      expect(Number(sql(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${k}'`))).toBe(1);
      expect(claimField(k, `encode(release_token_hash, 'hex') = encode(sha256(convert_to('${tokens.get(k)}', 'UTF8')), 'hex')`)).toBe('t');
      // Renovação e liberação com o segredo do aparelho funcionam; com outro, TF004.
      expect(asDevice(`SELECT tchefood_touch_payment_claim('${k}', '${STAFF}', '${newToken()}')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(json<{ status: string }>(asDevice(`SELECT tchefood_touch_payment_claim('${k}', '${STAFF}', ${tok(k)})`)).status).toBe('open');
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', '${newToken()}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(json<{ status: string }>(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`)).status).toBe('released');
      // Reserva gravada sem segredo (fora da função): reenvio com qualquer segredo é TF009.
      const raw = key('ctok-raw');
      rawClaim(raw, order, 'CASH', 'CASH_DESK', 100);
      expect(asDevice(claimQ(raw, order, 'CASH', 'CASH_DESK', 100, bal(order)))).toMatchObject({ ok: false, sqlstate: 'TF009' });
    });

    it('assinatura antiga de 7 argumentos não existe mais (42883 para aparelho antigo)', () => {
      const order = withItems(10);
      expect(asDevice(`SELECT tchefood_claim_payment('${key('old')}', '${order}', 'CASH', 'CASH_DESK', 100, 1000, '${STAFF}')`)).toMatchObject({ ok: false, sqlstate: '42883' });
      expect(sql(`SELECT count(*) FROM pg_proc WHERE proname = 'tchefood_claim_payment'`)).toBe('1');
    });

    it('reenvio da mesma chave devolve a mesma reserva sem reconferir o saldo; outros dados com a mesma chave: TF009', () => {
      const order = withItems(100);
      const k = key('re');
      const first = json(stoneClaim(k, order, 3000, 10000));
      // Saldo muda de verdade (dinheiro de R$ 20,00 com outra chave): o reenvio com o saldo antigo devolve a mesma.
      expect(pay(payment(order, 20)).ok).toBe(true);
      expect(bal(order)).toBe(8000);
      expect(json(stoneClaim(k, order, 3000, 10000))).toEqual(first);
      expect(Number(sql(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${k}'`))).toBe(1);
      for (const [label, r] of [
        ['valor', stoneClaim(k, order, 3001, 8000)],
        ['forma', claim(k, order, 'DEBIT', 'STONE', 3000, 8000)],
        ['credenciadora', claim(k, order, 'CREDIT', 'PAGBANK', 3000, 8000)],
        ['conta', stoneClaim(k, withItems(100), 3000, 10000)],
      ] as const) {
        expect(r, label).toMatchObject({ ok: false, sqlstate: 'TF009' });
      }
    });

    it('dados inválidos: TF006, nada gravado', () => {
      const order = withItems(100);
      const cases: [string, string][] = [
        ['chave nula', `SELECT tchefood_claim_payment(NULL, '${order}', 'CASH', 'CASH_DESK', 100, 10000, '${STAFF}', '${newToken()}')`],
        ['chave com espaço', claimQ('a b', order, 'CASH', 'CASH_DESK', 100, 10000)],
        ['chave longa', claimQ('x'.repeat(51), order, 'CASH', 'CASH_DESK', 100, 10000)],
        ['conta nula', `SELECT tchefood_claim_payment('k-null-order', NULL, 'CASH', 'CASH_DESK', 100, 10000, '${STAFF}', '${newToken()}')`],
        // Segredo do aparelho: exatamente 64 letras hex minúsculas.
        ['segredo nulo', claimQ('k-tok-1', order, 'CASH', 'CASH_DESK', 100, 10000, STAFF, 'NULL')],
        ['segredo vazio', claimQ('k-tok-2', order, 'CASH', 'CASH_DESK', 100, 10000, STAFF, `''`)],
        ['segredo curto', claimQ('k-tok-3', order, 'CASH', 'CASH_DESK', 100, 10000, STAFF, `'${'a'.repeat(63)}'`)],
        ['segredo longo', claimQ('k-tok-4', order, 'CASH', 'CASH_DESK', 100, 10000, STAFF, `'${'a'.repeat(65)}'`)],
        ['segredo maiúsculo', claimQ('k-tok-5', order, 'CASH', 'CASH_DESK', 100, 10000, STAFF, `'${'A'.repeat(64)}'`)],
        ['segredo não hex', claimQ('k-tok-6', order, 'CASH', 'CASH_DESK', 100, 10000, STAFF, `'${'g'.repeat(64)}'`)],
        ['segredo com quebra de linha', claimQ('k-tok-7', order, 'CASH', 'CASH_DESK', 100, 10000, STAFF, `'${'a'.repeat(64)}' || chr(10)`)],
        ['dinheiro na Stone', claimQ('k-inv-1', order, 'CASH', 'STONE', 100, 10000)],
        ['cartão no caixa', claimQ('k-inv-2', order, 'CREDIT', 'CASH_DESK', 100, 10000)],
        ['vale', claimQ('k-inv-3', order, 'VOUCHER', 'STONE', 100, 10000)],
        ['Mercado Pago', claimQ('k-inv-4', order, 'CREDIT', 'MERCADO_PAGO', 100, 10000)],
        ['forma nula', claimQ('k-inv-5', order, 'NULL', 'CASH_DESK', 100, 10000).replace(`'NULL'`, 'NULL')],
        ['valor zero', claimQ('k-inv-6', order, 'CASH', 'CASH_DESK', 0, 10000)],
        ['valor negativo', claimQ('k-inv-7', order, 'CASH', 'CASH_DESK', -1, 10000)],
        ['valor nulo', claimQ('k-inv-8', order, 'CASH', 'CASH_DESK', 'NULL' as unknown as number, 10000)],
        ['saldo nulo', claimQ('k-inv-9', order, 'CASH', 'CASH_DESK', 100, 'NULL')],
        ['saldo negativo', claimQ('k-inv-10', order, 'CASH', 'CASH_DESK', 100, -1)],
      ];
      for (const [label, q] of cases) expect(asDevice(q), label).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(sql(`SELECT count(*) FROM payment_claims WHERE order_id = '${order}'`)).toBe('0');
    });

    it.each([
      ['sem operador', 'NULL'],
      ['operador inativo', `'${INACTIVE}'`],
      ['operador de outra loja', `'${OTHER_STAFF}'`],
      ['id que não existe', `'12345678-1234-4234-8234-123456789012'`],
    ])('%s: TF004 e nada gravado', (_label, who) => {
      const order = withItems(100);
      const r = asDevice(`SELECT tchefood_claim_payment('k-who', '${order}', 'CASH', 'CASH_DESK', 100, 10000, ${who}, '${newToken()}')`);
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(sql(`SELECT count(*) FROM payment_claims WHERE idempotency_key = 'k-who'`)).toBe('0');
    });

    it('conta que não está no servidor ou é de outra loja (TF001), encerrada (TF002), saldo diferente (TF008), acima do livre (TF003)', () => {
      expect(cash(key('c'), '12345678-1234-4234-8234-123456789012', 100, 0)).toMatchObject({ ok: false, sqlstate: 'TF001' });
      const otherOrder = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      expect(cash(key('c'), otherOrder, 100, 10000)).toMatchObject({ ok: false, sqlstate: 'TF001' });
      const closed = withItems(50);
      expect(pay(payment(closed, 50)).ok).toBe(true);
      expect(sql(`SELECT status FROM orders WHERE id = '${closed}'`)).toBe('CLOSED');
      expect(cash(key('c'), closed, 100, 0)).toMatchObject({ ok: false, sqlstate: 'TF002' });
      const order = withItems(100);
      for (const expected of [9999, 10001, 0]) {
        const r = cash(key('c'), order, 100, expected);
        expect(r, String(expected)).toMatchObject({ ok: false, sqlstate: 'TF008' });
        expect(r.message).toContain('Nada foi cobrado');
      }
      // Saldo diferente vem antes do "passa do saldo".
      expect(cash(key('c'), order, 20000, 9999)).toMatchObject({ ok: false, sqlstate: 'TF008' });
      expect(cash(key('c'), order, 10001, 10000)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      // Cobrança da Point em revisão manual reserva para a reserva de pagamento também.
      charge(order, 'manual_review', 7000);
      const over = cash(key('c'), order, 3001, 10000);
      expect(over).toMatchObject({ ok: false, sqlstate: 'TF003' });
      expect(over.message).toContain('R$ 30.00 livre; R$ 70.00 reservado');
      expect(cash(key('c'), order, 3000, 10000).ok).toBe(true);
      expect(sql(`SELECT count(*) FROM payment_claims WHERE order_id = '${otherOrder}'`)).toBe('0');
      // Na conta fechada, só a reserva consumida pelo pagamento que a fechou.
      expect(sql(`SELECT string_agg(status, ',') FROM payment_claims WHERE order_id = '${closed}'`)).toBe('consumed');
    });

    it('TF009 key_in_use: chave de cobrança da Point não vira reserva, nem a de reserva vira cobrança (criação e bloqueio); chave de pagamento gravado também não', () => {
      const order = withItems(100);
      const pk = key('pt');
      expect(openPoint(pk, order, 1000).ok).toBe(true);
      expect(cash(pk, order, 1000, 10000)).toMatchObject({ ok: false, sqlstate: 'TF009' });
      const ck = key('cl');
      expect(cash(ck, order, 1000, 10000).ok).toBe(true);
      expect(openPoint(ck, order, 1000)).toMatchObject({ ok: false, sqlstate: 'TF009' });
      const block = psql(target!, `SELECT tchefood_block_point_key('${TENANT}', '${ck}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1000, '${STAFF}');`, DB);
      expect(block).toMatchObject({ ok: false, sqlstate: 'TF009' });
      // Gravando direto (fora das funções), o gatilho recusa igual.
      const direct = psql(target!, `INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status)
                                    VALUES ('${TENANT}', '${ck}', '${order}', '${TERMINAL}', 'mercado_pago_point', '${MP_ID}', 'CREDIT', 1000, 'creating');`, DB);
      expect(direct).toMatchObject({ ok: false, sqlstate: 'TF009' });
      const directClaim = psql(target!, `INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
                                         VALUES ('${TENANT}', '${pk}', '${order}', 'CASH', 'CASH_DESK', 100, '${STAFF}');`, DB);
      expect(directClaim).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${ck}'`)).toBe('0');
      // Pagamento já gravado com a chave sem reserva (pagamento antigo, de antes da auditoria r7 exigir a reserva em
      // toda loja; gravado sem os gatilhos só para montar o cenário): a chave não vira reserva.
      const otherOrder = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      const paid = JSON.parse(payment(otherOrder, 10, { tenant_id: OTHER, waiter_id: OTHER_STAFF })) as { id: string; idempotency_key: string };
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
           VALUES ('${paid.id}', '${otherOrder}', '${OTHER}', '${OTHER_STAFF}', 10, 'CASH', 'APPROVED', 'CASH_DESK', '${paid.idempotency_key}'); COMMIT;`);
      const again = claim(paid.idempotency_key, otherOrder, 'CASH', 'CASH_DESK', 100, undefined, OTHER_STAFF, OTHER);
      expect(again).toMatchObject({ ok: false, sqlstate: 'TF009' });
      // Revisão r8 (item 3): uma recusa só, sem dizer de quem é a chave.
      expect(again.message).toContain('já está em uso (outra reserva, cobrança ou pagamento)');
      // Chave de uma reserva de OUTRA loja: também recusada (a chave do pagamento é única no banco todo).
      const shared = key('xt');
      expect(cash(shared, order, 1000, 10000).ok).toBe(true);
      const cross = claim(shared, otherOrder, 'CASH', 'CASH_DESK', 100, undefined, OTHER_STAFF, OTHER);
      expect(cross).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(cross.message).toContain('já está em uso (outra reserva, cobrança ou pagamento)');
      expect(sql(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${shared}'`)).toBe('1');
    });

    it('permissões: anon não chama, token sem loja não reserva, o aparelho só lê as reservas da própria loja e não grava nem altera nenhuma', () => {
      const order = withItems(100);
      const k = key('perm');
      expect(asRole('anon', claimQ(k, order, 'CASH', 'CASH_DESK', 100, 10000))).toMatchObject({ ok: false, sqlstate: '42501' });
      for (const fn of [`tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'motivo')`, `tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'motivo longo o bastante')`,
        `tchefood_touch_payment_claim('${k}', '${STAFF}', NULL)`]) {
        expect(asRole('anon', `SELECT ${fn}`), fn).toMatchObject({ ok: false, sqlstate: '42501' });
      }
      const noTenant = asRole('authenticated', claimQ(k, order, 'CASH', 'CASH_DESK', 100, 10000));
      expect(noTenant.ok).toBe(false);
      expect(noTenant.message).toContain('TCHEFOOD_AUTH');
      expect(cash(k, order, 100).ok).toBe(true);
      expect(asDevice(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${k}'`).out).toContain('1');
      expect(asDevice(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${k}'`, OTHER).out).toContain('0');
      for (const q of [
        `UPDATE payment_claims SET amount_cents = 1 WHERE idempotency_key = '${k}'`,
        `DELETE FROM payment_claims WHERE idempotency_key = '${k}'`,
        `INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by) VALUES ('${TENANT}', 'forjada', '${order}', 'CASH', 'CASH_DESK', 100, '${STAFF}')`,
      ]) {
        expect(asDevice(q), q).toMatchObject({ ok: false, sqlstate: '42501' });
      }
      // A loja do token manda: outra loja não reserva na conta desta (a conta "não está no servidor" para ela).
      expect(asDevice(claimQ(key('x'), order, 'CASH', 'CASH_DESK', 100, 10000, OTHER_STAFF), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF001' });
      // A service role executa (sem loja no token, cai na conferência da loja).
      const svc = asRole('service_role', claimQ(key('x'), order, 'CASH', 'CASH_DESK', 100, 10000));
      expect(svc.message).toContain('TCHEFOOD_AUTH');
      // O aparelho não grava os registros do servidor em audit_logs.
      for (const action of ['PAYMENT_CLAIM_RELEASED', 'POINT_CHARGE_RESOLVED', 'POINT_CHARGE_RECONCILE_AUTHORIZED']) {
        const forged = asDevice(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
                                 VALUES ('${TENANT}', '${order}', '${STAFF}', '${action}', 'forjado', '{}'::jsonb)`);
        expect(forged.ok, action).toBe(false);
      }
    });
  });

  describe('A4: o pagamento com a chave da reserva a consome', () => {
    it('dinheiro reservado e pago com a mesma chave: entra, consome a reserva (a Point passa a ver o saldo novo)', () => {
      const order = withItems(100);
      const k = key('cash');
      expect(cash(k, order, 6000).ok).toBe(true);
      // Sem a reserva da própria chave, R$ 60,00 não caberiam (R$ 60,00 reservados de R$ 100,00 deixam R$ 40,00).
      const own = register(payment(order, 60, { idempotency_key: k }));
      expect(own.ok, own.message ?? '').toBe(true);
      expect(bal(order)).toBe(4000);
      expect(reservation(order)).toMatchObject({ reserved_cents: 0, claims_cents: 0, claims: [] });
      // Revisão P3: a reserva paga fica "consumed", com o pagamento dela.
      expect(claimField(k, `status || '|' || (consumed_payment_id = (SELECT id FROM payments WHERE idempotency_key = '${k}')) || '|' || (consumed_at IS NOT NULL)`))
        .toBe('consumed|true|true');
      expect(openPoint(key('pt'), order, 4001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      expect(openPoint(key('pt'), order, 4000).ok).toBe(true);
    });

    it('Stone reservada e paga com a mesma chave: entra e consome; valor menor que a reserva também consome tudo', () => {
      const order = withItems(100);
      const k = key('stone');
      expect(stoneClaim(k, order, 5000).ok).toBe(true);
      expect(cash(key('cash'), order, 5000).ok).toBe(true); // a outra metade, reservada por outro aparelho
      const r = register(stonePayment(order, 49.99, { idempotency_key: k }));
      expect(r.ok, r.message ?? '').toBe(true);
      expect(reservation(order)).toMatchObject({ claims_cents: 5000, reserved_cents: 5000 });
      expect(bal(order)).toBe(5001);
    });

    it('pagamento maior que a reserva é recusado e a reserva continua inteira', () => {
      const order = withItems(100);
      const k = key('big');
      expect(cash(k, order, 3000).ok).toBe(true);
      const r = register(payment(order, 30.01, { idempotency_key: k }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain('passa do valor reservado para este pagamento (R$ 30.00)');
      expect(reservation(order).claims_cents).toBe(3000);
      expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
      // Direto no banco, também.
      const direct = psql(target!, `INSERT INTO payments (order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
                                    VALUES ('${order}', '${TENANT}', '${STAFF}', 31, 'CASH', 'APPROVED', 'CASH_DESK', '${k}');`, DB);
      expect(direct.message).toContain('passa do valor reservado');
    });

    it('pagamento com a chave da reserva de OUTRA conta é recusado (INSERT e UPDATE), e as duas reservas continuam', () => {
      const a = withItems(100);
      const b = withItems(100);
      const k = key('other');
      expect(cash(k, a, 1000).ok).toBe(true);
      const r = register(payment(b, 10, { idempotency_key: k }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain(`a chave ${k} é da reserva de pagamento de outra conta`);
      expect(r.sqlstate).toBe('TF010');
      // Pagamento aprovado da conta B (com a reserva dele) que troca a chave pela da reserva da conta A: recusado.
      const id = crypto.randomUUID();
      rawClaim(id, b, 'CASH', 'CASH_DESK', 1000);
      sql(`INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
           VALUES ('${id}', '${b}', '${TENANT}', '${STAFF}', 10, 'CASH', 'APPROVED', 'CASH_DESK', '${id}');`);
      // Revisão r8 (F2): o pagamento gravado não muda de chave.
      const swap = psql(target!, `UPDATE payments SET idempotency_key = '${k}' WHERE id = '${id}';`, DB);
      expect(swap).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(swap.message).toContain('o pagamento gravado não muda de chave, de conta nem de loja');
      expect(reservation(a).claims_cents).toBe(1000);
    });

    it('chave de cobrança da Point continua recusada em pagamento que não é do Mercado Pago', () => {
      const order = withItems(100);
      const pk = key('pt');
      expect(openPoint(pk, order, 1000).ok).toBe(true);
      for (const j of [payment(order, 10, { idempotency_key: pk }), stonePayment(order, 10, { idempotency_key: pk })]) {
        const r = register(j);
        expect(r.ok).toBe(false);
        expect(r.message).toContain('é de uma cobrança da Point');
      }
      expect(reservation(order).point_cents).toBe(1000);
    });

    it('reserva liberada: não cobre mais pagamento nenhum; o pagamento com a chave dela é recusado (TF013)', () => {
      const order = withItems(100);
      const k = key('rel');
      expect(cash(k, order, 6000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'cliente desistiu')`).ok).toBe(true);
      expect(cash(key('c2'), order, 7000).ok).toBe(true); // a liberada não reserva mais
      for (const amount of [30.01, 30, 1]) {
        const r = register(payment(order, amount, { idempotency_key: k }));
        expect(r, String(amount)).toMatchObject({ ok: false, sqlstate: 'TF013' });
        expect(r.message, String(amount)).toContain('a reserva deste pagamento foi liberada pelo gerente; o valor não pode entrar: confira e devolva ao cliente');
      }
      expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
      expect(claimField(k, 'status')).toBe('released');
      // Com uma reserva nova (outra chave), os R$ 30,00 livres entram.
      expect(pay(payment(order, 30)).ok).toBe(true);
    });
  });

  describe('A3: liberar a reserva', () => {
    it('libera uma vez (um registro), de novo devolve como está; liberada não reserva; motivo, operador e chave conferidos', () => {
      const order = withItems(100);
      const k = key('rel');
      const created = json(cash(k, order, 6000));
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'ab')`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, NULL)`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      // Auditoria interna P3-6: operador inativo só libera com o segredo certo (teste próprio no fim); sem ele, TF004.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${INACTIVE}', '${'0'.repeat(64)}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${OTHER_STAFF}', ${tok(k)}, 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('nao-existe', '${STAFF}', NULL, 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      // Outra loja não acha a reserva desta.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${OTHER_STAFF}', ${tok(k)}, 'desistiu')`, OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(claimField(k, 'status')).toBe('open');
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
      // Auditoria r6: sem PIN, só o aparelho com o segredo da reserva libera; sem ele (ou com outro), TF004.
      for (const t of ['NULL', `'${'0'.repeat(64)}'`, `'${tokens.get(k)!.toUpperCase()}'`]) {
        const notMine = asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${t}, 'maquininha recusou')`);
        expect(notMine, t).toMatchObject({ ok: false, sqlstate: 'TF004' });
        expect(notMine.message, t).toContain('só o aparelho que pediu a reserva libera sem PIN');
      }
      expect(claimField(k, 'status')).toBe('open');
      const first = json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, '  maquininha recusou  ')`));
      expect(first).toMatchObject({ id: created.id, idempotency_key: k, status: 'released', amount_cents: 6000 });
      expect(claimField(k, `released_by || '|' || release_reason || '|' || (release_audit_id = '${first.release_audit_id}')`)).toBe(`${STAFF}|maquininha recusou|true`);
      expect(sql(`SELECT performed_by_user_id || '|' || order_id || '|' || reason || '|' || (authorized_by_manager_id IS NULL) FROM audit_logs WHERE id = '${first.release_audit_id}'`))
        .toBe(`${STAFF}|${order}|maquininha recusou|true`);
      // Já liberada: o reenvio com o segredo devolve como está (de qualquer operador da loja); sem o segredo, TF004.
      expect(json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF_B}', ${tok(k)}, 'outro motivo')`))).toEqual(first);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF_B}', NULL, 'outro motivo')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      const again = json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'outro motivo')`));
      expect(again).toEqual(first);
      expect(json(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'reserva presa do aparelho')`))).toEqual(first);
      // Terceira revisão P2-1: já liberada, com PIN errado, NULL e a falha conta no bloqueio (desfeito no fim para não
      // sujar as tentativas da loja); nunca a reserva "liberada" com qualquer PIN.
      const wrong = sql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
        SELECT COALESCE(tchefood_release_payment_claim_manager('${k}', '${STAFF}', '0000', 'reserva presa do aparelho')::text, 'null');
        RESET ROLE;
        SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED' AND metadata->>'idempotency_key' = '${k}';
        ROLLBACK;`).split('\n').filter((l) => l !== '' && l !== 'SET').slice(-2);
      expect(wrong).toEqual(['null', '1']);
      expect(claimField(k, `status || '|' || release_audit_id`)).toBe(`released|${first.release_audit_id}`);
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(1);
      expect(reservation(order)).toMatchObject({ reserved_cents: 0, claims_cents: 0 });
      // Reenvio da reserva com a mesma chave devolve a liberada (o aparelho não cobra com ela).
      expect(json(cash(k, order, 6000))).toMatchObject({ id: created.id, status: 'released' });
    });

    it('depois do pagamento: TF007 (aparelho e gerente), sem registro, e a reserva fica consumida', () => {
      const order = withItems(100);
      const k = key('paid');
      expect(cash(k, order, 2000).ok).toBe(true);
      expect(register(payment(order, 20, { idempotency_key: k })).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'reserva presa do aparelho')`)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(claimField(k, 'status')).toBe('consumed');
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
    });

    it('gerente: PIN certo libera com o gerente no registro, também a reserva pedida por outro operador; motivo curto TF006', () => {
      const order = withItems(100);
      const k = key('mgr');
      expect(claim(k, order, 'CASH', 'CASH_DESK', 2000, undefined, STAFF_B).ok).toBe(true);
      idle(k); // o aparelho que pediu parou de renovar
      expect(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'curto')`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${INACTIVE}', '${MANAGER_PIN}', 'reserva presa do aparelho')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      const r = json(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'aparelho do caixa quebrou')`));
      expect(r).toMatchObject({ status: 'released', idempotency_key: k });
      expect(sql(`SELECT authorized_by_manager_id || '|' || (metadata->>'by_manager') FROM audit_logs WHERE id = '${r.release_audit_id}'`)).toBe(`${MANAGER}|true`);
    });

    it('gerente: PIN errado devolve NULL, nada é liberado e só a falha fica registrada; 3 falhas bloqueiam até o PIN certo', () => {
      const order = withItems(100, PIN_TENANT, PIN_TABLE, PIN_STAFF);
      const k = key('pin');
      expect(asDevice(claimQ(k, order, 'CASH', 'CASH_DESK', 2000, 10000, PIN_STAFF), PIN_TENANT).ok).toBe(true);
      idle(k);
      const release = (pin: string) => asDevice(`SELECT COALESCE(tchefood_release_payment_claim_manager('${k}', '${PIN_STAFF}', '${pin}', 'aparelho do caixa quebrou')::text, 'NULL')`, PIN_TENANT);
      for (const pin of ['0000', '5164', '']) { // errado, PIN do próprio caixa (não é gerente), vazio
        const r = release(pin);
        expect(r.ok, pin).toBe(true);
        expect(last(r), pin).toBe('NULL');
      }
      expect(claimField(k, 'status')).toBe('open');
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
      expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${PIN_TENANT}' AND action_type = 'MANAGER_PIN_FAILED' AND metadata->>'idempotency_key' = '${k}'`))).toBe(3);
      // Bloqueado: nem o PIN certo libera.
      expect(last(release(PIN_MANAGER_PIN))).toBe('NULL');
      expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${PIN_TENANT}' AND action_type = 'MANAGER_PIN_LOCKOUT'`))).toBe(1);
      expect(claimField(k, 'status')).toBe('open');
      expect(reservation(order, PIN_TENANT).claims_cents).toBe(2000);
      // A conferência da Point da mesma loja também fica bloqueada (mesmo contador).
      const ch = sql(`INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status)
                      VALUES ('${PIN_TENANT}', '${key('pinch')}', '${order}', '${PIN_TERMINAL}', 'mercado_pago_point', 'PIN-POINT', 'CREDIT', 100, 'manual_review') RETURNING idempotency_key;`);
      const rec = reconcile(ch, PIN_MANAGER_PIN, PIN_TENANT, PIN_STAFF);
      expect(rec.ok).toBe(true);
      expect(rec.out).toBe('');
      expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'POINT_CHARGE_RECONCILE_AUTHORIZED' AND metadata->>'idempotency_key' = '${ch}'`))).toBe(0);
    });

    it('o gatilho: liberar sem o registro, mudar dados da reserva ou reabrir a liberada é recusado (nem o dono do banco passa)', () => {
      const order = withItems(100);
      const k = key('trg');
      expect(cash(k, order, 1000).ok).toBe(true);
      const upd = (set: string) => psql(target!, `UPDATE payment_claims SET ${set} WHERE idempotency_key = '${k}';`, DB);
      expect(upd(`status = 'released', released_at = NOW(), released_by = '${STAFF}', release_reason = 'sem registro', release_audit_id = (SELECT id FROM audit_logs LIMIT 1)`).message)
        .toContain('só é liberada com motivo e registro');
      expect(upd(`status = 'released'`).ok).toBe(false);
      for (const set of [`amount_cents = 1`, `order_id = '${withItems(10)}'`, `method = 'PIX', acquirer = 'STONE'`, `acquirer = 'PAGBANK', method = 'DEBIT'`,
        `created_by = '${STAFF_B}'`, `idempotency_key = 'outra-chave'`, `created_at = NOW() - INTERVAL '1 day'`]) {
        expect(upd(set).message, set).toContain('não mudam');
      }
      expect(json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`)).status).toBe('released');
      expect(upd(`status = 'open', released_at = NULL, released_by = NULL, release_reason = NULL, release_audit_id = NULL`).message).toContain('já foi liberada');
      expect(upd(`release_reason = 'outro'`).message).toContain('já foi liberada');
      // Nasce aberta.
      const born = psql(target!, `INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by, status, released_at, released_by, release_reason, release_audit_id)
                                  VALUES ('${TENANT}', '${key('born')}', '${order}', 'CASH', 'CASH_DESK', 100, '${STAFF}', 'released', NOW(), '${STAFF}', 'x', (SELECT id FROM audit_logs LIMIT 1));`, DB);
      expect(born).toMatchObject({ ok: false, sqlstate: 'TF006' });
    });
  });

  describe('A4 em duas sessões de verdade (conta travada)', () => {
    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;

    it('(1) dinheiro reservado primeiro: a Point que esperava a conta, pelo saldo cheio, é recusada; o resto cabe', async () => {
      for (const [cents, ok] of [[10000, false], [4001, false], [4000, true]] as const) {
        const order = withItems(100);
        const ck = key('c1');
        const pk = key('p1');
        const [c, p] = await contend(lockOrder(order), [deviceQ(claimQ(ck, order, 'CASH', 'CASH_DESK', 6000, 10000)), ownerQ(openPointQ(pk, order, cents, 10000))]);
        expect(lastOverlap, pk).toBe(2);
        expect(c, pk).toBe('ok');
        if (ok) expect(p, pk).toBe('ok');
        else expect(p, pk).toMatch(/^recusado TF003: .*passa do saldo da conta no servidor \(R\$ 40\.00 livre\)/);
        expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${pk}'`), pk).toBe(ok ? '1' : '0');
        expect(reservation(order).reserved_cents, pk).toBe(ok ? 10000 : 6000);
      }
    }, 60_000);

    it('(2) Point aberta primeiro: a reserva que esperava a conta é recusada (TF003) e nada é gravado', async () => {
      for (const [method, acquirer] of [['CASH', 'CASH_DESK'], ['CREDIT', 'STONE'], ['PIX', 'PAGBANK']] as const) {
        const order = withItems(100);
        const ck = key('c2');
        const pk = key('p2');
        const [p, c] = await contend(lockOrder(order), [ownerQ(openPointQ(pk, order, 10000, 10000)), deviceQ(claimQ(ck, order, method, acquirer, 10000, 10000))]);
        expect(lastOverlap, method).toBe(2);
        expect(p, method).toBe('ok');
        expect(c, method).toMatch(/^recusado TF003: .*R\$ 0\.00 livre; R\$ 100\.00 reservado/);
        expect(sql(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${ck}'`), method).toBe('0');
      }
    }, 60_000);

    it('(3) duas reservas pelo saldo inteiro, Stone no aparelho A e dinheiro no aparelho B, nas duas ordens: só uma passa', async () => {
      for (const stoneFirst of [true, false]) {
        const order = withItems(100);
        const sk = key('sA');
        const ck = key('cB');
        const stoneQ = deviceQ(claimQ(sk, order, 'CREDIT', 'STONE', 10000, 10000, STAFF));
        const cashQ = deviceQ(claimQ(ck, order, 'CASH', 'CASH_DESK', 10000, 10000, STAFF_B));
        const out = await contend(lockOrder(order), stoneFirst ? [stoneQ, cashQ] : [cashQ, stoneQ]);
        expect(lastOverlap).toBe(2);
        expect(out[0]).toBe('ok');
        expect(out[1]).toMatch(/^recusado TF003: /);
        expect(Number(sql(`SELECT count(*) FROM payment_claims WHERE order_id = '${order}'`))).toBe(1);
        expect(reservation(order).claims_cents).toBe(10000);
        // O vencedor paga com a própria chave; o outro pagamento não entra.
        const winner = stoneFirst ? sk : ck;
        const paid = stoneFirst ? register(stonePayment(order, 100, { idempotency_key: sk })) : register(payment(order, 100, { idempotency_key: ck }));
        expect(paid.ok, paid.message ?? winner).toBe(true);
        expect(sql(`SELECT remaining_balance || '|' || status FROM orders WHERE id = '${order}'`)).toBe('0.00|CLOSED');
      }
    }, 60_000);

    it('reserva e pagamento sem reserva ao mesmo tempo, nas duas ordens: o segundo vê o primeiro', async () => {
      // Reserva primeiro: o dinheiro de R$ 100,00 (outra chave) é recusado pela reserva.
      let order = withItems(100);
      let [c, p] = await contend(lockOrder(order), [deviceQ(claimQ(key('c'), order, 'CASH', 'CASH_DESK', 5000, 10000)), deviceQ(payQ(payment(order, 100), 10000))]);
      expect(lastOverlap).toBe(2);
      expect(c).toBe('ok');
      // O pagamento (com a reserva dele, no mesmo comando) é recusado já na reserva, e nada dele é gravado.
      expect(p).toMatch(/^recusado TF003: .*R\$ 100\.00 passa do saldo livre da conta no servidor \(R\$ 50\.00 livre; R\$ 50\.00 reservado/);
      expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
      expect(reservation(order).claims_cents).toBe(5000);
      // Pagamento primeiro: a reserva preparada com o saldo antigo recebe TF008 (sincroniza e tenta de novo).
      order = withItems(100);
      [p, c] = await contend(lockOrder(order), [deviceQ(payQ(payment(order, 60), 10000)), deviceQ(claimQ(key('c'), order, 'CASH', 'CASH_DESK', 5000, 10000))]);
      expect(lastOverlap).toBe(2);
      expect(p).toBe('ok');
      expect(c).toMatch(/^recusado TF008: /);
      expect(cash(key('c'), order, 4001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
    }, 60_000);

    it('liberação e pagamento da mesma reserva ao mesmo tempo, nas duas ordens: nunca as duas coisas', async () => {
      // Liberação primeiro: o pagamento com a chave dela é recusado (TF013: a reserva liberada não cobre nada).
      let order = withItems(100);
      let k = key('rp');
      expect(cash(k, order, 6000).ok).toBe(true);
      expect(cash(key('o'), order, 4000).ok).toBe(true);
      let [r, p] = await contend(lockOrder(order), [
        deviceQ(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`), deviceQ(registerQ(payment(order, 60, { idempotency_key: k })))]);
      expect(lastOverlap).toBe(2);
      expect(r).toBe('ok');
      expect(p).toMatch(/^recusado TF013: .*foi liberada pelo gerente/);
      expect(claimField(k, 'status')).toBe('released');
      expect(reservation(order)).toMatchObject({ claims_cents: 4000, reserved_cents: 4000 });
      expect(bal(order)).toBe(10000);
      // Pagamento primeiro: a liberação encontra o pagamento (TF007) e não grava registro.
      order = withItems(100);
      k = key('pr');
      expect(cash(k, order, 6000).ok).toBe(true);
      [p, r] = await contend(lockOrder(order), [
        deviceQ(registerQ(payment(order, 60, { idempotency_key: k }))), deviceQ(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`)]);
      expect(lastOverlap).toBe(2);
      expect(p).toBe('ok');
      expect(r).toMatch(/^recusado TF007: /);
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
      expect(claimField(k, 'status')).toBe('consumed');
    }, 60_000);
  });

  describe('A5: fim verificado da cobrança da Point', () => {
    const ends = ['approved', 'rejected', 'cancelled', 'expired', 'refunded'] as const;

    it.each(ends)('revisão manual → %s: o UPDATE direto é recusado; a função grava uma vez, com UM registro; a segunda chamada não grava nada', (to) => {
      const order = withItems(100);
      const c = charge(order, 'manual_review', 3000, { raw_status_detail: 'PROVIDER_STATUS_UNCERTAIN' });
      const direct = to === 'approved'
        ? `status = 'approved', external_payment_id = '1', paid_amount_cents = 3000, card_brand = 'VISA', authorization_code = 'A'`
        : `status = '${to}'`;
      const d = psql(target!, `UPDATE terminal_charges SET ${direct} WHERE id = '${c.id}';`, DB);
      expect(d.ok).toBe(false);
      expect(d.message).toContain(`só passa de "manual_review" para "${to}" com a confirmação do Mercado Pago`);
      // Nem com a marca ligada à mão (id qualquer, ou o registro de outra cobrança).
      const other = charge(order, 'manual_review', 100);
      expect(resolve(other.id, 'manual_review', 'rejected').ok).toBe(true);
      const otherAudit = sql(`SELECT id FROM audit_logs WHERE action_type = 'POINT_CHARGE_RESOLVED' AND metadata->>'charge_id' = '${other.id}'`);
      for (const flag of [crypto.randomUUID(), otherAudit, 'on']) {
        const forged = psql(target!, `BEGIN; SELECT set_config('tchefood.point_resolution', '${flag}', true); UPDATE terminal_charges SET ${direct} WHERE id = '${c.id}'; COMMIT;`, DB);
        expect(forged.ok, flag).toBe(false);
      }
      expect(reservation(order).point_cents).toBe(3000);
      const patch = to === 'approved' ? receiptPatch(3000) : `{"raw_status":"${to}","raw_status_detail":"by_mp"}`;
      const auth = authorized(c.key);
      const evidence = `{"authorization_audit_id":"${auth}","operation_id":"op-${to}","order_status":"${to}"}`;
      const r = psql(target!, `${resolveQ(c.id, 'manual_review', to, patch, evidence)};`, DB);
      expect(r.out, r.message ?? '').toBe(to);
      const audit = sql(`SELECT performed_by_user_id || '|' || order_id || '|' || (metadata->>'from') || '|' || (metadata->>'to') || '|' || (metadata->'evidence'->>'operation_id') || '|' || reason
                         FROM audit_logs WHERE action_type = 'POINT_CHARGE_RESOLVED' AND metadata->>'charge_id' = '${c.id}'`);
      expect(audit).toBe(`${STAFF}|${order}|manual_review|${to}|op-${to}|conferido no Mercado Pago`);
      // Segunda chamada (mesmo pedido, ou outra autorização): devolve a linha como está e não grava nada.
      expect(psql(target!, `${resolveQ(c.id, 'manual_review', to, patch, evidence)};`, DB).out).toBe(to);
      expect(psql(target!, `${resolveQ(c.id, 'manual_review', 'rejected', '{}', `{"authorization_audit_id":"${crypto.randomUUID()}","operation_id":"x"}`)};`, DB).out).toBe(to);
      expect(audits('POINT_CHARGE_RESOLVED', 'charge_id', c.id)).toBe(1);
      // Aprovada continua reservando até o pagamento dela; as outras liberam.
      expect(reservation(order).point_cents).toBe(to === 'approved' ? 3000 : 0);
      if (to === 'approved') {
        expect(chargeField(c.id, `raw_status || '|' || raw_status_detail || '|' || authorization_code || '|' || external_order_id`)).toBe(`processed|accredited|AUTR1|ORD-${c.key}`);
        const mp = mpPayment(c.id);
        expect(mp.ok, mp.message ?? '').toBe(true);
        expect(reservation(order).point_cents).toBe(0);
      }
      // Estado final não muda mais por fora (nem de volta para a revisão manual).
      expect(psql(target!, `UPDATE terminal_charges SET status = 'manual_review' WHERE id = '${c.id}';`, DB).ok).toBe(false);
    });

    it('revisão manual também não volta para criando, na fila ou na maquininha (sairia dela em dois passos)', () => {
      const c = charge(withItems(100), 'manual_review');
      for (const to of ['creating', 'pending', 'at_terminal']) {
        const r = psql(target!, `UPDATE terminal_charges SET status = '${to}' WHERE id = '${c.id}';`, DB);
        expect(r.message, to).toContain('está em revisão manual e só sai dela');
      }
      // Ficar em revisão, mudando o que o Mercado Pago disse, continua podendo (a consulta grava o detalhe).
      expect(psql(target!, `UPDATE terminal_charges SET raw_status_detail = 'ORDER_ID_CHANGED' WHERE id = '${c.id}';`, DB).ok).toBe(true);
      expect(chargeField(c.id, 'status')).toBe('manual_review');
    });

    it('aprovada sem pagamento → estornada: o UPDATE direto é recusado; a função libera a reserva; com o pagamento do Mercado Pago gravado, TF007', () => {
      const order = withItems(100);
      const c = charge(order, 'approved', 2500);
      expect(psql(target!, `UPDATE terminal_charges SET status = 'refunded' WHERE id = '${c.id}';`, DB).message)
        .toContain('só passa de "approved" para "refunded" com a confirmação do Mercado Pago');
      expect(reservation(order).point_cents).toBe(2500);
      // O comprovante não muda no estorno.
      expect(resolve(c.id, 'approved', 'refunded', '{"authorization_code":"X"}')).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(resolve(c.id, 'approved', 'refunded', '{"raw_status":"refunded","raw_status_detail":"refunded"}').out).toBe('refunded');
      expect(chargeField(c.id, `status || '|' || raw_status || '|' || authorization_code`)).toBe('refunded|refunded|AUT1');
      expect(audits('POINT_CHARGE_RESOLVED', 'charge_id', c.id)).toBe(1);
      expect(reservation(order).point_cents).toBe(0);
      // O pagamento do Mercado Pago de uma cobrança estornada não entra.
      expect(mpPayment(c.id).message).toContain('não aprovada');
      // Com o pagamento já gravado: TF007 e nada muda.
      const paid = charge(order, 'approved', 1000);
      expect(mpPayment(paid.id).ok).toBe(true);
      expect(resolve(paid.id, 'approved', 'refunded')).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(chargeField(paid.id, 'status')).toBe('approved');
      expect(audits('POINT_CHARGE_RESOLVED', 'charge_id', paid.id)).toBe(0);
    });

    it('aprovada pelo ID da operação, sem ordem do Mercado Pago (external_order_id NULL): grava e o pagamento dela entra', () => {
      const order = withItems(100);
      const c = charge(order, 'manual_review', 1500, { external_order_id: null, raw_status: 'dispatch_unknown', raw_status_detail: 'DISPATCH_UNKNOWN' });
      expect(resolve(c.id, 'manual_review', 'approved', receiptPatch(1500, 'OP777')).out).toBe('approved');
      expect(chargeField(c.id, `(external_order_id IS NULL) || '|' || external_payment_id`)).toBe('true|OP777');
      expect(mpPayment(c.id).ok).toBe(true);
    });

    it('transição que não é fim verificado, campos fora da lista, motivo, operador, evidência e autorização conferidos', () => {
      const order = withItems(100);
      const mr = charge(order, 'manual_review');
      const ap = charge(order, 'approved');
      const pend = charge(order, 'pending');
      const auth = authorized(mr.key);
      const ev = `{"authorization_audit_id":"${auth}","operation_id":"op"}`;
      const call = (id: string, from: string, to: string, patch = '{}', evidence = ev, reason = 'conferido no Mercado Pago', staff = STAFF) =>
        psql(target!, `${resolveQ(id, from, to, patch, evidence, reason, staff)};`, DB);
      for (const [id, from, to] of [[pend.id, 'pending', 'rejected'], [ap.id, 'approved', 'rejected'], [mr.id, 'manual_review', 'pending'], [mr.id, 'manual_review', 'manual_review'], [ap.id, 'rejected', 'approved']]) {
        expect(call(id!, from!, to!), `${from}→${to}`).toMatchObject({ ok: false, sqlstate: 'TF007' });
      }
      for (const patch of ['{"status":"approved"}', '{"external_order_id":"ORD-X"}', '{"cancel_reason":"void"}', '{"amount_cents":1}', '[1]']) {
        expect(call(mr.id, 'manual_review', 'rejected', patch), patch).toMatchObject({ ok: false, sqlstate: 'TF006' });
      }
      expect(call(mr.id, 'manual_review', 'rejected', '{}', ev, 'curto')).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(call(mr.id, 'manual_review', 'rejected', '{}', ev, 'conferido no Mercado Pago', INACTIVE)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      for (const evidence of ['{}', '{"operation_id":"op"}', `{"authorization_audit_id":"${auth}"}`, '{"authorization_audit_id":"nao-e-uuid","operation_id":"op"}',
        `{"authorization_audit_id":"${crypto.randomUUID()}","operation_id":"op"}`]) {
        expect(call(mr.id, 'manual_review', 'rejected', '{}', evidence), evidence).toMatchObject({ ok: false, sqlstate: 'TF006' });
      }
      expect(psql(target!, `SELECT tchefood_resolve_point_charge('${TENANT}', '${mr.id}', 'manual_review', 'rejected', '{}'::jsonb, '${STAFF}', 'conferido no Mercado Pago', NULL);`, DB))
        .toMatchObject({ ok: false, sqlstate: 'TF006' });
      // Autorização de OUTRA cobrança não vale para esta.
      const other = charge(order, 'manual_review');
      expect(call(other.id, 'manual_review', 'rejected')).toMatchObject({ ok: false, sqlstate: 'TF006' });
      // Cobrança de outra loja / que não existe: TF005.
      expect(psql(target!, `${resolveQ(mr.id, 'manual_review', 'rejected', '{}', ev, 'conferido no Mercado Pago', OTHER_STAFF, OTHER)};`, DB)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(call(crypto.randomUUID(), 'manual_review', 'rejected')).toMatchObject({ ok: false, sqlstate: 'TF005' });
      // Aprovada sem comprovante completo: o gatilho recusa e o registro é desfeito junto.
      expect(call(mr.id, 'manual_review', 'approved', '{"external_payment_id":"1"}').message).toContain('comprovante completo');
      expect(audits('POINT_CHARGE_RESOLVED', 'charge_id', mr.id)).toBe(0);
      expect(chargeField(mr.id, 'status')).toBe('manual_review');
      // A autorização vale para um fim só: usada aqui, não serve para o estorno da mesma cobrança depois.
      expect(call(mr.id, 'manual_review', 'approved', receiptPatch(1000)).out).toBe('approved');
      expect(call(mr.id, 'approved', 'refunded')).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(chargeField(mr.id, 'status')).toBe('approved');
    });

    it('permissões: o aparelho e anon não chamam o fim verificado nem a conferência; a service role chama', () => {
      const c = charge(withItems(100), 'manual_review');
      const auth = authorized(c.key);
      const q = resolveQ(c.id, 'manual_review', 'rejected', '{}', `{"authorization_audit_id":"${auth}","operation_id":"op"}`);
      expect(asDevice(q)).toMatchObject({ ok: false, sqlstate: '42501' });
      expect(asRole('anon', q)).toMatchObject({ ok: false, sqlstate: '42501' });
      const rq = `SELECT tchefood_authorize_point_reconcile('${TENANT}', '${c.key}', '${STAFF}', '${MANAGER_PIN}', 'conferir no Mercado Pago')`;
      expect(asDevice(rq)).toMatchObject({ ok: false, sqlstate: '42501' });
      expect(asRole('anon', rq)).toMatchObject({ ok: false, sqlstate: '42501' });
      // O aparelho também não altera a cobrança direto (sem UPDATE em terminal_charges).
      expect(asDevice(`UPDATE terminal_charges SET status = 'rejected' WHERE id = '${c.id}'`)).toMatchObject({ ok: false, sqlstate: '42501' });
      const svc = asRole('service_role', q);
      expect(last(svc), svc.message ?? '').toBe('rejected');
      expect(audits('POINT_CHARGE_RESOLVED', 'charge_id', c.id)).toBe(1);
      for (const fn of ['tchefood_point_reserved_cents(UUID, UUID, VARCHAR)', 'tchefood_point_charges_reserved_cents(UUID, UUID, VARCHAR)',
        'tchefood_payment_claims_reserved_cents(UUID, UUID, VARCHAR)', 'tchefood_resolve_point_charge(UUID, UUID, VARCHAR, VARCHAR, JSONB, UUID, TEXT, JSONB)',
        'tchefood_authorize_point_reconcile(UUID, VARCHAR, UUID, VARCHAR, TEXT)']) {
        expect(sql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE') || '|' || has_function_privilege('anon', '${fn}', 'EXECUTE') || '|' || has_function_privilege('service_role', '${fn}', 'EXECUTE')`), fn).toBe('false|false|true');
      }
      for (const fn of ['tchefood_claim_payment(VARCHAR, UUID, VARCHAR, VARCHAR, BIGINT, BIGINT, UUID, TEXT)', 'tchefood_release_payment_claim(VARCHAR, UUID, TEXT, TEXT)',
        'tchefood_release_payment_claim_manager(VARCHAR, UUID, VARCHAR, TEXT)', 'tchefood_point_reservation(UUID)', 'tchefood_touch_payment_claim(VARCHAR, UUID, TEXT)']) {
        expect(sql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE') || '|' || has_function_privilege('anon', '${fn}', 'EXECUTE') || '|' || has_function_privilege('service_role', '${fn}', 'EXECUTE')`), fn).toBe('true|false|true');
      }
    });

    it('tchefood_authorize_point_reconcile: registra o pedido com o gerente e não muda a cobrança; TF005, TF004, TF006, TF007', () => {
      const order = withItems(100);
      const c = charge(order, 'manual_review');
      const before = chargeField(c.id, 'to_jsonb(terminal_charges.*)::text');
      const id = authorized(c.key);
      expect(chargeField(c.id, 'to_jsonb(terminal_charges.*)::text')).toBe(before);
      expect(sql(`SELECT performed_by_user_id || '|' || authorized_by_manager_id || '|' || order_id || '|' || (metadata->>'idempotency_key') || '|' || reason FROM audit_logs WHERE id = '${id}'`))
        .toBe(`${STAFF}|${MANAGER}|${order}|${c.key}|conferir no Mercado Pago`);
      expect(authorized(charge(order, 'approved').key)).toMatch(/^[0-9a-f-]{36}$/);
      expect(reconcile('nao-existe')).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(reconcile(c.key, MANAGER_PIN, OTHER, OTHER_STAFF)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(reconcile(c.key, MANAGER_PIN, TENANT, INACTIVE)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(reconcile(c.key, MANAGER_PIN, TENANT, STAFF, 'curto')).toMatchObject({ ok: false, sqlstate: 'TF006' });
      for (const status of ['pending', 'creating', 'at_terminal', 'rejected', 'cancelled', 'expired', 'refunded']) {
        expect(reconcile(charge(order, status).key), status).toMatchObject({ ok: false, sqlstate: 'TF007' });
      }
    });

    it('estorno verificado e pagamento do Mercado Pago da mesma cobrança ao mesmo tempo, nas duas ordens: nunca os dois', async () => {
      const lockCharge = (id: string) => `SELECT 1 FROM terminal_charges WHERE id = '${id}' FOR UPDATE`;
      const payQ = (id: string) => {
        const c = sql(`SELECT order_id || '|' || amount_cents || '|' || external_payment_id || '|' || authorization_code || '|' || idempotency_key FROM terminal_charges WHERE id = '${id}'`).split('|');
        return ownerQ(`INSERT INTO payments (order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, acquirer_cnpj, card_brand, nsu, authorization_code, terminal_serial, idempotency_key)
                       VALUES ('${c[0]}', '${TENANT}', '${STAFF}', '${TERMINAL}', ${Number(c[1]) / 100}, 'CREDIT', 'APPROVED', 'MERCADO_PAGO', '10573521000191', 'VISA', '${c[2]}', '${c[3]}', '${MP_ID}', '${c[4]}')`);
      };
      const refundQ = (id: string, k: string) => ownerQ(resolveQ(id, 'approved', 'refunded', '{}', `{"authorization_audit_id":"${authorized(k)}","operation_id":"op",${refundRead(id)}}`));
      // Estorno primeiro: o pagamento que esperava encontra a cobrança estornada.
      let c = charge(withItems(100), 'approved', 2000);
      let [r, p] = await contend(lockCharge(c.id), [refundQ(c.id, c.key), payQ(c.id)]);
      expect(lastOverlap).toBe(2);
      expect(r).toBe('ok');
      expect(p).toMatch(/^recusado TF007: .*não aprovada/);
      expect(chargeField(c.id, 'status')).toBe('refunded');
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${c.key}'`)).toBe('0');
      // Pagamento primeiro: o estorno que esperava encontra o pagamento (TF007) e não grava registro.
      c = charge(withItems(100), 'approved', 2000);
      [p, r] = await contend(lockCharge(c.id), [payQ(c.id), refundQ(c.id, c.key)]);
      expect(lastOverlap).toBe(2);
      expect(p).toBe('ok');
      expect(r).toMatch(/^recusado TF007: /);
      expect(chargeField(c.id, 'status')).toBe('approved');
      expect(audits('POINT_CHARGE_RESOLVED', 'charge_id', c.id)).toBe(0);
    }, 60_000);

    it('a leitura lista as cobranças que reservam, com o detalhe da revisão e se há pagamento com a chave', () => {
      const order = withItems(100);
      const mr = charge(order, 'manual_review', 1000, { raw_status_detail: 'DISPATCH_UNKNOWN', external_order_id: null });
      const ap = charge(order, 'approved', 2000);
      charge(order, 'rejected', 500);
      const paid = charge(order, 'approved', 700);
      expect(mpPayment(paid.id).ok).toBe(true);
      const ck = key('cl');
      expect(cash(ck, order, 300).ok).toBe(true);
      const r = reservation(order);
      expect(r).toMatchObject({ reserved_cents: 3300, point_cents: 3000, claims_cents: 300, open_charges: 2, manual_review: true });
      expect(r.charges).toEqual([
        { idempotency_key: mr.key, status: 'manual_review', amount_cents: 1000, raw_status_detail: 'DISPATCH_UNKNOWN', has_payment: false, created_at: expect.any(String), stale: false },
        { idempotency_key: ap.key, status: 'approved', amount_cents: 2000, raw_status_detail: null, has_payment: false, created_at: expect.any(String), stale: false },
      ]);
      expect(r.claims.map((x) => x.idempotency_key)).toEqual([ck]);
    });
  });

  describe('revisão P1-B, P2-A e P3: o banco exige a reserva na loja com Point; a reserva paga é final', () => {
    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;
    const needsClaim = /o pagamento precisa da reserva no servidor antes de receber/;
    const paymentId = (k: string) => sql(`SELECT id FROM payments WHERE idempotency_key = '${k}'`);

    /** Senha de entrega (mesa do totem, entrega própria) com saldo `balance`, andando até `upTo`. */
    function deliveryOrder(balance: number, opts: { payOnDelivery?: boolean; upTo?: 'OUT' | 'DELIVERED' } = {}): { order: string; id: string } {
      seq += 1;
      const order = `f1f1f1f1-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      const id = crypto.randomUUID();
      sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id, status, charge_service_fee, fulfillment_type)
           VALUES ('${order}', '${TENANT}', '${KIOSK_TABLE}', '${STAFF}', 'PAYING', false, 'DELIVERY');
           BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
           VALUES ('${order}', gen_random_uuid(), '${STAFF}', 1, ${balance}, ${balance}, 'NONE');
           UPDATE orders SET subtotal_items = ${balance}, total_amount = ${balance}, paid_amount = 0, remaining_balance = ${balance} WHERE id = '${order}';
           COMMIT;
           INSERT INTO own_deliveries (id, tenant_id, order_id, customer_name, customer_phone, address, zone_id, zone_name, delivery_fee, pay_on_delivery)
           VALUES ('${id}', '${TENANT}', '${order}', 'Cliente', '51999998888', 'Rua A, 100', '${ZONE}', 'Centro', 5, ${opts.payOnDelivery ?? true});
           UPDATE own_deliveries SET status = 'READY' WHERE id = '${id}';
           UPDATE own_deliveries SET status = 'OUT', courier_id = '${COURIER}', courier_fee = 4, out_at = NOW() WHERE id = '${id}';
           ${(opts.upTo ?? 'DELIVERED') === 'DELIVERED' ? `UPDATE own_deliveries SET status = 'DELIVERED', delivered_at = NOW() WHERE id = '${id}';` : ''}`);
      return { order, id };
    }

    it('aparelho com a lista de maquininhas velha (sem reserva): dinheiro na loja com Point é recusado (TF010) e nada é gravado; Stone, Pix, INSERT e UPDATE diretos também', () => {
      const order = withItems(100);
      const attempts = [
        ['dinheiro', payment(order, 10)],
        ['Stone', stonePayment(order, 10)],
        ['Pix', payment(order, 10, { method: 'PIX', acquirer: 'STONE', acquirer_cnpj: STONE_CNPJ, nsu: `PX${seq}` })],
      ] as const;
      for (const [label, j] of attempts) {
        const r = register(j);
        expect(r, label).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(r.message, label).toMatch(needsClaim);
        expect(r.message, label).toContain('Nada foi gravado');
      }
      expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
      expect(bal(order)).toBe(10000);
      // Fora do aparelho (dono do banco), igual: INSERT aprovado, e pendente que vira aprovado.
      const id = crypto.randomUUID();
      const direct = psql(target!, `INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
                                    VALUES ('${id}', '${order}', '${TENANT}', '${STAFF}', 10, 'CASH', 'APPROVED', 'CASH_DESK', '${id}');`, DB);
      expect(direct).toMatchObject({ ok: false, sqlstate: 'TF010' });
      // Auditoria r8: PENDING fora do Mercado Pago não entra (TF007). O pendente antigo (de antes da regra, montado sem os
      // gatilhos) que vira aprovado sem reserva: TF010.
      const pendingQ = `INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
           VALUES ('${id}', '${order}', '${TENANT}', '${STAFF}', 10, 'CASH', 'PENDING', 'CASH_DESK', '${id}');`;
      expect(psql(target!, pendingQ, DB)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      sql(`BEGIN; SET LOCAL session_replication_role = replica; ${pendingQ} COMMIT;`);
      expect(psql(target!, `UPDATE payments SET status = 'APPROVED' WHERE id = '${id}';`, DB)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(sql(`SELECT status FROM payments WHERE id = '${id}'`)).toBe('PENDING');
      // Com a reserva (o aparelho atualizado), o mesmo dinheiro entra.
      const ok = pay(payment(order, 10));
      expect(ok.ok, ok.message ?? '').toBe(true);
      expect(bal(order)).toBe(9000);
      // As funções novas de conferência não são do aparelho.
      for (const fn of ['tchefood_courier_cash_payment(payments)', 'tchefood_payment_claim_consume()']) {
        expect(sql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE') || '|' || has_function_privilege('anon', '${fn}', 'EXECUTE')`), fn).toBe('false|false');
      }
    });

    it('reserva com outra forma ou credenciadora não cobre o pagamento (TF010) e continua aberta; a leitura lista as reservas abertas', () => {
      const order = withItems(100);
      const ck = key('cash');
      const sk = key('stone');
      expect(cash(ck, order, 5000).ok).toBe(true);
      expect(claim(sk, order, 'CREDIT', 'STONE', 3000, undefined, STAFF_B).ok).toBe(true);
      const wrongAcquirer = register(stonePayment(order, 10, { idempotency_key: ck }));
      expect(wrongAcquirer).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(wrongAcquirer.message).toContain('o pagamento (CREDIT na STONE) não é o que foi reservado (CASH na CASH_DESK)');
      const wrongMethod = register(stonePayment(order, 10, { idempotency_key: sk, method: 'DEBIT' }));
      expect(wrongMethod).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(wrongMethod.message).toContain('(DEBIT na STONE) não é o que foi reservado (CREDIT na STONE)');
      expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
      const read = reservation(order);
      expect(read).toMatchObject({ claims_cents: 8000, reserved_cents: 8000 });
      expect(read.claims.map(({ idempotency_key, amount_cents, method, acquirer, created_by, created_by_name }) => ({ idempotency_key, amount_cents, method, acquirer, created_by, created_by_name })))
        .toEqual([
          { idempotency_key: ck, amount_cents: 5000, method: 'CASH', acquirer: 'CASH_DESK', created_by: STAFF, created_by_name: 'Caixa' },
          { idempotency_key: sk, amount_cents: 3000, method: 'CREDIT', acquirer: 'STONE', created_by: STAFF_B, created_by_name: 'Caixa 2' },
        ]);
      // A certa entra; consumida ou liberada sai da lista.
      expect(register(stonePayment(order, 30, { idempotency_key: sk })).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${ck}', '${STAFF}', ${tok(ck)}, 'cliente desistiu')`).ok).toBe(true);
      expect(reservation(order)).toMatchObject({ claims_cents: 0, claims: [] });
    });

    it('auditoria r7 P1-01: loja sem Point também exige a reserva (TF010): Stone, PagBank, dinheiro e Pix manual sem reserva são recusados; com a reserva certa entram', () => {
      expect(sql(`SELECT count(*) FROM pos_terminals WHERE tenant_id = '${LATE_TENANT}'`)).toBe('0');
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE tenant_id = '${LATE_TENANT}'`)).toBe('0');
      const order = withItems(100, LATE_TENANT, LATE_TABLE, LATE_STAFF);
      const late = { tenant_id: LATE_TENANT, waiter_id: LATE_STAFF };
      const card = (amount: number, over: Record<string, unknown>) => stonePayment(order, amount, { ...late, terminal_id: null, ...over });
      const kinds: [string, (amount: number) => string][] = [
        ['Stone', (a) => card(a, {})],
        ['PagBank', (a) => card(a, { acquirer: 'PAGBANK', acquirer_cnpj: '08561701000101', terminal_serial: 'PAG-01' })],
        ['dinheiro', (a) => payment(order, a, late)],
        ['Pix manual', (a) => card(a, { method: 'PIX', card_brand: 'PIX' })],
      ];
      for (const [label, make] of kinds) {
        // O aparelho antigo (tchefood_register_payment / fila de sincronização sem reserva): TF010, nada gravado.
        const j = make(10);
        const r = register(j, LATE_TENANT);
        expect(r, label).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(r.message, label).toMatch(/o pagamento precisa da reserva no servidor antes de receber/);
        expect(sql(`SELECT count(*) FROM payments WHERE id = '${(JSON.parse(j) as { id: string }).id}'`), label).toBe('0');
        // Com a reserva que confere (mesma conta, forma, credenciadora e até o valor), entra.
        const ok = pay(make(10), LATE_TENANT);
        expect(ok.ok, `${label}: ${ok.message ?? ''}`).toBe(true);
      }
      // INSERT direto (dono do banco), sem reserva: recusado igual.
      const id = crypto.randomUUID();
      expect(psql(target!, `INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
                            VALUES ('${id}', '${order}', '${LATE_TENANT}', '${LATE_STAFF}', 10, 'CASH', 'APPROVED', 'CASH_DESK', '${id}');`, DB))
        .toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(bal(order)).toBe(6000);
    });

    it('dinheiro do entregador (senha paga na entrega): entra sem reserva só com a entrega conferida no banco; o prefixo "entrega-" sozinho não libera nada', () => {
      const ok = deliveryOrder(100);
      const r = register(payment(ok.order, 100, { idempotency_key: `entrega-${ok.id}` }));
      expect(r.ok, r.message ?? '').toBe(true);
      expect(sql(`SELECT remaining_balance || '|' || status FROM orders WHERE id = '${ok.order}'`)).toBe('0.00|CLOSED');
      const refused: [string, string][] = [];
      // Só o prefixo, com um id que não é de entrega nenhuma.
      const plain = withItems(100);
      refused.push(['prefixo sem entrega', payment(plain, 10, { idempotency_key: `entrega-${crypto.randomUUID()}` })]);
      // Entrega de verdade, mas de OUTRA conta.
      const elsewhere = deliveryOrder(100);
      refused.push(['entrega de outra conta', payment(plain, 10, { idempotency_key: `entrega-${elsewhere.id}` })]);
      // Entrega já paga no pedido (não é paga na entrega).
      const prepaid = deliveryOrder(100, { payOnDelivery: false });
      refused.push(['entrega não paga na entrega', payment(prepaid.order, 10, { idempotency_key: `entrega-${prepaid.id}` })]);
      // Entrega que ainda não foi entregue.
      const out = deliveryOrder(100, { upTo: 'OUT' });
      refused.push(['entrega ainda na rua', payment(out.order, 10, { idempotency_key: `entrega-${out.id}` })]);
      // Cartão com a chave da entrega (o acerto do entregador é só dinheiro no caixa).
      const card = deliveryOrder(100);
      refused.push(['cartão com a chave da entrega', stonePayment(card.order, 10, { idempotency_key: `entrega-${card.id}` })]);
      for (const [label, j] of refused) {
        const x = register(j);
        expect(x, label).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(x.message, label).toMatch(needsClaim);
      }
      for (const o of [plain, elsewhere.order, prepaid.order, out.order, card.order]) {
        expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${o}'`), o).toBe('0');
      }
      // O dinheiro do entregador continua respeitando a cobrança da Point em andamento na conta.
      const busy = deliveryOrder(100);
      expect(openPoint(key('pt'), busy.order, 6000).ok).toBe(true);
      const over = register(payment(busy.order, 100, { idempotency_key: `entrega-${busy.id}` }));
      expect(over.message).toContain('R$ 60.00 reservado). Livre para este pagamento: R$ 40.00');
      expect(register(payment(busy.order, 40, { idempotency_key: `entrega-${busy.id}` })).ok).toBe(true);
    });

    it('reserva paga é final: estorno do pagamento não a reabre nem a faz reservar; liberar dá TF007; o UPDATE direto é recusado', () => {
      const order = withItems(100);
      const k = key('fin');
      expect(cash(k, order, 3000).ok).toBe(true);
      expect(register(payment(order, 30, { idempotency_key: k })).ok).toBe(true);
      const pid = paymentId(k);
      expect(claimField(k, `status || '|' || consumed_payment_id`)).toBe(`consumed|${pid}`);
      // Auditoria r8: estorno direto no banco de pagamento fora do Mercado Pago é recusado (TF007: fora do MP só
      // aprovado ou recusado); a reserva continua consumida e não reserva nada.
      expect(psql(target!, `UPDATE payments SET status = 'REFUNDED' WHERE id = '${pid}';`, DB)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(bal(order)).toBe(7000);
      expect(claimField(k, 'status')).toBe('consumed');
      expect(reservation(order)).toMatchObject({ reserved_cents: 0, claims_cents: 0, claims: [] });
      // O saldo inteiro (R$ 70,00) cabe numa reserva nova (liberada logo em seguida).
      const full = key('full');
      expect(cash(full, order, 7000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${full}', '${STAFF}', ${tok(full)}, 'só conferindo')`).ok).toBe(true);
      // Liberar a reserva consumida: TF007, sem registro (aparelho de quem pediu e gerente).
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'reserva presa do aparelho')`)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
      // Nem o dono do banco reabre ou mexe na consumida.
      const upd = (set: string) => psql(target!, `UPDATE payment_claims SET ${set} WHERE idempotency_key = '${k}';`, DB);
      for (const set of [`status = 'open', consumed_payment_id = NULL, consumed_at = NULL`, `consumed_at = NOW()`,
        `status = 'released', consumed_payment_id = NULL, consumed_at = NULL, released_at = NOW(), released_by = '${STAFF}', release_reason = 'x', release_audit_id = (SELECT id FROM audit_logs LIMIT 1)`]) {
        const x = upd(set);
        expect(x, set).toMatchObject({ ok: false, sqlstate: 'TF007' });
        expect(x.message, set).toContain('já virou pagamento e não muda mais');
      }
      // Consumir à mão, com um pagamento que não é o dela: recusado. Nascer consumida: recusado.
      const k2 = key('fin2');
      rawClaim(k2, order, 'CASH', 'CASH_DESK', 100);
      expect(psql(target!, `UPDATE payment_claims SET status = 'consumed', consumed_payment_id = '${pid}', consumed_at = NOW() WHERE idempotency_key = '${k2}';`, DB).message)
        .toContain('só é consumida pelo pagamento aprovado dela');
      const born = psql(target!, `INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by, status, consumed_payment_id, consumed_at)
                                  VALUES ('${TENANT}', '${key('born')}', '${order}', 'CASH', 'CASH_DESK', 100, '${STAFF}', 'consumed', '${pid}', NOW());`, DB);
      expect(born).toMatchObject({ ok: false, sqlstate: 'TF006' });
      // O próprio pagamento estornado volta a aprovado (correção): a reserva consumida por ele ainda o cobre, até o valor dela.
      expect(psql(target!, `UPDATE payments SET status = 'APPROVED', amount = 30.01 WHERE id = '${pid}';`, DB)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      const back = psql(target!, `UPDATE payments SET status = 'APPROVED' WHERE id = '${pid}';`, DB);
      expect(back.ok, back.message ?? '').toBe(true);
      expect(claimField(k, `status || '|' || consumed_payment_id`)).toBe(`consumed|${pid}`);
      expect(bal(order)).toBe(7000);
    });

    it('aparelho com a lista velha e aparelho com reserva na mesma conta, ao mesmo tempo, nas duas ordens: o sem reserva nunca entra', async () => {
      for (const staleFirst of [true, false]) {
        const order = withItems(100);
        const stale = deviceQ(registerQ(payment(order, 10)));
        const claimed = deviceQ(payQ(payment(order, 60), 10000));
        const out = await contend(lockOrder(order), staleFirst ? [stale, claimed] : [claimed, stale]);
        expect(lastOverlap).toBe(2);
        const [s0, s1] = staleFirst ? out : [out[1], out[0]];
        expect(s0, `lista velha ${staleFirst ? 'primeiro' : 'depois'}`).toMatch(/^recusado TF010: .*precisa da reserva no servidor/);
        expect(s1).toBe('ok');
        expect(sql(`SELECT count(*) || '|' || COALESCE(sum(amount), 0) FROM payments WHERE order_id = '${order}'`)).toBe('1|60.00');
        expect(sql(`SELECT remaining_balance || '|' || status FROM orders WHERE id = '${order}'`)).toBe('40.00|OPEN');
      }
    }, 60_000);

    it('pagamento consumindo a reserva e liberação pelo gerente ao mesmo tempo, nas duas ordens: nunca os dois', async () => {
      for (const payFirst of [true, false]) {
        const order = withItems(100);
        const k = key('race');
        expect(claim(k, order, 'CASH', 'CASH_DESK', 5000, undefined, STAFF_B).ok).toBe(true);
        idle(k); // aparelho que pediu sumido: o gerente pode liberar
        const payment50 = deviceQ(registerQ(payment(order, 50, { idempotency_key: k })));
        const release = deviceQ(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'reserva presa do aparelho')`);
        const [a, b] = await contend(lockOrder(order), payFirst ? [payment50, release] : [release, payment50]);
        expect(lastOverlap).toBe(2);
        const [p, r] = payFirst ? [a, b] : [b, a];
        if (payFirst) {
          expect(p).toBe('ok');
          expect(r).toMatch(/^recusado TF007: /);
          expect(claimField(k, 'status')).toBe('consumed');
          expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
          expect(bal(order)).toBe(5000);
        } else {
          expect(r).toBe('ok');
          expect(p).toMatch(/^recusado TF013: /);
          expect(claimField(k, 'status')).toBe('released');
          expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(1);
          expect(bal(order)).toBe(10000);
        }
      }
    }, 60_000);
  });

  describe('auditoria r6: reserva em qualquer loja da nuvem e prazo de atividade', () => {
    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;
    const touchQ = (k: string, staff = STAFF, token = tok(k)) => `SELECT tchefood_touch_payment_claim('${k}', '${staff}', ${token})`;
    const touch = (k: string, staff = STAFF, tenant = TENANT, token = tok(k)) => asDevice(touchQ(k, staff, token), tenant);
    const managerQ = (k: string) => `SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'aparelho do caixa sumiu')`;
    const activeUntil = (k: string) => Date.parse(claimField(k, `to_jsonb(active_until) #>> '{}'`));
    const dbNow = () => Date.parse(sql(`SELECT to_jsonb(clock_timestamp()) #>> '{}'`));

    it('P0-01: loja sem Point também reserva; o pagamento com a reserva a consome; sem reserva é recusado (r7, TF010); a reserva soma no saldo livre', () => {
      const order = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      const other = (amount: number, over: Record<string, unknown> = {}) => payment(order, amount, { tenant_id: OTHER, waiter_id: OTHER_STAFF, ...over });
      const k = key('np');
      const c = json(claim(k, order, 'CASH', 'CASH_DESK', 6000, undefined, OTHER_STAFF, OTHER));
      expect(c).toMatchObject({ idempotency_key: k, status: 'open', amount_cents: 6000 });
      expect(reservation(order, OTHER)).toMatchObject({ reserved_cents: 6000, claims_cents: 6000, point_cents: 0 });
      // A reserva soma: outra reserva não passa do livre.
      expect(claim(key('np'), order, 'CASH', 'CASH_DESK', 4001, undefined, OTHER_STAFF, OTHER)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      // A forma reservada vale também aqui; acima do reservado, também recusado.
      expect(register(stonePayment(order, 10, { tenant_id: OTHER, waiter_id: OTHER_STAFF, idempotency_key: k, terminal_id: null }), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(register(other(60.01, { idempotency_key: k }), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      const own = register(other(60, { idempotency_key: k }), OTHER);
      expect(own.ok, own.message ?? '').toBe(true);
      expect(claimField(k, 'status')).toBe('consumed');
      expect(reservation(order, OTHER)).toMatchObject({ reserved_cents: 0, claims_cents: 0, claims: [] });
      // Sem reserva, a loja sem Point também é recusada (auditoria r7 P1-01: TF010 em toda loja).
      expect(register(other(10), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      const paid = pay(other(10), OTHER);
      expect(paid.ok, paid.message ?? '').toBe(true);
      // Reserva liberada: o pagamento com a chave dela é recusado também na loja sem Point (segunda revisão, item 1: TF013).
      const rk = key('np');
      expect(claim(rk, order, 'CASH', 'CASH_DESK', 1000, undefined, OTHER_STAFF, OTHER).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${rk}', '${OTHER_STAFF}', ${tok(rk)}, 'desistiu')`, OTHER).ok).toBe(true);
      expect(register(other(10, { idempotency_key: rk }), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF013' });
      expect(claimField(rk, 'status')).toBe('released');
      expect(bal(order)).toBe(3000);
    });

    it('falsificação (aceite do GPT): operador B, ativo na mesma loja, manda o UUID de A sem o segredo, ou com segredo errado: recusado, reserva aberta, sem registro', () => {
      const order = withItems(100);
      const k = key('spoof');
      // A (STAFF) pede a reserva; B (STAFF_B) lê a lista da conta (chave e created_by de A estão nela).
      expect(cash(k, order, 3000).ok).toBe(true);
      const seen = reservation(order).claims.find((c) => c.idempotency_key === k)!;
      expect(seen.created_by).toBe(STAFF);
      expect(Object.keys(seen)).not.toContain('release_token_hash');
      const other = key('spoof2');
      expect(cash(other, order, 1000).ok).toBe(true);
      for (const [label, t] of [['sem segredo', 'NULL'], ['vazio', `''`], ['segredo inventado', `'${'a'.repeat(64)}'`], ['segredo de outra reserva', tok(other)],
        ['sha256 em vez do segredo', `'${claimField(k, `encode(release_token_hash, 'hex')`)}'`]] as const) {
        for (const staff of [seen.created_by, STAFF_B]) {
          const r = asDevice(`SELECT tchefood_release_payment_claim('${k}', '${staff}', ${t}, 'liberando a reserva do outro')`);
          expect(r, `${label} / ${staff}`).toMatchObject({ ok: false, sqlstate: 'TF004' });
        }
      }
      expect(claimField(k, 'status')).toBe('open');
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
      expect(reservation(order).claims_cents).toBe(4000);
      // O aparelho não lê o sha256 (nem com select *), nem pela leitura da conta.
      expect(asDevice(`SELECT release_token_hash FROM payment_claims WHERE idempotency_key = '${k}'`)).toMatchObject({ ok: false, sqlstate: '42501' });
      expect(asDevice(`SELECT * FROM payment_claims WHERE idempotency_key = '${k}'`)).toMatchObject({ ok: false, sqlstate: '42501' });
      expect(asDevice(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${k}'`).out).toContain('1');
      expect(asDevice(`SELECT tchefood_point_reservation('${order}')::text`).out).not.toContain(claimField(k, `encode(release_token_hash, 'hex')`));
      // O segredo não muda (nem pelo dono do banco).
      expect(psql(target!, `UPDATE payment_claims SET release_token_hash = sha256('x'::bytea) WHERE idempotency_key = '${k}';`, DB).message).toContain('não mudam');
      // Com o segredo certo, B (o operador que está no aparelho de A agora) libera; o registro diz como e de quem era.
      const ok = json<{ status: string; release_audit_id: string }>(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF_B}', ${tok(k)}, 'maquininha recusou')`));
      expect(ok.status).toBe('released');
      expect(sql(`SELECT performed_by_user_id || '|' || (metadata->>'released_via') || '|' || (metadata->>'claim_creator') || '|' || (metadata->>'by_manager') FROM audit_logs WHERE id = '${ok.release_audit_id}'`))
        .toBe(`${STAFF_B}|release_token|${STAFF}|false`);
      // A reserva gravada sem segredo (fora de tchefood_claim_payment) só sai pelo gerente.
      const raw = key('raw');
      rawClaim(raw, order, 'CASH', 'CASH_DESK', 100);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${raw}', '${STAFF}', NULL, 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      // A assinatura antiga (sem o segredo) não existe mais.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${raw}', '${STAFF}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: '42883' });
    });

    it('P0-02: o prazo nasce no relógio do banco (nunca o da linha) e só a renovação o muda; o dono do banco não muda à mão', () => {
      const order = withItems(100);
      const k = key('lease');
      const before = dbNow();
      expect(cash(k, order, 1000).ok).toBe(true);
      const au = activeUntil(k);
      expect(au - before).toBeGreaterThanOrEqual(89_000);
      expect(au - before).toBeLessThan(95_000);
      // Gravada direto com prazo forjado: o gatilho troca pelo do banco.
      const fk = key('forged');
      sql(`INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by, active_until)
           VALUES ('${TENANT}', '${fk}', '${order}', 'CASH', 'CASH_DESK', 100, '${STAFF}', NOW() + INTERVAL '10 days');`);
      expect(activeUntil(fk) - dbNow()).toBeLessThan(95_000);
      // UPDATE direto do prazo: recusado (para frente, para trás, e com a marca de outra reserva).
      const otherId = claimField(fk, 'id');
      for (const q of [`UPDATE payment_claims SET active_until = active_until + INTERVAL '1 hour' WHERE idempotency_key = '${k}'`,
        `UPDATE payment_claims SET active_until = NOW() - INTERVAL '1 hour' WHERE idempotency_key = '${k}'`,
        `BEGIN; SELECT set_config('tchefood.claim_touch', '${otherId}', true); UPDATE payment_claims SET active_until = active_until + INTERVAL '1 hour' WHERE idempotency_key = '${k}'; COMMIT`]) {
        const r = psql(target!, `${q};`, DB);
        expect(r.ok, q).toBe(false);
        expect(r.message, q).toContain('só é renovado pelo aparelho que a pediu');
      }
      expect(activeUntil(k)).toBe(au);
    });

    it('P0-02: tchefood_touch_payment_claim renova só com o segredo da reserva; liberada ou consumida devolve o estado sem mudar nada', () => {
      const order = withItems(100);
      const k = key('touch');
      expect(cash(k, order, 2000).ok).toBe(true);
      idle(k, '30 seconds');
      const stale = activeUntil(k);
      const r = json<{ idempotency_key: string; status: string; active_until: string }>(touch(k));
      expect(Object.keys(r).sort()).toEqual(['active_until', 'idempotency_key', 'status']);
      expect(r.idempotency_key).toBe(k);
      expect(r.status).toBe('open');
      expect(Date.parse(r.active_until)).toBe(activeUntil(k));
      expect(activeUntil(k) - dbNow()).toBeGreaterThan(85_000);
      expect(activeUntil(k)).toBeGreaterThan(stale);
      // Falsificação: B com o UUID de A (ou o próprio), sem o segredo ou com outro: TF004 e o prazo não muda.
      const other = key('touch2');
      expect(cash(other, order, 1000).ok).toBe(true);
      idle(k, '30 seconds');
      const held = activeUntil(k);
      for (const [label, t] of [['sem segredo', 'NULL'], ['segredo inventado', `'${'b'.repeat(64)}'`], ['segredo de outra reserva', tok(other)]] as const) {
        for (const staff of [STAFF, STAFF_B]) {
          const x = touch(k, staff, TENANT, t);
          expect(x, `${label} / ${staff}`).toMatchObject({ ok: false, sqlstate: 'TF004' });
          expect(x.message, label).toContain('só o aparelho que pediu a reserva renova o prazo dela');
        }
      }
      expect(activeUntil(k)).toBe(held);
      // Com o segredo, renova (qualquer operador ativo no aparelho que o tem).
      expect(json(touch(k, STAFF_B)).status).toBe('open');
      expect(activeUntil(k)).toBeGreaterThan(held);
      // Operador inativo (TF004), outra loja (TF005), chave que não existe (TF005), anon (42501), assinatura antiga (42883).
      expect(touch(k, INACTIVE)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(touch(k, OTHER_STAFF, OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(asDevice(`SELECT tchefood_touch_payment_claim('${k}', '${STAFF}')`)).toMatchObject({ ok: false, sqlstate: '42883' });
      // A reserva gravada sem segredo não é renovada pelo aparelho.
      const raw = key('touchraw');
      rawClaim(raw, order, 'CASH', 'CASH_DESK', 100);
      expect(touch(raw)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(touch('nao-existe')).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(asRole('anon', touchQ(k))).toMatchObject({ ok: false, sqlstate: '42501' });
      // Liberada: devolve o estado, sem renovar.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'cliente desistiu')`).ok).toBe(true);
      const frozen = activeUntil(k);
      expect(json(touch(k))).toEqual({ idempotency_key: k, status: 'released', active_until: claimField(k, `to_jsonb(active_until) #>> '{}'`) });
      expect(activeUntil(k)).toBe(frozen);
      // O estado só é contado a quem tem o segredo.
      expect(touch(k, STAFF, TENANT, 'NULL')).toMatchObject({ ok: false, sqlstate: 'TF004' });
      // Consumida: idem.
      const pk = key('touchpaid');
      expect(cash(pk, order, 1000).ok).toBe(true);
      expect(register(payment(order, 10, { idempotency_key: pk })).ok).toBe(true);
      const paid = activeUntil(pk);
      expect(json(touch(pk))).toMatchObject({ idempotency_key: pk, status: 'consumed' });
      expect(activeUntil(pk)).toBe(paid);
    });

    it('P0-02: o gerente não libera a reserva em andamento (TF011, sem gastar PIN, com a hora em que fica liberável); depois do prazo + 5 min libera; quem pediu libera a qualquer hora', () => {
      const order = withItems(100);
      const k = key('act');
      expect(claim(k, order, 'CASH', 'CASH_DESK', 3000, undefined, STAFF_B).ok).toBe(true);
      const failuresBefore = Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`));
      const check = (pin = MANAGER_PIN) => asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${pin}', 'aparelho do caixa sumiu')`);
      for (const [label, ago] of [['recém-pedida', null], ['prazo vencido há 4 min', '4 minutes'], ['quase liberável', '4 minutes 55 seconds']] as const) {
        if (ago) idle(k, ago);
        for (const pin of [MANAGER_PIN, '0000']) {
          const r = check(pin);
          expect(r, label).toMatchObject({ ok: false, sqlstate: 'TF011' });
          expect(r.message, label).toMatch(new RegExp(`a reserva ${k} ainda está em andamento no aparelho que a pediu; o gerente pode liberá-la a partir de \\d{2}:\\d{2}:\\d{2} \\(horário de Brasília\\)`));
        }
      }
      // A hora da mensagem é active_until + 5 min, no horário de Brasília; o DETAIL traz o instante exato.
      const expected = sql(`SELECT to_char((active_until + INTERVAL '5 minutes') AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS') FROM payment_claims WHERE idempotency_key = '${k}'`);
      expect(check().message).toContain(`a partir de ${expected}`);
      const detail = asDevice(`CREATE FUNCTION pg_temp.d() RETURNS text LANGUAGE plpgsql AS $f$ DECLARE v text; BEGIN PERFORM tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'aparelho do caixa sumiu'); RETURN 'passou'; EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS v = PG_EXCEPTION_DETAIL; RETURN SQLSTATE || '|' || v; END $f$; SELECT pg_temp.d()`);
      const [code, d] = last(detail).split('|');
      expect(code).toBe('TF011');
      expect(Date.parse(d.replace('releasable_at=', ''))).toBe(Date.parse(reservation(order).claims[0].releasable_at));
      // Nenhuma recusa gastou tentativa de PIN nem gravou registro.
      expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`))).toBe(failuresBefore);
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
      expect(claimField(k, 'status')).toBe('open');
      // Prazo + 5 min passados: o gerente libera.
      idle(k, '5 minutes 1 second');
      const released = json(check());
      expect(released).toMatchObject({ status: 'released', idempotency_key: k });
      // Quem pediu libera a qualquer hora (reserva recém-pedida, em andamento).
      const own = key('own');
      expect(cash(own, order, 1000).ok).toBe(true);
      expect(json(asDevice(`SELECT tchefood_release_payment_claim('${own}', '${STAFF}', ${tok(own)}, 'maquininha recusou')`)).status).toBe('released');
      // A renovação depois do abandono traz a reserva de volta para "em andamento".
      const back = key('back');
      expect(cash(back, order, 1000).ok).toBe(true);
      idle(back);
      expect(json(touch(back)).status).toBe('open');
      expect(asDevice(managerQ(back))).toMatchObject({ ok: false, sqlstate: 'TF011' });
    });

    it('P0-02: renovação e liberação pelo gerente ao mesmo tempo (reserva abandonada), nas duas ordens: renovada na frente = gerente recusado; gerente na frente = a renovação só fica sabendo', async () => {
      for (const touchFirst of [true, false]) {
        const order = withItems(100);
        const k = key('rt');
        expect(cash(k, order, 2000).ok).toBe(true);
        idle(k);
        const t = deviceQ(touchQ(k));
        const m = deviceQ(managerQ(k));
        const out = await contend(lockOrder(order), touchFirst ? [t, m] : [m, t]);
        expect(lastOverlap).toBe(2);
        const [tr, mr] = touchFirst ? out : [out[1], out[0]];
        expect(tr).toBe('ok');
        if (touchFirst) {
          expect(mr).toMatch(/^recusado TF011: /);
          expect(claimField(k, 'status')).toBe('open');
          expect(activeUntil(k) - dbNow()).toBeGreaterThan(80_000);
          expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
        } else {
          expect(mr).toBe('ok');
          expect(claimField(k, 'status')).toBe('released');
          expect(json(touch(k)).status).toBe('released');
          expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(1);
        }
      }
    }, 60_000);

    it('P0-02: liberação pelo gerente e pagamento da reserva em andamento ao mesmo tempo, nas duas ordens: o gerente nunca passa e o pagamento entra', async () => {
      for (const managerFirst of [true, false]) {
        const order = withItems(100);
        const k = key('rp');
        expect(cash(k, order, 4000).ok).toBe(true);
        const m = deviceQ(managerQ(k));
        const pq = deviceQ(registerQ(payment(order, 40, { idempotency_key: k })));
        const out = await contend(lockOrder(order), managerFirst ? [m, pq] : [pq, m]);
        expect(lastOverlap).toBe(2);
        const [mr, pr] = managerFirst ? out : [out[1], out[0]];
        expect(pr).toBe('ok');
        expect(mr).toMatch(managerFirst ? /^recusado TF011: / : /^recusado TF007: /);
        expect(claimField(k, 'status')).toBe('consumed');
        expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
        expect(bal(order)).toBe(6000);
      }
    }, 60_000);
  });

  describe('revisão do banco: trava do PIN antes das linhas, relógio da janela e saldo abaixo do reservado', () => {
    const pinLock = `SELECT pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || '${TENANT}'))`;
    const releaseManagerQ = (k: string) => `SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'aparelho sumiu, liberando')`;
    const cancelQ = (k: string) => `SELECT tchefood_authorize_point_cancel('${TENANT}', '${k}', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu')`;
    const reconcileAuthQ = (k: string) => `SELECT tchefood_authorize_point_reconcile('${TENANT}', '${k}', '${STAFF}', '${MANAGER_PIN}', 'conferido no app do Mercado Pago')`;

    it('F1: PIN na mão de outra sessão; liberação pelo gerente e encerramento da Point na MESMA conta: sem deadlock (40P01)', async () => {
      for (const second of ['cancel', 'reconcile'] as const) {
        const order = withItems(100);
        const ck = key('dl-claim');
        rawClaim(ck, order, 'CASH', 'CASH_DESK', 2000);
        idle(ck);
        const ch = charge(order, second === 'cancel' ? 'pending' : 'manual_review', 3000);
        // A autorização da Point entra primeiro na fila do PIN; antes da correção, a liberação já tinha a conta
        // travada e a Point, com o PIN, esperava a conta para gravar o registro: 40P01.
        const [pointOut, releaseOut] = await contend(pinLock, [ownerQ(second === 'cancel' ? cancelQ(ch.key) : reconcileAuthQ(ch.key)), deviceQ(releaseManagerQ(ck))]);
        expect(lastOverlap, second).toBe(2);
        expect(pointOut, second).toBe('ok');
        expect(releaseOut, second).toBe('ok');
        expect(claimField(ck, 'status'), second).toBe('released');
        if (second === 'cancel') expect(chargeField(ch.id, 'cancel_reason')).toBe('operator');
      }
    }, 60_000);

    it('F1: a trava do PIN vem antes da trava da conta (liberação pelo gerente espera o PIN sem travar a conta)', async () => {
      const order = withItems(100);
      const ck = key('dl-order');
      rawClaim(ck, order, 'CASH', 'CASH_DESK', 2000);
      idle(ck);
      const holder = session();
      holder.send(`BEGIN; ${pinLock}; SELECT 'held';`);
      await until('PIN travado', () => holder.output().includes('held'));
      const s1 = session();
      s1.end(deviceQ(releaseManagerQ(ck)));
      await until('liberação esperando o PIN', () => waiting() >= 1);
      // A conta não ficou travada pela liberação parada no PIN.
      expect(sql(`SELECT count(*) FROM (SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE NOWAIT) x`)).toBe('1');
      holder.end('COMMIT;');
      await holder.done;
      expect((await s1.done).split('\n').pop()).toBe('ok');
    }, 30_000);

    // Três falhas de 59,5 s atrás (pelo início da transação) e 1 s de espera: pelo relógio de agora elas já saíram
    // da janela de 60 s (NOW() ainda as contaria e bloquearia). Tudo desfeito no fim (ROLLBACK).
    const windowCheck = (call: string, device: boolean) => {
      const out = sql(`BEGIN;
        INSERT INTO audit_logs (tenant_id, performed_by_user_id, action_type, reason, metadata, created_at)
          SELECT '${TENANT}', '${STAFF}', 'MANAGER_PIN_FAILED', 'teste da janela', '{}'::jsonb, now() - INTERVAL '59.5 seconds' FROM generate_series(1, 3);
        SELECT pg_sleep(1);
        ${device ? `SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);` : ''}
        SELECT COALESCE((${call})::text, 'null');
        RESET ROLE;
        SELECT string_agg(action_type || '|' || (created_at > now() + INTERVAL '0.9 seconds')::text, ',' ORDER BY created_at)
          FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type IN ('MANAGER_PIN_FAILED', 'MANAGER_PIN_LOCKOUT') AND created_at > now() - INTERVAL '1 second';
        ROLLBACK;`).split('\n').filter((l) => l !== '' && l !== 'SET');
      return out.slice(-2);
    };

    it('F3: janela de 60 s pelo relógio de agora e falha gravada com esse horário, nas três funções com PIN', () => {
      const order = withItems(100);
      const ck = key('win');
      rawClaim(ck, order, 'CASH', 'CASH_DESK', 1000);
      idle(ck);
      const pending = charge(order, 'pending', 1000);
      const review = charge(order, 'manual_review', 1000);
      for (const [label, call, device] of [
        ['liberação pelo gerente', releaseManagerQ(ck).replace(MANAGER_PIN, '0000').replace(/^SELECT /, ''), true],
        ['encerramento da Point', cancelQ(pending.key).replace(MANAGER_PIN, '0000').replace(/^SELECT /, ''), false],
        ['conferência da Point', reconcileAuthQ(review.key).replace(MANAGER_PIN, '0000').replace(/^SELECT /, ''), false],
      ] as const) {
        // PIN errado, fora do bloqueio: devolve null e grava UMA falha com o horário de agora (não o do início).
        expect(windowCheck(call, device), label).toEqual(['null', 'MANAGER_PIN_FAILED|true']);
      }
      expect(claimField(ck, 'status')).toBe('open');
    });

    // Conta de R$ 100,00 + item de R$ 50,00 (R$ 150,00), para o cancelamento do item reduzir o total.
    const withExtraItem = () => {
      const order = withItems(100);
      const item = sql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
        VALUES ('${order}', gen_random_uuid(), '${STAFF}', 1, 50, 50, 'NONE') RETURNING id;
        UPDATE orders SET subtotal_items = 150, total_amount = 150, remaining_balance = 150 WHERE id = '${order}';
        COMMIT;`).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l))!;
      expect(bal(order)).toBe(15000);
      return { order, item };
    };
    const cancelItem = (order: string, item: string) => psql(target!, `BEGIN;
      UPDATE order_items SET status = 'CANCELED', cancel_reason = 'cliente desistiu', canceled_by_user_id = '${STAFF}', canceled_at = now() WHERE id = '${item}';
      INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata)
      VALUES ('${TENANT}', '${order}', '${STAFF}', '${MANAGER}', 'ITEM_CANCELED', 'cliente desistiu', jsonb_build_object('item_id', '${item}'));
      COMMIT;`, DB);

    it('F2 (reproduzido): item cancelado com dinheiro reservado e Point aprovada sem pagamento: TF012, nada muda', () => {
      const { order, item } = withExtraItem();
      // R$ 60,00 em dinheiro reservado + R$ 50,00 da Point aprovada (sem pagamento ainda) = R$ 110,00 reservados.
      const ck = key('f2-cash');
      expect(cash(ck, order, 6000, 15000).ok).toBe(true);
      const ch = charge(order, 'approved', 5000);
      // Cancelar o item de R$ 50,00 deixaria R$ 100,00 de saldo para R$ 110,00 já recebidos.
      const r = cancelItem(order, item);
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF012' });
      expect(r.message).toContain('há R$ 110.00 reservado em cobrança desta comanda; conclua ou libere antes de reduzir o total');
      expect(bal(order)).toBe(15000);
      expect(sql(`SELECT status FROM order_items WHERE id = '${item}'`)).toBe('PENDING');
      // Os dois pagamentos já recebidos entram (o saldo não caiu abaixo deles).
      expect(mpPayment(ch.id).ok).toBe(true);
      expect(pay(payment(order, 60, { idempotency_key: ck })).ok).toBe(true);
      expect(bal(order)).toBe(4000);
      // Sem nada reservado, a conferência do reservado não segura mais; a do pago (fuzzer, item 1) segura: R$ 100,00
      // de total para R$ 110,00 pagos é TF012 total_below_paid (antes passava e a conta fechava com R$ 10,00 a mais).
      const after = cancelItem(order, item);
      expect(after).toMatchObject({ ok: false, sqlstate: 'TF012' });
      expect(after.message).toContain('o total não pode ficar abaixo do já pago (R$ 110.00); ficaria R$ 100.00');
      expect(bal(order)).toBe(4000);
    });

    it('F2: desconto e 10% retirado também não passam do reservado; redução que cabe passa', () => {
      const order = withItems(100);
      const ck = key('f2-disc');
      expect(cash(ck, order, 8000).ok).toBe(true);
      // Desconto (recálculo pelo gatilho de flags): R$ 30,00 deixaria R$ 70,00 para R$ 80,00 reservados.
      const disc = (v: number) => psql(target!, `BEGIN; SET LOCAL session_replication_role = origin;
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata)
        VALUES ('${TENANT}', '${order}', '${STAFF}', '${MANAGER}', 'DISCOUNT_APPLIED', 'desconto teste', jsonb_build_object('discount_before', 0, 'discount_after', ${v}));
        UPDATE orders SET discount_amount = ${v} WHERE id = '${order}'; COMMIT;`, DB);
      const refused = disc(30);
      expect(refused, refused.message ?? undefined).toMatchObject({ ok: false, sqlstate: 'TF012' });
      expect(bal(order)).toBe(10000);
      const fits = disc(20);
      expect(fits, fits.message ?? undefined).toMatchObject({ ok: true });
      expect(bal(order)).toBe(8000);
      // Liberada a reserva, nada mais segura o total.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${ck}', '${STAFF}', ${tok(ck)}, 'desistiu')`).ok).toBe(true);
    });
  });

  describe('segunda revisão independente: reserva liberada, troca de reserva e soma da Point', () => {
    const OTHER_MANAGER = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';
    const OTHER_PIN = '7531';

    it('item 1 (reproduzido): loja sem Point, reserva liberada pelo gerente, pagamento com a mesma chave: TF013, nada gravado', () => {
      sql(`INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${OTHER_MANAGER}', '${OTHER}', 'Gerente da outra', 'MANAGER', '${OTHER_PIN}') ON CONFLICT (id) DO NOTHING;`);
      expect(sql(`SELECT count(*) FROM pos_terminals WHERE tenant_id = '${OTHER}' AND acquirer::text = 'MERCADO_PAGO'`)).toBe('0');
      const order = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      const k = key('i1');
      expect(claim(k, order, 'CASH', 'CASH_DESK', 4000, undefined, OTHER_STAFF, OTHER).ok).toBe(true);
      idle(k);
      const rel = json<{ status: string }>(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${OTHER_STAFF}', '${OTHER_PIN}', 'aparelho sumiu com a reserva')`, OTHER));
      expect(rel.status).toBe('released');
      for (const amount of [40, 10]) {
        const r = register(payment(order, amount, { tenant_id: OTHER, waiter_id: OTHER_STAFF, idempotency_key: k }), OTHER);
        expect(r, String(amount)).toMatchObject({ ok: false, sqlstate: 'TF013' });
        expect(r.message).toContain('a reserva deste pagamento foi liberada pelo gerente; o valor não pode entrar: confira e devolva ao cliente');
      }
      expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
      // Reserva aberta na loja sem Point: conta, forma, credenciadora e valor conferidos como na loja com Point.
      const ok = key('i1-open');
      expect(claim(ok, order, 'CASH', 'CASH_DESK', 3000, undefined, OTHER_STAFF, OTHER).ok).toBe(true);
      const other = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      expect(register(payment(other, 30, { tenant_id: OTHER, waiter_id: OTHER_STAFF, idempotency_key: ok }), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(register(payment(order, 30.01, { tenant_id: OTHER, waiter_id: OTHER_STAFF, idempotency_key: ok }), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(register(payment(order, 30, { tenant_id: OTHER, waiter_id: OTHER_STAFF, idempotency_key: ok, method: 'PIX', acquirer: 'STONE', acquirer_cnpj: STONE_CNPJ, nsu: 'PX1' }), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      const paid = register(payment(order, 30, { tenant_id: OTHER, waiter_id: OTHER_STAFF, idempotency_key: ok }), OTHER);
      expect(paid.ok, paid.message ?? '').toBe(true);
      expect(claimField(ok, 'status')).toBe('consumed');
    });

    const reclaimQ = (oldK: string, oldT: string, newK: string, newT: string, method: string, acquirer: string, cents: number, staff = STAFF) =>
      `SELECT tchefood_reclaim_payment('${oldK}', ${oldT}, '${newK}', ${newT}, '${method}', '${acquirer}', ${cents}, '${staff}')`;

    it('item 2: troca a reserva pela credenciadora da maquininha, numa transação só; o recibo entra com a nova', () => {
      const order = withItems(100);
      const oldK = key('rc-old');
      expect(stoneClaim(oldK, order, 6000).ok).toBe(true);
      expect(cash(key('rc-other'), order, 3000).ok).toBe(true); // R$ 10,00 livres além da reserva antiga
      const newK = key('rc-new');
      const newT = tokenFor(newK);
      const out = json<{ old: { status: string; release_audit_id: string }; new: { idempotency_key: string; status: string; amount_cents: number } }>(
        asDevice(reclaimQ(oldK, tok(oldK), newK, `'${newT}'`, 'CREDIT', 'PAGBANK', 6000, STAFF_B)));
      claimed.add(newK);
      expect(out.old.status).toBe('released');
      expect(out.new).toMatchObject({ idempotency_key: newK, status: 'open', amount_cents: 6000 });
      expect(claimField(newK, `order_id || '|' || method || '|' || acquirer || '|' || created_by`)).toBe(`${order}|CREDIT|PAGBANK|${STAFF_B}`);
      expect(claimField(newK, `encode(release_token_hash, 'hex') = encode(sha256(convert_to('${newT}', 'UTF8')), 'hex')`)).toBe('t');
      expect(sql(`SELECT metadata->>'released_via' || '|' || (metadata->>'new_idempotency_key') || '|' || (metadata->>'new_acquirer') FROM audit_logs WHERE id = '${out.old.release_audit_id}'`))
        .toBe(`reclaim|${newK}|PAGBANK`);
      expect(reservation(order)).toMatchObject({ claims_cents: 9000 });
      // Reenvio (resposta perdida): a mesma troca, sem nada novo.
      expect(json(asDevice(reclaimQ(oldK, tok(oldK), newK, `'${newT}'`, 'CREDIT', 'PAGBANK', 6000, STAFF_B)))).toEqual(out);
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', oldK)).toBe(1);
      // O recibo da PagBank entra com a chave nova; com a antiga, TF013.
      expect(register(stonePayment(order, 60, { idempotency_key: oldK })).sqlstate).toBe('TF013');
      const r = register(stonePayment(order, 60, { idempotency_key: newK, acquirer: 'PAGBANK', terminal_id: null, acquirer_cnpj: '08561701000101' }));
      expect(r.ok, r.message ?? '').toBe(true);
      expect(claimField(newK, 'status')).toBe('consumed');
    });

    it('item 2: segredo errado, antiga não aberta, valor acima do livre, chave nova em uso: nada muda', () => {
      const order = withItems(100);
      const oldK = key('rc-x');
      expect(cash(oldK, order, 5000).ok).toBe(true);
      const busy = key('rc-busy');
      expect(cash(busy, order, 3000).ok).toBe(true);
      const before = sql(`SELECT count(*) FROM payment_claims WHERE order_id = '${order}'`);
      const fresh = () => key('rc-n');
      const t = () => `'${newToken()}'`;
      for (const [label, q, code] of [
        ['sem segredo', reclaimQ(oldK, 'NULL', fresh(), t(), 'CREDIT', 'STONE', 5000), 'TF004'],
        ['segredo inventado', reclaimQ(oldK, `'${'d'.repeat(64)}'`, fresh(), t(), 'CREDIT', 'STONE', 5000), 'TF004'],
        ['segredo de outra reserva', reclaimQ(oldK, tok(busy), fresh(), t(), 'CREDIT', 'STONE', 5000), 'TF004'],
        ['acima do livre (R$ 70,00 livres sem a antiga)', reclaimQ(oldK, tok(oldK), fresh(), t(), 'CREDIT', 'STONE', 7001), 'TF003'],
        ['chave nova em uso', reclaimQ(oldK, tok(oldK), busy, t(), 'CREDIT', 'STONE', 5000), 'TF009'],
        ['chave nova = antiga', reclaimQ(oldK, tok(oldK), oldK, t(), 'CREDIT', 'STONE', 5000), 'TF006'],
        ['segredo novo inválido', reclaimQ(oldK, tok(oldK), fresh(), `'${'A'.repeat(64)}'`, 'CREDIT', 'STONE', 5000), 'TF006'],
        ['dinheiro na Stone', reclaimQ(oldK, tok(oldK), fresh(), t(), 'CASH', 'STONE', 5000), 'TF006'],
        ['operador de fora', reclaimQ(oldK, tok(oldK), fresh(), t(), 'CREDIT', 'STONE', 5000, INACTIVE), 'TF004'],
        ['antiga não existe', reclaimQ(key('nada'), tok(oldK), fresh(), t(), 'CREDIT', 'STONE', 5000), 'TF005'],
      ] as const) {
        expect(asDevice(q), label).toMatchObject({ ok: false, sqlstate: code });
      }
      expect(claimField(oldK, 'status')).toBe('open');
      expect(sql(`SELECT count(*) FROM payment_claims WHERE order_id = '${order}'`)).toBe(before);
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', oldK)).toBe(0);
      // Exatamente o livre passa (R$ 70,00 sem a antiga).
      const ok = fresh();
      expect(asDevice(reclaimQ(oldK, tok(oldK), ok, t(), 'CREDIT', 'STONE', 7000)).ok).toBe(true);
      // Antiga já liberada (por outra troca) ou consumida: TF007.
      expect(asDevice(reclaimQ(oldK, tok(oldK), fresh(), t(), 'CREDIT', 'STONE', 1000))).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(pay(payment(order, 30, { idempotency_key: busy })).ok).toBe(true);
      expect(asDevice(reclaimQ(busy, tok(busy), fresh(), t(), 'CREDIT', 'STONE', 1000))).toMatchObject({ ok: false, sqlstate: 'TF007' });
      // Só o aparelho (authenticated/service_role) chama.
      expect(asRole('anon', reclaimQ(oldK, tok(oldK), fresh(), t(), 'CREDIT', 'STONE', 1000))).toMatchObject({ ok: false, sqlstate: '42501' });
    });

    it('auditoria r7 P0-01: cobrança aprovada só deixa de reservar com o pagamento APROVADO do Mercado Pago ou com o estorno resolvido', () => {
      const order = withItems(100);
      const ch = charge(order, 'approved', 10000);
      // Cobrança aprovada sem pagamento: os R$ 100 continuam reservados.
      expect(reservation(order).point_cents).toBe(10000);
      // DECLINED (ou REFUNDED) do Mercado Pago com a chave da cobrança ainda aprovada: recusado, nada liberado.
      for (const status of ['DECLINED', 'REFUNDED'] as const) {
        const r = mpPayment(ch.id, status);
        expect(r.ok, status).toBe(false);
        expect(r.message, status).toContain('não confere');
        expect(reservation(order).point_cents, status).toBe(10000);
      }
      // Auditoria r8: PENDING do Mercado Pago não entra (TF007). O pendente antigo (montado sem os gatilhos) não libera.
      expect(mpPayment(ch.id, 'PENDING')).toMatchObject({ ok: false, sqlstate: 'TF007' });
      const pendingId = legacyMpPending(ch.id);
      expect(reservation(order).point_cents).toBe(10000);
      expect(Number(sql(`SELECT tchefood_point_reserved_cents('${TENANT}', '${order}', NULL)`))).toBe(10000);
      // PENDING que vira DECLINED com a cobrança aprovada: recusado também.
      expect(psql(target!, `UPDATE payments SET status = 'DECLINED' WHERE id = '${pendingId}';`, DB).message).toContain('não confere');
      sql(`DELETE FROM payments WHERE id = '${pendingId}';`);
      // Stone ou dinheiro para os mesmos R$ 100: recusado (a reserva não deixa, e sem reserva é TF010).
      expect(stoneClaim(key('r7s'), order, 10000).ok).toBe(false);
      expect(cash(key('r7c'), order, 10000).ok).toBe(false);
      expect(register(stonePayment(order, 100))).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(register(payment(order, 100))).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(reservation(order).point_cents).toBe(10000);
      // O pagamento APROVADO do Mercado Pago que confere com a cobrança consome a reserva.
      const approvedId = crypto.randomUUID();
      expect(mpPayment(ch.id, 'APPROVED', approvedId).ok).toBe(true);
      expect(reservation(order).point_cents).toBe(0);
      // E não vira estornado enquanto a cobrança no servidor está aprovada.
      expect(psql(target!, `UPDATE payments SET status = 'REFUNDED' WHERE id = '${approvedId}';`, DB).message).toContain('não confere');
      expect(reservation(order).point_cents).toBe(0);

      // Estorno confirmado pela resolução (tchefood_resolve_point_charge) libera a cobrança aprovada sem pagamento.
      const order2 = withItems(100);
      const ch2 = charge(order2, 'approved', 10000);
      expect(reservation(order2).point_cents).toBe(10000);
      expect(resolve(ch2.id, 'approved', 'refunded', '{"raw_status":"refunded","raw_status_detail":"refunded"}').out).toBe('refunded');
      expect(reservation(order2).point_cents).toBe(0);
      expect(reservation(order2).charges).toHaveLength(0);
      // Com a cobrança estornada, o REFUNDED do Mercado Pago com a chave dela entra; DECLINED não.
      expect(mpPayment(ch2.id, 'DECLINED').ok).toBe(false);
      expect(mpPayment(ch2.id, 'REFUNDED').ok).toBe(true);
      // Cobrança recusada: DECLINED entra, REFUNDED não.
      const ch3 = charge(order2, 'rejected', 1000);
      expect(mpPayment(ch3.id, 'REFUNDED').ok).toBe(false);
      expect(mpPayment(ch3.id, 'DECLINED').ok).toBe(true);
      // Os R$ 100 liberados pelo estorno voltam a poder ser recebidos por outro meio.
      expect(stoneClaim(key('r7l'), order2, 10000).ok).toBe(true);
    });
  });

  describe('revisão r8: chave do Mercado Pago sem cobrança e pagamento que troca de chave', () => {
    /** Pagamento do Mercado Pago com uma chave qualquer (sem cobrança), no status pedido. */
    const mpBare = (order: string, k: string, status: string) =>
      psql(target!, `INSERT INTO payments (order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, acquirer_cnpj, terminal_serial, idempotency_key)
                     VALUES ('${order}', '${TENANT}', '${STAFF}', '${TERMINAL}', 10, 'CREDIT', '${status}', 'MERCADO_PAGO', '10573521000191', '${MP_ID}', '${k}');`, DB);

    it('F1: pagamento do Mercado Pago sem a cobrança da chave é recusado (PENDING e DECLINED); chave com pagamento gravado não vira cobrança (TF009)', () => {
      const order = withItems(100);
      const k = key('f1');
      for (const status of ['PENDING', 'DECLINED', 'REFUNDED'] as const) {
        const r = mpBare(order, k, status);
        expect(r.ok, status).toBe(false);
        expect(r.message, status).toContain('sem a cobrança da Point no servidor');
      }
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${k}'`)).toBe('0');
      // A cobrança com a chave ainda livre nasce normalmente e o aprovado dela entra.
      expect(openPoint(k, order, 1000).ok).toBe(true);
      // Pagamento gravado antes (de antes desta regra; montado sem os gatilhos): a chave dele não vira cobrança.
      const used = key('f1u');
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO payments (order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, idempotency_key)
           VALUES ('${order}', '${TENANT}', '${STAFF}', '${TERMINAL}', 10, 'CREDIT', 'DECLINED', 'MERCADO_PAGO', '${used}'); COMMIT;`);
      const again = openPoint(used, order, 1000);
      expect(again).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(again.message).toContain('já é de um pagamento gravado');
      const direct = psql(target!, `INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status)
                                    VALUES ('${TENANT}', '${used}', '${order}', '${TERMINAL}', 'mercado_pago_point', '${MP_ID}', 'CREDIT', 1000, 'creating');`, DB);
      expect(direct).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${used}'`)).toBe('0');
    });

    it('F1: has_payment da leitura só conta o APROVADO do Mercado Pago (o PENDING não esconde a conferência)', () => {
      const order = withItems(100);
      const ch = charge(order, 'manual_review', 2000);
      legacyMpPending(ch.id);
      const read = reservation(order);
      expect(read.point_cents).toBe(2000);
      expect(read.charges.find((c) => c.idempotency_key === ch.key)).toMatchObject({ status: 'manual_review', has_payment: false });
    });

    it('F2: pagamento aprovado que consumiu a reserva dele não muda de chave, de conta nem de loja (TF007); a outra reserva aberta continua', () => {
      const order = withItems(100);
      const a = key('f2a');
      expect(pay(payment(order, 30, { idempotency_key: a })).ok).toBe(true);
      expect(claimField(a, 'status')).toBe('consumed');
      const b = key('f2b');
      expect(cash(b, order, 3000).ok).toBe(true);
      const id = sql(`SELECT id FROM payments WHERE idempotency_key = '${a}'`);
      for (const set of [`idempotency_key = '${b}'`, `order_id = '${withItems(100)}'`, `tenant_id = '${OTHER}'`]) {
        const r = psql(target!, `UPDATE payments SET ${set} WHERE id = '${id}';`, DB);
        expect(r, set).toMatchObject({ ok: false, sqlstate: 'TF007' });
        expect(r.message, set).toContain('o pagamento gravado não muda de chave, de conta nem de loja');
      }
      expect(sql(`SELECT idempotency_key || '|' || order_id FROM payments WHERE id = '${id}'`)).toBe(`${a}|${order}`);
      expect(claimField(b, 'status')).toBe('open');
      expect(reservation(order)).toMatchObject({ claims_cents: 3000 });
      // Outro campo do pagamento continua podendo mudar.
      expect(psql(target!, `UPDATE payments SET tip_amount = 2 WHERE id = '${id}';`, DB).ok).toBe(true);
      expect(sql(`SELECT has_function_privilege('authenticated', 'tchefood_payment_identity_guard()', 'EXECUTE')`)).toBe('f');
    });
  });

  describe('auditoria r8 P1-01: a chave da cobrança da Point é conferida em todo status do pagamento', () => {
    const declined = (order: string, k: string, status = 'DECLINED', over: Record<string, unknown> = {}) =>
      stonePayment(order, 100, { idempotency_key: k, status, nsu: null, authorization_code: null, ...over });
    const approve = (k: string) =>
      sql(`UPDATE terminal_charges SET status = 'approved', external_order_id = 'ORD-${k}', external_payment_id = 'P-${k}', paid_amount_cents = amount_cents,
                  card_brand = 'VISA', authorization_code = 'AUT1' WHERE idempotency_key = '${k}';`);
    const keyLock = (k: string) => `SELECT pg_advisory_xact_lock(hashtextextended('tchefood_payment_key:${k}', 0))`;
    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;

    it('Point aberta de R$ 100 (chave point-abc): Stone DECLINED, PENDING e REFUNDED com a chave são recusados sem gravar; o aprovado do Mercado Pago dela entra', () => {
      const order = withItems(100);
      const k = key('point-abc');
      expect(openPoint(k, order, 10000).ok).toBe(true);
      for (const status of ['DECLINED', 'PENDING', 'REFUNDED'] as const) {
        const r = register(declined(order, k, status));
        expect(r, status).toMatchObject({ ok: false, sqlstate: 'TF009' });
        expect(r.message, status).toContain(`a chave ${k} é de uma cobrança da Point`);
        expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${k}'`), status).toBe('0');
      }
      // Dinheiro recusado com a chave também (qualquer forma fora do Mercado Pago).
      expect(register(payment(order, 100, { idempotency_key: k, status: 'DECLINED' }))).toMatchObject({ ok: false, sqlstate: 'TF009' });
      // A cobrança é aprovada e o pagamento do Mercado Pago com o comprovante certo entra e consome a reserva.
      approve(k);
      const id = sql(`SELECT id FROM terminal_charges WHERE idempotency_key = '${k}'`);
      const mp = mpPayment(id);
      expect(mp.ok, mp.message ?? '').toBe(true);
      expect(sql(`SELECT status || '|' || acquirer FROM payments WHERE idempotency_key = '${k}'`)).toBe('APPROVED|MERCADO_PAGO');
      expect(sql(`SELECT remaining_balance || '|' || status FROM orders WHERE id = '${order}'`)).toBe('0.00|CLOSED');
    });

    it('fora do Mercado Pago só aprovado ou recusado; o recusado com a chave de uma reserva só entra com ela liberada e da mesma conta', () => {
      const order = withItems(100);
      // PENDING e REFUNDED sem chave de ninguém: recusados (TF007). DECLINED sem reserva nem cobrança: entra (não move dinheiro).
      expect(register(declined(order, key('np'), 'PENDING'))).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(register(declined(order, key('nr'), 'REFUNDED'))).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(register(declined(order, key('nd'))).ok).toBe(true);
      // Reserva Stone aberta: o recusado dela (auditoria interna 3 P1-01) e o de outra conta são TF010. Auditoria
      // interna F1: liberada, forma e credenciadora podem ser outras (testes próprios abaixo).
      const k = key('dk');
      expect(stoneClaim(k, order, 5000).ok).toBe(true);
      const other = withItems(100);
      expect(register(declined(order, k)), 'aberta').toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(register(declined(other, k)), 'outra conta').toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${k}'`)).toBe('0');
      // A recusa libera a reserva; o registro do recusado sobe depois (reserva já liberada): entra.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'maquininha recusou')`).ok).toBe(true);
      const r = register(declined(order, k));
      expect(r.ok, r.message ?? '').toBe(true);
      expect(claimField(k, 'status')).toBe('released');
      expect(bal(order)).toBe(10000);
    });

    for (const [label, sameOrder] of [['mesma conta (trava da conta)', true], ['contas diferentes (trava da chave)', false]] as const) {
      it(`abertura da Point e recusado de Stone com a mesma chave ao mesmo tempo, nas duas ordens, ${label}: a chave nunca fica ocupada errado`, async () => {
        for (const pointFirst of [true, false]) {
          const order = withItems(100);
          const payOrder = sameOrder ? order : withItems(100);
          const k = key('race');
          const pointQ = ownerQ(openPointQ(k, order, 10000, 10000));
          const payQ2 = deviceQ(registerQ(declined(payOrder, k)));
          const [first, second] = await contend(sameOrder ? lockOrder(order) : keyLock(k), pointFirst ? [pointQ, payQ2] : [payQ2, pointQ]);
          expect(lastOverlap, `${label} ${pointFirst}`).toBe(2);
          const [point, paid] = pointFirst ? [first, second] : [second, first];
          const charges = sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${k}'`);
          const payments = sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${k}'`);
          if (pointFirst) {
            // A cobrança nasceu primeiro: o recusado com a chave dela é recusado e a chave fica só com ela.
            expect(point).toBe('ok');
            expect(paid).toMatch(/^recusado TF009: .*é de uma cobrança da Point/);
            expect(`${charges}|${payments}`).toBe('1|0');
          } else {
            // O recusado (sem cobrança nem reserva) entrou primeiro: a cobrança com a chave dele é recusada.
            expect(paid).toBe('ok');
            expect(point).toMatch(/^recusado TF009: .*já é de um pagamento gravado/);
            expect(`${charges}|${payments}`).toBe('0|1');
          }
        }
      }, 60_000);
    }
  });

  describe('tchefood_authorize_claim_refunded: estorno da reserva liberada com PIN de gerente', () => {
    const refundQ = (k: string, pin = MANAGER_PIN, reason = 'estornei na maquininha Stone', meta = `'{"refund_kind":"card","payment_local_id":"pay-local-1"}'::jsonb`, staff = STAFF) =>
      `SELECT COALESCE(tchefood_authorize_claim_refunded('${k}', '${staff}', '${pin}', '${reason}', ${meta})::text, 'null')`;
    const released = (order: string) => {
      const k = key('crr');
      expect(cash(k, order, 2000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`).ok).toBe(true);
      return k;
    };
    /** Roda como o aparelho numa transação desfeita no fim (falhas de PIN não sujam a loja para os outros testes). */
    const inRollback = (pre: string, q: string, post: string) =>
      sql(`BEGIN; ${pre}
           SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
           ${q}; RESET ROLE; ${post}; ROLLBACK;`).split('\n').filter((l) => l !== '' && l !== 'SET').slice(-2);

    it('PIN certo: grava CLAIM_RELEASED_REFUNDED com o gerente e os dados da reserva; a segunda chamada devolve o mesmo id', () => {
      const order = withItems(100);
      const k = released(order);
      const id = last(asDevice(refundQ(k)));
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(sql(`SELECT order_id || '|' || performed_by_user_id || '|' || authorized_by_manager_id || '|' || reason || '|' || amount_impact FROM audit_logs WHERE id = '${id}'`))
        .toBe(`${order}|${STAFF}|${MANAGER}|estornei na maquininha Stone|0.00`);
      const meta = JSON.parse(sql(`SELECT metadata::text FROM audit_logs WHERE id = '${id}'`)) as Record<string, unknown>;
      expect(meta).toMatchObject({ idempotency_key: k, amount_cents: 2000, method: 'CASH', acquirer: 'CASH_DESK', refund_kind: 'card', payment_local_id: 'pay-local-1',
        claim_id: claimField(k, 'id'), release_audit_id: claimField(k, 'release_audit_id'), manager_name: 'Gerente', server_verified: true });
      expect(last(asDevice(refundQ(k, MANAGER_PIN, 'outro motivo qualquer', `'{"refund_kind":"cash"}'::jsonb`)))).toBe(id);
      expect(audits('CLAIM_RELEASED_REFUNDED', 'idempotency_key', k)).toBe(1);
      // payment_local_id é opcional.
      const k2 = released(order);
      expect(last(asDevice(refundQ(k2, MANAGER_PIN, 'devolvi o dinheiro ao cliente', `'{"refund_kind":"cash"}'::jsonb`)))).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('reserva não liberada (aberta ou paga), de outra loja ou inexistente; motivo curto, metadata fora da lista, operador de fora: recusado antes do PIN', () => {
      const order = withItems(100);
      const open = key('crr-open');
      expect(cash(open, order, 1000).ok).toBe(true);
      const paid = key('crr-paid');
      expect(pay(payment(order, 10, { idempotency_key: paid })).ok).toBe(true);
      const k = released(order);
      const failuresBefore = Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`));
      for (const [label, q, code] of [
        ['aberta', refundQ(open), 'TF007'],
        ['paga', refundQ(paid), 'TF007'],
        ['inexistente', refundQ(key('nada')), 'TF005'],
        ['motivo curto', refundQ(k, MANAGER_PIN, 'estornei'), 'TF006'],
        ['sem refund_kind', refundQ(k, MANAGER_PIN, undefined, `'{}'::jsonb`), 'TF006'],
        ['metadata nula', refundQ(k, MANAGER_PIN, undefined, 'NULL'), 'TF006'],
        ['refund_kind inválido', refundQ(k, MANAGER_PIN, undefined, `'{"refund_kind":"pix"}'::jsonb`), 'TF006'],
        ['chave fora da lista', refundQ(k, MANAGER_PIN, undefined, `'{"refund_kind":"card","server_verified":true}'::jsonb`), 'TF006'],
        ['payment_local_id número', refundQ(k, MANAGER_PIN, undefined, `'{"refund_kind":"card","payment_local_id":5}'::jsonb`), 'TF006'],
        ['metadata não objeto', refundQ(k, MANAGER_PIN, undefined, `'[1]'::jsonb`), 'TF006'],
        ['operador inativo', refundQ(k, MANAGER_PIN, undefined, undefined, INACTIVE), 'TF004'],
      ] as const) {
        expect(asDevice(q), label).toMatchObject({ ok: false, sqlstate: code });
      }
      // Auditoria interna P3-7: aberta e paga têm o mesmo código (TF007) e DETAIL diferente.
      for (const [label, q, detail] of [['aberta', refundQ(open), 'claim_open'], ['paga', refundQ(paid), 'claim_consumed']] as const) {
        expect(detailOf(q), label).toBe(`TF007|${detail}`);
      }
      // Reserva de outra loja: não encontrada.
      expect(asDevice(refundQ(k, MANAGER_PIN, undefined, undefined, OTHER_STAFF), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'`))).toBe(failuresBefore);
      expect(audits('CLAIM_RELEASED_REFUNDED', 'idempotency_key', k)).toBe(0);
    });

    it('PIN errado: NULL e uma falha gravada com o horário de agora; com 3 falhas em 60 s, bloqueado mesmo com o PIN certo', () => {
      const order = withItems(100);
      const k = released(order);
      const count = `SELECT string_agg(action_type, ',' ORDER BY created_at) FROM audit_logs WHERE tenant_id = '${TENANT}' AND metadata->>'idempotency_key' = '${k}' AND action_type <> 'PAYMENT_CLAIM_RELEASED'`;
      expect(inRollback('', refundQ(k, '0000'), count)).toEqual(['null', 'MANAGER_PIN_FAILED']);
      const three = `INSERT INTO audit_logs (tenant_id, performed_by_user_id, action_type, reason, metadata)
                     SELECT '${TENANT}', '${STAFF}', 'MANAGER_PIN_FAILED', 'teste do bloqueio', '{}'::jsonb FROM generate_series(1, 3);`;
      expect(inRollback(three, refundQ(k), count)).toEqual(['null', 'MANAGER_PIN_LOCKOUT']);
      expect(audits('CLAIM_RELEASED_REFUNDED', 'idempotency_key', k)).toBe(0);
    });

    it('o aparelho não grava CLAIM_RELEASED_REFUNDED direto (com ou sem gerente); anon não chama a função', () => {
      const order = withItems(100);
      const k = released(order);
      for (const manager of ['NULL', `'${MANAGER}'`]) {
        const r = asDevice(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata)
                            VALUES ('${TENANT}', '${order}', '${STAFF}', ${manager}, 'CLAIM_RELEASED_REFUNDED', 'forjado pelo aparelho', jsonb_build_object('idempotency_key', '${k}'))`);
        expect(r.ok, manager).toBe(false);
      }
      expect(audits('CLAIM_RELEASED_REFUNDED', 'idempotency_key', k)).toBe(0);
      expect(asRole('anon', refundQ(k))).toMatchObject({ ok: false, sqlstate: '42501' });
      expect(sql(`SELECT has_function_privilege('authenticated', 'tchefood_authorize_claim_refunded(VARCHAR, UUID, VARCHAR, TEXT, JSONB)', 'EXECUTE')`)).toBe('t');
    });
  });

  it('as migrations de pagamento (e a de contas, que embrulha register_payment e o estorno) rodam de novo sem erro, nessa ordem', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.includes('mercado_pago') || x.includes('point_reserva') || x.includes('contas_aparelhos')).sort()) {
      expect(() => psqlFile(target!, join(dir, f), DB), f).not.toThrow();
    }
    const order = withItems(100);
    expect(cash(key('mig'), order, 1000).ok).toBe(true);
    expect(reservation(order).claims_cents).toBe(1000);
  });
  describe('auditoria interna P3-6: operador desativado depois de pedir a reserva', () => {
    let pinSeq = 600000;
    /** Operador novo da loja, ativo, para desativar no meio do teste. */
    const newStaff = () => {
      const id = crypto.randomUUID();
      sql(`INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${id}', '${TENANT}', 'Sai no meio', 'CASHIER', '${pinSeq++}')`);
      return id;
    };
    const deactivate = (id: string) => sql(`UPDATE staff_users SET active = false WHERE id = '${id}'`);
    const reclaimQ = (oldK: string, oldT: string, newK: string, newT: string, method: string, acquirer: string, cents: number, staff = STAFF) =>
      `SELECT tchefood_reclaim_payment('${oldK}', ${oldT}, '${newK}', ${newT}, '${method}', '${acquirer}', ${cents}, '${staff}')`;

    it('reserva: o reenvio exato (mesmos termos e segredo) devolve a reserva; qualquer outra coisa continua TF004', () => {
      const order = withItems(100);
      const who = newStaff();
      const k = key('p36');
      const first = json(claim(k, order, 'CASH', 'CASH_DESK', 2000, 10000, who));
      deactivate(who);
      // A resposta se perdeu e o operador saiu: o aparelho reenvia e recebe a mesma reserva (não larga o segredo).
      expect(json(asDevice(claimQ(k, order, 'CASH', 'CASH_DESK', 2000, 10000, who)))).toEqual(first);
      // O saldo mostrado não entra na conferência do reenvio (como antes).
      expect(json(asDevice(claimQ(k, order, 'CASH', 'CASH_DESK', 2000, 8000, who)))).toEqual(first);
      // Outro segredo, outro valor, outra forma ou outra conta: TF004 primeiro, como antes.
      const otherOrder = withItems(100);
      for (const [label, q] of [
        ['outro segredo', claimQ(k, order, 'CASH', 'CASH_DESK', 2000, 10000, who, `'${newToken()}'`)],
        ['outro valor', claimQ(k, order, 'CASH', 'CASH_DESK', 2001, 10000, who)],
        ['outra forma', claimQ(k, order, 'CREDIT', 'STONE', 2000, 10000, who)],
        ['outra conta', claimQ(k, otherOrder, 'CASH', 'CASH_DESK', 2000, 10000, who)],
        ['chave nova', claimQ(key('p36-n'), order, 'CASH', 'CASH_DESK', 2000, 10000, who)],
      ] as const) {
        expect(asDevice(q), label).toMatchObject({ ok: false, sqlstate: 'TF004' });
      }
      // O segredo certo vindo de outra loja não acha a reserva desta (reenvio só na mesma loja): chave em uso.
      expect(asDevice(claimQ(k, order, 'CASH', 'CASH_DESK', 2000, 10000, OTHER_STAFF), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(sql(`SELECT count(*) FROM payment_claims WHERE order_id IN ('${order}', '${otherOrder}')`)).toBe('1');
      // Já liberada: o reenvio exato devolve "released" (o aparelho não cobra com ela).
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`).ok).toBe(true);
      expect(json(asDevice(claimQ(k, order, 'CASH', 'CASH_DESK', 2000, 10000, who)))).toMatchObject({ id: first.id, status: 'released' });
    });

    it('troca: o reenvio exato devolve a mesma troca; a troca nova com o operador desativado é TF004', () => {
      const order = withItems(100);
      const who = newStaff();
      const oldK = key('p36-old');
      expect(claim(oldK, order, 'CREDIT', 'STONE', 6000, 10000, who).ok).toBe(true);
      const newK = key('p36-new');
      const newT = `'${tokenFor(newK)}'`;
      const out = json(asDevice(reclaimQ(oldK, tok(oldK), newK, newT, 'CREDIT', 'PAGBANK', 6000, who)));
      claimed.add(newK);
      deactivate(who);
      expect(json(asDevice(reclaimQ(oldK, tok(oldK), newK, newT, 'CREDIT', 'PAGBANK', 6000, who)))).toEqual(out);
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', oldK)).toBe(1);
      for (const [label, q] of [
        ['segredo antigo errado', reclaimQ(oldK, `'${'0'.repeat(64)}'`, newK, newT, 'CREDIT', 'PAGBANK', 6000, who)],
        ['segredo novo errado', reclaimQ(oldK, tok(oldK), newK, `'${newToken()}'`, 'CREDIT', 'PAGBANK', 6000, who)],
        ['outro valor', reclaimQ(oldK, tok(oldK), newK, newT, 'CREDIT', 'PAGBANK', 5000, who)],
      ] as const) {
        expect(asDevice(q), label).toMatchObject({ ok: false, sqlstate: 'TF004' });
      }
      // Troca nova (reserva aberta) com o operador desativado: TF004 e nada muda.
      const openK = key('p36-open');
      const who2 = newStaff();
      expect(claim(openK, order, 'CREDIT', 'STONE', 1000, 10000, who2).ok).toBe(true);
      deactivate(who2);
      expect(asDevice(reclaimQ(openK, tok(openK), key('p36-x'), `'${newToken()}'`, 'CREDIT', 'PAGBANK', 1000, who2))).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(claimField(openK, 'status')).toBe('open');
    });

    it('liberação: com o segredo certo o operador desativado libera (registro com operator_inactive); sem ele, TF004; renovar continua TF004', () => {
      const order = withItems(100);
      const who = newStaff();
      const k = key('p36-rel');
      expect(claim(k, order, 'CASH', 'CASH_DESK', 3000, 10000, who).ok).toBe(true);
      deactivate(who);
      // Renovar o prazo pede operador ativo (decisão: a reserva expira e o gerente a libera).
      expect(asDevice(`SELECT tchefood_touch_payment_claim('${k}', '${who}', ${tok(k)})`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      // Sem o segredo, segredo errado ou chave que não existe: TF004 (não diz se a reserva existe).
      for (const [label, kk, t] of [['sem segredo', k, 'NULL'], ['segredo errado', k, `'${'0'.repeat(64)}'`], ['não existe', key('nada'), tok(k)]] as const) {
        const r = asDevice(`SELECT tchefood_release_payment_claim('${kk}', '${who}', ${t}, 'desistiu')`);
        expect(r, label).toMatchObject({ ok: false, sqlstate: 'TF004' });
        expect(r.message, label).toContain('operador não é da equipe ativa');
      }
      // Operador de outra loja ou que não existe: TF004 antes de tudo, como antes.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${OTHER_STAFF}', ${tok(k)}, 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${crypto.randomUUID()}', ${tok(k)}, 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(claimField(k, 'status')).toBe('open');
      const out = json<{ status: string; release_audit_id: string }>(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${who}', ${tok(k)}, 'maquininha recusou')`));
      expect(out.status).toBe('released');
      expect(claimField(k, 'released_by')).toBe(who);
      expect(sql(`SELECT performed_by_user_id || '|' || (metadata->>'operator_inactive') || '|' || (metadata->>'released_via') FROM audit_logs WHERE id = '${out.release_audit_id}'`))
        .toBe(`${who}|true|release_token`);
      // Operador ativo: o registro não leva a marca.
      const k2 = key('p36-rel2');
      expect(cash(k2, order, 1000).ok).toBe(true);
      const out2 = json<{ release_audit_id: string }>(asDevice(`SELECT tchefood_release_payment_claim('${k2}', '${STAFF}', ${tok(k2)}, 'desistiu')`));
      expect(sql(`SELECT metadata ? 'operator_inactive' FROM audit_logs WHERE id = '${out2.release_audit_id}'`)).toBe('f');
    });
  });
  describe('auditoria interna F1-F4: recusado com a chave da reserva, chave de outra loja e ordem das travas do fim verificado', () => {
    const declinedJ = (order: string, k: string, over: Record<string, unknown> = {}) =>
      stonePayment(order, 50, { idempotency_key: k, status: 'DECLINED', nsu: null, authorization_code: null, ...over });
    const PAGBANK = { acquirer: 'PAGBANK', acquirer_cnpj: '08561701000101', terminal_id: null };

    it('F1: reserva Stone liberada e o recusado vem pela PagBank: entra (repro do revisor); aberta: TF010 (auditoria interna 3 P1-01)', () => {
      const order = withItems(100);
      const k = key('f1');
      expect(stoneClaim(k, order, 5000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'maquininha recusou')`).ok).toBe(true);
      const r = register(declinedJ(order, k, PAGBANK));
      expect(r.ok, r.message ?? '').toBe(true);
      expect(sql(`SELECT status || '|' || acquirer FROM payments WHERE idempotency_key = '${k}'`)).toBe('DECLINED|PAGBANK');
      expect(claimField(k, 'status')).toBe('released');
      // Aberta: o recusado (com a mesma ou outra forma) é TF010 e não ocupa a chave da reserva.
      const k2 = key('f1-open');
      expect(stoneClaim(k2, order, 3000).ok).toBe(true);
      expect(register(declinedJ(order, k2, { method: 'DEBIT' }))).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(register(declinedJ(order, k2))).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(claimField(k2, 'status')).toBe('open');
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${k2}'`)).toBe('0');
      expect(bal(order)).toBe(10000);
      // Outra conta da mesma loja continua TF010.
      const k3 = key('f1-other');
      expect(stoneClaim(k3, order, 1000).ok).toBe(true);
      expect(register(declinedJ(withItems(100), k3, PAGBANK))).toMatchObject({ ok: false, sqlstate: 'TF010' });
    });

    it('F2: chave repetida entre lojas (de antes da conferência em todo o banco): vale a reserva desta loja', () => {
      const order = withItems(100);
      const otherOrder = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      const k = key('f2');
      // A de outra loja nasce primeiro (id menor por created_at), sem os gatilhos, como uma linha antiga.
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
           VALUES ('${OTHER}', '${k}', '${otherOrder}', 'CASH', 'CASH_DESK', 1000, '${OTHER_STAFF}');
           INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
           VALUES ('${TENANT}', '${k}', '${order}', 'CREDIT', 'STONE', 2000, '${STAFF}'); COMMIT;`);
      // A reserva desta loja (aberta) é a que vale: TF010 "ainda aberta" (com a da outra loja seria TF009 key_in_use).
      const r = register(declinedJ(order, k));
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(r.message).toContain('ainda aberta');
      // Com a reserva desta loja em outra conta: TF010 (não confunde com a da outra loja).
      const k2 = key('f2-b');
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
           VALUES ('${OTHER}', '${k2}', '${otherOrder}', 'CASH', 'CASH_DESK', 1000, '${OTHER_STAFF}'),
                  ('${TENANT}', '${k2}', '${withItems(100)}', 'CREDIT', 'STONE', 2000, '${STAFF}'); COMMIT;`);
      expect(register(declinedJ(order, k2))).toMatchObject({ ok: false, sqlstate: 'TF010' });
    });

    it('F3: pagamento fora do Mercado Pago (aprovado, recusado, PENDING, REFUNDED) de outra loja com a chave de reserva, cobrança ou pagamento desta: a mesma recusa TF009', () => {
      const order = withItems(100);
      const claimK = key('f3-claim');
      expect(stoneClaim(claimK, order, 1000).ok).toBe(true);
      const chargeK = charge(order, 'pending', 1000).key;
      const payK = key('f3-pay');
      expect(register(declinedJ(order, payK)).ok).toBe(true);
      const otherOrder = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      // Aprovado em dinheiro (sem NSU); os outros status, recusa de cartão Stone.
      const otherJ = (k: string, status: string) => payment(otherOrder, 10, { tenant_id: OTHER, waiter_id: OTHER_STAFF, idempotency_key: k, status,
        ...(status === 'APPROVED' ? {} : { method: 'CREDIT', acquirer: 'STONE', nsu: null, authorization_code: null }) });
      const fromOther = (k: string, status = 'DECLINED') => register(otherJ(k, status), OTHER);
      const seen = new Set<string>();
      for (const k of [claimK, chargeK, payK]) {
        for (const status of ['APPROVED', 'DECLINED', 'PENDING', 'REFUNDED']) {
          const r = fromOther(k, status);
          expect(r, `${k} ${status}`).toMatchObject({ ok: false, sqlstate: 'TF009' });
          expect(detailOf(registerQ(otherJ(k, status)), OTHER), `${k} ${status}`).toBe('TF009|key_in_use');
          seen.add(r.message!.replace(k, '<k>'));
        }
      }
      // Uma mensagem só, sem dizer se a chave é reserva, cobrança ou pagamento.
      expect([...seen]).toEqual(['TCHEFOOD_PAGAMENTO: a chave <k> já está em uso (outra reserva, cobrança ou pagamento).']);
      expect(sql(`SELECT count(*) FROM payments WHERE tenant_id = '${OTHER}' AND idempotency_key IN ('${claimK}', '${chargeK}', '${payK}')`)).toBe('0');
      // Controle: chave livre, o recusado da outra loja entra.
      expect(fromOther(key('f3-free')).ok).toBe(true);
      expect(sql(`SELECT remaining_balance FROM orders WHERE id = '${otherOrder}'`)).toBe('100.00');
    });

    for (const fn of ['resolve', 'reconcile', 'cancel'] as const) {
      it(`F4: ${fn === 'resolve' ? 'tchefood_resolve_point_charge (estorno da aprovada)' : fn === 'reconcile' ? 'tchefood_authorize_point_reconcile' : 'tchefood_authorize_point_cancel (cobrança pendente)'} e o pagamento do Mercado Pago da mesma cobrança juntos, nas duas ordens: sem deadlock`, async () => {
        for (const [fnFirst, via] of [[true, 'register'], [false, 'register'], [true, 'insert'], [false, 'insert']] as const) {
          const order = withItems(100);
          const ch = charge(order, fn === 'cancel' ? 'pending' : 'approved', 3000);
          const fnQ = fn === 'cancel'
            ? `SELECT tchefood_authorize_point_cancel('${TENANT}', '${ch.key}', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu')`
            : fn === 'resolve'
            ? resolveQ(ch.id, 'approved', 'refunded', '{"raw_status":"refunded"}', `{"authorization_audit_id":"${authorized(ch.key)}","operation_id":"op-f4",${refundRead(ch.id)}}`, 'estorno conferido no Mercado Pago')
            : `SELECT tchefood_authorize_point_reconcile('${TENANT}', '${ch.key}', '${STAFF}', '${MANAGER_PIN}', 'conferir no app do Mercado Pago')`;
          // O caminho do aparelho (tchefood_register_payment trava a conta) e o INSERT direto (os gatilhos travam a conta).
          const c = sql(`SELECT COALESCE(external_payment_id, 'NSU-F4') || '|' || COALESCE(authorization_code, 'AUT1') FROM terminal_charges WHERE id = '${ch.id}'`).split('|');
          const payQ2 = via === 'insert' ? ownerQ(mpPaymentQ(ch.id)) : deviceQ(registerQ(payment(order, 30, {
            method: 'CREDIT', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191', card_brand: 'VISA', nsu: c[0], authorization_code: c[1],
            terminal_id: TERMINAL, terminal_serial: MP_ID, idempotency_key: ch.key })));
          // A conta travada por uma terceira sessão: os dois esperam por ela (antes da correção, a função já tinha a
          // cobrança e esperava a conta no registro, e o pagamento, com a conta, esperava a cobrança: 40P01).
          const [first, second] = await contend(`SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`,
            fnFirst ? [ownerQ(fnQ), payQ2] : [payQ2, ownerQ(fnQ)]);
          expect(lastOverlap, `${fn} ${fnFirst} ${via}`).toBe(2);
          const [fnOut, payOut] = fnFirst ? [first, second] : [second, first];
          expect(`${fnOut} ${payOut}`, `${fn} ${fnFirst} ${via}`).not.toContain('40P01');
          if (fn === 'cancel') {
            // A cobrança pendente não aceita o pagamento aprovado (TF007) em nenhuma ordem; o encerramento é autorizado.
            expect(fnOut, `${fn} ${fnFirst} ${via}`).toBe('ok');
            expect(payOut, `${fn} ${fnFirst} ${via}`).toMatch(/^recusado TF007: /);
            expect(chargeField(ch.id, 'cancel_reason')).toBe('operator');
          } else if (fn === 'reconcile') {
            expect(fnOut, `${fn} ${fnFirst}`).toBe('ok');
            expect(payOut, `${fn} ${fnFirst}`).toBe('ok');
          } else if (fnFirst) {
            // O estorno grava primeiro; o pagamento encontra a cobrança estornada.
            expect(fnOut).toBe('ok');
            expect(payOut).toMatch(/^recusado TF007: /);
            expect(chargeField(ch.id, 'status')).toBe('refunded');
          } else {
            // O pagamento entra primeiro; o estorno é recusado (já virou pagamento).
            expect(payOut).toBe('ok');
            expect(fnOut).toMatch(/^recusado TF007: .*já virou pagamento/);
            expect(chargeField(ch.id, 'status')).toBe('approved');
          }
        }
      }, 60_000);
    }
  });
  describe('auditoria interna 3', () => {
    const declinedJ = (order: string, k: string, over: Record<string, unknown> = {}) =>
      stonePayment(order, 10, { idempotency_key: k, status: 'DECLINED', nsu: null, authorization_code: null, waiter_id: STAFF_B, ...over });

    it('P1-01: o recusado de outro aparelho com a chave de uma reserva aberta é TF010; o aprovado dela entra e consome; depois, TF010 também', () => {
      const order = withItems(100);
      const k = key('KCLAIM1');
      expect(cash(k, order, 1000).ok).toBe(true);
      // Outro aparelho (outro operador) sobe um recusado Stone com a chave: recusado, a chave não fica ocupada.
      const d = register(declinedJ(order, k));
      expect(d).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(d.message).toContain('ainda aberta');
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${k}'`)).toBe('0');
      // O aprovado em dinheiro da reserva entra e a consome (antes da correção: 23505).
      const a = register(payment(order, 10, { idempotency_key: k }));
      expect(a.ok, a.message ?? '').toBe(true);
      expect(claimField(k, 'status')).toBe('consumed');
      expect(bal(order)).toBe(9000);
      // Consumida: o recusado com a chave é TF010 (a chave é do pagamento dela).
      const c = register(declinedJ(order, k, { id: crypto.randomUUID() }));
      expect(c).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(c.message).toContain('já paga');
      // Liberada: o recusado entra, com qualquer forma e credenciadora, na mesma conta.
      const k2 = key('KCLAIM2');
      expect(cash(k2, order, 1000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k2}', '${STAFF}', ${tok(k2)}, 'maquininha recusou')`).ok).toBe(true);
      const r = register(declinedJ(order, k2, { acquirer: 'PAGBANK', acquirer_cnpj: '08561701000101', terminal_id: null }));
      expect(r.ok, r.message ?? '').toBe(true);
      expect(claimField(k2, 'status')).toBe('released');
    });

    it('P1-02: as cobranças da reserva trazem created_at e stale pelo relógio do banco (prazo de point-charge, 120 s)', () => {
      expect(sql(`SELECT tchefood_point_charge_timeout() = INTERVAL '120 seconds'`)).toBe('t');
      // O mesmo prazo da Edge Function.
      const src = readFileSync(join(ROOT, 'supabase', 'functions', 'point-charge', 'charge.ts'), 'utf8');
      expect(/export const SERVER_TIMEOUT_MS = 120_000;/.test(src)).toBe(true);
      const order = withItems(100);
      const fresh = charge(order, 'pending', 1000);
      const old = charge(order, 'at_terminal', 1000);
      const edge = charge(order, 'pending', 1000);
      const age = (id: string, ago: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE terminal_charges SET created_at = clock_timestamp() - INTERVAL '${ago}' WHERE id = '${id}'; COMMIT;`);
      age(old.id, '121 seconds');
      age(edge.id, '119 seconds');
      const byKey = new Map(reservation(order).charges.map((c) => [c.idempotency_key, c]));
      expect(byKey.get(fresh.key)).toMatchObject({ stale: false });
      expect(byKey.get(edge.key)).toMatchObject({ stale: false });
      expect(byKey.get(old.key)).toMatchObject({ stale: true });
      expect(sql(`SELECT to_jsonb(created_at) #>> '{}' FROM terminal_charges WHERE id = '${old.id}'`)).toBe(byKey.get(old.key)!.created_at);
    });

    it('auditoria 2: aprovada sem pagamento só fica stale tchefood_claim_abandon_after() depois da aprovação (updated_at), não da criação', () => {
      expect(sql(`SELECT tchefood_claim_abandon_after() = INTERVAL '5 minutes'`)).toBe('t');
      const order = withItems(100);
      const recent = charge(order, 'approved', 1000);
      const edge = charge(order, 'approved', 1000);
      const old = charge(order, 'approved', 1000);
      const open = charge(order, 'pending', 1000);
      const at = (id: string, created: string, updated: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE terminal_charges SET created_at = clock_timestamp() - INTERVAL '${created}', updated_at = clock_timestamp() - INTERVAL '${updated}' WHERE id = '${id}'; COMMIT;`);
      // Criada há 10 min e aprovada há 3 min (o aparelho que cobrou pode estar sem rede com o pagamento na fila): não é stale.
      at(recent.id, '10 minutes', '3 minutes');
      at(edge.id, '10 minutes', '299 seconds');
      at(old.id, '10 minutes', '301 seconds');
      // A aberta segue pela criação (prazo do cartão), qualquer que seja updated_at.
      at(open.id, '121 seconds', '1 second');
      const byKey = new Map(reservation(order).charges.map((c) => [c.idempotency_key, c]));
      expect(byKey.get(recent.key)).toMatchObject({ status: 'approved', stale: false });
      expect(byKey.get(edge.key)).toMatchObject({ status: 'approved', stale: false });
      expect(byKey.get(old.key)).toMatchObject({ status: 'approved', stale: true });
      expect(byKey.get(open.key)).toMatchObject({ status: 'pending', stale: true });
      // tchefood_point_charge_in_wait não muda para a aprovada (estado final: FALSE).
      expect(sql(`SELECT tchefood_point_charge_in_wait('${TENANT}', '${recent.id}')`)).toBe('f');
    });
  });

  describe('fuzzer de concorrência: total abaixo do pago, chave repetida e prazo de espera do cartão', () => {
    const declinedJ = (order: string, k: string, over: Record<string, unknown> = {}) =>
      stonePayment(order, 10, { idempotency_key: k, status: 'DECLINED', nsu: null, authorization_code: null, ...over });
    /** Desconto autorizado (registro do gerente + UPDATE na mesma transação), como o aparelho faz. */
    const disc = (order: string, v: number) => psql(target!, `BEGIN;
      INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata)
      VALUES ('${TENANT}', '${order}', '${STAFF}', '${MANAGER}', 'DISCOUNT_APPLIED', 'desconto teste', jsonb_build_object('discount_before', 0, 'discount_after', ${v}));
      UPDATE orders SET discount_amount = ${v} WHERE id = '${order}'; COMMIT;`, DB);
    /** "sqlstate|DETAIL" de um comando rodado como dono do banco. */
    const ownerDetail = (stmt: string) => last(psql(target!, `DO $d$ DECLARE c TEXT := 'ok'; d TEXT := ''; BEGIN
        BEGIN ${stmt}; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS c = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL; END;
        PERFORM set_config('tchefood.test_err', c || '|' || d, false); END $d$; SELECT current_setting('tchefood.test_err');`, DB));
    const total = (order: string) => sql(`SELECT round(total_amount * 100)::bigint || '|' || round(paid_amount * 100)::bigint || '|' || status FROM orders WHERE id = '${order}'`);

    it('item 1: desconto que deixa o total abaixo do pago (e do reservado) é TF012 total_below_paid; o que cabe passa', () => {
      const order = withItems(100);
      expect(pay(payment(order, 40)).ok).toBe(true);
      // R$ 70,00 de desconto: total R$ 30,00 para R$ 40,00 pagos.
      const r = disc(order, 70);
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF012' });
      expect(r.message).toContain('o total não pode ficar abaixo do já pago (R$ 40.00); ficaria R$ 30.00');
      expect(total(order)).toBe('10000|4000|OPEN');
      expect(ownerDetail(`UPDATE orders SET discount_amount = 70 WHERE id = '${order}'`)).toBe('TF012|total_below_paid paid_cents=4000 total_cents=3000');
      // Com R$ 30,00 reservados em dinheiro: a conferência do reservado recusa antes (a mensagem de sempre).
      const k = key('fz-disc');
      expect(cash(k, order, 3000).ok).toBe(true);
      const r2 = disc(order, 40);
      expect(r2).toMatchObject({ ok: false, sqlstate: 'TF012' });
      expect(r2.message).toContain('há R$ 30.00 reservado em cobrança desta comanda');
      // O que cabe (total R$ 70,00 = pago + reservado) passa.
      const fits = disc(order, 30);
      expect(fits, fits.message ?? undefined).toMatchObject({ ok: true });
      expect(total(order)).toBe('7000|4000|OPEN');
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, 'desistiu')`).ok).toBe(true);
    });

    it('item 1: item cancelado depois de pagamento parcial é TF012 (nada muda); estornado o pagamento, o cancelamento passa', () => {
      const order = withItems(100);
      const item = sql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
        VALUES ('${order}', gen_random_uuid(), '${STAFF}', 1, 50, 50, 'NONE') RETURNING id;
        UPDATE orders SET subtotal_items = 150, total_amount = 150, remaining_balance = 150 WHERE id = '${order}';
        COMMIT;`).split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l))!;
      const cancelItem = () => psql(target!, `BEGIN;
        UPDATE order_items SET status = 'CANCELED', cancel_reason = 'cliente desistiu', canceled_by_user_id = '${STAFF}', canceled_at = now() WHERE id = '${item}';
        INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata)
        VALUES ('${TENANT}', '${order}', '${STAFF}', '${MANAGER}', 'ITEM_CANCELED', 'cliente desistiu', jsonb_build_object('item_id', '${item}'));
        COMMIT;`, DB);
      // R$ 60,00 em dinheiro + R$ 60,00 da Point = R$ 120,00 pagos; cancelar o item de R$ 50,00 deixaria R$ 100,00.
      expect(pay(payment(order, 60)).ok).toBe(true);
      const ch = charge(order, 'approved', 6000);
      const mpId = crypto.randomUUID();
      expect(mpPayment(ch.id, 'APPROVED', mpId).ok).toBe(true);
      const r = cancelItem();
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF012' });
      expect(r.message).toContain('já pago (R$ 120.00)');
      expect(sql(`SELECT status FROM order_items WHERE id = '${item}'`)).toBe('PENDING');
      expect(total(order)).toBe('15000|12000|OPEN');
      // Estorno gravado (a cobrança estornada no servidor, o pagamento do Mercado Pago vira REFUNDED): sai do pago.
      const refunded = refundPoint(ch.id);
      expect(refunded.ok, refunded.message ?? '').toBe(true);
      expect(sql(`SELECT status FROM payments WHERE id = '${mpId}'`)).toBe('REFUNDED');
      expect(total(order)).toBe('15000|6000|OPEN');
      const ok = cancelItem();
      expect(ok, ok.message ?? undefined).toMatchObject({ ok: true });
      expect(total(order)).toBe('10000|6000|OPEN');
      expect(bal(order)).toBe(4000);
    });

    it('item 3: recusado repetido com a mesma chave na mesma loja, e duas linhas do Mercado Pago para a mesma cobrança: TF009 key_in_use (não 23505)', () => {
      const order = withItems(100);
      const k = key('fz-dup');
      expect(register(declinedJ(order, k)).ok).toBe(true);
      expect(detailOf(registerQ(declinedJ(order, k)))).toBe('TF009|key_in_use');
      expect(detailOf(registerQ(payment(order, 10, { idempotency_key: k })))).toBe('TF009|key_in_use');
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${k}'`)).toBe('1');
      for (const [status, row] of [['rejected', 'DECLINED'], ['approved', 'APPROVED']] as const) {
        const ch = charge(order, status, 1000);
        expect(mpPayment(ch.id, row).ok, status).toBe(true);
        expect(ownerDetail(mpPaymentQ(ch.id, row)), status).toBe('TF009|key_in_use');
        expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${ch.key}'`), status).toBe('1');
      }
    });

    it('tchefood_point_charge_in_wait: no prazo, passado o prazo, estado final, outra loja (TF005), só a service role; stale é o contrário dele', () => {
      const inWait = (id: string, tenant = TENANT) => psql(target!, `BEGIN; SET LOCAL ROLE service_role; SELECT tchefood_point_charge_in_wait('${tenant}', '${id}'); COMMIT;`, DB);
      const val = (id: string) => last(inWait(id)).replace(/\nCOMMIT$/, '');
      const age = (id: string, ago: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE terminal_charges SET created_at = clock_timestamp() - INTERVAL '${ago}' WHERE id = '${id}'; COMMIT;`);
      const order = withItems(100);
      const fresh = charge(order, 'pending', 1000);
      const edge = charge(order, 'at_terminal', 1000);
      const old = charge(order, 'at_terminal', 1000);
      const cancelling = charge(order, 'at_terminal', 1000);
      age(edge.id, '119 seconds');
      age(old.id, '121 seconds');
      // Encerramento pedido não muda o prazo.
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           UPDATE terminal_charges SET cancel_requested_at = clock_timestamp(), cancel_reason = 'operator' WHERE id = '${cancelling.id}'; COMMIT;`);
      expect(val(fresh.id)).toBe('t');
      expect(val(edge.id)).toBe('t');
      expect(val(old.id)).toBe('f');
      expect(val(cancelling.id)).toBe('t');
      // stale de tchefood_point_reservation é exatamente o contrário, para cada cobrança aberta.
      const charges = reservation(order).charges;
      expect(charges).toHaveLength(4);
      for (const c of charges) {
        const id = sql(`SELECT id FROM terminal_charges WHERE idempotency_key = '${c.idempotency_key}'`);
        expect(c.stale, c.idempotency_key).toBe(val(id) === 'f');
      }
      // Estado final (mesmo criada agora): false.
      for (const status of ['approved', 'rejected', 'cancelled', 'expired', 'refunded']) {
        expect(val(charge(withItems(100), status, 1000).id), status).toBe('f');
      }
      // Outra loja ou inexistente: TF005.
      expect(inWait(fresh.id, OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(inWait(crypto.randomUUID())).toMatchObject({ ok: false, sqlstate: 'TF005' });
      // Só a service role.
      for (const role of ['authenticated', 'anon']) {
        expect(asRole(role, `SELECT tchefood_point_charge_in_wait('${TENANT}', '${fresh.id}')`), role).toMatchObject({ ok: false, sqlstate: '42501' });
      }
      expect(asDevice(`SELECT tchefood_point_charge_in_wait('${TENANT}', '${fresh.id}')`)).toMatchObject({ ok: false, sqlstate: '42501' });
      expect(sql(`SELECT p.provolatile::text || '|' || p.prosecdef FROM pg_proc p WHERE p.proname = 'tchefood_point_charge_in_wait'`)).toBe('s|true');
    });
  });

  describe('GPT r32: o estorno verificado desmarca só os itens do pagamento estornado (payment_items), e mais nada desmarca item pago', () => {
    /** Conta de R$ 100 com dois itens de R$ 50 (gravada direto, sem os gatilhos), ainda sem pagamento. */
    function twoItems(): { order: string; i1: string; i2: string } {
      const order = crypto.randomUUID();
      const i1 = crypto.randomUUID();
      const i2 = crypto.randomUUID();
      sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${order}', '${TENANT}', test_fresh_table('${TENANT}'), '${STAFF}');
           BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO order_items (id, order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
           VALUES ('${i1}', '${order}', gen_random_uuid(), '${STAFF}', 1, 50, 50, 'NONE'), ('${i2}', '${order}', gen_random_uuid(), '${STAFF}', 1, 50, 50, 'NONE');
           UPDATE orders SET charge_service_fee = false, subtotal_items = 100, total_amount = 100, paid_amount = 0, remaining_balance = 100 WHERE id = '${order}';
           COMMIT;`);
      return { order, i1, i2 };
    }
    /** Cobrança aprovada da Point com o pagamento registrado; `items` são os itens que ele quitou (vínculo gravado na criação). */
    function paidBy(order: string, cents: number, items: string[]): { ch: { id: string; key: string }; payment: string } {
      const ch = charge(order, 'approved', cents);
      const r = mpPayment(ch.id);
      expect(r.ok, r.message ?? '').toBe(true);
      const payment = sql(`SELECT id FROM payments WHERE idempotency_key = '${ch.key}'`);
      for (const it of items) sql(`UPDATE order_items SET is_paid = TRUE WHERE id = '${it}'; INSERT INTO payment_items (payment_id, item_id) VALUES ('${payment}', '${it}');`);
      return { ch, payment };
    }
    const paidFlags = (...ids: string[]) => ids.map((id) => sql(`SELECT is_paid FROM order_items WHERE id = '${id}'`)).join(',');
    const orderStatus = (order: string) => sql(`SELECT status FROM orders WHERE id = '${order}'`);
    const deviceUnpay = (id: string) => {
      const r = psql(target!, deviceQ(`UPDATE order_items SET is_paid = FALSE WHERE id = '${id}'`), DB);
      expect(r.ok, r.message ?? '').toBe(true);
    };

    it('dois itens, dois pagamentos: estornar A desmarca só o item 1 (o 2 continua pago), a conta reabre e atualização velha de aparelho não muda nada', () => {
      const { order, i1, i2 } = twoItems();
      const a = paidBy(order, 5000, [i1]);
      const b = paidBy(order, 5000, [i2]);
      expect(orderStatus(order)).toBe('CLOSED');
      expect(paidFlags(i1, i2)).toBe('t,t');
      // Antes do estorno nenhum aparelho desmarca.
      deviceUnpay(i1);
      deviceUnpay(i2);
      expect(paidFlags(i1, i2)).toBe('t,t');
      const r = refundPoint(a.ch.id);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(orderStatus(order)).toBe('PAYING');
      expect(paidFlags(i1, i2)).toBe('f,t');
      // O PATCH que o aparelho sobe depois do estorno (is_paid=false nos dois) é absorvido.
      deviceUnpay(i1);
      deviceUnpay(i2);
      expect(paidFlags(i1, i2)).toBe('f,t');
      expect(sql(`SELECT status FROM payments WHERE id = '${b.payment}'`)).toBe('APPROVED');
    });

    it('P0-02: item pago de novo por recebimento sem vínculo depois do estorno: atualização velha não o desmarca, e repetir o estorno não desmarca de novo', () => {
      const { order, i1, i2 } = twoItems();
      const a = paidBy(order, 5000, [i1]);
      paidBy(order, 5000, [i2]);
      const auth = authorized(a.ch.key);
      expect(refundPoint(a.ch.id, {}, auth).ok).toBe(true);
      expect(paidFlags(i1)).toBe('f');
      // O caixa recebe o item de novo em dinheiro (pagamento aprovado sem lista) e a conta fecha: o item volta a pago.
      sql(`UPDATE order_items SET is_paid = TRUE WHERE id = '${i1}'`);
      deviceUnpay(i1);
      expect(paidFlags(i1)).toBe('t');
      // Repetição do mesmo estorno (cobrança já estornada) não grava nada nem desmarca.
      for (const again of [refundPoint(a.ch.id, {}, auth), refundPoint(a.ch.id, {}, crypto.randomUUID())]) {
        expect(again.ok, again.message ?? '').toBe(true);
      }
      expect(paidFlags(i1, i2)).toBe('t,t');
    });

    it('pagamento sem vínculo (antigo, dinheiro sem lista, acerto de entregador): o estorno não desmarca nada', () => {
      const { order, i1, i2 } = twoItems();
      const a = paidBy(order, 10000, []);
      sql(`UPDATE order_items SET is_paid = TRUE WHERE order_id = '${order}'`);
      expect(refundPoint(a.ch.id).ok).toBe(true);
      expect(paidFlags(i1, i2)).toBe('t,t');
      deviceUnpay(i1);
      expect(paidFlags(i1, i2)).toBe('t,t');
    });

    it('item coberto por dois pagamentos (um estornado, outro aprovado): continua pago', () => {
      const { order, i1, i2 } = twoItems();
      const a = paidBy(order, 5000, [i1]);
      const b = paidBy(order, 5000, [i2]);
      sql(`INSERT INTO payment_items (payment_id, item_id) VALUES ('${b.payment}', '${i1}')`);
      expect(refundPoint(a.ch.id).ok).toBe(true);
      expect(paidFlags(i1, i2)).toBe('t,t');
    });

    it('o estorno recusado (prova do Mercado Pago não confere) não desmarca item algum', () => {
      const { order, i1, i2 } = twoItems();
      const a = paidBy(order, 5000, [i1]);
      paidBy(order, 5000, [i2]);
      const bad = refundPoint(a.ch.id, { mp_status: 'approved' });
      expect(bad.ok).toBe(false);
      expect(paidFlags(i1, i2)).toBe('t,t');
      expect(sql(`SELECT status FROM payments WHERE id = '${a.payment}'`)).toBe('APPROVED');
    });

    it('o miolo do estorno (_core) e a função de desmarcar não são chamáveis por aparelho nem pela service role direta', () => {
      for (const q of [
        `SELECT 1 FROM tchefood_refund_point_payment_core('${TENANT}', gen_random_uuid(), '${STAFF}', 'motivo de teste ok', '{}'::jsonb, '{}'::jsonb)`,
        `SELECT tchefood_unpay_payment_items(gen_random_uuid())`,
      ]) {
        const asDevice = psql(target!, deviceQ(q), DB);
        expect(asDevice.out, q).toMatch(/recusado 42501/);
        const asService = psql(target!, `${tryFn} BEGIN; SET LOCAL ROLE service_role; SELECT pg_temp.t($q$${q}$q$); COMMIT;`, DB);
        expect(asService.out, q).toMatch(/recusado 42501/);
      }
    });
  });

  describe('GPT r9 P1-01: estorno do pagamento da Point já registrado (tchefood_refund_point_payment)', () => {
    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;
    const state = (ch: { id: string; key: string }) => sql(`SELECT c.status || '|' || COALESCE((SELECT string_agg(p.status::text, ',') FROM payments p WHERE p.idempotency_key = c.idempotency_key), '-')
      FROM terminal_charges c WHERE c.id = '${ch.id}'`);
    const orderState = (order: string) => sql(`SELECT round(paid_amount * 100)::bigint || '|' || round(remaining_balance * 100)::bigint || '|' || status FROM orders WHERE id = '${order}'`);
    const refunds = (ch: { id: string }) => Number(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND metadata->>'charge_id' = '${ch.id}'`));
    /** Cobrança aprovada com o pagamento do Mercado Pago registrado. */
    const paidCharge = (order: string, cents: number) => {
      const ch = charge(order, 'approved', cents);
      const r = mpPayment(ch.id);
      expect(r.ok, r.message ?? '').toBe(true);
      return ch;
    };

    it('aprovada com pagamento registrado: o estorno autorizado estorna os dois, recalcula a conta; repetir devolve o mesmo e não grava de novo', () => {
      const order = withItems(100);
      const ch = paidCharge(order, 6000);
      expect(orderState(order)).toBe('6000|4000|OPEN');
      // Antes da correção: o fim verificado recusa (já virou pagamento) e o pagamento não vira estornado sozinho.
      expect(resolve(ch.id, 'approved', 'refunded', '{"raw_status":"refunded"}')).toMatchObject({ ok: false, sqlstate: 'TF007' });
      const auth = authorized(ch.key);
      const r = refundPoint(ch.id, {}, auth);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(state(ch)).toBe('refunded|REFUNDED');
      expect(chargeField(ch.id, `raw_status || '|' || raw_status_detail || '|' || external_payment_id`)).toBe(`refunded|refunded|${chargeField(ch.id, 'external_payment_id')}`);
      expect(orderState(order)).toBe('0|10000|OPEN');
      expect(refunds(ch)).toBe(1);
      const meta = JSON.parse(sql(`SELECT metadata::text FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND metadata->>'charge_id' = '${ch.id}'`)) as Record<string, unknown>;
      expect(meta).toMatchObject({ idempotency_key: ch.key, payment_id: sql(`SELECT id FROM payments WHERE idempotency_key = '${ch.key}'`), amount_cents: 6000,
        from: 'approved', to: 'refunded', server_verified: true, evidence: { authorization_audit_id: auth, mp_status: 'refunded' } });
      // A cobrança estornada não reserva e o saldo volta a poder ser recebido.
      expect(reservation(order)).toMatchObject({ reserved_cents: 0, charges: [] });
      // Repetição (mesma autorização ou qualquer outra: a cobrança já estornada não grava nada): devolve "refunded" e não grava nada.
      for (const again of [refundPoint(ch.id, {}, auth), refundPoint(ch.id, {}, crypto.randomUUID())]) {
        expect(again.ok, again.message ?? '').toBe(true);
        expect(again.out).toContain('refunded');
      }
      expect(refunds(ch)).toBe(1);
      expect(state(ch)).toBe('refunded|REFUNDED');
      expect(orderState(order)).toBe('0|10000|OPEN');
    });

    it('conta já fechada pelo pagamento: reabre (PAYING) com o saldo devolvido e o registro do estorno (GPT r10 P1-01)', () => {
      const order = withItems(60);
      const ch = paidCharge(order, 6000);
      expect(orderState(order)).toBe('6000|0|CLOSED');
      const r = refundPoint(ch.id);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(state(ch)).toBe('refunded|REFUNDED');
      expect(orderState(order)).toBe('0|6000|PAYING');
      expect(refunds(ch)).toBe(1);
    });

    it('sem prova, sem autorização ou com prova que não confere: recusado, nada muda', () => {
      const order = withItems(100);
      // A cobrança saiu da revisão manual pelo fim verificado (autorização A) e o pagamento dela foi registrado.
      const ch = charge(order, 'manual_review', 3000);
      const usedAuth = authorized(ch.key);
      const ok = resolve(ch.id, 'manual_review', 'approved', receiptPatch(3000), `{"authorization_audit_id":"${usedAuth}","operation_id":"op-1"}`);
      expect(ok.ok, ok.message ?? '').toBe(true);
      expect(mpPayment(ch.id).ok).toBe(true);
      const other = paidCharge(order, 1000);
      const auth = () => authorized(ch.key);
      const run = (over: Record<string, unknown>, a = auth(), patch?: string, staff = STAFF, tenant = TENANT) =>
        psql(target!, `BEGIN; SET LOCAL ROLE service_role; ${refundQ(ch.id, refundEvidence(ch.id, a, over), patch, staff, tenant)}; COMMIT;`, DB);
      for (const [label, r, code] of [
        ['autorização inexistente', run({}, crypto.randomUUID()), 'TF006'],
        ['autorização de outra cobrança', run({}, authorized(other.key)), 'TF006'],
        ['autorização já usada pelo fim verificado', run({}, usedAuth), 'TF007'],
        ['chargeback', run({ mp_status: 'charged_back' }), 'TF006'],
        ['status aprovado', run({ mp_status: 'approved' }), 'TF006'],
        ['outro pagamento', run({ mp_payment_id: 'P-OUTRO' }), 'TF006'],
        ['outro valor', run({ mp_amount_cents: 2999 }), 'TF006'],
        ['outra referência', run({ mp_external_reference: 'outra-chave' }), 'TF006'],
        ['sem o status', run({ mp_status: undefined }), 'TF006'],
        ['valor em texto', run({ mp_amount_cents: '3000' }), 'TF006'],
        ['patch com comprovante', run({}, auth(), '{"external_payment_id":"X"}'), 'TF006'],
        ['operador inativo', run({}, auth(), undefined, INACTIVE), 'TF004'],
        ['outra loja', run({}, auth(), undefined, OTHER_STAFF, OTHER), 'TF005'],
      ] as const) {
        expect(r, label).toMatchObject({ ok: false, sqlstate: code });
      }
      expect(state(ch)).toBe('approved|APPROVED');
      expect(orderState(order)).toBe('4000|6000|OPEN');
      expect(refunds(ch)).toBe(0);
      // Autorização gasta pelo estorno de outra cobrança não serve ao fim verificado desta (é de outra chave: TF006).
      const spent = authorized(other.key);
      expect(refundPoint(other.id, {}, spent).ok).toBe(true);
      const order2 = withItems(100);
      const review = charge(order2, 'manual_review', 1000);
      expect(resolve(review.id, 'manual_review', 'rejected', '{}', `{"authorization_audit_id":"${spent}","operation_id":null}`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      // Sem pagamento registrado: é o fim verificado que estorna (TF007); cobrança recusada: TF007.
      const bare = charge(order2, 'approved', 1000);
      expect(refundPoint(bare.id)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      const rejected = charge(order2, 'rejected', 1000);
      expect(psql(target!, `BEGIN; SET LOCAL ROLE service_role; ${refundQ(rejected.id, refundEvidence(rejected.id, crypto.randomUUID()))}; COMMIT;`, DB))
        .toMatchObject({ ok: false, sqlstate: 'TF007' });
      // Só a service role.
      for (const role of ['authenticated', 'anon']) {
        expect(asRole(role, refundQ(ch.id, refundEvidence(ch.id, auth()))), role).toMatchObject({ ok: false, sqlstate: '42501' });
      }
    });

    it('UPDATE direto ou forjado do pagamento para REFUNDED é recusado, com ou sem a cobrança estornada e com a marca de outro registro', () => {
      const order = withItems(100);
      const ch = paidCharge(order, 2000);
      const pid = sql(`SELECT id FROM payments WHERE idempotency_key = '${ch.key}'`);
      const upd = `UPDATE payments SET status = 'REFUNDED' WHERE id = '${pid}'`;
      expect(psql(target!, `${upd};`, DB)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      const auth = authorized(ch.key);
      // A cobrança estornada sem os gatilhos (só para montar o cenário): o UPDATE isolado continua recusado.
      sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE terminal_charges SET status = 'refunded' WHERE id = '${ch.id}'; COMMIT;`);
      const alone = psql(target!, `${upd};`, DB);
      expect(alone).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(alone.message).toContain('só vira estornado pelo estorno verificado');
      // Marca apontando para outro registro (o pedido de conferência) ou lixo: recusado.
      for (const flag of [auth, 'nao-e-uuid', crypto.randomUUID()]) {
        expect(psql(target!, `BEGIN; SELECT set_config('tchefood.point_resolution', '${flag}', true); ${upd}; COMMIT;`, DB), flag).toMatchObject({ ok: false, sqlstate: 'TF007' });
      }
      // Registro POINT_PAYMENT_REFUNDED forjado pelo aparelho: recusado pelo gatilho de audit_logs.
      expect(asDevice(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES ('${TENANT}', '${order}', '${STAFF}', 'POINT_PAYMENT_REFUNDED', 'forjado pelo aparelho', jsonb_build_object('payment_id', '${pid}', 'charge_id', '${ch.id}'))`).ok).toBe(false);
      expect(sql(`SELECT status FROM payments WHERE id = '${pid}'`)).toBe('APPROVED');
      expect(orderState(order)).toBe('2000|8000|OPEN');
      // A cobrança aprovada também não vira estornada pelo UPDATE direto com a marca de um POINT_PAYMENT_REFUNDED de outra cobrança.
      const ch2 = paidCharge(order, 1000);
      expect(refundPoint(ch2.id).ok).toBe(true);
      const foreign = sql(`SELECT id FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND metadata->>'charge_id' = '${ch2.id}'`);
      const ch3 = paidCharge(order, 1000);
      expect(psql(target!, `BEGIN; SELECT set_config('tchefood.point_resolution', '${foreign}', true); UPDATE terminal_charges SET status = 'refunded' WHERE id = '${ch3.id}'; COMMIT;`, DB).ok).toBe(false);
      expect(state(ch3)).toBe('approved|APPROVED');
    });

    it('pagamento aprovado é final: nenhum papel o tira de APROVADO fora do estorno verificado (DECLINED, PENDING, REFUNDED fora do MP)', () => {
      const order = withItems(100);
      const k = key('final');
      expect(pay(payment(order, 20, { idempotency_key: k })).ok).toBe(true);
      const cashId = sql(`SELECT id FROM payments WHERE idempotency_key = '${k}'`);
      const ch = paidCharge(order, 3000);
      const mpId = sql(`SELECT id FROM payments WHERE idempotency_key = '${ch.key}'`);
      for (const [id, to] of [[cashId, 'DECLINED'], [cashId, 'PENDING'], [cashId, 'REFUNDED'], [mpId, 'DECLINED'], [mpId, 'PENDING']] as const) {
        for (const role of ['owner', 'service_role']) {
          const upd = `UPDATE payments SET status = '${to}' WHERE id = '${id}'`;
          const q = role === 'owner' ? `${upd};` : `BEGIN; SET LOCAL ROLE service_role; ${upd}; COMMIT;`;
          const r = psql(target!, q, DB);
          expect(r, `${id === cashId ? 'dinheiro' : 'MP'} → ${to} (${role})`).toMatchObject({ ok: false, sqlstate: 'TF007' });
        }
      }
      // DETAIL do recusado fora do MP (o do MP para DECLINED/PENDING sai antes, pelo gatilho do Mercado Pago).
      expect(last(psql(target!, `DO $d$ DECLARE c TEXT; d TEXT; BEGIN
          BEGIN UPDATE payments SET status = 'DECLINED' WHERE id = '${cashId}'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS c = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL; END;
          PERFORM set_config('tchefood.test_err', c || '|' || d, false); END $d$; SELECT current_setting('tchefood.test_err');`, DB))).toBe('TF007|approved_is_final');
      expect(sql(`SELECT string_agg(status::text, ',' ORDER BY amount) FROM payments WHERE id IN ('${cashId}', '${mpId}')`)).toBe('APPROVED,APPROVED');
      expect(orderState(order)).toBe('5000|5000|OPEN');
      // O caminho autorizado continua valendo, e grava o gerente que autorizou.
      expect(refundPoint(ch.id).ok).toBe(true);
      expect(sql(`SELECT authorized_by_manager_id FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND metadata->>'charge_id' = '${ch.id}'`)).toBe(MANAGER);
      expect(orderState(order)).toBe('2000|8000|OPEN');
    });

    it('auditoria interna 1: estorno total provado (valor estornado = valor), só "refunded", motivo até 500, autorização recente e pedida com a cobrança aprovada', () => {
      const order = withItems(100);
      const ch = paidCharge(order, 3000);
      const run = (over: Record<string, unknown>, a = authorized(ch.key), reason?: string) =>
        psql(target!, `BEGIN; SET LOCAL ROLE service_role; ${refundQ(ch.id, refundEvidence(ch.id, a, over), undefined, STAFF, TENANT, reason)}; COMMIT;`, DB);
      const age = (id: string, ago: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE audit_logs SET created_at = clock_timestamp() - INTERVAL '${ago}' WHERE id = '${id}'; COMMIT;`);
      const fresh9 = authorized(ch.key);
      age(fresh9, '9 minutes');
      const old = authorized(ch.key);
      age(old, '10 minutes 1 second');
      for (const [label, r] of [
        ['estorno parcial', run({ mp_amount_refunded_cents: 2999 })],
        ['sem o valor estornado', run({ mp_amount_refunded_cents: undefined })],
        ['valor estornado em texto', run({ mp_amount_refunded_cents: '3000' })],
        ['estornado a mais', run({ mp_amount_refunded_cents: 3001 })],
        ['cancelled num pagamento aprovado', run({ mp_status: 'cancelled' })],
        ['motivo de 501', run({}, undefined, 'x'.repeat(501))],
        ['autorização de mais de 10 min', run({}, old)],
      ] as const) {
        expect(r, label).toMatchObject({ ok: false, sqlstate: 'TF006' });
      }
      expect(state(ch)).toBe('approved|APPROVED');
      // Autorização pedida antes de a cobrança ser aprovada (em revisão manual) não serve ao estorno.
      const review = charge(order, 'manual_review', 1000);
      const before = authorized(review.key);
      const after = authorized(review.key);
      expect(resolve(review.id, 'manual_review', 'approved', receiptPatch(1000), `{"authorization_audit_id":"${after}","operation_id":"op-1"}`).ok).toBe(true);
      expect(mpPayment(review.id).ok).toBe(true);
      expect(refundPoint(review.id, {}, before)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      // Dentro do prazo e com 500 caracteres: passa.
      const ok = run({}, fresh9, 'y'.repeat(500));
      expect(ok.ok, ok.message ?? '').toBe(true);
      expect(state(ch)).toBe('refunded|REFUNDED');
    });

    it('auditoria interna 1: fim verificado da aprovada → estornada só com estorno total (refunded, valor estornado = valor); cancelled só antes da aprovação', () => {
      const order = withItems(100);
      const c = charge(order, 'approved', 2000);
      const ev = (extra: string) => `{"authorization_audit_id":"${authorized(c.key)}","operation_id":null${extra}}`;
      for (const [label, extra] of [
        ['sem nada lido', ''],
        ['cancelled', ',"mp_status":"cancelled","mp_amount_refunded_cents":2000'],
        ['parcial', ',"mp_status":"refunded","mp_amount_refunded_cents":1999'],
        ['sem o valor estornado', ',"mp_status":"refunded"'],
        ['valor em texto', ',"mp_status":"refunded","mp_amount_refunded_cents":"2000"'],
        ['chargeback', ',"mp_status":"charged_back","mp_amount_refunded_cents":2000'],
      ] as const) {
        expect(resolve(c.id, 'approved', 'refunded', '{}', ev(extra)), label).toMatchObject({ ok: false, sqlstate: 'TF006' });
      }
      expect(chargeField(c.id, 'status')).toBe('approved');
      expect(resolve(c.id, 'approved', 'refunded', '{}', ev(',"mp_status":"refunded","mp_amount_refunded_cents":2000')).out).toBe('refunded');
      // Revisão manual (nunca aprovada no servidor) que termina cancelada continua sem essa prova.
      const review = charge(order, 'manual_review', 1000);
      expect(resolve(review.id, 'manual_review', 'cancelled', '{"raw_status":"canceled"}').out).toBe('cancelled');
    });

    it('auditoria interna 1: motivo até 500 caracteres e autorização de até 10 min também na conferência e no fim verificado', () => {
      const order = withItems(100);
      const ch = charge(order, 'manual_review', 1000);
      expect(psql(target!, `BEGIN; SET LOCAL ROLE service_role; SELECT tchefood_authorize_point_reconcile('${TENANT}', '${ch.key}', '${STAFF}', '${MANAGER_PIN}', '${'z'.repeat(501)}'); COMMIT;`, DB))
        .toMatchObject({ ok: false, sqlstate: 'TF006' });
      const old = authorized(ch.key);
      sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE audit_logs SET created_at = clock_timestamp() - INTERVAL '11 minutes' WHERE id = '${old}'; COMMIT;`);
      expect(resolve(ch.id, 'manual_review', 'rejected', '{}', `{"authorization_audit_id":"${old}","operation_id":null}`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      const a = authorized(ch.key);
      expect(psql(target!, `${resolveQ(ch.id, 'manual_review', 'rejected', '{}', `{"authorization_audit_id":"${a}","operation_id":null}`, 'w'.repeat(501))};`, DB))
        .toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(resolve(ch.id, 'manual_review', 'rejected', '{}', `{"authorization_audit_id":"${a}","operation_id":null}`).ok).toBe(true);
    });

    it('concorrência F1: reenvio do aparelho do pagamento APROVADO já estornado devolve o id sem gravar; o que muda qualquer campo continua recusado', () => {
      const order = withItems(100);
      const ch = charge(order, 'approved', 3000);
      const [pid, auth] = sql(`SELECT external_payment_id || '|' || authorization_code FROM terminal_charges WHERE id = '${ch.id}'`).split('|');
      const mpJ = (over: Record<string, unknown> = {}) => payment(order, 30, { id: payId, method: 'CREDIT', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
        terminal_id: TERMINAL, terminal_serial: MP_ID, card_brand: 'VISA', nsu: pid, authorization_code: auth, idempotency_key: ch.key, ...over });
      const payId = crypto.randomUUID();
      const first = register(mpJ());
      expect(first.ok, first.message ?? '').toBe(true);
      expect(refundPoint(ch.id).ok).toBe(true);
      expect(state(ch)).toBe('refunded|REFUNDED');
      // A resposta do primeiro INSERT se perdeu: o reenvio igual devolve o id e não muda nada.
      const again = register(mpJ());
      expect(again.ok, again.message ?? '').toBe(true);
      expect(last(again)).toBe(payId);
      expect(state(ch)).toBe('refunded|REFUNDED');
      expect(orderState(order)).toBe('0|10000|OPEN');
      // Qualquer campo diferente: a recusa de sempre.
      for (const [label, over] of [['valor', { amount: 29 }], ['NSU', { nsu: 'OUTRO' }], ['forma', { method: 'DEBIT' }], ['chave', { idempotency_key: key('outra') }]] as const) {
        const r = register(mpJ(over));
        expect(r.ok, label).toBe(false);
        expect(r.message, label).toContain('já existe outro pagamento com este id');
      }
      // Fora do Mercado Pago nada muda: aprovado em dinheiro reenviado como recusado continua recusado.
      const k = key('replay-cash');
      const cashJ = payment(order, 10, { idempotency_key: k });
      expect(pay(cashJ).ok).toBe(true);
      const declinedAgain = register(JSON.stringify({ ...JSON.parse(cashJ), status: 'DECLINED' }));
      expect(declinedAgain.message).toContain('já existe outro pagamento com este id');
    });

    for (const refundFirst of [false, true]) {
      it(`estorno e registro do pagamento ao mesmo tempo (${refundFirst ? 'estorno' : 'pagamento'} primeiro): sem 40P01, um resultado coerente`, async () => {
        const order = withItems(100);
        const ch = charge(order, 'approved', 4000);
        const auth = authorized(ch.key);
        const refund = `BEGIN; SET LOCAL ROLE service_role; ${ownerQ(refundQ(ch.id, refundEvidence(ch.id, auth)))} COMMIT;`;
        const payQ2 = ownerQ(mpPaymentQ(ch.id));
        const [first, second] = await contend(lockOrder(order), refundFirst ? [refund, payQ2] : [payQ2, refund]);
        expect(lastOverlap).toBe(2);
        const [refunded, paid] = refundFirst ? [first, second] : [second, first];
        expect(paid).toBe('ok');
        if (refundFirst) {
          // Sem pagamento ainda: o estorno é recusado (é o fim verificado que estorna sem pagamento) e o pagamento entra.
          expect(refunded).toMatch(/^recusado TF007: .*não tem pagamento registrado/);
          expect(state(ch)).toBe('approved|APPROVED');
          expect(orderState(order)).toBe('4000|6000|OPEN');
        } else {
          expect(refunded).toBe('ok');
          expect(state(ch)).toBe('refunded|REFUNDED');
          expect(orderState(order)).toBe('0|10000|OPEN');
        }
      }, 60_000);
    }

    it('dois estornos ao mesmo tempo (autorizações diferentes): um grava, o outro devolve a cobrança estornada; UM registro', async () => {
      const order = withItems(100);
      const ch = paidCharge(order, 5000);
      const q = (a: string) => `BEGIN; SET LOCAL ROLE service_role; ${ownerQ(refundQ(ch.id, refundEvidence(ch.id, a)))} COMMIT;`;
      const [a, b] = await contend(lockOrder(order), [q(authorized(ch.key)), q(authorized(ch.key))]);
      expect(lastOverlap).toBe(2);
      expect([a, b]).toEqual(['ok', 'ok']);
      expect(refunds(ch)).toBe(1);
      expect(state(ch)).toBe('refunded|REFUNDED');
      expect(orderState(order)).toBe('0|10000|OPEN');
    });
  });

  describe('auditoria 2 (segurança): chave de outra loja, recusado/estornado do Mercado Pago e motivo longo', () => {
    /** "sqlstate|DETAIL|mensagem" da recusa de um SELECT de uma função só, rodado como o servidor (sem erro: "ok||"). */
    const refusalOf = (q: string) => {
      const r = psql(target!, `BEGIN; DO $d$ DECLARE c TEXT := 'ok'; d TEXT := ''; m TEXT := ''; BEGIN
          BEGIN PERFORM ${q.replace(/^SELECT /, '')};
          EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS c = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL, m = MESSAGE_TEXT; END;
          PERFORM set_config('tchefood.test_err', c || '|' || d || '|' || m, true); END $d$;
        SELECT current_setting('tchefood.test_err'); COMMIT;`, DB);
      if (!r.ok) throw new Error(r.message ?? 'refusalOf');
      return r.out.split('\n').pop() ?? '';
    };
    const inUse = (k: string) => `TF009|key_in_use|TCHEFOOD_PAGAMENTO: a chave ${k} já está em uso (outra reserva, cobrança ou pagamento).`;
    const blockQ = (k: string, order: string) =>
      `SELECT tchefood_block_point_key('${TENANT}', '${k}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1000, '${STAFF}')`;
    /** Uma chave de cada dono em outras lojas: reserva (OTHER), cobrança da Point (PIN_TENANT) e pagamento gravado (OTHER). */
    const foreignKeys = () => {
      const otherOrder = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      const claimKey = key('a2c');
      expect(claim(claimKey, otherOrder, 'CASH', 'CASH_DESK', 1000, undefined, OTHER_STAFF, OTHER).ok).toBe(true);
      const pinOrder = withItems(100, PIN_TENANT, PIN_TABLE, PIN_STAFF);
      const chargeKey = charge(pinOrder, 'cancelled', 1000, { tenant_id: PIN_TENANT, terminal_id: PIN_TERMINAL }).key;
      const paymentKey = key('a2p');
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO payments (order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
           VALUES ('${otherOrder}', '${OTHER}', '${OTHER_STAFF}', 10, 'CASH', 'APPROVED', 'CASH_DESK', '${paymentKey}'); COMMIT;`);
      return { claim: claimKey, charge: chargeKey, payment: paymentKey };
    };

    it('P2-1: abrir cobrança com a chave de outra loja (reserva, cobrança ou pagamento): a mesma recusa TF009 key_in_use, nada gravado', () => {
      const keys = foreignKeys();
      const order = withItems(100);
      for (const [owner, k] of Object.entries(keys)) {
        expect(refusalOf(openPointQ(k, order, 1000, bal(order))), owner).toBe(inUse(k));
      }
      // Conta desta loja fechada: a recusa da chave de outra loja é a mesma para todo dono (não diz o que há com a chave).
      const closed = withItems(100);
      sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE orders SET status = 'CLOSED' WHERE id = '${closed}'; COMMIT;`);
      for (const [owner, k] of Object.entries(keys)) {
        expect(refusalOf(openPointQ(k, closed, 1000, bal(closed))), `fechada ${owner}`).toBe(inUse(k));
      }
      for (const k of Object.values(keys)) expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${k}' AND tenant_id = '${TENANT}'`)).toBe('0');
    });

    it('P2-1: bloquear a chave de outra loja (reserva, cobrança ou pagamento): a mesma recusa TF009 key_in_use, nada gravado', () => {
      const keys = foreignKeys();
      const order = withItems(100);
      for (const [owner, k] of Object.entries(keys)) {
        expect(refusalOf(blockQ(k, order)), owner).toBe(inUse(k));
        expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${k}' AND tenant_id = '${TENANT}'`)).toBe('0');
      }
      expect(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'POINT_KEY_BLOCKED' AND metadata->>'idempotency_key' IN ('${Object.values(keys).join("','")}')`)).toBe('0');
    });

    it('P2-1: chave desta loja segue com a recusa específica (reserva: "outro pagamento"; pagamento gravado)', () => {
      const order = withItems(100);
      const k = key('a2own');
      expect(cash(k, order, 1000).ok).toBe(true);
      expect(refusalOf(openPointQ(k, order, 1000, bal(order)))).toMatch(/^TF009\|.*\|TCHEFOOD_COBRANCA: a chave .* já é de outro pagamento/);
      expect(refusalOf(blockQ(k, order))).toMatch(/^TF009\|.*\|TCHEFOOD_COBRANCA: a chave .* já é de outro pagamento/);
    });

    /** Pagamento do Mercado Pago com a chave da cobrança, igual a ela, trocando os campos de `over` (SQL). */
    const mpRow = (id: string, status: string, over: Record<string, string> = {}) => {
      const [order, cents, pid, k] = sql(`SELECT order_id || '|' || amount_cents || '|' || COALESCE(external_payment_id, '') || '|' || idempotency_key FROM terminal_charges WHERE id = '${id}'`).split('|');
      const row: Record<string, string> = {
        order_id: `'${order}'`, tenant_id: `'${TENANT}'`, waiter_id: `'${STAFF}'`, terminal_id: `'${TERMINAL}'`, amount: String(Number(cents) / 100),
        method: `'CREDIT'`, status: `'${status}'`, acquirer: `'MERCADO_PAGO'`, acquirer_cnpj: `'10573521000191'`, nsu: pid ? `'${pid}'` : 'NULL',
        terminal_serial: `'${MP_ID}'`, idempotency_key: `'${k}'`, ...over,
      };
      return psql(target!, `INSERT INTO payments (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).join(', ')});`, DB);
    };

    it('P2-2: recusado do Mercado Pago só entra igual à cobrança (conta, valor, forma; comprovante, se houver)', () => {
      const order = withItems(100);
      const other = withItems(100);
      const cancelled = charge(order, 'cancelled', 100);
      // O caso da revisão: R$ 999,99 em débito numa cobrança de R$ 1,00 no crédito, cancelada.
      expect(mpRow(cancelled.id, 'DECLINED', { amount: '999.99', method: `'DEBIT'` })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(mpRow(cancelled.id, 'DECLINED', { amount: '999.99' })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(mpRow(cancelled.id, 'DECLINED', { method: `'DEBIT'` })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(mpRow(cancelled.id, 'DECLINED', { order_id: `'${other}'` })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      // Cobrança recusada com o pagamento do Mercado Pago: o recusado vem sem comprovante (como o aparelho grava) ou com o dela.
      const rejected = charge(order, 'rejected', 100, { external_payment_id: 'PREJ1' });
      expect(mpRow(rejected.id, 'DECLINED', { nsu: `'OUTRO'` })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key IN ('${cancelled.key}', '${rejected.key}')`)).toBe('0');
      expect(mpRow(cancelled.id, 'DECLINED').ok).toBe(true);
      expect(mpRow(rejected.id, 'DECLINED', { nsu: 'NULL' }).ok).toBe(true);
      const rejected2 = charge(order, 'rejected', 100, { external_payment_id: 'PREJ2' });
      expect(mpRow(rejected2.id, 'DECLINED').ok).toBe(true);
    });

    it('P2-2: estornado do Mercado Pago só entra igual à cobrança estornada (conta, valor, forma e comprovante)', () => {
      const order = withItems(100);
      const other = withItems(100);
      const refunded = charge(order, 'refunded', 100, { external_payment_id: 'PREF1', paid_amount_cents: 100, card_brand: 'VISA', authorization_code: 'AUT1' });
      expect(mpRow(refunded.id, 'REFUNDED', { amount: '999.99' })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(mpRow(refunded.id, 'REFUNDED', { method: `'DEBIT'` })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(mpRow(refunded.id, 'REFUNDED', { order_id: `'${other}'` })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(mpRow(refunded.id, 'REFUNDED', { nsu: `'OUTRO'` })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(mpRow(refunded.id, 'REFUNDED', { nsu: 'NULL' })).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(sql(`SELECT count(*) FROM payments WHERE idempotency_key = '${refunded.key}'`)).toBe('0');
      // O espelho do aparelho (o aprovado que vira estornado na fila: os campos do aprovado) entra.
      expect(mpRow(refunded.id, 'REFUNDED', { card_brand: `'VISA'`, authorization_code: `'AUT1'` }).ok).toBe(true);
    });

    it('P2-3: motivo de mais de 500 caracteres é recusado (TF006) nas liberações, no estorno da reserva e no encerramento com PIN', () => {
      const long = 'x'.repeat(501);
      const order = withItems(100);
      const k = key('a2r');
      expect(cash(k, order, 1000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, '${long}')`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', '${long}')`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(asDevice(`SELECT tchefood_authorize_claim_refunded('${k}', '${STAFF}', '${MANAGER_PIN}', '${long}', '{}'::jsonb)`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(claimField(k, 'status')).toBe('open');
      // 500 depois de tirar os espaços das pontas ainda vale.
      const ok = json<{ status: string }>(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', ${tok(k)}, '  ${'y'.repeat(500)}  ')`));
      expect(ok.status).toBe('released');
      const ch = charge(order, 'creating', 100);
      const cancel = psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', '${ch.key}', '${STAFF}', '${MANAGER_PIN}', '${long}');`, DB);
      expect(cancel).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(cancel.message).toContain('500');
      expect(audits('POINT_CHARGE_CANCELED', 'idempotency_key', ch.key)).toBe(0);
    });
  });

  describe('GPT r10: conta estornada reabre, venda devolvida, lista dos pagamentos da Point e reenvio do pagamento', () => {
    const orderState = (order: string) => sql(`SELECT round(paid_amount * 100)::bigint || '|' || round(remaining_balance * 100)::bigint || '|' || status FROM orders WHERE id = '${order}'`);
    const paidCharge = (order: string, cents: number) => {
      const ch = charge(order, 'approved', cents);
      const r = mpPayment(ch.id);
      expect(r.ok, r.message ?? '').toBe(true);
      return ch;
    };
    /** Conta de R$ 100 paga inteira na Point, fechada, e estornada (reaberta). */
    const refundedOrder = () => {
      const order = withItems(100);
      const ch = paidCharge(order, 10000);
      expect(orderState(order)).toBe('10000|0|CLOSED');
      const r = refundPoint(ch.id);
      expect(r.ok, r.message ?? '').toBe(true);
      return { order, ch };
    };
    const closeQ = (order: string, client: string, pin = MANAGER_PIN, reason = 'venda devolvida ao cliente', staff = STAFF) =>
      `SELECT COALESCE(tchefood_close_refunded_order('${order}', '${staff}', '${pin}', '${reason}', '${client}')::text, 'null')`;
    const writeOffs = (order: string) => Number(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'ORDER_REFUNDED_WRITE_OFF' AND order_id = '${order}'`));
    /** Como o aparelho, numa transação desfeita no fim (as falhas de PIN não bloqueiam os outros testes). */
    const inRollback = (q: string, post = 'SELECT 1') =>
      sql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
           ${q}; RESET ROLE; ${post}; ROLLBACK;`).split('\n').filter((l) => l !== '' && l !== 'SET' && !l.startsWith('{"tenant_id"')).slice(-2);

    it('P1-01 aceite: pagamento total → fecha → estorno total → PAYING com saldo 100 → reserva + dinheiro → CLOSED 0; a mesa não muda', () => {
      const order = withItems(100);
      const ch = paidCharge(order, 10000);
      expect(orderState(order)).toBe('10000|0|CLOSED');
      const closedAt = sql(`SELECT closed_at FROM orders WHERE id = '${order}'`);
      expect(closedAt).not.toBe('');
      const table = sql(`SELECT status || '|' || COALESCE(current_order_id::text, '-') FROM dining_tables WHERE id = '${TABLE}'`);
      const r = refundPoint(ch.id);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(orderState(order)).toBe('0|10000|PAYING');
      expect(sql(`SELECT closed_at IS NULL FROM orders WHERE id = '${order}'`)).toBe('t');
      const meta = JSON.parse(sql(`SELECT metadata::text FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND metadata->>'charge_id' = '${ch.id}'`)) as Record<string, unknown>;
      expect(meta.order_reopened).toBe(true);
      expect(new Date(String(meta.previous_closed_at)).getTime()).toBe(new Date(sql(`SELECT to_jsonb('${closedAt}'::timestamptz) #>> '{}'`)).getTime());
      expect(sql(`SELECT status || '|' || COALESCE(current_order_id::text, '-') FROM dining_tables WHERE id = '${TABLE}'`)).toBe(table);
      // O caixa cobra de novo: reserva + dinheiro, e a conta fecha no zero.
      const paid = pay(payment(order, 100, { idempotency_key: key('r10a') }));
      expect(paid.ok, paid.message ?? '').toBe(true);
      expect(orderState(order)).toBe('10000|0|CLOSED');
      expect(sql(`SELECT closed_at IS NOT NULL FROM orders WHERE id = '${order}'`)).toBe('t');
    });

    it('P1-01: a conta encerrada continua sem reabrir por UPDATE direto ou com a marca de outro registro; conta aberta estornada segue aberta', () => {
      const order = withItems(50);
      paidCharge(order, 5000);
      expect(orderState(order)).toBe('5000|0|CLOSED');
      sql(`UPDATE orders SET status = 'PAYING' WHERE id = '${order}'`);
      expect(orderState(order)).toBe('5000|0|CLOSED');
      // Marca apontando para um estorno de outra conta (order_reopened = true): ignorado.
      const other = refundedOrder();
      const foreign = sql(`SELECT id FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND order_id = '${other.order}'`);
      sql(`BEGIN; SELECT set_config('tchefood.point_resolution', '${foreign}', true); UPDATE orders SET status = 'PAYING' WHERE id = '${order}'; COMMIT;`);
      expect(orderState(order)).toBe('5000|0|CLOSED');
      const open = withItems(100);
      const ch = paidCharge(open, 4000);
      expect(refundPoint(ch.id).ok).toBe(true);
      expect(orderState(open)).toBe('0|10000|OPEN');
      expect(sql(`SELECT metadata->>'order_reopened' FROM audit_logs WHERE action_type = 'POINT_PAYMENT_REFUNDED' AND metadata->>'charge_id' = '${ch.id}'`)).toBe('false');
    });

    it('P1-02 (venda devolvida): o gerente encerra a conta estornada com saldo; registro ORDER_REFUNDED_WRITE_OFF; reenvio devolve o mesmo', () => {
      const { order } = refundedOrder();
      const client = crypto.randomUUID();
      const out = JSON.parse(last(asDevice(closeQ(order, client)))) as Record<string, unknown>;
      expect(out).toMatchObject({ order_id: order, status: 'CLOSED', written_off_cents: 10000 });
      expect(orderState(order)).toBe('0|10000|CLOSED');
      expect(sql(`SELECT closed_at IS NOT NULL FROM orders WHERE id = '${order}'`)).toBe('t');
      expect(sql(`SELECT performed_by_user_id || '|' || authorized_by_manager_id || '|' || amount_impact || '|' || reason || '|' || (metadata->>'written_off_cents') || '|' || (metadata->>'client_audit_id')
                  FROM audit_logs WHERE id = '${String(out.audit_id)}'`)).toBe(`${STAFF}|${MANAGER}|100.00|venda devolvida ao cliente|10000|${client}`);
      // Reenvio (a resposta se perdeu): o mesmo resultado, sem outro registro.
      expect(JSON.parse(last(asDevice(closeQ(order, client))))).toEqual(out);
      expect(writeOffs(order)).toBe(1);
      // Outro id do aparelho na conta já encerrada: TF007.
      expect(asDevice(closeQ(order, crypto.randomUUID()))).toMatchObject({ ok: false, sqlstate: 'TF007' });
      // O aparelho não grava esse registro direto, nem fecha outra conta com saldo apontando para ele.
      expect(asDevice(`INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata) VALUES ('${TENANT}', '${order}', '${STAFF}', 'ORDER_REFUNDED_WRITE_OFF', 'forjado', '{"written_off_cents":10000}')`).ok).toBe(false);
      const second = refundedOrder();
      sql(`BEGIN; SELECT set_config('tchefood.order_write_off', '${String(out.audit_id)}', true); COMMIT;`);
      const forged = psql(target!, `BEGIN; SELECT set_config('tchefood.order_write_off', '${String(out.audit_id)}', true); UPDATE orders SET status = 'CLOSED' WHERE id = '${second.order}'; COMMIT;`, DB);
      expect(forged).toMatchObject({ ok: false });
      expect(forged.message).toContain('ainda deve');
      expect(orderState(second.order)).toBe('0|10000|PAYING');
    });

    it('P1-02: PIN errado (NULL, nada muda, falha registrada), bloqueio depois de 3 erros, outra loja, operador inativo e motivo', () => {
      const { order } = refundedOrder();
      const wrong = inRollback(closeQ(order, crypto.randomUUID(), '0000'),
        `SELECT status || '|' || (SELECT count(*) FROM audit_logs WHERE action_type = 'MANAGER_PIN_FAILED' AND order_id = '${order}') FROM orders WHERE id = '${order}'`);
      expect(wrong).toEqual(['null', 'PAYING|1']);
      const locked = inRollback(`${closeQ(order, crypto.randomUUID(), '0000')}; ${closeQ(order, crypto.randomUUID(), '0001')}; ${closeQ(order, crypto.randomUUID(), '0002')}; ${closeQ(order, crypto.randomUUID())}`,
        `SELECT status || '|' || (SELECT count(*) FROM audit_logs WHERE action_type = 'MANAGER_PIN_LOCKOUT' AND order_id = '${order}') || '|' || (SELECT count(*) FROM audit_logs WHERE action_type = 'ORDER_REFUNDED_WRITE_OFF' AND order_id = '${order}') FROM orders WHERE id = '${order}'`);
      expect(locked).toEqual(['null', 'PAYING|1|0']);
      expect(asDevice(closeQ(order, crypto.randomUUID(), MANAGER_PIN, 'venda devolvida ao cliente', OTHER_STAFF), OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(asDevice(closeQ(order, crypto.randomUUID(), MANAGER_PIN, 'venda devolvida ao cliente', INACTIVE))).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(asDevice(closeQ(order, crypto.randomUUID(), MANAGER_PIN, 'curto'))).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(asDevice(closeQ(order, crypto.randomUUID(), MANAGER_PIN, 'x'.repeat(501)))).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(orderState(order)).toBe('0|10000|PAYING');
      expect(writeOffs(order)).toBe(0);
      // Só o aparelho (authenticated) e a service role chamam; anon não.
      expect(asRole('anon', closeQ(order, crypto.randomUUID()))).toMatchObject({ ok: false, sqlstate: '42501' });
    });

    it('P1-02: saldo que não é só do estorno da Point, conta sem saldo e conta com reserva aberta: recusado antes do PIN', () => {
      // Pagou 60 de 100 na Point e estornou: o saldo de 100 tem 40 que nunca foram pagos.
      const partial = withItems(100);
      const ch = paidCharge(partial, 6000);
      expect(refundPoint(ch.id).ok).toBe(true);
      expect(detailOf(closeQ(partial, crypto.randomUUID()))).toBe('TF007|balance_not_refunded');
      // Conta sem estorno nenhum.
      expect(detailOf(closeQ(withItems(100), crypto.randomUUID()))).toBe('TF007|balance_not_refunded');
      // Conta estornada com reserva aberta.
      const { order } = refundedOrder();
      expect(cash(key('r10r'), order, 1000).ok).toBe(true);
      expect(detailOf(closeQ(order, crypto.randomUUID()))).toBe('TF012|reserved');
      expect(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'MANAGER_PIN_FAILED' AND order_id IN ('${partial}', '${order}')`)).toBe('0');
      expect(orderState(order)).toBe('0|10000|PAYING');
    });

    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;
    for (const closeFirst of [true, false]) {
      it(`P1-02 concorrência: venda devolvida e reserva na mesma conta (${closeFirst ? 'encerramento' : 'reserva'} primeiro): só um entra`, async () => {
        const { order } = refundedOrder();
        const k = key('r10c');
        const close = deviceQ(closeQ(order, crypto.randomUUID()));
        const claimIt = deviceQ(claimQ(k, order, 'CASH', 'CASH_DESK', 1000, 10000));
        const [first, second] = await contend(lockOrder(order), closeFirst ? [close, claimIt] : [claimIt, close]);
        expect(lastOverlap).toBe(2);
        const [closed, claimed] = closeFirst ? [first, second] : [second, first];
        if (closeFirst) {
          expect(closed).toBe('ok');
          expect(claimed).toMatch(/^recusado TF002: /);
          expect(orderState(order)).toBe('0|10000|CLOSED');
          expect(sql(`SELECT count(*) FROM payment_claims WHERE idempotency_key = '${k}'`)).toBe('0');
        } else {
          expect(claimed).toBe('ok');
          expect(closed).toMatch(/^recusado TF012: /);
          expect(orderState(order)).toBe('0|10000|PAYING');
          expect(writeOffs(order)).toBe(0);
        }
      }, 60_000);
    }

    it('P1-01: nenhum caminho de estorno deixa conta fechada com saldo sem o registro da venda devolvida', () => {
      // Também os caminhos que não mexem no pago: fim verificado aprovada → estornada sem pagamento e o espelho REFUNDED.
      const order = withItems(30);
      const ch = paidCharge(order, 3000);
      expect(orderState(order)).toBe('3000|0|CLOSED');
      const bare = charge(withItems(10), 'approved', 1000);
      expect(resolve(bare.id, 'approved', 'refunded', '{"raw_status":"refunded"}').ok).toBe(true);
      expect(mpPayment(bare.id, 'REFUNDED').ok).toBe(true);
      expect(refundPoint(ch.id).ok).toBe(true);
      expect(sql(`SELECT count(*) FROM orders o
                   WHERE o.status = 'CLOSED' AND o.remaining_balance > 0
                     AND (EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'REFUNDED')
                          OR EXISTS (SELECT 1 FROM audit_logs a WHERE a.order_id = o.id AND a.action_type = 'POINT_PAYMENT_REFUNDED'))
                     AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.order_id = o.id AND a.action_type = 'ORDER_REFUNDED_WRITE_OFF'
                                       AND (a.metadata->>'written_off_cents')::bigint = round(o.remaining_balance * 100))`)).toBe('0');
    });

    it('GPT r12 P2-02 + decisão do Will: dois estornos e duas baixas na mesma conta somam o saldo perdoado, uma vez; a conta volta ao turno da venda', () => {
      const order = withItems(100);
      const a = paidCharge(order, 5000);
      const b = paidCharge(order, 5000);
      expect(orderState(order)).toBe('10000|0|CLOSED');
      const firstClosed = sql(`SELECT to_jsonb(closed_at) #>> '{}' FROM orders WHERE id = '${order}'`);
      expect(refundPoint(a.id).ok).toBe(true);
      expect(orderState(order)).toBe('5000|5000|PAYING');
      const w1 = JSON.parse(last(asDevice(closeQ(order, crypto.randomUUID())))) as Record<string, unknown>;
      expect(w1).toMatchObject({ status: 'CLOSED', written_off_cents: 5000, cumulative_written_off_cents: 5000 });
      expect(orderState(order)).toBe('5000|5000|CLOSED');
      expect(sql(`SELECT to_jsonb(closed_at) #>> '{}' FROM orders WHERE id = '${order}'`)).toBe(firstClosed);
      const r2 = refundPoint(b.id);
      expect(r2.ok, r2.message ?? '').toBe(true);
      expect(orderState(order)).toBe('0|10000|PAYING');
      const w2 = JSON.parse(last(asDevice(closeQ(order, crypto.randomUUID())))) as Record<string, unknown>;
      expect(w2).toMatchObject({ status: 'CLOSED', written_off_cents: 5000, cumulative_written_off_cents: 10000 });
      expect(orderState(order)).toBe('0|10000|CLOSED');
      // O total das baixas é o saldo perdoado (R$ 100), nunca R$ 150.
      expect(sql(`SELECT sum((metadata->>'written_off_cents')::bigint) || '|' || sum(amount_impact) FROM audit_logs WHERE action_type = 'ORDER_REFUNDED_WRITE_OFF' AND order_id = '${order}'`)).toBe('10000|100.00');
      // Decisão do Will (15/11): a venda devolvida fica no turno em que a conta foi fechada pela primeira vez.
      expect(sql(`SELECT to_jsonb(closed_at) #>> '{}' FROM orders WHERE id = '${order}'`)).toBe(firstClosed);
      expect(new Date(String(w2.closed_at)).getTime()).toBe(new Date(firstClosed).getTime());
    });

    it('GPT r14 P1-02 (ciclo completo): 2 pagamentos Point → fecha → 1º estorno → baixa → 2º estorno → pagamento parcial → encerra; ou pagamento integral → fecha zerada', () => {
      for (const variant of ['partial', 'full'] as const) {
        const order = withItems(100);
        const a = paidCharge(order, 5000);
        const b = paidCharge(order, 5000);
        expect(orderState(order)).toBe('10000|0|CLOSED');
        const firstClosed = sql(`SELECT to_jsonb(closed_at) #>> '{}' FROM orders WHERE id = '${order}'`);
        expect(refundPoint(a.id).ok).toBe(true);
        expect(orderState(order)).toBe('5000|5000|PAYING');
        const w1 = JSON.parse(last(asDevice(closeQ(order, crypto.randomUUID())))) as Record<string, unknown>;
        expect(w1).toMatchObject({ status: 'CLOSED', written_off_cents: 5000, cumulative_written_off_cents: 5000 });
        const r2 = refundPoint(b.id);
        expect(r2.ok, r2.message ?? '').toBe(true);
        expect(orderState(order)).toBe('0|10000|PAYING');
        if (variant === 'partial') {
          // O cliente paga R$ 50 (reserva + dinheiro); os R$ 50 restantes já tinham sido baixados antes.
          const paid = pay(payment(order, 50, { idempotency_key: key('r14p') }));
          expect(paid.ok, paid.message ?? '').toBe(true);
          expect(orderState(order)).toBe('5000|5000|PAYING');
          const w2 = JSON.parse(last(asDevice(closeQ(order, crypto.randomUUID())))) as Record<string, unknown>;
          // Antes da correção: TF007 nothing_to_write_off (a conta ficava aberta).
          expect(w2).toMatchObject({ status: 'CLOSED', written_off_cents: 0, cumulative_written_off_cents: 5000 });
          expect(orderState(order)).toBe('5000|5000|CLOSED');
          // O total baixado da conta é R$ 50 (o saldo que ficou sem pagar), contado uma vez.
          expect(sql(`SELECT count(*) || '|' || sum((metadata->>'written_off_cents')::bigint) || '|' || sum(amount_impact) FROM audit_logs WHERE action_type = 'ORDER_REFUNDED_WRITE_OFF' AND order_id = '${order}'`)).toBe('2|5000|50.00');
          expect(sql(`SELECT to_jsonb(closed_at) #>> '{}' FROM orders WHERE id = '${order}'`)).toBe(firstClosed);
          // Outro clique na conta encerrada: TF007, sem registro novo.
          expect(asDevice(closeQ(order, crypto.randomUUID()))).toMatchObject({ ok: false, sqlstate: 'TF007' });
        } else {
          const paid = pay(payment(order, 100, { idempotency_key: key('r14f') }));
          expect(paid.ok, paid.message ?? '').toBe(true);
          expect(orderState(order)).toBe('10000|0|CLOSED');
          // Nada a baixar: o gerente não encerra de novo.
          expect(asDevice(closeQ(order, crypto.randomUUID()))).toMatchObject({ ok: false, sqlstate: 'TF007' });
        }
      }
    });

    it('GPT r14 P1-02: pagamento depois da baixa que cobre mais do que o saldo baixado: a nova baixa reduz o total (diferença negativa) e o total fica igual ao saldo', () => {
      const order = withItems(100);
      const a = paidCharge(order, 5000);
      const b = paidCharge(order, 5000);
      expect(refundPoint(a.id).ok).toBe(true);
      asDevice(closeQ(order, crypto.randomUUID()));
      expect(refundPoint(b.id).ok).toBe(true);
      const paid = pay(payment(order, 80, { idempotency_key: key('r14n') }));
      expect(paid.ok, paid.message ?? '').toBe(true);
      expect(orderState(order)).toBe('8000|2000|PAYING');
      const w = JSON.parse(last(asDevice(closeQ(order, crypto.randomUUID())))) as Record<string, unknown>;
      expect(w).toMatchObject({ status: 'CLOSED', written_off_cents: -3000, cumulative_written_off_cents: 2000 });
      expect(sql(`SELECT sum((metadata->>'written_off_cents')::bigint) || '|' || sum(amount_impact) FROM audit_logs WHERE action_type = 'ORDER_REFUNDED_WRITE_OFF' AND order_id = '${order}'`)).toBe('2000|20.00');
      expect(orderState(order)).toBe('8000|2000|CLOSED');
    });

    it('GPT r12 P1-02/P1-03: tchefood_order_snapshot e tchefood_list_refund_reopened_orders dão o estado oficial, só da loja do token', () => {
      const { order, ch } = refundedOrder();
      const listed = json<Array<Record<string, unknown>>>(asDevice("SELECT tchefood_list_refund_reopened_orders()->'items'"));
      expect(listed.find((x) => x.order_id === order)).toMatchObject({ status: 'PAYING', remaining_balance: 100 });
      expect(json<Array<Record<string, unknown>>>(asDevice("SELECT tchefood_list_refund_reopened_orders()->'items'", OTHER)).some((x) => x.order_id === order)).toBe(false);
      const snap = json<{ order: Record<string, unknown>; items: unknown[]; payments: Array<Record<string, unknown>>; audits: Array<Record<string, unknown>> }>(asDevice(`SELECT tchefood_order_snapshot('${order}')`));
      expect(snap.order).toMatchObject({ id: order, status: 'PAYING', remaining_balance: 100 });
      expect(snap.items.length).toBeGreaterThan(0);
      expect(snap.payments.map((p) => `${p.idempotency_key}:${p.status}`)).toEqual([`${ch.key}:REFUNDED`]);
      expect(snap.audits.map((x) => x.action_type)).toEqual(['POINT_PAYMENT_REFUNDED']);
      expect(last(asDevice(`SELECT COALESCE(tchefood_order_snapshot('${order}')::text, 'null')`, OTHER))).toBe('null');
      expect(asRole('anon', `SELECT tchefood_order_snapshot('${order}')`)).toMatchObject({ ok: false, sqlstate: '42501' });
      // Encerrada como venda devolvida: sai da lista e o retrato traz o registro da baixa.
      asDevice(closeQ(order, crypto.randomUUID()));
      expect(json<Array<Record<string, unknown>>>(asDevice("SELECT tchefood_list_refund_reopened_orders()->'items'")).some((x) => x.order_id === order)).toBe(false);
      const after = json<{ order: Record<string, unknown>; audits: Array<Record<string, unknown>> }>(asDevice(`SELECT tchefood_order_snapshot('${order}')`));
      expect(after.order.status).toBe('CLOSED');
      expect(after.audits.map((x) => x.action_type)).toEqual(['POINT_PAYMENT_REFUNDED', 'ORDER_REFUNDED_WRITE_OFF']);
    });

    it('GPT r15 P2-01: 201 contas reabertas por estorno: a lista paginada (cursor refunded_at|order_id) devolve todas, sem repetir nem pular, mesmo com a mesma hora de estorno', () => {
      // Loja própria, gravada direto (o leitor não confere a origem): 201 contas PAYING com saldo e o registro do estorno
      // que as reabriu; metade com a MESMA hora de estorno (o desempate é o id da conta).
      const T = 'a1a1a1a1-0000-4000-8000-000000000a15';
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           DELETE FROM audit_logs WHERE tenant_id = '${T}'; DELETE FROM orders WHERE tenant_id = '${T}';
           INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id, status, total_amount, paid_amount, remaining_balance)
             SELECT ('b1b1b1b1-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${T}', '${TABLE}', '${STAFF}', 'PAYING', 10, 0, 10 FROM generate_series(1, 201) g;
           INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata, created_at)
             SELECT '${T}', ('b1b1b1b1-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${STAFF}', 'POINT_PAYMENT_REFUNDED', 'venda estornada',
                    jsonb_build_object('order_reopened', true, 'previous_closed_at', NOW() - INTERVAL '1 hour'),
                    CASE WHEN g <= 100 THEN TIMESTAMPTZ '2026-11-15 10:00:00+00' ELSE TIMESTAMPTZ '2026-11-15 10:00:00+00' + (g || ' seconds')::interval END
               FROM generate_series(1, 201) g;
           COMMIT;`);
      type Page = { items: Array<{ order_id: string; refunded_at: string }>; next_cursor: string | null };
      const page = (cursor: string | null, limit?: number) => json<Page>(asDevice(`SELECT tchefood_list_refund_reopened_orders(${cursor ? `'${cursor}'` : 'NULL'}${limit ? `, ${limit}` : ''})`, T));
      const first = page(null);
      expect(first.items).toHaveLength(200);
      expect(first.next_cursor).toBeTruthy();
      const second = page(first.next_cursor);
      expect(second.items).toHaveLength(1);
      expect(second.next_cursor).toBeNull();
      const ids = [...first.items, ...second.items].map((i) => i.order_id);
      expect(new Set(ids).size).toBe(201);
      // Páginas pequenas (cortando no meio das 100 com a mesma hora): as mesmas 201, na mesma ordem.
      const small: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const pg: Page = page(cursor, 37);
        small.push(...pg.items.map((x) => x.order_id));
        cursor = pg.next_cursor;
        if (!cursor) break;
      }
      expect(small).toEqual(ids);
      // Limite e cursor inválidos: recusa; outra loja não vê nada desta.
      expect(detailOf(`SELECT tchefood_list_refund_reopened_orders(NULL, 0)`, T)).toMatch(/^TF006/);
      expect(detailOf(`SELECT tchefood_list_refund_reopened_orders(NULL, 201)`, T)).toMatch(/^TF006/);
      expect(detailOf(`SELECT tchefood_list_refund_reopened_orders('nada', 10)`, T)).toMatch(/^TF006/);
      expect(json<Page>(asDevice('SELECT tchefood_list_refund_reopened_orders()', OTHER)).items.some((x) => ids.includes(x.order_id))).toBe(false);
      expect(asRole('anon', 'SELECT tchefood_list_refund_reopened_orders()')).toMatchObject({ ok: false, sqlstate: '42501' });
    });

    it('GPT r15 P1-01: tchefood_list_refund_order_changes traz a conta estornada e já encerrada (venda devolvida ou quitada), por sequência, só da loja do token', () => {
      type Change = { order_id: string; status: string; remaining_balance: number; last_seq: number; last_audit_id: string };
      type Out = { items: Change[]; next_seq: number; safe_seq: number; has_more: boolean };
      const changes = (after: number, limit?: number, tenant = TENANT) => json<Out>(asDevice(`SELECT tchefood_list_refund_order_changes(${after}${limit ? `, ${limit}` : ''})`, tenant));
      const start = Number(sql('SELECT COALESCE(max(server_seq), 0) FROM audit_logs'));
      // Conta 1: estornada e encerrada como venda devolvida. Conta 2: estornada e quitada em dinheiro. Conta 3: só estornada.
      const one = refundedOrder();
      asDevice(closeQ(one.order, crypto.randomUUID()));
      const two = refundedOrder();
      const paid = pay(payment(two.order, 100, { idempotency_key: key('r15c') }));
      expect(paid.ok, paid.message ?? '').toBe(true);
      const three = refundedOrder();
      const out = changes(start);
      const by = (id: string) => out.items.find((i) => i.order_id === id)!;
      expect(out.items.map((i) => i.order_id)).toEqual([one.order, two.order, three.order]);
      expect(by(one.order)).toMatchObject({ status: 'CLOSED', remaining_balance: 100 });
      expect(by(one.order).last_audit_id).toBe(sql(`SELECT id FROM audit_logs WHERE order_id = '${one.order}' AND action_type = 'ORDER_REFUNDED_WRITE_OFF'`));
      expect(by(two.order)).toMatchObject({ status: 'CLOSED', remaining_balance: 0 });
      expect(by(three.order)).toMatchObject({ status: 'PAYING', remaining_balance: 100 });
      expect(out.has_more).toBe(false);
      expect(out.next_seq).toBe(by(three.order).last_seq);
      // GPT r17 P2-01: a gravação é serializada pela trava da loja (sem prazo presumido): tudo o que foi lido já é seguro.
      expect(out.safe_seq).toBe(out.next_seq);
      // Paginado, em ordem de sequência; depois da última, nada.
      const p1 = changes(start, 2);
      expect(p1.items.map((i) => i.order_id)).toEqual([one.order, two.order]);
      expect(p1).toMatchObject({ has_more: true, next_seq: by(two.order).last_seq });
      expect(changes(p1.next_seq, 2)).toMatchObject({ items: [{ order_id: three.order }], has_more: false });
      expect(changes(out.next_seq)).toMatchObject({ items: [], next_seq: out.next_seq, safe_seq: out.next_seq, has_more: false });
      expect(changes(start).safe_seq).toBe(out.next_seq);
      // Nova alteração numa conta já lida (2º fechamento): volta com a sequência nova.
      asDevice(closeQ(three.order, crypto.randomUUID()));
      const again = changes(out.next_seq);
      expect(again.items).toMatchObject([{ order_id: three.order, status: 'CLOSED', remaining_balance: 100 }]);
      expect(again.safe_seq).toBe(again.next_seq);
      // Outra loja, anônimo e argumentos inválidos.
      expect(changes(start, undefined, OTHER).items.some((i) => [one.order, two.order, three.order].includes(i.order_id))).toBe(false);
      expect(asRole('anon', 'SELECT tchefood_list_refund_order_changes(0)')).toMatchObject({ ok: false, sqlstate: '42501' });
      expect(detailOf('SELECT tchefood_list_refund_order_changes(-1)')).toMatch(/^TF006/);
      expect(detailOf('SELECT tchefood_list_refund_order_changes(0, 201)')).toMatch(/^TF006/);
    });

    it('GPT r17 P2-01: a leitura não depende de prazo: duas gravações da mesma loja andam uma depois da outra e o ponto de leitura nunca passa de um registro por confirmar', async () => {
      type Out = { items: Array<{ order_id: string; last_seq: number }>; next_seq: number; safe_seq: number; has_more: boolean };
      const changes = (after: number) => json<Out>(asDevice(`SELECT tchefood_list_refund_order_changes(${after})`));
      const start = Number(sql('SELECT COALESCE(max(server_seq), 0) FROM audit_logs'));
      const x = refundedOrder();
      const y = refundedOrder();
      const z = refundedOrder();
      // O registro dos estornos (já confirmados) é lido por inteiro e o ponto anda até o último.
      const base = changes(start);
      expect(base.items.map((i) => i.order_id)).toEqual([x.order, y.order, z.order]);
      expect(base.safe_seq).toBe(base.next_seq);
      // Sessão 1 encerra a conta X (como o aparelho) e fica aberta; a sessão 2 encerra a Y, e espera a trava da loja.
      const closeSql = (order: string) => `SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true); ${closeQ(order, crypto.randomUUID())};`;
      const s1 = session();
      s1.send(`BEGIN; ${closeSql(x.order)}`);
      await until('sessão 1 gravou', () => writeOffs(x.order) === 0 && /ORDER|\{/.test(s1.output()));
      const before = waiting();
      const s2 = session();
      s2.send(`BEGIN; ${closeSql(y.order)}`);
      await until('sessão 2 espera a trava da loja', () => waiting() > before);
      // Com as duas em andamento nada novo está confirmado: a leitura do aparelho não anda nem vê as contas.
      const during = changes(base.next_seq);
      expect(during).toMatchObject({ items: [], next_seq: base.next_seq, safe_seq: base.next_seq });
      s1.end('COMMIT;');
      await s1.done;
      s2.end('COMMIT;');
      await s2.done;
      expect(writeOffs(x.order)).toBe(1);
      expect(writeOffs(y.order)).toBe(1);
      // Depois de confirmadas, as duas aparecem, na ordem da sequência (a da sessão 1 é menor), e o ponto anda até a última.
      const after = changes(base.next_seq);
      expect(after.items.map((i) => i.order_id)).toEqual([x.order, y.order]);
      expect(after.items[0]!.last_seq).toBeLessThan(after.items[1]!.last_seq);
      expect(after.safe_seq).toBe(after.next_seq);
      expect(changes(after.safe_seq).items).toEqual([]);
    });

    it('GPT r17 P2-01: registro de estorno ou encerramento sem a trava da loja é recusado pelo banco (nem o servidor grava por outro caminho)', () => {
      const x = refundedOrder();
      const insert = (type: string) => `INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason, metadata)
        VALUES ('${TENANT}', '${x.order}', '${STAFF}', '${type}', 'venda devolvida ao cliente', '{"written_off_cents": 0}'::jsonb)`;
      for (const type of ['ORDER_REFUNDED_WRITE_OFF', 'POINT_PAYMENT_REFUNDED']) {
        const direct = psql(target!, `BEGIN; SET LOCAL ROLE service_role; ${insert(type)}; COMMIT;`, DB);
        expect(direct.ok, type).toBe(false);
        // Com a trava da loja tomada (como as funções do servidor fazem) a gravação passa.
        const locked = psql(target!, `BEGIN; SELECT pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || '${TENANT}')); ${insert(type)}; ROLLBACK;`, DB);
        expect(locked.ok, locked.message ?? type).toBe(true);
        // Trava de outra loja, ou compartilhada: não vale.
        const other = psql(target!, `BEGIN; SELECT pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || '${OTHER}')); ${insert(type)}; ROLLBACK;`, DB);
        expect(other.ok, type).toBe(false);
        const shared = psql(target!, `BEGIN; SELECT pg_advisory_xact_lock_shared(hashtext('tchefood_manager_pin:' || '${TENANT}')); ${insert(type)}; ROLLBACK;`, DB);
        expect(shared.ok, type).toBe(false);
      }
      // Outros tipos de registro não são afetados.
      const other = psql(target!, `BEGIN; INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, action_type, reason) VALUES ('${TENANT}', '${x.order}', '${STAFF}', 'POINT_CHARGE_RESOLVED', 'x'); ROLLBACK;`, DB);
      expect(other.ok, other.message ?? '').toBe(true);
    });

    describe('P1-02: tchefood_list_point_payments', () => {
      const LIST_TERMINAL = '68686868-6868-4868-8868-686868686868';
      type Item = { payment_id: string; order_id: string; charge_id: string | null; idempotency_key: string; amount: number; method: string; nsu: string | null;
        authorization_code: string | null; status: string; created_at: string; refunded_at: string | null; refund_audit_id: string | null; refunded_by_manager_id: string | null };
      type Page = { items: Item[]; next_cursor: string | null };
      const listQ = (args: { from?: string; to?: string; search?: string; cursor?: string | null; limit?: number }) =>
        `SELECT tchefood_list_point_payments(${args.from ? `'${args.from}'` : 'NULL'}, ${args.to ? `'${args.to}'` : 'NULL'}, ${args.search ? `'${args.search}'` : 'NULL'}, ${args.cursor ? `'${args.cursor}'` : 'NULL'}${args.limit !== undefined ? `, ${args.limit}` : ''})`;
      const list = (args: Parameters<typeof listQ>[0], tenant = LATE_TENANT) => json<Page>(asDevice(listQ(args), tenant));
      /** Pagamento do Mercado Pago gravado direto (o leitor não confere a origem), com a hora pedida. */
      const seed = (order: string, ago: string, amount: number, status = 'APPROVED', k = key('lp'), nsu = `N${crypto.randomUUID().slice(0, 6)}`) => {
        const id = crypto.randomUUID();
        sql(`BEGIN; SET LOCAL session_replication_role = replica;
             INSERT INTO payments (id, order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, nsu, authorization_code, idempotency_key, created_at)
             VALUES ('${id}', '${order}', '${LATE_TENANT}', '${LATE_STAFF}', '${LIST_TERMINAL}', ${amount}, 'CREDIT', '${status}', 'MERCADO_PAGO', '${nsu}', 'AUTL', '${k}', clock_timestamp() - INTERVAL '${ago}');
             COMMIT;`);
        return { id, key: k, nsu };
      };
      let order = '';
      let rows: { id: string; key: string; nsu: string }[] = [];
      let refunded: { id: string; key: string; nsu: string };
      let refundAudit = '';
      let chargeId = '';

      beforeAll(() => {
        sql(`INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${LIST_TERMINAL}', '${LATE_TENANT}', 'Point da lista', 'LIST-POINT', 'MERCADO_PAGO') ON CONFLICT (id) DO NOTHING;`);
        order = withItems(1000, LATE_TENANT, LATE_TABLE, LATE_STAFF);
        rows = [seed(order, '1 hour', 10), seed(order, '2 hours', 12.5), seed(order, '3 hours', 13), seed(order, '45 days', 14), seed(order, '90 days', 15)];
        refunded = seed(order, '30 minutes', 16, 'REFUNDED', 'lp-estornado-xyz', 'NSU-ESTORNO-1');
        chargeId = sql(`BEGIN; SET LOCAL session_replication_role = replica;
          INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, external_order_id, external_payment_id)
          VALUES ('${LATE_TENANT}', '${refunded.key}', '${order}', '${LIST_TERMINAL}', 'mercado_pago_point', 'LIST-POINT', 'CREDIT', 1600, 'refunded', 'ORD-LISTA-777', 'NSU-ESTORNO-1') RETURNING id; COMMIT;`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l))[0]!;
        // Com a trava da loja tomada, como as funções do servidor gravam este registro (GPT r17 P2-01).
        refundAudit = sql(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('tchefood_manager_pin:' || '${LATE_TENANT}'));
          INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata)
          VALUES ('${LATE_TENANT}', '${order}', '${LATE_STAFF}', '${LATE_STAFF}', 'POINT_PAYMENT_REFUNDED', 'estorno conferido', '{"payment_id":"${refunded.id}"}') RETURNING id; COMMIT;`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l))[0]!;
        // Pagamento fora do Mercado Pago (não aparece) e pagamento do Mercado Pago de outra loja (não aparece).
        sql(`BEGIN; SET LOCAL session_replication_role = replica;
             INSERT INTO payments (order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key) VALUES ('${order}', '${LATE_TENANT}', '${LATE_STAFF}', 5, 'CASH', 'APPROVED', 'CASH_DESK', '${key('lpc')}');
             COMMIT;`);
      });

      it('só os pagamentos do Mercado Pago da loja do token, do mais novo ao mais antigo, inclusive de meses atrás; o estornado traz quando e quem', () => {
        const page = list({ limit: 200 });
        expect(page.next_cursor).toBeNull();
        expect(page.items.map((i) => i.payment_id)).toEqual([refunded.id, ...rows.map((r) => r.id)]);
        const r = page.items[0]!;
        expect(r).toMatchObject({ order_id: order, charge_id: chargeId, idempotency_key: refunded.key, amount: 16, method: 'CREDIT', nsu: 'NSU-ESTORNO-1',
          authorization_code: 'AUTL', status: 'REFUNDED', refund_audit_id: refundAudit, refunded_by_manager_id: LATE_STAFF });
        expect(r.refunded_at).toBe(sql(`SELECT to_jsonb(created_at) #>> '{}' FROM audit_logs WHERE id = '${refundAudit}'`));
        expect(page.items[1]).toMatchObject({ refunded_at: null, refund_audit_id: null, refunded_by_manager_id: null, charge_id: null });
        expect(Object.keys(r).sort()).toEqual(['amount', 'authorization_code', 'charge_id', 'created_at', 'idempotency_key', 'method', 'nsu', 'order_id',
          'payment_id', 'refund_audit_id', 'refunded_at', 'refunded_by_manager_id', 'status']);
        // Outra loja não vê nenhum deles.
        const theirs = list({ limit: 200 }, OTHER).items.map((i) => i.payment_id);
        for (const id of [refunded.id, ...rows.map((x) => x.id)]) expect(theirs).not.toContain(id);
        // Período: de 50 dias atrás até 2 dias atrás, só o de 45 dias.
        const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
        expect(list({ from: day(50), to: day(2) }).items.map((i) => i.payment_id)).toEqual([rows[3]!.id]);
        expect(asRole('anon', listQ({}))).toMatchObject({ ok: false, sqlstate: '42501' });
      });

      it('páginas por (created_at, id), sem repetir nem pular; cursor inválido e limite fora de 1..200: TF006', () => {
        const all = list({ limit: 200 }).items.map((i) => i.payment_id);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 10; i += 1) {
          const page: Page = list({ limit: 2, cursor });
          seen.push(...page.items.map((x) => x.payment_id));
          expect(page.items.length).toBeLessThanOrEqual(2);
          cursor = page.next_cursor;
          if (!cursor) break;
        }
        expect(seen).toEqual(all);
        expect(list({}).items.length).toBe(all.length); // padrão 50
        for (const bad of [listQ({ cursor: 'lixo' }), listQ({ limit: 0 }), listQ({ limit: 201 })]) {
          expect(asDevice(bad, LATE_TENANT)).toMatchObject({ ok: false, sqlstate: 'TF006' });
        }
      });

      it('busca por NSU, chave, ordem do Mercado Pago e valor (com ponto ou vírgula); curingas são texto', () => {
        const ids = (search: string) => list({ search, limit: 200 }).items.map((i) => i.payment_id);
        expect(ids('ESTORNO-1')).toEqual([refunded.id]);
        expect(ids('estornado-xy')).toEqual([refunded.id]);
        expect(ids('LISTA-777')).toEqual([refunded.id]);
        expect(ids('12,50')).toEqual([rows[1]!.id]);
        expect(ids('12.50')).toEqual([rows[1]!.id]);
        expect(ids(rows[2]!.nsu)).toEqual([rows[2]!.id]);
        expect(ids('%')).toEqual([]);
        expect(ids('_')).toEqual([]);
      });
    });

    describe('GPT r11 P2-01: tchefood_list_point_refunds (pela data do estorno)', () => {
      const RT = '69696969-6969-4969-8969-696969696969';
      type Page = { items: { payment_id: string; refunded_at: string; refund_audit_id: string; status: string; created_at: string; amount: number }[]; next_cursor: string | null };
      const q = (from: string | null, to: string | null, cursor: string | null = null, limit?: number) =>
        `SELECT tchefood_list_point_refunds(${from ? `'${from}'` : 'NULL'}, ${to ? `'${to}'` : 'NULL'}, ${cursor ? `'${cursor}'` : 'NULL'}${limit !== undefined ? `, ${limit}` : ''})`;
      const page = (from: string | null, to: string | null, cursor: string | null = null, limit?: number, tenant = LATE_TENANT) => json<Page>(asDevice(q(from, to, cursor, limit), tenant));
      const seed = (ago: string, status: string, refundAgo: string | null) => {
        const id = crypto.randomUUID();
        const order = withItems(1000, LATE_TENANT, LATE_TABLE, LATE_STAFF);
        sql(`BEGIN; SET LOCAL session_replication_role = replica;
             INSERT INTO payments (id, order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, nsu, authorization_code, idempotency_key, created_at)
             VALUES ('${id}', '${order}', '${LATE_TENANT}', '${LATE_STAFF}', '${RT}', 100, 'CREDIT', '${status}', 'MERCADO_PAGO', 'N-${id.slice(0, 6)}', 'A', '${key('lr')}', clock_timestamp() - INTERVAL '${ago}');
             COMMIT;`);
        let audit: string | null = null;
        if (refundAgo) {
          audit = sql(`BEGIN; SET LOCAL session_replication_role = replica;
            INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata, created_at)
            VALUES ('${LATE_TENANT}', '${order}', '${LATE_STAFF}', '${LATE_STAFF}', 'POINT_PAYMENT_REFUNDED', 'estorno conferido', '{"payment_id":"${id}"}', clock_timestamp() - INTERVAL '${refundAgo}') RETURNING id; COMMIT;`)
            .split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l))[0]!;
        }
        return { id, audit };
      };
      let old40: { id: string; audit: string | null };
      let recent: { id: string; audit: string | null };
      let yesterday: { id: string; audit: string | null };
      beforeAll(() => {
        sql(`INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${RT}', '${LATE_TENANT}', 'Point estornos', 'REF-POINT', 'MERCADO_PAGO') ON CONFLICT (id) DO NOTHING;`);
        old40 = seed('40 days', 'REFUNDED', '1 hour'); // venda de 40 dias, estornada hoje
        recent = seed('3 hours', 'REFUNDED', '2 hours');
        yesterday = seed('10 days', 'REFUNDED', '30 hours');
        seed('5 hours', 'APPROVED', null);
      });

      it('venda de 40 dias estornada hoje aparece no período de hoje (pela hora do estorno no servidor); a de ontem não; outra loja não vê; anon 42501', () => {
        const from = new Date(Date.now() - 20 * 3_600_000).toISOString();
        const items = page(from, null).items;
        const ids = items.map((i) => i.payment_id);
        expect(ids).toContain(old40.id);
        expect(ids).toContain(recent.id);
        expect(ids).not.toContain(yesterday.id);
        const o = items.find((i) => i.payment_id === old40.id)!;
        expect(o).toMatchObject({ status: 'REFUNDED', refund_audit_id: old40.audit, amount: 100 });
        expect(o.refunded_at).toBe(sql(`SELECT to_jsonb(created_at) #>> '{}' FROM audit_logs WHERE id = '${old40.audit}'`));
        expect(Date.parse(o.created_at)).toBeLessThan(Date.now() - 39 * 86_400_000);
        expect(page(from, null, null, 200, OTHER).items.map((i) => i.payment_id)).not.toContain(old40.id);
        expect(asRole('anon', q(null, null))).toMatchObject({ ok: false, sqlstate: '42501' });
      });

      it('páginas por (refunded_at, id do registro) sem repetir nem pular; cursor e limite inválidos: TF006', () => {
        const all = page(null, null).items.map((i) => i.payment_id);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 50; i += 1) {
          const p: Page = page(null, null, cursor, 1);
          seen.push(...p.items.map((x) => x.payment_id));
          cursor = p.next_cursor;
          if (!cursor) break;
        }
        expect(seen).toEqual(all);
        for (const bad of [q(null, null, 'lixo'), q(null, null, null, 0), q(null, null, null, 201)]) {
          expect(asDevice(bad, LATE_TENANT)).toMatchObject({ ok: false, sqlstate: 'TF006' });
        }
      });
    });

    describe('a verificar 5: reenvio do pagamento com o mesmo id (tchefood_payment_replay_ok)', () => {
      const row = (id: string) => JSON.parse(sql(`SELECT row_to_json(p)::text FROM payments p WHERE id = '${id}'`)) as Record<string, unknown>;
      const replay = (base: Record<string, unknown>, over: Record<string, unknown>) => register(JSON.stringify({ ...base, ...over }));
      const variants: [string, Record<string, unknown>][] = [
        ['chave', { idempotency_key: 'outra-chave' }], ['forma', { method: 'DEBIT' }], ['credenciadora', { acquirer: 'STONE' }],
        ['NSU', { nsu: 'OUTRO-NSU' }], ['maquininha', { terminal_id: STONE_TERMINAL }], ['série da maquininha', { terminal_serial: 'OUTRA' }],
      ];

      it('mesmo status: só o mesmo pagamento devolve o gravado; chave, forma, credenciadora, NSU, autorização ou maquininha diferentes: TF006 replay_mismatch', () => {
        const order = withItems(100);
        const ch = paidCharge(order, 3000);
        const id = sql(`SELECT id FROM payments WHERE idempotency_key = '${ch.key}'`);
        const base = row(id);
        const before = sql(`SELECT row_to_json(p)::text FROM payments p WHERE id = '${id}'`);
        expect(last(replay(base, {}))).toBe(id);
        // Campos que não identificam o pagamento (hora, gorjeta, campos só do aparelho) não contam.
        expect(last(replay(base, { created_at: new Date().toISOString(), paid_item_ids: [], withdrawn_reason: null }))).toBe(id);
        const regQ = (over: Record<string, unknown>) => `SELECT tchefood_register_payment('${JSON.stringify({ ...base, ...over })}'::jsonb)`;
        for (const [label, over] of [...variants, ['autorização', { authorization_code: 'OUTRA' }], ['sem NSU', { nsu: null }]] as [string, Record<string, unknown>][]) {
          expect(detailOf(regQ(over)), label).toBe('TF006|replay_mismatch');
        }
        expect(sql(`SELECT row_to_json(p)::text FROM payments p WHERE id = '${id}'`)).toBe(before);
        for (const [label, over] of [['conta', { order_id: withItems(10) }], ['valor', { amount: 29.99 }], ['status', { status: 'DECLINED' }]] as const) {
          expect(replay(base, over), label).toMatchObject({ ok: false });
        }
        // Vazio e NULL são o mesmo (o aparelho manda null; texto vazio ou só espaço vale igual).
        const cashOrder = withItems(100);
        const cashJ = payment(cashOrder, 10, { idempotency_key: key('rpl') });
        expect(pay(cashJ).ok).toBe(true);
        const cashId = (JSON.parse(cashJ) as { id: string }).id;
        expect(last(register(JSON.stringify({ ...JSON.parse(cashJ), nsu: '', authorization_code: '  ', terminal_serial: '' })))).toBe(cashId);
        expect(last(register(cashJ))).toBe(cashId);
      });

      it('estornado reenviado como aprovado: só o mesmo pagamento (conta, valor, forma, credenciadora, NSU, chave e maquininha)', () => {
        const order = withItems(100);
        const ch = paidCharge(order, 3000);
        const id = sql(`SELECT id FROM payments WHERE idempotency_key = '${ch.key}'`);
        const base = row(id);
        expect(refundPoint(ch.id).ok).toBe(true);
        const approved = { ...base, status: 'APPROVED' };
        expect(last(replay(approved, {}))).toBe(id);
        for (const [label, over] of [...variants, ['conta', { order_id: withItems(10) }], ['valor', { amount: 29.99 }]] as [string, Record<string, unknown>][]) {
          expect(replay(approved, over), label).toMatchObject({ ok: false });
        }
        expect(sql(`SELECT status FROM payments WHERE id = '${id}'`)).toBe('REFUNDED');
      });
    });
  });
});
