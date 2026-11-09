/**
 * Regras de segurança do resultado da maquininha — portadas do Tchê Vendas
 * (apps/w9-smart-pagbank/.../PlugPagGateway.kt e providers/stoneConnect.ts).
 *
 * Princípios:
 *  - aprovado só com PROVA COMPLETA: retorno de sucesso do SDK + código "0000"
 *    + NSU + código de autorização + número de série da maquininha;
 *  - qualquer resultado desconhecido ou inconsistente é MANUAL_REVIEW;
 *  - pagamento incerto nunca é repetido automaticamente;
 *  - o mesmo request_id com dados diferentes é conflito de idempotência;
 *  - o sistema NUNCA inventa NSU ou autorização para um pagamento real.
 */
import type { AcquirerType } from '../../types';

/** Códigos do PlugPag (PagBank) com significado conhecido. */
export const PLUGPAG_APPROVED_CODE = '0000';
export const PLUGPAG_CANCELLED_CODES = new Set(['C13', 'B018']);
export const PLUGPAG_REJECTED_CODES = new Set(['B024', 'M3011']);
export const PLUGPAG_BUSY_CODES = new Set(['SV03', 'PP1017', 'PP1047']);

/** Resultado cru que a ponte Android devolve (espelho de PlugPagTransactionResult). */
export interface PlugPagRawResult {
  /** 0 = PlugPag.RET_OK. */
  result: number;
  errorCode?: string | null;
  message?: string | null;
  transactionCode?: string | null;
  transactionId?: string | null;
  hostNsu?: string | null;
  autoCode?: string | null;
  cardBrand?: string | null;
  userReference?: string | null;
  /** Valor em centavos (o PlugPag devolve como texto). */
  amount?: string | number | null;
  terminalSerialNumber?: string | null;
}

export type GuardStatus = 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'BUSY' | 'MANUAL_REVIEW';

export interface GuardVerdict {
  status: GuardStatus;
  /** Código técnico (do SDK ou da regra que reprovou). */
  code: string;
  message: string | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** Mapeia o retorno do PlugPag como o PlugPagGateway do Tchê Vendas. */
export function classifyPlugPagResult(raw: PlugPagRawResult): GuardVerdict {
  const code = clean(raw.errorCode);
  const message = clean(raw.message) || null;
  const sdkSucceeded = raw.result === 0;
  if (sdkSucceeded) {
    // SDK diz sucesso mas o código não é 0000: não dá para saber se cobrou.
    if (code !== PLUGPAG_APPROVED_CODE) return { status: 'MANUAL_REVIEW', code: 'INCONSISTENT_APPROVAL', message };
    if (!clean(raw.transactionCode) || !clean(raw.transactionId)) {
      return { status: 'MANUAL_REVIEW', code: 'APPROVED_WITHOUT_REFERENCE', message };
    }
    return { status: 'APPROVED', code, message };
  }
  if (code === PLUGPAG_APPROVED_CODE) return { status: 'MANUAL_REVIEW', code: 'INCONSISTENT_APPROVAL', message };
  if (PLUGPAG_CANCELLED_CODES.has(code)) return { status: 'CANCELLED', code, message };
  if (code.startsWith('R ') || PLUGPAG_REJECTED_CODES.has(code)) return { status: 'DECLINED', code, message };
  if (PLUGPAG_BUSY_CODES.has(code)) return { status: 'BUSY', code, message };
  return { status: 'MANUAL_REVIEW', code: code || 'UNKNOWN_RESULT', message };
}

export interface ApprovalProof {
  nsu: string | null | undefined;
  authorization_code: string | null | undefined;
  terminal_serial: string | null | undefined;
  /** Valor pago informado pela maquininha, em centavos (null = não informado). */
  paid_amount_cents?: number | null;
  /** Referência devolvida pela maquininha (userReference / code do pedido). */
  reference?: string | null;
}

/**
 * Confere a prova de um pagamento aprovado. Devolve null quando está completa,
 * ou o código do motivo para mandar a revisão manual.
 */
export function missingApprovalProof(
  proof: ApprovalProof,
  expected: { amount_cents: number; reference?: string | null },
): string | null {
  if (!clean(proof.nsu)) return 'APPROVED_WITHOUT_NSU';
  if (!clean(proof.authorization_code)) return 'APPROVED_WITHOUT_AUTHORIZATION';
  if (!clean(proof.terminal_serial)) return 'APPROVED_WITHOUT_TERMINAL';
  if (proof.paid_amount_cents !== undefined && proof.paid_amount_cents !== null && proof.paid_amount_cents !== expected.amount_cents) {
    return 'PAID_AMOUNT_MISMATCH';
  }
  if (expected.reference && proof.reference !== undefined && proof.reference !== null && proof.reference !== expected.reference) {
    return 'REFERENCE_MISMATCH';
  }
  return null;
}

/** Converte o valor do PlugPag (texto ou número, em centavos) sem aceitar lixo. */
export function parseCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : /^\d{1,12}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * userReference do PlugPag (até 10 caracteres alfanuméricos), derivado do
 * request_id por hash: o mesmo pedido sempre gera a mesma referência, o que
 * permite reconferir a "última transação aprovada" depois de uma queda.
 */
export function terminalUserReference(requestId: string): string {
  // FNV-1a 32 bits: síncrono, estável e suficiente para 8 dígitos hex.
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(requestId);
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `TF${h.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Mensagem ao operador para cada motivo de revisão manual. */
export function manualReviewMessage(acquirer: AcquirerType, code: string): string {
  const name = acquirer === 'PAGBANK' ? 'PagBank' : acquirer === 'STONE' ? 'Stone' : 'maquininha';
  return `Não foi possível confirmar o resultado na ${name} (${code}). Confira o extrato da maquininha antes de cobrar de novo.`;
}

/**
 * Registro de idempotência por request_id: repetir a mesma cobrança devolve o
 * mesmo resultado; reutilizar o request_id com outro valor/forma é conflito.
 */
export class IdempotencyRegistry<Req, Res> {
  private readonly entries = new Map<string, { fingerprint: string; result: Promise<Res> }>();

  constructor(private readonly fingerprint: (req: Req) => string) {}

  run(requestId: string, req: Req, exec: () => Promise<Res>, onConflict: () => Res): Promise<Res> {
    const fp = this.fingerprint(req);
    const existing = this.entries.get(requestId);
    if (existing) return existing.fingerprint === fp ? existing.result : Promise.resolve(onConflict());
    const result = exec();
    this.entries.set(requestId, { fingerprint: fp, result });
    return result;
  }
}

/** Fila que serializa comandos bloqueantes do SDK (uma operação por vez). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
