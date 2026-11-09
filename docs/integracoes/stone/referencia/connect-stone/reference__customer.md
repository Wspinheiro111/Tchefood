---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Customer

Contem as informações detalhadas dos campos do objeto CUSTOMER.

```json
"customer": {
        "name": "Tony Stark",
        "email": "testes@gmail.com",
            },
```

| Nome              | Descrição                                        |
| :---------------- | :----------------------------------------------- |
| customer `objeto` | Dados do comprador `obrigatório`                 |
| name `string`     | Nome do cliente. Max 64 caracteres `obrigatório` |
| email `string`    | E-mail do cliente. Max 64 caracteres. `opcional` |