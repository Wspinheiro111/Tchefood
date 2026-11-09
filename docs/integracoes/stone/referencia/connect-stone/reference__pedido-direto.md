---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Exemplo de pedidos: Direto e Listado

Segue abaixo exemplos de como preencher os dois tipos de pedidos:

## Pedido Direto

Essa integração permite que o parceiro crie um pedido a ser pago diretamente para um POS integrado.

Nesse fluxo, o POS fica em espera, aguardando a criação de uma cobrança direcionada a ele. Ao receber um pedido, o POS entra automaticamente na tela de pagamento para realizar a transação.

As transações podem ser do tipo("Crédito", "débito", "voucher", "pix (Disponível versão 6.4 do app de pagamentos)")

## Pedido Listado

Essa integração permite que o parceiro crie uma lista de pedidos a serem pagas no POS. Nesse fluxo, o POS integrado irá listar todos os pedidos em aberto para esse terminal nessa conta no Pagar.me.

Dessa forma, o operador do POS poderá selecionar um pedido para realizar seu pagamento. Ao realizar um pagamento de um pedido selecionado, o parceiro irá receber um webhook de charge.paid para o informar que a cobrança foi paga.

Neste modelo é possível realizar algumas operações como:

Pagar um valor diferente do listado originalmente\
Pagar com mais de um tipo de cartão (Débito + Crédito, Crédito + Voucher, Crédito + Crédito, etc).

> 🚧 Cancelamento de pedido
>
> O fluxo de cancelamento de transações é iniciado via POS, que envia ao parceiro um webhook de charge.refunded para o informar que a cobrança foi reembolsada.

### Exemplos de pedido:

```json Pedido Direto
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
        "print_order_receipt": "false",
        "devices_serial_number": ["123456789"],
    "payment_setup": {
          "type": "credit",
          "installments": 1,
          "installment_type": "merchant"
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
        "print_order_receipt": "false",
        "devices_serial_number": [
          "123456789"
    ],
    "display_name": "Pedido #1"
   }
}
```