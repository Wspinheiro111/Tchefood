---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Impressão de Nota Fiscal

Dentro da integração com Connect Pagar.me temos a funcionalidade de impressão de NFe. Atenção: Não realizamos a geração da NFe, apenas impressão. Para ativar esta funcionalidade entre em contato com seu comercial responsável.

A impressão de NFe acontece dentro do fluxo transacional após a conclusão do pagamento, ou seja, atualmente não é possível realizar a impressão de forma avulsa.

OBS: A impressão acontece no formato de arquivo de imagem em Base64.

**Campos da requisição**

* **type:** Tipo de documento impresso. Valores possíveis: "NFE", "CUPOM" ou "RECEIPT".
* \*\*size\_v:\*\*Tamanho da nota na vertical. Max: 1500 px.
* \*\*size\_h:\*\*Tamanho da nota na horizontal. 388 px.
* \*\*format:\*\*Formato do arquivo de imagem enviado em base64. Valores aceitos: ”png”, “jpg“ ou “jpeg“.
* \*\*content:\*\*Imagem codificada em formato de texto seguindo o padrão base64.

> 📘 Reimpressão da NFE
>
> Caso precise realizar uma reimpressão da NFe que já foi impressa anteriormente, basta entrar no App de Reimpressão do POS e realizar o fluxo.

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
    "/posconnect/v1/orders/{order_id}/prints": {
      "post": {
        "summary": "Impressão de Nota Fiscal",
        "description": "",
        "operationId": "impressão-de-nota-fiscal-1",
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
  "_id": "676db46feacee90c0e1f01be:675c0c90ed1c0c0061310c80"
}
```