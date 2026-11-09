import { describe, expect, it } from 'vitest';
import { UniversalEscPosBuilder } from '../services/printer/escposBuilder';
import { BRAND_LOGO_RASTER } from '../services/printer/brandLogoRaster';
import { buildKitchenTicket, buildTestPage } from '../services/printer/printerService';

const GS_V_0 = [0x1d, 0x76, 0x30, 0x00];
function indexOfSeq(bytes: number[], seq: number[]): number {
  return bytes.findIndex((_, i) => seq.every((v, j) => bytes[i + j] === v));
}

describe('logo oficial na bobina', () => {
  it('raster cabe em 58mm (384 pontos) e tem o tamanho declarado', () => {
    expect(BRAND_LOGO_RASTER.widthDots).toBeLessThanOrEqual(384);
    expect(BRAND_LOGO_RASTER.widthBytes).toBe(Math.ceil(BRAND_LOGO_RASTER.widthDots / 8));
    expect(atob(BRAND_LOGO_RASTER.base64).length).toBe(BRAND_LOGO_RASTER.widthBytes * BRAND_LOGO_RASTER.heightDots);
  });

  it('logo() gera GS v 0 centralizado com cabeçalho xL xH yL yH e todos os bytes', () => {
    const b = new UniversalEscPosBuilder('58MM').logo();
    const bytes = Array.from(b.toBytes());
    const at = indexOfSeq(bytes, GS_V_0);
    expect(at).toBeGreaterThan(0);
    const { widthBytes, heightDots } = BRAND_LOGO_RASTER;
    expect(bytes.slice(at + 4, at + 8)).toEqual([widthBytes & 0xff, widthBytes >> 8, heightDots & 0xff, heightDots >> 8]);
    expect(bytes.length).toBeGreaterThanOrEqual(at + 8 + widthBytes * heightDots);
    expect(indexOfSeq(bytes.slice(0, at), [0x1b, 0x61, 0x01])).toBeGreaterThanOrEqual(0); // ESC a 1 (centro)
    expect(b.preview).toContainEqual({ kind: 'logo' });
  });

  it('ticket de cozinha e página de teste saem com a logo', () => {
    const t = buildKitchenTicket('80MM', { tableLabel: 'Mesa 1', tableNumber: 1, sectorLabel: 'Cozinha', waiterName: 'Tião', fromQr: false, createdAt: new Date().toISOString(), items: [] }, { beep: false, cut: true });
    expect(indexOfSeq(Array.from(t.toBytes()), GS_V_0)).toBeGreaterThan(0);
    const printer = { id: 'p', name: 'Caixa', brand: 'EPSON' as const, model: 'TM-T20', sector: 'CASHIER' as const, paperWidth: '58MM' as const, connection: 'BLUETOOTH' as const, macAddress: 'AA', beepOnPrint: false, cutPaper: false, active: true };
    expect(buildTestPage('58MM', printer).preview[0]).toEqual({ kind: 'logo' });
  });
});
