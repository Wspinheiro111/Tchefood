import { useEffect, useState } from 'react';
import { BarChart3, Bike, ChefHat, CloudOff, Flame, LayoutGrid, LogOut, QrCode as QrIcon, RefreshCw, Smartphone } from 'lucide-react';
import { isManagerRole, selectCurrentUser, useTcheStore } from './store/useTcheStore';
import { useOnline } from './lib/useOnline';
import { useTerminalBus } from './lib/payments/drivers';
import { LoginScreen } from './screens/LoginScreen';
import { TableMap } from './screens/TableMap';
import { OrderScreen } from './screens/OrderScreen';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { KdsScreen } from './screens/KdsScreen';
import { QrMenuScreen } from './screens/QrMenuScreen';
import { BackOffice } from './screens/BackOffice';
import { DeliveryScreen } from './screens/DeliveryScreen';
import { SmartPosSimulator } from './components/SmartPosSimulator';
import { PrintSimulatorModal } from './components/PrintSimulator';
import { ToastHost } from './components/ui';
import type { UserRole } from './types';

type View =
  | { name: 'map' }
  | { name: 'order'; orderId: string }
  | { name: 'checkout'; orderId: string }
  | { name: 'kds' }
  | { name: 'qr' }
  | { name: 'delivery' }
  | { name: 'backoffice' };

type NavKey = 'map' | 'kds' | 'qr' | 'delivery' | 'backoffice';

const NAV: Array<{ key: NavKey; label: string; icon: typeof LayoutGrid; roles: UserRole[] }> = [
  { key: 'map', label: 'Mesas', icon: LayoutGrid, roles: ['WAITER', 'MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'kds', label: 'KDS', icon: ChefHat, roles: ['KITCHEN', 'MANAGER', 'OWNER'] },
  { key: 'qr', label: 'QR Cliente', icon: QrIcon, roles: ['WAITER', 'MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'delivery', label: 'Delivery', icon: Bike, roles: ['MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'backoffice', label: 'Retaguarda', icon: BarChart3, roles: ['MANAGER', 'OWNER', 'CASHIER'] },
];

export default function App() {
  const hydrated = useTcheStore((s) => s.hydrated);
  const user = useTcheStore(selectCurrentUser);
  const logout = useTcheStore((s) => s.logout);
  const outbox = useTcheStore((s) => s.outbox.length);
  const online = useOnline();
  const [view, setView] = useState<View>({ name: 'map' });

  // Perfil Cozinha entra direto no KDS.
  useEffect(() => {
    if (user?.role === 'KITCHEN') setView({ name: 'kds' });
    else if (user) setView({ name: 'map' });
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hydrated) {
    return (
      <div className="grid h-full place-items-center">
        <RefreshCw className="h-8 w-8 animate-spin text-ouro" />
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LoginScreen />
        <ToastHost />
      </>
    );
  }

  const nav = NAV.filter((n) => n.roles.includes(user.role));
  const activeKey: NavKey = view.name === 'order' || view.name === 'checkout' ? 'map' : view.name;

  return (
    <div className="min-h-full pb-[72px] sm:pb-0">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-800 bg-base/95 px-3 backdrop-blur">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-brasa"><Flame className="h-5 w-5 text-white" /></div>
        <div className="mr-auto leading-tight">
          <div className="font-black">Tchê <span className="text-ouro">Food</span></div>
          <div className="text-[11px] text-slate-400">{user.name} · {user.role === 'WAITER' ? 'Garçom' : user.role === 'MANAGER' ? 'Gerente' : user.role === 'OWNER' ? 'Proprietário' : user.role === 'KITCHEN' ? 'Cozinha' : 'Caixa'}</div>
        </div>
        <nav className="hidden gap-1 sm:flex">
          {nav.map((n) => (
            <button key={n.key} onClick={() => setView({ name: n.key } as View)} className={`flex min-h-touch items-center gap-2 rounded-xl px-3 text-sm font-bold ${activeKey === n.key ? 'bg-surface text-ouro' : 'text-slate-300'}`}>
              <n.icon className="h-4 w-4" /> {n.label}
            </button>
          ))}
        </nav>
        <button aria-label="Abrir maquininha" onClick={() => useTerminalBus.getState().openSimulator()} className="grid h-11 w-11 place-items-center rounded-xl bg-surface text-stone" title="Maquininha / bobina">
          <Smartphone className="h-5 w-5" />
        </button>
        <span title={online ? `${outbox} evento(s) na fila de sincronização` : 'Offline: operando pela fila local'} className={`hidden items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold md:inline-flex ${online ? 'bg-stone/15 text-stone' : 'bg-ouro/20 text-ouro'}`}>
          {online ? '●' : <CloudOff className="h-3 w-3" />} {online ? 'Online' : 'Offline'} · fila {outbox}
        </span>
        <button aria-label="Sair" onClick={logout} className="grid h-11 w-11 place-items-center rounded-xl bg-surface"><LogOut className="h-5 w-5" /></button>
      </header>

      <main>
        {view.name === 'map' && <TableMap onOpenOrder={(orderId) => setView({ name: 'order', orderId })} />}
        {view.name === 'order' && (
          <OrderScreen orderId={view.orderId} onBack={() => setView({ name: 'map' })} onCheckout={(orderId) => setView({ name: 'checkout', orderId })} />
        )}
        {view.name === 'checkout' && (
          <CheckoutScreen orderId={view.orderId} onBack={() => setView({ name: 'order', orderId: view.orderId })} onClosed={() => setView({ name: 'map' })} />
        )}
        {view.name === 'kds' && <KdsScreen />}
        {view.name === 'qr' && <QrMenuScreen />}
        {view.name === 'delivery' && <DeliveryScreen />}
        {view.name === 'backoffice' && (isManagerRole(user.role) || user.role === 'CASHIER' ? <BackOffice /> : <p className="p-6">Acesso restrito.</p>)}
      </main>

      {nav.length > 1 && (
        <nav className="fixed inset-x-0 bottom-0 z-20 grid border-t border-slate-800 bg-base sm:hidden" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
          {nav.map((n) => (
            <button key={n.key} onClick={() => setView({ name: n.key } as View)} className={`flex min-h-[64px] flex-col items-center justify-center gap-1 text-xs font-bold ${activeKey === n.key ? 'text-ouro' : 'text-slate-400'}`}>
              <n.icon className="h-6 w-6" /> {n.label}
            </button>
          ))}
        </nav>
      )}

      <SmartPosSimulator />
      <PrintSimulatorModal />
      <ToastHost />
    </div>
  );
}
