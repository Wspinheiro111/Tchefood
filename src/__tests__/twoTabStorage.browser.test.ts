// @vitest-environment node
/**
 * Auditoria GPT r10 ("a verificar 1"): duas abas de verdade (Chromium via Playwright) gravando ao mesmo tempo no
 * registro de reservas, nas travas de conferência e nas cobranças da Point deste aparelho. Roda
 * scripts/two-tab-storage.mjs; pulado quando o Playwright não está instalado (não é dependência do projeto).
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

function hasPlaywright(): boolean {
  try {
    createRequire(import.meta.url)('playwright');
    return true;
  } catch {
    return false;
  }
}

type TwoTabResult = { name: string; written: number; lostTabA: number; lostTabB: number; lostAfterReload: number; sample: string[] };

describe.skipIf(!hasPlaywright())('duas abas no navegador gravando juntas', () => {
  it('nenhuma entrada (nem o segredo) se perde, em nenhuma das abas nem depois de recarregar', async () => {
    const script = new URL('../../scripts/two-tab-storage.mjs', import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ script)) as { runTwoTab: (o: { rounds: number; log: (s: string) => void }) => Promise<{ skipped: boolean; results: TwoTabResult[] }> };
    const { skipped, results } = await mod.runTwoTab({ rounds: 20, log: () => undefined });
    expect(skipped).toBe(false);
    expect(results.length).toBeGreaterThanOrEqual(6);
    for (const r of results) expect({ name: r.name, lostTabA: r.lostTabA, lostTabB: r.lostTabB, lostAfterReload: r.lostAfterReload, sample: r.sample }).toEqual({ name: r.name, lostTabA: 0, lostTabB: 0, lostAfterReload: 0, sample: [] });
  }, 120_000);
});
