---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização Magstripe

# Introdução

A transação magstripe (ou magnetic stripe transaction) é um tipo de transação de pagamento realizada usando a tarja magnética de um cartão, que contém informações estáticas sobre o titular do mesmo.

## Objeto authentication

| Campo       | Tipo   | Tamanho | Descrição                                                                                              |
| :---------- | :----- | :------ | :----------------------------------------------------------------------------------------------------- |
| `algorithm` | string | -       | Algoritmo de criptografia utilizado na senha do cliente.                                               |
| `ksi`       | string | -       | Identificação usada para derivar uma chave única de uma chave mestra fornecida para os dados proteção. |
| `ksn`       | string | -       | Chave de criptografia de chave criptografada.                                                          |
| `pin_block` | string | -       | Dados criptografados, resultado da criptografia de conteúdo.                                           |

## Request

Abaixo está um exemplo de uma transação utilizando captura automática e suas respostas.

### Pin Online

```json Request megstripe - pin online
{
  "payment_method": "card",
  "amount": 923,
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "initiator_operation_id": "1234567890",
  "reference_id": "787CVBNBN794",
  "local_datetime": "2023-07-15T10:53:16",
  "card_transaction": {
    "type": "debit",
    "operation_type": "auth_and_capture",
    "installments": 1,
    "statement_descriptor": "*loja teste",
    "card": {
      "entry_mode": "magstripe",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "track_2": "6033401111633077000=31116000018400040"
    },
    "authentication": {
      "type": "online_pin",
      "online_pin": {
        "algorithm": "dukpt_3des",
        "ksi": "2020080303",
        "ksn": "E598600944",
        "pin_block": "DD31B3DD87AC6321"
      }
    }
  }
}

```
```json Response megstripe- pin online
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

### Pin Offline

```json Request megstripe - pin offline
{
  "amount": 923,
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "local_datetime": "2023-07-15T10:53:16",
  "payment_method": "card",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "installments": 3,
    "installments_type": "merchant",
    "statement_descriptor": "loja teste",
    "card": {
      "entry_mode": "magstripe",
      "expiration_date": "5012",
      "number": "6033401111633077000",
      "track_2": "6033401111633077000=31116000018400040",
      "holder_name": "TONY STARK",
      "fallback": true
    },
    "authentication": {
      "type": "offline_pin"
    }
  }
}
```
```json Response megstripe- pin offline
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