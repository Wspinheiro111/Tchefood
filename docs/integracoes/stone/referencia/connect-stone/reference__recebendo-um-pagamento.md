---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Recebendo um Pagamento

Para todo transação que um POS integrado realizar será criado uma nova charge dentro da *order* referente ao pedido pago pelo POS. Uma *order* poderá conter *n charges* de pagamentos do POS.

Para cada transação no POS, será realizada a criação de charge e isso sempre irá disparar o envio de webhooks para o parceiro que tiver os eventos de webhooks configurados.

> 📘 Configuração de Webhooks
>
> A configuração de webhooks é feita automaticamente na ativação da sua conta, mas você também pode consultar/editar na Dashboard Pagar.me, em Configurações ->Webhooks.

> 📘 Transações Avulsas
>
> Transações Avulsas são transações criadas diretamente na maquininha, sem que o pedido tenha sido previamente criado. Neste caso, automaticamente será criado um pedido e uma charge para o mesmo dentro da dashboard do Pagar.me.

**Exemplo de Webhook charge.paid, enviado quando uma cobrança é paga via POS**

```json Webhook - charge.paid
{
  "id": "hook_masdwqYGoIjcEVe5Go",
  "account": {
    "id": "acc_ladsADGdasdgwIEd58A",
    "name": "Parceiro Teste"
  },
  "type": "charge.paid",
  "created_at": "2023-01-18T21:22:22.9517556Z",
  "data": {
    "id": "ch_bBy6neoSPdsdaewffvxvVd",
    "code": "11831338033297",
    "amount": 2538,
    "paid_amount": 2538,
    "status": "paid",
    "currency": "BRL",
    "payment_method": "cash",
    "paid_at": "2023-01-18T21:22:21.8129944Z",
    "created_at": "2023-01-18T21:22:21.7607907Z",
    "updated_at": "2023-01-18T21:22:21.8129944Z",
    "pending_cancellation": false,
    "customer": {
      "id": "cus_p0ljRJKHPDCdfsfsdvAF",
      "name": "Unknown customer",
      "delinquent": false,
      "created_at": "2023-01-18T21:22:21.6962222Z",
      "updated_at": "2023-01-18T21:22:21.6962222Z",
      "phones": {},
      "metadata": {}
    },
    "order": {
      "id": "or_omyzASdsdfoGADSFA06",
      "code": "O6W1CADq3TJR",
      "amount": 2538,
      "closed": true,
      "created_at": "2023-01-18T21:22:21.7274739Z",
      "updated_at": "2023-01-18T21:22:21.8276542Z",
      "closed_at": "2023-01-18T21:22:21.7274739Z",
      "currency": "BRL",
      "status": "paid",
      "customer_id": "cus_pFASdFKHPDCZjGVP",
      "metadata": {
        "scheme_name": "MasterCard",
        "account_holder_name": null,
        "account_funding_source": "Credit",
        "authorization_code": "051659",
        "initiator_transaction_key": "6C568971-3.21.0-ROPA0Z-0017",
        "installment_quantity": null,
        "installment_type": null,
        "transaction_timestamp": "2023-01-18T21:22:18.461+00:00",
        "terminal_serial_number": "6C568971"
      }
    },
    "last_transaction": {
      "transaction_type": "cash",
      "id": "tran_KlAMPFDffEURU1Pm0r",
      "amount": 2538,
      "status": "paid",
      "success": true,
      "created_at": "2023-01-18T21:22:21.7908938Z",
      "updated_at": "2023-01-18T21:22:21.7908938Z",
      "gateway_response": {},
      "antifraud_response": {}
    },
    "metadata": {
      "scheme_name": "MasterCard",
      "account_holder_name": null,
      "account_funding_source": "Credit",
      "authorization_code": "0124659",
      "initiator_transaction_key": "6C568971-3.21.0-ROPA0Z-0017",
      "installment_quantity": null,
      "installment_type": null,
      "transaction_timestamp": "2023-01-18T21:22:18.461+00:00",
      "terminal_serial_number": "6C5680991"
    }
  }
}
```

**Exemplo de Webhook charge.refunded, realizado quando uma cobrança é cancelada via POS**

```json Webhook - charge.refunded
{
  "id": "hook_3xLXqbnTAufsdfsP",
  "account": {
    "id": "acc_KrX29dfwefsvMBj",
    "name": "Parceiro teste"
  },
  "type": "charge.refunded",
  "created_at": "2023-01-16T19:34:01.4435691Z",
  "data": {
    "id": "ch_4XYezJ3gSasdfasfwjq67",
    "code": "11631304828303",
    "amount": 18254,
    "paid_amount": 18254,
    "canceled_amount": 18254,
    "status": "canceled",
    "currency": "BRL",
    "payment_method": "cash",
    "paid_at": "2023-01-16T18:53:51.54Z",
    "canceled_at": "2023-01-16T19:33:58.4205666Z",
    "created_at": "2023-01-16T18:53:51.523Z",
    "updated_at": "2023-01-16T19:33:58.4205666Z",
    "pending_cancellation": false,
    "order": {
      "id": "or_3gya1sfwwwhBkasdQfvO",
      "code": "R205B0MF4K",
      "amount": 18254,
      "closed": true,
      "created_at": "2023-01-16T18:53:27.947Z",
      "updated_at": "2023-01-16T18:53:55.897Z",
      "closed_at": "2023-01-16T18:53:55.897Z",
      "currency": "BRL",
      "status": "paid",
      "metadata": {}
    },
    "last_transaction": {
      "transaction_type": "cash",
      "id": "tran_J4zmQWLT9S9jPFsdfwQWfd",
      "amount": 18254,
      "status": "canceled",
      "success": true,
      "created_at": "2023-01-16T19:33:58.4205666Z",
      "updated_at": "2023-01-16T19:33:58.4205666Z",
      "gateway_response": {},
      "antifraud_response": {},
      "metadata": {}
    },
    "metadata": {
      "scheme_name": "Visa",
      "account_holder_name": "Tony Stark ",
      "account_funding_source": "Credit",
      "authorization_code": "209634",
      "initiator_transaction_key": "6M518018-3.21.0-ROLDTL-0039",
      "installment_quantity": null,
      "installment_type": null,
      "transaction_timestamp": "2023-01-16T18:53:47.894+00:00",
      "terminal_serial_number": "6M7898018"
    }
  }
}
```

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