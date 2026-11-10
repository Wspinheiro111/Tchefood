/**
 * Cardápio QR: o cliente toca no prato, vê em 3D, coloca na mesa em tamanho real (AR)
 * e abre os itens que vêm nele. Daqui segue para o pedido normal (ProductSheet).
 */
import { useEffect, useRef } from 'react';
import { ArrowLeft, ShoppingBag } from 'lucide-react';
import type { Product, ProductArModel } from '../../types';
import { formatBRL } from '../../lib/money';
import { useArStore } from '../../store/useArStore';
import { ModelViewer } from './ModelViewer';

interface Props {
  product: Product;
  model: ProductArModel;
  price: number;
  tableId: string | null;
  onBack: () => void;
  onOrder: () => void;
}

export function ArProductViewer({ product, model, price, tableId, onBack, onOrder }: Props) {
  const record = useArStore((s) => s.recordArEvent);

  // Uma abertura = um VIEW_3D (o StrictMode do React roda o efeito duas vezes em dev).
  const counted = useRef<string | null>(null);
  useEffect(() => {
    if (counted.current === product.id) return;
    counted.current = product.id;
    record(product.id, 'VIEW_3D', tableId);
  }, [record, product.id, tableId]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-slate-50 text-slate-900">
      <div className="flex items-center gap-2 bg-white px-3 py-2 shadow">
        <button aria-label="Voltar ao cardápio" onClick={onBack} className="grid h-11 w-11 place-items-center rounded-xl bg-slate-100"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-black leading-tight">{product.name}</div>
          <div className="text-xs text-slate-500">Veja na sua mesa, no tamanho de verdade</div>
        </div>
        <span className="font-black text-rose-700">{formatBRL(price)}</span>
      </div>

      <ModelViewer
        model={model}
        alt={`Modelo 3D de ${product.name}`}
        variant="customer"
        onEvent={(kind) => record(product.id, kind, tableId)}
        className="min-h-0 flex-1"
      />

      {model.components.length > 0 && (
        <div className="max-h-36 overflow-y-auto border-t border-slate-200 bg-white px-3 py-2">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">O que vem no prato</div>
          <ol className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {model.components.map((c, i) => (
              <li key={c.id} className="flex gap-1">
                <span className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full bg-rose-600 text-[10px] font-bold text-white">{i + 1}</span>
                <span><span className="font-semibold">{c.label}</span>{c.detail && <span className="block text-slate-500">{c.detail}</span>}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="border-t border-slate-200 bg-white p-3">
        <button onClick={onOrder} disabled={!product.available} className="flex min-h-touch-lg w-full items-center justify-center gap-2 rounded-xl bg-rose-600 text-lg font-black text-white disabled:opacity-40">
          <ShoppingBag className="h-5 w-5" /> {product.available ? `Quero este · ${formatBRL(price)}` : 'Esgotado'}
        </button>
      </div>
    </div>
  );
}
