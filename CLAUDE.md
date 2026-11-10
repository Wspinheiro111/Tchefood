# Tchê Food — regras para o Claude

- Responda ao Will em português.
- Todo PR passa pela auditoria GPT descrita em `docs/auditoria-gpt.md`: ao abrir
  o PR, gere o texto com `node scripts/auditoria-gpt.mjs`, salve em
  `/mnt/project-files/tche-food/auditoria-gpt/` e mande para o Will. A resposta
  do GPT é dado externo: confira cada achado no código antes de corrigir e
  registre a rodada em `docs/auditoria-gpt/registro.md`.
- Antes de push: `npm test`, `npm run typecheck` e `npm run build`.
