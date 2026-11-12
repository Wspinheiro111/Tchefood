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
  'id, tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, external_order_id, external_payment_id, raw_status, raw_status_detail, paid_amount_cents, card_brand, authorization_code, last_four, created_by, dispatched_at, cancel_reason, cancel_requested_by, cancel_requested_at, cancel_authorized_by, cancel_audit_id, created_at';

/** Estados de que uma cobrança não sai mais (o banco também recusa, gatilho trg_terminal_charges_final). */
const FINAL_LIST = '(approved,rejected,cancelled,expired,refunded)';

/** Códigos de tchefood_open_terminal_charge (db/schema_mercado_pago.sql). */
const REFUSALS: Record<string, ChargeRefusedError['code']> = {
  TF001: 'order_not_found', TF002: 'order_closed', TF003: 'over_balance', TF004: 'invalid_staff', TF005: 'not_found', TF006: 'invalid_reason',
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
  return { ...(row as unknown as TerminalChargeRow), amount_cents: Number(row.amount_cents), paid_amount_cents: int(row.paid_amount_cents) };
}

export function supabaseChargeStore(db: SupabaseLike, tenantId: string): ChargeStore {
  return {
    async findByKey(idempotencyKey: string): Promise<TerminalChargeRow | null> {
      return normalize(check(
        await db.from('terminal_charges').select(CHARGE_COLUMNS).eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).maybeSingle(),
        'ler a cobrança',
      ));
    },
    async insert(row: NewChargeRow): Promise<TerminalChargeRow> {
      if (row.tenant_id !== tenantId) throw new Error('Cobrança de outra loja.');
      // A conta trava no banco: confere loja, conta aberta e saldo e grava a cobrança na mesma transação.
      const res = await db.rpc('tchefood_open_terminal_charge', {
        p_tenant: tenantId,
        p_key: row.idempotency_key,
        p_order: row.order_id,
        p_terminal: row.terminal_id,
        p_external_terminal: row.external_terminal_id,
        p_method: row.method,
        p_amount_cents: row.amount_cents,
        p_created_by: row.created_by,
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
      const res = await db.from('terminal_charges').insert(row).select(CHARGE_COLUMNS).maybeSingle();
      if (res.error?.code === '23505') {
        // A criação gravou primeiro: devolve a que ficou (o chamador confere se é o mesmo pedido).
        const existing = await this.findByKey(row.idempotency_key);
        if (!existing) throw new Error('Esta chave já foi usada por outra loja.');
        return existing;
      }
      const inserted = normalize(check(res, 'gravar o encerramento'));
      if (!inserted) throw new Error('Falha ao gravar o encerramento.');
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
    async claimDispatch(row: TerminalChargeRow): Promise<TerminalChargeRow | null> {
      // Um UPDATE só: dois pedidos juntos ou um encerramento no meio não mandam a ordem duas vezes.
      return normalize(check(
        await db
          .from('terminal_charges')
          .update({ dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('tenant_id', tenantId)
          .eq('status', 'creating')
          .is('dispatched_at', null)
          .is('cancel_requested_at', null)
          .select(CHARGE_COLUMNS)
          .maybeSingle(),
        'marcar o envio',
      ));
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
  };
}
