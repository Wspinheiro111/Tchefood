---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Fechamento de Pedido

Para fechar um pedido que foi enviado ao POS você deve utilizar o endpoint de fechamento de pedidos.

Todos os pedido fechados, com propriedade *closed*=*true*, não irão aparecer nos POSs integrados.

> 🚧 Atenção
>
> O parceiro deve sempre fechar um pedidos após a confirmação de pagamento do mesmo via webhook. Caso o pedido não seja fechado, a maquininha pode parar de exibir novos pedidos.

Quando um pedido é fechado ele é automaticamente retirado da lista de pedidos do POS. O parceiro poderá fechar um pedido **a qualquer momento** se não quiser que o mesmo seja pago/visível para o POS, basta enviar a requisição alterando seu status para **canceled**.

> ❗️ Limite de pedidos
>
> Existe um limite de 30 pedidos em abertos para a integração com o POS.

# OpenAPI definition

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "Connect Split",
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
        "summary": "Fechamento de Pedido",
        "description": "",
        "operationId": "fechamento-de-pedido",
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
                    "value": "{}"
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {}
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
  "_id": "676db46feacee90c0e1f01be:675c0c7a337de900342b6822"
}
```