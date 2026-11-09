// Simulador da iFood Merchant API em memória. Responde pelo mesmo fetch que o adapter usa, então o
// IfoodMerchantApi roda igual contra ele e contra o iFood real. Serve para testes e para a tela de
// demonstração enquanto não existem credenciais de homologação. Nada aqui fala com a internet.

type SandboxEvent = { id: string; code: string; fullCode: string; orderId: string; merchantId: string; createdAt: string };

type SandboxOrder = {
  body: Record<string, unknown>;
  lastCode: string;
  fulfillment: string;
  deliveredBy: string | null;
};

export type IfoodSandboxOrderInput = {
  displayId?: string;
  customerName?: string;
  orderType?: "DELIVERY" | "TAKEOUT";
  deliveredBy?: "IFOOD" | "MERCHANT";
  items: Array<{
    name: string;
    externalCode?: string | null;
    quantity: number;
    unitPrice: number;
    observations?: string;
    options?: Array<{ name: string; externalCode?: string; quantity: number; unitPrice: number }>;
  }>;
  deliveryFee?: number;
  benefits?: number;
  payment?: { method: "CREDIT" | "PIX" | "CASH" | "MEAL_VOUCHER"; prepaid: boolean; changeFor?: number };
};

const CODE_NAMES: Readonly<Record<string, string>> = {
  PLC: "PLACED",
  CFM: "CONFIRMED",
  PRS: "PREPARATION_STARTED",
  RTP: "READY_TO_PICKUP",
  DSP: "DISPATCHED",
  CON: "CONCLUDED",
  CAR: "CANCELLATION_REQUESTED",
  CAN: "CANCELLED",
};

// Transições que o iFood aceita a partir do último evento do pedido. Ação fora de ordem = HTTP 400.
const ACTION_RULES: Readonly<Record<string, { from: readonly string[]; code: string }>> = {
  confirm: { from: ["PLC"], code: "CFM" },
  startPreparation: { from: ["CFM"], code: "PRS" },
  readyToPickup: { from: ["CFM", "PRS"], code: "RTP" },
  dispatch: { from: ["CFM", "PRS", "RTP"], code: "DSP" },
};

export const IFOOD_SANDBOX_CANCELLATION_REASONS = [
  { cancelCodeId: "501", description: "Problemas de sistema" },
  { cancelCodeId: "503", description: "Item indisponível" },
  { cancelCodeId: "504", description: "Restaurante sem motoboy" },
  { cancelCodeId: "506", description: "Restaurante fechado" },
] as const;

const round2 = (value: number) => Math.round(value * 100) / 100;

export class IfoodSandbox {
  readonly merchantId: string;
  readonly baseUrl = "https://sandbox.ifood.local";
  private readonly orders = new Map<string, SandboxOrder>();
  private readonly pending: SandboxEvent[] = [];
  private readonly history: SandboxEvent[] = [];
  private readonly issuedTokens = new Set<string>();
  private sequence = 0;
  // Contadores úteis nos testes.
  readonly stats = { polls: 0, acks: 0, tokenRequests: 0 };
  // Falha simulada: a próxima chamada a este caminho responde com o status dado.
  private readonly failures: Array<{ pathIncludes: string; status: number }> = [];

  constructor(
    private readonly credentials = { clientId: "sandbox-client", clientSecret: "sandbox-secret" },
    merchantId = "3f0c1c9e-7a9f-4c51-9d0f-0a9b7c2d1e11",
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.merchantId = merchantId;
  }

  get clientId(): string {
    return this.credentials.clientId;
  }

  get clientSecret(): string {
    return this.credentials.clientSecret;
  }

  failNext(pathIncludes: string, status: number): void {
    this.failures.push({ pathIncludes, status });
  }

  // Revoga todos os tokens, como se tivessem expirado antes da hora.
  revokeTokens(): void {
    this.issuedTokens.clear();
  }

  pendingEventCount(): number {
    return this.pending.length;
  }

  eventHistory(): readonly SandboxEvent[] {
    return this.history;
  }

  lastEventCode(orderId: string): string | null {
    return this.orders.get(orderId)?.lastCode ?? null;
  }

  // Cliente faz um pedido no app: gera o pedido e o evento PLC.
  placeOrder(input: IfoodSandboxOrderInput): string {
    this.sequence += 1;
    const orderId = this.uuid(`order-${this.sequence}`);
    const createdAt = this.clock().toISOString();
    const orderType = input.orderType ?? "DELIVERY";
    const deliveredBy = orderType === "DELIVERY" ? input.deliveredBy ?? "IFOOD" : null;
    const items = input.items.map((item, index) => {
      const options = (item.options ?? []).map((option) => ({
        name: option.name,
        externalCode: option.externalCode,
        quantity: option.quantity,
        unitPrice: option.unitPrice,
        price: round2(option.unitPrice * option.quantity),
      }));
      const optionsPrice = round2(options.reduce((sum, option) => sum + option.price, 0));
      const price = round2(item.unitPrice * item.quantity);
      return {
        index: index + 1,
        id: this.uuid(`item-${this.sequence}-${index}`),
        uniqueId: this.uuid(`unique-${this.sequence}-${index}`),
        name: item.name,
        externalCode: item.externalCode ?? undefined,
        unit: "UN",
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        optionsPrice,
        price,
        totalPrice: round2(price + optionsPrice * item.quantity),
        observations: item.observations,
        options,
      };
    });
    const subTotal = round2(items.reduce((sum, item) => sum + item.totalPrice, 0));
    const deliveryFee = orderType === "DELIVERY" ? input.deliveryFee ?? 0 : 0;
    const benefits = input.benefits ?? 0;
    const orderAmount = round2(subTotal + deliveryFee - benefits);
    const payment = input.payment ?? { method: "CREDIT", prepaid: true };
    const body: Record<string, unknown> = {
      id: orderId,
      displayId: input.displayId ?? String(1000 + this.sequence),
      orderType,
      orderTiming: "IMMEDIATE",
      salesChannel: "IFOOD",
      createdAt,
      merchant: { id: this.merchantId, name: "Galpão Crioulo" },
      customer: {
        id: this.uuid(`customer-${this.sequence}`),
        name: input.customerName ?? "Cliente Teste",
        documentNumber: null,
        phone: { number: "0800 705 0500", localizer: String(10_000_000 + this.sequence), localizerExpiration: createdAt },
      },
      items,
      total: { subTotal, deliveryFee, benefits, orderAmount, additionalFees: 0 },
      payments: {
        prepaid: payment.prepaid ? orderAmount : 0,
        pending: payment.prepaid ? 0 : orderAmount,
        methods: [
          {
            value: orderAmount,
            currency: "BRL",
            method: payment.method,
            type: payment.prepaid ? "ONLINE" : "OFFLINE",
            ...(payment.method === "CREDIT" ? { card: { brand: "MASTERCARD" } } : {}),
            ...(payment.method === "CASH" && payment.changeFor ? { cash: { changeFor: payment.changeFor } } : {}),
          },
        ],
      },
      ...(orderType === "DELIVERY"
        ? {
            delivery: {
              mode: "DEFAULT",
              deliveredBy,
              deliveryDateTime: createdAt,
              deliveryAddress: {
                streetName: "Rua Marechal Floriano",
                streetNumber: "1200",
                formattedAddress: "Rua Marechal Floriano, 1200",
                neighborhood: "Centro",
                complement: "Apto 302",
                reference: "Em frente à Catedral",
                postalCode: "98801000",
                city: "Santo Ângelo",
                state: "RS",
                country: "BR",
              },
            },
          }
        : { takeout: { mode: "DEFAULT", takeoutDateTime: createdAt } }),
    };
    this.orders.set(orderId, { body, lastCode: "PLC", fulfillment: orderType, deliveredBy });
    this.emit(orderId, "PLC");
    return orderId;
  }

  // Ações que só o iFood/cliente fazem (entregador concluiu, cliente cancelou...).
  emitFromMarketplace(orderId: string, code: "CON" | "CAN" | "DSP"): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Pedido inexistente no simulador: ${orderId}`);
    order.lastCode = code;
    this.emit(orderId, code);
  }

  // Reenvia um evento já entregue (o iFood garante "pelo menos uma vez", não "exatamente uma vez").
  redeliver(eventId: string): void {
    const original = this.history.find((event) => event.id === eventId);
    if (!original) throw new Error(`Evento inexistente no simulador: ${eventId}`);
    this.pending.push({ ...original });
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    const failureIndex = this.failures.findIndex((failure) => path.includes(failure.pathIncludes));
    if (failureIndex >= 0) {
      const [failure] = this.failures.splice(failureIndex, 1);
      return json(failure?.status ?? 500, { error: { code: "SimulatedFailure", message: "Falha simulada" } });
    }

    if (method === "POST" && path === "/authentication/v1.0/oauth/token") {
      this.stats.tokenRequests += 1;
      const form = new URLSearchParams(String(init.body ?? ""));
      if (form.get("grantType") !== "client_credentials" || form.get("clientId") !== this.credentials.clientId || form.get("clientSecret") !== this.credentials.clientSecret) {
        return json(401, { error: { code: "Unauthorized", message: "invalid client" } });
      }
      const token = `sandbox-token-${this.stats.tokenRequests}`;
      this.issuedTokens.add(token);
      return json(200, { accessToken: token, type: "bearer", expiresIn: 21_600 });
    }

    const authorization = headerValue(init.headers, "authorization");
    if (!authorization || !this.issuedTokens.has(authorization.replace(/^Bearer\s+/i, ""))) {
      return json(401, { error: { code: "Unauthorized", message: "token expired" } });
    }

    if (method === "GET" && path === "/order/v1.0/events:polling") {
      this.stats.polls += 1;
      const merchants = headerValue(init.headers, "x-polling-merchants");
      const allowed = merchants ? merchants.split(",") : null;
      const events = this.pending.filter((event) => !allowed || allowed.includes(event.merchantId));
      return events.length === 0 ? new Response(null, { status: 204 }) : json(200, events);
    }

    if (method === "POST" && path === "/order/v1.0/events/acknowledgment") {
      this.stats.acks += 1;
      const ids = new Set((JSON.parse(String(init.body ?? "[]")) as Array<{ id: string }>).map((entry) => entry.id));
      const remaining = this.pending.filter((event) => !ids.has(event.id));
      this.pending.splice(0, this.pending.length, ...remaining);
      return new Response(null, { status: 202 });
    }

    const match = /^\/order\/v1\.0\/orders\/([^/]+)(?:\/([A-Za-z]+))?$/.exec(path);
    if (match) {
      const orderId = decodeURIComponent(match[1] ?? "");
      const action = match[2] ?? null;
      const order = this.orders.get(orderId);
      if (!order) return json(404, { error: { code: "NotFound", message: "order not found" } });
      if (method === "GET" && action === null) return json(200, order.body);
      if (method === "GET" && action === "cancellationReasons") {
        return ["CON", "CAN"].includes(order.lastCode) ? new Response(null, { status: 204 }) : json(200, IFOOD_SANDBOX_CANCELLATION_REASONS);
      }
      if (method === "POST" && action === "requestCancellation") {
        if (["CON", "CAN"].includes(order.lastCode)) return json(400, { error: { code: "BadRequest", message: "order already finished" } });
        const body = JSON.parse(String(init.body ?? "{}")) as { cancellationCode?: string };
        if (!IFOOD_SANDBOX_CANCELLATION_REASONS.some((reason) => reason.cancelCodeId === body.cancellationCode)) {
          return json(400, { error: { code: "BadRequest", message: "invalid cancellationCode" } });
        }
        this.emit(orderId, "CAR");
        // No simulador o iFood aceita o cancelamento na hora; na vida real pode levar minutos ou ser negado.
        order.lastCode = "CAN";
        this.emit(orderId, "CAN");
        return new Response(null, { status: 202 });
      }
      const rule = action ? ACTION_RULES[action] : undefined;
      if (method === "POST" && rule) {
        if (!rule.from.includes(order.lastCode)) {
          return json(400, { error: { code: "BadRequest", message: `cannot ${action} from ${order.lastCode}` } });
        }
        if (action === "dispatch" && order.deliveredBy !== "MERCHANT") {
          return json(400, { error: { code: "BadRequest", message: "dispatch only for merchant delivery" } });
        }
        order.lastCode = rule.code;
        this.emit(orderId, rule.code);
        return new Response(null, { status: 202 });
      }
    }

    return json(404, { error: { code: "NotFound", message: `${method} ${path}` } });
  };

  private emit(orderId: string, code: string): void {
    this.sequence += 1;
    const event: SandboxEvent = {
      id: this.uuid(`event-${this.sequence}`),
      code,
      fullCode: CODE_NAMES[code] ?? code,
      orderId,
      merchantId: this.merchantId,
      createdAt: this.clock().toISOString(),
    };
    this.history.push(event);
    this.pending.push(event);
  }

  // UUID determinístico (o simulador precisa ser reproduzível nos testes).
  private uuid(seed: string): string {
    let hash = 0x811c9dc5;
    const hex: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      for (const char of `${seed}#${round}`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      hex.push(hash.toString(16).padStart(8, "0"));
    }
    const raw = hex.join("");
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry ? entry[1] : null;
}
