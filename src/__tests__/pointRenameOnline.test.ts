/**
 * Renomear a Point não pode regravar `online` (nem ativar/desativar regravar o nome): o evento de sincronização
 * leva só os campos que a pessoa mudou. Um aparelho com o cadastro desatualizado (Point ainda "ativa" para ele) que
 * renomeia sobrescrevia a desativação feita em outro aparelho (observação do GPT na r8 do PR #59).
 */
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { buildSyncRequest } from '../lib/sync/supabaseSync';
import type { PointListing } from '../lib/payments/pointTerminals';

const st = () => useTcheStore.getState();
const MP_ID = 'NEWLAND_N950__N950NCB801293324';
const CLOUD = { url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9_999_999_999 };
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' };
const READY: PointListing = { kind: 'ok', terminals: [{ id: MP_ID, operating_mode: 'pdv' }] };
const terminalEvents = () => st().outbox.filter((e) => e.table === 'pos_terminals');
const body = (e: ReturnType<typeof terminalEvents>[number]) => JSON.parse(buildSyncRequest(e, CFG).body ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  st().resetDemo();
  act(() => {
    useTcheStore.setState({ cloud: { ...CLOUD, tenant_id: st().tenant.id }, outbox: [] } as never);
  });
  expect(st().login('8888').ok).toBe(true);
});

function pointAtivaNesteAparelho() {
  const r = st().savePointTerminal({ name: 'Point Caixa', serial_number: MP_ID, active: true }, READY);
  if (!r.ok) throw new Error('cadastro falhou');
  act(() => useTcheStore.setState({ outbox: [] } as never));
  return r.data;
}

describe('renomear a Point não regrava `online`', () => {
  it('o PATCH de renomear leva só o nome (cadastro velho, Point ainda ativa neste aparelho)', () => {
    const t = pointAtivaNesteAparelho();
    const r = st().savePointTerminal({ id: t.id, name: 'Point Balcão', serial_number: MP_ID, active: t.online });
    expect(r.ok).toBe(true);
    const [e] = terminalEvents();
    expect(e).toMatchObject({ op: 'UPDATE', row_id: t.id });
    const req = buildSyncRequest(e!, CFG);
    expect(req.method).toBe('PATCH');
    expect(body(e!)).toEqual({ name: 'Point Balcão' });
    // Sem o PATCH achar a linha (INSERT recusado antes), o reenvio ainda sobe a linha inteira.
    expect(JSON.parse(req.fallback?.body ?? '{}')).toMatchObject({ id: t.id, name: 'Point Balcão', serial_number: MP_ID, online: true });
  });

  it('ativar/desativar leva só `online`, sem regravar o nome', () => {
    const t = pointAtivaNesteAparelho();
    expect(st().savePointTerminal({ id: t.id, name: t.name, serial_number: MP_ID, active: false }).ok).toBe(true);
    expect(body(terminalEvents()[0]!)).toEqual({ online: false });
  });

  it('mudar nome e ativação juntos leva os dois campos', () => {
    const t = pointAtivaNesteAparelho();
    expect(st().savePointTerminal({ id: t.id, name: 'Point Nova', serial_number: MP_ID, active: false }).ok).toBe(true);
    expect(body(terminalEvents()[0]!)).toEqual({ name: 'Point Nova', online: false });
  });

  it('evento da fila de versão anterior (sem a lista de campos) sobe a linha inteira como antes', () => {
    const t = pointAtivaNesteAparelho();
    const legacy = { id: 'e-velho', table: 'pos_terminals' as const, op: 'UPDATE' as const, row_id: t.id, payload: { ...t, name: 'Velha' }, created_at: new Date().toISOString() };
    expect(body(legacy as never)).toMatchObject({ id: t.id, name: 'Velha', online: true });
  });
});

describe('sem mudança não sobe evento', () => {
  it('salvar a Point igual não grava evento (PATCH vazio cairia no reenvio da linha inteira)', () => {
    const t = pointAtivaNesteAparelho();
    expect(st().savePointTerminal({ id: t.id, name: t.name, serial_number: MP_ID, active: t.online }).ok).toBe(true);
    expect(terminalEvents()).toEqual([]);
  });
});
