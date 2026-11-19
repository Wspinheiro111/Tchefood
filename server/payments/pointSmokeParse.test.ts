// Validador offline de scripts/point-smoke.mjs contra os fixtures montados com os mocks dos testes do Mercado Pago
// Point. Quando houver gravação real da Point, a mesma conferência roda nela (node scripts/point-smoke.mjs --dry-run --dir=...).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FIXTURES_DIR, liveOptions, parseArgs, summarize, validateRecording, type SmokeCheck } from "../../scripts/point-smoke.mjs";

const dirs: string[] = [];

function copyFixtures(edit: (name: string, record: { body: Record<string, any>; status: number }) => void, names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "point-smoke-"));
  dirs.push(dir);
  cpSync(DEFAULT_FIXTURES_DIR, dir, { recursive: true });
  for (const name of names) {
    const file = join(dir, `${name}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    edit(name, record);
    writeFileSync(file, JSON.stringify(record));
  }
  return dir;
}

function find(checks: SmokeCheck[], step: string, name: string) {
  const found = checks.find((c) => c.step === step && c.name.startsWith(name));
  if (!found) throw new Error(`checagem ausente: [${step}] ${name}`);
  return found;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("point-smoke: validador offline", () => {
  it("os fixtures dos mocks passam sem FAIL, com os parsers de produção", async () => {
    const checks = await validateRecording(DEFAULT_FIXTURES_DIR);
    expect(checks.filter((c) => c.result === "FAIL")).toEqual([]);
    expect(summarize(checks).pass).toBeGreaterThan(40);
    expect(find(checks, "order", "getCharge (produção)").detail).toContain("status=approved");
    expect(find(checks, "search", "findChargeByReference").result).toBe("PASS");
    // O id curto dos mocks (ORD01) não segue o formato da doc (ORD + 26): aviso, não falha.
    expect(find(checks, "create", "id no formato ORD").result).toBe("WARN");
  });

  it("transaction_amount em texto decimal, como no exemplo da doc de GET /v1/payments, é só aviso: o valor é lido igual", async () => {
    const dir = copyFixtures((_, r) => { r.body.transaction_amount = Number(r.body.transaction_amount).toFixed(2); }, ["get-payment"]);
    const checks = await validateRecording(dir);
    expect(find(checks, "payment", "transaction_amount é número").result).toBe("WARN");
    expect(find(checks, "payment", "amountCents = valor cobrado").result).toBe("PASS");
  });

  it("transaction_amount em texto fora do formato decimal estrito é FAIL", async () => {
    const dir = copyFixtures((_, r) => { r.body.transaction_amount = "1e0"; }, ["get-payment"]);
    const checks = await validateRecording(dir);
    expect(find(checks, "payment", "amountCents = valor cobrado").result).toBe("FAIL");
  });

  it("installments em texto (\"1\") e reference_id numérico na ordem continuam aceitos", async () => {
    const dir = copyFixtures((_, r) => {
      r.body.transactions.payments[0].payment_method.installments = "1";
      r.body.transactions.payments[0].reference_id = 123456789;
    }, ["get-order"]);
    const checks = await validateRecording(dir);
    expect(find(checks, "order", "payment_method.installments").result).toBe("PASS");
    expect(find(checks, "order", "reference_id (NSU)").result).toBe("PASS");
    expect(find(checks, "payment", "id = reference_id").result).toBe("PASS");
  });

  it("recusa com detail fora da tabela (rejected_other_reason, do simulador) vai para revisão", async () => {
    const dir = copyFixtures((_, r) => {
      r.body.status = "failed";
      r.body.status_detail = "failed";
      Object.assign(r.body.transactions.payments[0], { status: "failed", status_detail: "rejected_other_reason" });
    }, ["get-order"]);
    const checks = await validateRecording(dir);
    expect(find(checks, "order", "par da transação documentado").result).toBe("WARN");
    expect(find(checks, "order", "status normalizado não é manual_review").result).toBe("WARN");
  });

  it("busca que volta em results[] (outro formato) é FAIL", async () => {
    const dir = copyFixtures((_, r) => { r.body = { results: r.body.data }; }, ["search-orders"]);
    const checks = await validateRecording(dir);
    expect(find(checks, "search", "lista em data[]").result).toBe("FAIL");
    expect(find(checks, "search", "findChargeByReference").result).toBe("FAIL");
  });

  it("terminal diferente do pedido é FAIL", async () => {
    const dir = copyFixtures((_, r) => { r.body.config.point.terminal_id = "OUTRO__SN"; }, ["get-order"]);
    expect(find(await validateRecording(dir), "order", "externalTerminalId ecoado").result).toBe("FAIL");
  });
});

describe("point-smoke: opções da execução ao vivo", () => {
  const env = { MP_ACCESS_TOKEN: "APP_USR-x", MP_TERMINAL_ID: "NEWLAND_N950__SBX0000001" };

  it("padrão 100 centavos, crédito, fim automático", () => {
    expect(liveOptions(parseArgs([]), env)).toMatchObject({ amountCents: 100, method: "credit", finish: "auto", simulate: null });
  });

  it("recusa valor acima de 500 centavos, sem token ou com opção inválida", () => {
    expect(() => liveOptions(parseArgs(["--amount-cents=501"]), env)).toThrow(/500/);
    expect(() => liveOptions(parseArgs(["--amount-cents=1.5"]), env)).toThrow();
    expect(() => liveOptions(parseArgs([]), { MP_TERMINAL_ID: "T" })).toThrow(/MP_ACCESS_TOKEN/);
    expect(() => liveOptions(parseArgs(["--method=pix"]), env)).toThrow();
    expect(() => liveOptions(parseArgs(["--simulate"]), env)).toThrow();
    expect(() => liveOptions(parseArgs(["--simulate=processed"]), { ...env, MP_TERMINAL_ID: "PAX_A910__SMARTPOS123" })).toThrow(/SBX/);
    expect(liveOptions(parseArgs(["--simulate=processed"]), { ...env, MP_TERMINAL_ID: "NEWLAND_N950__SBX0000001" })).toMatchObject({ simulate: "processed" });
  });
});
