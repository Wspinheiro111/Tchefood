/**
 * Auditoria #59 r1 P2-03: a Edge Function point-charge de verdade (supabase/functions/point-charge/handler.ts, o mesmo
 * código que index.ts liga no Deno) contra o banco de verdade, com duas lojas e duas contas do Mercado Pago. A loja vem
 * do RLS do chamador (tenants_self, pos_terminals) e o token do Mercado Pago da service role filtrada por ela:
 *  - a loja A só vê as maquininhas da conta A, a B só as da B;
 *  - sessão recusada (JWT inválido/vencido) ou sem loja no JWT não vê lista nenhuma (401);
 *  - loja sem Access Token: 412 not_configured;
 *  - a loja B não cobra na maquininha da A (404), e a A não cobra numa Point fora da conta dela (409, nada gravado).
 * Se a escolha da loja sair do caminho (ler tenants ou o token sem o filtro), estes testes falham.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PaymentTerminalChargeResult, PaymentTerminalProvider } from '../../server/shared/paymentTerminal';
import { handlePointCharge } from '../../supabase/functions/point-charge/handler';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget } from './postgrestEmulator';
import { cloudUnreachable, resetCloudReachability, trackCloudReachability } from '../../src/lib/sync/cloudReachability';
import { rejectedSession, serviceDb } from './serviceDb';

const target = pgTargetFromEnv();
const DB = 'tchefood_point_auth_' + process.pid;
const ROOT = join(__dirname, '..', '..');
const A = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a';
const B = '2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b';
const C = '3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c';
const D = '9d9d9d9d-9d9d-49d9-89d9-9d9d9d9d9d9d';
const TERMINAL_A = '4d4d4d4d-4d4d-44d4-84d4-4d4d4d4d4d4d';
const TERMINAL_A_OUT = '5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e';
const TERMINAL_A_OFF = '8b8b8b8b-8b8b-48b8-88b8-8b8b8b8b8b8b';
const STAFF_A = '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a';
const ORDER_R1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const ORDER_R2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const ORDER_R3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';

/** JWT → claims, como a Supabase Auth deste teste. */
const SESSIONS: Record<string, Record<string, unknown>> = {
  'jwt-a': { role: 'authenticated', tenant_id: A, sub: 'aparelho-a' },
  'jwt-b': { role: 'authenticated', tenant_id: B, sub: 'aparelho-b' },
  'jwt-c': { role: 'authenticated', tenant_id: C, sub: 'aparelho-c' },
  'jwt-d': { role: 'authenticated', tenant_id: D, sub: 'aparelho-d' },
  'jwt-sem-loja': { role: 'authenticated', sub: 'sem-loja' },
};
/** Access Token do Mercado Pago → maquininhas da conta. */
const MP_ACCOUNTS: Record<string, string[]> = {
  'APP_USR-conta-a': ['NEWLAND_N950__CONTA_A_1', 'NEWLAND_N950__CONTA_A_2'],
  'APP_USR-conta-b': ['NEWLAND_N950__CONTA_B_1'],
};
const placed = new Map<string, PaymentTerminalChargeResult>();
const tokensUsed: string[] = [];
/** Ganchos do provedor falso: segura a lista do Mercado Pago (r6 P1-01) e registra/atende as ordens enviadas. */
const mp = {
  /** Segura a PRÓXIMA chamada da lista (consumida por ela) e avisa quando uma chamada entra. */
  listGate: null as Promise<void> | null,
  /** Faz a PRÓXIMA chamada da lista falhar (depois do gate, se houver). */
  failNext: false,
  entered: [] as (() => void)[],
  creates: [] as { idempotencyKey: string; externalTerminalId: string }[],
  create: async (): Promise<never> => { throw new Error('não deveria criar'); },
} as {
  listGate: Promise<void> | null;
  failNext: boolean;
  entered: (() => void)[];
  creates: { idempotencyKey: string; externalTerminalId: string }[];
  create: (r: { idempotencyKey: string; externalTerminalId: string; amountCents: number }) => Promise<PaymentTerminalChargeResult>;
};

function provider(token: string): PaymentTerminalProvider {
  tokensUsed.push(token);
  const list = MP_ACCOUNTS[token];
  return {
    key: 'mercado_pago_point', createRetryPolicy: 'same_key', approvalIdentity: 'reference_and_terminal', supportedMethods: ['credit', 'debit', 'pix'],
    listTerminals: async () => {
      if (!list) throw new Error('token desconhecido');
      const gate = mp.listGate;
      const failing = mp.failNext;
      mp.listGate = null;
      mp.failNext = false;
      mp.entered.shift()?.();
      if (gate) await gate;
      if (failing) throw new Error('Mercado Pago não respondeu');
      return list.map((id) => ({ provider: 'mercado_pago_point' as const, externalTerminalId: id, operatingMode: 'pdv' as const, externalStoreId: null, externalPosId: null }));
    },
    createCharge: async (r) => { mp.creates.push({ idempotencyKey: r.idempotencyKey, externalTerminalId: r.externalTerminalId }); return mp.create(r); },
    getCharge: async (id) => {
      if (!placed.has(id)) throw new Error('não deveria consultar');
      return placed.get(id)!;
    },
    cancelCharge: async () => { throw new Error('não deveria cancelar'); },
  };
}

async function call(auth: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handlePointCharge(
    new Request('http://cloud.test/functions/v1/point-charge', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    {
      callerDb: (h) => {
        const claims = SESSIONS[h.replace(/^Bearer\s+/, '')];
        return claims ? serviceDb(target!, DB, { role: 'authenticated', claims }) : rejectedSession;
      },
      adminDb: () => serviceDb(target!, DB),
      provider,
      payments: () => ({ getPayment: async () => { throw new Error('não deveria ler pagamento'); } }),
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

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

(target ? describe : describe.skip)('point-charge com duas lojas no banco real (auditoria #59 r1 P2-03)', () => {
  beforeAll(() => {
    applySchema(target!, DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES
           ('${A}', 'Loja A', 'Loja A Ltda', '11222333000181'),
           ('${B}', 'Loja B', 'Loja B Ltda', '11444777000161'),
           ('${C}', 'Loja C', 'Loja C Ltda', '19131243000197'),
           ('${D}', 'Loja D', 'Loja D Ltda', '45723174000110');
         INSERT INTO payment_provider_secrets (tenant_id, provider, access_token) VALUES
           ('${A}', 'mercado_pago_point', 'APP_USR-conta-a'),
           ('${B}', 'mercado_pago_point', 'APP_USR-conta-b'),
           ('${D}', 'mercado_pago_point', 'APP_USR-token-quebrado');
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer, mode, online) VALUES
           ('${TERMINAL_A}', '${A}', 'Point A', 'NEWLAND_N950__CONTA_A_1', 'MERCADO_PAGO', 'TEF_POS_WIRELESS', true),
           ('${TERMINAL_A_OUT}', '${A}', 'Point de outra conta', 'NEWLAND_N950__CONTA_B_1', 'MERCADO_PAGO', 'TEF_POS_WIRELESS', true),
           ('${TERMINAL_A_OFF}', '${A}', 'Point desativada', 'NEWLAND_N950__CONTA_A_2', 'MERCADO_PAGO', 'TEF_POS_WIRELESS', false);
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF_A}', '${A}', 'Caixa A', 'CASHIER', '5162');
         INSERT INTO dining_tables (tenant_id, number, label) VALUES ('${A}', 901, 'Mesa 901'), ('${A}', 902, 'Mesa 902'), ('${A}', 903, 'Mesa 903');
         INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id)
           SELECT o.id, '${A}', t.id, '${STAFF_A}' FROM (VALUES ('${ORDER_R1}'::uuid, 901), ('${ORDER_R2}'::uuid, 902), ('${ORDER_R3}'::uuid, 903)) o(id, n)
           JOIN dining_tables t ON t.tenant_id = '${A}' AND t.number = o.n;`);
    // Contas de R$ 10,00 (sem gatilhos: só os totais, como nos outros testes de banco).
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
         INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
           SELECT id, gen_random_uuid(), '${STAFF_A}', 1, 10, 10, 'NONE' FROM orders WHERE id IN ('${ORDER_R1}', '${ORDER_R2}', '${ORDER_R3}');
         UPDATE orders SET charge_service_fee = false, subtotal_items = 10, total_amount = 10, paid_amount = 0, remaining_balance = 10 WHERE id IN ('${ORDER_R1}', '${ORDER_R2}', '${ORDER_R3}');
         COMMIT;`);
  });

  it('cada loja só vê as maquininhas da própria conta do Mercado Pago', async () => {
    tokensUsed.length = 0;
    expect(await call('Bearer jwt-a', { action: 'terminals' })).toEqual({ status: 200, body: { terminals: [{ id: 'NEWLAND_N950__CONTA_A_1', operating_mode: 'pdv' }, { id: 'NEWLAND_N950__CONTA_A_2', operating_mode: 'pdv' }] } });
    expect(await call('Bearer jwt-b', { action: 'terminals' })).toEqual({ status: 200, body: { terminals: [{ id: 'NEWLAND_N950__CONTA_B_1', operating_mode: 'pdv' }] } });
    expect(tokensUsed).toEqual(['APP_USR-conta-a', 'APP_USR-conta-b']);
  });

  it('sessão recusada, sem loja no JWT ou sem Authorization: nenhuma lista', async () => {
    tokensUsed.length = 0;
    expect(await call('Bearer jwt-vencido', { action: 'terminals' })).toMatchObject({ status: 401, body: { error: 'auth' } });
    expect(await call('Bearer jwt-sem-loja', { action: 'terminals' })).toMatchObject({ status: 401, body: { error: 'auth' } });
    expect(await call('', { action: 'terminals' })).toMatchObject({ status: 401, body: { error: 'auth' } });
    expect(tokensUsed).toEqual([]);
  });

  it('loja sem Access Token do Mercado Pago: 412 not_configured, sem chamar o Mercado Pago', async () => {
    tokensUsed.length = 0;
    expect(await call('Bearer jwt-c', { action: 'terminals' })).toMatchObject({ status: 412, body: { error: 'not_configured' } });
    expect(tokensUsed).toEqual([]);
  });

  it('cobrança: a loja B não usa a maquininha da A; a A não cobra numa Point fora da conta dela', async () => {
    const charge = (terminal: string, key: string) => ({
      action: 'create', terminal_id: terminal, idempotency_key: key, order_id: '6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f', amount_cents: 1000, expected_balance_cents: 1000, method: 'CREDIT', staff_id: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
    });
    expect(await call('Bearer jwt-b', charge(TERMINAL_A, 'chave-b-1'))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await call('Bearer jwt-a', charge(TERMINAL_A_OUT, 'chave-a-1'))).toMatchObject({ status: 409, body: { error: 'terminal_not_ready' } });
    // Nada reservado nem enviado; só a chave presa (cancelada antes do envio, r6 P1-02), sem ordem no Mercado Pago.
    expect(sql(`SELECT count(*) FROM terminal_charges`)).toBe('1');
    expect(sql(`SELECT status || '/' || raw_status || '/' || coalesce(external_order_id, '-') FROM terminal_charges WHERE idempotency_key = 'chave-a-1'`)).toBe('cancelled/voided_before_send/-');
    expect(mp.creates).toEqual([]);
  });

  it('Point desativada no banco (online=false) está na conta e no PDV do Mercado Pago, mas cobrança nova é recusada sem gravar nada (auditoria #59 r5 P1-01)', async () => {
    const body = {
      action: 'create', terminal_id: TERMINAL_A_OFF, idempotency_key: 'chave-off-1', order_id: '6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f', amount_cents: 1000, expected_balance_cents: 1000, method: 'CREDIT', staff_id: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
    };
    // A lista do Mercado Pago mostra a Point (CONTA_A_2 está na conta A, no PDV): só o online=false do banco barra.
    expect((await call('Bearer jwt-a', { action: 'terminals' })).body.terminals).toContainEqual({ id: 'NEWLAND_N950__CONTA_A_2', operating_mode: 'pdv' });
    expect(await call('Bearer jwt-a', body)).toMatchObject({ status: 409, body: { error: 'terminal_inactive' } });
    // Só a chave presa (cancelada antes do envio, r7 P1-01): nada reservado, nada enviado.
    expect(sql(`SELECT status || '/' || raw_status FROM terminal_charges WHERE idempotency_key = 'chave-off-1'`)).toBe('cancelled/voided_before_send');
    expect(mp.creates.filter((c) => c.idempotencyKey === 'chave-off-1')).toEqual([]);
    // Religada no banco, a mesma chamada passa da verificação (e só então esbarra no teste, que não cria cobrança).
    sql(`UPDATE pos_terminals SET online = true WHERE id = '${TERMINAL_A_OFF}'`);
    const on = await call('Bearer jwt-a', body);
    expect(on.body.error).not.toBe('terminal_inactive');
    sql(`UPDATE pos_terminals SET online = false WHERE id = '${TERMINAL_A_OFF}'`);
  });

  /** Segura a próxima lista do Mercado Pago e devolve: quando ela entrou, e como soltar. */
  function holdNextList(opts: { failAfter?: boolean } = {}): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    mp.listGate = new Promise<void>((res) => { release = res; });
    mp.failNext = opts.failAfter === true;
    const entered = new Promise<void>((res) => { mp.entered.push(res); });
    return { entered, release };
  }
  const chargeBody = (terminal: string, key: string, order: string) => ({
    action: 'create', terminal_id: terminal, idempotency_key: key, order_id: order, amount_cents: 1000, expected_balance_cents: 1000, method: 'CREDIT', staff_id: STAFF_A,
  });
  const atTerminal = (key: string, serial: string, id: string): PaymentTerminalChargeResult => ({
    provider: 'mercado_pago_point', externalOrderId: id, externalPaymentId: null, externalTransactionId: null, externalReference: key, externalTerminalId: serial,
    status: 'at_terminal', rawStatus: 'at_terminal', rawStatusDetail: 'at_terminal', amountCents: 1000, paidAmountCents: null, paymentMethodId: null, paymentMethodType: null, installments: null,
  });

  it('Point desativada DURANTE a conferência no Mercado Pago: 409 terminal_inactive, nenhuma reserva nova, createCharge nunca chamado; a cobrança já reservada segue (auditoria #59 r6 P1-01)', async () => {
    mp.creates.length = 0;
    sql(`UPDATE pos_terminals SET online = true WHERE id = '${TERMINAL_A_OFF}'`);
    const SERIAL = 'NEWLAND_N950__CONTA_A_2';
    // Cobrança anterior, reservada com a Point ativa.
    mp.create = async (r) => { const o = atTerminal(r.idempotencyKey, SERIAL, 'ORD-PREV'); placed.set('ORD-PREV', o); return o; };
    const prev = await call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r6-prev', ORDER_R2));
    expect(prev.status).toBe(200);
    expect(mp.creates.map((c) => c.idempotencyKey)).toEqual(['chave-r6-prev']);
    // Cobrança nova: a conferência no Mercado Pago fica suspensa; a loja desativa a Point direto no banco; a lista chega
    // mostrando a Point no PDV. O banco recusa na hora de reservar.
    const held = holdNextList();
    const racing = call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r6-race', ORDER_R1));
    await held.entered;
    sql(`UPDATE pos_terminals SET online = false WHERE id = '${TERMINAL_A_OFF}'`);
    held.release();
    expect(await racing).toMatchObject({ status: 409, body: { error: 'terminal_inactive' } });
    // Só a chave presa (cancelada antes do envio): nenhuma cobrança reservando a conta.
    expect(sql(`SELECT status || '/' || raw_status FROM terminal_charges WHERE idempotency_key = 'chave-r6-race'`)).toBe('cancelled/voided_before_send');
    expect(sql(`SELECT count(*) FROM terminal_charges WHERE order_id = '${ORDER_R1}' AND status <> 'cancelled'`)).toBe('0');
    expect(mp.creates.map((c) => c.idempotencyKey)).toEqual(['chave-r6-prev']);
    // A cobrança reservada antes continua consultável e a repetição da mesma chave devolve a mesma cobrança, sem outra ordem.
    const status = await call('Bearer jwt-a', { action: 'status', idempotency_key: 'chave-r6-prev' });
    expect(status).toMatchObject({ status: 200, body: { status: 'PENDING' } });
    const again = await call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r6-prev', ORDER_R2));
    expect(again).toMatchObject({ status: 200, body: { status: 'PENDING' } });
    expect(mp.creates.map((c) => c.idempotencyKey)).toEqual(['chave-r6-prev']);
    expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'chave-r6-prev'`)).toBe('1');
  });

  it('a trava da Point ativa é do banco: tchefood_open_terminal_charge recusa Point desativada (TF010) e deixa a desativação esperar a reserva (auditoria #59 r6 P1-01)', async () => {
    // Direto na função, sem a Edge Function: o atalho da Edge Function não é o que protege.
    const open = (key: string) => psql(target!, `SELECT tchefood_open_terminal_charge('${A}', '${key}', '${ORDER_R1}', '${TERMINAL_A_OFF}', 'NEWLAND_N950__CONTA_A_2', 'CREDIT', 1000, '${STAFF_A}', 1000)`, DB);
    const refused = open('chave-r6-sql');
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('desativada');
    expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'chave-r6-sql'`)).toBe('0');
    // Chave já gravada: devolve a cobrança que ficou mesmo com a Point desativada.
    const known = psql(target!, `SELECT tchefood_open_terminal_charge('${A}', 'chave-r6-prev', '${ORDER_R2}', '${TERMINAL_A_OFF}', 'NEWLAND_N950__CONTA_A_2', 'CREDIT', 1000, '${STAFF_A}', 1000)`, DB);
    expect(known.ok).toBe(true);
    // Ativa de novo. Uma sessão reserva e segura a transação aberta; a desativação feita por outra sessão no meio TEM de
    // esperar (FOR SHARE na linha da maquininha): com lock_timeout ela falha em vez de passar por cima da reserva.
    sql(`UPDATE pos_terminals SET online = true WHERE id = '${TERMINAL_A_OFF}'`);
    const holder = spawn('psql', ['-h', target!.host, '-p', String(target!.port), '-U', target!.user, '-d', DB, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let holderOut = '';
    holder.stdout.on('data', (d: Buffer) => { holderOut += d.toString(); });
    holder.stdin.write(`BEGIN; SELECT 'reservou' FROM (SELECT tchefood_open_terminal_charge('${A}', 'chave-r6-lock', '${ORDER_R1}', '${TERMINAL_A_OFF}', 'NEWLAND_N950__CONTA_A_2', 'CREDIT', 1000, '${STAFF_A}', 1000)) x; SELECT pg_sleep(3); COMMIT;\n`);
    const closed = new Promise<void>((res) => holder.on('close', () => res()));
    for (let i = 0; i < 100 && !holderOut.includes('reservou'); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(holderOut).toContain('reservou');
    const blocked = psql(target!, `SET lock_timeout = '300ms'; UPDATE pos_terminals SET online = false WHERE id = '${TERMINAL_A_OFF}';`, DB);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/lock timeout/i);
    holder.stdin.end();
    await closed;
    // Reserva confirmada (COMMIT): agora a desativação passa, e a reserva já gravada continua lá.
    sql(`UPDATE pos_terminals SET online = false WHERE id = '${TERMINAL_A_OFF}'`);
    expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'chave-r6-lock'`)).toBe('1');
    sql(`DELETE FROM terminal_charges WHERE idempotency_key = 'chave-r6-lock'`);
  });

  it('mesma chave em duas requisições no banco real: a conferência que falha depois não nega uma cobrança que existe; a que falha antes prende a chave e a outra nunca envia (auditoria #59 r6 P1-02)', async () => {
    mp.creates.length = 0;
    sql(`UPDATE pos_terminals SET online = true WHERE id = '${TERMINAL_A_OFF}'`);
    const SERIAL = 'NEWLAND_N950__CONTA_A_2';
    mp.create = async (r) => { const o = atTerminal(r.idempotencyKey, SERIAL, `ORD-${r.idempotencyKey}`); placed.set(o.externalOrderId, o); return o; };
    // (a) A confere primeiro e fica pendurada (e falha depois); B confere, grava e envia.
    const heldA = holdNextList({ failAfter: true });
    const a = call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r6-a', ORDER_R3));
    await heldA.entered;
    const b = await call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r6-a', ORDER_R3));
    expect(b).toMatchObject({ status: 200, body: { status: 'PENDING' } });
    heldA.release();
    expect(await a).toEqual(b);
    expect(mp.creates.filter((c) => c.idempotencyKey === 'chave-r6-a')).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM terminal_charges WHERE idempotency_key = 'chave-r6-a'`)).toBe('1');
    // (b) Ordem invertida: B confere primeiro e fica pendurada; a conferência de A falha na hora.
    const heldB = holdNextList();
    const slow = call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r6-b', ORDER_R1));
    await heldB.entered;
    mp.failNext = true;
    const refused = await call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r6-b', ORDER_R1));
    expect(refused).toMatchObject({ status: 424, body: { error: 'mp_unavailable' } });
    heldB.release();
    const late = await slow;
    expect(late).toMatchObject({ status: 200, body: { status: 'DECLINED' } });
    expect(mp.creates.filter((c) => c.idempotencyKey === 'chave-r6-b')).toHaveLength(0);
    expect(sql(`SELECT status || '/' || raw_status FROM terminal_charges WHERE idempotency_key = 'chave-r6-b'`)).toBe('cancelled/voided_before_send');
    sql(`UPDATE pos_terminals SET online = false WHERE id = '${TERMINAL_A_OFF}'`);
  });

  it('recusa por Point desativada também prende a chave: com uma requisição da mesma chave pendurada na conferência, se a outra recebeu recusa definitiva nenhuma envia (atalho e TF010, auditoria #59 r7 P1-01)', async () => {
    mp.creates.length = 0;
    const SERIAL = 'NEWLAND_N950__CONTA_A_2';
    mp.create = async (r) => { const o = atTerminal(r.idempotencyKey, SERIAL, `ORD-${r.idempotencyKey}`); placed.set(o.externalOrderId, o); return o; };
    const setOnline = (v: boolean) => sql(`UPDATE pos_terminals SET online = ${v} WHERE id = '${TERMINAL_A_OFF}'`);
    // Atalho da Edge Function: B já lê a Point desativada.
    {
      setOnline(true);
      const heldA = holdNextList();
      const a = call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r7-atalho', ORDER_R3));
      await heldA.entered;
      setOnline(false);
      expect(await call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r7-atalho', ORDER_R3))).toMatchObject({ status: 409, body: { error: 'terminal_inactive' } });
      setOnline(true);
      heldA.release();
      expect(await a).toMatchObject({ status: 200, body: { status: 'DECLINED' } });
      expect(mp.creates.filter((c) => c.idempotencyKey === 'chave-r7-atalho')).toHaveLength(0);
      expect(sql(`SELECT status || '/' || raw_status FROM terminal_charges WHERE idempotency_key = 'chave-r7-atalho'`)).toBe('cancelled/voided_before_send');
    }
    // TF010: B leu a Point ativa, esperou a conferência, e o banco recusa na reserva porque foi desativada nesse meio tempo.
    {
      setOnline(true);
      const heldA = holdNextList();
      const a = call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r7-tf010', ORDER_R3));
      await heldA.entered;
      const heldB = holdNextList();
      const b = call('Bearer jwt-a', chargeBody(TERMINAL_A_OFF, 'chave-r7-tf010', ORDER_R3));
      await heldB.entered;
      setOnline(false);
      heldB.release();
      expect(await b).toMatchObject({ status: 409, body: { error: 'terminal_inactive' } });
      setOnline(true);
      heldA.release();
      expect(await a).toMatchObject({ status: 200, body: { status: 'DECLINED' } });
      expect(mp.creates.filter((c) => c.idempotencyKey === 'chave-r7-tf010')).toHaveLength(0);
      expect(sql(`SELECT status || '/' || raw_status FROM terminal_charges WHERE idempotency_key = 'chave-r7-tf010'`)).toBe('cancelled/voided_before_send');
    }
    setOnline(false);
  });

  it('Mercado Pago fora do ar na lista: 424 mp_unavailable, e o aviso de falta de internet não aparece com o Supabase respondendo (auditoria #59 r5 P2-01)', async () => {
    // Token desconhecido: listTerminals do Mercado Pago falha, mas o Supabase (a Edge Function) respondeu.
    const r = await call('Bearer jwt-d', { action: 'terminals' });
    expect(r).toMatchObject({ status: 424, body: { error: 'mp_unavailable' } });
    resetCloudReachability();
    await trackCloudReachability(async () => ({ status: r.status }))();
    expect(cloudUnreachable()).toBe(false);
    // Falha real do gateway do Supabase continua acendendo o aviso.
    await trackCloudReachability(async () => ({ status: 502 }))();
    expect(cloudUnreachable()).toBe(true);
    resetCloudReachability();
  });
});
