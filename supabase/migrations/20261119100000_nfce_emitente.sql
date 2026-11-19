-- PR #55 (rodada 3 do GPT, P1-01): o emitente do DANFE da bobina fica gravado no documento NFC-e,
-- junto do payload, no momento da transmissão (cadastro da loja no servidor). O aparelho imprime o
-- cabeçalho só com ele, nunca com o próprio cadastro, que pode estar desatualizado.
-- Idempotente; não mexe em dados existentes (documento antigo fica sem emitente: só o DANFE da Focus).

ALTER TABLE nfce_documents ADD COLUMN IF NOT EXISTS issuer JSONB;

-- Mesma função de 20261109060000_nfce_documents.sql, com o emitente imutável junto do payload e da chave.
CREATE OR REPLACE FUNCTION tchefood_nfce_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: documento NFC-e % não pode ser excluído.', OLD.id;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'processing'  AND NEW.status IN ('authorized', 'rejected', 'contingency', 'cancelled')) OR
        (OLD.status = 'rejected'    AND NEW.status IN ('processing', 'authorized', 'contingency')) OR
        (OLD.status = 'contingency' AND NEW.status IN ('processing', 'authorized', 'rejected', 'cancelled')) OR
        (OLD.status = 'authorized'  AND NEW.status = 'cancelled')
    ) THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: transição NFC-e inválida % -> %.', OLD.status, NEW.status;
    END IF;
    IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.environment IS DISTINCT FROM OLD.environment THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: identidade do documento NFC-e é imutável.';
    END IF;
    IF OLD.status IN ('authorized', 'cancelled') AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.access_key IS DISTINCT FROM OLD.access_key
       OR NEW.issuer IS DISTINCT FROM OLD.issuer) THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: NFC-e autorizada não pode ter payload, chave ou emitente alterados.';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;
