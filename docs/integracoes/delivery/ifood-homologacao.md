# iFood: servidor de polling e homologação

Este documento descreve o servidor que recebe os pedidos do iFood (`server/delivery/ifood/`), o que já foi conferido
na documentação oficial e o que falta para a homologação. Atualizado em 14/11/2026.

## Como funciona

```
iFood ──polling 30 s──> servidor (Node, 1 instância) ──service_role──> Supabase (delivery_orders / delivery_events)
                              ▲                                              │
                              └──── app (JWT da loja) chama as ações ────────┘ app lê pelo RLS
```

- **Um processo só** (`server/delivery/ifood/main.ts`). O iFood entrega cada evento "pelo menos uma vez"; duas
  instâncias fariam polling em dobro. As gravações usam versão (`version`) e não se atropelam, mas rode uma só.
- A cada 30 s o servidor lê as lojas ligadas (`delivery_integrations` ativas), manda `x-polling-merchants` com elas,
  grava cada evento e só então faz o ack. Sem loja ligada, não faz polling.
- **O app só lê** `delivery_orders` / `delivery_events` / `delivery_integrations`. Gravar é só pelo servidor, com as
  funções `tchefood_delivery_*` (`db/schema_delivery_servidor.sql`), executáveis só por `service_role`. Um pedido do
  iFood forjado pelo aparelho viraria venda e nota fiscal.
- As ações da tela (confirmar, iniciar preparo, pronto, despachar, cancelar, responder negociação, pausar a loja)
  passam pelo servidor. O app manda o JWT da sessão; o servidor confere no Supabase, com esse JWT e a chave anon, se o
  RLS mostra o pedido ou o `merchantId` para aquela loja. Pedido de outra loja responde 404 sem tocar no iFood.
- O `client_secret` do iFood e a `SUPABASE_SERVICE_ROLE_KEY` ficam só nas variáveis de ambiente do servidor.

### API do servidor (para a tela, no item 5 do piloto)

Todas exigem `Authorization: Bearer <JWT da sessão do app>`, menos `/health`. Corpo acima de 16 KB: 413
`{error: "Corpo grande demais."}` com `connection: close` (o servidor para de ler, responde e só depois fecha a conexão).

Cancelar, responder negociação, pausar e retomar a loja são ações de gerente: o corpo leva também
`authorization: {managerPin, performedBy, requestId, reason}` (PIN de gerente de 4 a 6 dígitos, UUID do operador,
UUID gerado pelo app por tentativa e motivo com 5 caracteres ou mais). O servidor confere o PIN no banco
(`tchefood_delivery_authorize`, com o mesmo bloqueio de 3 erros em 60 s do PIN de gerente) ANTES de chamar o
iFood; a autorização e o resultado da chamada ficam em `audit_logs`. Campos faltando: 400. PIN errado ou
bloqueado: 403 com `code` (`PIN_FAILED`, `PIN_LOCKED`, `DENIED`); mesmo `requestId` reaproveitado em outra ação, alvo, pessoa, motivo
ou conteúdo (código do cancelamento, resposta da negociação, duração da pausa): 409 `CONFLICT`. Reenvio idêntico (resposta
perdida, toque repetido): 409 `ALREADY_SUBMITTED`, sem chamar o iFood de novo; a tela relê o pedido/loja. O texto não
afirma que foi enviado (a autorização pode ter gravado e só a resposta do banco se perdido): diz que a tentativa já foi
registrada, pode estar em andamento ou não ter chegado ao iFood, e pede conferir no Portal do Parceiro antes de tentar
de novo com uma nova tentativa. Se a
tentativa com esse id falhou antes de chegar ao iFood (banco fora do ar na reserva) ou o iFood recusou: 409
`RETRY_WITH_NEW_ID` (nada foi enviado; a tela gera outro `requestId` e pede o PIN de novo). O que o gerente
aprovou fica em `audit_logs.metadata.details`.

Pausa e cancelamento com resultado incerto (tempo esgotado, iFood fora do ar ou resposta estranha depois de enviar):
o status HTTP do erro (503/502) com `code: "uncertain"` e "pode ter sido aplicado; confira a lista de pausas (ou o pedido
no Portal do Parceiro) antes de tentar de novo", nunca só "iFood indisponível". A tela relê `GET .../pauses` antes de
oferecer outra pausa. Recusa clara do iFood (4xx) continua com o código do erro (nada foi aplicado).

Se o iFood aceitou e o banco falhou logo depois (cancelamento e negociação): 503 com `code: "sent_not_saved"` e "Enviado ao
iFood, mas não deu para gravar; confira o pedido antes de repetir." O pedido fica reservado (nova tentativa recusada) até o
evento do app chegar (na negociação, passados 60 s, a repetição com `confirmUncertainRetry` volta 422 do iFood; ver
abaixo). A reserva de cancelamento sem confirmação (chamada em andamento, ou falha sem resposta clara: rede,
5xx) não se libera só pelo tempo: passados 10 min sem evento nenhum, a nova tentativa só vai se o corpo trouxer
`confirmUncertainRetry: true` (o gerente conferiu no Portal do Parceiro que o pedido não está cancelado nem com
cancelamento em análise; a decisão fica em `audit_logs.metadata.details`). Sem ela: 409. Dentro dos 10 min, o 409
diz a partir de que horas (horário de Brasília, `reservedAt` + 10 min) a repetição com a conferência vale. Com ela, o servidor consulta o
pedido no iFood (`GET /orders/{id}`): consulta falhou, 409 e segue bloqueado ("confira no Portal do Parceiro"); pedido já
cancelado no detalhe, grava e recusa (com o iFood esse ramo nunca roda: o mapeamento do detalhe sempre devolve `placed`,
então no iFood a única proteção contra o pedido repetido é o `confirmUncertainRetry` do gerente); senão pede de novo uma vez e marca o pedido para conferência ("o pedido de cancelamento
anterior ficou sem confirmação e foi repetido"). Por que a conferência humana: a doc oficial não dá prova de que a
primeira chamada não foi aplicada. O detalhe do pedido não tem status nem cancelamento em análise
(https://developer.ifood.com.br/en-US/docs/guides/modules/order/details/; o mapeamento daqui sempre lê `placed`), então a
consulta só pega o caso de outro app que informe status; o pedido aplicado aparece pelos eventos CAR (pedido recebido),
CARF (recusado) e CAN (https://developer.ifood.com.br/en-US/docs/guides/modules/order/events/), e nenhuma página que abriu
diz o que o iFood faz com um `requestCancellation` repetido (a página de rotas só lista a rota, 300/min:
https://developer.ifood.com.br/en-US/docs/getting-started/documentation/rate-limit/; as de cancelamento e workflow não
abriram). Não é garantia de idempotência do iFood.

Resposta à negociação sem confirmação (falha incerta do iFood: rede, 5xx; ou reserva "em andamento" com mais de 60 s,
de um processo que caiu no meio) não espera o app: se ela não chegou, o iFood aplica o `timeoutAction` no fim do prazo
(ex.: aceita o cancelamento que a loja recusou). Sem `confirmUncertainRetry: true` no corpo: 409 antes do PIN, dizendo
que a resposta anterior pode não ter chegado, para conferir no Portal do Parceiro se a negociação já tem resposta e
repetir confirmando (com o prazo `expiresAt`, quando houver). Com ela, a resposta vai de novo (a decisão fica em
`audit_logs.metadata.details`). Repetir é seguro do lado do iFood: se a primeira chegou, a segunda volta 422
`DISPUTE_ALREADY_ANSWERED`, a negociação fica como respondida e vira pendência (409). Reserva "em andamento" com menos de
60 s continua 409 (a chamada ainda pode estar no ar); `disputeId` continua obrigatório e conferido.

Se a gravação da reserva (cancelamento ou resposta à negociação) falha com erro do banco, a reserva pode ter gravado e só
a resposta do banco se perdido (timeout depois do commit). Como o iFood ainda não foi chamado, o servidor desfaz a reserva
dessa chamada (volta o que havia antes) antes de responder 503 "Banco indisponível; tente de novo." e registrar a
autorização como `failed`: a nova tentativa segue normal, sem esperar o prazo nem pedir conferência, e a guarda de venda
não acusa um cancelamento que não foi pedido. Se o desfazer também falhar, a reserva fica (como antes da correção).

| Método e rota | O que faz |
|---|---|
| `GET /health` | Público: `ok`, `running`, `merchants`, `lastCycleAt` e `hasError` (sim/não). O texto do erro fica só no log. |
| `POST /ifood/orders/:id/actions/:acao` | `confirm`, `start_preparation`, `ready_for_pickup`, `dispatch`. 200 com o pedido **ainda no status de antes** (o novo só chega com o evento do iFood) e `actionSent: <ação>`: a tela mostra "enviado, aguardando o app" no lugar do botão. A mesma ação de novo para o mesmo pedido em até 60 s, sem evento novo do pedido: 409 "Ação já enviada ao app, aguardando a confirmação dele" sem chamar o iFood (só em memória do processo; só depois de sucesso, então a nova tentativa depois de uma falha segue normal) |
| `GET /ifood/orders/:id/cancellation-reasons` | Motivos que o iFood aceita agora para o pedido |
| `POST /ifood/orders/:id/cancellation` | `{code, description, details?, authorization}`; o código precisa estar na lista atual. Lista vazia (pedido concluído, cancelado ou fora da janela): 400 "O iFood não aceita cancelamento deste pedido agora." |
| `POST /ifood/orders/:id/dispute` | Resposta à negociação (corpo abaixo), mais `authorization` (PIN de gerente) e `disputeId` da negociação mostrada (obrigatório: ausente ou fora do formato dá 400, outra negociação dá 409, os dois antes do PIN e sem chamar o iFood). A resposta só vai para essa negociação; se o app trocar a negociação depois da conferência, a reserva dá 409 sem chamar o iFood |
| `GET /ifood/merchants/:id/status` | Loja aberta/fechada no iFood |
| `GET /ifood/merchants/:id/pauses` | Pausas ativas |
| `POST /ifood/merchants/:id/pauses` | `{description, minutes, authorization}` (1 a 1440 min); início e fim pelo relógio do servidor |
| `DELETE /ifood/merchants/:id/pauses/:pauseId` | Retoma a loja; corpo `{authorization}` |

Corpo de `POST /ifood/orders/:id/dispute` (a tela monta as opções a partir de `dispute` no pedido):

| Resposta | Corpo | Conferido antes do PIN |
|---|---|---|
| Aceitar | `{kind: "accept", reason?, detailReason?}` | Se `dispute.acceptCancellationReasons` não está vazio, `reason` é obrigatório e tem que ser da lista (400). Sem lista, o aceite vai sem corpo. `detailReason` até 250 caracteres. |
| Recusar | `{kind: "reject", reason}` | `reason` até 250 caracteres. `dispute.handshakeType = "DELAY"` não aceita recusa (409). |
| Reembolso/benefício | `{kind: "alternative", alternativeId, amountCents}` | Inteiro em centavos, maior que zero e até `alternatives[].maxAmountCents` (400). |
| Mais prazo | `{kind: "alternative", alternativeId, additionalTimeInMinutes, additionalTimeReason}` | Minutos em `alternatives[].allowedAdditionalTimeInMinutes` e motivo em `allowedAdditionalTimeReasons` (400). |

O tipo da proposta (`REFUND`, `BENEFIT`, `ADDITIONAL_TIME`) vem da negociação gravada, nunca do aparelho. O pedido
guarda também `dispute.action`, `dispute.timeoutAction` (o que o iFood faz sem resposta) e `dispute.expiresAt`.

## Rodar

```
npm run build:ifood
IFOOD_CLIENT_ID=... IFOOD_CLIENT_SECRET=... \
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... \
CORS_ORIGINS=https://app.tchefood.com.br PORT=8787 npm run start:ifood
```

- `IFOOD_BASE_URL` muda o endereço da API (padrão `https://merchant-api.ifood.com.br`).
- `IFOOD_SANDBOX=1` sobe com o iFood simulado e gravação em memória (sem credenciais; qualquer token é aceito). Só
  para testar a tela; nunca em produção.
- Antes: aplicar as migrations no Supabase (`supabase db push`) e cadastrar a loja em `delivery_integrations`
  (`tenant_id`, `channel = 'ifood'`, `merchant_external_id` = merchantId do Portal do Parceiro), pelo SQL Editor.

## Conferido na documentação oficial (developer.ifood.com.br)

Lido em 14/11/2026: eventos, detalhes do pedido, autenticação do app centralizado, limites de uso e boas práticas.
Resumo em `/mnt/project-files/tche-food/ifood/conferencia-docs-oficiais.md` (pasta do projeto).

- Eventos e o que o Tchê Food faz com cada um (`IFOOD_EVENT_SIGNALS` em `ifoodMerchantApi.ts`). Todo evento recebe
  ack, inclusive os ignorados e os desconhecidos; evento sem pedido é confirmado e descartado.
- `PRS` é início do preparo (`SPS`/`SPE` são só do iFood Mercado). `CON` pode chegar até 2 h depois da entrega.
- Cancelamento pelo cliente (`CCR`, `CCA`, `CCD`) e plataforma de negociação (`HSD`, `HSS`, com
  `POST /order/v1.0/disputes/{id}/accept | reject | alternatives/{id}`).
- Pedido: `orderAmount = subTotal + deliveryFee + additionalFees − benefits`; `benefits[].sponsorshipValues` com
  IFOOD/EXTERNAL é pago pelo iFood (entra como pagamento), MERCHANT/CHAIN é desconto da loja; agendado
  (`orderTiming = SCHEDULED`, `schedule.deliveryDateTimeStart/End`, `preparationStartDateTime`); `isTest`;
  `delivery.pickupCode`.
- `confirm` responde 202: o pedido só fica confirmado quando o `CFM` chega no polling.
- Token reaproveitado até perto de vencer (`/oauth/token` tem limite de 20/min); app centralizado não tem refresh token.
- Rotas de loja: `GET /merchants/{id}/status`, `GET/POST /merchants/{id}/interruptions`,
  `DELETE /merchants/{id}/interruptions/{id}`.

### Plataforma de negociação (conferida em 14/11/2026)

Página: https://developer.ifood.com.br/en-US/docs/guides/modules/order/handshake-platform (a versão `/pt-BR/` não
abriu para leitura automática). Confirmado nela:

- `POST /order/v1.0/disputes/{disputeId}/alternatives/{alternativeId}` leva corpo:
  `{"type": "REFUND" | "BENEFIT", "metadata": {"amount": {"value": "1500", "currency": "BRL"}}}` ou
  `{"type": "ADDITIONAL_TIME", "metadata": {"additionalTimeInMinutes": 15, "additionalTimeReason": "..."}}`. O valor é
  texto sem casas decimais (centavos). No HSD, cada alternativa traz `metadata.maxAmount` (REFUND/BENEFIT) ou
  `metadata.allowedsAdditionalTimeInMinutes` e `metadata.allowedsAdditionalTimeReasons` (ADDITIONAL_TIME). Os
  exemplos do HSD escrevem `ADDTIONAL_TIME`; o servidor lê os dois.
- `POST .../accept`: corpo `{reason, detailReason?}` obrigatório quando o HSD traz `acceptCancellationReasons`
  (lista de textos; os exemplos põem em `metadata.metadata`, a tabela em `metadata`, e o servidor lê os dois). Sem
  motivo válido: 400 `INVALID_CANCELLATION_REASON`.
- `POST .../reject`: `{reason}` até 250 caracteres. `handshakeType = DELAY` não tem recusa: 400
  `CANCELLATION_WHILE_NEGOTIATION_TIME_CANNOT_BE_REJECTED`.
- As três respondem 201 com `{id, status, disputeId, createdAt}` (status `ACCEPTED`, `REJECTED` ou
  `ALTERNATIVE_REPLIED`). Erros: 404 `DISPUTE_NOT_FOUND`, 422 `DISPUTE_ALREADY_ANSWERED`, 422
  `HANDSHAKE_ALREADY_CONCLUDED`, 400 `DISPUTE_ALTERNATIVE_INVALID`, `DISPUTE_ALTERNATIVE_TYPE_INVALID`,
  `HANDSHAKE_NEGOTIATION_TIME_INVALID_REASON`, `HANDSHAKE_NEGOTIATION_TIME_INVALID_TIME_IN_MINUTES`. O 422
  `DISPUTE_ALREADY_ANSWERED` (respondida por fora, ex.: Portal) não registra a resposta do PDV como enviada: a
  negociação fica marcada como respondida (não libera nova tentativa), vira pendência e a API responde 409.
- HSD: `metadata.disputeId`, `action` (CANCELLATION, PARTIAL_CANCELLATION, PROPOSED_AMOUNT_REFUND,
  PROPOSED_ADDITIONAL_TIME, VOID) e `handshakeType` (AFTER_DELIVERY, DELAY, PREPARATION_TIME, AFTER_DELIVERY_PARTIALLY)
  são campos diferentes; `timeoutAction` (ACCEPT_CANCELLATION, REJECT_CANCELLATION, VOID) e `expiresAt`.
- HSS: `metadata.disputeId`, `status` (ACCEPTED, REJECTED, EXPIRED, ALTERNATIVE_REPLIED), `reason`,
  `selectedDisputeAlternative` (`id`, `type`, `metadata.amount` ou minutos e motivo). `ALTERNATIVE_REPLIED` não é
  desfecho: a contraproposta foi entregue e outro HSS vem depois da resposta do cliente. O servidor só fecha a
  negociação no desfecho do mesmo `disputeId`; HSS de outra negociação não apaga a atual; desfecho aceito com
  reembolso ou benefício vira pendência com o valor (muda o que a loja recebe).

A página não diz se valor acima de `maxAmount` tem código de erro próprio (o servidor recusa antes de chamar o iFood).

## Ainda a confirmar (o portal não abriu para leitura automática)

Todos os caminhos ficam em `IFOOD_PATHS` (`ifoodMerchantApi.ts`), marcados "a confirmar" quando for o caso.

- Prefixos de versão (`/order/v1.0`, `/merchant/v1.0`, `/authentication/v1.0`).
- Nomes dos campos do token (`grantType`, `clientId`, `clientSecret`) e resposta (`accessToken`, `expiresIn`).
- Rota de `cancellationReasons` e corpo de `requestCancellation`.
- Corpo de `interruptions` (`id`, `description`, `start`, `end`) e resposta de `status`.
- Tamanho máximo do lote de ack.
- **Checklist oficial de homologação, item a item.** Pedir ao Will o PDF da página do portal (logado) para fechar.

## Mapeamento para a homologação

| Item esperado | Situação |
|---|---|
| Polling a cada 30 s com `x-polling-merchants` | Pronto (`IfoodPoller`) |
| Ack de todos os eventos, depois de gravar | Pronto; teste no Postgres |
| Evento repetido não duplica | Pronto (`delivery_events` UNIQUE; teste no Postgres) |
| Consultar o detalhe do pedido uma vez | Pronto |
| Confirmar, iniciar preparo, pronto para retirada, despachar | Pronto (API do servidor) |
| Cancelar pela loja com motivo da lista | Pronto; vale só quando o iFood confirma (`CAN`/`CARF`) |
| Cancelamento pedido pelo cliente | Pronto (pendência para a loja conferir) |
| Negociação (aceitar com motivo, recusar, reembolso/benefício, mais prazo) | Pronto (API do servidor; corpo conferido na doc oficial) |
| Pedido agendado | Pronto no adapter (horários e aviso); tela no item 5 |
| Pausar e retomar a loja | Pronto (API do servidor) |
| Mostrar código de retirada e se é pedido de teste | Dados prontos; tela no item 5 |
| Tela, impressão, KDS e NFC-e do pedido iFood | Item 5 do piloto (tela congelada até lá) |

## Limites conhecidos

- Confirmar, iniciar preparo, pronto e despachar valem para qualquer sessão da loja. Cancelar, negociação, pausar e
  retomar exigem o PIN de gerente (ver "API do servidor"); a tela que pede o PIN entra com o item 5.
- Não há bloqueio automático de consulta/atualização 8 h depois da entrega (o servidor só consulta o detalhe no
  primeiro evento do pedido e, no pedido mínimo abaixo, até recuperá-lo).
- Pedido mínimo: quando o detalhe do iFood vem ilegível, ou é recusado (403/404) em 10 ciclos seguidos, o pedido entra
  sem itens nem valores, para conferência, com `detailPending = true` (coluna `delivery_orders.detail_pending`). A cada
  ciclo, depois do ack, o servidor busca de novo o detalhe de até 20 desses pedidos; vindo
  legível, grava itens, valores, pagamentos, cliente, endereço e `isTest` sem mexer no status nem no que os eventos já
  fizeram, troca para `detailPending = false` (uma vez só; o banco só aceita trocar o pedido e o total nessa
  passagem, na mesma loja do app) e deixa a pendência "Detalhe do pedido recuperado do app: confira itens e valores.".
  Rodízio: busca que falha (erro do app, detalhe de outro pedido, conflito de gravação) adia aquele pedido 5 min
  (`delivery_orders.detail_retry_at`, gravada só por `tchefood_delivery_defer_detail`, sem mudar a versão); detalhe
  de outra loja do app marca a pendência para conferência uma vez e adia 1 h. A lista traz primeiro os pedidos nunca
  adiados, depois os de prazo mais antigo, e só os de prazo vencido: pedidos cujo detalhe nunca vem (404/403/ilegível
  para sempre) não tomam o lugar de um pedido mínimo novo. O laço tem orçamento de 10 s por ciclo (conferido antes de
  cada busca; uma busca começada vai até o timeout de 15 s do iFood) e para no primeiro erro temporário (iFood fora
  do ar, tempo esgotado ou limite de uso), adiando só aquele pedido; o resto fica na vez para o próximo ciclo, sem
  segurar o polling de 30 s.
  Até a recuperação, pedido com `detailPending = true` não pode virar venda nem NFC-e (a guarda do item 5 usa esse
  campo).
- Erro 5xx do iFood numa ação da tela volta para a tela (não há nova tentativa automática); no polling o próximo ciclo
  já tenta de novo. A doc de boas práticas recomenda nova tentativa automática: avaliar na homologação.
- Todas as lojas vão num único `x-polling-merchants`. A doc fala em usar o header a partir de 100 lojas e torná-lo
  obrigatório acima de 500, sem dizer o teto por requisição; com muitas lojas pode ser preciso dividir em lotes.
- Não foi testado contra o iFood de verdade: depende das credenciais de teste do Portal do Desenvolvedor.

## Guarda para o item 5

- `server/delivery/deliverySaleGuard.ts` diz se um pedido do app pode virar venda, produção (cozinha/KDS) ou NFC-e.
  `deliverySaleBlockers(registro)` devolve os motivos que impedem (lista vazia = pode): pedido de teste do app,
  pedido gravado sem o detalhe (`detailPending`), pedido cancelado, cancelamento em análise no app, cancelamento pedido
  pela loja (`cancellationRequest` em qualquer estado: em andamento e sem confirmação podem já ter chegado ao iFood;
  se o iFood concluir o pedido (CON) com o cancelamento em análise ou com a reserva ainda sem evento, os dois são
  zerados e o pedido vai para conferência: "O app concluiu o pedido com o cancelamento ainda em análise: confira no
  Portal do Parceiro antes de lançar.", senão a venda ficaria bloqueada para sempre) e
  negociação aberta (`dispute`: pode virar cancelamento ou mudar o valor). A negociação só vira aviso, em vez de
  bloqueio, quando a recusa da loja foi confirmada pelo iFood (falta só o fechamento) ou quando é `AFTER_DELIVERY` de
  pedido concluído (a comida foi entregue; muda o valor a receber, não se houve venda). Aceite ou proposta confirmados
  e resposta dada por fora (Portal) continuam bloqueando.
  `needsReview` sozinho não bloqueia (junta avisos de naturezas diferentes; travar por ele pararia pedido bom): sai
  como aviso em `deliverySaleWarnings(registro)`, para a tela mostrar e pedir conferência. Ainda não está ligada em
  nada: a tela do item 5 chama a guarda antes de lançar a venda, mandar para a produção ou emitir a nota.
- `newOrderNotified` não prova que alguém foi avisado: o servidor marca o campo depois de tentar o aviso, e o
  `main.ts` não passa `onNewOrder` para a caixa de entrada, então hoje ele fica verdadeiro sem aviso nenhum. O
  alerta/KDS do item 5 não pode depender desse campo para saber se o pedido já tocou na loja.
- Conferência do Supabase de verdade: depois de aplicar as migrations, cole `db/verificar_delivery_servidor.sql`
  inteiro no SQL Editor e rode. É só leitura (consultas no catálogo) e volta uma tabela `item | esperado |
  encontrado | ok` com funções `tchefood_delivery_*` e quem as executa, privilégios de `anon`/`authenticated` nas
  tabelas `delivery_*`, RLS e policies por loja, `SECURITY DEFINER` com `search_path`, colunas novas, CHECKs e os
  triggers de `audit_logs`. Linha com `NÃO` sai primeiro: não ligue o servidor antes de corrigir.
  `ainda não (opcional)` só vale para `detail_pending (rodada 3)` e `detail_retry_at (rodada 3)`, enquanto essa
  migration não estiver aplicada.
  O mesmo script roda num Postgres migrado em `db/tests/verificarDeliveryServidor.pg.test.ts`.
