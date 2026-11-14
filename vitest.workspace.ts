import { configDefaults, defineWorkspace } from 'vitest/config';

// Três projetos no `npm test` da raiz:
// - app: o sistema (raiz), sem as pastas landing/ e admin/;
// - landing: roda com a própria landing/vite.config.ts, que define
//   __ANO_BUILD__ e o resto da configuração de build da landing;
// - admin: o painel administrativo (admin/vite.config.ts).
export default defineWorkspace([
  {
    extends: './vite.config.ts',
    test: {
      name: 'app',
      exclude: [...configDefaults.exclude, 'landing/**', 'admin/**'],
    },
  },
  'landing/vite.config.ts',
  'admin/vite.config.ts',
]);
