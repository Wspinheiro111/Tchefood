---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Fluxo Operacional

O fluxo para realizar transações na Stone é composto pelos processos transacionais que podem ser divididos nas etapas de Autorização e Captura. A etapa de autorização é feita via autorizador Stone (online), a etapa de captura/confirmação é feita via arquivo (backoffice)

![](https://files.readme.io/99ee84319712af6de074c5a8ba35489195313f1e7d242615eeac315e9de14c62-image.png)

<br />

# Autorização

# Requisição de Autorização

A mensagem de AcceptorAuthorisationRequest é enviada pelo estabelecimento para o adquirente, para checar junto ao banco que a conta associada ao cartão possui recursos para financiar o pagamento. Este controle inclui a validação dos dados do cartão e todos os dados adicionais previstos.

# Resposta de Autorização

A mensagem AcceptorAuthorisationResponse é enviada pelo adquirente, para retornar o resultado da validação realizada pelo emissor sobre a operação de pagamento.

> 👍 **Estrutura da Mensagem**
>
> Clique [aqui](https://dash.readme.com/project/stone-online/v4.1/refs/post_charge) para ver a descrição das tags e exemplos das mensagens de autorização

# Captura

A captura de uma transação é o reconhecimento da autorização da transação pelo sistema de captura do lojista (E-commerce, POS, Pinpad). Feito isso, a mensagem de captura é enviada para a adquirente (Stone) que, por sua vez, notifica o emissor, via arquivo de backoffice, que o saldo do portador deve ser debitado.

## Há três tipos de captura:

### 1. Autorização com captura imediata (Automática)

Nessa forma de captura, a autorização e a captura acontecem simultaneamente e de forma automática, logo, se a autorização for aprovada ela já estará capturada na adquirente.\
Em uma situação de compra via uma plataforma digital, o portador adiciona os seus produtos ao carrinho e, ao finalizar o pedido, faz o pagamento inserindo os dados para autenticação da compra.\
Nesse momento, é realizada uma comunicação com a adquirente solicitando a autorização e a captura daquele valor. Dessa forma, logo após criar uma transação já se recebe uma resposta com a transação paga ou recusada.\
Essa forma é mais utilizada em transações de mundo físico (cartão presente). Em ecommerce é mais comum utilizar a autorização com captura posterior.

![](https://files.readme.io/a5433c07361590c80cd53d0138f0d1a927c5d8b4308655c6828d0b66f7b636ad-image.png)

<br />

1. O estabelecimento envia uma mensagem preenchendo o campo operation\_type como auth\_and\_capture para o adquirente solicitando autorização, informando que deseja realizar a captura financeira.
2. Result é devolvido pelo adquirente, informando ao estabelecimento sobre o êxito do pedido, uma vez que o adquirente tenha autorizado a transação sem a necessidade de envio de captura.

## Quando enviar?

A autorização com captura automática deve ser enviada quando o estabelecimento deseja que após a aprovação aquela transação seja liquidada no valor total da autorização.

<br />

> 👍 **Estrutura da Mensagem**
>
> Clique [aqui ](https://dash.readme.com/project/stone-online/v4.1/refs/autoriza%C3%A7%C3%A3o-%C3%A0-vista-com-captura-autom%C3%A1tica) para ver um exemplo do envio de uma transação utilizando captura automática.

### 2. Autorização com captura posterior

Ocorre quando o estabelecimento decide autorizar a transação e capturá-la de forma manual posteriormente, isto pode ser necessário para aquele tipo de estabelecimento por diversos motivos, como: Ainda não tem o valor final da compra no momento da autorização, utilização de sistema antifraude, confirmação de estoque antes de confirmar a transação, entre outros.

> ⚠️ **Atenção**
>
> Uma mensagem específica para a captura deve ser enviada no momento oportuno!\
> Para ver como realizar a captura posterior, clique [aqui](https://dash.readme.com/project/stone-online/v4.1/refs/autoriza%C3%A7%C3%A3o-%C3%A0-vista-com-captura-posterior)

![](https://files.readme.io/7c60d08f683dd859682f6957fa78c85641ef8dde143faa59805ac93eb48e06d0-image.png)

<br />

1. O estabelecimento envia uma mensagem para a adquirente solicitando a autorização da transação, informando que deseja realizar a captura posteriormente, preenchendo o campo operation\_type como auth\_only
2. Um response é devolvida pelo adquirente, informando ao estabelecimento sobre o êxito da autorização.
3. Se a transação tiver sido concluída com êxito no lado do estabelecimento, o estabelecimento envia uma operação para capturar a transação.
4. O adquirente retorna um response, reconhecendo o resultado e captura financeira da transação.

> ⚠️ **Atenção**
>
> Não permitimos captura posterior para transações de débito.

## Quando enviar?

A captura posterior deve ser efetuada quando o cliente realiza uma compra com o cartão (mesmo caso da autorização), porém o lojista deseja que a captura não ocorra automaticamente, e prefere efetuar a captura manualmente em um momento futuro.

> 📘 **Prazo para a captura posterior**
>
> Abaixo estão os prazos de captura conforme as diferentes bandeiras:
>
> * Mastercard: 7 dias
> * Elo: 7 dias
> * Visa: Ao contrário das outras bandeiras, a Visa estabelece prazos de captura que variam de acordo com o ramo de atividade do estabelecimento (MCC)
>   * 29 dias corridos:
>     * MCC 4411/ 7011/ 7512
>   * 9 dias corridos:
>     * MCC 7999/ 4457/ 7296/ 7841/ 7394/ 7519/ 7033

# Cancelamento

O cancelamento deve ser realizado em até 180 dias (6 meses) após a data da transação.

Vale destacar que alguns emissores podem negar cancelamentos de transações não capturadas (como autorizações sem captura automática ou pré-autorização) após um prazo específico, que pode variar. Nesse caso, é possível que o saldo do portador já tenha sido dessensibilizado, limitando as opções de cancelamento disponíveis.

> ⚠️ Importante
>
> O cancelamento pode pode ser realizado apenas no estabelecimento onde foi realizada a transação original.

É possível realizar um estorno com valor abaixo da compra, é o que chamamos de estorno parcial.

## Transações que podem ser canceladas:

• Crédito (À vista, parcelado com juros e parcelado sem juros)\
• Débito\
• Voucher

**Dados da transação original que devem ser pedidos para o cancelamento:**\
• amount;\
• reason;\
• initiator\_operation\_id.

![](https://files.readme.io/de496a316fc8a5712d44098470acd0a2fabc3fd38e80223d9fd98d372ec68563-image.png)

<br />

1. O estabelecimento envia uma solicitação de autorização para a adquirente ;
2. Um response é enviada pelo adquirente confirmando e aprovando o pedido de autorização;
3. Uma solicitação de cancelamento é enviada para informar ao adquirente;
4. A adquirente retorna um response reconhecendo o pedido de cancelamento por parte do estabelecimento;

## Quando enviar?

Quando um portador desiste do produto ou serviço que contratou, ele pode entrar em contato direto com o lojista e solicitar o cancelamento do produto/serviço.

> 👍 **Estrutura da Mensagem**
>
> Caso a autorização não seja capturada em seu prazo máximo (de acordo com as regras estipuladas), ela é automaticamente cancelada pela Stone.

# Consulta de Transações

## Requisição de Consulta de Transação

Esta mensagem é utilizada para realizar um pedido de consulta de uma transação.

## Resposta de Consulta de Transação

A mensagem AcceptorTransactionStatusReportResponse é respondida pelo adquirente com as informações sobre a requisição de consulta.

## Quando enviar?

Quando deseja-se confirmar se o valor correto de uma transação foi capturado e/ou autorizado, confirmar se uma transação foi cancelada ou para confirmar se ocorreu algum tipo de erro nas requisições anteriores: Autorização, Captura ou Cancelamento.

> 👍 **Estrutura da Mensagem**
>
> Clique aqui **(INSERIR HIPER LINK)** para ver a descrição das tags e exemplos das mensagens de consulta de transação