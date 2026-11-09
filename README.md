# Tchê Food — SmartPOS & Comanda Mobile

SaaS de gestão para restaurantes, bares e churrascarias (seed: **Galpão Crioulo / Tchê Food**, Santo Ângelo/RS).
React 18 + TypeScript estrito + Vite + Tailwind + Zustand (persistência IndexedDB, offline-first).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 157 testes: motor financeiro, anti-fraude, rachadinha, NFC-e, QR, ESC/POS, maquininhas, Stone Connect, Fase 5, delivery iFood
npm run build
```

## PINs de demonstração
| PIN | Perfil | Entra em |
|-----|--------|----------|
| 1111 / 2222 / 3333 | Garçom | Mapa de mesas, QR Cliente |
| 7777 | Cozinha | KDS |
| 5555 | Caixa | Mesas, Pedido no Caixa, Retaguarda |
| 9999 | Gerente (autoriza cancelamentos, 10% e descontos) | Tudo |
| 8888 | Proprietário | Tudo |
| 4444 | Totem (aparelho do cliente) | Tela do totem; sair = 5 toques no logo + PIN de gerente |

## Fases entregues
1. **Comanda do garçom** — login por PIN, mapa de mesas (Salão/Deck/Parrilla), abertura de mesa, lançamento por código rápido (101, 201…), Ponto da Carne obrigatório, adicionais, meio-a-meio (maior valor ou média), tags de 1 toque, bandeja de despacho com alerta sonoro, extrato de conferência.
   **Anti-fraude:** item despachado nunca é apagado; cancelar, remover os 10% ou dar desconto exige PIN de gerente + motivo e grava `audit_logs`. 3 PINs errados bloqueiam por 60s e também ficam auditados.
2. **Fechamento** — rachadinha por pessoa, valor livre e por item consumido (10% proporcional, `is_paid`), HAL `IPaymentTerminalDriver` (`StonePosDriver`, `PagBankPlugPagDriver`, `MockTerminalDriver`), TEF POS Sem Fio por serial ou SmartPOS embarcado com chassi Stone/PagBank, NFC/chip/senha/Pix com BR Code real, bobina 58mm animada. Saldo 0,00 → conta `CLOSED`, mesa `FREE`.
3. **KDS multi-praça** com SLA verde/amarelo/vermelho piscante e **Cardápio QR Code** do cliente (`origin = 'QRCODE_TABLE'`, pedir a conta).
4. **Retaguarda** — KPIs do turno, conciliação Stone × PagBank × Caixa por método, rateio exato dos 10% por garçom, central anti-fraude com prévia do alerta de WhatsApp, **NFC-e modelo 65** (payload Focus NFe, chave de 44 dígitos com DV, protocolo, QR Code SEFAZ-RS v2, tributos Lei 12.741) e DANFE 58mm.
5. **Impressão ESC/POS universal** (58mm/32 col e 80mm/48 col) — cadastro de impressoras por praça, `UniversalEscPosBuilder`, roteamento automático no despacho, simulador lado a lado e ponte Android em `android/SmartPosJsBridge.java`.

6. **Regras de maquininha do Tchê Vendas** (mesmo autor) — aprovado só com prova completa (código `0000`, NSU, autorização, serial e valor batendo); resultado incerto vira **revisão manual** e trava nova cobrança em maquininha até o operador conferir o extrato; o sistema nunca inventa NSU/autorização; idempotência por `request_id`; comandos PlugPag serializados com `isServiceBusy()` (`src/lib/payments/terminalGuard.ts`, `android/PlugPagJsBridge.java`). Impressão de cozinha com ledger `STARTED/COMPLETE` (não reimprime sozinho se o resultado for incerto) e QR Code da NFC-e validado contra a chave de acesso.
7. **Stone Connect 2.0 (servidor)** — `server/payments/stoneConnect.ts`, cliente do Pagar.me v5 portado do Tchê Vendas com testes. Guia completo e documentação oficial em `docs/integracoes/stone/`. Roda em servidor porque a Secret Key da loja nunca vai para o navegador.

8. **Fase 5 — Balcão, buffet, chopp e cashback**
   - **⚡ Ficha Rápida (Balcão & Eventos):** vende sem abrir mesa (mesa técnica `COUNTER`, sem os 10%), cobra na SmartPOS Stone/PagBank ou em dinheiro e só então imprime **uma ficha destacável por unidade** (nome em fonte gigante, data/hora, QR Code com token antifraude de 16 caracteres e dígito verificador). A aba *Validar retirada* aceita cada ficha uma única vez (“FICHA JÁ USADA às 21:14”); o item só conta como entregue quando todas as fichas dele são retiradas. Venda não paga só é cancelada com PIN de gerente.
   - **⚖️ Buffet a Quilo:** botão na comanda, leitura de balança Toledo/Filizola (protocolo ENQ/STX…ETX pela Web Serial, ou simulador), tara por recipiente, preço do quilo vindo do cadastro (nunca do aparelho). Peso digitado fica marcado como `MANUAL`.
   - **🍺 Monitor de barris:** cada chopp vendido baixa o nível pelo volume do tamanho (300/500 ml/1 L); cancelado antes de servir volta, depois de servir vira desperdício. Leitura real do barril gera o **Índice de Aproveitamento** e alerta vermelho quando o volume real diverge do faturado. Troca de barril com PIN de gerente e histórico. Tela *Chopp* (bar/caixa/gerência) e aba na Retaguarda.
   - **🎁 CRM de cashback:** após o pagamento aprovado, WhatsApp do cliente com opt-in (LGPD), 5% sobre o consumo sem os 10%, válido do dia seguinte por 30 dias, resgate só de terça a quinta em até 50% da conta. Prévia da mensagem automática com o link da NFC-e e botão *Enviar no WhatsApp* (wa.me). Aba *Clientes & Cashback* na Retaguarda.
9. **Pedidos de delivery** — caixa de entrada única para apps de delivery com interface comum (`server/delivery/`). **iFood** (Merchant API) pronto e rodando contra um iFood simulado; tela **Delivery** para aceitar, preparar, marcar pronto, despachar e cancelar. 99Food, Keeta (Open Delivery), Delivery Much, Aiqfome, Anota AI e Rappi já estão no catálogo, aguardando credenciais/parceria. Guia em `docs/integracoes/delivery/`.
10. **Painel de senhas na TV** — aba **Painel TV**: colunas "Preparando" e "Pronto" no estilo fast-food, com pedidos de delivery/retirada (número do app + primeiro nome) e pedidos feitos pelo QR da mesa. Quando um pedido fica pronto, o número pisca, toca o sinal e a TV fala o número (voz do navegador, dá para desligar). Botão de tela cheia. Não mostra telefone, endereço nem valores.
11. **Totem de autoatendimento e pedido no caixa (pedido com senha)**
   - **Totem (PIN 4444):** tela própria para o cliente, sem o menu da equipe. Toque para pedir → *Comer aqui* ou *Para levar* → cardápio por categoria com fotos de categoria, opções (ponto da carne, adicionais, meio a meio, observações) → revisão do pedido com teclado na tela para o nome → pagamento em **Crédito, Débito ou Pix na SmartPOS Stone/PagBank** ao lado do totem, ou **Pagar no caixa**. Sai a **senha do dia** (001, 002…, reinicia à meia-noite de Brasília) no comprovante. Inatividade de 90 s pergunta "Ainda está aí?" e volta ao início. Sair do totem: 5 toques no logo em 3 s + PIN de gerente (fica no `audit_logs`).
   - **Pedido no Caixa (Caixa/Gerente/Dono):** a atendente monta o pedido no balcão, escolhe comer aqui/para levar, cobra em cartão, Pix ou dinheiro (com troco) e entrega a senha. Na mesma tela ficam as **senhas do totem aguardando pagamento** e o andamento das senhas de hoje (Preparando / Pronto / Entregue). Senha não paga só é cancelada com PIN de gerente.
   - **Cozinha e TV:** o pedido só entra no **KDS** depois de pago, com a SENHA no lugar da mesa ("Para levar · João", selo Totem/Caixa) e botão *Entregue no Balcão*; o ticket das praças sai com `SENHA 042` em fonte gigante. O **Painel TV** mostra a senha em *Preparando* e passa para *Pronto* quando a cozinha termina, falando "Senha 42".
   - **Regras de dinheiro:** mesa técnica `KIOSK` (fora do mapa), sem os 10% do garçom, preço sempre do cadastro, mesmas travas de maquininha da mesa (cobrança em andamento trava a conta, resultado incerto vira conferência manual e o totem manda o cliente ao caixa sem cobrar de novo, NSU nunca inventado). Fecha com NFC-e como qualquer conta.

## Banco de dados
`db/schema.sql` contém a modelagem do blueprint sem alterações, mais: `product_modifier_groups`, `printers`, recálculo financeiro em PL/pgSQL idêntico a `src/lib/money.ts`, travas anti-fraude (DELETE bloqueado, cancelamento/10%/desconto só com audit_log de gerente, `audit_logs` imutável), fechamento automático e RLS multi-tenant.

`db/schema_expansion.sql` (aplicar depois do `schema.sql`, idempotente) traz a Fase 5: venda por peso, barris (`keg_taps`, `keg_tap_products`, `keg_history`), fichas (`event_tickets` + `tchefood_redeem_ticket`), fidelidade (`loyalty_customers`, `cashback_ledger`, `tchefood_redeem_cashback`). O cabeçalho do arquivo lista as correções feitas sobre o rascunho original. Os cenários estão em `db/tests/fase5_cenarios.sql`.

`db/schema_kiosk.sql` (aplicar depois do `schema_expansion.sql`, idempotente) traz o totem: papel `KIOSK`, mesa técnica `KIOSK`, colunas `orders.pickup_number`, `pickup_name`, `fulfillment_type`, contador `pickup_counters` (senha gerada pelo banco com trava de linha, sem repetir entre dois totens) e gatilho com as regras do pedido com senha. Cenários em `db/tests/kiosk_cenarios.sql`.

## O que ainda é simulado
- Stone Connect / PlugPag: sem credenciais, as cobranças caem no simulador visual (`MockTerminalDriver`). Com `window.StoneBridge`/`window.PlugPagBridge` presentes, os drivers usam o hardware. O cliente Stone Connect 2.0 está pronto em `server/`, mas falta o servidor (rotas de cobrança e webhook) e a credencial de parceiro.
- NFC-e: payload e DANFE gerados localmente em **homologação**; o envio à Focus NFe precisa de token, certificado e CSC reais.
- Balança: a leitura pela Web Serial segue o protocolo Toledo/Filizola, mas não foi testada numa balança física; sem cabo, use o simulador ou o peso digitado.
- Barril: a leitura real é digitada (balança de barril ou medidor de vazão); não há integração com medidor físico.
- Fichas: o QR Code sai no simulador de bobina; na impressora real o comando de QR do ESC/POS ainda precisa ser ligado ao layout da ficha.
- Cashback no WhatsApp: a mensagem abre pronta pelo link wa.me; o envio automático depende de um provedor da API oficial.
- Alerta de WhatsApp: registrado (`whatsapp_alert_sent = true`) e pré-visualizado; o disparo real depende de um provedor.
- Delivery: o iFood da tela Delivery é simulado no navegador. Falta o servidor que roda o polling com as credenciais reais e grava em `delivery_orders`, e os pedidos de delivery ainda não descem para o KDS nem geram NFC-e.
- Totem: a senha é numerada no próprio aparelho enquanto o Supabase não está ligado; com dois totens offline ao mesmo tempo a senha pode repetir até sincronizar (no banco ela é gerada por `pickup_counters`). A maquininha do totem usa o mesmo simulador da SmartPOS; falta testar com Stone/PagBank físicos ao lado do totem e o modo quiosque do Android/Windows.
- Supabase: os eventos ficam na fila `outbox` (IndexedDB) prontos para sincronizar; o cliente Supabase ainda não está ligado.
