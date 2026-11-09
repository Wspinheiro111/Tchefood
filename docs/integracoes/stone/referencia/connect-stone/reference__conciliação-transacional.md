---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Conciliação Transacional

Para consultar as transações que são realizadas, temos duas opções:

* **Via Dashboard Pagar.me**

Todas as transações são registradas em tempo real dentro da Dashboard da Pagar.me, onde você como parceiro pode consultar e também seu cliente (caso seja liberado o acesso dele para tal).

Saiba como exportar os dados da dashboard [aqui](https://pagarme.helpjuice.com/pt_BR/p2-manual-da-dashboard/dashboard-como-exportar-relat%C3%B3rios-no-dashboard).

**OBS:** Lembrando que dentro da dashboard você não terá as informações completas de datas de liquidação, valor de aluguel da máquina e taxas aplicadas. Apenas os valores brutos transacionais.

* **Via API Pagar.me**

Para ter a conciliação via API das transações do Connect Pagar.me, atualmente, é necessário duas principais rotas, Payables e Balance operations, para ter visão das liquidações e extrato de cada recebedor e geral.

<br />

**Recebíveis**\
O saldo da conta Pagar.me é determinado pelos recebíveis, que são representados pela entidade de Payables e refletem o compromisso de pagamento do Pagar.me com seus clientes. Dessa forma, cada recebível contribui para aumentar ou diminuir o saldo total da conta Pagar.me. Mais detalhes e informações de como obter os recebíveis pode ser encontrado nesse [link](https://docs.pagar.me/reference/receb%C3%ADveis)

<br />

**Saldo**\
As operações de saldo referem-se a todas as atividades que envolvem a movimentação do saldo disponível na conta Pagar.me, como pagamentos ou saques. Mais detalhes e informações de obter os históricos das operações pode ser encontrado nesse [link](https://docs.pagar.me/reference/opera%C3%A7%C3%A3o-de-saldo)