/**
 * Quem vê cada botão do menu principal (rodapé no celular, topo no tablet). App.tsx usa esta
 * tabela e a Central de Ajuda mostra a mesma tabela, para a ajuda não ficar diferente do app.
 * A Retaguarda não entra aqui: ela aparece para quem tem ao menos uma aba liberada (BackOffice.tsx).
 */
import type { UserRole } from '../types';

export type NavKey = 'map' | 'kds' | 'caixa' | 'pickup' | 'ficha' | 'chopp' | 'qr' | 'delivery' | 'board' | 'backoffice';

export const NAV_ACCESS: ReadonlyArray<{ key: NavKey; label: string; roles: ReadonlyArray<UserRole> }> = [
  { key: 'map', label: 'Mesas', roles: ['WAITER', 'MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'kds', label: 'KDS', roles: ['KITCHEN', 'MANAGER', 'OWNER'] },
  { key: 'caixa', label: 'Caixa', roles: ['CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'pickup', label: 'PDV / Caixa', roles: ['CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'ficha', label: 'Ficha Rápida', roles: ['WAITER', 'CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'chopp', label: 'Chopp', roles: ['KITCHEN', 'CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'qr', label: 'QR Cliente', roles: ['WAITER', 'MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'delivery', label: 'Delivery', roles: ['MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'board', label: 'Painel TV', roles: ['MANAGER', 'OWNER', 'CASHIER', 'KITCHEN'] },
  // Retaguarda: aparece para quem tem ao menos uma aba liberada (perfil ou permissão).
  { key: 'backoffice', label: 'Retaguarda', roles: [] },
];
