# PR #54, rodada 34: matriz dos 14 itens pedida na auditoria da r33

SHA testado: a cabeça do PR na r34 (o commit que traz este arquivo; o código SQL e os testes são os mesmos que
rodaram). "Antes" = SHA 996133e (r33), rodado com os testes novos e o SQL antigo, para provar que o teste pega
o defeito. Postgres 16 local, banco recriado do zero (`db/schema.sql` + todas as migrações em ordem) por arquivo.

| # | Item | Entrada | Esperado | Obtido (r34) | Antes (996133e) | Teste |
|---|---|---|---|---|---|---|
| 1 | Pagamento criado e reenviado com lista idêntica | Point aprovada, `tchefood_register_payment` real com `item_ids=[i1]`, reenvio igual | 1 pagamento, vínculo só i1 | ok | — | `paymentClaims`: "reenvio real do pagamento (RPC) com lista idêntica, maior, menor ou vazia…" |
| 2 | Reenvio com lista maior, menor e vazia | reenvios `[i1,i2]`, `[i2]`, `[]` (e `[i1,i2,i2]` na matriz 8), antes e depois do estorno | vínculos da criação não mudam | ok | — | mesmo teste; `cloudSync` matriz 8 e 9 |
| 3 | Duas sessões criando o mesmo pagamento | sessão segura a conta; envio 1 (`[i1]`) e envio 2 (`[i2]`) do mesmo id esperam nela, nessa ordem; solta | os dois terminam, 1 pagamento, vínculo só da lista de quem criou (i1) | ok | — | `cloudSync` matriz 10 (sessões e barreira; não é mais `Promise.all`) |
| 4 | Estorno completo com itens exclusivos | dois itens, dois pagamentos (A→i1, B→i2), estorno verificado de A | A REFUNDED, conta reabre, i1 desmarcado, i2 pago, PATCH velho absorvido | ok | ok | `paymentClaims`: "dois itens, dois pagamentos…" |
| 5 | Estorno com dois pagamentos e itens compartilhados | i1 ligado a A e a B, estorno de A | i1 continua pago (B aprovado cobre) | ok | ok | `paymentClaims`: "item coberto por dois pagamentos…" |
| 6 | Novo pagamento após estorno; repetição do estorno | estorno de A, recebimento B em dinheiro sem lista pela RPC real (conta fecha), PATCH velho de aparelho, estorno repetido | conta CLOSED, itens pagos, B sem vínculo, nada desmarca | ok | — | `paymentClaims`: "GPT r33 item 4: fluxo da Point só por RPC real…" e "P0-02: item pago de novo…" |
| 7 | Registro de pagamento durante a espera do estorno | Point aprovada sem `payments`; sessão segura a trava do PIN; estorno espera; outra sessão registra por RPC com `[i1]` e o aparelho marca i1 pago; solta; repete o estorno | REFUNDED, saldo 100,00, i1 desmarcado; repetir não desmarca | ok | **falha**: REFUNDED e saldo reaberto, mas i1 continua pago (`t,f` em vez de `f,f`) | `paymentClaims`: "GPT r33 P1-01 (sessões independentes)…" |
| 8 | Acerto de entregador concorrendo com registro direto | sessão segura a conta; `tchefood_settle_courier` e `tchefood_register_payment` do MESMO id (`entrega-<id>`) esperam nela, nas duas ordens | sem 40P01, 1 pagamento, 0 vínculos, acerto gravado, entrega acertada, conta CLOSED 0,00 | ok nas duas ordens | **falha com o acerto chegando primeiro**: `deadlock detected` (40P01) no registro; a outra ordem passa | `cloudSync`: "acerto do entregador × envio do mesmo pagamento (acerto chega primeiro / envio chega primeiro)" |
| 9 | Point: RPC de registro, vínculos e estorno numa sequência | cobrança aprovada, registro real com `item_ids`, estorno autorizado, sem `INSERT` manual em `payment_items` | vínculo gravado pela RPC, i1 desmarcado, conta OPEN | ok | — | `paymentClaims`: "GPT r33 item 4…" |
| 10 | Estorno sem evidência, PIN inválido e tentativa repetida | prova ausente ou que não confere, autorização ausente/vencida, PIN errado, estorno repetido | recusa sem mudar nada; repetição devolve a cobrança estornada sem novo efeito | ok | ok | `paymentClaims`: "sem prova, sem autorização ou com prova que não confere…", "P1-02: PIN errado…", "dois estornos ao mesmo tempo…", "o estorno recusado… não desmarca" |
| 11 | Outra loja, anon e authenticated não acessam funções internas | chamar `_core` do estorno e do registro e `tchefood_unpay_payment_items` como aparelho e como service role; chaves de outra loja | 42501 em todas; outra loja: mesma recusa TF009 | ok | o miolo do registro era executável pela service role (fechado na r34) | `paymentClaims`: "os miolos (_core)… não são chamáveis…", "P2-1: … chave de outra loja…"; inventário abaixo |
| 12 | Migration aplicada e reaplicada em banco limpo e atualizado | banco limpo (todas em ordem; contas de novo; pagamento + contas de novo) e banco com a migração da r33 aplicada e a r34 por cima, duas vezes | aplica sem erro; mesmas permissões e gatilhos em todos os estados | ok (inventário abaixo) | — | script de conferência anexado ao texto da auditoria |
| 13 | Suíte PostgreSQL completa e comparação com a main | `npx vitest run db/tests/` | — | 1145 de 1146; a falha é "resgate refeito com o desconto da nuvem" | main (c510d18), só `cloudSync`: 5 falhas, entre elas a mesma | saída anexada |
| 14 | Build, typecheck e suíte de aplicação | `npm run typecheck`, `npm test`, `npm run build` | sem erro | ok; `npm test` 2735 de 2735 | — | saídas anexadas |

## Inventário de permissões (igual em todos os estados da migração)

| Função | anon | authenticated | service_role |
|---|---|---|---|
| `tchefood_register_payment(jsonb)` | não | sim | sim |
| `tchefood_register_payment_core(jsonb)` | não | não | não |
| `tchefood_refund_point_payment(...)` | não | não | sim |
| `tchefood_refund_point_payment_core(...)` | não | não | não |
| `tchefood_unpay_payment_items(uuid)` | não | não | não |
| `tchefood_payment_transition_note()` (gatilho) | não | não | não |
| tabela `payment_items` | sem acesso | sem acesso | acesso (RLS ligada) |

Gatilhos presentes: `order_items.trg_order_items_paid_stays`, `payments.trg_payments_transition_note`. Os dois
wrappers chamam o miolo, não têm `pg_advisory` e o do estorno não lê `payments` antes do miolo.

## Fora do PR (registrado à parte, não é falha deste delta)

- **"resgate refeito com o desconto da nuvem"** (`db/tests/cloudSync.pg.test.ts`): espera estorno de cashback
  33,50 e recebe 14 (+ 19,50 retido). Falha igual na `main` (c510d18), que além dela tem mais 4 falhas de
  cashback/datas no mesmo arquivo que o PR já corrigiu nos testes. Precisa de um PR próprio de cashback; a suíte
  não está toda verde.
- **Tempo esgotado sob carga**: numa das rodadas da suíte inteira, "tirar os 10% de conta com cashback" passou de
  5 s (os arquivos rodam em paralelo); passou nas outras três rodadas do mesmo arquivo.
- **`npm test`**: numa rodada feita em paralelo com a suíte Postgres, "Estornos Mercado Pago: estornados no
  turno…" (`src/__tests__/audit2Money.test.tsx`) falhou porque o fim do turno é "agora + 1 ms" e o registro
  do teste é criado depois; sozinho e na rodada final passa. Teste de relógio pré-existente, fora do escopo.
- Inversão item → conta (PATCH de item do aparelho) × conta → item (fechamento e estorno do servidor):
  pré-existente, ver `docs/travas-financeiras.md`.

## Pendências de ambiente (não são código)

Migração 20261119110000 não aplicada em homologação (aplicar à mão, DEPOIS das de pagamento); Edge Function
e Mercado Pago reais não exercitados (o estorno é testado no banco); APK e WebView físicos pendentes.
