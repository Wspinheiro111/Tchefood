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
  Pago (recusada, cancelada, expirada, estornada) ou com o encerramento autorizado por gerente. Antes de cobrar o
  app sobe a fila (com prazo de 15 s); conta que ainda não subiu é recusada antes de chegar à maquininha.
- Sem cartão em 2 minutos (contados desde o primeiro envio) o app **encerra a tentativa**: pede à maquininha que
  pare de esperar o cartão. Não é estorno: cobrança já paga continua paga e volta como aprovada. O servidor só
  aceita o encerramento por prazo depois de 90 s da cobrança gravada (relógio do servidor) e repete o pedido até lá.
  Só vira "recusado" quando o Mercado Pago confirma cancelada; senão vira revisão manual.
- Encerrar **antes do prazo** a pedido do operador exige **PIN de gerente** e motivo (5+ letras), conferidos no banco
  (`tchefood_authorize_point_cancel`, mesmas regras de `tchefood_authorize_manager`: 3 PINs errados em 60 s
  bloqueiam). Fica um registro `POINT_CHARGE_CANCELED` em `audit_logs` e a cobrança guarda operador, gerente e
  registro; o banco recusa encerramento "pelo operador" sem gerente. O pedido também confere conta, valor e forma.
  Cobrança que foi à nuvem e nunca ganhou ordem só é liberada assim, depois de 2 min do envio (`manager_released`).
- Consulta e encerramento **nunca** mandam cobrança nova à maquininha: só a criação manda, uma vez por chave
  (`dispatched_at` gravado antes do envio; reenvio só com a mesma chave e sem pedido de encerramento).
- Criação sem resposta (queda, prazo de 15 s por chamada estourado, erro 5xx): nem "cobrança não encontrada" nem
  outra recusa provam que nada foi cobrado, porque a primeira criação pode estar a caminho. Quem decide é o
  encerramento no servidor: sem cobrança gravada, ele grava o bloqueio da chave (`voided_before_send`) e a criação
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
