---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Split na criação do pedido

Contém detalhes para adicionar o objeto de split na criação de um pedido.

> ❗️ IMPORTANTE
>
> Desde fev/26, todas as integrações devem ser atualizadas para o modelo de **SPLIT NA AUTORIZAÇÃO**.
>
> Ou seja, as regras de split devem ser enviadas, obrigatoriamente, no momento de criar o pedido via PDV.
>
> Veja mais informações de como enviar a requisição com as novas regras em "Criar pedido para maquininha" no menu do lado esquerdo da sua tela.

<br />

> ⚠️ Uso de MCC de um recebedor secundário
>
> Para uso de MCC de um recebedor secundário, é necessário respeitar as seguintes regras:
>
> * Estar com a funcionalidade ativa para a conta. Para validação ou ativação, entrar em contato com o time de parceiras.
> * Enviar as regras de split na criação do pedido.
> * Adicionar somente 2 recebedores nas regras de split, o recebedor primário da conta, e o secundário, que será o que terá o MCC levado em consideração na transação.
>   * O MCC é resgatado automaticamente a partir do CNPJ do recebedor.

**Exemplo Request**

```json JSON
{
    "items": [
        {
            "amount": 500,
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
        "devices_serial_number": ["12345678"],
        "payment_setup": {
            "type": "credit",
            "installments": 1,
            "installment_type": "merchant",
            "split": [
                {
                    "amount": 70,
                    "recipient_id": "rp_XXXXXXXXXXXXXXXX",
                    "type": "percentage",
                    "options": {
                        "liable": true,
                        "charge_remainder_fee": true,
                        "charge_processing_fee": true
                    }
                },
                {
                    "amount": 30,
                    "recipient_id": "rp_YYYYYYYYYYYYYYYY",
                    "type": "percentage",
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
```

**Exemplo Response**

```json JSON
{
    "id": "or_j1eJPeQt6hxPm7vW",
    "code": "DN42H9KI35",
    "amount": 500,
    "currency": "BRL",
    "closed": false,
    "items": [
        {
            "id": "oi_rqPkzdl8IbfYzvjB",
            "type": "product",
            "description": "Chaveiro do Tesseract",
            "amount": 500,
            "quantity": 1,
            "status": "active",
            "created_at": "2024-12-27T15:20:58Z",
            "updated_at": "2024-12-27T15:20:58Z",
            "code": "123"
        }
    ],
    "customer": {
        "id": "cus_LQ0Z2eIlQide89bE",
        "name": "Tony Stark",
        "email": "testes@gmail.com",
        "document": "13621248773",
        "type": "individual",
        "delinquent": false,
        "created_at": "2024-09-24T16:57:32Z",
        "updated_at": "2024-12-19T16:57:00Z",
        "phones": {
            "home_phone": {
                "country_code": "55",
                "number": "000000000",
                "area_code": "21"
            },
            "mobile_phone": {
                "country_code": "55",
                "number": "000000000",
                "area_code": "21"
            }
        }
    },
    "status": "pending",
    "created_at": "2024-12-27T15:20:58Z",
    "updated_at": "2024-12-27T15:21:21Z",
    "poi_payment_settings": {
        "visible": true,
        "display_name": "Mesa 1",
        "print_order_receipt": false,
        "payment_setup": {
            "type": "credit",
            "installments": 1,
            "installment_type": "merchant"
        },
        "devices_serial_number": [
            "12345678"
        ],
        "updated_at": "2024-12-27T15:20:58Z",
        "created_at": "2024-12-27T15:20:58Z"
    }
}
```

| Nome                             | Descrição                                                                                       |
| :------------------------------- | :---------------------------------------------------------------------------------------------- |
| split `object`                   | Objeto que representa os itens do pedido.                                                       |
| amount `int`                     | Valor destinado ao recebedor.                                                                   |
| recipient\_id`string`            | Código do recebedor. Formato: rp\_XXXXXXXXXXXXXXXX.                                             |
| type`string`                     | Tipo de divisão. Os valores possíveis são flat (por valor) ou percentage (por porcentagem).     |
| options`object`                  | Informações da responsabilidade do recebedor na transação.                                      |
| charge\_processing\_fee`boolean` | Indica se o recebedor vinculado à regra será cobrado pelas taxas da transação.                  |
| charge\_remainder\_fee`boolean`  | Indica se o recebedor vinculado à regra irá receber o restante dos recebíveis após uma divisão. |
| liable`boolean`                  | Indica se o recebedor é responsável pela transação em caso de chargeback.                       |