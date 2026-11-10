import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/** Migration que é cópia de um arquivo de db/: a primeira linha diz qual. */
const COPY_HEADER = /^-- Cópia de db\/([a-z_]+\.sql) /;

describe('supabase/migrations', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

  it('cada arquivo de db/ aplicado depois do schema.sql tem a sua migration, igual ao original', () => {
    const copies = new Map<string, string>();
    for (const f of files) {
      const text = readFileSync(join(MIGRATIONS, f), 'utf8');
      const m = COPY_HEADER.exec(text);
      if (!m) continue;
      const body = text.slice(text.indexOf('\n') + 1);
      expect(body, `${f} difere de db/${m[1]}`).toBe(readFileSync(join(ROOT, 'db', m[1]!), 'utf8'));
      copies.set(m[1]!, f);
    }
    for (const db of ['schema_expansion.sql', 'schema_kiosk.sql', 'schema_purchases.sql', 'schema_equipe.sql', 'schema_autorizacao.sql', 'schema_gerente_nuvem.sql', 'schema_combos.sql', 'schema_baixar_loja.sql', 'schema_ar.sql', 'schema_caixa.sql']) {
      expect(copies.has(db), `falta a migration de db/${db}`).toBe(true);
    }
  });

  it('ordem: Fase 5 → totem → compras → equipe → autorização → barril/totem/cobrança → combos → baixar a loja, depois da Etapa 0', () => {
    const idx = (db: string) => files.findIndex((f) => readFileSync(join(MIGRATIONS, f), 'utf8').startsWith(`-- Cópia de db/${db} `));
    const etapa0 = files.findIndex((f) => f.includes('etapa0'));
    expect(etapa0).toBeGreaterThanOrEqual(0);
    expect(idx('schema_expansion.sql')).toBeGreaterThan(etapa0);
    expect(idx('schema_kiosk.sql')).toBeGreaterThan(idx('schema_expansion.sql'));
    expect(idx('schema_purchases.sql')).toBeGreaterThan(idx('schema_kiosk.sql'));
    expect(idx('schema_equipe.sql')).toBeGreaterThan(idx('schema_purchases.sql'));
    expect(idx('schema_autorizacao.sql')).toBeGreaterThan(idx('schema_equipe.sql'));
    expect(idx('schema_gerente_nuvem.sql')).toBeGreaterThan(idx('schema_autorizacao.sql'));
    expect(idx('schema_combos.sql')).toBeGreaterThan(idx('schema_gerente_nuvem.sql'));
    expect(idx('schema_baixar_loja.sql')).toBeGreaterThan(idx('schema_combos.sql'));
    expect(idx('schema_ar.sql')).toBeGreaterThan(idx('schema_baixar_loja.sql'));
    // O caixa redefine tchefood_authorize_manager: vem depois de toda migration que a define.
    expect(idx('schema_caixa.sql')).toBeGreaterThan(idx('schema_ar.sql'));
  });

  it('permissões padrão do banco iguais às do app (src/lib/permissions.ts)', async () => {
    const { DEFAULT_PERMISSIONS } = await import('../lib/permissions');
    const sql = readFileSync(join(ROOT, 'db', 'schema_equipe.sql'), 'utf8');
    for (const [perm, roles] of Object.entries(DEFAULT_PERMISSIONS)) {
      const m = new RegExp(`WHEN '${perm}' THEN ([^\\n]+)`).exec(sql);
      expect(m, `tchefood_can sem ${perm}`).not.toBeNull();
      const inDb = m![1]!.trim() === 'FALSE' ? [] : [...m![1]!.matchAll(/'([A-Z]+)'/g)].map((x) => x[1]);
      expect(['OWNER', ...inDb].sort(), perm).toEqual([...roles].sort());
    }
  });
});
