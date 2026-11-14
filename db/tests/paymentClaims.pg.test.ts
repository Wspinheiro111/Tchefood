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
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
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
const LATE_TERMINAL = '68686868-6868-4868-8868-686868686868';
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
function withItems(balance: number, tenant = TENANT, table = TABLE, staff = STAFF): string {
  seq += 1;
  const id = `f0f0f0f0-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${id}', '${tenant}', '${table}', '${staff}');
       BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
       VALUES ('${id}', gen_random_uuid(), '${staff}', 1, ${balance}, ${balance}, 'NONE');
       UPDATE orders SET charge_service_fee = false, subtotal_items = ${balance}, total_amount = ${balance}, paid_amount = 0, remaining_balance = ${balance} WHERE id = '${id}';
       COMMIT;`);
  return id;
}
const bal = (order: string) => Number(sql(`SELECT round(remaining_balance * 100)::bigint FROM orders WHERE id = '${order}'`));
const key = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;

const claimQ = (k: string, order: string, method: string, acquirer: string, cents: number, expected: number | string, staff = STAFF) =>
  `SELECT tchefood_claim_payment('${k}', '${order}', '${method}', '${acquirer}', ${cents}, ${expected}, '${staff}')`;
const claim = (k: string, order: string, method: string, acquirer: string, cents: number, expected?: number | string, staff = STAFF, tenant = TENANT) =>
  asDevice(claimQ(k, order, method, acquirer, cents, expected ?? bal(order), staff), tenant);
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
const rawClaim = (k: string, order: string, method: string, acquirer: string, cents: number, staff = STAFF, tenant = TENANT) =>
  sql(`INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
       VALUES ('${tenant}', '${k}', '${order}', '${method}', '${acquirer}', ${cents}, '${staff}') RETURNING id;`);

type Reservation = { reserved_cents: number; point_cents: number; claims_cents: number; open_charges: number; manual_review: boolean;
  charges: { idempotency_key: string; status: string; amount_cents: number; raw_status_detail: string | null; has_payment: boolean }[];
  claims: { idempotency_key: string; amount_cents: number; method: string; acquirer: string; created_at: string; created_by: string; created_by_name: string | null }[] };
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
function mpPayment(id: string): PsqlResult {
  const c = sql(`SELECT order_id || '|' || amount_cents || '|' || external_payment_id || '|' || authorization_code || '|' || idempotency_key FROM terminal_charges WHERE id = '${id}'`).split('|');
  return psql(target!, `INSERT INTO payments (order_id, tenant_id, waiter_id, terminal_id, amount, method, status, acquirer, acquirer_cnpj, card_brand, nsu, authorization_code, terminal_serial, idempotency_key)
                        VALUES ('${c[0]}', '${TENANT}', '${STAFF}', '${TERMINAL}', ${Number(c[1]) / 100}, 'CREDIT', 'APPROVED', 'MERCADO_PAGO', '10573521000191', 'VISA', '${c[2]}', '${c[3]}', '${MP_ID}', '${c[4]}');`, DB);
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
const resolve = (id: string, from: string, to: string, patch = '{}', evidence?: string) =>
  psql(target!, `${resolveQ(id, from, to, patch, evidence ?? `{"authorization_audit_id":"${authorized(sql(`SELECT idempotency_key FROM terminal_charges WHERE id = '${id}'`))}","operation_id":"op-1","mp_status":"x"}`)};`, DB);
const receiptPatch = (cents: number, nsu = `N${crypto.randomUUID().slice(0, 6)}`) =>
  `{"external_payment_id":"${nsu}","paid_amount_cents":${cents},"card_brand":"VISA","authorization_code":"AUTR1","raw_status":"processed","raw_status_detail":"accredited"}`;

describe.skipIf(!target)('auditoria r5: reserva de pagamento e fim verificado da Point no banco real', () => {
  beforeAll(() => {
    applySchema(target!, DB);
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
      expect(Object.keys(r).sort()).toEqual(['amount_cents', 'id', 'idempotency_key', 'status']);
      expect(r).toMatchObject({ idempotency_key: k, status: 'open', amount_cents: 6000 });
      expect(claimField(k, `tenant_id || '|' || order_id || '|' || method || '|' || acquirer || '|' || created_by`)).toBe(`${TENANT}|${order}|CASH|CASH_DESK|${STAFF}`);
      const read = reservation(order);
      expect(read).toMatchObject({ reserved_cents: 6000, point_cents: 0, claims_cents: 6000, open_charges: 0, manual_review: false, charges: [] });
      // Revisão: a leitura lista as reservas abertas (quem pediu, quando, forma e credenciadora).
      expect(read.claims).toEqual([{ idempotency_key: k, amount_cents: 6000, method: 'CASH', acquirer: 'CASH_DESK',
        created_at: read.claims[0].created_at, created_by: STAFF, created_by_name: 'Caixa' }]);
      expect(Date.parse(read.claims[0].created_at)).toBe(Date.parse(claimField(k, `to_jsonb(created_at) #>> '{}'`)));
      // A Point vê os R$ 40,00 livres (o saldo da conta não mudou: a reserva não é pagamento).
      expect(openPoint(key('pt'), order, 4001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      const pk = key('pt');
      expect(openPoint(pk, order, 4000).ok).toBe(true);
      const after = reservation(order);
      expect(after).toMatchObject({ reserved_cents: 10000, point_cents: 4000, claims_cents: 6000, open_charges: 1 });
      expect(after.charges).toEqual([{ idempotency_key: pk, status: 'creating', amount_cents: 4000, raw_status_detail: null, has_payment: false }]);
      // E outra reserva não passa da reserva única.
      expect(cash(key('cash'), order, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
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
        ['chave nula', `SELECT tchefood_claim_payment(NULL, '${order}', 'CASH', 'CASH_DESK', 100, 10000, '${STAFF}')`],
        ['chave com espaço', claimQ('a b', order, 'CASH', 'CASH_DESK', 100, 10000)],
        ['chave longa', claimQ('x'.repeat(51), order, 'CASH', 'CASH_DESK', 100, 10000)],
        ['conta nula', `SELECT tchefood_claim_payment('k-null-order', NULL, 'CASH', 'CASH_DESK', 100, 10000, '${STAFF}')`],
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
      const r = asDevice(`SELECT tchefood_claim_payment('k-who', '${order}', 'CASH', 'CASH_DESK', 100, 10000, ${who})`);
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
      // Pagamento já gravado com a chave (sem reserva, na loja sem Point): a chave não vira reserva.
      const otherOrder = withItems(100, OTHER, OTHER_TABLE, OTHER_STAFF);
      const paid = JSON.parse(payment(otherOrder, 10, { tenant_id: OTHER, waiter_id: OTHER_STAFF })) as { idempotency_key: string };
      const r = register(JSON.stringify(paid), OTHER);
      expect(r.ok, r.message ?? '').toBe(true);
      const again = claim(paid.idempotency_key, otherOrder, 'CASH', 'CASH_DESK', 100, undefined, OTHER_STAFF, OTHER);
      expect(again).toMatchObject({ ok: false, sqlstate: 'TF009' });
      expect(again.message).toContain('já é de um pagamento gravado');
    });

    it('permissões: anon não chama, token sem loja não reserva, o aparelho só lê as reservas da própria loja e não grava nem altera nenhuma', () => {
      const order = withItems(100);
      const k = key('perm');
      expect(asRole('anon', claimQ(k, order, 'CASH', 'CASH_DESK', 100, 10000))).toMatchObject({ ok: false, sqlstate: '42501' });
      for (const fn of [`tchefood_release_payment_claim('${k}', '${STAFF}', 'motivo')`, `tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'motivo longo o bastante')`]) {
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
      const swap = psql(target!, `UPDATE payments SET idempotency_key = '${k}' WHERE id = '${id}';`, DB);
      expect(swap).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(swap.message).toContain('reserva de pagamento de outra conta');
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

    it('reserva liberada: não cobre mais pagamento nenhum; na loja com Point o pagamento com a chave dela é recusado (TF010)', () => {
      const order = withItems(100);
      const k = key('rel');
      expect(cash(k, order, 6000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'cliente desistiu')`).ok).toBe(true);
      expect(cash(key('c2'), order, 7000).ok).toBe(true); // a liberada não reserva mais
      for (const amount of [30.01, 30, 1]) {
        const r = register(payment(order, amount, { idempotency_key: k }));
        expect(r, String(amount)).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(r.message, String(amount)).toContain('precisa da reserva no servidor');
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
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'ab')`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', NULL)`)).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${INACTIVE}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${OTHER_STAFF}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(asDevice(`SELECT tchefood_release_payment_claim('nao-existe', '${STAFF}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      // Outra loja não acha a reserva desta.
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${OTHER_STAFF}', 'desistiu')`, OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(claimField(k, 'status')).toBe('open');
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
      // Revisão P2-A: sem PIN, só quem pediu a reserva libera; outro operador da loja recebe TF004.
      const notMine = asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF_B}', 'maquininha recusou')`);
      expect(notMine).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(notMine.message).toContain('só quem pediu a reserva libera sem PIN');
      expect(claimField(k, 'status')).toBe('open');
      const first = json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', '  maquininha recusou  ')`));
      expect(first).toMatchObject({ id: created.id, idempotency_key: k, status: 'released', amount_cents: 6000 });
      expect(claimField(k, `released_by || '|' || release_reason || '|' || (release_audit_id = '${first.release_audit_id}')`)).toBe(`${STAFF}|maquininha recusou|true`);
      expect(sql(`SELECT performed_by_user_id || '|' || order_id || '|' || reason || '|' || (authorized_by_manager_id IS NULL) FROM audit_logs WHERE id = '${first.release_audit_id}'`))
        .toBe(`${STAFF}|${order}|maquininha recusou|true`);
      // Já liberada: o reenvio devolve como está (de qualquer operador da loja).
      expect(json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF_B}', 'outro motivo')`))).toEqual(first);
      const again = json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'outro motivo')`));
      expect(again).toEqual(first);
      expect(json(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'reserva presa do aparelho')`))).toEqual(first);
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
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(asDevice(`SELECT tchefood_release_payment_claim_manager('${k}', '${STAFF}', '${MANAGER_PIN}', 'reserva presa do aparelho')`)).toMatchObject({ ok: false, sqlstate: 'TF007' });
      expect(claimField(k, 'status')).toBe('consumed');
      expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(0);
    });

    it('gerente: PIN certo libera com o gerente no registro, também a reserva pedida por outro operador; motivo curto TF006', () => {
      const order = withItems(100);
      const k = key('mgr');
      expect(claim(k, order, 'CASH', 'CASH_DESK', 2000, undefined, STAFF_B).ok).toBe(true);
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
      expect(json(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'desistiu')`)).status).toBe('released');
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
      // Liberação primeiro: o pagamento com a chave dela é recusado (TF010: a reserva liberada não cobre nada).
      let order = withItems(100);
      let k = key('rp');
      expect(cash(k, order, 6000).ok).toBe(true);
      expect(cash(key('o'), order, 4000).ok).toBe(true);
      let [r, p] = await contend(lockOrder(order), [
        deviceQ(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'desistiu')`), deviceQ(registerQ(payment(order, 60, { idempotency_key: k })))]);
      expect(lastOverlap).toBe(2);
      expect(r).toBe('ok');
      expect(p).toMatch(/^recusado TF010: .*precisa da reserva no servidor/);
      expect(claimField(k, 'status')).toBe('released');
      expect(reservation(order)).toMatchObject({ claims_cents: 4000, reserved_cents: 4000 });
      expect(bal(order)).toBe(10000);
      // Pagamento primeiro: a liberação encontra o pagamento (TF007) e não grava registro.
      order = withItems(100);
      k = key('pr');
      expect(cash(k, order, 6000).ok).toBe(true);
      [p, r] = await contend(lockOrder(order), [
        deviceQ(registerQ(payment(order, 60, { idempotency_key: k }))), deviceQ(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'desistiu')`)]);
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
      for (const fn of ['tchefood_claim_payment(VARCHAR, UUID, VARCHAR, VARCHAR, BIGINT, BIGINT, UUID)', 'tchefood_release_payment_claim(VARCHAR, UUID, TEXT)',
        'tchefood_release_payment_claim_manager(VARCHAR, UUID, VARCHAR, TEXT)', 'tchefood_point_reservation(UUID)']) {
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
      const refundQ = (id: string, k: string) => ownerQ(resolveQ(id, 'approved', 'refunded', '{}', `{"authorization_audit_id":"${authorized(k)}","operation_id":"op"}`));
      // Estorno primeiro: o pagamento que esperava encontra a cobrança estornada.
      let c = charge(withItems(100), 'approved', 2000);
      let [r, p] = await contend(lockCharge(c.id), [refundQ(c.id, c.key), payQ(c.id)]);
      expect(lastOverlap).toBe(2);
      expect(r).toBe('ok');
      expect(p).toMatch(/^recusado P0001: .*não aprovada/);
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
        { idempotency_key: mr.key, status: 'manual_review', amount_cents: 1000, raw_status_detail: 'DISPATCH_UNKNOWN', has_payment: false },
        { idempotency_key: ap.key, status: 'approved', amount_cents: 2000, raw_status_detail: null, has_payment: false },
      ]);
      expect(r.claims.map((x) => x.idempotency_key)).toEqual([ck]);
    });
  });

  describe('revisão P1-B, P2-A e P3: o banco exige a reserva na loja com Point; a reserva paga é final', () => {
    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;
    const needsClaim = /loja com Point: o pagamento fora dela precisa da reserva no servidor antes de receber/;
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
      sql(`INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
           VALUES ('${id}', '${order}', '${TENANT}', '${STAFF}', 10, 'CASH', 'PENDING', 'CASH_DESK', '${id}');`);
      expect(psql(target!, `UPDATE payments SET status = 'APPROVED' WHERE id = '${id}';`, DB)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(sql(`SELECT status FROM payments WHERE id = '${id}'`)).toBe('PENDING');
      // Com a reserva (o aparelho atualizado), o mesmo dinheiro entra.
      const ok = pay(payment(order, 10));
      expect(ok.ok, ok.message ?? '').toBe(true);
      expect(bal(order)).toBe(9000);
      // As funções novas de conferência não são do aparelho.
      for (const fn of ['tchefood_point_store(UUID)', 'tchefood_courier_cash_payment(payments)', 'tchefood_payment_claim_consume()']) {
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
      expect(asDevice(`SELECT tchefood_release_payment_claim('${ck}', '${STAFF}', 'cliente desistiu')`).ok).toBe(true);
      expect(reservation(order)).toMatchObject({ claims_cents: 0, claims: [] });
    });

    it('loja sem Point: pagamento sem reserva entra; com a Point cadastrada o banco passa a exigir, e segue exigindo depois que a maquininha que cobrou muda de credenciadora', () => {
      const order = withItems(100, LATE_TENANT, LATE_TABLE, LATE_STAFF);
      const late = (amount: number) => payment(order, amount, { tenant_id: LATE_TENANT, waiter_id: LATE_STAFF });
      const first = register(late(10), LATE_TENANT);
      expect(first.ok, first.message ?? '').toBe(true);
      sql(`INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${LATE_TERMINAL}', '${LATE_TENANT}', 'Point nova', 'LATE-POINT', 'MERCADO_PAGO');`);
      expect(register(late(10), LATE_TENANT)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(pay(late(10), LATE_TENANT).ok).toBe(true);
      // Cobrou na Point; depois o cadastro troca a maquininha de credenciadora: a loja continua sendo "com Point".
      sql(`INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status)
           VALUES ('${LATE_TENANT}', '${key('late')}', '${order}', '${LATE_TERMINAL}', 'mercado_pago_point', 'LATE-POINT', 'CREDIT', 100, 'rejected');`);
      sql(`UPDATE pos_terminals SET acquirer = 'STONE' WHERE id = '${LATE_TERMINAL}';`);
      expect(register(late(10), LATE_TENANT)).toMatchObject({ ok: false, sqlstate: 'TF010' });
      expect(bal(order)).toBe(8000);
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
      // O pagamento é estornado depois: a reserva continua consumida e não reserva nada.
      sql(`UPDATE payments SET status = 'REFUNDED' WHERE id = '${pid}';`);
      expect(bal(order)).toBe(10000);
      expect(claimField(k, 'status')).toBe('consumed');
      expect(reservation(order)).toMatchObject({ reserved_cents: 0, claims_cents: 0, claims: [] });
      // Os R$ 100,00 inteiros cabem de novo numa reserva nova (liberada logo em seguida).
      const full = key('full');
      expect(cash(full, order, 10000).ok).toBe(true);
      expect(asDevice(`SELECT tchefood_release_payment_claim('${full}', '${STAFF}', 'só conferindo')`).ok).toBe(true);
      // Liberar a reserva consumida: TF007, sem registro (aparelho de quem pediu e gerente).
      expect(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', 'desistiu')`)).toMatchObject({ ok: false, sqlstate: 'TF007' });
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
          expect(p).toMatch(/^recusado TF010: /);
          expect(claimField(k, 'status')).toBe('released');
          expect(audits('PAYMENT_CLAIM_RELEASED', 'idempotency_key', k)).toBe(1);
          expect(bal(order)).toBe(10000);
        }
      }
    }, 60_000);
  });

  it('as duas migrations rodam de novo sem erro', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.includes('mercado_pago') || x.includes('point_reserva')).sort()) {
      expect(() => psqlFile(target!, join(dir, f), DB), f).not.toThrow();
    }
    const order = withItems(100);
    expect(cash(key('mig'), order, 1000).ok).toBe(true);
    expect(reservation(order).claims_cents).toBe(1000);
  });
});
