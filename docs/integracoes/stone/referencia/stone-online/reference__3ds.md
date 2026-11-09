---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com dados de 3DS

# Introdução

O 3-D Secure, ou 3DS como é popularmente conhecido, é um protocolo de segurança para autenticar transações online com cartão de crédito ou débito. Este protocolo é projetado para reduzir fraudes e proteger tanto os comerciantes quanto os consumidores.

# Como funciona

* Autenticação do Cliente: Quando um cliente faz uma compra online, o sistema 3DS pode solicitar uma autenticação adicional. Isso geralmente ocorre em forma de uma página de verificação onde o cliente deve inserir um código, senha ou realizar outra forma de autenticação.
* Processo de Transação: Se o cliente for autenticado com sucesso, a transação prossegue normalmente. Caso contrário, a transação pode ser rejeitada.

<br />

> 👍 Vantagens
>
> * Segurança Aumentada: A autenticação adicional ajuda a proteger contra fraudes, garantindo que a transação está sendo realizada pelo titular do cartão.
> * Responsabilidade do Risco: Em muitos casos, se uma transação autenticada pelo 3DS for posteriormente contestada como fraude, a responsabilidade pode recair sobre o emissor do cartão, e não sobre o comerciante.

<br />

```json Request
{
  "amount": 36055,
  "initiator_id": "a5606314e5c64486",
  "reference_id": "a5606314e5c64486",
  "initiator_operation_id": "2024040881031300000712548475101",
  "local_datetime": "2024-04-08T00:12:43",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "statement_descriptor": "loja ecommerce",
    "card": {
      "entry_mode": "manual",
      "number": "6033401111633077000",
      "expiration_date": "3111",
      "cvv": "123",
      "holder_name": "TONY STARK"
    },
    "authentication": {
      "type": "emv_3ds",
      "emv_3ds": {
        "cryptogram": "B5gQApKXlQAAAIzXmGCZdQAAAAA=",
        "eci": "02",
        "status": "Y",
        "directory_server_id": "4dd4df3f-583f-4970-b34f-90ff5d57aac8",
        "version": "VRS21"
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