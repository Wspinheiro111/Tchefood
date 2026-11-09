---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Limite de Retentivas

A Mastercard fornecerá um novo recurso chamado MAC - Merchant Advice Code para auxiliar na gestão de tentativas de pagamento não autorizadas.

Esse código adicional complementa o código de recusa da Abecs e orienta sobre quando as transações podem ser tentadas novamente após uma recusa ou se a recusa é definitiva.

Foi implementado o campo `merchant_advice_code`, que retornará o código MAC enviado pela bandeira (consultar tabela abaixo):

<br />

| Código MAC | Descrição                                                                                  | Descrição    |
| :--------- | :----------------------------------------------------------------------------------------- | :----------- |
| 1          | Informações atualizadas/adicionais necessárias                                             | Reversível   |
| 2          | Tente novamente mais tarde                                                                 | Reversível   |
| 3          | Não Tente Novamente                                                                        | Irreversível |
| 4          | Requisitos de token não atendidos para este tipo de token                                  | Reversível   |
| 21         | Cancelamento de Pagamento                                                                  | Irreversível |
| 24         | Tente após 1 hora (Válido somente para o código de resposta 51 (insuficiência de fundos)   | Reversível   |
| 25         | Tente após 24 horas (Válido somente para o código de resposta 51 (insuficiência de fundos) | Reversível   |
| 26         | Tente após 2 dias (Válido somente para o código de resposta 51 (insuficiência de fundos)   | Reversível   |
| 27         | Tente após 4 dias (Válido somente para o código de resposta 51 (insuficiência de fundos)   | Reversível   |
| 28         | Tente após 6 dias (Válido somente para o código de resposta 51 (insuficiência de fundos)   | Reversível   |
| 29         | Tente após 8 dias (Válido somente para o código de resposta 51 (insuficiência de fundos)   | Reversível   |
| 30         | Tente após 10 dias (Válido somente para o código de resposta 51 (insuficiência de fundos)  | Reversível   |

<br />

> ⚠️ **Atenção**
>
> Esta funcionalidade só está disponível para integrações digitais