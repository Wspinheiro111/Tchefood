---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Modalidades e Tipos de Parcelamento

| Transação | Modalidades         |
| --------- | ------------------- |
| Débito    | À vista             |
| Crédito   | À vista e parcelado |

## Modalidades de Pagamento

* **À vista** - Consiste no pagamento do valor total da compra de uma só vez.

* **Parcelado** - É o pagamento da compra dividido em certo número de parcelas, escolhido na hora do pagamento. O pagamento é realizado de acordo com a data de faturamento acordada entre o portador do cartão e o emissor, nos meses subsequentes a compra, até que o valor integral devido seja quitado. É o adquirente (Stone) quem controla o número máximo de parcelas desta transação. Existem dois tipos de parcelamentos e ambos possuem juros. A diferença é de quem os juros serão cobrados: Parcelado lojista, os juros são pagos pelo lojista em forma de desconto no recebimento das parcelas; Parcelado emissor, os juros são pagos pelo portador, a taxa é acordado com o emissor.

## Tipos de parcelamento

Durante o credenciamento com a Stone é possível optar pelas seguintes formas de parcelamento de transações:

* **Parcelado lojista (sem juros)** - Nessa modalidade de parcelamento, o portador irá pagar as parcelas na quantidade de vezes escolhida na compra e pagará no total o valor da compra sem juros. O lojista irá receber cada parcela mês a mês, a iniciar D+30, onde D é a data da compra, e ao final, receberá o valor da compra menos o MDR acordado com a adquirente para aquela quantidade de parcelas. É o adquirente quem controla as parcelas enviadas para o emissor, nesse tipo de parcelamento.

* **Parcelado emissor (com juros)** - É similar ao parcelado sem juros, porém, no valor a ser pago, será acrescentado juros cobrados diretamente pelo emissor e devidamente aceitos pelo portador. Para o adquirente e o estabelecimento, a transação será liquidada como à vista. É o emissor quem controla as parcelas dessa transação.

## Limites de parcelamento

* Existe um mínimo no valor de 10 centavos por parcela. Caso uma tentativa de transação seja feita e o valor da parcela seja menor que isso (exemplo: R$ 1,10 parcelado em 12x), a transação será negada com o retorno `1010`, indicando que o valor não é permitido.
* O valor máximo não existe, já que vai depender da aprovação da bandeira/emissor.

> ⚠️ **Atenção**
>
> Transações parceladas em 18x têm o valor mínimo de R$10 por parcela.