import { afterEach, describe, expect, it } from 'vitest';
import { classifyPlugPagResult, missingApprovalProof, parseCents, terminalUserReference } from '../lib/payments/terminalGuard';
import { PagBankPlugPagDriver, guardApproved, type ChargeRequest } from '../lib/payments/drivers';

const okRaw = { result: 0, errorCode: '0000', transactionCode: 'TC1', transactionId: 'TID1' };

describe('classifyPlugPagResult (regras do PlugPagGateway do Tchê Vendas)', () => {
  it('aprova só com sucesso do SDK + 0000 + referência', () => {
    expect(classifyPlugPagResult(okRaw).status).toBe('APPROVED');
    expect(classifyPlugPagResult({ ...okRaw, errorCode: '' }).code).toBe('INCONSISTENT_APPROVAL');
    expect(classifyPlugPagResult({ ...okRaw, transactionId: ' ' }).code).toBe('APPROVED_WITHOUT_REFERENCE');
  });
  it('falha do SDK com 0000 é inconsistente, não recusa', () => {
    expect(classifyPlugPagResult({ result: -1, errorCode: '0000' }).status).toBe('MANUAL_REVIEW');
  });
  it('separa cancelado, recusado, ocupado e desconhecido', () => {
    expect(classifyPlugPagResult({ result: -1, errorCode: 'C13' }).status).toBe('CANCELLED');
    expect(classifyPlugPagResult({ result: -1, errorCode: 'R 51' }).status).toBe('DECLINED');
    expect(classifyPlugPagResult({ result: -1, errorCode: 'M3011' }).status).toBe('DECLINED');
    expect(classifyPlugPagResult({ result: -1, errorCode: 'PP1017' }).status).toBe('BUSY');
    expect(classifyPlugPagResult({ result: -1, errorCode: 'XYZ' })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'XYZ' });
    expect(classifyPlugPagResult({ result: -1 })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'UNKNOWN_RESULT' });
  });
});

describe('missingApprovalProof', () => {
  const proof = { nsu: '123456', authorization_code: 'A1B2C3', terminal_serial: 'PB01' };
  it('exige NSU, autorização, serial e valor igual', () => {
    expect(missingApprovalProof(proof, { amount_cents: 1000 })).toBeNull();
    expect(missingApprovalProof({ ...proof, nsu: '' }, { amount_cents: 1000 })).toBe('APPROVED_WITHOUT_NSU');
    expect(missingApprovalProof({ ...proof, authorization_code: null }, { amount_cents: 1000 })).toBe('APPROVED_WITHOUT_AUTHORIZATION');
    expect(missingApprovalProof({ ...proof, terminal_serial: undefined }, { amount_cents: 1000 })).toBe('APPROVED_WITHOUT_TERMINAL');
    expect(missingApprovalProof({ ...proof, paid_amount_cents: 999 }, { amount_cents: 1000 })).toBe('PAID_AMOUNT_MISMATCH');
    expect(missingApprovalProof({ ...proof, reference: 'TFX' }, { amount_cents: 1000, reference: 'TFY' })).toBe('REFERENCE_MISMATCH');
  });
  it('parseCents não aceita lixo', () => {
    expect(parseCents('1990')).toBe(1990);
    expect(parseCents('19,90')).toBeNull();
    expect(parseCents(null)).toBeNull();
  });
  it('userReference tem 10 caracteres e é estável', () => {
    const a = terminalUserReference('req-1');
    expect(a).toMatch(/^TF[0-9A-F]{8}$/);
    expect(terminalUserReference('req-1')).toBe(a);
    expect(terminalUserReference('req-2')).not.toBe(a);
  });
});

describe('PagBankPlugPagDriver com a ponte nativa', () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => {
    delete g.window;
  });
  const req = (id: string, amount = 25.5): ChargeRequest => ({
    request_id: id, idempotency_key: `idem-${id}`, amount, method: 'CREDIT', table_label: 'Mesa 1', order_id: 'o1', description: 'teste',
  });
  function withBridge(raw: (input: { userReference: string; amount: number }) => unknown, busy = false) {
    const calls: string[] = [];
    g.window = {
      PlugPagBridge: {
        isServiceBusy: () => busy,
        doPayment: (json: string) => {
          calls.push(json);
          return JSON.stringify(raw(JSON.parse(json)));
        },
      },
    };
    return calls;
  }

  it('aprovado com prova completa usa o NSU e a autorização da maquininha', async () => {
    withBridge((i) => ({ ...okRaw, hostNsu: '654321', autoCode: 'XY12', cardBrand: 'MASTERCARD', amount: String(i.amount), userReference: i.userReference }));
    const r = await new PagBankPlugPagDriver('SMARTPOS_EMBEDDED', null).charge(req('a'));
    expect(r).toMatchObject({ status: 'APPROVED', nsu: '654321', authorization_code: 'XY12', card_brand: 'MASTERCARD' });
  });

  it('aprovado sem NSU nunca inventa NSU: vai para revisão manual', async () => {
    withBridge(() => ({ ...okRaw, autoCode: 'XY12' }));
    const r = await new PagBankPlugPagDriver('SMARTPOS_EMBEDDED', null).charge(req('b'));
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'APPROVED_WITHOUT_NSU' });
  });

  it('valor pago diferente vai para revisão manual', async () => {
    withBridge((i) => ({ ...okRaw, hostNsu: '1', autoCode: '2', amount: String(i.amount - 1) }));
    const r = await new PagBankPlugPagDriver('SMARTPOS_EMBEDDED', null).charge(req('c'));
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'PAID_AMOUNT_MISMATCH' });
  });

  it('exceção na ponte é incerta (WRAPPER_EXCEPTION)', async () => {
    g.window = { PlugPagBridge: { doPayment: () => 'não é json' } };
    const r = await new PagBankPlugPagDriver('SMARTPOS_EMBEDDED', null).charge(req('d'));
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'WRAPPER_EXCEPTION' });
  });

  it('maquininha ocupada não chama doPayment', async () => {
    const calls = withBridge(() => okRaw, true);
    const r = await new PagBankPlugPagDriver('SMARTPOS_EMBEDDED', null).charge(req('e'));
    expect(r.status).toBe('DECLINED');
    expect(calls).toHaveLength(0);
  });

  it('mesmo request_id não cobra duas vezes; com outro valor é conflito', async () => {
    const calls = withBridge((i) => ({ ...okRaw, hostNsu: '9', autoCode: '8', amount: String(i.amount) }));
    const d = new PagBankPlugPagDriver('SMARTPOS_EMBEDDED', null);
    const [r1, r2] = await Promise.all([d.charge(req('f')), d.charge(req('f'))]);
    expect(r1).toEqual(r2);
    expect(calls).toHaveLength(1);
    const r3 = await d.charge(req('f', 99));
    expect(r3).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'IDEMPOTENCY_CONFLICT' });
    expect(calls).toHaveLength(1);
  });
});

describe('guardApproved (Stone embarcada)', () => {
  it('aprovação sem autorização vira revisão manual', () => {
    const r = guardApproved(
      { status: 'APPROVED', acquirer: 'STONE', acquirer_cnpj: '16501555000157', card_brand: 'VISA', nsu: '1', authorization_code: '', terminal_serial: 'S1', terminal_id: null, masked_pan: null, mode: 'SMARTPOS_EMBEDDED' },
      { request_id: 'x', idempotency_key: 'y', amount: 10, method: 'CREDIT', table_label: '', order_id: '', description: '' },
    );
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'APPROVED_WITHOUT_AUTHORIZATION' });
  });
});
