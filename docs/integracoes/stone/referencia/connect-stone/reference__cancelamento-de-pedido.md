---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Cancelamento de pedido

Para cancelar um pedido que foi enviado ao POS você deve utilizar o endpoint de fechamento de pedidos.

O cancelamento pode ser feito quando o pagamento ainda não foi realizado. Após cancelar o pedido via rota da API, ele é automaticamente retirado do POS após 1 minuto quando os status dos pedidos são atualizados pelo terminal.

Para que ele saia do terminal antes desse tempo, basta **apertar o "X" vermelho no terminal**.

> ❗️ FECHAR O PEDIDO ≠ CANCELAR O PAGAMENTO
>
> Cancelar um objeto Order (Pedido) apenas impede que novos pagamentos sejam iniciados para ele. Isso NÃO cancela e NÃO estorna automaticamente as Charges (Cobranças) que já foram capturadas e aprovadas.

> ❗️ Estorno de pedido
>
> Estorno do pedido é a devolução do valor para o consumidor final. Neste caso, atualmente não temos uma rota da API para realizar este passo, ele é **feito ou via POS ou via Portal Stone**.
>
> Para saber mais dos passos para estorno de transação: [acesse aqui](https://ajuda.stone.com.br/maquininha-e-tef/como-funciona-o-cancelamento-de-venda?from_search=109111127).

# OpenAPI definition

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "Connect 2.0",
    "version": "1.0"
  },
  "servers": [
    {
      "url": "https://api.pagar.me"
    }
  ],
  "security": [
    {}
  ],
  "paths": {
    "/core/v5/orders/{order_id}/closed/": {
      "patch": {
        "summary": "Cancelamento de pedido",
        "description": "",
        "operationId": "cancelamento-de-pedido",
        "parameters": [
          {
            "name": "order_id",
            "in": "path",
            "description": "Id do pedido criado a ser fechado.",
            "schema": {
              "type": "string"
            },
            "required": true
          }
        ],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "status"
                ],
                "properties": {
                  "status": {
                    "type": "string",
                    "description": "Status final do pedido. **canceled**",
                    "default": "canceled"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "200",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": "{\n  \"id\": \"or_koMvlQOTMCb9dpPO\",\n  \"code\": \"O8YDFPZUM3\",\n  \"amount\": 2990,\n  \"currency\": \"BRL\",\n  \"closed\": true,\n  \"items\": [\n    {\n      \"id\": \"oi_jkW1MBc9MtKdzK20\",\n      \"description\": \"Item 1\",\n      \"amount\": 2990,\n      \"quantity\": 1,\n      \"status\": \"active\",\n      \"created_at\": \"2017-06-06T16:03:41Z\",\n      \"updated_at\": \"2017-06-06T16:03:41Z\"\n    }\n  ],\n  \"customer\": {\n    \"id\": \"cus_mBloKMLnswtD4O3a\",\n    \"name\": \"Cliente 1\",\n    \"email\": \"email@email.com\",\n    \"delinquent\": false,\n    \"created_at\": \"2016-10-07T19:50:39Z\",\n    \"updated_at\": \"2017-06-06T16:03:40Z\",\n    \"phones\": {},\n  },\n  \"status\": \"paid\",\n  \"created_at\": \"2017-06-06T16:03:40Z\",\n  \"updated_at\": \"2017-06-06T16:03:40Z\",\n  \"closed_at\": \"2017-06-06T16:03:47Z\"\n}"
                  }
                }
              }
            }
          },
          "400": {
            "description": "400",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": "{}"
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {}
                }
              }
            }
          }
        },
        "deprecated": false
      }
    }
  },
  "x-readme": {
    "headers": [],
    "explorer-enabled": true,
    "proxy-enabled": false
  },
  "x-readme-fauxas": true,
  "_id": "6286b4313190d80013ab43df:64f86d281565e8000d47852b"
}
```