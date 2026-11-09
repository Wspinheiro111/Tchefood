/**
 * Balança de checkout (Toledo Prix / Filizola) pela porta serial ou USB-serial.
 *
 * Protocolo de pesagem contínua usado pelas duas marcas no modo "PDV"
 * (Toledo P03 / Filizola padrão): o PDV envia ENQ (0x05) e a balança responde
 *   STX (0x02) + 5 caracteres de peso + ETX (0x03)
 * com o peso em gramas para balanças de 15 kg ("00645" = 0,645 kg) ou em kg
 * com ponto ("0.645"). Peso instável vem como "IIIII", negativo como "NNNNN"
 * e sobrecarga como "SSSSS".
 *
 * Configuração da porta: 9600 (Toledo) ou 2400 (Filizola antigas), 8N1.
 * No navegador usamos a Web Serial API (Chrome/Edge desktop e Android com
 * permissão). Na SmartPOS sem porta serial, a pesagem é feita na balança do
 * caixa e o valor é digitado (fica marcado como MANUAL no item).
 */

export type ScaleReading =
  | { kind: 'STABLE'; grams: number }
  | { kind: 'UNSTABLE' }
  | { kind: 'NEGATIVE' }
  | { kind: 'OVERLOAD' }
  | { kind: 'INVALID'; raw: string };

const STX = 0x02;
const ETX = 0x03;
export const ENQ = 0x05;

/** Interpreta o conteúdo entre STX e ETX. */
export function parseScalePayload(payload: string): ScaleReading {
  const p = payload.trim();
  if (/^I+$/.test(p)) return { kind: 'UNSTABLE' };
  if (/^N+$/.test(p)) return { kind: 'NEGATIVE' };
  if (/^S+$/.test(p)) return { kind: 'OVERLOAD' };
  if (/^\d{5,6}$/.test(p)) return { kind: 'STABLE', grams: Number(p) };
  if (/^\d{1,3}[.,]\d{3}$/.test(p)) return { kind: 'STABLE', grams: Math.round(Number(p.replace(',', '.')) * 1000) };
  return { kind: 'INVALID', raw: p };
}

/** Extrai o último quadro completo STX…ETX de um buffer de bytes. */
export function parseScaleFrame(bytes: ArrayLike<number>): ScaleReading | null {
  let end = -1;
  for (let i = bytes.length - 1; i >= 0; i--) if (bytes[i] === ETX) { end = i; break; }
  if (end < 0) return null;
  let start = -1;
  for (let i = end - 1; i >= 0; i--) if (bytes[i] === STX) { start = i; break; }
  if (start < 0) return null;
  let s = '';
  for (let i = start + 1; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return parseScalePayload(s);
}

export function encodeScaleFrame(payload: string): Uint8Array {
  return Uint8Array.from([STX, ...Array.from(payload).map((c) => c.charCodeAt(0)), ETX]);
}

export interface WeighResult {
  grossGrams: number;
  tareGrams: number;
  netGrams: number;
  /** Quantidade em KG (NUMERIC 10,3) = líquido / 1000. */
  quantityKg: number;
}

/** Peso líquido: bruto − tara, recusando leitura menor ou igual à tara. */
export function computeNetWeight(grossGrams: number, tareGrams: number): WeighResult | { error: string } {
  if (!Number.isInteger(grossGrams) || grossGrams <= 0) return { error: 'Peso inválido.' };
  if (!Number.isInteger(tareGrams) || tareGrams < 0) return { error: 'Tara inválida.' };
  if (grossGrams <= tareGrams) return { error: 'Peso menor que a tara do prato. Coloque a comida e pese de novo.' };
  if (grossGrams > 15000) return { error: 'Acima da capacidade da balança (15 kg).' };
  const net = grossGrams - tareGrams;
  return { grossGrams, tareGrams, netGrams: net, quantityKg: net / 1000 };
}

// ---------------------------------------------------------------------------
// Leitores
// ---------------------------------------------------------------------------
export interface ScaleReader {
  readonly label: string;
  /** Pede uma leitura (ENQ) e devolve o quadro interpretado. */
  read(): Promise<ScaleReading>;
  close(): Promise<void>;
}

/**
 * Simulador: sequência realista de quadros (instável enquanto o prato
 * assenta, depois estável) com o mesmo parser do hardware real.
 */
export class SimulatedScale implements ScaleReader {
  readonly label = 'Balança simulada (Toledo Prix 3)';
  private frames: Uint8Array[];
  private i = 0;
  constructor(targetGrams: number, unstableFrames = 2) {
    const stable = encodeScaleFrame(String(Math.max(0, Math.round(targetGrams))).padStart(5, '0'));
    this.frames = [...Array.from({ length: unstableFrames }, () => encodeScaleFrame('IIIII')), stable];
  }
  async read(): Promise<ScaleReading> {
    await new Promise((r) => setTimeout(r, 350));
    const f = this.frames[Math.min(this.i, this.frames.length - 1)]!;
    this.i += 1;
    return parseScaleFrame(f) ?? { kind: 'INVALID', raw: '' };
  }
  async close(): Promise<void> {}
}

// Tipos mínimos da Web Serial API (não fazem parte do lib.dom do TypeScript 5.6).
interface SerialPortLike {
  open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: 'none' }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export function webSerialAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** Leitura real pela Web Serial API. */
export class WebSerialScale implements ScaleReader {
  private constructor(
    private readonly port: SerialPortLike,
    readonly label: string,
  ) {}

  static async connect(baudRate = 9600): Promise<WebSerialScale> {
    const serial = (navigator as unknown as { serial?: SerialLike }).serial;
    if (!serial) throw new Error('Este navegador não acessa a porta serial. Use Chrome/Edge ou digite o peso.');
    const port = await serial.requestPort();
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
    return new WebSerialScale(port, `Balança serial ${baudRate} bps`);
  }

  async read(): Promise<ScaleReading> {
    if (!this.port.writable || !this.port.readable) throw new Error('Porta da balança fechada.');
    const writer = this.port.writable.getWriter();
    await writer.write(Uint8Array.from([ENQ]));
    writer.releaseLock();
    const reader = this.port.readable.getReader();
    const buf: number[] = [];
    const deadline = Date.now() + 1500;
    try {
      while (Date.now() < deadline) {
        const timeout = new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), Math.max(deadline - Date.now(), 0)));
        const { value, done } = await Promise.race([reader.read(), timeout]);
        if (done || !value) break;
        buf.push(...value);
        const frame = parseScaleFrame(buf);
        if (frame) return frame;
      }
    } finally {
      reader.releaseLock();
    }
    return { kind: 'INVALID', raw: 'sem resposta da balança' };
  }

  async close(): Promise<void> {
    await this.port.close();
  }
}

/** Repete a leitura até estabilizar (como o PDV faz com a Toledo). */
export async function readStable(reader: ScaleReader, onFrame?: (r: ScaleReading) => void, attempts = 8): Promise<ScaleReading> {
  let last: ScaleReading = { kind: 'INVALID', raw: '' };
  for (let i = 0; i < attempts; i++) {
    last = await reader.read();
    onFrame?.(last);
    if (last.kind !== 'UNSTABLE') return last;
  }
  return last;
}
