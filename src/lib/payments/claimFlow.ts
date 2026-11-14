/**
 * A reserva de um pagamento do começo ao fim, para as telas que recebem (caixa da mesa, ficha rápida,
 * retirada). Loja sem Point: não faz nada. Loja com Point:
 *   1. reserva no servidor (claimPayment) e grava neste aparelho que a cobrança começou;
 *   2. fim conhecido (pago, em revisão, aprovado sem registro): o registro local sai, a reserva segue no
 *      servidor até virar pagamento ou ser conferida;
 *   3. nada cobrado (recusa, dinheiro não registrado): libera com novas tentativas; se não der, fica pendente
 *      e aparece na lista de reservas presas;
 *   4. saída sem fim conhecido (erro inesperado): o registro local fica, e a reserva aparece na lista com o
 *      aviso de que foi este aparelho.
 */
import { beginLocalClaim, detachLocalClaim, endLocalClaim } from './claimLedger';
import { claimPayment, releaseClaimAfterNoCharge, type ClaimInput } from './paymentClaim';

export interface ClaimHandle {
  /** Fim conhecido com dinheiro ou cobrança feita / em revisão. */
  settle(): void;
  /** Nada foi recebido: libera a reserva. */
  noCharge(why: string): void;
  /** Chamar no finally: sem fim conhecido, o registro local fica. */
  leave(): void;
}

const NONE: ClaimHandle = { settle: () => undefined, noCharge: () => undefined, leave: () => undefined };

export async function startPaymentClaim(required: boolean, input: ClaimInput): Promise<{ ok: true; handle: ClaimHandle } | { ok: false; error: string }> {
  if (!required) return { ok: true, handle: NONE };
  const c = await claimPayment(input);
  if (!c.ok) return { ok: false, error: c.error };
  // Gravado antes de receber: se o app cair aqui, a reserva aparece como "deste aparelho" na lista.
  beginLocalClaim(input.key, input.orderId);
  let done = false;
  return {
    ok: true,
    handle: {
      settle: () => {
        if (done) return;
        done = true;
        endLocalClaim(input.key);
      },
      noCharge: (why) => {
        if (done) return;
        done = true;
        void releaseClaimAfterNoCharge(input.key, input.orderId, why);
      },
      leave: () => {
        if (!done) detachLocalClaim(input.key);
      },
    },
  };
}
