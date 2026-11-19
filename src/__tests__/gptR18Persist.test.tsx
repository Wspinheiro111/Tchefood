// @vitest-environment jsdom
// GPT, rodada 18 do PR #54.
// P1-01: o acerto com o entregador só vai à nuvem com o estado recuperável depois de reiniciar o app
//        (IndexedDB que recusa ou aborta a gravação, cópia no localStorage, reabertura com o IndexedDB bom).
// P2-01: fechar e reabrir o PIN do gerente com a confirmação ainda esperando não manda de novo.
// P2-02: confirmação recusada sem um Error (texto, null, undefined) não trava o PIN do gerente.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import type { ActionResult } from '../types';

// ---------------------------------------------------------------------------------------------
// IndexedDB de mentira, com o disco fora do módulo (sobrevive à "reabertura" do app).
// 'throw': a gravação falha; 'abort': o pedido dá certo e a transação aborta depois (nada vai ao disco).
type Mode = 'ok' | 'throw' | 'abort';
const disk = new Map<string, unknown>();
let mode: Mode = 'ok';
/** Chamado depois de cada leitura (get) de uma chave no IndexedDB de mentira: simula outra gravação no meio. */
let afterGet: ((key: string) => void) | null = null;
const later = (f: () => void) => setTimeout(f, 0);

function fakeIndexedDB() {
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    transaction: (_store: string, txMode: IDBTransactionMode) => {
      const t: Record<string, unknown> & { oncomplete?: (() => void) | null; onabort?: (() => void) | null; onerror?: (() => void) | null } = { error: null };
      const staged: (() => void)[] = [];
      // Transação só de leitura enxerga o disco como estava quando abriu (como o IndexedDB de verdade).
      const snapshot = txMode === 'readonly' ? new Map(disk) : null;
      const request = (run: () => unknown) => {
        const req: { onsuccess?: (() => void) | null; onerror?: (() => void) | null; result?: unknown; error?: unknown } = {};
        later(() => {
          if (txMode === 'readwrite' && mode === 'throw') {
            req.error = new DOMException('cheio', 'QuotaExceededError');
            t.error = req.error;
            req.onerror?.();
            t.onerror?.();
            t.onabort?.();
            return;
          }
          req.result = run();
          req.onsuccess?.();
          later(() => {
            if (txMode === 'readwrite' && mode === 'abort') {
              t.error = new DOMException('abortada', 'AbortError');
              t.onabort?.();
              return;
            }
            for (const f of staged) f();
            t.oncomplete?.();
          });
        });
        return req;
      };
      t.objectStore = () => ({
        get: (k: string) => request(() => {
          const v = (snapshot ?? disk).get(k);
          later(() => afterGet?.(k));
          return v;
        }),
        put: (v: unknown, k: string) => request(() => { staged.push(() => disk.set(k, structuredClone(v))); return k; }),
        delete: (k: string) => request(() => { staged.push(() => disk.delete(k)); return undefined; }),
      });
      return t;
    },
  };
  return {
    open: () => {
      const req: { onsuccess?: (() => void) | null; onupgradeneeded?: (() => void) | null; onerror?: (() => void) | null; result?: unknown } = {};
      later(() => { req.result = db; req.onsuccess?.(); });
      return req;
    },
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('GPT r18 P1-01: o acerto só sai com o estado que volta depois de reiniciar', () => {
  beforeEach(() => {
    disk.clear();
    localStorage.clear();
    mode = 'ok';
    afterGet = null;
    (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    vi.resetModules();
  });

  it.each<Mode>(['throw', 'abort'])('IndexedDB com S0, gravação de S1 falha (%s), cópia no localStorage: reabrindo, S1 volta', async (fail) => {
    vi.resetModules();
    const store = await import('../store/useTcheStore');
    await tick();
    const S = store.useTcheStore;
    const name = S.persist.getOptions().name!;
    S.setState({ courierSettlePending: [{ id: 'acerto-S0' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    expect(JSON.stringify(disk.get(name))).toContain('acerto-S0');

    mode = fail;
    S.setState({ courierSettlePending: [{ id: 'acerto-S1' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    await tick();

    // App fechado e aberto de novo, IndexedDB bom outra vez (ainda com S0 no disco).
    mode = 'ok';
    vi.resetModules();
    const { idbStorage } = await import('../lib/idbStorage');
    const raw = await idbStorage.getItem(name);
    expect(raw).toContain('acerto-S1');
    expect(raw).not.toContain('acerto-S0');

    // A próxima gravação boa no IndexedDB vale de novo (a cópia velha do localStorage não volta).
    await idbStorage.setItem(name, '{"state":{"courierSettlePending":[{"id":"acerto-S2"}]},"version":12}');
    vi.resetModules();
    const again = await import('../lib/idbStorage');
    expect(await again.idbStorage.getItem(name)).toContain('acerto-S2');
  });

  it('GPT r19 P2-01: o IndexedDB guarda o texto puro na chave do estado (a versão anterior do app lê o mesmo registro)', async () => {
    vi.resetModules();
    const store = await import('../store/useTcheStore');
    await tick();
    const name = store.useTcheStore.persist.getOptions().name!;
    store.useTcheStore.setState({ courierSettlePending: [{ id: 'acerto-R1' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    const raw = disk.get(name);
    expect(typeof raw).toBe('string');
    // Leitor da versão anterior: JSON.parse direto do valor, sem conhecer o número da gravação.
    expect(JSON.parse(raw as string).state.courierSettlePending[0].id).toBe('acerto-R1');
    // Registro antigo (texto puro, sem número): continua lido.
    disk.delete(name + '::seq');
    vi.resetModules();
    const again = await import('../lib/idbStorage');
    expect(await again.idbStorage.getItem(name)).toBe(raw);
  });

  it('GPT r20 P2-01: S0, gravação S1 recusada, volta a versão anterior, grava S2, atualiza de novo: S2 fica (a cópia velha não ganha)', async () => {
    vi.resetModules();
    const store = await import('../store/useTcheStore');
    await tick();
    const S = store.useTcheStore;
    const name = S.persist.getOptions().name!;
    S.setState({ courierSettlePending: [{ id: 'acerto-S0' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    mode = 'throw';
    S.setState({ courierSettlePending: [{ id: 'acerto-S1' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    await tick();
    expect(localStorage.getItem(name + '::copia')).toContain('acerto-S1');
    // A versão anterior do app lê o IndexedDB (S0) e grava S2 direto na chave do estado, sem mexer em `::seq`.
    mode = 'ok';
    const s2 = '{"state":{"courierSettlePending":[{"id":"acerto-S2"}]},"version":12}';
    disk.set(name, s2);
    // Atualiza de novo: o texto que a versão anterior gravou é o mais novo; a cópia S1 não volta por cima.
    vi.resetModules();
    const { idbStorage } = await import('../lib/idbStorage');
    expect(await idbStorage.getItem(name)).toBe(s2);
    expect(await idbStorage.getItem(name)).toBe(s2);
  });

  it('GPT r20 P2-01: cópia mais nova com o IndexedDB bom de novo entra no IndexedDB (a versão anterior passa a ler S1) e a cópia some', async () => {
    vi.resetModules();
    const store = await import('../store/useTcheStore');
    await tick();
    const S = store.useTcheStore;
    const name = S.persist.getOptions().name!;
    S.setState({ courierSettlePending: [{ id: 'acerto-S0' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    mode = 'throw';
    S.setState({ courierSettlePending: [{ id: 'acerto-S1' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    await tick();
    mode = 'ok';
    vi.resetModules();
    const { idbStorage } = await import('../lib/idbStorage');
    expect(await idbStorage.getItem(name)).toContain('acerto-S1');
    await tick();
    expect(String(disk.get(name))).toContain('acerto-S1');
    expect(localStorage.getItem(name + '::copia')).toBeNull();
    expect(await idbStorage.getItem(name)).toContain('acerto-S1');
  });

  it('GPT r20 P2-02: gravação concorrente entre a leitura do texto e a do número: nunca o texto de uma versão com o número de outra', async () => {
    vi.resetModules();
    const { idbStorage } = await import('../lib/idbStorage');
    const name = 'tchefood-teste';
    // IndexedDB com S0 (número 100); cópia de recuperação com S1 (número 101).
    const fp = (v: string) => {
      let h = 5381;
      for (let i = 0; i < v.length; i++) h = ((h << 5) + h + v.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16) + '.' + v.length;
    };
    mode = 'ok';
    await idbStorage.getItem(name); // abre o banco
    disk.set(name, 'S0');
    disk.set(name + '::seq', `100:${fp('S0')}`);
    localStorage.setItem(name + '::copia', JSON.stringify({ seq: 101, v: 'S1' }));
    // Outra gravação confirma S2 (número 102) logo depois de o texto ser lido (a cópia ainda não foi removida).
    afterGet = (key) => {
      if (key !== name) return;
      afterGet = null;
      disk.set(name, 'S2');
      disk.set(name + '::seq', `102:${fp('S2')}`);
    };
    const got = await idbStorage.getItem(name);
    // Antes: texto S0 com o número 102 (mistura que nunca foi gravada) → devolvia S0. Agora: uma versão inteira.
    expect(['S1', 'S2']).toContain(got);
  });

  it('IndexedDB e localStorage recusam: awaitPersisted devolve false (o acerto não sai)', async () => {
    vi.resetModules();
    const store = await import('../store/useTcheStore');
    await tick();
    mode = 'abort';
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('cheio', 'QuotaExceededError'); });
    store.useTcheStore.setState({ courierSettlePending: [{ id: 'acerto-S1' } as never] });
    expect(await store.awaitPersisted()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GPT r18 P2-01/P2-02: PIN do gerente com confirmação assíncrona', () => {
  afterEach(() => cleanup());

  const props = (onSubmit: (pin: string, reason: string) => Promise<ActionResult<null>>, open: boolean, onClose = () => {}) => ({
    open, onClose, title: 'Pagar', summary: 'x', confirmLabel: 'Autorizar', quickReasons: ['Acerto do entregador'], onSubmit, onSuccess: () => {},
  });
  const typePin = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acerto do entregador' }));
    for (const d of ['1', '2', '3', '9']) fireEvent.click(screen.getByRole('button', { name: d }));
  };

  it('P2-01: fechar e reabrir com a confirmação esperando não manda de novo; a resposta velha não mexe no modal novo', async () => {
    let settle!: (r: ActionResult<null>) => void;
    const onSubmit = vi.fn(() => new Promise<ActionResult<null>>((res) => { settle = res; }));
    const onClose = vi.fn();
    const view = render(createElement(ManagerAuthSheet<null>, props(onSubmit, true, onClose)));
    typePin();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Fechar com a confirmação esperando: não fecha.
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).not.toHaveBeenCalled();
    // Quem abriu fecha e reabre por fora: a trava continua.
    view.rerender(createElement(ManagerAuthSheet<null>, props(onSubmit, false, onClose)));
    view.rerender(createElement(ManagerAuthSheet<null>, props(onSubmit, true, onClose)));
    typePin();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // A resposta velha (recusa) chega: não aparece no modal novo, que fica livre para tentar.
    await act(async () => { settle({ ok: false, error: 'resposta velha' }); await tick(); });
    expect(screen.queryByText('resposta velha')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it.each([new Error('falha'), 'falha', null, undefined])('P2-02: recusa com %s mostra um erro e deixa tentar de novo', async (reason) => {
    const onSubmit = vi.fn(() => Promise.reject(reason));
    render(createElement(ManagerAuthSheet<null>, props(onSubmit, true)));
    typePin();
    await act(async () => { await tick(); });
    expect(screen.getByText(reason instanceof Error ? 'falha' : typeof reason === 'string' ? 'falha' : /Não foi possível confirmar/)).toBeTruthy();
    typePin();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
