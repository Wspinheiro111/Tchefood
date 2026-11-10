import { useEffect, useState } from 'react';
import { BarChart3, Beer, Bike, ChefHat, CloudOff, LayoutGrid, LogOut, MonitorPlay, QrCode as QrIcon, RefreshCw, ShoppingBag, Smartphone, Ticket, Wallet } from 'lucide-react';
import { BrandLogo, BrandMark } from './components/Brand';
import { selectCurrentUser, useTcheStore } from './store/useTcheStore';
import { useOnline } from './lib/useOnline';
import { useTerminalBus } from './lib/payments/drivers';
import { LoginScreen } from './screens/LoginScreen';
import { TableMap } from './screens/TableMap';
import { OrderScreen } from './screens/OrderScreen';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { KdsScreen } from './screens/KdsScreen';
import { QrMenuScreen } from './screens/QrMenuScreen';
import { BackOffice, useBackOfficeTabs } from './screens/BackOffice';
import { FichaRapidaScreen } from './screens/FichaRapidaScreen';
import { KegMonitorScreen } from './screens/KegMonitorScreen';
import { DeliveryScreen } from './screens/DeliveryScreen';
import { OrderBoardScreen } from './screens/OrderBoardScreen';
import { KioskScreen } from './screens/KioskScreen';
import { PickupCounterScreen } from './screens/PickupCounterScreen';
import { CashRegisterScreen } from './screens/CashRegisterScreen';
import { useCloudSync } from './lib/sync/useCloudSync';
import { SmartPosSimulator } from './components/SmartPosSimulator';
import { PrintSimulatorModal } from './components/PrintSimulator';
import { ToastHost, toast } from './components/ui';
import type { UserRole } from './types';

type View =
  | { name: 'map' }
  | { name: 'order'; orderId: string }
  | { name: 'checkout'; orderId: string }
  | { name: 'kds' }
  | { name: 'qr' }
  | { name: 'pickup' }
  | { name: 'ficha' }
  | { name: 'chopp' }
  | { name: 'delivery' }
  | { name: 'board' }
  | { name: 'caixa' }
  | { name: 'backoffice' };

type NavKey = 'map' | 'kds' | 'caixa' | 'pickup' | 'ficha' | 'chopp' | 'qr' | 'delivery' | 'board' | 'backoffice';

const NAV: Array<{ key: NavKey; label: string; icon: typeof LayoutGrid; roles: UserRole[] }> = [
  { key: 'map', label: 'Mesas', icon: LayoutGrid, roles: ['WAITER', 'MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'kds', label: 'KDS', icon: ChefHat, roles: ['KITCHEN', 'MANAGER', 'OWNER'] },
  { key: 'caixa', label: 'Caixa', icon: Wallet, roles: ['CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'pickup', label: 'Pedido no Caixa', icon: ShoppingBag, roles: ['CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'ficha', label: 'Ficha Rápida', icon: Ticket, roles: ['WAITER', 'CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'chopp', label: 'Chopp', icon: Beer, roles: ['KITCHEN', 'CASHIER', 'MANAGER', 'OWNER'] },
  { key: 'qr', label: 'QR Cliente', icon: QrIcon, roles: ['WAITER', 'MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'delivery', label: 'Delivery', icon: Bike, roles: ['MANAGER', 'OWNER', 'CASHIER'] },
  { key: 'board', label: 'Painel TV', icon: MonitorPlay, roles: ['MANAGER', 'OWNER', 'CASHIER', 'KITCHEN'] },
  // Retaguarda: aparece para quem tem ao menos uma aba liberada (perfil ou permissão).
  { key: 'backoffice', label: 'Retaguarda', icon: BarChart3, roles: [] },
];

export default function App() {
  const hydrated = useTcheStore((s) => s.hydrated);
  const user = useTcheStore(selectCurrentUser);
  const logout = useTcheStore((s) => s.logout);
  const outbox = useTcheStore((s) => s.outbox.length);
  const online = useOnline();
  const [view, setView] = useState<View>({ name: 'map' });
  const backOfficeTabs = useBackOfficeTabs();
  // Etapa 0: envia a fila para o Supabase quando há internet e o aparelho está conectado.
  useCloudSync(online);

  // Perfil Cozinha entra direto no KDS.
  useEffect(() => {
    if (user?.role === 'KITCHEN') setView({ name: 'kds' });
    else if (user) setView({ name: 'map' });
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hydrated) {
    return (
      <div className="grid h-full place-items-center">
        <RefreshCw className="h-8 w-8 animate-spin text-brasa" />
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

  // Aparelho do totem: só a tela do cliente, sem menu da equipe (sair exige PIN de gerente).
  if (user.role === 'KIOSK') {
    return (
      <>
        <KioskScreen />
        <SmartPosSimulator />
        <ToastHost />
      </>
    );
  }

  const nav = NAV.filter((n) => (n.key === 'backoffice' ? backOfficeTabs.length > 0 : n.roles.includes(user.role)));
  const activeKey: NavKey = view.name === 'order' || view.name === 'checkout' ? 'map' : view.name;

  return (
    <div className="min-h-full pb-[72px] sm:pb-0">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-200 bg-base/95 px-3 shadow-sm backdrop-blur">
        {/* Faixa com as três cores da marca no topo de todas as telas da equipe */}
        <div aria-hidden className="absolute inset-x-0 top-0 flex h-1"><span className="flex-1 bg-brasa" /><span className="flex-1 bg-amarelo" /><span className="flex-1 bg-verde" /></div>
        <BrandMark className="h-9 w-9 2xl:hidden" />
        <BrandLogo className="hidden h-11 w-auto 2xl:block" />
        <div className="mr-auto leading-tight">
          <div className="font-black 2xl:hidden">Tchê<span className="text-brasa">Food</span></div>
          <div className="text-[11px] text-slate-500">{user.name} · {user.role === 'WAITER' ? 'Garçom' : user.role === 'MANAGER' ? 'Gerente' : user.role === 'OWNER' ? 'Proprietário' : user.role === 'KITCHEN' ? 'Cozinha' : 'Caixa'}</div>
        </div>
        <nav className="hidden gap-1 sm:flex">
          {nav.map((n) => (
            <button key={n.key} onClick={() => setView({ name: n.key } as View)} className={`flex min-h-touch items-center gap-2 rounded-xl px-3 text-sm font-bold ${activeKey === n.key ? 'bg-brasa text-white shadow' : 'text-slate-700 hover:bg-slate-100'}`}>
              <n.icon className="h-4 w-4" /> {n.label}
            </button>
          ))}
        </nav>
        <button aria-label="Abrir maquininha" onClick={() => useTerminalBus.getState().openSimulator()} className="grid h-11 w-11 place-items-center rounded-xl bg-surface text-verde" title="Maquininha / bobina">
          <Smartphone className="h-5 w-5" />
        </button>
        <span title={online ? `${outbox} evento(s) na fila de sincronização` : 'Offline: operando pela fila local'} className={`hidden items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold md:inline-flex ${online ? 'bg-stone/15 text-verde' : 'bg-ouro/20 text-brasa'}`}>
          {online ? '●' : <CloudOff className="h-3 w-3" />} {online ? 'Online' : 'Offline'} · fila {outbox}
        </span>
        <button aria-label="Sair" onClick={() => { const r = logout(); if (!r.ok) toast.error(r.error); }}className="grid h-11 w-11 place-items-center rounded-xl bg-surface"><LogOut className="h-5 w-5" /></button>
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
        {view.name === 'caixa' && <CashRegisterScreen />}
        {view.name === 'pickup' && <PickupCounterScreen />}
        {view.name === 'ficha' && <FichaRapidaScreen />}
        {view.name === 'chopp' && <KegMonitorScreen />}
        {view.name === 'delivery' && <DeliveryScreen />}
        {view.name === 'board' && <OrderBoardScreen />}
        {view.name === 'backoffice' && <BackOffice onExit={(name) => setView({ name } as View)} />}
      </main>

      {nav.length > 1 && (
        <nav className="fixed inset-x-0 bottom-0 z-20 grid border-t border-slate-200 bg-base sm:hidden" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
          {nav.map((n) => (
            <button key={n.key} onClick={() => setView({ name: n.key } as View)} className={`flex min-h-[64px] flex-col items-center justify-center gap-1 text-xs font-bold ${activeKey === n.key ? 'text-brasa' : 'text-slate-500'}`}>
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
