# Apps de delivery

Pedidos de iFood, 99Food, Keeta, Delivery Much, Aiqfome, Anota AI e Rappi entram numa caixa de entrada única
(`server/delivery/deliveryInbox.ts`). Cada app fica atrás de um adapter que implementa
`DeliveryMarketplaceAdapter` (`server/delivery/marketplace.ts`) e traduz o formato dele para o `DeliveryOrder` comum.

## Situação de cada app

| App | Como integra | Situação no Tchê Food | O que falta |
|-----|--------------|-----------------------|-------------|
| iFood | API oficial (Merchant API), homologação do app | Adapter pronto + simulador | Conta no Portal do Desenvolvedor, credenciais de teste, homologação |
| 99Food | Open Platform da 99Food | Planejado | Cadastro de parceiro; documentação só abre com navegador |
| Keeta | Padrão Open Delivery (Abrasel) | Planejado (adapter Open Delivery genérico) | Credenciais OAuth `od.all` + `X-App-Signature` |
| Delivery Much | API de parceiro | Planejado | Contrato de parceria |
| Aiqfome | API de parceiro | Planejado | Contrato de parceria |
| Anota AI | API de parceiro (empresa do grupo iFood) | Planejado | Parceria de PDV |
| Rappi | Rappi Partners | Planejado | Homologação |

## Regras que valem para todos os apps

- **Ack só depois de gravar.** O evento é confirmado ao app só quando o pedido já está salvo; se algo falhar, o app
  reenvia no próximo polling e o pedido não some.
- **Evento repetido não duplica pedido.** Os apps entregam "pelo menos uma vez"; a chave é `(channel, external_event_id)`.
- **Status só anda para frente.** Evento atrasado não volta um pedido despachado para "confirmado"; cancelado é final.
- **Cancelamento pedido pela loja só vale quando o app confirma.** Até lá o pedido fica travado ("cancelamento pendente").
- **Cancelamento do app depois de aceito** e falha de impressão/KDS viram pendência para o lojista conferir.
- **Item sem código PDV ou total que não fecha** entra mesmo assim, com aviso. O PDV nunca recusa nem "corrige" valores
  do app sozinho.
- **Segredos só no servidor.** `client_secret` de app nunca vai ao navegador nem ao banco (`delivery_integrations` guarda
  só qual `merchantId` é de qual loja).

## iFood

`server/delivery/ifood/ifoodMerchantApi.ts`

- Token: `POST /authentication/v1.0/oauth/token` (`client_credentials`), reaproveitado até 1 min antes de vencer e
  renovado sozinho se o iFood responder 401.
- Polling: `GET /order/v1.0/events:polling` a cada 30 s com `x-polling-merchants` (o iFood considera a loja aberta
  enquanto o polling roda).
- Ack: `POST /order/v1.0/events/acknowledgment`.
- Pedido: `GET /order/v1.0/orders/{id}`; ações `confirm`, `startPreparation`, `readyToPickup`, `dispatch`
  (só com motoboy da loja), `cancellationReasons` e `requestCancellation`.
- Códigos de evento: PLC, CFM, PRS/SPS, RTP, DSP, CON, CAN, CAR, CARF. Os demais ficam só no histórico.

Os caminhos seguem a versão 1.0 da API e foram escritos sem acesso à documentação oficial (o portal não abre sem
navegador). **Conferir cada um no portal antes da homologação.**

`server/delivery/ifood/ifoodSandbox.ts` é um iFood falso em memória que responde pelo mesmo `fetch`. Os testes e a tela
**Delivery** (perfis Caixa, Gerente e Proprietário) usam ele.

## Para ligar uma loja de verdade

1. Criar a conta em developer.ifood.com.br e o app (modelo centralizado), anotar `client_id`/`client_secret`.
2. Rodar a caixa de entrada num servidor (ainda não existe; ver PRs de backend) com as credenciais em variáveis de
   ambiente e `DeliveryRepository` gravando em `delivery_orders` / `delivery_events` no Supabase.
3. Trocar a tela Delivery do simulador para ler `delivery_orders` (Realtime) e chamar as ações pelo servidor.
4. Passar pela homologação do iFood com a loja de teste.
