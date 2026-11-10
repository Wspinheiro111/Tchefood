import { useState } from 'react';
import { Bike, MapPin, Plus } from 'lucide-react';
import { isManagerRole, selectCurrentUser, useTcheStore } from '../../store/useTcheStore';
import { formatBRL } from '../../lib/money';
import { parseMoneyInput } from '../../lib/cashRegister';
import { Btn, toast } from '../../components/ui';
import type { Courier, DeliveryZone } from '../../types';

const input = 'min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro';

/** Retaguarda › Entrega própria: bairros com taxa e tempo, e entregadores com o ganho por entrega. */
export function OwnDeliveryAdmin() {
  const zones = useTcheStore((s) => s.deliveryZones);
  const couriers = useTcheStore((s) => s.couriers);
  const user = useTcheStore(selectCurrentUser);
  const canEdit = user ? isManagerRole(user.role) : false;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-slate-200 bg-surface p-3">
        <h2 className="mb-1 flex items-center gap-2 font-black"><MapPin className="h-5 w-5 text-brasa" /> Bairros e taxa de entrega</h2>
        <p className="mb-3 text-xs text-slate-500">A taxa entra na conta do cliente como item “Taxa de entrega” (sai na nota).</p>
        <div className="space-y-2">
          {zones.map((z) => <ZoneRow key={z.id} zone={z} canEdit={canEdit} />)}
          {canEdit && <ZoneRow canEdit />}
          {!canEdit && zones.length === 0 && <p className="text-sm text-slate-500">Nenhum bairro cadastrado.</p>}
        </div>
      </section>
      <section className="rounded-2xl border border-slate-200 bg-surface p-3">
        <h2 className="mb-1 flex items-center gap-2 font-black"><Bike className="h-5 w-5 text-brasa" /> Entregadores</h2>
        <p className="mb-3 text-xs text-slate-500">O ganho por entrega é o que a casa paga ao entregador no acerto.</p>
        <div className="space-y-2">
          {couriers.map((c) => <CourierRow key={c.id} courier={c} canEdit={canEdit} />)}
          {canEdit && <CourierRow canEdit />}
          {!canEdit && couriers.length === 0 && <p className="text-sm text-slate-500">Nenhum entregador cadastrado.</p>}
        </div>
      </section>
      {!canEdit && <p className="text-sm text-slate-500 lg:col-span-2">Só gerente ou proprietário altera estes cadastros.</p>}
    </div>
  );
}

function money(n: number) {
  return n.toFixed(2).replace('.', ',');
}

function ZoneRow({ zone, canEdit }: { zone?: DeliveryZone; canEdit: boolean }) {
  const [name, setName] = useState(zone?.name ?? '');
  const [fee, setFee] = useState(zone ? money(zone.fee) : '');
  const [eta, setEta] = useState(zone ? String(zone.eta_minutes) : '40');
  if (!canEdit && zone) {
    return <div className="flex justify-between rounded-xl bg-base p-2 text-sm"><span>{zone.name}{zone.active ? '' : ' (inativo)'}</span><span>{formatBRL(zone.fee)} · {zone.eta_minutes} min</span></div>;
  }
  const save = (active = zone?.active ?? true) => {
    const r = useTcheStore.getState().saveDeliveryZone({ id: zone?.id, name, fee: parseMoneyInput(fee || '0'), eta_minutes: Number(eta), active });
    if (!r.ok) return toast.error(r.error);
    toast.success(zone ? 'Bairro salvo.' : 'Bairro cadastrado.');
    if (!zone) { setName(''); setFee(''); setEta('40'); }
  };
  return (
    <div className={`grid grid-cols-[1fr_6rem_5rem] gap-2 rounded-xl p-2 ${zone ? 'bg-base' : 'border border-dashed border-slate-300'}`}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Novo bairro" aria-label="Nome do bairro" className={input} />
      <input value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" placeholder="Taxa" aria-label="Taxa de entrega" className={input} />
      <input value={eta} onChange={(e) => setEta(e.target.value.replace(/\D/g, ''))} inputMode="numeric" aria-label="Minutos" className={input} />
      <div className="col-span-3 flex gap-2">
        <Btn onClick={() => save()} variant={zone ? 'secondary' : 'gold'}>{zone ? 'Salvar' : <><Plus className="h-4 w-4" /> Cadastrar</>}</Btn>
        {zone && <Btn variant="secondary" onClick={() => save(!zone.active)}>{zone.active ? 'Desativar' : 'Ativar'}</Btn>}
      </div>
    </div>
  );
}

function CourierRow({ courier, canEdit }: { courier?: Courier; canEdit: boolean }) {
  const [name, setName] = useState(courier?.name ?? '');
  const [phone, setPhone] = useState(courier?.phone ?? '');
  const [fee, setFee] = useState(courier ? money(courier.fee_per_delivery) : '');
  if (!canEdit && courier) {
    return <div className="flex justify-between rounded-xl bg-base p-2 text-sm"><span>{courier.name}{courier.active ? '' : ' (inativo)'}</span><span>{formatBRL(courier.fee_per_delivery)}/entrega</span></div>;
  }
  const save = (active = courier?.active ?? true) => {
    const r = useTcheStore.getState().saveCourier({ id: courier?.id, name, phone: phone.trim() || null, fee_per_delivery: parseMoneyInput(fee || '0'), active });
    if (!r.ok) return toast.error(r.error);
    toast.success(courier ? 'Entregador salvo.' : 'Entregador cadastrado.');
    if (!courier) { setName(''); setPhone(''); setFee(''); }
  };
  return (
    <div className={`grid grid-cols-[1fr_8rem_6rem] gap-2 rounded-xl p-2 ${courier ? 'bg-base' : 'border border-dashed border-slate-300'}`}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Novo entregador" aria-label="Nome do entregador" className={input} />
      <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Telefone" aria-label="Telefone do entregador" className={input} />
      <input value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" placeholder="Ganho" aria-label="Ganho por entrega" className={input} />
      <div className="col-span-3 flex gap-2">
        <Btn onClick={() => save()} variant={courier ? 'secondary' : 'gold'}>{courier ? 'Salvar' : <><Plus className="h-4 w-4" /> Cadastrar</>}</Btn>
        {courier && <Btn variant="secondary" onClick={() => save(!courier.active)}>{courier.active ? 'Desativar' : 'Ativar'}</Btn>}
      </div>
    </div>
  );
}
