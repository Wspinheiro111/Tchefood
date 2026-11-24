// @vitest-environment jsdom
/**
 * Cadastro da Point Smart (aba Point Smart da Retaguarda) e o aviso de loja em nuvem sem internet.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { PointAdmin } from '../screens/admin/PointAdmin';
import { OFFLINE_OLD_SYSTEM_TEXT, OfflineCloudBanner } from '../components/OfflineCloudBanner';
import { fetchPointTerminals, pairingState, parseTerminalsReply, type PointListing } from '../lib/payments/pointTerminals';
import { cloudUnreachable, lastCloudContactAt, resetCloudReachability, trackCloudReachability } from '../lib/sync/cloudReachability';
import { PROBE_EVERY_MS, probeCloudIfIdle, syncOnce, useCloudSync } from '../lib/sync/useCloudSync';

// Estado do armazenamento controlável (auditoria #59 r5 P2-02): 'ok' por padrão, como nos outros testes.
const storage = vi.hoisted(() => ({ status: 'ok' as 'ok' | 'readonly' | 'blocked' }));
vi.mock('../lib/idbStorage', async (orig) => ({ ...(await orig<typeof import('../lib/idbStorage')>()), getStorageStatus: () => storage.status }));

const st = () => useTcheStore.getState();
const MP_ID = 'NEWLAND_N950__N950NCB801293324';
const CLOUD = { url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9_999_999_999 };

function withCloud() {
  act(() => {
    useTcheStore.setState({ cloud: { ...CLOUD, tenant_id: st().tenant.id } } as never);
  });
}
const points = () => st().terminals.filter((t) => t.acquirer === 'MERCADO_PAGO');
const terminalEvents = () => st().outbox.filter((e) => e.table === 'pos_terminals');
/** Lista do Mercado Pago lida agora mostrando a Point na conta e no modo PDV. */
const READY: PointListing = { kind: 'ok', terminals: [{ id: MP_ID, operating_mode: 'pdv' }] };

function mockFunction(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  resetCloudReachability();
  st().resetDemo();
  useTcheStore.setState({ outbox: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('savePointTerminal', () => {
  it('cadastra a Point com o ID do Mercado Pago e sobe para a nuvem', () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    const r = st().savePointTerminal({ name: ' Point Caixa ', serial_number: ` ${MP_ID} `, active: true }, READY);
    expect(r.ok).toBe(true);
    expect(points()).toEqual([expect.objectContaining({ name: 'Point Caixa', serial_number: MP_ID, acquirer: 'MERCADO_PAGO', mode: 'TEF_POS_WIRELESS', online: true, tenant_id: st().tenant.id })]);
    expect(terminalEvents().map((e) => `${e.op}:${(e.payload as { serial_number: string }).serial_number}`)).toEqual([`INSERT:${MP_ID}`]);
  });

  it('sem a nuvem não cadastra (a Point cobra pela nuvem)', () => {
    expect(st().login('8888').ok).toBe(true);
    const r = st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/nuvem/) });
    expect(points()).toEqual([]);
  });

  it('só quem tem acesso a Loja cadastra', () => {
    withCloud();
    expect(st().login('5555').ok).toBe(true);
    expect(st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true })).toMatchObject({ ok: false });
    expect(points()).toEqual([]);
  });

  it('recusa ID inválido, ID repetido (inclusive em outra maquininha) e nome vazio', () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    expect(st().savePointTerminal({ name: 'Point', serial_number: 'id com espaço', active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/ID da maquininha inválido/) });
    expect(st().savePointTerminal({ name: '  ', serial_number: MP_ID, active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/nome/) });
    expect(st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true }, READY).ok).toBe(true);
    expect(st().savePointTerminal({ name: 'Outra', serial_number: MP_ID.toLowerCase(), active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/já está cadastrado/) });
    expect(st().savePointTerminal({ name: 'Outra', serial_number: 'STONE-01', active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Stone Salão 01/) });
    expect(points()).toHaveLength(1);
  });

  it('o ID não muda depois do cadastro; nome e ativa/desativada mudam (UPDATE na nuvem)', () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    const row = st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true }, READY);
    if (!row.ok) throw new Error(row.error);
    expect(st().savePointTerminal({ id: row.data.id, name: 'Point', serial_number: 'NEWLAND_N950__OUTRA', active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/não muda/) });
    expect(st().savePointTerminal({ id: row.data.id, name: 'Point Salão', serial_number: MP_ID, active: false }).ok).toBe(true);
    expect(points()).toEqual([expect.objectContaining({ id: row.data.id, name: 'Point Salão', online: false })]);
    expect(terminalEvents().map((e) => e.op)).toEqual(['INSERT', 'UPDATE']);
    // Stone/PagBank não são editadas por aqui.
    const stone = st().terminals.find((t) => t.acquirer === 'STONE')!;
    expect(st().savePointTerminal({ id: stone.id, name: 'x', serial_number: stone.serial_number, active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Só a Point/) });
  });
});

describe('Point só vai para o caixa depois de conferida (auditoria #59 r1 P1-01)', () => {
  it('cadastrar ativa ou religar exige a lista do Mercado Pago mostrando a Point pronta', () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    const notPdv: PointListing = { kind: 'ok', terminals: [{ id: MP_ID, operating_mode: 'standalone' }] };
    const otherAccount: PointListing = { kind: 'ok', terminals: [{ id: 'NEWLAND_N950__OUTRA', operating_mode: 'pdv' }] };
    for (const check of [undefined, null, { kind: 'error', message: 'x' } as PointListing, { kind: 'not_configured' } as PointListing]) {
      expect(st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true }, check)).toMatchObject({ ok: false, error: expect.stringMatching(/Conferir no Mercado Pago/) });
    }
    expect(st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true }, notPdv)).toMatchObject({ ok: false, error: expect.stringMatching(/fora do modo PDV/) });
    expect(st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true }, otherAccount)).toMatchObject({ ok: false, error: expect.stringMatching(/Não aparece na conta/) });
    expect(points()).toEqual([]);
    // Desativada entra sem conferir; religar pede a conferência; com ela pronta, liga.
    const row = st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: false });
    if (!row.ok) throw new Error(row.error);
    expect(st().savePointTerminal({ id: row.data.id, name: 'Point', serial_number: MP_ID, active: true })).toMatchObject({ ok: false });
    expect(st().savePointTerminal({ id: row.data.id, name: 'Point', serial_number: MP_ID, active: true }, notPdv)).toMatchObject({ ok: false });
    expect(points()[0]!.online).toBe(false);
    expect(st().savePointTerminal({ id: row.data.id, name: 'Point', serial_number: MP_ID, active: true }, READY).ok).toBe(true);
    expect(points()[0]!.online).toBe(true);
    // Já ativa: trocar o nome não pede nova conferência (o servidor confere a cada cobrança).
    expect(st().savePointTerminal({ id: row.data.id, name: 'Point Salão', serial_number: MP_ID, active: true }).ok).toBe(true);
  });
});

describe('lista do Mercado Pago (ação terminals)', () => {
  it('manda só { action: "terminals" } com a sessão da nuvem e lê a lista', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ terminals: [{ id: MP_ID, operating_mode: 'pdv' }] }) }));
    const out = await fetchPointTerminals({ config: async () => ({ url: 'https://x.supabase.co/', anonKey: 'anon', accessToken: 'jwt' }), fetch: fetchFn });
    expect(out).toEqual({ kind: 'ok', terminals: [{ id: MP_ID, operating_mode: 'pdv' }] });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://x.supabase.co/functions/v1/point-charge');
    expect(init.headers.Authorization).toBe('Bearer jwt');
    expect(JSON.parse(init.body)).toEqual({ action: 'terminals' });
  });

  it('sem token na loja, erro do Mercado Pago, queda e resposta fora do formato', async () => {
    const cfg = async () => ({ url: 'https://x', anonKey: 'a', accessToken: 'j' });
    const reply = (status: number, body: unknown) => async () => ({ status, text: async () => JSON.stringify(body) });
    expect(await fetchPointTerminals({ config: cfg, fetch: reply(412, { error: 'not_configured', message: 'x' }) })).toEqual({ kind: 'not_configured' });
    expect(await fetchPointTerminals({ config: cfg, fetch: reply(424, { error: 'mp_unavailable', message: 'O Mercado Pago não devolveu' }) })).toEqual({ kind: 'error', message: 'O Mercado Pago não devolveu' });
    expect(await fetchPointTerminals({ config: cfg, fetch: async () => { throw new TypeError('Failed to fetch'); } })).toMatchObject({ kind: 'error' });
    expect(await fetchPointTerminals({ config: async () => null, fetch: reply(200, {}) })).toEqual({ kind: 'no_cloud' });
    expect(parseTerminalsReply(JSON.stringify({ terminals: [{ id: MP_ID, operating_mode: 'pdv' }, { id: '', operating_mode: 'pdv' }] }))).toBeNull();
    expect(parseTerminalsReply(JSON.stringify({ terminals: [{ id: MP_ID, operating_mode: 'PDV' }] }))).toBeNull();
    expect(parseTerminalsReply('nada')).toBeNull();
  });

  it('consulta que nunca responde vira erro no prazo e aborta o pedido (auditoria #59 r1 P2-01)', async () => {
    let fire: () => void = () => undefined;
    let signal: AbortSignal | undefined;
    const pending = fetchPointTerminals({
      config: async () => ({ url: 'https://x', anonKey: 'a', accessToken: 'j' }),
      fetch: (_u, init) => { signal = init.signal; return new Promise(() => undefined); },
      setTimer: (fn) => { fire = fn; return () => undefined; },
    });
    await Promise.resolve();
    fire();
    expect(await pending).toEqual({ kind: 'error', message: expect.stringMatching(/não respondeu a tempo/) });
    expect(signal?.aborted).toBe(true);
    // A sessão que nunca vem também acaba no prazo.
    const noSession = fetchPointTerminals({ config: () => new Promise(() => undefined), fetch: async () => { throw new Error('não chega'); }, setTimer: (fn) => { fire = fn; return () => undefined; } });
    fire();
    expect(await noSession).toMatchObject({ kind: 'error' });
  });

  it('estado da maquininha cadastrada', () => {
    const ok = { kind: 'ok' as const, terminals: [{ id: MP_ID, operating_mode: 'pdv' as const }, { id: 'B', operating_mode: 'standalone' as const }] };
    expect(pairingState({ serial_number: MP_ID, online: true }, null)).toBe('unchecked');
    expect(pairingState({ serial_number: MP_ID, online: true }, { kind: 'not_configured' })).toBe('unchecked');
    expect(pairingState({ serial_number: MP_ID, online: true }, ok)).toBe('ready');
    expect(pairingState({ serial_number: 'B', online: true }, ok)).toBe('not_pdv');
    expect(pairingState({ serial_number: 'C', online: true }, ok)).toBe('not_in_account');
    expect(pairingState({ serial_number: MP_ID, online: false }, ok)).toBe('inactive');
  });
});

describe('tela Point Smart', () => {
  it('sem nuvem: explica que precisa conectar e não mostra o cadastro', () => {
    expect(st().login('8888').ok).toBe(true);
    render(<PointAdmin />);
    expect(screen.getByText(/A Point cobra pela nuvem/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cadastrar Point' })).toBeNull();
  });

  it('cadastra desativada, só ativa depois de Pronta, mostra o estado de cada uma e desativa no caixa', async () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    render(<PointAdmin />);
    expect(screen.getByText('Nenhuma Point cadastrada nesta loja.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/NEWLAND/), { target: { value: MP_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar Point' }));
    const row = () => screen.getByTestId(`point-${MP_ID}`);
    // Sem conferir: entra desativada (não aparece no caixa) e não liga.
    expect(within(row()).getByText('Desativada')).toBeTruthy();
    expect(points()[0]!.online).toBe(false);
    fireEvent.click(within(row()).getByRole('switch', { name: /Ativa no caixa/ }));
    expect(within(row()).getByText(/Antes de ativar/)).toBeTruthy();
    expect(points()[0]!.online).toBe(false);

    mockFunction(200, { terminals: [{ id: MP_ID, operating_mode: 'standalone' }, { id: 'NEWLAND_N950__SEGUNDA', operating_mode: 'pdv' }] });
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByTestId('mp-state').textContent).toMatch(/fora do modo PDV/));
    fireEvent.click(within(row()).getByRole('switch', { name: /Ativa no caixa/ }));
    expect(within(row()).getByText(/Não dá para ativar/)).toBeTruthy();
    expect(points()[0]!.online).toBe(false);
    // A outra maquininha da conta aparece para cadastrar, com o ID sugerido; pronta, entra ativa.
    expect(screen.getByText('NEWLAND_N950__SEGUNDA')).toBeTruthy();
    expect((screen.getByPlaceholderText(/NEWLAND/) as HTMLInputElement).placeholder).toBe('NEWLAND_N950__SEGUNDA');
    fireEvent.change(screen.getByPlaceholderText(/NEWLAND/), { target: { value: 'NEWLAND_N950__SEGUNDA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar Point' }));
    expect(within(screen.getByTestId('point-NEWLAND_N950__SEGUNDA')).getByText('Pronta')).toBeTruthy();

    mockFunction(200, { terminals: [{ id: MP_ID, operating_mode: 'pdv' }] });
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByTestId('mp-state').textContent).toMatch(/pode ativar/));
    fireEvent.click(within(row()).getByRole('switch', { name: /Ativa no caixa/ }));
    expect(within(row()).getByText('Pronta')).toBeTruthy();
    expect(points().find((p) => p.serial_number === MP_ID)!.online).toBe(true);

    mockFunction(200, { terminals: [] });
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByText('Fora da conta')).toBeTruthy());

    fireEvent.click(within(row()).getByRole('switch', { name: /Ativa no caixa/ }));
    expect(within(row()).getByText('Desativada')).toBeTruthy();
    expect(points().find((p) => p.serial_number === MP_ID)!.online).toBe(false);
  });

  it('consulta pendurada: o botão volta no prazo com o erro (auditoria #59 r1 P2-01)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      withCloud();
      expect(st().login('8888').ok).toBe(true);
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
      render(<PointAdmin />);
      const button = () => screen.getByRole('button', { name: /Conferir no Mercado Pago/ }) as HTMLButtonElement;
      fireEvent.click(button());
      await waitFor(() => expect(button().disabled).toBe(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/não respondeu a tempo/));
      expect(button().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resposta que chega depois de trocar a sessão da nuvem é ignorada (auditoria #59 r1, a verificar)', async () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    const row = st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: false });
    if (!row.ok) throw new Error(row.error);
    let answer: (v: { status: number; text: () => Promise<string> }) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { answer = r; })));
    render(<PointAdmin />);
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    act(() => {
      useTcheStore.setState({ cloud: { ...CLOUD, email: 'outra@loja', tenant_id: st().tenant.id } } as never);
    });
    await act(async () => {
      answer({ status: 200, text: async () => JSON.stringify({ terminals: [{ id: MP_ID, operating_mode: 'pdv' }] }) });
      await new Promise((r) => setTimeout(r, 0));
    });
    const r = screen.getByTestId(`point-${MP_ID}`);
    expect(within(r).queryByTestId('mp-state')).toBeNull();
    // Sem a lista desta sessão, ativar continua pedindo a conferência.
    fireEvent.click(within(r).getByRole('switch', { name: /Ativa no caixa/ }));
    expect(within(r).getByText(/Antes de ativar/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Conferir no Mercado Pago/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('desconectar e reconectar na mesma loja (mesma url e e-mail, outra sessão) dentro de um só act invalida a conferência em andamento (auditoria #59 r7 P2-01)', async () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    const row = st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: false });
    if (!row.ok) throw new Error(row.error);
    let answer: (v: { status: number; text: () => Promise<string> }) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { answer = r; })));
    render(<PointAdmin />);
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect((screen.getByRole('button', { name: /Conferindo|Conferir no Mercado Pago/ }) as HTMLButtonElement).disabled).toBe(true);
    // Uma atualização só: o React agrupa e as dependências finais (url, e-mail, loja) ficam iguais.
    act(() => {
      useTcheStore.setState({ cloud: null } as never);
      useTcheStore.setState({ cloud: { ...CLOUD, access_token: 'sessao-nova', refresh_token: 'r2', tenant_id: st().tenant.id } } as never);
    });
    await act(async () => {
      answer({ status: 200, text: async () => JSON.stringify({ terminals: [{ id: MP_ID, operating_mode: 'pdv' }] }) });
      await new Promise((r) => setTimeout(r, 0));
    });
    // A lista da conexão anterior não aparece, ativar pede nova conferência e o botão está livre.
    const r = screen.getByTestId(`point-${MP_ID}`);
    expect(within(r).queryByTestId('mp-state')).toBeNull();
    fireEvent.click(within(r).getByRole('switch', { name: /Ativa no caixa/ }));
    expect(within(r).getByText(/Antes de ativar/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Conferir no Mercado Pago/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('loja sem Access Token do Mercado Pago: aviso claro', async () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    mockFunction(412, { error: 'not_configured', message: 'Mercado Pago sem Access Token nesta loja.' });
    render(<PointAdmin />);
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Access Token/));
  });
});

describe('aviso de loja em nuvem sem internet', () => {
  it('só aparece com a loja na nuvem e o aparelho sem internet, com o texto combinado', () => {
    const view = render(<OfflineCloudBanner online={false} />);
    expect(screen.queryByText(OFFLINE_OLD_SYSTEM_TEXT)).toBeNull(); // loja local (sem nuvem): a fila local segue
    withCloud();
    view.rerender(<OfflineCloudBanner online={false} />);
    expect(screen.getByRole('alert').textContent).toContain('Sem internet: use o sistema antigo até voltar');
    view.rerender(<OfflineCloudBanner online />);
    expect(screen.queryByText(OFFLINE_OLD_SYSTEM_TEXT)).toBeNull();
  });

  it('com rede mas a nuvem sem responder também aparece, e some quando ela volta (auditoria #59 r1 P2-02)', async () => {
    withCloud();
    render(<OfflineCloudBanner online />);
    expect(screen.queryByText(OFFLINE_OLD_SYSTEM_TEXT)).toBeNull();
    // O laço da sincronização: todo pedido à nuvem falha na rede (navigator.onLine segue true).
    useTcheStore.setState({ outbox: [] } as never);
    await act(async () => { await syncOnce(async () => { throw new TypeError('Failed to fetch'); }, { forcePull: true }); });
    expect(cloudUnreachable()).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(OFFLINE_OLD_SYSTEM_TEXT);
    // Gateway fora (502/503/504) conta como sem nuvem; qualquer outra resposta, como nuvem no ar.
    const answer = (status: number) => trackCloudReachability(async () => ({ status }));
    await act(async () => { await answer(200)(); });
    expect(screen.queryByText(OFFLINE_OLD_SYSTEM_TEXT)).toBeNull();
    await act(async () => { await answer(503)(); });
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => { await syncOnce(async () => ({ ok: true, status: 200, text: async () => '[]' }), { forcePull: true }); });
    expect(cloudUnreachable()).toBe(false);
    expect(screen.queryByText(OFFLINE_OLD_SYSTEM_TEXT)).toBeNull();
  });

  it('fila vazia e leitura recente: a verificação leve acha a nuvem fora sem venda nem sincronização forçada (auditoria #59 r2 P2-01)', async () => {
    withCloud();
    useTcheStore.setState({ outbox: [], pullStatus: { ...(st().pullStatus ?? {}), last_pull_at: new Date().toISOString() } } as never);
    render(<OfflineCloudBanner online />);
    const calls: { url: string; method: string; auth: string }[] = [];
    const via = (fail: boolean) => async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization ?? '' });
      expect(init.body).toBeUndefined(); // não grava nada
      if (fail) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, text: async () => '[]' };
    };
    // Nenhum contato com a nuvem há mais de 15 s e o Supabase fora: a verificação acha e o aviso aparece.
    await act(async () => { await probeCloudIfIdle(via(true), Date.now() + PROBE_EVERY_MS); });
    expect(calls).toEqual([{ url: 'https://x.supabase.co/rest/v1/tenants?select=id&limit=1', method: 'GET', auth: 'Bearer jwt' }]);
    expect(screen.getByRole('alert').textContent).toContain(OFFLINE_OLD_SYSTEM_TEXT);
    // Contato recente (a própria verificação): não repete antes do intervalo.
    await act(async () => { await probeCloudIfIdle(via(true), Date.now() + 1_000); });
    expect(calls).toHaveLength(1);
    // A nuvem volta: a próxima verificação tira o aviso (401 de sessão vencida também prova que ela responde).
    await act(async () => { await probeCloudIfIdle(via(false), Date.now() + PROBE_EVERY_MS); });
    expect(screen.queryByText(OFFLINE_OLD_SYSTEM_TEXT)).toBeNull();
    // Sem loja na nuvem não verifica nada.
    act(() => { useTcheStore.setState({ cloud: null } as never); });
    await probeCloudIfIdle(via(true), Date.now() + 10 * PROBE_EVERY_MS);
    expect(calls).toHaveLength(2);
  });

  it('resposta 200 com corpo que nunca termina não trava a verificação seguinte (auditoria #59 r3 P2-01)', async () => {
    withCloud();
    let n = 0;
    const hanging = async () => { n += 1; return { ok: true, status: 200, text: () => new Promise<string>(() => undefined) }; };
    const first = probeCloudIfIdle(hanging, Date.now() + PROBE_EVERY_MS);
    await expect(Promise.race([first.then(() => 'fim'), new Promise((r) => setTimeout(() => r('pendurada'), 200))])).resolves.toBe('fim');
    expect(cloudUnreachable()).toBe(false);
    await probeCloudIfIdle(async () => { n += 1; throw new TypeError('Failed to fetch'); }, Date.now() + 2 * PROBE_EVERY_MS);
    expect(n).toBe(2);
    expect(cloudUnreachable()).toBe(true);
  });

  it('resposta antiga não sobrescreve a nova, nem na mesma loja nem depois da troca de loja (auditoria #59 r5 P2-03)', async () => {
    resetCloudReachability();
    const pending = () => {
      let resolve!: (r: { status: number }) => void;
      let reject!: (e: unknown) => void;
      const p = new Promise<{ status: number }>((res, rej) => { resolve = res; reject = rej; });
      return { p, resolve, reject };
    };
    // Mesma loja: o pedido mais antigo termina por último, falhando; o mais novo já mostrou a nuvem no ar.
    const oldReq = pending();
    const newReq = pending();
    const fOld = trackCloudReachability(() => oldReq.p);
    const fNew = trackCloudReachability(() => newReq.p);
    const a = fOld().catch(() => undefined);
    const b = fNew();
    newReq.resolve({ status: 200 });
    await b;
    expect(cloudUnreachable()).toBe(false);
    oldReq.reject(new TypeError('Failed to fetch'));
    await a;
    expect(cloudUnreachable()).toBe(false);
    // O mais antigo também não apaga uma falha mais nova.
    resetCloudReachability();
    const o2 = pending();
    const n2 = pending();
    const p1 = trackCloudReachability(() => o2.p)().catch(() => undefined);
    const p2 = trackCloudReachability(() => n2.p)().catch(() => undefined);
    n2.reject(new TypeError('Failed to fetch'));
    await p2;
    expect(cloudUnreachable()).toBe(true);
    o2.resolve({ status: 200 });
    await p1;
    expect(cloudUnreachable()).toBe(true);
    // Troca de loja: pedido pendente da A falha depois de a B responder 200.
    resetCloudReachability();
    const conectar = (tenant: string) => act(() => { useTcheStore.setState({ cloud: { ...CLOUD, tenant_id: tenant } } as never); });
    const LOJA_A = st().tenant.id;
    const LOJA_B = '0b0b0b0b-0b0b-40b0-80b0-0b0b0b0b0b0b';
    conectar(LOJA_A);
    const a3 = pending();
    const pa = trackCloudReachability(() => a3.p)().catch(() => undefined);
    conectar(LOJA_B);
    const pb = trackCloudReachability(async () => ({ status: 200 }))();
    await pb;
    a3.reject(new TypeError('Failed to fetch'));
    await pa;
    expect(cloudUnreachable()).toBe(false);
    // E o pedido pendente da A que termina com 503 depois também não acende o aviso da B.
    resetCloudReachability();
    conectar(LOJA_A);
    const a4 = pending();
    const pa4 = trackCloudReachability(() => a4.p)().catch(() => undefined);
    conectar(LOJA_B);
    const pb4 = trackCloudReachability(async () => ({ status: 200 }))();
    await pb4;
    a4.resolve({ status: 503 });
    await pa4;
    expect(cloudUnreachable()).toBe(false);
    resetCloudReachability();
  });

  it('o monitor segue a conexão ativa da loja: troca de loja, pedido atrasado, reconexão e horário do último contato (auditoria #59 r6 P2-01)', async () => {
    const LOJA_A = st().tenant.id;
    const LOJA_B = '0b0b0b0b-0b0b-40b0-80b0-0b0b0b0b0b0b';
    const connect = (tenant: string, token = 'jwt') => act(() => { useTcheStore.setState({ cloud: { ...CLOUD, access_token: token, tenant_id: tenant } } as never); });
    const disconnect = () => act(() => { useTcheStore.setState({ cloud: null } as never); });
    const pending = () => {
      let resolve!: (r: { status: number }) => void;
      let reject!: (e: unknown) => void;
      const p = new Promise<{ status: number }>((res, rej) => { resolve = res; reject = rej; });
      return { p, resolve, reject };
    };

    // (1) A tem um pedido pendente; o aparelho troca para B, que ainda não pediu nada; o pedido da A termina fora do ar.
    connect(LOJA_A);
    const reqA = pending();
    const doneA = trackCloudReachability(() => reqA.p)().catch(() => undefined);
    connect(LOJA_B);
    reqA.reject(new TypeError('Failed to fetch'));
    await doneA;
    expect(cloudUnreachable()).toBe(false);
    expect(lastCloudContactAt()).toBe(0);

    // (2) Um fluxo da A que só dispara o fetch depois de B já ter respondido não vira a loja atual de novo.
    resetCloudReachability();
    connect(LOJA_A);
    const lateA = trackCloudReachability(async () => { throw new TypeError('Failed to fetch'); });
    connect(LOJA_B);
    await trackCloudReachability(async () => ({ status: 200 }))();
    expect(cloudUnreachable()).toBe(false);
    await lateA().catch(() => undefined);
    expect(cloudUnreachable()).toBe(false);
    // ...e a B continua valendo: uma falha dela agora acende o aviso.
    await trackCloudReachability(async () => ({ status: 503 }))();
    expect(cloudUnreachable()).toBe(true);

    // (3) Desconecta e reconecta na mesma loja com outra sessão: o pedido da sessão antiga não vale mais.
    resetCloudReachability();
    connect(LOJA_A, 'sessao-antiga');
    const old = pending();
    const oldDone = trackCloudReachability(() => old.p)().catch(() => undefined);
    disconnect();
    connect(LOJA_A, 'sessao-nova');
    old.reject(new TypeError('Failed to fetch'));
    await oldDone;
    expect(cloudUnreachable()).toBe(false);
    // Renovar o token (mesma conexão) não troca de conexão: o pedido em andamento continua valendo.
    const renewing = pending();
    const renewDone = trackCloudReachability(() => renewing.p)();
    connect(LOJA_A, 'token-renovado');
    renewing.resolve({ status: 503 });
    await renewDone;
    expect(cloudUnreachable()).toBe(true);

    // (4) A loja nova não herda o horário do último contato da anterior (a primeira verificação não é adiada).
    resetCloudReachability();
    connect(LOJA_A);
    await trackCloudReachability(async () => ({ status: 200 }))();
    expect(lastCloudContactAt()).toBeGreaterThan(0);
    connect(LOJA_B);
    expect(lastCloudContactAt()).toBe(0);
    const probe = vi.fn(async () => ({ status: 503 }));
    await probeCloudIfIdle(probe as never);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cloudUnreachable()).toBe(true);

    // (5) Verificação da loja anterior pendurada não atrasa a primeira da loja nova.
    resetCloudReachability();
    connect(LOJA_A);
    void probeCloudIfIdle((() => new Promise(() => undefined)) as never);
    connect(LOJA_B);
    const probeB = vi.fn(async () => ({ status: 200 }));
    await probeCloudIfIdle(probeB as never);
    expect(probeB).toHaveBeenCalledTimes(1);
    resetCloudReachability();
  });

  it('sem lock de escrita ou armazenamento provisório: o laço ainda verifica a nuvem (só GET, nenhuma escrita) e o aviso aparece (auditoria #59 r5 P2-02)', async () => {
    vi.useFakeTimers();
    storage.status = 'readonly';
    try {
      withCloud();
      const calls: { url: string; method: string; body?: string }[] = [];
      vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url: new URL(url).pathname + new URL(url).search, method: init?.method ?? 'GET', body: init?.body });
        return Promise.reject(new TypeError('Failed to fetch'));
      }));
      function Shell() {
        useCloudSync(true);
        return <OfflineCloudBanner online />;
      }
      render(<Shell />);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000 + PROBE_EVERY_MS + 1_000); });
      expect(calls.length).toBeGreaterThan(0);
      // Só a leitura leve de diagnóstico: nada de fila, leitura de contas, NFC-e nem escrita.
      expect(calls.every((c) => c.method === 'GET' && c.body === undefined && c.url === '/rest/v1/tenants?select=id&limit=1')).toBe(true);
      expect(cloudUnreachable()).toBe(true);
      expect(screen.getByRole('alert').textContent).toContain(OFFLINE_OLD_SYSTEM_TEXT);
    } finally {
      storage.status = 'ok';
      vi.useRealTimers();
    }
  });

  it('o laço da nuvem faz a verificação sozinho: Supabase mudo, nenhuma resposta, aviso antes do prazo da rodada (auditoria #59 r2 P2-01)', async () => {
    vi.useFakeTimers();
    try {
      withCloud();
      const urls: string[] = [];
      // Nenhum pedido responde nem falha (servidor mudo): a rodada fica esperando o prazo dela (30 s).
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        urls.push(new URL(url).pathname + new URL(url).search);
        return new Promise(() => undefined);
      }));
      function Shell() {
        useCloudSync(true);
        return <OfflineCloudBanner online />;
      }
      render(<Shell />);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 1_000); });
      // A verificação (prazo de 10 s) já achou a nuvem fora, antes de a rodada vencer.
      expect(urls).toContain('/rest/v1/tenants?select=id&limit=1');
      expect(cloudUnreachable()).toBe(true);
      expect(screen.getByRole('alert').textContent).toContain(OFFLINE_OLD_SYSTEM_TEXT);
    } finally {
      vi.useRealTimers();
    }
  });
});
