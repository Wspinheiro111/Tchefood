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
    limites: ['1 unidade', 'Até 2 maquininhas', 'Garçons ilimitados'],
    recursos: [
      'Comanda no celular do garçom',
      'Divisão de conta na maquininha',
      'NFC-e automática (SEFAZ-RS)',
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
      'Mapa de mesas e tela de cozinha (KDS)',
      'Cancelamento só com PIN de gerente',
      'Alerta de cancelamento no WhatsApp',
      'Taxa de serviço e couvert configuráveis',
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
  'Ficha rápida para balcão e eventos',
  'Controle de barril de chopp',
  'Cashback e fidelidade no WhatsApp',
]);

export function linkWhatsApp(mensagem: string): string {
  return `https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(mensagem)}`;
}
