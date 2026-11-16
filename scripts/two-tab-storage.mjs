/**
 * Duas abas de verdade (Chromium via Playwright) gravando ao mesmo tempo no registro de reservas (claimLedger) e nas
 * travas de conferência (reviewHolds). Auditoria GPT r10 ("a verificar 1"): ler, mudar e gravar a lista inteira numa
 * chave só não é atômico entre abas; a última gravação apagava a entrada da outra aba.
 *
 * Como roda: empacota os dois módulos com o esbuild do projeto numa página mínima, serve em http://127.0.0.1 (mesma
 * origem = mesmo localStorage), abre duas páginas no mesmo contexto e, a cada rodada, as duas esperam o mesmo instante
 * (barreira por relógio, em processos separados) e gravam uma entrada cada uma. No fim confere, nas duas abas e depois
 * de recarregar, que nenhuma entrada (nem o segredo) se perdeu.
 *
 * Uso: node scripts/two-tab-storage.mjs [rodadas]. Sai com 0 = nada perdido, 1 = perdeu, 2 = sem Playwright.
 * TWOTAB_MODULES=<pasta> testa outra cópia dos três módulos (ex.: a versão anterior, para ver a perda acontecer).
 * Também chamado por src/__tests__/twoTabStorage.browser.test.ts (pulado sem Playwright).
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadPlaywright() {
  const req = createRequire(join(ROOT, 'package.json'));
  for (const from of [() => req('playwright'), () => createRequire(import.meta.url)('playwright')]) {
    try {
      return from();
    } catch {
      // tenta o próximo
    }
  }
  return null;
}

async function bundle() {
  const { build } = await import(pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('esbuild')).href);
  const dir = mkdtempSync(join(tmpdir(), 'twotab-'));
  const entry = join(dir, 'entry.ts');
  // TWOTAB_MODULES: outra pasta com os três módulos (ex.: a versão anterior, para ver a perda acontecer).
  const mods = process.env.TWOTAB_MODULES ? resolve(process.env.TWOTAB_MODULES) : join(ROOT, 'src/lib/payments');
  writeFileSync(
    entry,
    [
      `import * as ledger from ${JSON.stringify(join(mods, 'claimLedger.ts'))};`,
      `import * as holds from ${JSON.stringify(join(mods, 'reviewHolds.ts'))};`,
      `import * as pointHere from ${JSON.stringify(join(mods, 'pointChargesHere.ts'))};`,
      'Object.assign(window, { ledger, holds, pointHere, ready: true });',
    ].join('\n'),
  );
  const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  rmSync(dir, { recursive: true, force: true });
  return out.outputFiles[0].text;
}

function serve(js) {
  const html = '<!doctype html><meta charset="utf-8"><title>duas abas</title><script type="module" src="/b.js"></script>';
  const server = createServer((req, res) => {
    if (req.url === '/b.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    else res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

/** Segredo da entrada (tab, r): conferido byte a byte no fim. Repetido dentro das páginas (as funções vão como texto). */
const TOKEN_SRC = `const tok = (tab, r) => (tab === 'A' ? 'a' : 'b').repeat(56) + String(r).padStart(8, '0');`;

/** Cada aba grava no mesmo instante (barreira por relógio); `op` roda na página com (tab, r, w = window). */
async function race(pages, rounds, op) {
  for (let r = 0; r < rounds; r++) {
    const at = Date.now() + 40;
    await Promise.all(
      pages.map(([tab, p]) =>
        p.evaluate(
          ({ at, tab, r, op }) => {
            while (Date.now() < at) {
              /* barreira: as duas abas saem juntas */
            }
            new Function('tab', 'r', 'w', op)(tab, r, window);
          },
          { at, tab, r, op: `${TOKEN_SRC}\n${op}` },
        ),
      ),
    );
  }
}

/**
 * setup: roda na aba A antes da corrida (com n = rodadas). op: cada aba, a cada rodada. check: roda em cada aba e numa
 * aba nova (recarregada) e devolve a lista do que se perdeu ou voltou.
 */
const SCENARIOS = {
  'claimLedger.beginLocalClaim (segredo da reserva)': {
    op: `w.ledger.beginLocalClaim(tab + '-' + r, 'o-' + tab, tok(tab, r))`,
    check: `const m = new Map(w.ledger.inFlightClaims().map((c) => [c.key, c.release_token]));
      const bad = []; for (const t of ['A', 'B']) for (let r = 0; r < n; r++) if (m.get(t + '-' + r) !== tok(t, r)) bad.push(t + '-' + r); return bad;`,
  },
  'claimLedger.addPendingRelease (liberação pendente)': {
    op: `w.ledger.addPendingRelease({ key: tab + '-' + r, order_id: 'o-' + tab, reason: 'x', release_token: tok(tab, r) })`,
    check: `const m = new Map(w.ledger.pendingReleases().map((c) => [c.key, c.release_token]));
      const bad = []; for (const t of ['A', 'B']) for (let r = 0; r < n; r++) if (m.get(t + '-' + r) !== tok(t, r)) bad.push(t + '-' + r); return bad;`,
  },
  'claimLedger: A encerra/termina as suas enquanto B grava novas': {
    setup: `for (let r = 0; r < n; r++) w.ledger.beginLocalClaim('A-' + r, 'o-A', tok('A', r));`,
    op: `if (tab === 'A') { if (r % 2) w.ledger.endLocalClaim('A-' + r); else w.ledger.settleLocalClaim('A-' + r); }
      else w.ledger.beginLocalClaim('B-' + r, 'o-B', tok('B', r));`,
    check: `const m = new Map(w.ledger.inFlightClaims().map((c) => [c.key, c])); const bad = [];
      for (let r = 0; r < n; r++) {
        const a = m.get('A-' + r);
        if (r % 2 ? a : a?.state !== 'settled' || a.release_token !== tok('A', r)) bad.push('A-' + r);
        if (m.get('B-' + r)?.release_token !== tok('B', r)) bad.push('B-' + r);
      } return bad;`,
  },
  'reviewHolds.setReviewHold (trava de conferência)': {
    op: `w.holds.setReviewHold({ order_id: 'o-' + tab, idempotency_key: tab + '-' + r, amount: 1, reason: tok(tab, r), code: 'X' })`,
    check: `const bad = []; for (const t of ['A', 'B']) for (let r = 0; r < n; r++) if (w.holds.getReviewHoldByKey(t + '-' + r)?.reason !== tok(t, r)) bad.push(t + '-' + r); return bad;`,
  },
  'reviewHolds: A tira as suas enquanto B grava novas (nada volta, nada some)': {
    setup: `for (let r = 0; r < n; r++) w.holds.setReviewHold({ order_id: 'o-A', idempotency_key: 'A-' + r, amount: 1, reason: tok('A', r), code: 'X' });`,
    op: `if (tab === 'A') w.holds.clearReviewHold('o-A', 'A-' + r);
      else w.holds.setReviewHold({ order_id: 'o-B', idempotency_key: 'B-' + r, amount: 1, reason: tok('B', r), code: 'X' });`,
    check: `const bad = []; for (let r = 0; r < n; r++) {
        if (w.holds.getReviewHoldByKey('A-' + r)) bad.push('A-' + r + ' voltou');
        if (w.holds.getReviewHoldByKey('B-' + r)?.reason !== tok('B', r)) bad.push('B-' + r);
      } return bad;`,
  },
  'pointChargesHere.rememberPointChargeHere': {
    op: `w.pointHere.rememberPointChargeHere(tab + '-' + r, 'o-' + tab)`,
    check: `const bad = []; for (const t of ['A', 'B']) for (let r = 0; r < n; r++) if (!w.pointHere.isPointChargeHere(t + '-' + r)) bad.push(t + '-' + r); return bad;`,
  },
};

export async function runTwoTab({ rounds = 30, log = console.log } = {}) {
  const pw = loadPlaywright();
  if (!pw) return { skipped: true, results: [] };
  const js = await bundle();
  const { server, url } = await serve(js);
  const browser = await pw.chromium.launch();
  const results = [];
  const open = async (ctx) => {
    const p = await ctx.newPage();
    await p.goto(url);
    await p.waitForFunction(() => window.ready === true);
    return p;
  };
  try {
    for (const [name, sc] of Object.entries(SCENARIOS)) {
      const ctx = await browser.newContext();
      const pa = await open(ctx);
      await pa.evaluate(() => localStorage.clear());
      await pa.reload();
      await pa.waitForFunction(() => window.ready === true);
      if (sc.setup) await pa.evaluate(({ src, n }) => new Function('w', 'n', src)(window, n), { src: `${TOKEN_SRC}\n${sc.setup}`, n: rounds });
      const pb = await open(ctx);
      await race([['A', pa], ['B', pb]], rounds, sc.op);
      await new Promise((ok) => setTimeout(ok, 200));
      const check = (p) => p.evaluate(({ src, n }) => new Function('w', 'n', src)(window, n), { src: `${TOKEN_SRC}\n${sc.check}`, n: rounds });
      const badA = await check(pa);
      const badB = await check(pb);
      const badReload = await check(await open(ctx));
      const r = { name, rounds, written: rounds * 2, lostTabA: badA.length, lostTabB: badB.length, lostAfterReload: badReload.length, sample: [...new Set([...badReload, ...badA, ...badB])].slice(0, 6) };
      results.push(r);
      log(`${name}: ${r.written} operações; erradas na aba A ${r.lostTabA}, na aba B ${r.lostTabB}, ao recarregar ${r.lostAfterReload}${r.sample.length ? ` (ex.: ${r.sample.join(', ')})` : ''}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return { skipped: false, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rounds = Number(process.argv[2]) || 30;
  const { skipped, results } = await runTwoTab({ rounds });
  if (skipped) {
    console.log('Playwright não encontrado: teste de duas abas pulado.');
    process.exit(2);
  }
  process.exit(results.some((r) => r.lostTabA + r.lostTabB + r.lostAfterReload > 0) ? 1 : 0);
}
