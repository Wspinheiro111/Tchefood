/**
 * Desconto da nuvem quando a conta foi recusada por ter outro desconto lá
 * (TCHEFOOD_DESCONTO, db/schema_cashback_servidor.sql); null para outras recusas.
 */
export function cloudDiscountOf(message: string): number | null {
  const m = /TCHEFOOD_DESCONTO: o desconto desta conta na nuvem é R\$ ([0-9]+\.[0-9]{2})/.exec(message);
  return m ? Number(m[1]) : null;
}
