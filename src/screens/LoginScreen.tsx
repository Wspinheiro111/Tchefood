import { useState } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { BrandLogo } from '../components/Brand';
import { PinPad } from '../components/PinPad';
import { useTcheStore } from '../store/useTcheStore';
import { playDeniedBuzz, vibrate } from '../lib/sound';
import { useOnline } from '../lib/useOnline';

export function LoginScreen() {
  const login = useTcheStore((s) => s.login);
  const tenant = useTcheStore((s) => s.tenant);
  const online = useOnline();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const attempt = (value: string) => {
    const res = login(value);
    if (!res.ok) {
      setError(res.error);
      playDeniedBuzz();
      vibrate(120);
      setTimeout(() => setPin(''), 300);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-gradient-to-b from-base to-surface px-4 py-8">
      <div className="mb-6 flex flex-col items-center text-center">
        <h1 className="mb-2">
          <BrandLogo variant="dark" className="h-20 w-auto max-w-[min(90vw,360px)] sm:h-24" />
        </h1>
        <p className="text-sm text-slate-400">{tenant.name} · {tenant.city}/{tenant.state}</p>
        <span className={`mt-2 inline-flex items-center gap-1 text-xs ${online ? 'text-stone' : 'text-ouro'}`}>
          {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />} {online ? 'Online' : 'Offline — operando pela fila local'}
        </span>
      </div>
      <p className="mb-4 text-lg font-semibold">Digite seu PIN</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={attempt} error={Boolean(error)} />
      <p className="mt-4 h-6 text-center text-sm font-semibold text-rose-300">{error}</p>
      <div className="mt-6 grid w-full max-w-xs grid-cols-2 gap-2 text-xs text-slate-500">
        <span>1111 · Garçom Tião</span>
        <span>2222 · Garçom Duda</span>
        <span>7777 · Cozinha (KDS)</span>
        <span>9999 · Gerente</span>
        <span>8888 · Dono</span>
        <span>5555 · Caixa</span>
        <span>4444 · Totem (cliente)</span>
      </div>
    </div>
  );
}
