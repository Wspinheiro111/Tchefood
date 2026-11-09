---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização Contactless

# Introdução

Uma transação por contactless (ou transação por aproximação) é um tipo de pagamento eletrônico em que o cliente efetua a compra apenas aproximando o cartão de crédito ou dispositivo eletrônico habilitado para NFC no terminal, sem inserir o cartão ou digitar a senha.

Transações Contactless devem enviar `emv_contactless` no campo `<entry_mode>`.

## Request

Abaixo temos um exemplo de autorização feita por métodos de aproximação ou sem contato.

```json Request
{
  "payment_method": "card",
  "amount": 923,
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "initiator_operation_id": "1234567890",
  "reference_id": "787CVBNBN794",
  "local_datetime": "2023-07-15T10:53:16",
  "card_transaction": {
    "type": "voucher",
    "operation_type": "auth_and_capture",
    "installments": 1,
    "statement_descriptor": "loja teste",
    "card": {
      "entry_mode": "emv_contactless",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020",
      "sequence_number": "01",
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