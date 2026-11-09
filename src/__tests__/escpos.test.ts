import { describe, expect, it } from 'vitest';
import { UniversalEscPosBuilder } from '../services/printer/escposBuilder';
import { buildKitchenTicket } from '../services/printer/printerService';

describe('ESC/POS universal', () => {
  it('80mm usa 48 colunas e 58mm usa 32', () => {
    expect(new UniversalEscPosBuilder('80MM').columns).toBe(48);
    expect(new UniversalEscPosBuilder('58MM').columns).toBe(32);
    const b = new UniversalEscPosBuilder('58MM').divider();
    const line = b.preview.find((e) => e.kind === 'line');
    expect(line && line.kind === 'line' && line.line.text.length).toBe(32);
  });
  it('remove acentos e começa com ESC @', () => {
    const b = new UniversalEscPosBuilder('80MM').line('Coração Tchê');
    const bytes = Array.from(b.toBytes());
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(String.fromCharCode(...bytes.slice(5, 17))).toBe('Coracao Tche');
  });
  it('quebra por palavra sem cortar no meio', () => {
    const b = new UniversalEscPosBuilder('58MM');
    const lines = b.wrap('Picanha na Parrilla 400g com farofa de ovo e vinagrete');
    expect(lines.every((l) => l.length <= 32)).toBe(true);
    expect(lines.join(' ')).toBe('Picanha na Parrilla 400g com farofa de ovo e vinagrete');
  });
  it('leftRight alinha nas extremidades', () => {
    const b = new UniversalEscPosBuilder('80MM').leftRight('2x Picanha', 'R$ 239,80');
    const l = b.preview[0]!;
    expect(l.kind === 'line' && l.line.text.length).toBe(48);
  });
  it('ticket de cozinha com sirene e guilhotina', () => {
    const t = buildKitchenTicket('80MM', { tableLabel: 'Mesa 12', tableNumber: 12, sectorLabel: 'Parrilla', waiterName: 'Tião', fromQr: false, createdAt: new Date().toISOString(), items: [{ quantity: 2, name: 'Picanha', code: '101', doneness: 'Ao Ponto', notes: '+ Farofa · Sem sal grosso' }] }, { beep: true, cut: true });
    const bytes = Array.from(t.toBytes());
    const has = (seq: number[]) => bytes.some((_, i) => seq.every((v, j) => bytes[i + j] === v));
    expect(has([0x1b, 0x42, 0x03, 0x02])).toBe(true); // ESC B
    expect(has([0x1d, 0x56, 0x42, 0x00])).toBe(true); // GS V 66 0
    expect(has([0x1d, 0x21, 0x11])).toBe(true); // mesa gigante
    expect(t.toBase64().length).toBeGreaterThan(100);
  });
});

describe('falha da impressora nativa', () => {
  it('reenviar usa o mesmo ESC/POS e atualiza o status', async () => {
    const { printTestPage, usePrintPreview } = await import('../services/printer/printerService');
    let up = false;
    const sent: string[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      SmartPosNative: {
        printNetworkEscPos: (_ip: string, _port: number, b64: string) => {
          sent.push(b64);
          return JSON.stringify(up ? { success: true } : { success: false, error: 'Connection refused' });
        },
      },
    };
    const printer = { id: 'p1', name: 'Parrilla', brand: 'ELGIN' as const, model: 'i9', sector: 'GRILL' as const, paperWidth: '80MM' as const, connection: 'NETWORK_TCP' as const, ipAddress: '192.168.1.50', port: 9100, beepOnPrint: true, cutPaper: true, active: true };
    const t = printTestPage(printer);
    expect(t.delivery).toMatchObject({ ok: false, via: 'NATIVE', error: 'Connection refused' });
    usePrintPreview.getState().show([t]);
    up = true;
    const again = usePrintPreview.getState().retry(0);
    expect(again?.delivery.ok).toBe(true);
    expect(sent[1]).toBe(sent[0]);
    expect(usePrintPreview.getState().tickets[0]!.delivery.ok).toBe(true);
    delete (globalThis as unknown as { window?: unknown }).window;
  });
});
