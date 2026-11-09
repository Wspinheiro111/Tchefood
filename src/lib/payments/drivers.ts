/**
 * HAL — Camada de Abstração de Hardware de pagamento (Stone & PagBank).
 *
 * Todas as cobranças passam por IPaymentTerminalDriver. Os drivers reais
 * (StonePosDriver / PagBankPlugPagDriver) tentam primeiro o hardware/SDK
 * nativo; quando ele não existe (navegador comum, demonstração), delegam ao
 * MockTerminalDriver, que renderiza a maquininha interativa na tela e
 * devolve NSU, cAut e bandeira gerados como na adquirente real.
 */
import { create } from 'zustand';
import type { AcquirerType, OperationMode, PaymentMethod, PosTerminal } from '../../types';
import { uuid } from '../ids';
import {
  IdempotencyRegistry,
  SerialQueue,
  classifyPlugPagResult,
  manualReviewMessage,
  missingApprovalProof,
  parseCents,
  terminalUserReference,
  type PlugPagRawResult,
} from './terminalGuard';

export const ACQUIRER_CNPJ: Record<'STONE' | 'PAGBANK', string> = {
  STONE: '16501555000157',
  PAGBANK: '08561701000101',
};

export type CardBrand = 'VISA' | 'MASTERCARD' | 'ELO' | 'PIX';

export interface ChargeRequest {
  request_id: string;
  idempotency_key: string;
  amount: number;
  method: Exclude<PaymentMethod, 'CASH' | 'VOUCHER'>;
  table_label: string;
  order_id: string;
  /** Mensagem extra exibida no visor (ex.: "Cota 2 de 4"). */
  description: string;
}

export interface TerminalApproved {
  status: 'APPROVED';
  acquirer: AcquirerType;
  acquirer_cnpj: string;
  card_brand: CardBrand;
  nsu: string;
  authorization_code: string;
  terminal_serial: string;
  terminal_id: string | null;
  masked_pan: string | null;
  mode: OperationMode;
}

export interface TerminalDeclined {
  status: 'DECLINED';
  acquirer: AcquirerType;
  reason: string;
  terminal_serial: string;
  terminal_id: string | null;
}

/**
 * Resultado que não se pode afirmar nem como aprovado nem como recusado
 * (SDK inconsistente, aprovação sem NSU/autorização, queda no meio). Não gera
 * pagamento: o operador confere o extrato da maquininha antes de cobrar de novo.
 */
export interface TerminalManualReview {
  status: 'MANUAL_REVIEW';
  acquirer: AcquirerType;
  reason: string;
  failure_code: string;
  terminal_serial: string;
  terminal_id: string | null;
}

export type TerminalResult = TerminalApproved | TerminalDeclined | TerminalManualReview;

export interface IPaymentTerminalDriver {
  readonly acquirer: AcquirerType;
  readonly mode: OperationMode;
  readonly terminal: PosTerminal | null;
  /** Dispara a cobrança e resolve quando a maquininha aprova/recusa. */
  charge(req: ChargeRequest): Promise<TerminalResult>;
  /** Imprime texto puro na bobina térmica de 58mm (32 colunas). */
  print(lines: string[]): Promise<void>;
  /** Cancela uma cobrança pendente no terminal. */
  abort(requestId: string): void;
}

// ---------------------------------------------------------------------------
// Barramento entre drivers e o simulador visual
// ---------------------------------------------------------------------------
export type Chassis = 'STONE' | 'PAGBANK';

export interface PendingCharge {
  request: ChargeRequest;
  chassis: Chassis;
  mode: OperationMode;
  terminal: PosTerminal | null;
  resolve: (r: TerminalResult) => void;
}

export interface PrintJob {
  id: string;
  title: string;
  lines: string[];
  chassis: Chassis;
  /** Linha em fonte gigante no topo (ex.: nome do item na ficha de evento). */
  headline?: string;
  /** QR Code impresso ao final (DANFE NFC-e). */
  qr?: string;
  /** Linhas após o QR Code. */
  footer?: string[];
}

interface TerminalBus {
  pending: PendingCharge | null;
  printQueue: PrintJob[];
  simulatorOpen: boolean;
  chassis: Chassis;
  setChassis: (c: Chassis) => void;
  openSimulator: (c?: Chassis) => void;
  closeSimulator: () => void;
  submit: (p: PendingCharge) => void;
  finish: (r: TerminalResult) => void;
  enqueuePrint: (job: Omit<PrintJob, 'id'>) => void;
  dismissPrint: (id: string) => void;
}

export const useTerminalBus = create<TerminalBus>((set, get) => ({
  pending: null,
  printQueue: [],
  simulatorOpen: false,
  chassis: 'STONE',
  setChassis: (c) => set({ chassis: c }),
  openSimulator: (c) => set({ simulatorOpen: true, ...(c ? { chassis: c } : {}) }),
  closeSimulator: () => {
    const p = get().pending;
    if (p) {
      p.resolve({
        status: 'DECLINED',
        acquirer: p.chassis,
        reason: 'Operação cancelada no terminal',
        terminal_serial: p.terminal?.serial_number ?? `${p.chassis}-EMBEDDED`,
        terminal_id: p.terminal?.id ?? null,
      });
    }
    set({ simulatorOpen: false, pending: null });
  },
  submit: (p) => set({ pending: p, simulatorOpen: true, chassis: p.chassis }),
  finish: (r) => {
    const p = get().pending;
    set({ pending: null });
    p?.resolve(r);
  },
  enqueuePrint: (job) => set({ printQueue: [...get().printQueue, { ...job, id: uuid() }], simulatorOpen: true, chassis: job.chassis }),
  dismissPrint: (id) => set({ printQueue: get().printQueue.filter((j) => j.id !== id) }),
}));

// ---------------------------------------------------------------------------
// Geradores de metadados (iguais aos formatos das adquirentes)
// ---------------------------------------------------------------------------
function randomDigits(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

export function generateNsu(): string {
  return randomDigits(6);
}

export function generateAuthorizationCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function randomCardBrand(): Exclude<CardBrand, 'PIX'> {
  const r = Math.random();
  return r < 0.45 ? 'VISA' : r < 0.85 ? 'MASTERCARD' : 'ELO';
}

const BIN_BY_BRAND: Record<Exclude<CardBrand, 'PIX'>, string> = {
  VISA: '4',
  MASTERCARD: '5',
  ELO: '6',
};

export function maskedPan(brand: CardBrand): string | null {
  if (brand === 'PIX') return null;
  return `${BIN_BY_BRAND[brand]}${randomDigits(5)}******${randomDigits(4)}`;
}

// ---------------------------------------------------------------------------
// MockTerminalDriver — simulação visual completa
// ---------------------------------------------------------------------------
export class MockTerminalDriver implements IPaymentTerminalDriver {
  readonly acquirer: AcquirerType;
  constructor(
    readonly chassis: Chassis,
    readonly mode: OperationMode,
    readonly terminal: PosTerminal | null,
  ) {
    this.acquirer = chassis;
  }

  charge(request: ChargeRequest): Promise<TerminalResult> {
    return new Promise<TerminalResult>((resolve) => {
      useTerminalBus.getState().submit({ request, chassis: this.chassis, mode: this.mode, terminal: this.terminal, resolve });
    });
  }

  async print(lines: string[]): Promise<void> {
    useTerminalBus.getState().enqueuePrint({ title: 'Impressão', lines, chassis: this.chassis });
  }

  abort(_requestId: string): void {
    useTerminalBus.getState().closeSimulator();
  }
}

// ---------------------------------------------------------------------------
// StonePosDriver — TEF POS Sem Fio (Stone Connect) + DeepLink local
// ---------------------------------------------------------------------------
interface StoneBridge {
  pay?: (json: string) => void;
}

export class StonePosDriver implements IPaymentTerminalDriver {
  readonly acquirer: AcquirerType = 'STONE';
  private readonly fallback: MockTerminalDriver;

  constructor(
    readonly mode: OperationMode,
    readonly terminal: PosTerminal | null,
  ) {
    this.fallback = new MockTerminalDriver('STONE', mode, terminal);
  }

  /** URL do DeepLink usada quando o app roda embarcado na Stone (stone-sdk://pay). */
  static deepLink(req: ChargeRequest): string {
    const type = req.method === 'CREDIT' ? 'credit' : req.method === 'DEBIT' ? 'debit' : 'pix';
    const params = new URLSearchParams({
      amount: Math.round(req.amount * 100).toString(),
      editable_amount: '0',
      transaction_type: type,
      installment_type: 'none',
      order_id: req.idempotency_key,
      return_scheme: 'tchefood',
    });
    return `stone-sdk://pay?${params.toString()}`;
  }

  async charge(req: ChargeRequest): Promise<TerminalResult> {
    const bridge = (window as unknown as { StoneBridge?: StoneBridge }).StoneBridge;
    if (this.mode === 'SMARTPOS_EMBEDDED' && bridge?.pay) {
      // Integração nativa: o app Android devolve o resultado via callback window.onStoneResult.
      return stoneQueue.run(() =>
        new Promise<TerminalResult>((resolve) => {
          (window as unknown as { onStoneResult?: (r: TerminalResult) => void }).onStoneResult = (r) => resolve(guardApproved(r, req));
          bridge.pay?.(JSON.stringify({ deeplink: StonePosDriver.deepLink(req), ...req }));
        }),
      );
    }
    // TEF POS Sem Fio: em produção a cobrança vai para a fila do terminal
    // (serial STONE-01/02) via Stone Connect. Sem credenciais, o terminal
    // físico é simulado na tela pelo MockTerminalDriver.
    return this.fallback.charge(req);
  }

  print(lines: string[]): Promise<void> {
    return this.fallback.print(lines);
  }

  abort(requestId: string): void {
    this.fallback.abort(requestId);
  }
}

// ---------------------------------------------------------------------------
// PagBankPlugPagDriver — Moderninha Smart via window.PlugPagBridge
// ---------------------------------------------------------------------------
interface PlugPagBridge {
  /** Recebe o JSON de PlugPagPaymentData e devolve o PlugPagTransactionResult cru (ver android/PlugPagJsBridge.java). */
  doPayment?: (json: string) => string;
  isServiceBusy?: () => boolean;
  /** Devolve {"success":bool,"errorCode","message"}. Falha incerta não é reimpressa sozinha. */
  printText?: (text: string) => string | void;
}

export class PagBankPlugPagDriver implements IPaymentTerminalDriver {
  readonly acquirer: AcquirerType = 'PAGBANK';
  private readonly fallback: MockTerminalDriver;

  constructor(
    readonly mode: OperationMode,
    readonly terminal: PosTerminal | null,
  ) {
    this.fallback = new MockTerminalDriver('PAGBANK', mode, terminal);
  }

  private bridge(): PlugPagBridge | undefined {
    return (window as unknown as { PlugPagBridge?: PlugPagBridge }).PlugPagBridge;
  }

  async charge(req: ChargeRequest): Promise<TerminalResult> {
    const bridge = this.bridge();
    if (!bridge?.doPayment) return this.fallback.charge(req);
    const doPayment = bridge.doPayment.bind(bridge);
    const serial = this.terminal?.serial_number ?? 'PAGBANK-EMBEDDED';
    const terminalId = this.terminal?.id ?? null;
    const review = (code: string): TerminalManualReview => ({
      status: 'MANUAL_REVIEW', acquirer: 'PAGBANK', reason: manualReviewMessage('PAGBANK', code), failure_code: code, terminal_serial: serial, terminal_id: terminalId,
    });
    return plugPagIdempotency.run(req.request_id, req, () =>
      // Uma única operação bloqueante do PlugPag por vez (o SDK não aceita comandos concorrentes).
      plugPagQueue.run(async (): Promise<TerminalResult> => {
        if (bridge.isServiceBusy?.()) {
          return { status: 'DECLINED', acquirer: 'PAGBANK', reason: 'Maquininha ocupada (SERVICE_BUSY). Aguarde e tente de novo.', terminal_serial: serial, terminal_id: terminalId };
        }
        const amountCents = Math.round(req.amount * 100);
        const userReference = terminalUserReference(req.request_id);
        // PlugPagPaymentData: type 1=crédito 2=débito 5=pix; amount em centavos; installmentType 1 = à vista.
        const type = req.method === 'CREDIT' ? 1 : req.method === 'DEBIT' ? 2 : 5;
        let raw: PlugPagRawResult;
        try {
          raw = JSON.parse(doPayment(JSON.stringify({ type, amount: amountCents, installmentType: 1, installments: 1, userReference }))) as PlugPagRawResult;
        } catch {
          // A cobrança pode ter passado antes da exceção: nunca repetir sozinho.
          return review('WRAPPER_EXCEPTION');
        }
        const verdict = classifyPlugPagResult(raw);
        if (verdict.status === 'MANUAL_REVIEW') return review(verdict.code);
        if (verdict.status !== 'APPROVED') {
          const reason = verdict.status === 'BUSY' ? 'Maquininha ocupada' : verdict.status === 'CANCELLED' ? 'Operação cancelada no terminal' : 'Recusada';
          return { status: 'DECLINED', acquirer: 'PAGBANK', reason: `${verdict.message ?? reason} (${verdict.code})`, terminal_serial: serial, terminal_id: terminalId };
        }
        const missing = missingApprovalProof(
          {
            nsu: raw.hostNsu,
            authorization_code: raw.autoCode,
            terminal_serial: raw.terminalSerialNumber ?? serial,
            paid_amount_cents: parseCents(raw.amount),
            reference: raw.userReference ?? null,
          },
          { amount_cents: amountCents, reference: userReference },
        );
        if (missing) return review(missing);
        const brandRaw = (raw.cardBrand ?? '').trim().toUpperCase();
        const brand: CardBrand = req.method === 'PIX' ? 'PIX' : brandRaw.includes('MASTER') ? 'MASTERCARD' : brandRaw.includes('ELO') ? 'ELO' : brandRaw.includes('VISA') ? 'VISA' : (brandRaw as CardBrand);
        return {
          status: 'APPROVED',
          acquirer: 'PAGBANK',
          acquirer_cnpj: ACQUIRER_CNPJ.PAGBANK,
          card_brand: brand,
          nsu: (raw.hostNsu ?? '').trim(),
          authorization_code: (raw.autoCode ?? '').trim(),
          terminal_serial: (raw.terminalSerialNumber ?? serial).trim(),
          terminal_id: terminalId,
          masked_pan: null,
          mode: this.mode,
        };
      }),
      () => review('IDEMPOTENCY_CONFLICT'),
    );
  }

  async print(lines: string[]): Promise<void> {
    const bridge = this.bridge();
    if (bridge?.printText) {
      const printText = bridge.printText.bind(bridge);
      const raw = await plugPagQueue.run(async () => printText(lines.join('\n')));
      if (typeof raw === 'string') {
        let parsed: { success?: boolean; errorCode?: string | null; message?: string | null } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          parsed = { success: false, errorCode: 'MALFORMED_RESPONSE' };
        }
        if (parsed.success !== true) throw new Error(`${parsed.message ?? 'Falha na impressão'} (${parsed.errorCode ?? 'PRINT_FAILED'})`);
      }
      return;
    }
    return this.fallback.print(lines);
  }

  abort(requestId: string): void {
    this.fallback.abort(requestId);
  }
}

// ---------------------------------------------------------------------------
// Regras comuns (portadas do Tchê Vendas)
// ---------------------------------------------------------------------------
const plugPagQueue = new SerialQueue();
const stoneQueue = new SerialQueue();
const plugPagIdempotency = new IdempotencyRegistry<ChargeRequest, TerminalResult>(
  (r) => `${r.idempotency_key}|${Math.round(r.amount * 100)}|${r.method}|${r.order_id}`,
);

/** Aprovação vinda de SDK nativo sem NSU/autorização/serial vira revisão manual. */
export function guardApproved(result: TerminalResult, req: ChargeRequest): TerminalResult {
  if (result.status !== 'APPROVED') return result;
  const missing = missingApprovalProof(result, { amount_cents: Math.round(req.amount * 100) });
  if (!missing) return result;
  return {
    status: 'MANUAL_REVIEW',
    acquirer: result.acquirer,
    reason: manualReviewMessage(result.acquirer, missing),
    failure_code: missing,
    terminal_serial: result.terminal_serial,
    terminal_id: result.terminal_id,
  };
}

/** Fábrica: escolhe o driver certo para o terminal/modo selecionado. */
export function createDriver(params: { terminal: PosTerminal | null; chassis: Chassis; mode: OperationMode }): IPaymentTerminalDriver {
  const acquirer = params.terminal?.acquirer ?? params.chassis;
  if (acquirer === 'PAGBANK') return new PagBankPlugPagDriver(params.mode, params.terminal);
  if (acquirer === 'STONE') return new StonePosDriver(params.mode, params.terminal);
  return new MockTerminalDriver(params.chassis, params.mode, params.terminal);
}
