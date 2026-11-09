---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Obter Pedido

> ❗️ Atenção
>
> A rota de obter pedidos deve ser usada **apenas** em fluxos de resiliência.
>
> A aplicação integrada no Connect Pagar.me deve usar webhooks para tratar os cenários transacionais e receber de forma passiva as respostas.
>
> Caso a aplicação integre utilizando a rota de obter pedidos, está sujeita a limites de consulta que podem variar de acordo com o número de requisições, portanto, não é recomendado a integração neste endpoint para atualizar o fluxo transacional.

> ❗️ Rate Limit
>
> Nesse [link](https://docs.pagar.me/reference/rate-limit)detalhamos o limite de solicitações que podem ser feitas em um determinado tempo.

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
    "/core/v5/orders/{order_id}": {
      "get": {
        "summary": "Obter Pedido",
        "description": "",
        "operationId": "impressão-de-nota-fiscal-2",
        "parameters": [
          {
            "name": "order_ir",
            "in": "path",
            "description": "Id do pedido criado",
            "schema": {
              "type": "string"
            },
            "required": true
          }
        ],
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
  "_id": "676db46feacee90c0e1f01be:675c0cc8f3fe6200131e8e1f"
}
```