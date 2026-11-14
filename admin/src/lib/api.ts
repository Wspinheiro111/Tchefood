/**
 * Cliente do painel administrativo: entra no Supabase Auth (e-mail e senha da equipe do
 * Tchê Food, conta sem loja) e chama só as funções tchefood_admin_* do banco
 * (db/schema_painel_admin.sql) e a função admin-device-account. Nada é lido direto das
 * tabelas: o banco confere o admin em cada chamada.
 */

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface AdminConfig {
  url: string;
  anonKey: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Quando o token vence (ms desde 1970). */
  expiresAt: number;
  email: string;
}

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

/** Mensagem para a tela: tira o prefixo das mensagens do banco. */
export function cleanError(message: string): string {
  return message.replace(/^TCHEFOOD_ADMIN:\s*/, '').trim();
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function readJson(res: { text: () => Promise<string> }): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const m = b.message ?? b.msg ?? b.error_description ?? b.error;
    if (typeof m === 'string' && m) return cleanError(m);
  }
  if (typeof body === 'string' && body) return cleanError(body);
  return fallback;
}

function sessionFrom(body: unknown, email: string, now: number): Session {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string') throw new AdminApiError('Resposta de login inválida.', 500);
  const expiresIn = typeof b.expires_in === 'number' ? b.expires_in : 3600;
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: now + expiresIn * 1000, email };
}

export async function signIn(cfg: AdminConfig, email: string, password: string, fetchFn: FetchLike, now = Date.now()): Promise<Session> {
  const res = await fetchFn(`${normalizeUrl(cfg.url)}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new AdminApiError(res.status === 400 ? 'E-mail ou senha incorretos.' : errorMessage(body, 'Não foi possível entrar.'), res.status);
  return sessionFrom(body, email.trim().toLowerCase(), now);
}

/**
 * Troca o refresh token por um token novo. Só 400/401 do Auth (refresh token inválido,
 * invalid_grant) vira AdminApiError(401), que encerra a sessão. Queda de rede vira status 0
 * e 5xx/429 (ou outra resposta) vira 503: a sessão continua e a chamada pode ser repetida.
 */
export async function refreshSession(cfg: AdminConfig, session: Session, fetchFn: FetchLike, now = Date.now()): Promise<Session> {
  let res: Awaited<ReturnType<FetchLike>>;
  let body: unknown;
  try {
    res = await fetchFn(`${normalizeUrl(cfg.url)}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    body = await readJson(res);
  } catch {
    throw new AdminApiError('Sem conexão com o servidor para renovar a sessão. Tente de novo.', 0);
  }
  if (res.status === 400 || res.status === 401) throw new AdminApiError('Sessão expirada. Entre de novo.', 401);
  if (!res.ok) throw new AdminApiError('O servidor não renovou a sessão agora. Tente de novo em instantes.', 503);
  try {
    return sessionFrom(body, session.email, now);
  } catch {
    throw new AdminApiError('Resposta inválida ao renovar a sessão. Tente de novo.', 503);
  }
}

/** Sai no servidor (revoga o refresh token). Melhor esforço: falha não impede sair da tela. */
export async function signOut(cfg: AdminConfig, accessToken: string, fetchFn: FetchLike): Promise<void> {
  try {
    await fetchFn(`${normalizeUrl(cfg.url)}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
  } catch {
    /* sem rede: o token vence sozinho em até 1 hora */
  }
}

/** Nome do servidor de um endereço (o que recebe a senha); '' se o endereço não é válido. */
export function hostOf(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Tipos das respostas (valores em reais chegam como número do JSON do banco).
// ---------------------------------------------------------------------------
export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
export type ChargeStatus = 'OPEN' | 'PAID' | 'CANCELLED';
export type PaymentMethod = 'PIX' | 'BOLETO' | 'CARTAO' | 'TRANSFERENCIA' | 'DINHEIRO';

export interface Plan {
  id: string;
  name: string;
  monthly_price: number;
  active: boolean;
}

export interface Subscription {
  plan_id: string;
  monthly_price: number;
  status: SubscriptionStatus;
  billing_day: number;
  trial_ends_on: string | null;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  notes: string | null;
  device_email: string | null;
  device_status: 'PENDING' | 'READY' | null;
  created_at: string;
  updated_at: string;
}

export interface StoreRow {
  tenant_id: string;
  name: string;
  legal_name: string;
  cnpj: string;
  city: string | null;
  state: string | null;
  created_at: string;
  subscription: Subscription | null;
  open_count: number;
  open_amount: number;
  overdue_count: number;
  overdue_amount: number;
  oldest_overdue_due: string | null;
  last_order_at: string | null;
  orders_7d: number;
  staff_active: number;
}

export interface Charge {
  id: string;
  reference_month: string;
  amount: number;
  due_date: string;
  status: ChargeStatus;
  payment_link: string | null;
  paid_on: string | null;
  paid_amount: number | null;
  payment_method: PaymentMethod | null;
  payment_reference: string | null;
  cancel_reason: string | null;
  created_at: string;
}

export interface AuditEntry {
  action: string;
  reason: string | null;
  details: Record<string, unknown>;
  created_at: string;
  admin_name: string | null;
}

export interface StoreDetail extends Omit<StoreRow, 'open_count' | 'open_amount' | 'overdue_count' | 'overdue_amount' | 'oldest_overdue_due'> {
  charges: Charge[];
  audit: AuditEntry[];
  orders_30d: number;
}

export interface Overview {
  today: string;
  stores: { trial: number; active: number; suspended: number; cancelled: number; without_subscription: number };
  mrr: number;
  open_amount: number;
  open_count: number;
  overdue_amount: number;
  overdue_count: number;
  received_this_month: number;
  /** Testes que terminam de hoje até daqui a 7 dias. */
  trials_ending_7d: number;
  /** Lojas ainda em TRIAL com o fim do teste antes de hoje. */
  trials_expired: number;
}

export interface DueCharge {
  id: string;
  tenant_id: string;
  store_name: string;
  reference_month: string;
  amount: number;
  due_date: string;
  days_late: number;
  payment_link: string | null;
  contact_name: string;
  contact_phone: string;
  subscription_status: SubscriptionStatus;
}

export interface Me {
  user_id: string;
  email: string;
  name: string;
  today: string;
}

export interface NewStoreInput {
  name: string;
  legalName: string;
  cnpj: string;
  city: string;
  state: string;
  planId: string;
  /** "199.00"; vazio = preço do plano. */
  monthlyPrice: string | null;
  billingDay: number;
  trialDays: number;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  notes: string;
}

export interface SubscriptionInput {
  planId: string;
  monthlyPrice: string;
  status: SubscriptionStatus;
  billingDay: number;
  trialEndsOn: string | null;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  notes: string;
  reason: string;
}

export interface DeviceAccountResult {
  email: string;
  /** Senha nova, mostrada uma vez só. */
  password: string;
  user_id: string;
}

export interface AdminClient {
  me(): Promise<Me>;
  plans(): Promise<Plan[]>;
  overview(): Promise<Overview>;
  stores(): Promise<StoreRow[]>;
  store(tenantId: string): Promise<StoreDetail>;
  chargesDue(days: number): Promise<DueCharge[]>;
  createStore(input: NewStoreInput): Promise<string>;
  saveSubscription(tenantId: string, input: SubscriptionInput): Promise<Subscription>;
  createCharge(tenantId: string, referenceMonth: string, amount: string | null, dueDate: string | null, paymentLink: string | null): Promise<string>;
  generateMonth(referenceMonth: string): Promise<number>;
  recordPayment(chargeId: string, paidAmount: string, paidOn: string, method: PaymentMethod, reference: string): Promise<{ status: ChargeStatus; subscription_status: SubscriptionStatus; replayed: boolean }>;
  cancelCharge(chargeId: string, reason: string): Promise<void>;
  deviceAccount(tenantId: string, action: 'create' | 'reset_password', email?: string): Promise<DeviceAccountResult>;
}

/**
 * `getToken` devolve o token de acesso válido (renovando quando precisa). Um 401 do
 * servidor vira AdminApiError(401) para a tela pedir o login de novo.
 */
export function createAdminClient(cfg: AdminConfig, getToken: () => Promise<string>, fetchFn: FetchLike): AdminClient {
  const base = normalizeUrl(cfg.url);

  async function call<T>(path: string, args: Record<string, unknown>): Promise<T> {
    const token = await getToken();
    const res = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await readJson(res);
    if (!res.ok) {
      const fallback = res.status === 401 ? 'Sessão expirada. Entre de novo.' : res.status === 403 ? 'Acesso restrito à equipe do Tchê Food.' : 'Falha na chamada ao servidor.';
      throw new AdminApiError(errorMessage(body, fallback), res.status);
    }
    return body as T;
  }
  const rpc = <T>(fn: string, args: Record<string, unknown> = {}) => call<T>(`/rest/v1/rpc/${fn}`, args);
  const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

  return {
    me: () => rpc<Me>('tchefood_admin_me'),
    plans: () => rpc<Plan[]>('tchefood_admin_plans'),
    overview: () => rpc<Overview>('tchefood_admin_overview'),
    stores: () => rpc<StoreRow[]>('tchefood_admin_stores'),
    store: (tenantId) => rpc<StoreDetail>('tchefood_admin_store', { p_tenant: tenantId }),
    chargesDue: (days) => rpc<DueCharge[]>('tchefood_admin_charges_due', { p_days: days }),
    createStore: (i) =>
      rpc<string>('tchefood_admin_create_store', {
        p_name: i.name,
        p_legal_name: i.legalName,
        p_cnpj: i.cnpj,
        p_city: blank(i.city),
        p_state: blank(i.state),
        p_plan_id: i.planId,
        p_monthly_price: blank(i.monthlyPrice),
        p_billing_day: i.billingDay,
        p_trial_days: i.trialDays,
        p_contact_name: i.contactName,
        p_contact_phone: i.contactPhone,
        p_contact_email: blank(i.contactEmail),
        p_notes: blank(i.notes),
      }),
    saveSubscription: (tenantId, i) =>
      rpc<Subscription>('tchefood_admin_save_subscription', {
        p_tenant: tenantId,
        p_plan_id: i.planId,
        p_monthly_price: i.monthlyPrice,
        p_status: i.status,
        p_billing_day: i.billingDay,
        p_trial_ends_on: blank(i.trialEndsOn),
        p_contact_name: i.contactName,
        p_contact_phone: i.contactPhone,
        p_contact_email: blank(i.contactEmail),
        p_notes: blank(i.notes),
        p_reason: i.reason,
      }),
    createCharge: (tenantId, referenceMonth, amount, dueDate, paymentLink) =>
      rpc<string>('tchefood_admin_create_charge', {
        p_tenant: tenantId,
        p_reference_month: referenceMonth,
        p_amount: blank(amount),
        p_due_date: blank(dueDate),
        p_payment_link: blank(paymentLink),
      }),
    generateMonth: (referenceMonth) => rpc<number>('tchefood_admin_generate_month', { p_reference_month: referenceMonth }),
    recordPayment: (chargeId, paidAmount, paidOn, method, reference) =>
      rpc('tchefood_admin_record_payment', { p_charge: chargeId, p_paid_amount: paidAmount, p_paid_on: paidOn, p_method: method, p_reference: reference }),
    cancelCharge: async (chargeId, reason) => {
      await rpc('tchefood_admin_cancel_charge', { p_charge: chargeId, p_reason: reason });
    },
    deviceAccount: (tenantId, action, email) =>
      call<DeviceAccountResult>('/functions/v1/admin-device-account', { tenant_id: tenantId, action, ...(email ? { email } : {}) }),
  };
}
