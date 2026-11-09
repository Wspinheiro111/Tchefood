---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Fluxos Transacionais

A definição do fluxo transacional é uma etapa fundamental na integração, pois determina como o terminal POS interagirá com as ordens de pagamento geradas pelo seu sistema.

## Configuração e Credenciamento

A escolha do fluxo transacional é realizada obrigatoriamente no momento do credenciamento, seja este um credenciamento próprio do Parceiro ou de um cliente final.

> 📘 A configuração é flexível
>
> Cada Cliente pode adotar uma regra de fluxo distinta, permitindo que a integração se adapte às necessidades específicas do modelo de negócio de cada ponto de venda (PDV).

## Fluxos Transacionais

Existem dois modelos pré-definidos para a operação de pagamentos via POS integrado:

**1. Listagem de pedidos:**\
Neste modelo, o parceiro cria uma lista de pedidos que ficam disponíveis na nuvem. Ao acessar o aplicativo no POS, o terminal consulta e lista todos os pedidos em aberto vinculados àquele terminal e conta.

* **Funcionamento:** O operador visualiza a lista no POS, seleciona o pedido correspondente e prossegue para o pagamento.
* **Casos de Uso:** É ideal para operações onde existe mobilidade, Restaurantes com atendimento em balcão ou mesas, onde diversos pedidos são gerados simultaneamente e o cliente escolhe o momento para efetuar o pagamento. Venda Consultiva (Lojas de Departamento/Materiais de Construção), onde o vendedor cria um orçamento e entre outros.

![](https://files.readme.io/cb4de8f-list_orders.png "list_orders.png")

**2. Pagamento direto de pedidos:**\
Neste fluxo, o sistema do parceiro envia um pedido específico diretamente para um terminal POS previamente identificado.

* **Funcionamento:** O terminal permanece em estado de espera no App de Pagamentos. Assim que recebe a ordem de pagamento, ele aciona automaticamente a tela de transação (inserção/aproximação do cartão).
* **Caso de Uso:** Recomendado para Vendas Rápidas em PDV Fixo (Checkouts), como supermercados ou lojas de conveniência, onde a agilidade é prioritária e a venda é enviada diretamente do software de caixa para a máquina de cartão ao lado.

![](https://files.readme.io/12444c3-direct_payment.png "direct_payment.png")