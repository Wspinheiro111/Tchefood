import { describe, expect, it } from 'vitest';
import {
  chargeMessage, cleanCnpj, cnpjMatches, dateBr, daysBetween, formatCnpj, formatPhone, money, moneyInputError, monthBr, monthStart, parseMoneyInput, priceInput,
  suggestedDeviceEmail, toCents, trialDetail, validCnpj, validMonthInput, validPhone, whatsappLink,
} from '../lib/format';

describe('formatação do painel', () => {
  it('valor digitado vira texto exato para o banco, sem ponto flutuante', () => {
    expect(parseMoneyInput('199')).toBe('199.00');
    expect(parseMoneyInput('199,9')).toBe('199.90');
    expect(parseMoneyInput('R$ 1.299,90')).toBe('1299.90');
    expect(parseMoneyInput('199.90')).toBe('199.90');
    // "1.299" deixou de ser aceito: com três casas depois do ponto é ambíguo (milhar ou decimal).
    expect(parseMoneyInput('1.299')).toBeNull();
    expect(parseMoneyInput('0,10')).toBe('0.10');
    expect(parseMoneyInput('0')).toBe('0.00');
    for (const bad of ['', 'abc', '1,999', '-5', '19,9,9', '1e3', '9999999']) expect(parseMoneyInput(bad), bad).toBeNull();
    expect(toCents('199.90')).toBe(19990);
  });

  it('valor digitado: regra estrita, sem leitura duvidosa', () => {
    expect(parseMoneyInput('1.5')).toBe('1.50');
    expect(parseMoneyInput('R$199,90')).toBe('199.90');
    expect(parseMoneyInput(' R$ 1 299,90 ')).toBe('1299.90');
    expect(parseMoneyInput('1.299.000')).toBeNull(); // passa de 6 dígitos de reais
    expect(parseMoneyInput('12.345.678,00')).toBeNull();
    expect(parseMoneyInput('100.000.000')).toBeNull();
    expect(parseMoneyInput('1.500,00')).toBe('1500.00');
    expect(parseMoneyInput('1500')).toBe('1500.00');
    expect(parseMoneyInput('1500,5')).toBe('1500.50');
    for (const bad of ['0.999', '12.34,5', '1.2.3,4', '1.500', '0.500', '1,2,3', '1.,50', '.50', ',50', '1.50.00', '01.500,00x']) expect(parseMoneyInput(bad), bad).toBeNull();
    expect(moneyInputError('1.500', 'x')).toBe('"1.500" é ambíguo: escreva 1.500,00 ou 1500.');
    expect(moneyInputError('R$ 2.000', 'x')).toBe('"2.000" é ambíguo: escreva 2.000,00 ou 2000.');
    expect(moneyInputError('abc', 'Valor inválido.')).toBe('Valor inválido.');
    expect(priceInput(199.9)).toBe('199,90');
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

  it('CNPJ alfanumérico (Receita Federal, 2026)', () => {
    expect(cleanCnpj('00.000.000/e08g-12')).toBe('00000000E08G12');
    expect(validCnpj('00.000.000/E08G-12')).toBe(true);
    expect(validCnpj('00000000e08g12')).toBe(true);
    expect(validCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(validCnpj('12.ABC.345/01DE-36')).toBe(false);
    expect(validCnpj('12.ABC.345/01DE-3A')).toBe(false); // verificador tem de ser número
    expect(validCnpj('AAAAAAAAAAAAAA')).toBe(false);
    expect(validCnpj('00000000000000')).toBe(false);
    expect(formatCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
    expect(formatCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
    expect(suggestedDeviceEmail('12.ABC.345/01DE-35')).toBe('loja-12abc34501de35@aparelho.tchefood.com.br');
    expect(cnpjMatches('12ABC34501DE35', 'abc.345')).toBe(true);
    expect(cnpjMatches('12ABC34501DE35', '01de')).toBe(true);
    expect(cnpjMatches('11444777000161', '444.777')).toBe(true);
    expect(cnpjMatches('11444777000161', '12')).toBe(false); // menos de 3 caracteres
    expect(cnpjMatches('11444777000161', 'xyz')).toBe(false);
  });

  it('telefone: mesma regra do banco', () => {
    for (const ok of ['(55) 99653-8255', '5599653825', '5555996538255', '555599653825', '11 3333-4444']) expect(validPhone(ok), ok).toBe(true);
    for (const bad of ['', '123', '0199653825', '4455996538255', '445599653825', '55996538255999', '55 01 99653-825']) expect(validPhone(bad), bad).toBe(false);
    expect(formatPhone('555599653825')).toBe('(55) 9965-3825');
    expect(formatPhone('4455996538255')).toBe('4455996538255'); // 13 dígitos sem 55: fica como veio
    expect(whatsappLink('4455996538255', 'oi')).toBeNull();
    expect(whatsappLink('123', 'oi')).toBeNull();
    expect(whatsappLink('(11) 3333-4444', 'oi')).toBe('https://wa.me/551133334444?text=oi');
    expect(whatsappLink('555599653825', 'oi')).toBe('https://wa.me/555599653825?text=oi');
  });

  it('visão geral e mês', () => {
    expect(trialDetail(0, 0)).toBeUndefined();
    expect(trialDetail(2, 0)).toBe('2 terminam em até 7 dias');
    expect(trialDetail(0, 3)).toBe('3 com teste vencido');
    expect(trialDetail(1, 3)).toBe('3 com teste vencido · 1 terminam em até 7 dias');
    expect(validMonthInput('2026-11')).toBe(true);
    for (const bad of ['', '2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', 'novembro']) expect(validMonthInput(bad), bad).toBe(false);
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
