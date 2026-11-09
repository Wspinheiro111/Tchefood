---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Consulta de transações

Consulta (sonda) de Charges.<br> É obrigatório que ao menos um dos dois parâmetros de identificação da cobrança seja informado (`ids` ou `initiator_ids`).<br> Se os dois forem informados, será usado o identificador da charge.

# OpenAPI definition

```json
{
  "openapi": "3.0.3",
  "info": {
    "title": "Payments - Processing - Acquiring - PaymentCardApi",
    "version": "1.0"
  },
  "servers": [
    {
      "url": "https://payments.stone.com.br/v1",
      "description": "Payment API Production Server"
    }
  ],
  "tags": [
    {
      "name": "Charges"
    }
  ],
  "paths": {
    "/charges": {
      "get": {
        "tags": [
          "Charges"
        ],
        "description": "Consulta (sonda) de Charges.<br> É obrigatório que ao menos um dos dois parâmetros de identificação da cobrança seja informado (`ids` ou `initiator_ids`).<br> Se os dois forem informados, será usado o identificador da charge.<br><br> A autenticação no endpoint é feita da seguinte forma:\n  * **Bearer Token Authorization**: Token JWT.\n",
        "security": [
          {
            "bearer_auth": []
          }
        ],
        "parameters": [
          {
            "name": "Host",
            "in": "header",
            "description": "Domínio utilizado para processar a requisição. Neste caso, determina o ambiente do serviço, podendo  ter os valores:\n  * `payments.stone.com.br`: ambiente produtivo\n  * `sdx-payments.stone.com.br`: ambiente de sandbox (pré-produção)\n",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "ids",
            "in": "query",
            "description": "Identificador(es) da(s) charge(s). Obrigatório caso não haja o parâmetro `initiator_ids`",
            "required": true,
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "initiator_ids",
            "in": "query",
            "description": "Identificador(es) externo(s).  Obrigatório caso não haja o parâmetro `ids`",
            "required": true,
            "schema": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          {
            "name": "with_details",
            "in": "query",
            "description": "Informa se serão exibidas informações detalhadas das operações realizadas na charge. Valor padrão é false.",
            "required": false,
            "schema": {
              "type": "string",
              "format": "boolean",
              "enum": [
                true,
                false
              ]
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GetChargeResponse"
                },
                "examples": {
                  "card-with-details": {
                    "value": {
                      "charges": [
                        {
                          "id": "B7843C6C57836C5ETWGFU",
                          "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                          "reference_id": "74d975cd4975-4dd0-84ef-c12292222a8a",
                          "amount": 923,
                          "payment_method": "card",
                          "status": "canceled",
                          "created_at": "2023-07-01T14:50:37Z",
                          "card_transaction": {
                            "type": "credit",
                            "transaction_id": "B7843C6C57836C5ETWGFU",
                            "funding_source": "prepaid",
                            "authorized_amount": 923,
                            "captured_amount": 923,
                            "canceled_amount": 923,
                            "card": {
                              "brand": "Visa",
                              "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C"
                            },
                            "details": [
                              {
                                "operation": "authorization",
                                "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                                "local_datetime": "2023-07-01T11:50:37",
                                "provider_datetime": "2023-07-01T14:50:37",
                                "operation_amount": 923,
                                "acquirer_message": "Aprovado",
                                "acquirer_return_code": "0000",
                                "authorization_code": "ABC416"
                              },
                              {
                                "operation": "capture",
                                "operation_id": "0bee4358-6087-48eb-924e-31cebbacb077",
                                "local_datetime": "2023-07-01T11:55:37",
                                "provider_datetime": "2023-07-01T14:55:37",
                                "operation_amount": 923,
                                "acquirer_message": "Aprovado",
                                "acquirer_return_code": "0000"
                              },
                              {
                                "operation": "capture",
                                "operation_id": "e47eb6c7-b2d4-477a-9425-6aa5a4a8b468",
                                "local_datetime": "2023-07-01T11:55:37",
                                "provider_datetime": "2023-07-01T14:55:37",
                                "operation_amount": 923,
                                "acquirer_message": "Aprovado",
                                "acquirer_return_code": "0000"
                              },
                              {
                                "operation": "cancel",
                                "operation_id": "aacb83e3-fa55-44da-ae45-b36921ecddb2",
                                "local_datetime": "2023-07-02T11:45:37",
                                "provider_datetime": "2023-07-02T14:45:37",
                                "operation_amount": 923,
                                "acquirer_message": "Aprovado",
                                "acquirer_return_code": "0000"
                              }
                            ]
                          }
                        }
                      ]
                    }
                  },
                  "card-without-details": {
                    "value": {
                      "charges": [
                        {
                          "id": "B7843C6C57836C5ETWGFU",
                          "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                          "reference_id": "74d975cd4975-4dd0-84ef-c12292222a8a",
                          "amount": 923,
                          "payment_method": "card",
                          "status": "canceled",
                          "created_at": "2023-07-01T14:50:37Z",
                          "card_transaction": {
                            "type": "credit",
                            "transaction_id": "B7843C6C57836C5ETWGFU",
                            "funding_source": "prepaid",
                            "authorized_amount": 923,
                            "captured_amount": 923,
                            "canceled_amount": 923,
                            "card": {
                              "brand": "Visa"
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "BadRequest",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                },
                "examples": {
                  "bad-request": {
                    "value": {
                      "error_code": "prefix_400",
                      "details": {
                        "message": "Transação Inválida"
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "Não autorizado",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                },
                "examples": {
                  "unauthorized": {
                    "value": {
                      "error_code": "unauthorized",
                      "details": {
                        "message": "Estabelecimento Comercial Não Cadastrado"
                      }
                    }
                  }
                }
              }
            }
          },
          "404": {
            "description": "NotFound",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                },
                "examples": {
                  "not-found": {
                    "value": {
                      "error_code": "not_found",
                      "details": {
                        "message": "Transação não Encontrada"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "bearer_auth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT"
      }
    },
    "schemas": {
      "GetChargeResponse": {
        "type": "object",
        "properties": {
          "charges": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "id",
                "initiator_id",
                "amount",
                "payment_method",
                "status",
                "created_at"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "description": "Identificador da charge"
                },
                "initiator_id": {
                  "type": "string",
                  "description": "Identificador externo que pode ser utilizado em reversões"
                },
                "reference_id": {
                  "type": "string",
                  "description": "Identificador externo do pedido"
                },
                "amount": {
                  "type": "integer",
                  "format": "int64",
                  "description": "Valor da charge em centavos"
                },
                "payment_method": {
                  "type": "string",
                  "description": "Payment method da charge",
                  "enum": [
                    "card"
                  ]
                },
                "status": {
                  "type": "string",
                  "description": "Status atual da Charge",
                  "enum": [
                    "authorized",
                    "paid",
                    "canceled",
                    "declined"
                  ]
                },
                "created_at": {
                  "type": "string",
                  "format": "date-time",
                  "description": "Data e hora da criação da charge no formato \"YYYY-MM-ddTHH:mm:ssZ\""
                },
                "card_transaction": {
                  "type": "object",
                  "required": [
                    "type",
                    "card",
                    "transaction_id",
                    "authorized_amount",
                    "captured_amount",
                    "canceled_amount"
                  ],
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "credit",
                        "debit",
                        "voucher",
                        "other"
                      ],
                      "description": "Detalhamento de que tipo de cartão está sendo utilizado na charge"
                    },
                    "transaction_id": {
                      "type": "string",
                      "description": "Identificador da transação emitido pelo provedor"
                    },
                    "funding_source": {
                      "type": "string",
                      "description": "Indicação para o método de liquidação a ser utilizado",
                      "enum": [
                        "credit",
                        "debit",
                        "prepaid"
                      ]
                    },
                    "authorized_amount": {
                      "type": "integer",
                      "format": "int64",
                      "description": "Valor autorizado na cobrança, em centavos."
                    },
                    "captured_amount": {
                      "type": "integer",
                      "format": "int64",
                      "description": "Valor capturado na cobrança, em centavos."
                    },
                    "canceled_amount": {
                      "type": "integer",
                      "format": "int64",
                      "description": "Valor cancelado na cobrança, em centavos."
                    },
                    "installments": {
                      "type": "integer",
                      "format": "int32",
                      "default": 0,
                      "minimum": 0,
                      "maximum": 99,
                      "description": "Quantidade de parcelas da cobrança."
                    },
                    "statement_descriptor": {
                      "type": "string",
                      "maxLength": 35,
                      "description": "Informação adicional apresentada na filipeta para o comprador final. Em geral o nome fantasia do cliente."
                    },
                    "merchant_category_code": {
                      "type": "string",
                      "description": "Código de categoria do lojista ou sublojista relacionado à cobrança."
                    },
                    "card": {
                      "type": "object",
                      "properties": {
                        "brand": {
                          "type": "string",
                          "description": "Bandeira do cartão"
                        },
                        "emv_response": {
                          "type": "string",
                          "format": "binary",
                          "description": "EMV"
                        }
                      }
                    },
                    "details": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "operation": {
                            "type": "string",
                            "description": "Operação feita sobre a charge",
                            "enum": [
                              "authorization",
                              "capture",
                              "cancel"
                            ]
                          },
                          "operation_id": {
                            "type": "string"
                          },
                          "local_datetime": {
                            "type": "string",
                            "format": "date-time"
                          },
                          "provider_datetime": {
                            "type": "string",
                            "format": "date-time"
                          },
                          "operation_amount": {
                            "type": "integer",
                            "format": "int64"
                          },
                          "authorization_code": {
                            "type": "string"
                          },
                          "emv_data": {
                            "type": "string"
                          },
                          "acquirer_message": {
                            "type": "string"
                          },
                          "acquirer_return_code": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "additional_data": {
                      "type": "array",
                      "description": "Detalhamento de informações adicionais",
                      "items": {
                        "type": "object",
                        "required": [
                          "name",
                          "value"
                        ],
                        "properties": {
                          "name": {
                            "type": "string",
                            "description": "Nome da propriedade adicional"
                          },
                          "value": {
                            "type": "string",
                            "description": "Valor da propriedade adicional"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "ErrorResponse": {
        "type": "object",
        "required": [
          "error_code",
          "details"
        ],
        "properties": {
          "error_code": {
            "type": "string",
            "description": "Código do erro para contribuir em investigações"
          },
          "request_key": {
            "type": "string",
            "description": "Identificador da requisição que permite investigação do erro"
          },
          "details": {
            "type": "array",
            "description": "Lista de detalhamento dos erros que ocorreram",
            "items": {
              "type": "object",
              "required": [
                "message"
              ],
              "properties": {
                "message": {
                  "type": "string",
                  "description": "Mensagem do erro"
                },
                "item": {
                  "type": "string",
                  "description": "Item que causou o retorno de erro, se aplicável"
                }
              }
            }
          }
        }
      }
    }
  },
  "x-readme": {
    "explorer-enabled": true,
    "proxy-enabled": true
  },
  "_id": {
    "buffer": {
      "0": 102,
      "1": 245,
      "2": 233,
      "3": 106,
      "4": 66,
      "5": 249,
      "6": 1,
      "7": 0,
      "8": 76,
      "9": 164,
      "10": 155,
      "11": 3
    }
  }
}
```