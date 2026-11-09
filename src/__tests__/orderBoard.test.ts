import { describe, expect, it } from 'vitest';
import { buildBoard, deliveryBoardEntries, qrBoardEntries } from '../lib/orderBoard';
import { DeliveryInbox, InMemoryDeliveryRepository } from '../../server/delivery/deliveryInbox';
import { IfoodMerchantApi } from '../../server/delivery/ifood/ifoodMerchantApi';
import { IfoodSandbox } from '../../server/delivery/ifood/ifoodSandbox';
import type { DiningTable, Order, OrderItem } from '../types';

async function deliveryFixture() {
  const sandbox = new IfoodSandbox();
  const api = new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
  });
  const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository() });
  const item = [{ name: 'Xis', externalCode: '301', quantity: 1, unitPrice: 38 }];
  const novo = sandbox.placeOrder({ items: item, customerName: 'Ana Paula' });
  const preparo = sandbox.placeOrder({ items: item, customerName: 'Jorge Lemes', orderType: 'TAKEOUT' });
  const pronto = sandbox.placeOrder({ items: item, customerName: 'Carla Fontoura' });
  await inbox.runCycle();
  await inbox.performAction('ifood', preparo, 'confirm');
  await inbox.performAction('ifood', pronto, 'confirm');
  await inbox.runCycle();
  await inbox.performAction('ifood', pronto, 'ready_for_pickup');
  await inbox.runCycle();
  return { records: await inbox.listOrders(), novo, preparo, pronto };
}

describe('painel de senhas', () => {
  it('pedido novo (ainda não aceito) não aparece; aceito vai para Preparando e pronto para Pronto', async () => {
    const { records, novo, preparo, pronto } = await deliveryFixture();
    const board = buildBoard(deliveryBoardEntries(records));
    const keys = (list: { key: string }[]) => list.map((entry) => entry.key);
    expect(keys(board.preparing)).toEqual([`delivery:ifood:${preparo}`]);
    expect(keys(board.ready)).toEqual([`delivery:ifood:${pronto}`]);
    expect([...keys(board.preparing), ...keys(board.ready)]).not.toContain(`delivery:ifood:${novo}`);
    expect(board.preparing[0]?.subtitle).toBe('Jorge');
    expect(board.preparing[0]?.courierLabel).toBeNull();
    expect(board.ready[0]?.courierLabel).toBe('Entregador iFood');
  });

  it('não expõe telefone, endereço nem valores', async () => {
    const { records } = await deliveryFixture();
    const text = JSON.stringify(deliveryBoardEntries(records));
    expect(text).not.toMatch(/Marechal|0800|Fontoura|38/);
  });

  it('pedido do QR fica Preparando até todos os itens ficarem prontos', () => {
    const table = { id: 't5', number: 5, current_order_id: 'o1' } as DiningTable;
    const orders = [{ id: 'o1', table_id: 't5' }] as Order[];
    const base = { order_id: 'o1', origin: 'QRCODE_TABLE', sector: 'KITCHEN', created_at: '2026-11-09T10:00:00Z', prepared_at: null } as const;
    const items = [
      { ...base, id: 'a', status: 'READY', prepared_at: '2026-11-09T10:10:00Z' },
      { ...base, id: 'b', status: 'PREPARING' },
      { ...base, id: 'c', status: 'CANCELED' },
      { ...base, id: 'd', order_id: 'o2', origin: 'WAITER', status: 'PENDING' },
    ] as unknown as OrderItem[];
    expect(qrBoardEntries(items, [table], orders)).toEqual([
      expect.objectContaining({ key: 'qr:o1', stage: 'preparing', number: 'Mesa 5' }),
    ]);
    const done = items.map((item) => (item.id === 'b' ? { ...item, status: 'READY' as const } : item));
    expect(qrBoardEntries(done, [table], orders)[0]?.stage).toBe('ready');
    const delivered = done.map((item) => (item.order_id === 'o1' ? { ...item, status: 'DELIVERED' as const } : item));
    expect(qrBoardEntries(delivered, [table], orders)).toEqual([]);
  });

  it('pedido do QR pago antes de ficar pronto continua com o número da mesa', () => {
    // settleIfPaid libera a mesa (current_order_id = null) mas os itens seguem na cozinha.
    const freed = { id: 't7', number: 7, current_order_id: null } as DiningTable;
    const other = { id: 't8', number: 8, current_order_id: null } as DiningTable;
    const orders = [{ id: 'p1', table_id: 't7' }, { id: 'p2', table_id: 't8' }] as Order[];
    const base = { origin: 'QRCODE_TABLE', sector: 'KITCHEN', created_at: '2026-11-09T10:00:00Z', prepared_at: null } as const;
    const items = [
      { ...base, id: 'x', order_id: 'p1', status: 'PREPARING' },
      { ...base, id: 'y', order_id: 'p2', status: 'READY', prepared_at: '2026-11-09T10:05:00Z' },
    ] as unknown as OrderItem[];
    const entries = qrBoardEntries(items, [freed, other], orders);
    expect(entries.map((entry) => entry.number).sort()).toEqual(['Mesa 7', 'Mesa 8']);
  });
});
