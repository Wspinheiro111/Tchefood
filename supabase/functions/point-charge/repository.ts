/**
 * terminal_charges pela service role, sempre filtrado pelo tenant já provado pelo RLS em index.ts.
 */
import { ChargeRefusedError, type ChargePatch, type ChargeStore, type NewChargeRow, type TerminalChargeRow } from './charge.ts';

// O query builder do supabase-js é encadeável e muito tipado; aqui basta o contrato mínimo.
// deno-lint-ignore no-explicit-any
type Query = any;
export interface SupabaseLike {
  from(table: string): Query;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: Query; error: { message: string; code?: string } | null }>;
}

export const CHARGE_COLUMNS =
  'id, tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, external_order_id, external_payment_id, raw_status, raw_status_detail, paid_amount_cents, card_brand, authorization_code, last_four, created_by, dispatched_at, dispatch_lease_until, dispatch_attempts, cancel_reason, cancel_requested_by, cancel_requested_at, cancel_authorized_by, cancel_audit_id, created_at';

/** Estados de que uma cobrança não sai mais (o banco também recusa, gatilho trg_terminal_charges_final). */
const FINAL_LIST = '(approved,rejected,cancelled,expired,refunded)';

/** Códigos das funções de db/schema_mercado_pago.sql. */
const REFUSALS: Record<string, ChargeRefusedError['code']> = {
  TF001: 'order_not_found', TF002: 'order_closed', TF003: 'over_balance', TF004: 'invalid_staff', TF005: 'not_found', TF006: 'invalid_reason', TF007: 'not_applicable', TF008: 'balance_mismatch', TF009: 'key_in_use',
};

function refusal(error: { message: string; code?: string } | null): ChargeRefusedError | null {
  const code = error?.code ? REFUSALS[error.code] : undefined;
  return code ? new ChargeRefusedError(code, (error?.message ?? '').replace(/^TCHEFOOD_COBRANCA:\s*/, '')) : null;
}

function check(result: { data: Query; error: { message: string; code?: string } | null }, what: string): Query {
  if (result.error) throw new Error(`Falha ao ${what}: ${result.error.message}`);
  return result.data;
}

/** BIGINT pode chegar como texto; a cobrança trabalha com número inteiro. */
function normalize(row: Record<string, unknown> | null): TerminalChargeRow | null {
  if (!row) return null;
  const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return { ...(row as unknown as TerminalChargeRow), amount_cents: Number(row.amount_cents), paid_amount_cents: int(row.paid_amount_cents), dispatch_attempts: Number(row.dispatch_attempts ?? 0) };
}

export function supabaseChargeStore(db: SupabaseLike, tenantId: string): ChargeStore {
  return {
    async findByKey(idempotencyKey: string): Promise<TerminalChargeRow | null> {
      return normalize(check(
        await db.from('terminal_charges').select(CHARGE_COLUMNS).eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).maybeSingle(),
        'ler a cobrança',
      ));
    },
    async insert(row: NewChargeRow, expectedBalanceCents: number): Promise<TerminalChargeRow> {
      if (row.tenant_id !== tenantId) throw new Error('Cobrança de outra loja.');
      // A conta trava no banco: confere loja, conta aberta, saldo igual ao do aparelho e saldo livre e grava a
      // cobrança na mesma transação.
      const res = await db.rpc('tchefood_open_terminal_charge', {
        p_tenant: tenantId,
        p_key: row.idempotency_key,
        p_order: row.order_id,
        p_terminal: row.terminal_id,
        p_external_terminal: row.external_terminal_id,
        p_method: row.method,
        p_amount_cents: row.amount_cents,
        p_created_by: row.created_by,
        p_expected_balance_cents: expectedBalanceCents,
      });
      const refused = refusal(res.error);
      if (refused) throw refused;
      check(res, 'gravar a cobrança');
      const inserted = await this.findByKey(row.idempotency_key);
      if (!inserted) throw new Error('Falha ao gravar a cobrança.');
      return inserted;
    },
    async insertVoid(row: NewChargeRow): Promise<TerminalChargeRow> {
      if (row.tenant_id !== tenantId) throw new Error('Cobrança de outra loja.');
      // O banco confere o operador (equipe ativa da loja), grava o bloqueio e o registro na mesma transação.
      // Chave já gravada: não mexe e devolve a que ficou (o chamador confere se é o mesmo pedido).
      const res = await db.rpc('tchefood_block_point_key', {
        p_tenant: tenantId,
        p_key: row.idempotency_key,
        p_order: row.order_id,
        p_terminal: row.terminal_id,
        p_external_terminal: row.external_terminal_id,
        p_method: row.method,
        p_amount_cents: row.amount_cents,
        p_requested_by: row.cancel_requested_by,
      });
      const refused = refusal(res.error);
      if (refused) throw refused;
      check(res, 'gravar o bloqueio da chave');
      const inserted = await this.findByKey(row.idempotency_key);
      if (!inserted) throw new Error('Falha ao gravar o bloqueio da chave.');
      return inserted;
    },
    async update(row: TerminalChargeRow, patch: ChargePatch): Promise<TerminalChargeRow> {
      // Só grava se ninguém mudou o estado desde a leitura (UPDATE ... WHERE status = lido é atômico).
      const updated = normalize(check(
        await db
          .from('terminal_charges')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('tenant_id', tenantId)
          .eq('status', row.status)
          .not('status', 'in', FINAL_LIST)
          .select(CHARGE_COLUMNS)
          .maybeSingle(),
        'atualizar a cobrança',
      ));
      if (updated) return updated;
      // Outra consulta passou na frente: vale o que está gravado.
      const current = await this.findByKey(row.idempotency_key);
      if (!current) throw new Error('Cobrança não encontrada para atualizar.');
      return current;
    },
    async claimDispatch(row: TerminalChargeRow, leaseMs: number): Promise<TerminalChargeRow | null> {
      // Um UPDATE só, com o relógio do banco: dois pedidos juntos não ganham a posse, e pedido de
      // encerramento gravado antes barra a posse.
      const res = await db.rpc('tchefood_claim_point_dispatch', { p_tenant: tenantId, p_id: row.id, p_lease_ms: leaseMs });
      const attempt = Number(check(res, 'pedir a posse do envio') ?? 0);
      if (!Number.isInteger(attempt) || attempt < 1) return null;
      // A posse é a de número `attempt`. A barreira (beginDispatch) confere de novo no banco se ela ainda vale.
      return { ...row, dispatch_attempts: attempt };
    },
    async beginDispatch(row: TerminalChargeRow, leaseMs: number, allowFirst: boolean): Promise<0 | 1 | 2> {
      const res = await db.rpc('tchefood_begin_point_dispatch', {
        p_tenant: tenantId, p_id: row.id, p_attempt: row.dispatch_attempts, p_lease_ms: leaseMs, p_allow_first: allowFirst === true,
      });
      const kind: unknown = check(res, 'marcar o envio');
      // Só os números 1 e 2 liberam o envio; qualquer outra resposta é "não mande". Consulta (allowFirst false)
      // nunca recebe 1 do banco; se receber, não manda.
      if ((kind === 1 || kind === '1') && allowFirst === true) return 1;
      return kind === 2 || kind === '2' ? 2 : 0;
    },
    async attachOrder(row: TerminalChargeRow, externalOrderId: string): Promise<TerminalChargeRow> {
      // Sem condição de estado lido: vale para "creating" e para revisão manual. Só não troca ordem já ligada
      // nem mexe em cobrança final (o gatilho do banco recusa as duas coisas também).
      const updated = normalize(check(
        await db
          .from('terminal_charges')
          .update({ external_order_id: externalOrderId, updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('tenant_id', tenantId)
          .is('external_order_id', null)
          .not('status', 'in', FINAL_LIST)
          .select(CHARGE_COLUMNS)
          .maybeSingle(),
        'ligar a ordem à cobrança',
      ));
      if (updated) return updated;
      const current = await this.findByKey(row.idempotency_key);
      if (!current) throw new Error('Cobrança não encontrada para ligar a ordem.');
      return current;
    },
    async rejectFirstSend(row: TerminalChargeRow, code: string): Promise<TerminalChargeRow> {
      const updated = normalize(check(
        await db
          .from('terminal_charges')
          .update({ status: 'rejected', raw_status: `create_failed:${code}`, raw_status_detail: null, updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('tenant_id', tenantId)
          .eq('status', 'creating')
          .eq('dispatch_attempts', row.dispatch_attempts)
          .is('external_order_id', null)
          .select(CHARGE_COLUMNS)
          .maybeSingle(),
        'gravar a recusa do envio',
      ));
      if (updated) return updated;
      const current = await this.findByKey(row.idempotency_key);
      if (!current) throw new Error('Cobrança não encontrada para gravar a recusa.');
      return current;
    },
    async settleDispatch(row: TerminalChargeRow): Promise<TerminalChargeRow> {
      check(await db.rpc('tchefood_settle_point_dispatch', { p_tenant: tenantId, p_id: row.id }), 'levar o envio sem resposta à revisão manual');
      const current = await this.findByKey(row.idempotency_key);
      if (!current) throw new Error('Cobrança não encontrada para revisar.');
      return current;
    },
    async requestTimeoutCancel(row: TerminalChargeRow, waitMs: number): Promise<TerminalChargeRow | null> {
      const res = await db.rpc('tchefood_request_point_timeout', { p_tenant: tenantId, p_id: row.id, p_wait_ms: waitMs });
      const refused = refusal(res.error);
      if (refused) throw refused;
      const kind: unknown = check(res, 'registrar o encerramento por prazo');
      if (kind === 0 || kind === '0') return null; // ainda é cedo
      if (kind !== 1 && kind !== 2 && kind !== '1' && kind !== '2') throw new Error('Resposta inesperada ao registrar o encerramento por prazo.');
      const current = await this.findByKey(row.idempotency_key);
      if (!current) throw new Error('Cobrança não encontrada para encerrar.');
      return current;
    },
    async voidUndispatched(row: TerminalChargeRow): Promise<TerminalChargeRow> {
      const updated = normalize(check(
        await db
          .from('terminal_charges')
          .update({ status: 'cancelled', raw_status: 'voided_before_send', updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('tenant_id', tenantId)
          .eq('status', 'creating')
          .is('dispatched_at', null)
          .select(CHARGE_COLUMNS)
          .maybeSingle(),
        'encerrar a cobrança',
      ));
      if (updated) return updated;
      const current = await this.findByKey(row.idempotency_key);
      if (!current) throw new Error('Cobrança não encontrada para encerrar.');
      return current;
    },
    async listOpenForOrder(orderId: string): Promise<TerminalChargeRow[]> {
      const rows = check(
        await db.from('terminal_charges').select(CHARGE_COLUMNS).eq('tenant_id', tenantId).eq('order_id', orderId).not('status', 'in', FINAL_LIST),
        'ler as cobranças da conta',
      ) as Record<string, unknown>[] | null;
      return (rows ?? []).map((r) => normalize(r)!);
    },
    async authorizeCancel(input): Promise<string | null> {
      const res = await db.rpc('tchefood_authorize_point_cancel', {
        p_tenant: tenantId,
        p_key: input.idempotency_key,
        p_performed_by: input.performed_by,
        p_manager_pin: input.manager_pin,
        p_reason: input.reason,
      });
      const refused = refusal(res.error);
      if (refused) throw refused;
      const id = check(res, 'conferir o PIN do gerente');
      return typeof id === 'string' && id ? id : null;
    },
    async authorizeReconcile(input): Promise<string | null> {
      // Só confere o PIN e grava o registro do pedido de conferência: não muda a cobrança.
      const res = await db.rpc('tchefood_authorize_point_reconcile', {
        p_tenant: tenantId,
        p_key: input.idempotency_key,
        p_staff: input.performed_by,
        p_manager_pin: input.manager_pin,
        p_reason: input.reason,
      });
      const refused = refusal(res.error);
      if (refused) throw refused;
      const id = check(res, 'conferir o PIN do gerente');
      return typeof id === 'string' && id ? id : null;
    },
    async hasRegisteredPayment(idempotencyKey: string): Promise<boolean> {
      // Mesma regra do banco (tchefood_point_reserved_cents): pagamento APPROVED do Mercado Pago com a chave.
      const found = check(
        await db.from('payments').select('id').eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).eq('status', 'APPROVED').eq('acquirer', 'MERCADO_PAGO').maybeSingle(),
        'ler o pagamento registrado',
      );
      return Boolean(found);
    },
    async resolve(row, toStatus, patch, audit): Promise<TerminalChargeRow> {
      // Uma transação no banco: só grava se o estado ainda for o lido, com UM audit_log. Devolve a linha atual.
      const res = await db.rpc('tchefood_resolve_point_charge', {
        p_tenant: tenantId,
        p_id: row.id,
        p_from_status: row.status,
        p_to_status: toStatus,
        p_patch: patch,
        p_staff: audit.staff,
        p_reason: audit.reason,
        p_evidence: audit.evidence,
      });
      const refused = refusal(res.error);
      if (refused) throw refused;
      const data = check(res, 'gravar a conferência no Mercado Pago');
      const returned = normalize(Array.isArray(data) ? (data[0] ?? null) : (data ?? null));
      if (returned && returned.id === row.id && returned.tenant_id === tenantId) return returned;
      const current = await this.findByKey(row.idempotency_key);
      if (!current) throw new Error('Cobrança não encontrada para gravar a conferência.');
      return current;
    },
  };
}
