---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Verificação de cartão

Validação de um novo cartão.

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
  "paths": {
    "/cards/verify": {
      "post": {
        "tags": [
          "Cards"
        ],
        "description": "Validação de um novo cartão.<br><br> A autenticação no endpoint é feita da seguinte forma:\n  * **Bearer Token Authorization**: Token JWT.\n",
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
                "$ref": "#/components/schemas/PostCardsVerifyRequest"
              },
              "examples": {
                "verify-card": {
                  "value": {
                    "type": "credit",
                    "initiator_id": "b4d67123a94c4c77",
                    "local_datetime": "2023-07-15T10:53:16",
                    "reference_id": "or_3f4783edd45",
                    "card": {
                      "number": "4705980000007171",
                      "expiration_date": "2608",
                      "cvv": "111",
                      "holder_name": "TONY STARK"
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
                  "$ref": "#/components/schemas/PostCardsVerifyResponse"
                },
                "examples": {
                  "valid-card": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "b4d67123a94c4c77",
                      "reference_id": "or_3f4783edd45",
                      "status": "authorized",
                      "created_at": "2023-07-15T10:54:16",
                      "result": "success",
                      "transaction_id": "14451082092221",
                      "operation_id": "jrbd9vjj9h2x82z9qz1hja265",
                      "authorization_code": "ABC416",
                      "acquirer_message": "Aprovado",
                      "acquirer_return_code": "0000",
                      "card": {
                        "brand": "Visa",
                        "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
                      }
                    }
                  },
                  "invalid-card": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "b4d67123a94c4c77",
                      "reference_id": "or_3f4783edd45",
                      "status": "declined",
                      "created_at": "2023-07-15T10:54:16",
                      "result": "failed",
                      "transaction_id": "14451082092221",
                      "operation_id": "jrbd9vjj9h2x82z9qz1hja265",
                      "acquirer_message": "Verifique os dados do cartão",
                      "acquirer_return_code": "1011",
                      "card": {
                        "brand": "Visa"
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
                  "bad-request-missing-headers": {
                    "value": {
                      "error_code": "api_400",
                      "details": {
                        "message": "Transação Inválida",
                        "description": "Headers obrigatórios não foram informados na requisição."
                      }
                    }
                  },
                  "bad-request-api-validator": {
                    "value": {
                      "error_code": "api_400",
                      "details": {
                        "message": "Transação Inválida",
                        "description": "O número do cartão deve ser fornecido."
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
      "PostCardsVerifyRequest": {
        "type": "object",
        "required": [
          "type",
          "local_datetime",
          "card",
          "initiator_id"
        ],
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "credit",
              "debit",
              "voucher"
            ],
            "description": "Tipo de cartão está sendo utilizado na cobrança."
          },
          "local_datetime": {
            "type": "string",
            "format": "yyyy-MM-ddTHH:mm:ss",
            "description": "Data e hora da operação utilizando o fuso horário do local do dispositivo no formato ISO8601."
          },
          "initiator_id": {
            "type": "string",
            "description": "Identificador externo (cliente) que pode ser utilizado em reversões e consultas."
          },
          "reference_id": {
            "type": "string",
            "description": "Identificador externo, geralmente relacionado a um pedido ou outra referência do cliente, apenas em fluxos informacionais."
          },
          "statement_descriptor": {
            "type": "string",
            "description": "Informação adicional apresentada na filipeta para o comprador final. Em geral o nome fantasia do cliente."
          },
          "merchant_category_code": {
            "type": "string",
            "description": "Código de categoria do lojista ou sublojista relacionado à cobrança."
          },
          "card": {
            "type": "object",
            "required": [
              "number",
              "expiration_date"
            ],
            "properties": {
              "entry_mode": {
                "type": "string",
                "enum": [
                  "magstripe",
                  "emv",
                  "emv_contacless",
                  "contactless",
                  "qr_code",
                  "manual",
                  "credentials_on_file"
                ],
                "description": "Método pelo qual foi realizada a leitura dos dados do cartão:\n  * `magstripe`: Leitura da tarja magnética.\n  * `emv`: Leitura por inserção de ICC, sendo os dados no padrão EMV.\n  * `emv_contactless`: Leitura por aproximação, sendo os dados no padrão EMV.\n  * `contactless`: Leitura por aproximação com tecnologia NFC ou bluetooth, \n    por exemplo, em padrões não EMV.\n  * `qr_code`: Leitura por código QR exibido em um terminal de pagamento..\n  * `manual`: Dados inseridos manualmente através de uma plataforma de pagamento.\n  * `credentials_on_file`: Dados armazenados previamente.\n"
              },
              "number": {
                "type": "string",
                "format": "int32",
                "minLength": 8,
                "maxLength": 19,
                "description": "Número do cartão (PAN) sendo utilizado na cobrança."
              },
              "expiration_date": {
                "type": "string",
                "format": "YYMM",
                "description": "Data de expiração do cartão utilizando o formato ano e mês \"YYMM\"."
              },
              "holder_name": {
                "type": "string",
                "description": "Nome do portador do cartão."
              },
              "cvv": {
                "type": "string",
                "format": "int32",
                "maxLength": 4,
                "description": "Código de segurança do cartão."
              },
              "fallback": {
                "type": "boolean",
                "default": false,
                "description": "Indicação se está sendo utilizado o entry_mode de fallback."
              },
              "brand": {
                "type": "string",
                "enum": [
                  "visa",
                  "mastercard",
                  "amex",
                  "hipercard",
                  "elo",
                  "jcb",
                  "aura",
                  "dinners"
                ],
                "description": "Bandeira do cartão."
              }
            }
          }
        }
      },
      "PostCardsVerifyResponse": {
        "type": "object",
        "required": [
          "id",
          "initiator_id",
          "status",
          "result",
          "created_at",
          "card",
          "transaction_id",
          "acquirer_return_code"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "Identificador único da validação."
          },
          "initiator_id": {
            "type": "string",
            "description": "Identificador externo (cliente) que pode ser utilizado em reversões e consultas."
          },
          "reference_id": {
            "type": "string",
            "description": "Identificador externo, geralmente relacionado a um pedido ou outra referência do cliente, apenas em fluxos informacionais."
          },
          "status": {
            "type": "string",
            "description": "Status atual da validação",
            "enum": [
              "authorized",
              "declined"
            ]
          },
          "result": {
            "type": "string",
            "description": "Resultado da operação de validação",
            "enum": [
              "success",
              "failed"
            ]
          },
          "created_at": {
            "type": "string",
            "format": "yyyy-MM-ddTHH:mm:ssZ",
            "description": "Data e hora da criação da validação no formato ISO8601."
          },
          "transaction_id": {
            "type": "string",
            "description": "Identificador da transação emitido pelo provedor (Adquirente)."
          },
          "operation_id": {
            "type": "string",
            "description": "Identificador da operação gerado pela adquirente."
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
              "payment_account_reference": {
                "type": "string",
                "description": "Referência exclusiva ao cartão, usada por comerciantes e adquirentes para vincular transações tokenizadas e não tokenizadas associadas ao mesmo cartão subjacente (PAR)."
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