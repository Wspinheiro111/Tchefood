---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Respostas de erro

# Introdução

Em caso de resposta de erros durante a utilização da API, os códigos e responses abaixo podem ser vistos.

| StatusCode | Nome                | Descrição                                        |
| :--------- | :------------------ | :----------------------------------------------- |
| **400**    | BadRequest          | A depender da falta de parametro enviado         |
| **401**    | Unauthorized        | Estabelecimento Comercial Não Cadastrado         |
| **500**    | InternalServerError | Erro inesperado.                                 |
| **502**    | BadGateway          | Erro no provedor durante a execução da operação. |
| **503**    | ServiceUnavailable  | Erro de comunicação com o provedor.              |
| **504**    | GatewayTimeout      | Timeout na comunicação com o provedor.           |

## Responses

```json 400	- BadRequest
{
  "error_code": "api_400",
  "details": {
    "message": "Transação Inválida",
    "description": "Headers obrigatórios não foram informados na requisição."
  }
}
```
```json 401 - Unauthorized
{
  "error_code": "unauthorized",
  "details": {
    "message": "Estabelecimento Comercial Não Cadastrado"
  }
}
```
```json 500 - InternalServerError
{
  "error_code": "internal_server_error",
  "details": {
    "message": "Erro no Sistema"
  }
}
```
```json 502 - BadGateway
{
  "error_code": "acquirer_bad_gateway",
  "details": {
    "message": "Erro de Conexão"
  }
}
```
```json 503 - ServiceUnavailable
{
  "error_code": "acquirer_service_unavailable",
  "details": {
    "message": "Serviço Indisponível"
  }
}
```
```json 504 - GatewayTimeout
{
  "error_code": "acquirer_timeout",
  "details": {
    "message": "Erro de Conexão"
  }
}
```