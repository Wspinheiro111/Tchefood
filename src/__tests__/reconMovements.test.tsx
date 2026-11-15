// @vitest-environment jsdom
/**
 * Auditoria GPT r10 do PR #49, P2-01 e P2-02: a conciliação trata venda e estorno como movimentos com data
 * própria. A venda conta no turno em que foi feita (mesmo estornada depois); o estorno conta no turno da data
 * do estorno no servidor; sem data confirmada, fica à parte ("estorno sem data confirmada").
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentShiftPeriod,
  loadServerPointPayments,
  reconciliationMovements,
  writeOffsByOrder,
  shiftStartBrasilia,
  type ShiftPeriod,
} from '../lib/reports';
import type { ListPointPaymentsInput, ListPointPaymentsResult, ListPointRefundsInput, ServerPointPayment } from '../lib/payments/pointPaymentsServer';
import { Dashboard, RECON_REFRESH_MS, Reconciliation } from '../screens/BackOffice';
import { useTcheStore } from '../store/useTcheStore';
import type { AuditLog, Payment } from '../types';

const BRT = (iso: string) => new Date(`${iso}-03:00`);
const shiftOf = (iso: string): ShiftPeriod => {
  const start = shiftStartBrasilia(BRT(iso));
  return { start, end: shiftStartBrasilia(new Date(start.getTime() + 36 * 3600_000)) };
};
const DAY14 = shiftOf('2026-11-14T12:00:00');
const DAY15 = shiftOf('2026-11-15T12:00:00');
const BOTH: ShiftPeriod = { start: DAY14.start, end: DAY15.end };

const pay = (id: string, created: string, over: Partial<Payment> = {}): Payment => ({
  id, order_id: `o-${id}`, tenant_id: 't', waiter_id: 'w', terminal_id: null, amount: 100, tip_amount: 0, method: 'CREDIT',
  status: 'APPROVED', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191', card_brand: 'VISA', nsu: `NSU${id}`,
  authorization_code: 'A1', terminal_serial: 'N1', idempotency_key: `k-${id}`, created_at: BRT(created).toISOString(), ...over,
});
const server = (p: Payment, refundedAt: string | null, status = refundedAt ? 'REFUNDED' : p.status): ServerPointPayment => ({
  payment_id: p.id, order_id: p.order_id, charge_id: 'c', idempotency_key: p.idempotency_key ?? '', amount: p.amount, method: p.method,
  nsu: p.nsu, authorization_code: p.authorization_code, status, created_at: p.created_at,
  refunded_at: refundedAt ? BRT(refundedAt).toISOString() : null, refund_audit_id: refundedAt ? 'a1' : null, refunded_by_manager_id: null,
});
const mpRow = (r: ReturnType<typeof reconciliationMovements>) => r.rows.find((x) => x.acquirer === 'MERCADO_PAGO');

describe('P2-01: venda e estorno são movimentos com data própria', () => {
  const sale = pay('s1', '2026-11-14T20:00:00', { status: 'REFUNDED' });
  const serverRows = [server(sale, '2026-11-15T13:00:00')];

  it('venda 14/11, estorno 15/11: 14/11 bruto 100, estorno 0, líquido 100; 15/11 bruto 0, estorno 100, líquido −100', () => {
    const d14 = reconciliationMovements([sale], DAY14, { serverPayments: serverRows });
    expect(mpRow(d14)).toMatchObject({ gross: 100, refunds: 0, net: 100, salesCount: 1, refundsCount: 0 });
    expect(mpRow(d14)!.byMethod.CREDIT).toEqual({ gross: 100, refunds: 0, net: 100 });
    const d15 = reconciliationMovements([sale], DAY15, { serverPayments: serverRows });
    expect(mpRow(d15)).toMatchObject({ gross: 0, refunds: 100, net: -100, salesCount: 0, refundsCount: 1 });
    expect(mpRow(d15)!.byMethod.CREDIT).toEqual({ gross: 0, refunds: 100, net: -100 });
    expect(d14.totals.net + d15.totals.net).toBe(0);
    expect(d14.undatedRefunds.count + d15.undatedRefunds.count).toBe(0);
  });

  it('mesmo turno: bruto 100, estorno 100, líquido 0', () => {
    const r = reconciliationMovements([sale], BOTH, { serverPayments: serverRows });
    expect(mpRow(r)).toMatchObject({ gross: 100, refunds: 100, net: 0 });
    expect(r.totals).toMatchObject({ gross: 100, refunds: 100, net: 0 });
  });

  it('pagamento retirado pelo gerente ("não aceito pela nuvem") nunca foi recebido: não é venda nem estorno', () => {
    const withdrawn = pay('w1', '2026-11-14T20:00:00', { status: 'REFUNDED', acquirer: 'STONE', withdrawn_reason: 'não aceito pela nuvem' });
    const r = reconciliationMovements([withdrawn], BOTH, { serverPayments: [] });
    expect(r.totals).toMatchObject({ gross: 0, refunds: 0, net: 0, salesCount: 0, refundsCount: 0 });
    expect(r.undatedRefunds.count).toBe(0);
  });

  it('aprovado conta como venda no turno da venda; recusado e pendente não contam', () => {
    const ok = pay('a', '2026-11-14T10:00:00', { acquirer: 'STONE', method: 'DEBIT', amount: 30 });
    const no = pay('b', '2026-11-14T10:00:00', { acquirer: 'STONE', status: 'DECLINED' });
    const pend = pay('c', '2026-11-14T10:00:00', { acquirer: 'STONE', status: 'PENDING' });
    const r = reconciliationMovements([ok, no, pend], DAY14, { serverPayments: [] });
    expect(r.rows.find((x) => x.acquirer === 'STONE')).toMatchObject({ gross: 30, refunds: 0, net: 30, salesCount: 1 });
    expect(r.rows.map((x) => x.acquirer)).toEqual(['STONE', 'PAGBANK', 'CASH_DESK']);
  });
});

describe('P2-02: a data do estorno é a do servidor', () => {
  const sale = pay('s2', '2026-11-14T20:00:00', { status: 'REFUNDED' });
  // Registro deste aparelho no dia 15: não é a data confirmada do estorno.
  const localLog = { id: 'l', action_type: 'POINT_PAYMENT_REFUNDED', created_at: BRT('2026-11-15T09:00:00').toISOString(), metadata: { payment_id: 's2' } } as unknown as AuditLog;

  it('nuvem não carregada: o estorno fica em "sem data confirmada", não no turno da venda nem no do registro local', () => {
    for (const period of [DAY14, DAY15]) {
      const r = reconciliationMovements([sale], period, { serverPayments: null, logs: [localLog] });
      expect(mpRow(r)?.refunds ?? 0).toBe(0);
      expect(r.cloudRefunds).toBe('NOT_LOADED');
    }
    const d14 = reconciliationMovements([sale], DAY14, { serverPayments: null, logs: [localLog] });
    expect(mpRow(d14)).toMatchObject({ gross: 100, net: 100 });
    expect(d14.undatedRefunds).toMatchObject({ total: 100, count: 1 });
    expect(d14.undatedRefunds.payments.map((p) => p.id)).toEqual(['s2']);
  });

  it('nuvem carregada sem data do estorno (ou data inválida): sem data confirmada', () => {
    for (const refunded_at of [null, 'ontem', '2026-11-15T13:00:00']) {
      const row = { ...server(sale, null, 'REFUNDED'), refunded_at };
      const r = reconciliationMovements([sale], BOTH, { serverPayments: [row] });
      expect(mpRow(r)!.refunds).toBe(0);
      expect(r.undatedRefunds.count).toBe(1);
      expect(r.cloudRefunds).toBe('LOADED');
    }
  });

  it('servidor diz estornado e este aparelho ainda não espelhou: o estorno conta na data do servidor', () => {
    const local = pay('s3', '2026-11-14T20:00:00');
    const r = reconciliationMovements([local], DAY15, { serverPayments: [server(local, '2026-11-15T13:00:00')] });
    expect(mpRow(r)).toMatchObject({ gross: 0, refunds: 100, net: -100 });
  });

  it('estorno sem data não aparece num turno anterior à venda', () => {
    const later = pay('s4', '2026-11-15T20:00:00', { status: 'REFUNDED' });
    expect(reconciliationMovements([later], DAY14, { serverPayments: null }).undatedRefunds.count).toBe(0);
    expect(reconciliationMovements([later], DAY15, { serverPayments: null }).undatedRefunds.count).toBe(1);
  });

  it('"Vendas devolvidas encerradas pelo gerente": soma os ORDER_REFUNDED_WRITE_OFF do turno', () => {
    const wo = (id: string, at: string, amount: number) =>
      ({ id, action_type: 'ORDER_REFUNDED_WRITE_OFF', order_id: `o-${id}`, amount_impact: -amount, created_at: BRT(at).toISOString(), metadata: { amount } }) as unknown as AuditLog;
    const r = reconciliationMovements([], DAY15, { serverPayments: [], logs: [wo('x', '2026-11-15T10:00:00', 40), wo('y', '2026-11-14T10:00:00', 7), localLog] });
    expect(r.writeOffs).toEqual({ total: 40, count: 1 });
  });
});

describe('loadServerPointPayments: vendas do período e estornos do período (pela data do estorno), todas as páginas', () => {
  const sale = pay('s5', '2026-11-14T20:00:00');
  const item = server(sale, '2026-11-15T13:00:00');
  const noRefunds = async (): Promise<ListPointPaymentsResult> => ({ kind: 'ok', items: [], nextCursor: null });

  it('vendas: todas as páginas com a venda no período; estornos: todas as páginas com o estorno no período', async () => {
    const calls: ListPointPaymentsInput[] = [];
    const rcalls: ListPointRefundsInput[] = [];
    const list = async (input: ListPointPaymentsInput): Promise<ListPointPaymentsResult> => {
      calls.push(input);
      return input.cursor === null ? { kind: 'ok', items: [item], nextCursor: 'c2' } : { kind: 'ok', items: [{ ...item, payment_id: 'other' }], nextCursor: null };
    };
    const old = server(pay('old', '2026-10-01T20:00:00'), '2026-11-15T10:00:00');
    const refunds = async (input: ListPointRefundsInput): Promise<ListPointPaymentsResult> => {
      rcalls.push(input);
      return input.cursor === null ? { kind: 'ok', items: [old], nextCursor: 'r2' } : { kind: 'ok', items: [], nextCursor: null };
    };
    const out = await loadServerPointPayments(DAY15, list, refunds);
    expect(out.map((r) => r.payment_id)).toEqual(['s5', 'other', 'old']);
    expect(calls[0]).toMatchObject({ from: DAY15.start.toISOString(), to: DAY15.end.toISOString(), search: null, cursor: null });
    expect(calls[1]).toMatchObject({ cursor: 'c2' });
    expect(rcalls[0]).toMatchObject({ from: DAY15.start.toISOString(), to: DAY15.end.toISOString(), cursor: null });
    expect(rcalls[1]).toMatchObject({ cursor: 'r2' });
  });

  it('erro em qualquer página (vendas ou estornos) ou cursor que não acaba: lança (a tela mostra "não carregados")', async () => {
    await expect(loadServerPointPayments(DAY15, async () => ({ kind: 'error', error: 'sem rede' }), noRefunds)).rejects.toThrow(/sem rede/);
    await expect(loadServerPointPayments(DAY15, noRefunds, async () => ({ kind: 'error', error: 'estornos fora' }))).rejects.toThrow(/estornos fora/);
    let n = 0;
    const second = async (): Promise<ListPointPaymentsResult> => (n++ === 0 ? { kind: 'ok', items: [item], nextCursor: 'x' } : { kind: 'error', error: 'caiu' });
    await expect(loadServerPointPayments(DAY15, second, noRefunds)).rejects.toThrow(/caiu/);
    const endless = async (input: { cursor: string | null }): Promise<ListPointPaymentsResult> => ({ kind: 'ok', items: [], nextCursor: `${input.cursor ?? ''}x` });
    await expect(loadServerPointPayments(DAY15, endless, noRefunds)).rejects.toThrow(/páginas/);
  });
});

describe('GPT r11 P2-01: venda antiga estornada hoje', () => {
  const OLD = shiftOf('2026-10-06T12:00:00'); // 40 dias antes do dia 15
  const refundRow = (p: Payment) => server(p, '2026-11-15T13:00:00');

  it('venda de 40 dias estornada hoje (aqui já REFUNDED ou ainda APPROVED): hoje estorno 100 e líquido −100; no dia da venda continua a venda', () => {
    for (const status of ['REFUNDED', 'APPROVED'] as const) {
      const old = pay(`v40-${status}`, '2026-10-06T20:00:00', { status });
      const today = reconciliationMovements([old], DAY15, { serverPayments: [refundRow(old)] });
      expect(mpRow(today), status).toMatchObject({ gross: 0, refunds: 100, net: -100, refundsCount: 1 });
      expect(today.undatedRefunds.count).toBe(0);
      // No dia da venda: a leitura daquele dia traz a venda (com a data do estorno, que é de outro dia).
      const thatDay = reconciliationMovements([old], OLD, { serverPayments: [refundRow(old)] });
      expect(mpRow(thatDay), status).toMatchObject({ gross: 100, refunds: 0, net: 100 });
    }
  });

  it('com a nuvem lida, estornado daqui de venda antiga que o servidor não listou (estorno de outro dia) não vira "sem data" todo dia', () => {
    const old = pay('v40-b', '2026-10-06T20:00:00', { status: 'REFUNDED' });
    const r = reconciliationMovements([old], DAY15, { serverPayments: [] });
    expect(mpRow(r)?.refunds ?? 0).toBe(0);
    expect(r.undatedRefunds.count).toBe(0);
    // Venda do próprio período estornada aqui e ausente do servidor (não subiu): sem data, à vista.
    const fresh = pay('v-fresh', '2026-11-15T10:00:00', { status: 'REFUNDED' });
    expect(reconciliationMovements([fresh], DAY15, { serverPayments: [] }).undatedRefunds.count).toBe(1);
  });
});

describe('GPT r11 P2-03: pagamento que só o servidor tem', () => {
  it('venda e estorno de outro aparelho entram uma vez; depois que o pagamento chega aqui, não duplica', () => {
    const other = pay('remote', '2026-11-15T10:00:00', { status: 'REFUNDED' });
    const rows = [server(other, null, 'APPROVED'), server(other, '2026-11-15T13:00:00')]; // das duas leituras
    const before = reconciliationMovements([], DAY15, { serverPayments: rows });
    expect(mpRow(before)).toMatchObject({ gross: 100, refunds: 100, net: 0, salesCount: 1, refundsCount: 1 });
    const after = reconciliationMovements([other], DAY15, { serverPayments: rows });
    expect(mpRow(after)).toMatchObject({ gross: 100, refunds: 100, net: 0, salesCount: 1, refundsCount: 1 });
    // Venda antiga de outro aparelho estornada hoje: só o estorno, hoje.
    const old = pay('remote-old', '2026-10-06T20:00:00');
    expect(mpRow(reconciliationMovements([], DAY15, { serverPayments: [server(old, '2026-11-15T13:00:00')] }))).toMatchObject({ gross: 0, refunds: 100, net: -100 });
    // Estornado no servidor sem data: sem data confirmada, uma vez.
    const nodate = { ...server(pay('remote-nd', '2026-11-15T09:00:00'), null, 'REFUNDED') };
    expect(reconciliationMovements([], DAY15, { serverPayments: [nodate] }).undatedRefunds).toMatchObject({ count: 1, total: 100 });
  });
});

describe('Tela de conciliação: bruto, estornos e líquido', () => {
  const initial = useTcheStore.getState();
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useTcheStore.setState(initial, true);
  });

  // Sessão da nuvem com token válido por uma hora (freshCloudConfig não renova).
  const CLOUD = { url: 'https://x.supabase.co', anon_key: 'a', email: 'e', access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, tenant_id: 't' };
  const nowSale = () => {
    const period = currentShiftPeriod();
    return { ...pay('u1', '2026-11-14T20:00:00', { status: 'REFUNDED' }), created_at: new Date(period.start.getTime() + 60_000).toISOString() };
  };

  it('ligada à nuvem e sem resposta: avisa "estornos da nuvem não carregados" e põe o estorno sem data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'fora' })));
    useTcheStore.setState({ payments: [nowSale()], auditLogs: [], cloud: CLOUD });
    render(<Reconciliation />);
    await waitFor(() => expect(screen.getByText(/estornos da nuvem não carregados/i)).toBeTruthy());
    expect(screen.getByText(/estorno sem data confirmada/i)).toBeTruthy();
    expect(screen.getAllByText(/Bruto/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Líquido/i).length).toBeGreaterThan(0);
  });

  it('com a data do servidor no turno: estorno na linha do Mercado Pago, sem pendência', async () => {
    const sale = nowSale();
    const refundedAt = new Date(new Date(sale.created_at).getTime() + 60_000).toISOString();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ items: [{ ...server(sale, null, 'REFUNDED'), refunded_at: refundedAt }], next_cursor: null }) })));
    useTcheStore.setState({ payments: [sale], auditLogs: [], cloud: CLOUD });
    render(<Reconciliation />);
    await waitFor(() => expect(screen.getByTestId('recon-net-MERCADO_PAGO').textContent).toMatch(/^R\$\s0,00$/));
    expect(screen.getByTestId('recon-refunds-MERCADO_PAGO').textContent).toMatch(/^−R\$\s100,00$/);
    expect(screen.queryByText(/estorno sem data confirmada/i)).toBeNull();
    expect(screen.queryByText(/estornos da nuvem não carregados/i)).toBeNull();
  });

  it('GPT r11 P2-02: tela aberta, estorno espelhado aqui: recarrega a nuvem e mostra o estorno com a data do servidor, sem fechar a tela', async () => {
    const sale = { ...nowSale(), status: 'APPROVED' as const };
    const refundedAt = new Date(new Date(sale.created_at).getTime() + 60_000).toISOString();
    let refunded = false;
    const fetchMock = vi.fn(async (url: string) => {
      const row = refunded ? { ...server(sale, null, 'REFUNDED'), refunded_at: refundedAt } : server(sale, null, 'APPROVED');
      const items = String(url).includes('tchefood_list_point_refunds') ? (refunded ? [row] : []) : [row];
      return { ok: true, status: 200, text: async () => JSON.stringify({ items, next_cursor: null }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    useTcheStore.setState({ payments: [sale], auditLogs: [], cloud: CLOUD });
    render(<Reconciliation />);
    await waitFor(() => expect(screen.getByTestId('recon-net-MERCADO_PAGO').textContent).toMatch(/^R\$\s100,00$/));
    const calls = fetchMock.mock.calls.length;
    // O estorno foi registrado no servidor e espelhado aqui (o status local muda).
    refunded = true;
    useTcheStore.setState({ payments: [{ ...sale, status: 'REFUNDED' }] });
    await waitFor(() => expect(screen.getByTestId('recon-refunds-MERCADO_PAGO').textContent).toMatch(/^−R\$\s100,00$/));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.getByTestId('recon-net-MERCADO_PAGO').textContent).toMatch(/^R\$\s0,00$/);
    expect(screen.queryByText(/estorno sem data confirmada/i)).toBeNull();
  });

  it('GPT r12 P2-01: estorno registrado em OUTRO aparelho (nada muda aqui): a tela lê a nuvem de novo a cada minuto e mostra a hora da leitura', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const sale = { ...nowSale(), status: 'APPROVED' as const };
      const refundedAt = new Date(new Date(sale.created_at).getTime() + 60_000).toISOString();
      let refunded = false;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).includes('tchefood_list_refund_reopened_orders')) return { ok: true, status: 200, text: async () => '[]' };
        const row = refunded ? { ...server(sale, null, 'REFUNDED'), refunded_at: refundedAt } : server(sale, null, 'APPROVED');
        const items = String(url).includes('tchefood_list_point_refunds') ? (refunded ? [row] : []) : [row];
        return { ok: true, status: 200, text: async () => JSON.stringify({ items, next_cursor: null }) };
      }));
      useTcheStore.setState({ payments: [sale], auditLogs: [], cloud: CLOUD });
      render(<Reconciliation />);
      await waitFor(() => expect(screen.getByTestId('recon-net-MERCADO_PAGO').textContent).toMatch(/^R\$\s100,00$/));
      expect(screen.getByTestId('recon-loaded-at').textContent).toMatch(/atualizados às \d{2}:\d{2}/);
      // O outro aparelho estorna: este aparelho não espelha nada (o pagamento daqui continua APPROVED).
      refunded = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(RECON_REFRESH_MS); });
      await waitFor(() => expect(screen.getByTestId('recon-refunds-MERCADO_PAGO').textContent).toMatch(/^−R\$\s100,00$/));
      expect(screen.getByTestId('recon-net-MERCADO_PAGO').textContent).toMatch(/^R\$\s0,00$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('painel do turno: venda antiga estornada hoje reduz o faturamento de hoje (mesma regra da conciliação)', async () => {
    const period = currentShiftPeriod();
    const old = pay('dash-old', '2026-10-01T20:00:00', { status: 'REFUNDED' });
    const refundedAt = new Date(period.start.getTime() + 60_000).toISOString();
    const row = { ...server(old, null, 'REFUNDED'), refunded_at: refundedAt };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, text: async () => JSON.stringify({ items: String(url).includes('tchefood_list_point_refunds') ? [row] : [], next_cursor: null }) })));
    useTcheStore.setState({ payments: [old], orders: [], auditLogs: [], cloud: CLOUD });
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/estornos R\$\s100,00/)).toBeTruthy());
    expect(screen.getAllByText(/^-\s?R\$\s100,00$|^−R\$\s100,00$|^R\$\s-100,00$/).length).toBeGreaterThan(0);
  });
});


describe('GPT r12 P2-02: duas baixas na mesma conta', () => {
  const wo = (id: string, cents: number): AuditLog => ({
    id, tenant_id: 't', order_id: 'o1', performed_by_user_id: 'u', authorized_by_manager_id: 'm', action_type: 'ORDER_REFUNDED_WRITE_OFF',
    amount_impact: cents / 100, reason: 'venda devolvida', whatsapp_alert_sent: false, metadata: { written_off_cents: cents }, created_at: new Date().toISOString(),
  });
  it('cada registro tem só a diferença baixada: a conta soma (R$ 50 + R$ 50 = R$ 100); o mesmo registro duas vezes conta uma', () => {
    expect(writeOffsByOrder([wo('w1', 5000), wo('w2', 5000)]).get('o1')).toBe(10000);
    expect(writeOffsByOrder([wo('w1', 5000), wo('w1', 5000)]).get('o1')).toBe(5000);
  });
});
