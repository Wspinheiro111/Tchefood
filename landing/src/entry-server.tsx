/**
 * Entrada do pré-render (scripts/prerender.mjs). Gera o HTML completo da página no build,
 * para o Google e as redes sociais lerem o conteúdo sem rodar JavaScript.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import App from './App';

export { jsonLdSeguroParaHtml, robotsTxt, sitemapXml, SEO, urlAbsoluta } from './lib/seo';

export function render(): string {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
