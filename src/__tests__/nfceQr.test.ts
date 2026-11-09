import { describe, expect, it } from 'vitest';
import { buildAccessKey, buildConsultaQrUrl, extractNfceQrCodeFromXml, isValidNfceQrCodeContent } from '../lib/nfce';

const key = buildAccessKey({ cnpj: '12345678000195', issuedAt: new Date('2026-11-09T12:00:00Z'), number: 42, cNF: '12345678' });
const qr = buildConsultaQrUrl(key, { csc_id: '000001', csc_token: 'CSC' });

describe('QR Code da NFC-e (regra do Tchê Vendas)', () => {
  it('aceita a URL da SEFAZ com a chave desta nota', () => {
    expect(isValidNfceQrCodeContent(qr, key)).toBe(true);
  });
  it('recusa outra nota, outro domínio, URL sem p e lixo', () => {
    const other = buildAccessKey({ cnpj: '12345678000195', issuedAt: new Date('2026-11-09T12:00:00Z'), number: 43, cNF: '12345678' });
    expect(isValidNfceQrCodeContent(qr, other)).toBe(false);
    expect(isValidNfceQrCodeContent(qr.replace('sefaz.rs.gov.br', 'sefaz.rs.gov.br.evil.com'), key)).toBe(false);
    expect(isValidNfceQrCodeContent('https://www.sefaz.rs.gov.br/nfce/consulta', key)).toBe(false);
    expect(isValidNfceQrCodeContent('javascript:alert(1)', key)).toBe(false);
    expect(isValidNfceQrCodeContent(null, key)).toBe(false);
  });
  it('extrai o QR do XML autorizado (com CDATA)', () => {
    const xml = `<nfeProc><NFe><infNFeSupl><qrCode><![CDATA[${qr}]]></qrCode><urlChave>x</urlChave></infNFeSupl></NFe></nfeProc>`;
    expect(extractNfceQrCodeFromXml(xml)).toBe(qr);
    expect(extractNfceQrCodeFromXml('<nfeProc/>')).toBeNull();
  });
});
