/**
 * Point Smart (Mercado Pago) no banco de verdade: token fora do alcance do aparelho e
 * pagamento aprovado do Mercado Pago só com a cobrança aprovada no servidor
 * (db/schema_mercado_pago.sql).
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
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
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF}', '${TENANT}', 'Caixa', 'CASHIER', '5162');
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${TABLE}', '${TENANT}', 1, 'Mesa 1');
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${TERMINAL}', '${TENANT}', 'Point Smart', '${MP_ID}', 'MERCADO_PAGO'),
                ('${STONE_TERMINAL}', '${TENANT}', 'Stone 01', 'STONE-01', 'STONE');
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${ORDER}', '${TENANT}', '${TABLE}', '${STAFF}');
         INSERT INTO payment_provider_secrets (tenant_id, provider, access_token) VALUES ('${TENANT}', 'mercado_pago_point', 'APP_USR-segredo');`);
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

  it('cobrança aprovada com valor pago diferente não libera o pagamento', () => {
    const key = charge({ paid_amount_cents: 900 });
    expect(pay(key).ok).toBe(false);
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
