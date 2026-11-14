// @vitest-environment jsdom
/**
 * Tela Retaguarda › Fechamento anual: só dono e gerente; ano escolhido; vale-refeição
 * sem registro aparece como "não registrado"; no app Android não oferece exportação.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnualClose } from '../screens/AnnualClose';
import { useBackOfficeTabs } from '../screens/BackOffice';
import { useTcheStore } from '../store/useTcheStore';
import type { Payment, StaffUser } from '../types';

const staff = [
  { id: 'own', name: 'Dono', role: 'OWNER', active: true },
  { id: 'cx', name: 'Caixa', role: 'CASHIER', active: true },
] as unknown as StaffUser[];
const pay = (amount: number, at: string, method = 'PIX') =>
  ({ id: `${amount}-${at}`, order_id: 'o', amount, tip_amount: 0, method, status: 'APPROVED', acquirer: 'CASH_DESK', card_brand: null, created_at: `${at}-03:00` }) as unknown as Payment;

function setup(userId: string, payments: Payment[] = []) {
  act(() => {
    useTcheStore.setState({
      staff,
      currentUserId: userId,
      payments,
      stockMovements: [],
      purchaseInvoices: [],
      purchaseInvoiceItems: [],
      cashSessions: [],
      cashMovements: [],
      ownDeliveries: [],
      courierSettlements: [],
    } as never);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-02-10T10:00:00-03:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).SmartPosNative;
});

describe('Fechamento anual (tela)', () => {
  it('a aba só aparece para dono e gerente', () => {
    setup('cx');
    expect(renderHook(() => useBackOfficeTabs()).result.current.some((t) => t.key === 'annual')).toBe(false);
    setup('own');
    expect(renderHook(() => useBackOfficeTabs()).result.current.some((t) => t.key === 'annual')).toBe(true);
  });

  it('avisa que são só os registros deste aparelho', () => {
    setup('own');
    render(<AnnualClose />);
    expect(screen.getByRole('note').textContent).toContain('NESTE aparelho');
  });

  it('caixa não vê o faturamento do ano', () => {
    setup('cx', [pay(100, '2025-05-01T12:00:00')]);
    render(<AnnualClose />);
    expect(screen.getByText(/Só o proprietário e o gerente/)).toBeTruthy();
    expect(screen.queryByText(/Total vendido/)).toBeNull();
  });

  it('dono: em fevereiro abre o ano que terminou, troca de ano e mostra VR/VA como não registrado', () => {
    setup('own', [pay(100, '2025-05-01T12:00:00'), pay(40, '2026-01-15T12:00:00')]);
    render(<AnnualClose />);
    const select = screen.getByLabelText('Ano do fechamento') as HTMLSelectElement;
    expect(select.value).toBe('2025');
    const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(100));
    expect(screen.getByText('Vale-refeição / alimentação').parentElement!.parentElement!.textContent).toContain('não registrado');
    expect(screen.getAllByRole('button', { name: /baixar Excel/ })).toHaveLength(4);
    fireEvent.change(select, { target: { value: '2026' } });
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(40));
    expect(screen.getByText(/2026 ainda não terminou/)).toBeTruthy();
  });

  it('sem dados não quebra; no app Android não oferece exportar', () => {
    (window as unknown as Record<string, unknown>).SmartPosNative = {};
    setup('own');
    render(<AnnualClose />);
    expect(screen.getByText(/não salva planilha nem PDF/)).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /baixar Excel/ })).toHaveLength(0);
  });
});

describe('Fechamento anual (tela): corte único no ano em andamento (auditoria P2-02)', () => {
  const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-11-14T10:00:00-03:00'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('às 10:00, o registro das 09:00 entra e o das 11:00 fica fora com aviso na tela e no CSV; Atualizar pega o novo instante', async () => {
    setup('own', [pay(30, '2026-11-14T09:00:00'), pay(70, '2026-11-14T11:00:00')]);
    act(() => {
      useTcheStore.setState({
        stockMovements: [
          { id: 'm9', tenant_id: useTcheStore.getState().tenant.id, product_id: 'p1', type: 'PURCHASE_IN', quantity: 1, unit_cost: 1, balance_after: 1, avg_cost_after: 1, purchase_invoice_item_id: null, performed_by_user_id: 'own', created_at: '2026-11-14T11:00:00-03:00' },
        ],
      } as never);
    });
    render(<AnnualClose />);
    expect((screen.getByLabelText('Ano do fechamento') as HTMLSelectElement).value).toBe('2026');
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(30));
    expect(screen.getAllByText(/Posição em 14\/11\/2026 10:00 \(ano em andamento\)/)).toHaveLength(2);
    expect(screen.getByText(/os números vão até 14\/11\/2026 10:00/)).toBeTruthy();
    const alert = screen.getAllByRole('alert').find((a) => a.textContent!.includes('instante deste relatório'))!;
    expect(alert.textContent).toContain('a partir de 14/11/2026 10:00');
    expect(alert.textContent).toContain('Inventário de insumos e mercadorias: 1');
    expect(alert.textContent).toContain('Fechamento de caixa e formas de pagamento: 1');
    expect(alert.textContent).toContain('Contas a pagar e a receber em aberto: 1');

    // Exportação: o CSV leva o mesmo corte e o mesmo aviso.
    let blob: Blob | null = null;
    Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => ((blob = b), 'blob:x')), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /Fechamento de caixa e formas de pagamento: baixar Excel/ }));
    // Blob do jsdom não tem .text(): lê pelo FileReader.
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as unknown as Blob);
    });
    expect(csv).toContain('01/01/2026 a 14/11/2026 10:00 (ano em andamento)');
    expect(csv).toContain('1 registro(s) com data a partir de 14/11/2026 10:00 (instante deste relatório) ficaram de fora');

    // Duas horas depois, "Atualizar" traz o registro das 11:00 e o aviso some.
    vi.setSystemTime(new Date('2026-11-14T12:00:00-03:00'));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar os números até agora' }));
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(100));
    expect(screen.getByText(/os números vão até 14\/11\/2026 12:00/)).toBeTruthy();
    expect(screen.queryAllByRole('alert').some((a) => a.textContent!.includes('instante deste relatório'))).toBe(false);
  });

  it('ano encerrado: sem botão Atualizar nem aviso de corte; 01/01 00:00 fica no ano seguinte', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00-03:00'));
    setup('own', [pay(30, '2025-12-31T23:59:00'), pay(70, '2026-01-01T00:00:00')]);
    render(<AnnualClose />);
    expect((screen.getByLabelText('Ano do fechamento') as HTMLSelectElement).value).toBe('2025');
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(30));
    expect(screen.queryByRole('button', { name: 'Atualizar os números até agora' })).toBeNull();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

describe('Fechamento anual (tela): rodada interna após a auditoria 2', () => {
  const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

  it('o instante fica fixo até Atualizar: relógio andando e dado novo não mudam o corte dos quatro relatórios', () => {
    vi.setSystemTime(new Date('2026-11-14T10:00:30-03:00'));
    setup('own', [pay(30, '2026-11-14T09:00:00')]);
    render(<AnnualClose />);
    // Corte no próximo minuto cheio: 10:00:30 vira 10:01 (o que já foi lançado entra).
    expect(screen.getByText(/os números vão até 14\/11\/2026 10:01 /)).toBeTruthy();
    vi.setSystemTime(new Date('2026-11-14T12:00:00-03:00'));
    act(() => {
      useTcheStore.setState({
        payments: [pay(30, '2026-11-14T09:00:00'), pay(70, '2026-11-14T11:00:00')],
        stockMovements: [{ id: 'm11', tenant_id: useTcheStore.getState().tenant.id, product_id: 'p1', type: 'PURCHASE_IN', quantity: 1, unit_cost: 1, balance_after: 1, avg_cost_after: 1, purchase_invoice_item_id: null, performed_by_user_id: 'own', created_at: '2026-11-14T11:00:00-03:00' }],
        cashMovements: [{ id: 'w11', type: 'WITHDRAWAL', amount: 5, reason: 'gelo', created_at: '2026-11-14T11:00:00-03:00' }],
      } as never);
    });
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(30));
    expect(screen.getByText('Itens com saldo').parentElement!.textContent).toContain('0');
    expect(screen.getAllByText(/Posição em 14\/11\/2026 10:01 \(ano em andamento\)/)).toHaveLength(2);
    const alert = screen.getAllByRole('alert').find((a) => a.textContent!.includes('instante deste relatório'))!;
    expect(alert.textContent).toContain('Inventário de insumos e mercadorias: 1');
    expect(alert.textContent).toContain('Fechamento de caixa e formas de pagamento: 2');
    expect(alert.textContent).toContain('Despesas operacionais: 1');
  });

  it('venda sem taxa de dezembro do ano anterior aparece na tela com valor e quantidade', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00-03:00'));
    setup('own', [pay(10, '2025-05-01T12:00:00'), { ...pay(123.45, '2024-12-20T20:00:00', 'CREDIT'), acquirer: 'STONE' } as Payment]);
    render(<AnnualClose />);
    expect((screen.getByLabelText('Ano do fechamento') as HTMLSelectElement).value).toBe('2025');
    const row = screen.getByText('Situação de repasse desconhecida (sem taxa cadastrada)').parentElement!.parentElement!;
    expect(row.textContent).toContain(fmt(123.45));
    expect(row.textContent).toContain('1 venda(s)');
    expect(row.textContent).toContain(`inclui 1 venda(s) de anos anteriores, ${fmt(123.45)}`);
  });

  it('relógio do aparelho antes do ano: mostra o ano inteiro e avisa', () => {
    vi.setSystemTime(new Date('1970-01-02T10:00:00-03:00'));
    setup('own', [pay(30, '2025-05-01T12:00:00'), pay(70, '2025-12-31T23:00:00')]);
    render(<AnnualClose />);
    expect((screen.getByLabelText('Ano do fechamento') as HTMLSelectElement).value).toBe('2025');
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(100));
    expect(screen.getAllByRole('alert').some((a) => a.textContent!.includes('antes de 2025 começar'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Atualizar os números até agora' })).toBeNull();
  });
});

describe('Fechamento anual (tela): rodada interna 2', () => {
  it('registros de outra loja ficam fora e a tela avisa', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00-03:00'));
    setup('own', [pay(30, '2025-05-01T12:00:00'), { ...pay(70, '2025-06-01T12:00:00'), tenant_id: 'outra-loja' } as Payment]);
    render(<AnnualClose />);
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain('30,00');
    expect(screen.getByText(/1 registro\(s\) de outra loja/)).toBeTruthy();
  });
});
