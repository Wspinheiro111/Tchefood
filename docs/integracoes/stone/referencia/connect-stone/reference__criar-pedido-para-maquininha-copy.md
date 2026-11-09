---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Criar pedido para maquininha

Para criar um pedido a ser pago no POS integrado você deve utilizar o endpoint de [Criar um pedido](https://docs.pagar.me/reference#criar-pedido-2).

Todos os pedidos criados em aberto (*closed*=*false*) e com a propriedade *poi_payment_settings* preenchida, serão enviados aos POSs integrados.

> ❗️ Tipo de parcelamento (installment\_type)
>
> Para o Connect Split o único tipo de parcelamento permitido é do tipo "merchant".
>
> merchant: o custo do parcelamento fica sob responsabilidade do estabelecimento. É o tipo mais comum de parcelamento.

> 🚧 Limitação de pagamentos no POS
>
> É importante ressaltar que não há limite de pagamentos para pedidos no fluxo de pagamento **Listagem de Pedidos**. Isso significa que o sistema do POS não restringe o operador em relação a quantidade de transações e em relação ao valor das transações por pedido, apenas se atentando que não é permitido uma pagamento que seja inferior a R$1,00
>
> Por exemplo, foi criado um pedido em aberto de R$ 5,00. Para esse pedido o operador do POS pode realizar 2 pagamentos de R$ 4,00, totalizando  R$ 8,00 pagos.
>
> O valor da transação por default no POS é sempre o valor total do pedido, mas o operador pode sobrescrever o valor default caso o comprador queira pagar de forma diferente. Isso garante uma maior flexibilidade no momento do pagamento.
>
> No fluxo de **Pagamento direto de pedidos**, o valor pago é **sempre** o valor total do pedido. O sistema não permite pagamentos de outros valores.

> 📘 Pagamento Direto
>
> Neste modelo de integração é **obrigatório** enviar os parâmetros no objeto de *payment\_setup*

<br />

> ❗️ IMPORTANTE
>
> Desde fev/26, todas as integrações devem ser atualizadas para o modelo de **SPLIT NA AUTORIZAÇÃO**.
>
> Ou seja, as regras de split devem ser enviadas, obrigatoriamente, no momento de criar o pedido via PDV.
>
> Veja mais informações de como enviar a requisição com as novas regras em "Criar pedido para maquininha" no menu do lado esquerdo da sua tela.

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
    "/core/v5/orders/": {
      "post": {
        "summary": "Criar pedido para maquininha",
        "description": "Para criar um pedido a ser pago no POS integrado você deve utilizar o endpoint de [Criar um pedido](https://docs.pagar.me/reference#criar-pedido-2).\n\nTodos os pedidos criados em aberto (*closed*=*false*) e com a propriedade *poi_payment_settings* preenchida, serão enviados aos POSs integrados.",
        "operationId": "criar-pedido-para-maquininha-copy",
        "parameters": [
          {
            "name": "ServiceRefererName",
            "in": "header",
            "description": "ID único de referencia da empresa parceria com o Stone Partner program. Consulte o seu com o time de Integrações ou seu Bizdev",
            "schema": {
              "type": "string",
              "default": "64d67ba05a4d5d6d0d6a43f5"
            }
          },
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
                    "properties": {
                      "Name": {
                        "type": "string",
                        "description": "Nome do cliente. Max: 64 caracteres.",
                        "default": "Nome do Cliente"
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
                          "type": "string",
                          "default": "1"
                        },
                        "code": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "amount"
                      ],
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
                        "description": "Tipo da transação a ser realizada pelo POS.  Se o campo for enviado vazio/nulo, o operador do POS irá poder selecionar o tipo de pagamento. Valores possíveis: (\"debit\" e \"credit\" (Disponível versão 6.4 do app de pagamentos))."
                      },
                      "installments": {
                        "type": "integer",
                        "description": "Define a quantidade de parcelas para compras com crédito. Campo obrigatório para *type*,*credit*,*pix*",
                        "format": "int32"
                      },
                      "installment_type": {
                        "type": "string",
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
                        "amount": 100,
                        "description": "Chaveiro do Tesseract",
                        "quantity": 1,
                        "code": "123"
                      }
                    ],
                    "closed": "false",
                    "poi_payment_settings": {
                      "visible": true,
                      "display_name": "Mesa 1",
                      "print_order_receipt": false,
                      "devices_serial_number": [
                        "PB0921C470442"
                      ],
                      "payment_setup": {
                        "type": "debit",
                        "installments": 1,
                        "installment_type": "merchant",
                        "split": [
                          {
                            "amount": 50,
                            "recipient_id": "re_cm5pr6n8802ba0l9tpggs0tp6",
                            "type": "flat",
                            "options": {
                              "liable": true,
                              "charge_remainder_fee": true,
                              "charge_processing_fee": true
                            }
                          },
                          {
                            "amount": 50,
                            "recipient_id": "re_cm5pgy35x1e6p0l9tiewsbra7",
                            "type": "flat",
                            "options": {
                              "liable": false,
                              "charge_remainder_fee": false,
                              "charge_processing_fee": false
                            }
                          }
                        ]
                      }
                    },
                    "customer": {
                      "name": "Tony Stark",
                      "email": "testes@gmail.com"
                    }
                  }
                },
                "Pagamento direto": {
                  "value": {
                    "items": [
                      {
                        "amount": 100,
                        "description": "Chaveiro do Tesseract",
                        "quantity": 1,
                        "code": "123"
                      }
                    ],
                    "closed": "false",
                    "poi_payment_settings": {
                      "visible": true,
                      "print_order_receipt": false,
                      "devices_serial_number": [
                        "PB0921C470442"
                      ],
                      "payment_setup": {
                        "type": "debit",
                        "installments": 1,
                        "installment_type": "merchant",
                        "split": [
                          {
                            "amount": 50,
                            "recipient_id": "re_cm5pr6n8802ba0l9tpggs0tp6",
                            "type": "flat",
                            "options": {
                              "liable": true,
                              "charge_remainder_fee": true,
                              "charge_processing_fee": true
                            }
                          },
                          {
                            "amount": 50,
                            "recipient_id": "re_cm5pgy35x1e6p0l9tiewsbra7",
                            "type": "flat",
                            "options": {
                              "liable": false,
                              "charge_remainder_fee": false,
                              "charge_processing_fee": false
                            }
                          }
                        ]
                      }
                    },
                    "customer": {
                      "name": "Tony Stark",
                      "email": "testes@gmail.com"
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
  "_id": "676db46feacee90c0e1f01be:67646a606d460d0054eb9617"
}
```