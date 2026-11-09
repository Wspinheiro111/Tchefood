import { useMemo, useState } from 'react';
import { Copy, FileJson, Printer, Receipt } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { buildNfce, formatAccessKey } from '../lib/nfce';
import { danfeLines } from '../lib/receipts';
import { useTerminalBus } from '../lib/payments/drivers';
import { Btn, Sheet, toast } from '../components/ui';
import { ThermalPaper } from '../components/SmartPosSimulator';

/** Visualizador do payload Focus NFe + DANFE NFC-e em bobina de 58mm. */
export function NfceViewer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const s = useTcheStore();
  const order = s.orders.find((o) => o.id === orderId);
  const table = s.tables.find((t) => t.id === order?.table_id);
  const [tab, setTab] = useState<'danfe' | 'json'>('danfe');

  const doc = useMemo(
    () => (order ? buildNfce({ tenant: s.tenant, order, items: s.orderItems, payments: s.payments, products: s.products, tableLabel: table?.label ?? '' }) : null),
    [order, s.tenant, s.orderItems, s.payments, s.products, table],
  );

  if (!order || !doc) {
    return (
      <Sheet open onClose={onClose} title="NFC-e">
        <p className="text-slate-400">A NFC-e é gerada quando a conta é totalmente liquidada.</p>
      </Sheet>
    );
  }

  const danfe = danfeLines({ tenant: s.tenant, doc });
  const json = JSON.stringify(doc.payload, null, 2);
  const printDanfe = () => {
    const first = s.payments.find((p) => p.order_id === orderId && p.status === 'APPROVED' && p.acquirer === 'PAGBANK');
    useTerminalBus.getState().enqueuePrint({ title: `DANFE NFC-e ${doc.payload.numero}`, lines: danfe.top, qr: doc.qr_url, footer: danfe.bottom, chassis: first ? 'PAGBANK' : 'STONE' });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast.success('Payload copiado.');
    } catch {
      toast.error('Não foi possível copiar.');
    }
  };

  return (
    <Sheet
      open
      wide
      onClose={onClose}
      title={<span className="flex items-center gap-2"><Receipt className="h-5 w-5 text-stone" /> NFC-e nº {doc.payload.numero} · {table?.label}</span>}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="gold" onClick={printDanfe}><Printer className="h-5 w-5" /> Imprimir DANFE na bobina</Btn>
          <Btn variant="secondary" onClick={copy}><Copy className="h-5 w-5" /> Copiar JSON</Btn>
        </div>
      }
    >
      <div className="mb-3 rounded-xl bg-base p-3 text-xs">
        <div><b>Chave de acesso:</b> <span className="font-mono">{formatAccessKey(doc.access_key)}</span></div>
        <div><b>Protocolo SEFAZ-RS:</b> {doc.protocol} · <b>Status:</b> {order.nfce_status} (homologação)</div>
        <div className="break-all"><b>QR consulta:</b> {doc.qr_url}</div>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <button onClick={() => setTab('danfe')} className={`min-h-touch rounded-xl font-bold ${tab === 'danfe' ? 'bg-brasa' : 'bg-base'}`}>DANFE 58mm</button>
        <button onClick={() => setTab('json')} className={`flex min-h-touch items-center justify-center gap-1 rounded-xl font-bold ${tab === 'json' ? 'bg-brasa' : 'bg-base'}`}><FileJson className="h-4 w-4" /> Payload Focus NFe</button>
      </div>
      {tab === 'danfe' ? (
        <div className="flex justify-center rounded-xl bg-slate-900 py-4">
          <ThermalPaper job={{ title: 'DANFE', lines: danfe.top }} qr={doc.qr_url} footer={danfe.bottom} />
        </div>
      ) : (
        <pre className="scroll-thin max-h-[55vh] overflow-auto rounded-xl bg-black p-3 text-[11px] leading-4 text-emerald-300">{json}</pre>
      )}
    </Sheet>
  );
}
