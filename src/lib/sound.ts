/**
 * Alertas sonoros gerados via Web Audio (sem arquivos de áudio, funciona offline).
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = 'sine', gain = 0.25) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, a.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, a.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + duration);
  osc.connect(g).connect(a.destination);
  osc.start(a.currentTime + start);
  osc.stop(a.currentTime + start + duration + 0.05);
}

/** "Ding-dong" de pedido despachado para a cozinha/bar. */
export function playDispatchChime() {
  tone(880, 0, 0.25, 'triangle');
  tone(1318.5, 0.18, 0.4, 'triangle');
}

/** Alerta grave para tentativa de ação protegida / PIN incorreto. */
export function playDeniedBuzz() {
  tone(180, 0, 0.18, 'square', 0.15);
  tone(140, 0.2, 0.25, 'square', 0.15);
}

/** Toque curto de confirmação. */
export function playTap() {
  tone(1200, 0, 0.05, 'sine', 0.08);
}

export function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* aparelho sem motor de vibração */
    }
  }
}
