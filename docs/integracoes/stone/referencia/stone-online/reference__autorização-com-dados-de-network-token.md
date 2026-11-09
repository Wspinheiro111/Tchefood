---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com network token

# Introdução

Conforme a regra das bandeiras, as transações com dados de network token (token de bandeira) devem conter dados do token que será utilizado. Para isso, utiliza-se o objeto `token` no lugar dos dados de cartão (PAN) dentro de `card` .

## Objeto token

[block:parameters]
{
  "data": {
    "h-0": "Campo",
    "h-1": "Tipo",
    "h-2": "Tamanho",
    "h-3": "Descrição",
    "0-0": "`number`",
    "0-1": "string",
    "0-2": "-",
    "0-3": "Token gerado pela bandeira.",
    "1-0": "`expiration_date`",
    "1-1": "string",
    "1-2": "-",
    "1-3": "Data de expiração do token utilizando o formato ano e mês \"YYMM\".",
    "2-0": "`cryptogram`",
    "2-1": "string",
    "2-2": "-",
    "2-3": "Criptograma do Token.",
    "3-0": "`result`",
    "3-1": "string",
    "3-2": "-",
    "3-3": "Resultado da autenticação do token:  \n**Valores possiveis:**  \n  \n- 02 ou 05: OK.\n- 01 ou 06: Attempted.\n- 00 ou 07: Failed.",
    "4-0": "`requestor_id`",
    "4-1": "string",
    "4-2": "-",
    "4-3": "Identificador do requerente do Token."
  },
  "cols": 4,
  "rows": 5,
  "align": [
    "left",
    "left",
    "left",
    "left"
  ]
}
[/block]

## Request

Abaixo está um exemplo de uma transação com dados de token e suas respostas.

```json Request - CNP - Network token
{
  "amount": 12861,
  "initiator_id": "13e67426baed4654",
  "reference_id": "13e67426baed4654",
  "local_datetime": "2024-04-12T11:15:35",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "statement_descriptor": "loja ecommerce",
    "card": {
      "entry_mode": "manual",
      "holder_name": "TONY STARK",
      "token": {
        "number": "6033401111633077000",
        "expiration_date": "2608",
        "cryptogram": "/xAAAAAAg6qOp5YAmbG3gmcAAAA=",
        "requestor_id": "40020165503"
      }
    }
  }
}

```
```json Response - Aprovada
{
  "id": "B7843C6C57836C5ETWGFU",
  "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
  "reference_id": "787CVBNBN794",
  "amount": 1000,
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