// supabase/functions/point-charge/index.ts
//
// Cobrança na Point Smart (Mercado Pago) pela nuvem.
//
//   POST /functions/v1/point-charge
//   Authorization: Bearer <JWT do app com o claim tenant_id>
//   { "action": "create", "terminal_id": "<uuid>", "idempotency_key": "...", "order_id": "<uuid>",
//     "amount_cents": 2450, "method": "CREDIT" | "DEBIT", "staff_id": "<uuid>" }
//   { "action": "status", "idempotency_key": "..." }
//   { "action": "cancel", "idempotency_key": "...", "reason": "timeout" | "operator", "staff_id": "<uuid>",
//     "terminal_id", "order_id", "amount_cents", "method" }   (encerra a tentativa; não estorna)
//   Cancel sem cobrança gravada grava o bloqueio da chave: a criação atrasada não chega mais à Point.
//
// Resposta: { status: "PENDING" | "APPROVED" | "DECLINED" | "MANUAL_REVIEW", ... } (ver charge.ts).
// O token do Mercado Pago fica em payment_provider_secrets e só a service role lê; o aparelho nunca o vê.
// A loja é provada pelo RLS com o JWT do chamador (a maquininha ou a cobrança só aparecem se forem dele).
//
// Variáveis: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (já injetadas pelo Supabase).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { MercadoPagoPointProvider } from '../../../server/payments/mercadoPagoPoint.ts';
import { ChargeInputError, cancelCharge, pollCharge, startCharge, validKey, validateCancel, voidCharge, type ChargeContext } from './charge.ts';
import { createMercadoPagoPayments } from './mpPayments.ts';
import { supabaseChargeStore } from './repository.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
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
  if (action !== 'create' && action !== 'status' && action !== 'cancel') return json({ error: 'action', message: 'Ação inválida.' }, 400);
  if (!validKey(body.idempotency_key)) return json({ error: 'invalid_key', message: 'Chave da cobrança inválida.' }, 400);
  const key = body.idempotency_key;

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // 1) Prova de loja pelo RLS.
  let tenantId: string;
  let terminal: { id: string; tenant_id: string; serial_number: string; acquirer: string } | null = null;
  const loadTerminal = async (): Promise<Response | null> => {
    if (typeof body.terminal_id !== 'string' || !UUID.test(body.terminal_id)) return json({ error: 'invalid_terminal', message: 'Maquininha inválida.' }, 400);
    const { data, error } = await asCaller.from('pos_terminals').select('id, tenant_id, serial_number, acquirer').eq('id', body.terminal_id).maybeSingle();
    if (error) return json({ error: 'auth', message: 'Não foi possível validar a sessão.' }, 401);
    if (!data) return json({ error: 'not_found', message: 'Maquininha não encontrada nesta loja.' }, 404);
    terminal = data;
    return null;
  };
  if (action === 'cancel') {
    try {
      validateCancel(body as { reason: unknown; staff_id: unknown });
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
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const secret = await admin.from('payment_provider_secrets').select('access_token').eq('tenant_id', tenantId).eq('provider', 'mercado_pago_point').maybeSingle();
  if (secret.error) return json({ error: 'internal', message: 'Falha ao ler a configuração do Mercado Pago.' }, 500);
  const accessToken = secret.data?.access_token as string | undefined;
  if (!accessToken) return json({ error: 'not_configured', message: 'Mercado Pago sem Access Token nesta loja.' }, 412);

  // Quem encerra precisa ser da equipe ativa desta loja (fica gravado na cobrança).
  if (action === 'cancel') {
    const staff = await admin.from('staff_users').select('id').eq('id', body.staff_id).eq('tenant_id', tenantId).eq('active', true).maybeSingle();
    if (staff.error) return json({ error: 'internal', message: 'Falha ao conferir o operador.' }, 500);
    if (!staff.data) return json({ error: 'invalid_staff', message: 'Operador não é da equipe ativa desta loja.' }, 403);
  }

  const ctx: ChargeContext = {
    store: supabaseChargeStore(admin, tenantId),
    provider: new MercadoPagoPointProvider({ accessToken, fetchImpl: (input, init) => fetch(input, init) }),
    payments: createMercadoPagoPayments({ accessToken, fetchImpl: (input, init) => fetch(input, init) }),
  };
  try {
    if (action === 'create') return json(await startCharge(ctx, terminal!, body), 200);
    const row = await ctx.store.findByKey(key);
    if (action === 'cancel') {
      const input = body as { idempotency_key: unknown; order_id: unknown; amount_cents: unknown; method: unknown; reason: unknown; staff_id: unknown };
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
});
