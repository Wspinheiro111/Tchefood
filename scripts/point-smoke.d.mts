// Tipos de scripts/point-smoke.mjs (para os testes em TypeScript).
export type SmokeCheck = { step: string; name: string; result: "PASS" | "FAIL" | "WARN" | "SKIP"; detail: string };

export const DEFAULT_FIXTURES_DIR: string;
export const MAX_AMOUNT_CENTS: number;

export function loadParsers(): Promise<unknown>;
export function replayFetch(records: Array<{ method: string; path: string; status: number; body: unknown }>): typeof fetch;
export function validateRecording(dir: string, parsers?: unknown): Promise<SmokeCheck[]>;
export function summarize(checks: SmokeCheck[]): { pass: number; fail: number; warn: number; skip: number };
export function parseArgs(argv: string[]): Record<string, string | true>;
export function liveOptions(
  args: Record<string, string | true>,
  env: Record<string, string | undefined>,
): {
  token: string;
  terminalId: string;
  amountCents: number;
  method: "credit" | "debit";
  finish: "auto" | "cancel" | "refund" | "none";
  simulate: string | null;
  pollMs: number;
};
