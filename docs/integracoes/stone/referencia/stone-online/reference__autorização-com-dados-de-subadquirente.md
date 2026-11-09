---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização com dados de sublojistas

# Introdução

Conforme a regra das bandeiras, as transações de subadquirentes devem conter dados do lojista que realizou a transação. Para isso, utiliza-se o objeto `sub_merchant`(Contém os dados de sublojista/sub-merchant) dentro de `Charge` (Traz contexto para a venda).

## Objeto sub\_merchant

[block:parameters]
{
  "data": {
    "h-0": "Campo",
    "h-1": "Tipo",
    "h-2": "Tamanho",
    "h-3": "Descrição",
    "0-0": "`id`",
    "0-1": "string",
    "0-2": "-",
    "0-3": "Identificador do sublojista atribuído pela Subadquirente",
    "1-0": "`name`",
    "1-1": "string",
    "1-2": "-",
    "1-3": "Nome Fantasia do sublojista",
    "2-0": "`legal_name`",
    "2-1": "string",
    "2-2": "-",
    "2-3": "Razão Social do sublojista",
    "3-0": "`document`",
    "3-1": "string",
    "3-2": "14",
    "3-3": "Documento do sublojista cadastrado com a adquirente, sem separadores.",
    "4-0": "`document_type`",
    "4-1": "string",
    "4-2": "-",
    "4-3": "Tipo de documento usado no cadastro com a adquirente  \n**Valores possiveis:** [ cpf, cnpj, passport ]",
    "5-0": "`email`",
    "5-1": "string",
    "5-2": "-",
    "5-3": "Endereço eletrônico do sublojista",
    "6-0": "`phone_number`",
    "6-1": "string",
    "6-2": "-",
    "6-3": "Número de telefone do sublojista",
    "7-0": "`site`",
    "7-1": "string",
    "7-2": "-",
    "7-3": "Endereço do ecommerce do sublojista",
    "8-0": "`address`",
    "8-1": "container",
    "8-2": "-",
    "8-3": "Endereço de cobrança do sublojista"
  },
  "cols": 4,
  "rows": 9,
  "align": [
    "left",
    "left",
    "left",
    "left"
  ]
}
[/block]

## Objeto address

| Campo          | Tipo   | Tamanho  | Descrição                                                                                             |
| :------------- | :----- | :------- | :---------------------------------------------------------------------------------------------------- |
| `street`       | string | ans 3-11 | Rua do endereço (mínimo de 3 e máximo de 90 caracteres)                                               |
| `number`       | string | -        | Número do endereço                                                                                    |
| `complement`   | string | -        | Campo para adicionar informações complementares do endereço.                                          |
| `city`         | string | -        | Cidade do endereço                                                                                    |
| `district`     | string | -        | Bairro do endereço                                                                                    |
| `state`        | string | a-2      | Estado do endereço (sigla)                                                                            |
| `country_code` | string | -        | Codigo do pais. Padrão ISO 3166. Quando não informado será considerado o valor default "076" (Brasil) |
| `zip_code`     | string | -        | Código postal do endereço, sem separadores ou espaçamento                                             |

Além dos dados recebidos nesse container, há dois campos que precisam ser populadas com dados do sublojista, são elas:

* `statement_descriptor` - Nome que irá na fatura do portador, junto ao identificador da subadquirente já cadastrado na Stone. Importante: o identificador da subadquirente não precisa ser enviado na requisição.
  * Para transações da bandeira **Mastercard** será necessário identificar na autorização, se o estabelecimento comercial faz parte do seguimento de casas de câmbio. (Exemplo: nomedomerchant\*cambio)
* `merchant_category_code` - MCC (merchant category code) do sub-merchant (corresponde ao tipo de atividade do CNAE do sub-merchant).

## Request

Abaixo está um exemplo de uma transação com dados de sublojista e suas respostas.

```json Request
{
  "amount": 1000,
  "initiator_id": "6c581baae0df4cb6",
  "local_datetime": "2024-04-10T15:46:47",
  "payment_method": "card",
  "channel": "website",
  "card_transaction": {
    "type": "credit",
    "operation_type": "auth_and_capture",
    "statement_descriptor": "loja ecommerce",
    "card": {
      "entry_mode": "manual",
      "expiration_date": "5012",
      "number": "6033401111633077000",
      "track_2": "6033401111633077000=31116000018400040",
      "holder_name": "TONY STARK"
    },
    "merchant_category_code": 5818
  },
  "sub_merchant": {
    "id": "254759",
    "name": "Mkt*subloja",
    "legal_name": "subloja LTDA",
    "document": "02326943001",
    "document_type": "cnpj",
    "email": "email@email.com",
    "phone_number": "+551130041234",
    "address": {
      "street": "Rua Presidente Getúlio Vargas",
      "number": "123",
      "complement": "2ª andar - sala 1",
      "state": "SC",
      "city": "Porto Alegre",
      "country_code": "076",
      "zip_code": "90050000"
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