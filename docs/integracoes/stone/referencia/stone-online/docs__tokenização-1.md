---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Tokenização

# Introdução

A Tokenização é o processo de substituição dos dados sensíveis do portador (PAN, CVV e validade) por um token do cartão para que a experiência de pagamento digital seja mais segura.

A tokenização dos cartões é feita através das bandeiras, onde um Token Requestor (Adquirente, Merchant ou Wallet) envia os dados do cartão do portador para a bandeira e a mesma retorna os dados em formato tokenizado para que seja utilizado na transação.

Esse processo na maioria das vezes é transparente para o portador, como no caso de carteiras digitais (Google Pay, Apple Pay e outras Wallets), onde o cliente simplesmente cadastra seu cartão e sequer sabe que todas as transações estão sendo realizadas por Tokens ao invés de seu cartão físico.

# Como funciona

* **Substituição de Dados**: Quando um cliente faz uma compra, os dados do cartão (como número do cartão, data de validade e CVV) são convertidos em um token, que é uma representação aleatória e sem valor intrínseco.
* **Armazenamento Seguro:** O token gerado é armazenado em um banco de dados seguro, enquanto os dados originais do cartão são mantidos em um ambiente protegido e não acessível durante a transação.
* **Transação Segura:** Quando o comerciante ou prestador de serviço precisa processar uma transação, ele usa o token em vez dos dados reais do cartão. Já que o sistema de pagamento é capaz de mapear esse token de volta aos dados do cartão, permitindo que a transação seja completada.

> 👍 Vantagens
>
> * Segurança Aumentada: Mesmo que um token seja interceptado, ele não pode ser usado para realizar transações, pois não contém informações identificáveis do cartão.
> * Conformidade: Ajuda os comerciantes a se manterem em conformidade com padrões de segurança, como o PCI DSS (Payment Card Industry Data Security Standard).
> * Experiência do Usuário: Facilita o armazenamento seguro dos dados de pagamento, permitindo transações mais rápidas e convenientes em futuras compras.

# Formato do Token

O token EMV foi criado para simular o formato de um cartão de crédito tradicional. Isto permite uma compatibilidade e um impacto menor na implementação, e em alguns casos, o uso de token pode ser transparente para o portador ou adquirente.

> 📘 Bandeiras Suportadas
>
> Atualmente suportamos as bandeiras:
>
> * Visa
> * Mastercard
> * Elo

# Fluxo da transação

* **Compra Inicial:** O cliente insere os dados do cartão em um site ou aplicativo.
* **Tokenização:** Os dados do cartão são enviados ao provedor, que gera um token.
* **Processamento da Transação:** O comerciante utiliza o token para processar a transação sem precisar acessar os dados do cartão.
* **Autorização:** O emissor valida o token e, se for válido, autoriza a transação.

Para mais informações sobre como enviar pedidos com informações com dados de TOKEN, consulte a documentação da nossa API - [Autorização com network token](ref:autorização-com-dados-de-network-token)

> ⚠️ **Atenção**
>
> Esta *feature* só esta disponível para integrações digitais