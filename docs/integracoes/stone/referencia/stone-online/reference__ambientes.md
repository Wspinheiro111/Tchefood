---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Ambientes

## Homologação

Em nosso ambiente de sandbox, você pode simular todas as situações que acontecerão em produção: transações aprovadas, negadas, timeout, etc.\
Com isso, você pode validar como a sua aplicação irá se comportar em situações de autorizações, capturas, cancelamento e consultas.

> 👍 Endpoint para Homologação
>
> Para acessar o **ambiente de teste**, o endpoint varia de acordo com o seu **modelo de negócio**
>
> Caso você seja uma **Subadquirente**, utilize o endpoint:
>
> <https://payments.stone.com.br/v1/charges>> com o Header **Host** sdx-payments.stone.com.br
>
> Caso você seja um  **Gateway** utilize o endpoint:
>
> <https://payments.stone.com.br/v1/charges>> com o Header **Host** sdx-ecommerce-payments.stone.com.br

> 🚧 Códigos de Retorno no Ambiente de Integração
>
> Nosso ambiente de homologação foi preparado para lhe ajudar a validar as principais respostas das bandeiras. As transações recebem respostas correspondentes ao valor dos centavos instanciados.
>
> **Exemplo**: Transações de R$1,00 terão o código de resposta 0000. Transações de R$1,01 terão o código de resposta 1007.
>
> Todos os possíveis códigos de retorno deste ambiente e seus significados encontram-se na seção [Códigos de Retorno do Sandbox](https://online.stone.com.br/reference/retorno-do-sandbox-old).

## Produção

Este é o ambiente em que você conseguirá realizar transações reais.\
Para transacionar nele, o cliente precisa estar cadastrado na Stone.

> 👍 Endpoint para Produção
>
> O endpoint para produção varia de acordo com o seu **modelo de negócio**
>
> Caso você seja uma **Subadquirente**, utilize o endpoint:
>
> <https://payments.stone.com.br/v1/charges> com o Header **Host** payments.stone.com.br
>
> Caso você seja um  **Gateway** utilize o endpoint:
>
> <https://payments.stone.com.br/v1/charges> com o Header **Host** ecommerce-payments.stone.com.br