---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Impressão de nota fiscal

Com uma simples integração via API, também é possível realizar impressões de notas fiscais e cupons após o pagamento de um pedido via POS integrado. Você pode saber mais em "Impressão de notas fiscais".

Abaixo está o fluxo de criação de pedido e impressão de NF-e:

[block:image]
{
  "images": [
    {
      "image": [
        "https://files.readme.io/9177cb1-fluxo_nfe.png",
        "fluxo_nfe.png",
        784,
        444,
        "#f8f8f8"
      ]
    }
  ]
}
[/block]

**Legenda**

1. Criação do pedido na API do Pagar.me (via PDV, inStore etc.)
2. POS recebe o pedido criado
3. POS realiza o pagamento de um pedido criado no Pagar.me passando pela adquirente
4. Adquirente envia resposta da transação para o POS e para o Pagar.me
5. Pagar.me envia webhook de pagamento realizado para o parceiro

***

Etapa Opcional
6\. Parceiro envia nota fiscal a ser impressa no POS
7\. POS recebe nota fiscal e a imprime, finalizando fluxo de pagamento

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
    "/posconnect/v1/orders/{order_id}/prints": {
      "post": {
        "summary": "Impressão de nota fiscal",
        "description": "",
        "operationId": "impressão-de-nota-fiscal",
        "parameters": [
          {
            "name": "order_id",
            "in": "path",
            "description": "Id do pedido (order_id) que será relacionado à nota fiscal enviada para impressão.",
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
                  "type",
                  "size_v",
                  "size_h",
                  "format",
                  "content"
                ],
                "properties": {
                  "type": {
                    "type": "string",
                    "description": "Tipo de documento impresso. Valores possíveis: \"NFE\", \"CUPOM\" ou \"RECEIPT\"."
                  },
                  "size_v": {
                    "type": "integer",
                    "description": "Tamanho da nota na vertical. Max: 1500 px.",
                    "format": "int32"
                  },
                  "size_h": {
                    "type": "integer",
                    "description": "Tamanho da nota na horizontal. 388 px.",
                    "format": "int32"
                  },
                  "format": {
                    "type": "string",
                    "description": "Formato do arquivo de imagem enviado em base64. Valores aceitos: ”png”, “jpg“ ou “jpeg“."
                  },
                  "content": {
                    "type": "string",
                    "description": "Imagem codificada em formato de texto seguindo o padrão base64."
                  }
                }
              },
              "examples": {
                "Requisição de impressão de NF": {
                  "value": {
                    "type": "NFE",
                    "size_v": "128",
                    "size_h": "384",
                    "format": "png",
                    "content": "A1b2cDefghiJkWlMn9PQrStUVABCDEFGHJISmansjdoas23aABCDEEFG="
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
                  "Requisição de impressão de NF": {
                    "value": ""
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
          },
          "409": {
            "description": "409",
            "content": {
              "text/plain": {
                "examples": {
                  "Result": {
                    "value": ""
                  }
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
  "_id": "6286b4313190d80013ab43df:628c1fefa90e860027da6102"
}
```