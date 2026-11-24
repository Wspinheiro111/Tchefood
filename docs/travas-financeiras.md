# Travas dos caminhos financeiros (PR #54, rodada 34)

Mapa da ordem de travas do dinheiro no banco, levantado nas funções como estão na migração de cada uma (não só
no comentário). Regra: **uma ordem só**; nenhuma função financeira pega trava fora dela.

## Ordem única (de fora para dentro)

| Nível | Trava | Quem usa |
|---|---|---|
| A | `tchefood_courier_settle:<loja>:<id do acerto>` (advisory) | só `tchefood_settle_courier` (nenhuma outra função usa a chave) |
| B | `tchefood_manager_pin:<loja>` (advisory; `tchefood_check_pin` e as funções com PIN) | estorno, conferência/fim verificado da Point, liberação de reserva pelo gerente, acerto, cobrança da Point |
| C | entregas (`own_deliveries`, `FOR UPDATE`, ordenadas por id) | acerto |
| D | conta (`orders`, `FOR UPDATE`; várias contas, ordenadas por id) | todos |
| E | dentro da conta: reserva (`payment_claims`), cobrança (`terminal_charges`), trava da credenciadora (advisory, só no registro), pagamento (`payments`) | conforme o caminho |
| F | itens (`order_items`) | fechamento pelo saldo (`tchefood_auto_close`), desmarcar do estorno |

## Cada caminho

| Caminho | Ordem (996133e) | Ordem (r34) |
|---|---|---|
| `tchefood_register_payment` | trava advisory `tchefood_payment_items:<id>` → D → E (credenciadora, pagamento) → F (fechamento) | **D → E → F** (o wrapper não pega trava) |
| `tchefood_settle_courier` | A → B → C → D → (registro: `tchefood_payment_items:<id>` → D já tida → E → F) | **A → B → C → D → E → F** |
| `tchefood_refund_point_payment` | `tchefood_refund_items:<cobrança>` → leitura do pagamento sem trava → B → D → E (cobrança, pagamento) → F (desmarcar) | **B → D → E → F** (o wrapper não pega trava nem lê antes do miolo) |
| `tchefood_resolve_point_charge` (fim verificado) | B → D → E (cobrança, pagamento) | inalterado |
| `tchefood_release_payment_claim` / `_manager` | (B, só a do gerente) → D → E (reserva) | inalterado |
| `tchefood_claim_payment` / `tchefood_open_terminal_charge` | (B na cobrança) → D → E | inalterado |
| `tchefood_open_terminal_charge`, cobrança NOVA (#59 r6) | — | (B na cobrança) → D → **maquininha** (`pos_terminals`, `FOR SHARE`, só se a Point está ativa) → E. A maquininha vem depois da conta e nenhuma função financeira pega a conta com a maquininha já travada (desativar a Point é um UPDATE simples, sem gatilho que trave conta), então não há ciclo. A desativação espera a reserva gravar. |
| Gatilhos de `payments` (`trg_payments_recalc`, gatilho do Mercado Pago, `trg_payments_transition_note`) | rodam dentro do registro/estorno: D já tida; cobrança com `FOR SHARE` (E) | `trg_payments_transition_note` (novo) não trava: só anota numa variável local da transação |
| Gatilhos de `order_items` (recálculo, `tchefood_item_paid_stays`) | o recálculo trava D depois da linha do item | inalterado |

## Por que o P2 da r33 acontecia e por que não acontece mais

Na 996133e o envio avulso do pagamento pegava `tchefood_payment_items:<id>` e depois D; o acerto já tinha D
quando chamava o registro, que pedia `tchefood_payment_items:<id>`: ciclo. Na r34 essa trava não existe: os
dois serializam só em D, e o segundo encontra o pagamento gravado (reenvio). Prova nas duas ordens de chegada em
`db/tests/cloudSync.pg.test.ts`.

## Como o wrapper sabe o que o miolo fez, sem ler antes (P1 da r33)

O gatilho `trg_payments_transition_note` (AFTER INSERT OR UPDATE OF status em `payments`) anota em variáveis
**locais da transação** (`set_config(..., true)`, desfeitas no rollback):

- `tchefood.payments_created`: ids de pagamentos que **esta** transação inseriu;
- `tchefood.payments_refunded`: ids que **esta** transação passou de APPROVED para REFUNDED.

O wrapper de registro grava os vínculos (`payment_items`) só quando o id está em `payments_created` (a
chamada que criou o pagamento) e consome a anotação; reenvio nunca acrescenta. O wrapper de estorno desmarca os
itens dos ids em `payments_refunded`, depois do miolo, na mesma transação: repetir um estorno já concluído não
executa o UPDATE, não anota nada e não desmarca de novo; um pagamento que chegou enquanto o estorno esperava a
trava do PIN é o que o miolo estorna e é o que foi anotado. Se a desmarcação falhar, a exceção desfaz o estorno
inteiro (uma transação só). Não há terceira leitura de status.

## Inversão que continua (pré-existente na `main`, não alterada)

`UPDATE order_items` vindo do aparelho (PATCH do PostgREST) trava a linha do item e, no gatilho de recálculo
(AFTER), a conta: item → conta (F → D). Os caminhos do servidor travam conta → item (D → F). Isso já existia na
`main` antes do PR #54: `tchefood_register_payment` com a conta zerando chama `tchefood_auto_close`, que faz
`UPDATE order_items SET is_paid = TRUE` com a conta travada. A r34 acrescenta o mesmo padrão D → F no desmarcar
do estorno.

Consequência possível: um aparelho atualizando exatamente o mesmo item no mesmo instante em que o servidor
fecha a conta ou estorna o pagamento dele pode receber 40P01. O Postgres aborta uma das duas transações por
inteiro (nada parcial): se for o aparelho, a fila dele reenvia; se for o estorno, nada muda no banco e o
estorno é refeito com nova conferência. Não dá para inverter aqui sem mudar a forma como o aparelho grava itens
(sync, fora do escopo congelado); um gatilho BEFORE não ajuda, porque o Postgres trava a linha do item antes de
rodar o gatilho de linha. Fica registrado como pendência para outro PR.

## Provas (arquivos de teste)

- `db/tests/paymentClaims.pg.test.ts`: P1 com sessões independentes (estorno esperando a trava do PIN,
  pagamento registrado por RPC real e item marcado pago pelo aparelho enquanto espera; repetir não desmarca),
  fluxo da Point só por RPC real (registro com `item_ids`, estorno autorizado, recebimento B sem vínculo pela RPC
  real, atualização velha), reenvio real com lista maior, menor ou vazia antes e depois do estorno.
- `db/tests/cloudSync.pg.test.ts`: acerto do entregador × envio do mesmo pagamento nas duas ordens de chegada
  (sessão segurando a conta; sem 40P01) e matriz 10 (dois envios do mesmo pagamento) com sessões e barreira.
