/**
 * Caixa: abrir com fundo de troco, suprimento, sangria (PIN de gerente) e fechamento cego.
 * No fechamento o operador digita o que contou antes de ver o esperado; o perfil Caixa
 * nunca vê o esperado da gaveta. Diferença (sobra ou falta) só fecha com PIN de gerente.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, EyeOff, Lock, Printer, Unlock, Wallet } from 'lucide-react';
import { Badge, Btn, Sheet, toast } from '../components/ui';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { CASH_ROLES, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { useTerminalBus } from '../lib/payments/drivers';
import { formatBRL } from '../lib/money';
import { shiftStart } from '../lib/reports';
import { cashOutsideSessions, cashSummary, closingDifference, closingReceiptLines, parseMoneyInput, validCashAmount } from '../lib/cashRegister';
import type { CashSession } from '../types';

const SUPPLY_REASONS = ['Troco do banco', 'Troco trazido pelo gerente', 'Reforço de troco'];
const WITHDRAWAL_REASONS = ['Depósito no banco', 'Pagamento de fornecedor', 'Excesso de dinheiro na gaveta', 'Vale para funcionário'];

const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function MoneyField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-700">{label}</span>
      <div className="mt-1 flex items-center rounded-xl border border-slate-300 bg-base px-3 focus-within:border-brasa">
        <span className="text-slate-500">R$</span>
        <input
          inputMode="decimal"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0,00"
          className="min-h-touch w-full bg-transparent px-2 text-xl font-black outline-none"
        />
      </div>
    </label>
  );
}

function printClosing(session: CashSession) {
  const s = useTcheStore.getState();
  const summary = cashSummary(session, s.payments, s.cashMovements, session.closed_at ? new Date(session.closed_at) : new Date());
  useTerminalBus.getState().enqueuePrint({
    title: 'Fechamento de caixa',
    lines: closingReceiptLines({ tenant: s.tenant, session, summary, movements: s.cashMovements, staff: s.staff }),
    chassis: useTerminalBus.getState().chassis,
  });
}

export function CashRegisterScreen() {
  const user = useTcheStore(selectCurrentUser);
  const sessions = useTcheStore((s) => s.cashSessions);
  const movements = useTcheStore((s) => s.cashMovements);
  const payments = useTcheStore((s) => s.payments);
  const staff = useTcheStore((s) => s.staff);
  const openCashSession = useTcheStore((s) => s.openCashSession);
  const addCashSupply = useTcheStore((s) => s.addCashSupply);
  const addCashWithdrawal = useTcheStore((s) => s.addCashWithdrawal);
  const closeCashSession = useTcheStore((s) => s.closeCashSession);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [floatRaw, setFloatRaw] = useState('');
  const [supplyOpen, setSupplyOpen] = useState(false);
  const [supplyRaw, setSupplyRaw] = useState('');
  const [supplyReason, setSupplyReason] = useState('');
  const [wdOpen, setWdOpen] = useState(false);
  const [wdRaw, setWdRaw] = useState('');
  const [wdAuthOpen, setWdAuthOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [countedRaw, setCountedRaw] = useState('');
  const [notes, setNotes] = useState('');
  /** Diferença mostrada depois que o operador confirmou a contagem (fechamento cego). */
  const [pendingDiff, setPendingDiff] = useState<number | null>(null);
  const [closeAuthOpen, setCloseAuthOpen] = useState(false);

  const open = sessions.find((c) => c.status === 'OPEN') ?? null;
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const summary = useMemo(() => (open ? cashSummary(open, payments, movements, now) : null), [open, payments, movements, now]);
  const outside = useMemo(() => cashOutsideSessions(payments, sessions, shiftStart(now), now), [payments, sessions, now]);
  const name = (id: string | null) => (id ? staff.find((u) => u.id === id)?.name ?? '?' : '-');
  const history = sessions.filter((c) => c.status === 'CLOSED').slice(0, 10);

  if (!user || !CASH_ROLES.includes(user.role)) {
    return <div className="p-6 text-center text-slate-500">Só caixa, gerente ou proprietário acessa o caixa.</div>;
  }

  const doOpen = () => {
    const v = parseMoneyInput(floatRaw || '0');
    const r = openCashSession(v);
    if (!r.ok) return toast.error(r.error);
    setFloatRaw('');
    toast.success(`Caixa aberto com ${formatBRL(r.data.opening_float)} de troco.`);
  };

  const doSupply = () => {
    const r = addCashSupply(parseMoneyInput(supplyRaw), supplyReason);
    if (!r.ok) return toast.error(r.error);
    setSupplyOpen(false);
    setSupplyRaw('');
    setSupplyReason('');
    toast.success(`Suprimento de ${formatBRL(r.data.amount)} lançado.`);
  };

  const wdAmount = parseMoneyInput(wdRaw);
  const startWithdrawal = () => {
    if (!validCashAmount(wdAmount)) return toast.error('Informe um valor maior que zero.');
    setWdOpen(false);
    setWdAuthOpen(true);
  };

  const counted = parseMoneyInput(countedRaw);
  const confirmCount = () => {
    if (!open || !validCashAmount(counted, true)) return toast.error('Informe quanto dinheiro foi contado na gaveta.');
    const r = closeCashSession(counted, notes, null);
    if (r.ok) return finishClose(r.data);
    // Sem PIN o store só recusa por diferença; mostra a diferença agora (depois da contagem).
    const expected = cashSummary(open, useTcheStore.getState().payments, useTcheStore.getState().cashMovements).expected;
    const diff = closingDifference(counted, expected);
    if (diff === 0) return toast.error(r.error);
    setPendingDiff(diff);
  };

  const finishClose = (closed: CashSession) => {
    setCloseOpen(false);
    setCloseAuthOpen(false);
    setPendingDiff(null);
    setCountedRaw('');
    setNotes('');
    toast.success('Caixa fechado. Cupom de fechamento enviado para a impressora.');
    printClosing(closed);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-verde/10 text-verde"><Wallet className="h-6 w-6" /></div>
        <div className="mr-auto">
          <h1 className="text-xl font-black">Caixa</h1>
          <p className="text-sm text-slate-500">{open ? `Aberto às ${time(open.opened_at)} por ${name(open.opened_by_user_id)}` : 'Fechado'}</p>
        </div>
        <Badge className={open ? 'bg-verde/15 text-verde' : 'bg-slate-200 text-slate-600'}>{open ? 'ABERTO' : 'FECHADO'}</Badge>
      </div>

      {outside.count > 0 && (
        <div role="alert" className="rounded-2xl border border-amarelo bg-amarelo/15 p-3 text-sm">
          <b>{formatBRL(outside.amount)}</b> em dinheiro ({outside.count} pagamento{outside.count > 1 ? 's' : ''}) recebido{outside.count > 1 ? 's' : ''} hoje com o caixa fechado. Esse valor não entra em nenhum fechamento: confira a gaveta.
        </div>
      )}

      {!open && (
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-base p-4 shadow-sm">
          <h2 className="flex items-center gap-2 font-black"><Unlock className="h-5 w-5 text-verde" /> Abrir caixa</h2>
          <MoneyField label="Fundo de troco na gaveta" value={floatRaw} onChange={setFloatRaw} autoFocus />
          <Btn variant="success" size="lg" block onClick={doOpen}>Abrir caixa</Btn>
        </section>
      )}

      {open && summary && (
        <>
          {/* O caixa não vê os totais: com eles daria para calcular o esperado (fechamento cego). */}
          {isManager && (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Fundo de troco" value={summary.openingFloat} />
              <Tile label={`Dinheiro (${summary.cashSalesCount})`} value={summary.cashSales} />
              <Tile label="Suprimentos" value={summary.supplies} />
              <Tile label="Sangrias" value={-summary.withdrawals} />
            </section>
          )}
          <section className="rounded-2xl border border-slate-200 bg-base p-4 shadow-sm">
            {isManager ? (
              <div className="flex items-baseline justify-between">
                <span className="font-bold text-slate-600">Esperado na gaveta agora</span>
                <span className="text-2xl font-black">{formatBRL(summary.expected)}</span>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-slate-600"><EyeOff className="h-4 w-4" /> Fechamento cego: o esperado na gaveta só aparece para o gerente.</p>
            )}
          </section>
          <section className="grid grid-cols-3 gap-2">
            <Btn variant="secondary" onClick={() => setSupplyOpen(true)}><ArrowDownCircle className="h-5 w-5 text-verde" /> Suprimento</Btn>
            <Btn variant="secondary" onClick={() => setWdOpen(true)}><ArrowUpCircle className="h-5 w-5 text-brasa" /> Sangria</Btn>
            <Btn variant="danger" onClick={() => { setPendingDiff(null); setCloseOpen(true); }}><Lock className="h-5 w-5" /> Fechar</Btn>
          </section>
          <section className="rounded-2xl border border-slate-200 bg-base p-4 shadow-sm">
            <h2 className="mb-2 font-black">Movimentos</h2>
            {movements.filter((m) => m.session_id === open.id).length === 0 ? (
              <p className="text-sm text-slate-500">Nenhum suprimento ou sangria neste caixa.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {movements.filter((m) => m.session_id === open.id).map((m) => (
                  <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="w-12 text-slate-500">{time(m.created_at)}</span>
                    <span className="mr-auto">
                      <b>{m.type === 'SUPPLY' ? 'Suprimento' : 'Sangria'}</b> · {m.reason}
                      {m.authorized_by_manager_id && <span className="text-slate-500"> · autorizado por {name(m.authorized_by_manager_id)}</span>}
                    </span>
                    <span className={`font-black ${m.type === 'SUPPLY' ? 'text-verde' : 'text-brasa'}`}>{m.type === 'SUPPLY' ? '+' : '−'}{formatBRL(m.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {isManager && history.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-base p-4 shadow-sm">
          <h2 className="mb-2 font-black">Caixas fechados</h2>
          <ul className="divide-y divide-slate-100">
            {history.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="mr-auto">
                  {dateTime(c.opened_at)} → {c.closed_at ? time(c.closed_at) : '-'} · {name(c.closed_by_user_id)}
                </span>
                <span className={`font-black ${(c.difference ?? 0) < 0 ? 'text-brasa' : (c.difference ?? 0) > 0 ? 'text-verde' : 'text-slate-600'}`}>
                  {(c.difference ?? 0) === 0 ? 'sem diferença' : `${(c.difference ?? 0) < 0 ? 'faltou' : 'sobrou'} ${formatBRL(Math.abs(c.difference ?? 0))}`}
                </span>
                <button aria-label="Reimprimir fechamento" onClick={() => printClosing(c)} className="grid h-11 w-11 place-items-center rounded-xl bg-surface"><Printer className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Sheet
        open={supplyOpen}
        onClose={() => setSupplyOpen(false)}
        title="Suprimento (entrada de dinheiro)"
        footer={<Btn variant="success" block onClick={doSupply}>Lançar suprimento</Btn>}
      >
        <div className="space-y-3">
          <MoneyField label="Valor" value={supplyRaw} onChange={setSupplyRaw} autoFocus />
          <label className="block">
            <span className="text-sm font-bold text-slate-700">Motivo</span>
            <input value={supplyReason} onChange={(e) => setSupplyReason(e.target.value)} className="mt-1 min-h-touch w-full rounded-xl border border-slate-300 px-3" />
          </label>
          <div className="flex flex-wrap gap-2">
            {SUPPLY_REASONS.map((r) => <button key={r} onClick={() => setSupplyReason(r)} className="rounded-full bg-surface px-3 py-2 text-sm font-semibold">{r}</button>)}
          </div>
        </div>
      </Sheet>

      <Sheet
        open={wdOpen}
        onClose={() => setWdOpen(false)}
        title="Sangria (retirada de dinheiro)"
        footer={<Btn variant="danger" block onClick={startWithdrawal}>Continuar com PIN do gerente</Btn>}
      >
        <div className="space-y-3">
          <MoneyField label="Valor retirado da gaveta" value={wdRaw} onChange={setWdRaw} autoFocus />
          <p className="text-sm text-slate-500">A sangria precisa do PIN do gerente e de um motivo, e fica no histórico de auditoria.</p>
        </div>
      </Sheet>

      <ManagerAuthSheet
        open={wdAuthOpen}
        onClose={() => setWdAuthOpen(false)}
        title="Autorizar sangria"
        summary={<span>Retirar <b>{validCashAmount(wdAmount) ? formatBRL(wdAmount) : '-'}</b> da gaveta.</span>}
        confirmLabel="Autorizar sangria"
        quickReasons={WITHDRAWAL_REASONS}
        successMessage="Sangria lançada."
        onSubmit={(managerPin, reason) => addCashWithdrawal(wdAmount, { managerPin, reason })}
        onSuccess={() => { setWdAuthOpen(false); setWdRaw(''); }}
      />

      <Sheet
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title="Fechar caixa"
        footer={
          pendingDiff === null ? (
            <Btn variant="danger" block onClick={confirmCount}>Confirmar contagem</Btn>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Btn variant="secondary" onClick={() => setPendingDiff(null)}>Contar de novo</Btn>
              <Btn variant="danger" onClick={() => setCloseAuthOpen(true)}>Chamar gerente</Btn>
            </div>
          )
        }
      >
        <div className="space-y-3">
          {pendingDiff === null ? (
            <>
              <p className="text-sm text-slate-600">Conte todo o dinheiro da gaveta (troco incluído) e digite o total. O sistema só mostra a diferença depois.</p>
              <MoneyField label="Dinheiro contado na gaveta" value={countedRaw} onChange={setCountedRaw} autoFocus />
              <label className="block">
                <span className="text-sm font-bold text-slate-700">Observação (opcional)</span>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 min-h-touch w-full rounded-xl border border-slate-300 px-3" />
              </label>
            </>
          ) : (
            isManager ? (
              <div role="alert" className={`rounded-2xl p-4 text-center ${pendingDiff < 0 ? 'bg-brasa/10 text-brasa' : 'bg-verde/10 text-verde'}`}>
                <div className="text-sm font-bold">{pendingDiff < 0 ? 'Faltou dinheiro' : 'Sobrou dinheiro'}</div>
                <div className="text-3xl font-black">{formatBRL(Math.abs(pendingDiff))}</div>
                <p className="mt-2 text-sm text-slate-600">Conte de novo ou feche com a diferença (PIN de gerente + motivo).</p>
              </div>
            ) : (
              // Fechamento cego: o caixa não fica sabendo quanto nem para que lado, senão
              // bastaria digitar o esperado na segunda contagem.
              <div role="alert" className="rounded-2xl bg-amarelo/15 p-4 text-center">
                <div className="text-lg font-black">A contagem não bateu</div>
                <p className="mt-2 text-sm text-slate-600">Conte a gaveta de novo. Se continuar diferente, chame o gerente: ele vê a diferença e fecha com o PIN.</p>
              </div>
            )
          )}
        </div>
      </Sheet>

      <ManagerAuthSheet
        open={closeAuthOpen}
        onClose={() => setCloseAuthOpen(false)}
        title="Fechar caixa com diferença"
        summary={pendingDiff !== null && <span>{pendingDiff < 0 ? 'Falta' : 'Sobra'} de <b>{formatBRL(Math.abs(pendingDiff))}</b> no fechamento.</span>}
        confirmLabel="Fechar com diferença"
        quickReasons={['Troco dado errado', 'Pagamento lançado no método errado', 'Diferença não encontrada']}
        successMessage="Caixa fechado com diferença. Proprietário avisado."
        onSubmit={(managerPin, reason) => closeCashSession(counted, notes, { managerPin, reason })}
        onSuccess={finishClose}
      />
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-base p-3 shadow-sm">
      <div className="text-xs font-bold text-slate-500">{label}</div>
      <div className={`text-lg font-black ${value < 0 ? 'text-brasa' : ''}`}>{value < 0 ? '−' : ''}{formatBRL(Math.abs(value))}</div>
    </div>
  );
}
