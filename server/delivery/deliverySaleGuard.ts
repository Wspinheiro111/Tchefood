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
//
// Cancelamento pedido pela loja (cancellationRequest): bloqueia em qualquer estado. cancellationPending só vira true
// com o evento do app; "sending" e "uncertain" podem já ter chegado ao app, e "sent" foi aceito por ele.
//
// Negociação aberta (dispute): bloqueia, porque pode acabar em cancelamento (o cliente pediu, ou o app aplica a ação
// padrão no fim do prazo) ou em pedido com outro valor. Só deixa de bloquear (vira aviso) quando:
//  - a loja recusou e o app confirmou a recusa (response "sent" com kind "reject"): o pedido segue como está e só
//    falta o app fechar a negociação. Aceite ou proposta confirmados continuam bloqueando: o cancelamento, ou a
//    decisão do cliente sobre a proposta, ainda vem. Resposta dada por fora (respondedAt sem response) também,
//    porque não se sabe qual foi;
//  - é negociação depois da entrega (AFTER_DELIVERY) de pedido concluído: a comida foi entregue e a venda
//    aconteceu; o que a negociação muda é o valor que a loja recebe do app (reembolso), não se houve venda.
//    Travar a NFC-e de um pedido entregue não protege nada; o aviso pede para conferir o valor.

// Evento de cancelamento do app sem horário quando não dá para ordenar com as outras respostas (ver applySignal em
// deliveryInbox.ts). Bloqueia até a conferência: a tela do item 5 deve pedir a reconciliação com o Portal do Parceiro.
export const CANCELLATION_EVENT_UNORDERED_REASON =
  "Evento de cancelamento do app sem horário: não dá para saber se o cancelamento segue em análise; confira no Portal do Parceiro antes de lançar.";

export type DeliverySaleGuardInput = {
  order: { isTest: boolean; status: string };
  detailPending?: boolean;
  needsReview: boolean;
  reviewReasons?: string[];
  cancellationPending: boolean;
  cancellationRequest: { state: string } | null;
  dispute: {
    handshakeType: string | null;
    respondedAt: string | null;
    response?: { decision: { kind: string }; state: string } | null;
  } | null;
};

type DisputeImpact = "none" | "warn" | "block";

function disputeImpact(record: DeliverySaleGuardInput): DisputeImpact {
  const dispute = record.dispute;
  if (!dispute) return "none";
  if (dispute.handshakeType === "AFTER_DELIVERY" && record.order.status === "concluded") return "warn";
  if (dispute.response?.state === "sent" && dispute.response.decision.kind === "reject") return "warn";
  return "block";
}

// Motivos (para mostrar ao operador) que impedem o pedido de virar venda, produção ou NFC-e. Lista vazia = pode.
export function deliverySaleBlockers(record: DeliverySaleGuardInput): string[] {
  const motivos: string[] = [];
  if (record.order.isTest) motivos.push("Pedido de teste do app: não é venda.");
  if (record.detailPending === true) {
    motivos.push("Pedido gravado sem o detalhe do app (itens e valores): confira pelo Portal do Parceiro antes de lançar.");
  }
  if (record.order.status === "cancelled") motivos.push("Pedido cancelado no app.");
  if (record.reviewReasons?.includes(CANCELLATION_EVENT_UNORDERED_REASON)) motivos.push(CANCELLATION_EVENT_UNORDERED_REASON);
  if (record.cancellationPending) motivos.push("Pedido de cancelamento em análise no app: aguarde a resposta.");
  if (record.cancellationRequest) {
    motivos.push(
      record.cancellationRequest.state === "sent"
        ? "A loja pediu o cancelamento e o app aceitou o pedido: aguarde a resposta do app."
        : "A loja pediu o cancelamento e o app ainda não confirmou (pode já ter chegado): confira no Portal do Parceiro.",
    );
  }
  if (disputeImpact(record) === "block") {
    motivos.push("Negociação com o cliente em aberto (pode cancelar o pedido ou mudar o valor): aguarde o desfecho no app.");
  }
  return motivos;
}

// Avisos que não impedem a venda, mas pedem conferência na tela.
export function deliverySaleWarnings(record: DeliverySaleGuardInput): string[] {
  const avisos = record.needsReview ? ["Pedido marcado para conferência: veja os avisos antes de lançar."] : [];
  if (disputeImpact(record) === "warn") {
    avisos.push(
      record.dispute!.handshakeType === "AFTER_DELIVERY" && record.order.status === "concluded"
        ? "Negociação depois da entrega em aberto: confira o valor a receber do app."
        : "A loja recusou a negociação e o app confirmou; falta o app fechar a negociação.",
    );
  }
  return avisos;
}
