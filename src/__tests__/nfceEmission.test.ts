import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import { dueNfceOrders, nextNfceRecord, parseEmitResponse, requestNfceEmission, type NfceEmitOutcome } from '../lib/sync/nfceEmission';
import { syncOnce } from '../lib/sync/useCloudSync';
import { buildNfce, serverNfceDocument } from '../lib/nfce';
import { danfeLines } from '../lib/receipts';
import type { FetchLike } from '../lib/sync/supabaseSync';

const st = () => useTcheStore.getState();
const KEY = '43261112345678000195650010000000421000000427';
const QR = `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${KEY}|2|2|1|ABCDEF`;
const ISSUED = '2026-11-14T10:00:00-03:00';

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
  danfe_path: '/notas_fiscais_consumidor/NFe43261112345678000195650010000000421000000427.html',
  issued_at: ISSUED,
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
  const paid = st().registerPayment({
    orderId: id, amount: order.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
    acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `k-${id}`, item_ids: [],
  });
  if (!paid.ok) throw new Error(paid.error);
  expect(paid.data.closed).toBe(true);
  return id;
}

const order = (id: string) => st().orders.find((o) => o.id === id)!;
const doc = (body: unknown): NfceEmitOutcome => parseEmitResponse(200, JSON.stringify(body));

beforeEach(() => st().resetDemo());

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

  it('o pedido leva só o order_id, com o JWT do aparelho', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(authorizedBody()) };
    };
    await requestNfceEmission({ url: 'https://proj.supabase.co/', anonKey: 'anon', accessToken: 'jwt' }, 'ord-1', f);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://proj.supabase.co/functions/v1/emit-nfce');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer jwt');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ order_id: 'ord-1' });
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
  it('usa chave, protocolo, número, data e QR do servidor; sem QR válido não imprime', () => {
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    const id = closeOrder();
    const o = { ...order(id), nfce_key: KEY };
    const local = buildNfce({ tenant: st().tenant, order: o, items: st().orderItems, payments: st().payments, products: st().products, tableLabel: 'Mesa 1' })!;
    const server = { status: 'authorized' as const, access_key: KEY, protocol: '143260000000042', number: 42, series: '1', qrcode_url: QR, issued_at: ISSUED };
    const d = serverNfceDocument(local, server)!;
    expect(d).toMatchObject({ access_key: KEY, protocol: '143260000000042', qr_url: QR, issued_at: ISSUED });
    expect(d.payload.numero).toBe(42);
    expect(serverNfceDocument(local, { ...server, qrcode_url: null })).toBeNull();
    expect(serverNfceDocument(local, { ...server, protocol: null })).toBeNull();
    expect(serverNfceDocument(local, { ...server, issued_at: null })).toBeNull();
    expect(serverNfceDocument(local, { ...server, status: 'processing' })).toBeNull();
    const cont = serverNfceDocument(local, { ...server, status: 'contingency', protocol: null })!;
    expect(cont.protocol).toBe('');

    const hom = danfeLines({ tenant: st().tenant, doc: d, environment: 'homologacao', showTributos: false }).top.join('\n');
    expect(hom).toContain('SEM VALOR FISCAL');
    expect(hom).toContain('143260000000042');
    expect(hom).not.toContain('IBPT');
    const prod = danfeLines({ tenant: st().tenant, doc: d, environment: 'producao', showTributos: false }).top.join('\n');
    expect(prod).not.toContain('HOMOLOGACAO');
    const c = danfeLines({ tenant: st().tenant, doc: cont, environment: 'homologacao', contingency: true, showTributos: false }).top.join('\n');
    expect(c).toContain('EMITIDA EM CONTINGENCIA');
    expect(c).not.toContain('Protocolo de Autorizacao');
  });
});
