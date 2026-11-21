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
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PaymentTerminalProvider } from '../../server/shared/paymentTerminal';
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
const tokensUsed: string[] = [];

function provider(token: string): PaymentTerminalProvider {
  tokensUsed.push(token);
  const list = MP_ACCOUNTS[token];
  return {
    key: 'mercado_pago_point', createRetryPolicy: 'same_key', approvalIdentity: 'reference_and_terminal', supportedMethods: ['credit', 'debit', 'pix'],
    listTerminals: async () => {
      if (!list) throw new Error('token desconhecido');
      return list.map((id) => ({ provider: 'mercado_pago_point' as const, externalTerminalId: id, operatingMode: 'pdv' as const, externalStoreId: null, externalPosId: null }));
    },
    createCharge: async () => { throw new Error('não deveria criar'); },
    getCharge: async () => { throw new Error('não deveria consultar'); },
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
           ('${TERMINAL_A_OFF}', '${A}', 'Point desativada', 'NEWLAND_N950__CONTA_A_2', 'MERCADO_PAGO', 'TEF_POS_WIRELESS', false);`);
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
    expect(sql(`SELECT count(*) FROM terminal_charges`)).toBe('0');
  });

  it('Point desativada no banco (online=false) está na conta e no PDV do Mercado Pago, mas cobrança nova é recusada sem gravar nada (auditoria #59 r5 P1-01)', async () => {
    const body = {
      action: 'create', terminal_id: TERMINAL_A_OFF, idempotency_key: 'chave-off-1', order_id: '6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f', amount_cents: 1000, expected_balance_cents: 1000, method: 'CREDIT', staff_id: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
    };
    // A lista do Mercado Pago mostra a Point (CONTA_A_2 está na conta A, no PDV): só o online=false do banco barra.
    expect((await call('Bearer jwt-a', { action: 'terminals' })).body.terminals).toContainEqual({ id: 'NEWLAND_N950__CONTA_A_2', operating_mode: 'pdv' });
    expect(await call('Bearer jwt-a', body)).toMatchObject({ status: 409, body: { error: 'terminal_inactive' } });
    expect(sql(`SELECT count(*) FROM terminal_charges`)).toBe('0');
    // Religada no banco, a mesma chamada passa da verificação (e só então esbarra no teste, que não cria cobrança).
    sql(`UPDATE pos_terminals SET online = true WHERE id = '${TERMINAL_A_OFF}'`);
    const on = await call('Bearer jwt-a', body);
    expect(on.body.error).not.toBe('terminal_inactive');
    sql(`UPDATE pos_terminals SET online = false WHERE id = '${TERMINAL_A_OFF}'`);
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
