// @vitest-environment jsdom
/**
 * Telas do painel com um cliente de mentira: formulário de assinatura que não se apaga,
 * troca de plano com o preço do plano, conta do aparelho, mês da cobrança, cancelar sem
 * clique duplo, nova loja com CNPJ alfanumérico e telefone, e o host da senha no login.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, type AdminClient, type Charge, type DueCharge, type Plan, type StoreDetail as Detail, type StoreRow, type Subscription } from '../lib/api';
import StoreDetail from '../components/StoreDetail';
import NewStoreForm from '../components/NewStoreForm';
import Login from '../components/Login';
import Overview from '../components/Overview';
import Charges from '../components/Charges';
import Stores from '../components/Stores';
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
    last_sale_at: null, last_order_opened_at: null, orders_7d: 0, staff_active: 1, charges: [CHARGE], audit: [], orders_30d: 0, ...over,
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

  it('salvar assinatura manda o updated_at de quando a edição começou (null sem assinatura)', async () => {
    const save = vi.fn(async (_t: string, _i: unknown) => SUB);
    const client = fakeClient({ saveSubscription: save, store: async () => detail({ subscription: { ...SUB, updated_at: '2026-11-14T10:00:00Z' } }) });
    render(<StoreDetail client={client} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(input('Motivo'), { target: { value: 'troca' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toMatchObject({ expectedUpdatedAt: '2026-11-14T10:00:00Z', reason: 'troca' });
    cleanup();

    const save2 = vi.fn(async (_t: string, _i: unknown) => SUB);
    render(<StoreDetail client={fakeClient({ saveSubscription: save2, store: async () => detail({ subscription: null, charges: [] }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    await screen.findByText('Cadastrar assinatura');
    fireEvent.change(input('WhatsApp'), { target: { value: '(55) 99653-8255' } });
    fireEvent.change(input('Contato'), { target: { value: 'Maria' } });
    fireEvent.change(input('Motivo'), { target: { value: 'loja nova' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(save2).toHaveBeenCalledTimes(1));
    expect(save2.mock.calls[0]![1]).toMatchObject({ expectedUpdatedAt: null });
  });

  it('assinatura mudou com o formulário aberto: avisa, mostra a recusa do banco e descartar recarrega os valores atuais', async () => {
    const T1 = '2026-11-14T10:00:00Z';
    const T2 = '2026-11-14T10:05:00Z';
    let atual: Subscription = { ...SUB, status: 'SUSPENDED', updated_at: T1 };
    const save = vi.fn(async (_t: string, i: { expectedUpdatedAt: string | null }) => {
      if (i.expectedUpdatedAt !== atual.updated_at) throw new Error('a assinatura mudou enquanto o formulário estava aberto; recarregue a loja');
      return atual;
    });
    let cobranca: Charge = CHARGE;
    const client = fakeClient({
      saveSubscription: save,
      store: async () => detail({ subscription: atual, charges: [cobranca] }),
      // O banco: pagamento de loja suspensa a reativa (e muda o updated_at da assinatura).
      recordPayment: async () => {
        atual = { ...SUB, status: 'ACTIVE', contact_phone: '55996538255', updated_at: T2 };
        cobranca = { ...CHARGE, status: 'PAID', paid_on: '2026-11-14', paid_amount: 179.9, payment_method: 'PIX', payment_reference: 'E2E1' };
        return { status: 'PAID', subscription_status: 'ACTIVE', replayed: false };
      },
    });
    render(<StoreDetail client={client} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(input('WhatsApp'), { target: { value: '(11) 3333-4444' } });
    fireEvent.change(input('Motivo'), { target: { value: 'troca' } });
    expect(screen.queryByText(/mudou enquanto você editava/)).toBeNull();

    // Um pagamento registrado nesta tela reativa a loja e recarrega a assinatura.
    fireEvent.click(screen.getByText('Registrar pagamento'));
    fireEvent.change(screen.getByLabelText('Referência do comprovante'), { target: { value: 'E2E1' } });
    fireEvent.click(screen.getByText('Confirmar pagamento'));
    expect(await screen.findByText(/mudou enquanto você editava/)).toBeTruthy();
    // O aviso não põe a culpa só num pagamento: outra aba ou outra pessoa também mudam a assinatura.
    expect(screen.getByText(/mudou enquanto você editava/).textContent).toMatch(/outra aba ou por outra pessoa/);
    expect(input('WhatsApp').value).toBe('(11) 3333-4444');

    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText(/a assinatura mudou enquanto o formulário estava aberto/)).toBeTruthy();
    expect(save.mock.calls[0]![1]).toMatchObject({ expectedUpdatedAt: T1 });

    fireEvent.click(screen.getByText('Descartar e recarregar'));
    expect(screen.queryByText(/mudou enquanto você editava/)).toBeNull();
    expect(screen.queryByText(/a assinatura mudou enquanto o formulário estava aberto/)).toBeNull();
    expect(input('WhatsApp').value).toBe('55996538255');
    fireEvent.change(input('Motivo'), { target: { value: 'troca' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![1]).toMatchObject({ expectedUpdatedAt: T2 });
  });

  it('recusa do banco sem a tela saber da mudança: relê a loja e o aviso aparece', async () => {
    let atual: Subscription = { ...SUB, updated_at: 'T1' };
    const save = vi.fn(async () => {
      atual = { ...SUB, updated_at: 'T2' };
      throw new Error('a assinatura mudou enquanto o formulário estava aberto');
    });
    render(<StoreDetail client={fakeClient({ saveSubscription: save, store: async () => detail({ subscription: atual }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(input('Motivo'), { target: { value: 'troca' } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText(/a assinatura mudou enquanto o formulário estava aberto/)).toBeTruthy();
    expect(await screen.findByText('Descartar e recarregar')).toBeTruthy();
    expect(input('Motivo').value).toBe('troca');
  });

  it('conta do aparelho: desistir da troca de senha não apaga a senha que está na tela', async () => {
    const reset = vi.fn(async () => ({ email: 'e', password: 'senha-1', user_id: 'u' }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoreDetail client={fakeClient({ deviceAccount: reset })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Trocar senha'));
    await screen.findByText('senha-1');
    confirm.mockReturnValue(false);
    fireEvent.click(screen.getByText('Trocar senha'));
    expect(screen.getByText('senha-1')).toBeTruthy();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('conta do aparelho: erro relê a loja e os botões mostram o estado real', async () => {
    let lojas = 0;
    const store = async () => {
      lojas++;
      return detail({ subscription: { ...SUB, device_status: lojas === 1 ? 'PENDING' : 'READY' } });
    };
    const create = vi.fn(async () => {
      throw new Error('esta loja já tem conta do aparelho: use Trocar senha');
    });
    render(<StoreDetail client={fakeClient({ store, deviceAccount: create })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Criar conta do aparelho'));
    expect(await screen.findByText(/já tem conta do aparelho/)).toBeTruthy();
    expect(await screen.findByText('Trocar senha')).toBeTruthy();
    expect(screen.queryByText('Criar conta do aparelho')).toBeNull();
  });

  it('erro ao carregar os planos aparece na tela', async () => {
    render(<StoreDetail client={fakeClient({ plans: async () => Promise.reject(new Error('planos fora do ar')) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    expect(await screen.findByText(/planos fora do ar/)).toBeTruthy();
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

describe('revisão: cobranças, conta do aparelho e validações', () => {
  const ROW: StoreRow = {
    tenant_id: 't1', name: 'Flip', legal_name: 'Flip Ltda', cnpj: '12ABC34501DE35', city: 'Santo Ângelo', state: 'RS', created_at: '', subscription: SUB,
    open_count: 0, open_amount: 0, overdue_count: 0, overdue_amount: 0, oldest_overdue_due: null, last_sale_at: null, last_order_opened_at: null, orders_7d: 0,
    staff_active: 1,
  };
  const due = (over: Partial<DueCharge>): DueCharge => ({
    id: 'd', tenant_id: 't1', store_name: 'Flip', reference_month: '2026-11-01', amount: 179.9, due_date: '2026-11-10', days_late: 4, payment_link: null,
    contact_name: 'Maria', contact_phone: '55996538255', subscription_status: 'ACTIVE', ...over,
  });

  it('vencimento vazio: a dica diz que nunca fica antes de hoje nem do fim do teste', async () => {
    render(<StoreDetail client={fakeClient()} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    expect(await screen.findByText('Vazio = dia 10, nunca antes de hoje nem antes do fim do teste.')).toBeTruthy();
  });

  it('cobranças do dia: loja cancelada ou suspensa aparece com a situação e o WhatsApp marcado', async () => {
    const chargesDue = async () => [
      due({ id: 'a', store_name: 'Ativa', subscription_status: 'ACTIVE' }),
      due({ id: 'b', store_name: 'Cancelada Ltda', subscription_status: 'CANCELLED' }),
      due({ id: 'c', store_name: 'Suspensa Ltda', subscription_status: 'SUSPENDED' }),
    ];
    render(<Charges client={fakeClient({ chargesDue })} today="2026-11-14" onOpenStore={() => {}} />);
    await screen.findByText('Ativa');
    const item = (nome: string) => screen.getByText(nome).closest('li')!;
    expect(item('Ativa').textContent).not.toMatch(/loja (cancelada|suspensa)/);
    expect(within(item('Ativa')).queryByText('Ativa', { selector: 'span' })).toBeNull();
    expect(within(item('Cancelada Ltda')).getByText('Cancelada', { selector: 'span' })).toBeTruthy();
    expect(item('Cancelada Ltda').textContent).toMatch(/loja cancelada: não é lembrete de rotina/);
    expect(within(item('Suspensa Ltda')).getByText('Suspensa', { selector: 'span' })).toBeTruthy();
    expect(item('Suspensa Ltda').textContent).toMatch(/loja suspensa: não é lembrete de rotina/);
  });

  it('lista de lojas: o nome é um botão (teclado) que abre a loja', async () => {
    const abrir = vi.fn();
    render(<Stores client={fakeClient({ stores: async () => [ROW] })} today="2026-11-14" onOpenStore={abrir} />);
    const btn = await screen.findByRole('button', { name: 'Flip' });
    fireEvent.click(btn);
    expect(abrir).toHaveBeenCalledTimes(1);
    expect(abrir).toHaveBeenCalledWith('t1');
  });

  it('conta do aparelho: sem conexão avisa que a senha nova pode ter se perdido e relê a loja', async () => {
    const store = vi.fn(async () => detail());
    const reset = vi.fn(async () => {
      throw new AdminApiError('Sem conexão com o servidor. Confira se a ação foi registrada antes de repetir.', 0);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoreDetail client={fakeClient({ store, deviceAccount: reset })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Trocar senha'));
    expect(await screen.findByText(/a senha nova se perdeu/)).toBeTruthy();
    expect(screen.getByText(/a senha nova se perdeu/).textContent).toMatch(/"Trocar senha" para gerar outra/);
    await waitFor(() => expect(store).toHaveBeenCalledTimes(2));
  });

  it('copiar a senha: diz "copiado" ou mostra o erro (sem área de transferência ou recusada)', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const setClip = (v: unknown) => Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true });
    try {
      const write = vi.fn(async (_t: string) => {});
      setClip({ writeText: write });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<StoreDetail client={fakeClient({ deviceAccount: async () => ({ email: 'e', password: 'senha-1', user_id: 'u' }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
      fireEvent.click(await screen.findByText('Trocar senha'));
      await screen.findByText('senha-1');
      fireEvent.click(screen.getByText('copiar'));
      expect(await screen.findByText('copiado')).toBeTruthy();
      expect(write).toHaveBeenCalledWith('senha-1');

      setClip({ writeText: async () => Promise.reject(new Error('negado')) });
      fireEvent.click(screen.getByText('copiar'));
      expect(await screen.findByText(/Não deu para copiar/)).toBeTruthy();
      expect(screen.queryByText('copiado')).toBeNull();

      setClip(undefined);
      fireEvent.click(screen.getByText('copiar'));
      expect(await screen.findByText(/Não deu para copiar/)).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('erro ao criar, cancelar ou pagar cobrança relê a loja', async () => {
    const store = vi.fn(async () => detail());
    const falha = async () => {
      throw new Error('recusado pelo banco');
    };
    vi.spyOn(window, 'prompt').mockReturnValue('duplicada');
    render(<StoreDetail client={fakeClient({ store, createCharge: falha, cancelCharge: falha, recordPayment: falha })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Criar cobrança'));
    await screen.findByText('recusado pelo banco');
    await waitFor(() => expect(store).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText('Cancelar'));
    await waitFor(() => expect(store).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByText('Registrar pagamento'));
    fireEvent.change(screen.getByLabelText('Referência do comprovante'), { target: { value: 'E2E123' } });
    fireEvent.click(screen.getByText('Confirmar pagamento'));
    await waitFor(() => expect(store).toHaveBeenCalledTimes(4));
    // O formulário de pagamento continua aberto com o erro.
    expect(screen.getByText('Confirmar pagamento')).toBeTruthy();
    expect(screen.getAllByText('recusado pelo banco').length).toBeGreaterThan(0);
  });

  it('validações iguais às do banco: referência, motivos, contato e link', async () => {
    const pay = vi.fn();
    const cancel = vi.fn();
    const create = vi.fn();
    const save = vi.fn();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(' abc ');
    render(<StoreDetail client={fakeClient({ recordPayment: pay, cancelCharge: cancel, createCharge: create, saveSubscription: save })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);

    // Referência do comprovante: 4 a 120 caracteres.
    fireEvent.click(await screen.findByText('Registrar pagamento'));
    const ref = input('Referência do comprovante');
    expect(ref.minLength).toBe(4);
    expect(ref.maxLength).toBe(120);
    fireEvent.change(ref, { target: { value: ' ab ' } });
    fireEvent.submit(ref.form!);
    expect(await screen.findByText(/Referência do comprovante: de 4 a 120 caracteres/)).toBeTruthy();
    fireEvent.change(ref, { target: { value: 'x'.repeat(121) } });
    fireEvent.submit(ref.form!);
    expect(await screen.findByText(/Referência do comprovante: de 4 a 120 caracteres/)).toBeTruthy();
    expect(pay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Voltar'));

    // Motivo do cancelamento: pelo menos 5 letras.
    fireEvent.click(screen.getByText('Cancelar'));
    expect(await screen.findByText(/motivo do cancelamento \(pelo menos 5 letras\)/)).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
    prompt.mockReturnValue('duplicada');

    // Link de pagamento: https://, sem espaços, até 500.
    const link = input('Link do boleto/Pix (Asaas)');
    expect(link.maxLength).toBe(500);
    for (const v of ['http://asaas.com/x', 'https://asaas.com/a b', `https://${'a'.repeat(493)}`]) {
      fireEvent.change(link, { target: { value: v } });
      fireEvent.submit(link.form!);
      expect(await screen.findByText(/precisa começar com https:\/\/, sem espaços, com até 500 caracteres/)).toBeTruthy();
    }
    expect(create).not.toHaveBeenCalled();

    // Assinatura: motivo com pelo menos 5 letras e contato de 2 a 100.
    fireEvent.click(screen.getByText('Alterar'));
    const contato = input('Contato');
    expect(contato.maxLength).toBe(100);
    fireEvent.change(input('Motivo'), { target: { value: ' ab  ' } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText(/motivo da alteração \(pelo menos 5 letras\)/)).toBeTruthy();
    fireEvent.change(input('Motivo'), { target: { value: 'troca de dia' } });
    fireEvent.change(contato, { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText(/Contato: de 2 a 100 caracteres/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('nova loja: contato com até 100 caracteres', async () => {
    const create = vi.fn();
    render(<NewStoreForm client={fakeClient({ createStore: create })} onCancel={() => {}} onCreated={() => {}} />);
    const byLabel = (t: string) => [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(t))!.querySelector('input')!;
    fireEvent.change(byLabel('Nome da loja'), { target: { value: 'Flip' } });
    fireEvent.change(byLabel('Razão social'), { target: { value: 'Flip Ltda' } });
    fireEvent.change(byLabel('CNPJ'), { target: { value: '11.444.777/0001-61' } });
    fireEvent.change(byLabel('WhatsApp do contato'), { target: { value: '(55) 99653-8255' } });
    const contato = byLabel('Contato');
    expect(contato.maxLength).toBe(100);
    fireEvent.change(contato, { target: { value: 'x'.repeat(101) } });
    fireEvent.submit(contato.form!);
    expect(await screen.findByText(/Contato: de 2 a 100 caracteres/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('assinatura cancelada: o aviso e a confirmação dizem que as cobranças em aberto dos meses seguintes são canceladas', async () => {
    const save = vi.fn(async () => SUB);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<StoreDetail client={fakeClient({ saveSubscription: save })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'CANCELLED' } });
    expect(screen.getByText(/cobranças em aberto de meses depois de novembro\/2026 também são canceladas/i)).toBeTruthy();
    fireEvent.change(input('Motivo'), { target: { value: 'loja fechou' } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatch(/cobranças em aberto de meses depois de novembro\/2026 também vão ser canceladas/i);
    expect(save).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
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

  it('visão geral: "A receber" diz que inclui as vencidas', async () => {
    const overview = async () => ({
      today: '2026-11-14', stores: { trial: 0, active: 1, suspended: 0, cancelled: 0, without_subscription: 0 }, mrr: 0, open_amount: 300, open_count: 2,
      overdue_amount: 100, overdue_count: 1, received_this_month: 0, trials_ending_7d: 0, trials_expired: 0,
    });
    render(<Overview client={fakeClient({ overview })} today="2026-11-14" irPara={() => {}} />);
    expect(await screen.findByText('2 cobrança(s) em aberto, vencidas incluídas')).toBeTruthy();
    expect(screen.getByText(/"A receber" soma todas as cobranças em aberto, vencidas incluídas/)).toBeTruthy();
    expect(screen.queryByText(/Cobrança que ainda vai vencer conta em "A receber"/)).toBeNull();
  });
});

describe('cobranças do dia', () => {
  it('gerar o mês avisa que também cobra as lojas em teste que terminaram antes do mês', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const gen = vi.fn(async () => 0);
    render(<Charges client={fakeClient({ chargesDue: async () => [], generateMonth: gen })} today="2026-11-14" onOpenStore={() => {}} />);
    fireEvent.click(await screen.findByText(/Gerar cobranças de/));
    expect(confirm.mock.calls[0]![0]).toMatch(/lojas ativas com mensalidade e as em teste que terminaram antes de/);
    expect(await screen.findByText(/as em teste que terminaram antes de .* já têm/)).toBeTruthy();
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
