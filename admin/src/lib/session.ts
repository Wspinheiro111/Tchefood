import { AdminApiError, createAdminClient, refreshSession, signOut, type AdminClient, type AdminConfig, type FetchLike, type Session } from './api';

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

/**
 * Endereço e chave do build (VITE_SUPABASE_URL/ANON_KEY) valem mais que os guardados no
 * navegador: um valor antigo no localStorage não desvia a senha para outro projeto.
 */
export function pickConfig(saved: Partial<AdminConfig> | null, env: { url?: string; anonKey?: string }): AdminConfig {
  return {
    url: env.url || saved?.url || '',
    anonKey: env.anonKey || saved?.anonKey || '',
  };
}

export function loadConfig(): AdminConfig {
  return pickConfig(read<AdminConfig>(() => localStorage, CONFIG_KEY), {
    url: import.meta.env.VITE_SUPABASE_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  });
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

export interface SessionClient extends AdminClient {
  /** Para de usar a sessão: renovação em andamento não grava nada nem chama onExpired. */
  dispose(): void;
  /** Sai: dispose, avisa o servidor (melhor esforço) e apaga a sessão desta aba. */
  logout(): Promise<void>;
}

const OWN = new Set<PropertyKey>(['dispose', 'logout']);

/**
 * Cliente com renovação do token: um minuto antes de vencer, troca pelo refresh token (uma
 * renovação por vez, compartilhada pelas chamadas que chegam juntas). Só um 401 encerra a
 * sessão e chama onExpired (a tela volta para a entrada); queda de rede ou servidor fora do
 * ar na renovação mantém a sessão e a chamada falha com erro que dá para repetir.
 */
export function sessionClient(cfg: AdminConfig, initial: Session, onExpired: () => void, fetchFn: FetchLike = browserFetch): SessionClient {
  let session = initial;
  let pending: Promise<Session> | null = null;
  let disposed = false;
  const closed = () => new AdminApiError('Sessão encerrada. Entre de novo.', 401);
  const expire = () => {
    if (disposed) return;
    disposed = true;
    saveSession(null);
    onExpired();
  };
  const getToken = async () => {
    if (disposed) throw closed();
    if (session.expiresAt - Date.now() > 60_000) return session.accessToken;
    pending ??= refreshSession(cfg, session, fetchFn)
      .then((s) => {
        // Saiu enquanto renovava: não volta a gravar a sessão.
        if (disposed) throw closed();
        session = s;
        saveSession(s);
        return s;
      })
      .catch((e: unknown) => {
        if (e instanceof AdminApiError && e.status === 401) expire();
        throw e instanceof AdminApiError ? e : new AdminApiError('Não foi possível renovar a sessão. Tente de novo.', 503);
      })
      .finally(() => {
        pending = null;
      });
    return (await pending).accessToken;
  };
  const client = createAdminClient(cfg, getToken, fetchFn);
  const own: Pick<SessionClient, 'dispose' | 'logout'> = {
    dispose: () => {
      disposed = true;
    },
    logout: async () => {
      disposed = true;
      saveSession(null);
      await signOut(cfg, session.accessToken, fetchFn);
    },
  };
  // 401 em qualquer chamada: sessão encerrada no servidor.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (OWN.has(prop)) return own[prop as keyof typeof own];
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (e) {
          if (e instanceof AdminApiError && e.status === 401) expire();
          throw e;
        }
      };
    },
  }) as SessionClient;
}
