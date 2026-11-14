/**
 * Point Smart (Mercado Pago) no banco de verdade: token fora do alcance do aparelho e
 * pagamento aprovado do Mercado Pago só com a cobrança aprovada no servidor
 * (db/schema_mercado_pago.sql).
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_mercado_pago_test';
const ROOT = join(__dirname, '..', '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const STAFF = '22222222-2222-4222-8222-222222222222';
const TABLE = '33333333-3333-4333-8333-333333333333';
const ORDER = '44444444-4444-4444-8444-444444444444';
const TERMINAL = '55555555-5555-4555-8555-555555555555';
const STONE_TERMINAL = '66666666-6666-4666-8666-666666666666';
const MP_ID = 'NEWLAND_N950__N950NCB801293324';
const ORDER2 = '77777777-7777-4777-8777-777777777777';
const CLOSED = '88888888-8888-4888-8888-888888888888';
const MANAGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INACTIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORDER3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MANAGER_PIN = '8642';
const OTHER_TERMINAL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_MP_ID = 'OUTRA-POINT';
const ORDER4 = 'abababab-abab-4bab-8bab-abababababab';
const ORDER5 = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const EX_MANAGER = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const OTHER_MANAGER = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const ORDER6 = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';

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
function asDevice(q: string, tenant = TENANT) {
  return psql(target!, `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${tenant}"}', true); ${q}; COMMIT;`, DB);
}

/** Saldo da conta na nuvem, em centavos (0 se a conta não existe): o que um aparelho sincronizado mandaria. */
const bal = (order: string) => `COALESCE((SELECT round(remaining_balance * 100)::bigint FROM orders WHERE id = '${order}'), 0)`;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uma sessão psql de verdade, com a entrada aberta: dá para mandar mais comandos depois. */
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

/** Sessões deste banco paradas esperando uma trava (pg_stat_activity). */
function waiting(): number {
  return Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${DB}' AND wait_event_type = 'Lock'`));
}

let gates = 424242;
/** Quantas sessões estavam comprovadamente juntas na última chamada de together()/contend(). */
let lastOverlap = 0;

/**
 * Roda `q` em `count` sessões ao mesmo tempo de verdade: uma sessão segura uma trava, as outras param nela,
 * e só quando o banco mostra TODAS esperando (pg_locks) a trava é solta e elas partem juntas.
 * Devolve a última linha da saída de cada uma. Erro em qualquer uma derruba o teste.
 */
async function together(count: number, q: string | ((i: number) => string)): Promise<string[]> {
  gates += 1;
  const gate = gates;
  const holder = session();
  holder.send(`SELECT pg_advisory_lock(${gate}); SELECT 'held';`);
  await until('trava do portão', () => holder.output().includes('held'));
  const runs = Array.from({ length: count }, (_, i) => {
    const s = session();
    s.end(`SELECT pg_advisory_lock_shared(${gate}); ${typeof q === 'function' ? q(i) : q}`);
    return s.done;
  });
  const parked = () => Number(sql(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = ${gate} AND NOT granted`));
  try {
    await until(`${count} sessões no portão`, () => parked() === count);
    lastOverlap = parked();
  } finally {
    holder.end(`SELECT pg_advisory_unlock(${gate});`);
  }
  await holder.done;
  return (await Promise.all(runs)).map((out) => out.split('\n').pop() ?? '');
}

/**
 * Disputa pela MESMA linha, na ordem dada: uma sessão trava a linha (`lock`, dentro de uma transação), cada
 * comando de `queries` entra numa sessão própria e só o seguinte entra depois que o banco mostra o anterior
 * parado na trava. Com todos esperando, a transação fecha e eles passam na ordem de chegada.
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

/** Volta a hora gravada da cobrança (o gatilho não deixa; só o dono do banco, sem gatilhos, para montar o teste). */
function backdate(key: string, interval: string): void {
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE terminal_charges SET created_at = NOW() - INTERVAL '${interval}', updated_at = NOW() - INTERVAL '${interval}' WHERE idempotency_key = '${key}'; COMMIT;`);
}

let n = 0;
function charge(over: Record<string, string | number | null> = {}): string {
  n += 1;
  const key = `chave-${n}`;
  const row: Record<string, string | number | null> = {
    tenant_id: TENANT, idempotency_key: key, order_id: ORDER, terminal_id: TERMINAL, provider: 'mercado_pago_point',
    external_terminal_id: MP_ID, method: 'CREDIT', amount_cents: 1000, status: 'approved', external_order_id: `ORD${n}`,
    external_payment_id: `12345${n}`, paid_amount_cents: 1000, card_brand: 'VISA', authorization_code: `AUT${n}`, ...over,
  };
  const cols = Object.keys(row);
  const vals = cols.map((c) => (row[c] === null ? 'NULL' : typeof row[c] === 'number' ? String(row[c]) : `'${row[c]}'`));
  sql(`INSERT INTO terminal_charges (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
  return key;
}

function pay(key: string, over: Record<string, string | number | null> = {}) {
  const row: Record<string, string | number | null> = {
    order_id: ORDER, tenant_id: TENANT, waiter_id: STAFF, terminal_id: TERMINAL, amount: 10, method: 'CREDIT', status: 'APPROVED',
    acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191', card_brand: 'VISA', nsu: `12345${key.split('-')[1]}`,
    authorization_code: `AUT${key.split('-')[1]}`, terminal_serial: MP_ID, idempotency_key: key, ...over,
  };
  const cols = Object.keys(row);
  const vals = cols.map((c) => (row[c] === null ? 'NULL' : typeof row[c] === 'number' ? String(row[c]) : `'${row[c]}'`));
  return psql(target!, `INSERT INTO payments (${cols.join(', ')}) VALUES (${vals.join(', ')});`, DB);
}

describe.skipIf(!target)('Mercado Pago Point no banco real', () => {
  beforeAll(() => {
    applySchema(target!, DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja', 'Loja Ltda', '11222333000181'), ('${OTHER}', 'Outra', 'Outra Ltda', '11444777000161');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF}', '${TENANT}', 'Caixa', 'CASHIER', '5162'),
                ('${MANAGER}', '${TENANT}', 'Gerente', 'MANAGER', '${MANAGER_PIN}'), ('${OTHER_STAFF}', '${OTHER}', 'Caixa da outra', 'CASHIER', '5162');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code, active) VALUES ('${INACTIVE}', '${TENANT}', 'Saiu', 'CASHIER', '7777', false);
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${TABLE}', '${TENANT}', 1, 'Mesa 1');
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${TERMINAL}', '${TENANT}', 'Point Smart', '${MP_ID}', 'MERCADO_PAGO'),
                ('${STONE_TERMINAL}', '${TENANT}', 'Stone 01', 'STONE-01', 'STONE'), ('${OTHER_TERMINAL}', '${OTHER}', 'Point da outra', '${OTHER_MP_ID}', 'MERCADO_PAGO');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code, active) VALUES ('${EX_MANAGER}', '${TENANT}', 'Gerente que saiu', 'MANAGER', '3197', false),
                ('${OTHER_MANAGER}', '${OTHER}', 'Gerente da outra', 'MANAGER', '9753', true);
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER}', '${TENANT}', '${TABLE}', '${STAFF}');
         INSERT INTO payment_provider_secrets (tenant_id, provider, access_token) VALUES ('${TENANT}', 'mercado_pago_point', 'APP_USR-segredo');
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER2}', '${TENANT}', '${TABLE}', '${STAFF}'), ('${CLOSED}', '${TENANT}', '${TABLE}', '${STAFF}'),
                ('${ORDER3}', '${TENANT}', '${TABLE}', '${STAFF}'), ('${ORDER4}', '${TENANT}', '${TABLE}', '${STAFF}'), ('${ORDER5}', '${TENANT}', '${TABLE}', '${STAFF}'),
                ('${ORDER6}', '${TENANT}', '${TABLE}', '${STAFF}');`);
    // ORDER3 tem saldo folgado: dezenas de cobranças de teste ficam em andamento nela, reservando.
    // Saldo de R$ 50,00 na ORDER2 sem montar itens (os totais só mudam pelo recálculo do banco).
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
         UPDATE orders SET total_amount = 50, remaining_balance = 50 WHERE id = '${ORDER2}';
         UPDATE orders SET total_amount = 100000, remaining_balance = 100000 WHERE id IN ('${ORDER3}', '${ORDER5}');
         UPDATE orders SET total_amount = 50, remaining_balance = 50 WHERE id = '${ORDER4}';
         UPDATE orders SET total_amount = 100, remaining_balance = 100 WHERE id = '${ORDER6}';
         UPDATE orders SET total_amount = 50, remaining_balance = 50, status = 'CLOSED' WHERE id = '${CLOSED}';
         COMMIT;`);
  }, 120_000);

  it('o aparelho não lê nem grava o token do Mercado Pago', () => {
    const read = asDevice('SELECT access_token FROM payment_provider_secrets');
    expect(read.ok).toBe(false);
    expect(read.sqlstate).toBe('42501');
    const write = asDevice(`INSERT INTO payment_provider_secrets (tenant_id, provider, access_token) VALUES ('${TENANT}', 'mercado_pago_point', 'x')`);
    expect(write.ok).toBe(false);
    expect(write.sqlstate).toBe('42501');
  });

  it('o aparelho lê só as cobranças da própria loja e não grava nem altera nenhuma', () => {
    const key = charge({ status: 'pending', external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null });
    expect(asDevice(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${key}'`).out).toContain('1');
    expect(asDevice(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${key}'`, OTHER).out).toContain('0');
    const upd = asDevice(`UPDATE terminal_charges SET status = 'approved' WHERE idempotency_key = '${key}'`);
    expect(upd.ok).toBe(false);
    expect(upd.sqlstate).toBe('42501');
    const ins = asDevice(`INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status)
                          VALUES ('${TENANT}', 'forjada', '${ORDER}', '${TERMINAL}', 'mercado_pago_point', '${MP_ID}', 'CREDIT', 1000, 'approved')`);
    expect(ins.ok).toBe(false);
    expect(ins.sqlstate).toBe('42501');
  });

  it('aprovado do Mercado Pago sem a cobrança no servidor é recusado', () => {
    const r = pay('chave-inexistente', { nsu: '999', authorization_code: 'X1' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('sem a cobrança no servidor');
  });

  it('cobrança não aprovada no servidor não vira pagamento aprovado', () => {
    for (const status of ['pending', 'at_terminal', 'manual_review', 'rejected', 'creating']) {
      const key = charge({ status });
      const r = pay(key);
      expect(r.ok, status).toBe(false);
      expect(r.message).toContain('não aprovada');
    }
  });

  it.each([
    ['valor', { amount: 9.99 }],
    ['forma', { method: 'DEBIT' }],
    ['NSU', { nsu: '000000' }],
    ['autorização', { authorization_code: 'OUTRA' }],
    ['maquininha', { terminal_id: STONE_TERMINAL }],
    ['serial', { terminal_serial: 'OUTRA' }],
  ])('pagamento que não confere com a cobrança aprovada (%s) é recusado', (_label, over) => {
    const key = charge();
    const r = pay(key, over);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('não confere');
  });

  it('cobrança aprovada com valor pago diferente nem é gravada (aprovado exige comprovante completo)', () => {
    expect(() => charge({ paid_amount_cents: 900 })).toThrow(/comprovante completo/);
    expect(() => charge({ authorization_code: null })).toThrow(/comprovante completo/);
    expect(() => charge({ card_brand: null })).toThrow(/comprovante completo/);
  });

  it.each([
    ['bandeira', { card_brand: 'MASTERCARD' }],
    ['CNPJ da credenciadora', { acquirer_cnpj: '16501555000157' }],
    ['sem CNPJ', { acquirer_cnpj: null }],
  ])('auditoria r1 P2-03: pagamento com %s diferente da cobrança aprovada é recusado', (_label, over) => {
    const key = charge(); // VISA
    const r = pay(key, over);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('não confere');
  });

  it('auditoria r1 P0-02: cobrança aprovada não é rebaixada nem perde o comprovante', () => {
    const key = charge();
    for (const set of [`status = 'at_terminal'`, `status = 'manual_review'`, `authorization_code = NULL`, `external_payment_id = '1'`, `card_brand = 'ELO'`]) {
      const r = psql(target!, `UPDATE terminal_charges SET ${set} WHERE idempotency_key = '${key}';`, DB);
      expect(r.ok, set).toBe(false);
      expect(r.message).toContain('não muda mais');
    }
    expect(sql(`SELECT status || '|' || authorization_code FROM terminal_charges WHERE idempotency_key = '${key}'`)).toBe(`approved|AUT${key.split('-')[1]}`);
    // Também recusado, cancelado e expirado são finais.
    const rej = charge({ status: 'rejected', external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null });
    expect(psql(target!, `UPDATE terminal_charges SET status = 'approved' WHERE idempotency_key = '${rej}';`, DB).ok).toBe(false);
  });

  it('auditoria r1 P0-02: gravação condicionada ao estado lido não sobrescreve quem passou na frente', () => {
    const key = charge({ status: 'at_terminal', external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null });
    // Primeira consulta aprova (leu at_terminal):
    expect(sql(`UPDATE terminal_charges SET status = 'approved', external_payment_id = '555', paid_amount_cents = 1000, card_brand = 'VISA', authorization_code = 'OK1'
                WHERE idempotency_key = '${key}' AND status = 'at_terminal' AND status NOT IN ('approved','rejected','cancelled','expired','refunded') RETURNING id;`)).not.toBe('');
    // Segunda, atrasada, também leu at_terminal: não acha a linha e não grava nada.
    expect(sql(`UPDATE terminal_charges SET status = 'at_terminal' WHERE idempotency_key = '${key}' AND status = 'at_terminal' RETURNING id;`)).toBe('');
    expect(sql(`SELECT status FROM terminal_charges WHERE idempotency_key = '${key}'`)).toBe('approved');
  });

  it('conta, maquininha, forma e valor da cobrança não mudam', () => {
    const key = charge({ status: 'pending', external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null });
    for (const set of [`amount_cents = 1`, `method = 'DEBIT'`, `order_id = '${ORDER2}'`, `external_terminal_id = 'X'`]) {
      expect(psql(target!, `UPDATE terminal_charges SET ${set} WHERE idempotency_key = '${key}';`, DB).ok, set).toBe(false);
    }
  });

  describe('auditoria r1 P1-02: abrir cobrança só para conta aberta e dentro do saldo', () => {
    const open = (key: string, order: string, cents: number) =>
      psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}', ${bal(order)});`, DB);

    it('conta inexistente, de outra loja ou fechada: recusa com código e não grava', () => {
      const missing = open('rpc-missing', '12345678-1234-4234-8234-123456789012', 100);
      expect(missing).toMatchObject({ ok: false, sqlstate: 'TF001' });
      // Outra loja, com a maquininha e o operador DELA, pedindo a conta desta: a conta não é dela (TF001).
      const other = psql(target!, `SELECT tchefood_open_terminal_charge('${OTHER}', 'rpc-other', '${ORDER2}', '${OTHER_TERMINAL}', '${OTHER_MP_ID}', 'CREDIT', 100, '${OTHER_STAFF}', ${bal(ORDER2)});`, DB);
      expect(other).toMatchObject({ ok: false, sqlstate: 'TF001' });
      expect(open('rpc-closed', CLOSED, 100)).toMatchObject({ ok: false, sqlstate: 'TF002' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key LIKE 'rpc-%'`)).toBe('0');
    });

    it('dentro do saldo grava "creating"; a cobrança em andamento reserva o valor; reenvio da chave devolve a mesma', () => {
      const a = open('rpc-a', ORDER2, 3000);
      expect(a.ok, a.message ?? '').toBe(true);
      expect(sql(`SELECT status || '|' || amount_cents FROM terminal_charges WHERE idempotency_key = 'rpc-a'`)).toBe('creating|3000');
      expect(open('rpc-a', ORDER2, 3000).out).toBe(a.out);
      // Saldo 50,00 com 30,00 em andamento: 20,01 não cabe, 20,00 cabe.
      const over = open('rpc-b', ORDER2, 2001);
      expect(over).toMatchObject({ ok: false, sqlstate: 'TF003' });
      expect(over.message).toContain('passa do saldo');
      expect(open('rpc-c', ORDER2, 2000).ok).toBe(true);
      expect(open('rpc-d', ORDER2, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
    });

    it('auditoria r2 P0-01: revisão manual e cobrança antiga em andamento seguem reservando; só o fim comprovado libera', () => {
      // rpc-a (30,00) em revisão manual e rpc-c (20,00) na fila há uma hora: o saldo continua tomado.
      sql(`UPDATE terminal_charges SET status = 'manual_review' WHERE idempotency_key = 'rpc-a';
           UPDATE terminal_charges SET status = 'pending' WHERE idempotency_key = 'rpc-c';`);
      backdate('rpc-c', '1 hour');
      expect(sql(`SELECT created_at < NOW() - INTERVAL '59 minutes' FROM terminal_charges WHERE idempotency_key = 'rpc-c'`)).toBe('t');
      expect(open('rpc-e', ORDER2, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      sql(`UPDATE terminal_charges SET status = 'cancelled' WHERE idempotency_key = 'rpc-c';`);
      expect(open('rpc-e', ORDER2, 2001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      // Auditoria r5 P1-01: a revisão manual só sai com o fim verificado no Mercado Pago (db/schema_point_reserva.sql,
      // testado em paymentClaims.pg.test.ts); o UPDATE direto é recusado. Aqui só monta o cenário, sem os gatilhos.
      expect(psql(target!, `UPDATE terminal_charges SET status = 'rejected' WHERE idempotency_key = 'rpc-a';`, DB).message).toContain('confirmação do Mercado Pago');
      sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE terminal_charges SET status = 'rejected' WHERE idempotency_key = 'rpc-a'; COMMIT;`);
    });

    it('aprovada sem pagamento gravado reserva; recusada e cancelada não reservam', () => {
      expect(open('rpc-e', ORDER2, 5000).ok).toBe(true);
      sql(`UPDATE terminal_charges SET status = 'approved', external_payment_id = '9', paid_amount_cents = 5000, card_brand = 'VISA', authorization_code = 'Z' WHERE idempotency_key = 'rpc-e';`);
      expect(open('rpc-f', ORDER2, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
    });

    it('o aparelho não chama a função (só a Edge Function, com a service role)', () => {
      const r = asDevice(`SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-dev', '${ORDER2}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1, NULL, ${bal(ORDER2)})`);
      expect(r.ok).toBe(false);
      expect(r.sqlstate).toBe('42501');
      const anon = psql(target!, `BEGIN; SET LOCAL ROLE anon; SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-anon', '${ORDER2}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1, NULL, ${bal(ORDER2)}); COMMIT;`, DB);
      expect(anon.sqlstate).toBe('42501');
      const svc = psql(target!, `BEGIN; SET LOCAL ROLE service_role; SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-svc', '${CLOSED}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1, '${STAFF}', ${bal(CLOSED)}); COMMIT;`, DB);
      expect(svc.sqlstate).toBe('TF002'); // executa (e recusa pela conta fechada)
    });

    it.each([
      ['sem operador', 'NULL'],
      ['operador inativo', `'${INACTIVE}'`],
      ['operador de outra loja', `'${OTHER_STAFF}'`],
      ['id que não existe', `'12345678-1234-4234-8234-123456789012'`],
    ])('auditoria r2 P2-02: %s não abre cobrança (TF004) e nada é gravado', (_label, who) => {
      const r = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-who', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, ${who}, ${bal(ORDER3)});`, DB);
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'rpc-who'`)).toBe('0');
    });
  });

  // Antes do bloco do PIN: o último teste dele bloqueia o PIN da loja por 60 s.
  describe('auditoria r3 P1-02/P1-03: posse do envio (um pedido por vez fala com o Mercado Pago)', () => {
    const open = (key: string) =>
      psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER3)});`, DB);
    const claim = (key: string, tenant = TENANT, lease = 30000) =>
      psql(target!, `SELECT tchefood_claim_point_dispatch('${tenant}', (SELECT id FROM terminal_charges WHERE idempotency_key = '${key}'), ${lease});`, DB);
    const field = (key: string, expr: string) => sql(`SELECT ${expr} FROM terminal_charges WHERE idempotency_key = '${key}'`);

    const begin = (key: string, attempt: number, tenant = TENANT, lease = 30000, allowFirst = true) =>
      psql(target!, `SELECT tchefood_begin_point_dispatch('${tenant}', (SELECT id FROM terminal_charges WHERE idempotency_key = '${key}'), ${attempt}, ${lease}, ${allowFirst});`, DB);
    const settle = (key: string, tenant = TENANT) =>
      psql(target!, `SELECT tchefood_settle_point_dispatch('${tenant}', (SELECT id FROM terminal_charges WHERE idempotency_key = '${key}'));`, DB);
    const timeout = (key: string, tenant = TENANT, wait = 120000) =>
      psql(target!, `SELECT tchefood_request_point_timeout('${tenant}', (SELECT id FROM terminal_charges WHERE idempotency_key = '${key}'), ${wait});`, DB);
    const expire = (key: string) => sql(`UPDATE terminal_charges SET dispatch_lease_until = NOW() - INTERVAL '1 second' WHERE idempotency_key = '${key}';`);
    const idOf = (key: string) => `(SELECT id FROM terminal_charges WHERE idempotency_key = '${key}')`;

    it('auditoria r3 P1-02: a posse não marca envio; com ela em vigor ninguém mais ganha; vencida, a repetição ganha a de número 2', () => {
      expect(open('lease-a').ok).toBe(true);
      expect(claim('lease-a').out).toBe('1');
      // Pedir a posse ainda não é mandar: dispatched_at só nasce na barreira (tchefood_begin_point_dispatch).
      expect(field('lease-a', `(dispatched_at IS NULL) || '|' || (dispatch_lease_until > NOW() + INTERVAL '25 seconds') || '|' || (dispatch_lease_until <= NOW() + INTERVAL '31 seconds')`)).toBe('true|true|true');
      expect(claim('lease-a').out).toBe('0');
      expect(claim('lease-a').out).toBe('0');
      expect(field('lease-a', 'dispatch_attempts')).toBe('1');
      expire('lease-a');
      expect(claim('lease-a').out).toBe('2');
      expect(field('lease-a', 'dispatched_at IS NULL')).toBe('t');
      expect(claim('lease-a').out).toBe('0');
    });

    it('auditoria r3 P1-02: no máximo 8 posses por cobrança; a nona não é dada', () => {
      expect(open('lease-cap').ok).toBe(true);
      for (let i = 1; i <= 8; i += 1) {
        expect(claim('lease-cap').out, `posse ${i}`).toBe(String(i));
        expire('lease-cap');
      }
      expect(claim('lease-cap').out).toBe('0');
      expect(field('lease-cap', 'dispatch_attempts')).toBe('8');
      // A barreira também não passa: a oitava posse venceu.
      expect(begin('lease-cap', 8).out).toBe('0');
    });

    it('auditoria r3 P1-03: a barreira antes do envio devolve 1 no primeiro envio, marca a hora e renova a posse', () => {
      expect(open('begin-a').ok).toBe(true);
      expect(claim('begin-a').out).toBe('1');
      // Posse quase vencendo: a barreira renova por inteiro a partir de agora.
      sql(`UPDATE terminal_charges SET dispatch_lease_until = NOW() + INTERVAL '2 seconds' WHERE idempotency_key = 'begin-a';`);
      expect(begin('begin-a', 1).out).toBe('1');
      expect(field('begin-a', `(dispatched_at IS NOT NULL) || '|' || (dispatched_at <= NOW()) || '|' || (dispatch_lease_until > NOW() + INTERVAL '25 seconds') || '|' || dispatch_attempts || '|' || status`))
        .toBe('true|true|true|1|creating');
      const first = field('begin-a', 'dispatched_at');
      // Posse vencida: quem a tinha não passa mais; a repetição (posse 2) passa como repetição e a hora do primeiro envio não muda.
      expire('begin-a');
      expect(begin('begin-a', 1).out).toBe('0');
      expect(claim('begin-a').out).toBe('2');
      expect(begin('begin-a', 1).out).toBe('0'); // a posse 1 não é mais a da linha
      expect(begin('begin-a', 3).out).toBe('0'); // nem uma que ninguém ganhou
      expect(begin('begin-a', 2).out).toBe('2');
      expect(field('begin-a', 'dispatched_at')).toBe(first);
      expect(field('begin-a', 'dispatch_attempts')).toBe('2');
    });

    it('auditoria r3 P1-03: a barreira não passa (0, sem gravar nada) sem posse, com encerramento pedido, com ordem, fora de "creating" ou de outra loja', () => {
      const untouched = (key: string) => expect(field(key, `(dispatched_at IS NULL) || '|' || dispatch_attempts`), key).toBe('true|1');
      // Sem ter pedido a posse.
      expect(open('begin-none').ok).toBe(true);
      expect(begin('begin-none', 0).out).toBe('0');
      expect(begin('begin-none', 1).out).toBe('0');
      expect(field('begin-none', `(dispatched_at IS NULL) || '|' || dispatch_attempts`)).toBe('true|0');
      // Encerramento por prazo gravado entre a posse e a barreira.
      expect(open('begin-timeout').ok).toBe(true);
      expect(claim('begin-timeout').out).toBe('1');
      backdate('begin-timeout', '121 seconds');
      expect(timeout('begin-timeout').out).toBe('1');
      expect(begin('begin-timeout', 1).out).toBe('0');
      untouched('begin-timeout');
      // Encerramento do gerente gravado entre a posse e a barreira.
      expect(open('begin-pin').ok).toBe(true);
      expect(claim('begin-pin').out).toBe('1');
      expect(psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', 'begin-pin', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`, DB).out).toMatch(/^[0-9a-f-]{36}$/);
      expect(begin('begin-pin', 1).out).toBe('0');
      untouched('begin-pin');
      // Ordem já ligada.
      expect(open('begin-order').ok).toBe(true);
      expect(claim('begin-order').out).toBe('1');
      sql(`UPDATE terminal_charges SET external_order_id = 'ORD-B' WHERE idempotency_key = 'begin-order';`);
      expect(begin('begin-order', 1).out).toBe('0');
      untouched('begin-order');
      // Fora de "creating".
      expect(open('begin-review').ok).toBe(true);
      expect(claim('begin-review').out).toBe('1');
      sql(`UPDATE terminal_charges SET status = 'manual_review' WHERE idempotency_key = 'begin-review';`);
      expect(begin('begin-review', 1).out).toBe('0');
      untouched('begin-review');
      // Outra loja, cobrança que não existe e prazo inválido.
      expect(open('begin-other').ok).toBe(true);
      expect(claim('begin-other').out).toBe('1');
      expect(begin('begin-other', 1, OTHER).out).toBe('0');
      untouched('begin-other');
      expect(psql(target!, `SELECT tchefood_begin_point_dispatch('${TENANT}', gen_random_uuid(), 1, 30000, true);`, DB).out).toBe('0');
      for (const lease of [10, 999, 600001]) {
        const bad = begin('begin-other', 1, TENANT, lease);
        expect(bad.ok, String(lease)).toBe(false);
        expect(bad.message).toContain('prazo de posse inválido');
      }
      expect(psql(target!, `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf('begin-other')}, 1, NULL, true);`, DB).ok).toBe(false);
      untouched('begin-other');
      expect(begin('begin-other', 1).out).toBe('1');
    });

    it('auditoria r4 P1-02: consulta de estado (p_allow_first = false) nunca faz o primeiro envio: devolve 0 e não grava nada', () => {
      expect(open('first-status').ok).toBe(true);
      expect(claim('first-status').out).toBe('1');
      const snapshot = () => field('first-status', `(dispatched_at IS NULL) || '|' || dispatch_lease_until || '|' || dispatch_attempts || '|' || updated_at || '|' || status`);
      const before = snapshot();
      // Posse em vigor, nada enviado: a consulta não manda, não marca a hora do envio e não renova a posse.
      for (let i = 0; i < 3; i += 1) expect(begin('first-status', 1, TENANT, 30000, false).out).toBe('0');
      expect(snapshot()).toBe(before);
      expect(before.startsWith('true|')).toBe(true);
      // A criação (true) faz o primeiro envio normalmente.
      expect(begin('first-status', 1, TENANT, 30000, true).out).toBe('1');
      const sentAt = field('first-status', 'dispatched_at');
      // Envio que já saiu, com a posse em vigor: a consulta pode repetir (2), e a hora do primeiro envio não muda.
      sql(`UPDATE terminal_charges SET dispatch_lease_until = NOW() + INTERVAL '2 seconds' WHERE idempotency_key = 'first-status';`);
      expect(begin('first-status', 1, TENANT, 30000, false).out).toBe('2');
      expect(field('first-status', `(dispatched_at = '${sentAt}') || '|' || (dispatch_lease_until > NOW() + INTERVAL '25 seconds')`)).toBe('true|true');
      // Posse vencida: nem a consulta passa.
      expire('first-status');
      expect(begin('first-status', 1, TENANT, 30000, false).out).toBe('0');
      expect(field('first-status', 'dispatched_at')).toBe(sentAt);
    });

    it('auditoria r4 P1-02: p_allow_first é obrigatório (NULL é recusado, sem gravar nada); a assinatura antiga de 4 argumentos não existe mais', () => {
      expect(open('first-null').ok).toBe(true);
      expect(claim('first-null').out).toBe('1');
      const bad = psql(target!, `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf('first-null')}, 1, 30000, NULL);`, DB);
      expect(bad.ok).toBe(false);
      expect(bad.message).toContain('primeiro envio');
      const old = psql(target!, `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf('first-null')}, 1, 30000);`, DB);
      expect(old).toMatchObject({ ok: false, sqlstate: '42883' });
      expect(field('first-null', `(dispatched_at IS NULL) || '|' || dispatch_attempts`)).toBe('true|1');
      expect(sql(`SELECT count(*) FROM pg_proc WHERE proname = 'tchefood_begin_point_dispatch'`)).toBe('1');
    });

    it('auditoria r4 P1-02: consulta de estado e criação disputando a mesma cobrança, nas duas ordens: só a criação faz o primeiro envio', async () => {
      for (let i = 0; i < 6; i += 1) {
        const key = `race-first-${i}`;
        expect(open(key).ok).toBe(true);
        expect(claim(key).out).toBe('1');
        const statusQ = `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf(key)}, 1, 30000, false);`;
        const createQ = `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf(key)}, 1, 30000, true);`;
        const statusFirst = i % 2 === 0;
        const out = await contend(`SELECT 1 FROM terminal_charges WHERE idempotency_key = '${key}' FOR UPDATE`, statusFirst ? [statusQ, createQ] : [createQ, statusQ]);
        expect(lastOverlap, key).toBe(2);
        const fromStatus = statusFirst ? out[0] : out[1];
        const fromCreate = statusFirst ? out[1] : out[0];
        // A criação sempre faz o primeiro envio; a consulta na frente não manda nada, a consulta atrás só repete.
        expect(fromCreate, key).toBe('1');
        expect(fromStatus, key).toBe(statusFirst ? '0' : '2');
        expect(field(key, `(dispatched_at IS NOT NULL) || '|' || dispatch_attempts`), key).toBe('true|1');
      }
    }, 60_000);

    it('auditoria r3 P1-03: barreira e encerramento disputando a mesma cobrança, nas duas ordens, 12 vezes: depois do encerramento gravado nada passa', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        const key = `race-begin-${i}`;
        const byPin = i % 4 >= 2;
        expect(open(key).ok).toBe(true);
        expect(claim(key).out).toBe('1');
        if (!byPin) backdate(key, '121 seconds');
        const beginQ = `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf(key)}, 1, 30000, true);`;
        const cancelQ = byPin
          ? `SELECT tchefood_authorize_point_cancel('${TENANT}', '${key}', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`
          : `SELECT tchefood_request_point_timeout('${TENANT}', ${idOf(key)}, 120000);`;
        const beginFirst = i % 2 === 0;
        const out = await contend(`SELECT 1 FROM terminal_charges WHERE idempotency_key = '${key}' FOR UPDATE`, beginFirst ? [beginQ, cancelQ] : [cancelQ, beginQ]);
        expect(lastOverlap, 'as duas sessões esperavam a mesma linha').toBe(2);
        const began = beginFirst ? out[0] : out[1];
        const cancelled = beginFirst ? out[1] : out[0];
        // O encerramento sempre fica gravado (não é barrado pelo envio).
        expect(cancelled, key).toMatch(byPin ? /^[0-9a-f-]{36}$/ : /^1$/);
        expect(field(key, 'cancel_reason'), key).toBe(byPin ? 'operator' : 'timeout');
        // Quem chegou primeiro à linha decide: a barreira na frente marca o envio; o encerramento na frente barra.
        expect(began, key).toBe(beginFirst ? '1' : '0');
        expect(field(key, 'dispatched_at IS NOT NULL'), key).toBe(beginFirst ? 't' : 'f');
        // Nunca: barreira passou E nada marcado, ou barreira barrada E envio marcado.
        expect(began !== '0', key).toBe(field(key, 'dispatched_at IS NOT NULL') === 't');
        // Depois do encerramento gravado: nem a barreira de novo, nem posse nova, nem com a posse vencida.
        expect(begin(key, 1).out, key).toBe('0');
        expire(key);
        expect(claim(key).out, key).toBe('0');
        expect(begin(key, 1).out, key).toBe('0');
        expect(begin(key, 2).out, key).toBe('0');
        expect(field(key, `dispatch_attempts || '|' || status`), key).toBe('1|creating');
        seen.add(`${byPin ? 'pin' : 'prazo'}:${beginFirst ? 'envio-antes' : 'encerramento-antes'}`);
      }
      expect([...seen].sort()).toEqual(['pin:encerramento-antes', 'pin:envio-antes', 'prazo:encerramento-antes', 'prazo:envio-antes']);
    }, 120_000);

    it('auditoria r3 P1-02: posse e encerramento disputando a mesma cobrança, 10 vezes: encerramento na frente = nenhuma posse', async () => {
      for (let i = 0; i < 10; i += 1) {
        const key = `race-claim-${i}`;
        expect(open(key).ok).toBe(true);
        backdate(key, '121 seconds');
        const claimQ = `SELECT tchefood_claim_point_dispatch('${TENANT}', ${idOf(key)}, 30000);`;
        const cancelQ = `SELECT tchefood_request_point_timeout('${TENANT}', ${idOf(key)}, 120000);`;
        const claimFirst = i % 2 === 0;
        const out = await contend(`SELECT 1 FROM terminal_charges WHERE idempotency_key = '${key}' FOR UPDATE`, claimFirst ? [claimQ, cancelQ] : [cancelQ, claimQ]);
        expect(lastOverlap).toBe(2);
        expect(claimFirst ? out[1] : out[0], key).toBe('1');
        expect(claimFirst ? out[0] : out[1], key).toBe(claimFirst ? '1' : '0');
        expect(field(key, 'dispatch_attempts'), key).toBe(claimFirst ? '1' : '0');
        // Com o encerramento gravado, a posse que saiu antes não passa da barreira.
        expect(begin(key, 1).out, key).toBe('0');
        expect(field(key, 'dispatched_at IS NULL'), key).toBe('t');
      }
    }, 120_000);

    it('oito pedidos ao mesmo tempo: só um ganha a posse', async () => {
      expect(open('lease-race').ok).toBe(true);
      const out = await together(8, `SELECT tchefood_claim_point_dispatch('${TENANT}', (SELECT id FROM terminal_charges WHERE idempotency_key = 'lease-race'), 30000);`);
      expect(lastOverlap, 'as 8 sessões partiram juntas').toBe(8);
      expect(out.sort()).toEqual(['0', '0', '0', '0', '0', '0', '0', '1']);
      expect(field('lease-race', 'dispatch_attempts')).toBe('1');
    }, 30_000);

    it('pedido de encerramento gravado: ninguém ganha a posse, nem com a anterior vencida, nem forçando no banco', () => {
      expect(open('lease-cancel').ok).toBe(true);
      expect(claim('lease-cancel').out).toBe('1');
      sql(`UPDATE terminal_charges SET dispatch_lease_until = NOW() - INTERVAL '1 second', cancel_reason = 'timeout', cancel_requested_at = NOW() WHERE idempotency_key = 'lease-cancel';`);
      expect(claim('lease-cancel').out).toBe('0');
      const forced = psql(target!, `UPDATE terminal_charges SET dispatch_attempts = dispatch_attempts + 1 WHERE idempotency_key = 'lease-cancel';`, DB);
      expect(forced.ok).toBe(false);
      expect(forced.message).toContain('não é mais enviada');
      // Nem esticar a posse que estava em vigor.
      const stretched = psql(target!, `UPDATE terminal_charges SET dispatch_lease_until = NOW() + INTERVAL '1 hour' WHERE idempotency_key = 'lease-cancel';`, DB);
      expect(stretched.ok).toBe(false);
      expect(stretched.message).toContain('não é mais enviada');
      // Nunca enviada com encerramento pedido: também não.
      expect(open('lease-never').ok).toBe(true);
      sql(`UPDATE terminal_charges SET cancel_reason = 'timeout', cancel_requested_at = NOW() WHERE idempotency_key = 'lease-never';`);
      expect(claim('lease-never').out).toBe('0');
      expect(field('lease-never', 'dispatched_at IS NULL')).toBe('t');
    });

    it('sem posse para cobrança com ordem, fora de "creating", de outra loja ou com prazo inválido; a contagem não volta', () => {
      expect(open('lease-order').ok).toBe(true);
      sql(`UPDATE terminal_charges SET external_order_id = 'ORDX' WHERE idempotency_key = 'lease-order';`);
      expect(claim('lease-order').out).toBe('0');
      expect(open('lease-review').ok).toBe(true);
      sql(`UPDATE terminal_charges SET status = 'manual_review' WHERE idempotency_key = 'lease-review';`);
      expect(claim('lease-review').out).toBe('0');
      expect(open('lease-other').ok).toBe(true);
      expect(claim('lease-other', OTHER).out).toBe('0');
      expect(claim('lease-other', TENANT, 10).ok).toBe(false);
      expect(claim('lease-other').out).toBe('1');
      const back = psql(target!, `UPDATE terminal_charges SET dispatch_attempts = 0 WHERE idempotency_key = 'lease-other';`, DB);
      expect(back.ok).toBe(false);
      expect(back.message).toContain('não volta');
    });

    it.each([
      ['tchefood_claim_point_dispatch', `'${TENANT}', gen_random_uuid(), 30000`],
      ['tchefood_begin_point_dispatch', `'${TENANT}', gen_random_uuid(), 1, 30000, true`],
      ['tchefood_settle_point_dispatch', `'${TENANT}', gen_random_uuid()`],
    ])('auditoria r3: o aparelho não chama %s (só a service role)', (fn, args) => {
      for (const role of ['authenticated', 'anon']) {
        const r = psql(target!, `BEGIN; SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
          SELECT ${fn}(${args}); COMMIT;`, DB);
        expect(r.sqlstate, role).toBe('42501');
      }
      const svc = psql(target!, `BEGIN; SET LOCAL ROLE service_role; SELECT ${fn}(${args}); COMMIT;`, DB);
      expect(svc.ok, svc.message ?? '').toBe(true);
    });

    it('auditoria r3 P1-01: encerramento por prazo decidido pelo relógio do banco: cedo demais não grava nada; depois grava uma vez', () => {
      expect(open('to-a').ok).toBe(true);
      expect(timeout('to-a').out).toBe('0');
      backdate('to-a', '119 seconds');
      expect(timeout('to-a').out).toBe('0');
      expect(field('to-a', `(cancel_reason IS NULL) || '|' || (cancel_requested_at IS NULL)`)).toBe('true|true');
      backdate('to-a', '121 seconds');
      expect(timeout('to-a').out).toBe('1');
      expect(field('to-a', `cancel_reason || '|' || (cancel_requested_by IS NULL) || '|' || (cancel_requested_at BETWEEN NOW() - INTERVAL '10 seconds' AND NOW()) || '|' || status`))
        .toBe('timeout|true|true|creating');
      const at = field('to-a', 'cancel_requested_at');
      expect(timeout('to-a').out).toBe('2');
      expect(field('to-a', 'cancel_requested_at')).toBe(at);
      // Prazo maior pedido pela função: a mesma cobrança de 121 s ainda é cedo para 180 s.
      expect(open('to-long').ok).toBe(true);
      backdate('to-long', '121 seconds');
      expect(timeout('to-long', TENANT, 180000).out).toBe('0');
      // Cobrança que já terminou: nada a gravar.
      expect(open('to-final').ok).toBe(true);
      backdate('to-final', '10 minutes');
      sql(`UPDATE terminal_charges SET status = 'expired' WHERE idempotency_key = 'to-final';`);
      expect(timeout('to-final').out).toBe('2');
      expect(field('to-final', 'cancel_reason IS NULL')).toBe('t');
      // Já encerrada pelo gerente: o prazo não troca o motivo.
      expect(open('to-pin').ok).toBe(true);
      backdate('to-pin', '10 minutes');
      expect(psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', 'to-pin', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`, DB).ok).toBe(true);
      expect(timeout('to-pin').out).toBe('2');
      expect(field('to-pin', 'cancel_reason')).toBe('operator');
    });

    it('auditoria r3 P1-01: prazo menor que 1 min ou inválido é recusado; outra loja não encerra (TF005); o aparelho não chama', () => {
      expect(open('to-guard').ok).toBe(true);
      backdate('to-guard', '10 minutes');
      for (const wait of ['0', '1000', '59999', '3600001', 'NULL']) {
        const bad = psql(target!, `SELECT tchefood_request_point_timeout('${TENANT}', ${idOf('to-guard')}, ${wait});`, DB);
        expect(bad.ok, wait).toBe(false);
        expect(bad.message).toContain('prazo de espera inválido');
      }
      expect(timeout('to-guard', OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(psql(target!, `SELECT tchefood_request_point_timeout('${TENANT}', gen_random_uuid(), 120000);`, DB)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      for (const role of ['authenticated', 'anon']) {
        const r = psql(target!, `BEGIN; SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
          SELECT tchefood_request_point_timeout('${TENANT}', ${idOf('to-guard')}, 120000); COMMIT;`, DB);
        expect(r.sqlstate, role).toBe('42501');
      }
      expect(field('to-guard', 'cancel_reason IS NULL')).toBe('t');
      expect(timeout('to-guard').out).toBe('1');
    });

    it('auditoria r3 P1-01: oito encerramentos por prazo ao mesmo tempo: um grava, os outros só confirmam, nenhum dá erro', async () => {
      expect(open('to-race').ok).toBe(true);
      backdate('to-race', '121 seconds');
      const out = await together(8, `SELECT tchefood_request_point_timeout('${TENANT}', ${idOf('to-race')}, 120000);`);
      expect(lastOverlap).toBe(8);
      expect(out.sort()).toEqual(['1', '2', '2', '2', '2', '2', '2', '2']);
      expect(field('to-race', 'cancel_reason')).toBe('timeout');
    }, 30_000);

    it('auditoria r3 P0-01: envio sem resposta só vai para revisão manual com TODAS as condições (encerramento pedido, envio feito, posse vencida, sem ordem)', () => {
      const state = (key: string) => field(key, `status || '|' || COALESCE(raw_status, '') || '|' || COALESCE(raw_status_detail, '')`);
      // Sem encerramento pedido.
      expect(open('st-nocancel').ok).toBe(true);
      expect(claim('st-nocancel').out).toBe('1');
      expect(begin('st-nocancel', 1).out).toBe('1');
      expire('st-nocancel');
      expect(settle('st-nocancel').out).toBe('f');
      expect(state('st-nocancel')).toBe('creating||');
      // Encerramento pedido, mas nenhum envio saiu (isso é "voided_before_send", não revisão).
      expect(open('st-unsent').ok).toBe(true);
      expect(claim('st-unsent').out).toBe('1');
      expire('st-unsent');
      backdate('st-unsent', '121 seconds');
      expect(timeout('st-unsent').out).toBe('1');
      expect(settle('st-unsent').out).toBe('f');
      expect(state('st-unsent')).toBe('creating||');
      // Envio feito e encerramento pedido, com a posse ainda em vigor: quem tem a posse pode gravar a ordem.
      expect(open('st-live').ok).toBe(true);
      expect(claim('st-live').out).toBe('1');
      expect(begin('st-live', 1).out).toBe('1');
      backdate('st-live', '121 seconds');
      expect(timeout('st-live').out).toBe('1');
      expect(settle('st-live').out).toBe('f');
      expect(state('st-live')).toBe('creating||');
      // Outra loja não mexe.
      expire('st-live');
      expect(settle('st-live', OTHER).out).toBe('f');
      expect(state('st-live')).toBe('creating||');
      // Todas as condições: revisão manual, resultado desconhecido. Nunca "cancelled".
      expect(settle('st-live').out).toBe('t');
      expect(state('st-live')).toBe('manual_review|dispatch_unknown|DISPATCH_UNKNOWN');
      expect(settle('st-live').out).toBe('f'); // já decidido
      // Com ordem ligada no meio: quem decide é a ordem, não o prazo.
      expect(open('st-order').ok).toBe(true);
      expect(claim('st-order').out).toBe('1');
      expect(begin('st-order', 1).out).toBe('1');
      backdate('st-order', '121 seconds');
      expect(timeout('st-order').out).toBe('1');
      expire('st-order');
      sql(`UPDATE terminal_charges SET external_order_id = 'ORD-ST' WHERE idempotency_key = 'st-order';`);
      expect(settle('st-order').out).toBe('f');
      expect(state('st-order')).toBe('creating||');
      expect(psql(target!, `SELECT tchefood_settle_point_dispatch('${TENANT}', gen_random_uuid());`, DB).out).toBe('f');
    });

    it('auditoria r3 P0-01: enviada sem resposta, encerrada com PIN de gerente: revisão manual (nunca cancelada) e segue reservando o saldo', () => {
      const ORDER4 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER4}', '${TENANT}', '${TABLE}', '${STAFF}');
           BEGIN; SET LOCAL session_replication_role = replica; UPDATE orders SET total_amount = 100, remaining_balance = 100 WHERE id = '${ORDER4}'; COMMIT;`);
      const open4 = (key: string, cents: number) =>
        psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER4}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}', ${bal(ORDER4)});`, DB);
      expect(open4('unk-a', 10000).ok).toBe(true);
      expect(claim('unk-a').out).toBe('1');
      expect(begin('unk-a', 1).out).toBe('1'); // o envio saiu; a resposta nunca chegou
      const auth = psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', 'unk-a', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`, DB);
      expect(auth.ok, auth.message ?? '').toBe(true);
      expect(auth.out).toMatch(/^[0-9a-f-]{36}$/);
      // PIN do gerente com a posse em vigor: nada muda ainda.
      expect(settle('unk-a').out).toBe('f');
      expect(field('unk-a', 'status')).toBe('creating');
      expect(open4('unk-b', 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      // Posse vencida (2 dias depois): a função do banco leva à revisão manual. PIN e tempo não viram recusa.
      backdate('unk-a', '2 days');
      sql(`UPDATE terminal_charges SET dispatch_lease_until = NOW() - INTERVAL '2 days' WHERE idempotency_key = 'unk-a';`);
      expect(settle('unk-a').out).toBe('t');
      expect(field('unk-a', `status || '|' || raw_status_detail || '|' || cancel_reason || '|' || (cancel_audit_id = '${auth.out}')`)).toBe('manual_review|DISPATCH_UNKNOWN|operator|true');
      // Segue reservando o saldo: a segunda cobrança da conta é recusada, até de 1 centavo.
      expect(open4('unk-b', 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'unk-b'`)).toBe('0');
      // Repetir a autorização ou o prazo não tira da revisão manual.
      expect(psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', 'unk-a', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`, DB).out).toBe(auth.out);
      expect(timeout('unk-a').out).toBe('2');
      expect(field('unk-a', 'status')).toBe('manual_review');
      // A resposta atrasada ainda liga a ordem (qualquer estado não final) e grava a aprovação por cima da revisão manual.
      expect(sql(`UPDATE terminal_charges SET external_order_id = 'ORD-LATE' WHERE idempotency_key = 'unk-a' AND external_order_id IS NULL
                  AND status NOT IN ('approved','rejected','cancelled','expired','refunded') RETURNING status;`)).toBe('manual_review');
      // Auditoria r5 P1-01: a aprovação por cima da revisão manual não é mais gravada direto (nem pela consulta
      // da Edge Function): só pelo fim verificado, com a conferência pedida com PIN de gerente.
      const late = psql(target!, `UPDATE terminal_charges SET status = 'approved', external_payment_id = '4242', paid_amount_cents = 10000, card_brand = 'VISA', authorization_code = 'LATE1'
                                  WHERE idempotency_key = 'unk-a' AND status = 'manual_review';`, DB);
      expect(late.ok).toBe(false);
      expect(late.message).toContain('só passa de "manual_review" para "approved" com a confirmação do Mercado Pago');
      const rec = psql(target!, `SELECT tchefood_authorize_point_reconcile('${TENANT}', 'unk-a', '${STAFF}', '${MANAGER_PIN}', 'conferido no app do Mercado Pago');`, DB);
      expect(rec.out, rec.message ?? '').toMatch(/^[0-9a-f-]{36}$/);
      const resolved = psql(target!, `SELECT status FROM tchefood_resolve_point_charge('${TENANT}', ${idOf('unk-a')}, 'manual_review', 'approved',
                                      '{"external_payment_id":"4242","paid_amount_cents":10000,"card_brand":"VISA","authorization_code":"LATE1"}'::jsonb,
                                      '${STAFF}', 'resposta atrasada conferida no Mercado Pago', '{"authorization_audit_id":"${rec.out}","operation_id":"4242"}'::jsonb);`, DB);
      expect(resolved.out, resolved.message ?? '').toBe('approved');
      expect(field('unk-a', `status || '|' || external_order_id`)).toBe('approved|ORD-LATE');
    });

    it('auditoria r3: o gatilho não deixa trocar a ordem ligada, mudar a hora da cobrança nem apagar ou alterar o encerramento registrado', () => {
      const refuse = (key: string, set: string, message: string) => {
        const r = psql(target!, `UPDATE terminal_charges SET ${set} WHERE idempotency_key = '${key}';`, DB);
        expect(r.ok, `${key}: ${set}`).toBe(false);
        expect(r.message, `${key}: ${set}`).toContain(message);
      };
      // Ordem: ligar uma vez pode; trocar ou apagar não.
      expect(open('trg-order').ok).toBe(true);
      sql(`UPDATE terminal_charges SET external_order_id = 'ORD-1', status = 'pending' WHERE idempotency_key = 'trg-order';`);
      refuse('trg-order', `external_order_id = 'ORD-2'`, 'já tem ordem no Mercado Pago');
      refuse('trg-order', `external_order_id = NULL`, 'já tem ordem no Mercado Pago');
      sql(`UPDATE terminal_charges SET external_order_id = 'ORD-1', status = 'at_terminal' WHERE idempotency_key = 'trg-order';`);
      // Hora gravada (base do prazo de espera).
      refuse('trg-order', `created_at = NOW() - INTERVAL '1 hour'`, 'a hora da cobrança');
      refuse('trg-order', `created_at = NOW() + INTERVAL '1 hour'`, 'a hora da cobrança');
      // Encerramento por prazo: não some, não muda de hora nem ganha operador; só pode virar "operator" pela função do gerente.
      expect(open('trg-timeout').ok).toBe(true);
      backdate('trg-timeout', '121 seconds');
      expect(timeout('trg-timeout').out).toBe('1');
      refuse('trg-timeout', `cancel_requested_at = NULL`, 'já foi registrado');
      refuse('trg-timeout', `cancel_reason = NULL`, 'já foi registrado');
      refuse('trg-timeout', `cancel_reason = NULL, cancel_requested_at = NULL`, 'já foi registrado');
      refuse('trg-timeout', `cancel_requested_at = NOW() + INTERVAL '1 minute'`, 'já foi registrado');
      refuse('trg-timeout', `cancel_requested_by = '${STAFF}'`, 'já foi registrado');
      refuse('trg-timeout', `cancel_reason = 'void'`, 'já foi registrado');
      refuse('trg-timeout', `dispatched_at = NOW()`, 'encerrada antes de ir à maquininha');
      const auth = psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', 'trg-timeout', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`, DB);
      expect(auth.out).toMatch(/^[0-9a-f-]{36}$/);
      expect(field('trg-timeout', `cancel_reason || '|' || cancel_requested_by || '|' || cancel_authorized_by || '|' || cancel_audit_id`)).toBe(`operator|${STAFF}|${MANAGER}|${auth.out}`);
      // Encerramento do gerente: nada dele muda mais, nem volta a ser "por prazo".
      refuse('trg-timeout', `cancel_requested_at = NULL`, 'já foi registrado');
      refuse('trg-timeout', `cancel_reason = 'timeout'`, 'já foi registrado');
      refuse('trg-timeout', `cancel_authorized_by = '${STAFF}'`, 'já foi registrado');
      refuse('trg-timeout', `cancel_requested_by = '${MANAGER}'`, 'já foi registrado');
      refuse('trg-timeout', `cancel_audit_id = (SELECT id FROM audit_logs WHERE id <> '${auth.out}' LIMIT 1)`, 'já foi registrado');
      refuse('trg-timeout', `cancel_requested_at = NOW() + INTERVAL '1 minute'`, 'já foi registrado');
      refuse('trg-timeout', `cancel_authorized_by = NULL`, 'já foi registrado');
      expect(field('trg-timeout', `cancel_reason || '|' || cancel_requested_by || '|' || cancel_authorized_by || '|' || cancel_audit_id`)).toBe(`operator|${STAFF}|${MANAGER}|${auth.out}`);
      // O estado da cobrança ainda pode andar com o encerramento registrado (ele não trava a conferência).
      sql(`UPDATE terminal_charges SET status = 'manual_review' WHERE idempotency_key = 'trg-timeout';`);
      expect(field('trg-timeout', 'status')).toBe('manual_review');
    });
  });

  describe('auditoria r3 P1-01: bloqueio preventivo da chave nunca gravada', () => {
    const block = (key: string, who: string, tenant = TENANT, terminal = TERMINAL) =>
      psql(target!, `SELECT tchefood_block_point_key('${tenant}', '${key}', '${ORDER3}', '${terminal}', '${MP_ID}', 'CREDIT', 100, ${who});`, DB);
    const audits = (key: string) => sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'POINT_KEY_BLOCKED' AND metadata->>'idempotency_key' = '${key}'`);

    it.each([
      ['sem operador', 'NULL'],
      ['operador inativo', `'${INACTIVE}'`],
      ['operador de outra loja', `'${OTHER_STAFF}'`],
    ])('%s não bloqueia (TF004) e nada é gravado', (_label, who) => {
      expect(block('blk-who', who)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'blk-who'`)).toBe('0');
      expect(audits('blk-who')).toBe('0');
    });

    it('operador ativo: grava a chave encerrada (nunca enviada), com quem pediu e um registro; repetir não grava outro', () => {
      const r = block('blk-ok', `'${STAFF}'`);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(sql(`SELECT status || '|' || raw_status || '|' || cancel_reason || '|' || cancel_requested_by || '|' || (dispatched_at IS NULL) || '|' || (created_by IS NULL) FROM terminal_charges WHERE idempotency_key = 'blk-ok'`))
        .toBe(`cancelled|voided_before_send|void|${STAFF}|true|true`);
      expect(sql(`SELECT performed_by_user_id || '|' || (authorized_by_manager_id IS NULL) FROM audit_logs WHERE action_type = 'POINT_KEY_BLOCKED' AND metadata->>'idempotency_key' = 'blk-ok'`)).toBe(`${STAFF}|true`);
      expect(block('blk-ok', `'${STAFF}'`).out).toBe(r.out);
      expect(audits('blk-ok')).toBe('1');
      // A criação atrasada com a mesma chave encontra a cobrança encerrada: a função de abrir devolve a mesma linha.
      const late = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'blk-ok', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER3)});`, DB);
      expect(late.out).toBe(r.out);
      expect(sql(`SELECT status FROM terminal_charges WHERE idempotency_key = 'blk-ok'`)).toBe('cancelled');
      // E nunca ganha a posse do envio.
      expect(psql(target!, `SELECT tchefood_claim_point_dispatch('${TENANT}', '${r.out}', 30000);`, DB).out).toBe('0');
    });

    it('a criação gravou primeiro: o bloqueio não mexe na cobrança nem registra nada', () => {
      const created = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'blk-late', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER3)});`, DB);
      expect(created.ok).toBe(true);
      expect(block('blk-late', `'${STAFF}'`).out).toBe(created.out);
      expect(sql(`SELECT status || '|' || (cancel_reason IS NULL) FROM terminal_charges WHERE idempotency_key = 'blk-late'`)).toBe('creating|true');
      expect(audits('blk-late')).toBe('0');
    });

    it('auditoria r3 P1-01: criação e bloqueio ao mesmo tempo, 10 rodadas de 8 sessões: sem travamento mútuo, uma linha só, ou a cobrança ou o bloqueio', async () => {
      for (let round = 0; round < 10; round += 1) {
        const key = `blk-race-${round}`;
        const q = (i: number) => ((i + round) % 2
          ? `SELECT tchefood_block_point_key('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`
          : `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER3)});`);
        // together() derruba o teste se alguma sessão der erro (travamento mútuo = erro 40P01).
        const out = await together(8, q);
        expect(lastOverlap, key).toBe(8);
        expect(new Set(out).size, key).toBe(1);
        expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${key}'`), key).toBe('1');
        const status = sql(`SELECT status FROM terminal_charges WHERE idempotency_key = '${key}'`);
        expect(['creating', 'cancelled'], key).toContain(status);
        expect(audits(key), key).toBe(status === 'cancelled' ? '1' : '0');
      }
    }, 180_000);

    it('auditoria r3 P1-01: criação e bloqueio parados na trava da MESMA conta, nas duas ordens: quem chega primeiro fica, o outro devolve a mesma linha', async () => {
      for (let i = 0; i < 10; i += 1) {
        const key = `blk-order-${i}`;
        const blockQ = `SELECT tchefood_block_point_key('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`;
        const openQ = `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER3)});`;
        const blockFirst = i % 2 === 0;
        const out = await contend(`SELECT 1 FROM orders WHERE id = '${ORDER3}' FOR UPDATE`, blockFirst ? [blockQ, openQ] : [openQ, blockQ]);
        expect(lastOverlap, key).toBe(2);
        expect(out[0], key).toBe(out[1]);
        expect(sql(`SELECT status FROM terminal_charges WHERE idempotency_key = '${key}'`), key).toBe(blockFirst ? 'cancelled' : 'creating');
        expect(audits(key), key).toBe(blockFirst ? '1' : '0');
        // Bloqueio na frente: a criação atrasada nunca ganha a posse do envio.
        expect(psql(target!, `SELECT tchefood_claim_point_dispatch('${TENANT}', '${out[0]}', 30000);`, DB).out, key).toBe(blockFirst ? '0' : '1');
      }
    }, 120_000);

    it('auditoria r3 P1-01: chave que já é de uma loja não é bloqueada nem lida por outra, mesmo com maquininha e operador da outra (TF005)', () => {
      const before = sql(`SELECT id || '|' || tenant_id || '|' || status || '|' || cancel_requested_by FROM terminal_charges WHERE idempotency_key = 'blk-ok'`);
      const stolen = psql(target!, `SELECT tchefood_block_point_key('${OTHER}', 'blk-ok', '${ORDER3}', '${OTHER_TERMINAL}', 'OUTRA-POINT', 'CREDIT', 100, '${OTHER_STAFF}');`, DB);
      expect(stolen).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(stolen.out).toBe(''); // nem o id da cobrança da outra loja volta
      expect(sql(`SELECT id || '|' || tenant_id || '|' || status || '|' || cancel_requested_by FROM terminal_charges WHERE idempotency_key = 'blk-ok'`)).toBe(before);
      expect(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id = '${OTHER}' AND action_type = 'POINT_KEY_BLOCKED'`)).toBe('0');
      // Chave nova da outra loja, com a maquininha dela: bloqueia normalmente, na loja dela.
      const own = psql(target!, `SELECT tchefood_block_point_key('${OTHER}', 'blk-outra', '${ORDER3}', '${OTHER_TERMINAL}', 'OUTRA-POINT', 'CREDIT', 100, '${OTHER_STAFF}');`, DB);
      expect(own.ok, own.message ?? '').toBe(true);
      expect(sql(`SELECT tenant_id || '|' || status FROM terminal_charges WHERE idempotency_key = 'blk-outra'`)).toBe(`${OTHER}|cancelled`);
      // E a primeira loja não a enxerga nem a bloqueia.
      expect(block('blk-outra', `'${STAFF}'`)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      // Maquininha da outra loja com a loja certa: recusa.
      expect(block('blk-term', `'${STAFF}'`, TENANT, OTHER_TERMINAL)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'blk-term'`)).toBe('0');
    });

    it('auditoria r3 P1-01: conta que ainda não subiu ao servidor: o bloqueio grava a chave encerrada e o registro fica sem conta', () => {
      const ABSENT = '12345678-1234-4234-8234-123456789012';
      const r = psql(target!, `SELECT tchefood_block_point_key('${TENANT}', 'blk-absent', '${ABSENT}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`, DB);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(sql(`SELECT status || '|' || raw_status || '|' || order_id FROM terminal_charges WHERE idempotency_key = 'blk-absent'`)).toBe(`cancelled|voided_before_send|${ABSENT}`);
      expect(sql(`SELECT (order_id IS NULL) || '|' || performed_by_user_id FROM audit_logs WHERE action_type = 'POINT_KEY_BLOCKED' AND metadata->>'idempotency_key' = 'blk-absent'`)).toBe(`true|${STAFF}`);
      // A criação atrasada com a mesma chave não abre cobrança nova: devolve a chave encerrada, e ela nunca ganha a posse do envio.
      const late = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'blk-absent', '${ABSENT}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ABSENT)});`, DB);
      expect(late.out).toBe(r.out);
      expect(psql(target!, `SELECT tchefood_claim_point_dispatch('${TENANT}', '${r.out}', 30000);`, DB).out).toBe('0');
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'blk-absent'`)).toBe('1');
      expect(sql(`SELECT status FROM terminal_charges WHERE idempotency_key = 'blk-absent'`)).toBe('cancelled');
    });

    it('chave de outra loja, maquininha de outra loja e papéis do aparelho', () => {
      expect(block('blk-ok', `'${OTHER_STAFF}'`, OTHER)).toMatchObject({ ok: false, sqlstate: 'TF005' }); // maquininha não é da outra loja
      for (const role of ['authenticated', 'anon']) {
        const r = psql(target!, `BEGIN; SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
          SELECT tchefood_block_point_key('${TENANT}', 'blk-dev', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}'); COMMIT;`, DB);
        expect(r.sqlstate, role).toBe('42501');
      }
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'blk-dev'`)).toBe('0');
    });
  });

  describe('auditoria r3, terceira revisão: loja, chave, reserva, gatilho e relógio', () => {
    const openAs = (tenant: string, key: string, order: string, terminal: string, serial: string, cents: number, staff: string) =>
      psql(target!, `SELECT tchefood_open_terminal_charge('${tenant}', '${key}', '${order}', '${terminal}', '${serial}', 'CREDIT', ${cents}, '${staff}', ${bal(order)});`, DB);
    const open = (key: string, order: string, cents: number) => openAs(TENANT, key, order, TERMINAL, MP_ID, cents, STAFF);
    const field = (key: string, expr: string) => sql(`SELECT ${expr} FROM terminal_charges WHERE idempotency_key = '${key}'`);
    const idOf = (key: string) => `(SELECT id FROM terminal_charges WHERE idempotency_key = '${key}')`;
    const set = (key: string, what: string) => psql(target!, `UPDATE terminal_charges SET ${what} WHERE idempotency_key = '${key}';`, DB);

    it('auditoria r3, terceira revisão: chave que já é de OUTRA loja não abre cobrança, não devolve o id dela e não grava nada (TF005)', () => {
      const theirs = psql(target!, `SELECT tchefood_block_point_key('${OTHER}', 't3-alheia', '${ORDER5}', '${OTHER_TERMINAL}', '${OTHER_MP_ID}', 'CREDIT', 100, '${OTHER_STAFF}');`, DB);
      expect(theirs.ok, theirs.message ?? '').toBe(true);
      const before = field('t3-alheia', `id || '|' || tenant_id || '|' || status || '|' || updated_at`);
      const r = open('t3-alheia', ORDER5, 100);
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(r.out).toBe('');
      expect(r.out).not.toContain(theirs.out);
      expect(field('t3-alheia', `id || '|' || tenant_id || '|' || status || '|' || updated_at`)).toBe(before);
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 't3-alheia'`)).toBe('1');
      // E a conta desta loja não ficou com nada reservado por causa da tentativa.
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE tenant_id = '${TENANT}' AND idempotency_key = 't3-alheia'`)).toBe('0');
    });

    it('auditoria r3, terceira revisão: maquininha de outra loja não abre cobrança nesta (TF005), nem a desta abre na outra', () => {
      expect(openAs(TENANT, 't3-maq', ORDER5, OTHER_TERMINAL, OTHER_MP_ID, 100, STAFF)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(openAs(OTHER, 't3-maq', ORDER5, TERMINAL, MP_ID, 100, OTHER_STAFF)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(openAs(TENANT, 't3-maq', ORDER5, '12345678-1234-4234-8234-123456789012', MP_ID, 100, STAFF)).toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 't3-maq'`)).toBe('0');
    });

    it('auditoria r3, terceira revisão: bloqueio (conta A) e criação (conta B) da mesma chave ao mesmo tempo, 6 rodadas: nenhum erro de chave duplicada, uma linha só', async () => {
      // Contas diferentes = travas diferentes: as duas gravações chegam juntas no índice único da chave.
      for (let round = 0; round < 6; round += 1) {
        const key = `t3-duas-${round}`;
        const out = await together(8, (i) => (i % 2
          ? `SELECT tchefood_block_point_key('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`
          : `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER5}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER5)});`));
        expect(lastOverlap).toBe(8);
        // together() derruba o teste se alguma sessão der erro (23505 incluído). Todas devolvem a MESMA linha.
        expect(new Set(out).size, key).toBe(1);
        expect(out[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${key}'`)).toBe('1');
        expect(['creating|' + ORDER5, 'cancelled|' + ORDER3]).toContain(field(key, `status || '|' || order_id`));
      }
    }, 90_000);

    it('auditoria r3, terceira revisão: cobrança na maquininha (at_terminal) reserva o saldo; aprovada COM pagamento gravado deixa de reservar', () => {
      // ORDER4 tem R$ 50,00. 30,00 esperando o cartão na maquininha: 20,01 não cabe, 20,00 cabe.
      expect(open('t3-res-a', ORDER4, 3000).ok).toBe(true);
      sql(`UPDATE terminal_charges SET status = 'at_terminal', external_order_id = 'ORDT3A' WHERE idempotency_key = 't3-res-a';`);
      expect(open('t3-res-b', ORDER4, 2001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      const b = open('t3-res-b', ORDER4, 2000);
      expect(b.ok, b.message ?? '').toBe(true);
      // A de 30,00 expira na maquininha (libera) e a de 20,00 é aprovada, ainda sem pagamento gravado: reserva 20,00.
      sql(`UPDATE terminal_charges SET status = 'expired' WHERE idempotency_key = 't3-res-a';
           UPDATE terminal_charges SET status = 'approved', external_order_id = 'ORDT3B', external_payment_id = '880022', paid_amount_cents = 2000, card_brand = 'VISA', authorization_code = 'T3B'
            WHERE idempotency_key = 't3-res-b';`);
      expect(open('t3-res-c', ORDER4, 3001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      // O pagamento aprovado da mesma chave entra. Sem itens na conta, o recálculo do banco zera os totais; o
      // saldo é remontado (dono do banco, sem gatilhos) em R$ 30,00 = 50,00 menos os 20,00 pagos.
      const paid = pay('t3-res-b', { order_id: ORDER4, amount: 20, nsu: '880022', authorization_code: 'T3B' });
      expect(paid.ok, paid.message ?? '').toBe(true);
      sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE orders SET total_amount = 50, remaining_balance = 30 WHERE id = '${ORDER4}'; COMMIT;`);
      // Se a aprovada ainda reservasse, só caberiam 10,00. Cabem os 30,00 inteiros, e nem 1 centavo a mais.
      expect(open('t3-res-c', ORDER4, 3001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      const c = open('t3-res-c', ORDER4, 3000);
      expect(c.ok, c.message ?? '').toBe(true);
    });

    it.each(['cancelled', 'expired', 'refunded', 'rejected', 'approved'])('auditoria r3, terceira revisão: cobrança "%s" é final: nenhum campo muda mais', (status) => {
      const receipt: Record<string, string | number | null> = status === 'approved' ? {} : { external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null };
      const key = charge({ status, ...receipt });
      for (const what of [`status = 'at_terminal'`, `status = 'manual_review'`, `status = 'creating'`, `raw_status = 'x'`, `external_order_id = 'OUTRA'`, `updated_at = NOW()`]) {
        const r = set(key, what);
        expect(r.ok, `${status}: ${what}`).toBe(false);
        expect(r.message, `${status}: ${what}`).toContain('não muda mais');
      }
      expect(field(key, 'status')).toBe(status);
    });

    it('auditoria r3, terceira revisão: chave, loja, maquininha e operador da cobrança não mudam (cobrança ainda em andamento)', () => {
      const key = 't3-ident';
      expect(open(key, ORDER5, 100).ok).toBe(true);
      const before = field(key, `idempotency_key || '|' || tenant_id || '|' || terminal_id || '|' || provider || '|' || created_by`);
      for (const what of [`idempotency_key = 't3-ident-x'`, `tenant_id = '${OTHER}'`, `terminal_id = '${STONE_TERMINAL}'`, `created_by = '${MANAGER}'`, `created_by = NULL`]) {
        const r = set(key, what);
        expect(r.ok, what).toBe(false);
        expect(r.message, what).toContain('não mudam');
      }
      // "provider" só aceita um valor (regra da tabela), então a troca já morre antes do gatilho; aqui fica a prova de que não muda.
      expect(set(key, `provider = 'outro'`).ok).toBe(false);
      expect(field(key, `idempotency_key || '|' || tenant_id || '|' || terminal_id || '|' || provider || '|' || created_by`)).toBe(before);
      // Operador gravado como NULL (linha antiga) também não ganha operador depois.
      const anon = charge({ status: 'pending', created_by: null, external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null });
      expect(set(anon, `created_by = '${STAFF}'`).message).toContain('não mudam');
    });

    it('auditoria r3, terceira revisão: virar "approved" por UPDATE exige o comprovante inteiro; campo vazio ou só com espaços não conta', () => {
      const key = charge({ status: 'at_terminal', external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null });
      const full = { external_payment_id: `'990011'`, paid_amount_cents: '1000', card_brand: `'VISA'`, authorization_code: `'T3OK'` };
      const approve = (over: Record<string, string>) => {
        const v = { ...full, ...over };
        return set(key, `status = 'approved', ${Object.entries(v).map(([k, x]) => `${k} = ${x}`).join(', ')}`);
      };
      const overs: Record<string, string>[] = [
        { external_payment_id: 'NULL' }, { external_payment_id: `''` }, { external_payment_id: `'   '` },
        { authorization_code: 'NULL' }, { authorization_code: `''` }, { authorization_code: `'  '` },
        { card_brand: 'NULL' }, { card_brand: `''` }, { card_brand: `' '` },
        { paid_amount_cents: 'NULL' }, { paid_amount_cents: '999' },
      ];
      for (const over of overs) {
        const r = approve(over);
        expect(r.ok, JSON.stringify(over)).toBe(false);
        expect(r.message, JSON.stringify(over)).toContain('comprovante completo');
      }
      expect(field(key, 'status')).toBe('at_terminal');
      // Na criação da linha vale o mesmo.
      expect(() => charge({ external_payment_id: '' })).toThrow(/comprovante completo/);
      expect(() => charge({ authorization_code: ' ' })).toThrow(/comprovante completo/);
      // Com tudo, aprova.
      const ok = approve({});
      expect(ok.ok, ok.message ?? '').toBe(true);
      expect(field(key, 'status')).toBe('approved');
    });

    it('auditoria r3, terceira revisão: motivo e hora do encerramento andam juntos (um sem o outro é recusado pela tabela)', () => {
      const key = 't3-par';
      expect(open(key, ORDER5, 100).ok).toBe(true);
      for (const what of [`cancel_reason = 'timeout'`, `cancel_requested_at = NOW()`]) {
        const r = set(key, what);
        expect(r.ok, what).toBe(false);
        expect(r.message, what).toContain('terminal_charges_cancel_pair_check');
      }
      expect(field(key, 'cancel_reason IS NULL AND cancel_requested_at IS NULL')).toBe('t');
      // Na criação da linha também.
      expect(() => charge({ status: 'pending', cancel_reason: 'timeout', external_payment_id: null, paid_amount_cents: null, card_brand: null, authorization_code: null }))
        .toThrow(/terminal_charges_cancel_pair_check/);
      // Os dois juntos entram; depois, tirar só um deles não passa (gatilho ou regra da tabela).
      expect(set(key, `cancel_reason = 'timeout', cancel_requested_at = NOW()`).ok).toBe(true);
      expect(set(key, `cancel_reason = NULL`).ok).toBe(false);
      expect(set(key, `cancel_requested_at = NULL`).ok).toBe(false);
      expect(set(key, `cancel_reason = NULL, cancel_requested_at = NULL`).ok).toBe(false);
      expect(field(key, `cancel_reason || '|' || (cancel_requested_at IS NOT NULL)`)).toBe('timeout|true');
    });

    it('auditoria r3, terceira revisão: o aparelho não grava registro da Point em audit_logs (encerramento autorizado nem bloqueio de chave)', () => {
      const insert = (action: string, tenant = TENANT, staff = STAFF) =>
        asDevice(`INSERT INTO audit_logs (tenant_id, performed_by_user_id, action_type, reason, metadata) VALUES ('${tenant}', '${staff}', '${action}', 'forjado pelo aparelho', '{"idempotency_key":"t3-forjada"}')`, tenant);
      for (const action of ['POINT_CHARGE_CANCELED', 'POINT_KEY_BLOCKED']) {
        const r = insert(action);
        expect(r.ok, action).toBe(false);
        expect(r.message, action).toContain('registro da Point só é gravado pelo servidor');
        const anon = psql(target!, `BEGIN; SET LOCAL ROLE anon; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
          INSERT INTO audit_logs (tenant_id, performed_by_user_id, action_type, reason) VALUES ('${TENANT}', '${STAFF}', '${action}', 'forjado'); COMMIT;`, DB);
        expect(anon.ok, `anon ${action}`).toBe(false);
      }
      expect(sql(`SELECT count(*) FROM audit_logs WHERE metadata->>'idempotency_key' = 't3-forjada'`)).toBe('0');
      // Um registro comum do aparelho continua entrando, e não vira registro da Point depois.
      const plain = insert('T3_REGISTRO_COMUM');
      expect(plain.ok, plain.message ?? '').toBe(true);
      const turn = asDevice(`UPDATE audit_logs SET action_type = 'POINT_CHARGE_CANCELED' WHERE action_type = 'T3_REGISTRO_COMUM'`);
      expect(turn.ok).toBe(false);
      expect(sql(`SELECT count(*) FROM audit_logs WHERE action_type = 'T3_REGISTRO_COMUM'`)).toBe('1');
      // As funções do servidor seguem gravando os dois tipos (provado nos testes do bloqueio e do PIN).
    });

    it('auditoria r3, terceira revisão: a barreira que ESPEROU a trava da linha decide com a hora de depois da espera: posse vencida no meio = não manda', async () => {
      const key = 't3-relogio-posse';
      expect(open(key, ORDER5, 100).ok).toBe(true);
      // Posse de 2 s. Uma sessão segura a linha; a barreira entra ANTES de a posse vencer e fica parada na trava.
      expect(psql(target!, `SELECT tchefood_claim_point_dispatch('${TENANT}', ${idOf(key)}, 2000);`, DB).out).toBe('1');
      const before = waiting();
      const holder = session();
      holder.send(`BEGIN; SELECT id FROM terminal_charges WHERE idempotency_key = '${key}' FOR UPDATE; SELECT 'held';`);
      await until('trava da linha', () => holder.output().includes('held'));
      const barrier = session();
      barrier.end(`SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf(key)}, 1, 30000, true);`);
      await until('barreira esperando a linha', () => waiting() === before + 1);
      // Prova de que ela começou com a posse ainda em vigor (com NOW(), a hora do começo, ela passaria).
      expect(field(key, 'dispatch_lease_until > clock_timestamp()')).toBe('t');
      await until('posse vencida', () => field(key, 'dispatch_lease_until <= clock_timestamp()') === 't', 5_000);
      expect(waiting()).toBe(before + 1);
      holder.end('COMMIT;');
      await holder.done;
      expect((await barrier.done).split('\n').pop()).toBe('0');
      expect(field(key, `(dispatched_at IS NULL) || '|' || dispatch_attempts`)).toBe('true|1');
    }, 30_000);

    it('auditoria r3, terceira revisão: posse pedida por quem ESPEROU a trava mais que o prazo dela nunca libera envio vencida (a barreira confere a hora de agora)', async () => {
      const key = 't3-relogio-claim';
      expect(open(key, ORDER5, 100).ok).toBe(true);
      const before = waiting();
      const holder = session();
      holder.send(`BEGIN; SELECT id FROM terminal_charges WHERE idempotency_key = '${key}' FOR UPDATE; SELECT 'held';`);
      await until('trava da linha', () => holder.output().includes('held'));
      const claimer = session();
      claimer.end(`SELECT tchefood_claim_point_dispatch('${TENANT}', ${idOf(key)}, 1000);`);
      await until('posse esperando a linha', () => waiting() === before + 1);
      await pause(1_200); // mais que a posse de 1 s
      holder.end('COMMIT;');
      await holder.done;
      expect((await claimer.done).split('\n').pop()).toBe('1');
      // O prazo da posse pode ter sido calculado antes da espera (a linha só estava travada, não mudou). O que
      // não pode é envio sair com posse vencida: a barreira passa se, e só se, a posse ainda vale agora.
      const valid = field(key, `dispatch_lease_until > clock_timestamp() + INTERVAL '300 milliseconds'`) === 't';
      const expired = field(key, 'dispatch_lease_until <= clock_timestamp()') === 't';
      expect(valid || expired, 'posse na beirada do prazo: rode de novo').toBe(true);
      const barrier = psql(target!, `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf(key)}, 1, 30000, true);`, DB);
      expect(barrier.out).toBe(valid ? '1' : '0');
      expect(field(key, '(dispatched_at IS NOT NULL)::text')).toBe(valid ? 'true' : 'false');
    }, 30_000);

    it('auditoria r3, terceira revisão: o encerramento por prazo que ESPEROU a trava decide com a hora de depois da espera (prazo vencido no meio = grava)', async () => {
      const key = 't3-relogio-prazo';
      expect(open(key, ORDER5, 100).ok).toBe(true);
      // Faltam 2 s para o prazo de 1 min.
      backdate(key, '58 seconds');
      const before = waiting();
      const holder = session();
      holder.send(`BEGIN; SELECT id FROM terminal_charges WHERE idempotency_key = '${key}' FOR UPDATE; SELECT 'held';`);
      await until('trava da linha', () => holder.output().includes('held'));
      const timeout = session();
      timeout.end(`SELECT tchefood_request_point_timeout('${TENANT}', ${idOf(key)}, 60000);`);
      await until('encerramento esperando a linha', () => waiting() === before + 1);
      // Começou antes do prazo (com NOW() responderia 0, "cedo demais").
      expect(field(key, `created_at + INTERVAL '60 seconds' > clock_timestamp()`)).toBe('t');
      await until('prazo vencido', () => field(key, `created_at + INTERVAL '60 seconds' <= clock_timestamp()`) === 't', 6_000);
      holder.end('COMMIT;');
      await holder.done;
      expect((await timeout.done).split('\n').pop()).toBe('1');
      // A hora gravada é a de depois da espera: nunca antes do prazo.
      expect(field(key, `cancel_reason || '|' || (cancel_requested_at >= created_at + INTERVAL '60 seconds')`)).toBe('timeout|true');
    }, 30_000);

    it('auditoria r3, terceira revisão: a hora do encerramento com PIN é a de quando gravou, nunca anterior ao envio que passou na frente', async () => {
      const key = 't3-relogio-pin';
      expect(open(key, ORDER5, 100).ok).toBe(true);
      expect(psql(target!, `SELECT tchefood_claim_point_dispatch('${TENANT}', ${idOf(key)}, 30000);`, DB).out).toBe('1');
      // Na trava da linha: primeiro a barreira, depois o PIN do gerente. A barreira passa (1) e o encerramento grava depois.
      const out = await contend(`SELECT id FROM terminal_charges WHERE idempotency_key = '${key}' FOR UPDATE`, [
        `SELECT tchefood_begin_point_dispatch('${TENANT}', ${idOf(key)}, 1, 30000, true);`,
        `SELECT (tchefood_authorize_point_cancel('${TENANT}', '${key}', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu') IS NOT NULL)::text;`,
      ]);
      expect(lastOverlap).toBe(2);
      expect(out).toEqual(['1', 'true']);
      // Com NOW() (hora do começo da transação, antes da espera) o encerramento ficaria gravado ANTES do envio.
      expect(field(key, 'cancel_requested_at >= dispatched_at')).toBe('t');
    }, 30_000);
  });

  describe('auditoria r2 P1-01: encerrar pelo operador só com PIN de gerente conferido no banco', () => {
    const open = (key: string) =>
      psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER3)});`, DB);
    const authorize = (key: string, pin: string, who = STAFF, reason = 'cliente desistiu') =>
      psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', '${key}', '${who}', '${pin}', '${reason}');`, DB);
    const audits = (action: string, key: string) =>
      sql(`SELECT count(*) FROM audit_logs WHERE action_type = '${action}' AND metadata->>'idempotency_key' = '${key}'`);

    it('PIN certo: grava o registro com o gerente e marca a cobrança (motivo, operador, gerente, registro)', () => {
      expect(open('pin-ok').ok).toBe(true);
      const r = authorize('pin-ok', MANAGER_PIN);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(r.out).toMatch(/^[0-9a-f-]{36}$/);
      expect(sql(`SELECT authorized_by_manager_id || '|' || performed_by_user_id || '|' || reason || '|' || amount_impact FROM audit_logs WHERE id = '${r.out}'`))
        .toBe(`${MANAGER}|${STAFF}|cliente desistiu|1.00`);
      expect(sql(`SELECT cancel_reason || '|' || cancel_requested_by || '|' || cancel_authorized_by || '|' || cancel_audit_id FROM terminal_charges WHERE idempotency_key = 'pin-ok'`))
        .toBe(`operator|${STAFF}|${MANAGER}|${r.out}`);
    });

    it('encerramento por prazo pode virar pedido do operador com gerente, e o registrado não muda mais', () => {
      expect(open('pin-timeout').ok).toBe(true);
      sql(`UPDATE terminal_charges SET cancel_reason = 'timeout', cancel_requested_at = NOW() WHERE idempotency_key = 'pin-timeout';`);
      const r = authorize('pin-timeout', MANAGER_PIN);
      expect(r.ok, r.message ?? '').toBe(true);
      expect(sql(`SELECT cancel_reason FROM terminal_charges WHERE idempotency_key = 'pin-timeout'`)).toBe('operator');
      const back = psql(target!, `UPDATE terminal_charges SET cancel_reason = 'timeout' WHERE idempotency_key = 'pin-timeout';`, DB);
      expect(back.ok).toBe(false);
      expect(back.message).toContain('já foi registrado');
    });

    it('cobrança de outra loja, operador inativo ou motivo curto: recusa com código', () => {
      expect(open('pin-codes').ok).toBe(true);
      expect(psql(target!, `SELECT tchefood_authorize_point_cancel('${OTHER}', 'pin-codes', '${OTHER_STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`, DB))
        .toMatchObject({ ok: false, sqlstate: 'TF005' });
      expect(authorize('pin-codes', MANAGER_PIN, INACTIVE)).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(authorize('pin-codes', MANAGER_PIN, STAFF, 'ok')).toMatchObject({ ok: false, sqlstate: 'TF006' });
      expect(sql(`SELECT cancel_reason IS NULL FROM terminal_charges WHERE idempotency_key = 'pin-codes'`)).toBe('t');
    });

    it('o gatilho recusa encerramento do operador sem gerente e cobrança mandada depois do pedido de encerramento', () => {
      expect(open('pin-guard').ok).toBe(true);
      const forged = psql(target!, `UPDATE terminal_charges SET cancel_reason = 'operator', cancel_requested_by = '${STAFF}', cancel_requested_at = NOW() WHERE idempotency_key = 'pin-guard';`, DB);
      expect(forged.ok).toBe(false);
      expect(forged.message).toContain('sem autorização de gerente');
      sql(`UPDATE terminal_charges SET cancel_reason = 'timeout', cancel_requested_at = NOW() WHERE idempotency_key = 'pin-guard';`);
      const late = psql(target!, `UPDATE terminal_charges SET dispatched_at = NOW() WHERE idempotency_key = 'pin-guard';`, DB);
      expect(late.ok).toBe(false);
      expect(late.message).toContain('encerrada antes de ir à maquininha');
      expect(open('pin-sent').ok).toBe(true);
      sql(`UPDATE terminal_charges SET dispatched_at = NOW() - INTERVAL '1 minute' WHERE idempotency_key = 'pin-sent';`);
      const again = psql(target!, `UPDATE terminal_charges SET dispatched_at = NOW() WHERE idempotency_key = 'pin-sent';`, DB);
      expect(again.ok).toBe(false);
      expect(again.message).toContain('já foi mandada');
    });

    it('o aparelho não chama a função (só a Edge Function, com a service role)', () => {
      for (const role of ['authenticated', 'anon']) {
        const r = psql(target!, `BEGIN; SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
          SELECT tchefood_authorize_point_cancel('${TENANT}', 'pin-ok', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu'); COMMIT;`, DB);
        expect(r.sqlstate, role).toBe('42501');
      }
    });

    it('auditoria r3 P2-01: o mesmo pedido autorizado dez vezes deixa UM registro e devolve sempre o mesmo', () => {
      expect(open('pin-ten').ok).toBe(true);
      const ids = new Set<string>();
      for (let i = 0; i < 10; i += 1) {
        // Da segunda em diante nem o PIN é conferido de novo (PIN errado não vira falha nem outro registro).
        const r = authorize('pin-ten', i === 0 ? MANAGER_PIN : i % 2 ? '0000' : MANAGER_PIN);
        expect(r.ok, r.message ?? '').toBe(true);
        ids.add(r.out);
      }
      expect(ids.size).toBe(1);
      expect(audits('POINT_CHARGE_CANCELED', 'pin-ten')).toBe('1');
      expect(audits('MANAGER_PIN_FAILED', 'pin-ten')).toBe('0');
      expect(sql(`SELECT cancel_audit_id FROM terminal_charges WHERE idempotency_key = 'pin-ten'`)).toBe([...ids][0]);
    });

    it('auditoria r3 P2-01: oito autorizações ao mesmo tempo gravam um registro só', async () => {
      expect(open('pin-race').ok).toBe(true);
      const out = await together(8, `SELECT tchefood_authorize_point_cancel('${TENANT}', 'pin-race', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`);
      expect(lastOverlap).toBe(8);
      expect(new Set(out).size).toBe(1);
      expect(out[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(audits('POINT_CHARGE_CANCELED', 'pin-race')).toBe('1');
    }, 30_000);

    it('auditoria r3 P2-01: cobrança que já terminou não ganha registro de encerramento (TF007)', () => {
      for (const [key, set] of [
        ['pin-paid', `status = 'approved', external_payment_id = '77', paid_amount_cents = 100, card_brand = 'VISA', authorization_code = 'OK7'`],
        ['pin-gone', `status = 'expired'`],
      ] as const) {
        expect(open(key).ok).toBe(true);
        sql(`UPDATE terminal_charges SET ${set} WHERE idempotency_key = '${key}';`);
        expect(authorize(key, MANAGER_PIN)).toMatchObject({ ok: false, sqlstate: 'TF007' });
        expect(authorize(key, '0000')).toMatchObject({ ok: false, sqlstate: 'TF007' });
        expect(sql(`SELECT count(*) FROM audit_logs WHERE metadata->>'idempotency_key' = '${key}'`)).toBe('0');
        expect(sql(`SELECT cancel_reason IS NULL AND cancel_audit_id IS NULL FROM terminal_charges WHERE idempotency_key = '${key}'`)).toBe('t');
      }
    });

    it('auditoria r3, terceira revisão: PIN de quem não é gerente, de gerente inativo e de gerente de outra loja não autoriza nada', () => {
      expect(open('pin-roles').ok).toBe(true);
      // Cada tentativa grava uma falha, e 3 em 60 s bloqueiam a loja. Para este teste e o seguinte (o do bloqueio)
      // partirem do zero, as falhas são apagadas pelo dono do banco, sem gatilhos, antes e depois.
      const clear = () => sql(`BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM audit_logs WHERE tenant_id = '${TENANT}' AND action_type = 'MANAGER_PIN_FAILED'; COMMIT;`);
      clear();
      // 5162 = caixa ativo desta loja; 3197 = gerente desta loja que saiu; 9753 = gerente ativo da outra loja.
      for (const pin of ['5162', '3197', '9753']) {
        const r = authorize('pin-roles', pin);
        expect(r.ok, r.message ?? '').toBe(true);
        expect(r.out, pin).toBe('');
      }
      // As três foram recusadas pelo PIN (não pelo bloqueio, que só entra na quarta).
      expect(audits('MANAGER_PIN_FAILED', 'pin-roles')).toBe('3');
      expect(audits('MANAGER_PIN_LOCKOUT', 'pin-roles')).toBe('0');
      expect(audits('POINT_CHARGE_CANCELED', 'pin-roles')).toBe('0');
      expect(sql(`SELECT cancel_reason IS NULL AND cancel_authorized_by IS NULL AND cancel_audit_id IS NULL FROM terminal_charges WHERE idempotency_key = 'pin-roles'`)).toBe('t');
      clear();
      // Sem as falhas, o PIN do gerente ativo desta loja autoriza a mesma cobrança.
      expect(authorize('pin-roles', MANAGER_PIN).out).toMatch(/^[0-9a-f-]{36}$/);
      expect(sql(`SELECT cancel_authorized_by FROM terminal_charges WHERE idempotency_key = 'pin-roles'`)).toBe(MANAGER);
    });

    // Por último: 3 PINs errados bloqueiam a loja por 60 s.
    it('PIN errado devolve NULL e registra a falha; 3 falhas em 60 s bloqueiam até o PIN certo', () => {
      expect(open('pin-bad').ok).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        const r = authorize('pin-bad', '0000');
        expect(r.ok, r.message ?? '').toBe(true);
        expect(r.out).toBe('');
      }
      expect(audits('MANAGER_PIN_FAILED', 'pin-bad')).toBe('3');
      expect(authorize('pin-bad', MANAGER_PIN).out).toBe('');
      expect(audits('MANAGER_PIN_LOCKOUT', 'pin-bad')).toBe('1');
      expect(audits('POINT_CHARGE_CANCELED', 'pin-bad')).toBe('0');
      expect(sql(`SELECT cancel_reason IS NULL FROM terminal_charges WHERE idempotency_key = 'pin-bad'`)).toBe('t');
    });
  });

  // Conta própria (ORDER6, saldo de R$ 100,00): as cobranças de teste deixadas na ORDER reservam o saldo
  // dela, e a reserva vale para qualquer pagamento (db/schema_point_reserva.sql).
  it('pagamento igual à cobrança aprovada entra, e a mesma cobrança não paga duas vezes', () => {
    const key = charge({ order_id: ORDER6 });
    const r = pay(key, { order_id: ORDER6 });
    expect(r.ok, r.message ?? '').toBe(true);
    const again = pay(key, { order_id: ORDER6 });
    expect(again.ok).toBe(false);
  });

  it('recusado do Mercado Pago e Stone aprovado seguem as regras de antes (a Stone, com a reserva dela: a loja tem Point)', () => {
    expect(pay('chave-recusada', { status: 'DECLINED', nsu: null, authorization_code: null, card_brand: null }).ok).toBe(true);
    const stoneOver = { order_id: ORDER6, acquirer: 'STONE', acquirer_cnpj: '16501555000157', terminal_id: STONE_TERMINAL, terminal_serial: 'STONE-01', nsu: '784512', authorization_code: 'A12345' };
    // Revisão P1-B: sem a reserva no servidor, a Stone aprovada na loja com Point é recusada (TF010).
    expect(pay('stone-1', stoneOver)).toMatchObject({ ok: false, sqlstate: 'TF010' });
    sql(`INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
         VALUES ('${TENANT}', 'stone-1', '${ORDER6}', 'CREDIT', 'STONE', 1000, '${STAFF}');`);
    const stone = pay('stone-1', stoneOver);
    expect(stone.ok, stone.message ?? '').toBe(true);
    expect(sql(`SELECT status FROM payment_claims WHERE idempotency_key = 'stone-1'`)).toBe('consumed');
  });

  it('auditoria r3: a migration roda de novo sem erro e devolve as colunas e a regra que faltarem (banco de uma versão anterior)', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    const f = readdirSync(dir).find((x) => x.includes('mercado_pago'))!;
    expect(() => psqlFile(target!, join(dir, f), DB)).not.toThrow();
    const columns = () => sql(`SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
                               WHERE table_name = 'terminal_charges' AND column_name IN ('dispatched_at', 'dispatch_lease_until', 'dispatch_attempts', 'cancel_audit_id', 'cancel_authorized_by')`);
    const reasonCheck = () => sql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'terminal_charges'::regclass AND conname = 'terminal_charges_cancel_reason_check'`);
    expect(columns()).toBe('cancel_audit_id,cancel_authorized_by,dispatch_attempts,dispatch_lease_until,dispatched_at');
    // Banco que rodou a versão da rodada 2: sem posse do envio, sem autorização de gerente e sem o motivo "void".
    sql(`ALTER TABLE terminal_charges DROP COLUMN dispatch_lease_until, DROP COLUMN dispatch_attempts, DROP COLUMN cancel_audit_id, DROP COLUMN cancel_authorized_by;
         ALTER TABLE terminal_charges DROP CONSTRAINT terminal_charges_cancel_reason_check;
         ALTER TABLE terminal_charges ADD CONSTRAINT terminal_charges_cancel_reason_check CHECK (cancel_reason IN ('timeout', 'operator')) NOT VALID;`);
    expect(columns()).toBe('dispatched_at');
    expect(() => psqlFile(target!, join(dir, f), DB)).not.toThrow();
    expect(columns()).toBe('cancel_audit_id,cancel_authorized_by,dispatch_attempts,dispatch_lease_until,dispatched_at');
    expect(reasonCheck()).toContain('void');
    expect(sql(`SELECT is_nullable || '|' || column_default FROM information_schema.columns WHERE table_name = 'terminal_charges' AND column_name = 'dispatch_attempts'`)).toBe('NO|0');
    // E as funções voltam a funcionar em cima delas: abrir, pedir a posse, passar a barreira e bloquear uma chave.
    const open = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'mig-a', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}', ${bal(ORDER3)});`, DB);
    expect(open.ok, open.message ?? '').toBe(true);
    expect(psql(target!, `SELECT tchefood_claim_point_dispatch('${TENANT}', '${open.out}', 30000);`, DB).out).toBe('1');
    expect(psql(target!, `SELECT tchefood_begin_point_dispatch('${TENANT}', '${open.out}', 1, 30000, true);`, DB).out).toBe('1');
    const blocked = psql(target!, `SELECT tchefood_block_point_key('${TENANT}', 'mig-b', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`, DB);
    expect(blocked.ok, blocked.message ?? '').toBe(true);
    expect(() => psqlFile(target!, join(dir, f), DB)).not.toThrow();
  });

  // db/schema_point_reserva.sql: a cobrança da Point em andamento reserva o saldo para qualquer pagamento.
  describe('reserva da Point vale para dinheiro, outra maquininha e Pix', () => {
    let seq = 0;
    /** Conta nova com saldo `balance` (sem itens: cada conta recebe um pagamento só, o recálculo zeraria o resto). */
    const fresh = (balance: number): string => {
      seq += 1;
      const id = `f0f0f0f0-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${id}', '${TENANT}', '${TABLE}', '${STAFF}');
           BEGIN; SET LOCAL session_replication_role = replica;
           UPDATE orders SET total_amount = ${balance}, remaining_balance = ${balance} WHERE id = '${id}'; COMMIT;`);
      return id;
    };
    const openPoint = (key: string, order: string, cents: number) =>
      psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}', ${bal(order)});`, DB);
    /** Muda o estado da cobrança só para montar o cenário (sem os gatilhos da cobrança). */
    const force = (key: string, status: string) =>
      sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE terminal_charges SET status = '${status}' WHERE idempotency_key = '${key}'; COMMIT;`);
    const payment = (order: string, amount: number, over: Record<string, unknown> = {}) => JSON.stringify({
      id: crypto.randomUUID(), order_id: order, tenant_id: TENANT, waiter_id: STAFF, terminal_id: null, amount, tip_amount: 0,
      method: 'CASH', status: 'APPROVED', acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null,
      terminal_serial: null, idempotency_key: crypto.randomUUID(), created_at: new Date().toISOString(), ...over,
    });
    /**
     * Revisão P1-B: a loja tem Point, então o pagamento fora dela só entra com a reserva no servidor. Aqui a reserva
     * é gravada direto (dono do banco), na MESMA transação do pagamento do aparelho, para testar a conta da reserva
     * da Point no gatilho de payments (a reserva do próprio pagamento fica de fora da soma). Chave de cobrança da
     * Point não vira reserva (TF009): nesse caso vai sem reserva, e o gatilho de payments recusa pela chave.
     */
    const claimFor = (json: string) => {
      const p = JSON.parse(json) as { tenant_id: string; idempotency_key: string; order_id: string; method: string; acquirer: string; amount: number; waiter_id: string };
      return `INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
              SELECT '${p.tenant_id}', '${p.idempotency_key}', '${p.order_id}', '${p.method}', '${p.acquirer}', ${Math.round(p.amount * 100)}, '${p.waiter_id}'
               WHERE NOT EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = '${p.idempotency_key}');`;
    };
    const register = (json: string) => psql(target!, `BEGIN; ${claimFor(json)} SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true); SELECT tchefood_register_payment('${json}'::jsonb); COMMIT;`, DB);
    const stone = (order: string, amount: number) => payment(order, amount, {
      method: 'CREDIT', acquirer: 'STONE', acquirer_cnpj: '16501555000157', terminal_id: STONE_TERMINAL, terminal_serial: 'STONE-01',
      card_brand: 'VISA', nsu: `R${crypto.randomUUID().slice(0, 8)}`, authorization_code: 'A12345',
    });
    const reservation = (order: string, tenant = TENANT) => {
      const r = asDevice(`SELECT tchefood_point_reservation('${order}')`, tenant);
      if (!r.ok) throw new Error(r.message ?? 'reserva');
      return JSON.parse(r.out.split('\n').pop()!) as { reserved_cents: number; open_charges: number; manual_review: boolean };
    };

    it('dinheiro e Stone não pagam o valor reservado por cobrança aberta; o que sobra entra', () => {
      for (const status of ['creating', 'pending', 'at_terminal', 'manual_review', 'approved']) {
        // Conta com item: o recálculo depois do pagamento mantém o total (fresh() o zeraria, abaixo do reservado: TF012).
        const order = withItems(100);
        expect(openPoint(`res-${status}`, order, 6000).ok).toBe(true);
        if (status !== 'creating') force(`res-${status}`, status);
        const cash = register(payment(order, 100));
        expect(cash.ok, status).toBe(false);
        expect(cash.message, status).toMatch(/há uma cobrança na Point em andamento nesta conta \(R\$ 60\.00 reservado\)\. Livre para este pagamento: R\$ 40\.00/);
        expect(register(stone(order, 40.01)).message, status).toMatch(/cobrança na Point em andamento/);
        expect(register(payment(order, 100, { method: 'PIX', acquirer: 'STONE', acquirer_cnpj: '16501555000157', nsu: `P${seq}${status}` })).message, status).toMatch(/cobrança na Point em andamento/);
        expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`), status).toBe('0');
        const ok = register(payment(order, 40));
        expect(ok.ok, ok.message ?? status).toBe(true);
      }
    });

    it('cobrança que terminou (recusada, cancelada, expirada, estornada) não reserva mais', () => {
      for (const status of ['rejected', 'cancelled', 'expired', 'refunded']) {
        const order = fresh(100);
        expect(openPoint(`fim-${status}`, order, 6000).ok).toBe(true);
        force(`fim-${status}`, status);
        const r = register(payment(order, 100));
        expect(r.ok, r.message ?? status).toBe(true);
      }
    });

    it('cobrança aprovada já registrada como pagamento não reserva de novo, e o próprio pagamento dela entra', () => {
      const order = fresh(100);
      // A cobrança aprovada reserva os R$ 100,00 inteiros, mas o pagamento DELA consome a própria reserva.
      const key = charge({ order_id: order, amount_cents: 10000, paid_amount_cents: 10000 });
      const own = pay(key, { order_id: order, amount: 100 });
      expect(own.ok, own.message ?? '').toBe(true);
      expect(reservation(order)).toMatchObject({ reserved_cents: 0, open_charges: 0, manual_review: false, charges: [] });
    });

    it('duas cobranças abertas somam; reserva de outra conta não conta', () => {
      const order = withItems(100);
      const other = fresh(100);
      expect(openPoint('soma-a', order, 3000).ok).toBe(true);
      expect(openPoint('soma-b', order, 2500).ok).toBe(true);
      force('soma-b', 'manual_review');
      expect(openPoint('soma-outra', other, 9000).ok).toBe(true);
      expect(reservation(order)).toMatchObject({ reserved_cents: 5500, point_cents: 5500, claims_cents: 0, open_charges: 2, manual_review: true });
      expect(register(payment(order, 45.01)).message).toMatch(/R\$ 55\.00 reservado\)\. Livre para este pagamento: R\$ 45\.00/);
      expect(register(payment(order, 45)).ok).toBe(true);
    });

    it('o aparelho lê só a reserva da própria loja', () => {
      const order = fresh(100);
      expect(openPoint('leitura', order, 1000).ok).toBe(true);
      expect(reservation(order).reserved_cents).toBe(1000);
      expect(reservation(order, OTHER)).toEqual({ reserved_cents: 0, point_cents: 0, claims_cents: 0, open_charges: 0, manual_review: false, charges: [], claims: [] });
      expect(asDevice(`SELECT tchefood_point_reserved_cents('${TENANT}', '${order}', NULL)`, OTHER).ok).toBe(false);
      expect(psql(target!, `SET ROLE anon; SELECT tchefood_point_reservation('${order}');`, DB).ok).toBe(false);
    });

    /**
     * O caminho do aparelho na loja com Point: a reserva (tchefood_claim_payment, que trava a conta e confere o
     * saldo livre) e o pagamento com a chave dela, num comando só (se a reserva é recusada, nada é gravado).
     */
    const claimAndPay = (json: string, expected: number | string) => {
      const p = JSON.parse(json) as { idempotency_key: string; order_id: string; method: string; acquirer: string; amount: number; waiter_id: string };
      return `WITH c AS MATERIALIZED (SELECT tchefood_claim_payment('${p.idempotency_key}', '${p.order_id}', '${p.method}', '${p.acquirer}', ${Math.round(p.amount * 100)}, ${expected}, '${p.waiter_id}', '${'c'.repeat(64)}') AS r)
              SELECT tchefood_register_payment('${json}'::jsonb) FROM c`;
    };

    it('cobrança e dinheiro ao mesmo tempo na mesma conta: a conta travada deixa passar só o que cabe no saldo', async () => {
      const order = fresh(100);
      const tryFn = `CREATE FUNCTION pg_temp.t(q text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE q; RETURN 'ok'; EXCEPTION WHEN others THEN RETURN 'recusado: ' || SQLERRM; END $f$;`;
      const [point, cash] = await contend(`SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`, [
        `${tryFn} SELECT pg_temp.t($q$SELECT tchefood_open_terminal_charge('${TENANT}', 'junto', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 10000, '${STAFF}', 10000)$q$);`,
        `${tryFn} BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
         SELECT pg_temp.t($q$${claimAndPay(payment(order, 100), 10000)}$q$); COMMIT;`,
      ]);
      expect(lastOverlap).toBe(2);
      expect(point).toBe('ok');
      // A reserva do dinheiro espera a conta travada e vê a cobrança gravada: nada passa, nada é gravado.
      expect(cash).toMatch(/^recusado: .*R\$ 100\.00 passa do saldo livre da conta no servidor \(R\$ 0\.00 livre; R\$ 100\.00 reservado/);
      expect(sql(`SELECT count(*) FROM payment_claims WHERE order_id = '${order}'`)).toBe('0');
      expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
    });

    /**
     * Conta de verdade com saldo `balance` (um item, sem 10%): ao contrário de fresh(), o recálculo do banco
     * mantém o total depois de cada pagamento, então a conta aceita vários pagamentos e fecha sozinha no zero.
     */
    const withItems = (balance: number): string => {
      const order = fresh(balance);
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
           INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
           VALUES ('${order}', gen_random_uuid(), '${STAFF}', 1, ${balance}, ${balance}, 'NONE');
           UPDATE orders SET charge_service_fee = false, subtotal_items = ${balance}, total_amount = ${balance}, paid_amount = 0, remaining_balance = ${balance} WHERE id = '${order}';
           COMMIT;`);
      return order;
    };
    /** Roda q e devolve 'ok' ou 'recusado <SQLSTATE>: <mensagem>' (a sessão não cai, o resultado vira a última linha). */
    const tryFn = `CREATE FUNCTION pg_temp.t(q text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE q; RETURN 'ok'; EXCEPTION WHEN others THEN RETURN 'recusado ' || SQLSTATE || ': ' || SQLERRM; END $f$;`;
    const pointQ = (key: string, order: string, cents: number, expected: number | string) =>
      `${tryFn} SELECT pg_temp.t($q$SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}', ${expected})$q$);`;
    /** Reserva e pagamento do aparelho num comando só (claimAndPay), com o saldo que o aparelho viu ao montar. */
    const deviceQ = (json: string) =>
      `${tryFn} BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
       SELECT pg_temp.t($q$${claimAndPay(json, bal((JSON.parse(json) as { order_id: string }).order_id))}$q$); COMMIT;`;
    const field = (key: string, expr: string) => sql(`SELECT ${expr} FROM terminal_charges WHERE idempotency_key = '${key}'`);
    const lockOrder = (order: string) => `SELECT 1 FROM orders WHERE id = '${order}' FOR UPDATE`;
    const charges = (key: string) => sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${key}'`);
    const approved = (order: string) => sql(`SELECT COALESCE(sum(amount), 0) FROM payments WHERE order_id = '${order}' AND status = 'APPROVED'`);
    const balanceOf = (order: string) => sql(`SELECT remaining_balance || '|' || status FROM orders WHERE id = '${order}'`);

    describe('auditoria r4 P0-01: Point e outra forma de pagamento na mesma conta de R$ 100,00, ao mesmo tempo, nas duas ordens', () => {
      it('(a) a Point reserva R$ 100,00 primeiro: a Stone de R$ 100,00 que esperava a conta é recusada', async () => {
        for (let i = 0; i < 3; i += 1) {
          const order = withItems(100);
          const key = `r4a-${i}`;
          const [point, card] = await contend(lockOrder(order), [pointQ(key, order, 10000, 10000), deviceQ(stone(order, 100))]);
          expect(lastOverlap, key).toBe(2);
          expect(point, key).toBe('ok');
          expect(card, key).toMatch(/^recusado TF003: .*R\$ 100\.00 passa do saldo livre da conta no servidor \(R\$ 0\.00 livre; R\$ 100\.00 reservado/);
          expect(sql(`SELECT count(*) FROM payment_claims WHERE order_id = '${order}'`), key).toBe('0');
          expect(approved(order), key).toBe('0');
          expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`), key).toBe('0');
          expect(field(key, `status || '|' || amount_cents`), key).toBe('creating|10000');
          expect(balanceOf(order), key).toBe('100.00|OPEN');
        }
      }, 60_000);

      it('(b) a Stone de R$ 100,00 liquida primeiro: a Point que esperava a conta é recusada e nenhuma cobrança é gravada', async () => {
        // Conta de verdade: a Stone quita e a conta fecha sozinha; a Point encontra a conta fechada (TF002).
        for (let i = 0; i < 2; i += 1) {
          const order = withItems(100);
          const key = `r4b-closed-${i}`;
          const [card, point] = await contend(lockOrder(order), [deviceQ(stone(order, 100)), pointQ(key, order, 10000, 10000)]);
          expect(lastOverlap, key).toBe(2);
          expect(card, key).toBe('ok');
          expect(point, key).toMatch(/^recusado TF002: .*conta já está fechada/);
          expect(charges(key), key).toBe('0');
          expect(approved(order), key).toBe('100.00');
          expect(balanceOf(order), key).toBe('0.00|CLOSED');
        }
        // Conta ainda aberta com saldo zero (fresh(): sem itens, o recálculo zera o total e a conta não fecha):
        // com o saldo que o aparelho viu antes (R$ 100,00) a Point recusa por saldo diferente (TF008); mesmo
        // mandando o saldo novo (R$ 0,00), os R$ 100,00 passam do saldo (TF003). Nada é gravado.
        for (const [expected, code] of [[10000, 'TF008'], [0, 'TF003']] as const) {
          const order = fresh(100);
          const key = `r4b-${code}`;
          const [card, point] = await contend(lockOrder(order), [deviceQ(stone(order, 100)), pointQ(key, order, 10000, expected)]);
          expect(lastOverlap, key).toBe(2);
          expect(card, key).toBe('ok');
          expect(point, key).toMatch(code === 'TF008'
            ? /^recusado TF008: .*saldo de R\$ 0\.00, diferente do R\$ 100\.00 mostrado no aparelho\. Nada foi cobrado/
            : /^recusado TF003: .*R\$ 100\.00 passa do saldo da conta no servidor \(R\$ 0\.00 livre\)/);
          expect(charges(key), key).toBe('0');
          expect(approved(order), key).toBe('100.00');
        }
      }, 90_000);

      it('(c) Point de R$ 60,00 e dinheiro ao mesmo tempo, nas duas ordens: R$ 40,00 entra, R$ 40,01 não passa do saldo', async () => {
        // Point na frente: a reserva vale para o dinheiro que esperava a conta.
        for (const [cash, ok] of [[40.01, false], [40, true]] as const) {
          const order = withItems(100);
          const key = `r4c-point-${cash}`.replace('.', '_');
          const [point, money] = await contend(lockOrder(order), [pointQ(key, order, 6000, 10000), deviceQ(payment(order, cash))]);
          expect(lastOverlap, key).toBe(2);
          expect(point, key).toBe('ok');
          if (ok) expect(money, key).toBe('ok');
          else expect(money, key).toMatch(/^recusado TF003: .*R\$ 40\.01 passa do saldo livre da conta no servidor \(R\$ 40\.00 livre; R\$ 60\.00 reservado/);
          expect(approved(order), key).toBe(ok ? '40.00' : '0');
          expect(field(key, 'status'), key).toBe('creating');
        }
        // Dinheiro na frente: ele entra; a Point, preparada com o saldo de antes (R$ 100,00), é recusada por saldo
        // diferente sem gravar nada. Cobrada de novo com o saldo novo: R$ 60,00 cabem depois de R$ 40,00 e
        // não cabem depois de R$ 40,01.
        for (const [cash, ok] of [[40.01, false], [40, true]] as const) {
          const order = withItems(100);
          const key = `r4c-cash-${cash}`.replace('.', '_');
          const [money, point] = await contend(lockOrder(order), [deviceQ(payment(order, cash)), pointQ(key, order, 6000, 10000)]);
          expect(lastOverlap, key).toBe(2);
          expect(money, key).toBe('ok');
          expect(point, key).toMatch(/^recusado TF008: /);
          expect(charges(key), key).toBe('0');
          const synced = Math.round((100 - cash) * 100);
          const retry = openPoint(`${key}-de-novo`, order, 6000);
          if (ok) {
            expect(retry.ok, retry.message ?? key).toBe(true);
          } else {
            expect(retry, key).toMatchObject({ ok: false, sqlstate: 'TF003' });
            expect(retry.message, key).toContain(`R$ ${(synced / 100).toFixed(2)} livre`);
          }
        }
      }, 90_000);

      it('o UPDATE também é conferido: pendente que vira aprovado, valor que sobe e pagamento que muda de conta não passam da reserva', () => {
        const order = withItems(100);
        expect(openPoint('r4-upd', order, 6000).ok).toBe(true);
        /**
         * Pagamento direto no banco com a reserva dele (chave = id do pagamento) gravada antes, na mesma transação: a
         * chave de um pagamento já gravado não vira reserva depois (TF009), então quem vai ser aprovado por UPDATE nasce
         * com a reserva. O aprovado nasce sempre com ela (a loja tem Point).
         */
        const insert = (orderId: string, amount: number, status: string, claimCents?: number) => {
          const id = crypto.randomUUID();
          const cents = claimCents ?? (status === 'APPROVED' ? Math.round(amount * 100) : null);
          sql(`BEGIN; ${cents === null ? '' : `INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
               VALUES ('${TENANT}', '${id}', '${orderId}', 'CASH', 'CASH_DESK', ${cents}, '${STAFF}');`}
               INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
               VALUES ('${id}', '${orderId}', '${TENANT}', '${STAFF}', ${amount}, 'CASH', '${status}', 'CASH_DESK', '${id}'); COMMIT;`);
          return id;
        };
        const update = (id: string, set: string) => psql(target!, `UPDATE payments SET ${set} WHERE id = '${id}';`, DB);
        const reserved = /há uma cobrança na Point em andamento nesta conta \(R\$ 60\.00 reservado\)/;
        // Revisão P1-B: pendente SEM reserva que vira aprovado: nem chega à conta da Point (TF010).
        const bare = insert(order, 100, 'PENDING');
        expect(update(bare, `status = 'APPROVED'`)).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(sql(`SELECT status FROM payments WHERE id = '${bare}'`)).toBe('PENDING');
        // Pendente de R$ 100,00 (não abate saldo), com a reserva dele, que vira aprovado por UPDATE: recusado pela Point.
        const big = insert(order, 100, 'PENDING', 10000);
        const promote = update(big, `status = 'APPROVED'`);
        expect(promote.ok).toBe(false);
        expect(promote.message).toMatch(reserved);
        expect(sql(`SELECT status FROM payments WHERE id = '${big}'`)).toBe('PENDING');
        // Recusado (DECLINED) que vira aprovado: também.
        expect(update(big, `status = 'DECLINED'`).ok).toBe(true);
        expect(update(big, `status = 'APPROVED'`).message).toMatch(reserved);
        // Só para o resto do cenário: a reserva de R$ 100,00 que não virou pagamento sai.
        sql(`DELETE FROM payment_claims WHERE idempotency_key = '${big}' AND status = 'open';`);
        // Pendente de R$ 40,00 vira aprovado: cabe (100 - 60), e consome a reserva dele.
        const cash = insert(order, 40, 'PENDING', 4000);
        const ok = update(cash, `status = 'APPROVED'`);
        expect(ok.ok, ok.message ?? '').toBe(true);
        expect(balanceOf(order)).toBe('60.00|OPEN');
        expect(sql(`SELECT status || '|' || (consumed_payment_id = '${cash}') FROM payment_claims WHERE idempotency_key = '${cash}'`)).toBe('consumed|true');
        // Valor aprovado que sobe 1 centavo: passa do valor reservado para ele (TF010), antes mesmo da reserva da Point.
        const up = update(cash, 'amount = 40.01');
        expect(up).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(up.message).toContain('R$ 40.01 passa do valor reservado para este pagamento (R$ 40.00)');
        // O próprio valor não conta duas vezes: o saldo gravado (R$ 60,00) já desconta estes R$ 40,00. Baixar
        // para 39,00 e voltar para 40,00 cabe (com o saldo gravado de R$ 61,00 contado de novo, só caberia R$ 1,00).
        expect(update(cash, 'amount = 39').ok).toBe(true);
        expect(balanceOf(order)).toBe('61.00|OPEN');
        const back = update(cash, 'amount = 40');
        expect(back.ok, back.message ?? '').toBe(true);
        expect(balanceOf(order)).toBe('60.00|OPEN');
        // Aprovado → aprovado com o mesmo valor, ou outro campo: não reabre a conferência (nada sai da reserva).
        expect(update(cash, `status = 'APPROVED'`).ok).toBe(true);
        expect(update(cash, 'tip_amount = 5').ok).toBe(true);
        // Pagamento aprovado de outra conta que muda para esta: recusado (a reserva dele é da outra conta, TF010).
        const other = withItems(100);
        const moved = insert(other, 10, 'APPROVED');
        const move = update(moved, `order_id = '${order}'`);
        expect(move).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(move.message).toContain('é da reserva de pagamento de outra conta');
        expect(sql(`SELECT order_id FROM payments WHERE id = '${moved}'`)).toBe(other);
        expect(approved(order)).toBe('40.00');
        // Cobrança encerrada: a reserva sai, e o pendente de R$ 60,00 que não cabia passa a caber.
        const rest = insert(order, 60, 'PENDING', 6000);
        expect(update(rest, `status = 'APPROVED'`).message).toMatch(/Livre para este pagamento: R\$ 0\.00/);
        force('r4-upd', 'cancelled');
        const paid = update(rest, `status = 'APPROVED'`);
        expect(paid.ok, paid.message ?? '').toBe(true);
        expect(balanceOf(order)).toBe('0.00|CLOSED');
        expect(sql(`SELECT status FROM payments WHERE id = '${big}'`)).toBe('DECLINED');
      });

      it('chave de cobrança da Point em pagamento que não é do Mercado Pago (dinheiro, Stone, Pix), pelo aparelho: recusado, e a reserva continua inteira', () => {
        // Cobrança aberta de R$ 60,00 numa conta de R$ 100,00: R$ 10,00 caberiam com qualquer chave, menos a dela.
        const order = withItems(100);
        expect(openPoint('r4-furo', order, 6000).ok).toBe(true);
        const attempts = [
          ['dinheiro de R$ 100,00', payment(order, 100, { idempotency_key: 'r4-furo' })],
          ['dinheiro de R$ 10,00', payment(order, 10, { idempotency_key: 'r4-furo' })],
          ['Stone', payment(order, 10, { method: 'CREDIT', acquirer: 'STONE', acquirer_cnpj: '16501555000157', terminal_id: STONE_TERMINAL, terminal_serial: 'STONE-01', card_brand: 'VISA', nsu: 'R4FURO1', authorization_code: 'A1', idempotency_key: 'r4-furo' })],
          ['Pix', payment(order, 10, { method: 'PIX', acquirer: 'STONE', acquirer_cnpj: '16501555000157', nsu: 'R4FURO2', idempotency_key: 'r4-furo' })],
        ] as const;
        for (const [label, json] of attempts) {
          const r = register(json);
          expect(r.ok, label).toBe(false);
          expect(r.message, label).toContain('a chave r4-furo é de uma cobrança da Point');
        }
        expect(sql(`SELECT count(*) FROM payments WHERE order_id = '${order}'`)).toBe('0');
        expect(reservation(order)).toMatchObject({ reserved_cents: 6000, open_charges: 1, manual_review: false });
        // Mesmo gravando direto no banco (fora do aparelho): recusado.
        const direct = psql(target!, `INSERT INTO payments (order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
                                      VALUES ('${order}', '${TENANT}', '${STAFF}', 10, 'CASH', 'APPROVED', 'CASH_DESK', 'r4-furo');`, DB);
        expect(direct.ok).toBe(false);
        expect(direct.message).toContain('é de uma cobrança da Point');
        // Com outra chave, os R$ 40,00 livres entram normalmente.
        expect(register(payment(order, 40)).ok).toBe(true);
        expect(openPoint('r4-furo-2', order, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      });

      it('cobrança APROVADA ainda sem pagamento: dinheiro com a chave dela é recusado e não a consome; o pagamento do Mercado Pago dela entra e consome', () => {
        const order = withItems(100);
        const key = charge({ order_id: order, amount_cents: 6000, paid_amount_cents: 6000 });
        const cash = register(payment(order, 60, { idempotency_key: key }));
        expect(cash.ok).toBe(false);
        expect(cash.message).toContain('é de uma cobrança da Point');
        expect(reservation(order).reserved_cents).toBe(6000);
        // O caminho legítimo: o pagamento do Mercado Pago, igual à cobrança aprovada, entra e consome a própria reserva.
        const mp = pay(key, { order_id: order, amount: 60 });
        expect(mp.ok, mp.message ?? '').toBe(true);
        expect(reservation(order)).toMatchObject({ reserved_cents: 0, open_charges: 0, manual_review: false, charges: [] });
        expect(balanceOf(order)).toBe('40.00|OPEN');
        // E a Point nova da conta vê os R$ 40,00 livres.
        expect(openPoint('r4-furo-mp', order, 4001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
        expect(openPoint('r4-furo-mp', order, 4000).ok).toBe(true);
      });

      it('pagamento do Mercado Pago que troca de credenciadora mantendo a chave da cobrança é recusado (a reserva não some nem volta por baixo)', () => {
        const order = withItems(100);
        const key = charge({ order_id: order, amount_cents: 3000, paid_amount_cents: 3000 });
        expect(pay(key, { order_id: order, amount: 30 }).ok).toBe(true);
        const r = psql(target!, `UPDATE payments SET acquirer = 'STONE', acquirer_cnpj = '16501555000157' WHERE idempotency_key = '${key}';`, DB);
        expect(r.ok).toBe(false);
        expect(r.message).toContain('é de uma cobrança da Point');
        expect(sql(`SELECT acquirer FROM payments WHERE idempotency_key = '${key}'`)).toBe('MERCADO_PAGO');
      });

      it('o UPDATE que troca a loja do pagamento aprovado para uma loja que não é a da conta é recusado', () => {
        const order = withItems(100);
        const id = crypto.randomUUID();
        sql(`INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
             VALUES ('${TENANT}', '${id}', '${order}', 'CASH', 'CASH_DESK', 1000, '${STAFF}');
             INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
             VALUES ('${id}', '${order}', '${TENANT}', '${STAFF}', 10, 'CASH', 'APPROVED', 'CASH_DESK', '${id}');`);
        const r = psql(target!, `UPDATE payments SET tenant_id = '${OTHER}' WHERE id = '${id}';`, DB);
        expect(r.ok).toBe(false);
        expect(r.message).toContain('não é da loja dele');
        expect(sql(`SELECT tenant_id FROM payments WHERE id = '${id}'`)).toBe(TENANT);
      });

      it('o UPDATE que dá a outro pagamento a chave de uma cobrança da Point é recusado, e a reserva dela continua', () => {
        const order = withItems(100);
        // Cobrança aprovada de R$ 60,00, ainda sem o pagamento dela gravado: reserva R$ 60,00.
        const key = charge({ order_id: order, amount_cents: 6000, paid_amount_cents: 6000 });
        const insert = (amount: number, status: string) => {
          const id = crypto.randomUUID();
          // O aprovado nasce com a reserva dele (a loja tem Point).
          sql(`${status === 'APPROVED' ? `INSERT INTO payment_claims (tenant_id, idempotency_key, order_id, method, acquirer, amount_cents, created_by)
               VALUES ('${TENANT}', '${id}', '${order}', 'CASH', 'CASH_DESK', ${Math.round(amount * 100)}, '${STAFF}');` : ''}
               INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, status, acquirer, idempotency_key)
               VALUES ('${id}', '${order}', '${TENANT}', '${STAFF}', ${amount}, 'CASH', '${status}', 'CASH_DESK', '${id}');`);
          return id;
        };
        // Dinheiro aprovado de R$ 40,00 (cabe) que troca a chave pela da cobrança: recusado.
        const cash = insert(40, 'APPROVED');
        const swap = psql(target!, `UPDATE payments SET idempotency_key = '${key}' WHERE id = '${cash}';`, DB);
        expect(swap.ok).toBe(false);
        expect(swap.message).toContain(`a chave ${key} é de uma cobrança da Point`);
        // Pendente que recebe a chave (ainda não conferido) e depois vira aprovado: recusado na aprovação.
        const pending = insert(60, 'PENDING');
        expect(psql(target!, `UPDATE payments SET idempotency_key = '${key}' WHERE id = '${pending}';`, DB).ok).toBe(true);
        const promote = psql(target!, `UPDATE payments SET status = 'APPROVED' WHERE id = '${pending}';`, DB);
        expect(promote.ok).toBe(false);
        expect(promote.message).toContain('é de uma cobrança da Point');
        // A reserva da cobrança continua inteira. Revisão P1-B: trocar para uma chave sem reserva também é recusado
        // na loja com Point (TF010); o pagamento segue com a chave e a reserva dele.
        expect(reservation(order).reserved_cents).toBe(6000);
        expect(psql(target!, `UPDATE payments SET idempotency_key = 'r4-chave-livre' WHERE id = '${cash}';`, DB)).toMatchObject({ ok: false, sqlstate: 'TF010' });
        expect(sql(`SELECT idempotency_key FROM payments WHERE id = '${cash}'`)).toBe(cash);
        expect(balanceOf(order)).toBe('60.00|OPEN');
      });
    });

    describe('auditoria r4 P1-01: o saldo da conta é conferido no servidor ao abrir a cobrança', () => {
      const openWith = (key: string, order: string, cents: number, expected: string | number) =>
        psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}', ${expected});`, DB);

      it('saldo diferente do da nuvem (para mais ou para menos, até 1 centavo): TF008 e nenhuma cobrança gravada', () => {
        const order = withItems(100);
        for (const expected of [9999, 10001, 0, 5000]) {
          const r = openWith('r4-saldo', order, 1000, expected);
          expect(r, String(expected)).toMatchObject({ ok: false, sqlstate: 'TF008' });
          expect(r.message, String(expected)).toContain(`TCHEFOOD_COBRANCA: a conta na nuvem tem saldo de R$ 100.00, diferente do R$ ${(expected / 100).toFixed(2)} mostrado no aparelho. Nada foi cobrado`);
        }
        // Saldo diferente vem antes do "passa do saldo": quem viu outro saldo sincroniza primeiro.
        expect(openWith('r4-saldo', order, 20000, 9999)).toMatchObject({ ok: false, sqlstate: 'TF008' });
        expect(charges('r4-saldo')).toBe('0');
        expect(reservation(order).reserved_cents).toBe(0);
        // Igual: abre.
        const ok = openWith('r4-saldo', order, 1000, 10000);
        expect(ok.ok, ok.message ?? '').toBe(true);
        expect(field('r4-saldo', `status || '|' || amount_cents`)).toBe('creating|1000');
      });

      it('saldo não mandado (NULL) ou negativo: recusado (TF008) e nada gravado; a assinatura antiga, sem o saldo, não existe mais', () => {
        const order = withItems(100);
        for (const expected of ['NULL', '-1', '-10000']) {
          const r = openWith('r4-sem-saldo', order, 1000, expected);
          expect(r, expected).toMatchObject({ ok: false, sqlstate: 'TF008' });
          expect(r.message, expected).toContain('Nada foi cobrado');
        }
        const old = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'r4-sem-saldo', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1000, '${STAFF}');`, DB);
        expect(old).toMatchObject({ ok: false, sqlstate: '42883' });
        expect(sql(`SELECT count(*) FROM pg_proc WHERE proname = 'tchefood_open_terminal_charge'`)).toBe('1');
        expect(charges('r4-sem-saldo')).toBe('0');
      });

      it('reenvio da mesma chave depois de o saldo mudar de verdade devolve a cobrança gravada (não TF008); chave nova confere o saldo novo', () => {
        const order = withItems(100);
        const first = openWith('r4-reenvio', order, 3000, 10000);
        expect(first.ok, first.message ?? '').toBe(true);
        // Dinheiro de R$ 20,00 entra (cabe: 100 - 30 reservados): o saldo da nuvem vai a R$ 80,00.
        const cash = register(payment(order, 20));
        expect(cash.ok, cash.message ?? '').toBe(true);
        expect(balanceOf(order)).toBe('80.00|OPEN');
        // O reenvio com o saldo antigo (o do pedido original) devolve a MESMA cobrança, sem gravar outra.
        expect(openWith('r4-reenvio', order, 3000, 10000).out).toBe(first.out);
        expect(openWith('r4-reenvio', order, 3000, 8000).out).toBe(first.out);
        expect(charges('r4-reenvio')).toBe('1');
        // Chave nova com o saldo antigo: TF008. Com o saldo novo: abre (80 - 30 reservados = 50 livres).
        expect(openWith('r4-reenvio-2', order, 1000, 10000)).toMatchObject({ ok: false, sqlstate: 'TF008' });
        expect(charges('r4-reenvio-2')).toBe('0');
        const second = openWith('r4-reenvio-2', order, 5000, 8000);
        expect(second.ok, second.message ?? '').toBe(true);
        expect(openWith('r4-reenvio-3', order, 1, 8000)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      });

      it('dois reenvios da mesma chave ao mesmo tempo, um com o saldo antigo: os dois devolvem a mesma cobrança, uma linha só', async () => {
        const order = withItems(100);
        const key = 'r4-reenvio-junto';
        const out = await contend(lockOrder(order), [pointQ(key, order, 3000, 10000), deviceQ(payment(order, 20)), pointQ(key, order, 3000, 10000)]);
        expect(lastOverlap).toBe(3);
        expect(out).toEqual(['ok', 'ok', 'ok']);
        expect(charges(key)).toBe('1');
        expect(balanceOf(order)).toBe('80.00|OPEN');
      }, 30_000);
    });
  });
});
