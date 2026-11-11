/**
 * Pré-render da landing: depois do `vite build`, gera o HTML completo da página e grava no
 * dist/index.html junto com título, descrição, canonical, Open Graph, Twitter, JSON-LD,
 * sitemap.xml e robots.txt. Assim o Google lê todo o conteúdo sem precisar rodar JavaScript.
 *
 * Uso: node scripts/prerender.mjs  (o `npm run build` já chama)
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(raiz, 'dist');
const ssr = path.join(raiz, 'dist-ssr');

const mod = await import(pathToFileURL(path.join(ssr, 'entry-server.js')).href);
const { render, SEO, urlAbsoluta, jsonLdSeguroParaHtml, sitemapXml, robotsTxt } = mod;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const imagem = urlAbsoluta(SEO.imagem);
const head = [
  `<title>${esc(SEO.titulo)}</title>`,
  `<meta name="description" content="${esc(SEO.descricao)}" />`,
  `<meta name="keywords" content="${esc(SEO.palavrasChave.join(', '))}" />`,
  `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />`,
  `<meta name="author" content="W9 Sistemas" />`,
  `<link rel="canonical" href="${esc(urlAbsoluta())}" />`,
  `<link rel="alternate" hreflang="pt-BR" href="${esc(urlAbsoluta())}" />`,
  `<meta property="og:type" content="website" />`,
  `<meta property="og:locale" content="pt_BR" />`,
  `<meta property="og:site_name" content="Tchê Food" />`,
  `<meta property="og:title" content="${esc(SEO.titulo)}" />`,
  `<meta property="og:description" content="${esc(SEO.descricao)}" />`,
  `<meta property="og:url" content="${esc(urlAbsoluta())}" />`,
  `<meta property="og:image" content="${esc(imagem)}" />`,
  `<meta property="og:image:width" content="${SEO.imagemLargura}" />`,
  `<meta property="og:image:height" content="${SEO.imagemAltura}" />`,
  `<meta property="og:image:alt" content="Logo do Tchê Food, sistema para restaurantes e delivery" />`,
  `<meta name="twitter:card" content="summary_large_image" />`,
  `<meta name="twitter:title" content="${esc(SEO.titulo)}" />`,
  `<meta name="twitter:description" content="${esc(SEO.descricao)}" />`,
  `<meta name="twitter:image" content="${esc(imagem)}" />`,
  `<script type="application/ld+json">${jsonLdSeguroParaHtml()}</script>`,
].join('\n    ');

const arquivo = path.join(dist, 'index.html');
let html = await readFile(arquivo, 'utf8');
for (const marca of ['<!--seo-head-->', '<!--app-html-->']) {
  if (!html.includes(marca)) throw new Error(`prerender: marcador ${marca} não encontrado em dist/index.html`);
}
// O build de SSR escreve os arquivos como "/assets/..."; o site usa caminho relativo (base './'),
// igual ao bundle do navegador, para funcionar na raiz do domínio e em subpasta.
const corpo = render().replace(/(src|href)="\/assets\//g, '$1="./assets/');
html = html.replace('<!--seo-head-->', head).replace('<!--app-html-->', corpo);
await writeFile(arquivo, html);

const hoje = new Date().toISOString().slice(0, 10);
await writeFile(path.join(dist, 'sitemap.xml'), sitemapXml(hoje));
await writeFile(path.join(dist, 'robots.txt'), robotsTxt());
await rm(ssr, { recursive: true, force: true });

console.log(`prerender: dist/index.html (${(html.length / 1024).toFixed(1)} KB), sitemap.xml e robots.txt para ${urlAbsoluta()}`);
