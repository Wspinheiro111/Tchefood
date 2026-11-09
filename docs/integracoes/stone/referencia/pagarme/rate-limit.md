---
updatedAt: 2026-04-06T17:49:41.000Z
agentTools:
  projectIndex: https://docs.pagar.me/llms.txt
---

# Rate Limit

O Rate limit controla o número de solicitações que um cliente pode fazer em um período de tempo específico em nossa API. Essa prática ajuda a manter a estabilidade da aplicação.

**Rate Limit - Tabela de quantidade máxima de requisições por minuto em cada endpoint:**

| Endpoint/Recurso                                                                                    | Metodo | Rate Limit por minuto                                                                                                                      |
| :-------------------------------------------------------------------------------------------------- | :----- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| [/charges](https://docs.pagar.me/reference#listar-cobran%C3%A7as)                                   | GET    | 200                                                                                                                                        |
| [/charges/\*](https://docs.pagar.me/reference#obter-cobran%C3%A7a)                                  | GET    | 200                                                                                                                                        |
| [/charges/\{\{charge\_id}}](https://docs.pagar.me/reference/cancelar-cobran%C3%A7a-1)               | DELETE | **Somente para PIX:** Após a 10° tentativa de cancelamento de uma mesma cobrança, permitimos somente uma nova tentativa a cada 15 minutos. |
| [/orders](https://docs.pagar.me/reference#listar-pedidos)                                           | GET    | 200                                                                                                                                        |
| [/orders/\*](https://docs.pagar.me/reference#obter-pedido)                                          | GET    | 200                                                                                                                                        |
| [/recipients](https://docs.pagar.me/reference#listar-recebedores-1)                                 | GET    | 100                                                                                                                                        |
| [ /recipients/\*](https://docs.pagar.me/reference#obter-recebedor-1)                                | GET    | 150                                                                                                                                        |
| [/subscriptions](https://docs.pagar.me/reference#listar-assinaturas-1)                              | GET    | 200                                                                                                                                        |
| [/subscriptions/\*](https://docs.pagar.me/reference#obter-assinatura-1)                             | GET    | 200                                                                                                                                        |
| [/invoices](https://docs.pagar.me/reference#listar-faturas-1)                                       | GET    | 200                                                                                                                                        |
| [/invoices/\*](https://docs.pagar.me/reference#obter-fatura-1)                                      | GET    | 200                                                                                                                                        |
| [/customers](https://docs.pagar.me/reference#listar-clientes-1)                                     | GET    | 200                                                                                                                                        |
| [/customers/\*](https://docs.pagar.me/reference#obter-cliente-1)                                    | GET    | 200                                                                                                                                        |
| [/hooks](https://docs.pagar.me/reference#listar-webhooks)                                           | GET    | 50                                                                                                                                         |
| [/hooks/\*](https://docs.pagar.me/reference/obter-webhook)                                          | GET    | 50                                                                                                                                         |
| [/payables](https://docs.pagar.me/reference/retornando-receb%C3%ADveis)                             | GET    | 700                                                                                                                                        |
| [/balance/operations](https://docs.pagar.me/reference/obter-hist%C3%B3rico-das-opera%C3%A7%C3%B5es) | GET    | 300                                                                                                                                        |

> 🚧 Contas de Teste (Sandbox)
>
> Para as contas de testes, o *rate limit* é determinado em **10 requisições por segundo** para qualquer *endpoint* utilizado.