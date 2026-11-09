import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bike, ChefHat, Expand, Flame, Minimize, ShoppingBag, Volume2, VolumeX } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { playDispatchChime } from '../lib/sound';
import { useDeliveryOrders, useDeliveryPolling } from '../lib/deliveryDemo';
import { buildBoard, deliveryBoardEntries, qrBoardEntries, type BoardEntry } from '../lib/orderBoard';

// Painel de senhas para TV (estilo fast-food): "Preparando" e "Pronto". Só mostra número do pedido e primeiro
// nome do cliente; nada de telefone, endereço ou valores, porque fica virado para o salão.
const HIGHLIGHT_MS = 30_000;

function spokenNumber(entry: BoardEntry): string {
  return /^\d+$/.test(entry.number) ? `Pedido ${entry.number.split('').join(' ')}` : entry.number;
}

function announce(entry: BoardEntry) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const phrase = entry.courierLabel
      ? `${spokenNumber(entry)}, pronto para o entregador.`
      : `${spokenNumber(entry)}, ${entry.subtitle}, pronto.`;
    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.lang = 'pt-BR';
    window.speechSynthesis.speak(utterance);
  } catch {
    // TV sem voz: o destaque visual e o sinal sonoro bastam.
  }
}

export function OrderBoardScreen() {
  useDeliveryPolling(useCallback(() => undefined, []));
  const orders = useDeliveryOrders((s) => s.orders);
  const orderItems = useTcheStore((s) => s.orderItems);
  const tables = useTcheStore((s) => s.tables);
  const tableOrders = useTcheStore((s) => s.orders);
  const tenant = useTcheStore((s) => s.tenant);
  const [voice, setVoice] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  // Quando cada pedido apareceu como pronto nesta tela (para destacar e chamar uma vez só).
  const readySince = useRef(new Map<string, number>());
  const firstRender = useRef(true);

  const { preparing, ready } = useMemo(
    () => buildBoard([...deliveryBoardEntries(orders), ...qrBoardEntries(orderItems, tables, tableOrders)]),
    [orders, orderItems, tables, tableOrders],
  );

  useEffect(() => {
    const seen = readySince.current;
    const current = new Set(ready.map((entry) => entry.key));
    for (const key of [...seen.keys()]) if (!current.has(key)) seen.delete(key);
    const fresh = ready.filter((entry) => !seen.has(entry.key));
    for (const entry of fresh) seen.set(entry.key, Date.now());
    // Ao abrir o painel, quem já estava pronto não é chamado de novo.
    if (firstRender.current) {
      firstRender.current = false;
      for (const entry of fresh) seen.set(entry.key, 0);
      return;
    }
    if (fresh.length > 0) {
      playDispatchChime();
      if (voice) fresh.forEach(announce);
    }
  }, [ready, voice]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
  };


  return (
    <div ref={rootRef} className="flex min-h-[calc(100vh-56px)] flex-col bg-base text-white">
      <header className="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-brasa"><Flame className="h-7 w-7" /></div>
        <div className="mr-auto">
          <div className="text-2xl font-black">{tenant.name}</div>
          <div className="text-sm text-slate-400">Acompanhe seu pedido</div>
        </div>
        <div className="text-3xl font-black tabular-nums text-slate-300">
          {new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <button aria-label={voice ? 'Desligar voz' : 'Ligar voz'} onClick={() => setVoice((v) => !v)} className="grid h-12 w-12 place-items-center rounded-xl bg-surface">
          {voice ? <Volume2 className="h-6 w-6" /> : <VolumeX className="h-6 w-6 text-slate-500" />}
        </button>
        <button aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} onClick={toggleFullscreen} className="grid h-12 w-12 place-items-center rounded-xl bg-surface">
          {fullscreen ? <Minimize className="h-6 w-6" /> : <Expand className="h-6 w-6" />}
        </button>
      </header>

      <div className="grid flex-1 grid-cols-1 md:grid-cols-2">
        <section className="border-b border-slate-800 p-6 md:border-b-0 md:border-r">
          <h2 className="mb-5 flex items-center gap-3 text-3xl font-black uppercase tracking-wide text-ouro">
            <ChefHat className="h-9 w-9" /> Preparando
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {preparing.map((entry) => (
              <div key={entry.key} className="rounded-2xl border border-slate-700 bg-surface px-4 py-3 text-center">
                <div className="text-5xl font-black tabular-nums text-slate-200">{entry.number}</div>
                <div className="truncate text-lg text-slate-400">{entry.subtitle}</div>
              </div>
            ))}
          </div>
          {preparing.length === 0 && <p className="text-xl text-slate-500">Nenhum pedido em preparo.</p>}
        </section>

        <section className="bg-stone/5 p-6">
          <h2 className="mb-5 flex items-center gap-3 text-3xl font-black uppercase tracking-wide text-stone">
            <ShoppingBag className="h-9 w-9" /> Pronto
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {ready.map((entry) => {
              const since = readySince.current.get(entry.key) ?? 0;
              const fresh = since > 0 && now - since < HIGHLIGHT_MS;
              return (
                <div
                  key={entry.key}
                  className={`rounded-2xl border-2 px-4 py-3 text-center ${fresh ? 'animate-pulse-ring border-stone bg-stone text-slate-950' : 'border-stone/60 bg-stone/15'}`}
                >
                  <div className="text-6xl font-black tabular-nums">{entry.number}</div>
                  <div className={`truncate text-lg ${fresh ? 'text-slate-900' : 'text-slate-300'}`}>{entry.subtitle}</div>
                  {entry.courierLabel && (
                    <div className={`mt-1 flex items-center justify-center gap-1 text-sm font-bold ${fresh ? 'text-slate-900' : 'text-stone'}`}>
                      <Bike className="h-4 w-4" /> {entry.courierLabel}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {ready.length === 0 && <p className="text-xl text-slate-500">Quando seu pedido ficar pronto, o número aparece aqui.</p>}
        </section>
      </div>
    </div>
  );
}
