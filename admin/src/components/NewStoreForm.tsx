import { useState, type FormEvent } from 'react';
import type { AdminClient, Plan } from '../lib/api';
import { cleanCnpj, money, moneyInputError, parseMoneyInput, validCnpj, validPhone } from '../lib/format';
import { Campo, Erro, errorText, useLoad } from './ui';

export default function NewStoreForm({ client, onCancel, onCreated }: { client: AdminClient; onCancel: () => void; onCreated: (id: string) => void }) {
  const plans = useLoad<Plan[]>(() => client.plans(), [client]);
  const [f, setF] = useState({
    name: '', legalName: '', cnpj: '', city: 'Santo Ângelo', state: 'RS', planId: 'salao-pro', price: '', billingDay: '10', trialDays: '15',
    contactName: '', contactPhone: '', contactEmail: '', notes: '',
  });
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErro(null);
    if (!validCnpj(f.cnpj)) return setErro('CNPJ inválido.');
    if (!validPhone(f.contactPhone)) return setErro('WhatsApp inválido: use DDD + número, com 10 ou 11 dígitos (ex.: (55) 99653-8255), com ou sem o 55 na frente.');
    const price = f.price.trim() ? parseMoneyInput(f.price) : null;
    if (f.price.trim() && price === null) return setErro(moneyInputError(f.price, 'Preço inválido (ex.: 199,90).'));
    setEnviando(true);
    try {
      const id = await client.createStore({
        name: f.name, legalName: f.legalName, cnpj: cleanCnpj(f.cnpj), city: f.city, state: f.state, planId: f.planId, monthlyPrice: price,
        billingDay: Number(f.billingDay), trialDays: Number(f.trialDays), contactName: f.contactName, contactPhone: f.contactPhone,
        contactEmail: f.contactEmail, notes: f.notes,
      });
      onCreated(id);
    } catch (e) {
      setErro(errorText(e));
    } finally {
      setEnviando(false);
    }
  }

  const plano = plans.data?.find((p) => p.id === f.planId);
  return (
    <form onSubmit={salvar} className="card space-y-4">
      <h1 className="text-xl font-bold text-slate-900">Nova loja</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo rotulo="Nome da loja"><input className="campo" value={f.name} onChange={set('name')} required /></Campo>
        <Campo rotulo="Razão social"><input className="campo" value={f.legalName} onChange={set('legalName')} required /></Campo>
        <Campo rotulo="CNPJ" dica="Numérico ou alfanumérico (letras e números)."><input className="campo" autoCapitalize="characters" value={f.cnpj} onChange={set('cnpj')} required /></Campo>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Campo rotulo="Cidade"><input className="campo" value={f.city} onChange={set('city')} /></Campo>
          <Campo rotulo="UF"><input className="campo" maxLength={2} value={f.state} onChange={set('state')} /></Campo>
        </div>
        <Campo rotulo="Plano">
          <select className="campo" value={f.planId} onChange={set('planId')}>
            {(plans.data ?? []).filter((p) => p.active).map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {money(p.monthly_price)}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Mensalidade negociada" dica={`Vazio = preço do plano${plano ? ` (${money(plano.monthly_price)})` : ''}. Zero = cortesia.`}>
          <input className="campo" inputMode="decimal" placeholder="ex.: 179,90" value={f.price} onChange={set('price')} />
        </Campo>
        <Campo rotulo="Dia de vencimento (1 a 28)"><input className="campo" type="number" min={1} max={28} value={f.billingDay} onChange={set('billingDay')} required /></Campo>
        <Campo rotulo="Dias de teste" dica="0 = começa ativa."><input className="campo" type="number" min={0} max={90} value={f.trialDays} onChange={set('trialDays')} required /></Campo>
        <Campo rotulo="Contato (responsável)"><input className="campo" value={f.contactName} onChange={set('contactName')} required /></Campo>
        <Campo rotulo="WhatsApp do contato" dica="Com DDD."><input className="campo" inputMode="tel" value={f.contactPhone} onChange={set('contactPhone')} required /></Campo>
        <Campo rotulo="E-mail do contato"><input className="campo" type="email" value={f.contactEmail} onChange={set('contactEmail')} /></Campo>
        <Campo rotulo="Observações"><input className="campo" value={f.notes} onChange={set('notes')} /></Campo>
      </div>
      <Erro>{erro ?? plans.error}</Erro>
      <div className="flex gap-2">
        <button type="submit" className="btn-primario" disabled={enviando}>{enviando ? 'Criando…' : 'Criar loja'}</button>
        <button type="button" className="btn-secundario" onClick={onCancel}>Voltar</button>
      </div>
      <p className="text-xs text-slate-500">Depois de criar, abra a loja e toque em "Criar conta do aparelho" para ter o e-mail e a senha que o aparelho usa em Retaguarda › Nuvem.</p>
    </form>
  );
}
