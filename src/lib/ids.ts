/** Gera UUID v4 (equivalente ao gen_random_uuid() do pgcrypto). */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback para WebViews antigas de maquininhas Android.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * UUID fixo derivado de um texto (mesmo texto = mesmo id em qualquer aparelho).
 * Para registros técnicos que dois aparelhos podem criar ao mesmo tempo (ex.: o
 * produto "Taxa de entrega" da loja): o segundo envio vira o mesmo registro na nuvem.
 */
export function stableUuid(seed: string): string {
  const bytes = new Uint8Array(16);
  // 4 FNV-1a de 32 bits com sementes diferentes = 128 bits.
  for (let k = 0; k < 4; k++) {
    let h = (0x811c9dc5 ^ (k * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    for (let b = 0; b < 4; b++) bytes[k * 4 + b] = (h >>> (b * 8)) & 0xff;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function minutesAgoISO(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** Tempo decorrido em formato curto: "12 min", "1h05". */
export function elapsedLabel(fromISO: string, now: number = Date.now()): string {
  const diffMin = Math.max(0, Math.floor((now - new Date(fromISO).getTime()) / 60_000));
  if (diffMin < 60) return `${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return `${h}h${m.toString().padStart(2, '0')}`;
}
