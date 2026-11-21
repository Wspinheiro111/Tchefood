import { ARTICLES_EQUIPE } from './articlesEquipe';
import { ARTICLES_OPERACAO } from './articlesOperacao';
import { ARTICLES_PERFIS } from './articlesPerfis';
import type { HelpArticle } from './types';

export const HELP_ARTICLES: ReadonlyArray<HelpArticle> = [...ARTICLES_EQUIPE, ...ARTICLES_PERFIS, ...ARTICLES_OPERACAO];

/**
 * Abas da Retaguarda liberadas POR PADRÃO para cada perfil (sem exceções do dono). O teste da ajuda
 * confere esta tabela com `useBackOfficeTabs`; se alguém mudar a regra no app, o teste falha.
 */
export const BACKOFFICE_HELP: ReadonlyArray<{ label: string; about: string; roles: ReadonlyArray<'OWNER' | 'MANAGER' | 'CASHIER'> }> = [
  { label: 'Painel do dono', about: 'Vendas, metas, mais vendidos, avisos', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Taxas e recebíveis', about: 'Taxas da maquininha e agenda (só consulta para o caixa)', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Fechamento anual', about: 'Relatórios para a contabilidade', roles: ['OWNER', 'MANAGER'] },
  { label: 'Entrega própria', about: 'Bairros e entregadores (só consulta para o caixa)', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Turno', about: 'Faturamento do turno', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Conciliação', about: 'Entradas por adquirente e método', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Rateio 10%', about: 'Comissão por garçom', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Anti-Fraude', about: 'Cancelamentos, descontos, PIN errado', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Barris de chopp', about: 'Aproveitamento dos barris', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Clientes & Cashback', about: 'Fidelidade e campanha de volta', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'NFC-e', about: 'Notas fiscais', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Compras / Estoque', about: 'Entrada de notas (só gerente e dono)', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Cardápio', about: 'Preços e adicionais (caixa só marca esgotado)', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Salão', about: 'Mesas, áreas e cartões', roles: ['OWNER', 'MANAGER'] },
  { label: 'Equipe', about: 'Pessoas e PINs', roles: ['OWNER', 'MANAGER'] },
  { label: 'Loja', about: 'Dados da loja e permissões', roles: ['OWNER'] },
  { label: 'Nuvem', about: 'Conexão e sincronização', roles: ['OWNER', 'MANAGER'] },
  { label: 'Impressoras', about: 'Impressoras por praça', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  { label: 'Ajustes', about: 'Meio a meio, som, fila offline', roles: ['OWNER', 'MANAGER', 'CASHIER'] },
];
