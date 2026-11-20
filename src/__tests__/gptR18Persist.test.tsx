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
let onPut: ((key: string) => void) | null = null;
/** Chamado quando uma transação de escrita é recusada (modo 'throw'): simula outra aba agindo durante a recuperação recusada. */
let onFail: (() => void) | null = null;
/** true: toda transação só de leitura falha (leitura degradada). */
let readFails = false;
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
      let pending = 0; // a transação só termina (oncomplete) quando todos os pedidos acabaram, como no IndexedDB
      const request = (run: () => unknown) => {
        pending++;
        const req: { onsuccess?: (() => void) | null; onerror?: (() => void) | null; result?: unknown; error?: unknown } = {};
        later(() => {
          if ((txMode === 'readwrite' && mode === 'throw') || (txMode === 'readonly' && readFails)) {
            onFail?.();
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
            if (--pending > 0) return;
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
        put: (v: unknown, k: string) => request(() => { onPut?.(k); staged.push(() => disk.set(k, structuredClone(v))); return k; }),
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

/** Cópias de emergência no localStorage (uma chave por gravação) e conflitos guardados. */
const copies = (name: string) => Object.keys(localStorage).filter((key) => key.startsWith(name + '::copia')).sort().map((key) => ({ key, ...(JSON.parse(localStorage.getItem(key)!) as { seq: number; v: string; id?: string }) }));
const conflicts = (name: string) => Object.keys(localStorage).filter((key) => key.startsWith(name + '::conflito')).map((key) => JSON.parse(localStorage.getItem(key)!) as { v: string });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('GPT r18 P1-01: o acerto só sai com o estado que volta depois de reiniciar', () => {
  beforeEach(() => {
    disk.clear();
    localStorage.clear();
    mode = 'ok';
    afterGet = null;
    onPut = null;
    onFail = null;
    readFails = false;
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
    expect(JSON.stringify(copies(name))).toContain('acerto-S1');
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
    expect(copies(name)).toEqual([]);
    expect(await idbStorage.getItem(name)).toContain('acerto-S1');
  });

  it('GPT r20 P2-02: gravação concorrente entre a leitura do texto e a do número: nunca o texto de uma versão com o número de outra', async () => {
    vi.resetModules();
    const { idbStorage, fingerprint: fp } = await import('../lib/idbStorage');
    const name = 'tchefood-teste';
    // IndexedDB com S0 (número 100); cópia de recuperação com S1 (número 101).
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

  it('GPT r21 P2-01: S0 → versão antiga grava S2 → app novo → IndexedDB recusa S3 → reinício: volta S3', async () => {
    vi.resetModules();
    const { idbStorage } = await import('../lib/idbStorage');
    const name = 'tchefood-r21a';
    await idbStorage.setItem(name, 'S0');
    await tick(); // o IndexedDB de mentira termina os pedidos da transação logo depois do oncomplete
    // Volta para a versão antiga: grava S2 na chave principal, sem mexer em ::seq.
    disk.set(name, 'S2');
    // App novo reabre: lê S2 (texto de versão anterior) e continua daí.
    vi.resetModules();
    let app = await import('../lib/idbStorage');
    expect(await app.idbStorage.getItem(name)).toBe('S2');
    // O operador altera; o IndexedDB recusa; a cópia no localStorage fica com S3.
    mode = 'throw';
    await app.idbStorage.setItem(name, 'S3');
    expect(JSON.stringify(copies(name))).toContain('S3');
    // Reinício com o IndexedDB bom outra vez (ainda com S2 no disco): S3, não S2.
    mode = 'ok';
    vi.resetModules();
    app = await import('../lib/idbStorage');
    expect(await app.idbStorage.getItem(name)).toBe('S3');
    // E S3 entrou no IndexedDB (a versão anterior do app lê o mesmo registro).
    expect(disk.get(name)).toBe('S3');
    expect(copies(name)).toEqual([]);
  });

  it('GPT r21 P2-01: a versão antiga grava S4 depois da cópia S3: S4 (escrita posterior) vale mais que a cópia', async () => {
    vi.resetModules();
    const { idbStorage } = await import('../lib/idbStorage');
    const name = 'tchefood-r21a2';
    await idbStorage.setItem(name, 'S0');
    await tick();
    vi.resetModules();
    let app = await import('../lib/idbStorage');
    await app.idbStorage.getItem(name);
    mode = 'throw';
    await app.idbStorage.setItem(name, 'S3'); // cópia em cima de S0
    await tick();
    mode = 'ok';
    disk.set(name, 'S4'); // versão antiga grava depois
    vi.resetModules();
    app = await import('../lib/idbStorage');
    expect(await app.idbStorage.getItem(name)).toBe('S4');
  });

  it('GPT r21 P2-02: a versão antiga grava S2 entre a leitura e a recuperação: S2 fica, a cópia não sobrescreve', async () => {
    vi.resetModules();
    const { idbStorage, fingerprint: fp } = await import('../lib/idbStorage');
    const name = 'tchefood-r21b';
    mode = 'ok';
    await idbStorage.getItem(name); // abre o banco
    disk.set(name, 'S0');
    disk.set(name + '::seq', `100:${fp('S0')}`);
    localStorage.setItem(name + '::copia', JSON.stringify({ seq: 101, v: 'S1', base: fp('S0') }));
    // Outra aba, com a versão antiga, grava S2 na chave principal (sem ::seq) depois da leitura inicial.
    let n = 0;
    const real = disk.get.bind(disk);
    afterGet = (key) => {
      if (key !== name || n++ > 0) return;
      afterGet = null;
      disk.set(name, 'S2');
    };
    void real;
    const got = await idbStorage.getItem(name);
    expect(got).toBe('S2');
    expect(disk.get(name)).toBe('S2');
  });

  it('GPT r24 P2-01/P2-02: cópia de outra aba surgida durante a recuperação: a leitura recomeça, devolve S2 e nada a apaga', async () => {
    vi.resetModules();
    const { idbStorage, fingerprint: fp } = await import('../lib/idbStorage');
    const name = 'tchefood-r24a';
    mode = 'ok';
    await idbStorage.getItem(name);
    disk.set(name, 'S0');
    disk.set(name + '::seq', `100:${fp('S0')}`);
    localStorage.setItem(name + '::copia::5.a', JSON.stringify({ seq: 101, id: 'a', v: 'S1', base: fp('S0') }));
    let reads = 0;
    afterGet = (key) => {
      if (key !== name || ++reads !== 2) return; // 2ª leitura de `name`: dentro da recuperação de S1
      localStorage.setItem(name + '::copia::6.b', JSON.stringify({ seq: 102, id: 'b', v: 'S2', base: fp('S0') }));
    };
    expect(await idbStorage.getItem(name)).toBe('S2'); // antes: S1
    await tick();
    expect(disk.get(name)).toBe('S2');
    expect(copies(name)).toEqual([]); // S1 e S2 já estão no IndexedDB
  });

  it('GPT r24 P2-02: a cópia só sai pela chave exata que foi lida: outra aba não perde a dela entre a conferência e a remoção', async () => {
    vi.resetModules();
    const { idbStorage, fingerprint: fp } = await import('../lib/idbStorage');
    const name = 'tchefood-r24b';
    mode = 'ok';
    await idbStorage.getItem(name);
    disk.set(name, 'S0');
    disk.set(name + '::seq', `100:${fp('S0')}`);
    // Esta aba (A) grava com o IndexedDB recusando: cópia própria.
    mode = 'throw';
    await idbStorage.setItem(name, 'S1');
    await tick();
    expect(copies(name)).toHaveLength(1);
    // Volta o IndexedDB; A grava S3 e, no meio, outra aba (B) grava a cópia S2 com número maior.
    mode = 'ok';
    onPut = (key) => {
      if (key !== name) return;
      onPut = null;
      localStorage.setItem(name + '::copia::zzzzzz.b', JSON.stringify({ seq: Date.now() + 5_000, id: 'b', v: 'S2', base: fp('S0') }));
    };
    await idbStorage.setItem(name, 'S3');
    await tick();
    expect(copies(name).map((c) => c.v)).toEqual(['S2']); // a de A (S1) saiu; a de B ficou
    vi.resetModules();
    const again = await import('../lib/idbStorage');
    expect(await again.idbStorage.getItem(name)).toBe('S2');
  });

  it('GPT r24 P2-01 (store real): S2 chega durante a recuperação de S1; hidratar, gravar sozinho e reiniciar mantém a pendência que só existe em S2', async () => {
    vi.resetModules();
    let store = await import('../store/useTcheStore');
    await tick();
    const name = store.useTcheStore.persist.getOptions().name!;
    store.useTcheStore.setState({ courierSettlePending: [{ id: 'acerto-S0' } as never] });
    expect(await store.awaitPersisted()).toBe(true);
    await tick();
    const s0 = disk.get(name) as string;
    const { fingerprint: fp } = await import('../lib/idbStorage');
    const mk = (id: string) => s0.replace('acerto-S0', id);
    const seq0 = Number(String(disk.get(name + '::seq')).split(':')[0]);
    localStorage.setItem(name + '::copia::1.a', JSON.stringify({ seq: seq0 + 1, id: 'a', v: mk('acerto-S1'), base: fp(s0) }));
    let reads = 0;
    afterGet = (key) => {
      if (key !== name || ++reads !== 2) return;
      localStorage.setItem(name + '::copia::2.b', JSON.stringify({ seq: seq0 + 2, id: 'b', v: mk('acerto-S2'), base: fp(s0) }));
    };
    // App reabre: getItem recupera S1, vê S2 chegar, recomeça e devolve S2; o onRehydrateStorage grava o estado hidratado.
    vi.resetModules();
    store = await import('../store/useTcheStore');
    await tick(60);
    afterGet = null;
    expect(store.useTcheStore.getState().courierSettlePending?.[0]?.id).toBe('acerto-S2');
    expect(await store.awaitPersisted()).toBe(true);
    await tick();
    // Reinício de novo: o persistido é S2.
    vi.resetModules();
    store = await import('../store/useTcheStore');
    await tick(60);
    expect(store.useTcheStore.getState().courierSettlePending?.[0]?.id).toBe('acerto-S2');
    expect(JSON.stringify(disk.get(name))).toContain('acerto-S2');
  });

  describe('GPT r24 P2-03: mesmo número de gravação em duas instâncias, conteúdos diferentes', () => {
    const T = 5_000_000_000_000;
    const instance = async () => {
      vi.resetModules();
      return (await import('../lib/idbStorage')).idbStorage;
    };
    afterEach(() => vi.restoreAllMocks());

    it('fallback recusado nas duas: as duas cópias existem; vale a de id maior e a outra vai para conflito, nada some', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(T);
      const name = 'tchefood-r24c';
      mode = 'throw';
      await (await instance()).setItem(name, 'X');
      await (await instance()).setItem(name, 'Y');
      const found = copies(name);
      expect(found.map((c) => c.v).sort()).toEqual(['X', 'Y']);
      expect(found[0]!.seq).toBe(found[1]!.seq);
      mode = 'ok';
      const winner = [...found].sort((a, b) => ((a.id ?? '') < (b.id ?? '') ? -1 : 1)).at(-1)!;
      const loser = found.find((c) => c.v !== winner.v)!;
      expect(await (await instance()).getItem(name)).toBe(winner.v);
      await tick();
      expect(conflicts(name).map((c) => c.v)).toEqual([loser.v]);
      expect(disk.get(name)).toBe(winner.v);
    });

    it('escrita boa de uma instância com o mesmo número de uma cópia de outra: a cópia não é apagada e o conflito é guardado', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(T);
      const name = 'tchefood-r24d';
      mode = 'throw';
      await (await instance()).setItem(name, 'X'); // cópia da instância A, número T
      mode = 'ok';
      await (await instance()).setItem(name, 'Y'); // instância B grava no IndexedDB, também número T
      await tick();
      expect(copies(name).map((c) => c.v)).toEqual(['X']); // B não conhecia a cópia de A: não apagou
      expect(await (await instance()).getItem(name)).toBe('Y'); // empate: o IndexedDB
      await tick();
      expect(conflicts(name).map((c) => c.v)).toEqual(['X']); // e a de A ficou guardada
      expect(copies(name)).toEqual([]);
    });

    it('recuperação com duas cópias do mesmo número: a de id maior entra, a outra vai para conflito', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(T);
      const name = 'tchefood-r24e';
      mode = 'ok';
      const first = await instance();
      await first.getItem(name);
      const { fingerprint: fp } = await import('../lib/idbStorage');
      disk.set(name, 'S0');
      disk.set(name + '::seq', `100:${fp('S0')}`);
      localStorage.setItem(name + '::copia::5.a', JSON.stringify({ seq: 101, id: 'a', v: 'S1a', base: fp('S0') }));
      localStorage.setItem(name + '::copia::5.b', JSON.stringify({ seq: 101, id: 'b', v: 'S1b', base: fp('S0') }));
      expect(await first.getItem(name)).toBe('S1b');
      await tick();
      expect(disk.get(name)).toBe('S1b');
      expect(conflicts(name).map((c) => c.v)).toEqual(['S1a']);
      expect(copies(name)).toEqual([]);
    });
  });

  describe('GPT r25 (PR #54): toda cópia que sai é provada incluída ou guardada; resultado sem seleção estável não vira estado definitivo', () => {
    const seed = async (name: string) => {
      vi.resetModules();
      const mod = await import('../lib/idbStorage');
      mode = 'ok';
      await mod.idbStorage.getItem(name);
      disk.set(name, 'S0');
      disk.set(name + '::seq', `100:${mod.fingerprint('S0')}`);
      return mod;
    };

    it('P2-01: cópia S1 (feita em cima de S0), versão antiga grava S2: S2 vale e S1 fica guardada em ::conflito (também depois de reiniciar)', async () => {
      const { idbStorage, fingerprint: fp } = await seed('tchefood-r25a');
      const name = 'tchefood-r25a';
      localStorage.setItem(name + '::copia::5.a', JSON.stringify({ seq: 101, id: 'a', v: 'S1', base: fp('S0') }));
      disk.set(name, 'S2'); // versão antiga: texto novo, sem mexer em ::seq
      expect(await idbStorage.getItem(name)).toBe('S2');
      await tick();
      expect(disk.get(name)).toBe('S2');
      expect(copies(name)).toEqual([]);
      expect(conflicts(name).map((c) => c.v)).toEqual(['S1']); // antes: S1 apagada sem registro
      vi.resetModules();
      expect(await (await import('../lib/idbStorage')).idbStorage.getItem(name)).toBe('S2');
      expect(conflicts(name).map((c) => c.v)).toEqual(['S1']);
    });

    it('P2-02: leitura degradada com duas cópias do mesmo número; ao voltar, setItem(Y) deixa Y e guarda X em ::conflito', async () => {
      const { idbStorage } = await seed('tchefood-r25b');
      const name = 'tchefood-r25b';
      localStorage.setItem(name + '::copia::5.a', JSON.stringify({ seq: 101, id: 'a', v: 'X', base: null }));
      localStorage.setItem(name + '::copia::5.b', JSON.stringify({ seq: 101, id: 'b', v: 'Y', base: null }));
      readFails = true;
      expect(await idbStorage.getItem(name)).toBe('Y'); // sem o IndexedDB: a de id maior
      readFails = false;
      await idbStorage.setItem(name, 'Y');
      await tick();
      expect(disk.get(name)).toBe('Y');
      expect(copies(name)).toEqual([]);
      expect(conflicts(name).map((c) => c.v)).toEqual(['X']); // antes: X apagada sem registro
    });

    it('P2-03 (store real): a recuperação de S1 é recusada e S2 chega nesse meio tempo; hidratar, gravar sozinho e reiniciar mantém S2', async () => {
      vi.resetModules();
      let store = await import('../store/useTcheStore');
      await tick();
      const name = store.useTcheStore.persist.getOptions().name!;
      store.useTcheStore.setState({ courierSettlePending: [{ id: 'acerto-S0' } as never] });
      expect(await store.awaitPersisted()).toBe(true);
      await tick();
      const s0 = disk.get(name) as string;
      const { fingerprint: fp } = await import('../lib/idbStorage');
      const mk = (id: string) => s0.replace('acerto-S0', id);
      const seq0 = Number(String(disk.get(name + '::seq')).split(':')[0]);
      localStorage.setItem(name + '::copia::1.a', JSON.stringify({ seq: seq0 + 1, id: 'a', v: mk('acerto-S1'), base: fp(s0) }));
      mode = 'throw'; // a leitura funciona, a recuperação (escrita) é recusada
      onFail = () => {
        onFail = null;
        localStorage.setItem(name + '::copia::2.b', JSON.stringify({ seq: seq0 + 2, id: 'b', v: mk('acerto-S2'), base: fp(s0) }));
      };
      vi.resetModules();
      store = await import('../store/useTcheStore');
      await tick(80);
      mode = 'ok';
      expect(store.useTcheStore.getState().courierSettlePending?.[0]?.id).toBe('acerto-S2'); // antes: S1
      expect(await store.awaitPersisted()).toBe(true);
      await tick();
      vi.resetModules();
      store = await import('../store/useTcheStore');
      await tick(80);
      expect(store.useTcheStore.getState().courierSettlePending?.[0]?.id).toBe('acerto-S2');
      expect(JSON.stringify(disk.get(name))).toContain('acerto-S2');
      const kept = [...copies(name).map((c) => c.v), ...conflicts(name).map((c) => c.v)].join('');
      expect(kept + JSON.stringify(disk.get(name))).toContain('acerto-S1'); // S1 continua recuperável
    });

    it('P2-04: chega cópia nova em todas as tentativas: devolve o mais novo visto, nada some, nada é apagado enquanto provisório, e a próxima leitura estável resolve', async () => {
      const { idbStorage, fingerprint: fp } = await seed('tchefood-r25d');
      const name = 'tchefood-r25d';
      localStorage.setItem(name + '::copia::0.a', JSON.stringify({ seq: 101, id: 'a', v: 'C101', base: fp('S0') }));
      let n = 101;
      const inject = () => {
        n++;
        localStorage.setItem(`${name}::copia::${n.toString(36)}.z`, JSON.stringify({ seq: n, id: 'z', v: `C${n}`, base: fp('S0') }));
      };
      onPut = (key) => { if (key === name) inject(); }; // cada recuperação é interrompida por uma cópia nova
      const got = await idbStorage.getItem(name);
      onPut = null;
      expect(got).not.toBeNull();
      await tick();
      // Provisório: nada se perdeu (cada conteúdo está numa cópia, em ::conflito ou no IndexedDB) e a gravação abaixo não apaga cópia.
      const where = () => [...copies(name).map((c) => c.v), ...conflicts(name).map((c) => c.v), String(disk.get(name))];
      for (let i = 101; i <= n; i++) expect(where()).toContain(`C${i}`);
      const before = copies(name).map((c) => c.v);
      await idbStorage.setItem(name, 'MINHA');
      await tick();
      expect(copies(name).map((c) => c.v)).toEqual(expect.arrayContaining(before));
      // Leitura estável: resolve, e o que não entrou vai para ::conflito.
      const final = await idbStorage.getItem(name);
      await tick();
      expect(final).toBe(disk.get(name));
      const preserved = [...copies(name).map((c) => c.v), ...conflicts(name).map((c) => c.v), String(disk.get(name))];
      // MINHA substitui o estado devolvido (`got`, a base dela); todo o resto segue guardado.
      for (let i = 101; i <= n; i++) if (`C${i}` !== got) expect(preserved).toContain(`C${i}`);
      expect(preserved).toContain('MINHA');
    });

    it('chave antiga única ::copia trocada por outra instância entre a leitura e a exclusão: não é apagada', async () => {
      const { idbStorage, fingerprint: fp } = await seed('tchefood-r25e');
      const name = 'tchefood-r25e';
      localStorage.setItem(name + '::copia', JSON.stringify({ seq: 101, v: 'S1', base: fp('S0') }));
      afterGet = (key) => {
        if (key !== name) return;
        afterGet = null;
        // outra instância (versão anterior) troca o conteúdo da mesma chave antiga
        localStorage.setItem(name + '::copia', JSON.stringify({ seq: 150, v: 'S9', base: fp('S0') }));
      };
      const got = await idbStorage.getItem(name);
      await tick();
      expect(got).toBe('S9'); // a leitura recomeça e vê a troca
      expect([...copies(name).map((c) => c.v), ...conflicts(name).map((c) => c.v), String(disk.get(name))]).toEqual(expect.arrayContaining(['S9']));
      expect(copies(name).map((c) => c.v).concat(String(disk.get(name)))).toContain('S9'); // a troca feita pela outra instância não é apagada por esta
    });
  });

  it('GPT r23 P2-01 (vizinho): gravação recusada no IndexedDB não troca nem apaga a cópia mais nova de outra aba', async () => {
    vi.resetModules();
    const { idbStorage } = await import('../lib/idbStorage');
    const name = 'tchefood-r23c';
    mode = 'ok';
    await idbStorage.getItem(name);
    localStorage.setItem(name + '::copia::zzzzzz.b', JSON.stringify({ seq: Date.now() + 60_000, id: 'b', v: 'S2', base: null }));
    mode = 'throw';
    await idbStorage.setItem(name, 'S1');
    expect(copies(name).map((c) => c.v).sort()).toEqual(['S1', 'S2']);
    mode = 'ok';
    vi.resetModules();
    expect(await (await import('../lib/idbStorage')).idbStorage.getItem(name)).toBe('S2');
  });

  it('GPT r21 P2-03: JSONs que colidiam na impressão de 32 bits não se confundem', async () => {
    vi.resetModules();
    const { idbStorage, fingerprint: fp } = await import('../lib/idbStorage');
    const a = '{"state":{"note":"Az"}}';
    const b = '{"state":{"note":"BY"}}';
    expect(fp(a)).not.toBe(fp(b));
    const name = 'tchefood-r21c';
    mode = 'ok';
    await idbStorage.getItem(name);
    disk.set(name, a);
    disk.set(name + '::seq', `100:${fp(a)}`);
    localStorage.setItem(name + '::copia', JSON.stringify({ seq: 101, v: 'S1', base: fp(a) }));
    // A versão antiga troca o texto por b, sem mexer em ::seq: b é escrita posterior, a cópia velha não ganha.
    disk.set(name, b);
    expect(await idbStorage.getItem(name)).toBe(b);
    expect(disk.get(name)).toBe(b);
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
