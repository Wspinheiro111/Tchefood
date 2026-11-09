# Mercado Pago Point (Point Smart / Point Smart 2)

Cliente servidor em `server/payments/mercadoPagoPoint.ts`, portado do Tchê Vendas (mesmas regras e testes).
Usa a **Orders API** (`POST /v1/orders`, `type: "point"`): o servidor manda a cobrança para a maquininha
pelo `terminal_id` e consulta o resultado em `GET /v1/orders/{id}`. Pix sai como ordem `qr` na própria tela.

## O que falta para cobrar de verdade

1. Conta Mercado Pago da loja + aplicação em <https://www.mercadopago.com.br/developers/panel/app>
   (produto "Pagamentos presenciais"). O Access Token fica só no servidor, nunca no app.
2. Maquininha Point Smart vinculada à mesma conta e trocada para **modo PDV**
   (`PATCH /terminals/v1/setup` com `operating_mode: "PDV"`, depois reiniciar a maquininha).
3. `listTerminals()` devolve o `terminal_id` (ex.: `NEWLAND_N950__N950NCB123456`) para cadastrar no Tchê Food.
4. Webhook de "Order (Mercado Pago)" apontando para o backend (ainda não existe; por ora o status é consultado).

## Regras mantidas

- Mesma `X-Idempotency-Key` para repetir criação com resultado desconhecido; nunca outra chave.
- Aprovado sem `paid_amount` vira `manual_review`. Nenhum NSU/ID é inventado: tudo vem da resposta.
- Parcelado exige `installments_cost`; crédito sempre com parcelas explícitas.
- Enquanto não houver token, o PDV continua no `MockTerminalDriver`.
