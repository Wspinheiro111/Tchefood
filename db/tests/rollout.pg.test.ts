/**
 * Publicação da Point Smart sobre um banco que já está em produção (caminho de atualização, não banco novo).
 *
 * Roteiro de docs/integracoes/mercado-pago-point.md ("Ordem de publicação"): aparelhos sobem a fila, migrations,
 * Edge Function, app novo em todos os aparelhos, abrir o caixa. Aqui, no Postgres de verdade:
 *  1. O banco nasce como na main ANTES da Point: db/schema.sql + as migrations anteriores à primeira da Point
 *     (20261114130000_mercado_pago.sql). Uma loja com contas abertas e pagas pela metade, pagamentos já gravados
 *     de todo status (APPROVED, DECLINED e também PENDING/REFUNDED, que o tchefood_register_payment da main aceita),
 *     uma senha de entrega já entregue e uma conta já fechada. Pagamentos que um aparelho com o app da main deixou
 *     na fila (dinheiro, Stone com NSU, dinheiro do entregador, Stone recusado) são montados exatamente como o
 *     registerPayment da main grava o Payment e o buildPaymentRequest manda ({ p_payment: Payment }).
 *  2. As migrations da Point entram por cima, cada uma numa transação (como o `supabase db push` aplica), sobre os
 *     dados existentes. Conferido: nada muda nos pagamentos e saldos gravados e nada fica reservado.
 *  3. A fila velha (não esvaziada) é reenviada depois das migrations: o que é recusado, e com qual código. É a prova
 *     de que a fila precisa subir ANTES (passo 1 do roteiro).
 *  4. A sequência documentada (fila esvaziada antes → migrations → app novo): as contas abertas antes, com pagamento
 *     parcial, terminam pelo fluxo novo (reserva e depois pagamento), com o saldo e a soma reservada certos.
 *  Também: as migrations rodam de novo sem erro (são idempotentes) e o estorno por UPDATE de pagamento antigo fora do
 *  Mercado Pago (o "a verificar" do GPT na rodada 9) é registrado como o banco responde.
 *
 * No fim, a tabela do que aconteceu com cada pagamento da fila é impressa no console.
 *
 * Só roda com TCHEFOOD_PG=host:porta:usuario (ex.: /var/tmp/tfpg:5499:postgres).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseLikeDb, pgTargetFromEnv, psql, psqlFile, type PgTarget, type PsqlResult } from './postgrestEmulator';

const target = pgTargetFromEnv();
const DB = `tchefood_rollout_test_${process.pid}`;
const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
/** As migrations da Point (deste PR). Tudo antes da primeira delas é o banco da main de antes da Point. */
const POINT_MIGRATIONS = ['20261114130000_mercado_pago.sql', '20261114140000_point_reserva.sql'];

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const TABLE = '33333333-3333-4333-8333-333333333333';
const KIOSK_TABLE = '37373737-3737-4737-8737-373737373737';
const ZONE = '38383838-3838-4838-8838-383838383838';
const COURIER = '39393939-3939-4939-8939-393939393939';
const STONE_TERMINAL = '57575757-5757-4575-8575-575757575757';
const STONE_SERIAL = 'STONE-S920-01';
const STONE_CNPJ = '16501555000157';

function applyMigration(t: PgTarget, file: string, db: string): void {
  // Cada arquivo numa transação só, como o CLI do Supabase aplica as migrations.
  execFileSync('psql', ['-h', t.host, '-p', t.port, '-U', t.user, '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', join(MIGRATIONS, file)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sql(q: string): string {
  const r = psql(target!, q, DB);
  if (!r.ok) throw new Error(r.message ?? 'sql');
  return r.out;
}
const owner = (q: string): PsqlResult => psql(target!, `${q};`, DB);
/** Chamada do aparelho (PostgREST): papel authenticated, tenant_id do token. */
const asDevice = (q: string): PsqlResult =>
  psql(target!, `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"tenant_id":"${TENANT}"}', true); ${q}; COMMIT;`, DB);
const last = (r: PsqlResult) => r.out.split('\n').pop() ?? '';
const cents = (q: string) => Number(sql(q));
const bal = (o: string) => cents(`SELECT round(remaining_balance * 100)::bigint FROM orders WHERE id = '${o}'`);
const paid = (o: string) => cents(`SELECT round(paid_amount * 100)::bigint FROM orders WHERE id = '${o}'`);
const statusOf = (o: string) => sql(`SELECT status FROM orders WHERE id = '${o}'`);
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const esc = (s: string) => s.replace(/'/g, "''");

let seq = 0;
/** Conta aberta com um item (sem 10%) de `total` reais. */
function order(total: number): string {
  seq += 1;
  const id = `f0f0f0f0-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('${id}', '${TENANT}', '${TABLE}', '${STAFF}');
       BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
       VALUES ('${id}', gen_random_uuid(), '${STAFF}', 1, ${total}, ${total}, 'NONE');
       UPDATE orders SET charge_service_fee = false, subtotal_items = ${total}, total_amount = ${total}, paid_amount = 0, remaining_balance = ${total} WHERE id = '${id}';
       COMMIT;`);
  return id;
}
/** Senha de entrega paga na entrega, com entregador e já entregue no servidor. */
function deliveryOrder(total: number): { order: string; id: string } {
  seq += 1;
  const o = `f1f1f1f1-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const id = crypto.randomUUID();
  sql(`INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id, status, charge_service_fee, fulfillment_type)
       VALUES ('${o}', '${TENANT}', '${KIOSK_TABLE}', '${STAFF}', 'PAYING', false, 'DELIVERY');
       BEGIN; SET LOCAL session_replication_role = replica;
       INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector)
       VALUES ('${o}', gen_random_uuid(), '${STAFF}', 1, ${total}, ${total}, 'NONE');
       UPDATE orders SET subtotal_items = ${total}, total_amount = ${total}, paid_amount = 0, remaining_balance = ${total} WHERE id = '${o}';
       COMMIT;
       INSERT INTO own_deliveries (id, tenant_id, order_id, customer_name, customer_phone, address, zone_id, zone_name, delivery_fee, pay_on_delivery)
       VALUES ('${id}', '${TENANT}', '${o}', 'Cliente', '51999998888', 'Rua A, 100', '${ZONE}', 'Centro', 5, true);
       UPDATE own_deliveries SET status = 'READY' WHERE id = '${id}';
       UPDATE own_deliveries SET status = 'OUT', courier_id = '${COURIER}', courier_fee = 4, out_at = NOW() WHERE id = '${id}';
       UPDATE own_deliveries SET status = 'DELIVERED', delivered_at = NOW() WHERE id = '${id}';`);
  return { order: o, id };
}

type Kind = 'cash' | 'stone' | 'stone-declined' | 'courier-cash' | 'stone-pending' | 'stone-refunded';
/**
 * O Payment que o registerPayment da main grava (src/store/useTcheStore.ts da main: os mesmos campos, na mesma
 * ordem) e que buildPaymentRequest manda inteiro em { p_payment } (payments não tem campo em NEVER_UPLOAD).
 * PENDING e REFUNDED: o app da main não grava, mas o tchefood_register_payment da main aceita qualquer status;
 * entram aqui como linha antiga possível no banco.
 */
function mainPayment(o: string, kind: Kind, amount: number, key: string = crypto.randomUUID()): Record<string, unknown> {
  const card = kind.startsWith('stone');
  const approvedCard = kind === 'stone' || kind === 'stone-refunded' || kind === 'stone-pending';
  const status = kind === 'stone-declined' ? 'DECLINED' : kind === 'stone-pending' ? 'PENDING' : kind === 'stone-refunded' ? 'REFUNDED' : 'APPROVED';
  return {
    id: crypto.randomUUID(),
    order_id: o,
    tenant_id: TENANT,
    waiter_id: STAFF,
    terminal_id: card ? STONE_TERMINAL : null,
    amount,
    tip_amount: 0,
    method: card ? 'CREDIT' : 'CASH',
    status,
    acquirer: card ? 'STONE' : 'CASH_DESK',
    acquirer_cnpj: approvedCard ? STONE_CNPJ : null,
    card_brand: approvedCard ? 'VISA' : null,
    nsu: approvedCard ? `NSU${String(++seq).padStart(6, '0')}` : null,
    authorization_code: approvedCard ? 'A12345' : null,
    terminal_serial: card ? STONE_SERIAL : null,
    idempotency_key: key,
    created_at: new Date().toISOString(),
  };
}
const register = (p: Record<string, unknown>) => asDevice(`SELECT tchefood_register_payment('${esc(JSON.stringify(p))}'::jsonb)`);
function mustRegister(p: Record<string, unknown>, what: string): void {
  const r = register(p);
  if (!r.ok) throw new Error(`${what}: ${r.sqlstate} ${r.message}`);
}

/** Fluxo do app novo: reserva no servidor (tchefood_claim_payment) e depois o pagamento com a mesma chave. */
function claim(o: string, method: 'CASH' | 'CREDIT', amountCents: number, key = crypto.randomUUID(), token = newToken()): PsqlResult & { key: string } {
  const acquirer = method === 'CASH' ? 'CASH_DESK' : 'STONE';
  const r = asDevice(`SELECT tchefood_claim_payment('${key}', '${o}', '${method}', '${acquirer}', ${amountCents}, ${bal(o)}, '${STAFF}', '${token}')`);
  return { ...r, key };
}
function newClientPay(o: string, method: 'CASH' | 'CREDIT', amountCents: number): { claim: PsqlResult; pay: PsqlResult | null; key: string } {
  const c = claim(o, method, amountCents);
  if (!c.ok) return { claim: c, pay: null, key: c.key };
  const p = mainPayment(o, method === 'CASH' ? 'cash' : 'stone', amountCents / 100, c.key);
  return { claim: c, pay: register(p), key: c.key };
}
const reservation = (o: string) => JSON.parse(last(asDevice(`SELECT tchefood_point_reservation('${o}')::text`))) as {
  reserved_cents: number; point_cents: number; claims_cents: number; claims: unknown[];
};

const report: string[] = [];
const note = (line: string) => report.push(line);
const outcome = (r: PsqlResult) => (r.ok ? 'gravado' : `${r.sqlstate}: ${(r.message ?? '').slice(0, 110)}`);

describe.skipIf(!target)('publicação da Point sobre o banco da main (atualização com dados e fila velha)', () => {
  // Contas montadas antes das migrations.
  let partial: string; // aberta, R$ 100, R$ 30 dinheiro + R$ 20 Stone já na nuvem
  let legacyStatuses: string; // aberta, R$ 80, com DECLINED, PENDING e REFUNDED gravados
  let closedOrder: string; // paga e fechada na main
  let refundable: string; // R$ 40 com Stone aprovado de R$ 10 (estorno por UPDATE depois)
  let refundablePayment: string;
  let notDrained: string; // R$ 60, pagamentos dela ficaram na fila do aparelho
  let drained: string; // R$ 70, mesma fila, mas subiu antes das migrations
  let delivery: { order: string; id: string }; // senha de entrega, dinheiro do entregador na fila
  let deliveryDrained: { order: string; id: string };
  const queue: { label: string; payload: Record<string, unknown> }[] = [];
  const drainedQueue: { label: string; payload: Record<string, unknown> }[] = [];
  let resentSynced: Record<string, unknown>; // pagamento já gravado cuja confirmação o aparelho perdeu
  let before: string;

  beforeAll(() => {
    createSupabaseLikeDb(target!, DB);
    psqlFile(target!, join(ROOT, 'db', 'schema.sql'), DB);
    const all = readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort();
    for (const f of POINT_MIGRATIONS) if (!all.includes(f)) throw new Error(`migration da Point não encontrada: ${f}`);
    for (const f of all.filter((x) => x < POINT_MIGRATIONS[0]!)) psqlFile(target!, join(MIGRATIONS, f), DB);
    sql(`INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('${TENANT}', 'Loja', 'Loja Ltda', '11222333000181');
         INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES ('${STAFF}', '${TENANT}', 'Caixa', 'CASHIER', '5162');
         INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('${TABLE}', '${TENANT}', 1, 'Mesa 1');
         INSERT INTO dining_tables (id, tenant_id, number, label, kind) VALUES ('${KIOSK_TABLE}', '${TENANT}', 950, 'Totem', 'KIOSK');
         INSERT INTO delivery_zones (id, tenant_id, name, fee, eta_minutes) VALUES ('${ZONE}', '${TENANT}', 'Centro', 5, 30);
         INSERT INTO couriers (id, tenant_id, name, fee_per_delivery) VALUES ('${COURIER}', '${TENANT}', 'Entregador', 4);
         INSERT INTO pos_terminals (id, tenant_id, name, serial_number, acquirer) VALUES ('${STONE_TERMINAL}', '${TENANT}', 'Stone', '${STONE_SERIAL}', 'STONE');`);
  }, 240_000);

  afterAll(() => {
    if (target) psql({ ...target, db: 'postgres' }, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
    if (report.length) {
      // eslint-disable-next-line no-console
      console.log(`\nPublicação da Point sobre o banco da main:\n${report.map((l) => `  ${l}`).join('\n')}\n`);
    }
  });

  it('1. banco da main antes da Point: pagamentos de todo status gravados e a fila do aparelho montada', () => {
    expect(sql(`SELECT count(*) FROM pg_proc WHERE proname = 'tchefood_claim_payment'`)).toBe('0');
    expect(sql(`SELECT count(*) FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'acquirer_type' AND e.enumlabel = 'MERCADO_PAGO'`)).toBe('0');

    partial = order(100);
    const syncedCash = mainPayment(partial, 'cash', 30);
    mustRegister(syncedCash, 'dinheiro parcial');
    mustRegister(mainPayment(partial, 'stone', 20), 'Stone parcial');
    resentSynced = syncedCash;
    expect(bal(partial)).toBe(5000);

    legacyStatuses = order(80);
    mustRegister(mainPayment(legacyStatuses, 'stone-declined', 80), 'recusado');
    mustRegister(mainPayment(legacyStatuses, 'stone-pending', 80), 'pendente');
    mustRegister(mainPayment(legacyStatuses, 'stone-refunded', 80), 'estornado');
    expect(bal(legacyStatuses)).toBe(8000);

    closedOrder = order(25);
    mustRegister(mainPayment(closedOrder, 'cash', 25), 'conta paga');
    expect(statusOf(closedOrder)).toBe('CLOSED');

    refundable = order(40);
    const rp = mainPayment(refundable, 'stone', 10);
    mustRegister(rp, 'Stone a estornar');
    refundablePayment = String(rp.id);
    expect(bal(refundable)).toBe(3000);

    // A fila de um aparelho com o app da main (sem internet na hora), nunca enviada.
    notDrained = order(60);
    delivery = deliveryOrder(45);
    queue.push(
      { label: 'dinheiro R$ 25 (conta aberta)', payload: mainPayment(notDrained, 'cash', 25) },
      { label: 'Stone R$ 35 com NSU (conta aberta)', payload: mainPayment(notDrained, 'stone', 35) },
      { label: 'dinheiro do entregador R$ 45 (entrega-<id>)', payload: mainPayment(delivery.order, 'cash', 45, `entrega-${delivery.id}`) },
      { label: 'Stone recusado R$ 60', payload: mainPayment(notDrained, 'stone-declined', 60) },
    );
    // A mesma fila, de outro aparelho, que sobe ANTES das migrations (passo 1 do roteiro).
    drained = order(70);
    deliveryDrained = deliveryOrder(15);
    drainedQueue.push(
      { label: 'dinheiro R$ 25', payload: mainPayment(drained, 'cash', 25) },
      { label: 'Stone R$ 35 com NSU', payload: mainPayment(drained, 'stone', 35) },
      { label: 'dinheiro do entregador R$ 15', payload: mainPayment(deliveryDrained.order, 'cash', 15, `entrega-${deliveryDrained.id}`) },
      { label: 'Stone recusado R$ 10', payload: mainPayment(drained, 'stone-declined', 10) },
    );
    for (const q of drainedQueue) {
      const r = register(q.payload);
      note(`fila esvaziada antes (main): ${q.label} -> ${outcome(r)}`);
      expect(r.ok, `${q.label}: ${r.message}`).toBe(true);
    }
    expect(bal(drained)).toBe(1000);
    expect(statusOf(deliveryDrained.order)).toBe('CLOSED');

    before = sql(`SELECT string_agg(id || ':' || status || ':' || amount, ',' ORDER BY id) FROM payments;
                  SELECT string_agg(id || ':' || status || ':' || remaining_balance || ':' || paid_amount, ',' ORDER BY id) FROM orders`);
  });

  it('2. as migrations da Point entram por cima, cada uma numa transação, sem mexer nos dados', () => {
    for (const f of POINT_MIGRATIONS) {
      try {
        applyMigration(target!, f, DB);
        note(`migration ${f} (uma transação, sobre os dados): ok`);
      } catch (e) {
        const msg = (e as { stderr?: string }).stderr ?? String(e);
        note(`migration ${f}: FALHOU ${msg.slice(0, 300)}`);
        throw new Error(`${f}: ${msg}`);
      }
    }
    const after = sql(`SELECT string_agg(id || ':' || status || ':' || amount, ',' ORDER BY id) FROM payments;
                       SELECT string_agg(id || ':' || status || ':' || remaining_balance || ':' || paid_amount, ',' ORDER BY id) FROM orders`);
    expect(after).toBe(before);
    for (const o of [partial, legacyStatuses, refundable, notDrained, drained]) expect(reservation(o).reserved_cents).toBe(0);
    expect(sql(`SELECT count(*) FROM payment_claims`)).toBe('0');
    expect(sql(`SELECT count(*) FROM terminal_charges`)).toBe('0');
  });

  it('3. a fila velha que não subiu antes: o que o servidor recusa depois das migrations', () => {
    // O reenvio de um pagamento já gravado (o aparelho perdeu a confirmação) devolve o gravado, sem passar
    // pelos gatilhos novos.
    const again = register(resentSynced);
    note(`reenvio de pagamento já gravado antes (confirmação perdida): ${outcome(again)}`);
    expect(again.ok).toBe(true);
    expect(last(again)).toBe(String(resentSynced.id));

    const got: Record<string, string | null> = {};
    for (const q of queue) {
      const r = register(q.payload);
      got[q.label] = r.ok ? 'ok' : r.sqlstate;
      note(`fila velha depois das migrations: ${q.label} -> ${outcome(r)}`);
    }
    // Dinheiro e Stone aprovados sem reserva: TF010 (o dinheiro foi recebido e não fica registrado).
    expect(got['dinheiro R$ 25 (conta aberta)']).toBe('TF010');
    expect(got['Stone R$ 35 com NSU (conta aberta)']).toBe('TF010');
    // Dinheiro do entregador com a entrega já DELIVERED no servidor: é a exceção conferida no banco.
    expect(got['dinheiro do entregador R$ 45 (entrega-<id>)']).toBe('ok');
    // Recusado sem reserva nenhuma com a chave: entra (não move dinheiro).
    expect(got['Stone recusado R$ 60']).toBe('ok');
    expect(bal(notDrained)).toBe(6000);
    expect(statusOf(delivery.order)).toBe('CLOSED');

    // O caixa reconfere e registra de novo pelo app novo (reserva e pagamento): a conta fecha.
    const cash = newClientPay(notDrained, 'CASH', 2500);
    const card = newClientPay(notDrained, 'CREDIT', 3500);
    note(`fila velha refeita pelo app novo: dinheiro -> ${outcome(cash.pay ?? cash.claim)}; Stone -> ${outcome(card.pay ?? card.claim)}`);
    expect(cash.pay?.ok).toBe(true);
    expect(card.pay?.ok).toBe(true);
    expect(statusOf(notDrained)).toBe('CLOSED');
  });

  it('3b. o app da main depois das migrations: todo pagamento novo dele é recusado', () => {
    const o = order(20);
    const r = register(mainPayment(o, 'cash', 20));
    note(`app da main depois das migrations, dinheiro novo: ${outcome(r)}`);
    expect(r.sqlstate).toBe('TF010');
    // A assinatura antiga de reserva não existe (aparelho com app de rodadas anteriores do PR).
    const old = asDevice(`SELECT tchefood_claim_payment('k-velha', '${o}', 'CASH', 'CASH_DESK', 2000, 2000, '${STAFF}')`);
    note(`reserva pela assinatura antiga (7 argumentos): ${outcome(old)}`);
    expect(old.sqlstate).toBe('42883');
  });

  it('4. sequência documentada: conta aberta antes, com pagamento parcial, termina pelo fluxo novo', () => {
    // R$ 100, R$ 50 pagos na main. Reserva de R$ 20 em dinheiro: reserva certa enquanto aberta.
    const c = claim(partial, 'CASH', 2000);
    expect(c.ok, c.message ?? '').toBe(true);
    let res = reservation(partial);
    expect(res.reserved_cents).toBe(2000);
    expect(res.claims_cents).toBe(2000);
    expect(res.point_cents).toBe(0);
    // Outra reserva acima do livre (R$ 50 - R$ 20 reservados = R$ 30): TF003.
    const over = claim(partial, 'CREDIT', 3100);
    note(`reserva acima do livre (R$ 31 com R$ 30 livres): ${outcome(over)}`);
    expect(over.sqlstate).toBe('TF003');
    // Pagamento sem reserva (app velho) com reserva aberta na conta: TF010.
    const stray = register(mainPayment(partial, 'cash', 10));
    expect(stray.sqlstate).toBe('TF010');
    // O pagamento da reserva consome a reserva.
    const pay = register(mainPayment(partial, 'cash', 20, c.key));
    expect(pay.ok, pay.message ?? '').toBe(true);
    expect(bal(partial)).toBe(3000);
    expect(paid(partial)).toBe(7000);
    res = reservation(partial);
    expect(res.reserved_cents).toBe(0);
    expect(sql(`SELECT status FROM payment_claims WHERE idempotency_key = '${c.key}'`)).toBe('consumed');
    // O resto na Stone, com NSU: a conta fecha.
    const card = newClientPay(partial, 'CREDIT', 3000);
    expect(card.pay?.ok, card.pay?.message ?? card.claim.message ?? '').toBe(true);
    expect(bal(partial)).toBe(0);
    expect(statusOf(partial)).toBe('CLOSED');
    note('conta aberta antes (R$ 100, R$ 50 pagos na main): reserva R$ 20 -> reservado 2000; paga; Stone R$ 30 -> fechada');

    // Conta com DECLINED/PENDING/REFUNDED antigos: as linhas antigas não contam no saldo nem na reserva.
    expect(reservation(legacyStatuses).reserved_cents).toBe(0);
    const full = newClientPay(legacyStatuses, 'CREDIT', 8000);
    expect(full.pay?.ok, full.pay?.message ?? full.claim.message ?? '').toBe(true);
    expect(statusOf(legacyStatuses)).toBe('CLOSED');

    // A fila que subiu antes das migrations: o resto (R$ 10) pelo fluxo novo.
    const rest = newClientPay(drained, 'CASH', 1000);
    expect(rest.pay?.ok, rest.pay?.message ?? rest.claim.message ?? '').toBe(true);
    expect(statusOf(drained)).toBe('CLOSED');

    // Nenhuma reserva ficou aberta.
    expect(sql(`SELECT count(*) FROM payment_claims WHERE status = 'open'`)).toBe('0');
  });

  it('5. estorno por UPDATE de um pagamento Stone gravado antes (como o banco responde, sem regra combinada)', () => {
    const r = owner(`UPDATE payments SET status = 'REFUNDED' WHERE id = '${refundablePayment}'`);
    note(`UPDATE de Stone APPROVED antigo para REFUNDED (dono do banco): ${outcome(r)}`);
    const d = owner(`UPDATE payments SET status = 'DECLINED' WHERE id = '${refundablePayment}'`);
    note(`UPDATE de Stone APPROVED antigo para DECLINED (dono do banco): ${outcome(d)}`);
    // Só registra: a decisão sobre o estorno fora do Mercado Pago é do Will (a verificar 1 da rodada 9).
    expect(typeof r.ok).toBe('boolean');
  });

  it('6. as migrations rodam de novo sobre o banco já atualizado (idempotentes)', () => {
    const snap = sql(`SELECT string_agg(id || ':' || status || ':' || remaining_balance, ',' ORDER BY id) FROM orders`);
    for (const f of POINT_MIGRATIONS) {
      try {
        applyMigration(target!, f, DB);
        note(`reaplicar ${f}: ok`);
      } catch (e) {
        const msg = (e as { stderr?: string }).stderr ?? String(e);
        note(`reaplicar ${f}: FALHOU ${msg.slice(0, 300)}`);
        throw new Error(`${f}: ${msg}`);
      }
    }
    expect(sql(`SELECT string_agg(id || ':' || status || ':' || remaining_balance, ',' ORDER BY id) FROM orders`)).toBe(snap);
  });
});
