/**
 * Mercado Pago Point Smart pela nuvem (TEF POS Sem Fio).
 *
 * O app não fala com o Mercado Pago: pede a cobrança à Edge Function point-charge
 * (supabase/functions/point-charge), que guarda a cobrança, manda a ordem para a
 * maquininha e confere o resultado. O app só reconsulta até a resposta final.
 *
 * Regras:
 *  - Aprovado só com a resposta APPROVED do servidor, com valor e forma iguais aos
 *    pedidos e comprovante completo (NSU = ID do pagamento no Mercado Pago,
 *    autorização e bandeira). O banco ainda confere de novo ao gravar o pagamento.
 *  - Sem resposta final no prazo, pede o cancelamento na maquininha e só devolve
 *    recusa quando o servidor confirma cancelada; senão vira revisão manual.
 *  - Falha de rede nunca vira recusa: a cobrança pode ter chegado à maquininha.
 *    Só "cobrança não encontrada" no servidor prova que nada foi enviado.
 *  - Pix pela Point ainda não: a cobrança nem começa.
 */
import type { OperationMode, PosTerminal } from '../../types';
import type { SyncConfig } from '../sync/supabaseSync';
import {
  ACQUIRER_CNPJ,
  MockTerminalDriver,
  guardApproved,
  type ChargeRequest,
  type IPaymentTerminalDriver,
  type TerminalResult,
} from './drivers';

export type PointFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

export interface PointDriverDeps {
  /** Sessão da nuvem com token válido; null = loja não conectada. */
  config: () => Promise<SyncConfig | null>;
  fetch: PointFetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Tempo esperando o cartão antes de pedir o cancelamento na maquininha. */
export const POINT_WAIT_MS = 120_000;
/** Depois do pedido de cancelamento, quanto tempo esperar a confirmação. */
export const POINT_CANCEL_WAIT_MS = 30_000;
export const POINT_POLL_MS = 2_000;

type Reply =
  | { status: 'PENDING' }
  | { status: 'APPROVED'; nsu: string; authorization_code: string; card_brand: 'VISA' | 'MASTERCARD' | 'ELO'; last_four: string | null; terminal_serial: string; amount_cents: number; method: 'CREDIT' | 'DEBIT' }
  | { status: 'DECLINED'; reason: string }
  | { status: 'MANUAL_REVIEW'; reason: string; code: string };

type CallOutcome =
  | { kind: 'reply'; reply: Reply }
  | { kind: 'rejected'; httpStatus: number; error: string; message: string }
  | { kind: 'unknown' };

const BRANDS = new Set(['VISA', 'MASTERCARD', 'ELO']);

function parseReply(text: string): Reply | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (body.status) {
    case 'PENDING':
      return { status: 'PENDING' };
    case 'DECLINED':
      return { status: 'DECLINED', reason: typeof body.reason === 'string' ? body.reason : 'Transação recusada.' };
    case 'MANUAL_REVIEW':
      return {
        status: 'MANUAL_REVIEW',
        reason: typeof body.reason === 'string' ? body.reason : 'Confira no app do Mercado Pago antes de cobrar de novo.',
        code: typeof body.code === 'string' ? body.code : 'MANUAL_REVIEW',
      };
    case 'APPROVED': {
      const { nsu, authorization_code, card_brand, last_four, terminal_serial, amount_cents, method } = body;
      if (typeof nsu !== 'string' || typeof authorization_code !== 'string' || typeof card_brand !== 'string' || !BRANDS.has(card_brand)
        || typeof terminal_serial !== 'string' || typeof amount_cents !== 'number' || (method !== 'CREDIT' && method !== 'DEBIT')) {
        return null;
      }
      return {
        status: 'APPROVED', nsu, authorization_code, card_brand: card_brand as 'VISA' | 'MASTERCARD' | 'ELO',
        last_four: typeof last_four === 'string' && /^\d{4}$/.test(last_four) ? last_four : null, terminal_serial, amount_cents, method,
      };
    }
    default:
      return null;
  }
}

export class MercadoPagoPointDriver implements IPaymentTerminalDriver {
  readonly acquirer = 'MERCADO_PAGO' as const;
  private readonly aborted = new Set<string>();
  private readonly printer: MockTerminalDriver;

  constructor(
    readonly mode: OperationMode,
    readonly terminal: PosTerminal | null,
    private readonly deps: PointDriverDeps,
  ) {
    // A Point é comandada pela nuvem: o comprovante da loja sai pelo simulador/impressora do app.
    this.printer = new MockTerminalDriver('STONE', mode, terminal);
  }

  private serial(): string {
    return this.terminal?.serial_number ?? 'MERCADO-PAGO-POINT';
  }

  private declined(reason: string): TerminalResult {
    return { status: 'DECLINED', acquirer: 'MERCADO_PAGO', reason, terminal_serial: this.serial(), terminal_id: this.terminal?.id ?? null };
  }

  private review(reason: string, code: string): TerminalResult {
    return { status: 'MANUAL_REVIEW', acquirer: 'MERCADO_PAGO', reason, failure_code: code, terminal_serial: this.serial(), terminal_id: this.terminal?.id ?? null };
  }

  private async call(body: Record<string, unknown>): Promise<CallOutcome> {
    const cfg = await this.deps.config().catch(() => null);
    if (!cfg) return { kind: 'unknown' };
    let res: { status: number; text(): Promise<string> };
    let text: string;
    try {
      res = await this.deps.fetch(`${cfg.url.replace(/\/+$/, '')}/functions/v1/point-charge`, {
        method: 'POST',
        headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch {
      return { kind: 'unknown' };
    }
    if (res.status === 200) {
      const reply = parseReply(text);
      return reply ? { kind: 'reply', reply } : { kind: 'unknown' };
    }
    let error = 'http';
    let message = `HTTP ${res.status}`;
    try {
      const b = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof b.error === 'string') error = b.error;
      if (typeof b.message === 'string') message = b.message;
    } catch {
      // corpo ilegível
    }
    // 5xx, 401 (sessão vencida no meio) e afins não provam nada sobre a maquininha.
    if (res.status >= 500 || res.status === 401) return { kind: 'unknown' };
    return { kind: 'rejected', httpStatus: res.status, error, message };
  }

  private toResult(reply: Reply, req: ChargeRequest): TerminalResult | null {
    if (reply.status === 'PENDING') return null;
    if (reply.status === 'DECLINED') return this.declined(reply.reason);
    if (reply.status === 'MANUAL_REVIEW') return this.review(reply.reason, reply.code);
    const cents = Math.round(req.amount * 100);
    if (reply.amount_cents !== cents || reply.method !== req.method) {
      return this.review('O Mercado Pago aprovou outro valor ou outra forma. Confira no app do Mercado Pago antes de cobrar de novo.', 'APPROVED_MISMATCH');
    }
    if (this.terminal && reply.terminal_serial !== this.terminal.serial_number) {
      return this.review('O Mercado Pago aprovou em outra maquininha. Confira no app do Mercado Pago.', 'TERMINAL_MISMATCH');
    }
    return guardApproved({
      status: 'APPROVED',
      acquirer: 'MERCADO_PAGO',
      acquirer_cnpj: ACQUIRER_CNPJ.MERCADO_PAGO,
      card_brand: reply.card_brand,
      nsu: reply.nsu,
      authorization_code: reply.authorization_code,
      terminal_serial: reply.terminal_serial,
      terminal_id: this.terminal?.id ?? null,
      masked_pan: reply.last_four ? `************${reply.last_four}` : null,
      mode: this.mode,
    }, req);
  }

  async charge(req: ChargeRequest): Promise<TerminalResult> {
    if (req.method !== 'CREDIT' && req.method !== 'DEBIT') return this.declined('Pela Point Smart esta versão cobra só crédito à vista e débito. Use outra forma para Pix.');
    if (!this.terminal) return this.declined('Selecione a maquininha Point Smart.');
    const cfg = await this.deps.config().catch(() => null);
    if (!cfg) return this.declined('Conecte a loja à nuvem para cobrar na Point Smart.');
    const key = req.idempotency_key;
    const amountCents = Math.round(req.amount * 100);
    this.aborted.delete(req.request_id);

    // 1) Criação. Rede caiu: repete com a mesma chave (o servidor não cria outra).
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
      const out = await this.call({ action: 'create', terminal_id: this.terminal.id, idempotency_key: key, order_id: req.order_id, amount_cents: amountCents, method: req.method });
      if (out.kind === 'reply') {
        sent = true;
        const final = this.toResult(out.reply, req);
        if (final) return final;
      } else if (out.kind === 'rejected') {
        // O servidor recusou antes de mandar à maquininha (validação, sem token, maquininha de outra loja).
        return this.declined(out.message);
      } else {
        await this.deps.sleep(POINT_POLL_MS);
      }
    }

    // 2) Espera o cartão. Sem saber se a criação chegou, a consulta diz (404 = nunca chegou).
    const started = this.deps.now();
    let cancelAt: number | null = null;
    for (;;) {
      const now = this.deps.now();
      if (cancelAt === null && (this.aborted.has(req.request_id) || now - started >= POINT_WAIT_MS)) {
        cancelAt = now;
        const out = await this.call({ action: 'cancel', idempotency_key: key });
        if (out.kind === 'reply') {
          const final = this.toResult(out.reply, req);
          if (final) return final;
        } else if (out.kind === 'rejected' && out.httpStatus === 404) {
          return this.declined('A cobrança não chegou ao servidor (nada foi cobrado).');
        }
      }
      if (cancelAt !== null && now - cancelAt >= POINT_CANCEL_WAIT_MS) {
        return this.review('A maquininha não confirmou o pagamento nem o cancelamento. Confira no app do Mercado Pago antes de cobrar de novo.', 'POINT_TIMEOUT');
      }
      await this.deps.sleep(POINT_POLL_MS);
      const out = await this.call({ action: 'status', idempotency_key: key });
      if (out.kind === 'reply') {
        const final = this.toResult(out.reply, req);
        if (final) return final;
      } else if (out.kind === 'rejected') {
        if (out.httpStatus === 404) return this.declined('A cobrança não chegou ao servidor (nada foi cobrado).');
        return this.review(`Falha ao consultar a cobrança: ${out.message}. Confira no app do Mercado Pago.`, 'POINT_STATUS_REJECTED');
      }
    }
  }

  print(lines: string[]): Promise<void> {
    return this.printer.print(lines);
  }

  /** Pede o cancelamento: a cobrança em andamento cancela na maquininha e espera a confirmação. */
  abort(requestId: string): void {
    this.aborted.add(requestId);
  }
}
