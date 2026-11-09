---
updatedAt: 2026-04-06T17:46:05.000Z
agentTools:
  projectIndex: https://docs.pagar.me/llms.txt
---

# O que são?

Os **Webhooks** são as notificações que enviamos para você sempre que um evento ocorre.

A cada atualização, o sistema envia um **HTTP POST** para a URL configurada no webhook, com todas as informações relevantes sobre cobranças, pedidos, assinaturas, entre outros. Desta maneira, o seu sistema, ao receber essa notificação, pode executar os próximos passos.

Você tem total liberdade para escolher sobre quais eventos quer ser notificado e para qual URL cada webhook será enviado.

<Image title="Webhooks-documentacao.png" alt={1303} align="center" width="80%" src="https://files.readme.io/6a82878-Webhooks-documentacao.png" />

> 📘 Contornando falhas no recebimento dos webhooks
>
> Pensando na possibilidade do seu serviço, por qualquer motivo, não conseguir receber o webhook, criamos uma configuração pela qual você pode definir quantas vezes iremos reenviá-lo em caso de falha no recebimento.
>
> De qualquer forma, nossa API também tem um endpoint pelo qual você pode consultar quais webhooks falharam, e forçar os seus envios manualmente.

## [**Funcionalidades relacionadas aos webhooks**]()

|                                                                              |
| :--------------------------------------------------------------------------- |
| **1)** [Reenviar webhook](https://docs.pagar.me/v5/reference#enviar-webhook) |
| **2)** [Obter](https://docs.pagar.me/v5/reference#obter-webhook)             |
| **3)** [Listar](https://docs.pagar.me/v5/reference#listar-webhooks)          |

## **Eventos disponíveis**

Temos uma lista de eventos importantes que podem ocorrer na nossa API. Veja abaixo!

| Evento                     | Descrição                                                                               |
| :------------------------- | :-------------------------------------------------------------------------------------- |
| `customer.created`         | Ocorre sempre que um comprador é criado                                                 |
| `customer.updated`         | Ocorre sempre que um comprador é atualizado                                             |
| `card.created`             | Ocorre sempre que um cartão é criado                                                    |
| `card.updated`             | Ocorre sempre que um cartão é atualizado                                                |
| `card.deleted`             | Ocorre sempre que um cartão é deletado                                                  |
| `address.created`          | Ocorre sempre que um endereço é criado                                                  |
| `address.updated`          | Ocorre sempre que um endereço é atualizado                                              |
| `address.deleted`          | Ocorre sempre que um endereço é deletado                                                |
| `plan.created`             | Ocorre sempre que um plano é criado                                                     |
| `plan.updated`             | Ocorre sempre que um plano é atualizado                                                 |
| `plan.deleted`             | Ocorre sempre que um plano é deletado                                                   |
| `planitem.created`         | Ocorre sempre que um item de plano é criado                                             |
| `planitem.updated`         | Ocorre sempre que um item de plano é atualizado                                         |
| `planitem.deleted`         | Ocorre sempre que um item de plano é deletado                                           |
| `subscription.created`     | Ocorre sempre que uma assinatura é criada                                               |
| `subscription.updated`     | Ocorre sempre que uma assinatura é atualizada                                           |
| `subscription.canceled`    | Ocorre sempre que uma assinatura é cancelada                                            |
| `subscriptionitem.created` | Ocorre sempre que um item de assinatura é criado                                        |
| `subscriptionitem.updated` | Ocorre sempre que um item de assinatura é atualizado                                    |
| `subscriptionitem.deleted` | Ocorre sempre que um item de assinatura é deletado                                      |
| `discount.created`         | Ocorre sempre que um desconto é criado                                                  |
| `discount.deleted`         | Ocorre sempre que um desconto é deletado                                                |
| `order.paid`               | Ocorre sempre que um pedido é pago                                                      |
| `order.payment_failed`     | Ocorre sempre que o pagamento de um pedido falha                                        |
| `order.create`             | Ocorre sempre que um pedido é criado                                                    |
| `order.canceled`           | Ocorre sempre que um pedido é cancelado                                                 |
| `invoice.created`          | Ocorre sempre que uma fatura é criada                                                   |
| `invoice.paid`             | Ocorre sempre que uma fatura é paga                                                     |
| `invoice.payment_failed`   | Ocorre sempre que o pagamento de uma fatura falha                                       |
| `invoice.canceled`         | Ocorre sempre que uma fatura é cancelada                                                |
| `charge.paid`              | Ocorre sempre que uma cobrança é paga                                                   |
| `charge.payment_failed`    | Ocorre sempre que o pagamento de uma cobrança falha                                     |
| `charge.pending`           | Ocorre sempre que o pagamento de uma cobrança estiver pendente                          |
| `charge.refunded`          | Ocorre sempre que uma cobrança é estornada                                              |
| `checkout.created`         | Ocorre sempre que um pedido do tipo de checkout é criado                                |
| `checkout.closed`          | Ocorre sempre que um pedido de checkout encontra-se em processamento ou quando foi pago |
| `checkout.canceled`        | Ocorre sempre que um pedido de checkout teve seu link de pagamento expirado             |
| `recipient.created`        | Ocorre sempre que um recebedor é criado                                                 |
| `recipient.updated`        | Ocorre sempre que um recebedor é atualizado                                             |

Saiba mais sobre os Webhooks através de nossa [API Reference](https://docs.pagar.me/reference/vis%C3%A3o-geral-sobre-webhooks)!