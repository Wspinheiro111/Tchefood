-- Cópia de db/schema_cartao.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- Tchê Food — Comanda por cartão numerado
-- Rodar depois de db/schema_kiosk.sql (que cria a coluna kind com TABLE, COUNTER e KIOSK).
--
--  1. Mesa com kind CARD é um cartão de comanda: o cliente anda com ele e a conta
--     funciona igual à de uma mesa (lança, fecha, rachadinha).
--  2. A numeração dos cartões é separada da das mesas: o cartão 12 e a mesa 12
--     convivem. Dois cartões com o mesmo número na loja, não.
--  3. Cartão não tem QR Code de autoatendimento (o pedido é sempre do garçom ou do caixa).
-- =============================================================================

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_kind_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_kind_check CHECK (kind IN ('TABLE', 'COUNTER', 'KIOSK', 'CARD'));

-- Número único por loja, separado entre cartões e o resto (mesas e mesas técnicas).
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_tenant_id_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dining_tables_number ON dining_tables(tenant_id, number) WHERE kind <> 'CARD';
CREATE UNIQUE INDEX IF NOT EXISTS uq_dining_tables_card_number ON dining_tables(tenant_id, number) WHERE kind = 'CARD';

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_card_no_qr_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_card_no_qr_check CHECK (kind <> 'CARD' OR qr_code_token IS NULL);
