// @vitest-environment jsdom
/**
 * Cadastro da Point Smart (aba Point Smart da Retaguarda) e o aviso de loja em nuvem sem internet.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { PointAdmin } from '../screens/admin/PointAdmin';
import { OFFLINE_OLD_SYSTEM_TEXT, OfflineCloudBanner } from '../components/OfflineCloudBanner';
import { fetchPointTerminals, pairingState, parseTerminalsReply } from '../lib/payments/pointTerminals';

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

function mockFunction(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
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
    const r = st().savePointTerminal({ name: ' Point Caixa ', serial_number: ` ${MP_ID} `, active: true });
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
    expect(st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true }).ok).toBe(true);
    expect(st().savePointTerminal({ name: 'Outra', serial_number: MP_ID.toLowerCase(), active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/já está cadastrado/) });
    expect(st().savePointTerminal({ name: 'Outra', serial_number: 'STONE-01', active: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Stone Salão 01/) });
    expect(points()).toHaveLength(1);
  });

  it('o ID não muda depois do cadastro; nome e ativa/desativada mudam (UPDATE na nuvem)', () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    const row = st().savePointTerminal({ name: 'Point', serial_number: MP_ID, active: true });
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
    expect(await fetchPointTerminals({ config: cfg, fetch: reply(502, { error: 'mp_unavailable', message: 'O Mercado Pago não devolveu' }) })).toEqual({ kind: 'error', message: 'O Mercado Pago não devolveu' });
    expect(await fetchPointTerminals({ config: cfg, fetch: async () => { throw new TypeError('Failed to fetch'); } })).toMatchObject({ kind: 'error' });
    expect(await fetchPointTerminals({ config: async () => null, fetch: reply(200, {}) })).toEqual({ kind: 'no_cloud' });
    expect(parseTerminalsReply(JSON.stringify({ terminals: [{ id: MP_ID, operating_mode: 'pdv' }, { id: '', operating_mode: 'pdv' }] }))).toBeNull();
    expect(parseTerminalsReply(JSON.stringify({ terminals: [{ id: MP_ID, operating_mode: 'PDV' }] }))).toBeNull();
    expect(parseTerminalsReply('nada')).toBeNull();
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

  it('cadastra, confere no Mercado Pago e mostra o estado de cada uma; desativa no caixa', async () => {
    withCloud();
    expect(st().login('8888').ok).toBe(true);
    render(<PointAdmin />);
    expect(screen.getByText('Nenhuma Point cadastrada nesta loja.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/NEWLAND/), { target: { value: MP_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar Point' }));
    const row = () => screen.getByTestId(`point-${MP_ID}`);
    expect(within(row()).getByText('Não conferida')).toBeTruthy();

    mockFunction(200, { terminals: [{ id: MP_ID, operating_mode: 'standalone' }, { id: 'NEWLAND_N950__SEGUNDA', operating_mode: 'pdv' }] });
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByText('Fora do modo PDV')).toBeTruthy());
    // A outra maquininha da conta aparece para cadastrar, com o ID sugerido.
    expect(screen.getByText('NEWLAND_N950__SEGUNDA')).toBeTruthy();
    expect((screen.getByPlaceholderText(/NEWLAND/) as HTMLInputElement).placeholder).toBe('NEWLAND_N950__SEGUNDA');

    mockFunction(200, { terminals: [{ id: MP_ID, operating_mode: 'pdv' }] });
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByText('Pronta')).toBeTruthy());

    mockFunction(200, { terminals: [] });
    fireEvent.click(screen.getByRole('button', { name: /Conferir no Mercado Pago/ }));
    await waitFor(() => expect(within(row()).getByText('Fora da conta')).toBeTruthy());

    fireEvent.click(within(row()).getByRole('switch', { name: /Ativa no caixa/ }));
    expect(within(row()).getByText('Desativada')).toBeTruthy();
    expect(points()[0]!.online).toBe(false);
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
});
