---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Exemplo de pedidos

## Pedido Direto

Essa integração permite que o parceiro crie um pedido a ser pago diretamente para um POS integrado.

Nesse fluxo, o POS fica em espera, aguardando a criação de uma cobrança direcionada a ele. Ao receber um pedido, o POS entra automaticamente na tela de pagamento para realizar a transação.

As transações podem ser do tipo "Crédito" e "débito" e precisam ser declaradas na criação do pedido via API. Pix e Voucher estão disponíveis APENAS no Connect Stone.

## Pedido Listado

Essa integração permite que o parceiro crie uma lista de pedidos a serem pagas no POS. Nesse fluxo, o POS integrado irá listar todos os pedidos em aberto para esse terminal nessa conta no Pagar.me.

Dessa forma, o operador do POS poderá selecionar um pedido para realizar seu pagamento. Ao realizar um pagamento de um pedido selecionado, o parceiro irá receber um webhook de charge.paid para o informar que a cobrança foi paga.

O fluxo de cancelamento de transações é iniciado via POS, que envia ao parceiro um webhook de charge.refunded para o informar que a cobrança foi reembolsada.

Neste modelo é possível realizar algumas operações como:

Pagar um valor diferente do listado originalmente\
Pagar com mais de um tipo de cartão (Débito + Crédito, Crédito + Voucher, Crédito + Crédito, etc)

<br />

> ❗️ IMPORTANTE
>
> Desde fev/26, todas as integrações devem ser atualizadas para o modelo de **SPLIT NA AUTORIZAÇÃO**.
>
> Ou seja, as regras de split devem ser enviadas, obrigatoriamente, no momento de criar o pedido via PDV.
>
> Veja mais informações de como enviar a requisição com as novas regras em "Criar pedido para maquininha" no menu do lado esquerdo da sua tela.

<br />

### Exemplos de pedido:

```json Pedido Direto
{
    "customer": { //dados do cliente. Sugerimos enviar "nome" e "e-mail"
        "name": "Teste",
        "email": "teste@teste.com.br"
    },
    "items": [ //o que foi comprado, quantidade e valor unitário
        {
            "amount": 1990,
            "description": "Chaveiro do Tesseract",
            "quantity": "1"
        }
    ],
    "closed": false, //sempre como "false"
    "poi_payment_settings": { //configurações do pagamento para o POS
        "visible": "true", //sempre "true"
        "print_order_receipt": "false", //para impressão customizada. Ver a seção "Impressão de Nota Fiscal" aqui na documentação
        "devices_serial_number": ["123456789"], //lista de maquininhas que receberão o pedido. Se enviado em branco, todas as máquinas vinculadas ao stonecode receberão o pedido
    "payment_setup": { //forma de pagamento
          "type": "credit", 
          "installments": 1,
          "installment_type": "merchant" //apenas "merchant"
    },
    "display_name": "Pedido #1"
    }
}
```
```json Pedido Listado
{
    "customer": {
    "name": "Teste",
    "email": "teste@teste.com.br"
    },
    "items": [
        {
            "amount": 1990,
            "description": "Chaveiro do Tesseract",
            "quantity": "1"
        }
    ],
    "closed": false,
    "poi_payment_settings": {
        "visible": "true",
        “print_order_receipt”: “false”,
        "devices_serial_number": [
          "123456789"
    ],
    "display_name": "Pedido #1"
   }
}
```

<br />

**Exemplo de RESPONSE:**

```json Response
{
    "id": "or_MBKw3GgCrvip1wy3", //ID do pedido criado
    "code": "JXQ7TY5U3O",
    "amount": 1990,
    "currency": "BRL",
    "closed": false,
    "items": [
        {
            "id": "oi_XKOwKYgFjriG9BkP",
            "type": "product",
            "description": "Chaveiro do Tesseract",
            "amount": 1990,
            "quantity": 1,
            "status": "active",
            "created_at": "2025-01-24T11:58:09Z",
            "updated_at": "2025-01-24T11:58:09Z"
        }
    ],
    "customer": {
        "id": "cus_4nDp5WyH2sbgAPdW",
        "name": "Teste",
        "email": "teste@teste.com.br",
        "delinquent": false,
        "created_at": "2024-10-16T18:55:45Z",
        "updated_at": "2025-01-24T11:58:09Z",
        "phones": {}
    },
    "status": "pending",
    "created_at": "2025-01-24T11:58:09Z",
    "updated_at": "2025-01-24T11:58:09Z",
    "poi_payment_settings": {
        "visible": true,
        "display_name": "Pedido #1",
        "print_order_receipt": false,
        "payment_setup": {
            "type": "credit",
            "installments": 1,
            "installment_type": "merchant"
        },
        "devices_serial_number": [
            "123456789"
        ],
        "updated_at": "2025-01-24T11:58:09Z",
        "created_at": "2025-01-24T11:58:09Z"
    }
}
```