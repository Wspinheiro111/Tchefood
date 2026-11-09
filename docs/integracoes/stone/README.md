# Integração Stone — maquininha avulsa (Connect Stone 2.0)

Guia da integração do Tchê Food com as maquininhas Stone. Baixado e lido em 30/10/2026.

A documentação original completa fica em `referencia/` (cópia das páginas `.md` oficiais), para que nenhuma
sessão futura precise baixá-la de novo:

- `referencia/connect-stone/` — Connect Stone 2.0 (o produto que usamos). Fonte: https://connect-stone.stone.com.br/llms.txt
- `referencia/stone-online/` — API Stone Online (lida, mas **não** é o produto certo; veja abaixo). Fonte: https://online.stone.com.br/llms.txt
- `referencia/pagarme/` — páginas de webhooks e rate limit do Pagar.me v5, que o Connect usa por baixo.

## Qual produto da Stone

| Produto | Para quem | Serve ao Tchê Food? |
|---|---|---|
| **Connect Stone 2.0** | PDV/ERP que manda a cobrança para a maquininha Stone pela nuvem | **Sim.** É o equivalente ao Mercado Pago Point e ao Vero Cliente PDV que já temos. |
| Stone Online | Gateways e subadquirentes que recebem o número do cartão, o chip (EMV) e o PIN e autorizam direto na Stone | **Não.** Exige certificação PCI DSS anual e que o nosso sistema trate dados de cartão, o que o Tchê Food proíbe por regra (nunca guardar PAN, PIN ou CVV). |
| SDK Stone em SmartPOS | App Android dentro da maquininha (como o nosso app PagBank) | Não nesta fase. |

## Como funciona o Connect

1. O caixa fecha a venda no Tchê Food.
2. O servidor cria um **pedido direto** na API do Pagar.me (`POST https://api.pagar.me/core/v5/orders`), apontado para o
   número de série da maquininha (`poi_payment_settings.devices_serial_number`).
3. O App de Pagamento da Stone, aberto na tela **"Aguardando Pagamentos"**, recebe o pedido e abre a cobrança sozinho.
4. O cliente paga. Cada pagamento vira uma **charge** dentro do pedido.
5. O Pagar.me manda o webhook `charge.paid` (ou `charge.refunded` quando estornam na maquininha).
6. O servidor **reconsulta** o pedido na API, confere tudo e conclui a venda.
7. O servidor **fecha o pedido** (`PATCH /core/v5/orders/{id}/closed` com `{"status":"paid"}`).
8. (Opcional) O servidor manda a NF-e/cupom para a maquininha imprimir (`POST /posconnect/v1/orders/{id}/prints`).

Credenciais por loja: cada loja cliente é uma **Account** no Pagar.me, ligada ao **StoneCode** dela, com uma **Secret Key**
(`sk_...`) própria. O Tchê Food, como parceiro, também tem o **ServiceRefererName**, recebido no Partner Hub, que vai no
cabeçalho de toda chamada.

## Passos com a Stone (fora do código)

1. Cadastro no programa de parceiros: https://partner.stone.com.br/formulario
2. A Stone dá acesso ao Partner Hub (https://partnerhub.stone.com.br/), ao painel do Pagar.me e ao `ServiceRefererName`.
3. A ativação do Connect é feita por loja, no credenciamento. É nela que se escolhe o fluxo (**pedido direto** para o
   caixa) e se configura o webhook.
4. Com o código pronto, a Stone manda um **roteiro de testes de homologação**. Preenchemos, devolvemos e eles validam.
5. Depois da aprovação, o gerente comercial manda o **manual do parceiro** para ativar os clientes.

Perguntas para levar ao gerente da Stone:

- O "split na autorização", obrigatório desde fev/2026, vale para nós? Pela documentação, ele é do modelo **Connect
  Split**, em que o parceiro recebe parte de cada venda. Se o Tchê Food não cobra comissão por transação, não deve se aplicar.
- O pedido aceita o campo `code` (nossa referência) e o devolve na consulta? O código depende disso para conferir a venda.
- A criação de pedido aceita o cabeçalho `Idempotency-Key`? Se aceitar, uma criação incerta pode ser repetida com segurança.
- Quais maquininhas estão liberadas hoje? A documentação cita S920, Q92, T8 e D400, e diz que a P2A11 está temporariamente fora.
- Pix pelo Connect: a documentação técnica diz "app de pagamentos 6.4+", mas a central de ajuda diz "ainda não".
- **Cartão negado no pedido direto:** a maquininha cria uma charge `failed` e deixa o cliente tentar outro cartão no mesmo
  pedido? Ou o pedido some da tela? O código funciona nos dois casos (veja "Regras do código"), mas a resposta muda o que
  o operador vê.
- O número de série volta no pagamento (`terminal_serial_number`) sempre em maiúsculas?
- O webhook do Pagar.me v5 tem assinatura ou autenticação (usuário e senha)? Hoje protegemos com um segredo na URL.
- Cartão pré-pago no débito chega com `account_funding_source = Prepaid`? Contamos como débito.

## O que NÃO fazer (erros comuns)

Juntamos aqui os avisos da própria documentação da Stone e do Pagar.me e os erros clássicos de integração de
maquininha (cobrança duplicada, venda concluída sem pagamento):

1. **Não esquecer de fechar o pedido depois do pagamento.** É o aviso mais repetido pela Stone: pedido pago e aberto
   continua na fila. Com **30 pedidos abertos** a maquininha para de receber pedidos novos, e o sintoma é "o pedido não
   aparece na maquininha".
2. **Não confiar no corpo do webhook.** O webhook do Pagar.me não tem assinatura. Ele só diz *qual* pedido consultar. A
   venda só é concluída depois de consultar o pedido na API com a chave da loja (`getCharge`).
3. **Não repetir a criação do pedido após timeout ou erro.** Timeout não quer dizer que o pedido não foi criado. Repetir
   pode mandar duas cobranças para a maquininha e cobrar o cliente duas vezes. Criação incerta vai para reconciliação ou
   revisão manual (`createRetryPolicy = "never"`).
4. **Não confundir "fechar/cancelar pedido" com estorno.** Fechar o pedido como `canceled` só impede pagamentos novos e
   **não devolve dinheiro**. Estorno de pagamento aprovado é feito **na maquininha (App de Cancelamento)** ou no portal
   Stone. Depois do estorno chega o webhook `charge.refunded`.
5. **Não dar a venda como cancelada logo depois de cancelar o pedido.** A maquininha só larga o pedido na próxima
   atualização (até cerca de 1 minuto) ou quando o operador toca no **X vermelho**. Nesse intervalo o cliente ainda pode
   pagar. Por isso o cancelamento devolve `cancellation_pending` e o sistema reconsulta.
6. **Não aprovar sem prova completa.** Uma charge `paid` só conta se tiver NSU (`charge.code`), código de autorização,
   número de série da maquininha e valor pago igual ao valor do pedido. Se faltar qualquer um, vai para revisão manual.
7. **Não aceitar pagamento dividido como venda simples.** Duas ou mais charges que não sejam cartões negados (débito +
   crédito, pagamento em dobro) vão para conferência humana. Cartão negado seguido de cartão aprovado no mesmo pedido é
   uma venda normal.
8. **Não testar com cartão de teste.** O Connect **não tem sandbox de ponta a ponta**: pedido criado no sandbox do
   Pagar.me não chega à maquininha. Teste em produção com **R$ 1,00**, cartão real, e estorne na maquininha logo depois.
   Avise a equipe, porque mexe no domicílio bancário da loja.
9. **Não expor a Secret Key.** Ela movimenta dinheiro real. Fica criptografada no banco (como o token do Mercado Pago),
   nunca vai ao navegador, ao app ou a log, e nunca entra no repositório.
10. **Não consultar o pedido em loop.** A Stone pede que a consulta seja usada só para resiliência. O limite do Pagar.me
    é de 200 consultas por minuto por rota. Use o webhook como gatilho e a consulta como confirmação.
11. **Não mandar pedido para a maquininha errada.** Confira o número de série cadastrado. O app precisa estar aberto em
    "Aguardando Pagamentos", com internet estável.
12. **Não usar "Cobrar Valor Avulso" para vendas do sistema.** Venda feita direto na maquininha cria pedido e charge
    sem ligação com a venda do Tchê Food, e precisa de conciliação manual.
13. **Não usar a API Stone Online.** Ela exige PCI DSS e o tratamento de dados de cartão (veja a tabela acima).

## Regras do código (como cada situação é tratada)

| Situação na Stone | O que o Tchê Food faz |
|---|---|
| Pedido aberto sem nenhuma charge | Aguardando o cliente pagar. Pode cancelar. |
| Só cartões negados (`failed`) no pedido aberto | Continua aguardando: o cliente pode tentar outro cartão na maquininha. O caixa mostra "o último cartão foi recusado". Pode cancelar. |
| Uma charge em andamento (`pending`/`processing`) | Aguardando. Não pode cancelar (o cliente está pagando). |
| Uma charge paga, com ou sem negadas antes | Aprova só com NSU, autorização, número de série da maquininha certa, valor pago igual ao da venda e a modalidade escolhida (crédito/débito, à vista). Faltou algo: conferência. Aprovou: grava a venda e fecha o pedido (`status: paid`). |
| Charge estornada (`canceled`) antes da venda | Conferência ("estornado antes de a venda ser gravada"). |
| Duas ou mais charges que não sejam negadas, ou mais de 5 charges | Conferência. |
| Pedido fechado como `canceled` sem pagamento | Cobrança cancelada. |
| Qualquer outro estado | Conferência. Nunca vira venda sozinho. |
| Resposta do POST de criação perdida (timeout, queda) | Não repete a criação. Procura o pedido pela referência (`GET /core/v5/orders?code=`) a cada consulta por até 60 s; achou, segue por ele; não achou, conferência. |
| Aviso de pagamento para cobrança já cancelada | Reabre para conferência ("aprovado depois de encerrada"), com a aprovação registrada como evidência: não dá para marcar "não cobrado". |
| Aviso de pedido de uma cobrança em conferência sem pedido | Liga o pedido à cobrança, se a consulta confirmar que a referência é desta venda. |
| Cobrança cancelada e pedido dela ainda aberto sem pagamento | Fecha o pedido como `canceled`, para ninguém pagar depois. |
| Estorno na maquininha depois de a venda gravada | Fecha o pedido de novo e registra `payment_terminal_refunded_after_sale` na auditoria. A venda **não** é desfeita sozinha (estoque, caixa e nota dependem de decisão da loja). |
| Conferência com pedido aberto e sem pagamento | O administrador usa "Encerrar pedido na maquininha" e depois "Não foi cobrado". |

**Crédito parcelado** (Stone e Mercado Pago): de 2x a 12x, escolhendo no caixa quem paga os juros — "sem juros (loja
paga)" vira `installment_type: merchant` na Stone e `installments_cost: seller` no Mercado Pago; "com juros (cliente
paga)" vira `issuer` / `buyer`. A venda só é gravada se o pagamento voltar no mesmo número de parcelas, com o mesmo tipo
de juros (quando o adquirente informa) e com valor pago igual ao da venda; se não, vai para conferência. A observação da
venda registra o parcelado (a venda não tem campo de parcelas). No Mercado Pago, pré-escolher as parcelas só funciona nas
Point Pro 2 e Pro 3, o "sem juros" exige plano ativo na conta para aquele número de parcelas, e a documentação não diz se
o valor pago muda no "com juros": confirmar num teste real (se mudar, essas vendas vão para conferência).

O caixa consulta a Stone a cada 5 s (o Mercado Pago, a cada 2,5 s), porque a Stone pede que a consulta seja só para
resiliência: quem grava a venda primeiro, normalmente, é o aviso (webhook).

## O que já está no código do Tchê Food

Portado do Tchê Vendas (mesmo autor), sem mudar as regras:

- `server/payments/stoneConnect.ts` — cliente do Connect Stone 2.0 (`createCharge`, `getCharge`,
  `findChargeByReference`, `cancelCharge`, `closeApprovedOrder`, `print`, `parseStoneConnectWebhook`), com as regras
  da tabela acima. Testes em `server/payments/stoneConnect.test.ts`, com a API simulada.
- `server/shared/paymentTerminal.ts` — contrato `PaymentTerminalProvider` e o vocabulário de estados
  (`pending`, `at_terminal`, `approved`, `rejected`, `cancelled`, `refunded`, `manual_review`).

O módulo roda em servidor (Node 20+ ou Supabase Edge Function com `node:buffer`), porque a Secret Key da loja **nunca**
pode ir para o navegador ou para o APK. O front-end continua usando o simulador até existir esse servidor.

### O que falta para ligar de verdade

1. Servidor (Supabase Edge Function ou Node) com três rotas: criar cobrança, consultar cobrança e webhook
   `POST /webhooks/stone-connect?token=<STONE_CONNECT_WEBHOOK_TOKEN>` que só chama `getCharge` (nunca confia no corpo).
2. Secret Key por loja guardada cifrada no banco; número de série da maquininha em `pos_terminals.serial_number`
   (maiúsculas).
3. Depois de aprovado e conferido: `closeApprovedOrder` (com 30 pedidos abertos a maquininha para de receber).
4. Criação incerta (timeout, 5xx, 429) nunca é repetida: vai para `findChargeByReference` ou revisão manual.

### Variáveis de ambiente (servidor)

| Variável | O que é |
|---|---|
| `STONE_CONNECT_SERVICE_REFERER_NAME` | Identificador do Tchê Food como parceiro, recebido no Partner Hub. |
| `STONE_CONNECT_WEBHOOK_TOKEN` | Segredo longo e aleatório que vai na URL do webhook cadastrada no Pagar.me (eventos `charge.paid` e `charge.refunded`). |

## Próximas etapas

- Servidor e webhook (item 1 acima).
- Impressão da NFC-e na maquininha pelo método `print`.
- Homologação com a Stone, com maquininha e cartão reais: [`roteiro-homologacao.md`](roteiro-homologacao.md). Levar
  também as perguntas da seção "Passos com a Stone".
