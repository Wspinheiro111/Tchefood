/**
 * Gerador de BR Code Pix (padrão EMV® QRCPS-MPM do Banco Central).
 * Produz o "Pix Copia e Cola" com CRC16-CCITT válido, usado no QR dinâmico
 * exibido na maquininha simulada.
 */

function tlv(id: string, value: string): string {
  return `${id}${value.length.toString().padStart(2, '0')}${value}`;
}

/** CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF). */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function sanitize(text: string, max: number): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .toUpperCase()
    .slice(0, max);
}

export interface PixParams {
  /** Chave Pix ou URL do payload dinâmico (PSP). */
  pixKeyOrUrl: string;
  dynamic: boolean;
  merchantName: string;
  merchantCity: string;
  amount: number;
  txid: string;
}

export function buildPixBrCode(p: PixParams): string {
  const gui = tlv('00', 'br.gov.bcb.pix');
  const account = p.dynamic ? tlv('25', p.pixKeyOrUrl) : tlv('01', p.pixKeyOrUrl);
  const merchantAccount = tlv('26', gui + account);
  const additional = tlv('62', tlv('05', sanitize(p.txid, 25) || '***'));
  const body =
    tlv('00', '01') +
    tlv('01', p.dynamic ? '12' : '11') +
    merchantAccount +
    tlv('52', '5812') + // MCC 5812 — Restaurantes
    tlv('53', '986') + // BRL
    tlv('54', p.amount.toFixed(2)) +
    tlv('58', 'BR') +
    tlv('59', sanitize(p.merchantName, 25)) +
    tlv('60', sanitize(p.merchantCity, 15)) +
    additional +
    '6304';
  return body + crc16(body);
}
