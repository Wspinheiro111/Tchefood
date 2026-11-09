---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Dúvidas Frequentes

## Dúvidas frequentes | Connect Stone

**1- O Connect 2.0 transaciona PIX?**\
Sim é possível. Basta enviar na requisição o ("Type": "PIX"), dentro do objeto "payment\_setup" como mostramos [aqui](https://connect-v2.stone.com.br/reference/pedido-direto). Apenas lembrando que o cliente precisa ter uma Conta Stone e o PIX habilitado para ele.

**2- Existe algum tempo de expiração da transação no POS?**\
Não, o pedido só é retirado do POS, quando ele é fechado, pelo método que explicamos [aqui](https://connect-v2.stone.com.br/reference/fechamento-de-um-pedido).

**3- Qual limite de pedidos abertos listados no POS?**\
O limite máximo é de 30 pedidos abertos.

**4- Como que faço para cancelar uma transação?**\
O cancelamento de pedido acontece quando o pagamento ainda não foi realizado. Este acontece via rota da API: <https://api.pagar.me/core/v5/orders/{order_id}/closed>).

**5- Como que faço para estornar uma transação?**\
Estorno da transação é a devolução do valor para o consumidor. Para estornar uma transação não possuímos uma rota na API para esse processo, ele deve ser realizado diretamente no POS ou via portal Stone. Mais informações [aqui](https://ajuda.stone.com.br/maquininha-e-tef/como-funciona-o-cancelamento-de-venda?from_search=109111127).

**6- Se o lojista passar uma transação avulsa sem o pedido previamente criado no PDV, o que acontece?**\
Neste caso, o pedido fica sem o vínculo do ID do pedido e do PDV do parceiro.

**6- Quais são as bandeiras aceitas nesta API?**\
As bandeiras são todas aquelas que passam na adquirência Stone, que estão listadas [aqui](https://ajuda.stone.com.br/bandeiras/bandeiras-aceitas-nas-maquininhas?from_search=89534879).

**8- Se o meu cliente já tiver uma máquina S920 ou Q92 e quiser realizar a integração com o Connect 2.0, o que devo fazer?**\
Para estes casos, dentro do nosso portal de credenciamento que os parceiros têm acesso, o Partner Hub, teremos o fluxo de ativação do produto. Você pode procurar o seu account manager responsável pela parceria para te orientar.

**9- Como funciona a conciliação das integrações?**\
Você pode visualizar suas transações em tempo real diretamente pela [dash do Pagar.me](https://id.pagar.me/signin). E para ter a conciliação completa dos pagamentos, basta se integrar na nossa [API de Conciliação](https://conciliacao.stone.com.br/).

[block:html]
{
  "html": "</br>"
}
[/block]

\*\* [Guia do Desenvolvedor](https://docs.google.com/document/d/1qzalIZqcJYq9Awgr6ARAfcF-oQeRFlFiZs9VlT7tpUI/edit) - Aqui você encontra o passo-a-passo e boas práticas para sua integração com a API do Connect Stone\*\*