---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com captura automática

# Introdução

Em uma tentativa de autorização com captura automática, a transação deve ser enviada com o valor **auth\_and\_capture** no campo `<operation_type>`.

Com isso a transação será capturada automaticamente e não precisará ser capturada através de um evento de captura.

## Request

Abaixo está um exemplo de uma transação utilizando captura automática e suas respostas.

```json Request de Autorização
{
  "amount": 3011,
  "initiator_id": "b4d67123a94c4c77",
  "reference_id": "or_3f4783edd45",
  "initiator_operation_reference": "2024041181031300000664348969444",
  "local_datetime": "2024-04-11T12:49:08",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "reference": "316464646454",
    "statement_descriptor": "loja ecommerce",
    "card": {
      "entry_mode": "manual",
      "expiration_date": "5012",
      "number": "6033401111633077000",
      "cvv": "123"
    }
  }
}
```
```json Response - Aprovada
{
  "id": "B7843C6C57836C5ETWGFU",
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "reference_id": "787CVBNBN794",
  "amount": 923,
  "status": "paid",
  "payment_method": "card",
  "created_at": "2023-07-01T11:50:37Z",
  "card_transaction": {
    "type": "credit",
    "funding_source": "credit",
    "result": "success",
    "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
    "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
    "authorization_code": "ABC416",
    "acquirer_message": "Aprovado",
    "card": {
      "brand": "MasterCard",
      "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
    }
  }
}
```
```json Response - Negada
{
  "id": "B7843C6C57836C5ETWGFU",
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "reference_id": "787CVBNBN794",
  "amount": 0,
  "status": "refused",
  "payment_method": "card",
  "created_at": "2023-07-01T11:50:37Z",
  "card_transaction": {
    "type": "credit",
    "funding_source": "credit",
    "result": "failed",
    "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
    "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
    "acquirer_message": "Transação inválida",
    "acquirer_return_code": "9102",
    "brand_return_code": "51",
    "merchant_advice_code": "30",
    "card": {
      "brand": "MasterCard",
      "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
    }
  }
}
```

<br />

> 🚧 A captura da transação de crédito pode ser feita de forma automática ou realizada posteriormente
>
> * Para captura automática, envie o campo \<operation\_type> como “auth\_and\_capture”
> * Para captura posterior, envie o campo como "**X**" e, posteriormente, faça a requisição de captura