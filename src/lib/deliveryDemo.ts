import { useEffect } from 'react';
import { create } from 'zustand';
import { DeliveryInbox, InMemoryDeliveryRepository, type DeliveryCycleReport, type DeliveryOrderRecord } from '../../server/delivery/deliveryInbox';
import { IfoodMerchantApi } from '../../server/delivery/ifood/ifoodMerchantApi';
import { IfoodSandbox } from '../../server/delivery/ifood/ifoodSandbox';

// Modo simulador: o mesmo adapter do iFood e a mesma caixa de entrada do servidor rodam no navegador contra
// um iFood falso em memória. Em produção a caixa de entrada roda no servidor (o client_secret não vem ao
// navegador) e as telas leem delivery_orders do Supabase.
export const DEMO_POLL_MS = 5_000;

let demo: { sandbox: IfoodSandbox; inbox: DeliveryInbox } | null = null;

export function getDeliveryDemo() {
  if (!demo) {
    const sandbox = new IfoodSandbox();
    const api = new IfoodMerchantApi({
      credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
      merchantIds: [sandbox.merchantId],
      baseUrl: sandbox.baseUrl,
      fetchImpl: sandbox.fetch,
    });
    const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository() });
    demo = { sandbox, inbox };
  }
  return demo;
}

interface DeliveryOrdersState {
  orders: DeliveryOrderRecord[];
  lastSync: string | null;
}

export const useDeliveryOrders = create<DeliveryOrdersState>(() => ({ orders: [], lastSync: null }));

let inFlight: Promise<DeliveryCycleReport[]> | null = null;

// Um ciclo por vez, mesmo com a tela Delivery e o painel abertos juntos.
export function syncDeliveryOrders(): Promise<DeliveryCycleReport[]> {
  if (!inFlight) {
    inFlight = (async () => {
      const { inbox } = getDeliveryDemo();
      const reports = await inbox.runCycle();
      useDeliveryOrders.setState({ orders: await inbox.listOrders(), lastSync: new Date().toLocaleTimeString('pt-BR') });
      return reports;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export async function refreshDeliveryOrders(): Promise<void> {
  useDeliveryOrders.setState({ orders: await getDeliveryDemo().inbox.listOrders() });
}

// Mantém o polling ligado enquanto a tela que chamou estiver montada.
export function useDeliveryPolling(onCycle?: (reports: DeliveryCycleReport[]) => void): void {
  useEffect(() => {
    let alive = true;
    const run = () =>
      void syncDeliveryOrders().then((reports) => {
        if (alive) onCycle?.(reports);
      });
    run();
    const timer = window.setInterval(run, DEMO_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [onCycle]);
}
