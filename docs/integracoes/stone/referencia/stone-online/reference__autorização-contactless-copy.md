---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Pré Autorização Magstripe

# Introdução

Pré autorização é uma transação temporária feita em uma cartão de crédito, no qual é reservado um limite do cartão do portador sem efetuar a cobrança imediata

Para realizar uma transação de pré autorização deve-se enviar `pre_auth` no campo `operation_type`.

<br />

> ❗️ Importante
>
> * Caso deseje realizar a captura do valor reservado, uma nova operação deve ser enviada com a informação `capture` no campo `operation_type`

## Request

Abaixo temos um exemplo de uma pré autorização.

```json Request
{
  "amount": 923,
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "local_datetime": "2023-07-15T10:53:16",
  "payment_method": "card",
  "card_transaction": {
    "type": "credit",
    "operation_type": "pre_auth",
    "installments": 1,
    "installments_type": "issuer",
    "statement_descriptor": "loja teste",
    "card": {
      "entry_mode": "magstripe",
      "expiration_date": "5012",
      "number": "6033401111633077000",
      "track_2": "6033401111633077000=31116000018400040",
      "holder_name": "TONY STARK"
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
    "authorization_code": "ABC416",
    "acquirer_message": "Aprovado",
    "acquirer_return_code": "0000",
    "card": {
      "brand": "Visa",
      "emv_response": "9F0500"
    }
  }
}
```