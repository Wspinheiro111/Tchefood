// @vitest-environment jsdom
/** Fechamento anual (tela), rodada interna 3: outra loja em cada coleção e avisos do topo no arquivo. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnualClose } from '../screens/AnnualClose';
import { useTcheStore } from '../store/useTcheStore';
import type { Payment, StaffUser } from '../types';

const staff = [{ id: 'own', name: 'Dono', role: 'OWNER', active: true }] as unknown as StaffUser[];
const pay = (amount: number, at: string, extra: Partial<Payment> = {}) =>
  ({ id: `${amount}-${at}`, order_id: 'o', amount, tip_amount: 0, method: 'PIX', status: 'APPROVED', acquirer: 'CASH_DESK', card_brand: null, created_at: `${at}-03:00`, tenant_id: useTcheStore.getState().tenant.id, ...extra }) as unknown as Payment;
function setup(state: Record<string, unknown>) {
  act(() => {
    useTcheStore.setState({ staff, currentUserId: 'own', payments: [], stockMovements: [], purchaseInvoices: [], purchaseInvoiceItems: [], cashSessions: [], cashMovements: [], ownDeliveries: [], courierSettlements: [], orders: [], ...state } as never);
  });
}
const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
const val = (label: string) => screen.getByText(label).parentElement!.lastElementChild!.textContent!.replace(/\u00a0/g, ' ');
async function exportCsv(name: RegExp): Promise<string> {
  let blob: Blob | null = null;
  Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => ((blob = b), 'blob:x')), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name }));
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob as unknown as Blob);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-02-10T10:00:00-03:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('outra loja fica fora em cada coleção', () => {
  it('nenhum registro de outra loja entra em nenhum relatório', () => {
    const X = 'outra-loja';
    const d = '2025-06-01T12:00:00-03:00';
    setup({
      payments: [pay(30, '2025-05-01T12:00:00')],
      products: [{ id: 'px', tenant_id: X, code: '9', name: 'Outro', ncm: '', unit: 'UN', active: true }],
      stockMovements: [{ id: 'sx', tenant_id: X, product_id: 'px', type: 'PURCHASE_IN', quantity: 2, unit_cost: 5, balance_after: 2, avg_cost_after: 5, purchase_invoice_item_id: null, created_at: d }],
      cashSessions: [{ id: 'cx', tenant_id: X, status: 'CLOSED', opened_at: d, closed_at: d, opening_float: 0, expected_cash: 0, counted_cash: 0, difference: 0 }],
      cashMovements: [{ id: 'mx', tenant_id: X, type: 'WITHDRAWAL', amount: 9, reason: 'x', created_at: d }],
      purchaseInvoices: [{ id: 'ix', tenant_id: X, supplier_id: 's', access_key: '1'.repeat(44), number: '1', series: '1', issued_at: d, environment: 'PRODUCTION', invoice_amount: 80, imported_at: d }],
      ownDeliveries: [{ id: 'dx', tenant_id: X, order_id: 'ox', status: 'DELIVERED', courier_id: 'c1', courier_fee: 7, pay_on_delivery: false, delivered_at: d, settlement_id: null }],
      courierSettlements: [{ id: 'kx', tenant_id: X, created_at: d, courier_fees: 11, cash_movement_id: null }],
      orders: [{ id: 'ox', tenant_id: X, status: 'CLOSED', closed_at: d, service_fee_amount: 10, total_amount: 100 }],
    });
    render(<AnnualClose />);
    expect((screen.getByLabelText('Ano do fechamento') as HTMLSelectElement).value).toBe('2025');
    expect(val('Itens com saldo')).toBe('0');
    expect(val('Fechamentos de caixa')).toBe('0');
    expect(screen.queryByText('Sangrias sem categoria (fora do total)')).toBeNull();
    expect(val('Compras de insumos e mercadorias')).toBe(fmt(0).replace(/\u00a0/g, ' '));
    expect(val('Taxas de entrega (entregadores próprios)')).toBe(fmt(0).replace(/\u00a0/g, ' '));
    expect(val('A pagar a entregadores próprios')).toBe(fmt(0).replace(/\u00a0/g, ' '));
    expect(screen.queryByText('Taxa de serviço dentro do total')).toBeNull();
    expect(screen.getAllByText(/8 registro\(s\) de outra loja/).length).toBeGreaterThan(0);
  });
});

describe('avisos do topo também vão para o arquivo exportado', () => {
  it('outra loja', async () => {
    setup({ payments: [pay(30, '2025-05-01T12:00:00'), pay(70, '2025-06-01T12:00:00', { tenant_id: 'outra' } as never)] });
    render(<AnnualClose />);
    expect(await exportCsv(/Fechamento de caixa e formas de pagamento: baixar Excel/)).toMatch(/\d+ registro\(s\) de outra loja/);
  });
  it('relógio antes do ano', async () => {
    vi.setSystemTime(new Date('1970-01-02T10:00:00-03:00'));
    setup({ payments: [pay(30, '2025-05-01T12:00:00')] });
    render(<AnnualClose />);
    expect(await exportCsv(/Inventário de insumos e mercadorias: baixar Excel/)).toContain('antes de 2025 começar');
  });
  it('ano em andamento', async () => {
    vi.setSystemTime(new Date('2026-11-14T10:00:00-03:00'));
    setup({ payments: [pay(30, '2026-11-14T09:00:00')] });
    render(<AnnualClose />);
    expect(await exportCsv(/Contas a pagar e a receber em aberto: baixar Excel/)).toContain('os números vão até 14/11/2026 10:00');
  });
});
