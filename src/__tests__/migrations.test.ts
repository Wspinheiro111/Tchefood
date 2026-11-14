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
    for (const db of ['schema_expansion.sql', 'schema_kiosk.sql', 'schema_purchases.sql', 'schema_equipe.sql', 'schema_autorizacao.sql', 'schema_gerente_nuvem.sql', 'schema_combos.sql', 'schema_baixar_loja.sql', 'schema_dinheiro_servidor.sql', 'schema_ar.sql', 'schema_caixa.sql', 'schema_entrega.sql', 'schema_avaliacoes.sql', 'schema_cartao.sql', 'schema_segredos.sql', 'schema_preco_gerente.sql', 'schema_cashback_servidor.sql', 'schema_desconto_uso_unico.sql', 'schema_cashback_conciliacao.sql', 'schema_pin_equipe_trava.sql']) {
      expect(copies.has(db), `falta a migration de db/${db}`).toBe(true);
    }
  });

  it('ordem: Fase 5 → totem → compras → equipe → autorização → barril/totem/cobrança → combos → baixar a loja → dinheiro no servidor, depois da Etapa 0', () => {
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
    expect(idx('schema_dinheiro_servidor.sql')).toBeGreaterThan(idx('schema_baixar_loja.sql'));
    expect(idx('schema_ar.sql')).toBeGreaterThan(idx('schema_dinheiro_servidor.sql'));
    // O caixa redefine tchefood_authorize_manager: vem depois de toda migration que a define.
    expect(idx('schema_caixa.sql')).toBeGreaterThan(idx('schema_ar.sql'));
    // A entrega aponta para a sangria do caixa (cash_movements).
    expect(idx('schema_entrega.sql')).toBeGreaterThan(idx('schema_caixa.sql'));
    // A entrega redefine tchefood_expected_item_price (taxa de entrega).
    expect(idx('schema_entrega.sql')).toBeGreaterThan(idx('schema_dinheiro_servidor.sql'));
    expect(idx('schema_avaliacoes.sql')).toBeGreaterThan(idx('schema_entrega.sql'));
    // O cartão de comanda refaz a regra de kind criada pelo totem.
    expect(idx('schema_cartao.sql')).toBeGreaterThan(idx('schema_kiosk.sql'));
    // A trava dos segredos libera as colunas de tenants que existem quando ela roda: coluna nova em
    // tenants numa migration posterior ficaria sem leitura para o aparelho (a pull da loja quebraria).
    // O preço com PIN refaz a autorização do gerente (versão do caixa) e a conferência do preço.
    expect(idx('schema_preco_gerente.sql')).toBeGreaterThan(idx('schema_caixa.sql'));
    expect(idx('schema_preco_gerente.sql')).toBeGreaterThan(idx('schema_dinheiro_servidor.sql'));
    // O desconto de uso único refaz a conferência da conta (versão de schema_expansion.sql).
    expect(idx('schema_desconto_uso_unico.sql')).toBeGreaterThan(idx('schema_expansion.sql'));
    const segredos = idx('schema_segredos.sql');
    for (const f of files.slice(segredos + 1)) {
      expect(/ALTER TABLE (IF EXISTS )?tenants\b/i.test(readFileSync(join(MIGRATIONS, f), 'utf8')), `${f} mexe em tenants depois de schema_segredos.sql: libere a coluna nova para authenticated`).toBe(false);
    }
    // O resgate pelo servidor refaz os gatilhos do extrato criados na Fase 5.
    expect(idx('schema_cashback_servidor.sql')).toBeGreaterThan(idx('schema_expansion.sql'));
    // A conciliação refaz o resgate (tchefood_register_cashback_redeem) e o guarda dos audit_logs do cashback no servidor.
    expect(idx('schema_cashback_conciliacao.sql')).toBeGreaterThan(idx('schema_cashback_servidor.sql'));
    expect(idx('schema_cashback_conciliacao.sql')).toBeGreaterThan(idx('schema_desconto_uso_unico.sql'));
    // A trava do PIN da equipe refaz tchefood_check_pin, tchefood_save_staff e tchefood_start_store
    // (versão de schema_equipe.sql) e usa a mesma chave da conciliação do cashback: é a última que as define.
    expect(idx('schema_pin_equipe_trava.sql')).toBeGreaterThan(idx('schema_equipe.sql'));
    expect(idx('schema_pin_equipe_trava.sql')).toBeGreaterThan(idx('schema_cashback_conciliacao.sql'));
    for (const fn of ['tchefood_check_pin', 'tchefood_save_staff', 'tchefood_start_store']) {
      const defines = files.filter((f) => readFileSync(join(MIGRATIONS, f), 'utf8').includes(`CREATE OR REPLACE FUNCTION ${fn}(`));
      expect(defines.at(-1), fn).toBe(files[idx('schema_pin_equipe_trava.sql')]);
    }
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
