/**
 * Relógio dos relatórios do turno: um "agora" reativo que avança a cada virada
 * de minuto (a virada das 05:00 é uma delas) e é conferido de novo quando o app
 * volta para a frente (aparelho dormindo atrasa ou pula timers). O período do
 * turno sai desse relógio, então o início (na virada das 05:00) e o fim (registro
 * que deixou de estar no futuro) mudam mesmo sem nenhuma venda nova.
 */
import { useEffect, useMemo, useState } from 'react';
import { currentShiftPeriod, shiftStartBrasilia, type ShiftPeriod } from './reports';

export interface ShiftClockDeps {
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Onde ouvir a volta do app (visibilitychange/focus/pageshow); null em teste ou fora do navegador. */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

const RESUME_EVENTS = ['visibilitychange', 'focus', 'pageshow'] as const;
export const REPORT_TICK_MS = 60_000;
/** Folga depois da virada do minuto para o timer não disparar um instante antes. */
const TICK_SLACK_MS = 250;

function defaultDeps(): ShiftClockDeps {
  return {
    now: () => new Date(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    target: typeof window !== 'undefined' ? window : null,
  };
}

/**
 * Chama `onTick(agora)` logo depois de cada virada de minuto e sempre que o app
 * volta para a frente. Reagenda a cada disparo. Devolve a função que cancela tudo.
 */
export function watchReportClock(onTick: (now: Date) => void, deps: ShiftClockDeps = defaultDeps()): () => void {
  let handle: unknown = null;
  let stopped = false;

  const schedule = () => {
    if (handle !== null) deps.clearTimer(handle);
    const t = deps.now().getTime();
    const wait = REPORT_TICK_MS - (t % REPORT_TICK_MS) + TICK_SLACK_MS;
    handle = deps.setTimer(tick, wait);
  };

  const tick = () => {
    if (stopped) return;
    onTick(deps.now());
    schedule();
  };

  for (const ev of RESUME_EVENTS) deps.target?.addEventListener(ev, tick);
  schedule();

  return () => {
    stopped = true;
    if (handle !== null) deps.clearTimer(handle);
    for (const ev of RESUME_EVENTS) deps.target?.removeEventListener(ev, tick);
  };
}

/** Período do turno no instante `now` (Brasília): [05:00 do dia operacional, agora]. */
export function shiftPeriodAt(now: Date): ShiftPeriod {
  return currentShiftPeriod(shiftStartBrasilia(now), now);
}

/** Hook: "agora" reativo dos relatórios (ms), atualizado por minuto e na volta do app. */
export function useReportClock(deps?: ShiftClockDeps): number {
  const [now, setNow] = useState(() => (deps ?? defaultDeps()).now().getTime());
  useEffect(() => watchReportClock((d) => setNow(d.getTime()), deps), [deps]);
  return now;
}

/**
 * Hook: um único período do turno para todos os números de uma tela. Recalcula a
 * cada minuto, na volta do app e quando os dados da tela mudam (`data`), sempre
 * com o horário de agora: uma venda que acabou de entrar já aparece.
 */
export function useShiftPeriod(data: readonly unknown[], deps?: ShiftClockDeps): ShiftPeriod {
  const tick = useReportClock(deps);
  const clockNow = deps?.now ?? (() => new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => shiftPeriodAt(new Date(Math.max(tick, clockNow().getTime()))), [tick, ...data]);
}
