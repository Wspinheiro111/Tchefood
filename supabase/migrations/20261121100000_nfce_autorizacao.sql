-- PR #63 (2ª auditoria do #55): o DANFE da bobina precisa do endereço do emitente e da data/hora
-- de autorização (dhRecbto) exatamente como a SEFAZ autorizou. Os dois vêm do XML autorizado /
-- protocolo da Focus, nunca do aparelho. Ficam gravados no documento e, depois de preenchidos,
-- não mudam mais. Documento antigo fica com os dois nulos: o aparelho não imprime pela bobina
-- própria (usa o DANFE da Focus) até a consulta completar.
-- Idempotente. Aplicar ANTES do deploy da emit-nfce.

ALTER TABLE nfce_documents ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;
ALTER TABLE nfce_documents ADD COLUMN IF NOT EXISTS issuer_address JSONB;

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
    -- Preenchido uma vez (nulo -> valor); depois disso nunca muda.
    IF (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
       OR (OLD.issuer_address IS NOT NULL AND NEW.issuer_address IS DISTINCT FROM OLD.issuer_address) THEN
        RAISE EXCEPTION 'TCHEFOOD_FISCAL: data de autorização e endereço do emitente não podem ser alterados.';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;
