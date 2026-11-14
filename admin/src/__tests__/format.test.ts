import { describe, expect, it } from 'vitest';
import { chargeMessage, dateBr, daysBetween, formatCnpj, formatPhone, money, monthBr, monthStart, parseMoneyInput, suggestedDeviceEmail, toCents, validCnpj, whatsappLink } from '../lib/format';

describe('formatação do painel', () => {
  it('valor digitado vira texto exato para o banco, sem ponto flutuante', () => {
    expect(parseMoneyInput('199')).toBe('199.00');
    expect(parseMoneyInput('199,9')).toBe('199.90');
    expect(parseMoneyInput('R$ 1.299,90')).toBe('1299.90');
    expect(parseMoneyInput('199.90')).toBe('199.90');
    expect(parseMoneyInput('1.299')).toBe('1299.00');
    expect(parseMoneyInput('0,10')).toBe('0.10');
    expect(parseMoneyInput('0')).toBe('0.00');
    for (const bad of ['', 'abc', '1,999', '-5', '19,9,9', '1e3', '9999999']) expect(parseMoneyInput(bad), bad).toBeNull();
    expect(toCents('199.90')).toBe(19990);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('199.9')).toBe(19990);
  });

  it('dinheiro, datas e meses', () => {
    expect(money(199.9).replace(/\s/g, ' ')).toBe('R$ 199,90');
    expect(dateBr('2026-11-14')).toBe('14/11/2026');
    expect(dateBr(null)).toBe('—');
    expect(monthBr('2026-11-01')).toBe('novembro/2026');
    expect(monthStart('2026-12-20')).toBe('2026-12-01');
    expect(monthStart('2026-12-20', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-11-10', '2026-11-14')).toBe(4);
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
  });

  it('CNPJ com a mesma regra do banco', () => {
    expect(validCnpj('11.444.777/0001-61')).toBe(true);
    expect(validCnpj('11444777000162')).toBe(false);
    expect(validCnpj('11111111111111')).toBe(false);
    expect(validCnpj('123')).toBe(false);
    expect(formatCnpj('11444777000161')).toBe('11.444.777/0001-61');
    expect(suggestedDeviceEmail('11.444.777/0001-61')).toBe('loja-11444777000161@aparelho.tchefood.com.br');
  });

  it('WhatsApp: DDI 55 quando falta, mensagem por situação', () => {
    expect(formatPhone('55996538255')).toBe('(55) 99653-8255');
    expect(formatPhone('5555996538255')).toBe('(55) 99653-8255');
    expect(whatsappLink('(55) 99653-8255', 'oi')).toBe('https://wa.me/5555996538255?text=oi');
    expect(whatsappLink('5555996538255', 'a b')).toBe('https://wa.me/5555996538255?text=a%20b');
    const base = { contactName: 'Maria da Silva', storeName: 'Flip', referenceMonth: '2026-11-01', amount: 199, dueDate: '2026-11-10', paymentLink: 'https://asaas.com/i/1' };
    const late = chargeMessage({ ...base, daysLate: 4 }, '2026-11-14');
    expect(late).toMatch(/^Olá, Maria!/);
    expect(late).toContain('venceu em 10/11/2026 e está em aberto há 4 dias');
    expect(late).toContain('Para pagar: https://asaas.com/i/1');
    expect(chargeMessage({ ...base, daysLate: 0 }, '2026-11-10')).toContain('vence hoje');
    const before = chargeMessage({ ...base, daysLate: 0, paymentLink: null }, '2026-11-08');
    expect(before).toContain('vence em 10/11/2026');
    expect(before).toContain('chave Pix');
  });
});
