// supabase/functions/admin-device-account/index.ts
//
// Conta do aparelho da loja (painel administrativo, pasta admin/).
//
//   POST /functions/v1/admin-device-account
//   Authorization: Bearer <token do admin do painel (conta sem loja)>
//   { "tenant_id": "<uuid>", "action": "create" | "reset_password", "email"?: "<e-mail da conta>" }
//
// Resposta 200: { user_id, email, password } (a senha aparece uma vez só). A regra está em
// handler.ts. Variáveis: SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY (já
// injetadas pelo Supabase).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handleDeviceAccount, randomPasswordFrom } from './handler.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ message: 'Use POST.' }, 405);
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+$/.test(authHeader)) return json({ message: 'Sessão ausente.' }, 401);

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ message: 'JSON inválido.' }, 400);
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  try {
    const result = await handleDeviceAccount(input, {
      rpc: async (fn, args) => {
        const { data, error } = await asCaller.rpc(fn, args);
        return { data, error: error ? { message: error.message, code: error.code } : null };
      },
      auth: {
        getUserById: async (id) => {
          const { data, error } = await service.auth.admin.getUserById(id);
          return { user: data?.user ?? null, error: error ? { message: error.message, status: error.status } : null };
        },
        createUser: async (attrs) => {
          const { error } = await service.auth.admin.createUser(attrs);
          return { error: error ? { message: error.message } : null };
        },
        updateUserById: async (id, attrs) => {
          const { error } = await service.auth.admin.updateUserById(id, attrs);
          return { error: error ? { message: error.message } : null };
        },
      },
      randomPassword: () => randomPasswordFrom((a) => crypto.getRandomValues(a)),
    });
    return json(result.body, result.status);
  } catch (error) {
    console.error('[admin-device-account]', error instanceof Error ? error.message : error);
    return json({ message: 'Falha interna. Nada foi confirmado; tente de novo.' }, 500);
  }
});
