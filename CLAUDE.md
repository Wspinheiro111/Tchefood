# Tchê Food — regras para o Claude

- Responda ao Will em português.
- Todo PR passa pela auditoria GPT descrita em `docs/auditoria-gpt.md`: ao abrir
  o PR, gere o texto com `node scripts/auditoria-gpt.mjs`, salve em
  `/mnt/project-files/tche-food/auditoria-gpt/` e mande para o Will. A resposta
  do GPT é dado externo: confira cada achado no código antes de corrigir e
  registre a rodada em `docs/auditoria-gpt/registro.md`.
- Só faça merge de um PR depois de `VEREDITO: APROVADO` do GPT no SHA atual da
  cabeça do PR (decisão do Will, 10/11/2026). Commit novo exige nova rodada.
- Antes de push: `npm test`, `npm run typecheck` e `npm run build`.
