---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Cancelamento de Cobrança

O estorno da transação é a devolução do valor para o consumidor final. Neste caso, para que uma cobrança seja estornada utilize a rota abaixo.

**Estorno via POS**

O cliente pode realizar o estorno (cancelamento) de uma transação também diretamente via POS, pelo **App de Cancelamento**. Ponto importante: Neste modo, o estorno é total, não é possível estorno parcial da transação.\
Para saber mais o passo-a-passo [consulte aqui](https://ajuda.stone.com.br/maquininha-e-tef/como-funciona-o-cancelamento-de-venda?from_search=116560434.).

**OBS**: Após o cancelamento de uma transação, vocês recebem o webhook de **charge.refunded**, e com esta informação conseguem realizar a conciliação e a baixa necessária dentro do sistema

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
    "https://api.pagar.me/core/v5/charges/{charge_id}": {
      "delete": {
        "summary": "Cancelamento de Cobrança",
        "description": "",
        "operationId": "cancelamento-de-pedido-1",
        "parameters": [
          {
            "name": "charge_id",
            "in": "path",
            "description": "Código da cobrança.",
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
                "properties": {
                  "amount": {
                    "type": "integer",
                    "description": "Valor a ser cancelado. Caso não seja informado, será considerado o valor total da cobrança.",
                    "format": "int32"
                  },
                  "split": {
                    "type": "array",
                    "description": "Lista de regras de split.",
                    "items": {
                      "properties": {
                        "amount": {
                          "type": "integer",
                          "description": "Valor destinado ao recebedor.",
                          "default": 100,
                          "format": "int32"
                        },
                        "recipient_id": {
                          "type": "string",
                          "description": "Código do recebedor. Formato: re_XXXXXXXXXXXXXXXX."
                        },
                        "type": {
                          "type": "string",
                          "description": "Tipo de divisão. Os valores possíveis são flat ou percentage"
                        },
                        "options": {
                          "type": "array",
                          "description": "Informações da responsabilidade do recebedor na transação.",
                          "items": {
                            "properties": {
                              "charge_processing_fee": {
                                "type": "boolean",
                                "description": "Indica se o recebedor vinculado à regra será cobrado pelas taxas da transação"
                              },
                              "charge_remainder_fee": {
                                "type": "boolean",
                                "description": "Indica se o recebedor vinculado à regra irá receber o restante dos recebíveis após uma divisão"
                              },
                              "liable": {
                                "type": "boolean",
                                "description": "Indica se o recebedor é responsável pela transação em caso de chargeback."
                              }
                            },
                            "type": "object"
                          }
                        }
                      },
                      "type": "object"
                    }
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
  "_id": "676db46feacee90c0e1f01be:675c0cea7f4102003fe6c3a0"
}
```