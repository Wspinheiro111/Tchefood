import { useEffect, useRef, useState } from 'react';
import { Keyboard, Plug, Scale } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { Product } from '../types';
import { computeItemTotal, formatBRL } from '../lib/money';
import { computeNetWeight, readStable, SimulatedScale, webSerialAvailable, WebSerialScale, type ScaleReader, type ScaleReading } from '../lib/scale';
import { Btn, Sheet, toast } from './ui';

type Display = { text: string; tone: 'ok' | 'wait' | 'error' };

const TARE_PRESETS = [
  { label: 'Sem prato', grams: 0 },
  { label: 'Taça 120 g', grams: 120 },
  { label: 'Prato raso 280 g', grams: 280 },
  { label: 'Prato fundo 350 g', grams: 350 },
  { label: 'Marmita 410 g', grams: 410 },
];

/**
 * ⚖️ Lançar Buffet a Quilo: lê a balança (Toledo/Filizola pela serial ou o
 * simulador), desconta a tara do prato e manda o prato pesado para a bandeja.
 */
export function ScaleSheet({ orderId, open, onClose }: { orderId: string; open: boolean; onClose: () => void }) {
  const products = useTcheStore((s) => s.products);
  const addWeighed = useTcheStore((s) => s.addWeighedToTray);
  const weighable = products.filter((p) => p.sold_by_weight && p.available);
  const [productId, setProductId] = useState<string>(weighable[0]?.id ?? '');
  const product: Product | undefined = weighable.find((p) => p.id === productId) ?? weighable[0];
  const [tare, setTare] = useState<number>(product?.tare_weight_grams ?? 0);
  const [gross, setGross] = useState<number | null>(null);
  const [source, setSource] = useState<'SCALE' | 'MANUAL'>('SCALE');
  const [display, setDisplay] = useState<Display>({ text: '0.000', tone: 'wait' });
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const serial = useRef<ScaleReader | null>(null);

  useEffect(() => {
    if (open) {
      setGross(null);
      setManual('');
      setDisplay({ text: '0.000', tone: 'wait' });
    }
  }, [open]);
  useEffect(() => {
    if (product) setTare(product.tare_weight_grams);
  }, [product?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void serial.current?.close().catch(() => undefined), []);

  const show = (r: ScaleReading) => {
    if (r.kind === 'STABLE') setDisplay({ text: (r.grams / 1000).toFixed(3), tone: 'ok' });
    else if (r.kind === 'UNSTABLE') setDisplay({ text: '- - - - -', tone: 'wait' });
    else if (r.kind === 'OVERLOAD') setDisplay({ text: 'SOBRECARGA', tone: 'error' });
    else if (r.kind === 'NEGATIVE') setDisplay({ text: 'NEGATIVO', tone: 'error' });
    else setDisplay({ text: 'ERRO', tone: 'error' });
  };

  const weigh = async (reader: ScaleReader) => {
    setBusy(true);
    try {
      const r = await readStable(reader, show);
      if (r.kind === 'STABLE') {
        setGross(r.grams);
        setSource('SCALE');
      } else {
        setGross(null);
        toast.error(r.kind === 'UNSTABLE' ? 'Peso não estabilizou. Não mexa no prato e pese de novo.' : 'Leitura da balança inválida.');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const simulate = () => {
    // Prato servido entre 350 g e 900 g de comida + a tara escolhida.
    const food = 350 + Math.round(Math.random() * 550);
    void weigh(new SimulatedScale(food + tare));
  };

  const connectSerial = async () => {
    try {
      serial.current ??= await WebSerialScale.connect(9600);
      await weigh(serial.current);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const useManual = () => {
    const g = Math.round(Number(manual.replace(',', '.')) * (manual.includes(',') || manual.includes('.') ? 1000 : 1));
    if (!(g > 0)) return toast.error('Digite o peso bruto (ex.: 645 ou 0,645).');
    setGross(g);
    setSource('MANUAL');
    setDisplay({ text: (g / 1000).toFixed(3), tone: 'ok' });
  };

  const net = gross !== null ? computeNetWeight(gross, tare) : null;
  const netOk = net && !('error' in net) ? net : null;
  const total = netOk && product ? computeItemTotal(netOk.quantityKg, product.price, 0) : 0;

  const confirm = () => {
    if (!product || gross === null) return;
    const r = addWeighed(orderId, product.id, gross, tare, source);
    if (!r.ok) return toast.error(r.error);
    toast.success(`⚖️ ${r.data.quantity.toFixed(3).replace('.', ',')} kg de ${product.name} na bandeja (${formatBRL(total)}).`);
    onClose();
  };

  if (!product) return null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2"><Scale className="h-5 w-5 text-brasa" /> Buffet a Quilo (Balança)</span>}
      footer={<Btn block size="lg" variant="success" disabled={!netOk || busy} onClick={confirm}>Lançar {netOk ? formatBRL(total) : ''} na comanda</Btn>}
    >
      {weighable.length > 1 && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          {weighable.map((p) => (
            <button key={p.id} onClick={() => setProductId(p.id)} className={`min-h-touch rounded-xl px-3 text-sm font-bold ${product.id === p.id ? 'bg-ouro text-slate-950' : 'bg-base text-slate-700'}`}>
              {p.name} · {formatBRL(p.price)}/kg
            </button>
          ))}
        </div>
      )}

      {/* Visor digital da balança: fica escuro de propósito, imita o LCD do aparelho. */}
      <div className="mb-3 rounded-2xl border-4 border-slate-300 bg-black p-3 text-right font-mono">
        <div className="flex justify-between text-[11px] font-bold uppercase text-slate-500">
          <span>{source === 'MANUAL' && gross !== null ? 'Digitado' : 'Toledo · Filizola'}</span>
          <span className={display.tone === 'ok' ? 'text-emerald-500' : display.tone === 'error' ? 'text-rose-500' : 'text-amber-500'}>
            {display.tone === 'ok' ? '● ESTÁVEL' : display.tone === 'error' ? '● ERRO' : busy ? '● PESANDO' : '○ AGUARDANDO'}
          </span>
        </div>
        <div className={`text-5xl font-black tabular-nums ${display.tone === 'error' ? 'text-rose-500' : 'text-emerald-500'}`}>{display.text}<span className="ml-1 text-xl">kg</span></div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <Btn size="lg" variant="gold" disabled={busy} onClick={simulate}><Scale className="h-5 w-5" /> Ler balança (simulada)</Btn>
        <Btn size="lg" variant="secondary" disabled={busy || !webSerialAvailable()} onClick={connectSerial} title={webSerialAvailable() ? 'Toledo/Filizola pela porta serial/USB' : 'Navegador sem Web Serial'}>
          <Plug className="h-5 w-5" /> Balança USB/Serial
        </Btn>
      </div>

      <div className="mb-3">
        <div className="mb-1 text-sm text-slate-500">Tara do recipiente</div>
        <div className="flex flex-wrap gap-2">
          {TARE_PRESETS.map((t) => (
            <button key={t.grams} onClick={() => setTare(t.grams)} className={`min-h-touch rounded-xl px-3 text-sm font-bold ${tare === t.grams ? 'bg-sky-600 text-white' : 'bg-base text-slate-700'}`}>{t.label}</button>
          ))}
        </div>
      </div>

      <details className="mb-3 rounded-xl bg-base p-3">
        <summary className="flex min-h-touch cursor-pointer items-center gap-2 text-sm font-bold text-slate-700"><Keyboard className="h-4 w-4" /> Digitar o peso (balança sem cabo)</summary>
        <div className="mt-2 flex gap-2">
          <input inputMode="decimal" value={manual} onChange={(e) => setManual(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Peso bruto: 645 ou 0,645" className="min-h-touch flex-1 rounded-xl border border-slate-300 bg-surface px-3 text-lg outline-none" />
          <Btn variant="secondary" onClick={useManual}>Usar</Btn>
        </div>
        <p className="mt-1 text-xs text-slate-500">O item fica marcado como “peso digitado” na comanda e na auditoria.</p>
      </details>

      <div className="rounded-xl border border-slate-200 p-3 text-sm">
        <div className="flex justify-between"><span>Peso bruto</span><b className="tabular-nums">{gross !== null ? `${gross} g` : '—'}</b></div>
        <div className="flex justify-between"><span>Tara</span><b className="tabular-nums">− {tare} g</b></div>
        <div className="flex justify-between"><span>Líquido</span><b className="tabular-nums">{netOk ? `${netOk.netGrams} g` : '—'}</b></div>
        <div className="flex justify-between"><span>Preço do quilo</span><b className="tabular-nums">{formatBRL(product.price)}</b></div>
        <div className="mt-1 flex justify-between text-lg"><span className="font-bold">Total do prato</span><b className="tabular-nums text-brasa">{netOk ? formatBRL(total) : '—'}</b></div>
        {net && 'error' in net && <p className="mt-1 text-rose-600">{net.error}</p>}
      </div>
    </Sheet>
  );
}
