---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Fechamento de um pedido

Para fechar um pedido que foi enviado ao POS você deve utilizar o endpoint de fechamento de pedidos.

Todos os pedido fechados, com propriedade *closed*=*true*, não irão aparecer nos POSs integrados.

[block:callout]
{
  "type": "warning",
  "body": "O parceiro deve sempre fechar um pedidos após a confirmação de pagamento do mesmo via webhook. Caso o pedido não seja fechado, a maquininha pode parar de exibir novos pedidos.",
  "title": "Atenção"
}
[/block]

Quando um pedido é fechado ele é automaticamente retirado da lista de pedidos do POS. O parceiro poderá fechar um pedido **a qualquer momento** se não quiser que o mesmo seja pago/visível para o POS.

[block:callout]
{
  "type": "danger",
  "title": "Limite de pedidos",
  "body": "Existe um limite de 30 pedidos em abertos para a integração com o POS."
}
[/block]

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
    "/core/v5/orders/{order_id}/closed": {
      "patch": {
        "summary": "Fechamento de um pedido",
        "description": "",
        "operationId": "fechamento-de-um-pedido",
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
                    "description": "Status final do pedido. Valores possíveis: **paid**, **canceled** ou **failed**. Caso não enviado, valor default será **paid**.",
                    "default": "paid"
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
  "_id": "6286b4313190d80013ab43df:628c1c5597f9f0009cc91264"
}
```