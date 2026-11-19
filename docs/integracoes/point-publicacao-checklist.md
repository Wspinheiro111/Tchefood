# Point Smart — checklist da janela de manutenção

Roteiro do operador para publicar a Point Smart (PR #49) numa loja que já usa a nuvem. Complementa a seção
"Ordem de publicação" de [`mercado-pago-point.md`](mercado-pago-point.md). O caminho de atualização (banco da
main com dados → migrations da Point → app novo) está conferido no Postgres em
[`db/tests/rollout.pg.test.ts`](../../db/tests/rollout.pg.test.ts).

**Regra que manda em tudo:** depois das migrations, o servidor recusa com **TF010** todo pagamento aprovado fora
do Mercado Pago que chega sem a reserva (`tchefood_claim_payment`). O app da main nunca pede reserva. Então:
pagamento em dinheiro, Stone ou PagBank que ainda estiver na fila de um aparelho quando as migrations entrarem
**não é registrado**: o dinheiro foi recebido e a nuvem não fica sabendo. O teste confirma isso. As exceções são o
dinheiro do entregador (`entrega-<id>`, com a entrega já `DELIVERED` no servidor) e o registro de cartão recusado
(DECLINED).

## Antes da janela (dia anterior)

- [ ] Backup do banco (Supabase › Database › Backups, ou `pg_dump`) e anotar o horário.
- [ ] Conferir que a `main` em produção está em `20261114120000_pin_gerente_trava.sql` (Supabase ›
      Database › Migrations): nenhuma migration da main pendente.
- [ ] Gerar o build do app novo e deixá-lo pronto para instalar em **todos** os aparelhos (caixa, garçons,
      totem, KDS, entregas).
- [ ] Só com Point: emitir NFC-e de venda Point em homologação e conferir tPag/tpIntegra/CNPJ/cAut no XML
      (crédito `03` / débito `04`, `tpIntegra` 1, CNPJ `10573521000191` do Mercado Pago, `cAut` = código de
      autorização da venda). Ver "NFC-e da venda na Point" em `mercado-pago-point.md`.
- [ ] Ter o token `APP_USR-...` e o `terminal_id` da Point, se a loja vai usar a Point (passo a passo em
      `mercado-pago-point.md`). Sem Point a publicação vale do mesmo jeito: a reserva vale em toda loja.

## 1. Fechar o caixa e esvaziar as filas

- [ ] Encerrar o atendimento: nenhuma cobrança em andamento em nenhum aparelho.
- [ ] Contas abertas podem ficar abertas, mesmo pagas pela metade. Depois da publicação elas são terminadas pelo
      app novo (reserva e depois pagamento); o saldo delas não muda. Conferido no teste.
- [ ] Em **cada** aparelho: Retaguarda › Nuvem › **sem pendências** (zero eventos esperando para subir).
- [ ] Em cada aparelho, a lista de **recusados** está vazia ou cada item foi resolvido. Pagamento recusado agora
      continua recusado depois da publicação (e daí em diante com TF010).
- [ ] Acerto do entregador já feito, ou pelo menos as marcações de **entregue** já subiram (o dinheiro do
      entregador só entra com a entrega `DELIVERED` no servidor).
- [ ] Desligar ou deixar sem internet todo aparelho que **não** vai ser atualizado agora. Aparelho com o app
      da main que voltar a sincronizar depois das migrations tem todo pagamento novo recusado (TF010).

Conferência no SQL Editor: nenhum pagamento novo enquanto a janela estiver aberta (anote o resultado):

```sql
SELECT count(*), max(registered_at) FROM payments WHERE tenant_id = '<id da loja>';
```

## 2. Migrations

- [ ] Aplicar `20261114130000_mercado_pago.sql` e depois `20261114140000_point_reserva.sql`
      (`supabase db push`). Cada uma roda numa transação; se uma falhar, nada dela fica gravado: pare e
      restaure o roteiro, sem publicar o app.
- [ ] Conferir que entraram:

```sql
SELECT proname FROM pg_proc WHERE proname IN ('tchefood_claim_payment', 'tchefood_point_reservation', 'tchefood_resolve_point_charge');
SELECT count(*) FROM payment_claims;      -- 0
SELECT count(*) FROM terminal_charges;    -- 0
```

- [ ] Repetir a conta da etapa 1: o número de pagamentos e os saldos das contas abertas não mudaram (as
      migrations não mexem em `payments` nem em `orders`).

As migrations podem ser reaplicadas sem erro (conferido no teste) se a primeira tentativa cair no meio por rede.

## 3. Edge Function

- [ ] `supabase functions deploy point-charge` (CLI atual: a função importa `server/payments/`).
- [ ] `supabase functions deploy emit-nfce` (o `payload.ts` mudou neste PR: sem esse deploy a NFC-e da venda na Point não sai como pagamento integrado).
- [ ] Só com Point: gravar o token em `payment_provider_secrets` (SQL em `mercado-pago-point.md`). A maquininha
      se cadastra pelo app: Retaguarda › Point Smart › "Conferir no Mercado Pago" (lista as Points da conta com o
      ID), "Cadastrar Point" com esse ID, e conferir que ela fica **Pronta** (na conta e no modo PDV). Sem a
      conferência mostrando Pronta ela entra desativada e não liga no caixa; a cada cobrança nova o servidor confere
      de novo na lista do Mercado Pago e recusa (nada cobrado) se ela saiu da conta ou do modo PDV. O SQL de
      `pos_terminals` em `mercado-pago-point.md` continua valendo como alternativa (o servidor confere igual).

## 4. App novo em todos os aparelhos

- [ ] Instalar o app novo em **todos** os aparelhos, ainda com o caixa fechado.
- [ ] Em cada aparelho: entrar, Retaguarda › Nuvem › sincronizar, sem pendências e sem recusados novos.
- [ ] Teste de fumaça numa conta de teste: lançar um item, receber R$ 1,00 em dinheiro (o app pede a reserva
      antes), conferir que a conta fechou na nuvem. Com Point: uma cobrança de R$ 1,00 na Point e o estorno dela
      pelo app da Mercado Pago.

## 5. Abrir o caixa

- [ ] Abrir o caixa e liberar o atendimento.
- [ ] Na primeira hora: Retaguarda › Nuvem sem recusados com TF010. Se aparecer um, o aparelho estava com o app
      antigo ou com a fila cheia; veja abaixo.

## Se um pagamento da fila velha foi recusado com TF010

O dinheiro (ou o cartão) foi recebido e o servidor não registrou. A conta continua aberta na nuvem com o saldo
de antes. No aparelho de origem a conta aparece paga (fechada), o evento fica em Retaguarda › Nuvem › recusados e
os eventos seguintes dessa conta (fechamento, mesa livre) ficam segurados ali.

**Hoje o app novo não tem como sair disso nesse aparelho.** "Reenviar recusados" recebe TF010 de novo. A retirada
automática do pagamento não aceito (`withdrawUnacceptedPayment`) só vale para pagamento que tem reserva registrada
no aparelho, e o pagamento da main não tem. E o caixa desse aparelho não cobra a conta: ela tem um recusado
(`ensureOrderSynced`). Por isso a etapa 1 é obrigatória. Se mesmo assim acontecer:

1. Não apagar dados nem reinstalar o aparelho de origem: o evento recusado é a única prova do recebimento.
2. Conferir o recebimento: dinheiro na gaveta, ou comprovante da Stone/PagBank (NSU e valor).
3. Em **outro** aparelho, já com o app novo e sem nada desta conta na fila, registrar o valor na conta aberta
   (o app pede a reserva e depois grava). Para cartão já passado, registrar pelo comprovante, sem passar o cartão
   de novo. O banco aceita esse caminho (conferido no teste, passo 3).
4. Avisar o desenvolvedor para limpar o recusado do aparelho de origem (falta um caminho no app; ver o relatório
   do teste de publicação).
5. Conferir na nuvem que a conta fechou e que não ficou reserva aberta:

```sql
SELECT status, remaining_balance FROM orders WHERE id = '<conta>';
SELECT idempotency_key, status, amount_cents FROM payment_claims WHERE order_id = '<conta>' AND status = 'open';
```

## O que fica de fora deste roteiro

- **Estorno de Stone, PagBank ou dinheiro já gravado:** depois das migrations, o `UPDATE` de um pagamento aprovado
  fora do Mercado Pago para `REFUNDED` é recusado (TF007), também para o dono do banco; para `DECLINED` passa. Não
  existe hoje um caminho no servidor para registrar o estorno desses pagamentos (o app trata estorno como pagamento
  novo, e o app da main nunca fez `UPDATE` em `payments`). Combinar com o Will antes de precisar.
- **Estorno de cobrança da Point já paga:** ver o P1-01 da rodada 9 do GPT (cobrança e pagamento não chegam a
  estornado pelos caminhos atuais).
