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

// "Detached" sozinho não prova que a aba assumiu a escrita (GPT r30): comprova uma gravação REAL no IndexedDB
// seguida de leitura íntegra. Entra com o PIN de demonstração pela tela (muda currentUserId, que é persistido),
// espera o texto aparecer no IndexedDB e recarrega: a sessão tem de voltar da hidratação (sem tela de PIN).
const KEY = 'tchefood-state-v1';
const readIdb = (page) => page.evaluate((key) => new Promise((resolve) => {
  const open = indexedDB.open('tchefood', 1);
  open.onerror = () => resolve(null);
  open.onsuccess = () => {
    try {
      const get = open.result.transaction('kv', 'readonly').objectStore('kv').get(key);
      get.onsuccess = () => resolve(typeof get.result === 'string' ? get.result : null);
      get.onerror = () => resolve(null);
    } catch { resolve(null); }
  };
}), KEY);
const hasUser = (text) => { try { return JSON.parse(text)?.state?.currentUserId != null; } catch { return false; } };
await b.waitForSelector('#root button', { timeout: 15000 });
const before = await readIdb(b);
check('antes do login, o IndexedDB da aba B não tem usuário logado', before === null || !hasUser(before));
for (const d of ['1', '1', '1', '1']) await b.locator('#root button', { hasText: new RegExp(`^${d}$`) }).first().click();
let written = null;
for (let i = 0; i < 40 && !written; i++) {
  const t = await readIdb(b);
  if (t && hasUser(t)) written = t;
  else await b.waitForTimeout(250);
}
check('a aba B grava no IndexedDB real (usuário logado persistido)', written !== null);
const loaded = b.waitForEvent('load');
await b.reload();
await loaded;
await b.waitForSelector('#root *', { timeout: 15000 });
await b.waitForTimeout(1500);
const after = await readIdb(b);
check('após recarregar, o texto lido do IndexedDB é íntegro e idêntico ao gravado', written !== null && after === written);
check('após recarregar, a hidratação devolve a sessão (sem bloqueio e sem tela de PIN)', await b.evaluate(() => document.querySelector('[role=alertdialog]') === null) && await b.evaluate(() => ![...document.querySelectorAll('#root button')].some((x) => x.textContent?.trim() === '0')));
await ctx.close();

// ---- estado blocked em navegador real (a hidratação não ficou estável) ----
// Contexto novo. Uma abertura normal grava o estado; depois, ao reabrir, cada leitura do estado principal no IndexedDB
// faz aparecer uma cópia de emergência NOVA no localStorage (como outro escritor gravando sem parar): a seleção nunca
// fica estável em 6 tentativas e a hidratação é provisória (select() -> markProvisional).
const ctx2 = await browser.newContext();
const p1 = await ctx2.newPage();
await p1.goto(url);
await p1.waitForSelector('#root button', { timeout: 15000 });
for (const d of ['1', '1', '1', '1']) await p1.locator('#root button', { hasText: new RegExp(`^${d}$`) }).first().click();
let saved = null;
for (let i = 0; i < 40 && !saved; i++) {
  const t = await readIdb(p1);
  if (t && hasUser(t)) saved = t;
  else await p1.waitForTimeout(250);
}
check('(blocked) preparo: o estado normal foi gravado no IndexedDB', saved !== null);
if (saved) {
  await p1.evaluate((text) => { localStorage.setItem('__e2e_text', text); localStorage.setItem('__e2e_block', '1'); }, saved);
  await p1.close();
  await ctx2.addInitScript((key) => {
    if (localStorage.getItem('__e2e_block') !== '1') return;
    const base = JSON.parse(localStorage.getItem('__e2e_text'));
    let n = 0;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (k) {
      if (k === key) {
        n += 1;
        const seq = 8_000_000_000_000_000 + n;
        const v = JSON.parse(JSON.stringify(base));
        v.state.__e2eCopia = n; // conteúdo diferente a cada leitura
        localStorage.setItem(`${key}::copia::${seq.toString(36)}.e2e`, JSON.stringify({ seq, id: 'e2e', v: JSON.stringify(v), base: null }));
      }
      return get.call(this, k);
    };
  }, KEY);
  const p2 = await ctx2.newPage();
  await p2.goto(url);
  let blocked = false;
  try { await p2.waitForSelector('[role=alertdialog]', { timeout: 15000 }); blocked = true; } catch { /* sem bloqueio */ }
  check('(blocked) a hidratação provisória mostra o bloqueio', blocked);
  if (blocked) {
    const txt = await p2.locator('[role=alertdialog]').innerText();
    check('(blocked) a mensagem é a de estado não confirmado (não a de outra janela)', txt.includes('não conseguiu confirmar') && !txt.includes('Outra janela'));
    check('(blocked) #root inerte e diálogo fora do #root', await p2.evaluate(() => document.getElementById('root').inert === true && !document.getElementById('root').contains(document.querySelector('[role=alertdialog]'))));
    await p2.keyboard.press('Tab');
    check('(blocked) o botão Recarregar é focável por teclado', await p2.evaluate(() => document.activeElement?.textContent?.includes('Recarregar') === true));
    check('(blocked) o ponto central da tela pertence ao diálogo', await p2.evaluate(() => !!document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[role=alertdialog]')));
    check('(blocked) nenhum botão de #root recebe foco', await p2.evaluate(() => {
      const el = document.querySelector('#root button');
      if (!el) return true;
      el.focus();
      return document.activeElement !== el;
    }));
  }
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} verificação(ões) falharam` : '\nTodas as verificações passaram');
process.exit(failed.length ? 1 : 0);
