# Tchê Food — SmartPOS & Comanda Mobile

SaaS de gestão para restaurantes, bares e churrascarias (seed: **Galpão Crioulo / Tchê Food**, Santo Ângelo/RS).
React 18 + TypeScript estrito + Vite + Tailwind + Zustand (persistência IndexedDB, offline-first).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 109 testes: motor financeiro, anti-fraude, rachadinha, NFC-e, QR, ESC/POS, maquininhas, Stone Connect
npm run build
```

## PINs de demonstração
| PIN | Perfil | Entra em |
|-----|--------|----------|
| 1111 / 2222 / 3333 | Garçom | Mapa de mesas, QR Cliente |
| 7777 | Cozinha | KDS |
| 5555 | Caixa | Mesas, Retaguarda |
| 9999 | Gerente (autoriza cancelamentos, 10% e descontos) | Tudo |
| 8888 | Proprietário | Tudo |

## Fases entregues
1. **Comanda do garçom** — login por PIN, mapa de mesas (Salão/Deck/Parrilla), abertura de mesa, lançamento por código rápido (101, 201…), Ponto da Carne obrigatório, adicionais, meio-a-meio (maior valor ou média), tags de 1 toque, bandeja de despacho com alerta sonoro, extrato de conferência.
   **Anti-fraude:** item despachado nunca é apagado; cancelar, remover os 10% ou dar desconto exige PIN de gerente + motivo e grava `audit_logs`. 3 PINs errados bloqueiam por 60s e também ficam auditados.
2. **Fechamento** — rachadinha por pessoa, valor livre e por item consumido (10% proporcional, `is_paid`), HAL `IPaymentTerminalDriver` (`StonePosDriver`, `PagBankPlugPagDriver`, `MockTerminalDriver`), TEF POS Sem Fio por serial ou SmartPOS embarcado com chassi Stone/PagBank, NFC/chip/senha/Pix com BR Code real, bobina 58mm animada. Saldo 0,00 → conta `CLOSED`, mesa `FREE`.
3. **KDS multi-praça** com SLA verde/amarelo/vermelho piscante e **Cardápio QR Code** do cliente (`origin = 'QRCODE_TABLE'`, pedir a conta).
4. **Retaguarda** — KPIs do turno, conciliação Stone × PagBank × Caixa por método, rateio exato dos 10% por garçom, central anti-fraude com prévia do alerta de WhatsApp, **NFC-e modelo 65** (payload Focus NFe, chave de 44 dígitos com DV, protocolo, QR Code SEFAZ-RS v2, tributos Lei 12.741) e DANFE 58mm.
5. **Impressão ESC/POS universal** (58mm/32 col e 80mm/48 col) — cadastro de impressoras por praça, `UniversalEscPosBuilder`, roteamento automático no despacho, simulador lado a lado e ponte Android em `android/SmartPosJsBridge.java`.

6. **Regras de maquininha do Tchê Vendas** (mesmo autor) — aprovado só com prova completa (código `0000`, NSU, autorização, serial e valor batendo); resultado incerto vira **revisão manual** e trava nova cobrança em maquininha até o operador conferir o extrato; o sistema nunca inventa NSU/autorização; idempotência por `request_id`; comandos PlugPag serializados com `isServiceBusy()` (`src/lib/payments/terminalGuard.ts`, `android/PlugPagJsBridge.java`). Impressão de cozinha com ledger `STARTED/COMPLETE` (não reimprime sozinho se o resultado for incerto) e QR Code da NFC-e validado contra a chave de acesso.
7. **Stone Connect 2.0 (servidor)** — `server/payments/stoneConnect.ts`, cliente do Pagar.me v5 portado do Tchê Vendas com testes. Guia completo e documentação oficial em `docs/integracoes/stone/`. Roda em servidor porque a Secret Key da loja nunca vai para o navegador.
8. **Emissão real de NFC-e (Supabase Edge Function + Focus NFe)** — `supabase/functions/emit-nfce`, regras portadas do Tchê Vendas. Detalhes abaixo.

9. **Etapa 0 — Fundação: cadastros na tela e nuvem** (Retaguarda → Cardápio, Salão, Equipe, Loja, Nuvem). Detalhes abaixo.

## Etapa 0: cadastros na tela e sincronização
**Cardápio** — categorias, produtos (código único, preço com 2 casas, NCM/CFOP/CSOSN validados), grupos de adicionais e opções, vínculo produto ↔ adicionais em ordem, **preço por dia/horário** (happy hour; janela que vira a meia-noite; duas regras do mesmo produto não podem se sobrepor) e **esgotado** em um toque, também no KDS para a cozinha.
- O preço da bandeja é recalculado no store a partir do cardápio (regra de horário + meio a meio). O valor que a tela manda é ignorado.
- Trocar preço grava `PRODUCT_PRICE_CHANGED` na auditoria e não muda item já lançado (o `order_items.unit_price` fica como foi vendido).
- Produto e mesa nunca são apagados: são desativados e somem da venda e do mapa. Mesa com conta aberta não desativa (também no banco, por trigger).

**Equipe** — PIN de 4 dígitos, único e não trivial. Trocar o PIN de outra pessoa, mudar perfil, desativar ou reativar pede PIN de gerente + motivo e grava `STAFF_*` na auditoria; o PIN nunca vai para o log. Gerente não mexe em gerente/proprietário; ninguém desativa a si mesmo; a loja nunca fica sem proprietário ativo.

**Loja** — dados cadastrais (CNPJ com dígito verificador, UF, taxa de serviço 0–20% com 2 casas). **Permissões por perfil** (`role_permissions` guarda só as exceções ao padrão de `src/lib/permissions.ts`; o proprietário pode tudo e só ele muda permissões, com PIN e motivo). **Iniciar loja nova** tira o aparelho da demonstração: exige o PIN do proprietário, nenhuma conta aberta e a fila vazia se já houver nuvem. As maquininhas cadastradas no aparelho continuam, com id novo, e sobem para a nuvem antes de qualquer pagamento. Ainda não há tela para cadastrar maquininha: o número de série é único no banco, então os seriais de demonstração (STONE-01…) só servem para uma loja na nuvem.

**Nuvem** — o aparelho entra com uma conta do Supabase Auth (e-mail e senha) e a fila `outbox` sobe sozinha a cada 5 s quando há internet (`src/lib/sync/`):
- Envio em ordem, um evento por vez. O `audit_log` de cancelamento, remoção dos 10% ou desconto sobe **antes** da mudança que ele autoriza (as travas do banco exigem a autorização já gravada). A janela de 5 minutos dessas travas conta de `audit_logs.received_at`, a hora em que o servidor recebeu, para um desconto dado sem internet ainda subir horas depois. `payments` e `audit_logs` são só INSERT (`ignore-duplicates`); o resto é upsert pelo id. DELETE só existe para vínculo produto ↔ adicional e opção de adicional.
- Erro de rede, 5xx e 401 ficam para depois (401 renova o token). 4xx **para a fila** naquele evento e mostra o motivo na aba Nuvem; nada é descartado sozinho.
- Token da Focus e CSC nunca sobem do aparelho; um trigger no banco também impede o app de trocá-los. `nfce_status` e `nfce_key` da comanda também não sobem: a NFC-e do aparelho é simulação e a situação real vem da `emit-nfce`.

Configuração:
```bash
supabase db push    # aplica supabase/migrations/20261109070000_etapa0_cadastros.sql
```
1. No painel do Supabase: Authentication → Hooks → **Custom Access Token** → `public.tchefood_access_token_hook`. Ele copia `app_metadata.tenant_id` para a claim `tenant_id` que o RLS (`tchefood_tenant()`) lê.
2. Crie a linha da loja em `tenants` e uma conta de usuário para o aparelho com `app_metadata = {"tenant_id": "<id da loja>"}` (pelo painel ou pela API admin; o app não cria lojas na nuvem).
3. Build com `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (ou digite os dois na aba Nuvem).
4. No aparelho: Retaguarda → Nuvem → entrar. Se a conta for de outra loja que a deste aparelho (ex.: ainda na demonstração), a própria tela oferece começar a loja da conta.

Limites conhecidos desta etapa: a sincronização é **só de envio** (um aparelho novo ainda não baixa o cardápio da nuvem) e, fora das tabelas imutáveis, conflito entre dois aparelhos é "o último que gravou vale". **Combos** ficam para o próximo PR da Etapa 0.

## NFC-e real: `supabase/functions/emit-nfce`
```bash
supabase db push                                   # aplica supabase/migrations (tabela nfce_documents)
supabase secrets set FOCUS_AMBIENTE=homologacao    # "producao" (exato) liga produção
supabase functions deploy emit-nfce
```
`POST /functions/v1/emit-nfce` com o JWT do app (claim `tenant_id`) e corpo `{ "order_id": "<uuid>" }`.
- O corpo só traz o `order_id`. Itens, valores, pagamentos e o token Focus (`tenants.focus_nfe_token`) são lidos do banco; o cliente não altera o valor da nota nem vê o token. A comanda só é encontrada se o RLS do chamador permitir.
- Um documento por comanda (`nfce_documents`, referência `tchefood<uuid>`). Reserva atômica antes do POST: duas abas não emitem duas vezes. Autorizada/cancelada → devolve o que está gravado; em processamento/contingência → só consulta (GET).
- `authorized: true` somente com chave + protocolo da SEFAZ. Falha de rede/timeout fica `processing` (HTTP 202) e a próxima chamada consulta a mesma referência; nunca vira "contingência" ou "sucesso" inventados. Contingência offline da Focus aparece como `contingency` até ser efetivada.
- Taxa de serviço em `valor_outras_despesas` e desconto em `valor_desconto`, rateados por item; qualquer divergência de centavo entre itens, total e pagamentos bloqueia a emissão (HTTP 422) sem chamar a Focus.
- `tipo_integracao: 1` só com prova da maquininha (CNPJ da credenciadora Stone/PagBank coerente com o adquirente do pagamento + código de autorização); sem prova, `2`. Pix da maquininha sai `2`, como no Tchê Vendas.
- Banco: transições inválidas (ex.: autorizada → rejeitada), DELETE e alteração de nota autorizada são barrados por trigger.

## Banco de dados
`db/schema.sql` contém a modelagem do blueprint sem alterações, mais: `product_modifier_groups`, `printers`, recálculo financeiro em PL/pgSQL idêntico a `src/lib/money.ts`, travas anti-fraude (DELETE bloqueado, cancelamento/10%/desconto só com audit_log de gerente, `audit_logs` imutável), fechamento automático e RLS multi-tenant.

## O que ainda é simulado
- Stone Connect / PlugPag: sem credenciais, as cobranças caem no simulador visual (`MockTerminalDriver`). Com `window.StoneBridge`/`window.PlugPagBridge` presentes, os drivers usam o hardware. O cliente Stone Connect 2.0 está pronto em `server/`, mas falta o servidor (rotas de cobrança e webhook) e a credencial de parceiro.
- NFC-e: o app ainda gera payload e DANFE localmente em **homologação**; a emissão real está pronta em `supabase/functions/emit-nfce`, mas as telas ainda não chamam a função e ela precisa do token Focus, certificado A1 e CSC cadastrados na Focus.
- Alerta de WhatsApp: registrado (`whatsapp_alert_sent = true`) e pré-visualizado; o disparo real depende de um provedor.
- Supabase: a fila `outbox` sobe para o Supabase depois que o aparelho entra na aba Nuvem; sem conta conectada, os eventos ficam no IndexedDB. Ainda não há download (pull) da nuvem para um aparelho novo.
