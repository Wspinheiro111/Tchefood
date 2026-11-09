import { BellRing, Bluetooth, Network, Scissors, Smartphone, X } from 'lucide-react';
import { COLUMNS, type PaperWidth, type PreviewEvent } from '../services/printer/escposBuilder';
import { routeDispatch, usePrintPreview, type RenderedTicket } from '../services/printer/printerService';
import { useTcheStore } from '../store/useTcheStore';
import type { OrderItem } from '../types';

/** Papel térmico renderizado a partir do preview ESC/POS (respeita 48/32 colunas). */
export function EscPosPaper({ width, events }: { width: PaperWidth; events: PreviewEvent[] }) {
  const cols = COLUMNS[width];
  // 1ch de fonte mono = 1 coluna. Dupla largura ocupa 2ch por caractere.
  return (
    <div className={`relative shadow-xl ${width === '80MM' ? 'bg-[#fff8dc]' : 'bg-[#fdfcf7]'}`} style={{ width: `calc(${cols}ch + 16px)`, fontFamily: "'Courier New', ui-monospace, monospace", fontSize: 11 }}>
      <div className="px-2 py-3 leading-[14px] text-slate-900">
        {events.map((e, idx) => {
          if (e.kind === 'beep') return <div key={idx} className="mb-1 flex items-center gap-1 text-[10px] font-bold text-rose-700"><BellRing className="h-3 w-3" /> ESC B · sirene</div>;
          if (e.kind === 'cut')
            return (
              <div key={idx} className="mt-3 flex items-center gap-1 border-t-2 border-dashed border-slate-500 pt-1 text-[10px] text-slate-600">
                <Scissors className="h-3 w-3" /> {e.guillotine ? 'GS V 66 0 · guilhotina' : 'serrilha manual'}
              </div>
            );
          const l = e.line;
          const wide = l.size === 'LARGE';
          const tall = l.size !== 'NORMAL';
          return (
            <div
              key={idx}
              className={`whitespace-pre ${l.bold ? 'font-bold' : ''}`}
              style={{
                textAlign: l.align === 'CENTER' ? 'center' : l.align === 'RIGHT' ? 'right' : 'left',
                transform: `scale(${wide ? 2 : 1}, ${tall ? 2 : 1})`,
                transformOrigin: l.align === 'CENTER' ? 'center top' : l.align === 'RIGHT' ? 'right top' : 'left top',
                height: tall ? 28 : 14,
                width: wide ? '50%' : '100%',
                marginLeft: wide && l.align === 'CENTER' ? '25%' : wide && l.align === 'RIGHT' ? '50%' : 0,
              }}
            >
              {l.text || ' '}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CONN_ICON = { NETWORK_TCP: Network, BLUETOOTH: Bluetooth, SMARTPOS_INTERNAL: Smartphone } as const;

function TicketBlock({ t }: { t: RenderedTicket }) {
  const Icon = CONN_ICON[t.printer.connection];
  return (
    <section className="rounded-2xl bg-slate-900 p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="font-bold">{t.title}</div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Icon className="h-4 w-4" /> {t.printer.name} · {t.printer.paperWidth === '80MM' ? '80mm' : '58mm'} ·{' '}
          {t.printer.connection === 'NETWORK_TCP' ? `${t.printer.ipAddress}:${t.printer.port ?? 9100}` : t.printer.connection === 'BLUETOOTH' ? t.printer.macAddress : 'interna'} · {t.byteLength} bytes ·{' '}
          <span className={t.delivery.ok ? 'text-stone' : 'text-rose-300'}>{t.delivery.via === 'NATIVE' ? (t.delivery.ok ? 'enviado' : `falha: ${t.delivery.error}`) : 'simulado'}</span>
        </div>
      </header>
      <div className="scroll-thin flex gap-4 overflow-x-auto pb-2">
        <div className="shrink-0">
          <div className={`mb-1 text-center text-xs font-bold ${t.printer.paperWidth === '80MM' ? 'text-ouro' : 'text-slate-400'}`}>Bobina larga 80mm · 48 colunas{t.printer.paperWidth === '80MM' ? ' (esta impressora)' : ''}</div>
          <EscPosPaper width="80MM" events={t.preview['80MM']} />
        </div>
        <div className="shrink-0">
          <div className={`mb-1 text-center text-xs font-bold ${t.printer.paperWidth === '58MM' ? 'text-ouro' : 'text-slate-400'}`}>Bobina estreita 58mm · 32 colunas{t.printer.paperWidth === '58MM' ? ' (esta impressora)' : ''}</div>
          <EscPosPaper width="58MM" events={t.preview['58MM']} />
        </div>
      </div>
      <details className="mt-1 text-xs text-slate-400">
        <summary className="cursor-pointer">Base64 ESC/POS enviado à ponte nativa</summary>
        <code className="block max-h-24 overflow-auto break-all text-[10px] text-emerald-300">{t.base64}</code>
      </details>
    </section>
  );
}

/** Modal de simulação térmica lado a lado 80mm vs 58mm. */
export function PrintSimulatorModal() {
  const { tickets, clear } = usePrintPreview();
  if (tickets.length === 0) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/80 sm:items-center" onClick={clear}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[94vh] w-full max-w-5xl flex-col rounded-t-2xl bg-surface sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
          <h2 className="text-lg font-bold">Impressão térmica ESC/POS · {tickets.length} ticket(s)</h2>
          <button aria-label="Fechar" onClick={clear} className="grid h-11 w-11 place-items-center rounded-full active:bg-slate-700"><X className="h-6 w-6" /></button>
        </div>
        <div className="scroll-thin space-y-3 overflow-y-auto p-3">
          {tickets.map((t, i) => <TicketBlock key={i} t={t} />)}
        </div>
      </div>
    </div>
  );
}

/** Roteia itens recém-despachados para as impressoras das praças e abre o simulador. */
export function printDispatchedItems(items: readonly OrderItem[]) {
  const s = useTcheStore.getState();
  const order = s.orders.find((o) => o.id === items[0]?.order_id);
  const table = s.tables.find((t) => t.id === order?.table_id);
  if (!order || !table) return;
  const tickets = routeDispatch({ items, printers: s.printers, products: s.products, staff: s.staff, tableLabel: table.label, tableNumber: table.number });
  if (s.showPrintSimulator && tickets.some((t) => t.delivery.via === 'SIMULATOR')) usePrintPreview.getState().show(tickets);
}
