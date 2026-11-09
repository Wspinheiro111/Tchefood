# Tchê Food — SmartPOS & Comanda Mobile

SaaS de gestão para restaurantes, bares e churrascarias (seed: **Galpão Crioulo / Tchê Food**, Santo Ângelo/RS).
React 18 + TypeScript estrito + Vite + Tailwind + Zustand (persistência IndexedDB, offline-first).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 110 testes: motor financeiro, anti-fraude, rachadinha, NFC-e, QR, ESC/POS, maquininhas, Stone Connect, delivery iFood
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

8. **Pedidos de delivery** — caixa de entrada única para apps de delivery com interface comum (`server/delivery/`). **iFood** (Merchant API) pronto e rodando contra um iFood simulado; tela **Delivery** para aceitar, preparar, marcar pronto, despachar e cancelar. 99Food, Keeta (Open Delivery), Delivery Much, Aiqfome, Anota AI e Rappi já estão no catálogo, aguardando credenciais/parceria. Guia em `docs/integracoes/delivery/`.

## Banco de dados
`db/schema.sql` contém a modelagem do blueprint sem alterações, mais: `product_modifier_groups`, `printers`, recálculo financeiro em PL/pgSQL idêntico a `src/lib/money.ts`, travas anti-fraude (DELETE bloqueado, cancelamento/10%/desconto só com audit_log de gerente, `audit_logs` imutável), fechamento automático e RLS multi-tenant.

## O que ainda é simulado
- Stone Connect / PlugPag: sem credenciais, as cobranças caem no simulador visual (`MockTerminalDriver`). Com `window.StoneBridge`/`window.PlugPagBridge` presentes, os drivers usam o hardware. O cliente Stone Connect 2.0 está pronto em `server/`, mas falta o servidor (rotas de cobrança e webhook) e a credencial de parceiro.
- NFC-e: payload e DANFE gerados localmente em **homologação**; o envio à Focus NFe precisa de token, certificado e CSC reais.
- Alerta de WhatsApp: registrado (`whatsapp_alert_sent = true`) e pré-visualizado; o disparo real depende de um provedor.
- Delivery: o iFood da tela Delivery é simulado no navegador. Falta o servidor que roda o polling com as credenciais reais e grava em `delivery_orders`, e os pedidos de delivery ainda não descem para o KDS nem geram NFC-e.
- Supabase: os eventos ficam na fila `outbox` (IndexedDB) prontos para sincronizar; o cliente Supabase ainda não está ligado.
