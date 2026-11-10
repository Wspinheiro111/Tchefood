import { useMemo, useState } from 'react';
import { CheckCircle2, MessageCircle, UserX } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { useOwnerSettings } from '../store/useOwnerSettings';
import { formatBRL } from '../lib/money';
import { formatWhatsapp } from '../lib/loyalty';
import { LAPSED_DAYS_DEFAULT, lapsedCustomers, winbackMessage, winbackResults, winbackUrl } from '../lib/winback';
import { Badge, Btn, toast } from '../components/ui';

const input = 'min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro';

/** Cliente sumido (30+ dias sem comprar) e a campanha de volta com cupom pelo WhatsApp. */
export function WinbackPanel() {
  const customers = useTcheStore((s) => s.loyaltyCustomers);
  const ledger = useTcheStore((s) => s.cashbackLedger);
  const storeName = useTcheStore((s) => s.tenant.name);
  const campaign = useOwnerSettings((s) => s.winbackCampaign);
  const contacts = useOwnerSettings((s) => s.winbackContacts);
  const [draft, setDraft] = useState(campaign);
  const [editing, setEditing] = useState(false);
  const [showContacted, setShowContacted] = useState(false);

  const lapsed = useMemo(() => lapsedCustomers(customers, ledger, new Date()), [customers, ledger]);
  const results = useMemo(() => winbackResults(contacts, ledger), [contacts, ledger]);
  const lastSent = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of contacts) if (!m.get(c.customer_id) || c.contacted_at > m.get(c.customer_id)!) m.set(c.customer_id, c.contacted_at);
    return m;
  }, [contacts]);
  const pending = lapsed.filter((l) => !lastSent.has(l.customer.id));
  const visible = showContacted ? lapsed : pending;

  const save = () => {
    const err = useOwnerSettings.getState().saveWinbackCampaign(draft);
    if (err) return toast.error(err);
    setDraft(useOwnerSettings.getState().winbackCampaign);
    setEditing(false);
    toast.success('Campanha salva.');
  };

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-surface p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto flex items-center gap-2 font-black"><UserX className="h-5 w-5 text-brasa" /> Clientes sumidos ({LAPSED_DAYS_DEFAULT}+ dias)</h2>
        <Badge className="bg-rose-100 text-rose-700">{pending.length} para chamar</Badge>
        <Badge className="bg-slate-200 text-slate-700">{results.contacted} chamado(s)</Badge>
        <Badge className="bg-emerald-50 text-emerald-700">
          {results.returned} voltaram{results.returnedPct !== null ? ` (${String(results.returnedPct).replace('.', ',')}%)` : ''} · {formatBRL(results.revenue)}
        </Badge>
      </header>

      <div className="rounded-xl bg-base p-3 text-sm">
        {editing ? (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={draft.offer} onChange={(e) => setDraft({ ...draft, offer: e.target.value })} placeholder="Oferta (ex.: 10% de desconto)" aria-label="Oferta" className={input} />
              <input value={draft.coupon} onChange={(e) => setDraft({ ...draft, coupon: e.target.value.toUpperCase() })} placeholder="Cupom (ex.: VOLTA10)" aria-label="Cupom" className={input} />
            </div>
            <textarea value={draft.template} onChange={(e) => setDraft({ ...draft, template: e.target.value })} rows={3} aria-label="Mensagem" className="w-full rounded-xl border border-slate-300 bg-surface p-2 outline-none focus:border-ouro" />
            <p className="text-xs text-slate-500">Use {'{nome}'}, {'{loja}'}, {'{oferta}'} e {'{cupom}'}; o sistema troca por cliente.</p>
            <div className="flex gap-2">
              <Btn variant="gold" onClick={save}>Salvar campanha</Btn>
              <Btn variant="secondary" onClick={() => { setDraft(campaign); setEditing(false); }}>Cancelar</Btn>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-2">
            <p className="mr-auto text-slate-700">“{winbackMessage(campaign, 'Maria', storeName)}”</p>
            <Btn variant="secondary" onClick={() => { setDraft(campaign); setEditing(true); }}>Editar mensagem</Btn>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Quando o cliente voltar com o cupom <b>{campaign.coupon}</b>, dê o desconto na conta normalmente (PIN do gerente) com o motivo “Cupom {campaign.coupon}”.
          Só aparece o botão do WhatsApp para quem autorizou receber mensagens.
        </p>
      </div>

      <div className="space-y-2">
        {visible.map((l) => {
          const sentAt = lastSent.get(l.customer.id);
          const text = winbackMessage(campaign, l.customer.name, storeName);
          return (
            <div key={l.customer.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-base p-3">
              <div className="mr-auto min-w-0 text-sm">
                <div className="truncate font-bold">{l.customer.name ?? 'Sem nome'} <span className="font-normal text-slate-500">· {formatWhatsapp(l.customer.phone_whatsapp)}</span></div>
                <div className="text-xs text-slate-500">
                  Sumido há {l.daysAway} dias · {l.visits} visita(s) · gastou {formatBRL(l.spent)}
                  {sentAt ? ` · chamado em ${new Date(sentAt).toLocaleDateString('pt-BR')}` : ''}
                </div>
              </div>
              {l.customer.whatsapp_opt_in ? (
                <a
                  href={winbackUrl(l.customer.phone_whatsapp, text)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => useOwnerSettings.getState().markWinbackSent(l.customer.id)}
                  className="flex min-h-touch items-center gap-2 rounded-xl bg-verde px-4 text-sm font-black text-white"
                >
                  {sentAt ? <CheckCircle2 className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />} {sentAt ? 'Mandar de novo' : 'Chamar no WhatsApp'}
                </a>
              ) : (
                <Badge className="bg-slate-200">sem autorização de WhatsApp</Badge>
              )}
            </div>
          );
        })}
        {visible.length === 0 && <p className="py-4 text-center text-sm text-slate-500">{lapsed.length ? 'Todos os clientes sumidos já foram chamados.' : 'Nenhum cliente sumido. 🎉'}</p>}
      </div>
      {lapsed.length > pending.length && (
        <button className="text-sm font-bold text-slate-500 underline" onClick={() => setShowContacted((v) => !v)}>
          {showContacted ? 'Esconder' : 'Mostrar'} quem já foi chamado
        </button>
      )}
    </section>
  );
}
