// @vitest-environment jsdom
/**
 * Auditoria GPT do PR #64 (P1-01): com a Central de Ajuda aberta, as telas escondidas continuam montadas
 * (para não perder estado), mas nenhum atalho de teclado delas pode agir. Montagem igual à do App.tsx.
 */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { resetClaimLedger } from '../lib/payments/claimLedger';
import type { IPaymentTerminalDriver, TerminalResult } from '../lib/payments/drivers';

const createDriver = vi.fn();
vi.mock('../lib/payments/drivers', async (orig) => {
  const real = await orig<typeof import('../lib/payments/drivers')>();
  return { ...real, createDriver: (...a: unknown[]) => createDriver(...a) };
});

const { PickupCounterScreen } = await import('../screens/PickupCounterScreen');
const { HelpCenter } = await import('../screens/HelpCenter');
const st = () => useTcheStore.getState();

function fakeDriver(result: TerminalResult) {
  return { acquirer: 'STONE', mode: 'TEF_POS_WIRELESS', terminal: null, charge: vi.fn(async () => result), print: vi.fn(async () => undefined), abort: vi.fn() } as unknown as IPaymentTerminalDriver;
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>abrir ajuda</button>
      {open && <HelpCenter onClose={() => setOpen(false)} />}
      <div hidden={open}><PickupCounterScreen /></div>
    </>
  );
}

const press = (key: string) => fireEvent.keyDown(document.body, { key });
const ALL = ['F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'Escape'];

beforeEach(() => {
  st().resetDemo();
  createDriver.mockReset().mockReturnValue(fakeDriver({ status: 'DECLINED', acquirer: 'STONE', reason: 'recusada', terminal_serial: 'S', terminal_id: null }));
  resetClaimLedger();
  expect(st().login('1111').ok).toBe(true);
  act(() => useTcheStore.setState({ cloud: null } as never));
});
afterEach(() => cleanup());

describe('Central de Ajuda aberta sobre o PDV / Caixa', () => {
  it('montador: F2, F8 e F9 não mexem no carrinho, no tipo de atendimento nem criam pedido; ao fechar voltam', async () => {
    const linked = new Set(st().productModifierGroups?.map((l: { product_id: string }) => l.product_id) ?? []);
    const p = st().products.find((x) => x.active !== false && x.available && !x.requires_meat_doneness && !x.allows_half_and_half && !linked.has(x.id))!;
    expect(p).toBeTruthy();
    render(<Harness />);
    const search = screen.getByLabelText('Buscar produto');
    fireEvent.change(search, { target: { value: p.code } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await screen.findByLabelText('Menos');
    const ordersBefore = st().orders.length;
    const qty = () => screen.getByLabelText('Menos').parentElement!.textContent;
    const took = () => screen.getByRole('button', { name: /Para levar/ }).className.includes('bg-brasa');
    const before = qty();
    expect(took()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'abrir ajuda' }));
    for (const k of ['F2', 'F8', 'F9']) press(k);
    expect(st().orders.length).toBe(ordersBefore);

    fireEvent.click(screen.getByRole('button', { name: /Fechar a ajuda/ }));
    expect(qty()).toBe(before);
    expect(took()).toBe(true);
    press('F9');
    await waitFor(() => expect(took()).toBe(false));
    press('F2');
    await waitFor(() => expect(st().orders.length).toBe(ordersBefore + 1));
  });

  it('cobrança pendente: F2/F3/F4/F6/F7/Escape não cobram, não trocam o pagamento nem saem; ao fechar voltam', async () => {
    const p = st().products.find((x) => x.code === '101')!;
    const o = st().createPickupOrder({ lines: [{ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, half_product_ids: [], quick_tags: [], free_notes: '' }], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    expect(o.ok).toBe(true);
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
    const chargeBtn = () => screen.queryByRole('button', { name: /^Cobrar R\$/ });
    expect(chargeBtn()).toBeTruthy();
    const paymentsBefore = st().payments.length;

    fireEvent.click(screen.getByRole('button', { name: 'abrir ajuda' }));
    for (const k of ALL) press(k);
    await act(async () => { await Promise.resolve(); });
    expect(createDriver).not.toHaveBeenCalled();
    expect(st().payments.length).toBe(paymentsBefore);

    fireEvent.click(screen.getByRole('button', { name: /Fechar a ajuda/ }));
    expect(chargeBtn()).toBeTruthy(); // continua na cobrança: a Escape não saiu
    press('F2');
    await waitFor(() => expect(createDriver).toHaveBeenCalled()); // atalho voltou
  });
});
