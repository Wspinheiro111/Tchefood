/** Etapa 0 — Loja (dados, permissões, loja nova) e Nuvem (login do aparelho e envio da fila). */
import { useEffect, useState } from 'react';
import { Cloud, CloudDownload, CloudOff, RefreshCw, Store, Users } from 'lucide-react';
import { selectCan, selectCurrentUser, useTcheStore, type CloudSession, type TenantDraft } from '../../store/useTcheStore';
import type { Permission, SyncEvent, UserRole } from '../../types';
import { CONFIGURABLE_ROLES, PERMISSIONS, PERMISSION_LABEL, can } from '../../lib/permissions';
import { ROLE_LABEL } from '../../lib/catalog';
import { signInDevice, type SyncConfig } from '../../lib/sync/supabaseSync';
import { cloudDiscountOf } from '../../lib/sync/cloudDiscount';
import { fetchCloudSnapshot, fetchCloudStaff, fetchStaffPins, type CloudStaff } from '../../lib/sync/cloudPull';
import { defaultCloudConfig, syncOnce } from '../../lib/sync/useCloudSync';
import { useOnline } from '../../lib/useOnline';
import { Btn, Sheet, toast } from '../../components/ui';
import { ManagerAuthSheet } from '../../components/ManagerAuthSheet';
import { Field, FormError, Panel, Select, TextInput, parseMoneyInput } from './fields';

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
      <p className="mb-3 text-xs text-slate-500">O proprietário sempre pode tudo. Cada mudança pede o seu PIN e motivo e fica na auditoria.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="p-2">Permissão</th>
              {CONFIGURABLE_ROLES.map((r) => <th key={r} className="p-2 text-center">{ROLE_LABEL[r]}</th>)}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p} className="border-t border-slate-200">
                <td className="p-2">{PERMISSION_LABEL[p]}</td>
                {CONFIGURABLE_ROLES.map((r) => {
                  const on = can(r, p, overrides);
                  return (
                    <td key={r} className="p-2 text-center">
                      <button
                        aria-label={`${PERMISSION_LABEL[p]} para ${ROLE_LABEL[r]}: ${on ? 'permitido' : 'bloqueado'}`}
                        onClick={() => setPending({ role: r, permission: p, allowed: !on })}
                        className={`h-11 w-16 rounded-lg text-xs font-bold ${on ? 'bg-stone text-white' : 'bg-slate-200 text-slate-500'}`}
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
      <p className="text-sm text-slate-500">
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
        <p className="mb-3 text-sm text-slate-500">Use a conta do aparelho criada no Supabase da loja (e-mail e senha). Sem conexão, tudo continua funcionando offline e a fila espera.</p>
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
      {otherStore && <OtherStoreChoice session={otherStore} isOwner={isOwner} onDone={() => setOtherStore(null)} />}
    </div>
  );
}

function cloudConfig(session: CloudSession): SyncConfig {
  return { url: session.url, anonKey: session.anon_key, accessToken: session.access_token };
}

const browserFetch = (u: string, init: { method: string; headers: Record<string, string>; body?: string }) => fetch(u, init);

/**
 * Conta de outra loja: se a loja da nuvem já tem equipe, este aparelho baixa a loja
 * (aparelho novo); se ainda não tem, começa a loja dela do zero.
 */
function OtherStoreChoice({ session, isOwner, onDone }: { session: CloudSession; isOwner: boolean; onDone: () => void }) {
  const [team, setTeam] = useState<CloudStaff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchCloudStaff(cloudConfig(session), browserFetch)
      .then((t) => live && setTeam(t))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [session]);
  return (
    <div className="space-y-3 rounded-2xl border border-ouro p-3">
      <p className="text-sm text-brasa">Esta conta é de outra loja (id {session.tenant_id.slice(0, 8)}…). Os dados deste aparelho são de {useTcheStore.getState().tenant.name}.</p>
      <FormError error={error} />
      {!isOwner ? (
        <p className="text-sm text-slate-500">Peça ao proprietário deste aparelho para fazer isso.</p>
      ) : team === null ? (
        !error && <p className="flex items-center gap-2 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" /> Lendo a loja na nuvem…</p>
      ) : team.length > 0 ? (
        <JoinStorePanel session={session} team={team} onDone={onDone} />
      ) : (
        <NewStorePanel cloud={session} onDone={onDone} />
      )}
    </div>
  );
}

/** Aparelho novo de uma loja que já está na nuvem: baixa os cadastros e a equipe. */
function JoinStorePanel({ session, team, onDone }: { session: CloudSession; team: CloudStaff[]; onDone: () => void }) {
  const join = useTcheStore((s) => s.joinCloudStore);
  const managers = team.filter((u) => u.active && (u.role === 'MANAGER' || u.role === 'OWNER'));
  const [who, setWho] = useState(managers[0]?.id ?? '');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const cfg = cloudConfig(session);
      const pins = await fetchStaffPins(cfg, who, pin, browserFetch);
      if (!pins.ok) return setError(pins.error);
      const snapshot = await fetchCloudSnapshot(cfg, session.tenant_id, browserFetch);
      const r = join({ session, snapshot, staff: pins.staff, userId: who });
      if (!r.ok) return setError(r.error);
      toast.success(`Loja ${r.data.name} baixada. Cada pessoa entra com o PIN dela.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPin('');
      setBusy(false);
    }
  };

  return (
    <Panel title={<span className="flex items-center gap-2"><CloudDownload className="h-4 w-4" /> Baixar a loja desta conta</span>}>
      <p className="mb-3 text-sm text-slate-500">
        A loja já tem equipe na nuvem. Este aparelho troca os dados dele (cardápio, mesas, equipe e histórico de demonstração) pelos cadastros da loja: cardápio, combos, mesas, equipe, maquininhas, permissões e fornecedores. Contas e pagamentos de outros aparelhos não vêm. Confirme com o PIN de um gerente ou do proprietário da loja.
      </p>
      <FormError error={error} />
      {managers.length === 0 ? (
        <p className="text-sm text-slate-500">A loja não tem gerente nem proprietário ativo na nuvem.</p>
      ) : (
        <>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Quem confirma">
              <Select value={who} onChange={setWho} options={managers.map((u) => ({ value: u.id, label: `${u.name} (${ROLE_LABEL[u.role]})` }))} />
            </Field>
            <Field label="PIN">
              <TextInput type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </Field>
          </div>
          <Btn block variant="danger" disabled={busy || pin.length !== 4 || !who} onClick={() => void run()}>
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />} Apagar este aparelho e baixar a loja
          </Btn>
        </>
      )}
    </Panel>
  );
}

/** Pessoa nova ou PIN trocado em outro aparelho: o gerente traz a equipe com os PINs. */
function RefreshStaffPanel() {
  const cloud = useTcheStore((s) => s.cloud)!;
  const unknown = useTcheStore((s) => s.pullStatus?.cloud_staff_unknown ?? 0);
  const staff = useTcheStore((s) => s.staff);
  const managers = staff.filter((u) => u.active && (u.role === 'MANAGER' || u.role === 'OWNER'));
  const applyStaff = useTcheStore((s) => s.applyCloudStaff);
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = who || managers[0]?.id || '';

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await fetchStaffPins(cloudConfig(useTcheStore.getState().cloud ?? cloud), chosen, pin, browserFetch);
      if (!r.ok) return setError(r.error);
      const applied = applyStaff(r.staff);
      if (!applied.ok) return setError(applied.error);
      toast.success(applied.data.added > 0 ? `Equipe atualizada: ${applied.data.added} pessoa(s) nova(s).` : 'Equipe atualizada.');
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPin('');
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 rounded-xl border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={unknown > 0 ? 'font-bold text-brasa' : 'text-slate-700'}>
          {unknown > 0 ? `${unknown} pessoa(s) nova(s) na equipe da nuvem ainda sem PIN neste aparelho.` : 'PIN trocado ou pessoa nova em outro aparelho? Atualize a equipe.'}
        </span>
        <Btn disabled={!online} onClick={() => setOpen((v) => !v)}><Users className="h-4 w-4" /> Atualizar equipe</Btn>
      </div>
      {open && (
        <div className="mt-3">
          <FormError error={error} />
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Gerente ou proprietário">
              <Select value={chosen} onChange={setWho} options={managers.map((u) => ({ value: u.id, label: u.name }))} />
            </Field>
            <Field label="PIN">
              <TextInput type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </Field>
          </div>
          <Btn block disabled={busy || pin.length !== 4 || !chosen} onClick={() => void run()}>
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />} Baixar equipe com os PINs
          </Btn>
        </div>
      )}
    </div>
  );
}

/** Autorização de gerente (ou troca de barril) recusada: fila antiga sem PIN, ou PIN que mudou antes de subir. */
function needsManagerPin(e: SyncEvent): boolean {
  if (e.table === 'keg_history') return e.keg_change != null;
  return e.table === 'audit_logs' && typeof e.payload.authorized_by_manager_id === 'string';
}

/** Conta recusada por ter outro desconto na nuvem: adota o da nuvem e reenvia. */
function AdoptCloudDiscount({ eventId, value }: { eventId: string; value: number }) {
  const adopt = useTcheStore((s) => s.adoptCloudDiscount);
  const online = useOnline();
  return (
    <div className="mt-1">
      <Btn
        disabled={!online}
        onClick={() => {
          const r = adopt(eventId);
          if (!r.ok) toast.error(r.error);
          else {
            toast.success(`Desconto da nuvem (R$ ${value.toFixed(2).replace('.', ',')}) aplicado nesta conta.`);
            void syncOnce();
          }
        }}
      >
        Usar o desconto da nuvem (R$ {value.toFixed(2).replace('.', ',')})
      </Btn>
    </div>
  );
}

function RejectedAuthPin({ eventId }: { eventId: string }) {
  const confirm = useTcheStore((s) => s.confirmRejectedAuthorization);
  const [pin, setPin] = useState('');
  return (
    <span className="mt-1 flex items-center gap-2">
      <input
        type="password"
        inputMode="numeric"
        maxLength={4}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        placeholder="PIN atual do gerente"
        className="w-28 rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-xs"
      />
      <Btn
        disabled={pin.length !== 4}
        onClick={() => {
          const r = confirm(eventId, pin);
          if (r.ok) toast.success('PIN conferido. Toque em Reenviar recusados.');
          else toast.error(r.error);
          setPin('');
        }}
      >
        Confirmar PIN
      </Btn>
    </span>
  );
}

function CloudStatus() {
  const cloud = useTcheStore((s) => s.cloud)!;
  const status = useTcheStore((s) => s.syncStatus);
  const pull = useTcheStore((s) => s.pullStatus);
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
      await syncOnce(undefined, { forcePull: true });
      const st = useTcheStore.getState();
      if (st.syncStatus.last_error) toast.error(st.syncStatus.last_error);
      else if (st.pullStatus?.last_error) toast.error(st.pullStatus.last_error);
      else toast.success(st.outbox.length === 0 ? 'Tudo enviado para a nuvem.' : `${st.outbox.length} evento(s) ainda na fila.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title={<span className="flex items-center gap-2"><Cloud className="h-4 w-4 text-verde" /> Nuvem conectada</span>}
      action={<Btn disabled={busy || !online} onClick={() => void now()}>{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sincronizar agora</Btn>}
    >
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Conta</dt><dd>{cloud.email}</dd>
        <dt className="text-slate-500">Projeto</dt><dd className="break-all">{cloud.url}</dd>
        <dt className="text-slate-500">Fila</dt><dd>{outbox.length} evento(s){outbox.length > 0 && ` · ${Object.entries(byTable).map(([t, n]) => `${t} ${n}`).join(', ')}`}</dd>
        <dt className="text-slate-500">Último envio</dt><dd>{status.last_success_at ? new Date(status.last_success_at).toLocaleString('pt-BR') : 'ainda não'}</dd>
        <dt className="text-slate-500">Cadastros da nuvem</dt><dd>{pull?.last_pull_at ? `lidos ${new Date(pull.last_pull_at).toLocaleString('pt-BR')}` : 'ainda não lidos'} <span className="text-xs text-slate-500">(a cada minuto, com a fila vazia)</span></dd>
        {!online && (<><dt className="text-slate-500">Conexão</dt><dd className="text-brasa">Sem internet: a fila espera e sobe sozinha quando voltar.</dd></>)}
      </dl>
      {status.last_error && (
        <div className="mb-3 rounded-xl border border-brasa/60 bg-brasa/10 p-3 text-sm">
          <div className="font-bold text-rose-700">{status.last_error}</div>
          {status.last_error_at && <div className="text-xs text-slate-500">{new Date(status.last_error_at).toLocaleString('pt-BR')}</div>}
        </div>
      )}
      {pull?.last_error && (
        <div className="mb-3 rounded-xl border border-ouro/60 bg-ouro/10 p-3 text-sm text-brasa">Leitura da nuvem: {pull.last_error}</div>
      )}
      <RefreshStaffPanel />
      {rejected.length > 0 && (
        <div className="mb-3 rounded-xl border border-ouro/60 bg-ouro/10 p-3 text-sm">
          <div className="mb-2 font-bold text-brasa">{rejected.length} evento(s) recusado(s) pela nuvem</div>
          <p className="mb-2 text-xs text-slate-700">
            Eles saíram da fila para não travar o resto do envio; as mudanças seguintes dos mesmos registros esperam na fila até o reenvio. Nada foi descartado. Corrija a causa no servidor (permissão, PIN do gerente ou trava) e toque em Reenviar recusados.
          </p>
          <ul className="mb-2 max-h-48 space-y-1 overflow-y-auto text-xs">
            {rejected.map((r) => (
              <li key={r.event.id} className="text-slate-700">
                <b>{r.event.table}</b> {r.event.op} (registro {r.event.row_id.slice(0, 8)}…) · HTTP {r.status}: {r.message}
                {needsManagerPin(r.event) && <RejectedAuthPin eventId={r.event.id} />}
                {r.event.table === 'orders' && cloudDiscountOf(r.message) !== null && (
                  <AdoptCloudDiscount eventId={r.event.id} value={cloudDiscountOf(r.message)!} />
                )}
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
