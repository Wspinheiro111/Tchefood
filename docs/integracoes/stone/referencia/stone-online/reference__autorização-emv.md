---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização EMV

# Introdução

A transação EMV é um tipo de operação de pagamento realizadao com cartões que possuem um chip EMV (Europay, Mastercard e Visa), o padrão global para pagamentos com chip.

## Objeto authentication

| Campo       | Tipo   | Tamanho | Descrição                                                                                              |
| :---------- | :----- | :------ | :----------------------------------------------------------------------------------------------------- |
| `algorithm` | string | -       | Algoritmo de criptografia utilizado na senha do cliente.                                               |
| `ksi`       | string | -       | Identificação usada para derivar uma chave única de uma chave mestra fornecida para os dados proteção. |
| `ksn`       | string | -       | Chave de criptografia de chave criptografada.                                                          |
| `pin_block` | string | -       | Dados criptografados, resultado da criptografia de conteúdo.                                           |

## Request

Abaixo estão os exemplos de transação utilizando captura automática (pin online e offline) e suas respostas

* **Pin Online**

```json Request EMV- pin online
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
    "statement_descriptor": "*loja a",
    "card": {
      "entry_mode": "emv",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020",
      "sequence_number": "00",
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
```json Response EMV - pin online
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

<br />

* **Pin Offline**

```json Request EMV- pin offline
{
  "payment_method": "card",
  "amount": 923,
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "initiator_operation_id": "1234567890",
  "reference_id": "787CVBNBN794",
  "local_datetime": "2023-07-15T10:53:16",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "installments": 1,
    "statement_descriptor": "*loja teste",
    "card": {
      "entry_mode": "emv",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020",
      "sequence_number": "00",
      "track_2": "6033401111633077000=31116000018400040"
    },
    "authentication": {
      "type": "offline_pin"
    }
  }
}
```
```json Response EMV - pin offline
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