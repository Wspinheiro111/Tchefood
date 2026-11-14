import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { AdminClient, DueCharge } from '../lib/api';
import { chargeMessage, dateBr, formatPhone, money, monthBr, monthStart, whatsappLink } from '../lib/format';
import { Aviso, Erro, errorText, useLoad } from './ui';

export default function Charges({ client, today, onOpenStore }: { client: AdminClient; today: string; onOpenStore: (id: string) => void }) {
  const { data, error, reload } = useLoad<DueCharge[]>(() => client.chargesDue(3), [client]);
  const [gerando, setGerando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const mes = monthStart(today);
  const proximo = monthStart(today, 1);

  async function gerar(ref: string) {
    setErro(null);
    setAviso(null);
    if (!window.confirm(`Gerar a cobrança de ${monthBr(ref)} para todas as lojas ativas com mensalidade que ainda não têm?`)) return;
    setGerando(true);
    try {
      const n = await client.generateMonth(ref);
      setAviso(n === 0 ? `Nenhuma cobrança nova: todas as lojas ativas já têm a de ${monthBr(ref)}.` : `${n} cobrança(s) de ${monthBr(ref)} criada(s).`);
      reload();
    } catch (e) {
      setErro(errorText(e));
    } finally {
      setGerando(false);
    }
  }

  const vencidas = (data ?? []).filter((c) => c.days_late > 0);
  const aVencer = (data ?? []).filter((c) => c.days_late === 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold text-slate-900">Cobranças do dia · {dateBr(today)}</h1>
        <button type="button" className="btn-secundario" disabled={gerando} onClick={() => gerar(mes)}>Gerar cobranças de {monthBr(mes)}</button>
        <button type="button" className="btn-secundario" disabled={gerando} onClick={() => gerar(proximo)}>Gerar de {monthBr(proximo)}</button>
      </div>
      {aviso && <Aviso>{aviso}</Aviso>}
      <Erro>{erro ?? error}</Erro>
      {data && (
        <>
          <Lista titulo={`Vencidas (${vencidas.length})`} itens={vencidas} today={today} onOpenStore={onOpenStore} vazio="Nenhuma cobrança vencida." />
          <Lista titulo={`Vencem em até 3 dias (${aVencer.length})`} itens={aVencer} today={today} onOpenStore={onOpenStore} vazio="Nada vence nos próximos 3 dias." />
        </>
      )}
      <p className="text-xs text-slate-500">O botão do WhatsApp abre a conversa com a mensagem pronta; nada é enviado sozinho. Para dar baixa, abra a loja e registre o pagamento com a referência do comprovante.</p>
    </div>
  );
}

function Lista({ titulo, itens, today, onOpenStore, vazio }: { titulo: string; itens: DueCharge[]; today: string; onOpenStore: (id: string) => void; vazio: string }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">{titulo}</h2>
      {itens.length === 0 ? (
        <p className="text-sm text-slate-500">{vazio}</p>
      ) : (
        <ul className="space-y-2">
          {itens.map((c) => {
            const msg = chargeMessage(
              { contactName: c.contact_name, storeName: c.store_name, referenceMonth: c.reference_month, amount: c.amount, dueDate: c.due_date, daysLate: c.days_late, paymentLink: c.payment_link },
              today,
            );
            return (
              <li key={c.id} className="card flex flex-wrap items-center gap-3">
                <div className="mr-auto">
                  <button type="button" className="font-semibold text-slate-900 underline-offset-2 hover:underline" onClick={() => onOpenStore(c.tenant_id)}>
                    {c.store_name}
                  </button>
                  <p className="text-sm text-slate-600">
                    {monthBr(c.reference_month)} · {money(c.amount)} · vence {dateBr(c.due_date)}
                    {c.days_late > 0 && <span className="ml-1 font-semibold text-brasa">({c.days_late} dia(s) de atraso)</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {c.contact_name} · {formatPhone(c.contact_phone)}
                  </p>
                </div>
                <a className="btn-verde" href={whatsappLink(c.contact_phone, msg)} target="_blank" rel="noreferrer">
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
