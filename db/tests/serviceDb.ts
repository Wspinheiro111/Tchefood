/**
 * SupabaseLike da service role sobre psql, para rodar o repositório da Edge Function point-charge
 * (supabase/functions/point-charge/repository.ts) contra o banco de verdade nos testes ponta a ponta.
 * Como o PostgREST: rpc com argumentos nomeados (tipos do pg_proc; argumento que não existe é recusado) e o
 * query builder que o repositório usa (select/update/eq/is/not, maybeSingle ou a lista com await).
 */
import type { SupabaseLike } from '../../supabase/functions/point-charge/repository';
import { psql, type PgTarget } from './postgrestEmulator';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function serviceDb(target: PgTarget, db: string): SupabaseLike {
  const asService = (stmt: string) => psql(target, `BEGIN; SET LOCAL ROLE service_role; ${stmt} COMMIT;`, db);
  const quoteValue = (v: unknown) => (v === null ? 'NULL' : lit(typeof v === 'string' ? v : JSON.stringify(v)));
  // "metadata->>charge_id" (filtro em campo de JSON, como no PostgREST) ou coluna simples.
  const column = (col: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? `"${m[1]}"->>${lit(m[2]!)}` : `"${col}"`;
  };
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const sig = psql(target, `SELECT array_to_string(p.proargnames, ',') || '|' || array_to_string(ARRAY(SELECT format_type(x, NULL) FROM unnest(p.proargtypes) x), ',')
                                  FROM pg_proc p WHERE p.proname = ${lit(fn)} AND p.pronamespace = 'public'::regnamespace;`, db);
      if (!sig.ok || !sig.out) return { data: null, error: { message: `Could not find the function public.${fn}`, code: 'PGRST202' } };
      const [namesRaw, typesRaw] = sig.out.split('|');
      const names = namesRaw!.split(',');
      const types = typesRaw!.split(',');
      const unknown = Object.keys(args).filter((k) => !names.includes(k));
      if (unknown.length) return { data: null, error: { message: `Could not find the function public.${fn}(${Object.keys(args).join(', ')})`, code: 'PGRST202' } };
      const list = Object.entries(args).map(([k, v]) => {
        const ty = types[names.indexOf(k)]!;
        return `"${k}" => ${v === null ? `NULL::${ty}` : `${lit(typeof v === 'string' ? v : JSON.stringify(v))}::${ty}`}`;
      });
      const r = asService(`SELECT to_jsonb(public."${fn}"(${list.join(', ')}));`);
      if (!r.ok) return { data: null, error: { message: r.message ?? 'erro', code: r.sqlstate ?? undefined } };
      const line = r.out.split('\n').filter(Boolean).pop() ?? '';
      const data = line === '' ? null : JSON.parse(line);
      // RETURNS <tabela> sem linha vem com todas as colunas nulas.
      return { data: data && typeof data === 'object' && !Array.isArray(data) && Object.values(data).every((x) => x === null) ? null : data, error: null };
    },
    from(table: string) {
      const where: string[] = [];
      let columns = '*';
      let patch: Record<string, unknown> | null = null;
      const run = () => {
        const cond = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const cols = columns === '*' ? '*' : columns.split(',').map((c) => `"${c.trim()}"`).join(', ');
        const stmt = patch
          ? `WITH u AS (UPDATE public."${table}" SET ${Object.entries(patch).map(([k, v]) => `"${k}" = ${quoteValue(v)}`).join(', ')}${cond} RETURNING ${cols}) SELECT coalesce(jsonb_agg(to_jsonb(u)), '[]') FROM u;`
          : `SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]') FROM (SELECT ${cols} FROM public."${table}"${cond}) s;`;
        const r = asService(stmt);
        if (!r.ok) return { rows: null, error: { message: r.message ?? 'erro', code: r.sqlstate ?? undefined } };
        return { rows: JSON.parse(r.out.split('\n').filter(Boolean).pop() ?? '[]') as unknown[], error: null };
      };
      const q = {
        select(cols: string) { columns = cols; return q; },
        update(p: Record<string, unknown>) { patch = p; return q; },
        eq(col: string, v: unknown) { where.push(`${column(col)} = ${quoteValue(v)}`); return q; },
        is(col: string, v: null) { where.push(`${column(col)} IS ${v === null ? 'NULL' : 'NOT NULL'}`); return q; },
        not(col: string, op: string, list: string) {
          if (op !== 'in') throw new Error(`filtro não suportado: ${op}`);
          where.push(`NOT (${column(col)} IN (${list.replace(/^\(|\)$/g, '').split(',').map((x) => lit(x)).join(', ')}))`);
          return q;
        },
        async maybeSingle() {
          const { rows, error } = run();
          if (error) return { data: null, error };
          if (rows!.length > 1) return { data: null, error: { message: 'mais de uma linha' } };
          return { data: rows![0] ?? null, error: null };
        },
        then(resolve: (v: { data: unknown[] | null; error: { message: string; code?: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
          try {
            const { rows, error } = run();
            return Promise.resolve(resolve({ data: rows, error }));
          } catch (e) {
            return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
          }
        },
      };
      return q;
    },
  };
}
