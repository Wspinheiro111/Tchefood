-- =============================================================================
-- Tchê Food — conferência do Supabase de verdade depois das migrations do delivery
-- (supabase/migrations/20261114150000_delivery_servidor.sql = db/schema_delivery_servidor.sql).
--
-- SÓ LEITURA: um único SELECT no catálogo, nada é criado nem alterado. Cole tudo no SQL Editor do Supabase e
-- rode. Volta uma tabela "item | esperado | encontrado | ok":
--   ok = 'sim'                  conferido
--   ok = 'NÃO'                  algo diferente do esperado: não ligue o servidor do iFood antes de corrigir
--   ok = 'ainda não (opcional)' item de uma rodada que talvez ainda não tenha sido aplicada (detail_pending)
-- As linhas com 'NÃO' saem primeiro.
--
-- Conferido em Postgres limpo por db/tests/verificarDeliveryServidor.pg.test.ts (mesmas migrations).
-- Mudou a assinatura de uma função tchefood_delivery_* no schema? Atualize a lista "funcs" abaixo.
-- =============================================================================
WITH
funcs (ordem, sig, servidor) AS (VALUES
    (1, 'public.tchefood_delivery_tenant(delivery_channel, varchar)', TRUE),
    (2, 'public.tchefood_delivery_active_merchants(delivery_channel)', TRUE),
    (3, 'public.tchefood_delivery_record_json(delivery_orders)', TRUE),
    (4, 'public.tchefood_delivery_get_order(delivery_channel, varchar)', TRUE),
    (5, 'public.tchefood_delivery_list_orders(delivery_channel, integer)', TRUE),
    (6, 'public.tchefood_delivery_has_event(delivery_channel, varchar)', TRUE),
    (7, 'public.tchefood_delivery_save_order(delivery_channel, integer, jsonb)', TRUE),
    (8, 'public.tchefood_delivery_record_event(jsonb)', TRUE),
    (9, 'public.tchefood_delivery_audit_result(uuid, varchar, text)', TRUE),
    (10, 'public.tchefood_delivery_authorize(delivery_channel, varchar, varchar, varchar, varchar, uuid, text, uuid, jsonb)', FALSE),
    (11, 'public.tchefood_delivery_list_detail_pending(delivery_channel, integer)', TRUE)
),
f AS (
    SELECT ordem, sig, servidor, to_regprocedure(sig) AS oid FROM funcs
),
f_priv AS (
    SELECT f.*,
           p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub,
           has_function_privilege('anon', f.oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', f.oid, 'EXECUTE') AS auth,
           has_function_privilege('service_role', f.oid, 'EXECUTE') AS svc
      FROM f JOIN pg_proc p ON p.oid = f.oid
),
-- Todas as tchefood_delivery_* que existem no banco (inclusive as que a lista acima não conhece). Fica de fora
-- tchefood_delivery_step, da entrega própria (db/schema_entrega.sql): conta pura (IMMUTABLE, sem tabela), não é
-- do servidor do iFood.
todas AS (
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.proname, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'tchefood\_delivery\_%' AND p.proname <> 'tchefood_delivery_step'
),
tabs (ordem, tab) AS (VALUES (1, 'delivery_orders'), (2, 'delivery_events'), (3, 'delivery_integrations')),
t AS (
    SELECT ordem, tab, to_regclass('public.' || tab) AS oid FROM tabs
),
col (ordem, nome, tipo, nulo, padrao, opcional) AS (VALUES
    (1, 'version', 'integer', 'NO', '1', FALSE),
    (2, 'dispute', 'jsonb', 'YES', NULL, FALSE),
    (3, 'cancellation_request', 'jsonb', 'YES', NULL, FALSE),
    (4, 'detail_pending', 'boolean', 'NO', 'false', TRUE)
),
trg (ordem, nome, funcao, quando) AS (VALUES
    (1, 'trg_audit_logs_guard', 'tchefood_guard_audit_insert', 'BEFORE INSERT FOR EACH ROW'),
    (2, 'trg_audit_logs_immutable', 'tchefood_audit_immutable', 'BEFORE UPDATE OR DELETE FOR EACH ROW')
),
checks (grupo, ordem, item, esperado, encontrado, ok, opcional) AS (
    -- 1) Funções com a assinatura atual.
    SELECT 1, ordem, 'função ' || sig, 'existe',
           CASE WHEN oid IS NULL THEN 'não existe (assinatura diferente ou migration não aplicada)' ELSE 'existe' END,
           oid IS NOT NULL, FALSE
      FROM f
    UNION ALL
    SELECT 1, 99, 'versão antiga de tchefood_delivery_authorize (sem p_details)', 'não existe',
           CASE WHEN to_regprocedure('public.tchefood_delivery_authorize(delivery_channel, varchar, varchar, varchar, varchar, uuid, text, uuid)') IS NULL
                THEN 'não existe' ELSE 'existe' END,
           to_regprocedure('public.tchefood_delivery_authorize(delivery_channel, varchar, varchar, varchar, varchar, uuid, text, uuid)') IS NULL, FALSE
    UNION ALL
    -- 2) Quem executa cada função.
    SELECT 2, ordem, 'quem executa ' || split_part(sig, '(', 1),
           CASE WHEN servidor THEN 'só service_role' ELSE 'authenticated (anon e PUBLIC não)' END,
           COALESCE(NULLIF(concat_ws(', ', CASE WHEN pub THEN 'PUBLIC' END, CASE WHEN anon THEN 'anon' END,
                                     CASE WHEN auth THEN 'authenticated' END, CASE WHEN svc THEN 'service_role' END), ''), 'ninguém'),
           CASE WHEN servidor THEN svc AND NOT pub AND NOT anon AND NOT auth
                ELSE auth AND NOT pub AND NOT anon END, FALSE
      FROM f_priv
    UNION ALL
    SELECT 2, 98, 'tchefood_delivery_* que anon executa', 'nenhuma',
           COALESCE((SELECT string_agg(sig, '; ' ORDER BY sig) FROM todas WHERE has_function_privilege('anon', oid, 'EXECUTE')), 'nenhuma'),
           NOT EXISTS (SELECT 1 FROM todas WHERE has_function_privilege('anon', oid, 'EXECUTE')), FALSE
    UNION ALL
    SELECT 2, 99, 'tchefood_delivery_* que authenticated executa', 'só tchefood_delivery_authorize',
           COALESCE((SELECT string_agg(sig, '; ' ORDER BY sig) FROM todas WHERE has_function_privilege('authenticated', oid, 'EXECUTE')), 'nenhuma'),
           NOT EXISTS (SELECT 1 FROM todas WHERE has_function_privilege('authenticated', oid, 'EXECUTE')
                                              AND proname <> 'tchefood_delivery_authorize')
           AND EXISTS (SELECT 1 FROM todas WHERE has_function_privilege('authenticated', oid, 'EXECUTE')
                                          AND proname = 'tchefood_delivery_authorize'), FALSE
    UNION ALL
    -- 3) SECURITY DEFINER e search_path fixo.
    SELECT 3, 1, 'tchefood_delivery_authorize é SECURITY DEFINER', 'sim',
           CASE WHEN p.prosecdef THEN 'sim' ELSE 'não' END, p.prosecdef, FALSE
      FROM f JOIN pg_proc p ON p.oid = f.oid WHERE f.ordem = 10
    UNION ALL
    SELECT 3, 2, 'SECURITY DEFINER tchefood_delivery_* sem search_path fixo', 'nenhuma',
           COALESCE((SELECT string_agg(sig, '; ' ORDER BY sig) FROM todas
                      WHERE prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(proconfig, '{}')) c WHERE c LIKE 'search\_path=%')), 'nenhuma'),
           NOT EXISTS (SELECT 1 FROM todas
                        WHERE prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(proconfig, '{}')) c WHERE c LIKE 'search\_path=%')), FALSE
    UNION ALL
    SELECT 3, 3, 'tchefood_delivery_* (todas) sem search_path fixo', 'nenhuma',
           COALESCE((SELECT string_agg(sig, '; ' ORDER BY sig) FROM todas
                      WHERE NOT EXISTS (SELECT 1 FROM unnest(COALESCE(proconfig, '{}')) c WHERE c LIKE 'search\_path=%')), 'nenhuma'),
           NOT EXISTS (SELECT 1 FROM todas
                        WHERE NOT EXISTS (SELECT 1 FROM unnest(COALESCE(proconfig, '{}')) c WHERE c LIKE 'search\_path=%')), FALSE
    UNION ALL
    SELECT 3, 4, 'tchefood_delivery_authorize devolve lastOutcome no reenvio', 'sim',
           CASE WHEN p.prosrc LIKE '%lastOutcome%' THEN 'sim' ELSE 'não (versão antiga, sem lastOutcome)' END,
           p.prosrc LIKE '%lastOutcome%', FALSE
      FROM f JOIN pg_proc p ON p.oid = f.oid WHERE f.ordem = 10
    UNION ALL
    -- 4) O app só lê as tabelas delivery_*. has_any_column_privilege pega também GRANT por coluna.
    SELECT 4, ordem * 10 + 1, 'anon em ' || tab, 'nenhum privilégio',
           COALESCE(NULLIF(concat_ws(', ',
               CASE WHEN has_any_column_privilege('anon', oid, 'SELECT') THEN 'SELECT' END,
               CASE WHEN has_any_column_privilege('anon', oid, 'INSERT') THEN 'INSERT' END,
               CASE WHEN has_any_column_privilege('anon', oid, 'UPDATE') THEN 'UPDATE' END,
               CASE WHEN has_table_privilege('anon', oid, 'DELETE') THEN 'DELETE' END,
               CASE WHEN has_table_privilege('anon', oid, 'TRUNCATE') THEN 'TRUNCATE' END), ''), 'nenhum privilégio'),
           NOT (has_any_column_privilege('anon', oid, 'SELECT') OR has_any_column_privilege('anon', oid, 'INSERT')
                OR has_any_column_privilege('anon', oid, 'UPDATE') OR has_table_privilege('anon', oid, 'DELETE')
                OR has_table_privilege('anon', oid, 'TRUNCATE')), FALSE
      FROM t WHERE oid IS NOT NULL
    UNION ALL
    SELECT 4, ordem * 10 + 2, 'authenticated grava em ' || tab, 'nada (sem INSERT/UPDATE/DELETE/TRUNCATE)',
           COALESCE(NULLIF(concat_ws(', ',
               CASE WHEN has_any_column_privilege('authenticated', oid, 'INSERT') THEN 'INSERT' END,
               CASE WHEN has_any_column_privilege('authenticated', oid, 'UPDATE') THEN 'UPDATE' END,
               CASE WHEN has_table_privilege('authenticated', oid, 'DELETE') THEN 'DELETE' END,
               CASE WHEN has_table_privilege('authenticated', oid, 'TRUNCATE') THEN 'TRUNCATE' END), ''), 'nada (sem INSERT/UPDATE/DELETE/TRUNCATE)'),
           NOT (has_any_column_privilege('authenticated', oid, 'INSERT') OR has_any_column_privilege('authenticated', oid, 'UPDATE')
                OR has_table_privilege('authenticated', oid, 'DELETE') OR has_table_privilege('authenticated', oid, 'TRUNCATE')), FALSE
      FROM t WHERE oid IS NOT NULL
    UNION ALL
    SELECT 4, ordem * 10 + 3, 'authenticated lê ' || tab, 'SELECT',
           CASE WHEN has_table_privilege('authenticated', oid, 'SELECT') THEN 'SELECT' ELSE 'sem SELECT' END,
           has_table_privilege('authenticated', oid, 'SELECT'), FALSE
      FROM t WHERE oid IS NOT NULL
    UNION ALL
    SELECT 4, ordem * 10, 'tabela ' || tab, 'existe', 'não existe', FALSE, FALSE
      FROM t WHERE oid IS NULL
    UNION ALL
    -- 5) RLS ligada e leitura só da própria loja.
    SELECT 5, ordem * 10 + 1, 'RLS ligada em ' || tab, 'sim',
           CASE WHEN c.relrowsecurity THEN 'sim' ELSE 'não' END, c.relrowsecurity, FALSE
      FROM t JOIN pg_class c ON c.oid = t.oid
    UNION ALL
    SELECT 5, ordem * 10 + 2, 'policies de leitura em ' || tab,
           'ao menos 1 com tchefood_tenant(); nenhuma sem',
           (SELECT count(*) FILTER (WHERE p.qual LIKE '%tchefood_tenant()%') || ' com tchefood_tenant(), '
                   || count(*) FILTER (WHERE p.qual IS NULL OR p.qual NOT LIKE '%tchefood_tenant()%') || ' sem'
              FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = t.tab AND p.cmd IN ('ALL', 'SELECT') AND p.permissive = 'PERMISSIVE'),
           (SELECT count(*) FILTER (WHERE p.qual LIKE '%tchefood_tenant()%') > 0
                   AND count(*) FILTER (WHERE p.qual IS NULL OR p.qual NOT LIKE '%tchefood_tenant()%') = 0
              FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = t.tab AND p.cmd IN ('ALL', 'SELECT') AND p.permissive = 'PERMISSIVE'),
           FALSE
      FROM t WHERE oid IS NOT NULL
    UNION ALL
    -- 6) Colunas novas de delivery_orders.
    SELECT 6, col.ordem,
           'coluna delivery_orders.' || col.nome || CASE WHEN col.opcional THEN ' (rodada 3)' ELSE '' END,
           col.tipo || CASE WHEN col.nulo = 'NO' THEN ' NOT NULL' ELSE '' END || COALESCE(' DEFAULT ' || col.padrao, ''),
           COALESCE((SELECT ic.data_type || CASE WHEN ic.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
                            || COALESCE(' DEFAULT ' || ic.column_default, '')
                       FROM information_schema.columns ic
                      WHERE ic.table_schema = 'public' AND ic.table_name = 'delivery_orders' AND ic.column_name = col.nome), 'não existe'),
           EXISTS (SELECT 1 FROM information_schema.columns ic
                    WHERE ic.table_schema = 'public' AND ic.table_name = 'delivery_orders' AND ic.column_name = col.nome
                      AND ic.data_type = col.tipo AND ic.is_nullable = col.nulo
                      AND ic.column_default IS NOT DISTINCT FROM col.padrao),
           col.opcional
      FROM col
    UNION ALL
    -- 7) CHECKs.
    SELECT 7, 1, 'CHECK delivery_integrations_merchant_format', 'canal ifood com merchantId ^[A-Za-z0-9-]{1,64}$',
           COALESCE((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                      WHERE c.conname = 'delivery_integrations_merchant_format' AND c.conrelid = to_regclass('public.delivery_integrations')),
                    'não existe'),
           EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = 'delivery_integrations_merchant_format' AND c.conrelid = to_regclass('public.delivery_integrations')
                      AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%ifood%'
                      AND pg_get_constraintdef(c.oid) LIKE '%^[A-Za-z0-9-]{1,64}$%'), FALSE
    UNION ALL
    SELECT 7, 2, 'CHECK delivery_orders_version_positive', 'version >= 1',
           COALESCE((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                      WHERE c.conname = 'delivery_orders_version_positive' AND c.conrelid = to_regclass('public.delivery_orders')),
                    'não existe'),
           EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = 'delivery_orders_version_positive' AND c.conrelid = to_regclass('public.delivery_orders')
                      AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%version >= 1%'), FALSE
    UNION ALL
    -- 8) audit_logs: guarda de inserção (bloqueia DELIVERY_* vindos do app) e imutabilidade. "Ligado" é tgenabled 'O'
    --    (origem) ou 'A' (sempre); 'R' (ENABLE REPLICA TRIGGER) só roda em réplica, não nas sessões do app.
    SELECT 8, trg.ordem, 'trigger ' || trg.nome || ' em audit_logs',
           trg.quando || ', ligado, ' || trg.funcao || '()',
           COALESCE((SELECT CASE WHEN (g.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END
                            || CASE WHEN (g.tgtype & 4) > 0 THEN ' INSERT' ELSE '' END
                            || CASE WHEN (g.tgtype & 16) > 0 THEN CASE WHEN (g.tgtype & 4) > 0 THEN ' OR' ELSE '' END || ' UPDATE' ELSE '' END
                            || CASE WHEN (g.tgtype & 8) > 0 THEN CASE WHEN (g.tgtype & 20) > 0 THEN ' OR' ELSE '' END || ' DELETE' ELSE '' END
                            || CASE WHEN (g.tgtype & 1) > 0 THEN ' FOR EACH ROW' ELSE ' FOR EACH STATEMENT' END
                            || CASE WHEN g.tgenabled IN ('O', 'A') THEN ', ligado, '
                                    WHEN g.tgenabled = 'R' THEN ', só em réplica (não roda nas sessões normais), '
                                    ELSE ', DESLIGADO, ' END
                            || g.tgfoid::regproc::text || '()'
                       FROM pg_trigger g
                      WHERE g.tgrelid = to_regclass('public.audit_logs') AND g.tgname = trg.nome AND NOT g.tgisinternal), 'não existe'),
           EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
                    WHERE g.tgrelid = to_regclass('public.audit_logs') AND g.tgname = trg.nome AND NOT g.tgisinternal
                      AND g.tgenabled IN ('O', 'A') AND p.proname = trg.funcao
                      AND (g.tgtype & 1) > 0 AND (g.tgtype & 2) > 0
                      AND CASE trg.ordem WHEN 1 THEN (g.tgtype & 4) > 0
                                         ELSE (g.tgtype & 8) > 0 AND (g.tgtype & 16) > 0 END),
           FALSE
      FROM trg
    UNION ALL
    SELECT 8, 3, 'tchefood_guard_audit_insert bloqueia DELIVERY_* do app', 'versão do delivery (DELIVERY_RESULT ... DELIVERY_RESUME)',
           CASE WHEN p.oid IS NULL THEN 'não existe'
                WHEN p.prosrc LIKE '%DELIVERY_RESULT%' AND p.prosrc LIKE '%DELIVERY_CANCEL%' AND p.prosrc LIKE '%DELIVERY_DISPUTE%'
                     AND p.prosrc LIKE '%DELIVERY_PAUSE%' AND p.prosrc LIKE '%DELIVERY_RESUME%' THEN 'versão do delivery'
                ELSE 'versão antiga (sem DELIVERY_*)' END,
           p.oid IS NOT NULL AND p.prosrc LIKE '%DELIVERY_RESULT%' AND p.prosrc LIKE '%DELIVERY_CANCEL%' AND p.prosrc LIKE '%DELIVERY_DISPUTE%'
                AND p.prosrc LIKE '%DELIVERY_PAUSE%' AND p.prosrc LIKE '%DELIVERY_RESUME%',
           FALSE
      FROM (SELECT to_regprocedure('public.tchefood_guard_audit_insert()') AS oid) g
      LEFT JOIN pg_proc p ON p.oid = g.oid
    UNION ALL
    -- 9) O aparelho não lê o PIN da equipe (o PIN de gerente autoriza as ações do iFood): staff_users.pin_code
    --    fica fora do GRANT SELECT por coluna de anon e authenticated.
    SELECT 9, r.ordem, r.papel || ' lê staff_users.pin_code', 'não',
           CASE WHEN s.oid IS NULL THEN 'tabela staff_users não existe'
                WHEN has_column_privilege(r.papel, s.oid, 'pin_code', 'SELECT') THEN 'sim' ELSE 'não' END,
           s.oid IS NOT NULL AND NOT has_column_privilege(r.papel, s.oid, 'pin_code', 'SELECT'), FALSE
      FROM (VALUES (1, 'anon'), (2, 'authenticated')) r (ordem, papel)
     CROSS JOIN (SELECT to_regclass('public.staff_users') AS oid) s
)
SELECT item, esperado, encontrado,
       CASE WHEN COALESCE(ok, FALSE) THEN 'sim' WHEN opcional THEN 'ainda não (opcional)' ELSE 'NÃO' END AS ok
  FROM checks
 ORDER BY (COALESCE(ok, FALSE) OR opcional), grupo, ordem;
