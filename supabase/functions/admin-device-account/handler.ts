// supabase/functions/admin-device-account/handler.ts
//
// Regra da função admin-device-account (index.ts só liga ao Supabase). Testada em
// supabase/functions/tests/admin-device-account.test.ts.
//
// Cria ou troca a senha da conta do Supabase Auth que o aparelho da loja usa para entrar
// na nuvem (app_metadata.tenant_id = id da loja, que o hook copia para o JWT).
//   1) Com o token de quem chama, tchefood_admin_store prova que é admin do painel e que a
//      loja existe (o banco recusa token de loja e quem não está em platform_admins).
//   2) tchefood_admin_reserve_device reserva o id e o e-mail da conta (repetir devolve a
//      mesma reserva). A conta é criada no Auth com esse id: se a função cair no meio, a
//      próxima chamada continua da reserva, sem conta solta.
//   3) Com a service role, cria a conta (ou troca a senha) e só mexe em conta cujo
//      tenant_id e e-mail conferem com a reserva.
//   4) tchefood_admin_confirm_device marca a conta como pronta e grava no histórico.
// A senha nova volta uma vez só na resposta; não fica gravada em lugar nenhum.

export interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export interface AuthUser {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
}

export interface AuthAdmin {
  getUserById(id: string): Promise<{ user: AuthUser | null; error: { message: string; status?: number } | null }>;
  createUser(attrs: { id: string; email: string; password: string; email_confirm: boolean; app_metadata: Record<string, unknown> }): Promise<{ error: { message: string } | null }>;
  updateUserById(id: string, attrs: { password: string; app_metadata: Record<string, unknown> }): Promise<{ error: { message: string } | null }>;
}

export interface DeviceAccountDeps {
  /** RPC com o token de quem chamou (o banco confere o admin). */
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
  auth: AuthAdmin;
  randomPassword(): string;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function fail(status: number, message: string): HandlerResult {
  return { status, body: { message } };
}

function rpcFailure(error: { message: string; code?: string }): HandlerResult {
  const message = error.message.replace(/^TCHEFOOD_ADMIN:\s*/, '');
  if (error.code === '42501') return fail(403, message);
  if (/não encontrada/.test(message)) return fail(404, message);
  return fail(400, message);
}

export function suggestedDeviceEmail(cnpj: string): string {
  return `loja-${cnpj.replace(/\D/g, '')}@aparelho.tchefood.com.br`;
}

/** Senha de 20 caracteres sem letras parecidas (0/O, 1/l/I), sorteada sem viés. */
export function randomPasswordFrom(getRandomValues: (a: Uint8Array) => Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < 20) {
    const buf = getRandomValues(new Uint8Array(32));
    for (const b of buf) {
      if (b < limit && out.length < 20) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** A conta existente só é usada se for desta loja (ou ainda sem loja) e com o e-mail reservado. */
function sameAccount(user: AuthUser, tenantId: string, email: string): boolean {
  const meta = user.app_metadata ?? {};
  const tenant = typeof meta.tenant_id === 'string' && meta.tenant_id ? meta.tenant_id : null;
  return (tenant === null || tenant === tenantId) && (user.email ?? '').toLowerCase() === email.toLowerCase();
}

export async function handleDeviceAccount(input: unknown, deps: DeviceAccountDeps): Promise<HandlerResult> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const tenantId = body.tenant_id;
  const action = body.action;
  const email = body.email;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return fail(400, 'tenant_id inválido.');
  if (action !== 'create' && action !== 'reset_password') return fail(400, 'Ação inválida.');
  if (email !== undefined && (typeof email !== 'string' || !EMAIL.test(email.trim()) || email.length > 200)) return fail(400, 'E-mail inválido.');

  // 1) Admin e loja, pelo banco.
  const store = await deps.rpc('tchefood_admin_store', { p_tenant: tenantId });
  if (store.error) return rpcFailure(store.error);
  const detail = (store.data ?? {}) as { cnpj?: string; subscription?: { device_status?: string | null } | null };
  if (!detail.subscription) return fail(409, 'Crie a assinatura da loja antes da conta do aparelho.');
  const deviceStatus = detail.subscription.device_status ?? null;
  if (action === 'create' && deviceStatus === 'READY') return fail(409, 'A loja já tem conta do aparelho. Use "Trocar senha".');
  if (action === 'reset_password' && deviceStatus !== 'READY') return fail(409, 'A loja ainda não tem conta do aparelho pronta. Use "Criar conta".');

  // 2) Reserva (ou a já existente).
  const reserve = await deps.rpc('tchefood_admin_reserve_device', {
    p_tenant: tenantId,
    p_email: (typeof email === 'string' ? email.trim() : '') || suggestedDeviceEmail(detail.cnpj ?? ''),
  });
  if (reserve.error) return rpcFailure(reserve.error);
  let r = (reserve.data ?? {}) as { user_id?: string; email?: string; status?: string };
  if (typeof r.user_id !== 'string' || !UUID.test(r.user_id) || typeof r.email !== 'string') return fail(500, 'Reserva da conta inválida.');

  // 3) Auth, com a service role.
  const lookup = async (id: string) => {
    const res = await deps.auth.getUserById(id);
    const missing = !res.user && (!res.error || res.error.status === 404 || /not found/i.test(res.error.message));
    return { user: res.user, failed: !res.user && !missing };
  };
  let existing = await lookup(r.user_id);
  if (existing.failed) return fail(502, 'Não foi possível consultar a conta no Supabase Auth. Tente de novo.');

  // Reserva pendente com outro e-mail (a criação anterior foi recusada, ex.: e-mail já usado
  // no Auth): troca por uma reserva nova, só se a conta do id reservado não existe no Auth.
  const wanted = typeof email === 'string' ? email.trim().toLowerCase() : null;
  if (action === 'create' && r.status === 'PENDING' && wanted && wanted !== r.email.toLowerCase() && !existing.user) {
    const replaced = await deps.rpc('tchefood_admin_reserve_device', { p_tenant: tenantId, p_email: wanted, p_replace_user_id: r.user_id });
    if (replaced.error) return rpcFailure(replaced.error);
    r = (replaced.data ?? {}) as typeof r;
    if (typeof r.user_id !== 'string' || !UUID.test(r.user_id) || typeof r.email !== 'string') return fail(500, 'Reserva da conta inválida.');
    existing = await lookup(r.user_id);
    if (existing.failed) return fail(502, 'Não foi possível consultar a conta no Supabase Auth. Tente de novo.');
  }
  const userId = r.user_id;
  const accountEmail = r.email;
  const password = deps.randomPassword();
  const appMetadata = { tenant_id: tenantId };

  if (existing.user) {
    if (!sameAccount(existing.user, tenantId, accountEmail)) return fail(409, 'A conta reservada não confere com esta loja. Nada foi alterado.');
    const upd = await deps.auth.updateUserById(userId, { password, app_metadata: appMetadata });
    if (upd.error) return fail(502, 'Não foi possível trocar a senha no Supabase Auth. Tente de novo.');
  } else {
    if (action === 'reset_password') return fail(409, 'A conta do aparelho não existe mais no Supabase Auth. Fale com o suporte.');
    const created = await deps.auth.createUser({ id: userId, email: accountEmail, password, email_confirm: true, app_metadata: appMetadata });
    if (created.error) {
      if (/already|exists|registered/i.test(created.error.message)) return fail(409, 'Já existe outra conta com este e-mail no Supabase Auth. Digite outro e-mail e toque em "Criar conta do aparelho" de novo.');
      return fail(502, 'Não foi possível criar a conta no Supabase Auth. Tente de novo.');
    }
  }

  // 4) Pronta.
  const confirm = await deps.rpc('tchefood_admin_confirm_device', {
    p_tenant: tenantId,
    p_user_id: userId,
    p_action: action === 'reset_password' ? 'PASSWORD_RESET' : 'CREATED',
  });
  if (confirm.error) return fail(500, 'A conta foi criada, mas o painel não registrou. Toque de novo em "Criar conta" para concluir (gera uma senha nova).');
  return { status: 200, body: { user_id: userId, email: accountEmail, password } };
}
