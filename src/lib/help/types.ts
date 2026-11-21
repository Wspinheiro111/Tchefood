/** Central de ajuda: formato dos artigos. O texto fica em articles*.ts; a tela em screens/HelpCenter.tsx. */
import type { UserRole } from '../../types';

/** Para quem o artigo serve. COURIER (entregador) não entra no app: o artigo é para quem o cadastra. */
export type Audience = Exclude<UserRole, 'KIOSK'> | 'COURIER';
export const AUDIENCE_LABEL: Record<Audience, string> = {
  OWNER: 'Dono',
  MANAGER: 'Gerente',
  CASHIER: 'Caixa',
  WAITER: 'Garçom',
  KITCHEN: 'Cozinha',
  COURIER: 'Entregador',
};
export const AUDIENCES: ReadonlyArray<Audience> = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'COURIER'];

export type HelpBlock =
  | { t: 'p'; text: string }
  | { t: 'h'; text: string }
  | { t: 'steps'; items: string[] }
  | { t: 'list'; items: string[] }
  | { t: 'note'; tone: 'info' | 'warn'; text: string }
  | { t: 'img'; src: string; alt: string; caption: string; wide?: boolean }
  | { t: 'faq'; items: Array<{ q: string; a: string }> }
  /** Tabelas montadas a partir do código (nunca digitadas): o que o menu e as permissões realmente liberam. */
  | { t: 'menuMatrix' }
  | { t: 'permMatrix' }
  | { t: 'backofficeMatrix' };

export type HelpCategory =
  | 'Primeiros passos'
  | 'Equipe, PIN e permissões'
  | 'Dúvidas de cada perfil'
  | 'Salão e atendimento'
  | 'Balcão, caixa e entrega'
  | 'Cozinha e chopp'
  | 'Gestão (Retaguarda)'
  | 'Problemas comuns';

export const CATEGORIES: ReadonlyArray<HelpCategory> = [
  'Primeiros passos',
  'Equipe, PIN e permissões',
  'Dúvidas de cada perfil',
  'Salão e atendimento',
  'Balcão, caixa e entrega',
  'Cozinha e chopp',
  'Gestão (Retaguarda)',
  'Problemas comuns',
];

export interface HelpArticle {
  id: string;
  title: string;
  summary: string;
  category: HelpCategory;
  /** Quem procura este artigo; 'ALL' aparece para todos. */
  audience: ReadonlyArray<Audience> | 'ALL';
  blocks: HelpBlock[];
  related?: string[];
}
