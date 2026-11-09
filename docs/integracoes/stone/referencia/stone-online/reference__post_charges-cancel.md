---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Cancelamento

Reversão ou Cancelamento de uma charge.<br> Pode ser utilizado o `id` ou o `initiator_id`.<br> Se os dois forem informados, será usado o `id`.

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
    "/charges/cancel": {
      "post": {
        "tags": [
          "Charges"
        ],
        "description": "Reversão ou Cancelamento de uma charge.<br> Pode ser utilizado o `id` ou o `initiator_id`.<br> Se os dois forem informados, será usado o `id`.<br><br>         A autenticação no endpoint é feita da seguinte forma:\n  * **Bearer Token Authorization**: Token JWT.\n",
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
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/PostChargeCancelRequest"
              },
              "examples": {
                "reversal-initiator-id": {
                  "value": {
                    "initiator_id": "b4d67123a94c4c77",
                    "amount": 100,
                    "reason": "4001"
                  }
                },
                "reversal-id": {
                  "value": {
                    "id": "B7843C6C57836C5ETWGFU",
                    "amount": 100,
                    "reason": "4001"
                  }
                },
                "reversal-id-initiator-id": {
                  "value": {
                    "id": "B7843C6C57836C5ETWGFU",
                    "initiator_id": "b4d67123a94c4c77",
                    "amount": 923,
                    "reason": "4001"
                  }
                },
                "reversal-with-initiator-operation-id": {
                  "value": {
                    "id": "B7843C6C57836C5ETWGFU",
                    "initiator_id": "b4d67123a94c4c77",
                    "amount": 923,
                    "reason": "4001",
                    "initiator_operation_id": "1234567890"
                  }
                },
                "refund-pos-brand-banricompras-pin-offline": {
                  "value": {
                    "amount": 100,
                    "reason": "4000",
                    "id": "B7843C6C57836C5ETWGFU",
                    "card_transaction": {
                      "card": {
                        "cvv": "123",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "00",
                        "track_2": "6060715919734019=23046050000000600000"
                      },
                      "authentication": {
                        "type": "offline_pin"
                      }
                    }
                  }
                },
                "refund-pos-brand-banricompras-pin-online": {
                  "value": {
                    "amount": 100,
                    "reason": "4000",
                    "id": "B7843C6C57836C5ETWGFU",
                    "card_transaction": {
                      "card": {
                        "cvv": "123",
                        "emv_data": "8407A00000015444425F2A02070282021800950580800080009A032404049C01009F02060000000001009F101706011203A000000F00564953414C3354455354434153459F1A0200769F2608C3B499BB011BD25A9F3303E0F8C89F360200029F3704930A6C2C9F03060000000000005F340101",
                        "track_1": "B6396649900108146^CARTAO TESTE ARM   ^28032068270007210302",
                        "track_2": "6396649900108146=28032068270007210302",
                        "track_3": "6396649900108146=28032068270007210302"
                      },
                      "authentication": {
                        "type": "online_pin",
                        "online_pin": {
                          "ksi": "20141125FF",
                          "ksn": "3210E10004",
                          "pin_block": "529B29D626938073"
                        }
                      }
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
                  "$ref": "#/components/schemas/PostChargeCancelResponse"
                },
                "examples": {
                  "reversal-initiator-id": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 923,
                      "payment_method": "card",
                      "status": "canceled",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "APPR",
                        "acquirer_return_code": "0000",
                        "authorization_code": "ABC123"
                      }
                    }
                  },
                  "reversal-id": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 923,
                      "payment_method": "card",
                      "status": "canceled",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "APPR",
                        "acquirer_return_code": "0000",
                        "authorization_code": "ABC123"
                      }
                    }
                  },
                  "reversal-id-initiator-id": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 923,
                      "payment_method": "card",
                      "status": "canceled",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "APPR",
                        "acquirer_return_code": "0000",
                        "authorization_code": "ABC123"
                      }
                    }
                  },
                  "refund-pos-band-banricompras-pin-online": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 100,
                      "payment_method": "card",
                      "status": "canceled",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "14451082092578",
                        "operation_id": "jrbdexusbhhb77vntqqpuuyan",
                        "acquirer_message": "Approved",
                        "acquirer_return_code": "0000",
                        "authorization_code": "ABC123"
                      }
                    }
                  },
                  "refund-pos-band-banricompras-pin-offline": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "amount": 100,
                      "payment_method": "card",
                      "status": "canceled",
                      "card_transaction": {
                        "result": "success",
                        "transaction_id": "14451082092578",
                        "operation_id": "jrbdexusbhhb77vntqqpuuyan",
                        "acquirer_message": "Approved",
                        "acquirer_return_code": "0000",
                        "authorization_code": "ABC123"
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
      "PostChargeCancelRequest": {
        "type": "object",
        "required": [
          "amount"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "Identificador da charge. Obrigatório se não for informado o `initiator_id`"
          },
          "initiator_id": {
            "type": "string",
            "description": "Identificador externo que pode ser utilizado em reversões. Obrigatório se não for informado o `id`"
          },
          "amount": {
            "type": "integer",
            "format": "int64",
            "minimum": 1,
            "description": "Valor a ser revertido (valor da autorização)"
          },
          "reason": {
            "type": "string",
            "description": "Motivo da solicitação do cancelamento"
          },
          "initiator_operation_id": {
            "type": "string",
            "description": "Identificador externo que pode ser utilizado para identificar cada operação realizada"
          },
          "card_transaction": {
            "description": "Informações específicas para cancelamentos de transações utilizando o método de pagamento cartão. Este nó é obrigatório apenas para transações da bandeira Banricompras com cartão presente. Caso contrário,  deve ser omitido  \n",
            "type": "object",
            "properties": {
              "card": {
                "type": "object",
                "properties": {
                  "cvv": {
                    "type": "string",
                    "format": "int32",
                    "maxLength": 4,
                    "description": "Código de segurança do cartão"
                  },
                  "emv_data": {
                    "type": "string",
                    "description": "Dados obtidos do chip do cartão"
                  },
                  "track_1": {
                    "type": "string",
                    "description": "Trilha 1 de dados do cartão"
                  },
                  "track_2": {
                    "type": "string",
                    "description": "Trilha 2 de dados do cartão"
                  },
                  "track_3": {
                    "type": "string",
                    "description": "Trilha 3 de dados do cartão"
                  }
                }
              },
              "authentication": {
                "type": "object",
                "required": [
                  "type"
                ],
                "properties": {
                  "type": {
                    "type": "string",
                    "enum": [
                      "online_pin",
                      "offline_pin"
                    ],
                    "description": "Método de autenticação do cliente"
                  },
                  "online_pin": {
                    "type": "object",
                    "properties": {
                      "ksi": {
                        "type": "string",
                        "format": "binary",
                        "example": "20141125FF",
                        "description": "ksi"
                      },
                      "ksn": {
                        "type": "string",
                        "format": "binary",
                        "example": 9999000025,
                        "description": "ksn"
                      },
                      "pin_block": {
                        "type": "string",
                        "format": "binary",
                        "example": "1C89680698D29991",
                        "description": "pin_block"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "PostChargeCancelResponse": {
        "type": "object",
        "required": [
          "id",
          "amount",
          "payment_method",
          "status"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "Identificador da charge"
          },
          "amount": {
            "type": "integer",
            "format": "int64",
            "description": "Valor estornado/revertido em centavos"
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
          "card_transaction": {
            "type": "object",
            "required": [
              "result",
              "transaction_id",
              "operation_id",
              "acquirer_return_code"
            ],
            "properties": {
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
                "description": "Identificador da transação emitido pelo provedor"
              },
              "operation_id": {
                "type": "string",
                "description": "Identificador da operação gerado pela adquirente"
              },
              "acquirer_message": {
                "type": "string",
                "description": "Mensagem de resultado da operação retornada pela adquirente"
              },
              "acquirer_return_code": {
                "type": "string",
                "minLength": 2,
                "maxLength": 4,
                "description": "Código de resultado da operação retornado pela adquirente"
              },
              "authorization_code": {
                "type": "string",
                "description": "Código de autorização retornado pelo emissor"
              },
              "card": {
                "type": "object",
                "properties": {
                  "remaining_balance": {
                    "type": "integer",
                    "format": "int64",
                    "description": "Saldo restante no cartão, caso seja informado pela adquirente"
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
              },
              "currency_conversion": {
                "type": "object",
                "required": [
                  "token",
                  "currency_code",
                  "converted_amount"
                ],
                "properties": {
                  "converted_amount": {
                    "type": "number",
                    "format": "int32",
                    "description": "Valor de cancelamento da transação na moeda de autorização do portador"
                  },
                  "currency_exp": {
                    "type": "number",
                    "format": "int32",
                    "description": "Expoente da moeda do portador. (Número de digitos após o separador de decimal)"
                  },
                  "currency_label": {
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 3,
                    "description": "Nome da moeda de autorização da transação no cartão do portador. Padrão ISO 3 caracteres"
                  },
                  "exchange_rate": {
                    "type": "number",
                    "format": "float",
                    "description": "Cotação de conversão entre as moedas do portador e do merchant"
                  },
                  "markup": {
                    "type": "number",
                    "format": "float",
                    "description": "Spread utilizado para conversão"
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