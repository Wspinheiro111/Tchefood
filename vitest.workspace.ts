import { configDefaults, defineWorkspace } from 'vitest/config';

// Dois projetos no `npm test` da raiz:
// - app: o sistema (raiz), sem a pasta landing/;
// - landing: roda com a própria landing/vite.config.ts, que define
//   __ANO_BUILD__ e o resto da configuração de build da landing.
export default defineWorkspace([
  {
    extends: './vite.config.ts',
    test: {
      name: 'app',
      exclude: [...configDefaults.exclude, 'landing/**'],
    },
  },
  'landing/vite.config.ts',
]);
