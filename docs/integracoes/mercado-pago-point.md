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
  chamada poderia passar do fim da posse). Recusa do pedido só vira "nada foi cobrado" no **primeiro**
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
- Cobrança incerta do Mercado Pago **não** entra pelo comprovante digitado: o banco recusaria. Confira no app
  do Mercado Pago; se foi cobrado, estorne lá e cobre de novo.

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
