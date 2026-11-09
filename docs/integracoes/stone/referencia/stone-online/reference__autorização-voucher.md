---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização voucher

# Introdução

Em uma tentativa de autorização de uma transação voucher, a transação deverá ser enviada com o campo `<card_transaction.type>` preenchido com o valor `"voucher"`.

## Request

Abaixo está um exemplo de uma transação utilizando cartão voucher e suas resposta.

```json Request de Autorização
{
  "amount": 100,
  "initiator_id": "b4d67123a94c4c77",
  "reference_id": "or_3f4783edd45",
  "local_datetime": "2024-04-11T12:49:08",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "voucher",
    "operation_type": "auth_and_capture",
    "installments": 1,
    "statement_descriptor": "loja ecommerce",
    "card": {
      "entry_mode": "manual",
      "expiration_date": "2304",
      "number": "6060715919734019",
      "cvv": "123"
    }
  }
}
```
```json Response - Aprovada
{
  "id": "B7843C6C57836C5ETWGFU",
  "initiator_id": "b4d67123a94c4c77",
  "reference_id": "or_3f4783edd45",
  "amount": 100,
  "status": "paid",
  "payment_method": "card",
  "created_at": "2023-07-01T11:50:37",
  "card_transaction": {
    "type": "voucher",
    "funding_source": "prepaid",
    "result": "success",
    "transaction_id": "14451082092153",
    "brand_transaction_id": "K2QYL2",
    "operation_id": "jrbd9gvm47fv2twjwnjw9wa2w",
    "authorization_code": "ABC416",
    "acquirer_message": "Aprovado",
    "acquirer_return_code": "0000",
    "card": {
      "brand": "Sodexo"
    }
  }
}
```
```json Response - Negada
{
    "id": "14451082092727",
    "initiator_id": "b4d67123a94c4c77",
    "reference_id": "or_3f4783edd45",
    "amount": 0,
    "payment_method": "card",
    "status": "declined",
    "created_at": "2024-04-11T12:49:08",
    "card_transaction": {
        "type": "voucher",
        "funding_source": "prepaid",
        "card": {
            "brand": "Sodexo"
        },
        "brand_return_code": "01",
        "brand_transaction_id": "009272704420",
        "result": "failed",
        "transaction_id": "14451082092727",
        "operation_id": "jrbdekjqns8z7yech6kz2kmvu",
        "acquirer_message": "Erro não especificado",
        "acquirer_return_code": "9999",
        "authorization_code": "092727"
    }
}
```