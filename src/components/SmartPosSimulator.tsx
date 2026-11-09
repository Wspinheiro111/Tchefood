import { useEffect, useMemo, useState } from 'react';
import { BatteryMedium, CreditCard, Delete, Nfc, Scissors, Signal, Wifi, X } from 'lucide-react';
import {
  ACQUIRER_CNPJ,
  generateAuthorizationCode,
  generateNsu,
  maskedPan,
  randomCardBrand,
  useTerminalBus,
  type Chassis,
  type PrintJob,
} from '../lib/payments/drivers';
import { buildPixBrCode } from '../lib/pix';
import { formatBRL } from '../lib/money';
import { useTcheStore } from '../store/useTcheStore';
import { QrCode } from './QrCode';
import { playDeniedBuzz, playDispatchChime, playTap } from '../lib/sound';

const CHASSIS_STYLE: Record<Chassis, { body: string; accent: string; brand: string; text: string; key: string }> = {
  STONE: { body: 'bg-gradient-to-b from-emerald-500 to-emerald-700', accent: 'bg-stone', brand: 'stone', text: 'text-emerald-950', key: 'bg-emerald-900/40' },
  PAGBANK: { body: 'bg-gradient-to-b from-yellow-300 to-yellow-500', accent: 'bg-pagbank', brand: 'PagBank', text: 'text-yellow-950', key: 'bg-yellow-900/20' },
};

type Step = 'card' | 'reading' | 'pin' | 'decide' | 'processing' | 'pix';

/** Papel da bobina térmica de 58mm com animação de impressão. */
export function ThermalPaper({ job, onTear, qr, footer }: { job: Pick<PrintJob, 'lines' | 'title'>; onTear?: () => void; qr?: string; footer?: string[] }) {
  return (
    <div className="flex flex-col items-center">
      <div className="animate-print receipt rounded-b-md px-2 pb-2 pt-3 shadow-lg">
        <pre className="whitespace-pre text-left text-[9.5px] leading-[12px]">{job.lines.join('\n')}</pre>
        {qr && (
          <div className="mt-2 flex justify-center">
            <QrCode value={qr} size={120} />
          </div>
        )}
        {footer && <pre className="whitespace-pre text-left text-[9.5px] leading-[12px]">{footer.join('\n')}</pre>}
        <div className="mt-2 border-t border-dashed border-slate-400" />
      </div>
      {onTear && (
        <button onClick={onTear} className="mt-1 inline-flex min-h-touch items-center gap-1 rounded-lg bg-slate-800 px-3 text-xs font-bold text-white">
          <Scissors className="h-4 w-4" /> Destacar papel
        </button>
      )}
    </div>
  );
}

export function SmartPosSimulator() {
  const bus = useTerminalBus();
  const tenant = useTcheStore((s) => s.tenant);
  const pending = bus.pending;
  const chassis = bus.chassis;
  const style = CHASSIS_STYLE[chassis];
  const [step, setStep] = useState<Step>('card');
  const [pin, setPin] = useState('');
  const [entry, setEntry] = useState<'NFC' | 'CHIP'>('NFC');
  const [pixLeft, setPixLeft] = useState(120);

  useEffect(() => {
    if (!pending) return;
    setPin('');
    setPixLeft(120);
    setStep(pending.request.method === 'PIX' ? 'pix' : 'card');
  }, [pending?.request.request_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== 'pix' || !pending) return;
    const id = setInterval(() => setPixLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [step, pending]);

  useEffect(() => {
    if (step === 'pix' && pixLeft === 0 && pending) decline('QR Code Pix expirado');
  }, [pixLeft]); // eslint-disable-line react-hooks/exhaustive-deps

  const pixCode = useMemo(() => {
    if (!pending || pending.request.method !== 'PIX') return '';
    return buildPixBrCode({
      pixKeyOrUrl: `pix.${chassis === 'STONE' ? 'stone.com.br' : 'pagseguro.com.br'}/qr/v2/${pending.request.idempotency_key.replace(/-/g, '').slice(0, 25)}`,
      dynamic: true,
      merchantName: tenant.name,
      merchantCity: tenant.city,
      amount: pending.request.amount,
      txid: pending.request.idempotency_key.replace(/-/g, '').slice(0, 25),
    });
  }, [pending, chassis, tenant]);

  if (!bus.simulatorOpen) return null;

  const serial = pending?.terminal?.serial_number ?? `${chassis}-SMART-EMB`;
  const canSwitchChassis = !pending || pending.mode === 'SMARTPOS_EMBEDDED';

  const approve = () => {
    if (!pending) return;
    setStep('processing');
    setTimeout(() => {
      const brand = pending.request.method === 'PIX' ? 'PIX' : randomCardBrand();
      playDispatchChime();
      bus.finish({
        status: 'APPROVED',
        acquirer: chassis,
        acquirer_cnpj: ACQUIRER_CNPJ[chassis],
        card_brand: brand,
        nsu: generateNsu(),
        authorization_code: generateAuthorizationCode(),
        terminal_serial: serial,
        terminal_id: pending.terminal?.id ?? null,
        masked_pan: maskedPan(brand),
        mode: pending.mode,
      });
    }, 1100);
  };

  const decline = (reason = 'Saldo insuficiente') => {
    if (!pending) return;
    playDeniedBuzz();
    bus.finish({ status: 'DECLINED', acquirer: chassis, reason, terminal_serial: serial, terminal_id: pending.terminal?.id ?? null });
  };

  const job = bus.printQueue[0];

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/80 px-3 py-4">
      <div className="flex w-full max-w-[340px] flex-col items-center">
        <div className="mb-2 flex w-full items-center justify-between">
          <div className="flex gap-1 rounded-xl bg-slate-800 p-1">
            {(['STONE', 'PAGBANK'] as Chassis[]).map((c) => (
              <button
                key={c}
                disabled={!canSwitchChassis}
                onClick={() => bus.setChassis(c)}
                className={`min-h-touch rounded-lg px-3 text-sm font-bold disabled:opacity-40 ${chassis === c ? (c === 'STONE' ? 'bg-stone text-slate-950' : 'bg-pagbank text-slate-950') : 'text-slate-300'}`}
              >
                {c === 'STONE' ? 'Stone Verde' : 'PagBank Amarelo'}
              </button>
            ))}
          </div>
          <button aria-label="Fechar maquininha" onClick={bus.closeSimulator} className="grid h-12 w-12 place-items-center rounded-full bg-slate-800 text-white">
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Saída da impressora térmica no topo da maquininha */}
        <div className="relative z-10 -mb-3 flex min-h-[12px] w-[230px] flex-col items-center">
          <div className="h-3 w-full rounded-t-md bg-slate-900" />
          {job && <ThermalPaper key={job.id} job={job} onTear={() => bus.dismissPrint(job.id)} qr={job.qr} footer={job.footer} />}
        </div>

        <div className={`w-full rounded-[2.2rem] p-4 pt-6 shadow-2xl ${style.body}`}>
          <div className={`mb-2 flex items-center justify-between px-2 text-xs font-black ${style.text}`}>
            <span className="text-lg lowercase tracking-tight">{style.brand}</span>
            <span>{chassis === 'PAGBANK' ? 'Moderninha Smart' : 'POS Android'}</span>
          </div>

          {/* Visor 5.5" */}
          <div className="min-h-[360px] overflow-hidden rounded-2xl text-left border-4 border-slate-900 bg-slate-950 text-white">
            <div className="flex items-center justify-between bg-slate-900 px-3 py-1 text-[10px] text-slate-400">
              <span>{serial}</span>
              <span className="flex items-center gap-1"><Signal className="h-3 w-3" /><Wifi className="h-3 w-3" /><BatteryMedium className="h-3 w-3" /> {pending?.terminal?.battery_level ?? 88}%</span>
            </div>

            {!pending && (
              <div className="flex h-[330px] flex-col items-center justify-center gap-2 p-4 text-center">
                <div className={`grid h-14 w-14 place-items-center rounded-2xl ${style.accent}`}><CreditCard className="h-8 w-8 text-slate-950" /></div>
                <div className="font-bold">Tchê Food SmartPOS</div>
                <div className="text-xs text-slate-400">{job ? 'Imprimindo na bobina de 58mm…' : 'Aguardando cobrança'}</div>
              </div>
            )}

            {pending && (
              <div className="flex min-h-[330px] flex-col p-3">
                <div className="mb-1 text-center text-[11px] text-slate-400">
                  {pending.mode === 'TEF_POS_WIRELESS' ? `TEF POS Sem Fio · recebido via ${chassis === 'STONE' ? 'Stone Connect' : 'PagBank Connect'}` : 'SmartPOS Embarcado'}
                </div>
                <div className="text-center text-xs text-slate-300">{pending.request.table_label} · {pending.request.description}</div>
                <div className="my-1 text-center text-3xl font-black tabular-nums">{formatBRL(pending.request.amount)}</div>
                <div className="mb-2 text-center text-xs font-bold uppercase tracking-widest text-ouro">
                  {pending.request.method === 'CREDIT' ? 'Crédito à vista' : pending.request.method === 'DEBIT' ? 'Débito' : 'Pix'}
                </div>

                {step === 'card' && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3">
                    <div className="relative grid h-20 w-20 place-items-center">
                      <span className="animate-nfc absolute inset-0 rounded-full border-2 border-sky-400" />
                      <Nfc className="h-12 w-12 text-sky-400" />
                    </div>
                    <div className="text-center text-sm">Aproxime, insira ou passe o cartão</div>
                    <div className="grid w-full grid-cols-2 gap-2">
                      <button onClick={() => { setEntry('NFC'); setStep('reading'); setTimeout(() => setStep('pin'), 900); }} className="min-h-touch rounded-lg bg-sky-600 text-sm font-bold">Aproximar (NFC)</button>
                      <button onClick={() => { setEntry('CHIP'); setStep('reading'); setTimeout(() => setStep('pin'), 1300); }} className="min-h-touch rounded-lg bg-slate-700 text-sm font-bold">Inserir chip</button>
                    </div>
                  </div>
                )}
                {step === 'reading' && <div className="flex flex-1 items-center justify-center text-sm text-slate-300">{entry === 'NFC' ? 'Lendo cartão por aproximação…' : 'Lendo chip… não remova o cartão'}</div>}
                {step === 'pin' && (
                  <div className="flex flex-1 flex-col items-center">
                    <div className="mb-2 text-sm">Digite a senha</div>
                    <div className="mb-2 flex gap-2">{Array.from({ length: 4 }).map((_, i) => <span key={i} className={`h-3 w-3 rounded-full ${i < pin.length ? 'bg-white' : 'bg-slate-700'}`} />)}</div>
                    <div className="grid w-full grid-cols-3 gap-1.5">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                        <button key={d} onClick={() => { playTap(); setPin((p) => (p.length < 4 ? p + d : p)); }} className="h-10 rounded-md bg-slate-800 font-bold">{d}</button>
                      ))}
                      <button onClick={() => setPin('')} className="h-10 rounded-md bg-brasa text-xs font-bold">LIMPA</button>
                      <button onClick={() => { playTap(); setPin((p) => (p.length < 4 ? p + '0' : p)); }} className="h-10 rounded-md bg-slate-800 font-bold">0</button>
                      <button onClick={() => setPin((p) => p.slice(0, -1))} className="grid h-10 place-items-center rounded-md bg-slate-700"><Delete className="h-4 w-4" /></button>
                    </div>
                    <button disabled={pin.length < 4} onClick={() => setStep('decide')} className="mt-2 min-h-touch w-full rounded-lg bg-stone font-bold text-slate-950 disabled:opacity-40">CONFIRMA</button>
                  </div>
                )}
                {(step === 'decide' || step === 'pix') && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2">
                    {step === 'pix' && (
                      <>
                        <div className="rounded-lg bg-white p-1"><QrCode value={pixCode} size={128} /></div>
                        <div className="text-xs text-slate-300">Expira em {Math.floor(pixLeft / 60)}:{(pixLeft % 60).toString().padStart(2, '0')}</div>
                      </>
                    )}
                    {step === 'decide' && <div className="text-center text-sm text-slate-300">Senha verificada. Enviando para autorização…</div>}
                    <div className="grid w-full grid-cols-1 gap-2">
                      <button onClick={approve} className="min-h-touch rounded-lg bg-stone font-bold text-slate-950">{step === 'pix' ? 'Simular Pix recebido' : 'Aprovar Transação'}</button>
                      <button onClick={() => decline('Saldo insuficiente')} className="min-h-touch rounded-lg bg-brasa font-bold">Recusar (Saldo Insuficiente)</button>
                    </div>
                  </div>
                )}
                {step === 'processing' && <div className="flex flex-1 items-center justify-center text-sm text-slate-300">Processando com a adquirente…</div>}
              </div>
            )}
          </div>

          <div className={`mx-auto mt-3 grid w-40 grid-cols-3 gap-2 ${style.text}`}>
            <span className={`h-3 rounded-full ${style.key}`} />
            <span className={`h-3 rounded-full ${style.key}`} />
            <span className={`h-3 rounded-full ${style.key}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
