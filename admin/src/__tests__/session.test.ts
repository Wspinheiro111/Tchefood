import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, hostOf, refreshSession, signOut, type FetchLike, type Session } from '../lib/api';
import { loadSession, pickConfig, saveSession, sessionClient } from '../lib/session';

const CFG = { url: 'https://x.supabase.co', anonKey: 'anon-key' };

/** sessionStorage de mentira (o projeto admin roda os testes em node). */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

type Resp = { status: number; body: unknown } | 'network';
interface Pending {
  url: string;
  headers: Record<string, string>;
  resolve: (r: Resp) => void;
}

/** fetch controlado: cada chamada fica pendente até o teste responder. */
function manualFetch() {
  const calls: Pending[] = [];
  const fetch: FetchLike = (url, init) =>
    new Promise((ok, fail) => {
      calls.push({
        url,
        headers: init.headers,
        resolve: (r) => {
          if (r === 'network') return fail(new TypeError('Failed to fetch'));
          ok({ ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) });
        },
      });
    });
  return { fetch, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const tokenCalls = (calls: Pending[]) => calls.filter((c) => c.url.includes('/auth/v1/token'));
const nearExpiry = (): Session => ({ accessToken: 'velho', refreshToken: 'r1', expiresAt: Date.now() + 30_000, email: 'will@x.com' });
const NEW_TOKEN = { status: 200, body: { access_token: 'novo', refresh_token: 'r2', expires_in: 3600 } };

beforeEach(() => {
  vi.stubGlobal('sessionStorage', fakeStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessão do painel', () => {
  it('duas chamadas perto do vencimento: uma renovação só, as duas usam o token novo', async () => {
    const f = manualFetch();
    const expired = vi.fn();
    const c = sessionClient(CFG, nearExpiry(), expired, f.fetch);
    const a = c.me();
    const b = c.plans();
    await flush();
    expect(tokenCalls(f.calls)).toHaveLength(1);
    tokenCalls(f.calls)[0]!.resolve(NEW_TOKEN);
    await flush();
    const rpcs = f.calls.filter((x) => x.url.includes('/rest/v1/rpc/'));
    expect(rpcs).toHaveLength(2);
    expect(rpcs.every((x) => x.headers.Authorization === 'Bearer novo')).toBe(true);
    rpcs.forEach((x) => x.resolve({ status: 200, body: [] }));
    await Promise.all([a, b]);
    expect(loadSession()?.refreshToken).toBe('r2');
    expect(expired).not.toHaveBeenCalled();
  });

  it('401 na renovação encerra a sessão', async () => {
    const f = manualFetch();
    const expired = vi.fn();
    saveSession(nearExpiry());
    const c = sessionClient(CFG, nearExpiry(), expired, f.fetch);
    const a = c.me();
    await flush();
    tokenCalls(f.calls)[0]!.resolve({ status: 400, body: { error: 'invalid_grant' } });
    await expect(a).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(loadSession()).toBeNull();
  });

  it('queda de rede ou 503 na renovação mantém a sessão (erro que dá para repetir)', async () => {
    const f = manualFetch();
    const expired = vi.fn();
    saveSession(nearExpiry());
    const c = sessionClient(CFG, nearExpiry(), expired, f.fetch);
    const a = c.me();
    await flush();
    tokenCalls(f.calls)[0]!.resolve('network');
    await expect(a).rejects.toMatchObject({ status: 0 });
    const b = c.me();
    await flush();
    tokenCalls(f.calls)[1]!.resolve({ status: 503, body: null });
    await expect(b).rejects.toMatchObject({ status: 503 });
    expect(expired).not.toHaveBeenCalled();
    expect(loadSession()?.refreshToken).toBe('r1');
    // Depois volta: a próxima chamada renova e segue.
    const d = c.me();
    await flush();
    tokenCalls(f.calls)[2]!.resolve(NEW_TOKEN);
    await flush();
    f.calls.at(-1)!.resolve({ status: 200, body: { user_id: 'u' } });
    await expect(d).resolves.toEqual({ user_id: 'u' });
  });

  it('sair durante a renovação: a resposta que chega depois não devolve a sessão', async () => {
    const f = manualFetch();
    const expired = vi.fn();
    saveSession(nearExpiry());
    const c = sessionClient(CFG, nearExpiry(), expired, f.fetch);
    const a = c.me().catch((e: unknown) => e);
    await flush();
    const logout = c.logout();
    await flush();
    const out = f.calls.find((x) => x.url.endsWith('/auth/v1/logout'))!;
    expect(out.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer velho' });
    out.resolve({ status: 204, body: null });
    await logout;
    tokenCalls(f.calls)[0]!.resolve(NEW_TOKEN);
    expect(await a).toBeInstanceOf(AdminApiError);
    expect(loadSession()).toBeNull();
    expect(expired).not.toHaveBeenCalled();
    expect(f.calls.filter((x) => x.url.includes('/rest/v1/rpc/'))).toHaveLength(0);
  });

  it('dispose: 401 de renovação que chega depois não chama onExpired', async () => {
    const f = manualFetch();
    const expired = vi.fn();
    const c = sessionClient(CFG, nearExpiry(), expired, f.fetch);
    const a = c.me().catch((e: unknown) => e);
    await flush();
    c.dispose();
    tokenCalls(f.calls)[0]!.resolve({ status: 401, body: null });
    await a;
    expect(expired).not.toHaveBeenCalled();
  });

  it('refreshSession separa 400/401 (sai) de rede, 429 e 5xx (repete)', async () => {
    const s = nearExpiry();
    const resp = (status: number): FetchLike => async () => ({ ok: status < 300, status, text: async () => '' });
    await expect(refreshSession(CFG, s, resp(401))).rejects.toMatchObject({ status: 401 });
    await expect(refreshSession(CFG, s, resp(400))).rejects.toMatchObject({ status: 401 });
    await expect(refreshSession(CFG, s, resp(429))).rejects.toMatchObject({ status: 503 });
    await expect(refreshSession(CFG, s, resp(502))).rejects.toMatchObject({ status: 503 });
    await expect(refreshSession(CFG, s, resp(200))).rejects.toMatchObject({ status: 503 }); // corpo inválido
    await expect(refreshSession(CFG, s, async () => Promise.reject(new TypeError('x')))).rejects.toMatchObject({ status: 0 });
  });

  it('signOut ignora falha; config do build vence a guardada; host da senha', async () => {
    await expect(signOut(CFG, 't', async () => Promise.reject(new TypeError('x')))).resolves.toBeUndefined();
    expect(pickConfig({ url: 'https://outro.supabase.co', anonKey: 'k2' }, { url: 'https://build.supabase.co', anonKey: 'k1' })).toEqual({
      url: 'https://build.supabase.co',
      anonKey: 'k1',
    });
    expect(pickConfig({ url: 'https://outro.supabase.co', anonKey: 'k2' }, {})).toEqual({ url: 'https://outro.supabase.co', anonKey: 'k2' });
    expect(pickConfig(null, {})).toEqual({ url: '', anonKey: '' });
    expect(hostOf('https://abc.supabase.co/')).toBe('abc.supabase.co');
    expect(hostOf('')).toBe('');
    expect(hostOf('nada')).toBe('');
  });
});
