# Apps de delivery

Pedidos de iFood, 99Food, Keeta, Delivery Much, Aiqfome, Anota AI e Rappi entram numa caixa de entrada única
(`server/delivery/deliveryInbox.ts`). Cada app fica atrás de um adapter que implementa
`DeliveryMarketplaceAdapter` (`server/delivery/marketplace.ts`) e traduz o formato dele para o `DeliveryOrder` comum.

## Situação de cada app

| App | Como integra | Situação no Tchê Food | O que falta |
|-----|--------------|-----------------------|-------------|
| iFood | API oficial (Merchant API), homologação do app | Servidor de polling + gravação no Supabase prontos ([ifood-homologacao.md](ifood-homologacao.md)); tela no item 5 | Credenciais de teste, conferir rotas "a confirmar", homologação |
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

Servidor de polling, API para o app, rotas conferidas e o que falta para a homologação:
[ifood-homologacao.md](ifood-homologacao.md).

- `server/delivery/ifood/ifoodMerchantApi.ts`: adapter (token, polling, ack, pedido, ações, negociação, pausa da loja).
  Caminhos em `IFOOD_PATHS`.
- `server/delivery/ifood/ifoodServer.ts` e `main.ts`: polling a cada 30 s e API HTTP para o app.
- `server/delivery/supabaseDeliveryRepository.ts`: grava pelas funções de `db/schema_delivery_servidor.sql`.
- `server/delivery/ifood/ifoodSandbox.ts`: iFood falso em memória que responde pelo mesmo `fetch`. Os testes e a tela
  **Delivery** (perfis Caixa, Gerente e Proprietário) usam ele.

## Para ligar uma loja de verdade

1. Conta no Portal do Desenvolvedor do iFood, app centralizado, `client_id`/`client_secret` (o segredo só nas variáveis
   de ambiente do servidor).
2. Aplicar as migrations no Supabase e cadastrar o `merchantId` da loja em `delivery_integrations`.
3. Subir o servidor (uma instância) com as variáveis de [ifood-homologacao.md](ifood-homologacao.md#rodar).
4. Trocar a tela Delivery do simulador para ler `delivery_orders` e chamar as ações pelo servidor (item 5 do piloto).
5. Passar pela homologação do iFood com a loja de teste.
