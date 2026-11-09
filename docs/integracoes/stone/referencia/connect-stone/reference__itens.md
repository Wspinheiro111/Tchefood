---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Itens

Contem as informações detalhadas dos campos do objeto ITENS.

```json JSON

    "items": [
        {
            "amount": 2990,
            "description": "Chaveiro do Tesseract",
            "quantity": 1,
            "code": "123"
        }
    ],
```

| Nome                 | Descrição                                                                                                                   |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| items `objeto`       | Objeto que representa os itens do pedido. `obrigatório`                                                                     |
| amount `int`         | Valor que será cobrado o pedido, é somado conforme a quantidade de itens.  `obrigatório`                                    |
| description `string` | Descrição do item que está sendo vendido. `opcional`                                                                        |
| quantity `int`       | Quantidade de itens que será cobrado no pedido. A quantidade de itens determina o valor total de amount.  `obrigatório`     |
| code `string`        | Código definido pelo integrador. Serve como referencia entre API PagarMe e Software integrador dentro do pedido. `opcional` |