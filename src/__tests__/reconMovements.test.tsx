// @vitest-environment jsdom
/**
 * Auditoria GPT r10 do PR #49, P2-01 e P2-02: a conciliação trata venda e estorno como movimentos com data
 * própria. A venda conta no turno em que foi feita (mesmo estornada depois); o estorno conta no turno da data
 * do estorno no servidor; sem data confirmada, fica à parte ("estorno sem data confirmada").
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentShiftPeriod,
  loadServerPointPayments,
  reconciliationMovements,
  shiftStartBrasilia,
  type ShiftPeriod,
} from '../lib/reports';
import type { ListPointPaymentsInput, ListPointPaymentsResult, ServerPointPayment } from '../lib/payments/pointPaymentsServer';
import { Reconciliation } from '../screens/BackOffice';
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

describe('loadServerPointPayments: tchefood_list_point_payments do período, todas as páginas', () => {
  const sale = pay('s5', '2026-11-14T20:00:00');
  const item = server(sale, '2026-11-15T13:00:00');

  it('lê todas as páginas, desde 31 dias antes do turno (estorno de venda antiga) até o fim do turno', async () => {
    const calls: ListPointPaymentsInput[] = [];
    const list = async (input: ListPointPaymentsInput): Promise<ListPointPaymentsResult> => {
      calls.push(input);
      return input.cursor === null ? { kind: 'ok', items: [item], nextCursor: 'c2' } : { kind: 'ok', items: [{ ...item, payment_id: 'other' }], nextCursor: null };
    };
    const out = await loadServerPointPayments(DAY15, list);
    expect(out.map((r) => r.payment_id)).toEqual(['s5', 'other']);
    expect(calls[0]).toMatchObject({ from: new Date(DAY15.start.getTime() - 31 * 86_400_000).toISOString(), to: DAY15.end.toISOString(), search: null, cursor: null });
    expect(calls[1]).toMatchObject({ cursor: 'c2' });
  });

  it('erro em qualquer página ou cursor que não acaba: lança (a tela mostra "não carregados")', async () => {
    await expect(loadServerPointPayments(DAY15, async () => ({ kind: 'error', error: 'sem rede' }))).rejects.toThrow(/sem rede/);
    let n = 0;
    const second = async (): Promise<ListPointPaymentsResult> => (n++ === 0 ? { kind: 'ok', items: [item], nextCursor: 'x' } : { kind: 'error', error: 'caiu' });
    await expect(loadServerPointPayments(DAY15, second)).rejects.toThrow(/caiu/);
    const endless = async (input: ListPointPaymentsInput): Promise<ListPointPaymentsResult> => ({ kind: 'ok', items: [], nextCursor: `${input.cursor ?? ''}x` });
    await expect(loadServerPointPayments(DAY15, endless)).rejects.toThrow(/páginas/);
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
});
