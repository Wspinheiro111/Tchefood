/** Formatação e regras pequenas do painel (sem dependência da tela, testadas à parte). */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Valor do banco (número em reais, 2 casas) para a tela. */
export function money(value: number | null | undefined): string {
  return BRL.format(Math.round((value ?? 0) * 100) / 100);
}

/**
 * Valor digitado ("199", "199,9", "1.299,90", "199.90") para o texto que vai ao banco
 * ("199.90"), sem passar por número de ponto flutuante. null = inválido.
 */
export function parseMoneyInput(raw: string): string | null {
  let s = raw.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const reais = String(Number(m[1]));
  const cents = (m[2] ?? '').padEnd(2, '0');
  return `${reais}.${cents}`;
}

/** Texto do banco ("199.90") ou número (199.9) para centavos inteiros. */
export function toCents(value: string | number): number {
  const s = typeof value === 'number' ? value.toFixed(2) : value;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return NaN;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** "2026-11-14" → "14/11/2026" (data pura, sem fuso). */
export function dateBr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Data e hora de um timestamp, no fuso de São Paulo. */
export function dateTimeBr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "2026-11-01" → "novembro/2026". */
export function monthBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MESES[Number(m[2]) - 1] ?? m[2]}/${m[1]}`;
}

/** Primeiro dia do mês de uma data "AAAA-MM-DD" (ou do mês seguinte, com offset 1). */
export function monthStart(iso: string, offset = 0): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`data inválida: ${iso}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + offset;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}

export function onlyDigits(s: string): string {
  return s.replace(/\D/g, '');
}

export function formatCnpj(cnpj: string): string {
  const d = onlyDigits(cnpj);
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Mesma regra do banco (tchefood_admin_cnpj_valid). */
export function validCnpj(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const digit = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * w[i]!;
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}

export function formatPhone(phone: string): string {
  let d = onlyDigits(phone);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

/** Link do WhatsApp com a mensagem pronta (DDI 55 quando o número veio só com DDD). */
export function whatsappLink(phone: string, message: string): string {
  let d = onlyDigits(phone);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return `https://wa.me/${d}?text=${encodeURIComponent(message)}`;
}

export interface ChargeMessageInput {
  contactName: string;
  storeName: string;
  referenceMonth: string;
  amount: number;
  dueDate: string;
  daysLate: number;
  paymentLink: string | null;
}

/** Mensagem de cobrança: lembrete antes do vencimento, aviso no dia e cobrança com atraso. */
export function chargeMessage(c: ChargeMessageInput, today: string): string {
  const first = c.contactName.trim().split(/\s+/)[0] || c.contactName.trim();
  const ref = monthBr(c.referenceMonth);
  const valor = money(c.amount);
  const link = c.paymentLink ? `\n\nPara pagar: ${c.paymentLink}` : '\n\nSe preferir, me chama aqui que eu mando a chave Pix.';
  let corpo: string;
  if (c.daysLate > 0) {
    const dias = c.daysLate === 1 ? '1 dia' : `${c.daysLate} dias`;
    corpo = `a mensalidade do Tchê Food da ${c.storeName} (${ref}, ${valor}) venceu em ${dateBr(c.dueDate)} e está em aberto há ${dias}. Consegue verificar?`;
  } else if (c.dueDate === today) {
    corpo = `a mensalidade do Tchê Food da ${c.storeName} (${ref}, ${valor}) vence hoje.`;
  } else {
    corpo = `passando para lembrar que a mensalidade do Tchê Food da ${c.storeName} (${ref}, ${valor}) vence em ${dateBr(c.dueDate)}.`;
  }
  return `Olá, ${first}! Tudo bem? ${corpo.charAt(0).toUpperCase()}${corpo.slice(1)}${link}\n\nSe já pagou, pode desconsiderar. Obrigado!`;
}

export const STATUS_LABEL: Record<string, string> = {
  TRIAL: 'Em teste',
  ACTIVE: 'Ativa',
  SUSPENDED: 'Suspensa',
  CANCELLED: 'Cancelada',
  OPEN: 'Em aberto',
  PAID: 'Paga',
};

export const METHOD_LABEL: Record<string, string> = {
  PIX: 'Pix',
  BOLETO: 'Boleto',
  CARTAO: 'Cartão',
  TRANSFERENCIA: 'Transferência',
  DINHEIRO: 'Dinheiro',
};

/** E-mail sugerido para a conta do aparelho da loja (não precisa receber e-mail). */
export function suggestedDeviceEmail(cnpj: string): string {
  return `loja-${onlyDigits(cnpj)}@aparelho.tchefood.com.br`;
}

/** Dias entre duas datas "AAAA-MM-DD" (b - a). */
export function daysBetween(a: string, b: string): number {
  const pa = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const pb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((pb - pa) / 86_400_000);
}
