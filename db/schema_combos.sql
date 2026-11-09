-- =============================================================================
-- Tchê Food — combos
-- Aplicar depois de db/schema_gerente_nuvem.sql. Idempotente: pode rodar de novo.
-- Espelho TypeScript: src/types.ts (Product.is_combo, ModifierOption.component_*,
-- OrderItem.combo_parent_item_id) e src/lib/combos.ts.
--
-- O combo é um produto (is_combo) com o preço do combo. As escolhas usam os grupos
-- de adicionais do próprio produto: a opção que aponta para um produto
-- (component_product_id) coloca esse produto no pedido. Grupo obrigatório com uma
-- opção só é item fixo; com várias, o cliente escolhe, e additional_price é o
-- acréscimo da troca.
--
-- No pedido, o item do combo leva o preço e é a linha da NFC-e. Cada componente é
-- um item de preço zero, no setor do produto dele, com combo_parent_item_id
-- apontando para o combo: vai para o KDS e baixa o barril sem mexer no total.
--
-- Travas (um item de preço zero sem elas seria um jeito de lançar consumo de graça):
--  - item com combo_parent_item_id só nasce com preço e adicionais zero, preso a um
--    combo da MESMA comanda, ainda não cancelado, e só com um produto que o combo
--    oferece, na quantidade do cadastro (quantidade do combo × quantidade da opção);
--  - o vínculo não muda depois de gravado;
--  - a opção de combo só aponta para produto da mesma loja, que não seja combo nem
--    vendido por peso.
-- =============================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_combo BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE modifier_options ADD COLUMN IF NOT EXISTS component_product_id UUID REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE modifier_options ADD COLUMN IF NOT EXISTS component_quantity INT NOT NULL DEFAULT 1;
ALTER TABLE modifier_options DROP CONSTRAINT IF EXISTS modifier_options_component_quantity_check;
ALTER TABLE modifier_options ADD CONSTRAINT modifier_options_component_quantity_check CHECK (component_quantity BETWEEN 1 AND 20);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS combo_parent_item_id UUID REFERENCES order_items(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_order_items_combo_parent ON order_items(combo_parent_item_id) WHERE combo_parent_item_id IS NOT NULL;

-- Opção de combo: produto da mesma loja, que não é combo nem vendido por peso.
CREATE OR REPLACE FUNCTION tchefood_check_combo_option()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_group_tenant UUID; v_comp products%ROWTYPE;
BEGIN
    IF NEW.component_product_id IS NULL THEN RETURN NEW; END IF;
    SELECT g.tenant_id INTO v_group_tenant FROM modifier_groups g WHERE g.id = NEW.group_id;
    SELECT * INTO v_comp FROM products p WHERE p.id = NEW.component_product_id;
    IF NOT FOUND OR v_comp.tenant_id IS DISTINCT FROM v_group_tenant THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: o produto do combo não é desta loja.';
    END IF;
    IF v_comp.is_combo THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: um combo não entra dentro de outro combo.';
    END IF;
    IF v_comp.sold_by_weight THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: produto vendido por peso não entra em combo.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_modifier_options_combo ON modifier_options;
CREATE TRIGGER trg_modifier_options_combo BEFORE INSERT OR UPDATE OF component_product_id, group_id ON modifier_options
    FOR EACH ROW EXECUTE FUNCTION tchefood_check_combo_option();

-- Combo não é vendido por peso nem meio a meio.
CREATE OR REPLACE FUNCTION tchefood_check_combo_product()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_combo AND (NEW.sold_by_weight OR NEW.allows_half_and_half) THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: combo não é vendido por peso nem tem meio a meio.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_products_combo ON products;
CREATE TRIGGER trg_products_combo BEFORE INSERT OR UPDATE OF is_combo, sold_by_weight, allows_half_and_half ON products
    FOR EACH ROW EXECUTE FUNCTION tchefood_check_combo_product();

-- Item de combo (componente): só preso a um combo da mesma comanda, com o que o combo oferece.
CREATE OR REPLACE FUNCTION tchefood_check_combo_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_parent order_items%ROWTYPE; v_is_combo BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.combo_parent_item_id IS DISTINCT FROM OLD.combo_parent_item_id THEN
            RAISE EXCEPTION 'TCHEFOOD_COMBO: o item % já enviado não muda de combo.', OLD.id;
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.combo_parent_item_id IS NULL THEN RETURN NEW; END IF;

    IF NEW.unit_price <> 0 OR NEW.modifiers_unit_price <> 0 THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: item do combo não tem preço próprio (o combo leva o preço).';
    END IF;
    SELECT * INTO v_parent FROM order_items i WHERE i.id = NEW.combo_parent_item_id;
    IF NOT FOUND OR v_parent.order_id <> NEW.order_id THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: o combo do item não está nesta comanda.';
    END IF;
    IF v_parent.combo_parent_item_id IS NOT NULL OR v_parent.status = 'CANCELED' THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: item preso a um combo inválido ou cancelado.';
    END IF;
    SELECT p.is_combo INTO v_is_combo FROM products p WHERE p.id = v_parent.product_id;
    IF NOT COALESCE(v_is_combo, FALSE) THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: o item pai não é um combo.';
    END IF;
    PERFORM 1
       FROM modifier_options o
       JOIN product_modifier_groups l ON l.group_id = o.group_id
      WHERE l.product_id = v_parent.product_id
        AND o.component_product_id = NEW.product_id
        AND NEW.quantity = v_parent.quantity * o.component_quantity;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TCHEFOOD_COMBO: o combo não oferece este produto nesta quantidade.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_order_items_combo ON order_items;
CREATE TRIGGER trg_order_items_combo BEFORE INSERT OR UPDATE OF combo_parent_item_id ON order_items
    FOR EACH ROW EXECUTE FUNCTION tchefood_check_combo_item();
