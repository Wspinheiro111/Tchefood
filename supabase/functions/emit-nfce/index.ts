// supabase/functions/emit-nfce/index.ts
//
// Emissão real de NFC-e (modelo 65, SEFAZ-RS) pela Focus NFe.
//
//   POST /functions/v1/emit-nfce
//   Authorization: Bearer <JWT do app com o claim tenant_id>
//   { "order_id": "<uuid da comanda fechada>" }
//
// O corpo só traz o order_id. Itens, valores, pagamentos e o token Focus são lidos do banco
// pelo servidor: o cliente não consegue mudar o valor da nota nem ver o token.
//
// Variáveis (supabase secrets set ...):
//   FOCUS_AMBIENTE  "producao" liga produção; qualquer outro valor (ou ausente) = homologação.
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (já injetadas pelo Supabase).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { emitNfce } from './emit.ts';
import { createFocusClient, focusEnvironment } from './focus.ts';
import { supabaseNfceRepository } from './repository.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ authorized: false, message: 'Use POST.' }, 405);

  const environment = focusEnvironment(Deno.env.get('FOCUS_AMBIENTE'));
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+$/.test(authHeader)) return json({ authorized: false, message: 'Sessão ausente.' }, 401);

  let orderId: unknown;
  try {
    orderId = (await req.json())?.order_id;
  } catch {
    return json({ authorized: false, message: 'JSON inválido.' }, 400);
  }
  if (typeof orderId !== 'string' || !UUID.test(orderId)) return json({ authorized: false, message: 'order_id inválido.' }, 400);

  const url = Deno.env.get('SUPABASE_URL')!;
  // 1) Prova de tenant pelo RLS: com o JWT do chamador, a comanda só aparece se for do tenant dele.
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: owned, error: ownedError } = await asCaller.from('orders').select('id, tenant_id').eq('id', orderId).maybeSingle();
  if (ownedError) return json({ authorized: false, message: 'Não foi possível validar a sessão.' }, 401);
  if (!owned) return json({ authorized: false, status: 'not_found', message: 'Comanda não encontrada para este estabelecimento.' }, 404);

  // 2) Daqui em diante, service role filtrado pelo tenant provado acima.
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  try {
    const result = await emitNfce(
      {
        repo: supabaseNfceRepository(admin),
        environment,
        focus: (token) => createFocusClient({ environment, token, fetch: (input, init) => fetch(input, init) }),
        sha256Hex,
      },
      { tenantId: owned.tenant_id, orderId },
    );
    return json(result.body, result.httpStatus);
  } catch (error) {
    // Erro interno depois da reserva deixa o documento em "processing": a próxima chamada só consulta.
    console.error('[emit-nfce]', error instanceof Error ? error.message : error);
    return json(
      { authorized: false, status: 'error', environment, message: 'Falha interna na emissão. A NFC-e NÃO está autorizada; chame de novo para consultar o status antes de qualquer reenvio.' },
      500,
    );
  }
});
