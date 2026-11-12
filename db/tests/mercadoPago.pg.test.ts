/**
 * Point Smart (Mercado Pago) no banco de verdade: token fora do alcance do aparelho e
 * pagamento aprovado do Mercado Pago só com a cobrança aprovada no servidor
 * (db/schema_mercado_pago.sql).
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { execFile } from 'node:child_process';
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

/**
 * Roda `q` em `count` sessões ao mesmo tempo de verdade: todas esperam uma trava que outra sessão segura
 * e partem juntas quando ela solta. Devolve a saída de cada uma.
 */
async function together(count: number, q: string | ((i: number) => string)): Promise<string[]> {
  const run = (text: string) => new Promise<string>((resolve, reject) => {
    const child = execFile('psql', ['-h', target!.host, '-p', target!.port, '-U', target!.user, '-d', DB, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'],
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())));
    child.stdin!.end(text);
  });
  const gate = 424242;
  const holder = run(`SELECT pg_advisory_lock(${gate}); SELECT pg_sleep(1.5);`);
  await new Promise((r) => setTimeout(r, 400));
  const runs = Array.from({ length: count }, (_, i) => run(`SELECT pg_advisory_lock_shared(${gate}); ${typeof q === 'function' ? q(i) : q}`));
  await holder;
  return (await Promise.all(runs)).map((out) => out.split('\n').pop() ?? '');
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
                ('${STONE_TERMINAL}', '${TENANT}', 'Stone 01', 'STONE-01', 'STONE');
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER}', '${TENANT}', '${TABLE}', '${STAFF}');
         INSERT INTO payment_provider_secrets (tenant_id, provider, access_token) VALUES ('${TENANT}', 'mercado_pago_point', 'APP_USR-segredo');
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER2}', '${TENANT}', '${TABLE}', '${STAFF}'), ('${CLOSED}', '${TENANT}', '${TABLE}', '${STAFF}'),
                ('${ORDER3}', '${TENANT}', '${TABLE}', '${STAFF}');`);
    // Saldo de R$ 50,00 na ORDER2 sem montar itens (os totais só mudam pelo recálculo do banco).
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
         UPDATE orders SET total_amount = 50, remaining_balance = 50 WHERE id IN ('${ORDER2}', '${ORDER3}');
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
      psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${order}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}');`, DB);

    it('conta inexistente, de outra loja ou fechada: recusa com código e não grava', () => {
      const missing = open('rpc-missing', '12345678-1234-4234-8234-123456789012', 100);
      expect(missing).toMatchObject({ ok: false, sqlstate: 'TF001' });
      const other = psql(target!, `SELECT tchefood_open_terminal_charge('${OTHER}', 'rpc-other', '${ORDER2}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${OTHER_STAFF}');`, DB);
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
           UPDATE terminal_charges SET status = 'pending', created_at = NOW() - INTERVAL '1 hour', updated_at = NOW() - INTERVAL '1 hour' WHERE idempotency_key = 'rpc-c';`);
      expect(open('rpc-e', ORDER2, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      sql(`UPDATE terminal_charges SET status = 'cancelled' WHERE idempotency_key = 'rpc-c';`);
      expect(open('rpc-e', ORDER2, 2001)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      sql(`UPDATE terminal_charges SET status = 'rejected' WHERE idempotency_key = 'rpc-a';`);
    });

    it('aprovada sem pagamento gravado reserva; recusada e cancelada não reservam', () => {
      expect(open('rpc-e', ORDER2, 5000).ok).toBe(true);
      sql(`UPDATE terminal_charges SET status = 'approved', external_payment_id = '9', paid_amount_cents = 5000, card_brand = 'VISA', authorization_code = 'Z' WHERE idempotency_key = 'rpc-e';`);
      expect(open('rpc-f', ORDER2, 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
    });

    it('o aparelho não chama a função (só a Edge Function, com a service role)', () => {
      const r = asDevice(`SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-dev', '${ORDER2}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1, NULL)`);
      expect(r.ok).toBe(false);
      expect(r.sqlstate).toBe('42501');
      const anon = psql(target!, `BEGIN; SET LOCAL ROLE anon; SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-anon', '${ORDER2}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1, NULL); COMMIT;`, DB);
      expect(anon.sqlstate).toBe('42501');
      const svc = psql(target!, `BEGIN; SET LOCAL ROLE service_role; SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-svc', '${CLOSED}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 1, '${STAFF}'); COMMIT;`, DB);
      expect(svc.sqlstate).toBe('TF002'); // executa (e recusa pela conta fechada)
    });

    it.each([
      ['sem operador', 'NULL'],
      ['operador inativo', `'${INACTIVE}'`],
      ['operador de outra loja', `'${OTHER_STAFF}'`],
      ['id que não existe', `'12345678-1234-4234-8234-123456789012'`],
    ])('auditoria r2 P2-02: %s não abre cobrança (TF004) e nada é gravado', (_label, who) => {
      const r = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'rpc-who', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, ${who});`, DB);
      expect(r).toMatchObject({ ok: false, sqlstate: 'TF004' });
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'rpc-who'`)).toBe('0');
    });
  });

  // Antes do bloco do PIN: o último teste dele bloqueia o PIN da loja por 60 s.
  describe('auditoria r3 P1-02/P1-03: posse do envio (um pedido por vez fala com o Mercado Pago)', () => {
    const open = (key: string) =>
      psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`, DB);
    const claim = (key: string, tenant = TENANT, lease = 30000) =>
      psql(target!, `SELECT tchefood_claim_point_dispatch('${tenant}', (SELECT id FROM terminal_charges WHERE idempotency_key = '${key}'), ${lease});`, DB);
    const field = (key: string, expr: string) => sql(`SELECT ${expr} FROM terminal_charges WHERE idempotency_key = '${key}'`);

    it('primeira posse marca o envio; com a posse em vigor ninguém mais ganha; vencida, a repetição ganha a de número 2', () => {
      expect(open('lease-a').ok).toBe(true);
      expect(claim('lease-a').out).toBe('1');
      expect(field('lease-a', `(dispatched_at IS NOT NULL) || '|' || (dispatch_lease_until > NOW() + INTERVAL '25 seconds') || '|' || (dispatch_lease_until <= NOW() + INTERVAL '31 seconds')`)).toBe('true|true|true');
      const first = field('lease-a', 'dispatched_at');
      expect(claim('lease-a').out).toBe('0');
      expect(claim('lease-a').out).toBe('0');
      expect(field('lease-a', 'dispatch_attempts')).toBe('1');
      sql(`UPDATE terminal_charges SET dispatch_lease_until = NOW() - INTERVAL '1 second' WHERE idempotency_key = 'lease-a';`);
      expect(claim('lease-a').out).toBe('2');
      expect(field('lease-a', 'dispatched_at')).toBe(first); // a hora do primeiro envio não muda
      expect(claim('lease-a').out).toBe('0');
    });

    it('oito pedidos ao mesmo tempo: só um ganha a posse', async () => {
      expect(open('lease-race').ok).toBe(true);
      const out = await together(8, `SELECT tchefood_claim_point_dispatch('${TENANT}', (SELECT id FROM terminal_charges WHERE idempotency_key = 'lease-race'), 30000);`);
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

    it('o aparelho não chama a função', () => {
      for (const role of ['authenticated', 'anon']) {
        const r = psql(target!, `BEGIN; SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true);
          SELECT tchefood_claim_point_dispatch('${TENANT}', gen_random_uuid(), 30000); COMMIT;`, DB);
        expect(r.sqlstate, role).toBe('42501');
      }
      const svc = psql(target!, `BEGIN; SET LOCAL ROLE service_role; SELECT tchefood_claim_point_dispatch('${TENANT}', gen_random_uuid(), 30000); COMMIT;`, DB);
      expect(svc.ok, svc.message ?? '').toBe(true);
    });

    it('auditoria r3 P0-01: enviada sem resposta, com encerramento do gerente, em revisão manual: segue reservando o saldo', () => {
      const ORDER4 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER4}', '${TENANT}', '${TABLE}', '${STAFF}');
           BEGIN; SET LOCAL session_replication_role = replica; UPDATE orders SET total_amount = 100, remaining_balance = 100 WHERE id = '${ORDER4}'; COMMIT;`);
      const open4 = (key: string, cents: number) =>
        psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER4}', '${TERMINAL}', '${MP_ID}', 'CREDIT', ${cents}, '${STAFF}');`, DB);
      expect(open4('unk-a', 10000).ok).toBe(true);
      expect(claim('unk-a').out).toBe('1');
      const auth = psql(target!, `SELECT tchefood_authorize_point_cancel('${TENANT}', 'unk-a', '${STAFF}', '${MANAGER_PIN}', 'cliente desistiu');`, DB);
      expect(auth.ok, auth.message ?? '').toBe(true);
      expect(auth.out).toMatch(/^[0-9a-f-]{36}$/);
      // O que a função grava quando a posse vence sem ordem (charge.ts cancelCharge):
      sql(`UPDATE terminal_charges SET status = 'manual_review', raw_status = 'dispatch_unknown', raw_status_detail = 'DISPATCH_UNKNOWN' WHERE idempotency_key = 'unk-a';`);
      // PIN do gerente e tempo passado não liberam: a segunda cobrança da conta é recusada.
      sql(`UPDATE terminal_charges SET created_at = NOW() - INTERVAL '2 days', dispatch_lease_until = NOW() - INTERVAL '2 days' WHERE idempotency_key = 'unk-a';`);
      expect(open4('unk-b', 1)).toMatchObject({ ok: false, sqlstate: 'TF003' });
      // A resposta atrasada ainda grava a aprovação por cima da revisão manual.
      const late = psql(target!, `UPDATE terminal_charges SET status = 'approved', external_order_id = 'ORD-LATE', external_payment_id = '4242', paid_amount_cents = 10000, card_brand = 'VISA', authorization_code = 'LATE1'
                                  WHERE idempotency_key = 'unk-a' AND status = 'manual_review';`, DB);
      expect(late.ok, late.message ?? '').toBe(true);
      expect(field('unk-a', 'status')).toBe('approved');
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
      const late = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'blk-ok', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`, DB);
      expect(late.out).toBe(r.out);
      expect(sql(`SELECT status FROM terminal_charges WHERE idempotency_key = 'blk-ok'`)).toBe('cancelled');
      // E nunca ganha a posse do envio.
      expect(psql(target!, `SELECT tchefood_claim_point_dispatch('${TENANT}', '${r.out}', 30000);`, DB).out).toBe('0');
    });

    it('a criação gravou primeiro: o bloqueio não mexe na cobrança nem registra nada', () => {
      const created = psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', 'blk-late', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`, DB);
      expect(created.ok).toBe(true);
      expect(block('blk-late', `'${STAFF}'`).out).toBe(created.out);
      expect(sql(`SELECT status || '|' || (cancel_reason IS NULL) FROM terminal_charges WHERE idempotency_key = 'blk-late'`)).toBe('creating|true');
      expect(audits('blk-late')).toBe('0');
    });

    it('criação e bloqueio ao mesmo tempo: fica uma linha só, e ou é a cobrança ou é o bloqueio', async () => {
      const q = (i: number) => (i % 2
        ? `SELECT tchefood_block_point_key('${TENANT}', 'blk-race', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`
        : `SELECT tchefood_open_terminal_charge('${TENANT}', 'blk-race', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`);
      const out = await together(8, q);
      expect(new Set(out).size).toBe(1);
      expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'blk-race'`)).toBe('1');
      const status = sql(`SELECT status FROM terminal_charges WHERE idempotency_key = 'blk-race'`);
      expect(audits('blk-race')).toBe(status === 'cancelled' ? '1' : '0');
    }, 30_000);

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

  describe('auditoria r2 P1-01: encerrar pelo operador só com PIN de gerente conferido no banco', () => {
    const open = (key: string) =>
      psql(target!, `SELECT tchefood_open_terminal_charge('${TENANT}', '${key}', '${ORDER3}', '${TERMINAL}', '${MP_ID}', 'CREDIT', 100, '${STAFF}');`, DB);
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

  it('pagamento igual à cobrança aprovada entra, e a mesma cobrança não paga duas vezes', () => {
    const key = charge();
    const r = pay(key);
    expect(r.ok, r.message ?? '').toBe(true);
    const again = pay(key, { order_id: ORDER });
    expect(again.ok).toBe(false);
  });

  it('recusado do Mercado Pago e Stone aprovado seguem as regras de antes', () => {
    expect(pay('chave-recusada', { status: 'DECLINED', nsu: null, authorization_code: null, card_brand: null }).ok).toBe(true);
    const stone = pay('stone-1', { acquirer: 'STONE', acquirer_cnpj: '16501555000157', terminal_id: STONE_TERMINAL, terminal_serial: 'STONE-01', nsu: '784512', authorization_code: 'A12345' });
    expect(stone.ok, stone.message ?? '').toBe(true);
  });

  it('as migrations rodam de novo sem erro', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    const f = readdirSync(dir).find((x) => x.includes('mercado_pago'))!;
    expect(() => psqlFile(target!, join(dir, f), DB)).not.toThrow();
  });
});
