/**
 * Cadastro e pareamento da Point Smart (Mercado Pago). A Point cobra pela nuvem (Edge Function point-charge):
 * aqui a loja cadastra o terminal_id do Mercado Pago, confere na conta da loja se a maquininha está lá e no modo
 * PDV, e ativa ou desativa a maquininha no caixa.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, CloudOff, RefreshCw, Smartphone } from 'lucide-react';
import { Btn, toast } from '../../components/ui';
import { selectCan, useTcheStore } from '../../store/useTcheStore';
import { useOnline } from '../../lib/useOnline';
import { freshCloudConfig } from '../../lib/sync/useCloudSync';
import { cloudGeneration, trackCloudReachability, useCloudGeneration } from '../../lib/sync/cloudReachability';
import { fetchPointTerminals, PAIRING_TEXT, pairingState, type PairingState, type PointListing } from '../../lib/payments/pointTerminals';
import type { PosTerminal } from '../../types';
import { Field, FormError, Panel, TextInput, Toggle } from './fields';

const TONE: Record<PairingState, string> = {
  ready: 'border-verde bg-verde/10 text-verde',
  not_pdv: 'border-ouro bg-ouro/10 text-brasa',
  not_in_account: 'border-brasa bg-brasa/10 text-brasa',
  unchecked: 'border-slate-300 bg-base text-slate-700',
  inactive: 'border-slate-300 bg-base text-slate-500',
};

const LABEL: Record<PairingState, string> = {
  ready: 'Pronta',
  not_pdv: 'Fora do modo PDV',
  not_in_account: 'Fora da conta',
  unchecked: 'Não conferida',
  inactive: 'Desativada',
};

const LISTING_ERROR: Record<Exclude<PointListing['kind'], 'ok'>, string> = {
  no_cloud: 'Este aparelho não está conectado à nuvem da loja.',
  not_configured: 'A loja ainda não tem o Access Token do Mercado Pago na nuvem. Sem ele a Point não cobra: peça ao suporte Tchê Food para configurar.',
  error: '',
};

export function PointAdmin() {
  const cloud = useTcheStore((s) => s.cloud);
  const terminals = useTcheStore((s) => s.terminals);
  const canEdit = useTcheStore((s) => selectCan(s, 'STORE_SETTINGS'));
  const online = useOnline();
  const tenantId = useTcheStore((s) => s.tenant.id);
  const [listing, setListing] = useState<PointListing | null>(null);
  const [busy, setBusy] = useState(false);
  // Cada consulta leva o número da vez: resposta de consulta antiga (outra loja, outra sessão, tela fechada) não vale.
  const gen = useRef(0);
  const points = terminals.filter((t) => t.acquirer === 'MERCADO_PAGO');

  // A conexão da loja (muda também ao desconectar e reconectar na mesma loja, mesmo agrupado pelo React: auditoria #59 r7 P2-01).
  const connection = useCloudGeneration();
  useEffect(() => {
    // Trocou de loja ou de sessão da nuvem: a lista anterior não é desta loja.
    gen.current += 1;
    setListing(null);
    setBusy(false);
  }, [tenantId, cloud?.tenant_id, cloud?.email, cloud?.url, connection]);
  useEffect(() => () => { gen.current += 1; }, []);

  const check = async () => {
    const mine = ++gen.current;
    setBusy(true);
    // A conexão da loja de agora, lida antes de qualquer espera: a resposta só conta para o aviso se ela ainda for a mesma.
    const started = cloudGeneration();
    const result = await fetchPointTerminals({ config: () => freshCloudConfig(), fetch: trackCloudReachability((u: string, init: RequestInit) => fetch(u, init), started) });
    // Resposta de uma conexão que já acabou não mostra lista nem libera o botão da conexão de agora.
    if (mine !== gen.current || started !== cloudGeneration()) return;
    setListing(result);
    setBusy(false);
  };

  if (!cloud) {
    return (
      <Panel title={<span className="flex items-center gap-2"><CloudOff className="h-4 w-4" /> Point Smart (Mercado Pago)</span>}>
        <p className="text-sm text-slate-600">A Point cobra pela nuvem. Conecte este aparelho à nuvem da loja na aba <b>Nuvem</b> e volte aqui para cadastrar a maquininha.</p>
      </Panel>
    );
  }

  const listingError = listing && listing.kind !== 'ok' ? (listing.kind === 'error' ? listing.message : LISTING_ERROR[listing.kind]) : null;
  const unregistered = listing?.kind === 'ok' ? listing.terminals.filter((m) => !terminals.some((t) => t.serial_number === m.id)) : [];

  return (
    <div className="space-y-3">
      <Panel
        title={<span className="flex items-center gap-2"><Smartphone className="h-4 w-4" /> Point Smart (Mercado Pago)</span>}
        action={
          <Btn variant="secondary" disabled={busy || !online} onClick={() => void check()}>
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> {online ? 'Conferir no Mercado Pago' : 'Sem internet'}
          </Btn>
        }
      >
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>Na Point, entre com a conta do Mercado Pago da loja.</li>
          <li>Toque em <b>Conferir no Mercado Pago</b>: as maquininhas da conta aparecem abaixo com o ID.</li>
          <li>Cadastre a maquininha e confira se ela fica <b>Pronta</b> (na conta e no modo PDV).</li>
        </ol>
        {listingError && <p role="alert" className="mb-3 rounded-xl border border-brasa bg-brasa/10 p-3 text-sm font-semibold text-brasa">{listingError}</p>}
        {points.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhuma Point cadastrada nesta loja.</p>
        ) : (
          <ul className="space-y-2">
            {points.map((t) => (
              <PointRow key={t.id} terminal={t} state={pairingState(t, listing)} mpState={pairingState({ ...t, online: true }, listing)} listing={listing} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </Panel>
      {unregistered.length > 0 && (
        <Panel title="Na conta do Mercado Pago, ainda não cadastradas">
          <ul className="space-y-2">
            {unregistered.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-base p-3 text-sm">
                <span><b className="break-all font-mono">{m.id}</b> · {m.operating_mode === 'pdv' ? 'modo PDV' : 'fora do modo PDV'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">Copie o ID para o cadastro abaixo.</p>
        </Panel>
      )}
      {canEdit ? <NewPointForm suggestion={unregistered[0]?.id ?? ''} listing={listing} /> : <p className="text-sm text-slate-500">Só quem tem acesso a Loja cadastra a Point.</p>}
    </div>
  );
}

function PointRow({ terminal, state, mpState, listing, canEdit }: { terminal: PosTerminal; state: PairingState; mpState: PairingState; listing: PointListing | null; canEdit: boolean }) {
  const save = useTcheStore((s) => s.savePointTerminal);
  const [name, setName] = useState(terminal.name);
  const [error, setError] = useState<string | null>(null);
  const apply = (draft: { name: string; active: boolean }) => {
    const r = save({ id: terminal.id, name: draft.name, serial_number: terminal.serial_number, active: draft.active }, listing);
    if (!r.ok) return setError(r.error);
    setError(null);
    toast.success(draft.active ? `${r.data.name}: salva.` : `${r.data.name}: desativada no caixa.`);
  };
  return (
    <li className={`rounded-xl border-2 p-3 ${TONE[state]}`} data-testid={`point-${terminal.serial_number}`}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold text-slate-900">{terminal.name}</span>
        <span className="flex items-center gap-1 text-xs font-black uppercase">
          {state === 'ready' ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />} {LABEL[state]}
        </span>
      </div>
      <div className="mb-1 break-all font-mono text-xs text-slate-600">{terminal.serial_number}</div>
      <p className="text-sm">{PAIRING_TEXT[state]}</p>
      {state === 'inactive' && mpState !== 'unchecked' && (
        <p className="mt-1 text-sm font-semibold" data-testid="mp-state">{mpState === 'ready' ? 'Pronta no Mercado Pago: pode ativar no caixa.' : PAIRING_TEXT[mpState]}</p>
      )}
      {canEdit && (
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Nome no caixa"><TextInput value={name} maxLength={50} onChange={(e) => setName(e.target.value)} /></Field>
          <Btn variant="secondary" disabled={name.trim() === terminal.name} onClick={() => apply({ name, active: terminal.online })}>Salvar nome</Btn>
          <div className="sm:col-span-2"><Toggle checked={terminal.online} label="Ativa no caixa" onChange={(v) => apply({ name: terminal.name, active: v })} /></div>
        </div>
      )}
      <FormError error={error} />
    </li>
  );
}

function NewPointForm({ suggestion, listing }: { suggestion: string; listing: PointListing | null }) {
  const save = useTcheStore((s) => s.savePointTerminal);
  const [name, setName] = useState('Point Caixa');
  const [serial, setSerial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    // Só entra ativa no caixa se a lista do Mercado Pago mostrou esta Point pronta; senão fica desativada.
    const ready = pairingState({ serial_number: serial.trim(), online: true }, listing) === 'ready';
    const r = save({ name, serial_number: serial, active: ready }, listing);
    if (!r.ok) return setError(r.error);
    setError(null);
    setSerial('');
    if (ready) toast.success(`${r.data.name} cadastrada e pronta: já aparece no caixa.`);
    else toast.success(`${r.data.name} cadastrada, ainda desativada. Toque em "Conferir no Mercado Pago" e ative quando estiver Pronta.`);
  };
  return (
    <Panel title="Cadastrar Point">
      <FormError error={error} />
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="Nome no caixa" hint="Ex.: Point Caixa, Point Salão"><TextInput value={name} maxLength={50} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="ID da maquininha no Mercado Pago" hint="Aparece em Conferir no Mercado Pago (ex.: NEWLAND_N950__N950NCB801293324)">
          <TextInput value={serial} placeholder={suggestion || 'NEWLAND_N950__…'} maxLength={60} autoCapitalize="characters" onChange={(e) => setSerial(e.target.value)} />
        </Field>
      </div>
      <Btn block onClick={submit}>Cadastrar Point</Btn>
    </Panel>
  );
}
