---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Recorrência

# Introdução

Pagamentos recorrentes são aqueles que se repetem em intervalos regulares, como mensal, trimestral ou anual.  Esse modelo é amplamente utilizado em serviços de assinatura, como plataformas de streaming, academias e softwares (SaaS).

## Como funciona:

Após a primeira compra, um acordo entre a empresa e o cliente define o período de cobrança (ciclo de recorrência) e o valor da mensalidade. A partir daí, os pagamentos são debitados automaticamente da conta do cliente, seja em conta bancária ou cartão de crédito, sem necessidade de uma nova autorização a cada cobrança.

**Vantagens da recorrência:**

**Previsibilidade de receita:** Facilita o planejamento financeiro da empresa, com uma estimativa mais precisa dos recebimentos futuros.

**Comodidade para o cliente:** Simplifica o processo de pagamento para o cliente, evitando esquecimentos e atrasos.

**Fidelização:** Incentiva a fidelização do cliente, que se mantém ativo por mais tempo.

**Redução de custos:** Diminui os custos com cobrança e gestão de pagamentos.\
Aplicações da recorrência:

A recorrência pode ser aplicada em diversos setores e tipos de negócio. Veja alguns exemplos:

* Assinaturas: Streamings de vídeo e música, plataformas de notícias, clubes de assinatura de produtos.
* Serviços: Academias, escolas, serviços de contabilidade, consultorias.
* Software: SaaS (Software as a Service), como ferramentas de gestão, CRM, plataformas de e-mail marketing.
* Utilities: Contas de luz, água, internet e telefone.
* Saúde: Planos de saúde, consultórios médicos e odontológicos.
* Seguros: Apólices de seguro de vida, saúde, automóvel.
* E-commerce: Venda de produtos com entrega recorrente, como alimentos, produtos de higiene pessoal e ração para animais.

<br />

## Como utilizar

Para a utilização de recorrência em transações, inicialmente é necessário o objeto *initiator* , informando no campo *initiating\_reason* o valor *subscription*

Deve ser enviado, também, um segundo campo *initiating\_entity*, que determinará se a transação se trata da primeira transação da série de recorrência ou uma das demais transações.

Para mais informações sobre como enviar pedidos com informações de recorrência, consulte a documentação da nossa API - [Autorização com dados de recorrência](ref:autorização-com-recorrencia)

> ⚠️ **Atenção**
>
> Esta *feature* só está disponível para integrações digitais