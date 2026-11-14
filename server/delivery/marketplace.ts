// Contrato neutro de pedidos de delivery vindos de apps (iFood, 99Food, Keeta, Delivery Much, Aiqfome, Anota AI...).
// O PDV só conhece este domínio comum; cada app fica atrás de um adapter que traduz o formato dele.
// Mesmo princípio das maquininhas (server/shared/paymentTerminal.ts): estado desconhecido nunca vira
// "deu certo" sozinho, e o identificador do pedido é sempre o do app (nunca inventado pelo PDV).

export const DELIVERY_CHANNELS = [
  "ifood",
  "ninety_nine_food",
  "keeta",
  "delivery_much",
  "aiqfome",
  "anota_ai",
  "rappi",
] as const;
export type DeliveryChannelKey = (typeof DELIVERY_CHANNELS)[number];

export type DeliveryIntegrationKind =
  // API do próprio app, com homologação do app integrador.
  | "official_api"
  // API no padrão Open Delivery (Abrasel): um adapter genérico atende vários apps.
  | "open_delivery"
  // API liberada apenas mediante contrato de parceria (documentação não é pública).
  | "partner_api";

export type DeliveryImplementationStatus =
  // Adapter pronto e coberto por testes, rodando contra o simulador até chegarem credenciais.
  | "mock_ready"
  // Ainda não implementado: depende de documentação/parceria.
  | "planned";

export type DeliveryChannelInfo = {
  key: DeliveryChannelKey;
  label: string;
  kind: DeliveryIntegrationKind;
  status: DeliveryImplementationStatus;
  // O que o lojista ou o integrador precisa providenciar para ligar em produção.
  requirements: string;
  docsUrl: string | null;
};

export const DELIVERY_CHANNEL_CATALOG: Readonly<Record<DeliveryChannelKey, DeliveryChannelInfo>> = {
  ifood: {
    key: "ifood",
    label: "iFood",
    kind: "official_api",
    status: "mock_ready",
    requirements: "Conta no Portal do Desenvolvedor iFood, client_id/client_secret e homologação do app integrador.",
    docsUrl: "https://developer.ifood.com.br",
  },
  ninety_nine_food: {
    key: "ninety_nine_food",
    label: "99Food",
    kind: "official_api",
    status: "planned",
    requirements: "Cadastro como parceiro na Open Platform da 99Food.",
    docsUrl: "https://developer-food.99app.com/pt-BR/openapi",
  },
  keeta: {
    key: "keeta",
    label: "Keeta",
    kind: "open_delivery",
    status: "planned",
    requirements: "Credenciais OAuth (escopo od.all) e assinatura X-App-Signature; aceite em até 5 minutos.",
    docsUrl: "https://api-docs.mykeeta.com/apis/opendelivery/orderssection.md",
  },
  delivery_much: {
    key: "delivery_much",
    label: "Delivery Much",
    kind: "partner_api",
    status: "planned",
    requirements: "Contrato de parceria de integração com a Delivery Much.",
    docsUrl: null,
  },
  aiqfome: {
    key: "aiqfome",
    label: "Aiqfome",
    kind: "partner_api",
    status: "planned",
    requirements: "Contrato de parceria de integração com o Aiqfome.",
    docsUrl: null,
  },
  anota_ai: {
    key: "anota_ai",
    label: "Anota AI",
    kind: "partner_api",
    status: "planned",
    requirements: "Parceria de PDV com o Anota AI (empresa do grupo iFood).",
    docsUrl: null,
  },
  rappi: {
    key: "rappi",
    label: "Rappi",
    kind: "partner_api",
    status: "planned",
    requirements: "Homologação no programa Rappi Partners.",
    docsUrl: null,
  },
};

// ---------------------------------------------------------------------------
// Pedido normalizado
// ---------------------------------------------------------------------------

// Ciclo de vida comum do pedido. "unknown" = o app mandou um status que não reconhecemos: o pedido vai para
// conferência humana e nenhuma ação automática é tomada em cima dele.
export type DeliveryOrderStatus =
  | "placed"
  | "confirmed"
  | "preparing"
  | "ready_for_pickup"
  | "dispatched"
  | "concluded"
  | "cancelled"
  | "unknown";

// O que um evento do app comunica: um novo status do pedido, o andamento de um pedido de cancelamento
// (que não muda o status até o app confirmar com "cancelled"), o pedido de cancelamento feito pelo cliente, ou
// uma negociação aberta pelo app (cliente pede cancelamento/reembolso e a loja aceita, recusa ou propõe outra coisa).
export type DeliveryEventSignal =
  | DeliveryOrderStatus
  | "cancellation_requested"
  | "cancellation_denied"
  | "customer_cancellation_requested"
  | "customer_cancellation_accepted"
  | "customer_cancellation_denied"
  | "dispute_opened"
  | "dispute_settled";

export type DeliveryFulfillment = "delivery" | "takeout" | "indoor";
// Quem leva o pedido: entregador do app ou motoboy da própria loja.
export type DeliveryCourier = "marketplace" | "merchant" | "unknown";

export type DeliveryOrderOption = {
  name: string;
  externalCode: string | null;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
};

export type DeliveryOrderItem = {
  externalId: string;
  // Código PDV cadastrado no app (o "código rápido" do produto no Tchê Food). Null = sem vínculo: o item
  // ainda entra no pedido, mas é sinalizado para o lojista mapear.
  externalCode: string | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
  optionsPriceCents: number;
  totalPriceCents: number;
  notes: string | null;
  options: DeliveryOrderOption[];
};

export type DeliveryPaymentMethod = "credit" | "debit" | "pix" | "cash" | "voucher" | "meal_voucher" | "other";

export type DeliveryOrderPayment = {
  method: DeliveryPaymentMethod;
  // true = já pago no app (online); false = cobrar na entrega/retirada.
  prepaid: boolean;
  amountCents: number;
  cardBrand: string | null;
  // Troco para (somente dinheiro na entrega).
  changeForCents: number | null;
};

export type DeliveryAddress = {
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  reference: string | null;
};

export type DeliveryOrder = {
  channel: DeliveryChannelKey;
  externalId: string;
  // Número curto que o cliente e o entregador falam no balcão (ex.: "4821").
  displayId: string;
  merchantExternalId: string;
  status: DeliveryOrderStatus;
  fulfillment: DeliveryFulfillment;
  courier: DeliveryCourier;
  // Pedido agendado: início da janela de entrega/retirada combinada com o cliente.
  scheduledFor: string | null;
  // Fim da janela do agendado (null quando o app não informa).
  scheduledUntil: string | null;
  // Horário recomendado pelo app para começar o preparo (agendados e imediatos). Só informativo.
  preparationStartAt: string | null;
  // Código que o entregador/cliente mostra na retirada (iFood: delivery.pickupCode). Null = o app não exige.
  pickupCode: string | null;
  // Pedido de teste do app (loja de homologação): não vale como venda.
  isTest: boolean;
  createdAt: string;
  customer: {
    name: string;
    phone: string | null;
    // Código que o app exige para falar com o cliente pelo 0800 mascarado (iFood: "localizer").
    phoneLocalizer: string | null;
    document: string | null;
  };
  address: DeliveryAddress | null;
  items: DeliveryOrderItem[];
  totals: {
    itemsCents: number;
    deliveryFeeCents: number;
    additionalFeesCents: number;
    // Descontos/cupons (valor positivo que abate do total).
    benefitsCents: number;
    // Parte dos descontos paga pelo app ou por terceiros (iFood: patrocínio IFOOD/EXTERNAL). Para a loja ela
    // funciona como pagamento, não como desconto; o restante (loja/rede) é desconto de verdade.
    benefitsSponsoredByMarketplaceCents: number;
    orderCents: number;
  };
  payments: DeliveryOrderPayment[];
  // Quanto falta o entregador/balcão cobrar do cliente.
  pendingCents: number;
  notes: string | null;
  // Itens sem código PDV, totais que não fecham etc.: o pedido entra, mas pede olho humano.
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export type DeliveryEvent = {
  channel: DeliveryChannelKey;
  // Id do evento no app: é a chave de deduplicação e de confirmação (ack).
  externalEventId: string;
  // Vazio quando o app manda um evento sem pedido (ex.: evento da loja): é confirmado e ignorado.
  externalOrderId: string;
  merchantExternalId: string;
  // Código bruto do app (ex.: "PLC"), mantido para auditoria.
  rawCode: string;
  signal: DeliveryEventSignal;
  createdAt: string;
  // Negociação aberta pelo app (só nos eventos "dispute_opened").
  dispute: DeliveryDispute | null;
};

// Negociação (iFood: plataforma de negociação / handshake). O cliente pede algo (cancelar, reembolso parcial...)
// e a loja responde dentro do prazo; sem resposta, o app aplica a ação padrão dele.
export type DeliveryDispute = {
  id: string;
  // O que o cliente pediu, no código do app (ex.: "CANCELLATION"). Só exibido.
  action: string | null;
  message: string | null;
  expiresAt: string | null;
  // Contrapropostas que a loja pode oferecer em vez de aceitar/recusar.
  alternatives: Array<{ id: string; type: string | null; description: string | null }>;
};

export type DeliveryDisputeDecision = { kind: "accept" } | { kind: "reject"; reason: string } | { kind: "alternative"; alternativeId: string };

export type DeliveryCancellationReason = {
  code: string;
  description: string;
};

export type DeliveryOrderAction = "confirm" | "start_preparation" | "ready_for_pickup" | "dispatch";

// Interface que todo app implementa. Toda chamada roda no servidor: client_secret de app nunca vai ao navegador.
export interface DeliveryMarketplaceAdapter {
  readonly channel: DeliveryChannelKey;
  // Eventos novos desde o último ack. Eventos não confirmados voltam na próxima chamada.
  pollEvents(): Promise<DeliveryEvent[]>;
  acknowledge(events: readonly DeliveryEvent[]): Promise<void>;
  getOrder(externalOrderId: string): Promise<DeliveryOrder>;
  performAction(externalOrderId: string, action: DeliveryOrderAction): Promise<void>;
  listCancellationReasons(externalOrderId: string): Promise<DeliveryCancellationReason[]>;
  // Pedido de cancelamento é assíncrono: só o evento "cancelled" confirma.
  requestCancellation(externalOrderId: string, reason: DeliveryCancellationReason, details?: string): Promise<void>;
  // Resposta da loja a uma negociação aberta pelo app. Assíncrona: o evento "dispute_settled" fecha.
  respondToDispute(disputeId: string, decision: DeliveryDisputeDecision): Promise<void>;
}

// Controle da loja no app (abrir/pausar). Separado do adapter de pedidos porque nem todo app oferece.
export type DeliveryStoreState = "open" | "warning" | "closed" | "error" | "unknown";

export type DeliveryStoreStatus = {
  state: DeliveryStoreState;
  // Texto do app explicando o estado (ex.: "Loja fechada por pausa programada").
  message: string | null;
  // Detalhes por operação (entrega, retirada...) vindos do app, só para exibir.
  operations: Array<{ operation: string; state: DeliveryStoreState; available: boolean | null; message: string | null }>;
};

export type DeliveryStorePause = {
  id: string;
  description: string;
  start: string;
  end: string;
};

export interface DeliveryStoreControl {
  readonly channel: DeliveryChannelKey;
  getStoreStatus(merchantExternalId: string): Promise<DeliveryStoreStatus>;
  listPauses(merchantExternalId: string): Promise<DeliveryStorePause[]>;
  // Pausa a loja no app entre start e end (a loja some ou aparece fechada para o cliente).
  pauseStore(merchantExternalId: string, pause: { description: string; start: string; end: string }): Promise<DeliveryStorePause>;
  resumeStore(merchantExternalId: string, pauseId: string): Promise<void>;
}

export type DeliveryMarketplaceErrorCode =
  | "auth_failed"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "invalid_response";

export class DeliveryMarketplaceError extends Error {
  constructor(
    readonly channel: DeliveryChannelKey,
    readonly code: DeliveryMarketplaceErrorCode,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "DeliveryMarketplaceError";
  }

  // Erros transitórios: tentar de novo no próximo ciclo sem alarde.
  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable";
  }
}

// Próxima ação permitida a partir de cada status. O PDV não pula etapas nem age em pedido cancelado/desconhecido.
const NEXT_ACTIONS: Readonly<Record<DeliveryOrderStatus, readonly DeliveryOrderAction[]>> = {
  placed: ["confirm"],
  confirmed: ["start_preparation", "ready_for_pickup", "dispatch"],
  preparing: ["ready_for_pickup", "dispatch"],
  ready_for_pickup: ["dispatch"],
  dispatched: [],
  concluded: [],
  cancelled: [],
  unknown: [],
};

export function allowedDeliveryActions(
  order: Pick<DeliveryOrder, "status" | "fulfillment" | "courier">,
  cancellationPending = false,
): DeliveryOrderAction[] {
  // Enquanto o app analisa um pedido de cancelamento, nada anda.
  if (cancellationPending) return [];
  return NEXT_ACTIONS[order.status].filter((action) => {
    // "Saiu para entrega" só existe quando o motoboy é da loja; com entregador do app quem despacha é o app.
    if (action === "dispatch") return order.fulfillment === "delivery" && order.courier === "merchant";
    // "Pronto para retirar" é para retirada no balcão ou para o entregador do app vir buscar.
    if (action === "ready_for_pickup") return order.fulfillment !== "delivery" || order.courier !== "merchant";
    return true;
  });
}

// Status só anda para frente. Evento atrasado (ex.: CONFIRMED chegando depois de DISPATCHED) não volta o pedido,
// e cancelado é final.
const STATUS_RANK: Readonly<Record<DeliveryOrderStatus, number>> = {
  unknown: -1,
  placed: 0,
  confirmed: 1,
  preparing: 2,
  ready_for_pickup: 3,
  dispatched: 4,
  concluded: 5,
  cancelled: 6,
};

export function mergeDeliveryStatus(current: DeliveryOrderStatus, incoming: DeliveryOrderStatus): DeliveryOrderStatus {
  if (incoming === "unknown" || current === "cancelled") return current;
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : current;
}
