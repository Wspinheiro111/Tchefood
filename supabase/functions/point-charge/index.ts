// supabase/functions/point-charge/index.ts
//
// Cobrança na Point Smart (Mercado Pago) pela nuvem.
//
//   POST /functions/v1/point-charge
//   Authorization: Bearer <JWT do app com o claim tenant_id>
//   { "action": "create", "terminal_id": "<uuid>", "idempotency_key": "...", "order_id": "<uuid>",
//     "amount_cents": 2450, "method": "CREDIT" | "DEBIT", "staff_id": "<uuid>" }
//   { "action": "status", "idempotency_key": "..." }
//   { "action": "cancel", "idempotency_key": "...", "terminal_id", "order_id", "amount_cents", "method",
//     "reason": "timeout", "staff_id": "<uuid>" }              (prazo vencido: o banco confere 2 min pela hora gravada)
//   { ..., "reason": "operator", "staff_id": "<uuid>", "manager_pin": "1234", "reason_text": "..." }
//                                                             (pedido do operador: PIN de gerente conferido no banco)
//   { "action": "reconcile", "idempotency_key": "...", "staff_id": "<uuid>", "manager_pin": "1234", "reason_text": "...",
//     "operation_id": "123456789" }                           (opcional: ID da operação do comprovante / app do MP)
//                                                             (conferência no Mercado Pago da cobrança em revisão manual ou
//                                                             aprovada sem pagamento registrado; PIN e motivo só pedem a
//                                                             leitura, quem libera é o que o MP mostrar; ver charge.ts).
//                                                             Cobrança ainda não final: segue no MP como a consulta e o
//                                                             encerramento por prazo; estornada: só confere o estorno.
//   { "action": "terminals" }                               (só leitura: as maquininhas da conta do Mercado Pago da loja,
//                                                             com o modo de operação, para a tela de cadastro da Point;
//                                                             resposta { terminals: [{ id, operating_mode }] }, ver terminals.ts)
//   { "action": "refund", "idempotency_key": "...", "staff_id": "<uuid>", "manager_pin": "1234", "reason_text": "..." }
//                                                             (estorno da cobrança aprovada com pagamento já registrado:
//                                                             só grava com o próprio pagamento lido no MP mostrando o
//                                                             estorno; cobrança refunded + pagamento REFUNDED no banco).
//   O encerramento não estorna nada: cobrança paga continua paga.
//   Cancel sem cobrança gravada não cancela nada: com "timeout" grava o bloqueio preventivo da chave (operador
//   ativo da loja, com registro), e a criação atrasada não chega mais à Point; com "operator" é recusado (404).
//
// Resposta: { status: "PENDING" | "APPROVED" | "DECLINED" | "MANUAL_REVIEW", ... } (ver charge.ts).
// O token do Mercado Pago fica em payment_provider_secrets e só a service role lê; o aparelho nunca o vê.
// A loja é provada pelo RLS com o JWT do chamador (a maquininha ou a cobrança só aparecem se forem dele).
//
// Variáveis: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (já injetadas pelo Supabase).
// A lógica fica em handler.ts (testada com o banco de verdade); aqui só as dependências do Deno.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { MercadoPagoPointProvider } from '../../../server/payments/mercadoPagoPoint.ts';
import { handlePointCharge } from './handler.ts';
import { createMercadoPagoPayments } from './mpPayments.ts';

const url = Deno.env.get('SUPABASE_URL')!;

Deno.serve((req: Request) =>
  handlePointCharge(req, {
    callerDb: (authHeader) =>
      createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } }),
    adminDb: () => createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }),
    provider: (accessToken) => new MercadoPagoPointProvider({ accessToken, fetchImpl: (input, init) => fetch(input, init) }),
    payments: (accessToken) => createMercadoPagoPayments({ accessToken, fetchImpl: (input, init) => fetch(input, init) }),
  }),
);
