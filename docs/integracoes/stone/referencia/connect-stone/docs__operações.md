---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Operações

## Ativação

Para que você comece a operar com o Connect Stone, temos algumas etapas de ativação. Algumas delas serão feitas internamente pelo seu Account Manager, e outras você irá realizar diretamente no nosso Partner Hub.

Assim que você homologar seu produto conosco, lhe enviaremos um manual de como realizar o credenciamento do seu cliente e a ativação do produto.

## Fluxo Geral

Na imagem abaixo, temos o fluxo geral transacional com a integração Connect Stone.

![](https://files.readme.io/90318c8-fluxoConnect2.JPG "fluxoConnect2.JPG")

Após a habilitação do produto, é necessário que o sistema faça algumas requisições na API para poder começar a se comunicar com o POS. O fluxo transacional está descrito abaixo:

**Legenda**

1. Criação do pedido na API do Pagar.me (via PDV, inStore etc.)
2. POS recebe o pedido criado
3. POS realiza o pagamento de um pedido criado no Pagar.me passando pela adquirente
4. Adquirente envia resposta da transação para o POS e para o Pagar.me
5. Pagar.me envia webhook de pagamento realizado para o parceiro

***

**Etapa Opcional**

6. Parceiro envia nota fiscal a ser impressa no POS
7. POS recebe nota fiscal e a imprime, finalizando fluxo de pagamento

## Tipos de Integração

* **Listagem de Pedidos**

Essa integração permite que o parceiro crie uma lista de pedidos a serem pagas no POS. Nesse fluxo, o POS integrado irá listar todos os pedidos em aberto para esse terminal nessa conta no Pagar.me.

Dessa forma, o operador do POS poderá selecionar um pedido para realizar seu pagamento. Ao realizar um pagamento de um pedido selecionado, o parceiro irá receber um webhook de charge.paid para o informar que a cobrança foi paga.

O fluxo de cancelamento de transações é iniciado via POS, que envia ao parceiro um webhook de charge.refunded para o informar que a cobrança foi reembolsada.

Neste modelo é possível realizar algumas operações como:

* Pagar um valor diferente do listado originalmente
* Pagar com mais de um tipo de cartão (Débito + Crédito, Crédito + Voucher, Crédito + Crédito, etc)

![](https://files.readme.io/68266a0-lista_pedidos.png "lista pedidos.png")

* **Pagamento Direto**

Essa integração permite que o parceiro crie um pedido a ser pago diretamente para um POS integrado.

Nesse fluxo, o POS fica em espera, aguardando a criação de uma cobrança direcionada a ele. Ao receber um pedido, o POS entra automaticamente na tela de pagamento para realizar a transação.

O fluxo ao realizar pagamento ou cancelamento de transações é idêntico ao  primeiro - Listagem de pedidos.

![](https://files.readme.io/021380a-pedido_direto.png "pedido direto.png")

## Pedidos

**Criação do Pedido**\
É o iniciador do processo operacional, através do PDV é enviado todas as informações para que o POS receba os parâmetros necessários e o cliente consiga efetuar o pagamento diretamente no terminal.

**Pagamento do Pedido**\
É a etapa em que consiste a efetivação do pagamento do [Pedido](https://connect-stone.stone.com.br/docs/conceitos) através da inserção do cartão de crédito, débito ou voucher. Este pagamento reflete no Pagar.me como uma [Cobrança](https://connect-stone.stone.com.br/docs/conceitos) (charge) adicionada ao Pedido.

**Webhook de charge.paid**\
Após a realização do pagamento, é disparado um Webhook com a confirmação do Cobrança.

**Fechamento de Pedido**\
Após o recebimento do webhook com a Cobrança paga (charge.paid), o Pedido deverá ser fechado para que o mesmo não conste mais na Lista de Pedidos ou na fila de Pagamentos Diretos.

## Webhooks

Os webhooks são utilizados para notificar de forma automatizada todos os eventos pertinentes às cobranças feitas no terminal, através deles é possível garantir que todas as etapas do processo foram executadas.

**Tipos de webhook**

* charge.paid\
  Ocorre sempre que uma cobrança é paga. É disparado quando a transação é aprovada no POS.

* charge.refunded\
  Ocorre sempre que uma cobrança é estornada. é disparado quando é efetuado um cancelamento da transação no POS.

## Ambientes

**Sandbox**\
Hoje ainda não oferecemos um ambiente de teste para integração.\
Devido a estrutura da API Connect Stone estar ligada diretamente a outras aplicações, sendo a principal o Mamba, onde ocorrem as transações e, essa ainda não possuir um ambiente controlado, a API Connect Stone fica sem possibilidade de replicar um ambiente de testes.

> 🚧
>
> Recomendamos que ao fazer testes de vendas (transações), façam o cancelamento logo depois para que o valor seja estornado de sua conta bancária.