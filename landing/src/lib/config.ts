/**
 * Configuração comercial da landing page.
 * Tudo que o Will precisa trocar antes de publicar fica AQUI.
 */

/** Número do WhatsApp comercial no formato internacional, só dígitos (ex.: 5551999998888). */
export const WHATSAPP_NUMERO = '5555996538255'; // (55) 99653-8255 — W9 Sistemas

export const EMPRESA = {
  produto: 'Tchê Food',
  tagline: 'Da Comanda à Maquininha',
  fabricante: 'W9 Sistemas',
};

/**
 * Nome DNS válido na forma em que o `URL` o entrega (minúsculo, nomes acentuados já em punycode
 * `xn--`): até 253 caracteres, rótulos de 1 a 63 caracteres com a-z, 0-9 e hífen, sem hífen no
 * começo ou no fim, sem rótulo vazio (`..`, ponto inicial ou final) e com a terminação não só de
 * números (recusa IP).
 */
function hostnameDnsValido(host: string): boolean {
  if (host.length > 253) return false;
  const rotulos = host.split('.');
  if (rotulos.length < 2) return false;
  const rotuloOk = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  if (!rotulos.every((r) => rotuloOk.test(r))) return false;
  return !/^\d+$/.test(rotulos[rotulos.length - 1]);
}

/**
 * Confere o endereço do site e devolve a origem sem barra no fim (ex.: https://tchefood.com.br).
 * Recusa com erro claro, que derruba o build: endereço malformado, sem https, com usuário/senha,
 * porta, caminho (o site é publicado na raiz do domínio), query ou fragmento.
 */
export function normalizarSiteUrl(bruto: string): string {
  const texto = bruto.trim();
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    throw new Error(`VITE_SITE_URL inválido: "${bruto}" não é um endereço. Use, por exemplo, https://tchefood.com.br`);
  }
  const problemas: string[] = [];
  if (url.protocol !== 'https:') problemas.push('precisa começar com https://');
  if (url.username || url.password) problemas.push('não pode ter usuário ou senha');
  if (url.port) problemas.push('não pode ter porta');
  if (url.pathname !== '/') problemas.push('não pode ter caminho: o site fica na raiz do domínio');
  if (url.search || texto.includes('?')) problemas.push('não pode ter ?parâmetros');
  if (url.hash || texto.includes('#')) problemas.push('não pode ter #fragmento');
  if (!url.hostname.includes('.')) problemas.push('o domínio precisa ter ponto (ex.: tchefood.com.br)');
  else if (!hostnameDnsValido(url.hostname))
    problemas.push('o domínio não é um nome válido (só letras, números e hífen, sem partes vazias, hífen nas pontas ou final só com números)');
  if (problemas.length) throw new Error(`VITE_SITE_URL inválido ("${bruto}"): ${problemas.join('; ')}.`);
  return url.origin;
}

/**
 * Endereço público do site, sem barra no fim. Usado no canonical, nas tags OG, no JSON-LD,
 * no sitemap.xml e no robots.txt. Troque com a variável de ambiente VITE_SITE_URL no build
 * (ou no arquivo .env) quando o domínio definitivo estiver registrado.
 */
// `??` e não `||`: só a variável AUSENTE usa o padrão. VITE_SITE_URL="" (ou só espaços) é erro de
// configuração e derruba o build, em vez de publicar com o domínio padrão sem ninguém perceber.
export const SITE_URL = normalizarSiteUrl(import.meta.env?.VITE_SITE_URL ?? 'https://tchefood.com.br');

export interface Plano {
  id: 'bistro' | 'salao-pro' | 'rede-eventos';
  nome: string;
  publico: string;
  /** Mensalidade em reais. `null` = ainda não definido, a página mostra "Sob consulta". */
  precoMensal: number | null;
  destaque: boolean;
  limites: string[];
  recursos: string[];
}

export const PLANOS: Plano[] = [
  {
    id: 'bistro',
    nome: 'Bistrô & Lancheria',
    publico: 'Lancherias, cafés, bistrôs e operações de balcão',
    precoMensal: 99,
    destaque: false,
    limites: ['1 unidade', 'Garçons ilimitados', 'Sem TEF integrado'],
    recursos: [
      'Comanda no celular do garçom',
      'NFC-e modelo 65 (SEFAZ-RS)',
      'Cardápio QR Code na mesa',
      'Impressão em bobina 58/80 mm',
      'Relatórios de vendas e caixa',
    ],
  },
  {
    id: 'salao-pro',
    nome: 'Churrascaria & Salão Pro',
    publico: 'Restaurantes com salão, churrascarias e pizzarias',
    precoMensal: 199,
    destaque: true,
    limites: ['1 unidade', 'Maquininhas ilimitadas', 'Garçons ilimitados'],
    recursos: [
      'Tudo do Bistrô & Lancheria',
      'TEF integrado à maquininha Stone ou PagBank',
      'Rachadinha na maquininha, na mesa',
      'Mapa de mesas e tela de cozinha (KDS)',
      'Cancelamento só com PIN de gerente',
      'Alerta de cancelamento no WhatsApp',
      'Taxa de serviço configurável, com rateio por garçom',
      'Painel do proprietário em tempo real',
    ],
  },
  {
    id: 'rede-eventos',
    nome: 'Rede & Eventos',
    publico: 'Redes, cervejarias, bailes, festas e food trucks',
    precoMensal: 299,
    destaque: false,
    limites: ['Várias unidades', 'Maquininhas ilimitadas', 'Garçons ilimitados'],
    recursos: [
      'Tudo do Churrascaria & Salão Pro',
      'Painel consolidado de todas as unidades',
      'Ficha rápida para balcão e eventos',
      'Controle de barril de chopp',
      'Cashback e fidelidade no WhatsApp',
      'Suporte prioritário na implantação',
    ],
  },
];

/** Recursos anunciados que ainda estão em desenvolvimento (aparecem com selo "Em breve"). */
export const EM_BREVE = new Set<string>([
  'Painel consolidado de todas as unidades',
  'Alerta de cancelamento no WhatsApp',
]);

/**
 * Recursos prontos no sistema que dependem de credencial ou contrato da própria loja
 * (certificado A1 e CSC na Focus NFe, contrato da maquininha). Aparecem com o selo
 * "Ativado na implantação".
 */
export const NA_IMPLANTACAO = new Set<string>([
  'NFC-e modelo 65 (SEFAZ-RS)',
  'TEF integrado à maquininha Stone ou PagBank',
]);

export function linkWhatsApp(mensagem: string): string {
  return `https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(mensagem)}`;
}
