import { describe, expect, it } from 'vitest';
import { AdminApiError, cleanError, createAdminClient, refreshSession, signIn, type FetchLike } from '../lib/api';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(responses: Array<{ status: number; body: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const r = responses.shift() ?? { status: 500, body: null };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === null ? '' : JSON.stringify(r.body)) };
    },
  };
}

const CFG = { url: 'https://x.supabase.co/', anonKey: 'anon-key' };

describe('cliente do painel', () => {
  it('login por senha guarda o vencimento do token; erro 400 vira mensagem de senha', async () => {
    const ok = fakeFetch([{ status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }]);
    const s = await signIn(CFG, ' Will@X.com ', 'pw', ok.fetch, 1000);
    expect(s).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 1000 + 3_600_000, email: 'will@x.com' });
    expect(ok.calls[0]!.url).toBe('https://x.supabase.co/auth/v1/token?grant_type=password');
    expect(ok.calls[0]!.headers.apikey).toBe('anon-key');
    expect(ok.calls[0]!.body).toEqual({ email: 'Will@X.com', password: 'pw' });

    const bad = fakeFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid login credentials' } }]);
    await expect(signIn(CFG, 'a@b.com', 'x', bad.fetch)).rejects.toThrow('E-mail ou senha incorretos.');

    const ref = fakeFetch([{ status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 60 } }]);
    expect(await refreshSession(CFG, s, ref.fetch, 5)).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', expiresAt: 60_005 });
    expect(ref.calls[0]!.body).toEqual({ refresh_token: 'r' });
  });

  it('RPC com o token, argumentos nomeados e vazio como null; erro do banco sem o prefixo', async () => {
    const f = fakeFetch([
      { status: 200, body: 'id-novo' },
      { status: 400, body: { code: 'P0001', message: 'TCHEFOOD_ADMIN: já existe cobrança deste mês para a loja' } },
      { status: 403, body: { code: '42501', message: 'TCHEFOOD_ADMIN: acesso restrito à equipe do Tchê Food' } },
      { status: 200, body: { user_id: 'u', email: 'e', password: 'p' } },
    ]);
    const c = createAdminClient(CFG, async () => 'tok', f.fetch);
    expect(await c.createCharge('t', '2026-11-01', '  ', null, '')).toBe('id-novo');
    expect(f.calls[0]!.url).toBe('https://x.supabase.co/rest/v1/rpc/tchefood_admin_create_charge');
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(f.calls[0]!.body).toEqual({ p_tenant: 't', p_reference_month: '2026-11-01', p_amount: null, p_due_date: null, p_payment_link: null });

    const e1 = await c.createCharge('t', '2026-11-01', null, null, null).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AdminApiError);
    expect((e1 as AdminApiError).message).toBe('já existe cobrança deste mês para a loja');
    const e2 = (await c.me().catch((e: unknown) => e)) as AdminApiError;
    expect(e2.status).toBe(403);

    await c.deviceAccount('t', 'create', 'loja@x.com');
    expect(f.calls[3]!.url).toBe('https://x.supabase.co/functions/v1/admin-device-account');
    expect(f.calls[3]!.body).toEqual({ tenant_id: 't', action: 'create', email: 'loja@x.com' });
    expect(cleanError('TCHEFOOD_ADMIN:  x ')).toBe('x');
  });
});
