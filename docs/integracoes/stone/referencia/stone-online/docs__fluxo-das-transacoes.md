---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Tipos de operações

O Stone Online possui quatro tipos de operações:

* Autorização;
* Captura;
* Cancelamento;
* Consulta de status da transação.

## Autorização

É a operação que inicia o ciclo de vida da transação. Na autorização, ocorre o envio da transação para o banco para a análise de prevenção, análise do limite de crédito e validação dos dados do cartão utilizado.\
Quando a autorização é bem-sucedida, acontece a reserva do limite de crédito do portador do cartão junto ao banco emissor, mas nenhuma cobrança é feita.

## Captura

A captura de uma transação é a confirmação da autorização da transação. A partir da captura aprovada da transação ela segue o fluxo de confirmação (isto é, enviamos via arquivo de backoffice a confirmação de que aquela venda deve ser debitada do portador e paga a adquirente para que repasse ao estabelecimento).

Existem 2 tipos de captura:

* Captura Automática: Ocorre quando a autorização contém a informação de que a mesma deve ser considerada confirmada, em caso de aprovação da autorização.
* Captura Posterior ou manual: Ocorre quando a autorização não vem com a informação de que a mesma deve ser considerada confirmada. O lojista deve enviar uma mensagem posterior confirmando a transação, ou revertendo, caso não queira compensar a transação.\
  Um exemplo prático, seria a reserva de um hotel. O cliente faz a reserva (autorização) através do site, porém a cobrança (captura) só é realizada no check-in.

![](https://files.readme.io/5e9641d-aut_cap.PNG "aut_cap.PNG")

> ❗️ Prazo para capturar uma autorização
>
> Se a mensagem de captura não for enviada dentro de 7 dias, a transação será cancelada automaticamente.

## Desfazimento e estorno

Desfazimento e o estorno são transações que devolvem o valor da compra para a conta do portador, ou seja, cancelam a compra original. Entretanto, é importante destacar a diferença entre o desfazimento e o estorno:

**Estorno:** ocorre quando o cancelamento acontece em um dia diferente da compra, contando que a transação já foi capturada (em caso de captura manual). Nesse caso, o valor é recebido pelo portador do cartão na próxima fatura.\
**Desfazimento:** ocorre quando o cancelamento é realizado antes do fluxo de confirmação da compra, antes da captura manual (para o caso de captura automática, dentro de 1 hora após autorização aprovada). Nesse caso o valor é recebido pelo portador do cartão em até 5 dias, variando de emissor para emissor.

Uma transação só pode ser cancelada se ela foi aprovada. É possível realizar o cancelamento parcial da transação original,  mais de um, se necessário, até atingir o limite do valor (valor original aprovado).\
Para realizar essa operação, é preciso enviar o Stone ID, data da transação original e valor a ser cancelado.

![](https://files.readme.io/2919533-cancelamento.PNG "cancelamento.PNG")

## Consulta de transações

Essa operação é utilizada quando há a necessidade de confirmar algumas informações da transação realizada, como valor autorizado/capturado, status da transação, código de retorno do autorizador, etc.

Além disso, através dessa consulta, é possível ver o histórico de todas as operações de Autorização, Captura e Cancelamento que ocorreram no ciclo de vida da transação.

Para fazer a consulta é preciso enviar o id da cobrança gerada.