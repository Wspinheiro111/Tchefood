import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeDispatch } from '../services/printer/printerService';
import { printLedgerReset } from '../services/printer/printLedger';
import type { PrinterConfig } from '../services/printer/escposBuilder';
import type { OrderItem } from '../types';

const g = globalThis as unknown as { window?: unknown };
const printer = { id: 'p1', name: 'Cozinha', brand: 'Epson', model: 'TM-T20', connection: 'NETWORK_TCP', ipAddress: '10.0.0.5', port: 9100, paperWidth: '80MM', sector: 'KITCHEN', active: true, beepOnPrint: false, cutPaper: true } as unknown as PrinterConfig;
const item = { id: 'i1', order_id: 'o1', product_id: 'x', quantity: 1, sector: 'KITCHEN', waiter_id: 'w', origin: 'WAITER', created_at: '2026-11-09T12:00:00Z', meat_doneness: null, notes: null } as unknown as OrderItem;
const params = { items: [item], printers: [printer], products: [], staff: [], tableLabel: 'Mesa 1', tableNumber: 1 };

describe('ledger STARTED/COMPLETE da impressão (regra do Tchê Vendas)', () => {
  beforeEach(() => printLedgerReset());
  afterEach(() => {
    delete g.window;
  });

  it('ticket impresso não sai de novo', () => {
    let calls = 0;
    g.window = { SmartPosNative: { printNetworkEscPos: () => (calls++, '{"success":true}') } };
    expect(routeDispatch(params)[0]!.delivery).toMatchObject({ ok: true, via: 'NATIVE' });
    expect(routeDispatch(params)[0]!.delivery).toMatchObject({ ok: true, skipped: 'ALREADY_PRINTED' });
    expect(calls).toBe(1);
  });

  it('recusa clara da impressora permite reimprimir', () => {
    let calls = 0;
    g.window = { SmartPosNative: { printNetworkEscPos: () => (calls++, calls === 1 ? '{"success":false,"error":"offline"}' : '{"success":true}') } };
    expect(routeDispatch(params)[0]!.delivery.ok).toBe(false);
    expect(routeDispatch(params)[0]!.delivery.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('exceção no meio deixa incerto e não reimprime sozinho', () => {
    let calls = 0;
    g.window = { SmartPosNative: { printNetworkEscPos: () => { calls++; throw new Error('socket'); } } };
    expect(routeDispatch(params)[0]!.delivery.ok).toBe(false);
    expect(routeDispatch(params)[0]!.delivery).toMatchObject({ ok: false, skipped: 'PRINT_RESULT_UNCERTAIN' });
    expect(calls).toBe(1);
  });
});
