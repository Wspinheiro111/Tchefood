import { AdminApiError, createAdminClient, refreshSession, type AdminClient, type AdminConfig, type FetchLike, type Session } from './api';

/** Endereço e chave pública do Supabase: do build ou digitados na tela de entrada. */
const CONFIG_KEY = 'tchefood-admin-config';
/** Sessão só nesta aba (fecha a aba, sai). */
const SESSION_KEY = 'tchefood-admin-session';

export const browserFetch: FetchLike = (url, init) => fetch(url, init);

function read<T>(storage: () => Storage, key: string): T | null {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: unknown): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(value));
  } catch {
    /* navegador sem armazenamento: segue só na memória */
  }
}

export function loadConfig(): AdminConfig {
  const saved = read<AdminConfig>(() => localStorage, CONFIG_KEY);
  return {
    url: saved?.url || import.meta.env.VITE_SUPABASE_URL || '',
    anonKey: saved?.anonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  };
}

export function saveConfig(cfg: AdminConfig): void {
  write(() => localStorage, CONFIG_KEY, cfg);
}

export function loadSession(): Session | null {
  return read<Session>(() => sessionStorage, SESSION_KEY);
}

export function saveSession(s: Session | null): void {
  write(() => sessionStorage, SESSION_KEY, s);
}

/**
 * Cliente com renovação do token: um minuto antes de vencer, troca pelo refresh token.
 * Falha na renovação chama onExpired (a tela volta para a entrada).
 */
export function sessionClient(cfg: AdminConfig, initial: Session, onExpired: () => void, fetchFn: FetchLike = browserFetch): AdminClient {
  let session = initial;
  let pending: Promise<Session> | null = null;
  const getToken = async () => {
    if (session.expiresAt - Date.now() > 60_000) return session.accessToken;
    pending ??= refreshSession(cfg, session, fetchFn).finally(() => {
      pending = null;
    });
    try {
      session = await pending;
      saveSession(session);
      return session.accessToken;
    } catch (e) {
      saveSession(null);
      onExpired();
      throw e instanceof AdminApiError ? e : new AdminApiError('Sessão expirada. Entre de novo.', 401);
    }
  };
  const client = createAdminClient(cfg, getToken, fetchFn);
  // 401 em qualquer chamada: sessão encerrada no servidor.
  return new Proxy(client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (e) {
          if (e instanceof AdminApiError && e.status === 401) {
            saveSession(null);
            onExpired();
          }
          throw e;
        }
      };
    },
  });
}
