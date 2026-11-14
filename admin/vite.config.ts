/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';

// Painel administrativo do Tchê Food (equipe da plataforma, não as lojas). Usa as
// dependências da raiz: `npm run build:admin` gera admin/dist.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  css: { postcss: { plugins: [tailwind({ config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) }), autoprefixer()] } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { name: 'admin', root, environment: 'node' },
});
