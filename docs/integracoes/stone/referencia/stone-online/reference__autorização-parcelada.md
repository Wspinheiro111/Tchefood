---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização parcelada

# Introdução

Em uma tentativa de autorização de uma transação utilizando parcelamento, a transação deverá ser enviada com o número de parcelas no campo `<installments>`, como indicado no exemplo abaixo que contém 4 parcelas.

## Request

Abaixo está um exemplo de uma transação parcelada em 4 vezes.

```json Request
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
    "installments": 4,
    "installments_type": "merchant",
    "card": {
      "entry_mode": "manual",
      "expiration_date": "5012",
      "number": "6033401111633077000",
      "cvv": "123"
    }
  }
}
```