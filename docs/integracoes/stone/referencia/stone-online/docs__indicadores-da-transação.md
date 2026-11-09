---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Indicadores da Transação (MIT/CIT)

# Introdução

Os indicadores de transação servem para trazer dados adicionais sobre uma compra para o banco emissor, essas informações são muito importantes para que seu estabelecimento esteja em conformidade com regras da Mastercard.

Caso um estabelecimento não esteja em conformidade, estará sujeito a multa pela bandeira.

## Indicadores

Os indicadores são bem relacionados a transações recorrentes e transações com credenciais armazenadas, e são divididas em 2 tipos:

* CIT (Cardholder Initiated Transaction ou Transação iniciada pelo portador);
* MIT (Merchant Initiated Transaction ou Transação iniciada pelo estabelecimento).

A principal diferença entre as duas é que:

* Na CIT, a transação ocorre com a presença do comprador durante a transação, já a MIT ocorre sem a presença do portador.
* Toda transação MIT é uma transação Credential on File, ou seja, são realizadas com credenciais armazenadas de interações anteriores. Já uma transação CIT pode ser realizada com base em credenciais fornecidas pelo portador no momento da transação.
* Transações CIT devem sempre conter o CVV, e transações MIT não precisam.

<br />

| Valores possíveis     | Definição                                                       |
| :-------------------- | :-------------------------------------------------------------- |
| credentials\_on\_file | Transação com credencial (dados de cartão) armazenada (MIT/CIT) |
| standing\_order       | Ordem Permanente (MIT/CIT)                                      |
| subscription          | Assinatura (MIT/CIT)                                            |
| installment           | Parcelado (MIT/CIT)                                             |
| partial\_shipment     | Remessa Parcial (MIT/CIT)                                       |
| delayed\_charge       | Cobrança atrasada (MIT/CIT)                                     |
| no\_show              | No show - Multa (MIT/CIT).                                      |
| retry                 | Reenvio (MIT/CIT)                                               |

<br />

> ⚠️ **Atenção**
>
> Esta funcionalidade só está disponível para integrações digitais