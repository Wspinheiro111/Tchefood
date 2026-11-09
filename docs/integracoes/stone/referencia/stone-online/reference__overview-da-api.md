---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Overview da API

# Introdução

A **API de Autorização Stone** foi desenvolvida com os melhores padrões **RESTfull**.

As operações são feitas por requisições aos *endpoints*, de acordo com os verbos HTTP, com corpos de mensagem em JSON.

> ❗️ ATENÇÃO!
>
> Diferente das versões anteriores da API Stone Online, as requisições e suas respostas serão enviadas no formato **JSON**

Agora, as chamadas à API serão através da rota */charges*(cobranças). Nela, teremos 04 operações disponíveis, sendo:

**Authorize**\
Operação responsável pela requisição de autorização e captura da transação. A captura pode ser executada de maneira automática junto a autorização ou pode ser uma captura posterior.

**Capture**\
Operação responsável pela captura posterior de uma transação.

**Cancel**\
Operação responsável pelo cancelamento de transações.

**Consulta**\
Operação responsável pela consulta do status das transações.

> 📘 Documentação em construção
>
> Estamos em constante evolução e essa documentação está em construção ainda.
>
> A versão apresentada aqui é uma versão resumida da documentação final na qual iremos trazer com mais detalhes o comportamento da nova API.