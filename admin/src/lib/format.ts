/** Formatação e regras pequenas do painel (sem dependência da tela, testadas à parte). */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Valor do banco (número em reais, 2 casas) para a tela. */
export function money(value: number | null | undefined): string {
  return BRL.format(Math.round((value ?? 0) * 100) / 100);
}

/**
 * Valor digitado para o texto que vai ao banco ("199.90"), sem passar por número de ponto
 * flutuante. Aceita "199", "199,9", "1.299,90", "199.90", "1.5" e "R$ 1.299.000" (milhar com
 * ponto e sem vírgula, a partir de dois grupos). null = inválido ou ambíguo: "1.500" pode
 * ser mil e quinhentos ou um e meio, e "0.999", "12.34,5" ou "1.2.3,4" não têm leitura segura.
 */
export function parseMoneyInput(raw: string): string | null {
  const s = raw.trim().replace(/^R\$/i, '').replace(/\s/g, '');
  if (!s) return null;
  let norm: string;
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) norm = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+$/.test(s) || /^\d+\.\d{1,2}$/.test(s)) norm = s;
  else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s) && !AMBIGUOUS_MONEY.test(s)) norm = s.replace(/\./g, '');
  else return null;
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(norm);
  if (!m) return null;
  const reais = String(Number(m[1]));
  const cents = (m[2] ?? '').padEnd(2, '0');
  return `${reais}.${cents}`;
}

/** "1.500": ponto de milhar ou decimal com três casas? Não dá para saber. */
const AMBIGUOUS_MONEY = /^\d{1,3}\.\d{3}$/;

/** Mensagem para um valor que parseMoneyInput recusou (o caso ambíguo tem a sua). */
export function moneyInputError(raw: string, fallback: string): string {
  const s = raw.trim().replace(/^R\$/i, '').replace(/\s/g, '');
  if (AMBIGUOUS_MONEY.test(s)) {
    const [a, b] = s.split('.');
    return `"${s}" é ambíguo: escreva ${s},00 ou ${a}${b}.`;
  }
  return fallback;
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

/**
 * CNPJ como o banco guarda (tchefood_admin_clean_cnpj): só letras e números, letras em
 * maiúsculas. Vale para o numérico e para o alfanumérico da Receita Federal (2026).
 */
export function cleanCnpj(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** XX.XXX.XXX/XXXX-XX (numérico ou alfanumérico); fora do formato, devolve como veio. */
export function formatCnpj(cnpj: string): string {
  const d = cleanCnpj(cnpj);
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/**
 * Mesma regra do banco (tchefood_admin_cnpj_valid): 12 posições de 0-9 ou A-Z e 2 dígitos
 * verificadores numéricos; cada posição vale o código ASCII menos 48 (dígito = ele mesmo,
 * A = 17 ... Z = 42), com os pesos de sempre.
 */
export function validCnpj(raw: string): boolean {
  const d = cleanCnpj(raw);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(d) || /^(.)\1{13}$/.test(d)) return false;
  const digit = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < len; i++) s += (d.charCodeAt(i) - 48) * w[i]!;
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}

/** Busca da lista de lojas: o CNPJ bate com o que foi digitado (com ou sem pontuação, letras inclusas). */
export function cnpjMatches(cnpj: string, query: string): boolean {
  const q = cleanCnpj(query);
  return q.length >= 3 && cleanCnpj(cnpj).includes(q);
}

/** Mesma regra do banco (tchefood_admin_check_contact): DDD + 8 ou 9 dígitos, com ou sem o 55. */
export function validPhone(raw: string): boolean {
  return /^(55)?[1-9][0-9]{9,10}$/.test(onlyDigits(raw));
}

/** Número nacional (DDD + número), sem o 55; null quando não é um telefone válido. */
function nationalPhone(phone: string): string | null {
  const d = onlyDigits(phone);
  if (!validPhone(d)) return null;
  if (d.length === 10 || d.length === 11) return d;
  return d.slice(2);
}

export function formatPhone(phone: string): string {
  const d = nationalPhone(phone);
  if (d?.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d?.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

/**
 * Link do WhatsApp com a mensagem pronta. O DDI 55 entra só quando o número veio com DDD e
 * 8 ou 9 dígitos (10 ou 11 no total); 12 ou 13 dígitos só valem começando por 55.
 * null = telefone inválido (a tela não oferece o link).
 */
export function whatsappLink(phone: string, message: string): string | null {
  const d = nationalPhone(phone);
  if (!d) return null;
  return `https://wa.me/55${d}?text=${encodeURIComponent(message)}`;
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
  return `loja-${cleanCnpj(cnpj).toLowerCase()}@aparelho.tchefood.com.br`;
}

/** Linha de detalhe do card "Em teste" na visão geral. */
export function trialDetail(endingIn7d: number, expired: number): string | undefined {
  const parts: string[] = [];
  if (expired) parts.push(`${expired} com teste vencido`);
  if (endingIn7d) parts.push(`${endingIn7d} terminam em até 7 dias`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** Mês de um campo type="month": só "AAAA-MM" com mês de 01 a 12. */
export function validMonthInput(v: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** Preço do plano no formato do campo de mensalidade ("199,90"). */
export function priceInput(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

/** Dias entre duas datas "AAAA-MM-DD" (b - a). */
export function daysBetween(a: string, b: string): number {
  const pa = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const pb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((pb - pa) / 86_400_000);
}
