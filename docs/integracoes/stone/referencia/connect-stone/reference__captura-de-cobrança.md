---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# [DESCONTINUADO] Captura de Cobrança

> ❗️ IMPORTANTE
>
> Desde fev/26, todas as integrações devem ser atualizadas para o modelo de **SPLIT NA AUTORIZAÇÃO**.
>
> Ou seja, as regras de split devem ser enviadas, obrigatoriamente, no momento de criar o pedido via PDV.
>
> Veja mais informações de como enviar a requisição com as novas regras em "Criar pedido para maquininha" no menu do lado esquerdo da sua tela.

<br />

Após o recebimento do **webhook** de **charge.pending**, é necessário o envio da captura da cobrança passando as regras de split e os recebedores.

> 🚧 Atenção: Tempo para captura de uma transação
>
> Seu sistema tem até 05 dias, contando o dia da autorização, para solicitar o processo de captura através desta rota. Caso não execute a operação, nossa API faz automaticamente o cancelamento do processo de autorização e sinaliza o *status\_reason* da transação como *capture\_timeout*.
>
> **Obs: Apenas para visa a captura deve ocorrer em 04 dias**

<br />

**Campos da requisição**

* **Recipient\_id:** ID de identificação dos recebedores na account.
* **Type:** Tipo de divisão do split, pode ser em percentual ou valor. Percentagem ou Flat.
* **Charge\_processing\_fee:** Indica se o recebedor vinculado à regra será cobrado pelas taxas da transação.
* **Charge\_remainder\_fee:** Indica se o recebedor vinculado à regra irá receber o restante dos recebíveis após uma divisão.
* **Liable:** Indica se o recebedor é responsável pela transação em caso de chargeback.

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
    "/core/v5/charges/{charge_id}/capture": {
      "post": {
        "summary": "[DESCONTINUADO] Captura de Cobrança",
        "description": "",
        "operationId": "captura-de-cobrança",
        "parameters": [
          {
            "name": "Authorization",
            "in": "header",
            "description": "Sua chave SK criptografada com o Basic Auth",
            "schema": {
              "type": "string",
              "default": "Basic c2tfbnhMMm94bWMxaFk3WHJENzo="
            }
          },
          {
            "name": "Content-Type",
            "in": "header",
            "schema": {
              "type": "string",
              "default": "application/json"
            }
          },
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
                    "description": "Valor a ser capturado. Caso não seja informado, será considerado o valor total da cobrança.",
                    "default": 1990,
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
  "_id": "676db46feacee90c0e1f01be:675c0c682bb0fb001886a928"
}
```