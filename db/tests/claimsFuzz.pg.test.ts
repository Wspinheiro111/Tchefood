/**
 * Fuzzer de concorrência da reserva de pagamento (payment_claims) e da Point no banco de verdade.
 *
 * N sessões psql abertas ao mesmo tempo rodam, em rodadas, operações sorteadas (semente fixa) sobre
 * duas contas de uma loja e uma conta de outra loja: reserva (tchefood_claim_payment), renovação,
 * liberação com o segredo, liberação do gerente com PIN (o prazo vencido é montado sem os gatilhos),
 * troca de reserva, pagamento do aparelho (aprovado com e sem reserva, recusado, reenvio), cobrança da
 * Point (abertura, bloqueio da chave, mudança de estado como a Edge Function faz, pagamento do Mercado
 * Pago, conferência com PIN + fim verificado) e redução do total (item cancelado, desconto).
 * Depois de cada rodada confere invariantes globais (ver INVARIANTS) e, por operação, o SQLSTATE contra a
 * lista do que cada uma pode recusar. 40P01 (travamento mútuo) e código fora da lista falham o teste.
 *
 * A semente fixa o sorteio das operações; o resultado de cada uma depende da ordem real em que o banco as
 * atende, então a reprodução mínima sai do registro impresso das últimas rodadas.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 * TCHEFOOD_FUZZ_SEEDS (padrão 4), TCHEFOOD_FUZZ_ROUNDS (padrão 200), TCHEFOOD_FUZZ_SESSIONS (padrão 6).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = `tchefood_claims_fuzz_${process.pid}`;
const ROOT = join(__dirname, '..', '..');
const SEEDS = Number(process.env.TCHEFOOD_FUZZ_SEEDS ?? 4);
const ROUNDS = Number(process.env.TCHEFOOD_FUZZ_ROUNDS ?? 200);
const SESSIONS = Number(process.env.TCHEFOOD_FUZZ_SESSIONS ?? 6);

const A = '11111111-1111-4111-8111-111111111111';
const B = '99999999-9999-4999-8999-999999999999';
const STAFF: Record<string, string> = { [A]: '22222222-2222-4222-8222-222222222222', [B]: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const MANAGER: Record<string, string> = { [A]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [B]: 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4' };
const PIN: Record<string, string> = { [A]: '8642', [B]: '7531' };
const TABLE: Record<string, string> = { [A]: '33333333-3333-4333-8333-333333333333', [B]: '34343434-3434-4434-8434-343434343434' };
const TERMINAL: Record<string, string> = { [A]: '55555555-5555-4555-8555-555555555555', [B]: '56565656-5656-4565-8565-565656565656' };
const MP_ID: Record<string, string> = { [A]: 'NEWLAND_N950__N950NCB801293324', [B]: 'NEWLAND_N950__N950NCB801299999' };
const STONE_TERMINAL = '66666666-6666-4666-8666-666666666666';
const MP_CNPJ = '10573521000191';
const STONE_CNPJ = '16501555000157';

function applySchema(t: PgTarget, db: string): void {
  createSupabaseLikeDb(t, db);
  psqlFile(t, join(ROOT, 'db', 'schema.sql'), db);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) psqlFile(t, join(dir, f), db);
}
function sql(q: string): string {
  const r = psql(target!, q, DB);
  if (!r.ok) throw new Error(`${r.sqlstate} ${r.message}`);
  return r.out;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// Sorteio com semente
// ---------------------------------------------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const chance = (rng: Rng, p: number) => rng() < p;
const hex = (rng: Rng, n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');
const uuid = (rng: Rng) => `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-8${hex(rng, 3)}-${hex(rng, 12)}`;

// ---------------------------------------------------------------------------------------------------------------
// Sessão psql persistente: cada comando termina com um marcador em stdout e em stderr
// ---------------------------------------------------------------------------------------------------------------
type Res = { ok: boolean; out: string; sqlstate: string | null; message: string | null; ms: number };
class Session {
  private child: ChildProcessWithoutNullStreams;
  private out = '';
  private err = '';
  private n = 0;
  constructor() {
    this.child = spawn('psql', ['-h', target!.host, '-p', target!.port, '-U', target!.user, '-d', DB, '-X', '-q', '-At', '-v', 'VERBOSITY=verbose']);
    this.child.stdout.on('data', (d) => { this.out += String(d); });
    this.child.stderr.on('data', (d) => { this.err += String(d); });
    this.child.on('exit', (code) => { this.exited = `psql saiu (${code}): ${this.err.slice(-300)}`; });
  }
  private exited: string | null = null;
  async run(text: string, timeoutMs = 30_000): Promise<Res> {
    this.n += 1;
    const mark = `__FUZZ_END_${this.n}__`;
    const start = Date.now();
    this.child.stdin.write(`${text}\n\\echo ${mark}\n\\warn ${mark}\n`);
    while (!(this.out.includes(`${mark}\n`) && this.err.includes(`${mark}\n`))) {
      if (this.exited) throw new Error(this.exited);
      if (Date.now() - start > timeoutMs) {
        // Quem espera quem, para o relatório (pg_blocking_pids e o que cada sessão está rodando).
        const who = psql(target!, `SELECT pid || ' ' || state || ' blocked_by=' || pg_blocking_pids(pid)::text || ' wait=' || COALESCE(wait_event_type || ':' || wait_event, '-')
          || ' xact_age=' || COALESCE(round(extract(epoch FROM clock_timestamp() - xact_start)::numeric, 1)::text, '-') || ' q=' || left(regexp_replace(query, '\\s+', ' ', 'g'), 300)
          FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();`, DB).out;
        throw new Error(`sessão parada há ${timeoutMs} ms (${text.slice(0, 300)})\n${who}`);
      }
      await pause(1);
    }
    const oi = this.out.indexOf(`${mark}\n`);
    const ei = this.err.indexOf(`${mark}\n`);
    const out = this.out.slice(0, oi).trim();
    const err = this.err.slice(0, ei);
    this.out = this.out.slice(oi + mark.length + 1);
    this.err = this.err.slice(ei + mark.length + 1);
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(err);
    // Travamento mútuo: junta o DETAIL (quem espera quem) e o CONTEXT (onde) na mensagem.
    const message = m?.[1] === '40P01' ? `${m[2]} | ${err.split('\n').filter((l) => /DETAIL|Process \d+|CONTEXT|statement/.test(l)).join(' | ')}` : m?.[2] ?? null;
    return { ok: !m, out, sqlstate: m?.[1] ?? null, message, ms: Date.now() - start };
  }
  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const device = (tenant: string, q: string, sleep = 0) =>
  `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${tenant}"}', true) \\g /dev/null
   ${q};${sleep ? ` SELECT pg_sleep(${sleep}) \\g /dev/null\n` : ''}
   COMMIT;`;
const service = (q: string, sleep = 0) =>
  `BEGIN; SET LOCAL ROLE service_role; ${q};${sleep ? ` SELECT pg_sleep(${sleep}) \\g /dev/null\n` : ''}
   COMMIT;`;

// ---------------------------------------------------------------------------------------------------------------
// Estado lido do banco no início de cada rodada (para sortear operações que façam sentido)
// ---------------------------------------------------------------------------------------------------------------
type Order = { id: string; tenant: string; status: string; bal: number; discount: number; reserved: number };
type Item = { id: string; order: string; status: string; paid: boolean };
type Claim = { key: string; tenant: string; order: string; status: string; cents: number; method: string; acq: string };
type Charge = { id: string; key: string; tenant: string; order: string; status: string; cents: number; nsu: string | null; auth: string | null;
  brand: string | null; term: string; serial: string; method: string; has_mp: boolean };
type Snap = { orders: Order[]; items: Item[]; claims: Claim[]; charges: Charge[]; pkeys: string[] };

const SNAP_SQL = `SELECT json_build_object(
  'orders', COALESCE((SELECT json_agg(json_build_object('id', id, 'tenant', tenant_id, 'status', status, 'bal', round(remaining_balance * 100)::bigint,
                       'discount', discount_amount, 'reserved', tchefood_point_reserved_cents(tenant_id, id, NULL)) ORDER BY id) FROM orders), '[]'),
  'items', COALESCE((SELECT json_agg(json_build_object('id', id, 'order', order_id, 'status', status, 'paid', is_paid) ORDER BY id) FROM order_items), '[]'),
  'claims', COALESCE((SELECT json_agg(json_build_object('key', idempotency_key, 'tenant', tenant_id, 'order', order_id, 'status', status, 'cents', amount_cents,
                       'method', method, 'acq', acquirer) ORDER BY idempotency_key, tenant_id) FROM payment_claims), '[]'),
  'charges', COALESCE((SELECT json_agg(json_build_object('id', c.id, 'key', c.idempotency_key, 'tenant', c.tenant_id, 'order', c.order_id, 'status', c.status,
                       'cents', c.amount_cents, 'nsu', c.external_payment_id, 'auth', c.authorization_code, 'brand', c.card_brand, 'term', c.terminal_id,
                       'serial', c.external_terminal_id, 'method', c.method,
                       'has_mp', EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = c.idempotency_key AND p.acquirer::text = 'MERCADO_PAGO'))
                       ORDER BY c.idempotency_key) FROM terminal_charges c), '[]'),
  'pkeys', COALESCE((SELECT json_agg(idempotency_key ORDER BY idempotency_key) FROM payments WHERE idempotency_key IS NOT NULL), '[]'))`;

// ---------------------------------------------------------------------------------------------------------------
// Invariantes globais (uma linha por violação)
// ---------------------------------------------------------------------------------------------------------------
const INVARIANTS = (minOrder: string) => `
WITH paid AS (SELECT o.id, o.tenant_id, o.status, o.total_amount, o.paid_amount, o.remaining_balance,
                     COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.order_id = o.id AND p.status = 'APPROVED'), 0) AS approved,
                     tchefood_point_reserved_cents(o.tenant_id, o.id, NULL) AS reserved
                FROM orders o WHERE o.id >= '${minOrder}')
SELECT 'I1 aprovado > total: conta ' || id || ' aprovado ' || approved || ' total ' || total_amount FROM paid WHERE approved > total_amount
UNION ALL SELECT 'I1b paid_amount/saldo fora da soma: conta ' || id FROM paid
  WHERE paid_amount <> approved OR remaining_balance <> GREATEST(total_amount - approved, 0)
UNION ALL SELECT 'I2 reservado > saldo: conta ' || id || ' reservado ' || reserved || ' saldo ' || round(remaining_balance * 100) FROM paid
  WHERE reserved > round(remaining_balance * 100)
UNION ALL SELECT 'I7 conta fechada com saldo ou reserva: ' || id || ' saldo ' || remaining_balance || ' reservado ' || reserved FROM paid
  WHERE status IN ('CLOSED', 'CANCELED') AND (remaining_balance <> 0 OR reserved <> 0)
    -- Conta fechada que teve o pagamento da Point estornado (tchefood_refund_point_payment) fica fechada com o saldo
    -- devolvido (como na main, a conta encerrada não reabre; decisão do Will): fora do I7.
    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = paid.id AND p.status = 'REFUNDED' AND p.acquirer::text = 'MERCADO_PAGO')
UNION ALL SELECT 'I7b reserva aberta em conta fechada: ' || pc.idempotency_key FROM payment_claims pc JOIN orders o ON o.id = pc.order_id
  WHERE pc.status = 'open' AND o.status IN ('CLOSED', 'CANCELED') AND o.id >= '${minOrder}'
UNION ALL SELECT 'I3 chave de reserva e de cobrança: ' || pc.idempotency_key FROM payment_claims pc JOIN terminal_charges c ON c.idempotency_key = pc.idempotency_key
UNION ALL SELECT 'I3b chave de reserva em duas lojas: ' || a.idempotency_key FROM payment_claims a JOIN payment_claims b
  ON a.idempotency_key = b.idempotency_key AND a.tenant_id < b.tenant_id
UNION ALL SELECT 'I3c pagamento fora do MP com chave de cobrança: ' || p.idempotency_key FROM payments p JOIN terminal_charges c ON c.idempotency_key = p.idempotency_key
  WHERE p.acquirer::text <> 'MERCADO_PAGO'
UNION ALL SELECT 'I3d pagamento do MP sem a cobrança dele: ' || p.idempotency_key FROM payments p
  WHERE p.acquirer::text = 'MERCADO_PAGO' AND NOT EXISTS (SELECT 1 FROM terminal_charges c WHERE c.idempotency_key = p.idempotency_key
                                                           AND c.tenant_id = p.tenant_id AND c.order_id = p.order_id)
UNION ALL SELECT 'I3e pagamento com chave de reserva de outra loja ou conta: ' || p.idempotency_key FROM payments p JOIN payment_claims pc
  ON pc.idempotency_key = p.idempotency_key AND (pc.tenant_id <> p.tenant_id OR pc.order_id <> p.order_id)
UNION ALL SELECT 'I4 reserva aberta com pagamento aprovado: ' || pc.idempotency_key FROM payment_claims pc
  WHERE pc.status = 'open' AND EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = pc.idempotency_key AND p.status = 'APPROVED')
UNION ALL SELECT 'I5 reserva liberada com pagamento aprovado: ' || pc.idempotency_key FROM payment_claims pc
  WHERE pc.status = 'released' AND EXISTS (SELECT 1 FROM payments p WHERE p.idempotency_key = pc.idempotency_key AND p.status = 'APPROVED')
UNION ALL SELECT 'I4b reserva consumida sem o pagamento que confere: ' || pc.idempotency_key FROM payment_claims pc
  WHERE pc.status = 'consumed' AND NOT EXISTS (
    SELECT 1 FROM payments p WHERE p.id = pc.consumed_payment_id AND p.tenant_id = pc.tenant_id AND p.order_id = pc.order_id
       AND p.idempotency_key = pc.idempotency_key AND p.method::text = pc.method AND p.acquirer::text = pc.acquirer
       AND round(p.amount * 100) <= pc.amount_cents)
UNION ALL SELECT 'I4c pagamento consumiu duas reservas: ' || consumed_payment_id FROM payment_claims
  WHERE consumed_payment_id IS NOT NULL GROUP BY consumed_payment_id HAVING count(*) > 1
UNION ALL SELECT 'I4d aprovado fora do MP sem reserva consumida por ele: ' || p.idempotency_key FROM payments p
  WHERE p.status = 'APPROVED' AND p.acquirer::text <> 'MERCADO_PAGO'
    AND NOT EXISTS (SELECT 1 FROM payment_claims pc WHERE pc.consumed_payment_id = p.id)
UNION ALL SELECT 'I6 aprovado do MP com a cobrança não aprovada: ' || p.idempotency_key || ' ' || c.status FROM payments p
  JOIN terminal_charges c ON c.idempotency_key = p.idempotency_key
  WHERE p.acquirer::text = 'MERCADO_PAGO' AND p.status = 'APPROVED' AND c.status <> 'approved'
UNION ALL SELECT 'I6b aprovado do MP com valor diferente da cobrança: ' || p.idempotency_key FROM payments p
  JOIN terminal_charges c ON c.idempotency_key = p.idempotency_key
  WHERE p.acquirer::text = 'MERCADO_PAGO' AND p.status = 'APPROVED' AND round(p.amount * 100) <> c.amount_cents
UNION ALL SELECT 'I8 item pago em conta aberta ou cancelado e pago: ' || i.id FROM order_items i JOIN orders o ON o.id = i.order_id
  WHERE i.status = 'CANCELED' AND i.is_paid AND o.id >= '${minOrder}'`;

// ---------------------------------------------------------------------------------------------------------------
// Operações
// ---------------------------------------------------------------------------------------------------------------
type OpResult = { kind: string; desc: string; res: Res; allowed: readonly string[]; extra?: string };
type Ctx = { rng: Rng; snap: Snap; seed: number; next: () => number; tokens: Map<string, string>; sent: string[] };

// Recusas esperadas por operação (P0001 = RAISE sem código, conferido pelo prefixo TCHEFOOD_).
const ALLOWED: Record<string, readonly string[]> = {
  claim: ['TF002', 'TF003', 'TF008', 'TF009'],
  touch: ['TF004', 'TF005'],
  release: ['TF004', 'TF005', 'TF007'],
  release_manager: ['TF005', 'TF007', 'TF011'],
  age: [],
  reclaim: ['TF002', 'TF003', 'TF004', 'TF005', 'TF007', 'TF009'],
  pay_claim: ['TF009', 'TF010', 'TF013', 'P0001'],
  pay_declined: ['TF009', 'TF010', 'P0001'], // chave repetida: TF009 key_in_use, nunca 23505
  pay_noclaim: ['TF009', 'TF010', 'TF013', 'P0001'],
  pay_replay: ['TF005', 'TF006', 'TF007', 'TF009', 'TF010', 'TF013', 'P0001'],
  open_charge: ['TF002', 'TF003', 'TF005', 'TF008', 'TF009'],
  block_key: ['TF005', 'TF009'],
  charge_step: ['P0001'],
  mp_pay: ['TF005', 'TF006', 'TF007', 'TF009', 'P0001'],
  resolve: ['TF005', 'TF006', 'TF007'],
  refund: ['TF006', 'TF007'],
  cancel_item: ['TF012', 'P0001'],
  discount: ['TF012', 'P0001'],
};

const fmt = (c: number) => (c / 100).toFixed(2);
function paymentJson(ctx: Ctx, o: Order, key: string, amountCents: number, method: string, acq: string, status: string): string {
  const n = ctx.next();
  const base: Record<string, unknown> = {
    id: uuid(ctx.rng), order_id: o.id, tenant_id: o.tenant, waiter_id: STAFF[o.tenant], terminal_id: null, amount: Number(fmt(amountCents)), tip_amount: 0,
    method, status, acquirer: acq, acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null,
    idempotency_key: key, created_at: new Date().toISOString(),
  };
  if (acq === 'STONE') Object.assign(base, { acquirer_cnpj: STONE_CNPJ, card_brand: 'VISA', nsu: `S${ctx.seed}x${n}`, authorization_code: 'A12345', terminal_serial: 'STONE-01', terminal_id: o.tenant === A ? STONE_TERMINAL : null });
  if (acq === 'PAGBANK') Object.assign(base, { acquirer_cnpj: '08561701000101', card_brand: 'VISA', nsu: `G${ctx.seed}x${n}`, authorization_code: 'A12345', terminal_serial: 'PAGBANK-01' });
  return JSON.stringify(base);
}
const METHODS: readonly [string, string][] = [['CASH', 'CASH_DESK'], ['CREDIT', 'STONE'], ['DEBIT', 'STONE'], ['PIX', 'PAGBANK'], ['CREDIT', 'PAGBANK']];
const sleepFor = (rng: Rng) => (chance(rng, 0.3) ? Number((rng() * 0.004).toFixed(4)) : 0);

function genOp(ctx: Ctx, s: Session): () => Promise<OpResult> {
  const { rng, snap } = ctx;
  const openOrders = snap.orders.filter((o) => o.status === 'OPEN' || o.status === 'PAYING');
  const anyOrder = (): Order => (chance(rng, 0.9) && openOrders.length ? pick(rng, openOrders) : pick(rng, snap.orders));
  const orderOf = (id: string) => snap.orders.find((o) => o.id === id)!;
  const ourClaims = snap.claims.filter((c) => ctx.tokens.has(`${c.tenant}|${c.key}`));
  const openClaims = ourClaims.filter((c) => c.status === 'open');
  const claimPick = (): Claim | undefined => (openClaims.length && chance(rng, 0.75) ? pick(rng, openClaims) : ourClaims.length ? pick(rng, ourClaims) : undefined);
  const newKey = () => `fz${ctx.seed}-${ctx.next()}`;
  /** Chave nova na maioria das vezes; às vezes a de uma reserva, cobrança ou pagamento (de qualquer loja). */
  const someKey = () => {
    const r = rng();
    if (r < 0.75) return newKey();
    if (r < 0.85 && snap.claims.length) return pick(rng, snap.claims).key;
    if (r < 0.95 && snap.charges.length) return pick(rng, snap.charges).key;
    if (snap.pkeys.length) return pick(rng, snap.pkeys);
    return newKey();
  };
  const tok = (c: Claim) => ctx.tokens.get(`${c.tenant}|${c.key}`)!;
  const wrongTok = () => hex(rng, 64);
  const run = (kind: string, desc: string, text: string, extra?: string) => async (): Promise<OpResult> => ({ kind, desc, res: await s.run(text), allowed: ALLOWED[kind], extra });

  const r = rng();
  // --- reserva --------------------------------------------------------------------------------------------------
  if (r < 0.2) {
    const o = anyOrder();
    const [m, a] = pick(rng, METHODS);
    const k = someKey();
    const token = hex(rng, 64);
    const free = Math.max(o.bal - o.reserved, 1);
    const cents = chance(rng, 0.8) ? 1 + Math.floor(rng() * free * 0.7) : chance(rng, 0.5) ? free : 1 + Math.floor(rng() * (o.bal + 3000));
    const expected = chance(rng, 0.9) ? o.bal : o.bal + 100;
    return async () => {
      const res = await s.run(device(o.tenant, `SELECT tchefood_claim_payment('${k}', '${o.id}', '${m}', '${a}', ${cents}, ${expected}, '${STAFF[o.tenant]}', '${token}')`, sleepFor(rng)));
      if (res.ok && !ctx.tokens.has(`${o.tenant}|${k}`)) ctx.tokens.set(`${o.tenant}|${k}`, token);
      return { kind: 'claim', desc: `claim ${k} ${o.tenant.slice(0, 2)}/${o.id.slice(-4)} ${m}/${a} ${cents} exp ${expected}`, res, allowed: ALLOWED.claim };
    };
  }
  if (r < 0.27) {
    const c = claimPick();
    if (!c) return genOp(ctx, s);
    const ok = chance(rng, 0.9);
    return run('touch', `touch ${c.key} ${ok ? 'token' : 'wrong'}`, device(c.tenant, `SELECT tchefood_touch_payment_claim('${c.key}', '${STAFF[c.tenant]}', '${ok ? tok(c) : wrongTok()}')`, sleepFor(rng)));
  }
  if (r < 0.34) {
    const c = claimPick();
    if (!c) return genOp(ctx, s);
    const ok = chance(rng, 0.9);
    return run('release', `release ${c.key} ${ok ? 'token' : 'wrong'}`, device(c.tenant, `SELECT tchefood_release_payment_claim('${c.key}', '${STAFF[c.tenant]}', '${ok ? tok(c) : wrongTok()}', 'desistiu')`, sleepFor(rng)));
  }
  if (r < 0.37) {
    const c = claimPick();
    if (!c) return genOp(ctx, s);
    // Prazo vencido montado sem os gatilhos (o gatilho só deixa o prazo andar pela renovação).
    return run('age', `age ${c.key}`, `BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE payment_claims SET active_until = clock_timestamp() - INTERVAL '6 minutes' WHERE tenant_id = '${c.tenant}' AND idempotency_key = '${c.key}'; COMMIT;`);
  }
  if (r < 0.41) {
    const c = claimPick();
    if (!c) return genOp(ctx, s);
    return run('release_manager', `release_manager ${c.key}`, device(c.tenant, `SELECT tchefood_release_payment_claim_manager('${c.key}', '${STAFF[c.tenant]}', '${PIN[c.tenant]}', 'aparelho sumiu com a reserva')`, sleepFor(rng)));
  }
  if (r < 0.45) {
    const c = claimPick();
    if (!c) return genOp(ctx, s);
    const [m, a] = pick(rng, METHODS);
    const nk = newKey();
    const nt = hex(rng, 64);
    const cents = chance(rng, 0.7) ? c.cents : 1 + Math.floor(rng() * c.cents * 1.5);
    const ok = chance(rng, 0.9);
    return async () => {
      const res = await s.run(device(c.tenant, `SELECT tchefood_reclaim_payment('${c.key}', '${ok ? tok(c) : wrongTok()}', '${nk}', '${nt}', '${m}', '${a}', ${cents}, '${STAFF[c.tenant]}')`, sleepFor(rng)));
      if (res.ok) ctx.tokens.set(`${c.tenant}|${nk}`, nt);
      return { kind: 'reclaim', desc: `reclaim ${c.key} -> ${nk} ${m}/${a} ${cents} ${ok ? 'token' : 'wrong'}`, res, allowed: ALLOWED.reclaim };
    };
  }
  // --- pagamento do aparelho -------------------------------------------------------------------------------------
  if (r < 0.6) {
    const c = claimPick();
    if (!c) return genOp(ctx, s);
    const o = orderOf(c.order);
    const cents = chance(rng, 0.7) ? c.cents : chance(rng, 0.5) ? Math.max(1, Math.floor(c.cents * rng())) : c.cents + 1 + Math.floor(rng() * 500);
    const [m, a] = chance(rng, 0.9) ? [c.method, c.acq] : pick(rng, METHODS);
    const j = paymentJson(ctx, o, c.key, cents, m, a, 'APPROVED');
    ctx.sent.push(`${o.tenant}|${j}`);
    const expectOk = c.status === 'open' && cents <= c.cents && m === c.method && a === c.acq;
    return run('pay_claim', `pay_claim ${c.key} [${c.status}] ${m}/${a} ${cents}/${c.cents}${expectOk ? ' (deve passar)' : ''}`,
      device(o.tenant, `SELECT tchefood_register_payment('${j}'::jsonb)`, sleepFor(rng)), expectOk ? `liveness:${c.tenant}|${c.key}` : undefined);
  }
  if (r < 0.65) {
    const o = anyOrder();
    const k = chance(rng, 0.6) && snap.claims.length ? pick(rng, snap.claims).key : someKey();
    const [m, a] = pick(rng, METHODS);
    const j = paymentJson(ctx, o, k, 1 + Math.floor(rng() * 3000), m, a, 'DECLINED');
    return run('pay_declined', `pay_declined ${k} ${o.id.slice(-4)} ${m}/${a}`, device(o.tenant, `SELECT tchefood_register_payment('${j}'::jsonb)`, sleepFor(rng)));
  }
  if (r < 0.68) {
    const o = anyOrder();
    const k = someKey();
    const [m, a] = pick(rng, METHODS);
    const j = paymentJson(ctx, o, k, 1 + Math.floor(rng() * 2000), m, a, 'APPROVED');
    return run('pay_noclaim', `pay_noclaim ${k} ${o.id.slice(-4)} ${m}/${a}`, device(o.tenant, `SELECT tchefood_register_payment('${j}'::jsonb)`, sleepFor(rng)));
  }
  if (r < 0.7 && ctx.sent.length) {
    const [tenant, j] = (() => { const x = pick(rng, ctx.sent); const i = x.indexOf('|'); return [x.slice(0, i), x.slice(i + 1)]; })();
    return run('pay_replay', `pay_replay ${(JSON.parse(j) as { idempotency_key: string }).idempotency_key}`, device(tenant, `SELECT tchefood_register_payment('${j}'::jsonb)`));
  }
  // --- Point (service role) ------------------------------------------------------------------------------------
  if (r < 0.77) {
    const o = anyOrder();
    const k = someKey();
    const free = Math.max(o.bal - o.reserved, 1);
    const cents = chance(rng, 0.8) ? 1 + Math.floor(rng() * free * 0.7) : chance(rng, 0.5) ? free : 1 + Math.floor(rng() * (o.bal + 3000));
    const expected = chance(rng, 0.9) ? o.bal : o.bal - 1;
    return run('open_charge', `open_charge ${k} ${o.tenant.slice(0, 2)}/${o.id.slice(-4)} ${cents} exp ${expected}`,
      service(`SELECT tchefood_open_terminal_charge('${o.tenant}', '${k}', '${o.id}', '${TERMINAL[o.tenant]}', '${MP_ID[o.tenant]}', 'CREDIT', ${cents}, '${STAFF[o.tenant]}', ${expected})`, sleepFor(rng)));
  }
  if (r < 0.79) {
    const o = anyOrder();
    const k = someKey();
    return run('block_key', `block_key ${k} ${o.id.slice(-4)}`,
      service(`SELECT tchefood_block_point_key('${o.tenant}', '${k}', '${o.id}', '${TERMINAL[o.tenant]}', '${MP_ID[o.tenant]}', 'CREDIT', 1000, '${STAFF[o.tenant]}')`, sleepFor(rng)));
  }
  const live = snap.charges.filter((c) => ['creating', 'pending', 'at_terminal'].includes(c.status));
  if (r < 0.86 && live.length) {
    // A Edge Function grava o estado que leu no Mercado Pago (UPDATE direto, condicionado ao estado lido).
    const c = pick(rng, live);
    const to = pick(rng, ['pending', 'at_terminal', 'manual_review', 'approved', 'approved', 'rejected', 'cancelled', 'expired']);
    const receipt = to === 'approved' ? `, external_payment_id = 'N${ctx.seed}x${ctx.next()}', paid_amount_cents = amount_cents, card_brand = 'VISA', authorization_code = 'AUT1'` : '';
    return run('charge_step', `charge_step ${c.key} ${c.status}->${to}`,
      service(`UPDATE terminal_charges SET status = '${to}'${receipt}, updated_at = clock_timestamp() WHERE id = '${c.id}' AND status = '${c.status}'`, sleepFor(rng)));
  }
  const payable = snap.charges.filter((c) => ['approved', 'rejected', 'cancelled', 'expired'].includes(c.status) && !c.has_mp);
  if (r < 0.92 && payable.length) {
    const c = pick(rng, payable);
    const o = orderOf(c.order);
    const status = c.status === 'approved' ? 'APPROVED' : 'DECLINED';
    const j = JSON.stringify({
      id: uuid(rng), order_id: c.order, tenant_id: c.tenant, waiter_id: STAFF[c.tenant], terminal_id: c.term, amount: Number(fmt(c.cents)), tip_amount: 0,
      method: c.method, status, acquirer: 'MERCADO_PAGO', acquirer_cnpj: MP_CNPJ, card_brand: c.brand ?? 'VISA', nsu: c.nsu ?? `X${ctx.next()}`,
      authorization_code: c.auth, terminal_serial: c.serial, idempotency_key: c.key, created_at: new Date().toISOString(),
    });
    ctx.sent.push(`${o.tenant}|${j}`);
    return run('mp_pay', `mp_pay ${c.key} [${c.status}] ${status} ${c.cents}`, device(c.tenant, `SELECT tchefood_register_payment('${j}'::jsonb)`, sleepFor(rng)));
  }
  // --- estorno do pagamento da Point registrado (auditoria interna 1, revisão de concorrência F2) ---------------------
  const refundable = snap.charges.filter((c) => c.status === 'approved' && c.has_mp);
  if (r < 0.93 && refundable.length && chance(rng, 0.8)) {
    const c = pick(rng, refundable);
    return async () => {
      const auth = await s.run(service(`SELECT tchefood_authorize_point_reconcile('${c.tenant}', '${c.key}', '${STAFF[c.tenant]}', '${PIN[c.tenant]}', 'conferir no Mercado Pago')`));
      if (!auth.ok) return { kind: 'refund', desc: `refund-auth ${c.key}`, res: auth, allowed: ALLOWED.refund };
      const ev = `{"authorization_audit_id":"${auth.out.split('\n').pop()}","operation_id":"${c.nsu}","mp_payment_id":"${c.nsu}","mp_amount_cents":${c.cents},`
        + `"mp_amount_refunded_cents":${c.cents},"mp_external_reference":"${c.key}","mp_status":"refunded"}`;
      const res = await s.run(service(`SELECT status FROM tchefood_refund_point_payment('${c.tenant}', '${c.id}', '${STAFF[c.tenant]}', 'conferido no Mercado Pago',
        '{"raw_status":"payment_refunded"}'::jsonb, '${ev}'::jsonb)`, sleepFor(rng)));
      return { kind: 'refund', desc: `refund ${c.key} ${c.cents}`, res, allowed: ALLOWED.refund };
    };
  }
  const resolvable = snap.charges.filter((c) => c.status === 'manual_review' || (c.status === 'approved' && !c.has_mp));
  if (r < 0.95 && resolvable.length) {
    const c = pick(rng, resolvable);
    const to = c.status === 'approved' ? 'refunded' : pick(rng, ['approved', 'rejected', 'cancelled', 'expired', 'refunded']);
    const patch = to === 'approved'
      ? `{"external_payment_id":"R${ctx.seed}x${ctx.next()}","paid_amount_cents":${c.cents},"card_brand":"VISA","authorization_code":"AUTR1"}` : '{}';
    return async () => {
      const auth = await s.run(service(`SELECT tchefood_authorize_point_reconcile('${c.tenant}', '${c.key}', '${STAFF[c.tenant]}', '${PIN[c.tenant]}', 'conferir no Mercado Pago')`));
      if (!auth.ok) return { kind: 'resolve', desc: `reconcile ${c.key} [${c.status}]`, res: auth, allowed: ALLOWED.resolve };
      const res = await s.run(service(`SELECT status FROM tchefood_resolve_point_charge('${c.tenant}', '${c.id}', '${c.status}', '${to}', '${patch}'::jsonb, '${STAFF[c.tenant]}',
        'conferido no Mercado Pago', '{"authorization_audit_id":"${auth.out.split('\n').pop()}","operation_id":"op-1","mp_status":"refunded","mp_amount_refunded_cents":${c.cents}}'::jsonb)`, sleepFor(rng)));
      return { kind: 'resolve', desc: `resolve ${c.key} ${c.status}->${to}`, res, allowed: ALLOWED.resolve };
    };
  }
  // --- redução do total, pelo caminho do aparelho: autorização com PIN (tchefood_authorize_manager), depois o PATCH --
  const authorizeQ = (o: Order, action: string, meta: string) =>
    device(o.tenant, `SELECT tchefood_authorize_manager('${o.id}', '${action}', '${PIN[o.tenant]}', '${STAFF[o.tenant]}', 'pedido do cliente', 0, '${meta}'::jsonb)`);
  if (chance(rng, 0.35)) {
    const items = snap.items.filter((i) => i.status !== 'CANCELED' && openOrders.some((o) => o.id === i.order));
    if (!items.length) return genOp(ctx, s);
    const i = pick(rng, items);
    const o = orderOf(i.order);
    return async () => {
      const auth = await s.run(authorizeQ(o, 'ITEM_CANCELED', `{"item_id":"${i.id}"}`));
      if (!auth.ok) return { kind: 'cancel_item', desc: `authorize ITEM_CANCELED ${i.id.slice(-4)}`, res: auth, allowed: ALLOWED.cancel_item };
      const res = await s.run(device(o.tenant, `UPDATE order_items SET status = 'CANCELED', cancel_reason = 'cliente desistiu', canceled_by_user_id = '${STAFF[o.tenant]}',
        canceled_at = now() WHERE id = '${i.id}'`, sleepFor(rng)));
      return { kind: 'cancel_item', desc: `cancel_item ${i.id.slice(-4)} of ${o.id.slice(-4)}`, res, allowed: ALLOWED.cancel_item };
    };
  }
  const o = openOrders.length ? pick(rng, openOrders) : pick(rng, snap.orders);
  const add = Number(fmt(1 + Math.floor(rng() * Math.max(o.bal * 0.15, 100))));
  const after = Number((o.discount + add).toFixed(2));
  return async () => {
    const auth = await s.run(authorizeQ(o, 'DISCOUNT_APPLIED', `{"discount_before":${o.discount},"discount_after":${after}}`));
    if (!auth.ok) return { kind: 'discount', desc: `authorize DISCOUNT ${o.id.slice(-4)}`, res: auth, allowed: ALLOWED.discount };
    const res = await s.run(device(o.tenant, `UPDATE orders SET discount_amount = ${after} WHERE id = '${o.id}'`, sleepFor(rng)));
    return { kind: 'discount', desc: `discount ${o.id.slice(-4)} ${o.discount}->${after}`, res, allowed: ALLOWED.discount };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------------------------------------------
let orderSeq = 0;
/** Conta aberta com itens (sem 10%), gravados sem os gatilhos de preço; totais acertados à mão. */
function newOrder(tenant: string, prices: number[]): string {
  orderSeq += 1;
  const id = `f0f0f0f0-0000-4000-8000-${String(orderSeq).padStart(12, '0')}`;
  const total = prices.reduce((a, b) => a + b, 0);
  sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${id}', '${tenant}', '${TABLE[tenant]}', '${STAFF[tenant]}');
       BEGIN; SET LOCAL session_replication_role = replica;
       ${prices.map((p) => `INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
         VALUES ('${id}', gen_random_uuid(), '${STAFF[tenant]}', 1, ${p}, ${p}, 'NONE');`).join('\n')}
       UPDATE orders SET charge_service_fee = false, subtotal_items = ${total}, total_amount = ${total}, paid_amount = 0, remaining_balance = ${total} WHERE id = '${id}';
       COMMIT;`);
  return id;
}

type Finding = { seed: number; round: number; kind: string; text: string; log: string[] };

describe.skipIf(!target)('fuzzer de concorrência: reservas de pagamento, Point e pagamentos no banco real', () => {
  const sessions: Session[] = [];
  beforeAll(() => {
    applySchema(target!, DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${A}', 'Loja', 'Loja Ltda', '11222333000181'), ('${B}', 'Outra', 'Outra Ltda', '11444777000161');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF[A]}', '${A}', 'Caixa', 'CASHIER', '5162'),
                ('${MANAGER[A]}', '${A}', 'Gerente', 'MANAGER', '${PIN[A]}'), ('${STAFF[B]}', '${B}', 'Caixa da outra', 'CASHIER', '5162'),
                ('${MANAGER[B]}', '${B}', 'Gerente da outra', 'MANAGER', '${PIN[B]}');
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${TABLE[A]}', '${A}', 1, 'Mesa 1'), ('${TABLE[B]}', '${B}', 1, 'Mesa 1');
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${TERMINAL[A]}', '${A}', 'Point Smart', '${MP_ID[A]}', 'MERCADO_PAGO'),
                ('${TERMINAL[B]}', '${B}', 'Point da outra', '${MP_ID[B]}', 'MERCADO_PAGO'), ('${STONE_TERMINAL}', '${A}', 'Stone 01', 'STONE-01', 'STONE');`);
    for (let i = 0; i < SESSIONS; i += 1) sessions.push(new Session());
  }, 180_000);

  afterAll(() => {
    for (const s of sessions) s.close();
    if (target) psql({ ...target, db: 'postgres' }, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
  });

  it(`${SEEDS} sementes × ${ROUNDS} rodadas × ${SESSIONS} sessões: invariantes, sem 40P01, só recusas esperadas`, async () => {
    const findings: Finding[] = [];
    const stats = new Map<string, Map<string, number>>();
    const count = (kind: string, code: string) => {
      const m = stats.get(kind) ?? new Map<string, number>();
      m.set(code, (m.get(code) ?? 0) + 1);
      stats.set(kind, m);
    };
    const started = Date.now();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      // Contas novas por semente: duas da loja A e uma da loja B, com itens para o cancelamento.
      // Contas de sementes anteriores ficam como estão e saem do sorteio e das invariantes por conta.
      const minOrder = newOrder(A, [60, 25, 15]);
      newOrder(A, [40, 30, 30]);
      newOrder(B, [70, 30]);
      const rng = mulberry32(seed * 7919);
      let counter = 0;
      const ctx: Ctx = { rng, seed, next: () => (counter += 1), tokens: new Map(), sent: [], snap: { orders: [], items: [], claims: [], charges: [], pkeys: [] } };
      const log: string[] = [];
      const seedOrders = new Set<string>();
      for (let round = 0; round < ROUNDS; round += 1) {
        const all = JSON.parse(sql(SNAP_SQL)) as Snap;
        if (round === 0) for (const o of all.orders.filter((x) => x.id >= minOrder)) seedOrders.add(o.id);
        const inSeed = (id: string) => seedOrders.has(id);
        ctx.snap = { orders: all.orders.filter((o) => inSeed(o.id)), items: all.items.filter((i) => inSeed(i.order)),
          claims: all.claims.filter((c) => inSeed(c.order)), charges: all.charges.filter((c) => inSeed(c.order)), pkeys: all.pkeys };
        // Mantém duas contas abertas na loja A e uma na B (as fechadas continuam nas invariantes).
        const openOf = (t: string) => ctx.snap.orders.filter((o) => o.tenant === t && (o.status === 'OPEN' || o.status === 'PAYING')).length;
        if (openOf(A) < 2 || openOf(B) < 1) {
          if (openOf(A) < 2) seedOrders.add(newOrder(A, [60, 25, 15]));
          if (openOf(B) < 1) seedOrders.add(newOrder(B, [70, 30]));
          continue;
        }
        const ops = sessions.map((s) => genOp(ctx, s));
        const results = await Promise.all(ops.map(async (op) => { await pause(rng() * 4); return op(); }));
        const roundLog: string[] = [];
        for (const r of results) {
          const code = r.res.ok ? 'ok' : r.res.sqlstate ?? '??';
          // P0001 (RAISE sem código) é separado pelo começo da mensagem, sem números nem chaves.
          count(r.kind, code === 'P0001' ? `P0001(${(r.res.message ?? '').replace(/^TCHEFOOD_[A-Z]+: /, '').replace(/[0-9][0-9.]*|fz[0-9-]+/g, '#').slice(0, 38)})` : code);
          roundLog.push(`  ${r.desc} => ${r.res.ok ? `ok ${r.res.out.split('\n').pop()?.slice(0, 80) ?? ''}` : `${code} ${r.res.message?.slice(0, 160)}`}`);
          if (!r.res.ok) {
            const unexpected = code === '40P01' || !r.allowed.includes(code) || (code === 'P0001' && !/^TCHEFOOD_/.test(r.res.message ?? ''));
            if (unexpected) findings.push({ seed, round, kind: code === '40P01' ? 'deadlock' : 'sqlstate', text: `${r.desc} => ${code} ${r.res.message}`, log: [] });
          }
        }
        log.push(`round ${round}:`, ...roundLog);
        // Pagamento de reserva aberta, nos termos dela, recusado sem que nada mais na rodada tenha mexido na reserva.
        for (const r of results) {
          if (!r.extra?.startsWith('liveness:') || r.res.ok) continue;
          const [tenant, key] = r.extra.slice('liveness:'.length).split('|');
          const touched = results.some((x) => x !== r && x.desc.includes(key));
          const still = sql(`SELECT status FROM payment_claims WHERE tenant_id = '${tenant}' AND idempotency_key = '${key}'`);
          if (!touched && still === 'open') findings.push({ seed, round, kind: 'liveness', text: `${r.desc} => ${r.res.sqlstate} ${r.res.message}`, log: [] });
        }
        const lines = sql(INVARIANTS(minOrder)).split('\n').filter(Boolean);
        // I1 (aprovado acima do total) é invariante como as outras: desconto ou item cancelado abaixo do já pago é
        // recusado (TF012 total_below_paid, tchefood_order_reserved_guard).
        const hard = lines;
        if (hard.length) {
          findings.push({ seed, round, kind: 'invariant', text: hard.join('\n'), log: log.slice(-40) });
          break; // estado já quebrado: os próximos achados seriam consequência
        }
      }
      const final = sql(INVARIANTS(minOrder)).split('\n').filter(Boolean).join('\n');
      if (final) findings.push({ seed, round: ROUNDS, kind: 'invariant(final)', text: final, log: log.slice(-40) });
      for (const f of findings.filter((x) => x.seed === seed && !x.log.length)) {
        const at = log.findIndex((l) => l === `round ${f.round}:`);
        f.log = at >= 0 ? log.slice(Math.max(0, at - 12), at + SESSIONS + 1) : [];
      }
    }
    const table = [...stats.entries()].sort().map(([k, m]) => `${k.padEnd(16)} ${[...m.entries()].sort().map(([c, n]) => `${c}:${n}`).join('  ')}`);
    console.log(`fuzz ${SEEDS}x${ROUNDS}x${SESSIONS} em ${((Date.now() - started) / 1000).toFixed(1)} s\n${table.join('\n')}`);
    for (const f of findings.slice(0, 20)) console.log(`\n[${f.kind}] semente ${f.seed} rodada ${f.round}: ${f.text}\n${f.log.join('\n')}`);
    expect(findings.map((f) => `[${f.kind}] s${f.seed} r${f.round}: ${f.text.split('\n')[0]}`)).toEqual([]);
  }, 600_000);

  // Reprodução dirigida do 40P01 que o sorteio só acha de vez em quando: o cancelamento do item (PATCH order_items) trava
  // o item e depois a conta (tchefood_recalc_order); o pagamento que quita a conta trava a conta e depois os itens
  // (tchefood_auto_close marca is_paid). A janela entre as duas travas do pagamento é alargada por uma sessão que segura a
  // trava da chave do pagamento (a que o gatilho de payments pega com a conta já travada), como qualquer reserva,
  // cobrança ou pagamento com a mesma chave faria.
  it('item cancelado × pagamento que quita a conta: sem 40P01', async () => {
    const o = newOrder(A, [60, 40]);
    const item = sql(`SELECT id FROM order_items WHERE order_id = '${o}' AND total_item_price = 60`);
    const k = `fzdl-${o.slice(-6)}`;
    const token = 'a'.repeat(64);
    const [h, pay, cancel] = [new Session(), new Session(), new Session()];
    try {
      expect((await pay.run(device(A, `SELECT tchefood_authorize_manager('${o}', 'ITEM_CANCELED', '${PIN[A]}', '${STAFF[A]}', 'cliente desistiu', 0, '{"item_id":"${item}"}'::jsonb)`))).ok).toBe(true);
      expect((await pay.run(device(A, `SELECT tchefood_claim_payment('${k}', '${o}', 'CASH', 'CASH_DESK', 10000, 10000, '${STAFF[A]}', '${token}')`))).ok).toBe(true);
      expect((await h.run(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('tchefood_payment_key:${k}', 0)) \\g /dev/null`)).ok).toBe(true);
      const j = JSON.stringify({ id: crypto.randomUUID(), order_id: o, tenant_id: A, waiter_id: STAFF[A], amount: 100, tip_amount: 0, method: 'CASH',
        status: 'APPROVED', acquirer: 'CASH_DESK', idempotency_key: k });
      const waiting = () => Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type IN ('Lock')`));
      const before = waiting();
      const p = pay.run(device(A, `SELECT tchefood_register_payment('${j}'::jsonb)`));
      while (waiting() < before + 1) await pause(10);
      const c = cancel.run(device(A, `UPDATE order_items SET status = 'CANCELED', cancel_reason = 'cliente desistiu', canceled_by_user_id = '${STAFF[A]}', canceled_at = now() WHERE id = '${item}'`));
      while (waiting() < before + 2) await pause(10);
      await h.run('COMMIT;');
      const [pr, cr] = await Promise.all([p, c]);
      console.log(`pagamento: ${pr.ok ? 'ok' : `${pr.sqlstate} ${pr.message}`}\ncancelamento: ${cr.ok ? 'ok' : `${cr.sqlstate} ${cr.message}`}`);
      expect([pr.sqlstate, cr.sqlstate]).not.toContain('40P01');
    } finally {
      for (const x of [h, pay, cancel]) x.close();
    }
  }, 60_000);
});
