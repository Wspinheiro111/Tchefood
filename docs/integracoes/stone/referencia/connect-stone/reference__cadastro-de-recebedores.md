---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Cadastro de Recebedores

Antes de iniciar o processo de geração de pedidos, é necessário realizar o credenciamento dos recebedores que irão participar das transações.

O objeto ***recipient\_id*** representa um **recebedor**, esse código de identificação será usado para direcionar os valores do split de pagamentos.

> 🚧 Atenção - Mudanças no contrato de recebedores
>
> Com objetivo de atender as diretrizes dispostas na [Circular 3.978/20 do Banco Central](https://www.bcb.gov.br/pre/normativos/busca/downloadNormativo.asp?arquivo=/Lists/Normativos/Attachments/50905/Circ_3978_v1_O.pdf) sobre os procedimentos a serem adotados para prevenção à lavagem de dinheiro e financiamento ao terrorismo é imprescindível o envio de dados mínimos de cadastro para os sellers dos marketplaces.
>
> O novo contrato para a criação de recebedores entrou em vigor em Fevereiro de 2024. Para obter mais informações, consulte o artigo [Mudanças de contrato na criação de Recebedores](https://docs.pagar.me/page/novas-regras-para-cria%C3%A7%C3%A3o-de-sellers-de-marketplace-c-v5).

**Objeto recipient**

| Atributos              | Tipo     | Descrição                                                                                                                                                      |
| :--------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                     | string   | Código do recebedor. Formato: re\_XXXXXXXXXXXXXXXX.                                                                                                            |
| name                   | string   | Nome do recebedor.                                                                                                                                             |
| email                  | string   | E-mail do recebedor.                                                                                                                                           |
| document               | string   | CPF ou CNPJ do recebedor.                                                                                                                                      |
| description            | string   | Descrição do recebedor.                                                                                                                                        |
| type                   | enum     | Tipo de cliente. Valores possíveis: individual (pessoa física) ou company (pessoa jurídica).                                                                   |
| status                 | string   | Status do recebedor. Valores possíveis: registration, affiliation, active, refused, suspended, blocked, inactive                                               |
| created\_at            | datetime | Data de criação do recebedor (UTC).                                                                                                                            |
| updated\_at            | datetime | Data de atualização do recebedor (UTC).                                                                                                                        |
| default\_bank\_account | object   | Conta bancária do recebedor.                                                                                                                                   |
| transfer\_settings     | object   | Informações de transferência do recebedor.                                                                                                                     |
| gateway\_recipients    | object   | Informações do recebedor no gateway.                                                                                                                           |
| metadata               | object   | Objeto chave/valor utilizado para armazenar informações adicionais sobre o recebedor. [Saiba mais sobre metadata](https://docs.pagar.me/reference/metadata-1). |

> 🚧 Status do Recebedor
>
> Recebedores podem receber os seguintes status:
>
> **registration:** Estágio no qual o recebedor já passou pelo pré-credenciamento e está com o auto credenciamento pendente. Aqui ele pode transacionar, mas não pode realizar um saque.
>
> **affiliation:** Estágio no qual o recebedor já passou pelo auto credenciamento e está esperando a afiliação por parte do Pagar.me. Ele continua podendo transacionar, mas não pode realizar um saque.
>
> **active:** Estágio no qual o recebedor já passou por todos os estágios do credenciamento e esta apto a transacionar e realizar saques.
>
> **refused:** Estágio no qual o recebedor foi recusado no pré-credenciamento ou na afiliação. Nesse estágio o recebedor não esta apto a realizar transações e saques.
>
> **suspended:** Estágio no qual o recebedor não se auto credenciou após um período de dias, ou teve pendências no estágio de afiliação. Nesse estágio o recebedor não esta apto a realizar transações e saques.
>
> **blocked:** Estágio no qual após ativo, mostrou comportamento suspeito. Nesse estágio o recebedor não esta apto a realizar transações e saques.
>
> **inactive:** Estágio no qual após ser monitorado, mostrou comportamento suspeito, e comprovamos algo de errado. Nesse estágio o recebedor **não** esta apto a realizar transações e saques.

<br />

> 🚧 Criação de recebedores
>
> Para mais detalhes da criação de recebedores consulte esse [link](https://docs.pagar.me/reference/recebedores-1) da documentação da pagar.me