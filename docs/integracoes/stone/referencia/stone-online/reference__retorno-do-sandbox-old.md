---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Retornos de Sandbox

Nosso Sandbox permite que os desenvolvedores possam testar o comportamento para os principais códigos de retorno (Action Codes) possíveis. Os códigos retornados nas transações em ambiente de integração tem correspondência com o valor (amount) da transação.

\#**Códigos para qualquer bandeira**

| Valor   | Action Code              | Descrição                                                                                             |              |
| ------- | ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------ |
| R$ 0,00 | 0000                     | Aprovado                                                                                              | Approved     |
| R$ 0,01 | 1007, 1809 ou 1815       | Verifique os dados do cartão / Valor diferente da pré-autorização / Valor inválido                    |              |
| R$ 0,02 | 1008                     | Consultar as condições especiais do emissor                                                           |              |
| R$ 0,03 | 2802                     | Transação não permitida - Não tente novamente                                                         |              |
| R$ 0,04 | 2000 ou 1836             | Contate a central do seu cartão / Transação não permitida para o cartão                               |              |
| R$ 0,05 | 1000 ou 1820             | Contate a central do seu cartão / Erro no cartão                                                      |              |
| R$ 0,06 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,07 | 1836                     | Transação não permitida para o cartão                                                                 |              |
| R$ 0,08 | 0001                     | Aprovar após verificação de identidade                                                                |              |
| R$ 0,09 | 2824                     | Requisição em progresso                                                                               |              |
| R$ 0,10 | 0002                     | Parcialmente aprovado                                                                                 |              |
| R$ 0,11 | 0003                     | Aprovado (VIP)                                                                                        |              |
| R$ 0,12 | 1832 ou 1805             | Erro no cartão / Parcelamento Inválido                                                                |              |
| R$ 0,13 | 1804                     | Valor da transação não permitido                                                                      |              |
| R$ 0,14 | 1820                     | Erro no cartão                                                                                        |              |
| R$ 0,15 | 1830 ou 1838             | Contate a central do seu cartão / Dados do cartão inválido                                            |              |
| R$ 0,16 | 0004                     | Aprovado, atualizar trilha 3                                                                          |              |
| R$ 0,17 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,18 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,19 | 1818, 1834, 1835 ou 1837 | Verifique os dados do cartão / Refazer a transação / Lojista, contate a adquirência / Erro no cartão  |              |
| R$ 0,20 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,21 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,22 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,23 | 1013                     | Unacceptable fee                                                                                      |              |
| R$ 0,24 | 3001                     | N/A                                                                                                   |              |
| R$ 0,25 | 3002                     | Contate a central do seu cartão - não tente novamente                                                 |              |
| R$ 0,26 | 3003                     | N/A                                                                                                   |              |
| R$ 0,27 | 3004                     | N/A                                                                                                   |              |
| R$ 0,28 | 3005                     | Contate a central do seu cartão - não tente novamente                                                 |              |
| R$ 0,29 | 3006                     | N/A                                                                                                   |              |
| R$ 0,30 | 9100                     | Erro no formato da mensagem                                                                           |              |
| R$ 0,31 | 1830 ou 1838             | Contate a central do seu cartão / Dados do cartão inválido                                            |              |
| R$ 0,32 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,33 | 2001                     | Cartão vencido                                                                                        |              |
| R$ 0,34 | 2002                     | Suspeita de fraude                                                                                    |              |
| R$ 0,35 | 2817                     | Estabelecimento entrar em contato com o adquirente                                                    |              |
| R$ 0,36 | 2004                     | Cartão com restrição                                                                                  |              |
| R$ 0,37 | 2005                     | Estabelecimento entrar em contato com departamento de segurança do adquirente                         |              |
| R$ 0,38 | 2006                     | Excedidas tentativas de senha - contate a central do seu cartão                                       |              |
| R$ 0,39 | 1810 ou 1811             | Utilize função crédito / Utilize função débito                                                        |              |
| R$ 0,40 | 1810, 1811, 1805 ou 1818 | Utilize função crédito / Utilize função débito / Parcelamento Inválido / Verifique os dados do cartão |              |
| R$ 0,41 | 2008                     | Cartão perdido                                                                                        |              |
| R$ 0,42 | 1810 ou 1811             | Utilize função crédito / Utilize função débito                                                        |              |
| R$ 0,43 | 2009                     | Cartão roubado                                                                                        |              |
| R$ 0,44 | 1810 ou 1811             | Utilize função crédito / Utilize função débito                                                        |              |
| R$ 0,45 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,46 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,47 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,48 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,49 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,50 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,51 | 1016                     | Não autorizada                                                                                        |              |
| R$ 0,52 | 1810 ou 1811             | Utilize função crédito / Utilize função débito                                                        |              |
| R$ 0,53 | 1810 ou 1811             | Utilize função crédito / Utilize função débito                                                        |              |
| R$ 0,54 | 1819                     | Verifique os dados do cartão                                                                          |              |
| R$ 0,55 | 1017                     | Senha inválida                                                                                        |              |
| R$ 0,56 | 1816 ou 1820             | Verifique os dados do cartão / Erro no cartão                                                         |              |
| R$ 0,57 | 1019                     | Transação não permitida para o cartão                                                                 |              |
| R$ 0,58 | 1020                     | Transação não permitida                                                                               |              |
| R$ 0,59 | 1002                     | Suspeita de fraude                                                                                    |              |
| R$ 0,60 | 2801                     | Estabelecimento entrar em contato com o adquirente                                                    |              |
| R$ 0,61 | 1021                     | Limite de valor para saque excedido                                                                   |              |
| R$ 0,62 | 1813                     | Contate a central do cartão                                                                           |              |
| R$ 0,63 | 1022 ou 1817             | Contate a central do cartão / Verifique os dados do cartão                                            |              |
| R$ 0,64 | 1804 ou 1010             | Valor da transação não permitido / Contate a central do cartão                                        |              |
| R$ 0,65 | 1023                     | Limite de quantidade de saques excedido                                                               |              |
| R$ 0,66 | 1005                     | Estabelecimento entrar em contato com departamento de segurança do adquirente                         |              |
| R$ 0,67 | 2000 ou 1836             | Contate a central do cartão / Transação não permitida para o cartão                                   |              |
| R$ 0,68 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,72 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,73 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,74 | 9999                     | Erro não especificado                                                                                 |              |
| R$ 0,75 | 1006                     | Excedidas as tentativas de senha                                                                      |              |
| R$ 0,76 | 1833                     | Contate a central do seu cartão                                                                       |              |
| R$ 0,82 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,83 | 9999                     | Erro não especificado                                                                                 | Other errors |
| R$ 0,84 | 2810                     | Ciclo de vida inválido para a transação                                                               |              |
| R$ 0,90 | 9106                     | Cutover in process                                                                                    |              |
| R$ 0,91 | 1831                     | Falha de comunicação                                                                                  |              |
| R$ 0,92 | 1830 ou 1838             | Contate a central do seu cartão / Dados do cartão inválido                                            |              |
| R$ 0,93 | 1024                     | Violação da lei                                                                                       |              |
| R$ 0,94 | 1828                     | Contate a central do seu cartão                                                                       |              |
| R$ 0,95 | 9115                     | Reconciliation cutover or checkpoint error                                                            |              |
| R$ 0,96 | 1829                     | Falha de comunicação                                                                                  |              |

\#**Códigos exclusivos para BINs MasterCard**

| Valor   | Action Code  | Descrição                                           | Description |
| ------- | ------------ | --------------------------------------------------- | ----------- |
| R$ 0,56 | 1018         | No Card Record                                      |             |
| R$ 0,70 | 1809 ou 1815 | Valor diferente da pré autorização / Senha Inválida |             |
| R$ 0,71 | 1048         | Senha Inválida utilize a nova senha                 |             |
| R$ 0,76 | 1042         | Status ruim para conta de destino                   |             |
| R$ 0,77 | 1041         | Status ruim para conta de origem                    |             |
| R$ 0,78 | 1810 ou 1811 | Utilize função crédito / Utilize função débito      |             |
| R$ 0,79 | 8002         | Rejected Key Verification Failed                    |             |
| R$ 0,80 | 9112         | Emissor indisponível                                |             |
| R$ 0,81 | 1805         | Parcelamento inválido                               |             |
| R$ 0,84 | 2810         | Ciclo de vida inválido para a transação             |             |
| R$ 0,85 | 0000         | Aprovado                                            |             |
| R$ 0,86 | 1017         | Senha inválida                                      |             |
| R$ 0,87 | 0862         | N/A                                                 |             |
| R$ 0,88 | 1820 ou 1827 | Erro no cartão / Senha inválida                     |             |
| R$ 0,89 | 1017         | Senha inválida                                      |             |

\#**Códigos exclusivos para BINs Visa e ELO**

| Valor   | Action Code | Descrição                       | Description |
| ------- | ----------- | ------------------------------- | ----------- |
| R$ 0,70 | 9999        | Erro não especificado           |             |
| R$ 0,71 | 9999        | Erro não especificado           |             |
| R$ 0,76 | 1833        | Contate a central do seu cartão |             |
| R$ 0,77 | 9999        | Erro não especificado           |             |
| R$ 0,78 | 1025        | Desbloqueie o cartão            |             |
| R$ 0,79 | 9999        | Erro não especificado           |             |
| R$ 0,80 | 9112        | Emissor indisponível            |             |
| R$ 0,81 | 1827        | Senha inválida                  |             |
| R$ 0,84 | 9999        | Erro não especificado           |             |
| R$ 0,85 | 0000        | Aprovado                        |             |
| R$ 0,86 | 1017        | Senha inválida                  |             |
| R$ 0,87 | 9999        | Erro não especificado           |             |
| R$ 0,88 | 9999        | Erro não especificado           |             |
| R$ 0,89 | 9999        | Erro não especificado           |             |

\#**Outros cenários**
Além disso, é possível testar alguns cenários, como descrito abaixo:

| Cenário              | Valor                                           |
| -------------------- | ----------------------------------------------- |
| Timeout              | R$666,00                                        |
| Transações aprovadas | Qualquer valor inteiro, entre R$1,00 e R$100,00 |