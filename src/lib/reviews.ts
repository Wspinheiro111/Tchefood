/** Avaliações dos clientes (nota 1 a 5): resumo do período para o Painel do dono. */
import type { Review } from '../types';

export const MAX_REVIEW_COMMENT = 280;

export interface ReviewSummary {
  count: number;
  /** Média com uma casa; null sem avaliações. */
  average: number | null;
  /** Quantas notas 1, 2, 3, 4 e 5 (índice 0 = nota 1). */
  distribution: [number, number, number, number, number];
  /** Nota 4 ou 5. */
  happyPct: number | null;
  /** Notas 1 a 3 com comentário, mais recentes primeiro (para o dono ler). */
  complaints: Review[];
}

export function reviewSummary(reviews: readonly Review[], range: { from: number; to: number }, maxComplaints = 5): ReviewSummary {
  const inRange = reviews.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return t >= range.from && t < range.to;
  });
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const r of inRange) {
    distribution[r.score - 1] = (distribution[r.score - 1] ?? 0) + 1;
    sum += r.score;
  }
  const count = inRange.length;
  const happy = distribution[3] + distribution[4];
  return {
    count,
    average: count ? Math.round((sum / count) * 10) / 10 : null,
    distribution,
    happyPct: count ? Math.round((happy / count) * 1000) / 10 : null,
    complaints: inRange
      .filter((r) => r.score <= 3 && r.comment)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, maxComplaints),
  };
}
