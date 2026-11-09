import { afterEach, describe, expect, it, vi } from 'vitest';

describe('hidratação com fallback síncrono (sem IndexedDB)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('carrega o store e marca hydrated, sem erro de inicialização', async () => {
    vi.stubGlobal('indexedDB', undefined);
    vi.resetModules();
    const { useTcheStore } = await import('../store/useTcheStore');
    await new Promise((r) => setTimeout(r, 0));
    expect(useTcheStore.getState().hydrated).toBe(true);
  });
});
