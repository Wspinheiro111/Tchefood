---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Criar pedido para maquininha

Para iniciar uma transação em um terminal integrado, você deve utilizar o endpoint de criação de pedido. Este comando enviará as informações da venda para a POS.

## Requisitos Obrigatórios

Para que um pedido seja visível e processável pelo POS, ele deve conter obrigatoriamente:

* **closed: false**: O pedido deve ser criado como "aberto".
* **poi\_payment\_settings**: Este objeto deve estar preenchido para habilitar o fluxo no terminal.
* **ServiceRefererName**: Identificador da integração.

> 📘 ServiceRefererName
>
> O campo ServiceRefererName é **essencial para a rastreabilidade** e identificação da origem da requisição dentro do ecossistema Stone/Pagar.me.
>
> Onde extrair o valor: Este valor é o identificador único do parceiro definido durante o processo de homologação/cadastro no Partner Hub.
>
> Importância: Sem este campo preenchido corretamente, a requisição pode ser rejeitada ou não ser roteada adequadamente para os terminais vinculados ao seu Stone Code.

> 📘 Tipo de parcelamento (installment\_type)
>
> merchant: o custo do parcelamento fica sob responsabilidade do estabelecimento. É o tipo mais comum de parcelamento.
>
> issuer: o custo do parcelamento é definido pelo emissor do cartão do portador. Para mais informações, [sobre juros emissor](https://ajuda.stone.com.br/maquininha-e-tef/parcelado-com-juros-emissor?from_search=97684595).
>
> Para utilizar o juros parcelado pelo emissor é preciso primeiro ativar a opção nos ajustes da maquininha.

> 🚧 Limitação de pagamentos no POS
>
> É importante ressaltar que não há limite de pagamentos para pedidos no fluxo de pagamento **Listagem de Pedidos**. Isso significa que o sistema do POS não restringe o operador em relação a quantidade de transações e em relação ao valor das transações por pedido.
>
> Por exemplo, foi criado um pedido em aberto de R$ 5,00. Para esse pedido o operador do POS pode realizar 2 pagamentos de R$ 4,00, totalizando  R$ 8,00 pagos.
>
> O valor da transação por default no POS é sempre o valor total do pedido, mas o operador pode sobrescrever o valor default caso o comprador queira pagar de forma diferente. Isso garante uma maior flexibilidade no momento do pagamento.
>
> No fluxo de **Pagamento direto de pedidos**, o valor pago é **sempre** o valor total do pedido. O sistema não permite pagamentos de outros valores.

> 📘 Pagamento Direto
>
> Neste modelo de integração é **obrigatório** enviar os parâmetros no objeto de *payment\_setup*. Veja exemplo [Aqui](https://connect-stone.stone.com.br/reference/pedido-direto)!

> ❗️ Cartão Banricompras
>
> Sugerimos restringir a aceitação da bandeira Banricompras.

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
    "/core/v5/orders/": {
      "post": {
        "summary": "Criar pedido para maquininha",
        "description": "",
        "operationId": "criar-pedido",
        "parameters": [
          {
            "name": "ServiceRefererName",
            "in": "header",
            "description": "ID único de referencia da empresa parceria com o Stone Partner program. Consulte o seu com o time de Integrações ou seu Bizdev",
            "required": true,
            "schema": {
              "type": "string",
              "default": "64d67ba05a4d5d6d0d6a43f5"
            }
          },
          {
            "name": "Authorization",
            "in": "header",
            "description": "Sua chave SK criptografada com o Basic Auth",
            "required": true,
            "schema": {
              "type": "string",
              "default": "Basic c2tfbnhMMm94bWMxaFk3WHJENzo="
            }
          },
          {
            "name": "Content-Type",
            "in": "header",
            "required": true,
            "schema": {
              "type": "string",
              "default": "application/json"
            }
          }
        ],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "customer",
                  "items",
                  "closed",
                  "poi_payment_settings"
                ],
                "properties": {
                  "customer": {
                    "type": "object",
                    "description": "Dados do cliente. Para mais informações [Criar um customer](https://docs.pagar.me/reference#criar-cliente-1)",
                    "required": [
                      "name"
                    ],
                    "properties": {
                      "name": {
                        "type": "string",
                        "description": "Nome do cliente. Max: 64 caracteres."
                      },
                      "email": {
                        "type": "string",
                        "description": "E-mail do cliente. Max: 64 caracteres"
                      }
                    }
                  },
                  "items": {
                    "type": "array",
                    "description": "Itens do pedido.",
                    "items": {
                      "properties": {
                        "amount": {
                          "type": "integer",
                          "description": "Valor unitário.",
                          "default": 1990,
                          "format": "int32"
                        },
                        "description": {
                          "type": "string",
                          "description": "Descrição do item.",
                          "default": "Chaveiro do Tesseract"
                        },
                        "quantity": {
                          "type": "integer",
                          "default": 1,
                          "format": "int32"
                        },
                        "code": {
                          "type": "string",
                          "description": "Código do item no sistema da loja."
                        }
                      },
                      "type": "object"
                    }
                  },
                  "closed": {
                    "type": "boolean",
                    "description": "Informa se o pedido será criado **aberto** ou **fechado**. Pare o pedido aparecer no POS, é preciso que o pedido seja criado aberto.",
                    "default": false
                  },
                  "poi_payment_settings": {
                    "type": "object",
                    "description": "Objeto que contém as informações de transações necessárias para pedidos pagos na maquininha (POS).",
                    "properties": {
                      "type": {
                        "type": "string",
                        "description": "Tipo da transação a ser realizada pelo POS.  Se o campo for enviado vazio/nulo, o operador do POS irá poder selecionar o tipo de pagamento. Valores possíveis: (\"debit\", \"credit\", \"voucher\" e \"pix (Disponível versão 6.4 do app de pagamentos))."
                      },
                      "installments": {
                        "type": "integer",
                        "description": "Define a quantidade de parcelas para compras com crédito. Campo obrigatório para *type*,*credit*,*pix*",
                        "format": "int32"
                      },
                      "installment_type": {
                        "type": "string",
                        "description": "Define o tipo do parcelamento a ser realizada pelo POS. Valores possíveis (\"merchant\" ou (\"issuer\").",
                        "default": "merchant"
                      }
                    }
                  }
                }
              },
              "examples": {
                "Listagem de pedidos": {
                  "value": {
                    "items": [
                      {
                        "amount": 400,
                        "description": "Produto 1",
                        "quantity": 1
                      }
                    ],
                    "customer": {
                      "name": "exemplo",
                      "email": "exemplo1@exemplo.com"
                    },
                    "closed": "false",
                    "poi_payment_settings": {
                      "visible": true,
                      "display_name": "Mesa 1",
                      "print_order_receipt": true,
                      "devices_serial_number": [
                        "a98765-4321",
                        "b98763-54322"
                      ]
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
                  "Listagem de pedidos": {
                    "value": "{\n    \"id\": \"or_3yqQpAbfBhlzgpY5\",\n    \"code\": \"WXQV9A5BOR\",\n    \"amount\": 400,\n    \"currency\": \"BRL\",\n    \"closed\": false,\n    \"items\": [\n        {\n            \"id\": \"oi_4nmqZgDu1hGVk1Al\",\n            \"type\": \"product\",\n            \"description\": \"Produto 1\",\n            \"amount\": 400,\n            \"quantity\": 1,\n            \"status\": \"active\",\n            \"created_at\": \"2021-09-09T19:19:29Z\",\n            \"updated_at\": \"2021-09-09T19:19:29Z\"\n        }\n    ],\n    \"customer\": {\n        \"id\": \"cus_75zwoLsn3U1paBqK\",\n        \"name\": \"exemplo\",\n        \"email\": \"exemplo1@exemplo.com\",\n        \"delinquent\": false,\n        \"created_at\": \"2021-09-09T19:19:29Z\",\n        \"updated_at\": \"2021-09-09T19:19:29Z\",\n        \"phones\": {}\n    },\n    \"status\": \"pending\",\n    \"created_at\": \"2021-09-09T19:19:29Z\",\n    \"updated_at\": \"2021-09-09T19:19:29Z\",\n    \"poi_payment_settings\": {\n        \"visible\": true,\n        \"display_name\": \"Mesa 1\",\n        \"print_order_receipt\": true,\n        \"devices_serial_number\": [\n            \"a98765-4321\",\n            \"b98763-54322\"\n        ],\n        \"updated_at\": \"2021-09-09T19:19:29Z\",\n        \"created_at\": \"2021-09-09T19:19:29Z\"\n    }\n}"
                  },
                  "Pagamento Direto": {
                    "value": "{\n    \"id\": \"or_Zw1n0zSWQuOBYRPE\",\n    \"code\": \"8YQEH1T0ZR\",\n    \"amount\": 400,\n    \"currency\": \"BRL\",\n    \"closed\": false,\n    \"items\": [\n        {\n            \"id\": \"oi_Qq4Z1D2HOfqnO2D6\",\n            \"type\": \"product\",\n            \"description\": \"Produto 1\",\n            \"amount\": 400,\n            \"quantity\": 1,\n            \"status\": \"active\",\n            \"created_at\": \"2021-09-09T19:21:04Z\",\n            \"updated_at\": \"2021-09-09T19:21:04Z\"\n        }\n    ],\n    \"customer\": {\n        \"id\": \"cus_75zwoLsn3U1paBqK\",\n        \"name\": \"exemplo\",\n        \"email\": \"exemplo1@exemplo.com\",\n        \"delinquent\": false,\n        \"created_at\": \"2021-09-09T19:19:29Z\",\n        \"updated_at\": \"2021-09-09T19:19:29Z\",\n        \"phones\": {}\n    },\n    \"status\": \"pending\",\n    \"created_at\": \"2021-09-09T19:21:04Z\",\n    \"updated_at\": \"2021-09-09T19:21:04Z\",\n    \"poi_payment_settings\": {\n        \"visible\": true,\n        \"display_name\": \"Mesa 1\",\n        \"print_order_receipt\": true,\n        \"payment_setup\": {\n            \"type\": \"credit\",\n            \"installments\": 6,\n            \"installment_type\": \"merchant\"\n        },\n        \"devices_serial_number\": [\n            \"a98765-4321\"\n        ],\n        \"updated_at\": \"2021-09-09T19:21:04Z\",\n        \"created_at\": \"2021-09-09T19:21:04Z\"\n    }\n}"
                  }
                },
                "schema": {
                  "oneOf": [
                    {
                      "title": "Listagem de pedidos",
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "example": "or_3yqQpAbfBhlzgpY5"
                        },
                        "code": {
                          "type": "string",
                          "example": "WXQV9A5BOR"
                        },
                        "amount": {
                          "type": "integer",
                          "example": 400,
                          "default": 0
                        },
                        "currency": {
                          "type": "string",
                          "example": "BRL"
                        },
                        "closed": {
                          "type": "boolean",
                          "example": false,
                          "default": true
                        },
                        "items": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "example": "oi_4nmqZgDu1hGVk1Al"
                              },
                              "type": {
                                "type": "string",
                                "example": "product"
                              },
                              "description": {
                                "type": "string",
                                "example": "Produto 1"
                              },
                              "amount": {
                                "type": "integer",
                                "example": 400,
                                "default": 0
                              },
                              "quantity": {
                                "type": "integer",
                                "example": 1,
                                "default": 0
                              },
                              "status": {
                                "type": "string",
                                "example": "active"
                              },
                              "created_at": {
                                "type": "string",
                                "example": "2021-09-09T19:19:29Z"
                              },
                              "updated_at": {
                                "type": "string",
                                "example": "2021-09-09T19:19:29Z"
                              }
                            }
                          }
                        },
                        "customer": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "string",
                              "example": "cus_75zwoLsn3U1paBqK"
                            },
                            "name": {
                              "type": "string",
                              "example": "exemplo"
                            },
                            "email": {
                              "type": "string",
                              "example": "exemplo1@exemplo.com"
                            },
                            "delinquent": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            },
                            "created_at": {
                              "type": "string",
                              "example": "2021-09-09T19:19:29Z"
                            },
                            "updated_at": {
                              "type": "string",
                              "example": "2021-09-09T19:19:29Z"
                            },
                            "phones": {
                              "type": "object",
                              "properties": {}
                            }
                          }
                        },
                        "status": {
                          "type": "string",
                          "example": "pending"
                        },
                        "created_at": {
                          "type": "string",
                          "example": "2021-09-09T19:19:29Z"
                        },
                        "updated_at": {
                          "type": "string",
                          "example": "2021-09-09T19:19:29Z"
                        },
                        "poi_payment_settings": {
                          "type": "object",
                          "properties": {
                            "visible": {
                              "type": "boolean",
                              "example": true,
                              "default": true
                            },
                            "display_name": {
                              "type": "string",
                              "example": "Mesa 1"
                            },
                            "print_order_receipt": {
                              "type": "boolean",
                              "example": true,
                              "default": true
                            },
                            "devices_serial_number": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "example": "a98765-4321"
                              }
                            },
                            "updated_at": {
                              "type": "string",
                              "example": "2021-09-09T19:19:29Z"
                            },
                            "created_at": {
                              "type": "string",
                              "example": "2021-09-09T19:19:29Z"
                            }
                          }
                        }
                      }
                    },
                    {
                      "title": "Pagamento Direto",
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "example": "or_Zw1n0zSWQuOBYRPE"
                        },
                        "code": {
                          "type": "string",
                          "example": "8YQEH1T0ZR"
                        },
                        "amount": {
                          "type": "integer",
                          "example": 400,
                          "default": 0
                        },
                        "currency": {
                          "type": "string",
                          "example": "BRL"
                        },
                        "closed": {
                          "type": "boolean",
                          "example": false,
                          "default": true
                        },
                        "items": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "example": "oi_Qq4Z1D2HOfqnO2D6"
                              },
                              "type": {
                                "type": "string",
                                "example": "product"
                              },
                              "description": {
                                "type": "string",
                                "example": "Produto 1"
                              },
                              "amount": {
                                "type": "integer",
                                "example": 400,
                                "default": 0
                              },
                              "quantity": {
                                "type": "integer",
                                "example": 1,
                                "default": 0
                              },
                              "status": {
                                "type": "string",
                                "example": "active"
                              },
                              "created_at": {
                                "type": "string",
                                "example": "2021-09-09T19:21:04Z"
                              },
                              "updated_at": {
                                "type": "string",
                                "example": "2021-09-09T19:21:04Z"
                              }
                            }
                          }
                        },
                        "customer": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "string",
                              "example": "cus_75zwoLsn3U1paBqK"
                            },
                            "name": {
                              "type": "string",
                              "example": "exemplo"
                            },
                            "email": {
                              "type": "string",
                              "example": "exemplo1@exemplo.com"
                            },
                            "delinquent": {
                              "type": "boolean",
                              "example": false,
                              "default": true
                            },
                            "created_at": {
                              "type": "string",
                              "example": "2021-09-09T19:19:29Z"
                            },
                            "updated_at": {
                              "type": "string",
                              "example": "2021-09-09T19:19:29Z"
                            },
                            "phones": {
                              "type": "object",
                              "properties": {}
                            }
                          }
                        },
                        "status": {
                          "type": "string",
                          "example": "pending"
                        },
                        "created_at": {
                          "type": "string",
                          "example": "2021-09-09T19:21:04Z"
                        },
                        "updated_at": {
                          "type": "string",
                          "example": "2021-09-09T19:21:04Z"
                        },
                        "poi_payment_settings": {
                          "type": "object",
                          "properties": {
                            "visible": {
                              "type": "boolean",
                              "example": true,
                              "default": true
                            },
                            "display_name": {
                              "type": "string",
                              "example": "Mesa 1"
                            },
                            "print_order_receipt": {
                              "type": "boolean",
                              "example": true,
                              "default": true
                            },
                            "payment_setup": {
                              "type": "object",
                              "properties": {
                                "type": {
                                  "type": "string",
                                  "example": "credit"
                                },
                                "installments": {
                                  "type": "integer",
                                  "example": 6,
                                  "default": 0
                                },
                                "installment_type": {
                                  "type": "string",
                                  "example": "merchant"
                                }
                              }
                            },
                            "devices_serial_number": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "example": "a98765-4321"
                              }
                            },
                            "updated_at": {
                              "type": "string",
                              "example": "2021-09-09T19:21:04Z"
                            },
                            "created_at": {
                              "type": "string",
                              "example": "2021-09-09T19:21:04Z"
                            }
                          }
                        }
                      }
                    }
                  ]
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
  "_id": "6286b4313190d80013ab43df:628c0c7066c376001acbfd32"
}
```