import { useMemo, useState } from 'react';
import { Copy, Gift, MessageCircle } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { formatBRL } from '../lib/money';
import { buildConsultaQrUrl } from '../lib/nfce';
import {
  availableCashback,
  buildCashbackMessage,
  CASHBACK_DAYS_LABEL,
  CASHBACK_MAX_USAGE_PCT,
  CASHBACK_PCT,
  cashbackEarnAmount,
  cashbackUsable,
  formatWhatsapp,
  isCashbackDay,
  normalizeWhatsapp,
  whatsappLink,
} from '../lib/loyalty';
import { Btn, toast } from './ui';

function maskPhone(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
}

/**
 * Tela final do pagamento aprovado: informa o WhatsApp do cliente, credita 5%
 * de cashback e mostra a mensagem automática com o link da NFC-e.
 */
export function CashbackCapture({ orderId }: { orderId: string }) {
  const s = useTcheStore();
  const order = s.orders.find((o) => o.id === orderId);
  const earned = s.cashbackLedger.find((e) => e.order_id === orderId && e.entry_type === 'EARN');
  const customer = earned ? s.loyaltyCustomers.find((c) => c.id === earned.customer_id) : undefined;
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [optIn, setOptIn] = useState(false);

  const message = useMemo(() => {
    if (!earned || !customer || !order) return null;
    const nfceUrl = order.nfce_key ? buildConsultaQrUrl(order.nfce_key, s.tenant) : null;
    return buildCashbackMessage({
      tenantName: s.tenant.name.split('—')[0]!.trim(),
      customer,
      earned: earned.amount,
      balance: customer.cashback_balance,
      expiresAt: earned.expires_at!,
      nfceUrl,
      now: new Date(earned.created_at),
    });
  }, [earned, customer, order, s.tenant]);

  if (!order || order.status !== 'CLOSED') return null;
  const preview = cashbackEarnAmount(order);
  if (!(preview > 0)) return null;

  if (earned && customer && message) {
    return (
      <div className="w-full rounded-2xl border border-stone/50 bg-stone/10 p-4 text-left">
        <div className="mb-2 flex items-center gap-2 font-black text-verde"><Gift className="h-5 w-5" /> {formatBRL(earned.amount)} de cashback para {customer.name ?? formatWhatsapp(customer.phone_whatsapp)}</div>
        <div className="mb-3 rounded-xl bg-[#0b141a] p-3 text-sm">
          <div className="mb-1 text-[11px] font-bold text-emerald-600">WhatsApp · {formatWhatsapp(customer.phone_whatsapp)}</div>
          <div className="whitespace-pre-wrap rounded-lg rounded-tl-none bg-[#005c4b] p-2 text-[13px] leading-snug text-white">{message}</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <a href={whatsappLink(customer.phone_whatsapp, message)} target="_blank" rel="noreferrer" className="inline-flex min-h-touch items-center justify-center gap-2 rounded-xl bg-[#25d366] px-3 font-bold text-slate-950">
            <MessageCircle className="h-5 w-5" /> Enviar no WhatsApp
          </a>
          <Btn variant="secondary" onClick={() => { void navigator.clipboard?.writeText(message); toast.info('Mensagem copiada.'); }}><Copy className="h-4 w-4" /> Copiar</Btn>
        </div>
      </div>
    );
  }

  const submit = () => {
    const r = s.earnCashback(orderId, { phone, name: name || null, cpf: null, optIn });
    if (!r.ok) return toast.error(r.error);
    toast.success(`🎁 ${formatBRL(r.data.entry.amount)} de cashback creditado.`);
  };

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-surface p-4 text-left">
      <div className="mb-1 flex items-center gap-2 font-black text-brasa"><Gift className="h-5 w-5" /> Cashback de {formatBRL(preview)} ({CASHBACK_PCT}%)</div>
      <p className="mb-3 text-xs text-slate-500">Para usar na próxima visita, de {CASHBACK_DAYS_LABEL}. O cliente recebe o cupom fiscal no WhatsApp.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input inputMode="tel" value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} placeholder="WhatsApp (55) 99999-1234" className="min-h-touch rounded-xl border border-slate-300 bg-base px-3 text-lg outline-none focus:border-ouro" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (opcional)" className="min-h-touch rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
      </div>
      <label className="my-3 flex min-h-touch items-center gap-3 text-sm">
        <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="h-6 w-6 accent-emerald-500" />
        Cliente autorizou receber mensagens do restaurante no WhatsApp (LGPD)
      </label>
      <Btn block variant="gold" disabled={!normalizeWhatsapp(phone) || !optIn} onClick={submit}>Creditar cashback</Btn>
    </div>
  );
}

/** Na conta aberta: abate o cashback liberado do cliente (terça a quinta). */
export function CashbackRedeem({ orderId }: { orderId: string }) {
  const s = useTcheStore();
  const order = s.orders.find((o) => o.id === orderId);
  const [phone, setPhone] = useState('');
  const used = s.cashbackLedger.find((e) => e.order_id === orderId && e.entry_type === 'REDEEM');
  const normalized = normalizeWhatsapp(phone);
  const customer = normalized ? s.loyaltyCustomers.find((c) => c.phone_whatsapp === normalized) : undefined;
  const now = new Date();
  const available = customer ? availableCashback(s.cashbackLedger, customer.id, now) : 0;
  const usable = order ? cashbackUsable(available, order) : 0;
  if (!order) return null;

  if (used) {
    return <div className="mb-3 rounded-2xl border border-stone/50 bg-stone/10 p-3 text-sm font-bold text-verde">🎁 Cashback de {formatBRL(used.amount)} abatido desta conta.</div>;
  }
  const today = isCashbackDay(now);
  return (
    <details className="mb-3 rounded-2xl border border-slate-200 bg-surface p-3">
      <summary className="flex min-h-touch cursor-pointer items-center gap-2 font-bold"><Gift className="h-5 w-5 text-brasa" /> Usar cashback do cliente</summary>
      {!today && <p className="mt-2 text-sm text-brasa">Hoje não é dia de cashback: o resgate vale de {CASHBACK_DAYS_LABEL}.</p>}
      <div className="mt-2 flex gap-2">
        <input inputMode="tel" value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} placeholder="WhatsApp do cliente" className="min-h-touch flex-1 rounded-xl border border-slate-300 bg-base px-3 text-lg outline-none focus:border-ouro" />
        <Btn
          variant="gold"
          disabled={!today || !(usable > 0)}
          onClick={() => {
            const r = s.redeemCashback(orderId, phone);
            if (!r.ok) return toast.error(r.error);
            toast.success(`🎁 ${formatBRL(r.data.amount)} de cashback abatido.`);
          }}
        >
          {usable > 0 ? `Usar ${formatBRL(usable)}` : 'Usar'}
        </Btn>
      </div>
      {normalized && (
        <p className="mt-2 text-xs text-slate-500">
          {customer
            ? `${customer.name ?? formatWhatsapp(customer.phone_whatsapp)}: ${formatBRL(available)} liberado hoje · limite de ${CASHBACK_MAX_USAGE_PCT}% da conta.`
            : 'Cliente não cadastrado no programa.'}
        </p>
      )}
    </details>
  );
}
