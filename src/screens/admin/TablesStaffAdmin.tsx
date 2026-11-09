/** Etapa 0 — Salão (mesas e áreas) e Equipe (pessoas, perfis e PINs). */
import { useState } from 'react';
import { KeyRound, Pencil, Plus } from 'lucide-react';
import { selectCurrentUser, useTcheStore } from '../../store/useTcheStore';
import type { DiningTable, StaffUser, UserRole } from '../../types';
import { ROLES, ROLE_LABEL } from '../../lib/catalog';
import { Badge, Btn, Sheet, toast } from '../../components/ui';
import { ManagerAuthSheet } from '../../components/ManagerAuthSheet';
import { isQrSelfService } from '../../data/seed';
import { Field, FormError, Panel, Select, TextInput, Toggle, parseIntInput } from './fields';

// ---------------------------------------------------------------------------
// SALÃO
// ---------------------------------------------------------------------------
export function TablesAdmin() {
  const allTables = useTcheStore((s) => s.tables);
  // O balcão da Ficha Rápida é uma mesa técnica: não aparece no cadastro do salão.
  const tables = allTables.filter((t) => t.kind === 'TABLE');
  const [editing, setEditing] = useState<DiningTable | 'new' | null>(null);
  const areas = Array.from(new Set(tables.map((t) => t.area)));
  const nextNumber = Math.max(0, ...tables.map((t) => t.number)) + 1;
  return (
    <Panel title={`Mesas (${tables.filter((t) => t.active).length} ativas)`} action={<Btn variant="gold" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova mesa</Btn>}>
      <p className="mb-3 text-xs text-slate-400">Mesa com conta aberta não pode ser desativada. Mesa nunca é apagada, para não quebrar o histórico de vendas.</p>
      {areas.map((area) => (
        <div key={area} className="mb-4">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">{area}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {tables
              .filter((t) => t.area === area)
              .sort((a, b) => a.number - b.number)
              .map((t) => (
                <button key={t.id} onClick={() => setEditing(t)} className={`rounded-xl bg-base p-3 text-left ${t.active ? '' : 'opacity-50'}`}>
                  <div className="flex items-center justify-between font-bold">{t.label}<Pencil className="h-3 w-3 text-slate-500" /></div>
                  <div className="text-xs text-slate-400">nº {t.number} · {t.capacity} lugares</div>
                  {!t.active && <Badge className="mt-1 bg-slate-600 text-white">desativada</Badge>}
                  {t.status !== 'FREE' && <Badge className="mt-1 bg-ouro text-slate-950">em uso</Badge>}
                </button>
              ))}
          </div>
        </div>
      ))}
      {tables.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nenhuma mesa. Cadastre a primeira.</p>}
      {editing && <TableEditor table={editing === 'new' ? null : editing} areas={areas} nextNumber={nextNumber} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function TableEditor({ table, areas, nextNumber, onClose }: { table: DiningTable | null; areas: string[]; nextNumber: number; onClose: () => void }) {
  const save = useTcheStore((s) => s.saveTable);
  const [number, setNumber] = useState(String(table?.number ?? nextNumber));
  const [label, setLabel] = useState(table?.label ?? `Mesa ${nextNumber}`);
  const [area, setArea] = useState(table?.area ?? areas[0] ?? 'Salão');
  const [capacity, setCapacity] = useState(String(table?.capacity ?? 4));
  const [active, setActive] = useState(table?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const n = parseIntInput(number);
    const c = parseIntInput(capacity);
    if (Number.isNaN(n) || Number.isNaN(c)) return setError('Número e lugares devem ser números inteiros.');
    const r = save({ id: table?.id, number: n, label, area, capacity: c, active });
    if (!r.ok) return setError(r.error);
    toast.success(`${r.data.label} salva.`);
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={table ? `Editar ${table.label}` : 'Nova mesa'} footer={<Btn block size="lg" onClick={submit}>Salvar mesa</Btn>}>
      <FormError error={error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Número" hint="Único na loja."><TextInput inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        <Field label="Lugares"><TextInput inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} /></Field>
      </div>
      <Field label="Nome na tela"><TextInput value={label} maxLength={50} onChange={(e) => setLabel(e.target.value)} /></Field>
      <Field label="Área" hint="Escolha uma existente ou digite uma nova (ex.: Varanda).">
        <TextInput value={area} list="tchefood-areas" maxLength={50} onChange={(e) => setArea(e.target.value)} />
        <datalist id="tchefood-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
      </Field>
      <Toggle label="Ativa no mapa" checked={active} onChange={setActive} />
      {table?.qr_code_token && <p className="mt-2 break-all text-xs text-slate-500">QR da mesa: {table.qr_code_token}</p>}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// EQUIPE
// ---------------------------------------------------------------------------
export function StaffAdmin() {
  const all = useTcheStore((s) => s.staff);
  // O usuário técnico do Cardápio QR não aparece na lista.
  const staff = all.filter((u) => !isQrSelfService(u));
  const me = useTcheStore(selectCurrentUser);
  const [editing, setEditing] = useState<StaffUser | 'new' | null>(null);
  const order: UserRole[] = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'];
  const sorted = [...staff].sort((a, b) => Number(b.active) - Number(a.active) || order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name, 'pt-BR'));
  return (
    <Panel title={`Equipe (${staff.filter((u) => u.active).length} ativos)`} action={<Btn variant="gold" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova pessoa</Btn>}>
      <p className="mb-3 text-xs text-slate-400">Trocar o PIN de outra pessoa, mudar perfil ou desativar pede PIN de gerente e motivo, e vai para a auditoria. O PIN nunca aparece na tela nem no log.</p>
      <div className="divide-y divide-slate-700 rounded-xl bg-base">
        {sorted.map((u) => (
          <div key={u.id} className={`flex items-center gap-3 p-3 ${u.active ? '' : 'opacity-50'}`}>
            <div className="flex-1">
              <div className="font-bold">{u.name}{u.id === me?.id && <span className="ml-2 text-xs text-ouro">(você)</span>}</div>
              <div className="text-xs text-slate-400">{ROLE_LABEL[u.role]}{!u.active && ' · desativado'}</div>
            </div>
            <Btn variant="ghost" aria-label={`Editar ${u.name}`} onClick={() => setEditing(u)}><Pencil className="h-4 w-4" /></Btn>
          </div>
        ))}
      </div>
      {editing && me && <StaffEditor person={editing === 'new' ? null : editing} me={me} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

const STAFF_REASONS = ['Esqueceu o PIN', 'PIN exposto para outra pessoa', 'Mudou de função', 'Saiu da empresa', 'Voltou à equipe'];

function StaffEditor({ person, me, onClose }: { person: StaffUser | null; me: StaffUser; onClose: () => void }) {
  const save = useTcheStore((s) => s.saveStaff);
  const [name, setName] = useState(person?.name ?? '');
  const [role, setRole] = useState<UserRole>(person?.role ?? 'WAITER');
  const [pin, setPin] = useState('');
  const [active, setActive] = useState(person?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [needAuth, setNeedAuth] = useState(false);

  // O que o próprio usuário pode atribuir (o store confere de novo).
  const roleOptions = ROLES.filter((r) => me.role === 'OWNER' || (r !== 'OWNER' && r !== 'MANAGER') || r === person?.role);
  const isSelf = person?.id === me.id;

  const draft = () => ({
    id: person?.id,
    name,
    role,
    // Campo em branco na edição = mantém o PIN atual (sem mostrar o PIN na tela).
    pin_code: pin.trim() === '' && person ? person.pin_code : pin.trim(),
    active,
  });

  const sensitive = (): boolean => {
    if (!person) return false;
    const d = draft();
    const pinChanged = d.pin_code !== person.pin_code;
    const roleChanged = d.role !== person.role;
    const activeChanged = d.active !== person.active;
    if (!pinChanged && !roleChanged && !activeChanged) return false;
    // Trocar só o próprio PIN não pede autorização.
    return !(isSelf && pinChanged && !roleChanged && !activeChanged);
  };

  const submit = () => {
    if (!person && pin.trim() === '') return setError('Defina um PIN de 4 dígitos.');
    if (pin.trim() !== '' && !/^\d{4}$/.test(pin.trim())) return setError('PIN deve ter 4 dígitos.');
    if (sensitive()) return setNeedAuth(true);
    const r = save(draft());
    if (!r.ok) return setError(r.error);
    toast.success(person ? `${r.data.name} atualizado.` : `${r.data.name} cadastrado como ${ROLE_LABEL[r.data.role]}.`);
    onClose();
  };

  const changes: string[] = [];
  if (person) {
    const d = draft();
    if (d.pin_code !== person.pin_code) changes.push('troca de PIN');
    if (d.role !== person.role) changes.push(`perfil ${ROLE_LABEL[person.role]} → ${ROLE_LABEL[d.role]}`);
    if (d.active !== person.active) changes.push(d.active ? 'reativação' : 'desativação');
  }

  return (
    <>
      <Sheet open={!needAuth} onClose={onClose} title={person ? `Editar ${person.name}` : 'Nova pessoa na equipe'} footer={<Btn block size="lg" onClick={submit}>Salvar</Btn>}>
        <FormError error={error} />
        <Field label="Nome"><TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Perfil">
          <Select value={role} disabled={isSelf} onChange={setRole} options={roleOptions.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
        </Field>
        <Field label={person ? 'Novo PIN (deixe em branco para manter)' : 'PIN de 4 dígitos'} hint="Único na loja. Nada de 1234 ou 1111.">
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <TextInput type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className="pl-9 tracking-[0.5em]" />
          </div>
        </Field>
        <Toggle label="Acesso ativo" checked={active} disabled={isSelf} onChange={setActive} />
      </Sheet>
      <ManagerAuthSheet
        open={needAuth}
        onClose={() => setNeedAuth(false)}
        title="Autorizar alteração na equipe"
        summary={<><b>{person?.name}</b>: {changes.join(', ')}.</>}
        confirmLabel="Autorizar e salvar"
        quickReasons={STAFF_REASONS}
        successMessage="Alteração da equipe registrada na auditoria."
        onSubmit={(managerPin, reason) => save(draft(), { managerPin, reason })}
        onSuccess={() => onClose()}
      />
    </>
  );
}
