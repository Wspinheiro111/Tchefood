---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Card on File

# Introdução

Card on File ou CoF, como é popularmente conhecido, refere-se ao armazenamento de forma segura dos dados do cartão. Permitindo que o cliente realize futuras transações de forma mais rápida e conveniente, sem a necessidade de inserir os dados do cartão novamente.

O produto de CoF oferece:

* Armazenamento Seguro: Ao realizar uma compra, o portador pode optar por salvar os dados do cartão. Esses dados são armazenados de forma segura, geralmente utilizando criptografia.
* Facilidade nas Futuras Compras: Nas transações seguintes, o portador pode selecionar o cartão armazenado, simplificando o processo de pagamento.
* Pagamentos Recorrentes: O CoF é especialmente útil para serviços de assinatura, onde pagamentos automáticos são feitos em intervalos regulares.

> 📘 Card on File e Recorrência
>
> As transações de Card on File podem ser recorrentes ou não.

# Como funciona

Uma transação Card on File ocorre quando o merchant armazena os dados do cartão do portador, mediante autorização do mesmo, para realizar cobranças futuras.

Esse tipo de pagamento pode ser feito de duas formas:

* Transação iniciada pelo portador (CIT).\
  Exemplo: Transação de comércio eletrônico, uma transação de pedido por correio ou por telefone.
* Transação iniciada pelo comerciante (MIT).\
  Exemplo: Pagamentos recorrentes de assinaturas.

## Regras de Negócios

* Transações Card on File são utilizadas apenas em transações E-Commerce.
* Transações por recorrência só podem ser feitas se o seu EntryMode for CDFL (Card on File).

> 👍 Vantagens
>
> * Conveniência: Facilita nas compras de clientes frequentes
> * Melhor Experiência do Usuário: Reduz o tempo gasto durante o checkout.
> * Fidelização: Pode incentivar a lealdade do cliente, já que o processo de compra se torna mais simples.

> 📘 Regra Mastercard - Para alguns MCCs
>
> Para transações dos seguintes MCCs: 7995 (Transações de jogos de azar); 7800 (Loteria de propriedade do governo); 7801 (Jogos de azar na Internet); 7802 (Corridas de cavalos/cães licenciadas pelo governo); 9406 (Loteria de propriedade do governo), as transações de Credential On File (sendo recorrentes ou não) sempre devem vir com CVV, exceto se forem autenticadas via 3DS com autenticação do emissor (AuthntcnRslt = CRPT) ou se forem InApp sem Wallet Identifier.

> ⚠️ **Atenção**
>
> Esta *feature* só está disponível para integrações digitais

Para mais informações sobre como enviar pedidos com credential on file, consulte a documentação da nossa API - [Autorização com credential on file](ref:autorização-com-credential-on-file-copy)