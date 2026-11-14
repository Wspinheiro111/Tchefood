// @vitest-environment jsdom
/**
 * Telas do painel com um cliente de mentira: formulário de assinatura que não se apaga,
 * troca de plano com o preço do plano, conta do aparelho, mês da cobrança, cancelar sem
 * clique duplo, nova loja com CNPJ alfanumérico e telefone, e o host da senha no login.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminClient, Charge, Plan, StoreDetail as Detail, Subscription } from '../lib/api';
import StoreDetail from '../components/StoreDetail';
import NewStoreForm from '../components/NewStoreForm';
import Login from '../components/Login';
import Overview from '../components/Overview';
import App from '../App';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PLANS: Plan[] = [
  { id: 'salao-pro', name: 'Salão Pro', monthly_price: 199.9, active: true },
  { id: 'balcao', name: 'Balcão', monthly_price: 99, active: true },
];

const SUB: Subscription = {
  plan_id: 'salao-pro', monthly_price: 179.9, status: 'ACTIVE', billing_day: 10, trial_ends_on: null, contact_name: 'Maria', contact_phone: '55996538255',
  contact_email: null, notes: null, device_email: 'loja-x@aparelho.tchefood.com.br', device_status: 'READY', created_at: '', updated_at: '',
};

const CHARGE: Charge = {
  id: 'c1', reference_month: '2026-11-01', amount: 179.9, due_date: '2026-11-10', status: 'OPEN', payment_link: null, paid_on: null, paid_amount: null,
  payment_method: null, payment_reference: null, cancel_reason: null, created_at: '',
};

function detail(over: Partial<Detail> = {}): Detail {
  return {
    tenant_id: 't1', name: 'Flip', legal_name: 'Flip Ltda', cnpj: '12ABC34501DE35', city: 'Santo Ângelo', state: 'RS', created_at: '', subscription: SUB,
    last_order_at: null, orders_7d: 0, staff_active: 1, charges: [CHARGE], audit: [], orders_30d: 0, ...over,
  };
}

function fakeClient(over: Partial<AdminClient> = {}): AdminClient {
  const no = () => Promise.reject(new Error('não usado'));
  return {
    me: no, overview: no, stores: no, chargesDue: no, createStore: no, saveSubscription: no, createCharge: no, generateMonth: no, recordPayment: no,
    cancelCharge: no, deviceAccount: no,
    plans: async () => PLANS,
    store: async () => detail(),
    ...over,
  } as AdminClient;
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('detalhe da loja', () => {
  it('recarregar a loja não apaga a assinatura que está sendo editada; trocar o plano põe o preço dele', async () => {
    const client = fakeClient({ deviceAccount: async () => ({ email: 'e', password: 'p1', user_id: 'u' }) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoreDetail client={client} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(input('WhatsApp'), { target: { value: '(11) 3333-4444' } });
    fireEvent.change(input('Motivo'), { target: { value: 'troca' } });
    // Outra ação da tela recarrega a loja.
    fireEvent.click(screen.getByText('Trocar senha'));
    await screen.findByText('p1');
    await waitFor(() => expect(input('WhatsApp').value).toBe('(11) 3333-4444'));
    expect(input('Motivo').value).toBe('troca');

    expect(input('Mensalidade').value).toBe('179,90');
    fireEvent.change(screen.getByLabelText('Plano'), { target: { value: 'balcao' } });
    expect(input('Mensalidade').value).toBe('99,00');
    fireEvent.change(input('Mensalidade'), { target: { value: '89,90' } });
    expect(input('Mensalidade').value).toBe('89,90');
  });

  it('telefone inválido na assinatura: erro claro e nenhuma chamada', async () => {
    const save = vi.fn();
    render(<StoreDetail client={fakeClient({ saveSubscription: save })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(input('WhatsApp'), { target: { value: '4455996538255' } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText(/WhatsApp inválido/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('conta do aparelho: a senha antiga some antes do erro novo; troca de senha avisa do token atual', async () => {
    let n = 0;
    const client = fakeClient({
      deviceAccount: async () => {
        n++;
        if (n === 1) return { email: 'e', password: 'senha-velha', user_id: 'u' };
        throw new Error('falhou agora');
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoreDetail client={client} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Trocar senha'));
    await screen.findByText('senha-velha');
    expect(screen.getByText(/continua até o token atual vencer \(até 1 hora\)/)).toBeTruthy();
    fireEvent.click(screen.getByText('Trocar senha'));
    await screen.findByText('falhou agora');
    expect(screen.queryByText('senha-velha')).toBeNull();
  });

  it('mês da cobrança: valida AAAA-MM e acompanha o today do servidor enquanto não foi mexido', async () => {
    const create = vi.fn(async () => 'id');
    const client = fakeClient({ createCharge: create });
    const { rerender } = render(<StoreDetail client={client} tenantId="t1" today="2026-11-30" onBack={() => {}} />);
    await screen.findByText('Criar cobrança');
    expect(input('Mês').value).toBe('2026-11');
    rerender(<StoreDetail client={client} tenantId="t1" today="2026-12-01" onBack={() => {}} />);
    await waitFor(() => expect(input('Mês').value).toBe('2026-12'));
    fireEvent.change(input('Mês'), { target: { value: '2027-01' } });
    rerender(<StoreDetail client={client} tenantId="t1" today="2027-02-01" onBack={() => {}} />);
    await screen.findByText('Criar cobrança');
    expect(input('Mês').value).toBe('2027-01');
    fireEvent.click(screen.getByText('Criar cobrança'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('t1', '2027-01-01', null, null, null));

    // Mês fora do formato (navegador sem type="month", ou campo apagado) não vai ao servidor.
    create.mockClear();
    fireEvent.change(input('Mês'), { target: { value: '2027-1' } });
    fireEvent.submit(input('Mês').form!);
    expect(await screen.findByText(/Mês inválido/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('cancelar cobrança: botão travado enquanto a chamada roda', async () => {
    let fim: () => void = () => {};
    const cancel = vi.fn(() => new Promise<void>((r) => (fim = r)));
    vi.spyOn(window, 'prompt').mockReturnValue('duplicada');
    render(<StoreDetail client={fakeClient({ cancelCharge: cancel })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Cancelar'));
    const btn = await screen.findByText('Cancelando…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => fim());
    await screen.findByText('Cancelar');
  });
});

describe('nova loja', () => {
  function preencher(cnpj: string, phone: string) {
    const campos = document.querySelectorAll('input');
    const byLabel = (t: string) => [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(t))!.querySelector('input')!;
    expect(campos.length).toBeGreaterThan(0);
    fireEvent.change(byLabel('Nome da loja'), { target: { value: 'Flip' } });
    fireEvent.change(byLabel('Razão social'), { target: { value: 'Flip Ltda' } });
    fireEvent.change(byLabel('CNPJ'), { target: { value: cnpj } });
    fireEvent.change(byLabel('Contato'), { target: { value: 'Maria' } });
    fireEvent.change(byLabel('WhatsApp do contato'), { target: { value: phone } });
    return byLabel('CNPJ');
  }

  it('CNPJ alfanumérico aceito (sem teclado só numérico) e enviado limpo', async () => {
    const create = vi.fn(async (_i: unknown) => 'novo');
    render(<NewStoreForm client={fakeClient({ createStore: create })} onCancel={() => {}} onCreated={() => {}} />);
    const cnpj = preencher('12.abc.345/01de-35', '(55) 99653-8255');
    expect(cnpj.getAttribute('inputmode')).toBeNull();
    fireEvent.click(screen.getByText('Criar loja'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ cnpj: '12ABC34501DE35', contactPhone: '(55) 99653-8255' });
  });

  it('telefone inválido: erro antes de chamar o servidor', async () => {
    const create = vi.fn();
    render(<NewStoreForm client={fakeClient({ createStore: create })} onCancel={() => {}} onCreated={() => {}} />);
    preencher('11.444.777/0001-61', '12345');
    fireEvent.click(screen.getByText('Criar loja'));
    expect(await screen.findByText(/WhatsApp inválido/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('login e visão geral', () => {
  it('login mostra o host que recebe a senha, também com o projeto já configurado', () => {
    render(<Login cfg={{ url: 'https://abc.supabase.co', anonKey: 'k' }} onLogin={() => {}} />);
    expect(screen.getByTestId('host-senha').textContent).toBe('A senha vai para abc.supabase.co.');
    cleanup();
    render(<Login cfg={{ url: '', anonKey: '' }} onLogin={() => {}} />);
    expect(screen.getByTestId('host-senha').textContent).toBe('Endereço do Supabase não informado.');
  });

  it('visão geral mostra os testes vencidos à parte', async () => {
    const overview = async () => ({
      today: '2026-11-14', stores: { trial: 5, active: 1, suspended: 0, cancelled: 0, without_subscription: 0 }, mrr: 0, open_amount: 0, open_count: 0,
      overdue_amount: 0, overdue_count: 0, received_this_month: 0, trials_ending_7d: 1, trials_expired: 3,
    });
    render(<Overview client={fakeClient({ overview })} today="2026-11-14" irPara={() => {}} />);
    expect(await screen.findByText('3 com teste vencido · 1 terminam em até 7 dias')).toBeTruthy();
  });
});

describe('painel com sessão guardada', () => {
  it('no StrictMode (efeito refeito) o cliente continua valendo e a visão geral carrega', async () => {
    sessionStorage.setItem('tchefood-admin-session', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, email: 'will@x.com' }));
    localStorage.setItem('tchefood-admin-config', JSON.stringify({ url: 'https://p.supabase.co', anonKey: 'k' }));
    const fetchMock = vi.fn(async (url: string) => {
      const fn = String(url).split('/rpc/')[1];
      const body = fn === 'tchefood_admin_me' ? { user_id: 'u', email: 'will@x.com', name: 'Will', today: '2026-11-14' }
        : fn === 'tchefood_admin_overview' ? { today: '2026-11-14', stores: { trial: 0, active: 1, suspended: 0, cancelled: 0, without_subscription: 0 }, mrr: 199, open_amount: 0, open_count: 0, overdue_amount: 0, overdue_count: 0, received_this_month: 0, trials_ending_7d: 0, trials_expired: 0 }
        : null;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('tchefood_admin_overview'))).toBe(true));
    expect(screen.queryByText(/Sessão encerrada/)).toBeNull();
    expect(sessionStorage.getItem('tchefood-admin-session')).not.toBeNull();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
  });
});
