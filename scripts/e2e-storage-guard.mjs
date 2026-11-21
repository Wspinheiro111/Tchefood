// Teste em navegador REAL (Chromium via Playwright) do escritor único e da tela de bloqueio (PR #54, rodadas 27-30).
// Uso: npm run build && npx vite preview --port 4173 & node scripts/e2e-storage-guard.mjs [url]
// Duas abas do mesmo contexto (mesmo IndexedDB e Web Locks reais): a primeira escreve, a segunda fica só leitura.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const url = process.argv[2] ?? 'http://localhost:4173/';
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK  ' : 'FALHOU'} ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
const a = await ctx.newPage();
await a.goto(url);
await a.waitForSelector('#root *', { timeout: 15000 });
await a.waitForTimeout(1500); // hidratação e pedido do lock
check('aba A (primeira) NÃO mostra o bloqueio', (await a.locator('[role=alertdialog]').count()) === 0);
check('navigator.locks existe no navegador', await a.evaluate(() => typeof navigator.locks?.request === 'function'));

const b = await ctx.newPage();
await b.goto(url);
await b.waitForSelector('[role=alertdialog]', { timeout: 15000 });
check('aba B (segunda) mostra o bloqueio "Outra janela está em uso"', (await b.locator('[role=alertdialog]').innerText()).includes('Outra janela'));
check('#root da aba B está inerte', await b.evaluate(() => document.getElementById('root').inert === true));
check('o diálogo está FORA do #root (portal)', await b.evaluate(() => !document.getElementById('root').contains(document.querySelector('[role=alertdialog]'))));
check('nenhum elemento de #root recebe foco', await b.evaluate(() => {
  const el = document.querySelector('#root button, #root input, #root a');
  if (!el) return true;
  el.focus();
  return document.activeElement !== el;
}));
await b.keyboard.press('Tab');
check('o botão Recarregar é focável por teclado', await b.evaluate(() => document.activeElement?.textContent?.includes('Recarregar') === true));
check('o ponto central da tela pertence ao diálogo (nada operacional é clicável)', await b.evaluate(() => {
  const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  return !!el?.closest('[role=alertdialog]');
}));
// Recarregar por clique: a escritora (A) ainda está aberta, então volta ao bloqueio.
const reloaded = b.waitForEvent('load');
await b.getByRole('button', { name: 'Recarregar' }).click();
await reloaded;
await b.waitForSelector('[role=alertdialog]', { timeout: 15000 });
check('Recarregar (clique) recarrega e, com a escritora aberta, segue só leitura', true);

// A escritora fecha: B recebe o lock na fila e recarrega sozinha, assumindo a escrita.
await a.close();
let assumed = false;
try { await b.waitForSelector('[role=alertdialog]', { state: 'detached', timeout: 15000 }); assumed = true; } catch { /* falhou */ }
check('com a escritora fechada, a aba B recarrega sozinha e assume (sem bloqueio)', assumed);
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} verificação(ões) falharam` : '\nTodas as verificações passaram');
process.exit(failed.length ? 1 : 0);
