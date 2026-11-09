---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# 3DS

### O que é 3DS 2.0?

Com o objetivo de minimizar o índice de fraude sem prejudicar a taxa de conversão, a indústria de meio de pagamento desenvolveu um novo padrão de autenticação, chamado EMV 3DS , ou também chamado de 3DS 2.0. A nova versão é capaz de analisar dezenas de variáveis que são utilizadas como critérios para determinar se um comprador é de fato o portador cartão, permitindo em alguns casos, a autenticação silenciosa do mesmo (autenticação sem desafio), sem prejuízo à questão do Liability Shift dos estabelecimentos.

> 📘 O que é Liability Shift?
>
> A transferência de responsabilidade geralmente se refere à responsabilidade de cobrir as perdas decorrentes de transações fraudulentas transferidas do comerciante para o banco emissor quando o comerciante tiver autenticado a transação usando qualquer um dos protocolos 3D Secure (3DS). Se o comerciante não autenticar a transação do cartão de crédito com um método 3D Secure, o comerciante permanecerá responsável por estornos e perdas por fraude.

3D significa “três domínios”, que são utilizados para autenticar o portador. Os três domínios são:\
• O emissor do cartão;\
• Adquirentes como gateway de pagamentos;\
• Sistemas de interoperabilidade, analisadores de risco, e assim por diante…

Os três domínios atuam em conjunto cruzando informações do portador para confirmar a autenticidade do mesmo. Podendo ser um processo com atrito (Requisitando ao portador informações que ele tenha cadastrado junto ao emissor do cartão, como data de aniversário, CPF, nome da mãe, ou outros…) em casos que a transação for classificada como alto risco, no cruzamento das informações e análise de risco, ou, em casos de baixo risco, um processo sem atrito, ou seja, sem requisição adicional de dados.

Principais benefícios de 3DS:

• Integração facilitada via Java Script;\
• Interface de autenticação é responsiva para mobile;\
• Possibilidade de autenticação "silenciosa" (isenção do desafio);\
• Minimiza transações com fraudes.

### Quem pode usar o 3DS 2.0?

O 3DS 2.0 é válido para todas as transações de ECommerce, sejam de débito, crédito ou pré-pago. Aos segmentos que possuem alto índice de chargeback/fraude, a solução tende a ser ainda mais vantajosa frente ao benefício de passar o liability shift ao banco emissor.

> 📘 Quais são requisitos para a utilização do 3DS 2.0?
>
> O estabelecimento comercial deve atender aos requisitos abaixo para a utilização do 3DS 2.0:
>
> • Ter uma afiliação Válida;\
> • Ter o 3DS habilitado na afiliação;\
> • Concluir a integração técnica do fluxo de autenticação.

<br />

> ⚠️ **Atenção**
>
> Esta *feature* só esta disponível para integrações digitais