import { useState } from 'react';
import { Star } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { MAX_REVIEW_COMMENT } from '../lib/reviews';
import { Btn, toast } from './ui';
import type { ReviewSource } from '../types';

const SCORE_LABEL = ['', 'Ruim', 'Fraco', 'Regular', 'Bom', 'Ótimo'];

/** Depois de pagar: o cliente toca na nota (1 a 5) e, se quiser, escreve o que achou. */
export function ReviewCapture({ orderId, source }: { orderId: string; source: ReviewSource }) {
  const existing = useTcheStore((s) => s.reviews.find((r) => r.order_id === orderId));
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');

  if (existing) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-surface p-3 text-sm text-slate-600">
        Obrigado! Nota {existing.score} · {SCORE_LABEL[existing.score]}
      </div>
    );
  }
  const send = () => {
    const r = useTcheStore.getState().addReview(orderId, score, comment, source);
    if (!r.ok) return toast.error(r.error);
    toast.success('Obrigado pela avaliação!');
  };
  return (
    <section className="rounded-2xl border border-slate-200 bg-surface p-3 text-left" aria-label="Avaliação do cliente">
      <h3 className="mb-2 text-center font-black">Como foi hoje?</h3>
      <div className="flex justify-center gap-1" role="radiogroup" aria-label="Nota de 1 a 5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="radio" aria-checked={score === n} aria-label={`Nota ${n} (${SCORE_LABEL[n]})`} onClick={() => setScore(n)} className="grid h-12 w-12 place-items-center rounded-xl active:bg-amarelo/30">
            <Star className={`h-9 w-9 ${n <= score ? 'fill-amarelo text-amber-500' : 'text-slate-300'}`} />
          </button>
        ))}
      </div>
      {score > 0 && (
        <div className="mt-2 space-y-2">
          <div className="text-center text-sm font-bold text-slate-600">{SCORE_LABEL[score]}</div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, MAX_REVIEW_COMMENT))}
            rows={2}
            placeholder={score <= 3 ? 'O que podemos melhorar? (opcional)' : 'Quer deixar um recado? (opcional)'}
            aria-label="Comentário"
            className="w-full rounded-xl border border-slate-300 bg-base p-2 outline-none focus:border-ouro"
          />
          <Btn block variant="success" onClick={send}>Enviar avaliação</Btn>
        </div>
      )}
    </section>
  );
}
