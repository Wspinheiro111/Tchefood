/**
 * Emulador mínimo do PostgREST do Supabase sobre um Postgres local (psql), para
 * testar a fila do aparelho contra o banco de verdade: as mesmas requisições que
 * flushOutbox() monta viram o SQL que o PostgREST rodaria, como o papel
 * `authenticated` e com a claim tenant_id no request.jwt.claims (RLS ligado).
 *
 * Cobre o que a sincronização usa:
 *  - POST /rest/v1/<tabela>?on_conflict=<cols> com Prefer resolution=merge|ignore-duplicates
 *  - PATCH /rest/v1/<tabela>?id=eq.<id>
 *  - DELETE /rest/v1/<tabela>?<col>=eq.<v>&...
 *  - POST /rest/v1/rpc/<função> com argumentos nomeados
 * Coluna que não existe na tabela é recusada (PGRST204), como no PostgREST.
 * Cada requisição é uma transação; os gatilhos DEFERRABLE rodam no fim dela.
 */
import { execFileSync } from 'node:child_process';
import type { FetchLike } from '../../src/lib/sync/supabaseSync';

export interface PgTarget {
  host: string;
  port: string;
  user: string;
  db: string;
}

export function pgTargetFromEnv(): PgTarget | null {
  const raw = process.env.TCHEFOOD_PG;
  if (!raw) return null;
  // Formato: host:port:user (ex.: /var/tmp/tfpg:5499:postgres)
  const [host, port, user] = raw.split(':');
  if (!host || !port || !user) return null;
  return { host, port, user, db: 'postgres' };
}

export interface PsqlResult {
  ok: boolean;
  out: string;
  sqlstate: string | null;
  message: string | null;
}

export function psql(t: PgTarget, sql: string, db = t.db): PsqlResult {
  try {
    const out = execFileSync('psql', ['-h', t.host, '-p', t.port, '-U', t.user, '-d', db, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim(), sqlstate: null, message: null };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    const stderr = err.stderr ?? '';
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
    return { ok: false, out: (err.stdout ?? '').trim(), sqlstate: m?.[1] ?? null, message: m?.[2] ?? stderr.trim() };
  }
}

export function psqlFile(t: PgTarget, file: string, db: string): void {
  execFileSync('psql', ['-h', t.host, '-p', t.port, '-U', t.user, '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Banco novo com os papéis e privilégios padrão do Supabase. */
export function createSupabaseLikeDb(t: PgTarget, db: string): void {
  const admin = { ...t, db: 'postgres' };
  const r1 = psql(admin, `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
  if (!r1.ok) throw new Error(r1.message ?? 'drop');
  const r2 = psql(admin, `CREATE DATABASE ${db};`);
  if (!r2.ok) throw new Error(r2.message ?? 'create');
  const r = psql(
    { ...t, db },
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
     END $$;
     GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`,
    db,
  );
  if (!r.ok) throw new Error(r.message ?? 'roles');
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador inválido: ${s}`);
  return `"${s}"`;
};

function statusFor(sqlstate: string | null): number {
  if (!sqlstate) return 400;
  if (sqlstate === '42501') return 403;
  if (sqlstate === '23505' || sqlstate === '23503') return 409;
  if (sqlstate === '42883' || sqlstate === '42P01') return 404;
  return 400;
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

export interface EmulatorLog {
  method: string;
  path: string;
  status: number;
  message?: string;
}

/**
 * fetch() falso que responde como o PostgREST. `claims` vira request.jwt.claims.
 */
export function postgrestFetch(t: PgTarget, db: string, claims: Record<string, unknown>, log: EmulatorLog[] = []): FetchLike {
  const columnsCache = new Map<string, string[]>();
  const columns = (table: string): string[] => {
    const hit = columnsCache.get(table);
    if (hit) return hit;
    const r = psql(t, `SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_schema='public' AND table_name=${lit(table)};`, db);
    const cols = r.out ? r.out.split(',') : [];
    columnsCache.set(table, cols);
    return cols;
  };
  const run = (stmt: string) =>
    psql(
      t,
      `BEGIN;
       SET LOCAL ROLE authenticated;
       SELECT set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null
       ${stmt}
       COMMIT;`,
      db,
    );

  return async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/rest\/v1\//, '');
    const done = (status: number, body?: unknown, message?: string) => {
      log.push({ method: init.method, path, status, message });
      return json(status, body);
    };
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (path.startsWith('rpc/')) {
      const fn = path.slice(4);
      const sig = psql(
        t,
        `SELECT array_to_string(p.proargnames, ',') || '|' || array_to_string(ARRAY(SELECT format_type(x, NULL) FROM unnest(p.proargtypes) x), ',')
           FROM pg_proc p WHERE p.proname = ${lit(fn)} AND p.pronamespace = 'public'::regnamespace;`,
        db,
      );
      if (!sig.ok || !sig.out) return done(404, { message: `Could not find the function public.${fn}` }, 'função não existe');
      const [namesRaw, typesRaw] = sig.out.split('|');
      const names = (namesRaw ?? '').split(',');
      const types = (typesRaw ?? '').split(',');
      const unknown = Object.keys(body).filter((k) => !names.includes(k));
      if (unknown.length) return done(404, { message: `Could not find the function public.${fn}(${Object.keys(body).join(', ')})` }, 'argumentos');
      const args = Object.keys(body).map((k) => {
        const ty = types[names.indexOf(k)]!;
        const v = body[k];
        const val = v === null ? `NULL::${ty}` : ty === 'jsonb' || ty === 'json' ? `${lit(JSON.stringify(v))}::${ty}` : `${lit(typeof v === 'string' ? v : JSON.stringify(v))}::${ty}`;
        return `${ident(k)} => ${val}`;
      });
      const r = run(`SELECT to_jsonb(public.${ident(fn)}(${args.join(', ')}));`);
      if (!r.ok) return done(statusFor(r.sqlstate), { code: r.sqlstate, message: r.message }, r.message ?? undefined);
      const line = r.out.split('\n').filter(Boolean).pop() ?? '';
      return done(200, line === '' ? null : JSON.parse(line));
    }

    const table = path;
    const cols = columns(table);
    if (cols.length === 0) return done(404, { message: `relation public.${table} does not exist` }, 'tabela não existe');
    const RESERVED = ['on_conflict', 'select', 'order', 'limit', 'offset'];
    const filters = [...u.searchParams.entries()].filter(([k]) => !RESERVED.includes(k));
    const where = filters
      .map(([k, v]) => {
        if (!v.startsWith('eq.')) throw new Error(`filtro não suportado: ${k}=${v}`);
        return `${ident(k)} = ${lit(v.slice(3))}`;
      })
      .join(' AND ');

    if (init.method === 'GET') {
      // select=a,b&order=x,y&limit=n&offset=m, como o PostgREST (a RLS e as permissões de coluna valem).
      const select = (u.searchParams.get('select') ?? '*').split(',').map((c) => (c === '*' ? '*' : ident(c.trim()))).join(', ');
      const order = u.searchParams.get('order');
      const orderBy = order ? ` ORDER BY ${order.split(',').map((c) => ident(c.trim())).join(', ')}` : '';
      const limit = u.searchParams.get('limit');
      const offset = u.searchParams.get('offset');
      const page = `${limit ? ` LIMIT ${Number(limit)}` : ''}${offset ? ` OFFSET ${Number(offset)}` : ''}`;
      const r = run(`SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) FROM (SELECT ${select} FROM public.${ident(table)}${where ? ` WHERE ${where}` : ''}${orderBy}${page}) q;`);
      if (!r.ok) return done(statusFor(r.sqlstate), { code: r.sqlstate, message: r.message }, r.message ?? undefined);
      return done(200, JSON.parse(r.out.split('\n').filter(Boolean).pop() ?? '[]'));
    }

    if (init.method === 'DELETE') {
      const r = run(`DELETE FROM public.${ident(table)} WHERE ${where};`);
      return r.ok ? done(204) : done(statusFor(r.sqlstate), { code: r.sqlstate, message: r.message }, r.message ?? undefined);
    }

    const keys = Object.keys(body);
    const missing = keys.filter((k) => !cols.includes(k));
    if (missing.length) {
      const message = `Could not find the '${missing[0]}' column of '${table}' in the schema cache`;
      return done(400, { code: 'PGRST204', message }, message);
    }
    const colList = keys.map(ident).join(', ');
    const src = `json_populate_record(NULL::public.${ident(table)}, ${lit(JSON.stringify(body))}::json)`;

    if (init.method === 'PATCH') {
      const sets = keys.map((k) => `${ident(k)} = (${src}).${ident(k)}`).join(', ');
      const r = run(`UPDATE public.${ident(table)} SET ${sets} WHERE ${where};`);
      return r.ok ? done(204) : done(statusFor(r.sqlstate), { code: r.sqlstate, message: r.message }, r.message ?? undefined);
    }

    // POST = INSERT / upsert
    const prefer = init.headers.Prefer ?? init.headers.prefer ?? '';
    const conflict = (u.searchParams.get('on_conflict') ?? 'id').split(',').map((c) => ident(c.trim()));
    let onConflict = '';
    if (prefer.includes('resolution=ignore-duplicates')) onConflict = ` ON CONFLICT (${conflict.join(', ')}) DO NOTHING`;
    else if (prefer.includes('resolution=merge-duplicates')) {
      const sets = keys.map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(', ');
      onConflict = ` ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${sets}`;
    }
    const r = run(`INSERT INTO public.${ident(table)} (${colList}) SELECT ${colList} FROM ${src}${onConflict};`);
    return r.ok ? done(201) : done(statusFor(r.sqlstate), { code: r.sqlstate, message: r.message }, r.message ?? undefined);
  };
}
