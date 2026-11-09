// Codemod do tema claro (fundo branco) do Tchê Food.
// Troca as classes Tailwind pensadas para fundo escuro pelas equivalentes
// em fundo branco. É idempotente: rodar de novo não muda nada.
// Rode depois de trocar <BrandLogo variant="dark"> pela logo padrão.
// Uso: node scripts/light-theme-codemod.mjs [pasta=src]
// Serve também para branches abertos antes do tema claro: rode e revise o diff.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'src';

// Cinzas: superfícies escuras viram claras e textos claros viram escuros.
// Tons já claros (50-300 em bg/border, 500-950 em texto) ficam como estão.
const SLATE = {
  bg: { 950: 'white', 900: 'slate-50', 800: 'slate-100', 700: 'slate-200', 600: 'slate-300', 500: 'slate-400' },
  border: { 950: 'slate-200', 900: 'slate-200', 800: 'slate-200', 700: 'slate-200', 600: 'slate-300', 500: 'slate-300' },
  divide: { 800: 'slate-200', 700: 'slate-200', 600: 'slate-300' },
  ring: { 800: 'slate-200', 700: 'slate-200', 600: 'slate-300' },
  text: { 50: 'slate-900', 100: 'slate-900', 200: 'slate-800', 300: 'slate-700', 400: 'slate-500' },
};

// Cores de destaque: tons claros de texto ficam ilegíveis no branco.
const ACCENT_TEXT = { 50: 700, 100: 700, 200: 700, 300: 600, 400: 600 };
const ACCENTS = 'rose|red|emerald|green|amber|yellow|orange|sky|blue|cyan|teal|indigo|violet|purple|pink|lime|fuchsia';

// Fundos de destaque escuros e translúcidos viram tintas claras.
const ACCENT_BG_DARK = { 950: 50, 900: 50, 800: 100 };

const B = '(?<![\\w-])';
const E = '(?![\\w-])';

function transform(src) {
  let out = src;
  out = out.replace(new RegExp(`${B}(bg|border|divide|ring|text)-slate-(\\d{2,3})${E}`, 'g'), (m, kind, shade) => {
    const to = SLATE[kind]?.[shade];
    return to ? `${kind}-${to}` : m;
  });
  out = out.replace(new RegExp(`${B}text-(${ACCENTS})-(\\d{2,3})${E}`, 'g'), (m, color, shade) => {
    const to = ACCENT_TEXT[shade];
    return to ? `text-${color}-${to}` : m;
  });
  out = out.replace(new RegExp(`${B}bg-(${ACCENTS})-(\\d{3})\\/(\\d{2})${E}`, 'g'), (m, color, shade) => {
    const to = ACCENT_BG_DARK[shade];
    return to ? `bg-${color}-${to}` : m;
  });
  // Destaques da marca: o amarelo é fundo; texto e contorno de destaque usam o vermelho.
  out = out.replace(new RegExp(`${B}text-ouro${E}`, 'g'), 'text-brasa');
  out = out.replace(new RegExp(`${B}text-stone${E}`, 'g'), 'text-verde');
  out = out.replace(new RegExp(`${B}shadow-black${E}`, 'g'), 'shadow-slate-300');
  // O verde da marca é escuro: texto sobre ele passa a ser branco.
  out = out.replace(/(['"`])([^'"`\n]*?)\1/g, (m, q, body) =>
    /(?<![\w-])bg-stone(?![\w/-])/.test(body) ? q + body.replace(/(?<![\w-])text-slate-950(?![\w-])/g, 'text-white') + q : m);
  return out;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p); continue; }
    if (!/\.(tsx|ts)$/.test(name)) continue;
    const before = readFileSync(p, 'utf8');
    if (before.includes('@tema-claro')) continue; // arquivo já pensado para fundo claro
    const after = transform(before);
    if (after !== before) { writeFileSync(p, after); console.log('tema claro:', p); }
  }
}
walk(root);
