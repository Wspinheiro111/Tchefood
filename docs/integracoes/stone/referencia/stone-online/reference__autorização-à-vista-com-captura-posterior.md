---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Captura posterior

# Introdução

Em uma tentativa de autorização com captura posterior, a transação deve ser enviada com o valor **auth\_only** no campo `<operation_type>`.

Com isso a transação não será capturada automaticamente e poderá ser capturada através de um evento de captura que também será demonstrado abaixo.

## Requests

### Fluxo de Transações

Abaixo está um exemplo de transação de crédito à vista, com a captura realizada posteriormente.

#### Exemplo do evento da Autorização

Abaixo temos um exemplo de uma autorização com sua resposta.

```json Evento de Autorização
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
    "operation_type": "auth_only",
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
```json Response
{
  "id": "B7843C6C57836C5ETWGFU",
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "reference_id": "787CVBNBN794",
  "amount": 923,
  "status": "authorized",
  "payment_method": "card",
  "created_at": "2023-07-01T11:50:37Z",
  "card_transaction": {
    "type": "credit",
    "funding_source": "credit",
    "result": "success",
    "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
    "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
    "issuer_transaction_id": "K2QYL2",
    "reference": "316464646454",
    "authorization_code": "ABC416",
    "acquirer_message": "Aprovado",
    "acquirer_return_code": "0000",
    "card": {
      "brand": "MasterCard",
      "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
    }
  }
}
```

#### Exemplo do evento de Captura

Abaixo temos o exemplo da captura posterior com sua resposta.

```json Evento de Captura Posterior
{
  "amount": 923
}
```
```json Response
{
  "id": "B7843C6C57836C5ETWGFU",
  "amount": 923,
  "payment_method": "card",
  "status": "paid",
  "card_transaction": {
    "result": "success",
    "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
    "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
    "acquirer_message": "APPR",
    "acquirer_return_code": "0000"
  }
}
```