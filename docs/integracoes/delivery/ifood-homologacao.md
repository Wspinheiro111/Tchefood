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

Todas exigem `Authorization: Bearer <JWT da sessão do app>`, menos `/health`.

Cancelar, responder negociação, pausar e retomar a loja são ações de gerente: o corpo leva também
`authorization: {managerPin, performedBy, requestId, reason}` (PIN de gerente de 4 a 8 dígitos, UUID do operador,
UUID gerado pelo app por tentativa e motivo com 5 caracteres ou mais). O servidor confere o PIN no banco
(`tchefood_delivery_authorize`, com o mesmo bloqueio de 3 erros em 60 s do PIN de gerente) ANTES de chamar o
iFood; a autorização e o resultado da chamada ficam em `audit_logs`. Campos faltando: 400. PIN errado ou
bloqueado: 403 com `code` (`PIN_FAILED`, `PIN_LOCKED`, `DENIED`); mesmo `requestId` reaproveitado em outra ação, alvo ou pessoa: 409 (reenvio igual devolve a mesma autorização).

| Método e rota | O que faz |
|---|---|
| `GET /health` | Público: `ok`, `running`, `merchants`, `lastCycleAt` e `hasError` (sim/não). O texto do erro fica só no log. |
| `POST /ifood/orders/:id/actions/:acao` | `confirm`, `start_preparation`, `ready_for_pickup`, `dispatch` |
| `GET /ifood/orders/:id/cancellation-reasons` | Motivos que o iFood aceita agora para o pedido |
| `POST /ifood/orders/:id/cancellation` | `{code, description, details?, authorization}`; o código precisa estar na lista atual |
| `POST /ifood/orders/:id/dispute` | Resposta à negociação (corpo abaixo), mais `authorization` (PIN de gerente) |
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
  `DISPUTE_ALREADY_ANSWERED` conta como resposta enviada (não libera nova tentativa) e vira pendência.
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
  primeiro evento do pedido).
- Não foi testado contra o iFood de verdade: depende das credenciais de teste do Portal do Desenvolvedor.
