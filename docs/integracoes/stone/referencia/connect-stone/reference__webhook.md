---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Webhook

O uso de Webhooks é obrigatório, nós disparamos para o seu servidor uma notificação dos eventos relacionados a transação. A configuração do Webhook acontece no momento da ativação do produto.

> 🚧 Portas padrão por protocolo
>
> No caso de habilitar uma porta específica para o recebimento dos webhooks, para cada protocolo abaixo há uma porta específica:
>
> * https:8080

Existem dois principais webhooks que são disparados:

* **Charge.Paid:** Quando uma transação é paga
* **Charge.Refunded:** Quando uma transação é estornada (cancelada)

[block:html]
{
  "html": "</br>"
}
[/block]

Para consultar, modificar ou acrescentar uma URL de Webhook, você pode fazer diretamente via Dashboard do Pagar.me

1 - Entra na Account;\
2 - Clique em Configurações -> Webhooks;\
3 - Clique em Criar ou Editar;\
4 - Selecione quais eventos deseja receber no seu sistema;

[block:html]
{
  "html": "</br>"
}
[/block]

![](https://files.readme.io/a92cfba-dash.JPG)