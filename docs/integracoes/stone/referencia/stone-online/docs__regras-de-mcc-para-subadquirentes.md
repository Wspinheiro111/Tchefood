---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Regras de MCC para subadquirentes

### Regra básica de MCC para sublojistas CNPJ

O Código da Categoria do Comerciante (MCC) da transação deve sempre retratar a atividade do sublojista.

Para os sublojistas cadastrados com CNPJ, o MCC deve refletir a Classificação Nacional de Atividades Econômicas (CNAE) seguindo o Cadastro Unificado de MCCs disponibilizado mensalmente pela Associação Brasileira das Empresas de Cartões de Crédito e Serviços (Abecs).

As informações do Cadastro Unificado de MCCs disponibilizadas pela Abecs são obtidas a partir da base de CNPJs da Receita Federal, bem como através de deliberações de contestações já finalizadas.

O MCC 0000 (“MCC Dinâmico”) não deverá ser trafegado na mensageria transacional.

> 🚧 Importante:
>
> Além das exigências citadas, existem exceções à regra que devem ser cumpridas pela subadquirente e estão listadas abaixo nesta documentação. Revise e ajuste os sistemas para evitar multas.

### Regra básica de MCC de sub lojistas CPF

A partir de 1º de março de 2025, sublojistas cadastrados com CPF devem usar apenas os MCCs listados abaixo, em conformidade com regras da bandeiras. Revise e ajuste os sistemas para evitar multas. A padronização assegura conformidade regulatória, transparência e uma avaliação de risco eficaz.

MCCs possíveis:

| MCC  | Descrição                                                 |
| :--- | :-------------------------------------------------------- |
| 5970 | Produtos Artesanais                                       |
| 8099 | Medicina em Geral e Praticantes de Serviços de Saúde      |
| 8021 | Dentistas e Ortodontistas (Clínicas e Consultórios)       |
| 7379 | Computadores: Consertos e Reparos                         |
| 1799 | Demais Serviços de Reforma e Construção Não-Classificados |
| 8011 | Médicos (Clínicas e Consultórios)                         |
| 7538 | Serviços para Carros (Não Concessionária)                 |
| 0742 | Veterinária                                               |
| 7230 | Salão de Beleza / Barbearia / Depilação / Manicure        |
| 7349 | Serviços de Llimpeza e/ Manutenção                        |
| 4121 | Limusines e Táxis                                         |
| 5499 | Loja de Alimentos Variados                                |
| 5963 | Venda Direta (Door-to-door)                               |
| 5699 | Serviços Gerais para Vestimenta                           |
| 5399 | Lojas de Penhores                                         |
| 5697 | Costureiras e Alfaiates                                   |
| 7299 | Outros Serviços Pessoais                                  |
| 7399 | Serviços de Negócios                                      |
| 8111 | Serviços Jurídicos - Advogados                            |
| 8999 | Outros Serviços Profissionais de Especializados           |

### Transações de alto risco

A Stone não é uma credenciadora de Alto Risco e, portanto, não são permitidas transações de sublojistas classificados como Alto Risco.

É de extrema importância que o subadquirente tenha total conhecimento das regras inerentes aos programas de Alto Risco estipulados pelas bandeiras Visa, Mastercard e American Express, visando o atendimento satisfatório dos requerimentos.

Cabe ressaltar que as regras de Alto Risco não se restringem ao uso do MCC, porém ele é a primeira etapa de verificação para a investigação de um caso de Alto Risco. Um exemplo de caso Alto Risco seriam transações de Cartão Não Presente utilizando o MCC 5993 (tabacaria).

Assim sendo, revise as regras de Alto Risco das bandeiras e ajuste os sistemas para evitar multas.

### Transações de Companhias Aéreas

Conforme política interna da Stone, transações com MCCs de companhias aéreas não são permitidas.

Trata-se dos MCCs especificamente classificados como uma única companhia aérea (incluindo, mas não se limitando ao MCC 3300) e os genéricos de companhias aéreas (incluindo, mas não se limitando ao MCC 4511).

Revise e ajuste os sistemas para evitar multas

### Transações SDWO

Para operar com carteiras digitais (SDWO), é necessário ter um cadastro (Stonecode) específico para essa operação.

Além disso, a Stone deve ser comunicada com no mínimo 30 dias de antecedência, para que seja possível realizar os trâmites junto às bandeiras antes do início das operações com essa forma de pagamento.

Além disso, existem regras específicas de mensageria e de MCCs permitidos.

Consulte a documentação de [Transação de Aporte de Recursos](https://online.stone.com.br/reference/transa%C3%A7%C3%A3o-de-aporte-de-recursos).

<br />

Saiba mais sobre Autorização com dados de sublojistas através da nossa [API Reference](https://online.stone.com.br/reference/autoriza%C3%A7%C3%A3o-com-dados-de-subadquirente)!