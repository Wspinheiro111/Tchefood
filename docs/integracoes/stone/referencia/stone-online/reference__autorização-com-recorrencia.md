---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com dados de recorrência

# Introdução

As transações de recorrência devem conter os dados do ciclo da recorrência.

Para a utilização de recorrência em transações, inicialmente é necessário o objeto `**initiator**` , informando no campo `**initiating_reason**` o valor `**subscription**`

Deve ser enviado, também, um segundo campo `**initiating_entity**`, que determinará se a transação se trata da primeira transação da série de recorrência ou uma das demais transações.

## Série de recorrência

A primeira transação deve receber o valor **`account_holder`** (First Recurring) na tag `initiating_entity`. E o modo de entrada deve ser Ecommerce.

```json Request - CNP - Recorrência
{
  "amount": 4490,
  "initiator_id": "51a3cca401874c8e",
  "reference_id": "51a3cca401874c8e",
  "local_datetime": "2024-04-07T19:48:50",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "card": {
      "entry_mode": "manual",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "holder_name": "TONY STARK",
      "cvv": "123"
    }
  },
  "initiator": {
    "initiating_entity": "account_holder",
    "initiating_reason": "subscription"
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
    "brand_transaction_id": "K00002"
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

Já as demais transações recebem o valor **merchant**  no campo `initiating_entity`. O modo de entrada será cartão armazenado.

```json Request - recorrências subsequentes
{
  "amount": 4490,
  "initiator_id": "51a3cca401874c8e",
  "reference_id": "51a3cca401874c8e",
  "local_datetime": "2024-04-07T19:48:50",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "card": {
      "entry_mode": "credentials_on_file",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "subscription"
  },
  "first_transaction": {
    "brand_transaction_id": "K00002"
  }
}
```

> 🚧 CVV
>
> Em transações recorrentes, essa informação só deve ser enviado na **primeira transação** da recorrência.

> 🚧 Identificador da recorrência
>
> O **brand\_transaction\_id** recebido na primeira transação deve ser repassado **sem alterações** nas autorizações subsequentes da **mesma série**. Visa e Elo retornam esse ID com **até 15 caracteres**, e qualquer modificação no envio do dado pode impactar a conversão das recorrências.

> 📘 Bandeira Mastercard - CIT e MIT
>
> Para a bandeira Mastercard é necessário informar os dados de MIT/CIT para transações recorrentes. Acesse nossa [página ](https://online.stone.com.br/reference/cit)com exemplos de MIT e CIT para entender mais sobre o assunto.