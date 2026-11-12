/**
 * Tudo o que os buscadores leem fora do texto visível: título, descrição, palavras-chave,
 * dados estruturados (JSON-LD), sitemap.xml e robots.txt. O build (scripts/prerender.mjs)
 * grava isso no index.html e na pasta dist/.
 */
import { EMPRESA, PLANOS, SITE_URL, WHATSAPP_NUMERO } from './config';
import { PERGUNTAS } from './faq';
import { todasAsFuncoes } from './funcionalidades';

export const SEO = {
  titulo: 'Tchê Food: Sistema para Restaurantes, Bares e Delivery',
  descricao:
    'Sistema para restaurantes, bares e delivery: PDV, comanda no celular, KDS, totem de autoatendimento, cardápio digital QR Code, NFC-e e cashback. Funciona offline.',
  palavrasChave: [
    'sistema para restaurantes',
    'sistema para bares',
    'sistema para delivery',
    'PDV para restaurante',
    'comanda eletrônica',
    'comanda no celular',
    'KDS',
    'tela de cozinha',
    'totem de autoatendimento',
    'cardápio digital',
    'cardápio QR Code',
    'NFC-e',
    'sistema para churrascaria',
    'sistema para pizzaria',
    'sistema para lancheria',
    'controle de caixa',
    'cashback',
    'TEF',
  ],
  imagem: 'og-image.png',
  imagemLargura: 1200,
  imagemAltura: 630,
};

export function urlAbsoluta(caminho = ''): string {
  return `${SITE_URL}/${caminho.replace(/^\/+/, '')}`;
}

/** Grafo JSON-LD da página: Organization, WebSite, SoftwareApplication (com as ofertas dos planos) e FAQPage. */
export function jsonLd(): Record<string, unknown> {
  const org = `${SITE_URL}/#organizacao`;
  const app = `${SITE_URL}/#software`;
  const planosComPreco = PLANOS.filter((p) => p.precoMensal !== null);
  const precos = planosComPreco.map((p) => p.precoMensal as number);
  const recursos = todasAsFuncoes()
    .filter((f) => f.status !== 'em-breve')
    .map((f) => f.titulo);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: EMPRESA.fabricante,
        url: urlAbsoluta(),
        logo: urlAbsoluta('icon-512.png'),
        brand: { '@type': 'Brand', name: EMPRESA.produto },
        contactPoint: {
          '@type': 'ContactPoint',
          telephone: `+${WHATSAPP_NUMERO}`,
          contactType: 'sales',
          areaServed: 'BR',
          availableLanguage: 'Portuguese',
        },
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#site`,
        url: urlAbsoluta(),
        name: EMPRESA.produto,
        inLanguage: 'pt-BR',
        publisher: { '@id': org },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': app,
        name: EMPRESA.produto,
        alternateName: `${EMPRESA.produto} — ${EMPRESA.tagline}`,
        description: SEO.descricao,
        url: urlAbsoluta(),
        image: urlAbsoluta(SEO.imagem),
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Sistema para restaurantes (PDV)',
        operatingSystem: 'Web, Android',
        inLanguage: 'pt-BR',
        publisher: { '@id': org },
        featureList: recursos,
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'BRL',
          lowPrice: Math.min(...precos).toFixed(2),
          highPrice: Math.max(...precos).toFixed(2),
          offerCount: planosComPreco.length,
          offers: planosComPreco.map((p) => ({
            '@type': 'Offer',
            name: p.nome,
            description: p.publico,
            price: (p.precoMensal as number).toFixed(2),
            priceCurrency: 'BRL',
            url: urlAbsoluta(`#planos`),
            availability: 'https://schema.org/InStock',
            priceSpecification: {
              '@type': 'UnitPriceSpecification',
              price: (p.precoMensal as number).toFixed(2),
              priceCurrency: 'BRL',
              billingDuration: 'P1M',
              unitText: 'mês',
            },
          })),
        },
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: PERGUNTAS.map(({ p, r }) => ({
          '@type': 'Question',
          name: p,
          acceptedAnswer: { '@type': 'Answer', text: r },
        })),
      },
    ],
  };
}

/**
 * Serializa um valor para dentro de <script type="application/ld+json">: "<" vira \u003c, então
 * nenhum texto (nem "</script>") consegue fechar a tag. U+2028/U+2029 também saem escapados.
 */
export function jsonParaScript(valor: unknown): string {
  return JSON.stringify(valor)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** JSON-LD da página pronto para o <head>. */
export function jsonLdSeguroParaHtml(): string {
  return jsonParaScript(jsonLd());
}

/**
 * sitemap.xml. `dataModificacao` (AAAA-MM-DD) é a data do último commit que mexeu na landing,
 * não a data do build: sem ela (build fora do git), o <lastmod> fica de fora em vez de inventar.
 */
export function sitemapXml(dataModificacao?: string | null): string {
  const lastmod = dataModificacao && /^\d{4}-\d{2}-\d{2}$/.test(dataModificacao) ? dataModificacao : null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${urlAbsoluta()}</loc>`,
    ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');
}

export function robotsTxt(): string {
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${urlAbsoluta('sitemap.xml')}`, ''].join('\n');
}
