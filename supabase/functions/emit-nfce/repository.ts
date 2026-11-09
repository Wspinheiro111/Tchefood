/**
 * Repositório Supabase (service role) da emissão NFC-e. Toda consulta filtra pelo tenant
 * já provado pelo RLS em index.ts; o service role só é usado depois dessa prova.
 */
import type { NewNfceDocument, NfceDocumentRow, NfceRepository, ProviderFields } from './emit.ts';
import type { NfceDocumentStatus } from './focus.ts';
import type { NfceSource } from './payload.ts';

// O query builder do supabase-js é encadeável e muito tipado; aqui basta o contrato mínimo.
// deno-lint-ignore no-explicit-any
type Query = any;
export interface SupabaseLike {
  from(table: string): Query;
}

const DOC_COLUMNS =
  'id, tenant_id, order_id, reference, environment, status, payload_hash, access_key, protocol, number, series, qrcode_url, danfe_path, xml_path, sefaz_status, sefaz_message, offline_contingency, transmissions';

function check(result: { data: Query; error: { message: string; code?: string } | null }, what: string): Query {
  if (result.error) throw new Error(`Falha ao ${what}: ${result.error.message}`);
  return result.data;
}

export function supabaseNfceRepository(db: SupabaseLike): NfceRepository {
  return {
    async loadSource(tenantId: string, orderId: string): Promise<NfceSource | null> {
      const order = check(
        await db
          .from('orders')
          .select('id, tenant_id, status, customer_cpf, subtotal_items, service_fee_amount, discount_amount, total_amount, remaining_balance, charge_service_fee, service_fee_pct')
          .eq('id', orderId)
          .eq('tenant_id', tenantId)
          .maybeSingle(),
        'ler a comanda',
      );
      if (!order) return null;
      const [tenant, items, payments] = await Promise.all([
        db.from('tenants').select('id, cnpj, state, focus_nfe_token').eq('id', tenantId).maybeSingle(),
        db
          .from('order_items')
          .select('id, order_id, product_id, quantity, unit_price, modifiers_unit_price, total_item_price, meat_doneness, status, created_at')
          .eq('order_id', orderId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true }),
        db
          .from('payments')
          .select('id, order_id, tenant_id, amount, method, status, acquirer, acquirer_cnpj, card_brand, authorization_code, created_at')
          .eq('order_id', orderId)
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: true }),
      ]);
      const tenantRow = check(tenant, 'ler o emitente');
      if (!tenantRow) return null;
      const itemRows = check(items, 'ler os itens') ?? [];
      const productIds = [...new Set(itemRows.map((i: { product_id: string }) => i.product_id))];
      const products = productIds.length
        ? check(
            await db.from('products').select('id, tenant_id, code, name, ncm, cfop, csosn_cst, unit').eq('tenant_id', tenantId).in('id', productIds),
            'ler os produtos',
          ) ?? []
        : [];
      return { tenant: tenantRow, order, items: itemRows, products, payments: check(payments, 'ler os pagamentos') ?? [] };
    },

    async getDocument(tenantId: string, orderId: string): Promise<NfceDocumentRow | null> {
      return check(
        await db.from('nfce_documents').select(DOC_COLUMNS).eq('tenant_id', tenantId).eq('order_id', orderId).maybeSingle(),
        'ler o documento NFC-e',
      );
    },

    async insertProcessing(doc: NewNfceDocument): Promise<NfceDocumentRow | null> {
      const result = await db
        .from('nfce_documents')
        .insert({ ...doc, status: 'processing', transmissions: 1 })
        .select(DOC_COLUMNS)
        .maybeSingle();
      if (result.error?.code === '23505') return null; // UNIQUE(order_id): outra requisição reservou antes
      return check(result, 'reservar o documento NFC-e');
    },

    async claimRejected(id: string, payloadHash: string, payload: unknown): Promise<NfceDocumentRow | null> {
      const current = check(await db.from('nfce_documents').select('transmissions').eq('id', id).maybeSingle(), 'ler tentativas');
      return check(
        await db
          .from('nfce_documents')
          .update({ status: 'processing', payload_hash: payloadHash, payload, transmissions: Number(current?.transmissions ?? 0) + 1, sefaz_message: null })
          .eq('id', id)
          .eq('status', 'rejected')
          .select(DOC_COLUMNS)
          .maybeSingle(),
        'reservar o reenvio da NFC-e',
      );
    },

    async saveProviderResult(id: string, expectedStatus: NfceDocumentStatus, fields: ProviderFields): Promise<NfceDocumentRow | null> {
      return check(
        await db.from('nfce_documents').update(fields).eq('id', id).eq('status', expectedStatus).select(DOC_COLUMNS).maybeSingle(),
        'gravar o retorno da Focus',
      );
    },

    async setOrderNfce(tenantId: string, orderId: string, status: string, accessKey: string | null): Promise<void> {
      const patch: Record<string, string> = { nfce_status: status };
      if (accessKey) patch.nfce_key = accessKey;
      check(await db.from('orders').update(patch).eq('id', orderId).eq('tenant_id', tenantId), 'atualizar a comanda');
    },
  };
}
