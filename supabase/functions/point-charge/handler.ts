/**
 * O tratamento das chamadas da Edge Function point-charge (contrato no topo de index.ts), sem Deno e sem supabase-js:
 * index.ts só liga o Deno.serve às dependências de verdade, e os testes chamam este mesmo código com o banco de verdade
 * (cliente do chamador com RLS, service role) e um Mercado Pago falso.
 */
import type { PaymentTerminalProvider } from '../../../server/shared/paymentTerminal.ts';
import { ChargeInputError, cancelCharge, pollCharge, reconcileCharge, refundCharge, startCharge, validKey, validateCancel, validateReconcile, voidCharge, type ChargeContext, type CreateInput, type PaymentDetailsSource } from './charge.ts';
import { supabaseChargeStore, type SupabaseLike } from './repository.ts';
import { listStoreTerminals } from './terminals.ts';

export interface PointChargeDeps {
  /** Cliente com o JWT do chamador: só enxerga o que o RLS deixa (a loja dele). */
  callerDb(authHeader: string): SupabaseLike;
  /** Service role: só usado filtrado pela loja já provada pelo cliente do chamador. */
  adminDb(): SupabaseLike;
  provider(accessToken: string): PaymentTerminalProvider;
  payments(accessToken: string): PaymentDetailsSource;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handlePointCharge(req: Request, deps: PointChargeDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method', message: 'Use POST.' }, 405);
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+$/.test(authHeader)) return json({ error: 'auth', message: 'Sessão ausente.' }, 401);

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'json', message: 'JSON inválido.' }, 400);
  }
  const action = body.action;
  if (action !== 'create' && action !== 'status' && action !== 'cancel' && action !== 'reconcile' && action !== 'refund' && action !== 'terminals') return json({ error: 'action', message: 'Ação inválida.' }, 400);

  const asCaller = deps.callerDb(authHeader);

  if (action === 'terminals') {
    // Só leitura, sem cobrança: a loja é a linha de tenants que o RLS deixa o chamador ler (a dele).
    const { data, error } = await asCaller.from('tenants').select('id').maybeSingle();
    if (error || !data) return json({ error: 'auth', message: 'Não foi possível validar a sessão.' }, 401);
    const admin = deps.adminDb();
    const secret = await admin.from('payment_provider_secrets').select('access_token').eq('tenant_id', data.id).eq('provider', 'mercado_pago_point').maybeSingle();
    if (secret.error) return json({ error: 'internal', message: 'Falha ao ler a configuração do Mercado Pago.' }, 500);
    const accessToken = secret.data?.access_token as string | undefined;
    if (!accessToken) return json({ error: 'not_configured', message: 'Mercado Pago sem Access Token nesta loja.' }, 412);
    try {
      return json(await listStoreTerminals(deps.provider(accessToken)), 200);
    } catch (error) {
      console.error('[point-charge] terminals', error instanceof Error ? error.message : error);
      return json({ error: 'mp_unavailable', message: 'O Mercado Pago não devolveu a lista de maquininhas. Tente de novo.' }, 424);
    }
  }

  if (!validKey(body.idempotency_key)) return json({ error: 'invalid_key', message: 'Chave da cobrança inválida.' }, 400);
  const key = body.idempotency_key;

  // 1) Prova de loja pelo RLS.
  let tenantId: string;
  let terminal: { id: string; tenant_id: string; serial_number: string; acquirer: string; online: boolean } | null = null;
  const loadTerminal = async (): Promise<Response | null> => {
    if (typeof body.terminal_id !== 'string' || !UUID.test(body.terminal_id)) return json({ error: 'invalid_terminal', message: 'Maquininha inválida.' }, 400);
    const { data, error } = await asCaller.from('pos_terminals').select('id, tenant_id, serial_number, acquirer, online').eq('id', body.terminal_id).maybeSingle();
    if (error) return json({ error: 'auth', message: 'Não foi possível validar a sessão.' }, 401);
    if (!data) return json({ error: 'not_found', message: 'Maquininha não encontrada nesta loja.' }, 404);
    terminal = data;
    return null;
  };
  if (action === 'cancel') {
    try {
      validateCancel(body as { reason: unknown });
    } catch (error) {
      if (error instanceof ChargeInputError) return json({ error: error.code, message: error.message }, error.httpStatus);
      throw error;
    }
  }
  if (action === 'reconcile' || action === 'refund') {
    try {
      validateReconcile(body as { idempotency_key: unknown }, { ignoreOperation: action === 'refund' });
    } catch (error) {
      if (error instanceof ChargeInputError) return json({ error: error.code, message: error.message }, error.httpStatus);
      throw error;
    }
  }
  if (action === 'create') {
    const refused = await loadTerminal();
    if (refused) return refused;
    tenantId = terminal!.tenant_id;
  } else {
    const { data, error } = await asCaller.from('terminal_charges').select('tenant_id').eq('idempotency_key', key).maybeSingle();
    if (error) return json({ error: 'auth', message: 'Não foi possível validar a sessão.' }, 401);
    if (data) tenantId = data.tenant_id;
    else if (action === 'cancel') {
      // Sem cobrança gravada: a loja vem da maquininha, e o encerramento grava o bloqueio da chave.
      const refused = await loadTerminal();
      if (refused) return refused;
      tenantId = terminal!.tenant_id;
    } else return json({ error: 'not_found', message: 'Cobrança não encontrada nesta loja.' }, 404);
  }

  // 2) Daqui em diante, service role filtrado pela loja provada acima.
  const admin = deps.adminDb();
  const secret = await admin.from('payment_provider_secrets').select('access_token').eq('tenant_id', tenantId).eq('provider', 'mercado_pago_point').maybeSingle();
  if (secret.error) return json({ error: 'internal', message: 'Falha ao ler a configuração do Mercado Pago.' }, 500);
  const accessToken = secret.data?.access_token as string | undefined;
  if (!accessToken) return json({ error: 'not_configured', message: 'Mercado Pago sem Access Token nesta loja.' }, 412);

  const ctx: ChargeContext = {
    store: supabaseChargeStore(admin, tenantId),
    provider: deps.provider(accessToken),
    payments: deps.payments(accessToken),
  };
  try {
    if (action === 'create') return json(await startCharge(ctx, terminal!, body as unknown as CreateInput), 200);
    if (action === 'reconcile') return json(await reconcileCharge(ctx, body as { idempotency_key: unknown }), 200);
    if (action === 'refund') return json(await refundCharge(ctx, body as { idempotency_key: unknown }), 200);
    const row = await ctx.store.findByKey(key);
    if (action === 'cancel') {
      const input = body as { idempotency_key: unknown; order_id: unknown; amount_cents: unknown; method: unknown; reason: unknown; staff_id?: unknown; manager_pin?: unknown; reason_text?: unknown };
      if (row) return json(await cancelCharge(ctx, row, input), 200);
      if (!terminal) {
        const refused = await loadTerminal();
        if (refused) return refused;
      }
      return json(await voidCharge(ctx, terminal!, input), 200);
    }
    if (!row) return json({ error: 'not_found', message: 'Cobrança não encontrada nesta loja.' }, 404);
    return json(await pollCharge(ctx, row), 200);
  } catch (error) {
    if (error instanceof ChargeInputError) return json({ error: error.code, message: error.message }, error.httpStatus);
    console.error('[point-charge]', error instanceof Error ? error.message : error);
    // Falha interna: a cobrança pode ter ido à maquininha. O aparelho consulta de novo antes de qualquer outra.
    return json({ error: 'internal', message: 'Falha interna. Consulte a cobrança de novo antes de cobrar outra vez.' }, 500);
  }
}
