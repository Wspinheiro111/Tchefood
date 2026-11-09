---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com credential on file

# Como utilizar

Basicamente, transações utilizando Card on File vão utilizar as tags **initiating\_entity** e **initiating\_reason** com os respectivos valores:

Transação avulsa com armazenamento do cartão:

* **initiating\_entity**: **"account\_holder"**
* **initiating\_reason**: **"credentials\_on\_file"**

Transação com uso de cartão armazenado:

* **initiating\_entity**: **"merchant"**
* **initiating\_reason**: **"credentials\_on\_file"**

## Exemplo

```json Exemplo das tags de transação avulsa com armazenamento do cartão
{
  "initiator": {
    "initiating_entity": "account_holder",
    "initiating_reason": "credentials_on_file"
}
```
```json Exemplo das tags de uso de cartão armazendo
{
  "initiator": {
    "initiating_entity": "merchant",
    "initiating_reason": "credentials_on_file"
}
```

## Exemplo de um Request Completo

```json Request transação avulsa com armazenamento do cartão
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
    "initiating_entity": "account_holder",
    "initiating_reason": "credentials_on_file"
  }
}
```
```json Request transação com uso de cartão armazendo
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

<br />

## Exemplo de Response Completo

```json 200 - OK
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
```json 400 - BadRequest
{
  "error_code": "api_400",
  "details": {
    "message": "Transação Inválida",
    "description": "Headers obrigatórios não foram informados na requisição."
  }
}
```
```Text 401 - Não Autorizado
{
  "error_code": "unauthorized",
  "details": {
    "message": "Estabelecimento Comercial Não Cadastrado"
  }
}
```
```Text 500 - Erro Interno na Payment Card API
{
  "error_code": "internal_server_error",
  "details": {
    "message": "Erro no Sistema"
  }
}
```
```Text 502 - Response Code do Provider diferente de 200
{
  "error_code": "acquirer_bad_gateway",
  "details": {
    "message": "Erro de Conexão"
  }
}
```
```Text 503 - Erro de Rede na conexão com o Provider
{
  "error_code": "acquirer_service_unavailable",
  "details": {
    "message": "Serviço Indisponível"
  }
}
```
```Text 504 - Timeout no Provider
{
  "error_code": "acquirer_timeout",
  "details": {
    "message": "Erro de Conexão"
  }
}
```