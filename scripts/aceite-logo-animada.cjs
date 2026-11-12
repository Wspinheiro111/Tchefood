#!/usr/bin/env node
/*
 * Teste de aceite da logo animada (auditoria GPT do PR #37, P2-01 e P2-02).
 * Roda no navegador de verdade (Playwright) contra o build servido:
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/aceite-logo-animada.cjs http://localhost:4173/
 *
 * Confere, no login, no totem e no painel de pedidos:
 *   - WebP carregado: animada visível, parada escondida (sem logo dobrada), sem esticar;
 *   - WebP com 404, pendente ou inválido: parada visível e nenhuma imagem quebrada;
 *   - movimento reduzido: só a parada;
 *   - larguras 320, 360, 1024 e 1280: a animada mantém a proporção 667x265 e fica sobre o desenho da parada.
 */
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:4173/';
const WEBP = 667 / 265;
const LOGO = 1816 / 451;
let falhas = 0;

function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FALHA'} ${msg}`);
  if (!cond) falhas++;
}

async function estado(page) {
  return page.evaluate(() => {
    const span = document.querySelector('span[role="img"][aria-label^="Tchê Food"]');
    if (!span) return null;
    const [parada, animada] = span.querySelectorAll('img');
    const vis = (el) => !!el && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      paradaVisivel: vis(parada),
      paradaCarregada: !!parada && parada.complete && parada.naturalWidth > 0,
      temAnimada: !!animada,
      animadaVisivel: vis(animada),
      animadaQuebrada: !!animada && animada.complete && animada.naturalWidth === 0,
      parada: r(parada),
      animada: r(animada),
    };
  });
}

function geometria(s, onde) {
  const a = s.animada;
  const p = s.parada;
  ok(Math.abs(a.width / a.height - WEBP) < 0.02, `${onde}: animada na proporção do WebP (${(a.width / a.height).toFixed(3)} vs ${WEBP.toFixed(3)})`);
  // desenho da parada dentro da caixa (object-contain)
  const w = Math.min(p.width, p.height * LOGO);
  const h = w / LOGO;
  const x = p.left + (p.width - w) / 2;
  const y = p.top + (p.height - h) / 2;
  const esperado = { left: x - 0.02006 * w, top: y - 0.25466 * h, width: 1.02932 * w };
  ok(
    Math.abs(a.left - esperado.left) < 1.5 && Math.abs(a.top - esperado.top) < 1.5 && Math.abs(a.width - esperado.width) < 1.5,
    `${onde}: animada alinhada ao desenho da parada (caixa ${p.width.toFixed(1)}x${p.height.toFixed(1)}, desenho ${w.toFixed(1)}x${h.toFixed(1)})`,
  );
}

async function abrir(browser, { largura = 1280, altura = 800, reduzir = false, rota } = {}) {
  const ctx = await browser.newContext({ viewport: { width: largura, height: altura }, reducedMotion: reduzir ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  if (rota) await page.route('**/*.webp', rota);
  await page.goto(BASE);
  return { ctx, page };
}

async function pin(page, digitos) {
  for (const d of digitos) await page.getByRole('button', { name: d, exact: true }).first().click();
}

(async () => {
  const browser = await chromium.launch();

  // P2-02: larguras (login)
  for (const [largura, altura] of [[320, 640], [360, 740], [1024, 768], [1280, 800]]) {
    const { ctx, page } = await abrir(browser, { largura, altura });
    await page.waitForTimeout(1500);
    const s = await estado(page);
    ok(s && s.temAnimada && s.animadaVisivel && !s.paradaVisivel, `login ${largura}px: animada visível e parada escondida`);
    if (s && s.temAnimada) geometria(s, `login ${largura}px`);
    await ctx.close();
  }

  // P2-01: WebP com 404
  {
    const { ctx, page } = await abrir(browser, { rota: (r) => r.fulfill({ status: 404, body: 'nao achou' }) });
    await page.waitForTimeout(1500);
    const s = await estado(page);
    ok(s && s.paradaVisivel && s.paradaCarregada && !s.temAnimada, 'login com WebP 404: parada visível, sem animada');
    await ctx.close();
  }
  // P2-01: rede fora para o WebP
  {
    const { ctx, page } = await abrir(browser, { rota: (r) => r.abort('internetdisconnected') });
    await page.waitForTimeout(1500);
    const s = await estado(page);
    ok(s && s.paradaVisivel && !s.temAnimada, 'login com WebP sem rede: parada visível, sem animada');
    await ctx.close();
  }
  // P2-01: requisição pendente
  {
    let liberar;
    const { ctx, page } = await abrir(browser, { rota: (r) => new Promise((res) => { liberar = () => r.continue().then(res); }) });
    await page.waitForTimeout(1500);
    const s = await estado(page);
    ok(s && s.paradaVisivel && !s.temAnimada, 'login com WebP pendente: parada visível durante a espera');
    if (liberar) liberar();
    await page.waitForTimeout(1500);
    const s2 = await estado(page);
    ok(s2 && s2.temAnimada && s2.animadaVisivel && !s2.paradaVisivel, 'login: quando o WebP chega, troca para a animada');
    await ctx.close();
  }
  // P2-01: arquivo que não decodifica
  {
    const { ctx, page } = await abrir(browser, { rota: (r) => r.fulfill({ status: 200, contentType: 'image/webp', body: Buffer.from('isto nao e um webp') }) });
    await page.waitForTimeout(1500);
    const s = await estado(page);
    ok(s && s.paradaVisivel && !s.temAnimada, 'login com WebP inválido: parada visível, sem imagem quebrada');
    await ctx.close();
  }
  // movimento reduzido
  {
    const { ctx, page } = await abrir(browser, { reduzir: true });
    await page.waitForTimeout(1500);
    const s = await estado(page);
    ok(s && s.paradaVisivel && !s.animadaVisivel, 'login com movimento reduzido: só a parada');
    await ctx.close();
  }

  // totem (PIN 4444) e painel de pedidos (dono 8888 → Painel TV): normal e com 404
  for (const falha of [false, true]) {
    const sufixo = falha ? ' com WebP 404' : '';
    const rota = falha ? (r) => r.fulfill({ status: 404, body: '' }) : undefined;
    {
      const { ctx, page } = await abrir(browser, { largura: 1024, altura: 768, rota });
      await page.waitForTimeout(800);
      await pin(page, '4444');
      await page.waitForTimeout(1500);
      const s = await estado(page);
      if (falha) ok(s && s.paradaVisivel && !s.temAnimada, `totem${sufixo}: parada visível`);
      else {
        ok(s && s.animadaVisivel && !s.paradaVisivel, 'totem: animada visível, parada escondida');
        if (s && s.temAnimada) geometria(s, 'totem');
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await abrir(browser, { largura: 1920, altura: 1080, rota });
      await page.waitForTimeout(800);
      await pin(page, '8888');
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: /Painel\s*TV/ }).first().click();
      await page.waitForTimeout(1500);
      const s = await estado(page);
      if (falha) ok(s && s.paradaVisivel && !s.temAnimada, `painel de pedidos${sufixo}: parada visível`);
      else {
        ok(s && s.animadaVisivel && !s.paradaVisivel, 'painel de pedidos: animada visível, parada escondida');
        if (s && s.temAnimada) geometria(s, 'painel de pedidos');
      }
      await ctx.close();
    }
  }

  await browser.close();
  console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
  process.exit(falhas ? 1 : 0);
})();
