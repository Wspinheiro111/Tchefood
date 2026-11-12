/**
 * terminal_charges pela service role, sempre filtrado pelo tenant já provado pelo RLS em index.ts.
 */
import type { ChargePatch, ChargeStore, NewChargeRow, TerminalChargeRow } from './charge.ts';

// O query builder do supabase-js é encadeável e muito tipado; aqui basta o contrato mínimo.
// deno-lint-ignore no-explicit-any
type Query = any;
export interface SupabaseLike {
  from(table: string): Query;
}

export const CHARGE_COLUMNS =
  'id, tenant_id, idempotency_key, order_id, terminal_id, provider, external_terminal_id, method, amount_cents, status, external_order_id, external_payment_id, raw_status, raw_status_detail, paid_amount_cents, card_brand, authorization_code, last_four, created_by';

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
      const res = await db.from('terminal_charges').insert(row).select(CHARGE_COLUMNS).maybeSingle();
      if (res.error?.code === '23505') {
        // Mesma chave gravada por outro envio: devolve a que ficou (o chamador confere se é o mesmo pedido).
        const existing = await this.findByKey(row.idempotency_key);
        if (!existing) throw new Error('Esta chave já foi usada por outra loja.');
        return existing;
      }
      const inserted = normalize(check(res, 'gravar a cobrança'));
      if (!inserted) throw new Error('Falha ao gravar a cobrança.');
      return inserted;
    },
    async update(id: string, patch: ChargePatch): Promise<TerminalChargeRow> {
      const updated = normalize(check(
        await db
          .from('terminal_charges')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('tenant_id', tenantId)
          .select(CHARGE_COLUMNS)
          .maybeSingle(),
        'atualizar a cobrança',
      ));
      if (!updated) throw new Error('Cobrança não encontrada para atualizar.');
      return updated;
    },
  };
}
