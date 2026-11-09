---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Autorização de Subadquirentes com dados de sublojistas

Por determinação do Banco Central e das bandeiras os cliente de E-commerce que se enquadram na categoria de Facilitadores de Pagamento (subadquirentes) deverão enviar dados referentes aos seus sublojistas em cada requisição transacional.

Abaixo apresentamos as informações que devem ser enviadas nessas transações:

| Valores possíveis           | Definição                                                                                                                                                                                                                                     |
| :-------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCC                         | Código de categoria do estabelecimento comercial do sublojista. Limite de quatro dígitos. O MCC deve estar de acordo com as regras das bandeira. Mais informações [aqui](https://online.stone.com.br/docs/regras-de-mcc-para-subadquirentes). |
| Código do subadquirente     | Código de identificação do subadquirente cadastrado com as bandeiras                                                                                                                                                                          |
| Código do sub credenciador  | Código de identificação do sublojistas para o subadquirente.                                                                                                                                                                                  |
| Nome fantasia do sublojista | -                                                                                                                                                                                                                                             |
| Razão Social do sublojista  | -                                                                                                                                                                                                                                             |
| Documento                   | CPF ou CNPJ do sublojista                                                                                                                                                                                                                     |
| Telefone                    | Telefones do sublojista                                                                                                                                                                                                                       |
| Endereço                    | Endereço do sublojista (até 90 caracteres)                                                                                                                                                                                                    |
| País                        | País do sublojista                                                                                                                                                                                                                            |
| Estado                      | Estado do sublojista                                                                                                                                                                                                                          |
| Bairro                      | Bairro do sublojista                                                                                                                                                                                                                          |
| Cep                         | Cep do sublojista                                                                                                                                                                                                                             |

<br />

Saiba mais sobre dados de sub lojista através da nossa [API Reference](https://online.stone.com.br/reference/autoriza%C3%A7%C3%A3o-com-dados-de-subadquirente)!