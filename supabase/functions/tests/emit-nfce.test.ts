import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ACQUIRER_CNPJ,
  NfceValidationError,
  buildNfcePayload,
  fiscalIssuedAt,
  nfceReference,
  paymentGroup,
  toCents,
  validCnpj,
  type NfceSource,
  type PaymentRow,
} from '../emit-nfce/payload.ts';
import { classifyTransmission, createFocusClient, focusEnvironment, normalizeProviderStatus, type FetchLike } from '../emit-nfce/focus.ts';
import { emitNfce, type NfceDocumentRow, type NfceRepository } from '../emit-nfce/emit.ts';
import { parseDanfePayload } from '../../../src/lib/sync/nfceEmission.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const KEY = '43261112345678000195650010000000421000000427';
const QR = `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY}|2|2|1|ABCDEF`;

function source(overrides: Partial<NfceSource> = {}): NfceSource {
  return {
    tenant: { id: TENANT, cnpj: '12345678000195', state: 'RS', focus_nfe_token: 'tok' },
    order: {
      id: ORDER,
      tenant_id: TENANT,
      status: 'CLOSED',
      customer_cpf: null,
      // Postgres NUMERIC chega como texto.
      subtotal_items: '91.50',
      service_fee_amount: '9.15',
      discount_amount: '5.00',
      total_amount: '95.65',
      remaining_balance: '0.00',
      charge_service_fee: true,
      service_fee_pct: '10.00',
    },
    items: [
      { id: 'i1', order_id: ORDER, product_id: 'p1', quantity: '2.000', unit_price: '32.00', modifiers_unit_price: '4.50', total_item_price: '73.00', meat_doneness: 'Ao ponto', status: 'DELIVERED' },
      { id: 'i2', order_id: ORDER, product_id: 'p2', quantity: '1.000', unit_price: '18.50', modifiers_unit_price: '0.00', total_item_price: '18.50', meat_doneness: null, status: 'DELIVERED' },
      { id: 'i3', order_id: ORDER, product_id: 'p2', quantity: '1.000', unit_price: '18.50', modifiers_unit_price: '0.00', total_item_price: '18.50', meat_doneness: null, status: 'CANCELED' },
    ],
    products: [
      { id: 'p1', tenant_id: TENANT, code: 'PIC01', name: 'Picanha', ncm: '02013000', cfop: '5102', csosn_cst: '102', unit: 'UN' },
      { id: 'p2', tenant_id: TENANT, code: 'CHP01', name: 'Chopp Pilsen', ncm: '22030000', cfop: '5405', csosn_cst: '500', unit: 'UN' },
    ],
    payments: [
      { id: 'pay1', order_id: ORDER, tenant_id: TENANT, amount: '50.00', method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE', acquirer_cnpj: ACQUIRER_CNPJ.STONE, card_brand: 'Visa', authorization_code: 'A1B2C3' },
      { id: 'pay2', order_id: ORDER, tenant_id: TENANT, amount: '45.65', method: 'CASH', status: 'APPROVED', acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, authorization_code: null },
      { id: 'pay3', order_id: ORDER, tenant_id: TENANT, amount: '10.00', method: 'DEBIT', status: 'DECLINED', acquirer: 'PAGBANK', acquirer_cnpj: ACQUIRER_CNPJ.PAGBANK, card_brand: 'Elo', authorization_code: 'X' },
    ],
    ...overrides,
  };
}

const card = (over: Partial<PaymentRow>): PaymentRow => ({
  id: 'p', order_id: ORDER, tenant_id: TENANT, amount: '10.00', method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE', acquirer_cnpj: ACQUIRER_CNPJ.STONE, card_brand: 'Mastercard', authorization_code: '123456', ...over,
});

describe('payload NFC-e', () => {
  it('converte NUMERIC em texto sem concatenar strings', () => {
    expect(toCents('12.50', 'x') + toCents('1.00', 'x')).toBe(1350);
    expect(toCents('0.005', 'x')).toBe(1);
  });

  it('CNPJs das credenciadoras têm DV válido', () => {
    expect(validCnpj(ACQUIRER_CNPJ.STONE)).toBe(true);
    expect(validCnpj(ACQUIRER_CNPJ.PAGBANK)).toBe(true);
    expect(validCnpj('11111111111111')).toBe(false);
  });

  it('rateia taxa de serviço e desconto por item e fecha no centavo', () => {
    const p = buildNfcePayload(source(), '2026-11-09T03:00:00-03:00');
    expect(p.items).toHaveLength(2); // item cancelado fora
    expect(p.items[0]!.valor_unitario_comercial).toBe(36.5);
    const cents = (n: number | undefined) => Math.round((n ?? 0) * 100);
    expect(p.items.reduce((s, i) => s + cents(i.valor_outras_despesas), 0)).toBe(915);
    expect(p.items.reduce((s, i) => s + cents(i.valor_desconto), 0)).toBe(500);
    expect(p.items.reduce((s, i) => s + cents(i.valor_bruto), 0)).toBe(9150);
    expect(p.valor_total).toBe(95.65);
    expect(p.formas_pagamento.reduce((s, f) => s + cents(f.valor_pagamento), 0)).toBe(9565);
    expect(p.data_emissao).toBe('2026-11-09T03:00:00-03:00');
  });

  it('o payload transmitido é aceito pelo aparelho para montar o DANFE (contrato servidor ↔ telas)', () => {
    const p = buildNfcePayload(source(), '2026-11-09T03:00:00-03:00');
    const d = parseDanfePayload(JSON.parse(JSON.stringify(p)));
    expect(d).not.toBeNull();
    expect(d!.valor_total).toBe(p.valor_total);
    expect(d!.items.map((i) => i.descricao)).toEqual(p.items.map((i) => i.descricao));
  });

  it('cartão Stone com prova sai integrado; dinheiro sem grupo de cartão', () => {
    const p = buildNfcePayload(source());
    expect(p.formas_pagamento[0]).toEqual({ forma_pagamento: '03', valor_pagamento: 50, indicador_pagamento: 0, tipo_integracao: 1, cnpj_credenciadora: ACQUIRER_CNPJ.STONE, numero_autorizacao: 'A1B2C3', bandeira_operadora: '01' });
    expect(p.formas_pagamento[1]).toEqual({ forma_pagamento: '01', valor_pagamento: 45.65, indicador_pagamento: 0 });
  });

  it('nunca atribui CNPJ do PagBank a adquirente que não é PagBank', () => {
    expect(paymentGroup(card({ acquirer: 'MOCK', acquirer_cnpj: null }))).toMatchObject({ tipo_integracao: 2 });
    expect(paymentGroup(card({ acquirer: 'MOCK' })).cnpj_credenciadora).toBeUndefined();
    // Stone gravado com CNPJ do PagBank: incoerente, não integra.
    expect(paymentGroup(card({ acquirer: 'STONE', acquirer_cnpj: ACQUIRER_CNPJ.PAGBANK }))).toMatchObject({ tipo_integracao: 2 });
    expect(paymentGroup(card({ authorization_code: null }))).toMatchObject({ tipo_integracao: 2 });
    expect(paymentGroup(card({ acquirer: 'PAGBANK', acquirer_cnpj: ACQUIRER_CNPJ.PAGBANK, method: 'DEBIT' }))).toMatchObject({ forma_pagamento: '04', tipo_integracao: 1, cnpj_credenciadora: ACQUIRER_CNPJ.PAGBANK, bandeira_operadora: '02' });
  });

  it('Pix sai não integrado e vale-refeição usa tPag 11', () => {
    expect(paymentGroup(card({ method: 'PIX' }))).toEqual({ forma_pagamento: '17', valor_pagamento: 10, indicador_pagamento: 0, tipo_integracao: 2 });
    expect(paymentGroup(card({ method: 'VOUCHER' }))).toEqual({ forma_pagamento: '11', valor_pagamento: 10, indicador_pagamento: 0 });
  });

  it('bloqueia comanda aberta, saldo pendente e pagamento que não fecha o total', () => {
    const s = source();
    expect(() => buildNfcePayload({ ...s, order: { ...s.order, status: 'PAYING' } })).toThrow(NfceValidationError);
    expect(() => buildNfcePayload({ ...s, order: { ...s.order, remaining_balance: '1.00' } })).toThrow(/saldo/);
    expect(() => buildNfcePayload({ ...s, payments: s.payments.slice(0, 1) })).toThrow(/Pagamentos aprovados/);
    expect(() => buildNfcePayload({ ...s, order: { ...s.order, total_amount: '96.00' } })).toThrow(/Total da comanda/);
  });

  it('bloqueia item com total gravado divergente e produto de outro tenant', () => {
    const s = source();
    const items = s.items.map((i) => (i.id === 'i2' ? { ...i, total_item_price: '18.49' } : i));
    expect(() => buildNfcePayload({ ...s, items })).toThrow(/diverge/);
    const products = s.products.map((p) => (p.id === 'p2' ? { ...p, tenant_id: 'outro' } : p));
    expect(() => buildNfcePayload({ ...s, products })).toThrow(/não encontrado/);
  });

  it('CPF do consumidor validado', () => {
    const s = source();
    expect(() => buildNfcePayload({ ...s, order: { ...s.order, customer_cpf: '111.111.111-11' } })).toThrow(/CPF/);
    expect(buildNfcePayload({ ...s, order: { ...s.order, customer_cpf: '529.982.247-25' } }).cpf_destinatario).toBe('52998224725');
  });

  it('referência e horário fiscal', () => {
    expect(nfceReference(ORDER)).toBe('tchefood22222222222242228222222222222222');
    expect(fiscalIssuedAt(new Date('2026-11-09T06:00:00Z'))).toBe('2026-11-09T03:00:00-03:00');
  });
});

describe('Focus: status e erros', () => {
  it('só "producao" exato liga produção', () => {
    expect(focusEnvironment('producao')).toBe('producao');
    expect(focusEnvironment('PRODUCAO')).toBe('homologacao');
    expect(focusEnvironment(undefined)).toBe('homologacao');
  });

  it('contingência offline não é autorização até ser efetivada', () => {
    expect(normalizeProviderStatus('autorizado', 'processing', { offlineContingency: true, offlineContingencyEffective: false })).toBe('contingency');
    expect(normalizeProviderStatus('autorizado', 'contingency', { offlineContingency: null, offlineContingencyEffective: null })).toBe('contingency');
    expect(normalizeProviderStatus('autorizado', 'contingency', { offlineContingency: true, offlineContingencyEffective: true })).toBe('authorized');
  });

  it('erro de API desconhecido fica em processamento; recusa conhecida vira rejeição', async () => {
    const empty = (await createFocusClient({ environment: 'homologacao', token: 't', fetch: async () => ({ status: 500, ok: false, text: async () => '{}' }) }).transmit('r', {})).response;
    expect(classifyTransmission({ httpStatus: 500, ok: false, errorCode: null, response: empty }).status).toBe('processing');
    expect(classifyTransmission({ httpStatus: 422, ok: false, errorCode: 'erro_validacao_schema', response: empty }).status).toBe('erro_autorizacao');
  });

  it('timeout de rede vira indeterminado, nunca sucesso', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('timeout');
    };
    const r = await createFocusClient({ environment: 'homologacao', token: 't', fetch }).transmit('ref1', {});
    expect(r.ok).toBe(false);
    expect(r.response.status).toBe('processing');
  });
});

class MemoryRepo implements NfceRepository {
  doc: NfceDocumentRow | null = null;
  constructor(public src: NfceSource) {}
  async loadSource(tenantId: string, orderId: string) {
    return tenantId === TENANT && orderId === ORDER ? this.src : null;
  }
  async getDocument() {
    return this.doc ? { ...this.doc } : null;
  }
  async insertProcessing(d: { tenant_id: string; order_id: string; reference: string; environment: 'homologacao' | 'producao'; payload_hash: string | null; payload: unknown }) {
    if (this.doc) return null;
    const { payload, ...rest } = d;
    this.doc = { id: 'd1', ...rest, payload, issued_at: (payload as { data_emissao?: string }).data_emissao ?? null, status: 'processing', access_key: null, protocol: null, number: null, series: null, qrcode_url: null, danfe_path: null, xml_path: null, sefaz_status: null, sefaz_message: null, offline_contingency: false, transmissions: 1 };
    return { ...this.doc };
  }
  async claimRejected(id: string, expectedTransmissions: number, payloadHash: string, payload: unknown = {}) {
    if (!this.doc || this.doc.id !== id || this.doc.status !== 'rejected' || this.doc.transmissions !== expectedTransmissions) return null;
    this.doc = { ...this.doc, status: 'processing', payload_hash: payloadHash, transmissions: this.doc.transmissions + 1, payload, issued_at: (payload as { data_emissao?: string }).data_emissao ?? null };
    return { ...this.doc };
  }
  async saveProviderResult(id: string, expected: string, expectedTransmissions: number, fields: Partial<NfceDocumentRow>) {
    if (!this.doc || this.doc.id !== id || this.doc.status !== expected || this.doc.transmissions !== expectedTransmissions) return null;
    this.doc = { ...this.doc, ...fields };
    return { ...this.doc };
  }
}

function fakeFocus(responses: Array<{ status: number; body: unknown } | 'network'>) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url });
    const next = responses.shift();
    if (!next || next === 'network') throw new Error('network');
    return { status: next.status, ok: next.status >= 200 && next.status < 300, text: async () => JSON.stringify(next.body) };
  };
  return { calls, focus: (token: string) => createFocusClient({ environment: 'homologacao', token, fetch }) };
}

const sha256Hex = async (t: string) => createHash('sha256').update(t).digest('hex');
const AUTHORIZED = { status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e', chave_nfe: `NFe${KEY}`, protocolo: '143260000000001', numero: '42', serie: '1', qrcode_url: QR, caminho_danfe: '/notas_fiscais_consumidor/x.html' };

describe('emitNfce', () => {
  it('autoriza, grava protocolo e QR Code, e não reenvia na segunda chamada', async () => {
    const repo = new MemoryRepo(source());
    const { calls, focus } = fakeFocus([{ status: 201, body: AUTHORIZED }]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    const first = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(first.httpStatus).toBe(200);
    expect(first.body).toMatchObject({ authorized: true, access_key: KEY, protocol: '143260000000001', qrcode_url: QR });
    const second = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(second.body.authorized).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('consulta (mode consult) sem documento não transmite nada e responde none', async () => {
    const repo = new MemoryRepo(source());
    const { calls, focus } = fakeFocus([{ status: 201, body: AUTHORIZED }]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    const r = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r.httpStatus).toBe(404);
    expect(r.body).toMatchObject({ status: 'none', authorized: false, access_key: null, payload: null });
    expect(calls).toHaveLength(0);
    expect(repo.doc).toBeNull();
    // Depois de emitida, a consulta devolve o documento sem nova transmissão.
    await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    const again = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(again.body).toMatchObject({ status: 'authorized', access_key: KEY });
    expect(calls).toHaveLength(1);
  });

  it('consulta de rejeitada não reenvia', async () => {
    const repo = new MemoryRepo(source());
    const { calls, focus } = fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', mensagem_sefaz: 'NCM' } }]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    const r = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r.body.status).toBe('rejected');
    expect(calls).toHaveLength(1);
  });

  it('autorizada sem QR Code: a chamada seguinte só consulta (GET) e completa o QR, sem retransmitir', async () => {
    const repo = new MemoryRepo(source());
    const { calls, focus } = fakeFocus([{ status: 201, body: { ...AUTHORIZED, qrcode_url: null } }, { status: 200, body: AUTHORIZED }]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    const first = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(first.body).toMatchObject({ status: 'authorized', qrcode_url: null });
    const second = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(second.body).toMatchObject({ status: 'authorized', access_key: KEY, qrcode_url: QR });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(repo.doc!.payload).toEqual(first.body.payload);
  });

  it('devolve a data de emissão transmitida (a tela imprime no DANFE)', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 201, body: AUTHORIZED }]);
    const now = () => new Date('2026-11-14T13:00:00Z');
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex, now }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body.issued_at).toBe(fiscalIssuedAt(now()));
    expect(r.body.issued_at).toMatch(/-03:00$/);
    const missing = await emitNfce({ repo: new MemoryRepo(source({ tenant: { ...source().tenant, focus_nfe_token: null } })), environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(missing.body).toMatchObject({ status: 'invalid', issued_at: null, payload: null });
  });

  it('devolve o payload transmitido só para nota com chave (o DANFE da tela sai dele)', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 201, body: AUTHORIZED }]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body.payload).toEqual(repo.doc!.payload);
    expect((r.body.payload as { items: unknown[] }).items.length).toBeGreaterThan(0);
    const rej = new MemoryRepo(source());
    const f2 = fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', mensagem_sefaz: 'NCM' } }]);
    const r2 = await emitNfce({ repo: rej, environment: 'homologacao', focus: f2.focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r2.body.status).toBe('rejected');
    expect(r2.body.payload).toBeNull();
  });

  it('falha de rede NÃO vira contingência nem sucesso; a próxima chamada só consulta', async () => {
    const repo = new MemoryRepo(source());
    const { calls, focus } = fakeFocus(['network', { status: 200, body: AUTHORIZED }]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    const first = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(first.httpStatus).toBe(202);
    expect(first.body).toMatchObject({ status: 'processing', authorized: false, contingency: false });
    const second = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(second.body.authorized).toBe(true);
  });

  it('contingência offline da Focus aparece como contingência, não autorizada', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 201, body: { ...AUTHORIZED, contingencia_offline: true, contingencia_offline_efetivada: false } }]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'contingency', authorized: false, contingency: true, protocol: null });
    expect(repo.doc?.status).toBe('contingency');
  });

  it('rejeição da SEFAZ permite reenviar a mesma referência', async () => {
    const repo = new MemoryRepo(source());
    const { calls, focus } = fakeFocus([
      { status: 422, body: { status: 'erro_autorizacao', status_sefaz: '778', mensagem_sefaz: 'NCM inexistente' } },
      { status: 201, body: AUTHORIZED },
    ]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    const first = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(first.httpStatus).toBe(422);
    expect(first.body).toMatchObject({ status: 'rejected', message: 'NCM inexistente' });
    const second = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(second.body.authorized).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(calls[1]!.url).toContain('ref=tchefood2222');
  });

  it('referência já conhecida pela Focus é consultada, não reenviada', async () => {
    const repo = new MemoryRepo(source());
    const { calls, focus } = fakeFocus([{ status: 422, body: { codigo: 'already_processed', mensagem: 'ja processada' } }, { status: 200, body: AUTHORIZED }]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(r.body.authorized).toBe(true);
  });

  it('lê o protocolo da resposta completa (protocolo_nota_fiscal.numero_protocolo)', async () => {
    const repo = new MemoryRepo(source());
    const { protocolo: _omit, ...complete } = AUTHORIZED;
    const { focus } = fakeFocus([{ status: 201, body: { ...complete, protocolo_nota_fiscal: { numero_protocolo: '143260000000077', chave_nfe: KEY } } }]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ authorized: true, protocol: '143260000000077' });
  });

  it('"autorizado" sem protocolo não é autorização', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 201, body: { status: 'autorizado', chave_nfe: KEY } }]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'processing', authorized: false });
  });

  it('QR Code de outra nota ou url_danfe não é aceito', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 201, body: { ...AUTHORIZED, qrcode_url: 'https://evil.example/qr?p=' + KEY } }]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body.authorized).toBe(true);
    expect(r.body.qrcode_url).toBeNull();
  });

  it('comanda inválida não grava documento nem chama a Focus', async () => {
    const s = source();
    const repo = new MemoryRepo({ ...s, order: { ...s.order, status: 'OPEN' } });
    const { calls, focus } = fakeFocus([]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.httpStatus).toBe(422);
    expect(repo.doc).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('documento de homologação não é reaproveitado com o servidor em produção', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus(['network']);
    await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    const r = await emitNfce({ repo, environment: 'producao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.httpStatus).toBe(409);
  });

  it('GET atrasado da tentativa anterior não grava rejeição sobre o reenvio em curso', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', mensagem_sefaz: 'NCM' } }]);
    await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    const stale = { ...repo.doc! }; // leitura da tentativa 1
    await repo.claimRejected(stale.id, stale.transmissions, 'h2'); // tentativa 2 em curso
    const saved = await repo.saveProviderResult(stale.id, 'processing', stale.transmissions, { status: 'rejected' });
    expect(saved).toBeNull();
    expect(repo.doc?.status).toBe('processing');
  });

  it('reserva de reenvio com contador antigo não reutiliza o número da tentativa', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', mensagem_sefaz: 'NCM' } }]);
    await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    const read = repo.doc!.transmissions; // duas requisições leram a tentativa 1
    expect(await repo.claimRejected('d1', read, 'a')).not.toBeNull();
    repo.doc = { ...repo.doc!, status: 'rejected' }; // tentativa 2 rejeitada
    expect(await repo.claimRejected('d1', read, 'b')).toBeNull();
  });

  it('nota em processamento cancelada na Focus é gravada como cancelada', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus(['network', { status: 200, body: { ...AUTHORIZED, status: 'cancelado' } }]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    const r = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    expect(r.body.status).toBe('cancelled');
    expect(repo.doc?.status).toBe('cancelled');
  });

  it('comanda de outro tenant: 404', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([]);
    const r = await emitNfce({ repo, environment: 'homologacao', focus, sha256Hex }, { tenantId: '33333333-3333-4333-8333-333333333333', orderId: ORDER });
    expect(r.httpStatus).toBe(404);
  });
});
