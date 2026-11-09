---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização

Criação de uma nova cobrança.

> 📘 Header Host conforme o modelo de negócio
>
> Para atender às regras específicas de autenticação, descritas neste link, é necessário que o Header Host das suas requisições seja ajustado de acordo com o seu modelo de negócio.
>
> Se você é um Gateway de Pagamentos, utilize o Header Host:\
> `ecommerce-payments.stone.com.br`
>
> Se você é uma Subadquirente, utilize o Header Host:\
> `payments.stone.com.br`

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
      "post": {
        "tags": [
          "Charges"
        ],
        "description": "Criação de uma nova cobrança.<br><br> A autenticação no endpoint é feita da seguinte forma: \n  * **Bearer Token Authorization**: Token JWT.\n",
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
                "$ref": "#/components/schemas/PostChargeRequest"
              },
              "examples": {
                "pos-magstripe-pin-offline": {
                  "value": {
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "local_datetime": "2023-07-15T10:53:16",
                    "payment_method": "card",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 3,
                      "installments_type": "merchant",
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "magstripe",
                        "expiration_date": "2608",
                        "number": "4705980000007171",
                        "cvv": "111",
                        "holder_name": "TONY STARK"
                      },
                      "authentication": {
                        "type": "offline_pin"
                      }
                    }
                  }
                },
                "pos-magstripe-pin-online": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-07-15T10:53:16",
                    "card_transaction": {
                      "type": "debit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "*loja teste",
                      "card": {
                        "entry_mode": "magstripe",
                        "number": "4705980000007171",
                        "expiration_date": "2608",
                        "cvv": "111"
                      },
                      "authentication": {
                        "type": "online_pin",
                        "online_pin": {
                          "algorithm": "dukpt_3des",
                          "ksi": "2020080303",
                          "ksn": "E598600944",
                          "pin_block": "DD31B3DD87AC6321"
                        }
                      }
                    }
                  }
                },
                "pos-magstripe-preauth": {
                  "value": {
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "local_datetime": "2023-07-15T10:53:16",
                    "payment_method": "card",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "pre_auth",
                      "installments": 1,
                      "installments_type": "account_holder",
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "magstripe",
                        "number": "4705980000007171",
                        "expiration_date": "2608",
                        "cvv": "111",
                        "holder_name": "TONY STARK"
                      }
                    }
                  }
                },
                "pos-magstripe-no-auth": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-07-15T10:53:16",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "magstripe",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "track_2": "6033401111633077000=31116000018400040"
                      }
                    }
                  }
                },
                "pos-magstripe-fallback": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-07-15T10:53:16",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "teste",
                      "card": {
                        "entry_mode": "magstripe",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "track_2": "6033401111633077000=31116000018400040",
                        "fallback": true
                      }
                    }
                  }
                },
                "pos-emv-pin-online": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-06-17T10:53:16",
                    "card_transaction": {
                      "type": "debit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "*loja a",
                      "card": {
                        "entry_mode": "emv",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "00",
                        "track_2": "5491678030473777=23046050000000600000"
                      },
                      "authentication": {
                        "type": "online_pin",
                        "online_pin": {
                          "algorithm": "dukpt_3des",
                          "ksi": "2020080303",
                          "ksn": "E598600944",
                          "pin_block": "DD31B3DD87AC6321"
                        }
                      }
                    }
                  }
                },
                "pos-emv-pin-offline": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-06-17T10:53:16",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "*loja teste",
                      "card": {
                        "entry_mode": "emv",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "00",
                        "track_2": "5491678030473777=23046050000000600000"
                      },
                      "authentication": {
                        "type": "offline_pin"
                      }
                    }
                  }
                },
                "pos-emv-no-auth": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-06-17T10:53:16",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "emv",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "00",
                        "track_2": "5491678030473777=23046050000000600000"
                      }
                    }
                  }
                },
                "pos-emv-no-auth-dcc": {
                  "value": {
                    "payment_method": "card",
                    "amount": 1000,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-06-17T10:53:16",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "emv",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "00",
                        "track_2": "5491678030473777=23046050000000600000"
                      },
                      "currency_conversion": {
                        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjdXJyZW5jeUNvbnZlcnNpb25JZCI6ImVhZjY1Y2ZhLWI3YmUtNGEzZC05Y2NjLTk2ZjhlOTc4ZjE0NiIsImV4Y2hhbmdlUmF0ZSI6MC4xNTYxLCJtYXJrdXAiOjEuMDUsImZyb21DdXJyZW5jeUNvZGUiOjk4NiwidG9DdXJyZW5jeUNvZGUiOjgyNiwicGF5bWVudFNjaGVtZUtleSI6ImV6NHJjbXE1IiwidG9DdXJyZW5jeUV4cG9lbnQiOjIsImlhdCI6MTY1OTUzMzQwMiwiZXhwIjoxNjU5NTU1MDAyfQ.g0rDU0NRSkiNKedd3WPedDuj_tiSOcnswf9eKGOES8w",
                        "currency_code": "826",
                        "converted_amount": 200
                      }
                    }
                  }
                },
                "pos-emv-contactless-pin-online": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-06-17T10:53:16",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "emv_contactless",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "01",
                        "track_2": "5491678030473777=23046050000000600000"
                      },
                      "authentication": {
                        "type": "online_pin",
                        "online_pin": {
                          "algorithm": "dukpt_3des",
                          "ksi": "2020080303",
                          "ksn": "E598600944",
                          "pin_block": "DD31B3DD87AC6321"
                        }
                      }
                    }
                  }
                },
                "pos-emv-contactless-urban-mobility": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-06-17T10:53:16",
                    "print_line_size": 36,
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "emv_contactless",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "01",
                        "track_2": "5491678030473777=23046050000000600000"
                      },
                      "authentication": {
                        "type": "online_pin",
                        "online_pin": {
                          "algorithm": "dukpt_3des",
                          "ksi": "2020080303",
                          "ksn": "E598600944",
                          "pin_block": "DD31B3DD87AC6321"
                        }
                      }
                    }
                  }
                },
                "pos-emv-contactless-urban-mobility-retry": {
                  "value": {
                    "payment_method": "card",
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "787CVBNBN794",
                    "local_datetime": "2023-06-17T10:53:16",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "emv_contactless",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "01",
                        "track_2": "5491678030473777=23046050000000600000"
                      }
                    },
                    "first_transaction": {
                      "brand_transaction_id": "123456789",
                      "transaction_id": "987654321"
                    }
                  }
                },
                "pos-emv-dcc": {
                  "value": {
                    "amount": 923,
                    "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                    "local_datetime": "2023-06-17T10:53:16",
                    "payment_method": "card",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja teste",
                      "card": {
                        "entry_mode": "emv",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "emv_data": "5F2A02098682021800950580C00480009A032306169C01009F02060000000001009F10200FA501A30200000000000000000000000F05B9082ED8050DA8BCC400053720209F1A0200769F2608C55A60A66575B4749F2701809F34034203009F360201FE9F3303E0F0C89F3704797C244B9F1E085465726D696E616C",
                        "sequence_number": "02",
                        "track_2": "5491678030473777=23046050000000600000"
                      },
                      "currency_conversion": {
                        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjdXJyZW5jeUNvbnZlcnNpb25JZCI6ImVhZjY1Y2ZhLWI3YmUtNGEzZC05Y2NjLTk2ZjhlOTc4ZjE0NiIsImV4Y2hhbmdlUmF0ZSI6MC4xNTYxLCJtYXJrdXAiOjEuMDUsImZyb21DdXJyZW5jeUNvZGUiOjk4NiwidG9DdXJyZW5jeUNvZGUiOjgyNiwicGF5bWVudFNjaGVtZUtleSI6ImV6NHJjbXE1IiwidG9DdXJyZW5jeUV4cG9lbnQiOjIsImlhdCI6MTY1OTUzMzQwMiwiZXhwIjoxNjU5NTU1MDAyfQ.g0rDU0NRSkiNKedd3WPedDuj_tiSOcnswf9eKGOES8w",
                        "currency_code": "826",
                        "converted_amount": 200
                      }
                    }
                  }
                },
                "ecommerce-credit": {
                  "value": {
                    "amount": 3011,
                    "initiator_id": "b4d67123a94c4c77",
                    "reference_id": "or_3f4783edd45",
                    "initiator_operation_reference": "2024041181031300000664348969444",
                    "local_datetime": "2024-04-11T12:49:08",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_only",
                      "reference": "316464646454",
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "expiration_date": "5012",
                        "number": "6033401111633077000",
                        "cvv": "123"
                      }
                    }
                  }
                },
                "ecommerce-voucher": {
                  "value": {
                    "amount": 100,
                    "initiator_id": "b4d67123a94c4c77",
                    "reference_id": "or_3f4783edd45",
                    "local_datetime": "2024-04-11T12:49:08",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "voucher",
                      "operation_type": "auth_and_capture",
                      "installments": 1,
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "expiration_date": "2304",
                        "number": "6060715919734019",
                        "cvv": "123"
                      }
                    }
                  }
                },
                "ecommerce-submerchant": {
                  "value": {
                    "amount": 1000,
                    "initiator_id": "6c581baae0df4cb6",
                    "local_datetime": "2024-04-10T15:46:47",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "holder_name": "TONY STARK"
                      },
                      "merchant_category_code": "5818"
                    },
                    "sub_merchant": {
                      "id": "254759",
                      "name": "Mkt*subloja",
                      "document": "02326943001",
                      "document_type": "cnpj",
                      "email": "email@email.com",
                      "phone_number": "+551130041234",
                      "address": {
                        "street": "Rua Presidente Getúlio Vargas",
                        "number": "123",
                        "complement": "2ª andar - sala 1",
                        "state": "SC",
                        "city": "Porto Alegre",
                        "country": "076",
                        "zip_code": "90050000"
                      },
                      "gateway_id": "1234"
                    }
                  }
                },
                "ecommerce-3ds": {
                  "value": {
                    "amount": 36055,
                    "initiator_id": "a5606314e5c64486",
                    "reference_id": "a5606314e5c64486",
                    "initiator_operation_id": "2024040881031300000712548475101",
                    "local_datetime": "2024-04-08T00:12:43",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "cvv": "123",
                        "holder_name": "TONY STARK"
                      },
                      "authentication": {
                        "type": "emv_3ds",
                        "emv_3ds": {
                          "cryptogram": "B5gQApKXlQAAAIzXmGCZdQAAAAA=",
                          "eci": "02",
                          "status": "Y",
                          "directory_server_id": "4dd4df3f-583f-4970-b34f-90ff5d57aac8",
                          "version": "VRS21"
                        }
                      }
                    }
                  }
                },
                "ecommerce-3ds-dataonly": {
                  "value": {
                    "amount": 36055,
                    "initiator_id": "a5606314e5c64486",
                    "reference_id": "a5606314e5c64486",
                    "initiator_operation_id": "2024040881031300000712548475101",
                    "local_datetime": "2024-04-08T00:12:43",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "cvv": "123",
                        "holder_name": "TONY STARK"
                      },
                      "authentication": {
                        "type": "emv_3ds",
                        "emv_3ds": {
                          "cryptogram": "B5gQApKXlQAAAIzXmGCZdQAAAAA=",
                          "eci": "DATA_ONLY",
                          "status": "Y",
                          "directory_server_id": "4dd4df3f-583f-4970-b34f-90ff5d57aac8",
                          "version": "VRS21"
                        }
                      }
                    }
                  }
                },
                "ecommerce-wallet": {
                  "value": {
                    "amount": 4600,
                    "initiator_id": "dd12eb25362c40a9",
                    "reference_id": "dd12eb25362c40a9",
                    "local_datetime": "2024-04-11T17:48:02",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "card": {
                        "entry_mode": "manual",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "holder_name": "TONY STARK"
                      },
                      "authentication": {
                        "type": "wallet",
                        "wallet": {
                          "cryptogram": "/gAAAAAAAfccLUUzxZgcQGUAAAA=",
                          "eci": "02",
                          "type": "GOOGLE PAY"
                        }
                      }
                    }
                  }
                },
                "ecommerce-credentials-on-file-wallet": {
                  "value": {
                    "amount": 9301,
                    "initiator_id": "5537d19280534cb0",
                    "reference_id": "5537d19280534cb0",
                    "local_datetime": "2024-04-11T17:08:34",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_only",
                      "card": {
                        "entry_mode": "credentials_on_file",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "holder_name": "TONY STARK"
                      },
                      "authentication": {
                        "type": "wallet",
                        "wallet": {
                          "cryptogram": "ACC/vQp3hycAAAHHZ5ZeGgADFA==",
                          "eci": "02",
                          "type": "GOOGLE PAY"
                        }
                      }
                    }
                  }
                },
                "ecommerce-tokenization": {
                  "value": {
                    "amount": 12861,
                    "initiator_id": "13e67426baed4654",
                    "reference_id": "13e67426baed4654",
                    "local_datetime": "2024-04-12T11:15:35",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "holder_name": "TONY STARK",
                        "token": {
                          "number": "6033401111633077000",
                          "expiration_date": "2608",
                          "cryptogram": "/xAAAAAAg6qOp5YAmbG3gmcAAAA=",
                          "eci": "02",
                          "requestor_id": "40020165503"
                        }
                      }
                    }
                  }
                },
                "ecommerce-tokenization-and-recurrence-first": {
                  "value": {
                    "amount": 11000,
                    "initiator_id": "465ec652277046ba",
                    "reference_id": "465ec652277046ba",
                    "local_datetime": "2024-04-11T18:41:47",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "holder_name": "TONY STARK",
                        "token": {
                          "number": "6033401111633077000",
                          "expiration_date": "2604",
                          "cryptogram": "/xAAAAAAg6qOp5YAmbG3gmcAAAA=",
                          "eci": "02",
                          "requestor_id": "40020165503"
                        }
                      }
                    },
                    "initiator": {
                      "initiating_entity": "account_holder",
                      "initiating_reason": "subscription"
                    }
                  }
                },
                "ecommerce-tokenization-recurrence-subsequent": {
                  "value": {
                    "amount": 11000,
                    "initiator_id": "385bff117ddb4f83",
                    "reference_id": "385bff117ddb4f83",
                    "local_datetime": "2024-04-12T11:15:35",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "card": {
                        "entry_mode": "credentials_on_file",
                        "holder_name": "TONY STARK",
                        "token": {
                          "number": "6033401111633077000",
                          "expiration_date": "2604",
                          "requestor_id": "40020165503"
                        }
                      }
                    },
                    "initiator": {
                      "initiating_entity": "merchant",
                      "initiating_reason": "subscription"
                    },
                    "first_transaction": {
                      "brand_transaction_id": "123456789"
                    }
                  }
                },
                "ecommerce-pre-auth": {
                  "value": {
                    "amount": 31065,
                    "initiator_id": "74e6e09bd3ff4737",
                    "reference_id": "74e6e09bd3ff4737",
                    "local_datetime": "2024-04-11T18:45:27",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "pre_auth",
                      "statement_descriptor": "loja ecommerce",
                      "card": {
                        "entry_mode": "manual",
                        "number": "5491678030473777",
                        "expiration_date": "2304",
                        "cvv": "123",
                        "holder_name": "TONY STARK"
                      }
                    }
                  }
                },
                "ecommerce-mitcit-credencials-on-file": {
                  "value": {
                    "amount": 2000,
                    "initiator_id": "e4ca44a8d57c4df6",
                    "reference_id": "e4ca44a8d57c4df6",
                    "local_datetime": "2024-04-12T12:01:54",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "card": {
                        "entry_mode": "credentials_on_file",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "holder_name": "TONY STARK"
                      }
                    },
                    "initiator": {
                      "initiating_entity": "merchant",
                      "initiating_reason": "credentials_on_file"
                    }
                  }
                },
                "ecommerce-mitcit-subscription-first": {
                  "value": {
                    "amount": 4490,
                    "initiator_id": "51a3cca401874c8e",
                    "reference_id": "51a3cca401874c8e",
                    "local_datetime": "2024-04-07T19:48:50",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "card": {
                        "entry_mode": "credentials_on_file",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "holder_name": "TONY STARK"
                      }
                    },
                    "initiator": {
                      "initiating_entity": "account_holder",
                      "initiating_reason": "subscription"
                    }
                  }
                },
                "ecommerce-mitcit-subscription-subsequent": {
                  "value": {
                    "amount": 7990,
                    "initiator_id": "d60e30590d154b0b",
                    "reference_id": "d60e30590d154b0b",
                    "local_datetime": "2024-03-23T08:44:52",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "card": {
                        "entry_mode": "credentials_on_file",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "holder_name": "TONY STARK"
                      }
                    },
                    "initiator": {
                      "initiating_entity": "merchant",
                      "initiating_reason": "subscription"
                    },
                    "first_transaction": {
                      "brand_transaction_id": "123456789"
                    }
                  }
                },
                "ecommerce-retry": {
                  "value": {
                    "amount": 2970,
                    "initiator_id": "d42dbe81bc0246a1",
                    "initiator_operation_id": "1234567890",
                    "reference_id": "d42dbe81bc0246a1",
                    "local_datetime": "2024-04-11T18:41:41",
                    "payment_method": "card",
                    "channel": "website",
                    "card_transaction": {
                      "type": "credit",
                      "operation_type": "auth_and_capture",
                      "card": {
                        "entry_mode": "emv",
                        "number": "6033401111633077000",
                        "expiration_date": "3111",
                        "emv_data": "5F2A02098682021800950580000480009A032212209C01009F02060000000200019F10200FA5E2A04030009300610000000000010FED93000000000000000000000000019F1A0200769F26080D76BBE72DF708999F2701809F34030203009F360200049F3303E0F0E89F370454ECB7779F1E0830303030303930359F0B1C303030342F3332313034303936202020202020202020202020202020",
                        "sequence_number": "00"
                      }
                    },
                    "initiator": {
                      "initiating_entity": "merchant",
                      "initiating_reason": "retry"
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
                  "manual-voucher-approved": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "b4d67123a94c4c77",
                      "reference_id": "or_3f4783edd45",
                      "amount": 100,
                      "status": "paid",
                      "payment_method": "card",
                      "created_at": "2023-07-01T11:50:37",
                      "card_transaction": {
                        "type": "voucher",
                        "funding_source": "prepaid",
                        "result": "success",
                        "transaction_id": "14451082092153",
                        "brand_transaction_id": "K2QYL2",
                        "operation_id": "jrbd9gvm47fv2twjwnjw9wa2w",
                        "authorization_code": "ABC416",
                        "acquirer_message": "Aprovado",
                        "acquirer_return_code": "0000",
                        "card": {
                          "brand": "Sodexo"
                        }
                      }
                    }
                  },
                  "manual-voucher-denied": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "b4d67123a94c4c77",
                      "reference_id": "or_3f4783edd45",
                      "amount": 0,
                      "status": "declined",
                      "payment_method": "card",
                      "created_at": "2023-07-01T11:50:37",
                      "card_transaction": {
                        "type": "voucher",
                        "funding_source": "prepaid",
                        "result": "failed",
                        "transaction_id": "14451082092153",
                        "brand_transaction_id": "K2QYL2",
                        "brand_return_code": "01",
                        "operation_id": "jrbd9gvm47fv2twjwnjw9wa2w",
                        "authorization_code": "ABC416",
                        "acquirer_message": "Erro não especificado",
                        "acquirer_return_code": "9999",
                        "card": {
                          "brand": "Sodexo"
                        }
                      }
                    }
                  },
                  "emv-approved-auth": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                      "reference_id": "787CVBNBN794",
                      "amount": 923,
                      "status": "authorized",
                      "payment_method": "card",
                      "created_at": "2023-07-01T11:50:37Z",
                      "card_transaction": {
                        "type": "credit",
                        "funding_source": "credit",
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "brand_transaction_id": "K2QYL2",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "authorization_code": "ABC416",
                        "acquirer_message": "Aprovado",
                        "acquirer_return_code": "0000",
                        "card": {
                          "brand": "Visa",
                          "emv_response": "1771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER41771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER41771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER41771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER4D45S",
                          "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
                        }
                      }
                    }
                  },
                  "emvV-approved-captured": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                      "reference_id": "787CVBNBN794",
                      "amount": 923,
                      "status": "paid",
                      "payment_method": "card",
                      "created_at": "2023-07-01T11:50:37Z",
                      "card_transaction": {
                        "type": "credit",
                        "funding_source": "credit",
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "brand_transaction_id": "K2QYL2",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "authorization_code": "ABC416",
                        "acquirer_message": "Aprovado",
                        "acquirer_return_code": "0000",
                        "card": {
                          "brand": "Visa",
                          "emv_response": "1771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER41771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER41771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER41771GCTRGRWTG718786787T8G7CER8CGF74E85486748CRE7T4F8ER4D45S",
                          "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
                        }
                      }
                    }
                  },
                  "magstripe-approved-auth": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                      "reference_id": "787CVBNBN794",
                      "amount": 923,
                      "status": "authorized",
                      "payment_method": "card",
                      "created_at": "2023-07-01T11:50:37Z",
                      "card_transaction": {
                        "type": "credit",
                        "funding_source": "credit",
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "brand_transaction_id": "K2QYL2",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "authorization_code": "ABC416",
                        "acquirer_message": "Aprovado",
                        "acquirer_return_code": "0000",
                        "card": {
                          "brand": "MasterCard",
                          "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
                        }
                      }
                    }
                  },
                  "magstripe-approved-captured": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                      "reference_id": "787CVBNBN794",
                      "amount": 923,
                      "status": "paid",
                      "payment_method": "card",
                      "created_at": "2023-07-01T11:50:37Z",
                      "card_transaction": {
                        "type": "credit",
                        "funding_source": "credit",
                        "result": "success",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "brand_transaction_id": "K2QYL2",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "authorization_code": "ABC416",
                        "acquirer_message": "Aprovado",
                        "card": {
                          "brand": "MasterCard",
                          "payment_account_reference": "50013CHVQMUPNSHIVDYVAG1H2V6LW"
                        }
                      }
                    }
                  },
                  "transaction-declined": {
                    "value": {
                      "id": "B7843C6C57836C5ETWGFU",
                      "initiator_id": "1470375860-3.19.3.3-RG0DA3-0001",
                      "reference_id": "787CVBNBN794",
                      "amount": 0,
                      "status": "declined",
                      "payment_method": "card",
                      "created_at": "2023-07-01T11:50:37Z",
                      "card_transaction": {
                        "type": "credit",
                        "result": "failed",
                        "transaction_id": "cb42d188-aca6-46f2-a2c9-046cb6342f5d",
                        "operation_id": "4d41314b-cb2d-4abe-b594-fd6875726e1b",
                        "acquirer_message": "Transação inválida",
                        "acquirer_return_code": "9102"
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
                        "description": "O 'amount' é obrigatório e deve ser um valor inteiro maior que 0."
                      }
                    }
                  },
                  "bad-request-acquirer-rejection": {
                    "value": {
                      "error_code": "provider_400",
                      "details": {
                        "message": "Transação Inválida",
                        "description": "The request was rejected by the provider  | IMSG|CardDataEntryMode = ICC and ICCRelatedData = null|"
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
      "PostChargeRequest": {
        "type": "object",
        "required": [
          "payment_method",
          "amount",
          "initiator_id",
          "local_datetime"
        ],
        "properties": {
          "payment_method": {
            "type": "string",
            "description": "Payment method da charge",
            "enum": [
              "card"
            ]
          },
          "amount": {
            "type": "integer",
            "format": "int64",
            "description": "Valor requisitado na cobrança em centavos."
          },
          "currency_code": {
            "type": "string",
            "minLength": 3,
            "maxLength": 3,
            "description": "Código da moeda de autorização da transação. Padrão ISO 3 dígitos. Quando não informado será considerado o valor default 986 (BRL)."
          },
          "initiator_id": {
            "type": "string",
            "maxLength": 123,
            "description": "Identificador externo (cliente) que pode ser utilizado em reversões e consultas."
          },
          "reference_id": {
            "type": "string",
            "maxLength": 128,
            "description": "Identificador externo, geralmente relacionado a um pedido ou outra referência do cliente, apenas em fluxos informacionais."
          },
          "local_datetime": {
            "type": "string",
            "format": "yyyy-MM-ddTHH:mm:ss",
            "description": "Data e hora da operação utilizando o fuso horário do local do dispositivo no formato ISO8601."
          },
          "channel": {
            "type": "string",
            "enum": [
              "standalone_device",
              "standalone_mobile",
              "website",
              "app",
              "payment_link"
            ],
            "description": "Canal de interação utilizado pelo cliente na inicialização da transação:\n  * `standalone_device` - Dispositivos que processam a transação de forma autônoma e direta (ex. POS).\n  * `standalone_mobile` - Dispositivos mobile que processam a transação de forma autônoma e direta (ex. TapPhone).\n  * `website` - Transações realizadas via ecommerce.\n  * `app` - Transações realizadas via aplicativo.\n  * `payment_link` - Obrigatório para transações realizadas através de link de pagamento.\n"
          },
          "card_transaction": {
            "description": "Informações específicas para transações utilizando o método de pagamento cartão",
            "type": "object",
            "required": [
              "type",
              "card",
              "operation_type"
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
              "operation_type": {
                "type": "string",
                "default": "auth_and_capture",
                "enum": [
                  "pre-auth",
                  "auth_only",
                  "auth_and_capture"
                ],
                "description": "Informa qual tipo de operação será realizada na autorização:\n  * `pre_auth`: Indica uma pré-autorização que ficará aberta à captura por 30 dias.\n  * `auth_only`: Indica uma autorização padrão, ficando aberta à captura por 07 dias.\n  * `auth_and_capture`: Indica que a captura será realiza de forma automática e imeditada.\n"
              },
              "installments": {
                "type": "integer",
                "format": "int32",
                "default": 0,
                "minimum": 0,
                "maximum": 99,
                "description": "Quantidade de parcelas da cobrança. Para cobranças à vista o valor deverá ser 0"
              },
              "installments_type": {
                "type": "string",
                "default": "none",
                "enum": [
                  "none",
                  "issuer",
                  "merchant"
                ],
                "description": "Indicação de quem oferece o parcelamento;\n  * `issuer`: Parcelamento oferecido pelo emissor (com juros).\n  * `merchant`: Parcelamento oferecido pelo lojista (sem juros).\n  * `none`: Sem parcelamento (à vista).\n"
              },
              "statement_descriptor": {
                "type": "string",
                "maxLength": 35,
                "description": "Informação adicional apresentada na filipeta para o comprador final. Em geral o nome fantasia do cliente."
              },
              "currency_conversion": {
                "type": "object",
                "required": [
                  "token",
                  "currency_code",
                  "converted_amount"
                ],
                "properties": {
                  "token": {
                    "type": "string",
                    "description": "Token contendo os dados da conversão da moeda."
                  },
                  "currency_code": {
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 3,
                    "description": "Código da moeda de autorização da transação no cartão do portador. Padrão ISO 3 dígitos"
                  },
                  "converted_amount": {
                    "type": "number",
                    "format": "int32",
                    "description": "Valor da transação na moeda de autorização do portador."
                  }
                }
              },
              "card": {
                "type": "object",
                "required": [
                  "number",
                  "expiration_date",
                  "token",
                  "entry_mode"
                ],
                "properties": {
                  "number": {
                    "type": "string",
                    "format": "int32",
                    "minLength": 8,
                    "maxLength": 19,
                    "description": "Número do cartão (PAN) sendo utilizado na cobrança. OBRIGATÓRIO caso não seja informado um payment_token."
                  },
                  "expiration_date": {
                    "type": "string",
                    "format": "YYMM",
                    "description": "Data de expiração do cartão utilizando o formato ano e mês \"YYMM\". OBRIGATÓRIO caso não seja informado um payment_token."
                  },
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
                  "holder_name": {
                    "type": "string",
                    "description": "Nome do portador do cartão."
                  },
                  "holder_document_number": {
                    "type": "string",
                    "description": "Número do documento do portador do cartão."
                  },
                  "cvv": {
                    "type": "string",
                    "format": "int32",
                    "maxLength": 4,
                    "description": "Código de segurança do cartão."
                  },
                  "emv_data": {
                    "type": "string",
                    "description": "Dados no padrão EMV obtidos do chip do cartão."
                  },
                  "track_1": {
                    "type": "string",
                    "description": "Trilha 1 de dados do cartão."
                  },
                  "track_2": {
                    "type": "string",
                    "description": "Trilha 2 de dados do cartão."
                  },
                  "track_3": {
                    "type": "string",
                    "description": "Trilha 3 de dados do cartão."
                  },
                  "sequence_number": {
                    "type": "string",
                    "description": "Identifica um cartão dentro de um conjunto de cartões com o mesmo número de cartão (PAN)."
                  },
                  "fallback": {
                    "type": "boolean",
                    "default": false,
                    "description": "Indicação se está sendo utilizado o entry_mode de fallback."
                  },
                  "token": {
                    "type": "object",
                    "description": "Objeto que contém os dados de tokenização do cartão na bandeira. OBRIGATÓRIO caso não seja informado um número de cartão aberto (number) e data de expiração.",
                    "required": [
                      "number",
                      "expiration_date"
                    ],
                    "properties": {
                      "number": {
                        "type": "string",
                        "description": "Token gerado pela bandeira."
                      },
                      "expiration_date": {
                        "type": "string",
                        "format": "YYMM",
                        "description": "Data de expiração do token utilizando o formato ano e mês \"YYMM\"."
                      },
                      "cryptogram": {
                        "type": "string",
                        "description": "Criptograma do Token."
                      },
                      "eci": {
                        "type": "string",
                        "description": "Resultado da autenticação do token:\n  * `02` ou `05`: OK.\n  * `01` ou `06`: Attempted.\n  * `00` ou `07`: Failed.\n"
                      },
                      "requestor_id": {
                        "type": "string",
                        "description": "Identificador do requerente do Token."
                      }
                    }
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
                      "offline_pin",
                      "online_pin",
                      "wallet",
                      "emv_3ds"
                    ],
                    "description": "Método de autenticação do titular do cartão:\n  * `offline_pin`: Autenticação do PIN no ICC do cartão.\n  * `online_pin`: Autenticação criptografada e verificada pelo emissor do cartão.\n  * `wallet`: Autenticação baseada em uma carteira digital.\n  * `emv_3ds`: Autenticação baseada no padrão 3DS\n"
                  },
                  "online_pin": {
                    "type": "object",
                    "description": "Dados da autenticação criptografada e verificada pelo emissor do cartão.",
                    "required": [
                      "algorithm"
                    ],
                    "properties": {
                      "algorithm": {
                        "type": "string",
                        "enum": [
                          "dukpt_3des"
                        ],
                        "description": "Algoritmo de criptografia utilizado na senha do cliente."
                      },
                      "ksi": {
                        "type": "string",
                        "format": "binary",
                        "example": "2020080303",
                        "description": "Identificação usada para derivar uma chave única de uma chave mestra fornecida para os dados proteção."
                      },
                      "ksn": {
                        "type": "string",
                        "format": "binary",
                        "example": "398A00137C",
                        "description": "Chave de criptografia de chave criptografada."
                      },
                      "pin_block": {
                        "type": "string",
                        "format": "binary",
                        "example": "9DDBB990C440FB0D",
                        "description": "Dados criptografados, resultado da criptografia de conteúdo."
                      }
                    }
                  },
                  "wallet": {
                    "type": "object",
                    "description": "Dados da autenticação realizada pela carteira digital.",
                    "properties": {
                      "cryptogram": {
                        "type": "string",
                        "description": "Criptograma gerado pelo carteira digital."
                      },
                      "eci": {
                        "type": "string",
                        "description": "Resultado da autenticação:\n  * `02` ou `05`: OK.\n  * `01` ou `06`: Attempted.\n  * `00` ou `07`: Failed.\n",
                        "enum": [
                          "00",
                          "01",
                          "02",
                          "05",
                          "06",
                          "07"
                        ]
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "applepay",
                          "googlepay",
                          "clicktopay"
                        ],
                        "description": "Tipo da Wallet"
                      }
                    }
                  },
                  "emv_3ds": {
                    "type": "object",
                    "description": "Dados da autenticação realizada pelo serviço de 3DS.",
                    "required": [
                      "directory_server_id",
                      "cryptogram"
                    ],
                    "properties": {
                      "directory_server_id": {
                        "type": "string",
                        "description": "O identificador da transação gerado pelo servidor de 3DS."
                      },
                      "cryptogram": {
                        "type": "string",
                        "description": "Criptograma gerado pelo  serviço de 3DS."
                      },
                      "eci": {
                        "type": "string",
                        "description": "Resultado da autenticação:\n  * `02` ou `05`: OK.\n  * `01` ou `06`: Attempted.\n  * `00` ou `07`: Failed.\n  * `DATA_ONLY`: Data Only.\n",
                        "enum": [
                          "00",
                          "01",
                          "02",
                          "05",
                          "06",
                          "07",
                          "DATA_ONLY"
                        ]
                      },
                      "status": {
                        "type": "string",
                        "description": "Resultado da autenticação:\n  * `Y`: Authentication Verification Successful.\n  * `N`: Not Authenticated / Account Not Verified;\n  * `U`: Authentication / Account Verification Could Not Be Performed; Technical or other problem, as indicated in ARes or RReq.\n  * `A`: Attempts Processing Performed; Not Authenticated/Verified, but a proof of attempted authentication/verification is provided. \n  * `R`: Authentication / Account Verification Rejected; Issuer is rejecting authentication/verification and request that auth.\n  * `I`: Data Only.\n",
                        "enum": [
                          "Y",
                          "N",
                          "U",
                          "A",
                          "R",
                          "I"
                        ]
                      },
                      "version": {
                        "type": "string",
                        "description": "Versão do 3DS. Exemplo `VRS21` para indicar 3D Secure 2.1."
                      },
                      "xid": {
                        "type": "string",
                        "description": "ID de 3DS retornado no processo de autenticação."
                      }
                    }
                  }
                }
              },
              "merchant_category_code": {
                "type": "string",
                "description": "Código de categoria do lojista ou sublojista relacionado à cobrança."
              }
            }
          },
          "sub_merchant": {
            "type": "object",
            "description": "Dados do cliente que possui o cadastro com a adquirente e está utilizando um facilitador de pagamento.",
            "required": [
              "id",
              "document",
              "document_type"
            ],
            "properties": {
              "id": {
                "type": "string",
                "description": "Identificador do sublojista atribuído pela Subadquirente."
              },
              "payment_facilitator_id": {
                "type": "string",
                "description": "Cadastro do facilitador de pagamento junto as bandeiras."
              },
              "name": {
                "type": "string",
                "description": "Nome do sublojista, para fins informacionais na fatura do comprador. Quando informado tem prioridade sobre o _statement_descriptor_."
              },
              "document": {
                "type": "string",
                "minLength": 8,
                "maxLength": 14,
                "description": "Documento do sublojista cadastrado com a adquirente, sem separadores."
              },
              "document_type": {
                "type": "string",
                "enum": [
                  "cpf",
                  "cnpj",
                  "passport"
                ],
                "description": "Tipo de documento usado no cadastro com a adquirente."
              },
              "email": {
                "type": "string",
                "description": "Endereço eletrônico do sublojista."
              },
              "phone_number": {
                "type": "string",
                "description": "Número de telefone do sublojista."
              },
              "site": {
                "type": "string",
                "description": "Endereço do ecommerce do sublojista."
              },
              "legal_name": {
                "type": "string",
                "description": "Razão social do sublojista."
              },
              "address": {
                "type": "object",
                "description": "Endereço de cobrança do sublojista.",
                "properties": {
                  "street": {
                    "type": "string",
                    "description": "Rua do endereço."
                  },
                  "number": {
                    "type": "string",
                    "description": "Número do endereço."
                  },
                  "complement": {
                    "type": "string",
                    "description": "Campo para adicionar informações complementares do endereço."
                  },
                  "city": {
                    "type": "string",
                    "description": "Cidade do endereço."
                  },
                  "state": {
                    "type": "string",
                    "description": "Estado do endereço."
                  },
                  "district": {
                    "type": "string",
                    "description": "Bairro do endereço."
                  },
                  "country_code": {
                    "type": "string",
                    "default": "076",
                    "description": "Codigo do pais. Padrão ISO 3166. Quando não informado será considerado o valor default \"076\" (Brasil)"
                  },
                  "zip_code": {
                    "type": "string",
                    "description": "Código portal do endereço, sem separadores ou espaçamento."
                  }
                }
              },
              "gateway_id": {
                "type": "string",
                "description": "Identificador do gateway de pagamentos utilizado pelo sublojista"
              }
            }
          },
          "initiator": {
            "type": "object",
            "description": "Indicador de inicialização de transação",
            "properties": {
              "initiating_entity": {
                "type": "string",
                "description": "Indica o agente iniciador da transação:\n  * `account_holder`: Indica a participação ativa do comprador na inicialização.\n  * `merchant`: Indica a inicialização pelo lojista.\n",
                "enum": [
                  "account_holder",
                  "merchant"
                ]
              },
              "initiating_reason": {
                "type": "string",
                "description": "Indica o tipo de transação realizada:\n  * `credentials_on_file`: Transação com credencial (dados de cartão) armazenada (MIT/CIT).\n  * `standing_order`: Ordem Permanente (MIT/CIT).\n  * `subscription`: Assinatura (MIT/CIT).\n  * `installment`: Parcelado (MIT/CIT).\n  * `partial_shipment`: Remessa Parcial (MIT/CIT).\n  * `delayed_charge`: Cobrança atrasada (MIT/CIT).\n  * `no_show`: No show - Multa (MIT/CIT).\n  * `retry`: Reenvio (MIT/CIT).\n  * `deferred_payment`: Pagamento diferido (Mobilidade Urbana).\n  * `debit_recovery`: Recuperação de débito (Mobilidade Urbana).\n  * `installment_payment`: Parcelamento através de mecanismo de recorrência. \n  São realizadas N transações espalhadas por um período de tempo ao invés de uma transação parcelada em N vezes.\n  Esse modelo é utilizado para sensibilizar o saldo do portador de forma parcial ao invés de o valor total de uma só vez.\n  * `marketplace`: Aceitante indireto que oferece sua plataforma de marca.\n  * `peer_to_peer`:  Transação que transfere fundos de/para usuários registrados de uma carteira digital.\n  * `stage_back_to_back`: Transação para gerar fundos na carteira digital para o pagamentos de compras e serviços em tempo real.\n  * `stored_value`: Transação que gera fundos na carteira digital para pagamentos subsequentes para um ou vários beneficiários finais.\n  * `bill_payment`: Pagamento de fatura.\n",
                "enum": [
                  "credentials_on_file",
                  "standing_order",
                  "subscription",
                  "installment",
                  "partial_shipment",
                  "delayed_charge",
                  "no_show",
                  "retry",
                  "deferred_payment",
                  "debit_recovery",
                  "installment_payment",
                  "marketplace",
                  "peer_to_peer",
                  "stage_back_to_back",
                  "stored_value",
                  "bill_payment",
                  "card_funds_transfer"
                ]
              }
            }
          },
          "first_transaction": {
            "type": "object",
            "description": "Dados relacionados a transação original.",
            "properties": {
              "brand_transaction_id": {
                "type": "string",
                "description": "Identificador da transação original no Emissor."
              },
              "transaction_id": {
                "type": "string",
                "description": "Identificador da transação original emitido pelo provedor (Adquirente)."
              }
            }
          },
          "partner_platform_id": {
            "type": "string",
            "description": "Identificador do cliente em provedores externos."
          },
          "print_line_size": {
            "type": "integer",
            "format": "int32",
            "minimum": 1,
            "maximum": 999,
            "description": "Limite máximo de caracteres por linha na impressão da filipeta."
          },
          "payee": {
            "type": "object",
            "description": "Dados para transações de aporte de recursos.",
            "properties": {
              "destination_type": {
                "type": "string",
                "description": "Tipo de destino da transação.",
                "enum": [
                  "digital_wallet"
                ]
              },
              "destination_name": {
                "type": "string",
                "description": "Nome do destino do aporte de fundos."
              },
              "name": {
                "type": "string",
                "description": "Nome do destinatário."
              },
              "document": {
                "type": "string",
                "description": "Número do documento do destinatário."
              },
              "document_type": {
                "type": "string",
                "description": "Tipo de documento do destinatário.",
                "enum": [
                  "cpf",
                  "cnpj"
                ]
              }
            }
          },
          "customer": {
            "type": "object",
            "description": "Dados do cliente que está realizando a compra.",
            "properties": {
              "name": {
                "type": "string",
                "description": "Nome do cliente."
              },
              "document": {
                "type": "string",
                "description": "Número do documento do cliente."
              },
              "document_type": {
                "type": "string",
                "description": "Tipo de documento do cliente.",
                "enum": [
                  "cpf",
                  "cnpj",
                  "passport"
                ]
              },
              "email": {
                "type": "string",
                "description": "Endereço eletrônico do cliente."
              },
              "phone": {
                "type": "object",
                "description": "Número de telefone do cliente.",
                "properties": {
                  "country": {
                    "type": "string",
                    "description": "Código do país do telefone."
                  },
                  "area": {
                    "type": "string",
                    "description": "Código de área do telefone."
                  },
                  "number": {
                    "type": "string",
                    "description": "Número do telefone."
                  },
                  "type": {
                    "type": "string",
                    "description": "Tipo do telefone.",
                    "enum": [
                      "home",
                      "work",
                      "mobile"
                    ]
                  }
                }
              }
            }
          },
          "items": {
            "type": "array",
            "description": "Lista de itens da compra.",
            "items": {
              "type": "object",
              "properties": {
                "amount": {
                  "type": "integer",
                  "format": "int64",
                  "description": "Preço unitário do item em centavos."
                },
                "description": {
                  "type": "string",
                  "description": "Descrição do item."
                },
                "quantity": {
                  "type": "integer",
                  "format": "int32",
                  "description": "Quantidade do item."
                },
                "code": {
                  "type": "string",
                  "description": "Código do item."
                }
              }
            }
          }
        }
      },
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