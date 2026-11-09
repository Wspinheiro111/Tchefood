---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Cancelamento

# Introdução

Neste item exemplificamos o modelo esperado pela nossa API para as requisições de cancelamentos.

## Requests

Abaixo está um exemplo de Cancelamento total por ChargId e suas resposta.

**Endpoint:**<https://payments.stone.com.br/v1/charges/cancel>

```json Request de Cancelamento
{
  "card_transaction": {
    "authentication": {
      "type": "online_pin"
    }
  },
  "id": "17053916666784"
  "amount": 923
}
```
```json Response Sucesso
{
  "id": "B7843C6C57836C5ETWGFU",
  "amount": 923,
  "payment_method": "card",
  "status": "canceled",
  "card_transaction": {
    "result": "success",
    "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
    "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
    "acquirer_message": "APPR",
    "acquirer_return_code": "0000"
  }
}
```
```json Response Falha
{
  "error_code": "not_found",
  "details": {
    "message": "Transação não Encontrada"
  }
}
```

Abaixo está um exemplo de Cancelamento parcial por ChargId e suas resposta.

```json Request de Cancelamento
{
  "card_transaction": {
    "authentication": {
      "type": "online_pin"
    }
  },
  "id": "17053916666789"
  "amount": 30
}
```
```json Response Sucesso
{
  "id": "B7843C6C57836C5ETWGFU",
  "amount": 30,
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
```json Response Falha
{
  "error_code": "not_found",
  "details": {
    "message": "Transação não Encontrada"
  }
}
```

## Requests

Abaixo está um exemplo de Cancelamento por Id próprio e suas resposta.

**Endpoint:**<https://payments.stone.com.br/v1/charges/cancel>

```json Request de Cancelamento
{
  "card_transaction": {
    "authentication": {
      "type": "online_pin"
    }
  },
  "initiator_id": "b4d67123a94c4c77",
  "amount": 100,
  "reason": "4001"
}
```
```json Response Sucesso
{
  "id": "B7843C6C57836C5ETWGFU",
  "amount": 100,
  "payment_method": "card",
  "status": "canceled",
  "card_transaction": {
    "result": "success",
    "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
    "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
    "acquirer_message": "APPR",
    "acquirer_return_code": "0000",
    "authorization_code": "ABC123"
  }
}
```
```json Response Falha
{
  "error_code": "prefix_400",
  "details": {
    "message": "Transação Inválida"
  }
}
```

Abaixo temos uma lista com possíveis reason codes a serem utilizados no cancelamento.

| Cancellation Reason   | ID   |
| :-------------------- | :--- |
| Customer Cancellation | 4000 |
| Reason Unknown        | 4001 |
| Auth Malfunction      | 4002 |
| Card Removed          | 4007 |
| Timed Out             | 4021 |
| Terminal Shutdown     | 4013 |
| Invalid Response      | 4020 |
| ICC Declined          | 4351 |