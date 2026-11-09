# Tchê Food — SmartPOS & Comanda Mobile

SaaS de gestão para restaurantes, bares e churrascarias (seed: **Galpão Crioulo / Tchê Food**, Santo Ângelo/RS).
React 18 + TypeScript estrito + Vite + Tailwind + Zustand (persistência IndexedDB, offline-first).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 24 testes: motor financeiro, anti-fraude, rachadinha, NFC-e, QR, ESC/POS
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

6. **Compras por XML (NF-e modelo 55)** — Retaguarda › Compras / Estoque. Lê o XML do fornecedor (regras do Tchê Vendas, tudo fail-closed: sem DTD, chave com DV, modelo 55, protocolo autorizado, nota destinada ao CNPJ da casa, itens fechando com o total), sugere o produto pelo vínculo do fornecedor, EAN ou nome, sugere o fator de embalagem (CX 2 com UN 24 = 12), cria o produto fora da venda quando não existe, dá entrada no estoque e recalcula o **custo médio ponderado** (produto − desconto + frete + seguro + outras + IPI + ICMS-ST). A mesma chave nunca entra duas vezes. Botão "XML de exemplo" para testar.

## Banco de dados
`db/schema_purchases.sql` (rodar depois do `schema.sql`): `suppliers`, `purchase_invoices` (`UNIQUE (tenant_id, access_key)`), `purchase_invoice_items`, `stock_movements` (somente inserção), `supplier_product_links` e as colunas `cost_price`, `stock_quantity`, `barcode` em `products`.

`db/schema.sql` contém a modelagem do blueprint sem alterações, mais: `product_modifier_groups`, `printers`, recálculo financeiro em PL/pgSQL idêntico a `src/lib/money.ts`, travas anti-fraude (DELETE bloqueado, cancelamento/10%/desconto só com audit_log de gerente, `audit_logs` imutável), fechamento automático e RLS multi-tenant.

## O que ainda é simulado
- Stone Connect / PlugPag: sem credenciais, as cobranças caem no simulador visual (`MockTerminalDriver`). Com `window.StoneBridge`/`window.PlugPagBridge` presentes, os drivers usam o hardware.
- NFC-e: payload e DANFE gerados localmente em **homologação**; o envio à Focus NFe precisa de token, certificado e CSC reais.
- Alerta de WhatsApp: registrado (`whatsapp_alert_sent = true`) e pré-visualizado; o disparo real depende de um provedor.
- Supabase: os eventos ficam na fila `outbox` (IndexedDB) prontos para sincronizar; o cliente Supabase ainda não está ligado.
