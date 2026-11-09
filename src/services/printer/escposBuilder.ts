/**
 * Motor Universal ESC/POS (bytes puros) — compatível com Epson, Elgin,
 * Bematech, Tanca, ControlID, Daruma, Jetway, Sweda, Sunmi e mini térmicas
 * Bluetooth genéricas, em 80mm (48 colunas) ou 58mm (32 colunas).
 *
 * Além dos bytes, o builder registra um "preview" estruturado de cada linha
 * (tamanho, negrito, alinhamento) usado pelo simulador visual lado a lado.
 */

import { BRAND_LOGO_RASTER } from './brandLogoRaster';

export type PaperWidth = '80MM' | '58MM';
export type PrinterConnection = 'NETWORK_TCP' | 'BLUETOOTH' | 'SMARTPOS_INTERNAL';
export type PrinterSector = 'KITCHEN' | 'BAR' | 'GRILL' | 'DESSERT' | 'CASHIER';
export type PrinterBrand =
  | 'EPSON'
  | 'ELGIN'
  | 'BEMATECH'
  | 'TANCA'
  | 'CONTROLID'
  | 'DARUMA'
  | 'JETWAY'
  | 'SWEDA'
  | 'GENERIC_BT'
  | 'SMARTPOS_STONE'
  | 'SMARTPOS_PAGBANK';

export interface PrinterConfig {
  id: string;
  name: string; // Ex.: "Impressora Parrilla (Elgin i9)", "Bar 58mm"
  brand: PrinterBrand;
  model: string;
  sector: PrinterSector;
  paperWidth: PaperWidth;
  connection: PrinterConnection;
  ipAddress?: string; // Ex.: "192.168.1.200"
  port?: number; // Padrão de todas as marcas: 9100
  macAddress?: string; // Impressoras Bluetooth
  beepOnPrint: boolean;
  cutPaper: boolean;
  active: boolean;
}

export const COLUMNS: Record<PaperWidth, number> = { '80MM': 48, '58MM': 32 };

export type FontSize = 'NORMAL' | 'DOUBLE_HEIGHT' | 'LARGE';
export type Align = 'LEFT' | 'CENTER' | 'RIGHT';

export interface PreviewLine {
  text: string;
  size: FontSize;
  bold: boolean;
  align: Align;
}

export type PreviewEvent =
  | { kind: 'line'; line: PreviewLine }
  | { kind: 'beep' }
  | { kind: 'cut'; guillotine: boolean }
  | { kind: 'qr'; data: string }
  | { kind: 'logo' };

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export class UniversalEscPosBuilder {
  private buffer: number[] = [];
  private readonly cols: number;
  private state: { size: FontSize; bold: boolean; align: Align } = { size: 'NORMAL', bold: false, align: 'LEFT' };
  readonly preview: PreviewEvent[] = [];

  constructor(readonly paperWidth: PaperWidth = '80MM') {
    this.cols = COLUMNS[paperWidth];
    this.init();
  }

  get columns(): number {
    return this.cols;
  }

  /** Colunas efetivas considerando dupla largura (LARGE ocupa 2 colunas por caractere). */
  private effectiveCols(): number {
    return this.state.size === 'LARGE' ? Math.floor(this.cols / 2) : this.cols;
  }

  /** ESC @ — inicializa qualquer marca e seleciona a página de código PC850 (ESC t 2). */
  private init() {
    this.buffer.push(ESC, 0x40, ESC, 0x74, 0x02);
  }

  /** Remove acentos e qualquer byte fora de ASCII imprimível (blindagem multimarcas). */
  static sanitize(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[–—]/g, '-')
      .replace(/[^\x20-\x7E]/g, '');
  }

  align(mode: Align): this {
    const map = { LEFT: 0x00, CENTER: 0x01, RIGHT: 0x02 } as const;
    this.buffer.push(ESC, 0x61, map[mode]);
    this.state.align = mode;
    return this;
  }

  /** ESC E n — negrito. */
  bold(enabled: boolean): this {
    this.buffer.push(ESC, 0x45, enabled ? 0x01 : 0x00);
    this.state.bold = enabled;
    return this;
  }

  /** GS ! n — NORMAL, DUPLA ALTURA (cozinha) ou GIGANTE (largura + altura, número da mesa). */
  size(mode: FontSize): this {
    const map = { NORMAL: 0x00, DOUBLE_HEIGHT: 0x01, LARGE: 0x11 } as const;
    this.buffer.push(GS, 0x21, map[mode]);
    this.state.size = mode;
    return this;
  }

  private rawLine(clean: string) {
    for (let i = 0; i < clean.length; i++) this.buffer.push(clean.charCodeAt(i));
    this.buffer.push(LF);
    this.preview.push({ kind: 'line', line: { text: clean, ...this.state } });
  }

  /** Quebra por palavra, nunca no meio (palavras maiores que a linha são cortadas). */
  wrap(text: string, width = this.effectiveCols(), indent = ''): string[] {
    const clean = UniversalEscPosBuilder.sanitize(text);
    if (clean.length <= width) return [clean];
    const out: string[] = [];
    let cur = '';
    for (const word of clean.split(' ')) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (candidate.length <= width) cur = candidate;
      else {
        if (cur) out.push(cur);
        let w = word;
        while (w.length > width - indent.length) {
          out.push(indent + w.slice(0, width - indent.length));
          w = w.slice(width - indent.length);
        }
        cur = indent + w;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Linha de texto com quebra automática conforme a largura (32/48 colunas). */
  line(text = '', indent = ''): this {
    if (text === '') {
      this.rawLine('');
      return this;
    }
    for (const l of this.wrap(text, this.effectiveCols(), indent)) this.rawLine(l);
    return this;
  }

  /** Duas colunas alinhadas nas extremidades: "2x Picanha ........ R$ 189,00". */
  leftRight(left: string, right: string): this {
    const cols = this.effectiveCols();
    const r = UniversalEscPosBuilder.sanitize(right);
    let l = UniversalEscPosBuilder.sanitize(left);
    const maxLeft = cols - r.length - 1;
    if (l.length > maxLeft) {
      const parts = this.wrap(l, maxLeft);
      for (const p of parts.slice(0, -1)) this.rawLine(p);
      l = parts[parts.length - 1] ?? '';
    }
    this.rawLine(l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r);
    return this;
  }

  divider(char: '-' | '=' | '*' = '-'): this {
    this.rawLine(char.repeat(this.effectiveCols()));
    return this;
  }

  feed(lines = 1): this {
    for (let i = 0; i < lines; i++) this.rawLine('');
    return this;
  }

  /** ESC B n t — sirene/buzzer da impressora (3 bips de 200ms). */
  beep(): this {
    this.buffer.push(ESC, 0x42, 0x03, 0x02);
    this.preview.push({ kind: 'beep' });
    return this;
  }

  /** Avança a margem da serrilha e aciona guilhotina (GS V 66 0) quando existir. */
  /**
   * GS ( k — QR Code nativo da impressora (modelo 2, correção M), centralizado.
   * Suportado por Epson, Elgin, Bematech, Daruma, Tanca e bobinas internas Android.
   */
  qrCode(data: string, moduleSize = 5): this {
    const bytes = Array.from(new TextEncoder().encode(data));
    const len = bytes.length + 3;
    const prevAlign = this.state.align;
    this.align('CENTER');
    this.buffer.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // modelo 2
    this.buffer.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, moduleSize))); // tamanho do módulo
    this.buffer.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31); // correção M
    this.buffer.push(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...bytes); // armazena
    this.buffer.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // imprime
    this.buffer.push(LF);
    this.preview.push({ kind: 'qr', data });
    this.align(prevAlign);
    return this;
  }

  /**
   * GS v 0 — logo oficial do Tchê Food em imagem raster (1 bit), centralizada.
   * Comando suportado por Epson, Elgin, Bematech, Daruma, Tanca, Sunmi e bobinas internas Android.
   */
  logo(): this {
    const { widthBytes, heightDots, base64 } = BRAND_LOGO_RASTER;
    const bin = atob(base64);
    const prevAlign = this.state.align;
    this.align('CENTER');
    this.buffer.push(GS, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, heightDots & 0xff, (heightDots >> 8) & 0xff);
    for (let i = 0; i < bin.length; i++) this.buffer.push(bin.charCodeAt(i));
    this.buffer.push(LF);
    this.preview.push({ kind: 'logo' });
    this.align(prevAlign);
    return this;
  }

  cut(enableGuillotine = true): this {
    this.buffer.push(LF, LF, LF, LF);
    if (enableGuillotine) this.buffer.push(GS, 0x56, 0x42, 0x00);
    this.preview.push({ kind: 'cut', guillotine: enableGuillotine });
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.buffer);
  }

  /** Base64 para a ponte nativa Android (em blocos para não estourar a pilha). */
  toBase64(): string {
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < this.buffer.length; i += chunk) {
      binary += String.fromCharCode(...this.buffer.slice(i, i + chunk));
    }
    return btoa(binary);
  }
}
