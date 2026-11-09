---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com dados de MIT/CIT

Merchant Initiated Transaction/Cardholder Initiated Transaction

# Introdução

Abaixo teremos exemplos de cada tipo de transação indicado na página [Envio de indicadores de Transação]()

> 📘 Bandeira Master
>
> Lembrando que o envio dessa informações é obrigatório para a Bandeira Mastercard

# Transações Recorrentes

## CRDP - Credential-on-file

Nesse tipo de transação, será adicionado o valor **`merchant`** no campo **`initiating_entity`** e o valor e **`credentials_on_file`** nos campos **`entry_mode`** e **`initiating_reason`**

```json CRDP
{
  "amount": 2000,
  "initiator_id": "e4ca44a8d57c4df6",
  "reference_id": "e4ca44a8d57c4df6",
  "local_datetime": "2024-04-12T12:01:54",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "card": {
      "entry_mode": "credentials_on_file",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "cvv": "123",
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "credentials_on_file"
  }
}

```

## Standing Order

Nesse tipo de transação, será adicionado o valor **merchant** no campo **`<initiating_entity>`** em uma situação de primeira recorrência (Valor **standing\_order** no campo **`initiating_reason`**):

* No cenário de ordem permanente o consumidor concorda que seu cartão seja armazenado com o comerciante e **inicia uma primeira transação** em uma série destinada a um **valor variável** e uma **frequência fixa**.

```json STOD
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
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "standing_order"
  }
}
```

## Subscription

Nesse tipo de transação, será adicionado o valor **merchant** no campo **`<initiating_entity>`** em uma situação de primeira recorrência (Valor **subscription** no campo **`initiating_reason`**):

```json SBCT
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
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "subscription"
  }
}
```

## REIN - Recurring Installment

Nesse tipo de transação, será adicionado o valor **merchant** no campo **`<initiating_entity>`** em uma situação de primeira recorrência (Valor **installment** no campo **`initiating_reason`**):

* No cenário de Recorrência Parcelada o consumidor concorda que seu cartão seja armazenado para estabelecer um **plano de parcelamento** e **inicia uma primeira transação** em uma série.

```json REIN
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
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "installment"
  }
}
```

# Transações com Cartões Armazenados

## PASH - Partial Shipping

Nesse tipo de transação, será adicionado o valor **merchant** no campo **`<initiating_entity>`** em uma situação de primeira recorrência (Valor **partial\_shipment** no campo **`initiating_reason`**):

* No cenário de Remessa Parcial, temos uma quantidade acordada de mercadorias encomendadas por e-commerce e nem todos os produtos estão disponível para envio no momento da compra. Neste caso cada remessa será uma transação separada.

```json PASH
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
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "partial_shipment"
  }
}
```

## DESL - Delayed Sale

Nesse tipo de transação, será adicionado o valor **merchant** no campo **`<initiating_entity>`** em uma situação de primeira recorrência (Valor **delayed\_charge** no campo **`initiating_reason`**):

* No cenário de Cobrança atrasada, temos uma cobrança adicional da conta após a prestação dos serviços iniciais e o processamento do pagamento.

```json DESL
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
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "delayed_charge"
  }
}
```

## NOAC - No Attendance Charge

Nesse tipo de transação, será adicionado o valor **merchant** no campo **`<initiating_entity>`** em uma situação de primeira recorrência (Valor **no\_show** no campo **`initiating_reason`**):

* No cenário de No show (Multa), temos uma multa cobrada de acordo com a política de cancelamento do comerciante.

```json DESL
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
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "no_show"
  }
}
```

## Reenvios

Nesse tipo de transação, será adicionado o valor **merchant** no campo **`<initiating_entity>`** em uma situação de primeira recorrência (Valor **retry** no campo **`initiating_reason`**):

* No cenário de Reenvio, a tentativa de obter autorização para uma transação que foi recusada, mas a resposta do emissor não proíbe que o comerciante tente mais tarde.

```json DESL
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
      "holder_name": "TONY STARK"
    }
  },
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "retry"
  }
}
```