import { describe, expect, it, vi } from "vitest";
import { PaymentTerminalProviderError } from "../shared/paymentTerminal";
import { MercadoPagoPointProvider } from "./mercadoPagoPoint";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeProvider(fetchImpl: ReturnType<typeof vi.fn>) {
  return new MercadoPagoPointProvider({ accessToken: "TEST-token", fetchImpl: fetchImpl as unknown as typeof fetch });
}

function order(overrides: Record<string, unknown> = {}, payment: Record<string, unknown> = {}) {
  return {
    id: "ORD1",
    type: "point",
    status: "processed",
    status_detail: "accredited",
    external_reference: "sale_1",
    config: { point: { terminal_id: "PAX_A910__SN1" } },
    transactions: {
      payments: [
        {
          id: "PAY1",
          reference_id: "1234567890",
          amount: "50.00",
          paid_amount: "50.00",
          status: "processed",
          status_detail: "accredited",
          payment_method: { id: "master", type: "credit_card", installments: 1 },
          ...payment,
        },
      ],
    },
    ...overrides,
  };
}

const request = {
  externalTerminalId: "PAX_A910__SN1",
  amountCents: 5000,
  idempotencyKey: "idem-1",
  externalReference: "sale_1",
};

describe("MercadoPagoPointProvider", () => {
  it("exige access token", () => {
    expect(() => new MercadoPagoPointProvider({ accessToken: "" })).toThrow();
  });

  it("lista terminais e mapeia o modo de operação", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          terminals: [
            { id: "T1", pos_id: 1, store_id: "S1", operating_mode: "PDV" },
            { id: "T2", operating_mode: "STANDALONE" },
            { id: "T3", operating_mode: "X" },
          ],
        },
        paging: { total: 3, offset: 0, limit: 50 },
      }),
    );
    const list = await makeProvider(fetchImpl).listTerminals();
    expect(list.map(t => [t.externalTerminalId, t.operatingMode])).toEqual([
      ["T1", "pdv"],
      ["T2", "standalone"],
      ["T3", "unknown"],
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.mercadopago.com/terminals/v1/list?limit=50&offset=0");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer TEST-token");
  });

  it("cria cobrança com valor em string, idempotência e terminal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, order({ status: "created", status_detail: "created" }, { status: "created", status_detail: "ready_to_process", paid_amount: undefined })));
    const result = await makeProvider(fetchImpl).createCharge({ ...request, method: "credit", installments: 3, installmentsCost: "seller" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.mercadopago.com/v1/orders");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Idempotency-Key"]).toBe("idem-1");
    // O Mercado Pago deduplica pela chave: a criação desconhecida pode ser repetida com a mesma chave.
    expect(makeProvider(fetchImpl).createRetryPolicy).toBe("same_key");
    const sent = JSON.parse(init.body);
    expect(sent.type).toBe("point");
    expect(sent.transactions.payments[0].amount).toBe("50.00");
    expect(sent.config.point.terminal_id).toBe("PAX_A910__SN1");
    expect(sent.config.payment_method).toEqual({ default_type: "credit_card", default_installments: 3, installments_cost: "seller" });
    expect(result.status).toBe("pending");
    expect(result.externalOrderId).toBe("ORD1");
  });

  it("Pix vai como ordem só de QR Code, à vista e sem parcelas", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, order({ status: "created", status_detail: "created" }, { status: "created", status_detail: "created", paid_amount: undefined, payment_method: undefined })));
    const provider = makeProvider(fetchImpl);
    expect(provider.supportedMethods).toEqual(["credit", "debit", "pix"]);
    await provider.createCharge({ ...request, method: "pix" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).config.payment_method).toEqual({ default_type: "qr" });
    await expect(provider.createCharge({ ...request, method: "pix", installments: 2, installmentsCost: "seller" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.createCharge({ ...request, method: "boleto" as never })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pagamento QR só é Pix com bank_transfer/pix; saldo em conta ou tipo novo fica sem tipo", async () => {
    const typeOf = async (method: Record<string, unknown>) =>
      (await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({}, { payment_method: { installments: 1, ...method } })))).getCharge("ORD1")).paymentMethodType;
    expect(await typeOf({ id: "pix", type: "bank_transfer" })).toBe("pix");
    expect(await typeOf({ id: "account_money", type: "account_money" })).toBeNull();
    expect(await typeOf({ id: "outro", type: "bank_transfer" })).toBeNull();
    expect(await typeOf({ id: "pix", type: "qr" })).toBeNull();
    expect(await typeOf({ id: "visa", type: "debit_card" })).toBe("debit_card");
  });

  it("recusa pedido inválido antes de chamar a rede", async () => {
    const fetchImpl = vi.fn();
    const provider = makeProvider(fetchImpl);
    await expect(provider.createCharge({ ...request, amountCents: 0 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.createCharge({ ...request, externalReference: "tem espaço" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.createCharge({ ...request, idempotencyKey: "" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aprova somente com pagamento processed/accredited e valor pago igual", async () => {
    const approved = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order()))).getCharge("ORD1");
    expect(approved.status).toBe("approved");
    expect(approved.paidAmountCents).toBe(5000);
    expect(approved.externalPaymentId).toBe("1234567890");
    expect(approved.externalTransactionId).toBe("PAY1");
    expect(approved.paymentMethodType).toBe("credit_card");

    const divergent = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({}, { paid_amount: "40.00" })))).getCharge("ORD1");
    expect(divergent.status).toBe("approved");
    expect(divergent.paidAmountCents).toBe(4000);

    const unknown = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({ status: "novo" }, { status: "novo", status_detail: "x" })))).getCharge("ORD1");
    expect(unknown.status).toBe("manual_review");
  });

  it("status da transação prevalece sobre o da ordem", async () => {
    const result = await makeProvider(
      vi.fn().mockResolvedValue(jsonResponse(200, order({ status: "processed" }, { status: "failed", status_detail: "rejected_by_issuer", paid_amount: undefined }))),
    ).getCharge("ORD1");
    expect(result.status).toBe("rejected");
  });

  it("resposta malformada vira malformed_response", async () => {
    await expect(makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, { foo: 1 }))).getCharge("ORD1")).rejects.toMatchObject({ code: "malformed_response" });
    await expect(makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({}, { amount: "1,00" })))).getCharge("ORD1")).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("cancelamento 202 fica pendente de confirmação e envia o header at_terminal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { id: "ORD1", status: "at_terminal", transactions: { payments: [{ id: "PAY1", status: "at_terminal" }] } }));
    const result = await makeProvider(fetchImpl).cancelCharge("ORD1", { idempotencyKey: "idem-c" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.mercadopago.com/v1/orders/ORD1/cancel");
    expect(init.headers["x-allow-cancelable-status"]).toBe("at_terminal");
    expect(init.headers["X-Idempotency-Key"]).toBe("idem-c");
    expect(result.outcome).toBe("cancellation_pending");
    expect(result.charge).toBeNull();
  });

  it("cancelamento 200 com ordem cancelada conclui", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, order({ status: "canceled" }, { status: "canceled", status_detail: "canceled", paid_amount: undefined })));
    const result = await makeProvider(fetchImpl).cancelCharge("ORD1", { idempotencyKey: "idem-c" });
    expect(result.outcome).toBe("cancelled");
  });

  it("mapeia erros HTTP", async () => {
    const codeFor = async (status: number, body: unknown = {}) => {
      try {
        await makeProvider(vi.fn().mockResolvedValue(jsonResponse(status, body))).getCharge("ORD1");
      } catch (e) {
        return (e as PaymentTerminalProviderError).code;
      }
      return null;
    };
    expect(await codeFor(401)).toBe("unauthorized");
    expect(await codeFor(403)).toBe("unauthorized");
    expect(await codeFor(403, { errors: [{ code: "forbidden_checking_terminal_owner" }] })).toBe("not_found");
    expect(await codeFor(404)).toBe("not_found");
    expect(await codeFor(409, { errors: [{ code: "idempotency_key_already_used" }] })).toBe("idempotency_conflict");
    expect(await codeFor(409, { errors: [{ code: "already_queued_order_on_terminal" }] })).toBe("terminal_busy");
    expect(await codeFor(409, { errors: [{ code: "already_queued_order_for_terminal" }] })).toBe("terminal_busy");
    expect(await codeFor(409, { errors: [{ code: "cannot_cancel_order" }] })).toBe("not_cancellable");
    expect(await codeFor(409, { errors: [{ code: "order_already_canceled" }] })).toBe("not_cancellable");
    expect(await codeFor(409, { errors: [{ code: "outro" }] })).toBe("invalid_request");
    expect(await codeFor(400)).toBe("invalid_request");
    expect(await codeFor(500)).toBe("unavailable");
  });

  it("falha de rede em escrita marca resultado desconhecido; em leitura não", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const write = await makeProvider(failing).createCharge(request).catch(e => e as PaymentTerminalProviderError);
    expect(write).toBeInstanceOf(PaymentTerminalProviderError);
    expect((write as PaymentTerminalProviderError).code).toBe("unavailable");
    expect((write as PaymentTerminalProviderError).outcomeUnknown).toBe(true);

    const read = await makeProvider(failing).getCharge("ORD1").catch(e => e as PaymentTerminalProviderError);
    expect((read as PaymentTerminalProviderError).outcomeUnknown).toBe(false);
  });

  it("timeout em escrita vira timeout com resultado desconhecido", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const err = await makeProvider(vi.fn().mockRejectedValue(abortError)).createCharge(request).catch(e => e as PaymentTerminalProviderError);
    expect((err as PaymentTerminalProviderError).code).toBe("timeout");
    expect((err as PaymentTerminalProviderError).outcomeUnknown).toBe(true);
  });

  it("408, 425 e 429 na criação deixam o resultado desconhecido; na consulta não", async () => {
    const errorFor = async (status: number, call: "create" | "get" | "cancel") => {
      const provider = makeProvider(vi.fn().mockResolvedValue(jsonResponse(status, {})));
      const promise =
        call === "create" ? provider.createCharge(request) : call === "get" ? provider.getCharge("ORD1") : provider.cancelCharge("ORD1", { idempotencyKey: "cancel-1" });
      const err = await promise.then(() => null, e => e as PaymentTerminalProviderError);
      expect(err).toBeInstanceOf(PaymentTerminalProviderError);
      return { code: err!.code, httpStatus: err!.httpStatus, outcomeUnknown: err!.outcomeUnknown };
    };
    expect(await errorFor(408, "create")).toEqual({ code: "timeout", httpStatus: 408, outcomeUnknown: true });
    expect(await errorFor(425, "create")).toEqual({ code: "unavailable", httpStatus: 425, outcomeUnknown: true });
    expect(await errorFor(429, "create")).toEqual({ code: "unavailable", httpStatus: 429, outcomeUnknown: true });
    expect(await errorFor(408, "cancel")).toEqual({ code: "timeout", httpStatus: 408, outcomeUnknown: true });
    expect(await errorFor(429, "cancel")).toEqual({ code: "unavailable", httpStatus: 429, outcomeUnknown: true });
    expect(await errorFor(408, "get")).toEqual({ code: "timeout", httpStatus: 408, outcomeUnknown: false });
    expect(await errorFor(425, "get")).toEqual({ code: "unavailable", httpStatus: 425, outcomeUnknown: false });
    expect(await errorFor(429, "get")).toEqual({ code: "unavailable", httpStatus: 429, outcomeUnknown: false });
    // 4xx definitivos continuam sem incerteza na criação.
    expect(await errorFor(400, "create")).toEqual({ code: "invalid_request", httpStatus: 400, outcomeUnknown: false });
  });

  it("criação desconhecida pode ser repetida com a mesma chave e o mesmo corpo (same_key)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(408, {})).mockResolvedValueOnce(jsonResponse(201, order()));
    const provider = makeProvider(fetchImpl);
    expect(provider.createRetryPolicy).toBe("same_key");
    const first = await provider.createCharge(request).catch(e => e as PaymentTerminalProviderError);
    expect((first as PaymentTerminalProviderError).outcomeUnknown).toBe(true);
    const retried = await provider.createCharge(request);
    expect(retried.externalOrderId).toBe("ORD1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchImpl.mock.calls[0];
    const [, secondInit] = fetchImpl.mock.calls[1];
    expect(firstInit.headers["X-Idempotency-Key"]).toBe("idem-1");
    expect(secondInit.headers["X-Idempotency-Key"]).toBe("idem-1");
    expect(secondInit.body).toBe(firstInit.body);
  });

  it("nunca vaza o token em mensagens de erro", async () => {
    const err = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(401, { message: "TEST-token invalid" }))).getCharge("ORD1").then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain("TEST-token");
  });

  it("segue a paginação de terminais", async () => {
    const page = (ids: string[], offset: number, total: number) => jsonResponse(200, { data: { terminals: ids.map(id => ({ id, operating_mode: "PDV" })) }, paging: { total, offset, limit: 2 } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(page(["A", "B"], 0, 3)).mockResolvedValueOnce(page(["C"], 2, 3));
    const list = await makeProvider(fetchImpl).listTerminals();
    expect(list.map(t => t.externalTerminalId)).toEqual(["A", "B", "C"]);
    expect(fetchImpl.mock.calls[1][0]).toContain("offset=2");
  });

  it("falha em vez de devolver lista truncada quando passa do limite de páginas", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, { data: { terminals: [{ id: "X" }] }, paging: { total: 100000 } }));
    await expect(makeProvider(fetchImpl).listTerminals()).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("corpo ilegível ou derrubado após headers em escrita deixa o resultado desconhecido", async () => {
    const brokenBody = { status: 201, text: () => Promise.reject(new Error("reset")) };
    const err = await makeProvider(vi.fn().mockResolvedValue(brokenBody)).createCharge(request).catch(e => e as PaymentTerminalProviderError);
    expect((err as PaymentTerminalProviderError).code).toBe("unavailable");
    expect((err as PaymentTerminalProviderError).outcomeUnknown).toBe(true);

    const garbage = await makeProvider(vi.fn().mockResolvedValue(new Response("<html>", { status: 201 }))).createCharge(request).catch(e => e as PaymentTerminalProviderError);
    expect((garbage as PaymentTerminalProviderError).code).toBe("malformed_response");
    expect((garbage as PaymentTerminalProviderError).outcomeUnknown).toBe(true);
  });

  it("parcelado exige crédito e responsável pelo custo", async () => {
    const fetchImpl = vi.fn();
    const provider = makeProvider(fetchImpl);
    await expect(provider.createCharge({ ...request, method: "credit", installments: 3 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.createCharge({ ...request, method: "debit", installments: 2, installmentsCost: "seller" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.createCharge({ ...request, installments: 0 })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aceita parcelas como string numérica na resposta", async () => {
    const result = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({}, { payment_method: { id: "visa", type: "credit_card", installments: "6" } })))).getCharge("ORD1");
    expect(result.installments).toBe(6);
    const bad = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({}, { payment_method: { installments: "abc" } })))).getCharge("ORD1");
    expect(bad.installments).toBeNull();
  });

  it("crédito à vista fixa uma parcela e não envia custo de parcelamento", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, order({ status: "created" }, { status: "created", paid_amount: undefined })));
    await makeProvider(fetchImpl).createCharge({ ...request, method: "credit", installments: 1, installmentsCost: "buyer" });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.config.payment_method).toEqual({ default_type: "credit_card", default_installments: 1 });
  });

  it("não completa o detail da transação com o da ordem", async () => {
    const result = await makeProvider(
      vi.fn().mockResolvedValue(jsonResponse(200, order({ status: "processed", status_detail: "processed" }, { status: "processed", status_detail: undefined }))),
    ).getCharge("ORD1");
    expect(result.status).toBe("manual_review");
  });

  it("listagem nunca devolve resultado parcial silencioso", async () => {
    const list = (body: unknown) => makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, body))).listTerminals();
    const terminals = [{ id: "A", operating_mode: "PDV" }];
    await expect(list({ data: { terminals } })).rejects.toMatchObject({ code: "malformed_response" });
    await expect(list({ data: { terminals }, paging: { total: "1" } })).rejects.toMatchObject({ code: "malformed_response" });
    await expect(list({ data: { terminals: [{ operating_mode: "PDV" }] }, paging: { total: 1 } })).rejects.toMatchObject({ code: "malformed_response" });
    await expect(list({ data: { terminals: [] }, paging: { total: 5 } })).rejects.toMatchObject({ code: "malformed_response" });
    expect(await list({ data: { terminals: [] }, paging: { total: 0 } })).toEqual([]);
  });

  it("transação cancelada/recusada sem detail vai para revisão manual", async () => {
    const r = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({ status: "canceled", status_detail: "canceled" }, { status: "canceled", status_detail: undefined, paid_amount: undefined })))).getCharge("ORD1");
    expect(r.status).toBe("manual_review");
  });

  it("transação processed/processed não aprova (só accredited)", async () => {
    const r = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, order({}, { status: "processed", status_detail: "processed" })))).getCharge("ORD1");
    expect(r.status).toBe("manual_review");
  });

  it("ordem sem transação nunca aprova (sem valor pago confirmado)", async () => {
    const r = await makeProvider(vi.fn().mockResolvedValue(jsonResponse(200, { id: "ORD2", status: "processed", status_detail: "processed", total_amount: "50.00", transactions: {} }))).getCharge("ORD2");
    expect(r.status).toBe("manual_review");
  });

  describe("findChargeByReference (auditoria r5)", () => {
    const NOW = Date.parse("2026-11-14T12:30:00.000Z");
    const CREATED = "2026-11-14T12:00:00.000Z";
    const find = (fetchImpl: ReturnType<typeof vi.fn>, ref = "sale_1", options: { createdAt?: string } = { createdAt: CREATED }) =>
      new MercadoPagoPointProvider({ accessToken: "TEST-token", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW }).findChargeByReference(ref, options);

    it("GET /v1/orders com a referência e a janela em RFC 3339 (gravação - 10 min até agora + 10 min), só leitura", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [order()] }));
      const found = await find(fetchImpl);
      expect(found).toMatchObject({ externalOrderId: "ORD1", externalReference: "sale_1", externalTerminalId: "PAX_A910__SN1", status: "approved", externalPaymentId: "1234567890", amountCents: 5000 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.mercadopago.com/v1/orders?external_reference=sale_1&begin_date=2026-11-14T11%3A50%3A00.000Z&end_date=2026-11-14T12%3A40%3A00.000Z");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.headers.Authorization).toBe("Bearer TEST-token");
      expect(init.headers["X-Idempotency-Key"]).toBeUndefined();
      const query = new URL(url).searchParams;
      expect([...query.keys()]).toEqual(["external_reference", "begin_date", "end_date"]);
      expect(new Date(query.get("begin_date")!).toISOString()).toBe(query.get("begin_date"));
    });

    it("nenhuma ordem: null", async () => {
      expect(await find(vi.fn().mockResolvedValue(jsonResponse(200, { data: [] })))).toBeNull();
    });

    it("só vale referência idêntica e tipo point (ou sem tipo)", async () => {
      const others = [order({ id: "X1", external_reference: "sale_10" }), order({ id: "X2", external_reference: "SALE_1" }), order({ id: "X3", type: "qr" }), order({ id: "X4", external_reference: undefined }), "lixo", null];
      expect(await find(vi.fn().mockResolvedValue(jsonResponse(200, { data: others })))).toBeNull();
      const noType = order({ id: "ORD9" });
      delete (noType as Record<string, unknown>).type;
      expect((await find(vi.fn().mockResolvedValue(jsonResponse(200, { data: [...others, noType] }))))?.externalOrderId).toBe("ORD9");
    });

    it("mais de uma ordem com a referência: erro (multiple_orders), não escolhe", async () => {
      const err = await find(vi.fn().mockResolvedValue(jsonResponse(200, { data: [order(), order({ id: "ORD2" })] }))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentTerminalProviderError);
      expect(err).toMatchObject({ code: "malformed_response", detail: "multiple_orders", outcomeUnknown: false });
    });

    it("erro HTTP, rede ou corpo sem lista: erro", async () => {
      await expect(find(vi.fn().mockResolvedValue(jsonResponse(500, {})))).rejects.toMatchObject({ code: "unavailable", outcomeUnknown: false });
      await expect(find(vi.fn().mockResolvedValue(jsonResponse(401, {})))).rejects.toMatchObject({ code: "unauthorized" });
      await expect(find(vi.fn().mockResolvedValue(jsonResponse(404, {})))).rejects.toMatchObject({ code: "not_found" });
      await expect(find(vi.fn().mockRejectedValue(new TypeError("rede")))).rejects.toMatchObject({ code: "unavailable", outcomeUnknown: false });
      await expect(find(vi.fn().mockResolvedValue(jsonResponse(200, {})))).rejects.toMatchObject({ code: "malformed_response" });
      await expect(find(vi.fn().mockResolvedValue(jsonResponse(200, { data: { results: [] } })))).rejects.toMatchObject({ code: "malformed_response" });
      // Ordem com a referência, mas ilegível: erro, nunca "não achou".
      await expect(find(vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ external_reference: "sale_1", type: "point" }] })))).rejects.toMatchObject({ code: "malformed_response" });
    });

    it("referência inválida ou sem a hora da cobrança: recusa antes da rede", async () => {
      const fetchImpl = vi.fn();
      await expect(find(fetchImpl, "x".repeat(65))).rejects.toMatchObject({ code: "invalid_request" });
      await expect(find(fetchImpl, "sale 1")).rejects.toMatchObject({ code: "invalid_request" });
      await expect(find(fetchImpl, "sale_1", {})).rejects.toMatchObject({ code: "invalid_request" });
      await expect(find(fetchImpl, "sale_1", { createdAt: "ontem" })).rejects.toMatchObject({ code: "invalid_request" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
