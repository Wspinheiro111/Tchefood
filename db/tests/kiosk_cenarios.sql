\set ON_ERROR_STOP 1
\set QUIET 1
-- Cenários do pedido com senha. Rode num banco com schema.sql + schema_expansion.sql + schema_kiosk.sql.
CREATE OR REPLACE FUNCTION expect_error(p_sql TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE p_like THEN RAISE EXCEPTION 'erro inesperado: % (esperado %)', SQLERRM, p_like; END IF;
    RAISE NOTICE 'OK erro esperado: %', SQLERRM; RETURN; END;
  RAISE EXCEPTION 'esperava erro % em: %', p_like, p_sql;
END $$;
CREATE OR REPLACE FUNCTION assert(p BOOLEAN, msg TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; RAISE NOTICE 'OK %', msg; END $$;

INSERT INTO tenants (id, name, legal_name, cnpj) VALUES ('00000000-0000-4000-8000-000000000001','Galpão','Galpão LTDA','48291736000155');
INSERT INTO staff_users (id, tenant_id, name, role, pin_code) VALUES
 ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001','Totem 01','KIOSK','4444'),
 ('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-000000000001','Tião','WAITER','1111');
INSERT INTO categories (id, tenant_id, name) VALUES ('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-000000000001','Pratos');
INSERT INTO products (id, tenant_id, category_id, code, name, price, sector) VALUES
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','301','Carreteiro',46.90,'KITCHEN');
INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-000000000001',1,'Mesa 1');
INSERT INTO dining_tables (id, tenant_id, number, label, area, kind) VALUES ('00000000-0000-4000-8000-0000000000d9','00000000-0000-4000-8000-000000000001',950,'Totem','Totem','KIOSK');

-- Senha gerada pelo banco, sequencial no dia.
INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id, status, charge_service_fee, fulfillment_type, pickup_name)
VALUES ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d9','00000000-0000-4000-8000-0000000000a1','PAYING',FALSE,'TAKEOUT','Ana');
INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id, status, charge_service_fee, fulfillment_type)
VALUES ('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d9','00000000-0000-4000-8000-0000000000a1','PAYING',FALSE,'DINE_IN');
SELECT assert((SELECT pickup_number FROM orders WHERE id = '00000000-0000-4000-8000-0000000000f1') = 1, 'primeira senha do dia = 1');
SELECT assert((SELECT pickup_number FROM orders WHERE id = '00000000-0000-4000-8000-0000000000f2') = 2, 'segunda senha do dia = 2');

-- Dia seguinte em Brasília recomeça; 999 volta para 1.
SELECT assert(tchefood_next_pickup_number('00000000-0000-4000-8000-000000000001', NOW() + INTERVAL '1 day') = 1, 'outro dia recomeça em 1');
UPDATE pickup_counters SET last_number = 999 WHERE business_date = tchefood_business_date(NOW() + INTERVAL '1 day');
SELECT assert(tchefood_next_pickup_number('00000000-0000-4000-8000-000000000001', NOW() + INTERVAL '1 day') = 1, 'depois do 999 volta para 1');
SELECT assert(tchefood_business_date('2026-11-10T02:30:00Z') = DATE '2026-11-09', '23:30 de Brasília ainda é o mesmo dia');

-- Regras.
SELECT expect_error($$INSERT INTO orders (tenant_id, table_id, opened_by_user_id, status, charge_service_fee) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d9','00000000-0000-4000-8000-0000000000a1','PAYING',FALSE)$$, '%comer aqui%');
SELECT expect_error($$INSERT INTO orders (tenant_id, table_id, opened_by_user_id, status, fulfillment_type) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d9','00000000-0000-4000-8000-0000000000a1','PAYING','TAKEOUT')$$, '%10%');
SELECT expect_error($$INSERT INTO orders (tenant_id, table_id, opened_by_user_id, status, charge_service_fee, fulfillment_type) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d9','00000000-0000-4000-8000-0000000000a1','OPEN',FALSE,'TAKEOUT')$$, '%PAYING%');
SELECT expect_error($$INSERT INTO orders (tenant_id, table_id, opened_by_user_id, pickup_number) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000a2',5)$$, '%mesa KIOSK%');
SELECT expect_error($$UPDATE orders SET pickup_number = 7 WHERE id = '00000000-0000-4000-8000-0000000000f1'$$, '%não muda%');
SELECT expect_error($$INSERT INTO orders (tenant_id, table_id, opened_by_user_id, status, charge_service_fee, fulfillment_type) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d9','00000000-0000-4000-8000-0000000000a1','PAYING',FALSE,'DELIVERY')$$, '%fulfillment_type%');

-- Comanda de mesa segue igual.
INSERT INTO orders (tenant_id, table_id, opened_by_user_id) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000a2');
SELECT assert((SELECT count(*) FROM orders WHERE table_id = '00000000-0000-4000-8000-0000000000d1' AND pickup_number IS NULL) = 1, 'comanda de mesa sem senha');

-- Fechamento do pedido com senha: item, pagamento e recálculo pelas regras do schema.sql.
INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, sector, origin)
VALUES ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',1,46.90,'KITCHEN','KIOSK');
SELECT assert((SELECT total_amount FROM orders WHERE id = '00000000-0000-4000-8000-0000000000f1') = 46.90, 'total sem 10%');
SELECT 'kiosk_cenarios OK';
