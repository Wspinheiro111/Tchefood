// Guarda do pedido de delivery antes de virar venda, produção (cozinha/KDS) ou NFC-e. Ainda não está ligada em
// nada: a tela que transforma o pedido do app em venda é o item 5 do piloto e deve chamar deliverySaleBlockers
// antes de lançar a venda, mandar para a produção ou emitir a nota.
//
// Decisão: needsReview sozinho NÃO bloqueia. Ele junta avisos de naturezas diferentes (observação do cliente,
// aviso de impressão que falhou, ação recusada pelo app) e travar a venda por qualquer um deles pararia pedidos
// bons. Ele sai separado, em deliverySaleWarnings, para a tela mostrar e pedir conferência. O que impede a venda
// de verdade (pedido que não é venda, pedido sem itens e valores conhecidos, pedido cancelado ou em vias de ser)
// está em deliverySaleBlockers.
//
// O tipo de entrada é estrutural e mínimo (DeliveryOrderRecord serve), para não amarrar a guarda ao resto do
// registro. detailPending é opcional enquanto o campo não existir em todo registro (rodada 3 do PR #57): sem o
// campo, não bloqueia por esse motivo.

export type DeliverySaleGuardInput = {
  order: { isTest: boolean; status: string };
  detailPending?: boolean;
  needsReview: boolean;
  cancellationPending: boolean;
};

// Motivos (para mostrar ao operador) que impedem o pedido de virar venda, produção ou NFC-e. Lista vazia = pode.
export function deliverySaleBlockers(record: DeliverySaleGuardInput): string[] {
  const motivos: string[] = [];
  if (record.order.isTest) motivos.push("Pedido de teste do app: não é venda.");
  if (record.detailPending === true) {
    motivos.push("Pedido gravado sem o detalhe do app (itens e valores): confira pelo Portal do Parceiro antes de lançar.");
  }
  if (record.order.status === "cancelled") motivos.push("Pedido cancelado no app.");
  if (record.cancellationPending) motivos.push("Pedido de cancelamento em análise no app: aguarde a resposta.");
  return motivos;
}

// Avisos que não impedem a venda, mas pedem conferência na tela.
export function deliverySaleWarnings(record: DeliverySaleGuardInput): string[] {
  return record.needsReview ? ["Pedido marcado para conferência: veja os avisos antes de lançar."] : [];
}
