/**
 * Textos em português para os códigos que o servidor e a Point mandam (auditoria interna 2, P2-2). O código cru só
 * aparece como detalhe secundário (para o suporte), nunca no lugar do texto.
 */

/** raw_status_detail das cobranças da Point (terminal_charges, point-charge) e failure_code das travas. */
const CODE_TEXT: Record<string, string> = {
  ORDER_ID_CHANGED: 'o Mercado Pago devolveu duas ordens para esta cobrança',
  DISPATCH_UNKNOWN: 'enviada sem resposta do Mercado Pago',
  POINT_TIMEOUT: 'a maquininha não respondeu a tempo',
  POINT_STATUS_REJECTED: 'falha ao consultar o Mercado Pago',
  KEY_MISMATCH: 'resposta sobre outra cobrança',
  APPROVED_MISMATCH: 'aprovada com outro valor ou forma',
  TERMINAL_MISMATCH: 'aprovada em outra maquininha',
  AMOUNT_MISMATCH: 'valor diferente no Mercado Pago',
  PAID_AMOUNT_MISMATCH: 'valor pago diferente no Mercado Pago',
  METHOD_MISMATCH: 'forma de pagamento diferente no Mercado Pago',
  BRAND_MISMATCH: 'bandeira diferente no Mercado Pago',
  INSTALLMENTS_MISMATCH: 'parcelas diferentes no Mercado Pago',
  PAYMENT_ID_MISMATCH: 'pagamento diferente no Mercado Pago',
  REFERENCE_MISMATCH: 'referência diferente no Mercado Pago',
  APPROVED_WITHOUT_NSU: 'aprovada sem NSU',
  APPROVED_WITHOUT_REFERENCE: 'aprovada sem referência',
  APPROVED_WITHOUT_TERMINAL: 'aprovada sem a maquininha',
  FINAL_WITHOUT_REFERENCE: 'encerrada sem referência',
  FINAL_WITHOUT_TERMINAL: 'encerrada sem a maquininha',
  PROVIDER_STATUS_UNCERTAIN: 'situação incerta no Mercado Pago',
  PAYMENT_REFUNDED: 'estornada',
  ORDER_REFUNDED: 'estornada',
  OPERATION_ID_CONFIRMED: 'confirmada pela operação',
  REGISTER_FAILED: 'aprovada, mas não registrada',
  CLAIM_RELEASED: 'reserva liberada antes do registro',
  CLAIM_UNCONFIRMED: 'reserva não confirmada',
  CLAIM_NOT_STORED: 'reserva não gravada',
  ACQUIRER_MISMATCH: 'outra credenciadora',
  INCONSISTENT_APPROVAL: 'aprovação inconsistente',
  PAYMENT_REJECTED: 'pagamento recusado pela nuvem',
};

/** Recusas do Mercado Pago (status_detail cc_rejected_*). */
const REJECT_TEXT: Record<string, string> = {
  cc_rejected_insufficient_amount: 'saldo ou limite insuficiente',
  cc_rejected_bad_filled_security_code: 'código de segurança inválido',
  cc_rejected_bad_filled_date: 'validade inválida',
  cc_rejected_bad_filled_card_number: 'número do cartão inválido',
  cc_rejected_bad_filled_other: 'dados do cartão inválidos',
  cc_rejected_call_for_authorize: 'o banco pede autorização: cliente deve ligar para o banco',
  cc_rejected_card_disabled: 'cartão bloqueado ou não ativado',
  cc_rejected_duplicated_payment: 'pagamento duplicado',
  cc_rejected_high_risk: 'recusada por segurança',
  cc_rejected_max_attempts: 'tentativas demais com este cartão',
  cc_rejected_blacklist: 'recusada por segurança',
  cc_rejected_card_error: 'erro no cartão',
  cc_rejected_other_reason: 'recusada pelo banco do cartão',
  rejected_by_bank: 'recusada pelo banco do cartão',
  canceled: 'cancelada',
  expired: 'expirada',
};

/** Texto do código para o operador; null quando o código não é conhecido. */
export function pointCodeText(code: string | null | undefined): string | null {
  if (!code) return null;
  return CODE_TEXT[code] ?? REJECT_TEXT[code] ?? null;
}

/**
 * Motivo de recusa como a tela mostra: "Transação recusada: <motivo em português>". O texto que point-charge monta
 * ("Transação recusada (cc_rejected_...).") não repete o começo, e o código vira o texto dele.
 */
export function declineMessage(reason: string): { text: string; code: string | null } {
  const m = /^Transação recusada(?: \(([^)]+)\))?\.?$/.exec(reason.trim());
  if (m) {
    const code = m[1] ?? null;
    const detail = pointCodeText(code) ?? (code ? 'recusada pelo Mercado Pago' : null);
    return { text: detail ? `Transação recusada: ${detail}.` : 'Transação recusada.', code };
  }
  return { text: `Transação recusada: ${reason}`, code: null };
}
