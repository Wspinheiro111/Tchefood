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
 *  - Falha de rede, prazo estourado ou erro do servidor nunca viram recusa: a cobrança
 *    pode ter chegado à maquininha. Depois de uma criação incerta, nem 404 nem outra
 *    recusa provam nada (a primeira criação pode estar a caminho): a recusa só vem do
 *    encerramento no servidor, que grava o bloqueio da chave antes de responder.
 *  - Cada chamada tem prazo próprio (POINT_REQUEST_TIMEOUT_MS) e o fluxo inteiro tem
 *    prazo contado desde o primeiro envio.
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
  type ManagerAbort,
  type TerminalResult,
} from './drivers';

export type PointFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface PointDriverDeps {
  /** Sessão da nuvem com token válido; null = loja não conectada. */
  config: () => Promise<SyncConfig | null>;
  fetch: PointFetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Resolve depois de ms: prazo de cada chamada (sem ele, a chamada não tem limite próprio). */
  timer?: (ms: number) => Promise<void>;
  /** Quem está no caixa (fica gravado no encerramento da tentativa). */
  operator?: () => Promise<string | null>;
  /** Sobe a fila antes de cobrar: o servidor só cobra conta que já está nele. */
  beforeCreate?: () => Promise<void>;
}

/** Tempo esperando o cartão antes de pedir o cancelamento na maquininha. */
export const POINT_WAIT_MS = 120_000;
/** Depois do pedido de cancelamento, quanto tempo esperar a confirmação. */
export const POINT_CANCEL_WAIT_MS = 30_000;
/**
 * Limite duro do fluxo, contado do primeiro envio. O servidor conta o prazo do cartão pela hora em que ELE
 * gravou a cobrança (depois do primeiro envio do app): enquanto responde "cedo demais", o app segue
 * consultando e pedindo o encerramento, mas não além deste limite.
 */
export const POINT_HARD_LIMIT_MS = POINT_WAIT_MS + 90_000;
export const POINT_POLL_MS = 2_000;
/** Prazo de cada chamada à função point-charge. */
export const POINT_REQUEST_TIMEOUT_MS = 15_000;

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

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseReply(text: string): Reply | null {
  const body = parseObject(text);
  if (!body) return null;
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
  /** Pedidos de encerramento do operador, com a autorização do gerente (sem ela, o servidor recusa). */
  private readonly aborted = new Map<string, ManagerAbort>();
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
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const request = (async () => {
        const r = await this.deps.fetch(`${cfg.url.replace(/\/+$/, '')}/functions/v1/point-charge`, {
          method: 'POST',
          headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          ...(controller ? { signal: controller.signal } : {}),
        });
        return { r, t: await r.text() };
      })();
      const timer = this.deps.timer;
      const out = timer
        ? await Promise.race([request, timer(POINT_REQUEST_TIMEOUT_MS).then(() => null)])
        : await request;
      if (!out) {
        // Prazo estourado: resultado desconhecido (a cobrança pode ter chegado).
        controller?.abort();
        request.catch(() => undefined);
        return { kind: 'unknown' };
      }
      res = out.r;
      text = out.t;
    } catch {
      return { kind: 'unknown' };
    }
    if (res.status === 200) {
      const reply = parseReply(text);
      return reply ? { kind: 'reply', reply } : { kind: 'unknown' };
    }
    let error = 'http';
    let message = `HTTP ${res.status}`;
    const b = parseObject(text);
    if (b && typeof b.error === 'string') error = b.error;
    if (b && typeof b.message === 'string') message = b.message;
    // 5xx, 401 (sessão vencida no meio), 408/425/429 (podem vir de um proxy depois de repassar o pedido) e
    // qualquer resposta que não seja da própria função (sem o campo "error") não provam nada sobre a maquininha.
    if (res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 425 || res.status === 429) return { kind: 'unknown' };
    if (!b || typeof b.error !== 'string') return { kind: 'unknown' };
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
    // Antes de qualquer espera: um abort logo depois de chamar charge() não pode se perder.
    this.aborted.delete(req.request_id);
    if (req.method !== 'CREDIT' && req.method !== 'DEBIT') return this.declined('Pela Point Smart esta versão cobra só crédito à vista e débito. Use outra forma para Pix.');
    if (!this.terminal) return this.declined('Selecione a maquininha Point Smart.');
    const cfg = await this.deps.config().catch(() => null);
    if (!cfg) return this.declined('Conecte a loja à nuvem para cobrar na Point Smart.');
    const key = req.idempotency_key;
    const amountCents = Math.round(req.amount * 100);
    const operator = await (this.deps.operator?.() ?? Promise.resolve(null)).catch(() => null);
    // Sem operador identificado não cobra (o servidor também recusa quem não é da equipe ativa da loja).
    if (!operator) return this.declined('Entre com o seu PIN para cobrar na Point Smart.');
    const charge = { terminal_id: this.terminal.id, idempotency_key: key, order_id: req.order_id, amount_cents: amountCents, method: req.method };
    // Sobe a fila antes (o servidor só cobra conta que já está nele). Com prazo: pendurada ou com erro, não
    // cobra (nada foi mandado). O servidor confere de novo que a conta está lá.
    if (this.deps.beforeCreate) {
      const before = this.deps.beforeCreate().then(() => 'ok' as const, () => 'failed' as const);
      const timer = this.deps.timer;
      const result = timer ? await Promise.race([before, timer(POINT_REQUEST_TIMEOUT_MS).then(() => 'timeout' as const)]) : await before;
      if (result !== 'ok') return this.declined('Não consegui sincronizar a conta com a nuvem. Nada foi cobrado; tente de novo.');
    }

    // O prazo do cartão conta a partir do primeiro envio (a sincronização acima tem o prazo dela e não
    // consome este): criação pendurada consome o tempo de espera.
    const started = this.deps.now();
    // 1) Criação. Resultado desconhecido: repete com a mesma chave (o servidor não cria outra).
    let uncertain = false;
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
      if (this.deps.now() - started >= POINT_WAIT_MS) break;
      const out = await this.call({ action: 'create', ...charge, staff_id: operator });
      if (out.kind === 'reply') {
        sent = true;
        const final = this.toResult(out.reply, req);
        if (final) return final;
      } else if (out.kind === 'rejected') {
        // Recusa antes da maquininha (validação, sem token, conta fora do servidor). Só prova algo se
        // nenhuma criação anterior ficou sem resposta: senão ela pode estar a caminho e quem decide é o
        // encerramento no servidor (abaixo).
        if (!uncertain) return this.declined(out.message);
        break;
      } else {
        uncertain = true;
        await this.deps.sleep(POINT_POLL_MS);
      }
    }

    // 2) Espera o cartão. Encerrar no servidor é a única prova de "nada foi cobrado": sem cobrança gravada,
    //    ele grava o bloqueio da chave e uma criação atrasada não chega mais à Point.
    //    Por prazo, o servidor confere a hora gravada (cedo demais = segue consultando e pedindo). Pelo
    //    operador, vai junto a autorização do gerente (repetir é seguro: o servidor reaproveita a primeira
    //    autorização, sem novo registro). Repete a cada volta até o fim.
    let cancelAt: number | null = null;
    const timeoutBody = { action: 'cancel', ...charge, reason: 'timeout', staff_id: operator };
    const close = async (): Promise<TerminalResult | null> => {
      const manager = this.aborted.get(req.request_id);
      let out = await this.call(manager
        ? { action: 'cancel', ...charge, reason: 'operator', staff_id: operator, manager_pin: manager.manager_pin, reason_text: manager.reason }
        // staff_id: quem responde pelo bloqueio preventivo quando a cobrança nem chegou a ser gravada.
        : timeoutBody);
      if (out.kind === 'rejected' && manager && out.httpStatus === 403) {
        // PIN recusado: o pedido do operador cai e a cobrança segue as regras do prazo.
        this.aborted.delete(req.request_id);
        if (this.deps.now() - started < POINT_WAIT_MS) cancelAt = null;
        return null;
      }
      if (out.kind === 'rejected' && manager && out.httpStatus === 404) {
        // A cobrança não está gravada: não há o que o gerente encerrar, mas a criação pode estar a caminho.
        // Pede já o bloqueio da chave. O pedido do gerente fica guardado: se a criação gravar primeiro, a
        // próxima volta manda a autorização de novo, agora com cobrança para encerrar.
        out = await this.call(timeoutBody);
      }
      // "Cedo demais": o prazo do servidor ainda não venceu. A espera pela confirmação recomeça daqui.
      if (out.kind === 'rejected' && out.error === 'too_early' && cancelAt !== null) cancelAt = this.deps.now();
      return out.kind === 'reply' ? this.toResult(out.reply, req) : null;
    };
    const stuck = (): TerminalResult =>
      this.review('A maquininha não confirmou o pagamento nem o cancelamento. Confira no app do Mercado Pago antes de cobrar de novo.', 'POINT_TIMEOUT');
    for (;;) {
      const now = this.deps.now();
      if (cancelAt === null && (this.aborted.has(req.request_id) || now - started >= POINT_WAIT_MS)) cancelAt = now;
      if (cancelAt !== null) {
        const final = await close();
        if (final) return final;
      }
      if (cancelAt !== null && this.deps.now() - cancelAt >= POINT_CANCEL_WAIT_MS) return stuck();
      if (this.deps.now() - started >= POINT_HARD_LIMIT_MS) return stuck();
      await this.deps.sleep(POINT_POLL_MS);
      const out = await this.call({ action: 'status', idempotency_key: key });
      if (out.kind === 'reply') {
        const final = this.toResult(out.reply, req);
        if (final) return final;
      } else if (out.kind === 'rejected') {
        if (out.httpStatus === 404) {
          // Não gravada AGORA não prova nada (a criação pode estar a caminho): encerra no servidor, que decide.
          if (cancelAt === null) cancelAt = this.deps.now();
          const final = await close();
          if (final) return final;
          continue;
        }
        return this.review(`Falha ao consultar a cobrança: ${out.message}. Confira no app do Mercado Pago.`, 'POINT_STATUS_REJECTED');
      }
    }
  }

  print(lines: string[]): Promise<void> {
    return this.printer.print(lines);
  }

  /**
   * Encerrar antes do prazo, a pedido do operador: exige o PIN do gerente e o motivo (conferidos no banco).
   * Sem autorização não faz nada: a cobrança segue até o prazo, quando o servidor encerra sozinho.
   */
  abort(requestId: string, auth?: ManagerAbort): void {
    if (auth) this.aborted.set(requestId, auth);
  }
}
