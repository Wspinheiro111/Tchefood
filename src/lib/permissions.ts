/**
 * Etapa 0 — permissões por perfil.
 * O padrão vale para toda loja; a tabela role_permissions guarda só as exceções.
 * Proprietário pode tudo e não pode perder acesso (evita a loja trancada para fora).
 */
import type { Permission, RolePermission, UserRole } from '../types';

export const PERMISSIONS: ReadonlyArray<Permission> = [
  'MENU_MANAGE',
  'MENU_AVAILABILITY',
  'TABLES_MANAGE',
  'STAFF_MANAGE',
  'STORE_SETTINGS',
  'SYNC_MANAGE',
];

export const PERMISSION_LABEL: Record<Permission, string> = {
  MENU_MANAGE: 'Editar cardápio, preços e adicionais',
  MENU_AVAILABILITY: 'Marcar produto como esgotado',
  TABLES_MANAGE: 'Cadastrar mesas e áreas',
  STAFF_MANAGE: 'Cadastrar equipe e PINs',
  STORE_SETTINGS: 'Dados da loja e taxa de serviço',
  SYNC_MANAGE: 'Conectar o aparelho à nuvem',
};

export const DEFAULT_PERMISSIONS: Record<Permission, ReadonlyArray<UserRole>> = {
  MENU_MANAGE: ['OWNER', 'MANAGER'],
  MENU_AVAILABILITY: ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN'],
  TABLES_MANAGE: ['OWNER', 'MANAGER'],
  STAFF_MANAGE: ['OWNER', 'MANAGER'],
  STORE_SETTINGS: ['OWNER'],
  SYNC_MANAGE: ['OWNER', 'MANAGER'],
};

/** Perfis que podem ganhar ou perder uma permissão na tela (o proprietário é fixo). */
export const CONFIGURABLE_ROLES: ReadonlyArray<UserRole> = ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'];

export function can(role: UserRole | undefined | null, permission: Permission, overrides: RolePermission[]): boolean {
  if (!role) return false;
  if (role === 'OWNER') return true;
  const o = overrides.find((r) => r.role === role && r.permission === permission);
  if (o) return o.allowed;
  return DEFAULT_PERMISSIONS[permission].includes(role);
}
