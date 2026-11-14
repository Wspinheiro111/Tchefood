import { useMemo, useState } from 'react';
import { Copy, ExternalLink, FileJson, Printer, Receipt, RefreshCw } from 'lucide-react';
import { isRealFiscalStore, useTcheStore } from '../store/useTcheStore';
import { buildNfce, formatAccessKey, isValidNfceQrCodeContent, serverNfceDocument } from '../lib/nfce';
import { danfeLines, type DanfeDoc } from '../lib/receipts';
import { printDocument } from '../lib/payments/drivers';
import { syncOnce } from '../lib/sync/useCloudSync';
import { ordersWithPendingEvents } from '../lib/sync/nfceEmission';
import { Btn, Sheet, toast } from '../components/ui';
import { ThermalPaper } from '../components/SmartPosSimulator';
import type { NfceCloudRecord, Order } from '../types';

const FOCUS_HOST: Record<'homologacao' | 'producao', string> = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};

/** Texto da situação da NFC-e real para a tela. */
export function nfceCloudLabel(order: Order, rec: NfceCloudRecord | undefined, waitingSync: boolean): string {
  if (rec?.status === 'authorized') return 'Autorizada pela SEFAZ';
  if (rec?.status === 'cancelled') return 'Cancelada';
  if (rec?.status === 'contingency') return 'Emitida em contingência, aguardando a SEFAZ';
  if (rec?.status === 'rejected') return 'Rejeitada pela SEFAZ';
  if (rec?.status === 'processing') return 'Em processamento na SEFAZ';
  if (waitingSync) return 'Aguardando a conta subir para a nuvem';
  if (rec?.problem) return 'Não emitida ainda';
  return order.nfce_status === 'PENDING' ? 'Na fila para emissão' : order.nfce_status ?? '—';
}

/** Visualizador do payload Focus NFe + DANFE NFC-e em bobina de 58mm. */
export function NfceViewer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const s = useTcheStore();
  const order = s.orders.find((o) => o.id === orderId);
  const table = s.tables.find((t) => t.id === order?.table_id);
  const [tab, setTab] = useState<'danfe' | 'json'>('danfe');
  // Loja da nuvem, mesmo desconectada: só mostra o que o servidor devolveu.
  const cloud = isRealFiscalStore(s);
  const rec = (s.nfceCloud ?? {})[orderId];

  // Demonstração: nota simulada a partir da comanda. Nuvem: só o que o servidor devolveu
  // (payload transmitido + chave, protocolo, QR); nada do cadastro atual do aparelho.
  const demoDoc = useMemo(() => {
    if (!order || cloud) return null;
    return buildNfce({ tenant: s.tenant, order, items: s.orderItems, payments: s.payments, products: s.products, tableLabel: table?.label ?? '' });
  }, [order, cloud, s.tenant, s.orderItems, s.payments, s.products, table]);
  const doc = useMemo<(DanfeDoc & { qr_url: string }) | null>(() => {
    if (!order) return null;
    if (!cloud) return demoDoc;
    return rec ? serverNfceDocument(rec) : null;
  }, [order, cloud, rec, demoDoc]);

  if (!order) {
    return (
      <Sheet open onClose={onClose} title="NFC-e">
        <p className="text-slate-500">Comanda não encontrada.</p>
      </Sheet>
    );
  }

  if (cloud && !doc) {
    const waiting = ordersWithPendingEvents([...s.outbox, ...(s.syncRejected ?? []).map((r) => r.event)]).has(orderId);
    const finalState = rec?.status === 'authorized' || rec?.status === 'cancelled';
    const askNow = () => {
      const r = s.requestNfceNow(orderId);
      if (!r.ok) return toast.error(r.error);
      toast.info(rec?.status === 'rejected' ? 'Reenvio pedido ao servidor.' : 'Consulta pedida ao servidor.');
      void syncOnce();
    };
    return (
      <Sheet
        open
        onClose={onClose}
        title={<span className="flex items-center gap-2"><Receipt className="h-5 w-5 text-verde" /> NFC-e · {table?.label}</span>}
        footer={
          !finalState && order.status === 'CLOSED' ? (
            <Btn variant="gold" block onClick={askNow}>
              <RefreshCw className="h-5 w-5" /> {rec?.status === 'rejected' || rec?.problem === 'invalid' ? 'Tentar emitir de novo' : 'Emitir / consultar agora'}
            </Btn>
          ) : undefined
        }
      >
        <div className="space-y-2 text-sm">
          <div><b>Situação:</b> {order.status === 'CLOSED' ? nfceCloudLabel(order, rec, waiting) : 'A NFC-e é emitida quando a conta é totalmente liquidada.'}</div>
          {rec?.environment && <div><b>Ambiente:</b> {rec.environment === 'producao' ? 'produção' : 'homologação (sem valor fiscal)'}</div>}
          {rec?.access_key && <div><b>Chave:</b> <span className="font-mono text-xs">{formatAccessKey(rec.access_key)}</span></div>}
          {rec?.message && <div className="rounded-xl bg-amber-50 p-2 text-amber-900">{rec.message}</div>}
          {(rec?.status === 'authorized' || rec?.status === 'contingency') && (
            <div className="rounded-xl bg-rose-50 p-2 text-rose-700">O servidor não devolveu tudo o que o DANFE precisa (QR Code assinado, protocolo, itens transmitidos ou emitente igual ao da chave): o DANFE não é impresso aqui. Use o DANFE da Focus.</div>
          )}
          {rec?.environment && rec.danfe_path && (
            <a className="inline-flex items-center gap-1 font-bold text-verde underline" href={`${FOCUS_HOST[rec.environment]}${rec.danfe_path}`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" /> Abrir DANFE da Focus
            </a>
          )}
          {rec?.next_attempt_at && !finalState && <div className="text-xs text-slate-500">Próxima consulta automática: {new Date(rec.next_attempt_at).toLocaleTimeString('pt-BR')}</div>}
        </div>
      </Sheet>
    );
  }

  if (!doc) {
    return (
      <Sheet open onClose={onClose} title="NFC-e">
        <p className="text-slate-500">A NFC-e é gerada quando a conta é totalmente liquidada.</p>
      </Sheet>
    );
  }

  const contingency = cloud && rec?.status === 'contingency';
  const environment = cloud ? rec?.environment ?? 'homologacao' : 'homologacao';
  // Nota real: os tributos aproximados do aparelho não foram enviados à SEFAZ, então não saem no DANFE.
  const danfe = danfeLines({ tenant: s.tenant, doc, environment, contingency, showTributos: !cloud });
  const json = JSON.stringify(demoDoc?.payload ?? null, null, 2);
  const qrValid = isValidNfceQrCodeContent(doc.qr_url, doc.access_key);
  const printDanfe = () => {
    if (!qrValid) return toast.error('QR Code da NFC-e não confere com a chave de acesso. DANFE não impresso.');
    const first = s.payments.find((p) => p.order_id === orderId && p.status === 'APPROVED' && p.acquirer === 'PAGBANK');
    try {
      const via = printDocument({ title: `DANFE NFC-e ${doc.payload.numero}`, lines: danfe.top, qr: doc.qr_url, footer: danfe.bottom, chassis: first ? 'PAGBANK' : 'STONE' });
      if (via === 'NATIVE') toast.success('DANFE enviado para a bobina.');
    } catch (e) {
      toast.error(`DANFE não impresso: ${e instanceof Error ? e.message : 'falha na impressora'}`);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast.success('Payload copiado.');
    } catch {
      toast.error('Não foi possível copiar.');
    }
  };
  const statusText = cloud
    ? `${nfceCloudLabel(order, rec, false)} (${environment === 'producao' ? 'produção' : 'homologação'})`
    : `${order.nfce_status} (simulação de demonstração, sem SEFAZ)`;

  return (
    <Sheet
      open
      wide
      onClose={onClose}
      title={<span className="flex items-center gap-2"><Receipt className="h-5 w-5 text-verde" /> NFC-e nº {doc.payload.numero} · {table?.label}</span>}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="gold" onClick={printDanfe}><Printer className="h-5 w-5" /> Imprimir DANFE na bobina</Btn>
          {cloud && rec?.environment && rec.danfe_path ? (
            <a className="inline-flex min-h-touch items-center justify-center gap-2 rounded-xl bg-base px-4 font-semibold" href={`${FOCUS_HOST[rec.environment]}${rec.danfe_path}`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-5 w-5" /> DANFE da Focus
            </a>
          ) : !cloud ? (
            <Btn variant="secondary" onClick={copy}><Copy className="h-5 w-5" /> Copiar JSON</Btn>
          ) : (
            <Btn variant="secondary" onClick={onClose}>Fechar</Btn>
          )}
        </div>
      }
    >
      <div className="mb-3 rounded-xl bg-base p-3 text-xs">
        <div><b>Chave de acesso:</b> <span className="font-mono">{formatAccessKey(doc.access_key)}</span></div>
        <div><b>Protocolo SEFAZ-RS:</b> {doc.protocol || '—'} · <b>Status:</b> {statusText}</div>
        <div className="break-all"><b>QR consulta:</b> {doc.qr_url}{!qrValid && <b className="text-rose-600"> (inválido para esta nota)</b>}</div>
      </div>
      {/* Nota real: o payload transmitido fica no servidor; o JSON local é só da demonstração. */}
      {!cloud && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button onClick={() => setTab('danfe')} className={`min-h-touch rounded-xl font-bold ${tab === 'danfe' ? 'bg-brasa' : 'bg-base'}`}>DANFE 58mm</button>
          <button onClick={() => setTab('json')} className={`flex min-h-touch items-center justify-center gap-1 rounded-xl font-bold ${tab === 'json' ? 'bg-brasa' : 'bg-base'}`}><FileJson className="h-4 w-4" /> Payload Focus NFe</button>
        </div>
      )}
      {cloud || tab === 'danfe' ? (
        <div className="flex justify-center rounded-xl bg-slate-50 py-4">
          <ThermalPaper job={{ title: 'DANFE', lines: danfe.top }} qr={doc.qr_url} footer={danfe.bottom} />
        </div>
      ) : (
        <pre className="scroll-thin max-h-[55vh] overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] leading-4 text-emerald-800">{json}</pre>
      )}
    </Sheet>
  );
}
