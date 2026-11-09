---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# 3DS Data Only

# O que é 3DS Data Only?

No modelo Data Only, os campos adicionais do 3DS 2.0 são mapeados da mesma forma, e enviados para a bandeira e Bancos Emissores, porém, sem solicitar a autenticação. Uma grande característica do 3DS Data Only é ser um modelo frictionless onde não há pedido de informações extras ao usuário.

O benefício do uso do Data Only é enriquecer o banco de dados dos Bancos Emissores e das bandeiras, que passarão a receber mais informações sobre os portadores de cada lojista. Esse campo busca aprimorar a autenticação silenciosa e o índice de aprovação dos Emissores, considerando o contexto atual onde o mercado está evoluindo para a integração com o protocolo de autenticação 2.0.

Vale pontuar que nesse modelo o lojista será responsável por arcar com as fraudes pois não há liability shift visto que não há autenticação do Emissor.

## Diferença de 3DS Full e 3DS Data Only no request

A principal diferença entre uma transação 3DS Full e uma transação Data Only é o valor da tag AuthntcnRslt que numa transação de autenticação 3DS Data Only deve ser enviada com o valor UCRP, isso indica que houve uma autenticação com sucesso sem a participação do emissor.