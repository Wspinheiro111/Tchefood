---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Captura posterior

Captura de uma charge autorizada.

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
    "/charges/{id}/capture": {
      "post": {
        "tags": [
          "Charges"
        ],
        "description": "Captura de uma charge autorizada.<br><br>         A autenticação no endpoint é feita da seguinte forma:\n  * **Bearer Token Authorization**: Token JWT.\n",
        "security": [
          {
            "bearer_auth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "description": "Identificador da charge retornado em sua criação",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "Host",
            "in": "header",
            "description": "Domínio utilizado para processar a requisição. Neste caso, determina o ambiente do serviço, podendo  ter os valores:\n  * `payments.stone.com.br`: ambiente produtivo\n  * `sdx-payments.stone.com.br`: ambiente de sandbox (pré-produção)\n",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/PostChargeCaptureRequest"
              },
              "examples": {
                "total-without-emv-data": {
                  "value": {
                    "amount": 923
                  }
                },
                "total-with-emv-data": {
                  "value": {
                    "amount": 923,
                    "card_transaction": {
                      "card": {
                        "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020"
                      }
                    }
                  }
                },
                "total-with-emv-data-and-initiator-operation-id-fixed": {
                  "value": {
                    "amount": 923,
                    "initiator_operation_id": "1234567890",
                    "card_transaction": {
                      "card": {
                        "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020"
                      }
                    }
                  }
                },
                "partial-capture-without-emv-data": {
                  "value": {
                    "amount": 30
                  }
                },
                "partial-with-emv-data": {
                  "value": {
                    "amount": 30,
                    "card_transaction": {
                      "card": {
                        "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020"
                      }
                    }
                  }
                },
                "with-card-data": {
                  "value": {
                    "amount": 30,
                    "card_transaction": {
                      "card": "2223000250000004",
                      "cvv": 123
                    }
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PostChargeResponse"
                },
                "examples": {
                  "total-without-emv-data": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 923,
                      "payment_method": "card",
                      "status": "paid",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "APPR",
                        "acquirer_return_code": "0000"
                      }
                    }
                  },
                  "total-with-emv-data": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 923,
                      "payment_method": "card",
                      "status": "paid",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "APPR",
                        "acquirer_return_code": "0000",
                        "card": {
                          "emv_response": "9F0500"
                        }
                      }
                    }
                  },
                  "partial-capture-without-emv-data": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 30,
                      "payment_method": "card",
                      "status": "paid",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "APPR",
                        "acquirer_return_code": "0000"
                      }
                    }
                  },
                  "partial-capture-with-emv-data": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 30,
                      "payment_method": "card",
                      "status": "paid",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "APPR",
                        "acquirer_return_code": "0000",
                        "card": {
                          "emv_response": "9F0500"
                        }
                      }
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
          },
          "422": {
            "description": "Captura não processada",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                },
                "examples": {
                  "invalid_amount": {
                    "value": {
                      "error_code": "invalid_amount",
                      "details": {
                        "message": "Valor não disponível"
                      }
                    }
                  },
                  "time_limit_exceed": {
                    "value": {
                      "error_code": "time_limit_exceed",
                      "details": {
                        "message": "Transação Expirada"
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
      "PostChargeResponse": {
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
            "description": "Identificador único da cobrança."
          },
          "initiator_id": {
            "type": "string",
            "description": "Identificador externo (cliente) que pode ser utilizado em reversões e consultas."
          },
          "reference_id": {
            "type": "string",
            "description": "Identificador externo, geralmente relacionado a um pedido ou outra referência do cliente, apenas em fluxos informacionais."
          },
          "amount": {
            "type": "integer",
            "format": "int64",
            "description": "Valor requisitado na cobrança em centavos."
          },
          "payment_method": {
            "type": "string",
            "description": "Meio de pagamento da cobrança.",
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
            "format": "yyyy-MM-ddTHH:mm:ssZ",
            "description": "Data e hora da criação da cobrança no formato ISO8601."
          },
          "card_transaction": {
            "type": "object",
            "required": [
              "type",
              "card",
              "result",
              "transaction_id",
              "operation_id",
              "acquirer_return_code"
            ],
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "credit",
                  "debit",
                  "voucher"
                ],
                "description": "Detalhamento de que tipo de cartão está sendo utilizado na cobrança."
              },
              "funding_source": {
                "type": "string",
                "description": "Indicação para o método de liquidação a ser utilizado.",
                "enum": [
                  "credit",
                  "debit",
                  "prepaid"
                ]
              },
              "result": {
                "type": "string",
                "description": "Resultado da operação que foi executada",
                "enum": [
                  "success",
                  "failed"
                ]
              },
              "transaction_id": {
                "type": "string",
                "description": "Identificador da transação emitido pelo provedor (Adquirente)."
              },
              "operation_id": {
                "type": "string",
                "description": "Identificador da operação gerado pela adquirente."
              },
              "brand_transaction_id": {
                "type": "string",
                "description": "Identificador da transação no Emissor."
              },
              "authorization_code": {
                "type": "string",
                "description": "Código de autorização.",
                "minLength": 6,
                "maxLength": 6
              },
              "acquirer_message": {
                "type": "string",
                "description": "Mensagem de resultado da operação retornada pela adquirente."
              },
              "acquirer_return_code": {
                "type": "string",
                "minLength": 2,
                "maxLength": 4,
                "description": "Código de resultado da operação retornado pela adquirente."
              },
              "brand_return_code": {
                "type": "string",
                "description": "Código de retorno ABECS."
              },
              "merchant_advice_code": {
                "type": "string",
                "description": "código de retorno do padrão MAC."
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
              },
              "card": {
                "type": "object",
                "required": [
                  "brand"
                ],
                "properties": {
                  "brand": {
                    "type": "string",
                    "description": "Bandeira do cartão"
                  },
                  "remaining_balance": {
                    "type": "integer",
                    "format": "int64",
                    "description": "Saldo disponível no cartão, caso seja informado pela adquirente"
                  },
                  "emv_response": {
                    "type": "string",
                    "format": "binary",
                    "description": "EMV"
                  },
                  "payment_account_reference": {
                    "type": "string",
                    "description": "Referência exclusiva ao cartão, usada por comerciantes e adquirentes para vincular transações tokenizadas e não tokenizadas associadas ao mesmo cartão subjacente (PAR)."
                  }
                }
              }
            }
          }
        }
      },
      "PostChargeCaptureRequest": {
        "type": "object",
        "required": [
          "amount"
        ],
        "properties": {
          "amount": {
            "type": "integer",
            "format": "int64",
            "minimum": 1,
            "description": "Valor a ser capturado"
          },
          "emv_data": {
            "type": "string",
            "description": "Dados obtidos do chip do cartão"
          },
          "initiator_operation_id": {
            "type": "string",
            "description": "Identificador externo que pode ser utilizado para identificar cada operação realizada"
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