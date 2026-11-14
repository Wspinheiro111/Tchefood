import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Copy, KeyRound, MessageCircle } from 'lucide-react';
import type { AdminClient, Charge, DeviceAccountResult, PaymentMethod, Plan, StoreDetail as Detail, SubscriptionStatus } from '../lib/api';
import {
  METHOD_LABEL, STATUS_LABEL, chargeMessage, dateBr, dateTimeBr, daysBetween, formatCnpj, formatPhone, money, monthBr, monthStart,
  parseMoneyInput, suggestedDeviceEmail, toCents, whatsappLink,
} from '../lib/format';
import { Aviso, Campo, Erro, Numero, Selo, errorText, useLoad } from './ui';

export default function StoreDetail({ client, tenantId, today, onBack }: { client: AdminClient; tenantId: string; today: string; onBack: () => void }) {
  const { data, error, reload } = useLoad<Detail>(() => client.store(tenantId), [client, tenantId]);
  const plans = useLoad<Plan[]>(() => client.plans(), [client]);

  return (
    <div className="space-y-4">
      <button type="button" className="btn-secundario" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> Lojas
      </button>
      <Erro>{error}</Erro>
      {!data ? (
        !error && <p className="text-sm text-slate-500">Carregando…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <h1 className="text-xl font-bold text-slate-900">{data.name}</h1>
              <p className="text-sm text-slate-500">
                {data.legal_name} · {formatCnpj(data.cnpj)} · {data.city ?? '—'}/{data.state ?? '—'}
              </p>
            </div>
            <Selo status={data.subscription?.status ?? null} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Numero titulo="Última venda" valor={data.last_order_at ? dateTimeBr(data.last_order_at) : 'nenhuma'} />
            <Numero titulo="Pedidos em 7 dias" valor={String(data.orders_7d)} />
            <Numero titulo="Pedidos em 30 dias" valor={String(data.orders_30d)} />
            <Numero titulo="Equipe ativa" valor={String(data.staff_active)} />
          </div>
          <SubscriptionForm client={client} detail={data} plans={plans.data ?? []} onSaved={reload} />
          {data.subscription && <DeviceAccount client={client} detail={data} onChanged={reload} />}
          {data.subscription && <ChargesSection client={client} detail={data} today={today} onChanged={reload} />}
          <section className="card space-y-2">
            <h2 className="font-bold text-slate-900">Histórico</h2>
            {data.audit.length === 0 ? (
              <p className="text-sm text-slate-500">Nada registrado.</p>
            ) : (
              <ul className="divide-y divide-borda text-sm">
                {data.audit.map((a, i) => (
                  <li key={i} className="py-2">
                    <span className="font-semibold">{ACTION_LABEL[a.action] ?? a.action}</span>
                    <span className="text-slate-500"> · {dateTimeBr(a.created_at)} · {a.admin_name ?? '—'}</span>
                    {a.reason && <p className="text-slate-600">Motivo: {a.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  STORE_CREATED: 'Loja criada',
  SUBSCRIPTION_CREATED: 'Assinatura criada',
  SUBSCRIPTION_UPDATED: 'Assinatura alterada',
  CHARGE_CREATED: 'Cobrança criada',
  CHARGE_PAID: 'Pagamento registrado',
  CHARGE_CANCELLED: 'Cobrança cancelada',
  DEVICE_ACCOUNT_RESERVED: 'Conta do aparelho reservada',
  DEVICE_ACCOUNT_CREATED: 'Conta do aparelho criada',
  DEVICE_PASSWORD_RESET: 'Senha do aparelho trocada',
};

function SubscriptionForm({ client, detail, plans, onSaved }: { client: AdminClient; detail: Detail; plans: Plan[]; onSaved: () => void }) {
  const s = detail.subscription;
  const initial = () => ({
    planId: s?.plan_id ?? 'salao-pro',
    price: s ? String(s.monthly_price.toFixed(2)).replace('.', ',') : '',
    status: (s?.status ?? 'ACTIVE') as SubscriptionStatus,
    billingDay: String(s?.billing_day ?? 10),
    trialEndsOn: s?.trial_ends_on ?? '',
    contactName: s?.contact_name ?? '',
    contactPhone: s?.contact_phone ?? '',
    contactEmail: s?.contact_email ?? '',
    notes: s?.notes ?? '',
    reason: '',
  });
  const [f, setF] = useState(initial);
  const [aberto, setAberto] = useState(!s);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Recarregou a loja (salvou ou outra ação): o formulário volta aos dados do banco.
  useEffect(() => setF(initial()), [detail]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErro(null);
    const price = parseMoneyInput(f.price || (plans.find((p) => p.id === f.planId)?.monthly_price.toFixed(2) ?? ''));
    if (price === null) return setErro('Mensalidade inválida (ex.: 199,90).');
    setEnviando(true);
    try {
      await client.saveSubscription(detail.tenant_id, {
        planId: f.planId, monthlyPrice: price, status: f.status, billingDay: Number(f.billingDay), trialEndsOn: f.trialEndsOn || null,
        contactName: f.contactName, contactPhone: f.contactPhone, contactEmail: f.contactEmail, notes: f.notes, reason: f.reason,
      });
      setAberto(false);
      onSaved();
    } catch (e) {
      setErro(errorText(e));
    } finally {
      setEnviando(false);
    }
  }

  if (s && !aberto) {
    return (
      <section className="card flex flex-wrap items-start gap-4">
        <div className="mr-auto space-y-1 text-sm">
          <h2 className="font-bold text-slate-900">Assinatura</h2>
          <p>
            {plans.find((p) => p.id === s.plan_id)?.name ?? s.plan_id} · <strong>{money(s.monthly_price)}</strong> por mês · vence todo dia {s.billing_day}
          </p>
          {s.status === 'TRIAL' && <p>Teste até {dateBr(s.trial_ends_on)}</p>}
          <p className="text-slate-600">
            Contato: {s.contact_name} · {formatPhone(s.contact_phone)}
            {s.contact_email ? ` · ${s.contact_email}` : ''}
          </p>
          {s.notes && <p className="text-slate-600">Obs.: {s.notes}</p>}
        </div>
        <button type="button" className="btn-secundario" onClick={() => setAberto(true)}>Alterar</button>
      </section>
    );
  }

  return (
    <form onSubmit={salvar} className="card space-y-3">
      <h2 className="font-bold text-slate-900">{s ? 'Alterar assinatura' : 'Cadastrar assinatura'}</h2>
      {!s && <Aviso>Esta loja foi criada direto no Supabase e ainda não tem assinatura. Cadastre para cobrar e criar a conta do aparelho por aqui.</Aviso>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Campo rotulo="Plano">
          <select className="campo" value={f.planId} onChange={set('planId')}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {money(p.monthly_price)}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Mensalidade" dica="Vazio = preço do plano. Zero = cortesia.">
          <input className="campo" inputMode="decimal" value={f.price} onChange={set('price')} />
        </Campo>
        <Campo rotulo="Situação">
          <select className="campo" value={f.status} onChange={set('status')}>
            {(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'] as const).map((st) => (
              <option key={st} value={st}>{STATUS_LABEL[st]}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Dia de vencimento (1 a 28)"><input className="campo" type="number" min={1} max={28} value={f.billingDay} onChange={set('billingDay')} /></Campo>
        <Campo rotulo="Fim do teste"><input className="campo" type="date" value={f.trialEndsOn} onChange={set('trialEndsOn')} /></Campo>
        <Campo rotulo="Contato"><input className="campo" value={f.contactName} onChange={set('contactName')} /></Campo>
        <Campo rotulo="WhatsApp (com DDD)"><input className="campo" value={f.contactPhone} onChange={set('contactPhone')} /></Campo>
        <Campo rotulo="E-mail"><input className="campo" value={f.contactEmail} onChange={set('contactEmail')} /></Campo>
        <Campo rotulo="Observações"><input className="campo" value={f.notes} onChange={set('notes')} /></Campo>
      </div>
      <Campo rotulo="Motivo da alteração (obrigatório)"><input className="campo" value={f.reason} onChange={set('reason')} placeholder="ex.: cliente pediu para trocar o vencimento" /></Campo>
      <Erro>{erro}</Erro>
      <div className="flex gap-2">
        <button type="submit" className="btn-primario" disabled={enviando}>{enviando ? 'Salvando…' : 'Salvar'}</button>
        {s && <button type="button" className="btn-secundario" onClick={() => { setF(initial()); setAberto(false); }}>Cancelar</button>}
      </div>
    </form>
  );
}

function DeviceAccount({ client, detail, onChanged }: { client: AdminClient; detail: Detail; onChanged: () => void }) {
  const s = detail.subscription!;
  const [email, setEmail] = useState(s.device_email ?? suggestedDeviceEmail(detail.cnpj));
  const [res, setRes] = useState<DeviceAccountResult | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const pronta = s.device_status === 'READY';

  async function run(action: 'create' | 'reset_password') {
    setErro(null);
    if (action === 'reset_password' && !window.confirm('Trocar a senha do aparelho? O aparelho da loja vai precisar entrar de novo em Retaguarda › Nuvem com a senha nova.')) return;
    setEnviando(true);
    try {
      setRes(await client.deviceAccount(detail.tenant_id, action, action === 'create' && !s.device_email ? email : undefined));
      onChanged();
    } catch (e) {
      setErro(errorText(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-slate-900">Conta do aparelho</h2>
      <p className="text-sm text-slate-600">É o e-mail e a senha que o aparelho da loja usa em Retaguarda › Nuvem. A conta só enxerga os dados desta loja e não abre este painel.</p>
      {pronta ? (
        <p className="text-sm">
          Conta: <strong>{s.device_email}</strong>
        </p>
      ) : (
        <Campo rotulo="E-mail da conta" dica={s.device_email ? 'Reservado; toque em Criar conta para concluir.' : 'Não precisa receber e-mail; só identifica a loja.'}>
          <input className="campo" value={email} disabled={!!s.device_email} onChange={(e) => setEmail(e.target.value)} />
        </Campo>
      )}
      {res && (
        <div className="space-y-2 rounded-lg border border-green-300 bg-green-50 p-3 text-sm">
          <p className="font-semibold text-green-900">Anote agora: a senha aparece só esta vez.</p>
          <p>E-mail: <code>{res.email}</code></p>
          <p>
            Senha: <code className="text-base font-bold">{res.password}</code>
            <button type="button" className="ml-2 inline-flex items-center gap-1 text-xs underline" onClick={() => void navigator.clipboard?.writeText(res.password)}>
              <Copy className="h-3 w-3" /> copiar
            </button>
          </p>
        </div>
      )}
      <Erro>{erro}</Erro>
      <div className="flex gap-2">
        {pronta ? (
          <button type="button" className="btn-secundario" disabled={enviando} onClick={() => run('reset_password')}>
            <KeyRound className="h-4 w-4" /> Trocar senha
          </button>
        ) : (
          <button type="button" className="btn-primario" disabled={enviando} onClick={() => run('create')}>
            <KeyRound className="h-4 w-4" /> Criar conta do aparelho
          </button>
        )}
      </div>
    </section>
  );
}

function ChargesSection({ client, detail, today, onChanged }: { client: AdminClient; detail: Detail; today: string; onChanged: () => void }) {
  const s = detail.subscription!;
  const [mes, setMes] = useState(monthStart(today).slice(0, 7));
  const [valor, setValor] = useState('');
  const [vence, setVence] = useState('');
  const [link, setLink] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [pagando, setPagando] = useState<string | null>(null);

  async function criar(ev: FormEvent) {
    ev.preventDefault();
    setErro(null);
    const amount = valor.trim() ? parseMoneyInput(valor) : null;
    if (valor.trim() && amount === null) return setErro('Valor inválido (ex.: 199,90).');
    setEnviando(true);
    try {
      await client.createCharge(detail.tenant_id, `${mes}-01`, amount, vence || null, link || null);
      setValor('');
      setVence('');
      setLink('');
      onChanged();
    } catch (e) {
      setErro(errorText(e));
    } finally {
      setEnviando(false);
    }
  }

  async function cancelar(c: Charge) {
    const motivo = window.prompt(`Motivo para cancelar a cobrança de ${monthBr(c.reference_month)} (${money(c.amount)}):`);
    if (motivo === null) return;
    setErro(null);
    try {
      await client.cancelCharge(c.id, motivo);
      onChanged();
    } catch (e) {
      setErro(errorText(e));
    }
  }

  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-slate-900">Cobranças</h2>
      {s.status !== 'CANCELLED' && (
        <form onSubmit={criar} className="grid gap-2 sm:grid-cols-5 sm:items-start">
          <Campo rotulo="Mês"><input className="campo" type="month" value={mes} onChange={(e) => setMes(e.target.value)} required /></Campo>
          <Campo rotulo="Valor" dica={`Vazio = ${money(s.monthly_price)}`}><input className="campo" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Campo>
          <Campo rotulo="Vencimento" dica={`Vazio = dia ${s.billing_day}`}><input className="campo" type="date" value={vence} onChange={(e) => setVence(e.target.value)} /></Campo>
          <Campo rotulo="Link do boleto/Pix (Asaas)"><input className="campo" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} /></Campo>
          <button type="submit" className="btn-primario sm:mt-5" disabled={enviando}>Criar cobrança</button>
        </form>
      )}
      <Erro>{erro}</Erro>
      {detail.charges.length === 0 ? (
        <p className="text-sm text-slate-500">Nenhuma cobrança ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="tabela w-full min-w-[720px]">
            <thead>
              <tr><th>Mês</th><th>Valor</th><th>Vencimento</th><th>Situação</th><th></th></tr>
            </thead>
            <tbody>
              {detail.charges.map((c) => {
                const atraso = c.status === 'OPEN' ? Math.max(daysBetween(c.due_date, today), 0) : 0;
                return (
                  <tr key={c.id}>
                    <td>{monthBr(c.reference_month)}</td>
                    <td>{money(c.amount)}</td>
                    <td>
                      {dateBr(c.due_date)}
                      {atraso > 0 && <p className="text-xs font-semibold text-brasa">{atraso} dia(s) de atraso</p>}
                    </td>
                    <td>
                      <Selo status={c.status} />
                      {c.status === 'PAID' && (
                        <p className="mt-1 text-xs text-slate-500">
                          {dateBr(c.paid_on)} · {METHOD_LABEL[c.payment_method ?? ''] ?? c.payment_method} · ref. {c.payment_reference}
                        </p>
                      )}
                      {c.status === 'CANCELLED' && <p className="mt-1 text-xs text-slate-500">{c.cancel_reason}</p>}
                    </td>
                    <td className="space-y-2 text-right">
                      {c.status === 'OPEN' && pagando !== c.id && (
                        <div className="flex flex-wrap justify-end gap-2">
                          <a
                            className="btn-secundario"
                            target="_blank"
                            rel="noreferrer"
                            href={whatsappLink(
                              s.contact_phone,
                              chargeMessage({ contactName: s.contact_name, storeName: detail.name, referenceMonth: c.reference_month, amount: c.amount, dueDate: c.due_date, daysLate: atraso, paymentLink: c.payment_link }, today),
                            )}
                          >
                            <MessageCircle className="h-4 w-4" /> WhatsApp
                          </a>
                          <button type="button" className="btn-verde" onClick={() => setPagando(c.id)}>Registrar pagamento</button>
                          <button type="button" className="btn-secundario" onClick={() => cancelar(c)}>Cancelar</button>
                        </div>
                      )}
                      {pagando === c.id && (
                        <PaymentForm
                          client={client}
                          charge={c}
                          today={today}
                          onDone={() => {
                            setPagando(null);
                            onChanged();
                          }}
                          onCancel={() => setPagando(null)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PaymentForm({ client, charge, today, onDone, onCancel }: { client: AdminClient; charge: Charge; today: string; onDone: () => void; onCancel: () => void }) {
  const [valor, setValor] = useState(charge.amount.toFixed(2).replace('.', ','));
  const [data, setData] = useState(today);
  const [forma, setForma] = useState<PaymentMethod>('PIX');
  const [ref, setRef] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErro(null);
    const pago = parseMoneyInput(valor);
    if (pago === null) return setErro('Valor inválido.');
    if (toCents(pago) !== toCents(charge.amount)) return setErro(`O valor pago precisa ser o da cobrança (${money(charge.amount)}). Valor diferente: cancele e crie outra cobrança.`);
    setEnviando(true);
    try {
      await client.recordPayment(charge.id, pago, data, forma, ref);
      onDone();
    } catch (e) {
      setErro(errorText(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-2 rounded-lg border border-borda p-3 text-left">
      <div className="grid gap-2 sm:grid-cols-2">
        <Campo rotulo="Valor pago"><input className="campo" value={valor} onChange={(e) => setValor(e.target.value)} /></Campo>
        <Campo rotulo="Data do pagamento"><input className="campo" type="date" max={today} value={data} onChange={(e) => setData(e.target.value)} /></Campo>
        <Campo rotulo="Forma">
          <select className="campo" value={forma} onChange={(e) => setForma(e.target.value as PaymentMethod)}>
            {Object.entries(METHOD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Referência do comprovante" dica="id do Pix (E2E), nosso número, nº do recibo">
          <input className="campo" value={ref} onChange={(e) => setRef(e.target.value)} required />
        </Campo>
      </div>
      <Erro>{erro}</Erro>
      <div className="flex gap-2">
        <button type="submit" className="btn-verde" disabled={enviando}>{enviando ? 'Salvando…' : 'Confirmar pagamento'}</button>
        <button type="button" className="btn-secundario" onClick={onCancel}>Voltar</button>
      </div>
    </form>
  );
}
