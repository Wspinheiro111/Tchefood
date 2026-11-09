import { describe, expect, it, vi } from "vitest";
import { PaymentTerminalProviderError } from "../shared/paymentTerminal";
import {
  STONE_ACQUIRER_CNPJ,
  StoneConnectProvider,
  normalizeStoneConnectChargeStatus,
  parseStoneConnectWebhook,
} from "./stoneConnect";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SECRET = "sk_abcdef0123456789";
const SERIAL = "6N021234";
const ORDER = "or_3yqQpAbfBhlzgpY5";
const CHARGE = "ch_NRPl6mouLuZ123FR4";
const REF = "tf0123456789abcdef0123456789abcdef01234567";

function makeProvider(fetchImpl: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return new StoneConnectProvider({
    secretKey: SECRET,
    serviceRefererName: "TCHEFOOD",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(fetchImpl.mock.calls[call][1].body as string);
}

const request = { externalTerminalId: SERIAL, amountCents: 12500, idempotencyKey: REF, externalReference: REF, method: "debit" as const };

function orderBody(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    code: REF,
    amount: 12500,
    currency: "BRL",
    closed: false,
    status: "pending",
    poi_payment_settings: { devices_serial_number: [SERIAL] },
    charges: [],
    ...overrides,
  };
}

// Charge como no exemplo de charge.paid da documentação do Connect.
function paidCharge(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    id: CHARGE,
    code: "38332544765625",
    amount: 12500,
    paid_amount: 12500,
    status: "paid",
    currency: "BRL",
    payment_method: "cash",
    metadata: {
      scheme_name: "MasterCard",
      account_funding_source: "debit",
      authorization_code: "M21111",
      initiator_transaction_key: "6N027946-4.0.0-S1BY3V-9977",
      installment_type: "None",
      terminal_serial_number: SERIAL,
      ...meta,
    },
    ...overrides,
  };
}

function paidOrderFetch(charge: Record<string, unknown> = paidCharge(), order: Record<string, unknown> = {}) {
  return vi.fn()
    .mockResolvedValueOnce(jsonResponse(200, orderBody({ status: "paid", charges: [{ id: CHARGE, status: charge.status }], ...order })))
    .mockResolvedValueOnce(jsonResponse(200, charge));
}

async function expectCode(promise: Promise<unknown>, code: string, outcomeUnknown?: boolean) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(PaymentTerminalProviderError);
  expect((error as PaymentTerminalProviderError).code).toBe(code);
  expect((error as PaymentTerminalProviderError).provider).toBe("stone_connect");
  if (outcomeUnknown !== undefined) expect((error as PaymentTerminalProviderError).outcomeUnknown).toBe(outcomeUnknown);
}

describe("StoneConnectProvider", () => {
  it("exige secret key da loja e o ServiceRefererName do parceiro", () => {
    const base = { secretKey: SECRET, serviceRefererName: "TCHEFOOD" };
    expect(() => new StoneConnectProvider({ ...base, secretKey: "" })).toThrow("stone_connect_secret_key_invalid");
    expect(() => new StoneConnectProvider({ ...base, secretKey: "pk_abcdef0123456789" })).toThrow("stone_connect_secret_key_invalid");
    expect(() => new StoneConnectProvider({ ...base, serviceRefererName: "" })).toThrow("stone_connect_service_referer_required");
    expect(() => new StoneConnectProvider({ ...base, customerName: "x".repeat(65) })).toThrow("stone_connect_customer_name_invalid");
    expect(() => new StoneConnectProvider({ ...base, secretKey: "sk_test_abcdef0123456789" })).not.toThrow();
  });

  it("não lista maquininhas: o Connect não tem essa rota", async () => {
    const fetchImpl = vi.fn();
    expect(await makeProvider(fetchImpl).listTerminals()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cria pedido direto para a maquininha com Basic Auth e ServiceRefererName", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody()));
    const result = await makeProvider(fetchImpl).createCharge({ ...request, description: "Venda balcão" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.pagar.me/core/v5/orders");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${SECRET}:`).toString("base64")}`);
    expect(init.headers.ServiceRefererName).toBe("TCHEFOOD");
    expect(sentBody(fetchImpl)).toEqual({
      code: REF,
      customer: { name: "Consumidor" },
      items: [{ amount: 12500, description: "Venda balcão", quantity: 1, code: REF }],
      closed: false,
      poi_payment_settings: {
        visible: true,
        display_name: "Venda balcão",
        print_order_receipt: false,
        devices_serial_number: [SERIAL],
        payment_setup: { type: "debit", installments: 1 },
      },
    });
    expect(result).toMatchObject({
      provider: "stone_connect",
      externalOrderId: ORDER,
      externalReference: REF,
      externalTerminalId: SERIAL,
      status: "pending",
      amountCents: 12500,
      acquirerCnpj: STONE_ACQUIRER_CNPJ,
    });
  });

  it("monta crédito à vista, parcelado pela loja e pelo emissor", async () => {
    const cases = [
      [{ method: "credit", installments: 1 }, { type: "credit", installments: 1, installment_type: "merchant" }],
      [{ method: "credit", installments: 3, installmentsCost: "seller" }, { type: "credit", installments: 3, installment_type: "merchant" }],
      [{ method: "credit", installments: 6, installmentsCost: "buyer" }, { type: "credit", installments: 6, installment_type: "issuer" }],
    ] as const;
    for (const [input, setup] of cases) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody()));
      await makeProvider(fetchImpl).createCharge({ ...request, ...input });
      expect(sentBody(fetchImpl).poi_payment_settings.payment_setup).toEqual(setup);
    }
  });

  it("sem forma de pagamento deixa o operador escolher na maquininha", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody()));
    await makeProvider(fetchImpl).createCharge({ ...request, method: undefined });
    expect(sentBody(fetchImpl).poi_payment_settings).not.toHaveProperty("payment_setup");
  });

  it("recusa pedido inválido sem chamar a Stone", async () => {
    const invalidRequests = [
      { ...request, externalTerminalId: "abc" },
      { ...request, externalTerminalId: "serial com espaço" },
      { ...request, amountCents: 0 },
      { ...request, amountCents: 10.5 },
      { ...request, externalReference: "x".repeat(53) },
      { ...request, idempotencyKey: "" },
      { ...request, method: "debit" as const, installments: 2 },
      { ...request, method: "credit" as const, installments: 3 },
      { ...request, method: "credit" as const, installments: 19, installmentsCost: "seller" as const },
      { ...request, method: "pix" as unknown as "credit" },
    ];
    for (const input of invalidRequests) {
      const fetchImpl = vi.fn();
      await expectCode(makeProvider(fetchImpl).createCharge(input), "invalid_request");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("criação com resposta 2xx ilegível ou divergente tem resultado desconhecido", async () => {
    for (const body of [{}, { id: "pedido" }, orderBody({ amount: 100 }), orderBody({ code: "outra" })]) {
      await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, body))).createCharge(request), "malformed_response", true);
    }
  });

  it("nunca repete a criação: timeout, queda e 5xx saem com resultado desconhecido", async () => {
    expect(makeProvider(vi.fn()).createRetryPolicy).toBe("never");
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expectCode(makeProvider(vi.fn().mockRejectedValue(abort)).createCharge(request), "timeout", true);
    await expectCode(makeProvider(vi.fn().mockRejectedValue(new Error("ECONNRESET"))).createCharge(request), "unavailable", true);
    for (const status of [404, 408, 429, 500, 502]) {
      const error = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(status, {}))).createCharge(request).catch((e: unknown) => e);
      expect((error as PaymentTerminalProviderError).outcomeUnknown).toBe(true);
    }
  });

  it("4xx de validação e credencial recusada são falhas definitivas", async () => {
    await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(422, { message: "invalid" }))).createCharge(request), "invalid_request", false);
    await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(401, {}))).createCharge(request), "unauthorized", false);
  });

  it("pedido aberto sem charge está aguardando na maquininha", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody()));
    const result = await makeProvider(fetchImpl).getCharge(ORDER);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.pagar.me/core/v5/orders/${ORDER}`);
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("body");
    expect(result).toMatchObject({ status: "pending", externalReference: REF, externalTerminalId: SERIAL, amountCents: 12500 });
  });

  it("pedido fechado como canceled sem charge foi cancelado; outros fechamentos sem charge vão para revisão", async () => {
    const cancelled = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ closed: true, status: "canceled" })))).getCharge(ORDER);
    expect(cancelled.status).toBe("cancelled");
    for (const order of [{ closed: true, status: "paid" }, { closed: true, status: "failed" }, { status: "estranho" }]) {
      const result = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, orderBody(order)))).getCharge(ORDER);
      expect(result.status).toBe("manual_review");
    }
  });

  it("charge paga com NSU, autorização e maquininha aprova a venda", async () => {
    const fetchImpl = paidOrderFetch();
    const result = await makeProvider(fetchImpl).getCharge(ORDER);
    expect(fetchImpl.mock.calls[1][0]).toBe(`https://api.pagar.me/core/v5/charges/${CHARGE}`);
    expect(result).toMatchObject({
      status: "approved",
      externalOrderId: ORDER,
      externalPaymentId: CHARGE,
      externalReference: REF,
      externalTerminalId: SERIAL,
      paidAmountCents: 12500,
      paymentMethodType: "debit_card",
      installments: 1,
      cardBrand: "MasterCard",
      authorizationCode: "M21111",
      nsu: "38332544765625",
      acquirerCnpj: STONE_ACQUIRER_CNPJ,
    });
  });

  it("aceita o metadata em camelCase e lê as parcelas do crédito", async () => {
    const charge = paidCharge({
      metadata: {
        schemeName: "Visa",
        accountFundingSource: "Credit",
        authorizationCode: "A1B2C3",
        installmentQuantity: "3",
        installmentType: "MerchantFinanced",
        terminalSerialNumber: SERIAL,
      },
    });
    const result = await makeProvider(paidOrderFetch(charge)).getCharge(ORDER);
    expect(result).toMatchObject({ status: "approved", paymentMethodType: "credit_card", installments: 3, installmentsCost: "seller", cardBrand: "Visa" });
    const issuer = await makeProvider(paidOrderFetch(paidCharge({}, { account_funding_source: "credit", installment_quantity: "4", installment_type: "IssuerFinanced" }))).getCharge(ORDER);
    expect(issuer).toMatchObject({ installments: 4, installmentsCost: "buyer" });
    // À vista ("None") não informa tipo de parcelado.
    expect((await makeProvider(paidOrderFetch()).getCharge(ORDER)).installmentsCost).toBeNull();
  });

  it("charge paga sem prova completa não aprova", async () => {
    const incomplete = [
      paidCharge({ code: null }),
      paidCharge({}, { authorization_code: null }),
      paidCharge({}, { terminal_serial_number: null }),
      paidCharge({ paid_amount: 12000 }),
      paidCharge({ paid_amount: null }),
      // Charge parcial: paga tudo o que ela própria cobra, mas menos que o pedido.
      paidCharge({ amount: 5000, paid_amount: 5000 }),
    ];
    for (const charge of incomplete) {
      const result = await makeProvider(paidOrderFetch(charge)).getCharge(ORDER);
      expect(result.status).toBe("manual_review");
      expect(result.paidAmountCents).toBeNull();
    }
  });

  it("mapeia estados da charge e manda o desconhecido para revisão", () => {
    expect(normalizeStoneConnectChargeStatus("paid")).toBe("approved");
    expect(normalizeStoneConnectChargeStatus("processing")).toBe("at_terminal");
    // Sozinha a charge negada é recusa; no pedido, evaluateOrder a trata como tentativa (veja os testes acima).
    expect(normalizeStoneConnectChargeStatus("failed")).toBe("rejected");
    expect(normalizeStoneConnectChargeStatus("canceled")).toBe("refunded");
    for (const raw of ["overpaid", "underpaid", "chargedback", "", null]) {
      expect(normalizeStoneConnectChargeStatus(raw)).toBe("manual_review");
    }
  });

  it("duas charges que não são negadas (pagamento dividido ou dobrado) vão para revisão sem consultar charges", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ charges: [{ id: CHARGE, status: "paid" }, { id: "ch_abcdefgh12345678", status: "paid" }] })));
    const result = await makeProvider(fetchImpl).getCharge(ORDER);
    expect(result.status).toBe("manual_review");
    expect(result.rawStatusDetail).toBe("charges:2");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cartão negado não encerra a cobrança: o pedido segue aguardando outro cartão e ainda pode ser cancelado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ charges: [{ id: CHARGE, status: "failed" }] })));
    const result = await makeProvider(fetchImpl).getCharge(ORDER);
    expect(result).toMatchObject({ status: "at_terminal", rawStatus: "failed", rawStatusDetail: "declined:1", externalTerminalId: SERIAL });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const cancelFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, orderBody({ charges: [{ id: CHARGE, status: "failed" }] })))
      .mockResolvedValueOnce(jsonResponse(200, orderBody({ closed: true, status: "canceled" })));
    expect(await makeProvider(cancelFetch).cancelCharge(ORDER, { idempotencyKey: "c" })).toEqual({ outcome: "cancellation_pending", charge: null });
    expect(sentBody(cancelFetch, 1)).toEqual({ status: "canceled" });
  });

  it("pedido aberto marcado como failed pelo cartão negado continua aguardando; failed sem charge negada vai para revisão", async () => {
    const declined = orderBody({ status: "failed", charges: [{ id: CHARGE, status: "failed" }] });
    expect((await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, declined))).getCharge(ORDER)).status).toBe("at_terminal");
    expect((await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ status: "failed" })))).getCharge(ORDER)).status).toBe("manual_review");
  });

  it("negado e depois pago no mesmo pedido: vale o pagamento, consultando só a charge paga", async () => {
    const declinedId = "ch_declined12345678";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, orderBody({ status: "paid", charges: [{ id: declinedId, status: "failed" }, { id: CHARGE, status: "paid" }] })))
      .mockResolvedValueOnce(jsonResponse(200, paidCharge()));
    const result = await makeProvider(fetchImpl).getCharge(ORDER);
    expect(result).toMatchObject({ status: "approved", externalPaymentId: CHARGE, paidAmountCents: 12500 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(`https://api.pagar.me/core/v5/charges/${CHARGE}`);
  });

  it("pagamento em andamento aguarda e não pode ser cancelado", async () => {
    const order = orderBody({ charges: [{ id: CHARGE, status: "processing" }] });
    expect((await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order))).getCharge(ORDER)).status).toBe("at_terminal");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, order));
    await expectCode(makeProvider(fetchImpl).cancelCharge(ORDER, { idempotencyKey: "c" }), "not_cancellable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pedido fechado como canceled só com cartões negados está cancelado", async () => {
    const order = orderBody({ closed: true, status: "canceled", charges: [{ id: CHARGE, status: "failed" }] });
    expect((await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order))).getCharge(ORDER)).status).toBe("cancelled");
  });

  it("charge sem estado embutido é consultada, nunca presumida negada", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, orderBody({ charges: [{ id: CHARGE }] })))
      .mockResolvedValueOnce(jsonResponse(200, paidCharge()));
    expect((await makeProvider(fetchImpl).getCharge(ORDER)).status).toBe("approved");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("mais de 5 charges no pedido vai para revisão sem consultar nenhuma", async () => {
    const charges = Array.from({ length: 6 }, (_, i) => ({ id: `ch_failedcharge000${i}`, status: "failed" }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ charges })));
    const result = await makeProvider(fetchImpl).getCharge(ORDER);
    expect(result).toMatchObject({ status: "manual_review", rawStatusDetail: "charges:6" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cartão pré-pago conta como débito", async () => {
    const result = await makeProvider(paidOrderFetch(paidCharge({}, { account_funding_source: "Prepaid" }))).getCharge(ORDER);
    expect(result).toMatchObject({ status: "approved", paymentMethodType: "debit_card" });
  });

  it("procura o pedido de criação incerta pela referência, conferindo o code de cada resultado", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "or_outraVenda123456", code: "outra" }, { id: ORDER, code: REF }] }))
      .mockResolvedValueOnce(jsonResponse(200, orderBody()));
    const found = await makeProvider(fetchImpl).findChargeByReference(REF);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.pagar.me/core/v5/orders?code=${REF}&page=1&size=10`);
    expect(found).toMatchObject({ externalOrderId: ORDER, externalReference: REF, status: "pending" });
  });

  it("referência sem pedido devolve null; dois pedidos com a mesma referência não se resolvem sozinhos", async () => {
    expect(await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: "or_outraVenda123456", code: "outra" }] }))).findChargeByReference(REF)).toBeNull();
    const two = { data: [{ id: ORDER, code: REF }, { id: "or_segundoPedido1234", code: REF }] };
    await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, two))).findChargeByReference(REF), "malformed_response", false);
    await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, {}))).findChargeByReference(REF), "malformed_response", false);
    await expectCode(makeProvider(vi.fn()).findChargeByReference("x".repeat(53)), "invalid_request");
  });

  it("consulta inexistente é not_found; resposta de outro pedido é ilegível", async () => {
    await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(404, { message: "Order not found" }))).getCharge(ORDER), "not_found");
    await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ id: "or_outroPedido1234" })))).getCharge(ORDER), "malformed_response", false);
    await expectCode(makeProvider(vi.fn()).getCharge("123"), "invalid_request");
  });

  it("cancela só pedido ainda sem pagamento e espera a confirmação", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, orderBody()))
      .mockResolvedValueOnce(jsonResponse(200, orderBody({ closed: true, status: "canceled" })));
    const result = await makeProvider(fetchImpl).cancelCharge(ORDER, { idempotencyKey: "cancel-1" });
    expect(result).toEqual({ outcome: "cancellation_pending", charge: null });
    expect(fetchImpl.mock.calls[1][0]).toBe(`https://api.pagar.me/core/v5/orders/${ORDER}/closed`);
    expect(fetchImpl.mock.calls[1][1].method).toBe("PATCH");
    expect(sentBody(fetchImpl, 1)).toEqual({ status: "canceled" });
  });

  it("pedido já cancelado não é fechado de novo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ closed: true, status: "canceled" })));
    const result = await makeProvider(fetchImpl).cancelCharge(ORDER, { idempotencyKey: "cancel-1" });
    expect(result.outcome).toBe("cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pedido com charge não é cancelável pela API: estorno é na maquininha", async () => {
    const fetchImpl = paidOrderFetch();
    await expectCode(makeProvider(fetchImpl).cancelCharge(ORDER, { idempotencyKey: "cancel-1" }), "not_cancellable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fecha o pedido pago para liberar a fila da maquininha", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, orderBody({ closed: true, status: "paid" })));
    await makeProvider(fetchImpl).closeApprovedOrder(ORDER);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.pagar.me/core/v5/orders/${ORDER}/closed`);
    expect(sentBody(fetchImpl)).toEqual({ status: "paid" });
    await expectCode(makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, orderBody()))).closeApprovedOrder(ORDER), "malformed_response", true);
  });

  it("imprime PNG na maquininha e recusa imagem fora do formato", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("resto")]).toString("base64");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await makeProvider(fetchImpl).print({ externalOrderId: ORDER, type: "NFE", imageBase64: png, widthPx: 384, heightPx: 900 });
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.pagar.me/posconnect/v1/orders/${ORDER}/prints`);
    expect(sentBody(fetchImpl)).toEqual({ type: "NFE", size_v: 900, size_h: 384, format: "png", content: png });
    const bad = [
      { imageBase64: Buffer.from("texto").toString("base64") },
      { widthPx: 389 },
      { heightPx: 1501 },
    ];
    for (const override of bad) {
      const noCall = vi.fn();
      await expectCode(makeProvider(noCall).print({ externalOrderId: ORDER, type: "NFE", imageBase64: png, widthPx: 384, heightPx: 900, ...override }), "invalid_request");
      expect(noCall).not.toHaveBeenCalled();
    }
  });
});

describe("parseStoneConnectWebhook", () => {
  it("extrai só o pedido a reconsultar do charge.paid", () => {
    const hint = parseStoneConnectWebhook({
      id: "hook_j0R8BYh0dS123RQ34",
      type: "charge.paid",
      data: { id: CHARGE, status: "paid", order: { id: ORDER } },
    });
    expect(hint).toEqual({ eventId: "hook_j0R8BYh0dS123RQ34", type: "charge.paid", externalOrderId: ORDER, chargeId: CHARGE, externalReference: null });
  });

  it("traz a referência da venda (code do pedido) só quando tem o formato da nossa referência", () => {
    const body = (code: unknown) => ({ id: "hook_1", type: "charge.paid", data: { id: CHARGE, order: { id: ORDER, code } } });
    expect(parseStoneConnectWebhook(body(REF))?.externalReference).toBe(REF);
    expect(parseStoneConnectWebhook(body("D3MG IQI835"))?.externalReference).toBeNull();
    expect(parseStoneConnectWebhook(body("x".repeat(53)))?.externalReference).toBeNull();
    expect(parseStoneConnectWebhook({ id: "hook_1", type: "order.paid", data: { id: ORDER, code: REF } })?.externalReference).toBe(REF);
  });

  it("aceita eventos de pedido e recusa corpo sem pedido válido", () => {
    expect(parseStoneConnectWebhook({ id: "hook_1", type: "order.closed", data: { id: ORDER } })?.externalOrderId).toBe(ORDER);
    expect(parseStoneConnectWebhook({ id: "hook_1", type: "charge.paid", data: { id: CHARGE } })).toBeNull();
    expect(parseStoneConnectWebhook({ type: "charge.paid", data: { order: { id: ORDER } } })).toBeNull();
    expect(parseStoneConnectWebhook("lixo")).toBeNull();
  });
});
