import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ACQUIRER_CNPJ as DEVICE_ACQUIRER_CNPJ } from '../../../src/lib/payments/drivers';
import {
  ACQUIRER_CNPJ,
  NfceValidationError,
  buildNfcePayload,
  fiscalIssuedAt,
  issuerSnapshot,
  nfceReference,
  paymentGroup,
  toCents,
  validCnpj,
  type NfceSource,
  type PaymentRow,
} from '../emit-nfce/payload.ts';
import { classifyTransmission, createFocusClient, focusEnvironment, isValidAccessKey, isValidQrCodeUrl, normalizeProviderStatus, parseAuthorizedXml, type FetchLike } from '../emit-nfce/focus.ts';
import { parseEmitResponse } from '../../../src/lib/sync/nfceEmission.ts';
import { supabaseNfceRepository } from '../emit-nfce/repository.ts';
import { emitNfce, type NfceDocumentRow, type NfceRepository } from '../emit-nfce/emit.ts';
import { parseDanfePayload, parseNfceIssuer } from '../../../src/lib/sync/nfceEmission.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const KEY = '43261112345678000195650010000000421000000420';
const QR = `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY}|2|2|1|ABCDEF0123456789ABCDEF0123456789ABCDEF01`;

function source(overrides: Partial<NfceSource> = {}): NfceSource {
  return {
    tenant: { id: TENANT, cnpj: '12345678000195', state: 'RS', focus_nfe_token: 'tok', name: 'Flip', legal_name: 'FLIP LTDA', state_registration: '0960000000', city: 'Santo Angelo' },
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

  it('auditoria 2 (P2-D): cartão da Point (Mercado Pago) com prova sai integrado como na prévia do aparelho', () => {
    const mp = card({ acquirer: 'MERCADO_PAGO', acquirer_cnpj: DEVICE_ACQUIRER_CNPJ.MERCADO_PAGO, card_brand: 'Mastercard', authorization_code: 'A1B2C3' });
    expect(paymentGroup(mp)).toEqual({
      forma_pagamento: '03', valor_pagamento: 10, indicador_pagamento: 0, tipo_integracao: 1,
      cnpj_credenciadora: '10573521000191', numero_autorizacao: 'A1B2C3', bandeira_operadora: '02',
    });
    // Mesmo CNPJ que o aparelho grava (src/lib/payments/drivers.ts), para todas as credenciadoras.
    expect(ACQUIRER_CNPJ).toEqual(DEVICE_ACQUIRER_CNPJ);
    expect(validCnpj(ACQUIRER_CNPJ.MERCADO_PAGO)).toBe(true);
    // Sem prova coerente continua não integrado.
    expect(paymentGroup({ ...mp, acquirer_cnpj: ACQUIRER_CNPJ.STONE })).toMatchObject({ tipo_integracao: 2 });
    expect(paymentGroup({ ...mp, authorization_code: null })).toMatchObject({ tipo_integracao: 2 });
    expect(paymentGroup({ ...mp, acquirer: 'STONE' })).toMatchObject({ tipo_integracao: 2 });
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
  async insertProcessing(d: { tenant_id: string; order_id: string; reference: string; environment: 'homologacao' | 'producao'; payload_hash: string | null; payload: unknown; issuer: unknown }) {
    if (this.doc) return null;
    const { payload, ...rest } = d;
    this.doc = { id: 'd1', ...rest, payload, issued_at: (payload as { data_emissao?: string }).data_emissao ?? null, status: 'processing', access_key: null, protocol: null, number: null, series: null, qrcode_url: null, danfe_path: null, xml_path: null, sefaz_status: null, sefaz_message: null, offline_contingency: false, transmissions: 1 };
    return { ...this.doc };
  }
  async claimRejected(id: string, expectedTransmissions: number, payloadHash: string, payload: unknown = {}, issuer: unknown = null) {
    if (!this.doc || this.doc.id !== id || this.doc.status !== 'rejected' || this.doc.transmissions !== expectedTransmissions) return null;
    this.doc = { ...this.doc, status: 'processing', payload_hash: payloadHash, transmissions: this.doc.transmissions + 1, payload, issuer, authorized_at: null, issuer_address: null, access_key: null, protocol: null, qrcode_url: null, danfe_path: null, xml_path: null, issued_at: (payload as { data_emissao?: string }).data_emissao ?? null };
    return { ...this.doc };
  }
  async saveProviderResult(id: string, expected: string, expectedTransmissions: number, fields: Partial<NfceDocumentRow>) {
    if (!this.doc || this.doc.id !== id || this.doc.status !== expected || this.doc.transmissions !== expectedTransmissions) return null;
    this.doc = { ...this.doc, ...fields };
    return { ...this.doc };
  }
}

const XML_PATH = '/arquivos_development/x/NFe.xml';
/** XML autorizado como a Focus devolve (trecho): Id da chave, emitente com endereço, dhRecbto do protocolo. */
function authorizedXml(key = KEY, over: { cnpj?: string; id?: string; ender?: string; dh?: string; protKey?: string; nprot?: string } = {}) {
  const ender = over.ender ?? '<enderEmit><xLgr>Rua das Flores</xLgr><nro>120</nro><xBairro>Centro</xBairro><cMun>4317103</cMun><xMun>Santo Angelo</xMun><UF>RS</UF><CEP>98800000</CEP></enderEmit>';
  return `<nfeProc><NFe><infNFe versao="4.00" Id="NFe${over.id ?? key}"><emit><CNPJ>${over.cnpj ?? key.slice(6, 20)}</CNPJ><xNome>FLIP</xNome>${ender}<IE>0960000000</IE></emit></infNFe></NFe><protNFe><infProt><chNFe>${over.protKey ?? key}</chNFe><dhRecbto>${over.dh ?? '2026-11-09T03:00:07-03:00'}</dhRecbto><nProt>${over.nprot ?? '143260000000001'}</nProt></infProt></protNFe></nfeProc>`;
}

function fakeFocus(responses: Array<{ status: number; body: unknown } | 'network'>, xml: string | null = authorizedXml()) {
  const calls: Array<{ method: string; url: string }> = [];
  const xmlCalls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith(XML_PATH)) {
      xmlCalls.push(url);
      return xml === null ? { status: 404, ok: false, text: async () => '' } : { status: 200, ok: true, text: async () => xml };
    }
    calls.push({ method: init.method, url });
    const next = responses.shift();
    if (!next || next === 'network') throw new Error('network');
    return { status: next.status, ok: next.status >= 200 && next.status < 300, text: async () => JSON.stringify(next.body) };
  };
  return { calls, xmlCalls, focus: (token: string) => createFocusClient({ environment: 'homologacao', token, fetch }) };
}

const sha256Hex = async (t: string) => createHash('sha256').update(t).digest('hex');
const AUTHORIZED = { status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e', chave_nfe: `NFe${KEY}`, protocolo: '143260000000001', numero: '42', serie: '1', qrcode_url: QR, caminho_danfe: '/notas_fiscais_consumidor/x.html', caminho_xml_nota_fiscal: XML_PATH };

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

  it('P2-01 r5: consulta do documento já gravado não exige o token Focus; emissão nova sem token continua bloqueada', async () => {
    for (const token of [null, '', '   ']) {
      const repo = new MemoryRepo(source({ tenant: { ...source().tenant, focus_nfe_token: token } }));
      repo.doc = {
        id: 'd1', tenant_id: TENANT, order_id: ORDER, reference: nfceReference(ORDER), environment: 'homologacao', payload_hash: 'h', payload: { data_emissao: '2026-11-14T10:00:00-03:00' }, issuer: null, issued_at: '2026-11-14T10:00:00-03:00',
        status: 'authorized', access_key: KEY, protocol: '143260000000001', number: 42, series: '1', qrcode_url: QR, danfe_path: '/x.html', xml_path: null, sefaz_status: '100', sefaz_message: 'Autorizado', offline_contingency: false, transmissions: 1,
      } as NfceDocumentRow;
      const { calls, focus } = fakeFocus([]);
      const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
      const r = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER, consultOnly: true });
      expect(r.httpStatus).toBe(200);
      expect(r.body).toMatchObject({ status: 'authorized', authorized: true, access_key: KEY, qrcode_url: QR });
      expect(calls).toHaveLength(0);
      // Sem documento, consultar não transmite e nada pede token.
      const empty = new MemoryRepo(source({ tenant: { ...source().tenant, focus_nfe_token: token } }));
      const none = await emitNfce({ ...deps, repo: empty }, { tenantId: TENANT, orderId: ORDER, consultOnly: true });
      expect(none.body.status).toBe('none');
      // Emissão nova sem token: bloqueada, nada gravado nem enviado.
      const blocked = await emitNfce({ ...deps, repo: empty }, { tenantId: TENANT, orderId: ORDER });
      expect(blocked.httpStatus).toBe(422);
      expect(blocked.body.status).toBe('invalid');
      expect(empty.doc).toBeNull();
      expect(calls).toHaveLength(0);
    }
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

  it('P1-01 r3: emitente gravado com o payload na transmissão, devolvido só com chave e aceito pelo aparelho', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 201, body: AUTHORIZED }]);
    const deps = { repo, environment: 'homologacao' as const, focus, sha256Hex };
    const r = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER });
    const expected = { name: 'Flip', legal_name: 'FLIP LTDA', cnpj: '12345678000195', state_registration: '0960000000', city: 'Santo Angelo', state: 'RS' };
    expect(repo.doc!.issuer).toEqual(expected);
    expect(r.body.issuer).toEqual(expected);
    expect(parseNfceIssuer(JSON.parse(JSON.stringify(r.body.issuer)))).toEqual(expected);
    // Cadastro mudado depois no servidor: a consulta devolve o emitente gravado, não o novo.
    repo.src = source({ tenant: { ...source().tenant, legal_name: 'RAZAO NOVA' } });
    const again = await emitNfce(deps, { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(again.body.issuer).toEqual(expected);
    // Rejeitada não devolve emitente; o reenvio grava o do cadastro atual com o payload novo.
    const rej = new MemoryRepo(source());
    const f2 = fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', mensagem_sefaz: 'NCM' } }, { status: 201, body: AUTHORIZED }]);
    const d2 = { repo: rej, environment: 'homologacao' as const, focus: f2.focus, sha256Hex };
    expect((await emitNfce(d2, { tenantId: TENANT, orderId: ORDER })).body.issuer).toBeNull();
    rej.src = source({ tenant: { ...source().tenant, legal_name: 'RAZAO CORRIGIDA' } });
    const ok = await emitNfce(d2, { tenantId: TENANT, orderId: ORDER });
    expect((ok.body.issuer as { legal_name: string }).legal_name).toBe('RAZAO CORRIGIDA');
    // Cadastro do servidor incompleto: sem emitente (o aparelho não imprime; fica o DANFE da Focus).
    expect(issuerSnapshot({ ...source().tenant, legal_name: null })).toBeNull();
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


describe('P1-02 e P1-03 (2ª auditoria do #55): endereço do emitente e dhRecbto vêm do XML autorizado', () => {
  const deps = (repo: MemoryRepo, focus: ReturnType<typeof fakeFocus>['focus']) => ({ repo, environment: 'homologacao' as const, focus, sha256Hex });
  const ADDRESS = { street: 'Rua das Flores', number: '120', complement: null, district: 'Centro', city: 'Santo Angelo', state: 'RS', zip: '98800000' };

  it('grava e devolve endereço (enderEmit) e data de autorização (dhRecbto) do XML, e não consulta de novo depois', async () => {
    const repo = new MemoryRepo(source());
    const { calls, xmlCalls, focus } = fakeFocus([{ status: 201, body: AUTHORIZED }]);
    const first = await emitNfce(deps(repo, focus), { tenantId: TENANT, orderId: ORDER });
    expect(first.body).toMatchObject({ authorized: true, issuer_address: ADDRESS, authorized_at: '2026-11-09T06:00:07.000Z' });
    expect(xmlCalls).toHaveLength(1);
    const again = await emitNfce(deps(repo, focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(again.body).toMatchObject({ issuer_address: ADDRESS, authorized_at: '2026-11-09T06:00:07.000Z' });
    expect(calls).toHaveLength(1);
    expect(xmlCalls).toHaveLength(1);
  });

  it('XML de outra nota (Id ou CNPJ diferentes) ou ausente não preenche nada: nem endereço, nem data inventada a partir da emissão', async () => {
    for (const xml of [authorizedXml(KEY, { id: `${KEY.slice(0, 43)}9` }), authorizedXml(KEY, { cnpj: '48291736000155' }), authorizedXml(KEY, { ender: '' }), null]) {
      const repo = new MemoryRepo(source());
      const { focus } = fakeFocus([{ status: 201, body: AUTHORIZED }], xml);
      const r = await emitNfce(deps(repo, focus), { tenantId: TENANT, orderId: ORDER });
      expect(r.body.authorized).toBe(true);
      expect(r.body.issuer_address).toBeNull();
      // data_emissao do payload nunca vira data de autorização.
      expect(r.body.authorized_at).not.toBe(r.body.issued_at);
    }
  });

  it('a data do protocolo da Focus vale quando o XML não vem, e uma consulta posterior completa o endereço sem mudar a data', async () => {
    const repo = new MemoryRepo(source());
    const withProtocol = { ...AUTHORIZED, protocolo_nota_fiscal: { numero_protocolo: '143260000000001', data_recebimento: '2026-11-09T03:03:00-03:00' } };
    const first = fakeFocus([{ status: 201, body: withProtocol }], null);
    const r1 = await emitNfce(deps(repo, first.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r1.body).toMatchObject({ issuer_address: null, authorized_at: '2026-11-09T06:03:00.000Z' });
    // Documento com QR mas sem endereço: a consulta (GET) busca o XML; a data já gravada não muda.
    const second = fakeFocus([{ status: 200, body: withProtocol }], authorizedXml(KEY, { dh: '2026-11-09T03:09:00-03:00' }));
    const r2 = await emitNfce(deps(repo, second.focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r2.body).toMatchObject({ issuer_address: ADDRESS, authorized_at: '2026-11-09T06:03:00.000Z' });
    expect(second.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('parseAuthorizedXml: chave inválida, XML sem enderEmit ou com CEP/UF malformados não devolve endereço', () => {
    expect(parseAuthorizedXml(authorizedXml(), KEY).address).toEqual(ADDRESS);
    expect(parseAuthorizedXml(authorizedXml(), 'x').address).toBeNull();
    expect(parseAuthorizedXml(authorizedXml(KEY, { ender: '<enderEmit><xLgr>R</xLgr><nro>1</nro><xBairro>B</xBairro><xMun>M</xMun><UF>rs</UF><CEP>12</CEP></enderEmit>' }), KEY).address).toBeNull();
    expect(parseAuthorizedXml(authorizedXml(KEY, { dh: 'ontem' }), KEY).authorizedAt).toBeNull();
  });

  it('QR Code do servidor: só https e só o portal da SEFAZ da UF da chave', () => {
    expect(isValidQrCodeUrl(QR, KEY, 'homologacao')).toBe(true);
    expect(isValidQrCodeUrl(QR.replace('https:', 'http:'), KEY, 'homologacao')).toBe(false);
    expect(isValidQrCodeUrl(QR.replace('www.sefaz.rs.gov.br', 'evil.gov.br'), KEY, 'homologacao')).toBe(false);
    expect(isValidQrCodeUrl(QR.replace('/NFCE/NFCE-COM.aspx', '/x'), KEY, 'homologacao')).toBe(false);
  });
});


describe('achados do Codex no #63', () => {
  it('P1: o CNPJ do emitente no XML tem 14 caracteres e é comparado inteiro com o da chave', () => {
    const xml = authorizedXml().replace(/<CNPJ>\d+<\/CNPJ>/, '<CNPJ>12345678000195</CNPJ>');
    expect(parseAuthorizedXml(xml, KEY).address).toMatchObject({ street: 'Rua das Flores', zip: '98800000' });
    expect(parseAuthorizedXml(xml.replace('12345678000195', '12345678000196'), KEY).address).toBeNull();
    expect(parseAuthorizedXml(xml.replace('<CNPJ>12345678000195', '<CNPJ>123456780001'), KEY).address).toBeNull();
  });

  it('P2: nota em contingência também devolve o endereço do emitente (sem data de autorização, que ainda não existe)', async () => {
    const repo = new MemoryRepo(source());
    const { focus } = fakeFocus([{ status: 201, body: { ...AUTHORIZED, contingencia_offline: true, contingencia_offline_efetivada: false } }]);
    const r = await emitNfce({ repo, environment: 'homologacao' as const, focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'contingency', contingency: true, authorized_at: null });
    expect(r.body.issuer_address).toMatchObject({ street: 'Rua das Flores', zip: '98800000' });
  });
});


describe('auditoria do #63 (r8): QR e chave validados igual no servidor e no aparelho', () => {
  const BAD_DV = `${KEY.slice(0, 43)}7`; // DV certo é 0
  const qr = (p: string) => `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${p}`;
  const deps = (repo: MemoryRepo, focus: ReturnType<typeof fakeFocus>['focus']) => ({ repo, environment: 'homologacao' as const, focus, sha256Hex });

  it('P2-01: QR sem versão/tpAmb, com tpAmb vazio ou de outro ambiente é recusado; o correto passa (versões 2 e 3), nos dois validadores', async () => {
    const { isValidNfceQrCodeContent } = await import('../../../src/lib/nfce.ts');
    const H = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    const cases: Array<[string, boolean, 'homologacao' | 'producao']> = [
      [`${KEY}`, false, 'homologacao'], [`${KEY}|2`, false, 'homologacao'], [`${KEY}|3`, false, 'homologacao'],
      [`${KEY}|2|2`, false, 'homologacao'], [`${KEY}|2|2|1`, false, 'homologacao'],
      [`${KEY}|2||1|${H}`, false, 'homologacao'], [`${KEY}|3|`, false, 'homologacao'],
      [`${KEY}|2|1|1|${H}`, false, 'homologacao'], [`${KEY}|3|1`, false, 'homologacao'],
      [`${KEY}|9|2|1|${H}`, false, 'homologacao'], [`${KEY}||2|1|${H}`, false, 'homologacao'],
      [`${KEY}|2|2|1|ABCDEF`, false, 'homologacao'], [`${KEY}|2|2|1|${'Z'.repeat(40)}`, false, 'homologacao'],
      [`${KEY}|2|2|1|${H}|EXTRA`, false, 'homologacao'], [`${KEY}|2|2||${H}`, false, 'homologacao'],
      [`${KEY}|3|2|EXTRA`, false, 'homologacao'], [`${KEY}|3|2|`, false, 'homologacao'],
      [`${KEY}|2|1|1|${H}`, true, 'producao'], [`${KEY}|3|1`, true, 'producao'],
      [`${KEY}|2|2|1|${H}`, true, 'homologacao'], [`${KEY}|3|2`, true, 'homologacao'],
      [`${KEY}|2|2|1|${H}`, false, 'producao'], // ambiente da nota é outro
    ];
    for (const [p, expected, env] of cases) {
      expect(isValidQrCodeUrl(qr(p), KEY, env), `servidor ${p} ${env}`).toBe(expected);
      expect(isValidNfceQrCodeContent(qr(p), KEY, env), `aparelho ${p} ${env}`).toBe(expected);
    }
  });

  it('r16 P2-01: matriz por versão e modalidade (2.0 online 5, 2.0 offline 8 com digVal de 56 hex, 3.0 online 3, 3.0 offline 8) e tpEmis coerente, nos dois validadores', async () => {
    const dev = await import('../../../src/lib/nfce.ts');
    const H = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    const DIG56 = 'AB'.repeat(28);
    const key9 = (() => { const k = `${KEY.slice(0, 34)}9${KEY.slice(35, 43)}`; return k + dev.accessKeyCheckDigit(k); })();
    expect(key9[34]).toBe('9');
    expect(isValidAccessKey(key9)).toBe(true);
    const SIG = `${'A+b/'.repeat(42)}Zg==`; // 172 caracteres Base64 (RSA 1024 → 128 bytes)
    const cases: Array<[string, string, boolean]> = [
      // [chave, p depois da chave, esperado] (ambiente homologação = tpAmb 2)
      [KEY, `|2|2|1|${H}`, true], // 2.0 online, tpEmis 1
      [key9, `|2|2|1|${H}`, false], // 2.0 online com chave de contingência
      [key9, `|2|2|09|15.50|${DIG56}|1|${H}`, true], // 2.0 offline, tpEmis 9, digVal 56
      [key9, `|2|2|09|15.50|${'AB'.repeat(20)}|1|${H}`, false], // digVal de 40 hex
      [key9, `|2|2|09|15.50|${'AB'.repeat(29)}|1|${H}`, false], // digVal de 58 hex
      [key9, `|2|2|09|15.50|${DIG56}|1`, false], // faltando hash (7 campos)
      [key9, `|2|2|09|15.50|${DIG56}|1|${H}|EXTRA`, false], // 9 campos
      [KEY, `|2|2|09|15.50|${DIG56}|1|${H}`, false], // 2.0 offline com chave de emissão normal
      [KEY, `|3|2`, true], // 3.0 online
      [key9, `|3|2`, false], // 3.0 online com chave de contingência
      [key9, `|3|2|09|15.50|1|12345678000195|${SIG}`, true], // CNPJ
      [key9, `|3|2|09|15.50|2|12345678901|${SIG}`, true], // CPF
      [key9, `|3|2|09|15.50|3|AB12345|${SIG}`, true], // estrangeiro
      [key9, `|3|2|09|15.50|||${SIG}`, true], // consumidor não identificado (campos 6 e 7 vazios), como no manual 6.0
      [key9, `|3|2|09|15.50|12345678901|1|${SIG}`, false], // campos invertidos (CPF no lugar do tipo)
      [key9, `|3|2|09|15.50|2||${SIG}`, false], // tipo sem identificação
      [key9, `|3|2|09|15.50||12345678901|${SIG}`, false], // identificação sem tipo
      [key9, `|3|2|09|15.50|2|1234567890|${SIG}`, false], // CPF com 10 dígitos
      [key9, `|3|2|09|15.50|4|12345678901|${SIG}`, false], // tipo desconhecido
      [key9, `|3|2|09|15.50|2|12345678901|${SIG.slice(0, 170)}`, false], // assinatura malformada (tamanho não múltiplo de 4)
      [key9, `|3|2|09|15.50|2|12345678901|${'!'.repeat(172)}`, false], // assinatura fora do Base64
      [key9, `|3|2|09|15.50|2|12345678901|`, false], // assinatura ausente
      [key9, `|3|2|09|15.50|12345678901|1`, false], // 7 campos
      [key9, `|3|2|9|15.50|2|12345678901|${SIG}`, false], // dia com 1 dígito
      [KEY, `|3|2|09|15.50|2|12345678901|${SIG}`, false], // 3.0 offline com chave normal
      [key9, `|3|1|09|15.50|2|12345678901|${SIG}`, false], // tpAmb de outro ambiente
    ];
    for (const [k, rest, expected] of cases) {
      const url = qr(`${k}${rest}`);
      expect(isValidQrCodeUrl(url, k, 'homologacao'), `servidor ${k.slice(34, 35)} ${rest}`).toBe(expected);
      expect(dev.isValidNfceQrCodeContent(url, k, 'homologacao'), `aparelho ${k.slice(34, 35)} ${rest}`).toBe(expected);
    }
  });

  it('P2-02: DV da chave: `...427` recusada e `...420` aceita, também com CNPJ alfanumérico, igual ao aparelho', async () => {
    const dev = await import('../../../src/lib/nfce.ts');
    expect(isValidAccessKey(KEY)).toBe(true);
    expect(isValidAccessKey(BAD_DV)).toBe(false);
    const alpha43 = `${KEY.slice(0, 6)}12ABC45678AB95${KEY.slice(20, 43)}`;
    const good = alpha43 + dev.accessKeyCheckDigit(alpha43);
    const bad = alpha43 + ((Number(dev.accessKeyCheckDigit(alpha43)) + 1) % 10);
    for (const k of [KEY, BAD_DV, good, bad]) expect(isValidAccessKey(k), k).toBe(dev.isValidAccessKey(k));
    expect(isValidAccessKey(good)).toBe(true);
    expect(isValidAccessKey(bad)).toBe(false);
  });

  it('P2-02: resposta autorizada da Focus com chave de DV errado não vira autorizada nem grava a chave; com DV certo autoriza, e o aparelho entende igual', async () => {
    const repoBad = new MemoryRepo(source());
    const bad = fakeFocus([{ status: 201, body: { ...AUTHORIZED, chave_nfe: `NFe${BAD_DV}`, qrcode_url: qr(`${BAD_DV}|2|2|1|ABCDEF0123456789ABCDEF0123456789ABCDEF01`) } }]);
    const r = await emitNfce(deps(repoBad, bad.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'processing', authorized: false, access_key: null, qrcode_url: null });
    expect(repoBad.doc).toMatchObject({ status: 'processing', access_key: null });
    // O aparelho interpreta o retorno do servidor do mesmo jeito (sem desacordo).
    expect(parseEmitResponse(r.httpStatus, JSON.stringify(r.body))).toMatchObject({ kind: 'document', status: 'processing', access_key: null });
    const repoOk = new MemoryRepo(source());
    const ok = fakeFocus([{ status: 201, body: AUTHORIZED }]);
    const r2 = await emitNfce(deps(repoOk, ok.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r2.body).toMatchObject({ status: 'authorized', authorized: true, access_key: KEY });
    expect(parseEmitResponse(r2.httpStatus, JSON.stringify(r2.body))).toMatchObject({ kind: 'document', status: 'authorized', access_key: KEY });
  });

  it('P2-03: Focus de homologação devolvendo QR de produção: o QR não é gravado e o documento autorizado não perde o estado', async () => {
    const repo = new MemoryRepo(source());
    const prodQr = qr(`${KEY}|2|1|1|ABCDEF0123456789ABCDEF0123456789ABCDEF01`);
    const first = fakeFocus([{ status: 201, body: { ...AUTHORIZED, qrcode_url: prodQr } }]);
    const r = await emitNfce(deps(repo, first.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'authorized', authorized: true, qrcode_url: null });
    expect(repo.doc?.qrcode_url).toBeNull();
    // Consulta posterior com o QR certo completa; um QR de produção depois não sobrescreve o bom.
    const second = fakeFocus([{ status: 200, body: AUTHORIZED }]);
    await emitNfce(deps(repo, second.focus), { tenantId: TENANT, orderId: ORDER });
    expect(repo.doc).toMatchObject({ status: 'authorized', qrcode_url: QR });
    const third = fakeFocus([{ status: 200, body: { ...AUTHORIZED, qrcode_url: prodQr } }]);
    const r3 = await emitNfce(deps(repo, third.focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r3.body).toMatchObject({ status: 'authorized', qrcode_url: QR });
  });
});


describe('Codex #63: endereço de contingência rejeitada não sobrevive ao reenvio', () => {
  it('claimRejected zera endereço e data; o endereço do XML novo é o que fica', async () => {
    const repo = new MemoryRepo(source());
    const cont = fakeFocus([{ status: 201, body: { ...AUTHORIZED, contingencia_offline: true, contingencia_offline_efetivada: false } }], authorizedXml());
    await emitNfce({ repo, environment: 'homologacao' as const, focus: cont.focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(repo.doc?.issuer_address).toMatchObject({ street: 'Rua das Flores' });
    // A Focus rejeita a nota em contingência; o cadastro é corrigido e a nota reenviada.
    repo.doc = { ...repo.doc!, status: 'rejected' };
    const fixed = authorizedXml(KEY, { ender: '<enderEmit><xLgr>Rua Nova</xLgr><nro>9</nro><xBairro>Centro</xBairro><xMun>Santo Angelo</xMun><UF>RS</UF><CEP>98800000</CEP></enderEmit>' });
    const resend = fakeFocus([{ status: 201, body: AUTHORIZED }], fixed);
    const r = await emitNfce({ repo, environment: 'homologacao' as const, focus: resend.focus, sha256Hex }, { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'authorized' });
    expect(r.body.issuer_address).toMatchObject({ street: 'Rua Nova' });
  });

  it('o repositório real zera authorized_at e issuer_address ao reservar o reenvio da rejeitada', async () => {
    let updated: Record<string, unknown> | null = null;
    const chain = { eq: () => chain, select: () => chain, maybeSingle: async () => ({ data: { id: 'd1' }, error: null }) };
    const db = { from: () => ({ update: (v: Record<string, unknown>) => { updated = v; return chain; } }) };
    await supabaseNfceRepository(db).claimRejected('d1', 1, 'h', {}, {});
    expect(updated).toMatchObject({ status: 'processing', transmissions: 2, authorized_at: null, issuer_address: null, access_key: null, protocol: null, qrcode_url: null });
  });
});

describe('P2-04 (auditoria do #63): QR legado inválido nunca deixa o documento "recuperado"', () => {
  const HTTP_QR = `http://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY}|2|2|1|ABCDEF0123456789ABCDEF0123456789ABCDEF01`;
  const legacyRepo = () => {
    const repo = new MemoryRepo(source());
    repo.doc = {
      id: 'd1', tenant_id: TENANT, order_id: ORDER, reference: 'tchefood', environment: 'homologacao', status: 'authorized', payload_hash: 'h', payload: {}, issuer: null,
      access_key: KEY, protocol: '143260000000001', number: 42, series: '1', qrcode_url: HTTP_QR, danfe_path: null, xml_path: XML_PATH, sefaz_status: '100', sefaz_message: null,
      offline_contingency: false, transmissions: 1, issued_at: null, authorized_at: '2026-11-09T06:00:07.000Z', issuer_address: { street: 'R', number: '1', complement: null, district: 'C', city: 'S', state: 'RS', zip: '98800000' },
    } as never;
    return repo;
  };
  const deps = (repo: MemoryRepo, focus: ReturnType<typeof fakeFocus>['focus']) => ({ repo, environment: 'homologacao' as const, focus, sha256Hex });

  it('documento autorizado com QR HTTP gravado: não é devolvido como completo, consulta a Focus e o QR válido o substitui', async () => {
    const repo = legacyRepo();
    const f = fakeFocus([{ status: 200, body: AUTHORIZED }]);
    const r = await emitNfce(deps(repo, f.focus), { tenantId: TENANT, orderId: ORDER });
    expect(f.calls).toHaveLength(1); // consultou, não devolveu "completo" pelo campo não vazio
    expect(r.body).toMatchObject({ status: 'authorized', qrcode_url: QR });
    expect(repo.doc?.qrcode_url).toBe(QR);
  });

  it('se a Focus não devolve QR válido, o QR legado inválido é descartado (nunca devolvido) e a nota segue autorizada', async () => {
    const repo = legacyRepo();
    const f = fakeFocus([{ status: 200, body: { ...AUTHORIZED, qrcode_url: null } }]);
    const r = await emitNfce(deps(repo, f.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'authorized', authorized: true, qrcode_url: null });
    expect(repo.doc).toMatchObject({ status: 'authorized', qrcode_url: null });
    // Sem token, o documento gravado é devolvido sem o QR inválido.
    const noToken = new MemoryRepo(source({ tenant: { ...source().tenant, focus_nfe_token: null } }));
    noToken.doc = { ...legacyRepo().doc! };
    const again = await emitNfce(deps(noToken, fakeFocus([]).focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(again.body.qrcode_url).toBeNull();
  });
});


describe('P0 (auditoria do #63, r14): resposta com chave inválida nunca autoriza com a chave de outra tentativa', () => {
  const BAD = `${KEY.slice(0, 43)}7`;
  const deps = (repo: MemoryRepo, focus: ReturnType<typeof fakeFocus>['focus']) => ({ repo, environment: 'homologacao' as const, focus, sha256Hex });

  it('rejeição (chave A) → claimRejected → reenvio autorizado com chave B de DV inválido: não vira authorized com a chave A; reconcilia depois com resposta válida', async () => {
    const repo = new MemoryRepo(source());
    const rejected = fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', chave_nfe: `NFe${KEY}`, mensagem_sefaz: 'Rejeicao' } }]);
    const r1 = await emitNfce(deps(repo, rejected.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r1.body).toMatchObject({ status: 'rejected', access_key: KEY });
    // Reenvio: a Focus devolve protocolo novo e chave nova com DV errado.
    const resend = fakeFocus([{ status: 201, body: { ...AUTHORIZED, chave_nfe: `NFe${BAD}`, protocolo: '143260000000099', qrcode_url: null } }]);
    const r2 = await emitNfce(deps(repo, resend.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r2.body).toMatchObject({ status: 'processing', authorized: false, access_key: null, protocol: null });
    expect(repo.doc).toMatchObject({ status: 'processing', access_key: null });
    expect(repo.doc?.access_key).not.toBe(KEY); // a chave da tentativa rejeitada não volta
    // O aparelho não vê nota autorizada nem chave (nada a espelhar em orders).
    expect(parseEmitResponse(r2.httpStatus, JSON.stringify(r2.body))).toMatchObject({ kind: 'document', status: 'processing', access_key: null });
    // Consulta posterior com resposta válida reconcilia.
    const ok = fakeFocus([{ status: 200, body: AUTHORIZED }]);
    const r3 = await emitNfce(deps(repo, ok.focus), { tenantId: TENANT, orderId: ORDER });
    expect(r3.body).toMatchObject({ status: 'authorized', authorized: true, access_key: KEY });
  });

  it('resposta sem chave, em reenvio de rejeitada, também não autoriza com a chave anterior', async () => {
    const repo = new MemoryRepo(source());
    await emitNfce(deps(repo, fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', chave_nfe: `NFe${KEY}` } }]).focus), { tenantId: TENANT, orderId: ORDER });
    const r = await emitNfce(deps(repo, fakeFocus([{ status: 201, body: { status: 'autorizado', protocolo: '143260000000099', numero: '42', serie: '1' } }]).focus), { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'processing', authorized: false, access_key: null });
  });

  it('mesmo que o repositório preserve a chave antiga no reenvio, a resposta com chave inválida não confirma a autorização', async () => {
    class KeepKeyRepo extends MemoryRepo {
      override async claimRejected(id: string, expected: number, hash: string, payload: unknown = {}, issuer: unknown = null) {
        const key = this.doc?.access_key ?? null;
        const claimed = await super.claimRejected(id, expected, hash, payload, issuer);
        if (claimed && this.doc) this.doc = { ...this.doc, access_key: key };
        return claimed && this.doc ? { ...this.doc } : null;
      }
    }
    const repo = new KeepKeyRepo(source());
    await emitNfce(deps(repo, fakeFocus([{ status: 422, body: { status: 'erro_autorizacao', chave_nfe: `NFe${KEY}` } }]).focus), { tenantId: TENANT, orderId: ORDER });
    expect(repo.doc?.access_key).toBe(KEY);
    const r = await emitNfce(deps(repo, fakeFocus([{ status: 201, body: { ...AUTHORIZED, chave_nfe: `NFe${BAD}`, protocolo: '143260000000099' } }]).focus), { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ status: 'processing', authorized: false, protocol: null });
    expect(repo.doc).toMatchObject({ status: 'processing' });
  });
});


describe('auditoria do #63 (r16): consulta de nota autorizada com chave inválida, XML de outra nota e reenvio', () => {
  /** Repositório que aplica a regra do trigger tchefood_nfce_guard: authorized não volta a processing. */
  class GuardedRepo extends MemoryRepo {
    override async saveProviderResult(id: string, expected: string, expectedTransmissions: number, fields: Partial<NfceDocumentRow>) {
      if (this.doc?.status === 'authorized' && fields.status === 'processing') throw new Error('trigger: authorized não volta a processing');
      return super.saveProviderResult(id, expected, expectedTransmissions, fields);
    }
  }
  const deps = (repo: MemoryRepo, focus: ReturnType<typeof fakeFocus>['focus']) => ({ repo, environment: 'homologacao' as const, focus, sha256Hex });
  const BAD = `${KEY.slice(0, 43)}7`;

  it('P2-02: consulta de nota JÁ autorizada (QR legado incompleto) com chave inválida mantém chave/protocolo/status e não tenta gravar (trigger do banco intacto)', async () => {
    const repo = new GuardedRepo(source());
    const first = fakeFocus([{ status: 201, body: { ...AUTHORIZED, qrcode_url: null } }], null);
    await emitNfce(deps(repo, first.focus), { tenantId: TENANT, orderId: ORDER });
    expect(repo.doc).toMatchObject({ status: 'authorized', access_key: KEY, protocol: '143260000000001', qrcode_url: null });
    const before = { ...repo.doc! };
    const bad = fakeFocus([{ status: 200, body: { ...AUTHORIZED, chave_nfe: `NFe${BAD}` } }]);
    const r = await emitNfce(deps(repo, bad.focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r.body).toMatchObject({ status: 'authorized', access_key: KEY, protocol: '143260000000001' });
    expect(String(r.body.message)).toMatch(/inconclusiva/i);
    expect(repo.doc).toEqual(before);
  });

  it('P2-02: o mesmo retorno inválido em nota ainda em processamento continua indo para processing (sem regressão)', async () => {
    const repo = new GuardedRepo(source());
    const proc = fakeFocus([{ status: 201, body: { status: 'processando_autorizacao' } }]);
    await emitNfce(deps(repo, proc.focus), { tenantId: TENANT, orderId: ORDER });
    const bad = fakeFocus([{ status: 200, body: { ...AUTHORIZED, chave_nfe: `NFe${BAD}` } }]);
    const r = await emitNfce(deps(repo, bad.focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r.body).toMatchObject({ status: 'processing', authorized: false });
    expect(repo.doc?.access_key).toBeNull();
  });

  it('A verificar: dhRecbto de protocolo de OUTRA nota (chNFe ou nProt diferentes) não vira authorized_at', () => {
    const ok = parseAuthorizedXml(authorizedXml(), KEY, '143260000000001');
    expect(ok.authorizedAt).toBe('2026-11-09T06:00:07.000Z');
    const otherKey = `${KEY.slice(0, 33)}99${KEY.slice(35)}`;
    expect(parseAuthorizedXml(authorizedXml(KEY, { protKey: otherKey }), KEY, '143260000000001').authorizedAt).toBeNull();
    expect(parseAuthorizedXml(authorizedXml(KEY, { nprot: '143260000000999' }), KEY, '143260000000001').authorizedAt).toBeNull();
    // Endereço (que não depende do protocolo) continua lido.
    expect(parseAuthorizedXml(authorizedXml(KEY, { protKey: otherKey }), KEY, '143260000000001').address).toMatchObject({ street: 'Rua das Flores' });
  });

  it('A verificar: reservar o reenvio da rejeitada zera também danfe_path e xml_path (repositório real e de teste)', async () => {
    let updated: Record<string, unknown> | null = null;
    const chain = { eq: () => chain, select: () => chain, maybeSingle: async () => ({ data: { id: 'd1' }, error: null }) };
    const db = { from: () => ({ update: (v: Record<string, unknown>) => { updated = v; return chain; } }) };
    await supabaseNfceRepository(db).claimRejected('d1', 1, 'h', {}, {});
    expect(updated).toMatchObject({ danfe_path: null, xml_path: null });
    const repo = new MemoryRepo(source());
    const cont = fakeFocus([{ status: 201, body: { ...AUTHORIZED, contingencia_offline: true, contingencia_offline_efetivada: false } }]);
    await emitNfce(deps(repo, cont.focus), { tenantId: TENANT, orderId: ORDER });
    expect(repo.doc?.danfe_path).toBeTruthy();
    repo.doc = { ...repo.doc!, status: 'rejected' };
    await repo.claimRejected('d1', repo.doc.transmissions, 'h2');
    expect(repo.doc).toMatchObject({ danfe_path: null, xml_path: null });
  });
});


describe('auditoria do #63 (r17): cancelamento com chave inválida e data de protocolo divergente', () => {
  class GuardedRepo extends MemoryRepo {
    override async saveProviderResult(id: string, expected: string, expectedTransmissions: number, fields: Partial<NfceDocumentRow>) {
      // Reproduz o gatilho: cancelamento só de nota com chave e protocolo; processing não vem de authorized.
      if (this.doc?.status === 'authorized' && fields.status === 'processing') throw new Error('trigger');
      return super.saveProviderResult(id, expected, expectedTransmissions, fields);
    }
  }
  const deps = (repo: MemoryRepo, focus: ReturnType<typeof fakeFocus>['focus']) => ({ repo, environment: 'homologacao' as const, focus, sha256Hex });
  const BAD = `${KEY.slice(0, 43)}7`;
  const INCOMPLETE = { ...AUTHORIZED, qrcode_url: null }; // autorizada sem QR: precisa de consulta de reconciliação
  const CANCELLED = { ...AUTHORIZED, status: 'cancelado' };

  it('P1-01: retorno cancelado com chave de DV inválido não cancela nota autorizada nem em processamento', async () => {
    const auth = new GuardedRepo(source());
    await emitNfce(deps(auth, fakeFocus([{ status: 201, body: INCOMPLETE }], null).focus), { tenantId: TENANT, orderId: ORDER });
    const before = { ...auth.doc! };
    const r = await emitNfce(deps(auth, fakeFocus([{ status: 200, body: { ...CANCELLED, chave_nfe: `NFe${BAD}` } }]).focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r.body).toMatchObject({ status: 'authorized', access_key: KEY });
    expect(String(r.body.message)).toMatch(/inconclusiva/i);
    expect(auth.doc).toEqual(before);
    const proc = new GuardedRepo(source());
    await emitNfce(deps(proc, fakeFocus([{ status: 201, body: { status: 'processando_autorizacao' } }]).focus), { tenantId: TENANT, orderId: ORDER });
    const r2 = await emitNfce(deps(proc, fakeFocus([{ status: 200, body: { ...CANCELLED, chave_nfe: `NFe${BAD}` } }]).focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
    expect(r2.body.status).toBe('processing');
    expect(proc.doc?.status).toBe('processing');
  });

  it('P1-01 (contraprova): cancelado com chave válida (ou sem chave) continua cancelando', async () => {
    for (const body of [CANCELLED, { ...CANCELLED, chave_nfe: undefined }]) {
      const repo = new GuardedRepo(source());
      await emitNfce(deps(repo, fakeFocus([{ status: 201, body: INCOMPLETE }], null).focus), { tenantId: TENANT, orderId: ORDER });
      await emitNfce(deps(repo, fakeFocus([{ status: 200, body }]).focus), { tenantId: TENANT, orderId: ORDER, consultOnly: true });
      expect(repo.doc?.status).toBe('cancelled');
    }
  });

  it('P2-02: protocolo principal A com número aninhado B e data de B: authorized_at fica nulo; com protocolos iguais a data é gravada', async () => {
    const nestedBody = (nested: string) => ({ ...AUTHORIZED, protocolo: '111', protocolo_nota_fiscal: { numero_protocolo: nested, data_recebimento: '2026-11-09T03:03:00-03:00' } });
    const xmlOther = authorizedXml(KEY, { nprot: '222', dh: '2026-11-09T03:03:00-03:00' }); // XML não confirma o protocolo 111
    const diverge = new MemoryRepo(source());
    const r = await emitNfce(deps(diverge, fakeFocus([{ status: 201, body: nestedBody('222') }], xmlOther).focus), { tenantId: TENANT, orderId: ORDER });
    expect(r.body).toMatchObject({ protocol: '111', authorized_at: null });
    expect(parseAuthorizedXml(xmlOther, KEY, '111').authorizedAt).toBeNull();
    const same = new MemoryRepo(source());
    const ok = await emitNfce(deps(same, fakeFocus([{ status: 201, body: nestedBody('111') }], authorizedXml(KEY, { nprot: '111', dh: '2026-11-09T03:03:00-03:00' })).focus), { tenantId: TENANT, orderId: ORDER });
    expect(ok.body).toMatchObject({ protocol: '111', authorized_at: '2026-11-09T06:03:00.000Z' });
  });
});
