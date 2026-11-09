---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Códigos de retorno do Autorizador Stone

Os códigos de retorno sempre estarão presentes no campos `<acquirer_response_code> `e `<acquirer_message>`.

Lista de códigos de retorno:

| Código | Descrição                                                       | Mensagem                                                                                          |
| :----- | :-------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| 0000   | Approved                                                        | Aprovado                                                                                          |
| 0001   | Approve after identity verification                             | Aprovar após verificação de identidade                                                            |
| 0002   | Partially approved                                              | Parcialmente aprovado                                                                             |
| 0003   | Approved (VIP)                                                  | Aprovado (VIP)                                                                                    |
| 0004   | Approved, upgrade track 3                                       | Aprovado, atualizar trilha 3                                                                      |
| 0005   | Approved, account type defined by the issuer                    | Aprovado, tipo de conta definido pelo emissor                                                     |
| 0006   | Partially approved, account type defined by the issuer          | Parcialmente aprovado, tipo de conta definido pelo emissor                                        |
| 0008   | Approved but fees disputed                                      | Approved but fees disputed                                                                        |
| 0009   | Approved with overdraft                                         | Approved with overdraft                                                                           |
| 0010   | Approved, customer reactivated                                  | Approved, customer reactivated                                                                    |
| 0011   | Aprovado offline, não foi possível ir online                    | Aprovado offline, não foi possível ir online                                                      |
| 0012   | Approved, transaction processed offline by terminal	 \|         | Approved, transaction processed offline by terminal                                               |
| 0013   | Approved, transaction processed offline after referral          | Approved, transaction processed offline after referral                                            |
| 1000   | Do not honour                                                   | Contate a central do seu cartão                                                                   |
| 1820   | Do not honour                                                   | Erro no cartão - não tente novamente                                                              |
| 1001   | Expired card                                                    | Verifique os dados do cartão                                                                      |
| 1819   | Expired card                                                    | Verifique os dados do cartão                                                                      |
| 1002   | Suspected fraud                                                 | Contate a central do seu cartão                                                                   |
| 1003   | Card acceptor contact acquirer                                  | Estabelecimento entrar em contato com o adquirente                                                |
| 1813   | Restricted card                                                 | Cartão não permite transação internacional                                                        |
| 1005   | Card acceptor call acquirer's security department               | Estabelecimento entrar em contato com departamento de segurança do adquirente                     |
| 1006   | Allowable PIN tries exceeded                                    | Excedidas tentativas de senha - contate a central do seu cartão                                   |
| 1007   | Refer to card issuer                                            | Verifique os dados do cartão                                                                      |
| 1809   | Refer to card issuer                                            | Valor diferente da pré-autorização - não tente novamente                                          |
| 1815   | Refer to card issuer                                            | Senha inválida - não tente novamente                                                              |
| 1008   | Refer to card issuer's special conditions                       | Consultar as condições especiais do emissor                                                       |
| 1009   | Invalid card acceptor                                           | Estabelecimento inválido - contate a adquirente                                                   |
| 1010   | Invalid amount                                                  | Contate a central do seu cartão - não tente novamente                                             |
| 1804   | Invalid amount                                                  | Valor da transação não permitido - não tente novamente                                            |
| 1011   | Invalid card number                                             | Cartão inválido                                                                                   |
| 1816   | Invalid card number                                             | Verifique os dados do cartão                                                                      |
| 1820   | Invalid card number                                             | Erro no cartão - não tente novamente                                                              |
| 1012   | PIN data required                                               | Senha necessária                                                                                  |
| 1013   | Unacceptable fee                                                | Unacceptable fee                                                                                  |
| 1014   | No account of type requested                                    | Nenhuma conta do tipo selecionado                                                                 |
| 1810   | No account of type requested                                    | Utilize função crédito                                                                            |
| 1811   | No account of type requested                                    | Utilize função débito                                                                             |
| 1015   | Requested function not supported                                | Função selecionada não suportada                                                                  |
| 1805   | Requested function not supported                                | Parcelamento inválido - não tente novamente                                                       |
| 1810   | Requested function not supported                                | Utilize função crédito                                                                            |
| 1811   | Requested function not supported                                | Utilize função débito                                                                             |
| 1818   | Requested function not supported                                | Verifique os dados do cartão                                                                      |
| 1016   | Not sufficient funds                                            | Não autorizada                                                                                    |
| 1017   | Incorrect PIN                                                   | Senha inválida                                                                                    |
| 1816   | No card record                                                  | Verifique os dados do cartão                                                                      |
| 1019   | Transaction not permitted to cardholder                         | Transação não permitida para o cartão - não tente novamente                                       |
| 1020   | Transaction not permitted to terminal                           | Transação não permitida - não tente novamente                                                     |
| 1021   | Exceeds withdrawal amount limit                                 | Limite de valor para saque excedido                                                               |
| 1022   | Security violation                                              | Contate a central do seu cartão                                                                   |
| 1817   | Security violation                                              | Verifique os dados do cartão                                                                      |
| 1023   | Exceeds withdrawal frequency limit                              | Limite de quantidade de saques excedido                                                           |
| 1024   | Violation of law                                                | Transação não permitida para o cartão - não tente novamente                                       |
| 1025   | Card not effective                                              | Desbloqueie o cartão                                                                              |
| 1026   | Invalid PIN block                                               | Dados de senha inválidos                                                                          |
| 1027   | PIN length error                                                | Erro no tamanho da senha                                                                          |
| 1028   | PIN key sync error                                              | Erro de sincronia de chave de senha                                                               |
| 1029   | Suspected counterfeit card                                      | Suspeita de cartão falso                                                                          |
| 1030   | Currency unacceptable to card issuer                            | Moeda inaceitável para o emissor                                                                  |
| 1031   | Not authorised and fees disputed                                | Not authorised and fees disputed                                                                  |
| 1032   | Lost/stolen card                                                | Cartão perdido ou roubado                                                                         |
| 1033   | Invalid life cycle for the transaction                          | Ciclo de vida inválido para a transação                                                           |
| 1034   | Authorization lifecycle has expired                             | Ciclo de vida da autorização expirado                                                             |
| 1035   | Closed account                                                  | Conta encerrada                                                                                   |
| 1036   | Closed savings account, or restricted for closing               | Conta poupança encerrada ou bloqueada para encerramento                                           |
| 1037   | Closed credit account or restricted for closing                 | Conta de crédito encerrada ou bloqueada para encerramento                                         |
| 1038   | Closed credit facility cheque account or restricted for closing | Closed credit facility cheque account or restricted for closing                                   |
| 1039   | Closed cheque account or restricted for closing                 | Conta corrente encerrada ou bloqueada para encerramento                                           |
| 1040   | Bad debt                                                        | Bad debt                                                                                          |
| 1041   | From account bad status                                         | Status ruim para conta de origem                                                                  |
| 1042   | To account bad status                                           | Status ruim para conta de destino                                                                 |
| 1043   | Cheque already posted                                           | Cheque already posted                                                                             |
| 1044   | Information not on file                                         | Information not on file                                                                           |
| 1045   | Card verification data failed                                   | Código de segurança inválido                                                                      |
| 1817   | Card verification data failed                                   | Verifique os dados do cartão                                                                      |
| 1046   | Amount not found                                                | Amount not found                                                                                  |
| 1047   | PIN change required                                             | Senha inválida - não tente novamente                                                              |
| 1048   | New PIN invalid                                                 | Senha inválida utilize a nova senha                                                               |
| 1049   | Bank not found                                                  | Bank not found                                                                                    |
| 1050   | Bank not effective                                              | Bank not effective                                                                                |
| 1051   | Customer vendor not found                                       | Estabelecimento não encontrado                                                                    |
| 1052   | Customer vendor not effective                                   | Customer vendor not effective                                                                     |
| 1053   | Customer vendor account invalid                                 | Customer vendor account invalid                                                                   |
| 1054   | Vendor not found                                                | Vendor not found                                                                                  |
| 1055   | Vendor not effective                                            | Vendor not effective                                                                              |
| 1056   | Vendor data invalid                                             | Vendor data invalid                                                                               |
| 1057   | Payment date invalid                                            | Data de pagamento inválida                                                                        |
| 1058   | Personal identification not found                               | Personal identification not found                                                                 |
| 1059   | Scheduled transactions exist                                    | Scheduled transactions exist                                                                      |
| 1060   | Transaction did not complete normally at terminal               | Transação não completou normalmente no terminal                                                   |
| 1061   | Transaction not supported by the card issuer                    | Transação não suportada pelo emissor                                                              |
| 1062   | Cashback not allowed                                            | Troco fácil não disponível                                                                        |
| 1063   | Cashback amount exceeded                                        | Limite de troco fácil excedido                                                                    |
| 1064   | Declined, transaction processed offline by terminal             | Negado offline pelo terminal                                                                      |
| 1065   | Declined, terminal unable to process offline                    | Declined, terminal unable to process offline                                                      |
| 1066   | Declined, transaction processed offline after referral          | Declined, transaction processed offline after referral                                            |
| 1068   | Identification number invalid                                   | Identification number invalid                                                                     |
| 1069   | Driver number invalid                                           | Driver number invalid                                                                             |
| 1070   | Vehicle number invalid                                          | Vehicle number invalid                                                                            |
| 1071   | Digital certificate expired                                     | Digital certificate expired                                                                       |
| 1820   | Encryption failed                                               | Erro no cartão - não tente novamente                                                              |
| 1827   | Encryption failed                                               | Senha inválida - não tente novamente                                                              |
| 2000   | Do not honour                                                   | Contate a central do seu cartão - não tente novamente                                             |
| 1836   | Do not honour                                                   | Transação não permitida ao cartão - não tente novamente                                           |
| 2001   | Expired card                                                    | Cartão vencido                                                                                    |
| 2002   | Suspected fraud                                                 | Suspeita de fraude                                                                                |
| 2003   | Card acceptor contact acquirer                                  | Estabelecimento entrar em contato com o adquirente                                                |
| 2004   | Restricted card                                                 | Cartão com restrição                                                                              |
| 2005   | Card acceptor call acquirer's security department               | Estabelecimento entrar em contato com departamento de segurança do adquirente                     |
| 2006   | Allowable PIN tries exceeded                                    | Tentativas de senha excedidas                                                                     |
| 1836   | Special conditions                                              | Transação não permitida para o cartão - não tente novamente                                       |
| 2008   | Lost card                                                       | Transação não permitida - não tente novamente                                                     |
| 2009   | Stolen card                                                     | Transação não permitida - não tente novamente                                                     |
| 2010   | Suspected counterfeit card                                      | Suspeita de cartão falso                                                                          |
| 2011   | Daily withdrawal uses exceeded                                  | Limite de quantidade de saques excedido                                                           |
| 2012   | Daily withdrawal amount exceeded                                | Limite de valor para saque excedido                                                               |
| 3002   | N/A                                                             | Contate a central do seu cartão - não tente novamente                                             |
| 3005   | N/A                                                             | Contate a central do seu cartão - não tente novamente                                             |
| 9100   | One or more data element errors (see message error indicator)   | Erro no formato da mensagem                                                                       |
| 1805   | Invalid transaction                                             | Parcelamento inválido - não tente novamente                                                       |
| 1832   | Invalid transaction                                             | Erro no cartão - não tente novamente                                                              |
| 9103   | Re-enter transaction                                            | Tente novamente                                                                                   |
| 1818   | Re-enter transaction                                            | Verifique os dados do cartão                                                                      |
| 1834   | Re-enter transaction                                            | Refazer a transação                                                                               |
| 1835   | Re-enter transaction                                            | Lojista, contate a adquirente                                                                     |
| 1837   | Re-enter transaction                                            | Erro no cartão - não tente novamente                                                              |
| 9105   | Acquirer not supported by switch                                | Adquirente não suportado pelo switch                                                              |
| 9106   | Cutover in process                                              | Cutover in process                                                                                |
| 1831   | Card issuer or switch inoperative                               | Falha de comunicação - tente mais tarde                                                           |
| 1830   | Transaction destination cannot be found for routing             | Contate a central do seu cartão - não tente novamente                                             |
| 1838   | Transaction destination cannot be found for routing             | Dados do cartão inválido - não tente novamente                                                    |
| 9109   | System malfunction                                              | Erro no sistema                                                                                   |
| 1829   | System malfunction                                              | Falha de comunicação - tente mais tarde                                                           |
| 9110   | Card issuer signed off                                          | Emissor se desconectou                                                                            |
| 9111   | Card issuer timed out                                           | Emissor não respondeu em tempo                                                                    |
| 1829   | Card issuer timed out                                           | Falha de comunicação - tente mais tarde                                                           |
| 9112   | Card issuer unavailable                                         | Emissor indisponível                                                                              |
| 1828   | Transmissão duplicada                                           | Contate a central do seu cartão - não tente novamente                                             |
| 9114   | Not able to trace back to original transaction                  | Não foi possível encontrar a transação original                                                   |
| 1833   | Não foi possível encontrar a transação original                 | Contate a central do seu cartão - não tente novamente                                             |
| 9115   | Reconciliation cutover or checkpoint error                      | Reconciliation cutover or checkpoint error                                                        |
| 9116   | MAC incorrect                                                   | MAC incorreto                                                                                     |
| 9117   | MAC key sync error                                              | Erro de sincronização de chave de MAC                                                             |
| 9118   | No communication keys available for use                         | Nenhuma chave de comunicação disponível                                                           |
| 9119   | Encryption key sync error                                       | Erro de sincronização de chave de encriptação                                                     |
| 9120   | Security software/hardware error – try again                    | Erro de segurança de software/hardware, tente novamente                                           |
| 9121   | Security software/hardware error – no action                    | Erro de segurança de software/hardware                                                            |
| 9122   | Message number out of sequence                                  | Número da mensagem fora de sequência                                                              |
| 9123   | Request in progress                                             | Requisição em progresso                                                                           |
| 9124   | Invalid security code                                           | Código de segurança inválido                                                                      |
| 9125   | Database error                                                  | Erro no banco de dados                                                                            |
| 9128   | Customer vendor format error                                    | Erro no formato da mensagem                                                                       |
| 1832   | Customer vendor format error                                    | Erro no cartão - não tente novamente                                                              |
| 9132   | Recurring data error                                            | Erro nos dados de recorrência                                                                     |
| 9133   | Update not allowed                                              | Atualização não permitida                                                                         |
| 9350   | Violation of business arrangement                               | Violação de acordo comercial                                                                      |
| 9999   | Other errors                                                    | Erro não especificado                                                                             |
| 1805   | Other errors                                                    | Parcelamento inválido - não tente novamente                                                       |
| 1807   | Other errors                                                    | Conta destino inválida - não tente novamente                                                      |
| 1808   | Other errors                                                    | Conta origem inválida - não tente novamente                                                       |
| 1809   | Other errors                                                    | Valor diferente da pré-autorização - não tente novamente                                          |
| 1819   | Other errors                                                    | Verifique os dados do cartão                                                                      |
| 1820   | Other errors                                                    | Erro no cartão - não tente novamente                                                              |
| 1822   | Other errors                                                    | Contate a central do seu cartão                                                                   |
| 1823   | Other errors                                                    | Contate a central do seu cartão                                                                   |
| 1824   | Other errors                                                    | Contate a central do seu cartão                                                                   |
| 1825   | Other errors                                                    | Transação não permitida para o cartão - não tente novamente                                       |
| 1826   | Other errors                                                    | Suspensão de pagamento recorrente para serviço - não tente novamente                              |
| 1827   | Other errors                                                    | Senha inválida - não tente novamente                                                              |
| 1839   | Other errors                                                    | Saque não disponível - não tente novamente                                                        |
| 1840   | Other errors                                                    | Suspensão de pagamento recorrente para serviço - não tente novamente                              |
| 1841   | Other errors                                                    | Tente novamente mais tarde                                                                        |
| UNPR   | Não Foi possível processar                                      | Não foi possível processar a mensagem. Tente novamente.                                           |
| ISMG   | Mensagem Invalida                                               | A mensagem enviada possui um formato inválido.                                                    |
| PARS   | Erro na leitura da mensagem                                     | Algum campo obrigatório não esta sendo enviado                                                    |
| SECU   | Segurança                                                       | Algum erro no processo de segurança. A chave de criptografia pode não estar presente no terminal. |
| INTP   | SAK Invalido                                                    | O SAK enviado não foi reconhecido                                                                 |
| RCPP   | Destinatario Invalido                                           | O local para aonde a mensagem foi enviada esta invalida                                           |
| DPMG   | Mensagem Duplicada                                              | Esta mensagem já foi recebida pela Stone.                                                         |
| VERS   | Protocolo                                                       | A versão do protocolo enviada não é suportada.                                                    |
| MSGT   | Tipo da Mensagem                                                | o Message Type enviado não é reconhecido                                                          |