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
    // Sem maxLength: texto colado maior não é cortado calado; a conferência abaixo avisa.
    expect(ref.hasAttribute('maxlength')).toBe(false);
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
    expect(link.hasAttribute('maxlength')).toBe(false);
    for (const v of ['http://asaas.com/x', 'https://asaas.com/a b', `https://${'a'.repeat(493)}`]) {
      fireEvent.change(link, { target: { value: v } });
      fireEvent.submit(link.form!);
      expect(await screen.findByText(/precisa começar com https:\/\/, sem espaços, com até 500 caracteres/)).toBeTruthy();
    }
    expect(create).not.toHaveBeenCalled();

    // Assinatura: motivo com pelo menos 5 letras e contato de 2 a 100.
    fireEvent.click(screen.getByText('Alterar'));
    const contato = input('Contato');
    expect(contato.hasAttribute('maxlength')).toBe(false);
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
    expect(contato.hasAttribute('maxlength')).toBe(false);
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
  it('gerar o mês descreve o lote: ativas ou em teste com mensalidade, sem o mês dentro do teste nem antes da loja entrar', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const gen = vi.fn(async () => 0);
    render(<Charges client={fakeClient({ chargesDue: async () => [], generateMonth: gen })} today="2026-11-14" onOpenStore={() => {}} />);
    fireEvent.click(await screen.findByText(/Gerar cobranças de/));
    const texto = confirm.mock.calls[0]![0] as string;
    expect(texto).toMatch(/lojas ativas ou em teste com mensalidade/);
    expect(texto).toMatch(/novembro\/2026 ainda dentro do teste/);
    expect(texto).toMatch(/entraram depois desse mês/);
    expect(texto).toMatch(/cancelada junto com uma assinatura que voltou é gerada de novo/);
    expect(await screen.findByText(/já têm a de novembro\/2026 \(lojas com o mês ainda dentro do teste ou que entraram depois dele ficam de fora\)/)).toBeTruthy();
  });
});

describe('painel com sessão guardada', () => {
  it('no StrictMode (efeito refeito) o cliente continua valendo e a visão geral carrega', async () => {
    sessionStorage.setItem('tchefood-admin-session', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, email: 'will@x.com', url: 'https://p.supabase.co' }));
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

describe('revisão 4: teste, pagamento, limites, abas paradas e erros de conexão', () => {
  const visivel = async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  const byLabel = (t: string) => [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(t))!.querySelector('input')!;

  it('fim do teste: só editável em teste, até 90 dias de hoje; fora do teste aparece só para leitura e vai a data guardada', async () => {
    const save = vi.fn(async (_t: string, _i: unknown) => SUB);
    const client = fakeClient({ saveSubscription: save, store: async () => detail({ subscription: { ...SUB, status: 'ACTIVE', trial_ends_on: '2026-11-20' } }) });
    render(<StoreDetail client={client} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    expect(screen.queryByLabelText('Fim do teste')).toBeNull();
    expect(screen.getByTestId('fim-teste-leitura').textContent).toMatch(/20\/11\/2026.*meses até essa data não entram no lote de cobranças/);
    fireEvent.change(input('Motivo'), { target: { value: 'troca de dia' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toMatchObject({ status: 'ACTIVE', trialEndsOn: '2026-11-20' });
    cleanup();

    const save2 = vi.fn(async (_t: string, _i: unknown) => SUB);
    render(<StoreDetail client={fakeClient({ saveSubscription: save2 })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'TRIAL' } });
    fireEvent.change(input('Motivo'), { target: { value: 'voltou ao teste' } });
    const fim = input('Fim do teste');
    expect(fim.max).toBe('2027-02-12');
    fireEvent.submit(fim.form!);
    expect(await screen.findByText('Loja em teste precisa da data de fim do teste.')).toBeTruthy();
    fireEvent.change(fim, { target: { value: '2027-02-13' } });
    fireEvent.submit(fim.form!);
    expect(await screen.findByText(/Fim do teste em até 90 dias a partir de hoje \(até 12\/02\/2027\)/)).toBeTruthy();
    expect(save2).not.toHaveBeenCalled();
    fireEvent.change(fim, { target: { value: '2027-02-12' } });
    fireEvent.submit(fim.form!);
    await waitFor(() => expect(save2).toHaveBeenCalledTimes(1));
    expect(save2.mock.calls[0]![1]).toMatchObject({ status: 'TRIAL', trialEndsOn: '2027-02-12' });
  });

  it('pagamento sem data: campo obrigatório e erro claro, sem chamar o banco', async () => {
    const pay = vi.fn();
    render(<StoreDetail client={fakeClient({ recordPayment: pay })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Registrar pagamento'));
    const data = input('Data do pagamento');
    expect(data.required).toBe(true);
    fireEvent.change(data, { target: { value: '' } });
    fireEvent.change(input('Referência do comprovante'), { target: { value: 'E2E123' } });
    fireEvent.submit(data.form!);
    expect(await screen.findByText('Informe a data do pagamento.')).toBeTruthy();
    expect(pay).not.toHaveBeenCalled();
  });

  it('tamanhos contam caracteres como o banco: emoji conta 1 na referência, no contato e nos motivos', async () => {
    const pay = vi.fn(async () => ({ status: 'PAID' as const, subscription_status: 'ACTIVE' as const, replayed: false }));
    const save = vi.fn(async (_t: string, _i: unknown) => SUB);
    const cancel = vi.fn(async () => {});
    vi.spyOn(window, 'prompt').mockReturnValue('abc😀');
    render(<StoreDetail client={fakeClient({ recordPayment: pay, saveSubscription: save, cancelCharge: cancel })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    // 4 caracteres no banco (abc + emoji), 5 unidades no .length: o motivo é curto.
    fireEvent.click(await screen.findByText('Cancelar'));
    expect(await screen.findByText(/motivo do cancelamento \(pelo menos 5 letras\)/)).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Alterar'));
    fireEvent.change(input('Contato'), { target: { value: '😀'.repeat(60) } });
    fireEvent.change(input('Motivo'), { target: { value: 'abc😀' } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText(/motivo da alteração \(pelo menos 5 letras\)/)).toBeTruthy();
    fireEvent.change(input('Motivo'), { target: { value: 'troca de contato' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText('Registrar pagamento'));
    fireEvent.change(input('Referência do comprovante'), { target: { value: '🍕'.repeat(100) } });
    fireEvent.click(screen.getByText('Confirmar pagamento'));
    await waitFor(() => expect(pay).toHaveBeenCalledTimes(1));
  });

  it('nova loja: nome e razão social com os limites na mensagem e mensalidade até R$ 100.000,00', async () => {
    const create = vi.fn(async (_i: unknown) => 'novo');
    render(<NewStoreForm client={fakeClient({ createStore: create })} onCancel={() => {}} onCreated={() => {}} />);
    fireEvent.change(byLabel('CNPJ'), { target: { value: '11.444.777/0001-61' } });
    fireEvent.change(byLabel('Contato'), { target: { value: 'Maria' } });
    fireEvent.change(byLabel('WhatsApp do contato'), { target: { value: '(55) 99653-8255' } });
    fireEvent.change(byLabel('Razão social'), { target: { value: 'Flip Ltda' } });
    fireEvent.change(byLabel('Nome da loja'), { target: { value: 'F' } });
    fireEvent.submit(byLabel('CNPJ').form!);
    expect(await screen.findByText('Nome da loja: de 2 a 150 caracteres.')).toBeTruthy();
    fireEvent.change(byLabel('Nome da loja'), { target: { value: 'x'.repeat(151) } });
    fireEvent.submit(byLabel('CNPJ').form!);
    expect(await screen.findByText('Nome da loja: de 2 a 150 caracteres.')).toBeTruthy();
    fireEvent.change(byLabel('Nome da loja'), { target: { value: 'Flip' } });
    fireEvent.change(byLabel('Razão social'), { target: { value: 'x'.repeat(201) } });
    fireEvent.submit(byLabel('CNPJ').form!);
    expect(await screen.findByText('Razão social: de 2 a 200 caracteres.')).toBeTruthy();
    fireEvent.change(byLabel('Razão social'), { target: { value: 'Flip Ltda' } });
    fireEvent.change(byLabel('Mensalidade negociada'), { target: { value: '100.000,01' } });
    fireEvent.submit(byLabel('CNPJ').form!);
    expect(await screen.findByText('Mensalidade até R$ 100.000,00.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(byLabel('Mensalidade negociada'), { target: { value: '100.000,00' } });
    fireEvent.submit(byLabel('CNPJ').form!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it('assinatura: mensalidade acima de R$ 100.000,00 não vai ao banco', async () => {
    const save = vi.fn();
    render(<StoreDetail client={fakeClient({ saveSubscription: save })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(input('Mensalidade'), { target: { value: '100001' } });
    fireEvent.change(input('Motivo'), { target: { value: 'reajuste' } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText('Mensalidade até R$ 100.000,00.')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('loja em cortesia: a dica não promete R$ 0,00 e a cobrança exige um valor maior que zero', async () => {
    const create = vi.fn(async () => 'id');
    render(<StoreDetail client={fakeClient({ createCharge: create, store: async () => detail({ subscription: { ...SUB, monthly_price: 0 } }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    await screen.findByText('Criar cobrança');
    expect(screen.queryByText(/Vazio = R\$\s?0,00/)).toBeNull();
    expect(screen.getByText('Loja em cortesia: informe o valor.')).toBeTruthy();
    fireEvent.click(screen.getByText('Criar cobrança'));
    expect(await screen.findByText(/Loja em cortesia \(mensalidade R\$ 0,00\): informe o valor da cobrança, maior que zero/)).toBeTruthy();
    fireEvent.change(input('Valor'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Criar cobrança'));
    expect(await screen.findByText('O valor da cobrança precisa ser maior que zero.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(input('Valor'), { target: { value: '50' } });
    fireEvent.click(screen.getByText('Criar cobrança'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('t1', '2026-11-01', '50.00', null, null));
  });

  it('conta do aparelho: falha depois de o pedido sair diz que a senha pode já ter mudado; 409 mantém a mensagem', async () => {
    const erros = [
      new AdminApiError('Falha interna. Nada foi confirmado; tente de novo.', 500),
      new AdminApiError('Não foi possível confirmar a troca de senha no Supabase Auth; a senha pode já ter mudado. Toque de novo em "Trocar senha" para gerar uma senha nova.', 502),
      new AdminApiError('upstream timeout', 504),
      new AdminApiError('WORKER_LIMIT', 546),
      new AdminApiError('A loja ainda não tem conta do aparelho pronta. Use "Criar conta".', 409),
    ];
    let i = 0;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoreDetail client={fakeClient({ deviceAccount: async () => Promise.reject(erros[i++]) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    for (let n = 0; n < 4; n++) {
      fireEvent.click(await screen.findByText('Trocar senha'));
      const msg = await screen.findByText(/A senha pode já ter mudado/);
      expect(msg.textContent).toMatch(/Use "Trocar senha" para gerar outra/);
      expect(msg.textContent).not.toMatch(/Nada foi confirmado; tente de novo\.\s*$/);
      await waitFor(() => expect((screen.getByText('Trocar senha').closest('button') as HTMLButtonElement).disabled).toBe(false));
    }
    fireEvent.click(screen.getByText('Trocar senha'));
    expect(await screen.findByText('A loja ainda não tem conta do aparelho pronta. Use "Criar conta".')).toBeTruthy();
    expect(screen.queryByText(/A senha pode já ter mudado/)).toBeNull();
  });

  it('aba que volta a ficar visível relê a loja e as cobranças do dia', async () => {
    const store = vi.fn(async () => detail());
    render(<StoreDetail client={fakeClient({ store })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    await screen.findByText('Criar cobrança');
    expect(store).toHaveBeenCalledTimes(1);
    await visivel();
    await waitFor(() => expect(store).toHaveBeenCalledTimes(2));
    cleanup();

    const chargesDue = vi.fn(async () => [] as DueCharge[]);
    render(<Charges client={fakeClient({ chargesDue })} today="2026-11-14" onOpenStore={() => {}} />);
    await screen.findByText('Nenhuma cobrança vencida.');
    await visivel();
    await waitFor(() => expect(chargesDue).toHaveBeenCalledTimes(2));
  });

  it('senha na tela some quando a loja relida mostra outra senha gerada depois dela', async () => {
    const reset = (t: string) => ({ action: 'DEVICE_PASSWORD_RESET', reason: null, details: {}, created_at: t, admin_name: 'Will' });
    let audit = [reset('2026-11-10T10:00:00.000000+00:00')];
    const store = vi.fn(async () => detail({ audit }));
    const device = vi.fn(async () => {
      audit = [reset('2026-11-14T12:00:00.123456+00:00'), ...audit];
      return { email: 'e', password: 'senha-desta-aba', user_id: 'u' };
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoreDetail client={fakeClient({ store, deviceAccount: device })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Trocar senha'));
    await screen.findByText('senha-desta-aba');
    await waitFor(() => expect(store).toHaveBeenCalledTimes(2));
    // Voltar para a aba sem troca nova: a senha continua.
    await visivel();
    await waitFor(() => expect(store).toHaveBeenCalledTimes(3));
    expect(screen.getByText('senha-desta-aba')).toBeTruthy();
    // Outra aba trocou a senha de novo.
    audit = [reset('2026-11-14T12:05:00.000000+00:00'), ...audit];
    await visivel();
    await waitFor(() => expect(screen.queryByText('senha-desta-aba')).toBeNull());
    expect(screen.getByText(/Outra senha foi gerada para o aparelho depois desta/)).toBeTruthy();
  });

  it('formulário de pagamento fecha quando a loja relida mostra a cobrança paga', async () => {
    let cobranca: Charge = CHARGE;
    const pay = vi.fn(async () => {
      cobranca = { ...CHARGE, status: 'PAID', paid_on: '2026-11-14', paid_amount: 179.9, payment_method: 'PIX', payment_reference: 'E2E1' };
      throw new AdminApiError('Sem conexão com o servidor. Confira se a ação foi registrada antes de repetir.', 0);
    });
    render(<StoreDetail client={fakeClient({ recordPayment: pay, store: async () => detail({ charges: [cobranca] }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Registrar pagamento'));
    fireEvent.change(input('Referência do comprovante'), { target: { value: 'E2E1' } });
    fireEvent.click(screen.getByText('Confirmar pagamento'));
    expect(await screen.findByText(/A cobrança de novembro\/2026 já está paga: o formulário de pagamento foi fechado/)).toBeTruthy();
    expect(screen.queryByText('Confirmar pagamento')).toBeNull();
  });
});

describe('revisão 4: painel', () => {
  function respostas(me: () => { status: number; body: unknown }) {
    const fetchMock = vi.fn(async (url: string) => {
      const fn = String(url).split('/rpc/')[1];
      const r = fn === 'tchefood_admin_me' ? me()
        : fn === 'tchefood_admin_overview' ? { status: 200, body: { today: '2026-11-14', stores: { trial: 0, active: 1, suspended: 0, cancelled: 0, without_subscription: 0 }, mrr: 199, open_amount: 0, open_count: 0, overdue_amount: 0, overdue_count: 0, received_this_month: 0, trials_ending_7d: 0, trials_expired: 0 } }
        : { status: 200, body: null };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const guardar = (url: string) => {
    sessionStorage.setItem('tchefood-admin-session', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, email: 'will@x.com', url }));
    localStorage.setItem('tchefood-admin-config', JSON.stringify({ url: 'https://p.supabase.co', anonKey: 'k' }));
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('servidor fora do ar ao ler a conta: mensagem de conexão e "Tentar de novo" (não diz que a conta não é da equipe)', async () => {
    guardar('https://p.supabase.co');
    let fora = true;
    const fetchMock = respostas(() => (fora ? { status: 503, body: { message: 'Service Unavailable' } } : { status: 200, body: { user_id: 'u', email: 'will@x.com', name: 'Will', today: '2026-11-14' } }));
    render(<App />);
    expect(await screen.findByText(/Não foi possível falar com o servidor agora/)).toBeTruthy();
    expect(screen.queryByText(/não é da equipe do Tchê Food/)).toBeNull();
    fora = false;
    fireEvent.click(screen.getByText('Tentar de novo'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('tchefood_admin_overview'))).toBe(true));
  });

  it('403 ao ler a conta: diz que a conta não é da equipe', async () => {
    guardar('https://p.supabase.co');
    respostas(() => ({ status: 403, body: { message: 'TCHEFOOD_ADMIN: acesso restrito à equipe do Tchê Food' } }));
    render(<App />);
    expect(await screen.findByText(/Esta conta não é da equipe do Tchê Food/)).toBeTruthy();
    expect(screen.queryByText('Tentar de novo')).toBeNull();
  });

  it('sessão guardada de outro projeto: volta para a entrada sem chamar o servidor', async () => {
    guardar('https://outro.supabase.co');
    const fetchMock = respostas(() => ({ status: 200, body: null }));
    render(<App />);
    expect(await screen.findByTestId('host-senha')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('tchefood-admin-session')).toBeNull();
  });
});

describe('revisão 4: avisos da assinatura sobre cobranças já criadas', () => {
  const dez: Charge = { ...CHARGE, id: 'c2', reference_month: '2026-12-01', due_date: '2026-12-10' };
  const out: Charge = { ...CHARGE, id: 'c0', reference_month: '2026-10-01', due_date: '2026-10-10' };

  it('mudar mensalidade ou vencimento com cobranças em aberto deste mês em diante avisa que elas ficam como estão', async () => {
    render(<StoreDetail client={fakeClient({ store: async () => detail({ charges: [dez, CHARGE, out] }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    expect(screen.queryByText(/Para mudar, cancele e crie de novo/)).toBeNull();
    fireEvent.change(input('Mensalidade'), { target: { value: '189,90' } });
    const aviso = await screen.findByText(/Para mudar, cancele e crie de novo/);
    expect(aviso.textContent).toBe('As cobranças em aberto de dezembro/2026, novembro/2026 continuam com o valor de antes. Para mudar, cancele e crie de novo.');
    fireEvent.change(input('Mensalidade'), { target: { value: '179,90' } });
    expect(screen.queryByText(/Para mudar, cancele e crie de novo/)).toBeNull();
    fireEvent.change(byDia(), { target: { value: '15' } });
    expect(screen.getByText(/continuam com o vencimento de antes/)).toBeTruthy();
  });

  it('voltar ao teste com cobranças em aberto até o fim do teste avisa que elas ficam em aberto', async () => {
    render(<StoreDetail client={fakeClient({ store: async () => detail({ charges: [dez, CHARGE] }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'TRIAL' } });
    fireEvent.change(input('Fim do teste'), { target: { value: '2026-11-30' } });
    expect(screen.getByText(/de novembro\/2026 fica em aberto: voltar ao teste não cancela cobrança já criada\. Se for cortesia, cancele\./)).toBeTruthy();
    fireEvent.change(input('Fim do teste'), { target: { value: '2026-12-20' } });
    expect(screen.getByText(/de dezembro\/2026, novembro\/2026 ficam em aberto/)).toBeTruthy();
  });

  it('teste → ativa: o teste termina hoje, o lote cobra do mês seguinte e vai a data de hoje', async () => {
    const save = vi.fn(async (_t: string, _i: unknown) => SUB);
    render(<StoreDetail client={fakeClient({ saveSubscription: save, store: async () => detail({ subscription: { ...SUB, status: 'TRIAL', trial_ends_on: '2026-12-20' } }) })} tenantId="t1" today="2026-11-14" onBack={() => {}} />);
    fireEvent.click(await screen.findByText('Alterar'));
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'ACTIVE' } });
    const nota = screen.getByTestId('fim-teste-leitura').textContent!;
    expect(nota).toMatch(/termina em 14\/11\/2026 \(hoje\): o lote cobra a partir de dezembro\/2026/);
    expect(nota).not.toMatch(/Em teste/);
    fireEvent.change(input('Motivo'), { target: { value: 'fechou contrato' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toMatchObject({ status: 'ACTIVE', trialEndsOn: '2026-11-14' });
  });
});

function byDia() {
  return [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Dia de vencimento'))!.querySelector('input')!;
}
