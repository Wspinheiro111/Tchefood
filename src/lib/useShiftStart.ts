/**
 * Início do turno como estado reativo: muda sozinho na virada das 05:00 de
 * Brasília, mesmo sem nenhuma venda nova, e é conferido de novo quando o app
 * volta para a frente (aparelho dormindo atrasa ou pula timers).
 */
import { useEffect, useState } from 'react';
import { nextShiftStart, shiftStartBrasilia } from './reports';

export interface ShiftClockDeps {
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Onde ouvir a volta do app (visibilitychange/focus/pageshow); null em teste ou fora do navegador. */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

const RESUME_EVENTS = ['visibilitychange', 'focus', 'pageshow'] as const;
/** Folga depois das 05:00 para o timer não disparar um instante antes da virada. */
const ROLLOVER_SLACK_MS = 250;

function defaultDeps(): ShiftClockDeps {
  return {
    now: () => new Date(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    target: typeof window !== 'undefined' ? window : null,
  };
}

/**
 * Agenda a próxima virada e reagenda a cada disparo. Chama `onChange` com o novo
 * início sempre que ele difere de `initial` (ou do último informado). Devolve a
 * função que cancela tudo.
 */
export function watchShiftRollover(initial: Date, onChange: (start: Date) => void, deps: ShiftClockDeps = defaultDeps()): () => void {
  let current = initial.getTime();
  let handle: unknown = null;
  let stopped = false;

  const check = () => {
    if (stopped) return;
    const start = shiftStartBrasilia(deps.now());
    if (start.getTime() !== current) {
      current = start.getTime();
      onChange(start);
    }
    schedule();
  };

  const schedule = () => {
    if (handle !== null) deps.clearTimer(handle);
    const wait = nextShiftStart(new Date(current)).getTime() - deps.now().getTime() + ROLLOVER_SLACK_MS;
    handle = deps.setTimer(check, Math.max(ROLLOVER_SLACK_MS, wait));
  };

  for (const ev of RESUME_EVENTS) deps.target?.addEventListener(ev, check);
  check();

  return () => {
    stopped = true;
    if (handle !== null) deps.clearTimer(handle);
    for (const ev of RESUME_EVENTS) deps.target?.removeEventListener(ev, check);
  };
}

/** Hook: início do turno corrente (Brasília), atualizado na virada das 05:00. */
export function useShiftStart(): Date {
  const [start, setStart] = useState(() => shiftStartBrasilia());
  useEffect(() => watchShiftRollover(start, setStart), []); // eslint-disable-line react-hooks/exhaustive-deps
  return start;
}
