import { useState } from 'react';
import { Bluetooth, Network, Pencil, Plus, Printer, Smartphone, Trash2 } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { PaperWidth, PrinterBrand, PrinterConfig, PrinterConnection, PrinterSector } from '../services/printer/escposBuilder';
import { printTestPage, usePrintPreview } from '../services/printer/printerService';
import { uuid } from '../lib/ids';
import { Badge, Btn, Sheet, toast } from '../components/ui';

export const BRAND_PRESETS: Record<PrinterBrand, { label: string; models: string[]; width: PaperWidth; connection: PrinterConnection; cut: boolean }> = {
  EPSON: { label: 'Epson', models: ['TM-T20X', 'TM-T88VI', 'TM-m30'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  ELGIN: { label: 'Elgin', models: ['i9', 'i8', 'i7', 'Mobi 58'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  BEMATECH: { label: 'Bematech', models: ['MP-4200 TH', 'MP-100S TH'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  TANCA: { label: 'Tanca', models: ['TP-650', 'TP-550'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  CONTROLID: { label: 'ControlID', models: ['Print iD', 'Print iD Touch'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  DARUMA: { label: 'Daruma', models: ['DR800', 'DR700'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  JETWAY: { label: 'Jetway', models: ['JP-500', 'JP-800'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  SWEDA: { label: 'Sweda', models: ['SI-300', 'SI-250'], width: '80MM', connection: 'NETWORK_TCP', cut: true },
  GENERIC_BT: { label: 'Genérica Bluetooth', models: ['MTP-II', 'PT-210', 'Mini 58mm'], width: '58MM', connection: 'BLUETOOTH', cut: false },
  SMARTPOS_STONE: { label: 'Bobina Interna Stone', models: ['Stone POS Android'], width: '58MM', connection: 'SMARTPOS_INTERNAL', cut: false },
  SMARTPOS_PAGBANK: { label: 'Bobina Interna PagBank', models: ['Moderninha Smart 2'], width: '58MM', connection: 'SMARTPOS_INTERNAL', cut: false },
};

const SECTOR_LABEL: Record<PrinterSector, string> = { GRILL: '🔥 Parrilla', KITCHEN: '🍳 Cozinha', BAR: '🍺 Bar / Copa', DESSERT: '🍮 Sobremesas', CASHIER: '🧾 Caixa / Conferência / NFC-e' };
const CONN_LABEL: Record<PrinterConnection, string> = { NETWORK_TCP: 'Rede TCP/IP (porta 9100)', BLUETOOTH: 'Bluetooth (MAC)', SMARTPOS_INTERNAL: 'Bobina interna da maquininha (58mm)' };
const CONN_ICON = { NETWORK_TCP: Network, BLUETOOTH: Bluetooth, SMARTPOS_INTERNAL: Smartphone } as const;

function blank(): PrinterConfig {
  return { id: uuid(), name: '', brand: 'ELGIN', model: 'i9', sector: 'KITCHEN', paperWidth: '80MM', connection: 'NETWORK_TCP', ipAddress: '192.168.1.', port: 9100, beepOnPrint: true, cutPaper: true, active: true };
}

/** Cadastro e roteamento de impressoras térmicas por praça. */
export function PrinterSettings() {
  const printers = useTcheStore((s) => s.printers);
  const remove = useTcheStore((s) => s.removePrinter);
  const [editing, setEditing] = useState<PrinterConfig | null>(null);

  const test = (p: PrinterConfig) => {
    const t = printTestPage(p);
    usePrintPreview.getState().show([t]);
    if (t.delivery.via === 'NATIVE') (t.delivery.ok ? toast.success : toast.error)(t.delivery.ok ? 'Página de teste enviada.' : `Falha: ${t.delivery.error}`);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-400">Cada praça imprime no formato da sua bobina: 80mm = 48 colunas com guilhotina, 58mm = 32 colunas com serrilha.</p>
        <Btn onClick={() => setEditing(blank())}><Plus className="h-5 w-5" /> Nova impressora</Btn>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {printers.map((p) => {
          const Icon = CONN_ICON[p.connection];
          return (
            <div key={p.id} className={`rounded-2xl border bg-surface p-4 ${p.active ? 'border-slate-700' : 'border-dashed border-slate-700 opacity-60'}`}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 font-bold"><Printer className="h-5 w-5 text-ouro" /> {p.name}</div>
                  <div className="text-xs text-slate-400">{BRAND_PRESETS[p.brand].label} {p.model}</div>
                </div>
                <Badge className={p.paperWidth === '80MM' ? 'bg-ouro text-slate-950' : 'bg-slate-600'}>{p.paperWidth === '80MM' ? '80mm · 48 col' : '58mm · 32 col'}</Badge>
              </div>
              <div className="mb-3 space-y-1 text-sm">
                <div>{SECTOR_LABEL[p.sector]}</div>
                <div className="flex items-center gap-1 text-slate-300"><Icon className="h-4 w-4" /> {p.connection === 'NETWORK_TCP' ? `${p.ipAddress}:${p.port ?? 9100}` : p.connection === 'BLUETOOTH' ? p.macAddress : 'Bobina interna'}</div>
                <div className="text-xs text-slate-400">{p.beepOnPrint ? 'Sirene ligada' : 'Sem sirene'} · {p.cutPaper ? 'Guilhotina automática' : 'Serrilha manual'}</div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Btn variant="success" onClick={() => test(p)}>Testar</Btn>
                <Btn variant="secondary" onClick={() => setEditing({ ...p })}><Pencil className="h-4 w-4" /></Btn>
                <Btn variant="danger" onClick={() => { if (window.confirm(`Remover ${p.name}?`)) remove(p.id); }}><Trash2 className="h-4 w-4" /></Btn>
              </div>
            </div>
          );
        })}
      </div>
      {editing && <PrinterForm value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PrinterForm({ value, onClose }: { value: PrinterConfig; onClose: () => void }) {
  const upsert = useTcheStore((s) => s.upsertPrinter);
  const [p, setP] = useState<PrinterConfig>(value);
  const set = <K extends keyof PrinterConfig>(k: K, v: PrinterConfig[K]) => setP((cur) => ({ ...cur, [k]: v }));

  const pickBrand = (brand: PrinterBrand) => {
    const preset = BRAND_PRESETS[brand];
    setP((cur) => ({ ...cur, brand, model: preset.models[0]!, paperWidth: preset.width, connection: preset.connection, cutPaper: preset.cut }));
  };

  const save = () => {
    const r = upsert(p);
    if (!r.ok) return toast.error(r.error);
    toast.success('Impressora salva.');
    onClose();
  };

  const field = 'min-h-touch w-full rounded-xl border border-slate-600 bg-base px-3 outline-none focus:border-ouro';
  return (
    <Sheet open onClose={onClose} title={value.name ? `Editar ${value.name}` : 'Nova impressora'} footer={<Btn block size="lg" onClick={save}>Salvar impressora</Btn>}>
      <div className="space-y-3">
        <label className="block text-sm font-semibold">Nome<input className={field} value={p.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Impressora Parrilla (Elgin i9)" /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm font-semibold">Marca
            <select className={field} value={p.brand} onChange={(e) => pickBrand(e.target.value as PrinterBrand)}>
              {(Object.keys(BRAND_PRESETS) as PrinterBrand[]).map((b) => <option key={b} value={b}>{BRAND_PRESETS[b].label}</option>)}
            </select>
          </label>
          <label className="block text-sm font-semibold">Modelo
            <input className={field} list="models" value={p.model} onChange={(e) => set('model', e.target.value)} />
            <datalist id="models">{BRAND_PRESETS[p.brand].models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        </div>
        <div>
          <div className="mb-1 text-sm font-semibold">Largura da bobina</div>
          <div className="grid grid-cols-2 gap-2">
            {(['80MM', '58MM'] as PaperWidth[]).map((w) => <Btn key={w} variant={p.paperWidth === w ? 'gold' : 'secondary'} onClick={() => set('paperWidth', w)}>{w === '80MM' ? '80mm (48 colunas)' : '58mm (32 colunas)'}</Btn>)}
          </div>
        </div>
        <div>
          <div className="mb-1 text-sm font-semibold">Conexão</div>
          <div className="grid gap-2">
            {(Object.keys(CONN_LABEL) as PrinterConnection[]).map((c) => <Btn key={c} variant={p.connection === c ? 'gold' : 'secondary'} onClick={() => set('connection', c)}>{CONN_LABEL[c]}</Btn>)}
          </div>
        </div>
        {p.connection === 'NETWORK_TCP' && (
          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <label className="block text-sm font-semibold">IP<input className={field} inputMode="decimal" value={p.ipAddress ?? ''} onChange={(e) => set('ipAddress', e.target.value)} placeholder="192.168.1.200" /></label>
            <label className="block text-sm font-semibold">Porta<input className={field} inputMode="numeric" value={p.port ?? 9100} onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || 9100)} /></label>
          </div>
        )}
        {p.connection === 'BLUETOOTH' && (
          <label className="block text-sm font-semibold">MAC Address<input className={field} value={p.macAddress ?? ''} onChange={(e) => set('macAddress', e.target.value.toUpperCase())} placeholder="66:22:A1:3C:7F:10" /></label>
        )}
        <label className="block text-sm font-semibold">Praça vinculada
          <select className={field} value={p.sector} onChange={(e) => set('sector', e.target.value as PrinterSector)}>
            {(Object.keys(SECTOR_LABEL) as PrinterSector[]).map((s) => <option key={s} value={s}>{SECTOR_LABEL[s]}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <Btn variant={p.beepOnPrint ? 'success' : 'secondary'} onClick={() => set('beepOnPrint', !p.beepOnPrint)}>Sirene {p.beepOnPrint ? 'on' : 'off'}</Btn>
          <Btn variant={p.cutPaper ? 'success' : 'secondary'} onClick={() => set('cutPaper', !p.cutPaper)}>Guilhotina {p.cutPaper ? 'on' : 'off'}</Btn>
          <Btn variant={p.active ? 'success' : 'secondary'} onClick={() => set('active', !p.active)}>{p.active ? 'Ativa' : 'Inativa'}</Btn>
        </div>
      </div>
    </Sheet>
  );
}
