/**
 * Fichas de balcão / bailes e eventos.
 *
 * Código antifraude (barcode_token): 15 caracteres aleatórios do alfabeto
 * Crockford Base32 (sem I, L, O, U: não se confundem com 1 e 0) gerados com
 * crypto.getRandomValues (75 bits, impossível de adivinhar) + 1 dígito
 * verificador mod 32 ponderado, que pega erro de digitação no resgate manual.
 * Mesma regra do CHECK em db/schema_expansion.sql.
 */
import type { EventTicket, Tenant } from '../types';
import { ascii, center } from './receipts';
import { formatBRL } from './money';

export const TICKET_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_LEN = 15;

function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += TICKET_ALPHABET.indexOf(body[i]!) * (i + 1);
  return TICKET_ALPHABET[sum % 32]!;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) throw new Error('Gerador seguro indisponível: não é possível emitir fichas.');
  c.getRandomValues(out);
  return out;
}

export function generateTicketToken(): string {
  const bytes = randomBytes(BODY_LEN);
  let body = '';
  for (const b of bytes) body += TICKET_ALPHABET[b & 31]!;
  return body + checkChar(body);
}

/** Aceita digitação com minúsculas, espaços, hífens e O/I/L no lugar de 0/1. */
export function normalizeTicketToken(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function isValidTicketToken(token: string): boolean {
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(token)) return false;
  return checkChar(token.slice(0, BODY_LEN)) === token[BODY_LEN];
}

/** "7K3Q-9XWB-..." para leitura humana na bobina. */
export function formatTicketToken(token: string): string {
  return token.match(/.{1,4}/g)?.join('-') ?? token;
}

/**
 * Layout da ficha destacável (bobina 58mm, 32 colunas). O nome do item vai em
 * `headline` (fonte gigante no simulador e GS ! 0x11 no ESC/POS); o QR Code
 * carrega o token e é lido no balcão pela câmera da SmartPOS ou leitor.
 */
export function ticketPrint(params: { tenant: Tenant; ticket: EventTicket; total: number; eventLabel: string }): {
  headline: string;
  lines: string[];
  footer: string[];
} {
  const { tenant, ticket, total, eventLabel } = params;
  const d = new Date(ticket.created_at);
  const when = d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return {
    headline: ascii(ticket.product_name_snapshot).toUpperCase(),
    lines: [
      center(ascii(tenant.name).slice(0, 32)),
      center(ascii(eventLabel).toUpperCase().slice(0, 32)),
      '-'.repeat(32),
      center(`FICHA ${ticket.ticket_seq} de ${total} - ${formatBRL(ticket.unit_price).replace(/ /g, ' ')}`),
      center(when),
    ],
    footer: [
      center(formatTicketToken(ticket.barcode_token)),
      '-'.repeat(32),
      center('VALE 1 UNIDADE - USO UNICO'),
      center('Apresente no balcao para retirar'),
      center('Nao tem valor fiscal'),
    ],
  };
}
