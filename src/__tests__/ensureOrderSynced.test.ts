/**
 * Auditoria r4 P1-01 do PR #49: antes de cobrar na Point Smart pela nuvem, a conta precisa estar no servidor
 * como o aparelho a mostra. syncOnce() resolve normalmente mesmo quando não sincronizou nada (outra rodada em
 * andamento, sem sessão, evento recusado, nuvem fora): ensureOrderSynced não toma isso por sucesso.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureOrderSynced, freshCloudConfig, syncOnce } from '../lib/sync/useCloudSync';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { FetchLike } from '../lib/sync/supabaseSync';
import type { Order, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const ORDER_ID = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const OTHER_ID = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';

const session = (): CloudSession => ({
  url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: st().tenant.id,
});

function seedOrder(remaining: number): void {
  const base = (st().orders[0] ?? {}) as Order;
  const order = { ...base, id: ORDER_ID, tenant_id: st().tenant.id, status: 'OPEN', remaining_balance: remaining } as Order;
  useTcheStore.setState({ orders: [order, ...st().orders.filter((o) => o.id !== ORDER_ID)] });
}

const event = (id: string, over: Partial<SyncEvent> = {}): SyncEvent => ({
  id, table: 'orders', op: 'UPDATE', row_id: ORDER_ID, payload: { id: ORDER_ID, remaining_balance: 80 }, created_at: new Date().toISOString(), ...over,
});

/** Responde cada PATCH/POST com `status`; conta as chamadas. */
function cloud(status: number | (() => Promise<number>)) {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const s = typeof status === 'number' ? status : await status();
    return { ok: s >= 200 && s < 300, status: s, text: async () => (s >= 400 ? '{"message":"recusado"}' : '[{"id":"x"}]') };
  };
  return { fetchFn, calls };
}

beforeEach(() => {
  st().resetDemo();
  useTcheStore.setState({ cloud: session(), outbox: [], syncRejected: [], pullStatus: { last_pull_at: new Date().toISOString() } as never });
  seedOrder(80);
});

describe('ensureOrderSynced (auditoria r4 P1-01)', () => {
  it('sem nada da conta na fila: devolve o saldo daqui em centavos, sem chamar a nuvem', async () => {
    const { fetchFn, calls } = cloud(200);
    expect(await ensureOrderSynced(ORDER_ID, fetchFn)).toEqual({ ok: true, balance_cents: 8000 });
    expect(calls).toHaveLength(0);
  });

  it('evento da conta na fila e aceito pela nuvem: sobe e libera', async () => {
    useTcheStore.setState({ outbox: [event('e1')] });
    const { fetchFn, calls } = cloud(200);
    expect(await ensureOrderSynced(ORDER_ID, fetchFn)).toEqual({ ok: true, balance_cents: 8000 });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(st().outbox).toHaveLength(0);
  });

  it('syncOnce resolve normalmente, mas o evento da conta continua pendente (nuvem fora): não libera', async () => {
    useTcheStore.setState({ outbox: [event('e1')] });
    const { fetchFn } = cloud(503);
    await expect(syncOnce(fetchFn)).resolves.toBeUndefined(); // o que o driver antigo tomava por "ok"
    expect(st().outbox).toHaveLength(1);
    const r = await ensureOrderSynced(ORDER_ID, fetchFn);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringMatching(/esperando a nuvem/) });
  });

  it('evento da conta recusado pela nuvem: não libera', async () => {
    useTcheStore.setState({ outbox: [event('e1')] });
    const { fetchFn } = cloud(400);
    const r = await ensureOrderSynced(ORDER_ID, fetchFn);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/recusou uma alteração desta conta/) });
    // Recusa antiga, já fora da fila, também segura.
    const again = await ensureOrderSynced(ORDER_ID, cloud(200).fetchFn);
    expect(again.ok).toBe(false);
  });

  it('item, pagamento ou cashback da conta (payload.order_id) também contam como evento da conta', async () => {
    for (const table of ['order_items', 'payments', 'cashback_ledger'] as const) {
      useTcheStore.setState({ outbox: [event(`e-${table}`, { table, op: 'INSERT', row_id: 'x', payload: { id: 'x', order_id: ORDER_ID } })], syncRejected: [] });
      const r = await ensureOrderSynced(ORDER_ID, cloud(503).fetchFn);
      expect(r.ok, table).toBe(false);
    }
  });

  it('evento de outra conta pendente não segura esta', async () => {
    useTcheStore.setState({ outbox: [event('e1', { row_id: OTHER_ID, payload: { id: OTHER_ID } })] });
    expect(await ensureOrderSynced(ORDER_ID, cloud(503).fetchFn)).toEqual({ ok: true, balance_cents: 8000 });
  });

  it('sem sessão da nuvem ou sem a conta neste aparelho: não libera', async () => {
    useTcheStore.setState({ cloud: null });
    expect((await ensureOrderSynced(ORDER_ID, cloud(200).fetchFn)).ok).toBe(false);
    useTcheStore.setState({ cloud: session() });
    expect((await ensureOrderSynced('7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c', cloud(200).fetchFn)).ok).toBe(false);
  });

  it('sincronização em andamento: espera ela terminar em vez de tomar "já está rodando" por sucesso', async () => {
    useTcheStore.setState({ outbox: [event('e1')] });
    let release!: (s: number) => void;
    const gate = new Promise<number>((r) => { release = r; });
    const slow = cloud(() => gate);
    const running = syncOnce(slow.fetchFn); // a rodada do laço de 5 s, pendurada na nuvem
    await new Promise((r) => setTimeout(r, 0));
    // syncOnce concorrente continua voltando na hora (comportamento de sempre do laço).
    await expect(syncOnce(cloud(200).fetchFn)).resolves.toBeUndefined();
    let settled = false;
    const ensured = ensureOrderSynced(ORDER_ID, cloud(200).fetchFn).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // não respondeu enquanto o evento da conta ainda estava subindo
    release(200);
    await running;
    expect(await ensured).toEqual({ ok: true, balance_cents: 8000 });
  });

  it('sincronização em andamento que termina sem subir o evento da conta: tenta de novo e não libera sem prova', async () => {
    useTcheStore.setState({ outbox: [event('e1')] });
    let release!: (s: number) => void;
    const gate = new Promise<number>((r) => { release = r; });
    const running = syncOnce(cloud(() => gate).fetchFn);
    await new Promise((r) => setTimeout(r, 0));
    const down = cloud(503);
    const ensured = ensureOrderSynced(ORDER_ID, down.fetchFn);
    release(503);
    await running;
    expect((await ensured).ok).toBe(false);
    expect(down.calls.length).toBeGreaterThanOrEqual(1); // tentou subir ele mesmo depois da rodada alheia
  });

  it('mesa que aponta para a conta (current_order_id) também é evento da conta', async () => {
    useTcheStore.setState({ outbox: [event('e1', { table: 'dining_tables', row_id: 'mesa-1', payload: { id: 'mesa-1', current_order_id: ORDER_ID } })] });
    expect((await ensureOrderSynced(ORDER_ID, cloud(503).fetchFn)).ok).toBe(false);
  });

  it('a preparação da cobrança só sobe a fila: não lê os cadastros da nuvem (fora do prazo dela)', async () => {
    useTcheStore.setState({ outbox: [event('e1')], pullStatus: { last_pull_at: null } as never });
    const { fetchFn, calls } = cloud(200);
    expect((await ensureOrderSynced(ORDER_ID, fetchFn)).ok).toBe(true);
    expect(calls.every((c) => c.startsWith('PATCH') || c.startsWith('POST'))).toBe(true);
    expect(calls.some((c) => c.startsWith('GET'))).toBe(false);
  });
});

describe('renovação do token uma por vez (revisão da r4)', () => {
  it('cobrança e laço com o token vencendo ao mesmo tempo: uma renovação só, com o mesmo refresh token', async () => {
    useTcheStore.setState({ cloud: { ...session(), expires_at: Math.floor(Date.now() / 1000) }, outbox: [event('e1')] });
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchFn: FetchLike = async (url, init) => {
      if (url.includes('/auth/v1/token')) {
        refreshes += 1;
        await gate;
        const jwt = `h.${btoa(JSON.stringify({ app_metadata: { tenant_id: st().tenant.id } })).replace(/=+$/, '')}.s`;
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: jwt, refresh_token: 'r2', expires_at: 9e9 }) };
      }
      return { ok: true, status: 200, text: async () => (init.method === 'PATCH' ? '[{"id":"x"}]' : '') };
    };
    const a = freshCloudConfig(fetchFn);
    const b = syncOnce(fetchFn);
    const c = freshCloudConfig(fetchFn);
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshes).toBe(1);
    release();
    await Promise.all([a, b, c]);
    expect(refreshes).toBe(1);
    expect((await a)?.accessToken).toMatch(/^h\./);
    expect(st().cloud?.refresh_token).toBe('r2');
  });
});

