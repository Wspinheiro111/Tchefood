---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com dados de DCC

# Introdução

As transações com DCC  permite que você ofereça ao seu cliente que veio de outro país a possibilidade de pagar com sua moeda de origem.

## Objeto DCC

[block:parameters]
{
  "data": {
    "h-0": "Campo",
    "h-1": "Tipo",
    "h-2": "Tamanho",
    "h-3": "Descrição",
    "0-0": "`token`",
    "0-1": "string",
    "0-2": "-",
    "0-3": "",
    "1-0": "`currency_code`",
    "1-1": "string",
    "1-2": "-",
    "1-3": "Código da moeda  \n**Valores possíveis:**",
    "2-0": "`converted_amount`",
    "2-1": "string",
    "2-2": "-",
    "2-3": "Valor convertido "
  },
  "cols": 4,
  "rows": 3,
  "align": [
    "left",
    "left",
    "left",
    "left"
  ]
}
[/block]

<br />

## Request

Abaixo está um exemplo de uma transação com dados de E-wallets e suas respostas.

<br />

```json Request
{
  "payment_method": "card",
  "amount": 1000,
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "initiator_operation_id": "1234567890",
  "reference_id": "787CVBNBN794",
  "local_datetime": "2023-07-15T10:53:16",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "installments": 1,
    "statement_descriptor": "loja teste",
    "card": {
      "entry_mode": "emv",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020",
      "sequence_number": 0,
      "track_2": "6033401111633077000=31116000018400040"
    },
    "currency_conversion": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjdXJyZW5jeUNvbnZlcnNpb25JZCI6ImVhZjY1Y2ZhLWI3YmUtNGEzZC05Y2NjLTk2ZjhlOTc4ZjE0NiIsImV4Y2hhbmdlUmF0ZSI6MC4xNTYxLCJtYXJrdXAiOjEuMDUsImZyb21DdXJyZW5jeUNvZGUiOjk4NiwidG9DdXJyZW5jeUNvZGUiOjgyNiwicGF5bWVudFNjaGVtZUtleSI6ImV6NHJjbXE1IiwidG9DdXJyZW5jeUV4cG9lbnQiOjIsImlhdCI6MTY1OTUzMzQwMiwiZXhwIjoxNjU5NTU1MDAyfQ.g0rDU0NRSkiNKedd3WPedDuj_tiSOcnswf9eKGOES8w",
      "currency_code": "826",
      "converted_amount": 200
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