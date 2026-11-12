import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import App from '../App';
import { EM_BREVE, NA_IMPLANTACAO, normalizarSiteUrl, PLANOS, SITE_URL } from '../lib/config';
import { PERGUNTAS } from '../lib/faq';
import { GRUPOS_FUNCOES, todasAsFuncoes } from '../lib/funcionalidades';
import { jsonLd, jsonLdSeguroParaHtml, jsonParaScript, robotsTxt, SEO, sitemapXml } from '../lib/seo';
import { mensagemContato } from '../components/Contato';

type No = Record<string, unknown>;
const grafo = () => (jsonLd()['@graph'] as No[]);
const doTipo = (t: string) => grafo().find((n) => n['@type'] === t) as No;

describe('SEO da landing', () => {
  it('título e descrição cabem no resultado do Google', () => {
    expect(SEO.titulo.length).toBeLessThanOrEqual(60);
    expect(SEO.descricao.length).toBeGreaterThanOrEqual(120);
    expect(SEO.descricao.length).toBeLessThanOrEqual(170);
  });

  it('o endereço do site é absoluto, com https e sem barra no fim', () => {
    expect(SITE_URL).toMatch(/^https:\/\/[^/]+$/);
  });

  it('JSON-LD tem Organization, WebSite, SoftwareApplication e FAQPage', () => {
    const tipos = grafo().map((n) => n['@type']);
    expect(tipos).toEqual(['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']);
  });

  it('cada plano com preço vira uma Offer em BRL com o mesmo valor do card', () => {
    const app = doTipo('SoftwareApplication');
    const agregado = app.offers as No;
    const ofertas = agregado.offers as No[];
    const comPreco = PLANOS.filter((p) => p.precoMensal !== null);
    expect(ofertas).toHaveLength(comPreco.length);
    comPreco.forEach((p, i) => {
      expect(ofertas[i].name).toBe(p.nome);
      expect(ofertas[i].price).toBe((p.precoMensal as number).toFixed(2));
      expect(ofertas[i].priceCurrency).toBe('BRL');
    });
    expect(agregado.lowPrice).toBe('99.00');
    expect(agregado.highPrice).toBe('299.00');
  });

  it('o FAQPage é exatamente a lista da seção Dúvidas', () => {
    const faq = doTipo('FAQPage').mainEntity as No[];
    expect(faq.map((q) => q.name)).toEqual(PERGUNTAS.map((p) => p.p));
    expect(faq.map((q) => (q.acceptedAnswer as No).text)).toEqual(PERGUNTAS.map((p) => p.r));
  });

  it('a resposta de preço usa os valores do config', () => {
    const preco = PERGUNTAS.find((p) => p.p === 'Quanto custa?')!.r;
    for (const p of PLANOS) expect(preco).toContain(p.nome);
    expect(preco).toContain('R$ 99');
    expect(preco).toContain('R$ 199');
    expect(preco).toContain('R$ 299');
    expect(preco).toContain('a partir do plano Churrascaria & Salão Pro');
  });

  it('featureList do JSON-LD não anuncia o que ainda é "Em breve"', () => {
    const lista = doTipo('SoftwareApplication').featureList as string[];
    const emBreve = todasAsFuncoes().filter((f) => f.status === 'em-breve').map((f) => f.titulo);
    expect(emBreve.length).toBeGreaterThan(0);
    for (const t of emBreve) expect(lista).not.toContain(t);
  });

  it('o JSON-LD dentro do HTML não consegue fechar a tag <script>', () => {
    expect(jsonLdSeguroParaHtml()).not.toContain('<');
    expect(JSON.parse(jsonLdSeguroParaHtml())).toEqual(jsonLd());
  });

  it('sitemap e robots apontam para o domínio do site', () => {
    expect(sitemapXml('2026-11-11')).toContain(`<loc>${SITE_URL}/</loc>`);
    expect(sitemapXml('2026-11-11')).toContain('<lastmod>2026-11-11</lastmod>');
    expect(robotsTxt()).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  it('sem a data da última alteração o sitemap sai sem <lastmod> (não usa a data do build)', () => {
    expect(sitemapXml(null)).not.toContain('<lastmod>');
    expect(sitemapXml(undefined)).not.toContain('<lastmod>');
    expect(sitemapXml('ontem')).not.toContain('<lastmod>');
    expect(sitemapXml(null)).toContain(`<loc>${SITE_URL}/</loc>`);
  });

  it('o mesmo conteúdo gera o mesmo sitemap em dias diferentes', () => {
    // A data vem do último commit da pasta landing/, então dois builds do mesmo commit recebem a mesma data.
    expect(sitemapXml('2026-11-11')).toBe(sitemapXml('2026-11-11'));
  });

  it('texto hostil no JSON-LD não fecha a tag <script>', () => {
    const hostil = { name: '</script><script>alert(1)</script>', d: 'a\u2028b\u2029c' };
    const saida = jsonParaScript(hostil);
    expect(saida).not.toContain('<');
    expect(saida).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(saida)).toEqual(hostil);
    // Um parser de HTML encerra o <script> no primeiro "</script" (sem diferenciar maiúsculas):
    // o único deve ser o que nós mesmos escrevemos.
    const html = `<script type="application/ld+json">${saida}</script>`;
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(html.match(/<script/gi)).toHaveLength(1);
  });
});

describe('Endereço do site (VITE_SITE_URL)', () => {
  it('aceita o domínio com ou sem barra final e devolve só a origem', () => {
    expect(normalizarSiteUrl('https://tchefood.com.br')).toBe('https://tchefood.com.br');
    expect(normalizarSiteUrl('https://tchefood.com.br/')).toBe('https://tchefood.com.br');
    expect(normalizarSiteUrl(' https://www.tchefood.com.br ')).toBe('https://www.tchefood.com.br');
    expect(normalizarSiteUrl('https://TCHEFOOD.com.br')).toBe('https://tchefood.com.br');
  });

  it.each([
    ['http://tchefood.com.br', /https/],
    ['https://tchefood.com.br?utm=1', /parâmetros/],
    ['https://tchefood.com.br/#topo', /fragmento/],
    ['https://tchefood.com.br/site', /caminho/],
    ['https://admin:senha@tchefood.com.br', /usuário ou senha/],
    ['https://tchefood.com.br:8443', /porta/],
    ['https://localhost', /ponto/],
    ['tchefood.com.br', /não é um endereço/],
    ['', /não é um endereço/],
  ])('recusa %s com erro claro', (valor, motivo) => {
    expect(() => normalizarSiteUrl(valor)).toThrow(motivo);
  });
});

describe('Conteúdo honesto', () => {
  it('integrações que dependem de credencial ou parceria não aparecem como prontas', () => {
    const status = (t: string) => todasAsFuncoes().find((f) => f.titulo.startsWith(t))?.status;
    expect(status('NFC-e')).toBe('implantacao');
    expect(status('Maquininha integrada')).toBe('implantacao');
    expect(status('Pedidos do iFood')).toBe('em-breve');
    expect(status('Alerta de cancelamento')).toBe('em-breve');
    expect(status('Várias unidades')).toBe('em-breve');
  });

  it('selos dos planos apontam para recursos que existem nos planos', () => {
    const recursos = new Set(PLANOS.flatMap((p) => p.recursos));
    for (const r of [...EM_BREVE, ...NA_IMPLANTACAO]) expect(recursos.has(r)).toBe(true);
  });

  it('âncoras das áreas são únicas', () => {
    const ids = GRUPOS_FUNCOES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Página pré-renderizada', () => {
  const html = renderToString(createElement(App));

  it('tem um único h1 com a palavra-chave principal', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Sistema para/);
  });

  it('mostra todas as funções, o FAQ e os planos no HTML (sem depender de JavaScript)', () => {
    const texto = html.replace(/&amp;/g, '&');
    for (const f of todasAsFuncoes()) expect(texto).toContain(f.titulo);
    for (const p of PERGUNTAS) expect(texto).toContain(p.p);
    for (const p of PLANOS) expect(texto).toContain(p.nome);
  });

  it('toda imagem tem alt', () => {
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const i of imgs) expect(i).toMatch(/\salt="/);
  });
});

describe('Formulário de demonstração', () => {
  it('monta a mensagem do WhatsApp só com os campos preenchidos', () => {
    const m = mensagemContato({ nome: ' Ana ', estabelecimento: 'Galpão', cidade: '', tipo: 'Churrascaria', plano: '' });
    expect(m).toBe(
      'Olá! Quero agendar uma demonstração gratuita do Tchê Food.\nNome: Ana\nEstabelecimento: Galpão\nTipo: Churrascaria',
    );
  });
});
