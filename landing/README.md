# Tchê Food — Landing page comercial

Site de vendas do **Tchê Food** (W9 Sistemas). App independente em React 18 + TypeScript + Vite + Tailwind, sem backend.
O build **pré-renderiza** a página: o `dist/index.html` já sai com todo o texto, para o Google ler sem rodar JavaScript.

## Rodar

```bash
cd landing
npm install
npm run dev      # desenvolvimento
npm test         # calculadora, SEO (JSON-LD, sitemap, FAQ) e conteúdo
npm run build    # gera dist/ pré-renderizado + sitemap.xml + robots.txt
```

## O que trocar

- `src/lib/config.ts`: WhatsApp, planos e preços, selos dos planos (`EM_BREVE`, `NA_IMPLANTACAO`) e o domínio (`SITE_URL`).
- `src/lib/funcionalidades.ts`: a lista completa de funções, com o status de cada uma (`pronto`, `implantacao`, `em-breve`).
  Só marque `pronto` o que já roda sem credencial da loja (ver "O que ainda é simulado" no README do sistema).
- `src/lib/faq.ts`: perguntas frequentes (viram a seção Dúvidas e o FAQPage do Google ao mesmo tempo).
- `src/lib/seo.ts`: título, descrição, palavras-chave, JSON-LD, sitemap e robots.

## SEO

- Título, descrição, canonical, Open Graph e Twitter Card no `<head>` (gravados pelo `scripts/prerender.mjs`).
- JSON-LD: `Organization`, `WebSite`, `SoftwareApplication` (com uma `Offer` por plano em BRL) e `FAQPage`.
- `sitemap.xml` e `robots.txt` gerados no build com o domínio de `SITE_URL`.
- HTML semântico: um único `h1`, seções com `h2`/`h3`, `nav`, `footer`, imagens com `alt`, largura e altura.
- Logo em WebP, fontes carregadas sem travar a página, cache longo para `/assets/*` (`public/_headers`).

## Domínio

O site usa `https://tchefood.com.br` por padrão. Para outro domínio, defina `VITE_SITE_URL` no build
(ex.: `VITE_SITE_URL=https://www.seudominio.com.br npm run build`) ou no painel da hospedagem.

## Publicar (grátis, sem servidor)

Qualquer hospedagem de site estático serve. Com a **Netlify** (o `netlify.toml` na raiz do repositório já está pronto):

1. Entre em netlify.com com a conta do GitHub → *Add new site* → *Import an existing project* → escolha o repositório.
   A Netlify lê o `netlify.toml` (pasta `landing`, comando `npm ci && npm run build`, publica `dist`).
2. Em *Domain management* → *Add a domain* → `tchefood.com.br`. A Netlify mostra os registros de DNS.
3. No registro.br (onde o domínio `.com.br` é comprado), em *DNS* do domínio, use os servidores da Netlify ou crie os
   registros que ela mostrar (apex `A` e `www` `CNAME`). O HTTPS sai sozinho em alguns minutos.
4. No Google Search Console, adicione a propriedade `tchefood.com.br`, confirme pelo DNS e envie `https://tchefood.com.br/sitemap.xml`.

Cloudflare Pages e Vercel funcionam igual: pasta raiz `landing`, comando `npm run build`, saída `dist`.

## Calculadora

A lógica fica em `src/lib/calculadora.ts`, com as premissas em `PREMISSAS`. A página mostra essas premissas em "Ver premissas do cálculo".
