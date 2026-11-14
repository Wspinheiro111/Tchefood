import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertOctagon, AlertTriangle, ArrowDownRight, ArrowUpRight, Info, Pencil, Target } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { useOwnerSettings, WEEKDAY_LABEL } from '../store/useOwnerSettings';
import { useDeliveryOrders, useDeliveryPolling } from '../lib/deliveryDemo';
import { DELIVERY_CHANNEL_CATALOG } from '../../server/delivery/marketplace';
import { getReviewHold } from '../lib/payments/reviewHolds';
import { formatBRL } from '../lib/money';
import { brasiliaWeekday, shiftStartBrasilia } from '../lib/reports';
import {
  cancellations,
  channelMix,
  customerReturn,
  dayOverview,
  deliveryStatus,
  goalProgress,
  indexDashboard,
  LAPSED_DAYS,
  PERIOD_LABEL,
  periodRanges,
  sellers,
  type DashboardPeriod,
  type HourPoint,
  type MarketplaceSale,
} from '../lib/ownerDashboard';
import { cashOutsideSessions } from '../lib/cashRegister';
import { leftover, type LeftoverReport } from '../lib/cardFees';
import { reviewSummary, type ReviewSummary } from '../lib/reviews';
import { ownerAlerts, type AlertTarget, type OwnerAlert } from '../lib/ownerAlerts';
import { Btn, Sheet, toast } from '../components/ui';

/** Tela de fora da Retaguarda que um aviso pode abrir. */
export type DashboardNavTarget = AlertTarget;

const REFRESH_MS = 60_000;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), REFRESH_MS);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

const pctLabel = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export function OwnerDashboard({ onNavigate }: { onNavigate: (target: DashboardNavTarget) => void }) {
  const [period, setPeriod] = useState<DashboardPeriod>('today');
  const now = useNow();
  const orders = useTcheStore((s) => s.orders);
  const orderItems = useTcheStore((s) => s.orderItems);
  const payments = useTcheStore((s) => s.payments);
  const tables = useTcheStore((s) => s.tables);
  const products = useTcheStore((s) => s.products);
  const auditLogs = useTcheStore((s) => s.auditLogs);
  const loyaltyCustomers = useTcheStore((s) => s.loyaltyCustomers);
  const cashbackLedger = useTcheStore((s) => s.cashbackLedger);
  const staff = useTcheStore((s) => s.staff);
  const kegTaps = useTcheStore((s) => s.kegTaps);
  const cashSessions = useTcheStore((s) => s.cashSessions);
  const reviews = useTcheStore((s) => s.reviews);
  const cloud = useTcheStore((s) => s.cloud);
  const outbox = useTcheStore((s) => s.outbox.length);
  const rejected = useTcheStore((s) => s.syncRejected.length);
  const syncStatus = useTcheStore((s) => s.syncStatus);
  const tenant = useTcheStore((s) => s.tenant);
  const deliveryRecords = useDeliveryOrders((s) => s.orders);
  const deliveryErrors = useDeliveryOrders((s) => s.lastErrors);
  // O painel é "ao vivo": busca os pedidos dos apps enquanto está aberto (as telas de
  // Delivery e da TV não ficam montadas na Retaguarda).
  useDeliveryPolling();

  const marketplace = useMemo<MarketplaceSale[]>(
    () =>
      deliveryRecords.map((r) => ({
        channel: r.order.channel,
        label: DELIVERY_CHANNEL_CATALOG[r.order.channel]?.label ?? r.order.channel,
        created_at: r.order.createdAt,
        total_cents: r.order.totals.orderCents,
        canceled: r.order.status === 'cancelled',
        status: r.order.status,
      })),
    [deliveryRecords],
  );

  const ix = useMemo(
    () => indexDashboard({ orders, orderItems, payments, tables, products, auditLogs, loyaltyCustomers, cashbackLedger, marketplace }),
    [orders, orderItems, payments, tables, products, auditLogs, loyaltyCustomers, cashbackLedger, marketplace],
  );
  const range = useMemo(() => periodRanges(period, now).current, [period, now]);
  const overview = useMemo(() => dayOverview(ix, period, now), [ix, period, now]);
  const channels = useMemo(() => channelMix(ix, range), [ix, range]);
  const sold = useMemo(() => sellers(ix, range), [ix, range]);
  const cancel = useMemo(() => cancellations(ix, range), [ix, range]);
  const ret = useMemo(() => customerReturn(ix, range, now), [ix, range, now]);
  const deliveries = useMemo(() => deliveryStatus(marketplace, range), [marketplace, range]);
  const feeRules = useOwnerSettings((s) => s.feeRules);
  const appCommissionPct = useOwnerSettings((s) => s.appCommissionPct);
  const left = useMemo(() => leftover(ix, range, feeRules, appCommissionPct), [ix, range, feeRules, appCommissionPct]);
  const rating = useMemo(() => reviewSummary(reviews, range), [reviews, range]);

  const alerts = useMemo(
    () =>
      ownerAlerts({
        now,
        orders,
        tables,
        products,
        kegTaps,
        reviewHoldOrderIds: orders.filter((o) => (o.status === 'OPEN' || o.status === 'PAYING') && getReviewHold(o.id)).map((o) => o.id),
        marketplaceErrors: Object.entries(deliveryErrors).map(([ch, error]) => ({
          label: DELIVERY_CHANNEL_CATALOG[ch as keyof typeof DELIVERY_CHANNEL_CATALOG]?.label ?? ch,
          error: error ?? '',
        })),
        marketplace,
        cloud: { connected: cloud !== null, rejected, pending: outbox, lastSuccessAt: syncStatus.last_success_at, lastError: syncStatus.last_error },
        // Dependência de app: olha sempre o dia de hoje, não o período escolhido.
        channels: channelMix(ix, periodRanges('today', now).current),
        // Só avisa em loja que já usa o caixa; quem nunca abriu um não recebe o aviso todo dia.
        cashOutside: cashSessions.length ? cashOutsideSessions(payments, cashSessions, shiftStartBrasilia(now), now) : undefined,
      }),
    [now, orders, tables, products, kegTaps, deliveryErrors, marketplace, cloud, rejected, outbox, syncStatus, ix, payments, cashSessions],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">Painel do dono</h2>
          <p className="text-sm text-slate-500">
            {tenant.name} · {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'short' })} · {now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{' '}
            <span className="font-bold text-verde">ao vivo</span>
          </p>
        </div>
        <div role="tablist" aria-label="Período" className="flex rounded-xl bg-surface p-1">
          {(Object.keys(PERIOD_LABEL) as DashboardPeriod[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={period === p}
              onClick={() => setPeriod(p)}
              className={`min-h-touch rounded-lg px-3 text-sm font-bold ${period === p ? 'bg-base text-slate-900 shadow' : 'text-slate-500'}`}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      <AlertStrip alerts={alerts} onNavigate={onNavigate} />

      <div className="grid gap-4 lg:grid-cols-3">
        <DayCard period={period} overview={overview} now={now} />
        <DeliveriesCard d={deliveries} onOpen={() => onNavigate('delivery')} />
      </div>

      <LeftoverCard r={left} badge={PERIOD_LABEL[period]} onSetup={() => onNavigate('fees')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Dependo demais de um canal?" badge={PERIOD_LABEL[period]}>
          {channels.length === 0 ? (
            <Empty>Nenhuma venda no período.</Empty>
          ) : (
            <>
              <ul className="space-y-2">
                {channels.map((c) => (
                  <li key={c.key}>
                    <div className="flex justify-between gap-2 text-sm">
                      <span className="font-semibold">{c.label}{c.marketplace && <span className="ml-1 text-xs font-normal text-rose-600">paga comissão</span>}</span>
                      <span className="tabular-nums">{formatBRL(c.sales)} · {c.orders} ped · {pctLabel(c.pct)}</span>
                    </div>
                    <Bar pct={c.pct} tone={c.marketplace ? 'bg-amber-500' : 'bg-brasa'} />
                  </li>
                ))}
              </ul>
              <p className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-500">{channelSummary(channels)}</p>
            </>
          )}
        </Card>

        <Card title="O que vende e o que encalha?" badge={PERIOD_LABEL[period]}>
          <div className="grid gap-4 sm:grid-cols-2">
            <RankList title="Mais vendidos" rows={sold.top} tone="bg-brasa" empty="Nada vendido no período." />
            <RankList title="Encalhados" rows={sold.stalled} tone="bg-slate-400" empty="Nenhum produto à venda." />
          </div>
          <p className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-500">Quantidade · valor. Encalhado = produto à venda no cardápio que menos vendeu (esgotado não entra).</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="O cliente volta?" badge={PERIOD_LABEL[period]}>
          <div className="grid grid-cols-2 gap-3">
            <Stat value={ret.returningPct === null ? '—' : pctLabel(ret.returningPct)} label="das compras identificadas foram de quem já era cliente" />
            <Stat value={String(ret.newCustomers)} label="clientes novos" />
            <Stat value={String(ret.customers)} label="clientes identificados no período" />
            <Stat value={String(ret.lapsed)} label={`sumidos há ${LAPSED_DAYS}+ dias`} tone={ret.lapsed > 0 ? 'text-rose-600' : undefined} />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
            <span>Conta os clientes que deram o WhatsApp no cashback. Quanto mais clientes identificados, mais certo o número.</span>
            {ret.lapsed > 0 && <Btn variant="gold" className="!min-h-0 py-1.5 text-sm" onClick={() => onNavigate('crm')}>Chamar de volta</Btn>}
          </div>
        </Card>

        <RatingCard r={rating} badge={PERIOD_LABEL[period]} />

        <Card title="Quanto cancelei?" badge={PERIOD_LABEL[period]}>
          {cancel.itemsCanceled === 0 && cancel.discounts === 0 && cancel.ordersCanceled === 0 && cancel.serviceFeeRemoved === 0 ? (
            <Empty>Nenhum cancelamento ou desconto no período.</Empty>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Stat value={formatBRL(cancel.itemsValue)} label={`${cancel.itemsCanceled} item(ns) cancelado(s)${cancel.pctOfSales !== null ? ` · ${pctLabel(cancel.pctOfSales)} do vendido` : ''}`} tone="text-rose-600" />
                <Stat value={formatBRL(cancel.discountsValue)} label={`${cancel.discounts} desconto(s)`} />
                <Stat value={String(cancel.ordersCanceled)} label="pedido(s) inteiro(s) cancelado(s)" />
                <Stat value={String(cancel.serviceFeeRemoved)} label="vez(es) que tiraram os 10%" />
              </div>
              {cancel.byManager.length > 0 && (
                <p className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-500">
                  Quem autorizou:{' '}
                  {cancel.byManager
                    .map((m) => `${staff.find((s) => s.id === m.manager_id)?.name ?? 'Gerente'} (${m.count} · ${formatBRL(m.value)})`)
                    .join(', ')}
                  . Detalhes na aba Anti-Fraude.
                </p>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function channelSummary(channels: ReturnType<typeof channelMix>): string {
  const top = channels[0]!;
  const app = channels.filter((c) => c.marketplace).reduce((a, c) => a + c.pct, 0);
  const own = Math.round((100 - app) * 10) / 10;
  if (app === 0) return `${top.label} concentra ${pctLabel(top.pct)} das vendas. Todas as vendas foram em canais próprios, sem comissão de app.`;
  return `${top.label} concentra ${pctLabel(top.pct)} das vendas. Canais próprios: ${pctLabel(own)} (sem comissão); apps: ${pctLabel(Math.round(app * 10) / 10)}.`;
}

// ---------------------------------------------------------------------------

const ALERT_STYLE: Record<OwnerAlert['tone'], { box: string; icon: typeof Info }> = {
  critical: { box: 'border-l-brasa', icon: AlertOctagon },
  warning: { box: 'border-l-amber-500', icon: AlertTriangle },
  info: { box: 'border-l-slate-400', icon: Info },
};

function AlertStrip({ alerts, onNavigate }: { alerts: OwnerAlert[]; onNavigate: (t: DashboardNavTarget) => void }) {
  if (alerts.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Avisos">
      {alerts.map((a) => {
        const S = ALERT_STYLE[a.tone];
        return (
          <div key={a.id} className={`flex flex-col gap-2 rounded-xl border border-l-4 border-slate-200 bg-base p-3 ${S.box}`}>
            <div className="flex items-start gap-2">
              <S.icon className={`mt-0.5 h-4 w-4 shrink-0 ${a.tone === 'critical' ? 'text-rose-600' : a.tone === 'warning' ? 'text-amber-600' : 'text-slate-500'}`} aria-hidden />
              <div>
                <div className="font-bold leading-tight">{a.title}</div>
                <div className="text-xs text-slate-600">{a.detail}</div>
              </div>
            </div>
            {a.action && (
              <Btn variant="secondary" className="self-start !min-h-0 py-1.5 text-sm" onClick={() => onNavigate(a.action!.target)}>
                {a.action.label}
              </Btn>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Card({ title, badge, children, className = '' }: { title: string; badge?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-base p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">{title}</h3>
        {badge && <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-bold text-slate-600">{badge}</span>}
      </div>
      {children}
    </section>
  );
}

/** "Quanto sobrou?": vendido menos custo dos produtos, taxas da maquininha e comissão dos apps. */
function LeftoverCard({ r, badge, onSetup }: { r: LeftoverReport; badge: string; onSetup: () => void }) {
  const rows: Array<{ label: string; value: number; hint?: string }> = [
    { label: 'Vendido', value: r.sales },
    { label: 'Custo dos produtos (contas fechadas)', value: -r.productCost, hint: r.productsWithoutCost ? `${r.productsWithoutCost} produto(s) vendido(s) sem custo no cadastro` : undefined },
    { label: 'Taxas da maquininha', value: -r.cardFees, hint: r.cardWithoutRule ? `${formatBRL(r.cardWithoutRule)} passado na maquininha sem taxa cadastrada` : undefined },
    { label: 'Comissão dos apps', value: -r.appCommission, hint: r.appWithoutCommission ? `${formatBRL(r.appWithoutCommission)} vendido em app sem comissão cadastrada` : undefined },
  ];
  const missing = r.cardWithoutRule > 0 || r.appWithoutCommission > 0;
  return (
    <Card title="Quanto sobrou?" badge={badge}>
      {r.sales === 0 ? (
        <Empty>Nenhuma venda no período.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <ul className="divide-y divide-slate-100 text-sm">
            {rows.map((row) => (
              <li key={row.label} className="py-1.5">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{row.label}</span>
                  <span className={`tabular-nums ${row.value < 0 ? 'text-rose-700' : ''}`}>{row.value < 0 ? '− ' : ''}{formatBRL(Math.abs(row.value))}</span>
                </div>
                {row.hint && <div className="text-xs text-amber-700">{row.hint}</div>}
              </li>
            ))}
          </ul>
          <div className="rounded-2xl bg-surface p-4 text-right">
            <div className="text-xs font-bold uppercase text-slate-500">Sobrou</div>
            <div className={`text-3xl font-black tabular-nums ${r.leftover < 0 ? 'text-rose-700' : 'text-verde'}`}>{formatBRL(r.leftover)}</div>
            {r.leftoverPct !== null && <div className="text-sm text-slate-600">{pctLabel(r.leftoverPct)} do vendido</div>}
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
        <span>Antes de aluguel, salários e outras despesas fixas.</span>
        <Btn variant={missing ? 'gold' : 'ghost'} className="!min-h-0 py-1.5 text-sm" onClick={onSetup}>{missing ? 'Cadastrar taxas' : 'Taxas e recebíveis'}</Btn>
      </div>
    </Card>
  );
}

/** "O que os clientes acharam?": notas de 1 a 5 dadas depois de pagar. */
function RatingCard({ r, badge }: { r: ReviewSummary; badge: string }) {
  return (
    <Card title="O que os clientes acharam?" badge={badge}>
      {r.count === 0 ? (
        <Empty>Nenhuma avaliação no período. O cliente dá a nota na tela de conta encerrada.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-[auto_1fr] items-center gap-4">
            <div className="text-center">
              <div className={`text-4xl font-black tabular-nums ${r.average !== null && r.average < 4 ? 'text-rose-600' : 'text-verde'}`}>{r.average?.toFixed(1).replace('.', ',')}</div>
              <div className="text-xs text-slate-500">{r.count} nota(s)</div>
            </div>
            <ul className="space-y-0.5 text-xs" aria-label="Notas por estrela">
              {[5, 4, 3, 2, 1].map((n) => {
                const qty = r.distribution[n - 1] ?? 0;
                return (
                  <li key={n} className="grid grid-cols-[1.5rem_1fr_2rem] items-center gap-2">
                    <span className="font-bold">{n}★</span>
                    <Bar pct={(qty / r.count) * 100} tone={n >= 4 ? 'bg-verde' : n === 3 ? 'bg-amarelo' : 'bg-brasa'} />
                    <span className="text-right tabular-nums">{qty}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          {r.complaints.length > 0 && (
            <div className="mt-3 border-t border-slate-200 pt-2">
              <div className="mb-1 text-xs font-black uppercase text-slate-500">O que reclamaram</div>
              <ul className="space-y-1 text-sm">
                {r.complaints.map((c) => (
                  <li key={c.id}><b>{c.score}★</b> “{c.comment}” <span className="text-xs text-slate-500">{new Date(c.created_at).toLocaleDateString('pt-BR')}</span></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">{children}</div>;
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div>
      <div className={`text-2xl font-black tabular-nums ${tone ?? 'text-slate-900'}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="mt-1 h-2 rounded-full bg-surface">
      <div className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function RankList({ title, rows, tone, empty }: { title: string; rows: Array<{ product_id: string; name: string; quantity: number; sales: number }>; tone: string; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.quantity));
  return (
    <div>
      <div className="mb-2 text-xs font-bold uppercase text-slate-500">{title}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.product_id}>
              <div className="flex justify-between gap-2 text-sm">
                <span className="truncate">{r.name}</span>
                <span className="shrink-0 tabular-nums text-slate-600">{r.quantity.toLocaleString('pt-BR')} · {formatBRL(r.sales)}</span>
              </div>
              <Bar pct={(r.quantity / max) * 100} tone={tone} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Como está o dia?"
// ---------------------------------------------------------------------------

function DayCard({ period, overview, now }: { period: DashboardPeriod; overview: ReturnType<typeof dayOverview>; now: Date }) {
  const goals = useOwnerSettings((s) => s.dailyGoals);
  const [editGoal, setEditGoal] = useState(false);
  const weekday = brasiliaWeekday(shiftStartBrasilia(now)) as keyof typeof goals;
  const goal = period === 'today' ? goals[weekday] : null;
  const progress = goalProgress(overview.sales, goal);
  const compareLabel =
    period === 'today' ? `vs ${WEEKDAY_LABEL[weekday]!.toLowerCase()} passada` : period === 'yesterday' ? 'vs mesmo dia da semana anterior' : 'vs período anterior';
  const up = overview.changePct !== null && overview.changePct >= 0;
  return (
    <Card title={period === 'today' ? 'Como está o dia?' : 'Como foi o período?'} badge={PERIOD_LABEL[period]} className="lg:col-span-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <div className="text-4xl font-black tabular-nums">{formatBRL(overview.sales)}</div>
        {overview.changePct !== null && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm font-bold ${up ? 'bg-emerald-50 text-verde' : 'bg-rose-50 text-rose-700'}`}>
            {up ? <ArrowUpRight className="h-4 w-4" aria-hidden /> : <ArrowDownRight className="h-4 w-4" aria-hidden />}
            {up ? '+' : ''}
            {pctLabel(overview.changePct)} {compareLabel}
          </span>
        )}
      </div>
      <div className="text-sm text-slate-500">vendido {period === 'today' ? 'hoje até agora' : 'no período'}</div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat value={String(overview.orders)} label="pedidos" />
        <Stat value={formatBRL(overview.averageTicket)} label="ticket médio" />
        {overview.lastHour !== null && <Stat value={formatBRL(overview.lastHour)} label="últimos 60 min" />}
        {period === 'today' && <Stat value={overview.projection === null ? '—' : formatBRL(overview.projection)} label={overview.projection === null ? 'projeção (sem histórico)' : 'projeção do dia'} />}
      </div>

      {period === 'today' && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-1 font-semibold"><Target className="h-4 w-4" aria-hidden /> Meta do dia</span>
            <button className="flex items-center gap-1 text-xs font-bold text-brasa" onClick={() => setEditGoal(true)}>
              <Pencil className="h-3 w-3" aria-hidden /> {goal ? `${progress !== null ? pctLabel(progress) : ''} de ${formatBRL(goal)}` : 'Definir meta'}
            </button>
          </div>
          <div className="h-3 rounded-full bg-surface" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? 0} aria-label="Meta do dia">
            <div className={`h-3 rounded-full ${progress !== null && progress >= 100 ? 'bg-verde' : 'bg-brasa'}`} style={{ width: `${Math.min(100, progress ?? 0)}%` }} />
          </div>
        </div>
      )}

      {overview.hourly && <HourlyChart points={overview.hourly} currentLabel={period === 'today' ? 'hoje' : 'ontem'} previousLabel="mesmo dia, semana anterior" />}

      {period === 'today' && (
        <p className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
          {overview.normalUntilNow === null
            ? 'Ainda sem histórico deste dia da semana para comparar.'
            : `Normal para ${WEEKDAY_LABEL[weekday]!.toLowerCase()} até esta hora (média das últimas semanas): ${formatBRL(overview.normalUntilNow)}.`}
        </p>
      )}
      <GoalSheet open={editGoal} onClose={() => setEditGoal(false)} />
    </Card>
  );
}

function GoalSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const goals = useOwnerSettings((s) => s.dailyGoals);
  const setDailyGoal = useOwnerSettings((s) => s.setDailyGoal);
  const [draft, setDraft] = useState<string[]>([]);
  useEffect(() => {
    if (open) setDraft(WEEKDAY_LABEL.map((_, i) => (goals[i as keyof typeof goals] ?? '') === '' ? '' : String(goals[i as keyof typeof goals]).replace('.', ',')));
  }, [open, goals]);
  const save = () => {
    for (let i = 0; i < 7; i++) {
      const raw = (draft[i] ?? '').trim().replace(/\./g, '').replace(',', '.');
      const err = setDailyGoal(i, raw === '' ? null : Number(raw));
      if (err) return toast.error(`${WEEKDAY_LABEL[i]}: ${err}`);
    }
    toast.success('Metas salvas neste aparelho.');
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Meta de venda por dia da semana" footer={<Btn block onClick={save}>Salvar metas</Btn>}>
      <p className="mb-3 text-sm text-slate-500">Deixe em branco o dia sem meta. A meta fica guardada neste aparelho.</p>
      <div className="grid grid-cols-2 gap-3">
        {WEEKDAY_LABEL.map((d, i) => (
          <label key={d} className="text-sm font-semibold">
            {d}
            <input
              inputMode="decimal"
              className="mt-1 w-full rounded-xl border border-slate-300 bg-base px-3 py-2 tabular-nums"
              placeholder="R$ 0,00"
              value={draft[i] ?? ''}
              onChange={(e) => setDraft((d2) => d2.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
      </div>
    </Sheet>
  );
}

/** Venda por hora: duas linhas (período e semana anterior) no mesmo eixo, com dica ao passar o dedo/mouse. */
function HourlyChart({ points, currentLabel, previousLabel }: { points: HourPoint[]; currentLabel: string; previousLabel: string }) {
  const W = 640;
  const H = 160;
  const PAD = { l: 8, r: 8, t: 10, b: 20 };
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const max = Math.max(1, ...points.map((p) => Math.max(p.current, p.previous)));
  const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / (points.length - 1);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const line = (key: 'current' | 'previous') => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const area = `${line('current')} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((rel - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const h = hover !== null ? points[hover]! : null;
  return (
    <div className="mt-4">
      <div className="mb-1 flex flex-wrap gap-4 text-xs text-slate-600" aria-hidden>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-brasa" /> {currentLabel}</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 border-t-2 border-dashed border-slate-400" /> {previousLabel}</span>
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-40 w-full touch-none"
          role="img"
          aria-label={`Venda por hora: ${currentLabel} e ${previousLabel}`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {[0.5, 1].map((f) => (
            <line key={f} x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="#e2e8f0" strokeWidth={1} />
          ))}
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth={1} />
          <path d={area} fill="#D2232A" opacity={0.08} />
          <path d={line('previous')} fill="none" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 4" />
          <path d={line('current')} fill="none" stroke="#D2232A" strokeWidth={2} strokeLinejoin="round" />
          {points.map((p, i) =>
            i % 3 === 0 ? (
              <text key={i} x={x(i)} y={H - 4} textAnchor="middle" fontSize={11} fill="#64748b">
                {p.hour}h
              </text>
            ) : null,
          )}
          {h && hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={y(0)} stroke="#334155" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(h.previous)} r={4} fill="#94a3b8" stroke="#fff" strokeWidth={2} />
              <circle cx={x(hover)} cy={y(h.current)} r={4} fill="#D2232A" stroke="#fff" strokeWidth={2} />
            </>
          )}
        </svg>
        {h && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-slate-200 bg-base px-2 py-1 text-xs shadow"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > points.length / 2 ? 'translateX(-105%)' : 'translateX(5%)' }}
          >
            <div className="font-bold">{h.hour}h às {(h.hour + 1) % 24}h</div>
            <div>{currentLabel}: <span className="tabular-nums">{formatBRL(h.current)}</span></div>
            <div className="text-slate-500">{previousLabel}: <span className="tabular-nums">{formatBRL(h.previous)}</span></div>
          </div>
        )}
      </div>
      <details className="mt-1 text-xs text-slate-500">
        <summary className="cursor-pointer">Ver em tabela</summary>
        <table className="mt-1 w-full tabular-nums">
          <thead><tr><th className="text-left">Hora</th><th className="text-right">{currentLabel}</th><th className="text-right">{previousLabel}</th></tr></thead>
          <tbody>
            {points.filter((p) => p.current || p.previous).map((p) => (
              <tr key={p.hour}><td>{p.hour}h</td><td className="text-right">{formatBRL(p.current)}</td><td className="text-right">{formatBRL(p.previous)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function DeliveriesCard({ d, onOpen }: { d: ReturnType<typeof deliveryStatus>; onOpen: () => void }) {
  const total = d.open + d.preparing + d.ready + d.onTheWay + d.done + d.canceled;
  const rows: Array<[string, number, string]> = [
    ['Para aceitar', d.open, 'text-rose-600'],
    ['Em preparo', d.preparing, 'text-slate-900'],
    ['Pronto para despachar', d.ready, 'text-slate-900'],
    ['Saiu para entrega', d.onTheWay, 'text-slate-900'],
    ['Concluídos', d.done, 'text-verde'],
    ['Cancelados', d.canceled, 'text-slate-500'],
  ];
  return (
    <Card title="Como estão as entregas?" badge="apps">
      {total === 0 ? (
        <Empty>Nenhum pedido de app de delivery no período.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map(([label, n, tone]) => (
            <li key={label} className="flex justify-between py-1.5 text-sm">
              <span>{label}</span>
              <span className={`font-black tabular-nums ${tone}`}>{n}</span>
            </li>
          ))}
        </ul>
      )}
      <Btn variant="secondary" block className="mt-3" onClick={onOpen}>Abrir Delivery</Btn>
    </Card>
  );
}
