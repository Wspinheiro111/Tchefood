import { useEffect, useMemo, useState } from 'react';
import { LogOut } from 'lucide-react';
import iconUrl from './assets/icon.png';
import type { AdminClient, AdminConfig, Me, Session } from './lib/api';
import { loadConfig, loadSession, saveSession, sessionClient } from './lib/session';
import Login from './components/Login';
import Overview from './components/Overview';
import Stores from './components/Stores';
import StoreDetail from './components/StoreDetail';
import Charges from './components/Charges';
import { useLoad, Erro } from './components/ui';

type Aba = 'visao' | 'lojas' | 'cobrancas';

export default function App() {
  const [cfg, setCfg] = useState<AdminConfig>(loadConfig);
  const [session, setSession] = useState<Session | null>(loadSession);

  const client = useMemo(() => (session ? sessionClient(cfg, session, () => setSession(null)) : null), [cfg, session]);
  // Cliente trocado ou descartado: a renovação que ainda estiver no ar não grava a sessão.
  useEffect(() => () => client?.dispose(), [client]);

  if (!session || !client) {
    return (
      <Login
        cfg={cfg}
        onLogin={(c, s) => {
          setCfg(c);
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  return (
    <Painel
      client={client}
      email={session.email}
      onLogout={() => {
        // Sai no servidor (revoga o refresh token) sem esperar: se falhar, sai da tela mesmo assim.
        void client.logout();
        setSession(null);
      }}
    />
  );
}

function Painel({ client, email, onLogout }: { client: AdminClient; email: string; onLogout: () => void }) {
  const [aba, setAba] = useState<Aba>('visao');
  const [loja, setLoja] = useState<string | null>(null);
  const me = useLoad<Me>(() => client.me(), [client]);
  // A data de hoje vem do servidor (fuso de São Paulo): relê a cada troca de tela, ao voltar
  // para a aba e a cada 5 minutos, para o painel aberto de um dia para o outro não usar a de ontem.
  const reloadMe = me.reload;
  useEffect(() => {
    reloadMe();
  }, [aba, loja]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && reloadMe();
    const timer = window.setInterval(reloadMe, 5 * 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const abrirLoja = (id: string) => {
    setLoja(id);
    setAba('lojas');
  };

  return (
    <div className="min-h-screen bg-fundo">
      <header className="border-b border-borda bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="inline-flex items-center gap-2">
            <img src={iconUrl} alt="" className="h-8 w-8 object-contain" />
            <span className="text-lg font-extrabold">
              <span className="text-verde">Tchê</span>
              <span className="text-brasa">Food</span>
              <span className="ml-2 text-sm font-semibold text-slate-500">Painel</span>
            </span>
          </span>
          <nav className="flex gap-1" aria-label="Seções">
            {(
              [
                ['visao', 'Visão geral'],
                ['lojas', 'Lojas'],
                ['cobrancas', 'Cobranças do dia'],
              ] as const
            ).map(([id, nome]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setAba(id);
                  setLoja(null);
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${aba === id ? 'bg-brasa text-white' : 'text-slate-700 hover:bg-surface'}`}
              >
                {nome}
              </button>
            ))}
          </nav>
          <span className="ml-auto hidden text-sm text-slate-600 sm:inline">{me.data?.name ?? email}</span>
          <button type="button" className="btn-secundario" onClick={onLogout}>
            <LogOut className="h-4 w-4" /> Sair
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        {me.error && !me.data ? (
          <Erro>{me.error} Esta conta não é da equipe do Tchê Food (ou o painel ainda não foi instalado no banco).</Erro>
        ) : !me.data ? (
          <p className="text-sm text-slate-500">Carregando…</p>
        ) : aba === 'visao' ? (
          <Overview client={client} today={me.data.today} irPara={setAba} />
        ) : aba === 'cobrancas' ? (
          <Charges client={client} today={me.data.today} onOpenStore={abrirLoja} />
        ) : loja ? (
          <StoreDetail client={client} tenantId={loja} today={me.data.today} onBack={() => setLoja(null)} />
        ) : (
          <Stores client={client} today={me.data.today} onOpenStore={setLoja} />
        )}
      </main>
    </div>
  );
}
