---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Recebendo um pagamento

Para todo transação que um POS integrado realizar será criado uma nova charge dentro da *order* referente ao pedido pago pelo POS. Uma *order* poderá conter *n charges* de pagamentos do POS.

Para cada transação no POS, será realizada a criação de charge e isso sempre irá disparar o envio de webhooks para o parceiro que tiver os eventos de webhooks configurados.

> 📘 Configuração de Webhooks
>
> A configuração de webhooks deve ser realizada pelo Dashboard Pagar.me. Em Configurações->Webhooks.\
> Detalhes de webooks nesse [link](https://connect-stone.stone.com.br/reference/webhook-1)

> 📘 Transações Avulsas
>
> Para transação avulsa, na qual o POS realiza um pagamento que não está relacionado a um pedido previamente criado, automaticamente será criado um pedido e uma charge para o mesmo.

**Exemplo de Webhook charge.pending, enviado quando uma cobrança é paga via POS e está pendente de captura**

```json Webhook - charge.pending
{
  "id": "hook_GBwoYpzfBBU3q1La",
  "account": {
    "id": "acc_WdmBrKKCxXFkrXjP",
    "name": "Testes Pagar.me - Parcerias - test"
  },
  "type": "charge.pending",
  "created_at": "2024-03-12T21:26:51.2391669Z",
  "data": {
    "id": "ch_lNX9gpRiXiELOJ8V",
    "code": "EG9WI3IMGQ",
    "gateway_id": "2203028541",
    "amount": 100,
    "status": "pending",
    "currency": "BRL",
    "payment_method": "credit_card",
    "created_at": "2024-03-12T21:26:50.4967184Z",
    "updated_at": "2024-03-12T21:26:51.0490851Z",
    "pending_cancellation": false,
    "customer": {
      "id": "cus_GPZNp58uWhzdkXde",
      "name": "Felipe - teste",
      "email": "teste@teste.com.br",
      "delinquent": false,
      "created_at": "2023-06-09T16:13:15.687Z",
      "updated_at": "2024-01-24T01:13:24.537Z",
      "phones": {},
      "metadata": {}
    },
    "order": {
      "id": "or_lOV0LZrt6tbLJqxG",
      "code": "JEY5TRTXE8",
      "amount": 100,
      "closed": false,
      "created_at": "2024-03-12T21:26:26.843Z",
      "updated_at": "2024-03-12T21:26:26.853Z",
      "currency": "BRL",
      "status": "pending",
      "customer_id": "cus_GPZNp58uWhzdkXde",
      "metadata": {}
    },
    "last_transaction": {
      "transaction_type": "credit_card",
      "installments": 1,
      "installment_type": "merchant",
      "acquirer_name": "pagarme",
      "acquirer_tid": "2203028541",
      "acquirer_nsu": "2203028541",
      "acquirer_auth_code": "2585",
      "acquirer_return_code": "0000",
      "operation_type": "auth_only",
      "card": {
        "id": "card_GmOy4EVfMtv4D80R",
        "first_six_digits": "515460",
        "last_four_digits": "3100",
        "brand": "Mastercard",
        "exp_month": 11,
        "exp_year": 2025,
        "status": "active",
        "type": "credit",
        "created_at": "2023-08-22T12:39:15.847Z",
        "updated_at": "2023-08-22T12:39:15.847Z",
        "billing_address": {},
        "metadata": {}
      },
      "funding_source": "credit",
      "id": "tran_JgjLp75i6iPe7PG4",
      "gateway_id": "2203028541",
      "amount": 100,
      "status": "authorized_pending_capture",
      "success": true,
      "created_at": "2024-03-12T21:26:50.4967184Z",
      "updated_at": "2024-03-12T21:26:50.4967184Z",
      "gateway_response": {},
      "antifraud_response": {},
      "metadata": {},
      "entry_mode": "contactless_emv",
      "initiator_date": "2024-03-12T18:26:46Z",
      "initiator_reference": ";flow=1;retry=0;",
      "initiator_transaction_key": "1731035934-4.0.0.17-SA97KM-0001",
      "device_serial_number": "1731035934"
    },
    "metadata": {}
  }
}
```

<br />

**Campos específicos para transações de POS:**

[block:parameters]
{
  "data": {
    "h-0": "Atributo",
    "h-1": "Tipo",
    "h-2": "Descrição",
    "0-0": "data.code",
    "0-1": "String",
    "0-2": "NSU - Código identificador da transação na adquirente",
    "1-0": "metadata.schemeName",
    "1-1": "String in (\"Alelo\", \"AmericanExpress\", \"AvanCard\", \"BanesCard\" ,\"Ben\", \"Biq\", \"Cabal\", \"CooperCard\", \"DinersClub\", \"Discover\", \"Elo\", \"FortBrasil\", \"GreenCard\", \"Hipercard\", \"JCB\", \"MasterCard\", \"NutriCard\", \"Senff\", \"Sodexo\", \"SoroCred\", \"Ticket\", \"UnionPay\", \"UpBrasil\", \"ValeCard\",\" VerdeCard\", \"VeroCard\", \"Visa\", \"VR\")",
    "1-2": "Nome da bandeira",
    "2-0": "metadata.accountHolderName",
    "2-1": "String",
    "2-2": "Nome do portador do cartão",
    "3-0": "metadata.accountFundingSource",
    "3-1": "String in  \n(\"Credit\", \"Debit\", \"Prepaid\")",
    "3-2": "Tipo da transação",
    "4-0": "metadata.authorizationCode",
    "4-1": "String",
    "4-2": "Código de autorização da bandeira",
    "5-0": "metadata.installmentQuantity",
    "5-1": "String (\"1\" a \"24\")",
    "5-2": "Quantidade de parcelas. Campo não será enviado se transação não for de crédito parcelado",
    "6-0": "metadata.installmentType",
    "6-1": "String in  \n(\"MerchantFinanced\", \"IssuerFinanced\")",
    "6-2": "Tipo de parcelamento.  \nCampo não será enviado se transação não for de crédito parcelado",
    "7-0": "metadata.transactionTimestamp",
    "7-1": "String DateTime  \nEx: \"2020-07-09T18:28:26\"",
    "7-2": "Data/Hora da transação UTV",
    "8-0": "metadata.terminalSerialNumber",
    "8-1": "String",
    "8-2": "Numero serial do terminal (POS)",
    "9-0": "metadata.initiatorTransactionKey",
    "9-1": "Sting",
    "9-2": "Código identificador da transação do POS"
  },
  "cols": 3,
  "rows": 10,
  "align": [
    "left",
    "left",
    "left"
  ]
}
[/block]

> ❗️ Cartões Pré-pagos - A partir do dia 01/04/2023
>
> Para atender à Resolução nº 246 do Banco Central do Brasil, em 01/04/2023 as liquidações de cartões pré-pagos que antes aconteciam em D+30 passam a ser em D+2. Para ser possível conciliar esse tipo de transação, incluiremos no campo AccountFundingSource um novo valor (3) que indicara transações originadas de cartões Pré-pago (Prepaid).