import { describe, expect, it } from 'vitest';
import { MercadoPagoPointDriver, POINT_CANCEL_WAIT_MS, POINT_HARD_LIMIT_MS, POINT_WAIT_MS, type PointDriverDeps } from '../lib/payments/mercadoPagoPointDriver';
import { createDriver, type ChargeRequest } from '../lib/payments/drivers';
import { holdAcquirer } from '../lib/payments/reviewHolds';
import { reconciliation } from '../lib/reports';
import type { Payment, PosTerminal } from '../types';

const TERMINAL: PosTerminal = {
  id: '33333333-3333-4333-8333-333333333333', tenant_id: 't', name: 'Point Smart', serial_number: 'NEWLAND_N950__N950NCB801293324',
  acquirer: 'MERCADO_PAGO', mode: 'TEF_POS_WIRELESS', online: true, battery_level: null,
};
const REQ: ChargeRequest = {
  request_id: 'req-1', idempotency_key: '55555555-5555-4555-8555-555555555555', amount: 24.5, method: 'CREDIT',
  table_label: 'Mesa 1', order_id: '22222222-2222-4222-8222-222222222222', description: '',
};
const CFG = { url: 'https://proj.supabase.co/', anonKey: 'anon', accessToken: 'jwt' };

const APPROVED = {
  status: 'APPROVED', idempotency_key: REQ.idempotency_key, nsu: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD',
  last_four: '4242', terminal_serial: TERMINAL.serial_number, amount_cents: 2450, method: 'CREDIT',
};

type Answer = { status: number; body: unknown } | 'network';

const STAFF = '44444444-4444-4444-8444-444444444444';

function harness(answer: (action: string, n: number) => Answer | 'hang', opts: { config?: PointDriverDeps['config']; operator?: string | null; timer?: PointDriverDeps['timer']; prepareOrder?: PointDriverDeps['prepareOrder'] } = {}) {
  let clock = 0;
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const counts: Record<string, number> = {};
  const deps: PointDriverDeps = {
    config: opts.config ?? (async () => CFG),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, headers: init.headers, body });
      const action = String(body.action);
      counts[action] = (counts[action] ?? 0) + 1;
      const a = answer(action, counts[action]!);
      if (a === 'hang') return new Promise(() => undefined);
      if (a === 'network') throw new Error('offline');
      return { status: a.status, text: async () => JSON.stringify(a.body) };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    // Por padrão o prazo de cada chamada nunca estoura (o teste de chamada pendurada troca).
    timer: opts.timer ?? (() => new Promise(() => undefined)),
    operator: async () => (opts.operator === undefined ? STAFF : opts.operator),
    prepareOrder: opts.prepareOrder ?? (async () => ({ ok: true, balance_cents: 2450 })),
  };
  return { driver: new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, deps), calls, counts };
}

const pending = { status: 200, body: { status: 'PENDING', idempotency_key: REQ.idempotency_key, detail: '' } };

describe('MercadoPagoPointDriver', () => {
  it('cria na função point-charge com a sessão da loja e devolve a aprovação com o comprovante do servidor', async () => {
    const { driver, calls } = harness((action, n) => (action === 'create' ? pending : n < 2 ? pending : { status: 200, body: APPROVED }));
    const r = await driver.charge(REQ);
    expect(r).toEqual({
      status: 'APPROVED', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191', card_brand: 'MASTERCARD', nsu: '123456789',
      authorization_code: 'A1B2C3', terminal_serial: TERMINAL.serial_number, terminal_id: TERMINAL.id, masked_pan: '************4242', mode: 'TEF_POS_WIRELESS',
    });
    expect(calls[0]).toEqual({
      url: 'https://proj.supabase.co/functions/v1/point-charge',
      headers: { apikey: 'anon', Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: { action: 'create', terminal_id: TERMINAL.id, idempotency_key: REQ.idempotency_key, order_id: REQ.order_id, amount_cents: 2450, method: 'CREDIT', staff_id: STAFF, expected_balance_cents: 2450 },
    });
    expect(calls.slice(1).every((c) => c.body.action === 'status' && c.body.idempotency_key === REQ.idempotency_key)).toBe(true);
  });

  it('Pix, sem maquininha ou sem nuvem: recusa sem chamar nada', async () => {
    const h = harness(() => pending);
    expect((await h.driver.charge({ ...REQ, method: 'PIX' })).status).toBe('DECLINED');
    expect(h.calls).toHaveLength(0);
    const none = new MercadoPagoPointDriver('TEF_POS_WIRELESS', null, { config: async () => CFG, fetch: async () => { throw new Error('x'); }, sleep: async () => undefined, now: () => 0, prepareOrder: async () => ({ ok: true, balance_cents: 2450 }) });
    expect((await none.charge(REQ)).status).toBe('DECLINED');
    const offline = harness(() => pending, { config: async () => null });
    const r = await offline.driver.charge(REQ);
    expect(r.status === 'DECLINED' && r.reason).toContain('nuvem');
    expect(offline.calls).toHaveLength(0);
  });

  it('servidor recusa a criação (4xx) antes da maquininha: recusa com a mensagem do servidor', async () => {
    const { driver, counts } = harness(() => ({ status: 412, body: { error: 'not_configured', message: 'Mercado Pago sem Access Token nesta loja.' } }));
    const r = await driver.charge(REQ);
    expect(r).toMatchObject({ status: 'DECLINED', reason: 'Mercado Pago sem Access Token nesta loja.' });
    expect(counts.status).toBeUndefined();
  });

  const notFound = { status: 404, body: { error: 'not_found', message: 'Cobrança não encontrada nesta loja.' } };
  const voided = { status: 200, body: { status: 'DECLINED', idempotency_key: REQ.idempotency_key, reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' } };

  it('queda na criação repete com a mesma chave; 404 na consulta só vira recusa quando o encerramento no servidor bloqueia a chave', async () => {
    const { driver, calls } = harness((action) => (action === 'create' ? 'network' : action === 'cancel' ? voided : notFound));
    const r = await driver.charge(REQ);
    expect(r).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
    const creates = calls.filter((c) => c.body.action === 'create');
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((c) => c.body.idempotency_key))).toEqual(new Set([REQ.idempotency_key]));
    expect(calls.find((c) => c.body.action === 'cancel')!.body).toEqual({
      action: 'cancel', terminal_id: TERMINAL.id, idempotency_key: REQ.idempotency_key, order_id: REQ.order_id, amount_cents: 2450, method: 'CREDIT', reason: 'timeout', staff_id: STAFF,
    });
  });

  it('auditoria r1 P0-01: criação a caminho, consulta 404 e a criação chega depois: não recusa, acompanha a cobrança que ficou', async () => {
    // A primeira criação "cai" (resposta perdida) mas chega ao servidor depois; 404 nas primeiras consultas.
    const { driver } = harness((action, n) => {
      if (action === 'create') return 'network';
      if (action === 'status') return n < 2 ? notFound : n < 4 ? pending : { status: 200, body: APPROVED };
      return pending; // encerramento: a cobrança já existe e está na maquininha
    });
    expect((await driver.charge(REQ)).status).toBe('APPROVED');
  });

  it('auditoria r1 P0-01: depois de criação incerta, 404 sem encerramento confirmado nunca vira recusa', async () => {
    const { driver } = harness((action) => (action === 'create' ? 'network' : action === 'cancel' ? 'network' : notFound));
    expect(await driver.charge(REQ)).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT' });
  });

  it('auditoria r1 P0-01: recusa 4xx depois de criação incerta não vira recusa', async () => {
    const { driver, counts } = harness((action, n) => {
      if (action === 'create') return n === 1 ? 'network' : { status: 409, body: { error: 'order_not_found', message: 'a conta ainda não está no servidor' } };
      return action === 'cancel' ? pending : n < 3 ? pending : { status: 200, body: APPROVED };
    });
    expect((await driver.charge(REQ)).status).toBe('APPROVED');
    expect(counts.create).toBe(2);
  });

  it('auditoria r2 P2-02: sem operador identificado não cobra (nada vai ao servidor)', async () => {
    const { driver, calls } = harness(() => pending, { operator: null });
    expect(await driver.charge(REQ)).toMatchObject({ status: 'DECLINED', reason: 'Entre com o seu PIN para cobrar na Point Smart.' });
    expect(calls).toHaveLength(0);
  });

  it('auditoria r2 P2-01: sincronização antes de cobrar que nunca termina estoura o prazo e não cobra', async () => {
    let clock = 0;
    const calls: string[] = [];
    const driver = new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, {
      config: async () => CFG,
      fetch: async (url) => { calls.push(url); return { status: 200, text: async () => JSON.stringify(pending.body) }; },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      timer: () => new Promise((r) => setTimeout(r, 0)),
      operator: async () => STAFF,
      prepareOrder: () => new Promise(() => undefined),
    });
    expect(await driver.charge(REQ)).toMatchObject({ status: 'DECLINED', reason: 'Não consegui sincronizar a conta com a nuvem. Nada foi cobrado; tente de novo.' });
    expect(calls).toHaveLength(0);
    const failing = new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, {
      config: async () => CFG,
      fetch: async (url) => { calls.push(url); return { status: 200, text: async () => '{}' }; },
      sleep: async () => undefined,
      now: () => 0,
      operator: async () => STAFF,
      prepareOrder: async () => { throw new Error('offline'); },
    });
    expect((await failing.charge(REQ)).status).toBe('DECLINED');
    expect(calls).toHaveLength(0);
  });

  it('auditoria r1 P2-02: chamada que nunca responde estoura o prazo e o fluxo termina em revisão manual', async () => {
    const { driver, counts } = harness(() => 'hang', { timer: () => new Promise((r) => setTimeout(r, 0)) });
    expect(await driver.charge(REQ)).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT' });
    expect(counts.create).toBe(3);
    expect(counts.cancel).toBeGreaterThanOrEqual(1);
  });

  it('auditoria r1 P2-04: corpo null, [], número ou ilegível não lança e não vira recusa', async () => {
    for (const text of ['null', '[]', '42', '{', '"x"']) {
      let clock = 0;
      const driver = new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, {
        config: async () => CFG,
        fetch: async () => ({ status: 200, text: async () => text }),
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        operator: async () => STAFF,
        prepareOrder: async () => ({ ok: true, balance_cents: 2450 }),
      });
      expect((await driver.charge(REQ)).status).toBe('MANUAL_REVIEW');
    }
    let clock = 0;
    const err = new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, {
      config: async () => CFG,
      fetch: async () => ({ status: 400, text: async () => 'null' }),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      operator: async () => STAFF,
      prepareOrder: async () => ({ ok: true, balance_cents: 2450 }),
    });
    // 400 com corpo que não é da função (sem "error"): pode ter vindo de um intermediário, não prova nada.
    expect(await err.charge(REQ)).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT' });
  });

  it.each([
    [408, { error: 'timeout', message: 'gateway timeout' }],
    [425, { error: 'too_early', message: 'too early' }],
    [429, { error: 'rate_limited', message: 'calma' }],
    [400, '<html><body>Bad Request</body></html>'],
    [400, { message: 'sem o campo error' }],
    [403, { error: 42, message: 'error não é texto' }],
    [404, 'not found'],
  ] as const)('auditoria r3, terceira revisão: criação respondida com %s que não prova nada não vira recusa; quem decide é o encerramento no servidor', async (status, body) => {
    const odd = { status, body };
    // Só a criação recebe a resposta estranha; a cobrança existe e é aprovada depois.
    const paid = harness((action, n) => (action === 'create' ? odd : n < 2 ? pending : { status: 200, body: APPROVED }));
    expect((await paid.driver.charge(REQ)).status).toBe('APPROVED');
    expect(paid.counts.create).toBe(3); // tratada como resultado desconhecido: repete com a mesma chave
    expect(new Set(paid.calls.filter((c) => c.body.action === 'create').map((c) => c.body.idempotency_key))).toEqual(new Set([REQ.idempotency_key]));
    // Tudo responde assim: nunca "nada foi cobrado"; passa pelo encerramento no servidor e termina em revisão manual.
    const all = harness(() => odd);
    const r = await all.driver.charge(REQ);
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT' });
    expect(all.counts.cancel).toBeGreaterThan(0);
  });

  it('auditoria r3, terceira revisão: recusa de verdade da função ({error, message}) na primeira criação segue sendo recusa', async () => {
    const { driver, counts } = harness(() => ({ status: 409, body: { error: 'over_balance', message: 'passa do saldo' } }));
    expect(await driver.charge(REQ)).toMatchObject({ status: 'DECLINED', reason: 'passa do saldo' });
    expect(counts).toEqual({ create: 1 });
  });

  it('auditoria r3, terceira revisão: consulta respondida com 404 que não é da função não dispara o bloqueio nem recusa', async () => {
    const { driver, counts } = harness((action, n) => (action === 'create' ? pending : action === 'status' ? (n < 3 ? { status: 404, body: 'not found' } : { status: 200, body: APPROVED }) : pending));
    expect((await driver.charge(REQ)).status).toBe('APPROVED');
    expect(counts.cancel).toBeUndefined();
  });

  it('erro 500 ou rede na consulta nunca vira recusa', async () => {
    const { driver } = harness((action) => (action === 'create' ? pending : action === 'cancel' ? 'network' : { status: 500, body: { error: 'internal' } }));
    const r = await driver.charge(REQ);
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT' });
  });

  it('sem cartão no prazo: cancela e só recusa quando o servidor confirma', async () => {
    const declined = { status: 200, body: { status: 'DECLINED', idempotency_key: REQ.idempotency_key, reason: 'Cobrança cancelada na maquininha (nada foi cobrado).' } };
    const { driver, counts } = harness((action) => (action === 'cancel' ? declined : pending));
    const r = await driver.charge(REQ);
    expect(r).toMatchObject({ status: 'DECLINED', reason: 'Cobrança cancelada na maquininha (nada foi cobrado).' });
    expect(counts.cancel).toBe(1);
    expect(counts.status).toBeGreaterThanOrEqual(POINT_WAIT_MS / 2_000 - 2);
  });

  it('cancelamento sem confirmação vira revisão manual depois do prazo', async () => {
    const { driver, counts } = harness(() => pending);
    const r = await driver.charge(REQ);
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT', acquirer: 'MERCADO_PAGO' });
    // Repete o encerramento a cada volta (o servidor pode recusar por "cedo demais" e aceitar depois).
    expect(counts.cancel).toBeGreaterThanOrEqual(POINT_CANCEL_WAIT_MS / 2_000 - 1);
    expect(counts.status).toBeGreaterThanOrEqual((POINT_WAIT_MS + POINT_CANCEL_WAIT_MS) / 2_000 - 2);
  });

  it('auditoria r2 P1-01: encerrar antes do prazo leva o PIN do gerente e o motivo ao servidor', async () => {
    const h = harness((action) => (action === 'cancel' ? { status: 200, body: { status: 'DECLINED', reason: 'cancelada' } } : pending));
    const p = h.driver.charge(REQ);
    h.driver.abort(REQ.request_id, { manager_pin: '9999', reason: 'cliente desistiu' });
    expect((await p).status).toBe('DECLINED');
    expect(h.counts.cancel).toBe(1);
    expect(h.calls.find((c) => c.body.action === 'cancel')!.body).toMatchObject({ reason: 'operator', staff_id: STAFF, manager_pin: '9999', reason_text: 'cliente desistiu' });
  });

  it('auditoria r2 P1-01: sem autorização do gerente o encerramento antecipado não acontece (segue até o prazo)', async () => {
    const h = harness((action) => (action === 'cancel' ? { status: 200, body: { status: 'DECLINED', reason: 'cancelada' } } : pending));
    const p = h.driver.charge(REQ);
    h.driver.abort(REQ.request_id);
    await p;
    const cancel = h.calls.find((c) => c.body.action === 'cancel')!;
    expect(cancel.body.reason).toBe('timeout');
    expect(h.counts.status).toBeGreaterThanOrEqual(POINT_WAIT_MS / 2_000 - 2);
  });

  it('auditoria r2 P1-01: PIN recusado (403) desfaz o pedido e a cobrança segue até o prazo', async () => {
    const h = harness((action, n) => (action === 'cancel' ? (n === 1 ? { status: 403, body: { error: 'manager_denied', message: 'PIN errado' } } : { status: 200, body: { status: 'DECLINED', reason: 'cancelada' } }) : pending));
    const p = h.driver.charge(REQ);
    h.driver.abort(REQ.request_id, { manager_pin: '0000', reason: 'cliente desistiu' });
    expect((await p).status).toBe('DECLINED');
    const cancels = h.calls.filter((c) => c.body.action === 'cancel').map((c) => c.body.reason);
    expect(cancels).toEqual(['operator', 'timeout']);
    expect(h.counts.status).toBeGreaterThanOrEqual(POINT_WAIT_MS / 2_000 - 2);
  });

  it('auditoria r3 P2-02: o prazo do cartão conta do primeiro envio, não da sincronização', async () => {
    let clock = 0;
    const cancelAt: number[] = [];
    let createAt = -1;
    const driver = new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, {
      config: async () => CFG,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body.action === 'create' && createAt < 0) createAt = clock;
        if (body.action === 'cancel') {
          cancelAt.push(clock);
          return { status: 200, text: async () => JSON.stringify({ status: 'DECLINED', idempotency_key: REQ.idempotency_key, reason: 'cancelada' }) };
        }
        return { status: 200, text: async () => JSON.stringify(pending.body) };
      },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      timer: () => new Promise(() => undefined),
      operator: async () => STAFF,
      prepareOrder: async () => { clock += 14_000; return { ok: true, balance_cents: 2450 }; }, // sincronização lenta, dentro do prazo dela
    });
    expect((await driver.charge(REQ)).status).toBe('DECLINED');
    expect(createAt).toBe(14_000);
    // A Point teve os 2 minutos inteiros desde o envio (antes: o pedido saía aos 120 s do início, 106 s de espera).
    expect(cancelAt[0]! - createAt).toBeGreaterThanOrEqual(POINT_WAIT_MS);
    expect(cancelAt[0]! - createAt).toBeLessThan(POINT_WAIT_MS + 2 * 2_000);
  });

  it('auditoria r3 P1-01: pedido do operador sem cobrança gravada (404): na mesma volta pede o bloqueio preventivo com o operador', async () => {
    const h = harness((action, n) => {
      if (action === 'create') return 'network';
      if (action === 'status') return { status: 404, body: { error: 'not_found', message: 'não encontrada' } };
      return n === 1 ? { status: 404, body: { error: 'not_found', message: 'não gravada' } } : { status: 200, body: { status: 'DECLINED', idempotency_key: REQ.idempotency_key, reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' } };
    });
    const p = h.driver.charge(REQ);
    h.driver.abort(REQ.request_id, { manager_pin: '9999', reason: 'cliente desistiu' });
    expect((await p).status).toBe('DECLINED');
    const cancels = h.calls.filter((c) => c.body.action === 'cancel').map((c) => c.body);
    expect(cancels.map((c) => c.reason)).toEqual(['operator', 'timeout']);
    expect(cancels[1]).toMatchObject({ staff_id: STAFF });
    expect(cancels[1]).not.toHaveProperty('manager_pin');
  });

  it('encerramento por prazo cedo demais no servidor (409) segue consultando e tenta de novo', async () => {
    const { driver, counts } = harness((action, n) => (action === 'cancel' ? (n < 3 ? { status: 409, body: { error: 'too_early', message: 'cedo' } } : { status: 200, body: { status: 'DECLINED', reason: 'cancelada' } }) : pending));
    expect((await driver.charge(REQ)).status).toBe('DECLINED');
    expect(counts.cancel).toBe(3);
  });

  it('auditoria r3, segunda revisão: PIN certo com cobrança ainda não gravada (404) não perde o pedido do gerente', async () => {
    // 1º encerramento (gerente): 404, não gravada. Bloqueio na mesma volta: 409, a criação gravou no meio.
    // Volta seguinte: a autorização do gerente vai de novo e agora encerra.
    const answers: Answer[] = [
      { status: 404, body: { error: 'not_found', message: 'não gravada' } },
      { status: 409, body: { error: 'too_early', message: 'cedo' } },
      { status: 200, body: { status: 'DECLINED', idempotency_key: REQ.idempotency_key, reason: 'Cobrança cancelada na maquininha (nada foi cobrado).' } },
    ];
    const h = harness((action, n) => (action === 'create' ? 'network' : action === 'status' ? pending : answers[n - 1]!));
    const p = h.driver.charge(REQ);
    h.driver.abort(REQ.request_id, { manager_pin: '9999', reason: 'cliente desistiu' });
    expect((await p).status).toBe('DECLINED');
    const cancels = h.calls.filter((c) => c.body.action === 'cancel').map((c) => c.body);
    expect(cancels.map((c) => c.reason)).toEqual(['operator', 'timeout', 'operator']);
    expect(cancels[2]).toMatchObject({ manager_pin: '9999', reason_text: 'cliente desistiu', staff_id: STAFF });
  });

  it('auditoria r3, segunda revisão: servidor ainda no prazo dele ("cedo demais") por mais de 30 s não vira revisão manual', async () => {
    // A cobrança foi gravada no servidor 40 s depois do primeiro envio do app: o prazo dele vence 40 s depois.
    const early = Math.ceil(40_000 / 2_000);
    const { driver, counts } = harness((action, n) => (action === 'cancel'
      ? (n <= early ? { status: 409, body: { error: 'too_early', message: 'cedo' } } : { status: 200, body: { status: 'DECLINED', reason: 'cancelada' } })
      : pending));
    const r = await driver.charge(REQ);
    expect(r.status).toBe('DECLINED');
    expect(counts.cancel).toBe(early + 1);
  });

  it('auditoria r3, segunda revisão: "cedo demais" sem fim para no limite duro, em revisão manual (nunca recusa)', async () => {
    const h = harness((action) => (action === 'cancel' ? { status: 409, body: { error: 'too_early', message: 'cedo' } } : pending));
    const r = await h.driver.charge(REQ);
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT' });
    // Limite: POINT_HARD_LIMIT_MS desde o primeiro envio, uma volta de consulta a cada 2 s.
    expect(h.counts.cancel).toBeGreaterThan((POINT_HARD_LIMIT_MS - POINT_WAIT_MS) / 2_000 - 2);
    expect(h.counts.cancel).toBeLessThan((POINT_HARD_LIMIT_MS - POINT_WAIT_MS) / 2_000 + 3);
  });

  it('cancelar depois de pago devolve a aprovação', async () => {
    const { driver } = harness((action) => (action === 'cancel' ? { status: 200, body: APPROVED } : pending));
    expect((await driver.charge(REQ)).status).toBe('APPROVED');
  });

  it.each([
    [{ amount_cents: 2400 }, 'APPROVED_MISMATCH'],
    [{ method: 'DEBIT' }, 'APPROVED_MISMATCH'],
    [{ terminal_serial: 'OUTRA' }, 'TERMINAL_MISMATCH'],
  ])('aprovação que não confere com o pedido (%o) vira revisão manual', async (over, code) => {
    const { driver } = harness((action) => (action === 'create' ? { status: 200, body: { ...APPROVED, ...over } } : pending));
    expect(await driver.charge(REQ)).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: code });
  });

  it('resposta APPROVED incompleta ou ilegível não aprova (segue consultando até o prazo)', async () => {
    for (const bad of [{ ...APPROVED, nsu: undefined }, { ...APPROVED, card_brand: 'AMEX' }, { ...APPROVED, authorization_code: 7 }, 'texto']) {
      const { driver } = harness(() => ({ status: 200, body: bad }));
      expect((await driver.charge(REQ)).status).toBe('MANUAL_REVIEW');
    }
  });

  it('revisão manual do servidor chega com o código', async () => {
    const { driver } = harness((action) => (action === 'create' ? pending : { status: 200, body: { status: 'MANUAL_REVIEW', reason: 'confira', code: 'PAID_AMOUNT_MISMATCH' } }));
    expect(await driver.charge(REQ)).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'PAID_AMOUNT_MISMATCH', reason: 'confira' });
  });
});

describe('Mercado Pago no resto do app', () => {
  it('createDriver usa o driver da Point para maquininha MERCADO_PAGO', () => {
    expect(createDriver({ terminal: TERMINAL, chassis: 'STONE', mode: 'TEF_POS_WIRELESS' })).toBeInstanceOf(MercadoPagoPointDriver);
  });

  it('trava de revisão guarda Mercado Pago pelo nome; o resto como antes', () => {
    expect(['MERCADO_PAGO', 'PAGBANK', 'STONE', 'MOCK', 'CASH_DESK'].map(holdAcquirer)).toEqual(['MERCADO_PAGO', 'PAGBANK', 'STONE', 'STONE', 'STONE']);
  });

  it('conciliação: Mercado Pago tem linha própria só quando houve venda na Point', () => {
    const base = { id: 'p', order_id: 'o', tenant_id: 't', waiter_id: 'w', terminal_id: null, tip_amount: 0, status: 'APPROVED', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: null, created_at: '2026-11-12T15:00:00.000Z' };
    const period = { start: new Date('2026-11-12T09:00:00.000Z'), end: new Date('2026-11-13T09:00:00.000Z') };
    const stone = { ...base, amount: 10, method: 'CREDIT', acquirer: 'STONE' } as unknown as Payment;
    expect(reconciliation([stone], period).map((r) => r.acquirer)).toEqual(['STONE', 'PAGBANK', 'CASH_DESK']);
    const mp = { ...base, amount: 24.5, method: 'DEBIT', acquirer: 'MERCADO_PAGO' } as unknown as Payment;
    const rows = reconciliation([stone, mp], period);
    expect(rows.map((r) => r.acquirer)).toEqual(['STONE', 'PAGBANK', 'MERCADO_PAGO', 'CASH_DESK']);
    expect(rows[2]).toMatchObject({ total: 24.5, count: 1, cnpj: '10573521000191' });
    expect(rows[3]!.total).toBe(0);
  });
});

describe('MercadoPagoPointDriver: auditoria r4', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it('P1-01: a preparação da conta sem prova (pendente, recusada, resposta estranha) não cobra', async () => {
    const answers: unknown[] = [
      { ok: false, reason: 'Ainda há alterações desta conta esperando a nuvem. Nada foi cobrado; tente de novo.' },
      undefined, null, {}, { ok: true }, { ok: 'true', balance_cents: 2450 }, { ok: true, balance_cents: -1 }, { ok: true, balance_cents: 24.5 }, { ok: true, balance_cents: '2450' },
    ];
    for (const answer of answers) {
      const h = harness(() => pending, { prepareOrder: async () => answer as never });
      const r = await h.driver.charge(REQ);
      expect(r.status, JSON.stringify(answer)).toBe('DECLINED');
      expect(h.calls, JSON.stringify(answer)).toHaveLength(0);
    }
    const h = harness(() => pending, { prepareOrder: async () => answers[0] as never });
    expect(await h.driver.charge(REQ)).toMatchObject({ reason: 'Ainda há alterações desta conta esperando a nuvem. Nada foi cobrado; tente de novo.' });
  });

  it('P1-01: prepara a conta desta cobrança e manda o saldo dela para o servidor conferir', async () => {
    const asked: string[] = [];
    const h = harness((action) => (action === 'create' ? pending : { status: 200, body: APPROVED }), {
      prepareOrder: async (orderId) => { asked.push(orderId); return { ok: true, balance_cents: 9000 }; },
    });
    expect((await h.driver.charge(REQ)).status).toBe('APPROVED');
    expect(asked).toEqual([REQ.order_id]);
    expect(h.calls[0]!.body).toMatchObject({ action: 'create', expected_balance_cents: 9000, amount_cents: 2450 });
  });

  it('P1-01: saldo diferente no servidor (409 balance_mismatch) recusa sem nada cobrado', async () => {
    const h = harness(() => ({ status: 409, body: { error: 'balance_mismatch', message: 'O saldo desta conta na nuvem é outro. Nada foi cobrado.' } }));
    expect(await h.driver.charge(REQ)).toMatchObject({ status: 'DECLINED', reason: 'O saldo desta conta na nuvem é outro. Nada foi cobrado.' });
    expect(h.counts.create).toBe(1);
    expect(h.counts.status ?? 0).toBe(0);
  });

  it('P1-02: a consulta avisa que nenhum envio saiu (awaiting_send): o driver repete o create com a mesma chave', async () => {
    const awaiting = { status: 200, body: { status: 'PENDING', idempotency_key: REQ.idempotency_key, detail: '', awaiting_send: true } };
    const h = harness((action, n) => (action === 'create' ? pending : n === 1 ? awaiting : { status: 200, body: APPROVED }));
    expect((await h.driver.charge(REQ)).status).toBe('APPROVED');
    const creates = h.calls.filter((c) => c.body.action === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.body).toEqual(creates[0]!.body);
  });

  it('P1-02: sem awaiting_send a consulta nunca vira create', async () => {
    const h = harness((action, n) => (action === 'create' ? pending : n < 5 ? pending : { status: 200, body: APPROVED }));
    expect((await h.driver.charge(REQ)).status).toBe('APPROVED');
    expect(h.counts.create).toBe(1);
  });

  it('P2-01: sessão que nunca chega (renovação do token pendurada) antes de cobrar: recusa no prazo, sem chamar nada', async () => {
    const h = harness(() => pending, { config: () => new Promise(() => undefined), timer: () => tick() });
    const r = await h.driver.charge(REQ);
    expect(r).toMatchObject({ status: 'DECLINED' });
    expect(h.calls).toHaveLength(0);
  });

  it('P2-01: sessão que deixa de chegar na hora da criação, sem envio anterior: recusa local (nada saiu)', async () => {
    let n = 0;
    const h = harness(() => pending, {
      config: () => { n += 1; return n === 1 ? Promise.resolve(CFG) : new Promise(() => undefined); },
      timer: () => tick(),
    });
    expect(await h.driver.charge(REQ)).toMatchObject({ status: 'DECLINED', reason: 'Não consegui falar com a nuvem. Nada foi cobrado; tente de novo.' });
    expect(h.calls).toHaveLength(0);
  });

  it('P2-01: sessão pendurada depois de uma criação incerta: termina no prazo em revisão manual, nunca recusa nem lança', async () => {
    let n = 0;
    const h = harness((action) => (action === 'create' ? 'network' : pending), {
      // 1ª: início da cobrança; 2ª: a criação (sai e cai na rede); daí em diante a renovação pendura.
      config: () => { n += 1; return n <= 2 ? Promise.resolve(CFG) : new Promise(() => undefined); },
      timer: () => tick(),
    });
    const r = await h.driver.charge(REQ);
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'POINT_TIMEOUT' });
    expect(h.counts.create).toBe(1);
  });
});
