/**
 * Script de conferência do Supabase de verdade (db/verificar_delivery_servidor.sql).
 *
 * Monta um Postgres igual ao Supabase (db/schema.sql + supabase/migrations, mesmo applySchema de
 * deliveryRepository.pg.test.ts), roda o script e espera todas as linhas ok (menos o item opcional da
 * rodada 3). Depois estraga um privilégio de propósito e espera a linha correspondente falhar.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = 'tchefood_verificar_delivery_test';
const ROOT = join(__dirname, '..', '..');
const SCRIPT = readFileSync(join(ROOT, 'db', 'verificar_delivery_servidor.sql'), 'utf8');

function applySchema(t: PgTarget, db: string): void {
  createSupabaseLikeDb(t, db);
  psqlFile(t, join(ROOT, 'db', 'schema.sql'), db);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) psqlFile(t, join(dir, f), db);
}

function sql(q: string): string {
  const r = psql(target!, q, DB);
  if (!r.ok) throw new Error(r.message ?? 'sql');
  return r.out;
}

type Linha = { item: string; esperado: string; encontrado: string; ok: string };

// Roda o script como o SQL Editor rodaria e devolve as linhas (separador fora do texto do script).
function conferir(): Linha[] {
  const r = psql(target!, `\\pset fieldsep '\\x1f'\n${SCRIPT}`, DB);
  if (!r.ok) throw new Error(r.message ?? 'script');
  return r.out
    .split('\n')
    .filter((l) => l.includes('\x1f'))
    .map((l) => {
      const [item, esperado, encontrado, ok] = l.split('\x1f');
      return { item: item!, esperado: esperado!, encontrado: encontrado!, ok: ok! };
    });
}

const opcional = (l: Linha) => l.item.includes('(rodada 3)');

(target ? describe : describe.skip)('conferência do Supabase do delivery (script só leitura)', () => {
  beforeAll(() => {
    applySchema(target!, DB);
  });

  it('banco migrado: todas as linhas ok (menos o opcional da rodada 3)', () => {
    const linhas = conferir();
    // Cobre funções, privilégios, SECURITY DEFINER, tabelas, RLS, colunas, CHECKs e triggers.
    expect(linhas.length).toBeGreaterThanOrEqual(40);
    expect(linhas.filter((l) => !opcional(l) && l.ok !== 'sim')).toEqual([]);
    for (const l of linhas.filter(opcional)) expect(['sim', 'ainda não (opcional)']).toContain(l.ok);
    expect(linhas.map((l) => l.item)).toEqual(expect.arrayContaining([
      'quem executa public.tchefood_delivery_save_order',
      'quem executa public.tchefood_delivery_authorize',
      'authenticated grava em delivery_orders',
      'RLS ligada em delivery_events',
      'policies de leitura em delivery_integrations',
      'coluna delivery_orders.cancellation_request',
      'CHECK delivery_integrations_merchant_format',
      'trigger trg_audit_logs_guard em audit_logs',
      'trigger trg_audit_logs_immutable em audit_logs',
    ]));
  });

  it('o script não grava nada (roda dentro de uma transação só leitura)', () => {
    const r = psql(target!, `BEGIN READ ONLY;\n${SCRIPT}\nCOMMIT;`, DB);
    expect(r.ok).toBe(true);
  });

  it('GRANT INSERT a authenticated numa tabela delivery_* faz a linha correspondente falhar', () => {
    sql('GRANT INSERT ON delivery_orders TO authenticated;');
    try {
      const falhas = conferir().filter((l) => l.ok === 'NÃO');
      expect(falhas).toEqual([expect.objectContaining({ item: 'authenticated grava em delivery_orders', encontrado: 'INSERT' })]);
    } finally {
      sql('REVOKE INSERT ON delivery_orders FROM authenticated;');
    }
  });

  it('função do servidor liberada ao app, RLS desligada e trigger desligado também aparecem', () => {
    sql(`GRANT EXECUTE ON FUNCTION tchefood_delivery_save_order(delivery_channel, INTEGER, JSONB) TO authenticated;
         ALTER TABLE delivery_events DISABLE ROW LEVEL SECURITY;
         ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable;`);
    try {
      const falhas = conferir().filter((l) => l.ok === 'NÃO').map((l) => l.item);
      expect(falhas.sort()).toEqual([
        'RLS ligada em delivery_events',
        'quem executa public.tchefood_delivery_save_order',
        'tchefood_delivery_* que authenticated executa',
        'trigger trg_audit_logs_immutable em audit_logs',
      ].sort());
    } finally {
      sql(`REVOKE EXECUTE ON FUNCTION tchefood_delivery_save_order(delivery_channel, INTEGER, JSONB) FROM authenticated;
           ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;
           ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable;`);
    }
  });
});
