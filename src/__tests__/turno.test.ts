import { afterEach, describe, expect, it } from 'vitest';
import {
  currentShiftPeriod,
  formatShiftStart,
  inShiftPeriod,
  nextShiftStart,
  parseIsoInstant,
  reconciliation,
  shiftKpis,
  shiftStartBrasilia,
  waiterSplit,
  type ShiftPeriod,
} from '../lib/reports';
import { shiftPeriodAt, watchReportClock, type ShiftClockDeps } from '../lib/useShiftStart';
import type { Order, OrderItem, Payment, StaffUser } from '../types';

// Instantes absolutos. Brasília = UTC-3 (sem horário de verão desde 2019).
const BRT = (iso: string) => new Date(`${iso}-03:00`);

const pay = (amount: number, created_at: string | null) =>
  ({ amount, status: 'APPROVED', acquirer: 'STONE', method: 'CREDIT', created_at }) as unknown as Payment;
const staff = [{ id: 'w1', name: 'Tião' }] as StaffUser[];
const ord = (id: string, closed_at: string | null, fee = 10) =>
  ({ id, status: 'CLOSED', closed_at, service_fee_amount: fee }) as unknown as Order;
const item = (order_id: string, price = 100) =>
  ({ order_id, waiter_id: 'w1', status: 'DELIVERED', total_item_price: price, quantity: 1 }) as OrderItem;

const now = BRT('2026-11-09T23:00:00');
const period = currentShiftPeriod(shiftStartBrasilia(now), now);
const ontem = BRT('2026-11-08T22:00:00').toISOString();
const hoje = BRT('2026-11-09T21:00:00').toISOString();

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe('Conciliação e rateio só do turno (desde 05:00)', () => {
  it('conciliação ignora pagamentos aprovados de turnos anteriores', () => {
    const [stone] = reconciliation([pay(300, ontem), pay(110, hoje)], period);
    expect(stone!.total).toBe(110);
    expect(stone!.count).toBe(1);
    expect(stone!.byMethod.CREDIT).toBe(110);
  });

  it('rateio dos 10% considera só contas fechadas no turno', () => {
    const rows = waiterSplit([ord('o1', ontem), ord('o2', hoje)], [item('o1'), item('o2')], staff, period);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commission).toBe(10);
    expect(rows[0]!.sales).toBe(100);
    expect(rows[0]!.itemsSold).toBe(1);
  });
});

describe('P2-01: data inválida, vazia ou null não entra', () => {
  const ruins = ['data-invalida', '', null];

  it.each(ruins)('conciliação ignora created_at = %j', (bad) => {
    const [stone] = reconciliation([pay(150, bad), pay(110, hoje)], period);
    expect(stone!.total).toBe(110);
    expect(stone!.count).toBe(1);
  });

  it.each(ruins)('rateio ignora closed_at = %j', (bad) => {
    const rows = waiterSplit([ord('o1', bad), ord('o2', hoje)], [item('o1'), item('o2')], staff, period);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commission).toBe(10);
    expect(rows[0]!.sales).toBe(100);
    expect(rows[0]!.itemsSold).toBe(1);
  });

  it('inShiftPeriod recusa NaN em vez de deixar passar', () => {
    expect(inShiftPeriod('data-invalida', period)).toBe(false);
    expect(inShiftPeriod('', period)).toBe(false);
    expect(inShiftPeriod(null, period)).toBe(false);
    expect(inShiftPeriod(undefined, period)).toBe(false);
    expect(inShiftPeriod(hoje, period)).toBe(true);
  });
});

describe('P2-02: corte das 05:00 em America/Sao_Paulo, qualquer que seja o fuso do aparelho', () => {
  const zonas = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'America/Los_Angeles'];
  const casos: Array<[string, string]> = [
    ['2026-11-11T04:59:00', '2026-11-10T08:00:00.000Z'],
    ['2026-11-11T05:00:00', '2026-11-11T08:00:00.000Z'],
    ['2026-11-11T05:01:00', '2026-11-11T08:00:00.000Z'],
    ['2026-12-01T04:30:00', '2026-11-30T08:00:00.000Z'],
    ['2027-01-01T03:00:00', '2026-12-31T08:00:00.000Z'],
  ];

  it('o fuso do processo realmente muda entre as rodadas', () => {
    process.env.TZ = 'UTC';
    const utc = new Date(0).getTimezoneOffset();
    process.env.TZ = 'America/Sao_Paulo';
    expect(new Date(0).getTimezoneOffset()).not.toBe(utc);
  });

  for (const tz of zonas) {
    it(`TZ=${tz}: 04:59, 05:00 e 05:01 de Brasília`, () => {
      process.env.TZ = tz;
      for (const [brt, esperado] of casos) {
        expect(shiftStartBrasilia(BRT(brt)).toISOString()).toBe(esperado);
      }
      expect(formatShiftStart(shiftStartBrasilia(BRT('2026-11-11T06:30:00')))).toBe(
        formatShiftStart(new Date('2026-11-11T08:00:00Z')),
      );
      expect(formatShiftStart(new Date('2026-11-11T08:00:00Z'))).toContain('05:00');
    });
  }

  it.each(['UTC', 'America/Sao_Paulo'])('TZ=%s: 09/11 05:01 BRT → início 08:00Z e legenda "09/11, 05:00"', (tz) => {
    process.env.TZ = tz;
    const start = shiftStartBrasilia(new Date('2026-11-09T08:01:00.000Z'));
    expect(start.toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(formatShiftStart(start)).toBe('09/11, 05:00');
  });

  it('cenário do GPT: 06:30 BRT em aparelho UTC não conta pagamento das 03:15 BRT', () => {
    const agora = BRT('2026-11-11T06:30:00');
    const pagamentos = [pay(90, BRT('2026-11-11T03:15:00').toISOString()), pay(40, BRT('2026-11-11T06:00:00').toISOString())];
    const resultados = zonas.map((tz) => {
      process.env.TZ = tz;
      return reconciliation(pagamentos, currentShiftPeriod(shiftStartBrasilia(agora), agora));
    });
    for (const r of resultados) {
      expect(r[0]!.total).toBe(40);
      expect(r[0]!.count).toBe(1);
    }
    expect(new Set(resultados.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});

describe('P2-03: período [início, fim) — 05:00 exato entra, antes e futuro não', () => {
  const agora = BRT('2026-11-11T10:00:00');
  const atual = currentShiftPeriod(shiftStartBrasilia(agora), agora);
  const exato = BRT('2026-11-11T05:00:00').toISOString();
  const antes = new Date(BRT('2026-11-11T05:00:00').getTime() - 1).toISOString();
  const proximoTurno = BRT('2026-11-12T06:00:00').toISOString();
  const futuroMesmoTurno = BRT('2026-11-11T10:05:00').toISOString();

  it('conciliação', () => {
    const [stone] = reconciliation(
      [pay(1, exato), pay(10, antes), pay(100, proximoTurno), pay(1000, futuroMesmoTurno)],
      atual,
    );
    expect(stone!.total).toBe(1);
    expect(stone!.count).toBe(1);
  });

  it('rateio', () => {
    const orders = [ord('a', exato, 1), ord('b', antes, 10), ord('c', proximoTurno, 100), ord('d', futuroMesmoTurno, 1000)];
    const items = [item('a', 10), item('b', 100), item('c', 1000), item('d', 10000)];
    const rows = waiterSplit(orders, items, staff, atual);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commission).toBe(1);
    expect(rows[0]!.sales).toBe(10);
  });

  it('o fim do turno corrente nunca passa do início do turno seguinte', () => {
    const start = shiftStartBrasilia(agora);
    const muitoDepois = BRT('2026-11-13T12:00:00');
    expect(currentShiftPeriod(start, muitoDepois).end.toISOString()).toBe(nextShiftStart(start).toISOString());
    expect(nextShiftStart(start).toISOString()).toBe('2026-11-12T08:00:00.000Z');
  });

  it('cenário do GPT: turno de 09/11 05:00 não soma o pagamento de 10/11 06:00', () => {
    const start = new Date('2026-11-09T08:00:00Z');
    const p = currentShiftPeriod(start, BRT('2026-11-10T07:00:00'));
    expect(p.end.toISOString()).toBe('2026-11-10T08:00:00.000Z');
    const [stone] = reconciliation([pay(110, BRT('2026-11-09T21:00:00').toISOString()), pay(300, BRT('2026-11-10T06:00:00').toISOString())], p);
    expect(stone!.total).toBe(110);
    expect(inShiftPeriod(BRT('2026-11-09T04:59:59').toISOString(), p)).toBe(false);
    expect(inShiftPeriod(BRT('2026-11-09T05:00:00').toISOString(), p)).toBe(true);
    expect(inShiftPeriod(BRT('2026-11-10T04:59:59').toISOString(), p)).toBe(true);
  });

  it('período histórico explícito', () => {
    const ontemTurno: ShiftPeriod = { start: new Date('2026-11-10T08:00:00Z'), end: new Date('2026-11-11T08:00:00Z') };
    const [stone] = reconciliation([pay(10, antes), pay(1, exato)], ontemTurno);
    expect(stone!.total).toBe(10);
  });
});

describe('P1-01 / rodada 3 P2-02: relógio dos relatórios sem mudar os arrays', () => {
  /** Relógio e timers controlados à mão. */
  function fakeClock(startIso: Date) {
    let t = startIso.getTime();
    let timer: { fn: () => void; at: number } | null = null;
    const win = new EventTarget();
    const doc = new EventTarget();
    const deps: ShiftClockDeps = {
      now: () => new Date(t),
      setTimer: (fn, ms) => {
        timer = { fn, at: t + ms };
        return timer;
      },
      clearTimer: (h) => {
        if (timer === h) timer = null;
      },
      windowTarget: win,
      documentTarget: doc,
    };
    return {
      deps,
      win,
      doc,
      /** Avança o relógio disparando os timers que vencerem no caminho. */
      advance(ms: number) {
        const until = t + ms;
        while (timer && timer.at <= until) {
          const due = timer;
          timer = null;
          t = due.at;
          due.fn();
        }
        t = until;
      },
      /** Avança o relógio sem disparar timer (aparelho dormindo). */
      jump(ms: number) {
        t += ms;
      },
      get pendingAt() {
        return (timer as { at: number } | null)?.at ?? null;
      },
    };
  }

  // Três visualizações, com os mesmos arrays do começo ao fim.
  const orders = [ord('o1', BRT('2026-11-11T02:00:00').toISOString(), 80)];
  const items = [item('o1', 800)];
  const payments = [pay(880, BRT('2026-11-11T02:00:00').toISOString())];
  const telas = (agora: Date) => {
    const p = shiftPeriodAt(agora);
    const recon = reconciliation(payments, p);
    return {
      dashboardTotal: recon.reduce((a, r) => a + r.total, 0),
      conciliacaoTransacoes: recon.reduce((a, r) => a + r.count, 0),
      rateioComissao: waiterSplit(orders, items, staff, p).reduce((a, r) => a + r.commission, 0),
      legenda: formatShiftStart(p.start),
    };
  };

  it('virada das 04:59 para as 05:01: o tick do minuto troca o turno', () => {
    const clock = fakeClock(BRT('2026-11-11T04:59:00'));
    let agora = clock.deps.now();
    const stop = watchReportClock((d) => { agora = d; }, clock.deps);

    const antes = telas(agora);
    expect(antes.rateioComissao).toBe(80);
    expect(antes.dashboardTotal).toBe(880);
    expect(antes.conciliacaoTransacoes).toBe(1);
    expect(antes.legenda).toContain('10/11');
    // O próximo disparo é logo depois das 05:00.
    expect(clock.pendingAt! - BRT('2026-11-11T05:00:00').getTime()).toBeGreaterThan(0);
    expect(clock.pendingAt! - BRT('2026-11-11T05:00:00').getTime()).toBeLessThan(1000);

    clock.advance(2 * 60_000); // 05:01
    const depois = telas(agora);
    expect(depois.rateioComissao).toBe(0);
    expect(depois.dashboardTotal).toBe(0);
    expect(depois.conciliacaoTransacoes).toBe(0);
    expect(depois.legenda).toContain('11/11');
    expect(depois.legenda).toContain('05:00');
    stop();
  });

  it('o tick é a cada minuto: pagamento das 10:01 entra às 10:02 sem mudar os arrays', () => {
    const clock = fakeClock(BRT('2026-11-11T10:00:00'));
    let agora = clock.deps.now();
    const stop = watchReportClock((d) => { agora = d; }, clock.deps);
    const futuro = [pay(70, BRT('2026-11-11T10:01:00').toISOString())];
    expect(reconciliation(futuro, shiftPeriodAt(agora))[0]!.total).toBe(0);
    clock.advance(2 * 60_000);
    expect(reconciliation(futuro, shiftPeriodAt(agora))[0]!.total).toBe(70);
    stop();
  });

  it('ao voltar para o app (timer perdido com o aparelho dormindo) o relógio é conferido de novo', () => {
    const clock = fakeClock(BRT('2026-11-11T04:59:00'));
    let agora = clock.deps.now();
    const stop = watchReportClock((d) => { agora = d; }, clock.deps);
    clock.jump(2 * 60_000);
    expect(telas(agora).rateioComissao).toBe(80);
    // visibilitychange chega no document; no window ele não faz nada.
    clock.win.dispatchEvent(new Event('visibilitychange'));
    expect(telas(agora).rateioComissao).toBe(80);
    clock.doc.dispatchEvent(new Event('visibilitychange'));
    expect(telas(agora).rateioComissao).toBe(0);
    stop();
    // Depois de parar, não reage mais.
    const parado = agora;
    clock.jump(24 * 3600_000);
    clock.win.dispatchEvent(new Event('focus'));
    clock.doc.dispatchEvent(new Event('visibilitychange'));
    expect(agora).toBe(parado);
  });
});

describe('Rodada 3 P2-01: KPIs usam o mesmo período da conciliação e do rateio', () => {
  it('às 10:00, pagamento das 09:00 entra, o das 10:05 e a conta fechada às 10:05 não', () => {
    const agora = BRT('2026-11-11T10:00:00');
    const p = shiftPeriodAt(agora);
    const pagamentos = [pay(50, BRT('2026-11-11T09:00:00').toISOString()), pay(110, BRT('2026-11-11T10:05:00').toISOString())];
    const contas = [ord('f', BRT('2026-11-11T10:05:00').toISOString(), 10)];
    const k = shiftKpis(contas, pagamentos, p);
    const recon = reconciliation(pagamentos, p);
    expect(k.grossRevenue).toBe(50);
    expect(recon.reduce((a, r) => a + r.total, 0)).toBe(50);
    expect(k.serviceFeeTotal).toBe(0);
    expect(k.closedOrders).toBe(0);
    expect(waiterSplit(contas, [item('f')], staff, p)).toHaveLength(0);
  });

  it('com Date continua contando desde o início (chamadas antigas)', () => {
    const k = shiftKpis([], [pay(50, BRT('2026-11-11T09:00:00').toISOString())], new Date('2026-11-11T08:00:00Z'));
    expect(k.grossRevenue).toBe(50);
  });
});

describe('Rodada 3 P2-03: datas impossíveis ou sem fuso ficam de fora', () => {
  const dia1Dez: ShiftPeriod = { start: BRT('2026-12-01T05:00:00'), end: BRT('2026-12-01T10:00:00') };
  const dia2Mar: ShiftPeriod = { start: BRT('2026-03-02T05:00:00'), end: BRT('2026-03-02T10:00:00') };

  it('31/11 e 30/02 não viram 01/12 e 02/03', () => {
    expect(inShiftPeriod('2026-11-31T06:00:00-03:00', dia1Dez)).toBe(false);
    expect(inShiftPeriod('2026-02-30T06:00:00-03:00', dia2Mar)).toBe(false);
    expect(reconciliation([pay(99, '2026-11-31T06:00:00-03:00')], dia1Dez)[0]!.total).toBe(0);
    expect(waiterSplit([ord('x', '2026-11-31T06:00:00-03:00')], [item('x')], staff, dia1Dez)).toHaveLength(0);
  });

  it('hora, minuto, segundo e fuso impossíveis, e data sem fuso', () => {
    for (const bad of [
      '2026-12-01T24:00:00Z', '2026-12-01T08:60:00Z', '2026-12-01T08:00:60Z', '2026-13-01T08:00:00Z',
      '2026-12-00T08:00:00Z', '2026-12-01T08:00:00+24:00', '2026-12-01T08:00:00', '2026-12-01', '2026-12-01 08:00:00Z',
    ]) {
      expect(parseIsoInstant(bad), bad).toBeNull();
    }
  });

  it('datas válidas: limite exato das 05:00, offsets equivalentes, microssegundos e 29/02 bissexto', () => {
    expect(inShiftPeriod('2026-12-01T05:00:00-03:00', dia1Dez)).toBe(true);
    expect(inShiftPeriod('2026-12-01T08:00:00Z', dia1Dez)).toBe(true);
    expect(inShiftPeriod('2026-12-01T08:00:00.000Z', dia1Dez)).toBe(true);
    expect(inShiftPeriod('2026-12-01T08:00:00+00:00', dia1Dez)).toBe(true);
    expect(inShiftPeriod('2026-12-01T08:00:00.123456+00:00', dia1Dez)).toBe(true);
    expect(inShiftPeriod('2026-12-01T04:59:59.999-03:00', dia1Dez)).toBe(false);
    expect(parseIsoInstant('2028-02-29T12:00:00Z')).toBe(Date.parse('2028-02-29T12:00:00Z'));
    expect(parseIsoInstant('2027-02-29T12:00:00Z')).toBeNull();
    expect(parseIsoInstant('2026-12-01T05:00:00.5-03:00')).toBe(Date.parse('2026-12-01T08:00:00.500Z'));
    const iso = new Date(2026, 10, 11, 9, 30).toISOString();
    expect(parseIsoInstant(iso)).toBe(Date.parse(iso));
  });
});
