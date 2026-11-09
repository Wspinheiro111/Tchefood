---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Obter pedido

> ❗️ Atenção
>
> A rota de obter pedidos deve ser usada **apenas** em fluxos de resiliência.
>
> A aplicação integrada no Connect 2.0 deve usar webhooks para tratar os cenários transacionais e receber de forma passiva as respostas.
>
> Caso a aplicação integre utilizando a rota de obter pedidos, está sujeita a limites de consulta que podem variar de acordo com o número de requisições, portanto, não é recomendado a integração neste endpoint para atualizar o fluxo transacional.

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
    "/core/v5/orders/{order_id}": {
      "get": {
        "summary": "Obter pedido",
        "description": "",
        "operationId": "obter-pedido",
        "parameters": [
          {
            "name": "order_id",
            "in": "path",
            "description": "Id do pedido criado",
            "schema": {
              "type": "string"
            },
            "required": true
          }
        ],
        "responses": {
          "200": {
            "description": "200",
            "content": {
              "application/json": {
                "examples": {
                  "Result": {
                    "value": "{\n    \"id\": \"or_WwQN2zKtaSOXaaaa\",\n    \"code\": \"PD73A4YHMO\",\n    \"amount\": 200,\n    \"currency\": \"BRL\",\n    \"closed\": false,\n    \"items\": [\n        {\n            \"id\": \"oi_B1EQVZHdzhJJaaaa\",\n            \"type\": \"product\",\n            \"description\": \"Produto teste\",\n            \"amount\": 200,\n            \"quantity\": 1,\n            \"status\": \"active\",\n            \"created_at\": \"2022-09-13T14:22:23Z\",\n            \"updated_at\": \"2022-09-13T14:22:23Z\",\n            \"code\": \"1\"\n        }\n    ],\n    \"customer\": {\n        \"id\": \"cus_4r8eZzvtwh6aaaa\",\n        \"name\": \"Customer 1\",\n        \"email\": \"customer1@email.com\",\n        \"document\": \"13621248773\",\n        \"type\": \"individual\",\n        \"delinquent\": false,\n        \"created_at\": \"2022-09-13T14:19:11Z\",\n        \"updated_at\": \"2022-09-13T14:19:11Z\",\n        \"phones\": {\n            \"home_phone\": {\n                \"country_code\": \"55\",\n                \"number\": \"000000000\",\n                \"area_code\": \"21\"\n            },\n            \"mobile_phone\": {\n                \"country_code\": \"55\",\n                \"number\": \"000000000\",\n                \"area_code\": \"21\"\n            }\n        }\n    },\n    \"status\": \"pending\",\n    \"created_at\": \"2022-09-13T14:22:23Z\",\n    \"updated_at\": \"2022-09-13T14:22:23Z\",\n    \"poi_payment_settings\": {\n        \"visible\": true,\n        \"display_name\": \"#pedido1\",\n        \"payment_setup\": {\n            \"type\": \"credit\",\n            \"installments\": 1,\n            \"installment_type\": \"merchant\"\n        },\n        \"devices_serial_number\": [\n            \"123456789\"\n        ],\n        \"updated_at\": \"2022-09-13T14:22:23Z\",\n        \"created_at\": \"2022-09-13T14:22:23Z\"\n    },\n    \"checkouts\": []\n}"
                  }
                },
                "schema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "example": "or_WwQN2zKtaSOXaaaa"
                    },
                    "code": {
                      "type": "string",
                      "example": "PD73A4YHMO"
                    },
                    "amount": {
                      "type": "integer",
                      "example": 200,
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
                            "example": "oi_B1EQVZHdzhJJaaaa"
                          },
                          "type": {
                            "type": "string",
                            "example": "product"
                          },
                          "description": {
                            "type": "string",
                            "example": "Produto teste"
                          },
                          "amount": {
                            "type": "integer",
                            "example": 200,
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
                            "example": "2022-09-13T14:22:23Z"
                          },
                          "updated_at": {
                            "type": "string",
                            "example": "2022-09-13T14:22:23Z"
                          },
                          "code": {
                            "type": "string",
                            "example": "1"
                          }
                        }
                      }
                    },
                    "customer": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "example": "cus_4r8eZzvtwh6aaaa"
                        },
                        "name": {
                          "type": "string",
                          "example": "Customer 1"
                        },
                        "email": {
                          "type": "string",
                          "example": "customer1@email.com"
                        },
                        "document": {
                          "type": "string",
                          "example": "13621248773"
                        },
                        "type": {
                          "type": "string",
                          "example": "individual"
                        },
                        "delinquent": {
                          "type": "boolean",
                          "example": false,
                          "default": true
                        },
                        "created_at": {
                          "type": "string",
                          "example": "2022-09-13T14:19:11Z"
                        },
                        "updated_at": {
                          "type": "string",
                          "example": "2022-09-13T14:19:11Z"
                        },
                        "phones": {
                          "type": "object",
                          "properties": {
                            "home_phone": {
                              "type": "object",
                              "properties": {
                                "country_code": {
                                  "type": "string",
                                  "example": "55"
                                },
                                "number": {
                                  "type": "string",
                                  "example": "000000000"
                                },
                                "area_code": {
                                  "type": "string",
                                  "example": "21"
                                }
                              }
                            },
                            "mobile_phone": {
                              "type": "object",
                              "properties": {
                                "country_code": {
                                  "type": "string",
                                  "example": "55"
                                },
                                "number": {
                                  "type": "string",
                                  "example": "000000000"
                                },
                                "area_code": {
                                  "type": "string",
                                  "example": "21"
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    "status": {
                      "type": "string",
                      "example": "pending"
                    },
                    "created_at": {
                      "type": "string",
                      "example": "2022-09-13T14:22:23Z"
                    },
                    "updated_at": {
                      "type": "string",
                      "example": "2022-09-13T14:22:23Z"
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
                          "example": "#pedido1"
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
                              "example": 1,
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
                            "example": "123456789"
                          }
                        },
                        "updated_at": {
                          "type": "string",
                          "example": "2022-09-13T14:22:23Z"
                        },
                        "created_at": {
                          "type": "string",
                          "example": "2022-09-13T14:22:23Z"
                        }
                      }
                    },
                    "checkouts": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {}
                      }
                    }
                  }
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
  "_id": "6286b4313190d80013ab43df:6320926796cfff004c9b838c"
}
```