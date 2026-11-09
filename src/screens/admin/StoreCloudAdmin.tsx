/** Etapa 0 — Loja (dados, permissões, loja nova) e Nuvem (login do aparelho e envio da fila). */
import { useState } from 'react';
import { Cloud, CloudOff, RefreshCw, Store } from 'lucide-react';
import { selectCan, selectCurrentUser, useTcheStore, type CloudSession, type TenantDraft } from '../../store/useTcheStore';
import type { Permission, UserRole } from '../../types';
import { CONFIGURABLE_ROLES, PERMISSIONS, PERMISSION_LABEL, can } from '../../lib/permissions';
import { ROLE_LABEL } from '../../lib/catalog';
import { signInDevice } from '../../lib/sync/supabaseSync';
import { defaultCloudConfig, syncOnce } from '../../lib/sync/useCloudSync';
import { useOnline } from '../../lib/useOnline';
import { Btn, Sheet, toast } from '../../components/ui';
import { ManagerAuthSheet } from '../../components/ManagerAuthSheet';
import { Field, FormError, Panel, TextInput, parseMoneyInput } from './fields';

// ---------------------------------------------------------------------------
// LOJA
// ---------------------------------------------------------------------------
export function StoreAdmin() {
  const canSettings = useTcheStore((s) => selectCan(s, 'STORE_SETTINGS'));
  const me = useTcheStore(selectCurrentUser);
  return (
    <div className="space-y-3">
      {canSettings && <TenantForm />}
      {me?.role === 'OWNER' && <PermissionsMatrix />}
      {me?.role === 'OWNER' && <NewStorePanel />}
    </div>
  );
}

interface TenantFormState {
  name: string;
  legal_name: string;
  cnpj: string;
  state_registration: string;
  city: string;
  state: string;
  fee: string;
}

function tenantToForm(t: { name: string; legal_name: string; cnpj: string; state_registration: string | null; city: string; state: string; default_service_fee_pct: number }): TenantFormState {
  return {
    name: t.name,
    legal_name: t.legal_name,
    cnpj: t.cnpj,
    state_registration: t.state_registration ?? '',
    city: t.city,
    state: t.state,
    fee: String(t.default_service_fee_pct).replace('.', ','),
  };
}

function formToDraft(f: TenantFormState): TenantDraft | string {
  const fee = parseMoneyInput(f.fee);
  if (Number.isNaN(fee)) return 'Taxa de serviço inválida. Ex.: 10 ou 12,5.';
  return {
    name: f.name,
    legal_name: f.legal_name,
    cnpj: f.cnpj.replace(/\D/g, ''),
    state_registration: f.state_registration.trim() || null,
    city: f.city,
    state: f.state.toUpperCase(),
    default_service_fee_pct: fee,
  };
}

function TenantFields({ f, set }: { f: TenantFormState; set: (f: TenantFormState) => void }) {
  const up = (k: keyof TenantFormState, v: string) => set({ ...f, [k]: v });
  return (
    <div className="grid gap-x-3 sm:grid-cols-2">
      <Field label="Nome fantasia"><TextInput value={f.name} maxLength={255} onChange={(e) => up('name', e.target.value)} /></Field>
      <Field label="Razão social"><TextInput value={f.legal_name} maxLength={255} onChange={(e) => up('legal_name', e.target.value)} /></Field>
      <Field label="CNPJ" hint="Só números; o dígito verificador é conferido."><TextInput inputMode="numeric" value={f.cnpj} maxLength={18} onChange={(e) => up('cnpj', e.target.value)} /></Field>
      <Field label="Inscrição estadual"><TextInput value={f.state_registration} maxLength={20} onChange={(e) => up('state_registration', e.target.value)} /></Field>
      <Field label="Cidade"><TextInput value={f.city} maxLength={100} onChange={(e) => up('city', e.target.value)} /></Field>
      <Field label="UF"><TextInput value={f.state} maxLength={2} onChange={(e) => up('state', e.target.value.toUpperCase())} /></Field>
      <Field label="Taxa de serviço padrão (%)" hint="Vale para contas abertas daqui em diante."><TextInput inputMode="decimal" value={f.fee} onChange={(e) => up('fee', e.target.value)} /></Field>
    </div>
  );
}

function TenantForm() {
  const tenant = useTcheStore((s) => s.tenant);
  const update = useTcheStore((s) => s.updateTenant);
  const [f, setF] = useState<TenantFormState>(() => tenantToForm(tenant));
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const d = formToDraft(f);
    if (typeof d === 'string') return setError(d);
    const r = update(d);
    if (!r.ok) return setError(r.error);
    setError(null);
    setF(tenantToForm(r.data));
    toast.success('Dados da loja salvos.');
  };
  return (
    <Panel title={<span className="flex items-center gap-2"><Store className="h-4 w-4" /> Dados da loja</span>} action={<Btn onClick={submit}>Salvar</Btn>}>
      <FormError error={error} />
      <TenantFields f={f} set={setF} />
      <p className="text-xs text-slate-500">Token da Focus NFe e CSC ficam só no servidor e não são editados por este aparelho.</p>
    </Panel>
  );
}

function PermissionsMatrix() {
  const overrides = useTcheStore((s) => s.rolePermissions);
  const setPermission = useTcheStore((s) => s.setRolePermission);
  const [pending, setPending] = useState<{ role: UserRole; permission: Permission; allowed: boolean } | null>(null);
  return (
    <Panel title="Permissões por perfil">
      <p className="mb-3 text-xs text-slate-400">O proprietário sempre pode tudo. Cada mudança pede o seu PIN e motivo e fica na auditoria.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="p-2">Permissão</th>
              {CONFIGURABLE_ROLES.map((r) => <th key={r} className="p-2 text-center">{ROLE_LABEL[r]}</th>)}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p} className="border-t border-slate-700">
                <td className="p-2">{PERMISSION_LABEL[p]}</td>
                {CONFIGURABLE_ROLES.map((r) => {
                  const on = can(r, p, overrides);
                  return (
                    <td key={r} className="p-2 text-center">
                      <button
                        aria-label={`${PERMISSION_LABEL[p]} para ${ROLE_LABEL[r]}: ${on ? 'permitido' : 'bloqueado'}`}
                        onClick={() => setPending({ role: r, permission: p, allowed: !on })}
                        className={`h-11 w-16 rounded-lg text-xs font-bold ${on ? 'bg-stone text-slate-950' : 'bg-slate-700 text-slate-400'}`}
                      >
                        {on ? 'Sim' : 'Não'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ManagerAuthSheet
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Mudar permissão"
        summary={pending && <><b>{ROLE_LABEL[pending.role]}</b> {pending.allowed ? 'passa a poder' : 'deixa de poder'}: {PERMISSION_LABEL[pending.permission]}.</>}
        confirmLabel="Confirmar com meu PIN"
        quickReasons={['Mudança de função na equipe', 'Ajuste de segurança', 'Cobertura de turno']}
        successMessage="Permissão alterada e registrada na auditoria."
        onSubmit={(managerPin, reason) => (pending ? setPermission(pending.role, pending.permission, pending.allowed, { managerPin, reason }) : { ok: false, error: 'Nada para alterar.' })}
        onSuccess={() => setPending(null)}
      />
    </Panel>
  );
}

const EMPTY_TENANT: TenantFormState = { name: '', legal_name: '', cnpj: '', state_registration: '', city: '', state: 'RS', fee: '10' };

/**
 * Tira o aparelho da demonstração (ou troca de loja): apaga cardápio, mesas,
 * equipe e histórico DESTE aparelho e começa com o proprietário informado.
 * Recusado com conta aberta ou fila sem enviar para a nuvem.
 */
function NewStorePanel({ cloud, onDone }: { cloud?: CloudSession; onDone?: () => void }) {
  const start = useTcheStore((s) => s.startNewStore);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<TenantFormState>(EMPTY_TENANT);
  const [ownerName, setOwnerName] = useState('');
  const [ownerPin, setOwnerPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState(false);
  const [draft, setDraft] = useState<TenantDraft | null>(null);

  const next = () => {
    const d = formToDraft(f);
    if (typeof d === 'string') return setError(d);
    if (ownerName.trim().length < 2) return setError('Informe o nome do proprietário.');
    if (!/^\d{4}$/.test(ownerPin)) return setError('PIN do proprietário: 4 dígitos.');
    setError(null);
    setDraft(d);
    setAuth(true);
  };

  return (
    <Panel title={cloud ? 'Começar a loja desta conta' : 'Iniciar loja nova neste aparelho'} action={<Btn variant="danger" onClick={() => setOpen(true)}>{cloud ? 'Começar' : 'Iniciar loja nova'}</Btn>}>
      <p className="text-sm text-slate-400">
        Apaga deste aparelho o cardápio, as mesas, a equipe e o histórico de demonstração, e começa a loja do zero com você como proprietário. Contas abertas impedem. {cloud ? 'A loja fica ligada à conta da nuvem que você acabou de entrar.' : ''}
      </p>
      <Sheet open={open && !auth} onClose={() => setOpen(false)} wide title="Dados da loja nova" footer={<Btn block size="lg" variant="primary" onClick={next}>Continuar</Btn>}>
        <FormError error={error} />
        <TenantFields f={f} set={setF} />
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Field label="Nome do proprietário"><TextInput value={ownerName} maxLength={100} onChange={(e) => setOwnerName(e.target.value)} /></Field>
          <Field label="PIN do proprietário (novo)" hint="4 dígitos; é com ele que você entra depois."><TextInput type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={ownerPin} onChange={(e) => setOwnerPin(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
      </Sheet>
      <ManagerAuthSheet
        open={auth}
        onClose={() => setAuth(false)}
        title="Apagar dados deste aparelho"
        summary={<>Tudo que está neste aparelho será substituído pela loja <b>{draft?.name}</b>. Confirme com o PIN <b>atual</b> do proprietário.</>}
        confirmLabel="Apagar e iniciar loja"
        quickReasons={['Sair da demonstração', 'Aparelho trocado de loja']}
        successMessage="Loja nova iniciada. Entre com o seu novo PIN quando sair."
        onSubmit={(managerPin, reason) => (draft ? start({ tenant: draft, owner_name: ownerName, owner_pin: ownerPin, cloud }, { managerPin, reason }) : { ok: false, error: 'Preencha os dados da loja.' })}
        onSuccess={() => {
          setOpen(false);
          onDone?.();
        }}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// NUVEM
// ---------------------------------------------------------------------------
export function CloudAdmin() {
  const cloud = useTcheStore((s) => s.cloud);
  return cloud ? <CloudStatus /> : <CloudLogin />;
}

function CloudLogin() {
  const env = defaultCloudConfig();
  const tenantId = useTcheStore((s) => s.tenant.id);
  const isOwner = useTcheStore((s) => selectCurrentUser(s)?.role === 'OWNER');
  const setCloud = useTcheStore((s) => s.setCloudSession);
  const online = useOnline();
  const [url, setUrl] = useState(env.url);
  const [anonKey, setAnonKey] = useState(env.anonKey);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherStore, setOtherStore] = useState<CloudSession | null>(null);

  const login = async () => {
    setError(null);
    setOtherStore(null);
    if (!/^https:\/\//.test(url.trim())) return setError('Endereço do projeto Supabase deve começar com https://');
    if (!anonKey.trim()) return setError('Informe a chave pública (anon key) do projeto.');
    setBusy(true);
    try {
      const t = await signInDevice(url.trim(), anonKey.trim(), email.trim(), password, (u, init) => fetch(u, init));
      const session: CloudSession = { url: url.trim(), anon_key: anonKey.trim(), email: email.trim(), ...t };
      if (session.tenant_id !== tenantId) {
        setOtherStore(session);
        return;
      }
      const r = setCloud(session);
      if (!r.ok) return setError(r.error);
      setPassword('');
      toast.success('Aparelho conectado à nuvem. A fila começa a subir agora.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Panel title={<span className="flex items-center gap-2"><CloudOff className="h-4 w-4" /> Conectar este aparelho à nuvem</span>}>
        <p className="mb-3 text-sm text-slate-400">Use a conta do aparelho criada no Supabase da loja (e-mail e senha). Sem conexão, tudo continua funcionando offline e a fila espera.</p>
        <FormError error={error} />
        <Field label="Endereço do projeto" hint={env.url ? 'Preenchido pelo build (.env).' : 'Ex.: https://xxxx.supabase.co'}><TextInput value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="Chave pública (anon key)"><TextInput value={anonKey} onChange={(e) => setAnonKey(e.target.value)} /></Field>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Field label="E-mail do aparelho"><TextInput type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Senha"><TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        </div>
        <Btn block disabled={busy || !online || !email || !password} onClick={() => void login()}>
          {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />} {online ? 'Entrar' : 'Sem internet'}
        </Btn>
      </Panel>
      {otherStore && (
        <div className="space-y-3 rounded-2xl border border-ouro p-3">
          <p className="text-sm text-ouro">Esta conta é de outra loja (id {otherStore.tenant_id.slice(0, 8)}…). Os dados deste aparelho são de {useTcheStore.getState().tenant.name}. Para usar esta conta, comece a loja dela neste aparelho.</p>
          {isOwner ? <NewStorePanel cloud={otherStore} onDone={() => setOtherStore(null)} /> : <p className="text-sm text-slate-400">Peça ao proprietário para fazer isso.</p>}
        </div>
      )}
    </div>
  );
}

function CloudStatus() {
  const cloud = useTcheStore((s) => s.cloud)!;
  const status = useTcheStore((s) => s.syncStatus);
  const outbox = useTcheStore((s) => s.outbox);
  const setCloud = useTcheStore((s) => s.setCloudSession);
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const rejected = useTcheStore((s) => s.syncRejected) ?? [];
  const retryRejected = useTcheStore((s) => s.retryRejectedSync);
  const byTable = outbox.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.table]: (acc[e.table] ?? 0) + 1 }), {});
  const now = async () => {
    setBusy(true);
    try {
      await syncOnce();
      const st = useTcheStore.getState();
      if (st.syncStatus.last_error) toast.error(st.syncStatus.last_error);
      else toast.success(st.outbox.length === 0 ? 'Tudo enviado para a nuvem.' : `${st.outbox.length} evento(s) ainda na fila.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title={<span className="flex items-center gap-2"><Cloud className="h-4 w-4 text-stone" /> Nuvem conectada</span>}
      action={<Btn disabled={busy || !online} onClick={() => void now()}>{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sincronizar agora</Btn>}
    >
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-400">Conta</dt><dd>{cloud.email}</dd>
        <dt className="text-slate-400">Projeto</dt><dd className="break-all">{cloud.url}</dd>
        <dt className="text-slate-400">Fila</dt><dd>{outbox.length} evento(s){outbox.length > 0 && ` · ${Object.entries(byTable).map(([t, n]) => `${t} ${n}`).join(', ')}`}</dd>
        <dt className="text-slate-400">Último envio</dt><dd>{status.last_success_at ? new Date(status.last_success_at).toLocaleString('pt-BR') : 'ainda não'}</dd>
        {!online && (<><dt className="text-slate-400">Conexão</dt><dd className="text-ouro">Sem internet: a fila espera e sobe sozinha quando voltar.</dd></>)}
      </dl>
      {status.last_error && (
        <div className="mb-3 rounded-xl border border-brasa/60 bg-brasa/10 p-3 text-sm">
          <div className="font-bold text-rose-200">{status.last_error}</div>
          {status.last_error_at && <div className="text-xs text-slate-400">{new Date(status.last_error_at).toLocaleString('pt-BR')}</div>}
        </div>
      )}
      {rejected.length > 0 && (
        <div className="mb-3 rounded-xl border border-ouro/60 bg-ouro/10 p-3 text-sm">
          <div className="mb-2 font-bold text-ouro">{rejected.length} evento(s) recusado(s) pela nuvem</div>
          <p className="mb-2 text-xs text-slate-300">
            Eles saíram da fila para não travar o resto do envio. Nada foi descartado. Corrija a causa no servidor (permissão, PIN do gerente ou trava) e toque em Reenviar recusados.
          </p>
          <ul className="mb-2 max-h-48 space-y-1 overflow-y-auto text-xs">
            {rejected.map((r) => (
              <li key={r.event.id} className="text-slate-300">
                <b>{r.event.table}</b> {r.event.op} (registro {r.event.row_id.slice(0, 8)}…) · HTTP {r.status}: {r.message}
              </li>
            ))}
          </ul>
          <Btn disabled={!online} onClick={() => { retryRejected(); void syncOnce(); }}>
            <RefreshCw className="h-4 w-4" /> Reenviar recusados
          </Btn>
        </div>
      )}
      <Btn
        variant="danger"
        onClick={() => {
          const msg = outbox.length > 0 ? `Ainda há ${outbox.length} evento(s) sem enviar. Eles ficam guardados aqui e sobem quando você conectar de novo. Desconectar?` : 'Desconectar este aparelho da nuvem?';
          if (window.confirm(msg)) setCloud(null);
        }}
      >
        Desconectar
      </Btn>
    </Panel>
  );
}
