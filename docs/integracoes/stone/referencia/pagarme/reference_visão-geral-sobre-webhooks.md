---
updatedAt: 2026-04-06T17:53:13.000Z
agentTools:
  projectIndex: https://docs.pagar.me/llms.txt
---

# Visão geral sobre Webhooks

Sempre que ocorre um evento importante, nós disparamos uma notificação para seu servidor. Essas notificações são chamadas de **webhooks**. É possível configurar varios endpoints e escolher quais eventos serão disparados . O objeto `webhook` contêm os seguintes atributos:

| Atributos         | Tipo         | Descrição                                                              |
| :---------------- | :----------- | :--------------------------------------------------------------------- |
| `id`              | **string**   | *Código do webhook*. Formato: `hook_XXXXXXXXXXXXXXXX`.                 |
| `url`             | **string**   | *Endereço do alvo*.                                                    |
| `event`           | **enum**     | *Evento do webhook*.                                                   |
| `status`          | **enum**     | *Status do webhook*. Valores possíveis: `pending`, `sent` ou `failed`. |
| `attempts`        | **string**   | *Tentativas realizadas*.                                               |
| `last_attempt`    | **datetime** | *Data da última tentativa*.                                            |
| `response_status` | **string**   | *Código de resposta do servidor*.                                      |
| `response_raw`    | **string**   | *Resposta do servidor*.                                                |
| `account`         | **object**   | *Dados da loja*.                                                       |
| `account.id`      | **string**   | *Código da loja*.                                                      |
| `account.name`    | **string**   | *Nome da loja*.                                                        |
| `data`            | **object**   | *Conteúdo da requisição*.                                              |

> 🚧 Portas Padrão por protocolo (http e https)
>
> No caso de habilitar uma porta específica para o recebimento dos webhooks, para cada protocolo abaixo há uma porta específica:
>
> * http:80
> * https:443

> 📘 Inspeção e debug
>
> Você pode usar o [RequestBin](http://requestb.in) para facilmente inspecionar e debugar os webhooks que recebe.