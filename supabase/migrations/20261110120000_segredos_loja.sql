-- Cópia de db/schema_segredos.sql (manter os dois iguais: src/__tests__/migrations.test.ts confere).
-- =============================================================================
-- Tchê Food — segredos fiscais da loja fora do alcance do aparelho
-- Aplicar depois de db/schema.sql e das demais migrations (achado P1-03 da auditoria GPT).
--
-- A política tenants_self deixa o aparelho ler a linha da própria loja. Sem trava por
-- coluna, uma chamada direta (GET /rest/v1/tenants?select=focus_nfe_token,csc_token)
-- devolvia o token da Focus NFe e o CSC. O app nunca pediu esses campos, mas o token
-- do aparelho conseguia.
--
-- Agora o aparelho (anon/authenticated) lê e altera só as colunas sem segredo. Quem
-- precisa dos segredos é a Edge Function emit-nfce, que usa a service role.
-- Coluna nova em tenants entra na lista automaticamente ao rodar esta migration de
-- novo; o teste db/tests/cloudSync.pg.test.ts confere que o aparelho lê tudo que o
-- app baixa (TENANT_COLUMNS em src/lib/sync/cloudPull.ts).
-- =============================================================================

DO $$
DECLARE
    v_cols TEXT;
    v_role TEXT;
BEGIN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenants'
       AND column_name NOT IN ('focus_nfe_token', 'csc_id', 'csc_token');
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            EXECUTE format('REVOKE ALL ON tenants FROM %I', v_role);
            IF v_role = 'authenticated' THEN
                EXECUTE format('GRANT SELECT (%s), UPDATE (%s) ON tenants TO authenticated', v_cols, v_cols);
            END IF;
        END IF;
    END LOOP;
END $$;
