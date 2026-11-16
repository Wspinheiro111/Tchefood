/**
 * Espaço das chaves de pagamento (payments.idempotency_key, única no banco todo) no banco de verdade.
 *
 * Uma chave tem um dono: (a) uma cobrança da Point (terminal_charges), (b) uma reserva de pagamento
 * (payment_claims, por loja, tchefood_claim_payment), (c) o dinheiro do entregador ("entrega-<id da entrega>"),
 * ou um pagamento já gravado. Regras conferidas aqui, em matriz dono × quem grava:
 *  - pagamento fora do Mercado Pago, de QUALQUER status, nunca usa a chave de uma cobrança da Point (TF009); só
 *    aprovado ou recusado entra (PENDING e REFUNDED: TF007); recusado com a chave de uma reserva da loja só com ela
 *    liberada e da mesma conta (aberta ou consumida: TF010, auditoria interna 3 P1-01; forma e credenciadora podem ser
 *    outras, auditoria interna F1); fora do Mercado Pago, em todo
 *    status, chave de reserva, cobrança ou pagamento de outra loja é uma recusa só (TF009, auditoria interna F3);
 *  - pagamento do Mercado Pago só com a cobrança dele: APPROVED só com o comprovante completo, DECLINED só com a
 *    cobrança recusada/cancelada/expirada, REFUNDED só com a cobrança estornada; PENDING não entra (TF007);
 *  - cobrança (tchefood_open_terminal_charge, tchefood_block_point_key) não nasce com a chave de um pagamento ou de
 *    uma reserva; reserva não nasce com a chave de um pagamento ou de uma cobrança;
 *  - pagamento gravado não muda de chave, conta ou loja (TF007);
 *  - chave de reserva liberada não recebe pagamento aprovado (TF013);
 *  - chave de outra loja: nenhuma das gravações acima passa por cima dela.
 * E a disputa entre duas sessões (cobrança nova × pagamento DECLINED com a mesma chave), nas duas ordens.
 *
 * Célula sem regra combinada (marcada "info") só registra o que o banco faz, sem conferir.
 * No fim, a matriz é impressa no console.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget, type PsqlResult } from './postgrestEmulator';

const target = pgTargetFromEnv();
// Nome por processo: duas rodadas juntas (outro terminal, outro agente) não derrubam o banco uma da outra.
const DB = `tchefood_payment_keys_test_${process.pid}`;
const ROOT = join(__dirname, '..', '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const STAFF = '22222222-2222-4222-8222-222222222222';
const OTHER_STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TABLE = '33333333-3333-4333-8333-333333333333';
const OTHER_TABLE = '34343434-3434-4434-8434-343434343434';
const KIOSK_TABLE = '37373737-3737-4737-8737-373737373737';
const ZONE = '38383838-3838-4838-8838-383838383838';
const COURIER = '39393939-3939-4939-8939-393939393939';
const TERMINAL = '55555555-5555-4555-8555-555555555555';
const OTHER_TERMINAL = '56565656-5656-4565-8565-565656565656';
const MP_ID = 'NEWLAND_N950__N950NCB801293324';
const OTHER_MP_ID = 'NEWLAND_N950__N950NCB801299999';
const MP_CNPJ = '10573521000191';

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
const owner = (q: string): PsqlResult => psql(target!, `${q};`, DB);
const asDevice = (q: string, tenant = TENANT): PsqlResult =>
  psql(target!, `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${tenant}"}', true); ${q}; COMMIT;`, DB);
const last = (r: PsqlResult) => r.out.split('\n').pop() ?? '';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
/** Conta aberta com um item (sem 10%) e saldo `balance` reais. */
function order(balance = 100, tenant = TENANT): string {
  seq += 1;
  const id = `f0f0f0f0-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const [table, staff] = tenant === TENANT ? [TABLE, STAFF] : [OTHER_TABLE, OTHER_STAFF];
  sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${id}', '${tenant}', '${table}', '${staff}');
       BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
       VALUES ('${id}', gen_random_uuid(), '${staff}', 1, ${balance}, ${balance}, 'NONE');
       UPDATE orders SET charge_service_fee = false, subtotal_items = ${balance}, total_amount = ${balance}, paid_amount = 0, remaining_balance = ${balance} WHERE id = '${id}';
       COMMIT;`);
  return id;
}
/** Conta de entrega paga na entrega, com entregador e já entregue (o dinheiro do entregador vale nela). */
function deliveryOrder(balance = 100): { order: string; id: string } {
  seq += 1;
  const o = `f1f1f1f1-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const id = crypto.randomUUID();
  sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id, status, charge_service_fee, fulfillment_type)
       VALUES ('${o}', '${TENANT}', '${KIOSK_TABLE}', '${STAFF}', 'PAYING', false, 'DELIVERY');
       BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
       VALUES ('${o}', gen_random_uuid(), '${STAFF}', 1, ${balance}, ${balance}, 'NONE');
       UPDATE orders SET subtotal_items = ${balance}, total_amount = ${balance}, paid_amount = 0, remaining_balance = ${balance} WHERE id = '${o}';
       COMMIT;
       INSERT INTO own_deliveries (id, tenant_id, order_id, customer_name, customer_phone, address, zone_id, zone_name, delivery_fee, pay_on_delivery)
       VALUES ('${id}', '${TENANT}', '${o}', 'Cliente', '51999998888', 'Rua A, 100', '${ZONE}', 'Centro', 5, true);
       UPDATE own_deliveries SET status = 'READY' WHERE id = '${id}';
       UPDATE own_deliveries SET status = 'OUT', courier_id = '${COURIER}', courier_fee = 4, out_at = NOW() WHERE id = '${id}';
       UPDATE own_deliveries SET status = 'DELIVERED', delivered_at = NOW() WHERE id = '${id}';`);
  return { order: o, id };
}
const bal = (o: string) => Number(sql(`SELECT round(remaining_balance * 100)::bigint FROM orders WHERE id = '${o}'`));
const newKey = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const staffOf = (tenant: string) => (tenant === TENANT ? STAFF : OTHER_STAFF);
const terminalOf = (tenant: string) => (tenant === TENANT ? [TERMINAL, MP_ID] : [OTHER_TERMINAL, OTHER_MP_ID]);

type Acq = 'STONE' | 'PAGBANK' | 'CASH_DESK' | 'MERCADO_PAGO';
type PayStatus = 'APPROVED' | 'DECLINED' | 'PENDING' | 'REFUNDED';
type Proof = { nsu: string | null; auth: string | null; brand: string | null };

/** Pagamento do aparelho (tchefood_register_payment) de R$ 10,00. */
function paymentJson(o: string, k: string, acq: Acq, status: PayStatus, tenant = TENANT, proof?: Proof): string {
  const base = {
    id: crypto.randomUUID(), order_id: o, tenant_id: tenant, waiter_id: staffOf(tenant), terminal_id: null as string | null, amount: 10, tip_amount: 0,
    status, acquirer: acq, idempotency_key: k, created_at: new Date().toISOString(),
  };
  if (acq === 'CASH_DESK') return JSON.stringify({ ...base, method: 'CASH', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null });
  if (acq === 'MERCADO_PAGO') {
    const [term, serial] = terminalOf(tenant);
    const p = proof ?? { nsu: `X${crypto.randomUUID().slice(0, 8)}`, auth: 'AUT1', brand: 'VISA' };
    return JSON.stringify({ ...base, method: 'CREDIT', terminal_id: term, acquirer_cnpj: MP_CNPJ, card_brand: p.brand, nsu: p.nsu, authorization_code: p.auth, terminal_serial: serial });
  }
  return JSON.stringify({ ...base, method: 'CREDIT', acquirer_cnpj: acq === 'STONE' ? '16501555000157' : '08561701000101', card_brand: 'VISA',
    nsu: `R${crypto.randomUUID().slice(0, 8)}`, authorization_code: 'A12345', terminal_serial: `${acq}-01` });
}
const register = (j: string, tenant = TENANT) => asDevice(`SELECT tchefood_register_payment('${j}'::jsonb)`, tenant);
const claimQ = (k: string, o: string, cents = 1000, tenant = TENANT, token = newToken(), method = 'CASH', acquirer = 'CASH_DESK') =>
  `SELECT tchefood_claim_payment('${k}', '${o}', '${method}', '${acquirer}', ${cents}, ${bal(o)}, '${staffOf(tenant)}', '${token}')`;
const openQ = (k: string, o: string, tenant = TENANT, cents = 1000) => {
  const [term, serial] = terminalOf(tenant);
  return `SELECT tchefood_open_terminal_charge('${tenant}', '${k}', '${o}', '${term}', '${serial}', 'CREDIT', ${cents}, '${staffOf(tenant)}', ${bal(o)})`;
};
const blockQ = (k: string, o: string, tenant = TENANT) => {
  const [term, serial] = terminalOf(tenant);
  return `SELECT tchefood_block_point_key('${tenant}', '${k}', '${o}', '${term}', '${serial}', 'CREDIT', 1000, '${staffOf(tenant)}')`;
};

/** Cobrança da Point gravada direto (como a Edge Function grava), no estado pedido, de R$ 10,00. */
function insertCharge(o: string, status: string, k = newKey('ch')): { key: string; id: string; proof: Proof } {
  const withReceipt = status === 'approved' || status === 'refunded';
  const proof: Proof = withReceipt ? { nsu: `P${seq}${k.slice(-6)}`, auth: 'AUT1', brand: 'VISA' } : { nsu: null, auth: null, brand: null };
  const receipt = withReceipt ? `, external_payment_id, paid_amount_cents, card_brand, authorization_code` : '';
  const receiptVals = withReceipt ? `, '${proof.nsu}', 1000, 'VISA', 'AUT1'` : '';
  const id = sql(`INSERT INTO terminal_charges (tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, external_order_id, created_by${receipt})
                  VALUES ('${TENANT}', '${k}', '${o}', '${TERMINAL}', 'mercado_pago_point', '${MP_ID}', 'CREDIT', 1000, '${status}', 'ORD-${k}', '${STAFF}'${receiptVals}) RETURNING id;`);
  return { key: k, id, proof };
}

// ---------------------------------------------------------------------------------------------------------------
// Donos da chave
// ---------------------------------------------------------------------------------------------------------------
type OwnerState = { key: string; order: string; chargeId?: string; chargeStatus?: string; proof?: Proof; paid?: boolean };
const CHARGE_STATUSES = ['creating', 'pending', 'at_terminal', 'manual_review', 'approved', 'rejected', 'cancelled', 'expired', 'refunded'] as const;
type OwnerKind =
  | `charge:${(typeof CHARGE_STATUSES)[number]}` | 'charge:approved+paid' | 'charge:blocked'
  | 'claim:open' | 'claim:released' | 'claim:consumed'
  | 'payment:declined' | 'payment:courier' | 'none';
const OWNERS: OwnerKind[] = [
  ...CHARGE_STATUSES.map((s) => `charge:${s}` as OwnerKind), 'charge:approved+paid', 'charge:blocked',
  'claim:open', 'claim:released', 'claim:consumed', 'payment:declined', 'payment:courier', 'none',
];

function must(r: PsqlResult, what: string): string {
  if (!r.ok) throw new Error(`montagem (${what}) falhou: ${r.sqlstate} ${r.message}`);
  return last(r);
}

function makeOwner(kind: OwnerKind): OwnerState {
  if (kind === 'payment:courier') {
    const d = deliveryOrder();
    const k = `entrega-${d.id}`;
    must(register(paymentJson(d.order, k, 'CASH_DESK', 'APPROVED')), kind);
    return { key: k, order: d.order };
  }
  const o = order();
  if (kind === 'none') return { key: newKey('free'), order: o };
  if (kind === 'charge:blocked') {
    const k = newKey('blk');
    const id = must(owner(blockQ(k, o)), kind);
    return { key: k, order: o, chargeId: id, chargeStatus: 'cancelled', proof: { nsu: null, auth: null, brand: null } };
  }
  if (kind.startsWith('charge:')) {
    const paid = kind === 'charge:approved+paid';
    const status = paid ? 'approved' : kind.slice('charge:'.length);
    const c = insertCharge(o, status);
    if (paid) must(register(paymentJson(o, c.key, 'MERCADO_PAGO', 'APPROVED', TENANT, c.proof)), kind);
    return { key: c.key, order: o, chargeId: c.id, chargeStatus: status, proof: c.proof, paid };
  }
  const k = newKey('clm');
  if (kind.startsWith('claim:')) {
    const token = newToken();
    must(asDevice(claimQ(k, o, 1000, TENANT, token)), kind);
    if (kind === 'claim:released') must(asDevice(`SELECT tchefood_release_payment_claim('${k}', '${STAFF}', '${token}', 'desistiu')`), kind);
    if (kind === 'claim:consumed') must(register(paymentJson(o, k, 'CASH_DESK', 'APPROVED')), kind);
    return { key: k, order: o };
  }
  // payment:declined: Stone recusado, sem reserva.
  must(register(paymentJson(o, k, 'STONE', 'DECLINED')), kind);
  return { key: k, order: o };
}

// ---------------------------------------------------------------------------------------------------------------
// Quem grava
// ---------------------------------------------------------------------------------------------------------------
type Writer =
  | { kind: 'reg'; acq: 'STONE' | 'PAGBANK' | 'CASH_DESK'; status: PayStatus }
  | { kind: 'mp'; status: PayStatus; badProof?: boolean }
  | { kind: 'open' } | { kind: 'block' } | { kind: 'claim' };
const WRITERS: Writer[] = [
  ...(['STONE', 'PAGBANK', 'CASH_DESK'] as const).flatMap((acq) => (['APPROVED', 'DECLINED', 'PENDING', 'REFUNDED'] as const).map((status) => ({ kind: 'reg', acq, status }) as Writer)),
  ...(['APPROVED', 'DECLINED', 'PENDING', 'REFUNDED'] as const).map((status) => ({ kind: 'mp', status }) as Writer),
  { kind: 'mp', status: 'APPROVED', badProof: true },
  { kind: 'open' }, { kind: 'block' }, { kind: 'claim' },
];
const writerName = (w: Writer) =>
  w.kind === 'reg' ? `${w.acq === 'CASH_DESK' ? 'CASH' : w.acq} ${w.status}` : w.kind === 'mp' ? `MP ${w.status}${w.badProof ? ' (bad proof)' : ''}` : w.kind;

function runWriter(w: Writer, s: OwnerState, tenant: string): PsqlResult {
  const o = tenant === TENANT ? s.order : order(100, OTHER);
  switch (w.kind) {
    case 'reg':
      return register(paymentJson(o, s.key, w.acq, w.status, tenant), tenant);
    case 'mp': {
      const proof = s.proof && tenant === TENANT ? { ...s.proof } : undefined;
      const p = proof && proof.nsu ? proof : { nsu: `X${crypto.randomUUID().slice(0, 8)}`, auth: 'AUT1', brand: 'VISA' };
      if (w.badProof) p.auth = 'WRONG';
      return register(paymentJson(o, s.key, 'MERCADO_PAGO', w.status, tenant, p), tenant);
    }
    case 'open':
      return owner(openQ(s.key, o, tenant));
    case 'block':
      return owner(blockQ(s.key, o, tenant));
    case 'claim':
      return asDevice(claimQ(s.key, o, 1000, tenant), tenant);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// O que se espera
// ---------------------------------------------------------------------------------------------------------------
/** ok: grava (sameCharge: devolve a cobrança que já existia, sem gravar outra); refused: recusa (code: com esse SQLSTATE) e nada gravado; info: sem regra combinada. */
type Exp = { ok: true; sameCharge?: boolean } | { ok: false; code?: string } | 'info';
const REFUSED: Exp = { ok: false };
const ref = (code: string): Exp => ({ ok: false, code });

function expected(kind: OwnerKind, s: OwnerState, w: Writer, cross: boolean): Exp {
  if (kind.startsWith('charge:')) {
    const cs = s.chargeStatus!;
    if (cross) {
      // Auditoria interna F3: fora do Mercado Pago, chave de outra loja é TF009 key_in_use, igual para todo dono e status.
      if (w.kind === 'reg') return ref('TF009');
      if (w.kind === 'mp') return ref('TF005'); // a cobrança da chave não é desta loja: para o MP, não existe
      if (w.kind === 'claim') return ref('TF009');
      return ref('TF009'); // auditoria 2 (P2-1): chave de cobrança de outra loja é a recusa única da chave em uso
    }
    // r8 P1-01 (item 14): fora do Mercado Pago, a chave da cobrança é recusada em qualquer status (TF009 key_in_use;
    // PENDING/REFUNDED já são recusados por si, TF007 ou TF009).
    if (w.kind === 'reg') return w.status === 'APPROVED' || w.status === 'DECLINED' ? ref('TF009') : REFUSED;
    if (w.kind === 'mp') {
      if (w.status === 'PENDING') return ref('TF007'); // item 14: PENDING do Mercado Pago não entra
      if (s.paid) return REFUSED; // a chave já tem o pagamento aprovado dela
      // Revisão r8 (item 4): as recusas do gatilho do Mercado Pago têm código (TF007 estado da cobrança, TF006 comprovante).
      if (w.status === 'APPROVED') return cs !== 'approved' ? ref('TF007') : w.badProof ? ref('TF006') : { ok: true };
      if (w.status === 'DECLINED') return ['rejected', 'cancelled', 'expired'].includes(cs) ? { ok: true } : ref('TF007');
      if (w.status === 'REFUNDED') return cs === 'refunded' ? { ok: true } : ref('TF007');
      return REFUSED;
    }
    if (w.kind === 'open' || w.kind === 'block') return { ok: true, sameCharge: true };
    return ref('TF009');
  }
  if (kind.startsWith('claim:')) {
    const st = kind.slice('claim:'.length);
    if (w.kind === 'mp') return ref('TF005'); // sem cobrança com a chave
    if (w.kind === 'open' || w.kind === 'block') return ref('TF009');
    // Revisão r8 (item 3): reserva com a chave de uma reserva de outra loja também é recusada (a chave do pagamento é única no banco todo).
    if (w.kind === 'claim') return ref('TF009');
    // Auditoria interna F3: a chave da reserva de outra loja é TF009 key_in_use em todo status (sem dizer que é reserva).
    if (cross) return ref('TF009');
    if (w.status === 'PENDING' || w.status === 'REFUNDED') return REFUSED; // item 14: só aprovado ou recusado entra
    // Auditoria interna 3 P1-01: o recusado com a chave de uma reserva aberta ou consumida da loja é TF010 (não ocupa a
    // chave do aprovado dela); liberada, só precisa da mesma conta (auditoria interna F1: forma e credenciadora livres).
    if (w.status === 'DECLINED') return st === 'released' ? { ok: true } : ref('TF010');
    if (st === 'consumed') return REFUSED; // chave já é do pagamento que a consumiu
    if (st === 'released') return ref('TF013');
    return w.acq === 'CASH_DESK' ? { ok: true } : ref('TF010'); // a reserva é de dinheiro no caixa
  }
  if (kind.startsWith('payment:')) {
    if (w.kind === 'mp') return ref('TF005'); // sem cobrança com a chave
    if (w.kind === 'open' || w.kind === 'block' || w.kind === 'claim') return ref('TF009');
    // Auditoria interna F3: o pagamento de outra loja com a chave é TF009 key_in_use antes do 23505, em todo status.
    if (cross) return ref('TF009');
    return REFUSED;
  }
  // none (controle): chave livre.
  if (w.kind === 'reg') return w.status === 'APPROVED' ? ref('TF010') : w.status === 'DECLINED' ? { ok: true } : ref('TF007');
  if (w.kind === 'mp') return ref('TF005'); // sem cobrança com a chave
  return { ok: true };
}

const counts = (k: string) =>
  sql(`SELECT (SELECT count(*) FROM payments WHERE idempotency_key = '${k}') || '|' || (SELECT count(*) FROM terminal_charges WHERE idempotency_key = '${k}')
              || '|' || (SELECT count(*) FROM payment_claims WHERE idempotency_key = '${k}')`);

const matrix = new Map<string, Map<string, string>>();
const failures: string[] = [];
const races: string[] = [];
function record(row: string, col: string, r: PsqlResult, exp: Exp, pass: boolean): void {
  if (!matrix.has(row)) matrix.set(row, new Map());
  const got = r.ok ? 'ok' : (r.sqlstate ?? '?');
  const want = exp === 'info' ? 'info' : exp.ok ? 'ok' : (exp.code ?? 'refused');
  matrix.get(row)!.set(col, exp === 'info' ? `(${got})` : pass ? got : `**${got}≠${want}**`);
  if (!pass && exp !== 'info') failures.push(`${row} × ${col}: got ${got}${r.ok ? '' : ` (${r.message})`}, want ${want}`);
}

function checkCell(kind: OwnerKind, w: Writer, cross: boolean): void {
  const s = makeOwner(kind);
  const before = counts(s.key);
  const r = runWriter(w, s, cross ? OTHER : TENANT);
  const after = counts(s.key);
  const exp = expected(kind, s, w, cross);
  let pass: boolean;
  if (exp === 'info') pass = true;
  else if (!exp.ok) pass = !r.ok && (!exp.code || r.sqlstate === exp.code) && after === before;
  else if (exp.sameCharge) pass = r.ok && last(r) === s.chargeId && after === before;
  else pass = r.ok && after !== before;
  record(`${cross ? 'OTHER tenant ← ' : ''}${kind}`, writerName(w), r, exp, pass);
  if (exp === 'info') return;
  const detail = `${kind} × ${writerName(w)}${cross ? ' (other tenant)' : ''}: ${r.ok ? `ok ${last(r)}` : `${r.sqlstate} ${r.message}`}; rows p|c|pc ${before} -> ${after}`;
  expect(pass, detail).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------
// Duas sessões
// ---------------------------------------------------------------------------------------------------------------
function session() {
  const child = spawn('psql', ['-h', target!.host, '-p', target!.port, '-U', target!.user, '-d', DB, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']);
  let out = '';
  let err = '';
  let finished = false;
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { err += String(d); });
  const done = new Promise<string>((resolve, reject) => {
    child.on('close', (code) => { finished = true; return code === 0 ? resolve(out.trim()) : reject(new Error(err || `psql saiu com ${code}`)); });
  });
  done.catch(() => undefined);
  return { send: (text: string) => child.stdin.write(`${text}\n`), end: (text = '') => child.stdin.end(`${text}\n`), output: () => out,
    finished: () => finished, done, kill: () => child.kill('SIGKILL') };
}
async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Não aconteceu em ${ms} ms: ${what}`);
    await pause(25);
  }
}
/** Sessões deste banco paradas numa trava (pg_locks sem granted). */
const blocked = () => Number(sql(`SELECT count(DISTINCT l.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = '${DB}'`));

/** Roda q e devolve 'ok' ou 'recusado <SQLSTATE>: <mensagem>' (a sessão não cai). */
const tryFn = `CREATE FUNCTION pg_temp.t(q text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE q; RETURN 'ok'; EXCEPTION WHEN others THEN RETURN 'recusado ' || SQLSTATE || ': ' || SQLERRM; END $f$;`;
const asDeviceTx = (q: string) => `SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true); SELECT pg_temp.t($q$${q}$q$);`;
const asOwnerTx = (q: string) => `SELECT pg_temp.t($q$${q}$q$);`;

/**
 * A primeira gravação fica com a transação aberta; a segunda entra numa sessão própria e o teste espera ela parar
 * numa trava (pg_locks) ou terminar sozinha. Só então a primeira faz COMMIT.
 */
async function race(first: string, second: string): Promise<{ first: string; second: string; waited: boolean }> {
  const holder = session();
  const other = session();
  try {
    holder.send(`${tryFn} BEGIN; ${first} SELECT 'held';`);
    await until('primeira gravação com a transação aberta', () => holder.output().includes('held') || holder.finished());
    const base = blocked();
    other.end(`${tryFn} BEGIN; ${second} COMMIT;`);
    let waited = false;
    await until('segunda gravação parada na trava ou terminada', () => {
      if (other.finished()) return true;
      if (blocked() > base) { waited = true; return true; }
      return false;
    });
    holder.end('COMMIT;');
    const h = await holder.done;
    const o = await other.done;
    return { first: h.split('\n').filter((x) => x !== 'held').pop() ?? '', second: o.split('\n').pop() ?? '', waited };
  } finally {
    holder.kill();
    other.kill();
  }
}

describe.skipIf(!target)('chaves de pagamento: cobrança da Point, reserva e pagamento no mesmo espaço de chaves', () => {
  beforeAll(() => {
    applySchema(target!, DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja', 'Loja Ltda', '11222333000181'), ('${OTHER}', 'Outra', 'Outra Ltda', '11444777000161');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF}', '${TENANT}', 'Caixa', 'CASHIER', '5162'),
                ('${OTHER_STAFF}', '${OTHER}', 'Caixa da outra', 'CASHIER', '5162');
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${TABLE}', '${TENANT}', 1, 'Mesa 1'), ('${OTHER_TABLE}', '${OTHER}', 1, 'Mesa 1');
         INSERT INTO dining_tables (id, tenant_id, number, label, kind) VALUES ('${KIOSK_TABLE}', '${TENANT}', 950, 'Totem', 'KIOSK');
         INSERT INTO delivery_zones (id, tenant_id, name, fee, eta_minutes) VALUES ('${ZONE}', '${TENANT}', 'Centro', 5, 30);
         INSERT INTO couriers (id, tenant_id, name, fee_per_delivery) VALUES ('${COURIER}', '${TENANT}', 'Entregador', 4);
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${TERMINAL}', '${TENANT}', 'Point Smart', '${MP_ID}', 'MERCADO_PAGO'),
                ('${OTHER_TERMINAL}', '${OTHER}', 'Point da outra', '${OTHER_MP_ID}', 'MERCADO_PAGO');`);
  }, 180_000);

  afterAll(() => {
    psql({ ...target!, db: 'postgres' }, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
    if (matrix.size === 0 && races.length === 0) return;
    const cols = WRITERS.map(writerName);
    const lines = [`| owner \\ writer | ${cols.join(' | ')} |`, `|${' --- |'.repeat(cols.length + 1)}`];
    for (const [row, cells] of matrix) lines.push(`| ${row} | ${cols.map((c) => cells.get(c) ?? '').join(' | ')} |`);
    // eslint-disable-next-line no-console
    console.log(`\nMatriz das chaves (ok / SQLSTATE; **got≠want** = falhou; (x) = info, sem regra)\n${lines.join('\n')}\n\nDuas sessões:\n${races.join('\n')}\n\nFalhas (${failures.length}):\n${failures.join('\n')}`);
  });

  describe('matriz: dono da chave × quem grava (mesma loja)', () => {
    for (const kind of OWNERS) {
      it.each(WRITERS.map((w) => [writerName(w), w] as const))(`${kind} × %s`, (_n, w) => checkCell(kind, w, false), 30_000);
    }
  });

  describe('matriz: chave de uma loja × gravação na outra loja', () => {
    for (const kind of OWNERS.filter((k) => k !== 'none')) {
      it.each(WRITERS.map((w) => [writerName(w), w] as const))(`${kind} (loja A) × %s (loja B)`, (_n, w) => checkCell(kind, w, true), 30_000);
    }
  });

  describe('pagamento gravado não muda de chave, conta nem loja (TF007)', () => {
    const cases = [
      ['chave para uma chave livre', (id: string) => `UPDATE payments SET idempotency_key = '${newKey('moved')}' WHERE id = '${id}'`],
      ['chave para a de uma cobrança da Point', (id: string) => `UPDATE payments SET idempotency_key = '${insertCharge(order(), 'approved').key}' WHERE id = '${id}'`],
      ['chave para NULL', (id: string) => `UPDATE payments SET idempotency_key = NULL WHERE id = '${id}'`],
      ['conta', (id: string) => `UPDATE payments SET order_id = '${order()}' WHERE id = '${id}'`],
      ['loja', (id: string) => `UPDATE payments SET tenant_id = '${OTHER}' WHERE id = '${id}'`],
    ] as const;
    const payments = {
      'dinheiro aprovado (reserva consumida)': () => { const s = makeOwner('claim:consumed'); return sql(`SELECT id FROM payments WHERE idempotency_key = '${s.key}'`); },
      'Stone recusado': () => { const s = makeOwner('payment:declined'); return sql(`SELECT id FROM payments WHERE idempotency_key = '${s.key}'`); },
      'Mercado Pago aprovado': () => { const s = makeOwner('charge:approved+paid'); return sql(`SELECT id FROM payments WHERE idempotency_key = '${s.key}'`); },
    };
    for (const [pname, mk] of Object.entries(payments)) {
      it.each(cases)(`${pname}: muda %s → TF007, nada muda`, (_label, q) => {
        const id = mk();
        const before = sql(`SELECT idempotency_key || '|' || order_id || '|' || tenant_id FROM payments WHERE id = '${id}'`);
        const r = owner(q(id));
        expect(r, r.message ?? '').toMatchObject({ ok: false, sqlstate: 'TF007' });
        expect(sql(`SELECT idempotency_key || '|' || order_id || '|' || tenant_id FROM payments WHERE id = '${id}'`)).toBe(before);
      }, 30_000);
    }
    it('UPDATE que repete a mesma chave, conta e loja passa (não é mudança)', () => {
      const s = makeOwner('payment:declined');
      expect(owner(`UPDATE payments SET idempotency_key = idempotency_key, order_id = order_id, tenant_id = tenant_id WHERE idempotency_key = '${s.key}'`).ok).toBe(true);
    });
  });

  describe('duas sessões: cobrança nova × pagamento DECLINED com a mesma chave', () => {
    const payDeclined = (o: string, k: string) => asDeviceTx(`SELECT tchefood_register_payment('${paymentJson(o, k, 'STONE', 'DECLINED')}'::jsonb)`);
    const openCharge = (o: string, k: string) => asOwnerTx(openQ(k, o));
    const rows = (k: string) => counts(k).split('|').map(Number);

    it.each([
      ['cobrança primeiro, mesma conta', 'charge', true],
      ['cobrança primeiro, contas diferentes', 'charge', false],
      ['pagamento primeiro, mesma conta', 'payment', true],
      ['pagamento primeiro, contas diferentes', 'payment', false],
    ] as const)('%s: só uma das duas grava a chave', async (_label, firstIs, sameOrder) => {
      const k = newKey('race');
      const oCharge = order();
      const oPay = sameOrder ? oCharge : order();
      const first = firstIs === 'charge' ? openCharge(oCharge, k) : payDeclined(oPay, k);
      const second = firstIs === 'charge' ? payDeclined(oPay, k) : openCharge(oCharge, k);
      const r = await race(first, second);
      const [p, c] = rows(k);
      const detail = `first=${r.first} second=${r.second} waited=${r.waited} payments=${p} charges=${c}`;
      races.push(`${_label}: ${p + c === 1 ? 'one row' : `BOTH rows (payments=${p}, charges=${c})`}; second waited on a lock: ${r.waited}; first=${r.first}; second=${r.second}`);
      if (p + c !== 1) failures.push(`race ${_label}: ${detail}`);
      expect(r.first, detail).toBe('ok');
      expect(p + c, detail).toBe(1);
      expect(r.second, detail).toMatch(/^recusado /);
    }, 60_000);
  });
});
