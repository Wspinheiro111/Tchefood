\set ON_ERROR_STOP 1
\set QUIET 1
-- helper: espera erro
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
 ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001','Tião','WAITER','1111'),
 ('00000000-0000-4000-8000-0000000000a9','00000000-0000-4000-8000-000000000001','Rafa','MANAGER','9999');
INSERT INTO categories (id, tenant_id, name) VALUES ('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-000000000001','Chopps');
INSERT INTO products (id, tenant_id, category_id, code, name, price, sector) VALUES
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','201','Chopp Pilsen',12.90,'BAR'),
 ('00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','313','Pastel',34.90,'KITCHEN');
SELECT expect_error($$INSERT INTO products (tenant_id, category_id, code, name, price, sold_by_weight) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','900','Buffet',79.90,TRUE)$$, '%products_weight_unit_check%');
INSERT INTO products (id, tenant_id, category_id, code, name, price, sector, sold_by_weight, tare_weight_grams, unit) VALUES
 ('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','900','Buffet a Quilo',79.90,'NONE',TRUE,280,'KG');

INSERT INTO dining_tables (id, tenant_id, number, label) VALUES ('00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-000000000001',1,'Mesa 1');
INSERT INTO dining_tables (id, tenant_id, number, label, area, kind) VALUES ('00000000-0000-4000-8000-0000000000d0','00000000-0000-4000-8000-000000000001',999,'Balcão','Balcão & Eventos','COUNTER');

INSERT INTO keg_taps (id, tenant_id, tap_number, beer_name, tapped_at) VALUES ('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-000000000001',1,'Pilsen 50L', NOW() - INTERVAL '1 hour');
INSERT INTO keg_tap_products (tap_id, product_id, pour_ml) VALUES ('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000b1',300);
SELECT expect_error($$INSERT INTO keg_taps (tenant_id, tap_number, beer_name) VALUES ('00000000-0000-4000-8000-000000000001',2,'IPA'); INSERT INTO keg_tap_products (tap_id, product_id) SELECT id, '00000000-0000-4000-8000-0000000000b1' FROM keg_taps WHERE tap_number=2$$, '%keg_tap_products_product_id_key%');

-- MESA: chopp
INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000a1');
INSERT INTO order_items (id, order_id, product_id, waiter_id, quantity, unit_price, modifiers_unit_price, total_item_price, sector, keg_volume_ml) VALUES
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',2,12.90,6,0,'BAR',500);
INSERT INTO order_items (id, order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector) VALUES
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',3,12.90,0,'BAR');
SELECT assert((SELECT keg_volume_ml FROM order_items WHERE id='00000000-0000-4000-8000-000000000102') = 300, 'volume padrão da torneira aplicado');
SELECT assert((SELECT billed_volume_ml FROM keg_taps WHERE tap_number=1) = 1900, 'faturado 2x500 + 3x300 = 1900');
SELECT assert((SELECT remaining_volume_ml FROM keg_taps WHERE tap_number=1) = 48100, 'restante gerado 48100');

-- cancelar PENDENTE devolve ao barril
BEGIN;
UPDATE order_items SET status='CANCELED', cancel_reason='Cliente desistiu', canceled_by_user_id='00000000-0000-4000-8000-0000000000a1', canceled_at=NOW() WHERE id='00000000-0000-4000-8000-000000000102';
INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000a9','ITEM_CANCELED','Cliente desistiu', jsonb_build_object('item_id','00000000-0000-4000-8000-000000000102'));
COMMIT;
SELECT assert((SELECT billed_volume_ml FROM keg_taps WHERE tap_number=1) = 1000 AND (SELECT wasted_foam_ml FROM keg_taps WHERE tap_number=1) = 0, 'cancelado pendente volta ao barril');
-- cancelar ENTREGUE vira desperdício
UPDATE order_items SET status='DELIVERED' WHERE id='00000000-0000-4000-8000-000000000101';
BEGIN;
UPDATE order_items SET status='CANCELED', cancel_reason='Chopp quente', canceled_by_user_id='00000000-0000-4000-8000-0000000000a1', canceled_at=NOW() WHERE id='00000000-0000-4000-8000-000000000101';
INSERT INTO audit_logs (tenant_id, order_id, performed_by_user_id, authorized_by_manager_id, action_type, reason, metadata) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000a9','ITEM_CANCELED','Chopp quente', jsonb_build_object('item_id','00000000-0000-4000-8000-000000000101'));
COMMIT;
SELECT assert((SELECT billed_volume_ml FROM keg_taps WHERE tap_number=1) = 0 AND (SELECT wasted_foam_ml FROM keg_taps WHERE tap_number=1) = 1000, 'cancelado servido vira desperdício');

-- BALANÇA
INSERT INTO order_items (id, order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector, weight_gross_grams, weight_tare_grams, weight_source) VALUES
 ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000a1',9,1.00,0,'NONE',645,280,'SCALE');
SELECT assert((SELECT quantity = 0.365 AND unit_price = 79.90 AND total_item_price = 29.16 FROM order_items WHERE id='00000000-0000-4000-8000-000000000103'), 'peso 645-280g = 0,365 kg x 79,90 = 29,16 (preço forjado ignorado)');
SELECT expect_error($$INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector) VALUES ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000a1',1,79.90,0,'NONE')$$, '%TCHEFOOD_BALANCA%');
SELECT expect_error($$INSERT INTO order_items (order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector, weight_gross_grams, weight_tare_grams, weight_source) VALUES ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',1,12.9,0,'BAR',500,0,'SCALE')$$, '%não é vendido por peso%');
SELECT assert((SELECT subtotal_items FROM orders WHERE id='00000000-0000-4000-8000-0000000000f1') = 29.16, 'recalc da comanda com item pesado');

-- BALCÃO: venda + fichas
INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id, charge_service_fee, status) VALUES ('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d0','00000000-0000-4000-8000-0000000000a1',FALSE,'PAYING');
INSERT INTO order_items (id, order_id, product_id, waiter_id, quantity, unit_price, total_item_price, sector, origin) VALUES
 ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',3,12.90,0,'BAR','SMARTPOS'),
 ('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000a1',2,34.90,0,'KITCHEN','SMARTPOS');
SELECT expect_error($$INSERT INTO event_tickets (tenant_id, order_id, order_item_id, product_id, product_name_snapshot, unit_price, ticket_seq, barcode_token) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-0000000000b1','Chopp',12.90,1,'ABCDEFGHJK123450')$$, '%depois da venda paga%');
INSERT INTO payments (id, order_id, tenant_id, waiter_id, amount, method, acquirer, idempotency_key) VALUES ('00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1',108.50,'CREDIT','STONE','k1');
SELECT assert((SELECT status FROM orders WHERE id='00000000-0000-4000-8000-0000000000f2') = 'CLOSED', 'venda de balcão fechou (108,50 sem 10%)');
SELECT assert((SELECT status FROM dining_tables WHERE kind='COUNTER') = 'FREE', 'mesa técnica do balcão continua livre');
INSERT INTO event_tickets (tenant_id, order_id, order_item_id, payment_id, product_id, product_name_snapshot, unit_price, ticket_seq, barcode_token)
SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-0000000000b1','Chopp Pilsen',12.90,g,'CHAPP000000000' || g || 'X' FROM generate_series(1,3) g;
SELECT expect_error($$INSERT INTO event_tickets (tenant_id, order_id, order_item_id, product_id, product_name_snapshot, unit_price, ticket_seq, barcode_token) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-0000000000b1','Chopp',12.90,4,'CHAPP0000000004X')$$, '%no máximo%');
SELECT expect_error($$INSERT INTO event_tickets (tenant_id, order_id, order_item_id, product_id, product_name_snapshot, unit_price, ticket_seq, barcode_token) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-0000000000b3','Pastel',1.00,1,'PASTE0000000001X')$$, '%valor da ficha%');
SELECT (tchefood_redeem_ticket('chapp0000000001x','00000000-0000-4000-8000-0000000000a1')).redeemed;
SELECT expect_error($$SELECT tchefood_redeem_ticket('CHAPP0000000001X','00000000-0000-4000-8000-0000000000a1')$$, '%já resgatada%');
SELECT expect_error($$SELECT tchefood_redeem_ticket('ZZZZZ0000000001X','00000000-0000-4000-8000-0000000000a1')$$, '%não existe%');
SELECT expect_error($$DELETE FROM event_tickets$$, '%não pode ser apagada%');
SELECT expect_error($$UPDATE event_tickets SET redeemed=FALSE, redeemed_at=NULL, redeemed_by_user_id=NULL WHERE ticket_seq=1$$, '%já resgatada%');
SELECT assert((SELECT status FROM order_items WHERE id='00000000-0000-4000-8000-000000000201') = 'PENDING', 'item segue pendente com fichas em aberto');
SELECT tchefood_redeem_ticket('CHAPP0000000002X','00000000-0000-4000-8000-0000000000a1') IS NOT NULL;
SELECT tchefood_redeem_ticket('CHAPP0000000003X','00000000-0000-4000-8000-0000000000a1') IS NOT NULL;
SELECT assert((SELECT status FROM order_items WHERE id='00000000-0000-4000-8000-000000000201') = 'DELIVERED', 'todas as fichas resgatadas -> item entregue');
SELECT assert((SELECT billed_volume_ml FROM keg_taps WHERE tap_number=1) = 900, 'chopp da ficha baixou 3x300 no barril');

-- CASHBACK
INSERT INTO loyalty_customers (id, tenant_id, name, phone_whatsapp, whatsapp_opt_in, opt_in_at) VALUES ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000001','Ana','5555999991234',TRUE,NOW());
SELECT expect_error($$INSERT INTO loyalty_customers (tenant_id, phone_whatsapp) VALUES ('00000000-0000-4000-8000-000000000001','999991234')$$, '%phone_whatsapp_check%');
SELECT expect_error($$INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, base_amount, pct, valid_from, expires_at) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-0000000000f2','EARN',10,10,108.5,5,NOW()+INTERVAL '1 day',NOW()+INTERVAL '31 days')$$, '%crédito esperado R$ 5.43%');
SELECT expect_error($$INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, base_amount, pct, valid_from, expires_at) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-0000000000f1','EARN',1,1,0,5,NOW()+INTERVAL '1 day',NOW()+INTERVAL '31 days')$$, '%conta encerrada%');
-- crédito antigo (já liberado) para testar o resgate
INSERT INTO cashback_ledger (tenant_id, customer_id, order_id, entry_type, amount, remaining_amount, base_amount, pct, valid_from, expires_at, created_at) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-0000000000f2','EARN',5.43,5.43,108.5,5,NOW()-INTERVAL '2 days',NOW()+INTERVAL '20 days', NOW()-INTERVAL '3 days');
SELECT assert((SELECT cashback_balance FROM loyalty_customers WHERE id='00000000-0000-4000-8000-000000000401') = 5.43, 'saldo de cashback 5,43');
SELECT expect_error($$UPDATE cashback_ledger SET amount = 50$$, '%somente inserção%');
SELECT expect_error($$UPDATE cashback_ledger SET remaining_amount = 50$$, '%somente inserção%');
-- desconto manual sem gerente continua bloqueado
SELECT expect_error($$SET CONSTRAINTS ALL IMMEDIATE; UPDATE orders SET discount_amount = 3 WHERE id='00000000-0000-4000-8000-0000000000f1'$$, '%DISCOUNT_APPLIED sem PIN%');
BEGIN;
CREATE OR REPLACE FUNCTION tchefood_is_cashback_day(p_at TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT TRUE $$;
SELECT assert(tchefood_redeem_cashback('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000a1') = 5.43, 'resgatou 5,43 (cap 50% de 29,16 = 14,58)');
COMMIT;
SELECT assert((SELECT discount_amount = 5.43 AND total_amount = round(29.16*1.10,2) - 5.43 FROM orders WHERE id='00000000-0000-4000-8000-0000000000f1'), 'cashback virou desconto e passou pela trava de audit');
SELECT assert((SELECT cashback_balance FROM loyalty_customers WHERE id='00000000-0000-4000-8000-000000000401') = 0, 'saldo consumido');
SELECT expect_error($$SELECT tchefood_redeem_cashback('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-0000000000a1')$$, '%já usou cashback%');
-- restaura a regra real do dia (hoje, 09/11/2026, é segunda)
CREATE OR REPLACE FUNCTION tchefood_is_cashback_day(p_at TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXTRACT(ISODOW FROM p_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN 2 AND 4 $$;
INSERT INTO orders (id, tenant_id, table_id, opened_by_user_id) VALUES ('00000000-0000-4000-8000-0000000000f3','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000a1');
SELECT expect_error($$SELECT tchefood_redeem_cashback('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-0000000000f3','00000000-0000-4000-8000-0000000000a1')$$, '%terça a quinta%');
SELECT assert(tchefood_is_cashback_day('2026-11-10 12:00-03') AND NOT tchefood_is_cashback_day('2026-11-09 12:00-03') AND NOT tchefood_is_cashback_day('2026-11-13 12:00-03'), 'terça sim, segunda e sexta não');

-- TROCA DE BARRIL
SELECT expect_error($$SELECT tchefood_tap_new_keg('00000000-0000-4000-8000-0000000000e1','Pilsen 30L',30000,320,'00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000a1','Barril secou')$$, '%exige gerente%');
SELECT (tchefood_tap_new_keg('00000000-0000-4000-8000-0000000000e1','Pilsen 30L',30000,320,'00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000a9','Barril secou')).remaining_volume_ml;
SELECT assert((SELECT count(*) FROM keg_history) = 1 AND (SELECT billed_volume_ml FROM keg_history) = 900, 'histórico do barril encerrado');
SELECT assert((SELECT count(*) FROM audit_logs WHERE action_type='KEG_CHANGED') = 1, 'troca auditada');
SELECT assert((SELECT count(*) FROM pg_policies WHERE tablename IN ('keg_taps','keg_tap_products','keg_history','event_tickets','loyalty_customers','cashback_ledger')) = 6, 'RLS nas 6 tabelas novas');
\echo TODOS OS CENARIOS PASSARAM
