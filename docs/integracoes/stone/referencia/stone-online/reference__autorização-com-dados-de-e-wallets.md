---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com E-wallets

# Introdução

As transações com dados de E-wallets (carteiras  digitais) devem conter dados do cartão utilizado e do método de autenticação. Para isso, utiliza-se o objeto `wallet` dentro de `authentication` .

> 📘 Carteiras aceitas
>
> Atualmente aceitamos pedidos autenticados com as carteiras Google e Apple

## Objeto wallet

[block:parameters]
{
  "data": {
    "h-0": "Campo",
    "h-1": "Tipo",
    "h-2": "Tamanho",
    "h-3": "Descrição",
    "0-0": "`type`",
    "0-1": "string",
    "0-2": "-",
    "0-3": "Tipo da Wallet  \n**Valores possíveis: **GooglePay, ApplePay",
    "1-0": "`cryptogram`",
    "1-1": "string",
    "1-2": "-",
    "1-3": "Criptograma gerado pelo carteira digital.",
    "2-0": "`eci`",
    "2-1": "string",
    "2-2": "-",
    "2-3": "Resultado da autenticação:  \n**Valores possíveis:**  \n  \n- 02 ou 05: OK.\n- 01 ou 06: Attempted.\n- 00 ou 07: Failed."
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

```json Request - CNP - Sumerchant
{
    "amount": 4600,
    "initiator_id": "dd12eb25362c40a9",
    "reference_id": "dd12eb25362c40a9",
    "local_datetime": "2024-04-11T17:48:02",
    "payment_method": "card",
    "channel": "website",
    "card_transaction": {
        "type": "credit",
        "operation_type": "auth_and_capture",
        "card": {
            "entry_mode": "manual",
            "number": "6033401111633077000",
            "expiration_date": "3111",
            "holder_name": "TONY STARK"
        },
        "authentication": {
            "type": "wallet",
            "wallet": {
                "cryptogram": "/gAAAAAAAfccLUUzxZgcQGUAAAA=",
                "eci": "02",
                "type": "GooglePay"
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