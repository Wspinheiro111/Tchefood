import { useState, type FormEvent } from 'react';
import iconUrl from '../assets/icon.png';
import { normalizeUrl, signIn, type AdminConfig, type Session } from '../lib/api';
import { browserFetch, saveConfig } from '../lib/session';
import { Campo, Erro, errorText } from './ui';

export default function Login({ cfg, onLogin }: { cfg: AdminConfig; onLogin: (cfg: AdminConfig, s: Session) => void }) {
  const [url, setUrl] = useState(cfg.url);
  const [anonKey, setAnonKey] = useState(cfg.anonKey);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [mostrarNuvem, setMostrarNuvem] = useState(!cfg.url || !cfg.anonKey);

  async function entrar(ev: FormEvent) {
    ev.preventDefault();
    setErro(null);
    const c = { url: normalizeUrl(url), anonKey: anonKey.trim() };
    if (!/^https:\/\//.test(c.url) || !c.anonKey) {
      setMostrarNuvem(true);
      setErro('Informe o endereço (https://…supabase.co) e a chave pública (anon) do Supabase.');
      return;
    }
    setEnviando(true);
    try {
      const s = await signIn(c, email, password, browserFetch);
      saveConfig(c);
      onLogin(c, s);
    } catch (e) {
      setErro(errorText(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <form onSubmit={entrar} className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2">
          <img src={iconUrl} alt="" className="h-10 w-10 object-contain" />
          <div>
            <p className="text-lg font-extrabold">
              <span className="text-verde">Tchê</span>
              <span className="text-brasa">Food</span>
            </p>
            <p className="text-xs text-slate-500">Painel da equipe: lojas e mensalidades</p>
          </div>
        </div>
        <Campo rotulo="E-mail">
          <input className="campo" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Campo>
        <Campo rotulo="Senha">
          <input className="campo" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Campo>
        {mostrarNuvem ? (
          <div className="space-y-3 rounded-lg border border-borda p-3">
            <Campo rotulo="Endereço do Supabase">
              <input className="campo" placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Campo>
            <Campo rotulo="Chave pública (anon)">
              <input className="campo" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} />
            </Campo>
          </div>
        ) : (
          <button type="button" className="text-xs text-slate-500 underline" onClick={() => setMostrarNuvem(true)}>
            Trocar o projeto do Supabase
          </button>
        )}
        <Erro>{erro}</Erro>
        <button type="submit" className="btn-primario w-full" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
        <p className="text-xs text-slate-500">Só a equipe do Tchê Food entra aqui. A conta de aparelho de uma loja não abre o painel.</p>
      </form>
    </div>
  );
}
