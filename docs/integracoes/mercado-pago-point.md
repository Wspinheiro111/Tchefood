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
  (crédito à vista ou débito), autorização e bandeira (Visa, Master ou Elo). Qualquer diferença vira revisão
  manual.
- Sem cartão em 2 minutos o app pede o cancelamento na maquininha. Só vira "recusado" quando o Mercado Pago
  confirma cancelada; senão vira revisão manual.
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
