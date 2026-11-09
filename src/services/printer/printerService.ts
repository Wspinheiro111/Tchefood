/**
 * Roteamento de impressão por praça + envio pela ponte nativa Android.
 *
 *   window.SmartPosNative.printNetworkEscPos(ip, 9100, base64)   → Wi-Fi / cabo
 *   window.SmartPosNative.printBluetoothEscPos(mac, base64)      → Bluetooth SPP
 *   window.SmartPosNative.printInternalEscPos(base64)            → bobina da SmartPOS
 *
 * Sem a ponte (navegador comum), os tickets vão para o simulador visual.
 */
import { create } from 'zustand';
import type { OrderItem, Product, ProductionSector, StaffUser } from '../../types';
import { printLedgerGet, printLedgerMark } from './printLedger';
import { UniversalEscPosBuilder, type PaperWidth, type PreviewEvent, type PrinterConfig, type PrinterSector } from './escposBuilder';

export interface NativePrinterBridge {
  printNetworkEscPos?: (ip: string, port: number, base64: string) => string;
  printBluetoothEscPos?: (mac: string, base64: string) => string;
  printInternalEscPos?: (base64: string) => string;
}

export interface RenderedTicket {
  printer: PrinterConfig;
  title: string;
  base64: string;
  byteLength: number;
  /** Mesmo conteúdo renderizado em 80mm e em 58mm para a comparação lado a lado. */
  preview: Record<PaperWidth, PreviewEvent[]>;
  delivery: { ok: boolean; via: 'NATIVE' | 'SIMULATOR'; error?: string; skipped?: 'ALREADY_PRINTED' | 'PRINT_RESULT_UNCERTAIN' };
}

/** Praça da impressora que atende cada setor de produção. */
export function printerSectorFor(sector: ProductionSector): PrinterSector {
  if (sector === 'NONE') return 'CASHIER';
  return sector;
}

export interface KitchenTicketData {
  tableLabel: string;
  tableNumber: number;
  sectorLabel: string;
  waiterName: string;
  fromQr: boolean;
  createdAt: string;
  items: Array<{ quantity: number; name: string; code: string; doneness: string | null; notes: string | null }>;
  /** Título gigante no lugar de "MESA n" (ex.: "SENHA 042" no pedido do totem). */
  headline?: string;
}

/** Ticket de produção: mesa gigante, quantidade/ponto em dupla altura. */
export function buildKitchenTicket(width: PaperWidth, data: KitchenTicketData, opts: { beep: boolean; cut: boolean }): UniversalEscPosBuilder {
  const b = new UniversalEscPosBuilder(width);
  if (opts.beep) b.beep();
  b.align('CENTER').size('LARGE').bold(true).line(data.headline ?? `MESA ${data.tableNumber}`);
  b.size('DOUBLE_HEIGHT').line(data.sectorLabel.toUpperCase());
  b.size('NORMAL').bold(false).align('LEFT').divider('=');
  b.leftRight(data.fromQr ? 'PEDIDO VIA QR CODE' : `Garcom: ${data.waiterName}`, new Date(data.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
  b.line(data.tableLabel);
  b.divider();
  for (const it of data.items) {
    b.size('DOUBLE_HEIGHT').bold(true).line(`${it.quantity}x ${it.name}`);
    if (it.doneness) b.line(`  >> ${it.doneness.toUpperCase()}`);
    b.size('NORMAL').bold(false);
    if (it.notes) {
      for (const n of it.notes.split(' · ')) {
        if (n.startsWith('+')) b.line(`   ${n}`, '     ');
        else b.size('DOUBLE_HEIGHT').line(`   ! ${n}`, '     ').size('NORMAL');
      }
    }
    b.line(`   cod ${it.code}`);
    b.divider();
  }
  b.logo();
  b.align('CENTER').line('Tche Food - Comanda Mobile').align('LEFT');
  b.cut(opts.cut);
  return b;
}

/** Página de teste da impressora. */
export function buildTestPage(width: PaperWidth, printer: PrinterConfig): UniversalEscPosBuilder {
  const b = new UniversalEscPosBuilder(width);
  if (printer.beepOnPrint) b.beep();
  b.logo();
  b.align('CENTER').size('LARGE').bold(true).line('TESTE OK');
  b.size('NORMAL').bold(false).line(printer.name).line(`${printer.brand} ${printer.model}`);
  b.align('LEFT').divider('=');
  b.leftRight('Largura', `${width === '80MM' ? '80mm / 48 col' : '58mm / 32 col'}`);
  b.leftRight('Conexao', printer.connection === 'NETWORK_TCP' ? `${printer.ipAddress}:${printer.port ?? 9100}` : printer.connection === 'BLUETOOTH' ? printer.macAddress ?? '-' : 'Bobina interna');
  b.leftRight('Praca', printer.sector);
  b.divider();
  b.line('Acentuacao: ação, pão, coração, Tchê!');
  b.line('0123456789'.repeat(5).slice(0, b.columns));
  b.size('DOUBLE_HEIGHT').line('FONTE DUPLA ALTURA').size('NORMAL');
  b.leftRight('2x Picanha na Parrilla', 'R$ 239,80');
  b.divider();
  b.cut(printer.cutPaper);
  return b;
}

type NativeCall = () => string;

function nativeCall(printer: PrinterConfig, base64: string): NativeCall | null {
  const bridge = (window as unknown as { SmartPosNative?: NativePrinterBridge }).SmartPosNative;
  if (printer.connection === 'NETWORK_TCP' && bridge?.printNetworkEscPos && printer.ipAddress) {
    const fn = bridge.printNetworkEscPos.bind(bridge);
    return () => fn(printer.ipAddress!, printer.port ?? 9100, base64);
  }
  if (printer.connection === 'BLUETOOTH' && bridge?.printBluetoothEscPos && printer.macAddress) {
    const fn = bridge.printBluetoothEscPos.bind(bridge);
    return () => fn(printer.macAddress!, base64);
  }
  if (printer.connection === 'SMARTPOS_INTERNAL' && bridge?.printInternalEscPos) {
    const fn = bridge.printInternalEscPos.bind(bridge);
    return () => fn(base64);
  }
  return null;
}

/**
 * Envia pela ponte nativa. Com `ledgerKey`, aplica o ledger STARTED/COMPLETE:
 * ticket já impresso não sai de novo, e ticket com resultado incerto não é
 * reimpresso sozinho.
 */
function sendNative(printer: PrinterConfig, base64: string, ledgerKey?: string): RenderedTicket['delivery'] {
  if (typeof window === 'undefined') return { ok: true, via: 'SIMULATOR' };
  const call = nativeCall(printer, base64);
  if (!call) return { ok: true, via: 'SIMULATOR' };
  if (ledgerKey) {
    const previous = printLedgerGet(ledgerKey);
    if (previous?.state === 'COMPLETE') return { ok: true, via: 'NATIVE', skipped: 'ALREADY_PRINTED' };
    if (previous?.state === 'STARTED') {
      return { ok: false, via: 'NATIVE', skipped: 'PRINT_RESULT_UNCERTAIN', error: 'A impressão anterior pode ter saído. Confira o papel antes de reimprimir.' };
    }
    printLedgerMark(ledgerKey, 'STARTED');
  }
  let raw: string;
  try {
    raw = call();
  } catch (e) {
    // A ponte caiu depois de receber os bytes? Sem prova: fica STARTED (incerto).
    return { ok: false, via: 'NATIVE', error: e instanceof Error ? e.message : String(e) };
  }
  let r: { success: boolean; error?: string };
  try {
    r = JSON.parse(raw) as { success: boolean; error?: string };
  } catch {
    return { ok: false, via: 'NATIVE', error: 'Resposta inválida da impressora' };
  }
  if (ledgerKey) printLedgerMark(ledgerKey, r.success ? 'COMPLETE' : 'FAILED');
  return { ok: r.success, via: 'NATIVE', error: r.error };
}

function render(printer: PrinterConfig, title: string, make: (w: PaperWidth) => UniversalEscPosBuilder, ledgerKey?: string): RenderedTicket {
  const real = make(printer.paperWidth);
  const base64 = real.toBase64();
  return {
    printer,
    title,
    base64,
    byteLength: real.toBytes().length,
    preview: { '80MM': make('80MM').preview, '58MM': make('58MM').preview },
    delivery: sendNative(printer, base64, ledgerKey),
  };
}

const SECTOR_TITLE: Record<ProductionSector, string> = { GRILL: 'Parrilla', KITCHEN: 'Cozinha', BAR: 'Bar / Copa', DESSERT: 'Sobremesas', NONE: 'Caixa' };

/**
 * Separa os itens despachados por setor e imprime cada grupo na impressora
 * da praça correspondente, no formato de largura dela.
 */
export function routeDispatch(params: {
  items: readonly OrderItem[];
  printers: readonly PrinterConfig[];
  products: readonly Product[];
  staff: readonly StaffUser[];
  tableLabel: string;
  tableNumber: number;
  headline?: string;
}): RenderedTicket[] {
  const bySector = new Map<ProductionSector, OrderItem[]>();
  for (const i of params.items) bySector.set(i.sector, [...(bySector.get(i.sector) ?? []), i]);
  const out: RenderedTicket[] = [];
  for (const [sector, items] of bySector) {
    const targets = params.printers.filter((p) => p.active && p.sector === printerSectorFor(sector));
    const fallback = targets.length ? targets : params.printers.filter((p) => p.active && p.sector === 'KITCHEN').slice(0, 1);
    const first = items[0]!;
    const data: KitchenTicketData = {
      tableLabel: params.tableLabel,
      tableNumber: params.tableNumber,
      sectorLabel: SECTOR_TITLE[sector],
      waiterName: params.staff.find((s) => s.id === first.waiter_id)?.name ?? '-',
      fromQr: first.origin === 'QRCODE_TABLE',
      createdAt: first.created_at,
      ...(params.headline ? { headline: params.headline } : {}),
      items: items.map((i) => {
        const p = params.products.find((x) => x.id === i.product_id);
        return { quantity: i.quantity, name: p?.name ?? 'Item', code: p?.code ?? '', doneness: i.meat_doneness, notes: i.notes };
      }),
    };
    for (const printer of fallback) {
      // Mesmo lote de itens na mesma impressora = mesmo ticket físico.
      const ledgerKey = `kitchen:${printer.id}:${items.map((i) => i.id).sort().join(',')}`;
      out.push(render(printer, `${SECTOR_TITLE[sector]} · ${params.tableLabel}`, (w) => buildKitchenTicket(w, data, { beep: printer.beepOnPrint, cut: printer.cutPaper }), ledgerKey));
    }
  }
  return out;
}

export function printTestPage(printer: PrinterConfig): RenderedTicket {
  return render(printer, `Teste · ${printer.name}`, (w) => buildTestPage(w, printer));
}

// ---------------------------------------------------------------------------
// Fila do simulador visual 80mm vs 58mm
// ---------------------------------------------------------------------------
/** Reenvia o mesmo ESC/POS para a impressora (ex.: impressora estava desligada). */
export function resendTicket(ticket: RenderedTicket): RenderedTicket {
  return { ...ticket, delivery: sendNative(ticket.printer, ticket.base64) };
}

interface PrintPreviewState {
  tickets: RenderedTicket[];
  show: (t: RenderedTicket[]) => void;
  retry: (index: number) => RenderedTicket | null;
  clear: () => void;
}

export const usePrintPreview = create<PrintPreviewState>((set, get) => ({
  tickets: [],
  show: (tickets) => set({ tickets }),
  retry: (index) => {
    const t = get().tickets[index];
    if (!t) return null;
    const again = resendTicket(t);
    set((s) => ({ tickets: s.tickets.map((x, i) => (i === index ? again : x)) }));
    return again;
  },
  clear: () => set({ tickets: [] }),
}));
