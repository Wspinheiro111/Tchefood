#!/usr/bin/env node
// scripts/point-smoke.mjs
//
// Teste de fumaça do Mercado Pago Point com respostas REAIS (PR #49): confere, com os MESMOS parsers da produção
// (server/payments/mercadoPagoPoint.ts, supabase/functions/point-charge/mpPayments.ts e brandFromMethodId de
// charge.ts), cada suposição que eles fazem sobre o formato das respostas. Sem dependências novas.
//
// Ao vivo (cobra de verdade, valor pequeno, e no fim cancela ou estorna):
//   MP_ACCESS_TOKEN=APP_USR-... MP_TERMINAL_ID=NEWLAND_N950__N950NCB123456 node scripts/point-smoke.mjs
//   opções: --amount-cents=100 (máx. 500)  --method=credit|debit  --finish=auto|cancel|refund|none
//           --simulate=processed|failed|canceled|expired|action_required  (só conta de teste + Point virtual SBX0000001)
//           --out=<pasta>  --poll-seconds=120
// Sem rede (confere uma pasta já gravada, por padrão os fixtures dos mocks):
//   node scripts/point-smoke.mjs --dry-run [--dir=<pasta>]
//
// O token nunca é impresso nem gravado: o cabeçalho Authorization não é registrado e qualquer ocorrência do
// token em texto de saída é trocada por "***".
//
// Precisa de Node 22.7+ (remoção de tipos do TypeScript). charge.ts usa "parameter properties", então o script se
// reinicia sozinho com --experimental-transform-types. Alternativa: npx vite-node scripts/point-smoke.mjs -- ...
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const DEFAULT_FIXTURES_DIR = join(HERE, "point-smoke-fixtures");
export const MAX_AMOUNT_CENTS = 500;
const BASE_URL = "https://api.mercadopago.com";

// Pares status/status_detail documentados para a Point:
// https://www.mercadopago.com.br/developers/en/docs/mp-point/resources/status-order-transaction
// "canceled/canceled" da ordem não está nessa tabela, mas é o que a referência do cancelamento devolve:
// https://www.mercadopago.com.br/developers/en/reference/in-person-payments/point/orders/cancel-order/post
const DOC_ORDER_PAIRS = new Set([
  "created/created", "at_terminal/at_terminal", "processed/processed", "action_required/action_required",
  "failed/failed", "refunded/refunded", "expired/expired", "canceled/canceled",
]);
const DOC_TRANSACTION_PAIRS = new Set([
  "created/created", "created/ready_to_process", "at_terminal/at_terminal", "at_terminal/cancellation_requested",
  "processed/accredited", "action_required/waiting_payment", "action_required/check_on_terminal", "expired/expired",
  "refunded/refunded", "canceled/canceled", "canceled/canceled_by_api", "canceled/canceled_on_terminal",
  "failed/failed", "failed/bad_filled_card_data", "failed/high_risk", "failed/rejected_by_issuer",
  "failed/required_call_for_authorize", "failed/max_attempts_exceeded", "failed/card_disabled",
  "failed/insufficient_amount", "failed/amount_limit_exceeded", "failed/processing_error",
  "failed/invalid_installments", "failed/in_review",
]);
// Mesmo conjunto de charge.ts (REFUND_PAYMENT_STATUSES): pagamento que prova o estorno.
const REFUND_PAYMENT_STATUSES = new Set(["refunded", "charged_back", "cancelled"]);

// ---------------------------------------------------------------------------------------------- parsers de produção

/** Carrega os módulos de produção (os mesmos arquivos que a Edge Function importa). */
export async function loadParsers() {
  const point = await import("../server/payments/mercadoPagoPoint.ts");
  const mp = await import("../supabase/functions/point-charge/mpPayments.ts");
  const charge = await import("../supabase/functions/point-charge/charge.ts");
  const shared = await import("../server/shared/paymentTerminal.ts");
  return {
    MercadoPagoPointProvider: point.MercadoPagoPointProvider,
    parsePayment: mp.parsePayment,
    createMercadoPagoPayments: mp.createMercadoPagoPayments,
    brandFromMethodId: charge.brandFromMethodId,
    decimalStringToCents: shared.decimalStringToCents,
  };
}

// ---------------------------------------------------------------------------------------------- registro/replay

function stripQuery(path) {
  const i = path.indexOf("?");
  return i < 0 ? path : path.slice(0, i);
}

/** fetch que devolve as respostas gravadas, na ordem, conferindo método e caminho (sem a query). */
export function replayFetch(records) {
  const queue = [...records];
  return async (url, init = {}) => {
    const next = queue.shift();
    const method = (init.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    if (!next) throw new Error(`replay_sem_resposta ${method} ${path}`);
    if (next.method !== method || stripQuery(next.path) !== path) throw new Error(`replay_fora_de_ordem esperado ${next.method} ${next.path}, veio ${method} ${path}`);
    const text = next.body === undefined || next.body === null ? "" : JSON.stringify(next.body);
    return new Response(text === "" ? null : text, { status: next.status, headers: { "content-type": "application/json" } });
  };
}

function readRecord(dir, name) {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------------------------- validador offline

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function errText(error) {
  if (!error) return "";
  const parts = [error.message];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.httpStatus != null) parts.push(`http=${error.httpStatus}`);
  if (error.detail) parts.push(`detail=${error.detail}`);
  return parts.join(" ");
}

/**
 * Confere uma pasta gravada (ao vivo ou fixtures). Devolve a lista de checagens:
 * { step, name, result: "PASS" | "FAIL" | "WARN" | "SKIP", detail }.
 * FAIL = a produção não aprovaria/leria certo uma cobrança boa, ou a resposta contradiz o que foi pedido.
 * WARN = formato fora do documentado (ou não documentado) que o código tolera.
 */
export async function validateRecording(dir, parsers) {
  const p = parsers ?? (await loadParsers());
  const checks = [];
  const add = (step, name, result, detail = "") => checks.push({ step, name, result, detail: String(detail) });
  const ok = (step, name, cond, detail, soft = false) => add(step, name, cond ? "PASS" : soft ? "WARN" : "FAIL", detail);

  const meta = readRecord(dir, "meta");
  if (!meta) {
    add("meta", "meta.json presente", "FAIL", dir);
    return checks;
  }
  const expectedType = meta.method === "debit" ? "debit_card" : "credit_card";
  const providerFor = (records, now) =>
    new p.MercadoPagoPointProvider({ accessToken: "offline-replay", fetchImpl: replayFetch(records), now: now ? () => now : undefined });

  // 1. POST /v1/orders ------------------------------------------------------------------------------------------
  const create = readRecord(dir, "create-order");
  let orderId = null;
  if (!create) add("create", "create-order.json presente", "FAIL");
  else {
    const body = obj(create.body) ?? {};
    ok("create", "HTTP 201", create.status === 201, `status=${create.status}`);
    ok("create", "id é string", typeof body.id === "string", typeof body.id);
    ok("create", "id no formato ORD + 26 caracteres (doc do reembolso)", typeof body.id === "string" && /^ORD[0-9A-Z]{26}$/.test(body.id), body.id, true);
    ok("create", "type = point", body.type === "point", body.type);
    ok("create", "external_reference ecoada", body.external_reference === meta.externalReference, body.external_reference);
    ok("create", "config.point.terminal_id ecoado", obj(obj(body.config)?.point)?.terminal_id === meta.terminalId, obj(obj(body.config)?.point)?.terminal_id);
    const pays = obj(body.transactions)?.payments;
    ok("create", "transactions.payments com 1 item", Array.isArray(pays) && pays.length === 1, Array.isArray(pays) ? pays.length : typeof pays);
    const pay0 = Array.isArray(pays) ? obj(pays[0]) : null;
    ok("create", "payments[0].amount é string decimal", typeof pay0?.amount === "string", `${typeof pay0?.amount} ${JSON.stringify(pay0?.amount)}`);
    ok("create", "payments[0].amount = valor cobrado", p.decimalStringToCents(pay0?.amount) === meta.amountCents, pay0?.amount);
    ok("create", "payments[0].id é string (PAY...)", typeof pay0?.id === "string", pay0?.id);
    ok("create", "payments[0].id começa com PAY", typeof pay0?.id === "string" && pay0.id.startsWith("PAY"), pay0?.id, true);
    try {
      const parsed = await providerFor([create]).createCharge({
        externalTerminalId: meta.terminalId,
        amountCents: meta.amountCents,
        idempotencyKey: meta.externalReference,
        externalReference: meta.externalReference,
        method: meta.method,
        installments: 1,
        description: "Tchê Food",
      });
      orderId = parsed.externalOrderId;
      ok("create", "createCharge (produção) lê a resposta", true, `status=${parsed.status} raw=${parsed.rawStatus}/${parsed.rawStatusDetail}`);
      ok("create", "status inicial pending/at_terminal", parsed.status === "pending" || parsed.status === "at_terminal", parsed.status);
      ok("create", "amountCents lido = valor cobrado", parsed.amountCents === meta.amountCents, parsed.amountCents);
    } catch (error) {
      add("create", "createCharge (produção) lê a resposta", "FAIL", errText(error));
    }
  }

  // 2. GET /v1/orders/{id} (última consulta) --------------------------------------------------------------------
  const got = readRecord(dir, "get-order");
  let order = null;
  if (!got) add("order", "get-order.json presente", "FAIL");
  else {
    const body = obj(got.body) ?? {};
    orderId = orderId ?? body.id ?? null;
    ok("order", "HTTP 200", got.status === 200, `status=${got.status}`);
    ok("order", "par da ordem documentado", DOC_ORDER_PAIRS.has(`${body.status}/${body.status_detail}`), `${body.status}/${body.status_detail}`, true);
    const pay0 = Array.isArray(obj(body.transactions)?.payments) ? obj(body.transactions.payments[0]) : null;
    if (pay0) ok("order", "par da transação documentado", DOC_TRANSACTION_PAIRS.has(`${pay0.status}/${pay0.status_detail}`), `${pay0.status}/${pay0.status_detail}`, true);
    add("order", "total_amount na ordem (só usado sem transação)", body.total_amount === undefined ? "WARN" : "PASS", body.total_amount === undefined ? "ausente (não documentado no GET)" : JSON.stringify(body.total_amount));
    try {
      order = await providerFor([got]).getCharge(String(body.id));
      ok("order", "getCharge (produção) lê a resposta", true, `status=${order.status} raw=${order.rawStatus}/${order.rawStatusDetail}`);
      ok("order", "status normalizado não é manual_review", order.status !== "manual_review", order.status, true);
      ok("order", "externalReference ecoada", order.externalReference === meta.externalReference, order.externalReference);
      ok("order", "externalTerminalId ecoado", order.externalTerminalId === meta.terminalId, order.externalTerminalId);
      ok("order", "amountCents = valor cobrado", order.amountCents === meta.amountCents, order.amountCents);
      if (order.status === "approved") {
        ok("order", "paid_amount é string decimal", typeof pay0?.paid_amount === "string", `${typeof pay0?.paid_amount} ${JSON.stringify(pay0?.paid_amount)}`);
        ok("order", "paidAmountCents = valor cobrado", order.paidAmountCents === meta.amountCents, order.paidAmountCents);
        ok("order", `payment_method.type = ${expectedType}`, order.paymentMethodType === expectedType, obj(pay0?.payment_method)?.type);
        const rawInst = obj(pay0?.payment_method)?.installments;
        ok("order", "payment_method.installments = 1 (número ou texto)", order.installments === 1, `${typeof rawInst} ${JSON.stringify(rawInst)}`, order.installments === null);
        add("order", "tipo de reference_id", "PASS", `${typeof pay0?.reference_id} ${JSON.stringify(pay0?.reference_id)}`);
        ok("order", "reference_id (NSU) só dígitos (exigido por getPayment)", typeof order.externalPaymentId === "string" && /^\d{1,20}$/.test(order.externalPaymentId), order.externalPaymentId);
        ok("order", "payment_method.id é bandeira aceita", p.brandFromMethodId(order.paymentMethodId) !== null, order.paymentMethodId);
      } else {
        add("order", "conferências de aprovação", "SKIP", `ordem ${order.status}`);
      }
    } catch (error) {
      add("order", "getCharge (produção) lê a resposta", "FAIL", errText(error));
    }
  }

  // 3. GET /v1/payments/{reference_id} ---------------------------------------------------------------------------
  const pay = readRecord(dir, "get-payment");
  let payment = null;
  if (!pay) add("payment", "get-payment.json", order?.status === "approved" ? "FAIL" : "SKIP", "ausente");
  else {
    const body = obj(pay.body) ?? {};
    ok("payment", "HTTP 200", pay.status === 200, `status=${pay.status}`);
    try {
      payment = p.parsePayment(pay.body);
      ok("payment", "parsePayment (produção) lê a resposta", true, `id=${payment.id}`);
      if (order?.externalPaymentId) ok("payment", "id = reference_id da ordem", payment.id === order.externalPaymentId, `${payment.id} vs ${order.externalPaymentId}`);
      ok("payment", "transaction_amount é número (texto decimal aceito, aviso)", typeof body.transaction_amount === "number", `${typeof body.transaction_amount} ${JSON.stringify(body.transaction_amount)}`, typeof body.transaction_amount === "string");
      ok("payment", "amountCents = valor cobrado", payment.amountCents === meta.amountCents, payment.amountCents);
      ok("payment", "status = approved", payment.status === "approved", payment.status);
      add("payment", "status_detail", "PASS", JSON.stringify(body.status_detail));
      ok("payment", `payment_type_id = ${expectedType}`, payment.paymentTypeId === expectedType, payment.paymentTypeId);
      ok("payment", "installments = 1 (número)", payment.installments === 1, `${typeof body.installments} ${JSON.stringify(body.installments)}`);
      ok("payment", "authorization_code alfanumérico 1-20", /^[A-Za-z0-9]{1,20}$/.test((payment.authorizationCode ?? "").trim()), JSON.stringify(body.authorization_code));
      const brand = p.brandFromMethodId(payment.paymentMethodId);
      ok("payment", "payment_method_id é bandeira aceita", brand !== null, `${payment.paymentMethodId} -> ${brand}`);
      if (order?.paymentMethodId) ok("payment", "bandeira = a da ordem", p.brandFromMethodId(order.paymentMethodId) === brand, `${order.paymentMethodId} vs ${payment.paymentMethodId}`);
      ok("payment", "card.last_four_digits com 4 dígitos", typeof payment.lastFour === "string" && /^\d{4}$/.test(payment.lastFour), JSON.stringify(obj(body.card)?.last_four_digits), true);
      ok("payment", "external_reference = a da ordem", payment.externalReference === meta.externalReference, JSON.stringify(body.external_reference), payment.externalReference === null);
      const rawOrder = obj(body.order);
      if (payment.orderId) ok("payment", "order.id (ORD...) = ordem", payment.orderId === orderId, payment.orderId);
      else add("payment", "order.id do pagamento", "WARN", rawOrder ? `${JSON.stringify(rawOrder)} (não é id da Orders API; não comparado)` : "ausente");
    } catch (error) {
      add("payment", "parsePayment (produção) lê a resposta", "FAIL", errText(error));
    }
  }

  // 4. GET /v1/orders?external_reference=... ---------------------------------------------------------------------
  const search = readRecord(dir, "search-orders");
  if (!search) add("search", "search-orders.json", "SKIP", "ausente");
  else {
    const body = obj(search.body) ?? {};
    ok("search", "HTTP 200", search.status === 200, `status=${search.status}`);
    ok("search", "lista em data[]", Array.isArray(body.data), Array.isArray(body.data) ? `${body.data.length} item(ns)` : `chaves: ${Object.keys(body).join(",")}`);
    if (Array.isArray(body.data)) {
      const item = obj(body.data.find((it) => obj(it)?.external_reference === meta.externalReference));
      ok("search", "item com a referência", item !== null, item?.id);
      if (item) ok("search", "item.type ausente ou point", item.type == null || item.type === "point", JSON.stringify(item.type));
    }
    if (got && meta.createdAt) {
      try {
        const now = Date.parse(meta.createdAt) + 60_000;
        const found = await providerFor([search, got], now).findChargeByReference(meta.externalReference, { createdAt: meta.createdAt });
        ok("search", "findChargeByReference (produção) acha a ordem", found !== null && found.externalOrderId === orderId, found?.externalOrderId ?? "null");
      } catch (error) {
        add("search", "findChargeByReference (produção) acha a ordem", "FAIL", errText(error));
      }
    }
  }

  // 5. Cancelamento / estorno -------------------------------------------------------------------------------------
  const cancel = readRecord(dir, "cancel-order");
  if (cancel) {
    ok("cancel", "HTTP 200 ou 202", cancel.status === 200 || cancel.status === 202, `status=${cancel.status}`);
    if (cancel.status === 200) {
      const body = obj(cancel.body) ?? {};
      ok("cancel", "ordem canceled/canceled", body.status === "canceled" && body.status_detail === "canceled", `${body.status}/${body.status_detail}`);
      try {
        const res = await providerFor([cancel]).cancelCharge(String(body.id ?? orderId), { idempotencyKey: "offline" });
        ok("cancel", "cancelCharge (produção) = cancelled", res.outcome === "cancelled", res.outcome);
      } catch (error) {
        add("cancel", "cancelCharge (produção) lê a resposta", "FAIL", errText(error));
      }
    }
  }
  const refund = readRecord(dir, "refund-order");
  if (refund) {
    const body = obj(refund.body) ?? {};
    ok("refund", "HTTP 201", refund.status === 201, `status=${refund.status}`);
    add("refund", "status do corpo do estorno", "PASS", `${body.status}/${body.status_detail}`);
  }
  const after = readRecord(dir, "get-order-after");
  if (after) {
    try {
      const res = await providerFor([after]).getCharge(String(obj(after.body)?.id ?? orderId));
      const want = refund ? "refunded" : "cancelled";
      ok("final", `ordem depois = ${want}`, res.status === want, `${res.status} raw=${res.rawStatus}/${res.rawStatusDetail}`, cancel?.status === 202);
    } catch (error) {
      add("final", "getCharge depois do fim", "FAIL", errText(error));
    }
  }
  const payAfter = readRecord(dir, "get-payment-after");
  if (payAfter) {
    try {
      const pa = p.parsePayment(payAfter.body);
      ok("final", "pagamento prova o estorno (REFUND_PAYMENT_STATUSES)", pa.status !== null && REFUND_PAYMENT_STATUSES.has(pa.status), pa.status);
      ok("final", "valor do pagamento estornado = cobrado", pa.amountCents === meta.amountCents, pa.amountCents);
    } catch (error) {
      add("final", "parsePayment depois do estorno", "FAIL", errText(error));
    }
  }
  return checks;
}

export function summarize(checks) {
  const count = (r) => checks.filter((c) => c.result === r).length;
  return { pass: count("PASS"), fail: count("FAIL"), warn: count("WARN"), skip: count("SKIP") };
}

function printChecks(checks, write = (line) => process.stdout.write(`${line}\n`)) {
  for (const c of checks) write(`${c.result.padEnd(4)}  [${c.step}] ${c.name}${c.detail ? `  — ${c.detail}` : ""}`);
  const s = summarize(checks);
  write(`\n${s.pass} PASS, ${s.fail} FAIL, ${s.warn} WARN, ${s.skip} SKIP`);
}

// ---------------------------------------------------------------------------------------------- execução ao vivo

export function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] ?? true;
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Opções da execução ao vivo, conferidas antes de qualquer chamada de rede. */
export function liveOptions(args, env) {
  const token = env.MP_ACCESS_TOKEN ?? "";
  const terminalId = env.MP_TERMINAL_ID ?? "";
  if (!token || !terminalId) throw new Error("defina MP_ACCESS_TOKEN e MP_TERMINAL_ID");
  const amountCents = args["amount-cents"] === undefined ? 100 : Number(args["amount-cents"]);
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error("--amount-cents inválido");
  if (amountCents > MAX_AMOUNT_CENTS) throw new Error(`--amount-cents acima de ${MAX_AMOUNT_CENTS} recusado`);
  const method = args.method === "debit" ? "debit" : args.method === undefined || args.method === "credit" ? "credit" : null;
  if (!method) throw new Error("--method deve ser credit ou debit");
  const finish = args.finish ?? "auto";
  if (!["auto", "cancel", "refund", "none"].includes(finish)) throw new Error("--finish deve ser auto, cancel, refund ou none");
  const simulate = typeof args.simulate === "string" ? args.simulate : null;
  if (args.simulate !== undefined && !["processed", "failed", "canceled", "expired", "action_required"].includes(simulate)) throw new Error("--simulate inválido");
  if (simulate && !/__SBX\d+$/.test(String(env.MP_TERMINAL_ID ?? ""))) throw new Error("--simulate só com a Point virtual de teste (MP_TERMINAL_ID terminando em __SBX…)");
  const pollSeconds = args["poll-seconds"] === undefined ? 120 : Number(args["poll-seconds"]);
  if (!Number.isFinite(pollSeconds) || pollSeconds < 0 || pollSeconds > 900) throw new Error("--poll-seconds inválido");
  return { token, terminalId, amountCents, method, finish, simulate, pollMs: pollSeconds * 1000 };
}

async function live(args) {
  const { token, terminalId, amountCents, method, finish, simulate, pollMs } = liveOptions(args, process.env);
  const scrub = (s) => String(s).split(token).join("***");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(typeof args.out === "string" ? args.out : join(homedir(), "tchefood-point-smoke", stamp));
  mkdirSync(out, { recursive: true });

  const p = await loadParsers();
  // Mesmo formato do registro usado no --dry-run. O Authorization nunca entra no registro.
  let current = null;
  let currentCalls = 0;
  let pollN = 0;
  // Segunda chamada no mesmo passo (ex.: a busca por referência lê a ordem pelo id em seguida) vai para <nome>-2.json.
  const save = (name, record) => {
    currentCalls += 1;
    const file = currentCalls === 1 ? name : `${name}-${currentCalls}`;
    writeFileSync(join(out, `${file}.json`), scrub(JSON.stringify(record, null, 2)) + "\n");
  };
  const recordingFetch = async (url, init = {}) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { _raw_text: text }; }
    const u = new URL(url);
    const rec = { method: (init.method ?? "GET").toUpperCase(), path: u.pathname + u.search, status: res.status, at: new Date().toISOString(), x_request_id: res.headers.get("x-request-id"), body };
    if (current) save(current, rec);
    return new Response(text === "" ? null : text, { status: res.status, headers: res.headers });
  };
  const as = (name) => { current = name; currentCalls = 0; };
  const provider = new p.MercadoPagoPointProvider({ accessToken: token, fetchImpl: recordingFetch });
  const payments = p.createMercadoPagoPayments({ accessToken: token, fetchImpl: recordingFetch });
  const say = (line) => process.stdout.write(scrub(line) + "\n");
  const raw = async (name, method, path, body) => {
    as(name);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "X-Idempotency-Key": randomUUID() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await recordingFetch(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.status;
  };

  // Chave nova a cada execução, como a produção: chave = referência (UUID).
  const key = randomUUID();
  const createdAt = new Date().toISOString();
  writeFileSync(join(out, "meta.json"), JSON.stringify({ amountCents, terminalId, externalReference: key, method, createdAt, simulate, finish }, null, 2) + "\n");
  say(`Pasta: ${out}`);
  say(`Cobrança de ${(amountCents / 100).toFixed(2)} (${method}) na maquininha ${terminalId}, referência ${key}`);

  as("create-order");
  let order;
  try {
    order = await provider.createCharge({ externalTerminalId: terminalId, amountCents, idempotencyKey: key, externalReference: key, method, installments: 1, description: "Tchê Food" });
  } catch (error) {
    say(`Criação falhou: ${errText(error)} (veja create-order.json)`);
    throw Object.assign(new Error("create_failed"), { quiet: true });
  }
  say(`Ordem ${order.externalOrderId}: ${order.status} (${order.rawStatus}/${order.rawStatusDetail})`);

  if (simulate) {
    const body = { status: simulate };
    if (simulate === "processed" || simulate === "failed") {
      body.payment_method_type = method === "debit" ? "debit_card" : "credit_card";
      body.payment_method_id = method === "debit" ? "debmaster" : "master";
      if (method === "credit") body.installments = 1;
    }
    const st = await raw("simulate-event", "POST", `/v1/orders/${encodeURIComponent(order.externalOrderId)}/events`, body);
    say(`Evento simulado ${simulate}: HTTP ${st}`);
  } else {
    say("Passe o cartão na maquininha agora.");
  }

  const deadline = Date.now() + pollMs;
  for (;;) {
    pollN += 1;
    as(`poll-${String(pollN).padStart(3, "0")}`);
    try {
      order = await provider.getCharge(order.externalOrderId);
    } catch (error) {
      say(`Consulta falhou: ${errText(error)}`);
    }
    if (!["pending", "at_terminal"].includes(order.status) || Date.now() > deadline) break;
    await sleep(2000);
  }
  // A última consulta gravada vira get-order.json.
  for (let n = pollN; n >= 1; n -= 1) {
    const file = join(out, `poll-${String(n).padStart(3, "0")}.json`);
    if (existsSync(file)) { writeFileSync(join(out, "get-order.json"), readFileSync(file)); break; }
  }
  say(`Ordem depois de ${pollN} consulta(s): ${order.status} (${order.rawStatus}/${order.rawStatusDetail})`);

  if (order.externalPaymentId) {
    as("get-payment");
    try {
      await payments.getPayment(order.externalPaymentId);
    } catch (error) {
      say(`Leitura do pagamento falhou: ${scrub(error.message)} (veja get-payment.json)`);
    }
  }

  as("search-orders");
  try {
    const found = await provider.findChargeByReference(key, { createdAt });
    say(`Busca por referência: ${found ? found.externalOrderId : "nada"}`);
  } catch (error) {
    say(`Busca por referência falhou: ${errText(error)}`);
  }
  let action = finish;
  // Havendo pagamento capturado (reference_id na ordem), estorna, mesmo que o status lido seja de revisão manual.
  const captured = order.status === "approved" || Boolean(order.externalPaymentId);
  if (finish === "auto") action = captured ? "refund" : ["pending", "at_terminal"].includes(order.status) ? "cancel" : "none";
  if (action === "cancel") {
    as("cancel-order");
    try {
      const res = await provider.cancelCharge(order.externalOrderId, { idempotencyKey: randomUUID() });
      say(`Cancelamento: ${res.outcome}`);
    } catch (error) {
      say(`Cancelamento falhou: ${errText(error)}`);
    }
  } else if (action === "refund") {
    // A produção não estorna pela API (só lê o estorno). Corpo vazio = estorno total (doc do refund).
    const st = await raw("refund-order", "POST", `/v1/orders/${encodeURIComponent(order.externalOrderId)}/refund`, undefined);
    say(`Estorno: HTTP ${st}`);
  }
  if (action !== "none") {
    await sleep(action === "cancel" ? 5000 : 3000);
    as("get-order-after");
    try {
      const last = await provider.getCharge(order.externalOrderId);
      say(`Ordem no fim: ${last.status} (${last.rawStatus}/${last.rawStatusDetail})`);
      if (last.status === "approved") say(`\nATENÇÃO: a ordem ficou APROVADA e não foi estornada. Estorne no app do Mercado Pago (ordem ${order.externalOrderId}).`);
    } catch (error) {
      say(`Consulta final falhou: ${errText(error)}`);
    }
    if (action === "refund" && order.externalPaymentId) {
      as("get-payment-after");
      try { await payments.getPayment(order.externalPaymentId); } catch (error) { say(`Pagamento final falhou: ${scrub(error.message)}`); }
    }
  }
  current = null;

  say("\nConferências:");
  const checks = await validateRecording(out, p);
  printChecks(checks, say);
  writeFileSync(join(out, "checks.json"), scrub(JSON.stringify(checks, null, 2)) + "\n");
  if (captured && action !== "refund") say(`\nATENÇÃO: há pagamento capturado e NÃO foi pedido estorno (--finish=${finish}, status ${order.status}). Estorne no app do Mercado Pago (ordem ${order.externalOrderId}).`);
  return checks;
}

// ---------------------------------------------------------------------------------------------- entrada

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  if (args["dry-run"]) {
    const dir = resolve(typeof args.dir === "string" ? args.dir : DEFAULT_FIXTURES_DIR);
    process.stdout.write(`Conferindo ${dir} (sem rede)\n`);
    const checks = await validateRecording(dir);
    printChecks(checks);
    return summarize(checks).fail > 0 ? 1 : 0;
  }
  const checks = await live(args);
  return summarize(checks).fail > 0 ? 1 : 0;
}

function needsTransformFlag() {
  return !process.execArgv.some((a) => a.startsWith("--experimental-transform-types")) && !process.env.VITEST && !process.env.POINT_SMOKE_CHILD;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  if (needsTransformFlag()) {
    // charge.ts tem "parameter properties": só carrega com a transformação de tipos do Node.
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
      cwd: ROOT,
      env: { ...process.env, POINT_SMOKE_CHILD: "1" },
    });
    if (r.error || r.status === 9) process.stderr.write("Node sem --experimental-transform-types (precisa 22.7+). Use: npx vite-node scripts/point-smoke.mjs -- <opções>\n");
    process.exit(r.status ?? 1);
  }
  main().then(
    (code) => process.exit(code),
    (error) => {
      const token = process.env.MP_ACCESS_TOKEN;
      const msg = error?.quiet ? "" : String(error?.message ?? error);
      if (msg) process.stderr.write(`Erro: ${token ? msg.split(token).join("***") : msg}\n`);
      process.exit(2);
    },
  );
}

