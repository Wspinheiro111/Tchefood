import { describe, expect, it } from 'vitest';
import { listStoreTerminals } from '../point-charge/terminals';

describe('point-charge: ação terminals (só leitura)', () => {
  it('devolve só o ID e o modo de cada maquininha da conta', async () => {
    const out = await listStoreTerminals({
      listTerminals: async () => [
        { provider: 'mercado_pago_point', externalTerminalId: 'NEWLAND_N950__A', operatingMode: 'pdv', externalStoreId: '1', externalPosId: '2' },
        { provider: 'mercado_pago_point', externalTerminalId: 'NEWLAND_N950__B', operatingMode: 'standalone', externalStoreId: null, externalPosId: null },
      ],
    });
    expect(out).toEqual({ terminals: [{ id: 'NEWLAND_N950__A', operating_mode: 'pdv' }, { id: 'NEWLAND_N950__B', operating_mode: 'standalone' }] });
  });

  it('falha do Mercado Pago não vira lista vazia', async () => {
    await expect(listStoreTerminals({ listTerminals: async () => { throw new Error('malformed'); } })).rejects.toThrow('malformed');
  });
});
