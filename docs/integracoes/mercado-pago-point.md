# Mercado Pago Point (Point Smart / Point Smart 2)

Cliente servidor em `server/payments/mercadoPagoPoint.ts`, portado do Tchê Vendas (mesmas regras e testes).
Usa a **Orders API** (`POST /v1/orders`, `type: "point"`): o servidor manda a cobrança para a maquininha
pelo `terminal_id` e consulta o resultado em `GET /v1/orders/{id}`.

## Como a cobrança anda

```
Tchê Food (celular/tablet)          Edge Function point-charge           Mercado Pago            Point Smart
  "Cobrar R$ 24,50 crédito"  ──►  grava terminal_charges ("creating") ──► POST /v1/orders ──► mostra o valor
  consulta a cada 2 s         ◄──  GET /v1/orders/{id} + /v1/payments/{id}, confere tudo
  APPROVED com NSU/autorização     grava "approved"
  registra o pagamento ──────────► payments: o banco só aceita se terminal_charges está "approved" e confere
```

- Código: `src/lib/payments/mercadoPagoPointDriver.ts` (app), `supabase/functions/point-charge/` (nuvem),
  `db/schema_mercado_pago.sql` (banco).
- **NSU** = ID do pagamento no Mercado Pago (o "ID da operação" do comprovante). **Autorização**, bandeira e
  final do cartão vêm de `GET /v1/payments/{id}`. Nada é gerado pelo app.
- Aprovado só quando ordem e pagamento confirmam referência, maquininha, valor cobrado, valor pago, forma
  (crédito à vista ou débito), autorização e bandeira (Visa, Master ou Elo). Parcelas = 1 e bandeira vêm do
  próprio pagamento (ausentes não contam). Qualquer diferença vira revisão manual. O banco confere de novo ao
  gravar o pagamento, inclusive bandeira e CNPJ do Mercado Pago (10.573.521/0001-91).
- Cobrança nova só para conta **aberta no servidor**, com **operador identificado** (da equipe ativa da loja, conferido
  no banco) e dentro do saldo dele, menos as outras cobranças da mesma conta que ainda não terminaram
  (`tchefood_open_terminal_charge`, com a conta travada). Reservam: criando, na fila, na maquininha e em **revisão
  manual**, sem limite de tempo, e aprovadas ainda sem pagamento gravado. Só liberam com o fim comprovado no Mercado
  Pago (recusada, cancelada, expirada, estornada). PIN de gerente e tempo passado não liberam.
- **A conta cobrada é a que o servidor conhece** (auditoria r4): antes de cobrar, o app espera a sincronização que
  estiver em andamento (nunca toma "já está sincronizando" por sucesso), sobe a fila e só segue quando nenhum
  evento da conta (a própria conta, itens, pagamentos, cashback) ficou na fila nem foi recusado pela nuvem
  (`ensureOrderSynced`, com prazo de 15 s). O saldo da conta no aparelho vai junto (`expected_balance_cents`) e
  o banco recusa abrir a cobrança se o saldo dele for outro (`TF008`). Nada é mandado à maquininha nesses casos.
- A mesma reserva vale para **qualquer outro pagamento** da conta: dinheiro, Pix, outra maquininha ou outra cobrança
  (`db/schema_point_reserva.sql`, gatilho em `payments` com a conta travada). Pagamento aprovado só entra até o saldo
  menos a reserva das outras cobranças; o pagamento da própria cobrança aprovada consome a reserva dela. O caixa lê a
  reserva da conta a cada 5 s (`tchefood_point_reservation`) e mostra "Há uma cobrança na Point em andamento nesta
  conta" com o valor livre; sem nuvem, vale a cobrança incerta da Point gravada no próprio aparelho.
- Sem cartão em 2 minutos (contados desde o primeiro envio) o app **encerra a tentativa**: pede à maquininha que
  pare de esperar o cartão. Não é estorno: cobrança já paga continua paga e volta como aprovada. O servidor só
  aceita o encerramento por prazo depois dos mesmos 2 min, contados pelo **relógio do banco** desde a hora em que a
  cobrança foi gravada (`tchefood_request_point_timeout`; a hora gravada não muda). Como essa hora é um pouco
  depois do primeiro envio do app, o servidor pode responder "cedo demais": o app segue consultando e pedindo,
  até o limite de 3 min 30 s desde o primeiro envio. Pedidos de encerramento simultâneos gravam um só.
  Só vira "recusado" quando o Mercado Pago confirma cancelada; senão vira revisão manual.
- Encerrar **antes do prazo** a pedido do operador exige **PIN de gerente** e motivo (5+ letras), conferidos no banco
  (`tchefood_authorize_point_cancel`, mesmas regras de `tchefood_authorize_manager`: 3 PINs errados em 60 s
  bloqueiam). Fica um registro `POINT_CHARGE_CANCELED` em `audit_logs` e a cobrança guarda operador, gerente e
  registro; o banco recusa encerramento "pelo operador" sem gerente. O pedido também confere conta, valor e forma.
  Repetir o mesmo pedido reaproveita a primeira autorização (um registro só); cobrança que já terminou não gera
  registro de encerramento.
- **Um pedido por vez fala com o Mercado Pago**, em três passos no banco (relógio do banco):
  1. `tchefood_claim_point_dispatch` dá a posse do envio (30 s, maior que o prazo de 15 s da chamada; no máximo 8
     posses por cobrança). Com posse em vigor, as outras consultas só acompanham.
  2. `tchefood_begin_point_dispatch` é a barreira **imediatamente antes** da chamada: confere de uma vez só que a
     posse ainda é a de quem chama, que não venceu e que não há pedido de encerramento; marca o primeiro envio e
     renova a posse. Não passou, não manda.
  **Só o pedido de criação (`create`) manda a ordem pela primeira vez.** A consulta (`status`) só repete, com a
  mesma chave, um envio que comprovadamente já saiu (`dispatched_at` gravado), para recuperar a ordem; a barreira
  do banco confere isso de novo (`p_allow_first` falso nunca marca o primeiro envio). Cobrança gravada e largada
  antes do primeiro envio fica parada até o encerramento por prazo, que a encerra com prova (nada foi cobrado).
  3. A ordem devolvida é **ligada à cobrança assim que chega**, em qualquer estado não final (inclusive revisão
     manual), e só depois o resultado é conferido. Com o encerramento já pedido, ela é cancelada no Mercado Pago
     na mesma hora e vale o que ele responder.
  Sem resultado do Mercado Pago (queda, prazo, erro 5xx, 408, 429, resposta ilegível), a posse **nunca é devolvida
  antes da hora**: fica até vencer e só então a próxima consulta repete com a **mesma chave** (o Mercado Pago
  devolve a ordem original). Se a resposta da barreira demorar mais de 10 s para chegar, o envio não sai (a
  chamada poderia passar do fim da posse). Nesse caso o primeiro envio já ficou marcado sem a chamada ter saído,
  e quem faz o primeiro POST de verdade pode ser uma consulta (`status`) depois que a posse vence; ele conta como
  repetição, então uma recusa ali fica como resultado desconhecido (vai para revisão), nunca "nada foi cobrado".
  Recusa do pedido só vira "nada foi cobrado" no **primeiro**
  envio; numa repetição (ou com conflito de idempotência) o envio anterior pode ter criado a ordem, e a cobrança
  segue como resultado desconhecido.
- **Envio sem resposta nunca vira recusa por tempo nem por PIN.** Encerramento pedido com a ordem ainda desconhecida:
  se nenhum envio saiu, encerra com prova (`voided_before_send`); se saiu, espera a posse vencer e a cobrança vai
  para **revisão manual** (`DISPATCH_UNKNOWN`, `tchefood_settle_point_dispatch`) e segue segurando o saldo. Ela
  pode ter sido paga: confira no app do Mercado Pago. Uma resposta atrasada ainda liga a ordem à cobrança em
  revisão manual. A liberação conferida pelo gerente (com prova do Mercado Pago) fica para a tela de conciliação,
  fora deste PR.
- **Duas ordens para a mesma chave** (o Mercado Pago não deveria devolver): a segunda é cancelada no Mercado Pago
  na hora e a cobrança fica em revisão manual (`ORDER_ID_CHANGED`, com o número da segunda anotado) até alguém
  conferir; consulta nenhuma desfaz essa revisão.
- **Cobrança largada pelo aparelho** (app fechado no meio, pedido de encerramento que não chegou): ao abrir outra
  cobrança na mesma conta, o servidor encerra por prazo as antigas que já passaram dos 2 min (relógio do banco),
  com as mesmas regras: cancelada só com a confirmação do Mercado Pago; envio sem resposta vai para revisão manual
  e segue reservando.
- Chave que **nunca foi gravada** (a criação se perdeu no caminho) não tem o que cancelar: o servidor grava o
  **bloqueio preventivo** da chave (`tchefood_block_point_key`), exige operador da equipe ativa e registra
  `POINT_KEY_BLOCKED` em `audit_logs`. Pedido "pelo operador" (com PIN) sem cobrança gravada é recusado. O app, ao
  receber essa recusa, pede o bloqueio na mesma volta e guarda a autorização do gerente: se a criação gravar
  primeiro, ela vai de novo e encerra a cobrança que ficou.
- O prazo de 15 s de cada chamada conta também a obtenção da sessão (renovação do token). Sessão que não chega
  antes do primeiro envio = recusa local, nada foi mandado; depois de um envio incerto, a cobrança segue o caminho
  de sempre e termina no limite de 3 min 30 s em revisão manual se a nuvem não responder.
- Criação sem resposta (queda, prazo de 15 s por chamada estourado, erro 5xx): nem "cobrança não encontrada" nem
  outra recusa provam que nada foi cobrado, porque a primeira criação pode estar a caminho. Quem decide é o
  encerramento no servidor: sem cobrança gravada, ele grava o bloqueio preventivo da chave (`voided_before_send`) e a criação
  atrasada encontra a cobrança encerrada e não vai à Point.
- Cobrança em estado final (aprovada, recusada, cancelada, expirada, estornada) não muda mais: cada gravação só vale
  se o estado ainda for o lido, e o banco recusa mudar uma cobrança final.
- Cobrança incerta do Mercado Pago **não** entra pelo comprovante digitado: o banco recusaria. Ela se resolve pela
  tela "Conferir no Mercado Pago" (abaixo): o servidor lê o Mercado Pago e só então aprova, encerra ou libera.

## Auditoria r5 (decisões do Will, 14/11/2026)

**Reserva antes de qualquer cobrança.** Em toda loja na nuvem, com ou sem Point (auditoria r7 P1-01, decisão do
Will; antes valia só na loja com Point): todo pagamento fora do Mercado Pago (dinheiro, Stone, PagBank,
Pix manual, ficha rápida, retirada) pede antes a reserva no servidor (`tchefood_claim_payment`, conta travada,
mesma chave do pagamento, saldo conferido). Sem internet ou sem resposta do servidor, o caixa avisa e não cobra.
O banco também exige: pagamento aprovado fora do Mercado Pago sem reserva aberta da mesma conta, forma e
credenciadora é recusado (TF010), em qualquer loja e mesmo de aparelho antigo que não pede reserva. Única exceção: o
dinheiro do entregador de uma entrega paga na entrega que o banco confere (`tchefood_courier_cash_payment`).
A reserva e as cobranças da Point somam uma reserva só (`tchefood_point_reserved_cents`), usada pela Point,
pela reserva nova e pelo gatilho de payments.
Cobrança aprovada só deixa de reservar com o pagamento APROVADO do Mercado Pago dela ou quando a própria cobrança
é estornada pela resolução verificada (auditoria r7 P0-01). Pagamento do Mercado Pago recusado (DECLINED) com a
chave de uma cobrança só entra com a cobrança recusada, cancelada ou expirada; estornado (REFUNDED), só com a
cobrança estornada. PENDING segue como antes.

Fim da reserva: o pagamento aprovado com a chave dela a consome de vez (`consumed`); recusa na maquininha ou
desistência a libera (só quem pediu, sem PIN); reserva presa (aparelho fechou no meio, liberação sem rede) aparece
na tela da conta e o gerente libera com PIN e motivo (`tchefood_release_payment_claim_manager`, registrado). O app
repete a liberação que falhou por rede.

**Cobrança da Point em revisão só sai com o Mercado Pago.** "Conferir no Mercado Pago" (PIN de gerente + motivo,
`tchefood_authorize_point_reconcile`) faz o servidor ler a ordem e o pagamento no Mercado Pago:
- revisão manual com ordem: aprovada com todas as conferências da aprovação normal, ou recusada/cancelada/expirada/
  estornada como o Mercado Pago disser;
- envio sem resposta e sem ordem (`DISPATCH_UNKNOWN`): busca a ordem pela referência (`GET /v1/orders`); achando uma,
  segue como acima; sem ordem, o gerente pode digitar o ID da operação do comprovante, que o servidor confere
  (referência, valor, forma, autorização). Sem nada disso a cobrança continua em revisão e reservando;
- aprovada sem pagamento registrado: o app registra o pagamento com os dados do servidor, sem cobrar de novo; se o
  Mercado Pago mostra o estorno, ela vira `refunded` e libera a reserva uma vez.
Só `tchefood_resolve_point_charge` (service role, com a autorização do gerente, um registro por fim) tira uma
cobrança da revisão ou estorna uma aprovada; a consulta normal não muda mais uma cobrança em revisão. Nada é
liberado por tempo ou por declaração.

"Cancelar cobrança" na espera da Point pede PIN de gerente e motivo.

## Auditoria r6 (decisões do Will, 14/11/2026)

**Toda loja na nuvem reserva antes de cobrar.** Com ou sem Point, o aparelho ligado à nuvem pede a reserva ao
servidor (`tchefood_claim_payment`) antes de qualquer pagamento fora do Mercado Pago, sem olhar a lista de
maquininhas salva no aparelho. Sem internet, recusa ou erro: não cobra. O aparelho gera um segredo de 64 hex,
grava no aparelho antes de chamar e manda junto; o banco guarda só o sha256 (coluna que o aparelho não lê).
Liberar sem PIN (`tchefood_release_payment_claim`) e renovar (`tchefood_touch_payment_claim`) exigem esse segredo;
o UUID do operador não prova mais nada. Pagamento com a chave de uma reserva liberada é recusado (TF013).

**Prazo de atividade.** A reserva tem `active_until` (90 s, relógio do banco), renovado a cada 20 s durante a
cobrança e, depois dela, até o servidor consumir a reserva (supervisor no laço de sincronização, sobrevive a
reinício). O gerente só libera (`tchefood_release_payment_claim_manager`, PIN) depois de 5 min sem renovação
(`tchefood_claim_abandon_after`); antes disso recebe TF011 com o horário, sem gastar tentativa de PIN.

**Se o gerente liberar com o pagamento ainda no aparelho** (aparelho sem internet por mais de 6,5 min): o
aparelho tira o pagamento da conta, reabre a conta e mostra a trava "estorne na maquininha" / "devolva o dinheiro";
a trava bloqueia qualquer forma de pagamento na conta e só sai com "Estornei / devolvi" e PIN de gerente conferido
no servidor (`tchefood_authorize_claim_refunded`). O mesmo vale para pagamento recusado pelo servidor.
Maquininha que responde com outra credenciadora: a reserva é trocada no servidor (`tchefood_reclaim_payment`)
antes de registrar o comprovante.

**Total da conta.** Desconto, cancelamento de item ou retirada da taxa que deixem o saldo abaixo do reservado são
recusados (TF012).

**Mercado Pago.** `external_reference` do pagamento diferente da chave da cobrança, ou id da ordem (`ORD…`)
diferente, vai para revisão. O `order.id` numérico do `/v1/payments` é a merchant_order e não é comparado.
Recusa/cancelamento/expiração/estorno só liberam a reserva com a ordem ecoando a referência e a maquininha;
estorno na conferência exige o pagamento provando o estorno. 409 desconhecido na criação = resultado desconhecido.
A busca por referência termina no máximo em "agora"; recusa da busca tem mensagem própria.

**Ordem de publicação (janela de manutenção, caixa fechado).** Migrations e app novo vão juntos: nenhum dos dois
funciona com o outro na versão antiga.

1. **Antes das migrations, todo aparelho sobe a fila** (Nuvem sem pendências: nenhum pagamento esperando para subir).
   Pagamento sem reserva que ainda estiver na fila de um aparelho quando as migrations entrarem é recusado com TF010
   em qualquer loja (com ou sem Point): o dinheiro foi recebido e o pagamento não fica registrado.
2. Aplicar as migrations (`20261114130000_mercado_pago.sql`, `20261114140000_point_reserva.sql`, depois das de 14/11
   da main).
3. Publicar a Edge Function `point-charge`.
4. Atualizar **todos** os aparelhos para o app novo, na mesma janela.
5. Abrir o caixa.

O que acontece fora dessa ordem:
- **App antigo depois das migrations:** todo pagamento recebido sem a reserva (o app antigo não pede, ou pede pela
  função antiga) é recusado com TF010, e o dinheiro recebido fica sem registro no servidor; as chamadas de reserva
  com a assinatura antiga dão 42883 (função não existe).
- **App novo antes das migrations:** as funções de reserva não existem (42883); o caixa não cobra (falha fechada)
  até as migrations entrarem.

**Dinheiro do entregador** (`entrega-<id>`, sem reserva): o servidor só aceita esse pagamento com a entrega já
`DELIVERED` lá (`tchefood_courier_cash_payment`). Na fila do aparelho, a marcação de entregue entra antes do acerto
(a fila sobe em ordem); o acerto liga o pagamento à marcação de entregue que ainda está na fila ou recusada
(`depends_on_event_ids`), e o pagamento espera ela subir. Marcação recusada segura o pagamento até ser resolvida.

## Passo a passo para testar com uma Point Smart

1. Conta Mercado Pago da loja + aplicação em <https://www.mercadopago.com.br/developers/panel/app>
   (produto "Pagamentos presenciais"). Copie o **Access Token de produção** (`APP_USR-...`).
2. Point Smart vinculada à mesma conta e em **modo PDV**
   (`PATCH /terminals/v1/setup` com `operating_mode: "PDV"`, depois reiniciar a maquininha).
3. Descubra o `terminal_id` (ex.: `NEWLAND_N950__N950NCB123456`) em `GET /terminals/v1/list`.
4. No Supabase (SQL Editor), com o id da loja:

   ```sql
   INSERT INTO payment_provider_secrets (tenant_id, provider, access_token)
   VALUES ('<id da loja>', 'mercado_pago_point', 'APP_USR-...')
   ON CONFLICT (tenant_id, provider) DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = NOW();

   INSERT INTO pos_terminals (tenant_id, name, serial_number, acquirer, mode)
   VALUES ('<id da loja>', 'Point Smart Caixa', '<terminal_id do passo 3>', 'MERCADO_PAGO', 'TEF_POS_WIRELESS');
   ```

   O `serial_number` da maquininha Mercado Pago é o `terminal_id` da API.
5. Publique a função: `supabase functions deploy point-charge` (ela importa `server/payments/`, por isso use o
   CLI atual, que empacota arquivos fora de `supabase/functions`).
6. No app, conecte a loja à nuvem, espere a maquininha aparecer, escolha **TEF POS Sem Fio** e a Point Smart
   no fechamento da conta.

## Ainda não

- Pix pela Point (ordem `qr`), crédito parcelado e outras bandeiras (Amex, Hipercard).
- Webhook "Order (Mercado Pago)": por ora o app consulta.
- NFC-e integrada (CNPJ da credenciadora Mercado Pago no `emit-nfce`): a nota sai como pagamento não integrado.
- Taxa do cartão por adquirente (`cardFees`) para o Mercado Pago.
- Comprovante impresso na Point: a ordem vai com `no_ticket`; o comprovante da loja sai pela impressora do app.

## Regras mantidas

- Mesma `X-Idempotency-Key` para repetir criação com resultado desconhecido; nunca outra chave.
- Aprovado sem `paid_amount` vira `manual_review`. Nenhum NSU/ID é inventado: tudo vem da resposta.
- Parcelado exige `installments_cost`; crédito sempre com parcelas explícitas.
- O token do Mercado Pago fica em `payment_provider_secrets`, sem acesso para o aparelho.
