import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Copy, KeyRound, MessageCircle } from 'lucide-react';
import { AdminApiError, type AdminClient, type Charge, type DeviceAccountResult, type PaymentMethod, type Plan, type StoreDetail as Detail, type SubscriptionStatus } from '../lib/api';
import {
  MAX_AMOUNT_CENTS, METHOD_LABEL, STATUS_LABEL, addDays, chargeMessage, contactNameError, dateBr, dateTimeBr, daysBetween, formatCnpj, formatPhone, money, monthBr,
  monthStart, moneyInputError, parseMoneyInput, priceInput, suggestedDeviceEmail, textLength, toCents, validMonthInput, validPhone, whatsappLink,
} from '../lib/format';
import { Aviso, Campo, Erro, Numero, Selo, errorText, useLoad, useOnVisible } from './ui';

export default function StoreDetail({ client, tenantId, today, onBack }: { client: AdminClient; tenantId: string; today: string; onBack: () => void }) {
  const { data, error, reload } = useLoad<Detail>(() => client.store(tenantId), [client, tenantId, today]);
  const plans = useLoad<Plan[]>(() => client.plans(), [client]);
  // Aba que volta a ficar visível relê a loja: o que outra aba ou outra pessoa mudou aparece
  // (formulários abertos não são apagados; cada um trata a loja relida).
  useOnVisible(reload);

  return (
    <div className="space-y-4">
      <button type="button" className="btn-secundario" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> Lojas
      </button>
      <Erro>{error}</Erro>
      {plans.error && <Erro>Não foi possível carregar os planos: {plans.error}</Erro>}
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
          <div className="grid gap-3 sm:grid-cols-5">
            <Numero titulo="Última venda concluída" valor={data.last_sale_at ? dateTimeBr(data.last_sale_at) : 'nenhuma'} />
            <Numero titulo="Último pedido aberto" valor={data.last_order_opened_at ? dateTimeBr(data.last_order_opened_at) : 'nenhum'} />
            <Numero titulo="Pedidos em 7 dias" valor={String(data.orders_7d)} />
            <Numero titulo="Pedidos em 30 dias" valor={String(data.orders_30d)} />
            <Numero titulo="Equipe ativa" valor={String(data.staff_active)} />
          </div>
          <SubscriptionForm client={client} detail={data} plans={plans.data ?? []} today={today} onChanged={reload} />
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

// Mesmos limites do banco (db/schema_painel_admin.sql), medidos depois de aparar as pontas.
const MOTIVO_MIN = 5;
const TRIAL_MAX_DAYS = 90;
function paymentLinkError(link: string): string | null {
  const l = link.trim();
  if (!l) return null;
  return /^https:\/\/\S+$/.test(l) && l.length <= 500 ? null : 'O link de pagamento precisa começar com https://, sem espaços, com até 500 caracteres.';
}

function SubscriptionForm({ client, detail, plans, today, onChanged }: { client: AdminClient; detail: Detail; plans: Plan[]; today: string; onChanged: () => void }) {
  const s = detail.subscription;
  const initial = () => ({
    planId: s?.plan_id ?? 'salao-pro',
    price: s ? priceInput(s.monthly_price) : '',
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
  // updated_at da assinatura quando a edição começou (null = loja sem assinatura). Vai para o
  // banco, que recusa salvar se a assinatura mudou nesse meio-tempo.
  const [base, setBase] = useState<string | null>(s?.updated_at ?? null);
  const [aberto, setAberto] = useState(!s);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Recarregou a loja (salvou ou outra ação): o resumo volta aos dados do banco. Com o
  // formulário aberto não mexe: outra ação na tela (cobrança, conta do aparelho) recarrega a
  // loja e não pode apagar o que está sendo digitado.
  const editando = !s || aberto;
  useEffect(() => {
    if (editando) return;
    setF(initial());
    setBase(s?.updated_at ?? null);
  }, [detail]);
  // A loja recarregou com a assinatura mudada (outra aba, outra pessoa, ou um pagamento que a
  // reativou): o que está no formulário partiu de valores velhos e o banco vai recusar. As
  // ações da conta do aparelho não mexem no updated_at da assinatura.
  const mudou = editando && (s?.updated_at ?? null) !== base;
  const recomecar = () => {
    setF(initial());
    setBase(s?.updated_at ?? null);
    setErro(null);
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  // O fim do teste só é editável com a situação "Em teste". Nas outras o banco só mantém ou
  // antecipa a data guardada (assinatura nova fora do teste fica sem data): vai a data guardada.
  const emTeste = f.status === 'TRIAL';
  // Saindo do teste à mão, o teste termina hoje (o banco grava o menor entre a data guardada e
  // hoje): o lote cobra a partir do mês seguinte ao fim.
  const saindoDoTeste = s?.status === 'TRIAL' && !emTeste;
  const guardado = s?.trial_ends_on ?? null;
  const fimGuardado = saindoDoTeste && guardado && guardado > today ? today : guardado;
  // Cobranças já criadas não mudam com a assinatura: avisa antes de salvar.
  const abertas = detail.charges.filter((c) => c.status === 'OPEN');
  const precoNovo = parseMoneyInput(f.price);
  const mudouValor = !!s && precoNovo !== null && toCents(precoNovo) !== toCents(s.monthly_price);
  const mudouDia = !!s && Number(f.billingDay) !== s.billing_day;
  const abertasDoMes = abertas.filter((c) => c.reference_month >= monthStart(today));
  const avisoCobrancas =
    (mudouValor || mudouDia) && abertasDoMes.length > 0
      ? `${abertasDoMes.length === 1 ? 'A cobrança em aberto' : 'As cobranças em aberto'} de ${abertasDoMes.map((c) => monthBr(c.reference_month)).join(', ')} ${abertasDoMes.length === 1 ? 'continua' : 'continuam'} com ${mudouValor && mudouDia ? 'o valor e o vencimento' : mudouValor ? 'o valor' : 'o vencimento'} de antes. Para mudar, cancele e crie de novo.`
      : null;
  const abertasNoTeste = emTeste && s?.status !== 'TRIAL' && f.trialEndsOn ? abertas.filter((c) => c.reference_month <= f.trialEndsOn) : [];
  const avisoTeste =
    abertasNoTeste.length > 0
      ? `${abertasNoTeste.length === 1 ? 'A cobrança em aberto' : 'As cobranças em aberto'} de ${abertasNoTeste.map((c) => monthBr(c.reference_month)).join(', ')} ${abertasNoTeste.length === 1 ? 'fica' : 'ficam'} em aberto: voltar ao teste não cancela cobrança já criada. Se for cortesia, cancele.`
      : null;
  // Trocar o plano põe o preço do plano novo na mensalidade (dá para editar depois).
  const setPlano = (e: { target: { value: string } }) => {
    const p = plans.find((x) => x.id === e.target.value);
    setF({ ...f, planId: e.target.value, price: p ? priceInput(p.monthly_price) : f.price });
  };

  async function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErro(null);
    const price = parseMoneyInput(f.price || (plans.find((p) => p.id === f.planId)?.monthly_price.toFixed(2) ?? ''));
    if (price === null) return setErro(moneyInputError(f.price, 'Mensalidade inválida (ex.: 199,90).'));
    if (toCents(price) > MAX_AMOUNT_CENTS) return setErro('Mensalidade até R$ 100.000,00.');
    if (!validPhone(f.contactPhone)) return setErro('WhatsApp inválido: use DDD + número, com 10 ou 11 dígitos (ex.: (55) 99653-8255), com ou sem o 55 na frente.');
    const contato = contactNameError(f.contactName);
    if (contato) return setErro(contato);
    if (emTeste) {
      if (!f.trialEndsOn) return setErro('Loja em teste precisa da data de fim do teste.');
      if (daysBetween(today, f.trialEndsOn) > TRIAL_MAX_DAYS) return setErro(`Fim do teste em até ${TRIAL_MAX_DAYS} dias a partir de hoje (até ${dateBr(addDays(today, TRIAL_MAX_DAYS))}).`);
    }
    if (textLength(f.reason) < MOTIVO_MIN) return setErro(`Informe o motivo da alteração (pelo menos ${MOTIVO_MIN} letras).`);
    // Cancelar a assinatura também cancela, no banco, as cobranças em aberto dos meses seguintes.
    if (f.status === 'CANCELLED' && s?.status !== 'CANCELLED' && !window.confirm(`Cancelar a assinatura? As cobranças em aberto de meses depois de ${monthBr(monthStart(today))} também vão ser canceladas; as de ${monthBr(monthStart(today))} e de antes continuam em aberto.`)) return;
    setEnviando(true);
    try {
      await client.saveSubscription(detail.tenant_id, {
        planId: f.planId, monthlyPrice: price, status: f.status, billingDay: Number(f.billingDay), trialEndsOn: emTeste ? f.trialEndsOn : fimGuardado,
        contactName: f.contactName, contactPhone: f.contactPhone, contactEmail: f.contactEmail, notes: f.notes, reason: f.reason,
        expectedUpdatedAt: base,
      });
      setAberto(false);
      onChanged();
    } catch (e) {
      setErro(errorText(e));
      // Relê a loja (sem apagar o formulário): se a recusa foi porque a assinatura mudou,
      // o aviso e o botão de descartar aparecem.
      onChanged();
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
        <button
          type="button"
          className="btn-secundario"
          onClick={() => {
            recomecar();
            setAberto(true);
          }}
        >
          Alterar
        </button>
      </section>
    );
  }

  return (
    <form onSubmit={salvar} className="card space-y-3">
      <h2 className="font-bold text-slate-900">{s ? 'Alterar assinatura' : 'Cadastrar assinatura'}</h2>
      {!s && <Aviso>Esta loja foi criada direto no Supabase e ainda não tem assinatura. Cadastre para cobrar e criar a conta do aparelho por aqui.</Aviso>}
      {mudou && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
          <p>
            A assinatura desta loja mudou enquanto você editava (alterada em outra aba ou por outra pessoa, ou reativada por um pagamento registrado). Salvar vai ser recusado: descarte o que
            digitou e recarregue os valores atuais antes de alterar.
          </p>
          <button type="button" className="btn-secundario" onClick={recomecar}>Descartar e recarregar</button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Campo rotulo="Plano">
          <select className="campo" aria-label="Plano" value={f.planId} onChange={setPlano}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {money(p.monthly_price)}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Mensalidade" dica="Vazio = preço do plano. Zero = cortesia.">
          <input className="campo" aria-label="Mensalidade" inputMode="decimal" value={f.price} onChange={set('price')} />
        </Campo>
        <Campo
          rotulo="Situação"
          dica={f.status === 'CANCELLED' && s?.status !== 'CANCELLED' ? `Ao salvar, as cobranças em aberto de meses depois de ${monthBr(monthStart(today))} também são canceladas.` : undefined}
        >
          <select className="campo" aria-label="Situação" value={f.status} onChange={set('status')}>
            {(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'] as const).map((st) => (
              <option key={st} value={st}>{STATUS_LABEL[st]}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Dia de vencimento (1 a 28)"><input className="campo" type="number" min={1} max={28} value={f.billingDay} onChange={set('billingDay')} /></Campo>
        {emTeste ? (
          <Campo rotulo="Fim do teste" dica={`Até ${TRIAL_MAX_DAYS} dias a partir de hoje.`}>
            <input className="campo" aria-label="Fim do teste" type="date" max={addDays(today, TRIAL_MAX_DAYS)} value={f.trialEndsOn} onChange={set('trialEndsOn')} required />
          </Campo>
        ) : (
          fimGuardado && (
            <div className="text-sm" data-testid="fim-teste-leitura">
              <span className="rotulo">Fim do teste</span>
              <p>{dateBr(fimGuardado)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {saindoDoTeste
                  ? `Saindo do teste, ele termina em ${dateBr(fimGuardado)}${fimGuardado === today ? ' (hoje)' : ''}: o lote cobra a partir de ${monthBr(monthStart(fimGuardado, 1))}.`
                  : 'Os meses até essa data não entram no lote de cobranças.'}
              </p>
            </div>
          )
        )}
        <Campo rotulo="Contato"><input className="campo" aria-label="Contato" minLength={2} value={f.contactName} onChange={set('contactName')} /></Campo>
        <Campo rotulo="WhatsApp (com DDD)"><input className="campo" aria-label="WhatsApp" inputMode="tel" value={f.contactPhone} onChange={set('contactPhone')} /></Campo>
        <Campo rotulo="E-mail"><input className="campo" value={f.contactEmail} onChange={set('contactEmail')} /></Campo>
        <Campo rotulo="Observações"><input className="campo" value={f.notes} onChange={set('notes')} /></Campo>
      </div>
      <Campo rotulo="Motivo da alteração (obrigatório)"><input className="campo" aria-label="Motivo" minLength={MOTIVO_MIN} value={f.reason} onChange={set('reason')} placeholder="ex.: cliente pediu para trocar o vencimento" /></Campo>
      {avisoCobrancas && <Aviso>{avisoCobrancas}</Aviso>}
      {avisoTeste && <Aviso>{avisoTeste}</Aviso>}
      <Erro>{erro}</Erro>
      <div className="flex gap-2">
        <button type="submit" className="btn-primario" disabled={enviando}>{enviando ? 'Salvando…' : 'Salvar'}</button>
        {s && <button type="button" className="btn-secundario" onClick={() => { recomecar(); setAberto(false); }}>Cancelar</button>}
      </div>
    </form>
  );
}

function DeviceAccount({ client, detail, onChanged }: { client: AdminClient; detail: Detail; onChanged: () => void }) {
  const s = detail.subscription!;
  const [email, setEmail] = useState(s.device_email ?? suggestedDeviceEmail(detail.cnpj));
  const [res, setRes] = useState<(DeviceAccountResult & { action: 'create' | 'reset_password' }) | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [copia, setCopia] = useState<'ok' | 'erro' | null>(null);
  const pronta = s.device_status === 'READY';
  // Senha na tela e a loja relida (outra aba, aba que voltou a ficar visível) mostra no histórico
  // outra senha gerada depois desta (troca feita em outra aba ou por outra pessoa): a da tela não
  // vale mais e sai. "marca" = a entrada mais nova de senha gerada antes desta; a desta é uma só.
  const [marca, setMarca] = useState<number | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  useEffect(() => {
    if (!res) return;
    if (passwordEntriesAfter(detail, marca) > 1) {
      setRes(null);
      setCopia(null);
      setAviso('Outra senha foi gerada para o aparelho depois desta (em outra aba ou por outra pessoa): a senha que estava aqui não vale mais.');
    }
  }, [detail]);

  async function copiar(senha: string) {
    setCopia(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('sem área de transferência');
      await navigator.clipboard.writeText(senha);
      setCopia('ok');
    } catch {
      setCopia('erro');
    }
  }

  async function run(action: 'create' | 'reset_password') {
    // Desistiu da troca: a senha que está na tela (mostrada uma vez só) fica.
    if (action === 'reset_password' && !window.confirm('Trocar a senha do aparelho? O aparelho da loja vai precisar entrar de novo em Retaguarda › Nuvem com a senha nova.')) return;
    // A senha de antes some já: nunca fica ao lado de um erro novo.
    setRes(null);
    setCopia(null);
    setErro(null);
    setAviso(null);
    const antes = newestPasswordEntry(detail);
    setEnviando(true);
    try {
      const r = await client.deviceAccount(detail.tenant_id, action, action === 'create' ? email : undefined);
      setMarca(antes);
      setRes({ ...r, action });
      onChanged();
    } catch (e) {
      setErro(deviceAccountError(e, action));
      // Relê a loja: os botões passam a refletir o estado real (ex.: 409 "já tem conta").
      onChanged();
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
        <Campo rotulo="E-mail da conta" dica={s.device_email ? 'Reservado. Toque em Criar conta para concluir; se o e-mail já existia no Supabase, troque-o aqui.' : 'Não precisa receber e-mail; só identifica a loja.'}>
          <input className="campo" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Campo>
      )}
      {res && (
        <div className="space-y-2 rounded-lg border border-green-300 bg-green-50 p-3 text-sm">
          <p className="font-semibold text-green-900">Anote agora: a senha aparece só esta vez.</p>
          <p>E-mail: <code>{res.email}</code></p>
          <p>
            Senha: <code className="text-base font-bold">{res.password}</code>
            <button type="button" className="ml-2 inline-flex items-center gap-1 text-xs underline" onClick={() => void copiar(res.password)}>
              <Copy className="h-3 w-3" /> copiar
            </button>
            {copia === 'ok' && <span className="ml-2 text-xs font-semibold text-green-800" role="status">copiado</span>}
          </p>
          {copia === 'erro' && <p className="text-xs font-semibold text-red-800" role="alert">Não deu para copiar (o navegador não deixou): selecione a senha e copie à mão, ou anote.</p>}
          {res.action === 'reset_password' && (
            <p className="text-slate-700">O aparelho que estava conectado continua até o token atual vencer (até 1 hora); entre com a senha nova nele.</p>
          )}
        </div>
      )}
      {aviso && <Aviso>{aviso}</Aviso>}
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

const PASSWORD_ACTIONS = new Set(['DEVICE_ACCOUNT_CREATED', 'DEVICE_PASSWORD_RESET']);
const auditTime = (a: { created_at: string }) => {
  const t = Date.parse(a.created_at);
  return Number.isNaN(t) ? 0 : t;
};

/** Hora (ms) da entrada mais nova de senha gerada no histórico da loja; null se não há. */
function newestPasswordEntry(detail: Detail): number | null {
  const ts = detail.audit.filter((a) => PASSWORD_ACTIONS.has(a.action)).map(auditTime);
  return ts.length ? Math.max(...ts) : null;
}

/** Quantas senhas geradas o histórico mostra depois de `marca` (null = todas). */
function passwordEntriesAfter(detail: Detail, marca: number | null): number {
  return detail.audit.filter((a) => PASSWORD_ACTIONS.has(a.action) && (marca === null || auditTime(a) > marca)).length;
}

/**
 * Erro da conta do aparelho. Recusa clara (400, 401, 403, 409) mantém a mensagem do servidor.
 * Falha depois de o pedido sair (sem conexão, 5xx, 502/504/546 do gateway, ou a função dizendo
 * que a escrita no Auth pode ter passado): a senha pode já ter mudado e a nova, que só aparece
 * uma vez, se perdeu. Nunca diz que nada mudou.
 */
function deviceAccountError(e: unknown, action: 'create' | 'reset_password'): string {
  const status = e instanceof AdminApiError ? e.status : null;
  const texto = errorText(e);
  if (status === 400 || status === 401 || status === 403 || status === 409) return texto;
  const talvez = status === 0 || (status !== null && status >= 500) || /pode já ter mudado|pode ter (sido|passado|mudado)/i.test(texto);
  if (!talvez) return texto;
  const oQue = action === 'create' ? 'A conta pode ter sido criada e a senha pode já valer' : 'A senha pode já ter mudado';
  return `Não deu para confirmar com o servidor (${texto}). ${oQue}: a senha nova se perdeu (ela só aparece uma vez). Use "Trocar senha" para gerar outra${action === 'create' ? ' (se o botão ainda for "Criar conta do aparelho", toque nele de novo)' : ''}.`;
}

function ChargesSection({ client, detail, today, onChanged }: { client: AdminClient; detail: Detail; today: string; onChanged: () => void }) {
  const s = detail.subscription!;
  // Mês padrão = mês de hoje no servidor; acompanha a virada do mês enquanto ninguém mexeu no campo.
  const [mes, setMes] = useState(monthStart(today).slice(0, 7));
  const [mesTocado, setMesTocado] = useState(false);
  useEffect(() => {
    if (!mesTocado) setMes(monthStart(today).slice(0, 7));
  }, [today]);
  const [cancelando, setCancelando] = useState<string | null>(null);
  const [valor, setValor] = useState('');
  const [vence, setVence] = useState('');
  const [link, setLink] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [pagando, setPagando] = useState<string | null>(null);
  const [fechado, setFechado] = useState<string | null>(null);
  // A loja relida mostra a cobrança do formulário de pagamento já paga ou cancelada (o pagamento
  // entrou e só a resposta se perdeu, ou outra aba deu baixa): o formulário fecha.
  useEffect(() => {
    if (!pagando) return;
    const c = detail.charges.find((x) => x.id === pagando);
    if (c && c.status === 'OPEN') return;
    setPagando(null);
    setFechado(c ? `A cobrança de ${monthBr(c.reference_month)} já está ${STATUS_LABEL[c.status]?.toLowerCase() ?? c.status}: o formulário de pagamento foi fechado.` : 'A cobrança não está mais na lista: o formulário de pagamento foi fechado.');
  }, [detail]);
  // Loja em cortesia (mensalidade zero): a cobrança precisa de um valor digitado.
  const cortesia = toCents(s.monthly_price) === 0;

  async function criar(ev: FormEvent) {
    ev.preventDefault();
    setErro(null);
    if (!validMonthInput(mes)) return setErro('Mês inválido: use AAAA-MM (ex.: 2026-11).');
    const amount = valor.trim() ? parseMoneyInput(valor) : null;
    if (valor.trim() && amount === null) return setErro(moneyInputError(valor, 'Valor inválido (ex.: 199,90).'));
    if (amount === null && cortesia) return setErro('Loja em cortesia (mensalidade R$ 0,00): informe o valor da cobrança, maior que zero.');
    if (amount !== null && toCents(amount) <= 0) return setErro('O valor da cobrança precisa ser maior que zero.');
    if (amount !== null && toCents(amount) > MAX_AMOUNT_CENTS) return setErro('Cobrança até R$ 100.000,00.');
    const erroLink = paymentLinkError(link);
    if (erroLink) return setErro(erroLink);
    setEnviando(true);
    try {
      await client.createCharge(detail.tenant_id, `${mes}-01`, amount, vence || null, link || null);
      setValor('');
      setVence('');
      setLink('');
      onChanged();
    } catch (e) {
      setErro(errorText(e));
      // Relê a loja (sem apagar o formulário): a lista mostra o que o banco tem de fato antes
      // de tentar de novo (ex.: a cobrança foi criada e só a resposta se perdeu).
      onChanged();
    } finally {
      setEnviando(false);
    }
  }

  async function cancelar(c: Charge) {
    if (cancelando) return;
    const motivo = window.prompt(`Motivo para cancelar a cobrança de ${monthBr(c.reference_month)} (${money(c.amount)}):`);
    if (motivo === null) return;
    setErro(null);
    if (textLength(motivo) < MOTIVO_MIN) return setErro(`Informe o motivo do cancelamento (pelo menos ${MOTIVO_MIN} letras).`);
    setCancelando(c.id);
    try {
      await client.cancelCharge(c.id, motivo);
      onChanged();
    } catch (e) {
      setErro(errorText(e));
      onChanged();
    } finally {
      setCancelando(null);
    }
  }

  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-slate-900">Cobranças</h2>
      {s.status !== 'CANCELLED' && (
        <form onSubmit={criar} className="grid gap-2 sm:grid-cols-5 sm:items-start">
          <Campo rotulo="Mês"><input
              className="campo"
              aria-label="Mês"
              type="month"
              value={mes}
              onChange={(e) => {
                setMesTocado(true);
                setMes(e.target.value);
              }}
              required
            /></Campo>
          <Campo rotulo="Valor" dica={cortesia ? 'Loja em cortesia: informe o valor.' : `Vazio = ${money(s.monthly_price)}`}><input className="campo" aria-label="Valor" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Campo>
          <Campo rotulo="Vencimento" dica={`Vazio = dia ${s.billing_day}, nunca antes de hoje nem antes do fim do teste.`}><input className="campo" aria-label="Vencimento" type="date" min={s.trial_ends_on ? addDays(s.trial_ends_on, 1) : undefined} value={vence} onChange={(e) => setVence(e.target.value)} /></Campo>
          <Campo rotulo="Link do boleto/Pix (Asaas)"><input className="campo" aria-label="Link do boleto/Pix (Asaas)" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} /></Campo>
          <button type="submit" className="btn-primario sm:mt-5" disabled={enviando}>Criar cobrança</button>
        </form>
      )}
      {fechado && <Aviso>{fechado}</Aviso>}
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
                const wa = whatsappLink(
                  s.contact_phone,
                  chargeMessage({ contactName: s.contact_name, storeName: detail.name, referenceMonth: c.reference_month, amount: c.amount, dueDate: c.due_date, daysLate: atraso, paymentLink: c.payment_link }, today),
                );
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
                          {wa ? (
                            <a className="btn-secundario" target="_blank" rel="noreferrer" href={wa}>
                              <MessageCircle className="h-4 w-4" /> WhatsApp
                            </a>
                          ) : (
                            <span className="text-xs text-amber-700">WhatsApp do contato inválido: corrija na assinatura.</span>
                          )}
                          <button type="button" className="btn-verde" disabled={cancelando === c.id} onClick={() => {
                              setFechado(null);
                              setPagando(c.id);
                            }}>Registrar pagamento</button>
                          <button type="button" className="btn-secundario" disabled={cancelando !== null} onClick={() => cancelar(c)}>
                            {cancelando === c.id ? 'Cancelando…' : 'Cancelar'}
                          </button>
                        </div>
                      )}
                      {pagando === c.id && c.status === 'OPEN' && (
                        <PaymentForm
                          client={client}
                          charge={c}
                          today={today}
                          onDone={() => {
                            setPagando(null);
                            onChanged();
                          }}
                          onCancel={() => setPagando(null)}
                          onFailed={onChanged}
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

const REF_MIN = 4;
const REF_MAX = 120;

function PaymentForm({ client, charge, today, onDone, onCancel, onFailed }: { client: AdminClient; charge: Charge; today: string; onDone: () => void; onCancel: () => void; onFailed: () => void }) {
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
    if (pago === null) return setErro(moneyInputError(valor, 'Valor inválido.'));
    if (toCents(pago) !== toCents(charge.amount)) return setErro(`O valor pago precisa ser o da cobrança (${money(charge.amount)}). Valor diferente: cancele e crie outra cobrança.`);
    if (!data) return setErro('Informe a data do pagamento.');
    const r = ref.trim();
    const n = textLength(r);
    if (n < REF_MIN || n > REF_MAX) return setErro(`Referência do comprovante: de ${REF_MIN} a ${REF_MAX} caracteres (id do Pix, nosso número, nº do recibo).`);
    setEnviando(true);
    try {
      await client.recordPayment(charge.id, pago, data, forma, r);
      onDone();
    } catch (e) {
      setErro(errorText(e));
      // Relê a loja com o formulário aberto: se o pagamento entrou e só a resposta se perdeu,
      // a linha já mostra a cobrança paga antes de tentar de novo.
      onFailed();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-2 rounded-lg border border-borda p-3 text-left">
      <div className="grid gap-2 sm:grid-cols-2">
        <Campo rotulo="Valor pago"><input className="campo" aria-label="Valor pago" value={valor} onChange={(e) => setValor(e.target.value)} /></Campo>
        <Campo rotulo="Data do pagamento"><input className="campo" aria-label="Data do pagamento" type="date" max={today} value={data} onChange={(e) => setData(e.target.value)} required /></Campo>
        <Campo rotulo="Forma">
          <select className="campo" value={forma} onChange={(e) => setForma(e.target.value as PaymentMethod)}>
            {Object.entries(METHOD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Referência do comprovante" dica="id do Pix (E2E), nosso número, nº do recibo">
          <input className="campo" aria-label="Referência do comprovante" minLength={REF_MIN} value={ref} onChange={(e) => setRef(e.target.value)} required />
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
