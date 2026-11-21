import { beforeEach, describe, expect, it } from 'vitest';
import { inferCloudTenantId, useTcheStore, type CloudSession } from '../store/useTcheStore';
import { DEMO_TENANT_ID } from '../data/seed';
import { dueNfceCalls, dueNfceOrders, nextNfceRecord, nfceCall, nfceCallNow, parseDanfePayload, parseEmitResponse, requestNfceEmission, type NfceEmitOutcome } from '../lib/sync/nfceEmission';
import { syncOnce } from '../lib/sync/useCloudSync';
import { accessKeyCheckDigit, isValidAccessKey, isValidNfceQrCodeContent, serverNfceDocument } from '../lib/nfce';
import { danfeLines } from '../lib/receipts';
import type { FetchLike } from '../lib/sync/supabaseSync';
import { beginLocalClaim, resetClaimLedger } from '../lib/payments/claimLedger';

const st = () => useTcheStore.getState();
const KEY = '43261112345678000195650010000000421000000420';
const QR = `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY}|2|2|1|ABCDEF`;
const ISSUED = '2026-11-14T10:00:00-03:00';

const PAYLOAD = {
  items: [
    { numero_item: 1, codigo_produto: '311', descricao: 'X-SALADA TRANSMITIDO', unidade_comercial: 'UN', quantidade_comercial: 1, valor_unitario_comercial: 32, valor_bruto: 32 },
  ],
  valor_produtos: 32,
  valor_desconto: 0,
  valor_outras_despesas: 0,
  valor_total: 32,
  formas_pagamento: [{ forma_pagamento: '01', valor_pagamento: 32 }],
  cnpj_emitente: '12345678000195',
};
const ISSUER = { name: 'Flip', legal_name: 'FLIP LTDA', cnpj: '12345678000195', state_registration: '0960000000', city: 'Santo Angelo', state: 'RS' };

const ADDRESS = { street: 'Rua das Missoes', number: '123', complement: 'Sala 2', district: 'Centro', city: 'Santo Angelo', state: 'RS', zip: '98800000' };
const AUTHORIZED_AT = '2026-11-14T10:03:00-03:00';

const authorizedBody = (over: Record<string, unknown> = {}) => ({
  status: 'authorized',
  authorized: true,
  contingency: false,
  reference: 'tchefoodx',
  environment: 'homologacao',
  access_key: KEY,
  protocol: '143260000000042',
  number: 42,
  series: '1',
  qrcode_url: QR,
  danfe_path: '/notas_fiscais_consumidor/NFe43261112345678000195650010000000421000000420.html',
  issued_at: ISSUED,
  payload: PAYLOAD,
  issuer: ISSUER,
  issuer_address: ADDRESS,
  authorized_at: AUTHORIZED_AT,
  message: null,
  ...over,
});

const session = (tenantId: string): CloudSession => ({
  url: 'https://proj.supabase.co',
  anon_key: 'anon',
  email: 'loja@x',
  access_token: 'jwt',
  refresh_token: 'r',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  tenant_id: tenantId,
});

/** Abre a mesa 1, lança um item e paga tudo em dinheiro: a conta fecha. */
function closeOrder(): string {
  expect(st().login('1111').ok).toBe(true);
  const table = st().tables.find((t) => t.number === 1)!;
  const opened = st().openTable(table.id, 1, null);
  if (!opened.ok) throw new Error(opened.error);
  const id = opened.data.id;
  const p = st().products.find((x) => x.code === '311')!;
  const tray = st().addToTray({
    order_id: id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
    meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector,
  });
  if (!tray.ok) throw new Error(tray.error);
  expect(st().dispatchTray(id).ok).toBe(true);
  st().startCheckout(id);
  const order = st().orders.find((o) => o.id === id)!;
  // Loja na nuvem: o fluxo real pede a reserva ao servidor antes de receber (#49); aqui só o registro local dela.
  if (st().cloud) beginLocalClaim(`k-${id}`, id, null);
  const paid = st().registerPayment({
    orderId: id, amount: order.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
    acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `k-${id}`, item_ids: [],
  });
  if (!paid.ok) throw new Error(paid.error);
  expect(paid.data.closed).toBe(true);
  return id;
}

const order = (id: string) => st().orders.find((o) => o.id === id)!;
// HTTP que a emit-nfce devolve para cada situação (processamento 202, rejeitada 422, demais 200).
const HTTP_OF: Record<string, number> = { processing: 202, rejected: 422 };
const doc = (body: unknown): NfceEmitOutcome => parseEmitResponse(HTTP_OF[(body as { status?: string }).status ?? ''] ?? 200, JSON.stringify(body));

beforeEach(() => {
  resetClaimLedger();
  st().resetDemo();
});

describe('resposta da emit-nfce', () => {
  it('autorizada só com authorized=true, chave e protocolo', () => {
    expect(doc(authorizedBody())).toMatchObject({ kind: 'document', status: 'authorized', access_key: KEY, protocol: '143260000000042', qrcode_url: QR, issued_at: ISSUED });
    for (const over of [{ protocol: null }, { access_key: null }, { authorized: false }, { access_key: '123' }, { protocol: 'abc' }]) {
      const r = doc(authorizedBody(over));
      expect(r).toMatchObject({ kind: 'document', status: 'processing', protocol: null });
    }
  });

  it('QR Code de outra chave ou fora da SEFAZ e DANFE de outro host não passam', () => {
    const other = QR.replace(KEY, KEY.slice(0, 43) + '8');
    expect(doc(authorizedBody({ qrcode_url: other }))).toMatchObject({ qrcode_url: null });
    expect(doc(authorizedBody({ qrcode_url: 'https://evil.com/?p=' + KEY }))).toMatchObject({ qrcode_url: null });
    for (const danfe of ['//evil.com/x', 'https://evil.com/x', '/a/../b', 'x']) {
      expect(doc(authorizedBody({ danfe_path: danfe }))).toMatchObject({ danfe_path: null });
    }
  });

  it('erros sem documento não viram nota: inválida, não encontrada, conflito, 500, corpo estranho, rede', async () => {
    expect(parseEmitResponse(422, JSON.stringify({ status: 'invalid', authorized: false, message: 'Token Focus NFe do estabelecimento não configurado.' }))).toMatchObject({ kind: 'invalid' });
    expect(parseEmitResponse(404, JSON.stringify({ status: 'not_found', authorized: false }))).toMatchObject({ kind: 'not_found' });
    expect(parseEmitResponse(409, JSON.stringify({ status: 'conflict' }))).toMatchObject({ kind: 'conflict' });
    expect(parseEmitResponse(500, JSON.stringify({ status: 'error', message: 'Falha interna' }))).toMatchObject({ kind: 'error' });
    expect(parseEmitResponse(502, '<html>bad gateway</html>')).toMatchObject({ kind: 'error' });
    expect(parseEmitResponse(200, JSON.stringify({ status: 'authorized', authorized: true, environment: 'outro', access_key: KEY, protocol: '1' }))).toMatchObject({ kind: 'error' });
    const offline: FetchLike = async () => { throw new Error('offline'); };
    expect(await requestNfceEmission({ url: 'https://p', anonKey: 'a', accessToken: 't' }, 'o', offline)).toMatchObject({ kind: 'network' });
  });

  it('o pedido leva só o order_id e o modo, com o JWT do aparelho', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(authorizedBody()) };
    };
    await requestNfceEmission({ url: 'https://proj.supabase.co/', anonKey: 'anon', accessToken: 'jwt' }, 'ord-1', f);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://proj.supabase.co/functions/v1/emit-nfce');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer jwt');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ order_id: 'ord-1', mode: 'emit' });
    await requestNfceEmission({ url: 'https://proj.supabase.co/', anonKey: 'anon', accessToken: 'jwt' }, 'ord-1', f, 'consult');
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ order_id: 'ord-1', mode: 'consult' });
  });

  it('consultas de QR depois da autorização têm limite próprio (emissões anteriores não contam)', () => {
    let rec = nextNfceRecord('o1', undefined, doc(authorizedBody({ status: 'processing', authorized: false, protocol: null, qrcode_url: null })), 0);
    for (let i = 0; i < 12; i++) rec = nextNfceRecord('o1', rec, doc(authorizedBody({ status: 'processing', authorized: false, protocol: null, qrcode_url: null })), 0);
    expect(rec.attempts).toBe(13);
    rec = nextNfceRecord('o1', rec, doc(authorizedBody({ qrcode_url: null })), 0);
    expect(rec).toMatchObject({ status: 'authorized', print_attempts: 1 });
    expect(rec.next_attempt_at).toBe(new Date(10_000).toISOString());
    for (let i = 2; i < 8; i++) rec = nextNfceRecord('o1', rec, doc(authorizedBody({ qrcode_url: null })), 0);
    expect(rec.print_attempts).toBe(7);
    expect(rec.next_attempt_at).not.toBeNull();
    rec = nextNfceRecord('o1', rec, doc(authorizedBody({ qrcode_url: null })), 0);
    expect(rec.print_attempts).toBe(8);
    expect(rec.next_attempt_at).toBeNull();
  });

  it('consulta sem documento (none) não tenta de novo sozinha', () => {
    const none = parseEmitResponse(404, JSON.stringify({ status: 'none', authorized: false, message: 'Esta comanda não tem NFC-e no servidor.' }));
    expect(none).toMatchObject({ kind: 'none' });
    const rec = nextNfceRecord('o1', undefined, none, Date.now());
    expect(rec).toMatchObject({ status: null, problem: 'none', next_attempt_at: null });
  });
});

describe('registro local da NFC-e real', () => {
  it('retorno atrasado não regride autorizada; erro de rede não muda a situação', () => {
    const a = nextNfceRecord('o', undefined, doc(authorizedBody()), 0);
    expect(a).toMatchObject({ status: 'authorized', next_attempt_at: null });
    const stale = nextNfceRecord('o', a, doc(authorizedBody({ status: 'processing', authorized: false, protocol: null })), 1000);
    expect(stale).toMatchObject({ status: 'authorized', protocol: '143260000000042', next_attempt_at: null });
    const p = nextNfceRecord('o', undefined, doc(authorizedBody({ status: 'processing', authorized: false })), 0);
    const net = nextNfceRecord('o', p, { kind: 'network', httpStatus: 0, message: 'x' }, 0);
    expect(net).toMatchObject({ status: 'processing', problem: 'network' });
    expect(net.next_attempt_at).not.toBeNull();
  });

  it('rejeitada, inválida e conflito param a tentativa automática; processamento consulta com intervalo crescente', () => {
    expect(nextNfceRecord('o', undefined, doc(authorizedBody({ status: 'rejected', authorized: false })), 0).next_attempt_at).toBeNull();
    expect(nextNfceRecord('o', undefined, { kind: 'invalid', httpStatus: 422, message: 'x' }, 0).next_attempt_at).toBeNull();
    expect(nextNfceRecord('o', undefined, { kind: 'conflict', httpStatus: 409, message: 'x' }, 0).next_attempt_at).toBeNull();
    const p1 = nextNfceRecord('o', undefined, doc(authorizedBody({ status: 'processing', authorized: false })), 0);
    const p2 = nextNfceRecord('o', p1, doc(authorizedBody({ status: 'processing', authorized: false })), 0);
    expect(Date.parse(p1.next_attempt_at!)).toBe(10_000);
    expect(Date.parse(p2.next_attempt_at!)).toBe(20_000);
  });

  it('ambiente diferente do já gravado é ignorado', () => {
    const a = nextNfceRecord('o', undefined, doc(authorizedBody({ status: 'processing', authorized: false })), 0);
    const b = nextNfceRecord('o', a, doc(authorizedBody({ environment: 'producao' })), 0);
    expect(b.status).toBe('processing');
    expect(b.environment).toBe('homologacao');
  });
});

describe('fechamento da conta com a loja na nuvem', () => {
  it('demonstração (sem nuvem) continua com a nota simulada', () => {
    const id = closeOrder();
    expect(order(id).nfce_status).toBe('AUTORIZADA');
    expect(order(id).nfce_key).toHaveLength(44);
  });

  it('aparelho atualizado com sessão já salva (sem cloudTenantId): desconectar continua real', () => {
    const tenantId = st().tenant.id;
    useTcheStore.setState({ cloud: session(tenantId), cloudTenantId: null });
    expect(st().setCloudSession(null).ok).toBe(true);
    expect(st().cloudTenantId).toBe(tenantId);
    const id = closeOrder();
    expect(order(id)).toMatchObject({ nfce_status: 'PENDING', nfce_key: null });
  });

  it('loja da nuvem desconectada continua real: conta fecha pendente e é emitida ao reconectar', () => {
    const tenantId = st().tenant.id;
    expect(st().setCloudSession(session(tenantId)).ok).toBe(true);
    expect(st().setCloudSession(null).ok).toBe(true);
    expect(st().cloud).toBeNull();
    const seq = st().nfceSeq;
    const id = closeOrder();
    expect(order(id)).toMatchObject({ status: 'CLOSED', nfce_status: 'PENDING', nfce_key: null });
    expect(st().nfceSeq).toBe(seq);
    expect(st().requestNfceNow(id).ok).toBe(false); // sem sessão não pede
    expect(st().setCloudSession(session(tenantId)).ok).toBe(true);
    useTcheStore.setState({ outbox: [] });
    expect(dueNfceOrders(st(), Date.now())).toContain(id);
  });

  it('na nuvem a conta fecha com NFC-e pendente e sem chave; sai depois que a conta sobe', () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const seq = st().nfceSeq;
    const id = closeOrder();
    expect(order(id)).toMatchObject({ status: 'CLOSED', nfce_status: 'PENDING', nfce_key: null });
    expect(st().nfceSeq).toBe(seq);
    // Ainda há eventos da conta na fila: não pede.
    expect(dueNfceOrders(st(), Date.now())).not.toContain(id);
    expect(st().requestNfceNow(id).ok).toBe(false);
    // Recusado da conta também segura.
    const ev = st().outbox.find((e) => e.table === 'orders' && e.row_id === id)!;
    useTcheStore.setState({ outbox: [], syncRejected: [{ event: ev, status: 400, message: 'x', rejected_at: new Date().toISOString() }] as never });
    expect(dueNfceOrders(st(), Date.now())).not.toContain(id);
    useTcheStore.setState({ syncRejected: [] });
    expect(dueNfceOrders(st(), Date.now())).toContain(id);
  });

  it('autorizada espelha situação e chave na comanda; rejeitada só volta pelo botão', () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const id = closeOrder();
    useTcheStore.setState({ outbox: [] });
    expect(st().applyNfceOutcome(id, doc(authorizedBody({ status: 'rejected', authorized: false, access_key: null, message: 'NCM inválido' }))).ok).toBe(true);
    expect(order(id).nfce_status).toBe('REJEITADA');
    expect(dueNfceOrders(st(), Date.now() + 3_600_000)).not.toContain(id);
    expect(st().requestNfceNow(id).ok).toBe(true);
    expect(dueNfceOrders(st(), Date.now())).toContain(id);
    st().applyNfceOutcome(id, doc(authorizedBody()));
    expect(order(id)).toMatchObject({ nfce_status: 'AUTORIZADA', nfce_key: KEY });
    expect(st().nfceForced).not.toContain(id);
    expect(dueNfceOrders(st(), Date.now() + 3_600_000)).not.toContain(id);
    expect(st().requestNfceNow(id).ok).toBe(false);
  });

  it('sem nuvem a resposta não é aplicada', () => {
    const id = closeOrder();
    expect(st().applyNfceOutcome(id, doc(authorizedBody())).ok).toBe(false);
  });

  it('a sincronização pede a NFC-e da conta que já subiu e grava a resposta', async () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const id = closeOrder();
    useTcheStore.setState({ outbox: [], pullStatus: { last_pull_at: new Date().toISOString(), last_error: null, cloud_staff_unknown: 0 } });
    const urls: string[] = [];
    const f: FetchLike = async (url) => {
      // A rodada também lê os estornos de outros aparelhos (#49): aqui só conta a emit-nfce.
      if (!url.includes('/functions/v1/emit-nfce')) return { ok: true, status: 200, text: async () => '[]' };
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(authorizedBody()) };
    };
    await syncOnce(f);
    expect(urls).toEqual(['https://proj.supabase.co/functions/v1/emit-nfce']);
    expect(order(id)).toMatchObject({ nfce_status: 'AUTORIZADA', nfce_key: KEY });
    // Autorizada: nada mais a pedir.
    await syncOnce(f);
    expect(urls).toHaveLength(1);
  });
});

describe('DANFE da nota real', () => {
  const server = () => ({
    status: 'authorized' as const,
    access_key: KEY,
    protocol: '143260000000042',
    number: 42,
    series: '1',
    qrcode_url: QR,
    issued_at: ISSUED,
    payload: PAYLOAD,
    issuer: ISSUER,
    issuer_address: ADDRESS,
    authorized_at: AUTHORIZED_AT,
  });

  it('sai só do que o servidor devolveu (payload transmitido, chave, protocolo, QR)', () => {
    const d = serverNfceDocument(server())!;
    expect(d).toMatchObject({ access_key: KEY, protocol: '143260000000042', qr_url: QR, issued_at: ISSUED });
    expect(d.payload).toMatchObject({ numero: 42, serie: 1, valor_total: 32 });
    expect(d.payload.items[0]?.descricao).toBe('X-SALADA TRANSMITIDO');
    expect(serverNfceDocument({ ...server(), qrcode_url: null })).toBeNull();
    expect(serverNfceDocument({ ...server(), protocol: null })).toBeNull();
    expect(serverNfceDocument({ ...server(), issued_at: null })).toBeNull();
    expect(serverNfceDocument({ ...server(), payload: null })).toBeNull();
    // Número/série que contradizem a chave (nota 42, série 1): não imprime.
    expect(serverNfceDocument({ ...server(), number: 43 })).toBeNull();
    expect(serverNfceDocument({ ...server(), series: '2' })).toBeNull();
    expect(serverNfceDocument({ ...server(), number: null, series: null })!.payload).toMatchObject({ numero: 42, serie: 1 });
    // Emitente: sem o congelado, ou CNPJ diferente da chave, não imprime.
    expect(serverNfceDocument({ ...server(), issuer: null })).toBeNull();
    expect(serverNfceDocument({ ...server(), issuer: { ...ISSUER, cnpj: '48291736000155' } })).toBeNull();
    expect(serverNfceDocument({ ...server(), payload: { ...PAYLOAD, cnpj_emitente: '48291736000155' } })).toBeNull();
    expect(serverNfceDocument({ ...server(), status: 'processing' })).toBeNull();
    const cont = serverNfceDocument({ ...server(), status: 'contingency', protocol: null })!;
    expect(cont.protocol).toBe('');

    const hom = danfeLines({ tenant: st().tenant, doc: d, environment: 'homologacao', showTributos: false }).top.join('\n');
    expect(hom).toContain('SEM VALOR FISCAL');
    expect(hom).toContain('143260000000042');
    expect(hom).toContain('X-SALADA TRANSMITIDO');
    expect(hom).toContain('FLIP LTDA');
    expect(hom).not.toContain('IBPT');
    const prod = danfeLines({ tenant: st().tenant, doc: d, environment: 'producao', showTributos: false }).top.join('\n');
    expect(prod).not.toContain('HOMOLOGACAO');
    const c = danfeLines({ tenant: st().tenant, doc: cont, environment: 'homologacao', contingency: true, showTributos: false }).top.join('\n');
    expect(c).toContain('EMITIDA EM CONTINGENCIA');
    expect(c).not.toContain('Protocolo de Autorizacao');
  });

  it('P2-02 r5: data e hora do DANFE saem no fuso de Brasília, igual em qualquer fuso do aparelho', () => {
    const base = process.env.TZ;
    const cases: Array<[string, string]> = [
      ['2026-11-14T23:30:00-03:00', '14/11/2026'],
      ['2026-11-14T23:30:00-03:00', '23:30:00'],
      ['2026-11-15T02:30:00Z', '14/11/2026'],
    ];
    const outs: string[] = [];
    try {
      for (const tz of ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        const doc = serverNfceDocument({ ...server(), issued_at: '2026-11-14T23:30:00-03:00' })!;
        const text = danfeLines({ tenant: st().tenant, doc, environment: 'homologacao', showTributos: false }).top.join('\n');
        for (const [, expected] of cases.slice(0, 2)) expect(text).toContain(expected);
        const z = serverNfceDocument({ ...server(), issued_at: cases[2]![0] })!;
        outs.push(text, danfeLines({ tenant: st().tenant, doc: z, environment: 'homologacao', showTributos: false }).top.join('\n'));
      }
    } finally {
      if (base === undefined) delete process.env.TZ;
      else process.env.TZ = base;
    }
    // Mesmo texto nos três fusos.
    expect(new Set([outs[0], outs[2], outs[4]]).size).toBe(1);
    expect(new Set([outs[1], outs[3], outs[5]]).size).toBe(1);
    expect(outs[1]).toContain('14/11/2026');
  });

  it('P1-01 r3: cabeçalho do DANFE vem do emitente gravado no servidor, nunca do cadastro deste aparelho', async () => {
    // Aparelho B com cadastro desatualizado (mesmo CNPJ, outra razão social e IE).
    useTcheStore.setState({ cloud: session(st().tenant.id), tenant: { ...st().tenant, cnpj: '12.345.678/0001-95', legal_name: 'RAZAO DESATUALIZADA', state_registration: '999' } });
    const id = closeOrder();
    useTcheStore.setState({ outbox: [], pullStatus: { last_pull_at: new Date().toISOString(), last_error: null, cloud_staff_unknown: 0 } });
    const f: FetchLike = async (url) =>
      url.includes('/functions/v1/emit-nfce')
        ? { ok: true, status: 200, text: async () => JSON.stringify(authorizedBody()) }
        : { ok: true, status: 200, text: async () => '[]' };
    await syncOnce(f);
    const before = danfeLines({ tenant: st().tenant, doc: serverNfceDocument(st().nfceCloud[id]!)!, environment: 'homologacao', showTributos: false }).top.join('\n');
    expect(before).toContain('FLIP LTDA');
    expect(before).not.toContain('RAZAO DESATUALIZADA');
    expect(st().nfceCloud[id]!.issuer).toEqual(ISSUER);
    // Editar cardápio e cadastro depois; nova consulta (mesmo documento) e até um emitente diferente
    // numa resposta posterior não trocam o emitente da nota autorizada.
    useTcheStore.setState({ products: st().products.map((p) => ({ ...p, name: 'NOME NOVO', price: 999, ncm: '99999999' })) });
    useTcheStore.setState({ tenant: { ...st().tenant, name: 'LOJA NOVA', legal_name: 'RAZAO NOVA', state_registration: '111' } });
    st().applyNfceOutcome(id, doc(authorizedBody({ issuer: { ...ISSUER, legal_name: 'OUTRA' } })));
    const after = danfeLines({ tenant: st().tenant, doc: serverNfceDocument(st().nfceCloud[id]!)!, environment: 'homologacao', showTributos: false }).top.join('\n');
    expect(after).toBe(before);
    expect(after).not.toContain('NOME NOVO');
    expect(after).not.toContain('RAZAO NOVA');
  });

  it('P1-01 r3: sem emitente do servidor (documento antigo) ou emitente malformado, o DANFE não sai da bobina', async () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const id = closeOrder();
    useTcheStore.setState({ outbox: [] });
    st().applyNfceOutcome(id, doc(authorizedBody({ issuer: null })));
    expect(st().nfceCloud[id]!.issuer).toBeNull();
    expect(serverNfceDocument(st().nfceCloud[id]!)).toBeNull();
    // O cadastro local não preenche o que faltou; a nota segue consultável (só leitura).
    expect(dueNfceCalls(st(), Date.now() + 3_600_000)).toEqual([{ orderId: id, mode: 'consult' }]);
    expect((doc(authorizedBody({ issuer: { ...ISSUER, cnpj: '123' } })) as { issuer: unknown }).issuer).toBeNull();
    expect((doc(authorizedBody({ issuer: { ...ISSUER, state: 'Rio Grande' } })) as { issuer: unknown }).issuer).toBeNull();
    // Chega depois com o emitente: imprime.
    st().applyNfceOutcome(id, doc(authorizedBody()));
    expect(serverNfceDocument(st().nfceCloud[id]!)).not.toBeNull();
  });

  it('payload incoerente ou malformado é descartado', () => {
    const bad = (payload: unknown) => (doc(authorizedBody({ payload })) as { payload: unknown }).payload;
    expect(bad(PAYLOAD)).toEqual(PAYLOAD);
    expect(bad(null)).toBeNull();
    expect(bad({ ...PAYLOAD, valor_total: 31 })).toBeNull();
    expect(bad({ ...PAYLOAD, valor_produtos: 33 })).toBeNull();
    expect(bad({ ...PAYLOAD, formas_pagamento: [{ forma_pagamento: '01', valor_pagamento: 30 }] })).toBeNull();
    expect(bad({ ...PAYLOAD, items: [] })).toBeNull();
    expect(bad({ ...PAYLOAD, items: [{ ...PAYLOAD.items[0], numero_item: 0 }] })).toBeNull();
    expect(bad({ ...PAYLOAD, items: [{ ...PAYLOAD.items[0], valor_bruto: 32.001 }] })).toBeNull();
    expect(bad({ ...PAYLOAD, cpf_destinatario: '123' })).toBeNull();
    expect(bad({ ...PAYLOAD, cnpj_emitente: undefined })).toBeNull();
    expect(bad({ ...PAYLOAD, cpf_destinatario: '12345678909' })).toMatchObject({ cpf_destinatario: '12345678909' });
  });
});

describe('achados da auditoria (rodada 8b171a7)', () => {
  const settle = () => useTcheStore.setState({ outbox: [], pullStatus: { last_pull_at: new Date().toISOString(), last_error: null, cloud_staff_unknown: 0 } });

  it('autorizada sem QR Code volta a ser consultada (só leitura) e imprime quando o QR chega', async () => {
    useTcheStore.setState({ cloud: session(st().tenant.id), tenant: { ...st().tenant, cnpj: '12345678000195' } });
    const id = closeOrder();
    settle();
    const bodies = [authorizedBody({ qrcode_url: null }), authorizedBody()];
    const modes: string[] = [];
    const f: FetchLike = async (_url, init) => {
      modes.push(JSON.parse(init.body!).mode);
      return { ok: true, status: 200, text: async () => JSON.stringify(bodies.shift()) };
    };
    await syncOnce(f);
    const rec = st().nfceCloud[id]!;
    expect(rec).toMatchObject({ status: 'authorized', qrcode_url: null });
    expect(serverNfceDocument(rec)).toBeNull();
    expect(rec.next_attempt_at).not.toBeNull();
    expect(dueNfceCalls(st(), Date.parse(rec.next_attempt_at!) + 1)).toEqual([{ orderId: id, mode: 'consult' }]);
    // Botão: consulta já, sem nova emissão.
    expect(st().requestNfceNow(id).ok).toBe(true);
    await syncOnce(f);
    expect(modes).toEqual(['emit', 'consult']);
    expect(serverNfceDocument(st().nfceCloud[id]!)).not.toBeNull();
    expect(dueNfceCalls(st(), Date.now() + 3_600_000)).toEqual([]);
    expect(st().requestNfceNow(id).ok).toBe(false);
  });

  it('conta antiga com NFC-e simulada: consulta primeiro; sem nota no servidor, só o botão emite', async () => {
    // Fechada sem nuvem (chave simulada), depois a loja liga na nuvem.
    const id = closeOrder();
    expect(order(id)).toMatchObject({ nfce_status: 'AUTORIZADA' });
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    settle();
    expect(dueNfceCalls(st(), Date.now())).toEqual([{ orderId: id, mode: 'consult' }]);
    const modes: string[] = [];
    let reply: unknown = { status: 'none', authorized: false, message: 'Esta comanda não tem NFC-e no servidor. Nada foi transmitido.' };
    const f: FetchLike = async (_url, init) => {
      modes.push(JSON.parse(init.body!).mode);
      return { ok: reply === null, status: 404, text: async () => JSON.stringify(reply) };
    };
    await syncOnce(f);
    expect(st().nfceCloud[id]).toMatchObject({ problem: 'none', next_attempt_at: null });
    // Nada automático depois disso.
    expect(dueNfceCalls(st(), Date.now() + 3_600_000)).toEqual([]);
    await syncOnce(f);
    expect(modes).toEqual(['consult']);
    // O gerente pede a nota real: aí sim vai em modo emit.
    expect(st().requestNfceNow(id).ok).toBe(true);
    expect(dueNfceCalls(st(), Date.now())).toEqual([{ orderId: id, mode: 'emit' }]);
    reply = authorizedBody();
    const ok: FetchLike = async (_u, init) => {
      modes.push(JSON.parse(init.body!).mode);
      return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
    };
    await syncOnce(ok);
    expect(modes).toEqual(['consult', 'emit']);
    expect(order(id)).toMatchObject({ nfce_status: 'AUTORIZADA', nfce_key: KEY });
    expect(st().nfceCloud[id]!.status).toBe('authorized');
  });

  it('conta antiga já emitida de verdade (outro aparelho): a consulta só traz o documento', async () => {
    const id = closeOrder();
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    settle();
    const modes: string[] = [];
    const f: FetchLike = async (_url, init) => {
      modes.push(JSON.parse(init.body!).mode);
      return { ok: true, status: 200, text: async () => JSON.stringify(authorizedBody()) };
    };
    await syncOnce(f);
    expect(modes).toEqual(['consult']);
    expect(order(id)).toMatchObject({ nfce_key: KEY });
  });

  it('troca de loja durante a chamada: resultado atrasado não é gravado na outra loja e nada mais é pedido', async () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const a = closeOrder();
    settle();
    const tenantA = st().tenant.id;
    const urls: string[] = [];
    const f: FetchLike = async (url) => {
      urls.push(url);
      // Durante a chamada o aparelho vira outra loja (sessão B).
      useTcheStore.setState({ tenant: { ...st().tenant, id: 'tenant-b' }, cloud: { ...session('tenant-b'), access_token: 'jwt-b' } });
      return { ok: true, status: 200, text: async () => JSON.stringify(authorizedBody()) };
    };
    await syncOnce(f);
    expect(urls).toHaveLength(1);
    expect(st().nfceCloud[a]).toBeUndefined();
    expect(order(a).nfce_status).toBe('PENDING');
    expect(tenantA).not.toBe('tenant-b');
  });
});

describe('achados da auditoria (rodada 68cf69a)', () => {
  const ready = () => useTcheStore.setState({ outbox: [], syncRejected: [], pullStatus: { last_pull_at: new Date().toISOString(), last_error: null, cloud_staff_unknown: 0 } });
  const KEY2 = '43261112345678000195650010000000431000000435';
  const QR2 = `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY2}|2|2|1|ABCDEF`;

  it('P0-01: comanda que volta a ter evento na fila durante a chamada anterior não é pedida', async () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const a = closeOrder();
    const b = closeOrder();
    const events = st().outbox;
    ready();
    const asked: string[] = [];
    const f: FetchLike = async (url, init) => {
      if (!url.includes('/functions/v1/emit-nfce')) return { ok: true, status: 200, text: async () => '[]' };
      const id = (JSON.parse(String(init?.body)) as { order_id: string }).order_id;
      asked.push(id);
      // Enquanto a primeira chamada espera, a outra comanda ganha evento na fila (ex.: ajuste ainda não subiu).
      const other = id === a ? b : a;
      const ev = events.find((e) => e.table === 'orders' && e.row_id === other)!;
      useTcheStore.setState({ outbox: [ev] });
      return { ok: true, status: 202, text: async () => JSON.stringify(authorizedBody({ status: 'processing', authorized: false, protocol: null, qrcode_url: null, payload: null, issuer: null })) };
    };
    await syncOnce(f);
    expect(asked).toHaveLength(1);
    const skipped = asked[0] === a ? b : a;
    expect(st().nfceCloud[skipped]).toBeUndefined();
    expect(order(skipped).nfce_status).toBe('PENDING');
    // Reaberta (não está mais fechada) também não é pedida.
    useTcheStore.setState({ outbox: [], orders: st().orders.map((o) => (o.id === skipped ? { ...o, status: 'PAYING' as const } : o)) });
    expect(nfceCallNow(st(), skipped, Date.now())).toBeNull();
    // Inteira na nuvem e fechada de novo: volta a ser pedida.
    useTcheStore.setState({ orders: st().orders.map((o) => (o.id === skipped ? { ...o, status: 'CLOSED' as const } : o)) });
    expect(nfceCallNow(st(), skipped, Date.now())).toBe('emit');
  });

  it('P2-01: número ou série que não conferem com a chave bloqueiam a bobina e a nota segue consultável', () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const id = closeOrder();
    ready();
    st().applyNfceOutcome(id, doc(authorizedBody({ number: 43 })));
    const rec = st().nfceCloud[id]!;
    expect(rec.status).toBe('authorized');
    expect(serverNfceDocument(rec)).toBeNull();
    expect(rec.next_attempt_at).not.toBeNull();
    expect(dueNfceCalls(st(), Date.parse(rec.next_attempt_at!) + 1)).toEqual([{ orderId: id, mode: 'consult' }]);
    expect(st().requestNfceNow(id).ok).toBe(true);
    expect(dueNfceCalls(st(), Date.now())).toEqual([{ orderId: id, mode: 'consult' }]);
    // Série divergente também.
    st().applyNfceOutcome(id, doc(authorizedBody({ series: '2' })));
    expect(serverNfceDocument(st().nfceCloud[id]!)).toBeNull();
    // A consulta traz dados coerentes: imprime e para de consultar.
    st().applyNfceOutcome(id, doc(authorizedBody()));
    expect(serverNfceDocument(st().nfceCloud[id]!)).not.toBeNull();
    expect(st().nfceCloud[id]!.next_attempt_at).toBeNull();
    expect(st().requestNfceNow(id).ok).toBe(false);
  });

  it('P2-02: resposta regressiva (processamento) numa autorizada sem QR não encerra a busca do QR', () => {
    const start = nextNfceRecord('o1', undefined, doc(authorizedBody({ qrcode_url: null })), 0);
    expect(start.status).toBe('authorized');
    expect(start.next_attempt_at).not.toBeNull();
    const late = nextNfceRecord('o1', start, doc(authorizedBody({ status: 'processing', authorized: false, protocol: null })), 1000);
    expect(late.status).toBe('authorized');
    expect(late.protocol).toBe('143260000000042');
    expect(late.next_attempt_at).not.toBeNull();
    expect(late.print_attempts).toBe(2);
    // Respeita o limite de consultas.
    let r = late;
    for (let i = 0; i < 20; i++) r = nextNfceRecord('o1', r, doc(authorizedBody({ status: 'processing', authorized: false, protocol: null })), 2000 + i);
    expect(r.next_attempt_at).toBeNull();
    // Autorizada imprimível: a regressiva não agenda nada.
    const ok = nextNfceRecord('o1', undefined, doc(authorizedBody()), 0);
    expect(nextNfceRecord('o1', ok, doc(authorizedBody({ status: 'processing', authorized: false, protocol: null })), 1).next_attempt_at).toBeNull();
  });

  it('P2-03: chave nova não reaproveita payload, QR, protocolo nem emitente da nota anterior', () => {
    const k1 = nextNfceRecord('o1', undefined, doc(authorizedBody({ status: 'contingency', authorized: false, contingency: true, protocol: null })), 0);
    expect(k1.payload).not.toBeNull();
    expect(serverNfceDocument(k1)).not.toBeNull();
    const k2 = nextNfceRecord('o1', k1, doc(authorizedBody({ access_key: KEY2, qrcode_url: QR2, number: 43, payload: { ...PAYLOAD, valor_total: 99 }, issuer: null })), 1000);
    expect(k2.access_key).toBe(KEY2);
    expect(k2.payload).toBeNull();
    expect(k2.issuer).toBeNull();
    expect(serverNfceDocument(k2)).toBeNull();
    expect(k2.next_attempt_at).not.toBeNull();
    // Sem QR da chave nova, o QR da anterior também não fica.
    const k2b = nextNfceRecord('o1', k1, doc(authorizedBody({ access_key: KEY2, qrcode_url: null, number: 43 })), 1000);
    expect(k2b.qrcode_url).toBeNull();
    // Com o payload e o emitente da chave nova: imprime, com o número da chave nova.
    const k2c = nextNfceRecord('o1', k2, doc(authorizedBody({ access_key: KEY2, qrcode_url: QR2, number: 43 })), 2000);
    expect(serverNfceDocument(k2c)?.payload.numero).toBe(43);
  });

  it('P2-05: item com quantidade × unitário diferente do bruto é recusado; peso e arredondamento legítimos passam', () => {
    const one = (item: Record<string, unknown>) => {
      const bruto = item.valor_bruto as number;
      return parseDanfePayload({ ...PAYLOAD, items: [{ ...PAYLOAD.items[0], ...item }], valor_produtos: bruto, valor_total: bruto, formas_pagamento: [{ forma_pagamento: '01', valor_pagamento: bruto }] });
    };
    expect(one({ quantidade_comercial: 2, valor_unitario_comercial: 10, valor_bruto: 32 })).toBeNull();
    expect(one({ quantidade_comercial: 2, valor_unitario_comercial: 10, valor_bruto: 20 })).not.toBeNull();
    // 0,347 kg × R$ 59,90 = 20,7853 → R$ 20,79 (mesma conta da emit-nfce).
    expect(one({ quantidade_comercial: 0.347, valor_unitario_comercial: 59.9, valor_bruto: 20.79 })).not.toBeNull();
    expect(one({ quantidade_comercial: 0.347, valor_unitario_comercial: 59.9, valor_bruto: 20.78 })).toBeNull();
  });
});

describe('achados da auditoria (rodada 8c07a77, PR de correção do #55)', () => {
  const server = (over: Record<string, unknown> = {}) => ({
    status: 'authorized' as const, access_key: KEY, protocol: '143260000000042', number: 42, series: '1', qrcode_url: QR,
    issued_at: ISSUED, payload: PAYLOAD, issuer: ISSUER, issuer_address: ADDRESS, authorized_at: AUTHORIZED_AT, environment: 'homologacao' as const, ...over,
  });
  const printed = (d: NonNullable<ReturnType<typeof serverNfceDocument>>) => danfeLines({ tenant: st().tenant, doc: d, environment: 'homologacao', showTributos: false }).top.join('\n');

  it('P1-01: IE ausente em tenants não vira "ISENTO" na bobina; IE presente e isento declarado imprimem como são', () => {
    // IE nula (Focus pode ter a IE; o cadastro não): não imprime, fica o DANFE oficial da Focus.
    expect(serverNfceDocument(server({ issuer: { ...ISSUER, state_registration: null } }))).toBeNull();
    expect(missingPrintOf(server({ issuer: { ...ISSUER, state_registration: null } }))).toBe(true);
    const withIe = serverNfceDocument(server())!;
    expect(printed(withIe)).toContain('IE 0960000000');
    expect(printed(withIe)).not.toContain('ISENTO');
    // Emitente efetivamente isento: declarado como ISENTO no cadastro, imprime assim.
    const isento = serverNfceDocument(server({ issuer: { ...ISSUER, state_registration: 'ISENTO' } }))!;
    expect(printed(isento)).toContain('IE ISENTO');
  });

  it('P2-01: chave com dígito verificador errado é recusada; a válida passa', () => {
    const bad = '43261112345678000195650010000000421000000427';
    expect(isValidAccessKey(bad)).toBe(false);
    expect(isValidAccessKey(KEY)).toBe(true);
    const r = doc(authorizedBody({ access_key: bad, qrcode_url: `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${bad}|2|2|1|ABCDEF` })) as { status: string; access_key: string | null; qrcode_url: string | null };
    expect(r.access_key).toBeNull();
    expect(r.qrcode_url).toBeNull();
    expect(r.status).toBe('processing'); // "autorizada" sem chave válida não vale
    expect((doc(authorizedBody()) as { access_key: string | null }).access_key).toBe(KEY);
    // DV de chave com CNPJ alfanumérico (NT 2025.001): letra vale código ASCII - 48.
    const alpha43 = '4326111234567800019565001000000042100000042'.replace('12345678000195', '12ABC45678AB95');
    const dv = accessKeyCheckDigit(alpha43);
    expect(isValidAccessKey(alpha43 + dv)).toBe(true);
    expect(isValidAccessKey(alpha43 + ((Number(dv) + 1) % 10))).toBe(false);
  });

  it('P2-02: QR Code com tpAmb de outro ambiente é descartado', () => {
    const qrProd = `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY}|2|1|1|ABCDEF`;
    expect(doc(authorizedBody({ qrcode_url: qrProd }))).toMatchObject({ environment: 'homologacao', qrcode_url: null });
    expect(doc(authorizedBody({ environment: 'producao', qrcode_url: qrProd }))).toMatchObject({ environment: 'producao', qrcode_url: qrProd });
    expect(doc(authorizedBody({ environment: 'producao' }))).toMatchObject({ qrcode_url: null }); // QR de homologação em produção
    expect(doc(authorizedBody())).toMatchObject({ qrcode_url: QR });
    // QR 3.0 (chave|3|tpAmb): mesma regra.
    const q3 = (amb: string) => `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY}|3|${amb}`;
    expect(doc(authorizedBody({ qrcode_url: q3('1') }))).toMatchObject({ qrcode_url: null });
    expect(doc(authorizedBody({ qrcode_url: q3('2') }))).toMatchObject({ qrcode_url: q3('2') });
    // Na hora de imprimir também: QR de produção numa nota de homologação não imprime.
    expect(serverNfceDocument(server({ qrcode_url: qrProd }))).toBeNull();
  });

  it('P2-03: HTTP de erro com corpo "autorizada" não vira documento nem muda a situação fiscal', () => {
    for (const code of [500, 502, 503, 401, 404]) {
      const out = parseEmitResponse(code, JSON.stringify(authorizedBody()));
      expect(out.kind).toBe('error');
    }
    const prev = nextNfceRecord('o', undefined, doc(authorizedBody({ status: 'processing', authorized: false })), 0);
    const after = nextNfceRecord('o', prev, parseEmitResponse(503, JSON.stringify(authorizedBody())), 0);
    expect(after.status).toBe('processing');
    expect(after.protocol).toBeNull();
    // Os HTTP do contrato continuam valendo.
    expect(parseEmitResponse(200, JSON.stringify(authorizedBody())).kind).toBe('document');
    expect(parseEmitResponse(202, JSON.stringify(authorizedBody({ status: 'processing', authorized: false }))).kind).toBe('document');
    expect(parseEmitResponse(422, JSON.stringify(authorizedBody({ status: 'rejected', authorized: false }))).kind).toBe('document');
    expect(parseEmitResponse(200, JSON.stringify(authorizedBody({ status: 'rejected', authorized: false }))).kind).toBe('error');
  });

  it('P2-05: orientação de consulta no DANFE é a da UF da chave; fora do RS não imprime URL do RS', () => {
    const rs = serverNfceDocument(server())!;
    expect(printed(rs)).toMatch(/sefaz\.rs\.gov\.br\/nfce\/consul/);
    const sp = { ...rs, access_key: `35${KEY.slice(2)}` };
    const text = printed(sp);
    expect(text).not.toContain('rs.gov.br');
    expect(text).toContain('SEFAZ do estado');
  });
});

function missingPrintOf(rec: Parameters<typeof serverNfceDocument>[0]): boolean {
  return serverNfceDocument(rec) === null;
}


describe('achados da auditoria (2ª rodada em 8c07a77, PR de correção do #55)', () => {
  const server = (over: Record<string, unknown> = {}) => ({
    status: 'authorized' as const, access_key: KEY, protocol: '143260000000042', number: 42, series: '1', qrcode_url: QR,
    issued_at: ISSUED, payload: PAYLOAD, issuer: ISSUER, issuer_address: ADDRESS, authorized_at: AUTHORIZED_AT, environment: 'homologacao' as const, ...over,
  });
  const lines = (d: NonNullable<ReturnType<typeof serverNfceDocument>>, contingency = false) =>
    danfeLines({ tenant: st().tenant, doc: d, environment: 'homologacao', contingency, showTributos: false }).top;
  const REAL_TENANT = '99999999-9999-4999-8999-999999999999';

  it('P0-01: estado da versão anterior (cloud null, sem cloudTenantId, loja real) fecha pendente, sem chave simulada; só a demonstração simula', () => {
    // Estado persistido antes do cloudTenantId existir: desconectado, loja que a nuvem trouxe.
    useTcheStore.setState({ cloud: null, cloudTenantId: undefined as unknown as null, tenant: { ...st().tenant, id: REAL_TENANT } });
    expect(inferCloudTenantId(st())).toBe(REAL_TENANT);
    useTcheStore.setState({ cloudTenantId: inferCloudTenantId(st()) }); // o que a hidratação faz
    const seq = st().nfceSeq;
    const id = closeOrder();
    expect(order(id)).toMatchObject({ nfce_status: 'PENDING', nfce_key: null });
    expect(st().nfceSeq).toBe(seq);
    // Reconectar permite a emissão real.
    expect(st().setCloudSession(session(REAL_TENANT)).ok).toBe(true);
    useTcheStore.setState({ outbox: [] });
    expect(dueNfceOrders(st(), Date.now())).toContain(id);
  });

  it('P0-01: instalação genuinamente de demonstração continua simulando', () => {
    useTcheStore.setState({ cloud: null, cloudTenantId: undefined as unknown as null, tenant: { ...st().tenant, id: DEMO_TENANT_ID } });
    expect(inferCloudTenantId(st())).toBeNull();
    useTcheStore.setState({ cloudTenantId: null });
    const id = closeOrder();
    expect(order(id).nfce_status).toBe('AUTORIZADA');
    expect(order(id).nfce_key).toHaveLength(44);
  });

  it('P1-01: rejeitada vista em outro aparelho (sem registro local) só consulta; reenviar exige o botão', () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const id = closeOrder();
    useTcheStore.setState({
      outbox: [], nfceCloud: {}, nfceForced: [],
      orders: st().orders.map((o) => (o.id === id ? { ...o, nfce_status: 'REJEITADA' as const, nfce_key: null } : o)),
    });
    expect(nfceCallNow(st(), id, Date.now())).toBe('consult');
    expect(dueNfceCalls(st(), Date.now())).toEqual([{ orderId: id, mode: 'consult' }]);
    // Depois de conhecer o documento rejeitado, nada automático: o operador decide.
    const known = nextNfceRecord(id, undefined, doc(authorizedBody({ status: 'rejected', authorized: false, protocol: null, message: 'Rejeicao' })), Date.now());
    useTcheStore.setState({ nfceCloud: { [id]: known } });
    expect(dueNfceCalls(st(), Date.now() + 3_600_000)).toEqual([]);
    // Ação explícita (botão): aí sim emite.
    expect(st().requestNfceNow(id).ok).toBe(true);
    expect(nfceCallNow(st(), id, Date.now())).toBe('emit');
  });

  it('P1-02: DANFE da bobina traz o endereço completo do documento autorizado, não muda com o cadastro da loja e sem endereço não imprime', () => {
    const d = serverNfceDocument(server())!;
    const text = lines(d).join('\n');
    expect(text).toContain('Rua das Missoes');
    expect(text).toContain('123');
    expect(text).toContain('Sala 2');
    expect(text).toContain('Centro');
    expect(text).toContain('98800-000');
    expect(text).toContain('Santo Angelo');
    // Mudar o cadastro da loja depois da nota não muda a reimpressão.
    useTcheStore.setState({ tenant: { ...st().tenant, city: 'Outra Cidade', name: 'Outro Nome' } });
    expect(lines(d).join('\n')).toBe(text);
    // Sem endereço completo (ou malformado) a impressão própria fica indisponível.
    expect(serverNfceDocument(server({ issuer_address: null }))).toBeNull();
    expect(serverNfceDocument(server({ issuer_address: { ...ADDRESS, street: '' } }))).toBeNull();
    expect(serverNfceDocument(server({ issuer_address: { ...ADDRESS, zip: '9880' } }))).toBeNull();
    expect(serverNfceDocument(server({ issuer_address: undefined }))).toBeNull();
    // A resposta do servidor sem endereço mantém a nota consultável (para o servidor completar).
    const noAddr = nextNfceRecord('o', undefined, doc(authorizedBody({ issuer_address: null })), Date.now());
    expect(serverNfceDocument(noAddr)).toBeNull();
    expect(nfceCall({ ...st().orders[0]!, status: 'CLOSED', total_amount: 10, paid_amount: 10, nfce_status: 'AUTORIZADA' } as never, { ...noAddr, next_attempt_at: new Date(0).toISOString() }, new Set(), false, Date.now())).toBe('consult');
  });

  it('P1-03: emissão às 10h00 e autorização às 10h03 saem nos dois campos, em Brasília; sem authorized_at não inventa nem imprime', () => {
    const d = serverNfceDocument(server())!;
    const text = lines(d);
    const iEmi = text.findIndex((l) => l.includes('10:00'));
    const iAut = text.findIndex((l) => l.includes('10:03'));
    expect(iEmi).toBeGreaterThanOrEqual(0);
    expect(iAut).toBeGreaterThan(iEmi);
    expect(text.slice(iAut - 2, iAut + 1).join('\n')).toContain('Protocolo de Autorizacao');
    // UTC no servidor: mesma hora em Brasília.
    const utc = serverNfceDocument(server({ authorized_at: '2026-11-14T13:03:00Z' }))!;
    expect(lines(utc).join('\n')).toContain('10:03');
    // Ausente: a nota não imprime pela bobina (nunca reconstruída a partir da emissão).
    expect(serverNfceDocument(server({ authorized_at: null }))).toBeNull();
    expect(serverNfceDocument(server({ authorized_at: 'ontem' }))).toBeNull();
    const rec = nextNfceRecord('o', undefined, doc(authorizedBody({ authorized_at: null })), Date.now());
    expect(rec.authorized_at ?? null).toBeNull();
    expect(serverNfceDocument(rec)).toBeNull();
    // Contingência ainda sem autorização imprime sem data de autorização (não existe).
    const cont = serverNfceDocument(server({ status: 'contingency', protocol: null, authorized_at: null }))!;
    expect(lines(cont, true).join('\n')).not.toContain('Protocolo de Autorizacao');
  });

  it('P2-01: aviso de contingência aparece abaixo do cabeçalho e junto da identificação da nota (duas vezes), sem protocolo', () => {
    const cont = serverNfceDocument(server({ status: 'contingency', protocol: null, authorized_at: null }))!;
    const text = lines(cont, true);
    expect(text.filter((l) => l.includes('EMITIDA EM CONTINGENCIA'))).toHaveLength(2);
    expect(text.filter((l) => l.includes('Pendente de autorizacao'))).toHaveLength(2);
    const header = text.findIndex((l) => l.includes('DANFE NFC-e'));
    expect(text.findIndex((l) => l.includes('EMITIDA EM CONTINGENCIA'))).toBeLessThan(header);
    expect(text.join('\n')).not.toContain('Protocolo de Autorizacao');
    // Nota autorizada normal não tem o aviso.
    expect(lines(serverNfceDocument(server())!).join('\n')).not.toContain('CONTINGENCIA');
  });

  it('P2-02: rodapé não fixa tpIntegra 1 e valores saem como R$ 1.234,50 (milhar com ponto, centavos com vírgula)', () => {
    const big = { ...PAYLOAD, items: [{ ...PAYLOAD.items[0]!, valor_unitario_comercial: 1234.5, valor_bruto: 1234.5 }], valor_produtos: 1234.5, valor_total: 1234.5, formas_pagamento: [{ forma_pagamento: '01', valor_pagamento: 1234.5 }] };
    const d = serverNfceDocument(server({ payload: big }))!;
    const text = lines(d).join('\n');
    expect(text).toContain('1.234,50');
    expect(text).not.toMatch(/\d\.\d{2}(\s|$)/); // nenhum 1234.50 com ponto decimal
    expect(text.toLowerCase()).not.toContain('tpintegra');
  });

  it('P2-03: QR Code só em https e só no portal da SEFAZ da UF da chave (outro .gov.br, http, porta ou UF diferente não valem)', () => {
    const ok = (u: string, env: 'homologacao' | 'producao' = 'homologacao') => isValidNfceQrCodeContent(u, KEY, env);
    expect(ok(QR)).toBe(true);
    expect(ok(QR.replace('https:', 'http:'))).toBe(false);
    expect(ok(QR.replace('www.sefaz.rs.gov.br', 'evil.gov.br'))).toBe(false);
    expect(ok(QR.replace('www.sefaz.rs.gov.br', 'www.sefaz.rs.gov.br.evil.gov.br'))).toBe(false);
    expect(ok(QR.replace('www.sefaz.rs.gov.br', 'www.sefaz.rs.gov.br:8443'))).toBe(false);
    expect(ok(QR.replace('/NFCE/NFCE-COM.aspx', '/outra/pagina'))).toBe(false);
    // Chave de SP com o portal do RS (ou o contrário): recusado.
    const sp = `35${KEY.slice(2)}`;
    expect(isValidNfceQrCodeContent(QR.replace(KEY, sp), sp, 'homologacao')).toBe(false);
    // Na resposta e na impressão.
    expect(doc(authorizedBody({ qrcode_url: QR.replace('https:', 'http:') }))).toMatchObject({ qrcode_url: null });
    expect(serverNfceDocument(server({ qrcode_url: QR.replace('www.sefaz.rs.gov.br', 'evil.gov.br') }))).toBeNull();
  });

  it('Codex P2: registro autorizado salvo antes dos campos novos, sem consulta agendada, consulta sozinho uma vez e depois respeita o limite', () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const id = closeOrder();
    useTcheStore.setState({ outbox: [] });
    const old = nextNfceRecord(id, undefined, doc(authorizedBody({ issuer_address: undefined, authorized_at: undefined })), Date.now());
    // Como o aparelho antigo gravou: sem os campos novos, sem agendamento.
    const legacy = { ...old, issuer_address: null, authorized_at: null, next_attempt_at: null, print_attempts: 0, problem: null };
    expect(serverNfceDocument(legacy)).toBeNull();
    useTcheStore.setState({ nfceCloud: { [id]: legacy } });
    expect(nfceCallNow(st(), id, Date.now())).toBe('consult');
    // Consulta que falha (erro) não repete sozinha em laço.
    const failed = nextNfceRecord(id, legacy, { kind: 'error', httpStatus: 500, message: 'x' }, Date.now());
    useTcheStore.setState({ nfceCloud: { [id]: { ...failed, next_attempt_at: null } } });
    expect(nfceCallNow(st(), id, Date.now())).toBeNull();
    // Nota completa não consulta.
    const full = nextNfceRecord(id, undefined, doc(authorizedBody()), Date.now());
    useTcheStore.setState({ nfceCloud: { [id]: full } });
    expect(nfceCallNow(st(), id, Date.now())).toBeNull();
  });
});
