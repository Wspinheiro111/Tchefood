import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AlertTriangle, BarChart3, Bike, CreditCard, Gauge, Beer, Cloud, FileText, Gift, LayoutGrid, MessageCircle, PackageOpen, Printer, Receipt, Settings, ShieldAlert, Store, UserCog, Users, UtensilsCrossed } from 'lucide-react';
import { isManagerRole, isRealFiscalStore, selectCan, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { ReportHeader } from '../components/Brand';
import { formatBRL, toCents } from '../lib/money';
import { kegStatus } from '../lib/kegs';
import { AUDIT_LABEL, declinedInShift, formatShiftStart, reconciliation, shiftKpis, waiterSplit, whatsappAlertText } from '../lib/reports';
import { useShiftPeriod } from '../lib/useShiftStart';
import { Badge, Btn, toast } from '../components/ui';
import { NfceViewer, nfceCloudLabel } from './NfceViewer';
import { PrinterSettings } from './PrinterSettings';
import { CrmPanel } from './CrmPanel';
import { PurchaseImport } from './PurchaseImport';
import { KegMonitorScreen } from './KegMonitorScreen';
import { MenuAdmin } from './admin/MenuAdmin';
import { FeesReceivables } from './FeesReceivables';
import { OwnDeliveryAdmin } from './admin/OwnDeliveryAdmin';
import { OwnerDashboard, type DashboardNavTarget } from './OwnerDashboard';
import { CardsAdmin, StaffAdmin, TablesAdmin } from './admin/TablesStaffAdmin';
import { CloudAdmin, StoreAdmin } from './admin/StoreCloudAdmin';
import type { Permission } from '../types';

type Tab = 'owner' | 'fees' | 'entrega' | 'dash' | 'recon' | 'waiters' | 'audit' | 'chopp' | 'crm' | 'nfce' | 'purchases' | 'menu' | 'tables' | 'staff' | 'store' | 'cloud' | 'printers' | 'config';

/**
 * Abas da retaguarda. As de relatório seguem o perfil (gerente, proprietário, caixa);
 * as de cadastro (Etapa 0) seguem a permissão configurável do perfil.
 */
const TABS: Array<{ key: Tab; label: string; icon: typeof BarChart3; needs: 'reports' | Permission | Permission[] }> = [
  { key: 'owner', label: 'Painel do dono', icon: Gauge, needs: 'reports' },
  { key: 'fees', label: 'Taxas e recebíveis', icon: CreditCard, needs: 'reports' },
  { key: 'entrega', label: 'Entrega própria', icon: Bike, needs: 'reports' },
  { key: 'dash', label: 'Turno', icon: BarChart3, needs: 'reports' },
  { key: 'recon', label: 'Conciliação', icon: Receipt, needs: 'reports' },
  { key: 'waiters', label: 'Rateio 10%', icon: Users, needs: 'reports' },
  { key: 'audit', label: 'Anti-Fraude', icon: ShieldAlert, needs: 'reports' },
  { key: 'chopp', label: 'Barris de chopp', icon: Beer, needs: 'reports' },
  { key: 'crm', label: 'Clientes & Cashback', icon: Gift, needs: 'reports' },
  { key: 'nfce', label: 'NFC-e', icon: FileText, needs: 'reports' },
  { key: 'purchases', label: 'Compras / Estoque', icon: PackageOpen, needs: 'reports' },
  { key: 'menu', label: 'Cardápio', icon: UtensilsCrossed, needs: ['MENU_MANAGE', 'MENU_AVAILABILITY'] },
  { key: 'tables', label: 'Salão', icon: LayoutGrid, needs: 'TABLES_MANAGE' },
  { key: 'staff', label: 'Equipe', icon: UserCog, needs: 'STAFF_MANAGE' },
  { key: 'store', label: 'Loja', icon: Store, needs: 'STORE_SETTINGS' },
  { key: 'cloud', label: 'Nuvem', icon: Cloud, needs: 'SYNC_MANAGE' },
  { key: 'printers', label: 'Impressoras', icon: Printer, needs: 'reports' },
  { key: 'config', label: 'Ajustes', icon: Settings, needs: 'reports' },
];

/** Abas que o usuário logado enxerga. Exportada para o App decidir se mostra a Retaguarda. */
export function useBackOfficeTabs(): typeof TABS {
  const user = useTcheStore(selectCurrentUser);
  const perms = useTcheStore(useShallow((s) => ({
    MENU_MANAGE: selectCan(s, 'MENU_MANAGE'),
    MENU_AVAILABILITY: selectCan(s, 'MENU_AVAILABILITY'),
    TABLES_MANAGE: selectCan(s, 'TABLES_MANAGE'),
    STAFF_MANAGE: selectCan(s, 'STAFF_MANAGE'),
    STORE_SETTINGS: selectCan(s, 'STORE_SETTINGS'),
    SYNC_MANAGE: selectCan(s, 'SYNC_MANAGE'),
  })));
  const reports = isManagerRole(user?.role) || user?.role === 'CASHIER';
  return TABS.filter((t) => {
    if (t.needs === 'reports') return reports;
    const list = Array.isArray(t.needs) ? t.needs : [t.needs];
    // Quem não vê relatórios só entra em cadastro se puder editar algo além do "esgotado"
    // (o esgotado da cozinha fica no próprio KDS).
    if (!reports && list.length > 1) return perms.MENU_MANAGE;
    return list.some((p) => perms[p]);
  });
}

/** Telas fora da Retaguarda que um aviso do Painel do dono pode abrir. */
export type BackOfficeExit = 'delivery' | 'pickup' | 'map' | 'caixa';

export function BackOffice({ onExit }: { onExit?: (view: BackOfficeExit) => void } = {}) {
  const tabs = useBackOfficeTabs();
  const [picked, setTab] = useState<Tab>('owner');
  const navigate = (target: DashboardNavTarget) => {
    if (target === 'delivery' || target === 'pickup' || target === 'map' || target === 'caixa') onExit?.(target);
    else setTab(target);
  };
  const tab: Tab | undefined = tabs.some((t) => t.key === picked) ? picked : tabs[0]?.key;
  const alerts = useTcheStore((s) => s.auditLogs.filter((l) => l.whatsapp_alert_sent).length);
  const kegTaps = useTcheStore((s) => s.kegTaps);
  const kegAlerts = useMemo(() => kegTaps.filter((t) => t.active && kegStatus(t).alert === 'CRITICAL').length, [kegTaps]);
  const tenant = useTcheStore((s) => s.tenant);
  if (!tab) return <p className="p-6">Acesso restrito.</p>;
  return (
    <div className="mx-auto max-w-6xl px-3 pb-10 pt-3">
      <ReportHeader title={tabs.find((t) => t.key === tab)?.label ?? 'Retaguarda'} subtitle={`${tenant.name} · ${tenant.city}/${tenant.state}`} />
      <div className="scroll-thin -mx-3 mb-4 flex gap-2 overflow-x-auto px-3">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`flex min-h-touch shrink-0 items-center gap-2 rounded-xl px-4 font-bold ${tab === t.key ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-700'}`}>
            <t.icon className="h-4 w-4" /> {t.label}
            {t.key === 'audit' && alerts > 0 && <span className="rounded-full bg-brasa px-2 text-xs text-white">{alerts}</span>}
            {t.key === 'chopp' && kegAlerts > 0 && <span className="rounded-full bg-rose-600 px-2 text-xs text-white">{kegAlerts}</span>}
          </button>
        ))}
      </div>
      {tab === 'owner' && <OwnerDashboard onNavigate={navigate} />}
      {tab === 'fees' && <FeesReceivables />}
      {tab === 'entrega' && <OwnDeliveryAdmin />}
      {tab === 'dash' && <Dashboard />}
      {tab === 'recon' && <Reconciliation />}
      {tab === 'waiters' && <WaiterSplit />}
      {tab === 'audit' && <AuditCenter />}
      {tab === 'chopp' && <KegMonitorScreen compact />}
      {tab === 'crm' && <CrmPanel />}
      {tab === 'nfce' && <NfceList />}
      {tab === 'purchases' && <PurchaseImport />}
      {tab === 'menu' && <MenuAdmin />}
      {tab === 'tables' && (
        <>
          <TablesAdmin />
          <CardsAdmin />
        </>
      )}
      {tab === 'staff' && <StaffAdmin />}
      {tab === 'store' && <StoreAdmin />}
      {tab === 'cloud' && <CloudAdmin />}
      {tab === 'printers' && <PrinterSettings />}
      {tab === 'config' && <Config />}
    </div>
  );
}

function Kpi({ label, value, hint, tone = 'text-slate-900' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-black tabular-nums ${tone}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Dashboard() {
  const orders = useTcheStore((s) => s.orders);
  const payments = useTcheStore((s) => s.payments);
  const tables = useTcheStore((s) => s.tables);
  // Um só período para todos os números e a legenda: muda na virada das 05:00,
  // a cada minuto (registro que deixou de estar no futuro) e quando os dados mudam.
  const period = useShiftPeriod([orders, payments]);
  const k = useMemo(() => shiftKpis(orders, payments, period), [orders, payments, period]);
  const occupied = tables.filter((t) => t.status !== 'FREE' && t.status !== 'DIRTY').length;
  const recon = useMemo(() => reconciliation(payments, period), [payments, period]);
  const max = Math.max(1, ...recon.map((r) => r.total));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Faturamento bruto do turno" value={formatBRL(k.grossRevenue)} hint={`Σ aprovados desde ${formatShiftStart(period.start)}`} tone="text-verde" />
        <Kpi label="Ticket médio por mesa" value={formatBRL(k.averageTicket)} hint={`${k.closedOrders} conta(s) fechada(s)`} />
        <Kpi label="Taxa de serviço (10%)" value={formatBRL(k.serviceFeeTotal)} hint="Contas fechadas" tone="text-brasa" />
        <Kpi label="Mesas atendidas" value={String(k.tablesServed)} hint={`${occupied} ocupada(s) agora`} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Kpi label="Em aberto no salão" value={formatBRL(k.openBalance)} hint={`${k.openOrders} comanda(s) abertas`} tone="text-rose-600" />
        <div className="rounded-2xl border border-slate-200 bg-surface p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Entradas por adquirente</div>
          {recon.map((r) => (
            <div key={r.acquirer} className="mb-2">
              <div className="flex justify-between text-sm"><span>{r.acquirer === 'CASH_DESK' ? 'Dinheiro / Caixa' : r.acquirer === 'STONE' ? 'Stone' : 'PagBank'}</span><span className="tabular-nums">{formatBRL(r.total)}</span></div>
              <div className="h-3 rounded-full bg-base"><div className={`h-3 rounded-full ${r.acquirer === 'STONE' ? 'bg-stone' : r.acquirer === 'PAGBANK' ? 'bg-pagbank' : 'bg-slate-400'}`} style={{ width: `${(r.total / max) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Reconciliation() {
  const payments = useTcheStore((s) => s.payments);
  const period = useShiftPeriod([payments]);
  const rows = useMemo(() => reconciliation(payments, period), [payments, period]);
  const methods = ['CREDIT', 'DEBIT', 'PIX', 'CASH'] as const;
  const label = { CREDIT: 'Crédito', DEBIT: 'Débito', PIX: 'Pix', CASH: 'Dinheiro' } as const;
  const totals = methods.map((m) => rows.reduce((a, r) => a + r.byMethod[m], 0));
  const declined = useMemo(() => declinedInShift(payments, period), [payments, period]);
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-surface">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-base text-left text-xs uppercase text-slate-500">
            <tr><th className="p-3">Adquirente</th>{methods.map((m) => <th key={m} className="p-3 text-right">{label[m]}</th>)}<th className="p-3 text-right">Total</th><th className="p-3 text-right">Transações</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.acquirer} className="border-t border-slate-200">
                <td className="p-3">
                  <div className="font-bold">{r.acquirer === 'STONE' ? 'Stone' : r.acquirer === 'PAGBANK' ? 'PagBank' : 'Dinheiro / Caixa'}</div>
                  <div className="text-xs text-slate-500">{r.cnpj ? `CNPJ ${r.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}` : 'Gaveta do caixa'}</div>
                </td>
                {methods.map((m) => <td key={m} className="p-3 text-right tabular-nums">{formatBRL(r.byMethod[m])}</td>)}
                <td className="p-3 text-right font-bold tabular-nums">{formatBRL(r.total)}</td>
                <td className="p-3 text-right">{r.count}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-ouro font-black">
              <td className="p-3">Total</td>
              {totals.map((t, i) => <td key={i} className="p-3 text-right tabular-nums">{formatBRL(t)}</td>)}
              <td className="p-3 text-right tabular-nums text-brasa">{formatBRL(rows.reduce((a, r) => a + r.total, 0))}</td>
              <td className="p-3 text-right">{rows.reduce((a, r) => a + r.count, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-surface p-4 text-sm">
        <div className="mb-1 font-bold">Transações recusadas no turno: {declined.length}</div>
        {declined.map((p) => <div key={p.id} className="text-slate-500">{new Date(p.created_at).toLocaleTimeString('pt-BR')} · {p.acquirer} · {p.terminal_serial} · {formatBRL(p.amount)}</div>)}
      </div>
    </div>
  );
}

export function WaiterSplit() {
  const orders = useTcheStore((s) => s.orders);
  const items = useTcheStore((s) => s.orderItems);
  const staff = useTcheStore((s) => s.staff);
  const period = useShiftPeriod([orders, items, staff]);
  const rows = useMemo(() => waiterSplit(orders, items, staff, period), [orders, items, staff, period]);
  const total = rows.reduce((a, r) => a + r.commission, 0);
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-surface">
      <p className="p-3 text-xs text-slate-500">Base: contas fechadas no turno (desde {formatShiftStart(period.start)}). A taxa de serviço efetivamente cobrada de cada conta é rateada entre os garçons proporcionalmente ao que cada um lançou (sem perder centavos).</p>
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-base text-left text-xs uppercase text-slate-500">
          <tr><th className="p-3">Garçom</th><th className="p-3 text-right">Itens</th><th className="p-3 text-right">Total vendido</th><th className="p-3 text-right">Comissão 10%</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.waiter.id} className="border-t border-slate-200">
              <td className="p-3 font-bold">{r.waiter.name}</td>
              <td className="p-3 text-right">{r.itemsSold}</td>
              <td className="p-3 text-right tabular-nums">{formatBRL(r.sales)}</td>
              <td className="p-3 text-right font-bold tabular-nums text-brasa">{formatBRL(r.commission)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">Nenhuma conta fechada no turno ainda.</td></tr>}
          {rows.length > 0 && <tr className="border-t-2 border-ouro font-black"><td className="p-3" colSpan={3}>Total a ratear</td><td className="p-3 text-right tabular-nums">{formatBRL(total)}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AuditCenter() {
  const logs = useTcheStore((s) => s.auditLogs);
  const staff = useTcheStore((s) => s.staff);
  const tables = useTcheStore((s) => s.tables);
  const orders = useTcheStore((s) => s.orders);
  const impact = logs.reduce((a, l) => a + l.amount_impact, 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Ocorrências" value={String(logs.length)} />
        <Kpi label="Impacto financeiro" value={formatBRL(impact)} tone="text-rose-600" />
        <Kpi label="Cancelamentos" value={String(logs.filter((l) => l.action_type === 'ITEM_CANCELED').length)} />
        <Kpi label="PIN incorreto" value={String(logs.filter((l) => l.action_type.startsWith('MANAGER_PIN')).length)} tone="text-brasa" />
      </div>
      {logs.length === 0 && <p className="rounded-2xl bg-surface p-6 text-center text-slate-500">Nenhuma ocorrência registrada. Cancelamentos, remoção dos 10% e descontos aparecem aqui.</p>}
      {logs.map((l) => {
        const waiter = staff.find((s) => s.id === l.performed_by_user_id)?.name ?? '?';
        const manager = l.authorized_by_manager_id ? staff.find((s) => s.id === l.authorized_by_manager_id)?.name : null;
        const order = orders.find((o) => o.id === l.order_id);
        // Etapa 0: logs de cadastro (preço, equipe, permissão) não têm mesa.
        const table = l.order_id === null && l.metadata?.table === undefined ? 'Cadastro' : (l.metadata?.table as string | undefined) ?? tables.find((t) => t.id === order?.table_id)?.label ?? '?';
        const subject = typeof l.metadata?.staff_name === 'string' ? l.metadata.staff_name : typeof l.metadata?.product_code === 'string' ? `${l.metadata.product_code}` : null;
        const danger = l.action_type.startsWith('MANAGER_PIN');
        return (
          <article key={l.id} className={`grid gap-3 rounded-2xl border p-4 lg:grid-cols-[1fr_340px] ${danger ? 'border-brasa bg-brasa/10' : 'border-slate-200 bg-surface'}`}>
            <div className="text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                {danger && <AlertTriangle className="h-4 w-4 text-rose-600" />}
                <Badge className={danger ? 'bg-brasa text-white' : 'bg-ouro text-slate-950'}>{AUDIT_LABEL[l.action_type]}</Badge>
                <span className="text-slate-500">{new Date(l.created_at).toLocaleString('pt-BR')}</span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-slate-500">Mesa</dt><dd className="font-bold">{table}</dd>
                <dt className="text-slate-500">{l.order_id ? 'Garçom solicitante' : 'Feito por'}</dt><dd>{waiter}</dd>
                <dt className="text-slate-500">Gerente (PIN)</dt><dd>{manager ?? <span className="text-rose-600">não autorizado</span>}</dd>
                <dt className="text-slate-500">Impacto</dt><dd className="font-bold tabular-nums text-rose-600">{formatBRL(l.amount_impact)}</dd>
                {subject && (<><dt className="text-slate-500">Cadastro de</dt><dd>{subject}</dd></>)}
                {l.action_type === 'PRODUCT_PRICE_CHANGED' && (<><dt className="text-slate-500">Preço</dt><dd className="tabular-nums">{formatBRL(Number(l.metadata?.price_before))} → {formatBRL(Number(l.metadata?.price_after))}</dd></>)}
                <dt className="text-slate-500">Justificativa</dt><dd>{l.reason}</dd>
                {typeof l.metadata?.product_name === 'string' && (<><dt className="text-slate-500">Item</dt><dd>{String(l.metadata.quantity)}x {l.metadata.product_name} ({String(l.metadata.item_status_before)})</dd></>)}
              </dl>
            </div>
            <div className="rounded-2xl bg-[#0b141a] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-emerald-600"><MessageCircle className="h-4 w-4" /> WhatsApp do Proprietário {l.whatsapp_alert_sent ? '· enviado ✓✓' : '· sem alerta'}</div>
              <div className="whitespace-pre-wrap rounded-lg rounded-tl-none bg-[#005c4b] p-2 text-xs text-white">{whatsappAlertText(l, staff, tables, orders)}</div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function NfceList() {
  const orders = useTcheStore((s) => s.orders);
  const tables = useTcheStore((s) => s.tables);
  const cloud = useTcheStore(isRealFiscalStore);
  const records = useTcheStore((s) => s.nfceCloud);
  // Nuvem: toda conta fechada com valor tem NFC-e real (mesmo pendente, sem chave ainda).
  const closed = orders
    .filter((o) => o.status === 'CLOSED' && (o.nfce_key || (cloud && toCents(o.total_amount) > 0 && o.nfce_status !== 'DISPENSADA')))
    .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {closed.length === 0 && <p className="rounded-2xl bg-surface p-6 text-center text-slate-500">Feche uma conta (saldo R$ 0,00) para gerar a NFC-e modelo 65.</p>}
      {closed.map((o) => (
        <button key={o.id} onClick={() => setOpen(o.id)} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-surface p-4 text-left">
          <div className="min-w-0">
            <div className="font-bold">{o.nfce_key ? `NFC-e nº ${(records ?? {})[o.id]?.number ?? Number(o.nfce_key.slice(25, 34))}` : 'NFC-e'} · {tables.find((t) => t.id === o.table_id)?.label}</div>
            {o.nfce_key && <div className="truncate font-mono text-xs text-slate-500">{o.nfce_key}</div>}
            <div className="text-xs text-slate-500">{o.closed_at ? new Date(o.closed_at).toLocaleString('pt-BR') : ''} · {cloud ? nfceCloudLabel(o, (records ?? {})[o.id], false) : o.nfce_status}</div>
          </div>
          <div className="text-right font-black tabular-nums text-verde">{formatBRL(o.total_amount)}</div>
        </button>
      ))}
      {open && <NfceViewer orderId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Config() {
  const s = useTcheStore();
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-2xl border border-slate-200 bg-surface p-4">
        <h3 className="mb-2 font-bold">Pizza meio-a-meio</h3>
        <div className="grid grid-cols-2 gap-2">
          <Btn variant={s.tenant.half_and_half_pricing === 'HIGHEST' ? 'gold' : 'secondary'} onClick={() => s.setHalfAndHalfPricing('HIGHEST')}>Cobrar o maior</Btn>
          <Btn variant={s.tenant.half_and_half_pricing === 'AVERAGE' ? 'gold' : 'secondary'} onClick={() => s.setHalfAndHalfPricing('AVERAGE')}>Cobrar a média</Btn>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-surface p-4">
        <h3 className="mb-2 font-bold">Alertas</h3>
        <div className="grid grid-cols-2 gap-2">
          <Btn variant={s.soundEnabled ? 'success' : 'secondary'} onClick={() => s.setSoundEnabled(!s.soundEnabled)}>Som {s.soundEnabled ? 'ligado' : 'desligado'}</Btn>
          <Btn variant={s.showPrintSimulator ? 'success' : 'secondary'} onClick={() => s.setShowPrintSimulator(!s.showPrintSimulator)}>Simulador de impressão {s.showPrintSimulator ? 'on' : 'off'}</Btn>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-surface p-4">
        <h3 className="mb-1 font-bold">Fila offline-first</h3>
        <p className="mb-2 text-sm text-slate-500">{s.outbox.length} evento(s) gravados no IndexedDB {s.cloud ? 'aguardando envio ao Supabase (aba Nuvem).' : 'prontos para sincronizar. Conecte o aparelho na aba Nuvem.'}</p>
      </div>
      <div className="rounded-2xl border border-brasa/50 bg-surface p-4">
        <h3 className="mb-1 font-bold">Demonstração</h3>
        <p className="mb-2 text-sm text-slate-500">Volta ao seed do Galpão Crioulo (apaga comandas, pagamentos e auditoria deste aparelho).</p>
        {s.cloud ? (
          <p className="text-sm text-brasa">Aparelho ligado à nuvem de uma loja real: a demonstração fica bloqueada. Desconecte na aba Nuvem primeiro.</p>
        ) : (
          <Btn variant="danger" onClick={() => { if (window.confirm('Restaurar dados de demonstração?')) { s.resetDemo(); toast.info('Dados de demonstração restaurados.'); } }}>Restaurar seed</Btn>
        )}
      </div>
    </div>
  );
}
