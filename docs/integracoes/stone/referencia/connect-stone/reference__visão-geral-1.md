---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Visão Geral

Esta solução oferece uma **integração** entre a **API Pagar.me** e **pagamentos** realizados nos **POS integrados**.

Com esta solução, é possível **criar pedidos** via API Pagar.me **com as regras de split já declaradas** entre os recebedores cadastrados (integrada em seu PDV ou app inStore), **pagá-los presencialmente** pelo terminal POS (a maquininha) e **receber** a **resposta** das transações em **tempo real** via nossos webhooks.

<br />

> ❗️ IMPORTANTE
>
> Desde fev/26, todas as integrações devem ser atualizadas para o modelo de **SPLIT NA AUTORIZAÇÃO**.
>
> Ou seja, as regras de split devem ser enviadas, obrigatoriamente, no momento de criar o pedido via PDV.
>
> Veja mais informações de como enviar a requisição com as novas regras em "Criar pedido para maquininha" no menu do lado esquerdo da sua tela.

<br />

Abaixo detalhamos alguns benefícios da integração.

![](https://files.readme.io/147e5f6-image.png)

Além disso, nossa solução oferece dois fluxos transacionais e a possibilidade de impressão de nota fiscal ou cupom, aumentando ainda mais as possibilidades de integração e os casos de uso. Saiba mais em [Fluxos transacionais](https://connect-v2.stone.com.br/reference/fluxos-transacionais) e [Impressão de nota fiscal](https://connect-v2.stone.com.br/reference/impress%C3%A3o-de-nota-fiscal).

Abaixo, um fluxo simplificado de como funciona o Fluxo Transacional da criação, pagamento e captura de um pedido:

![](https://files.readme.io/bad2f44032a8be820ea5b8d8be48eb6053d96615ca5be6cc4e7a892c7a800559-image.png)