## Objetivo
Descreva o problema e a mudança proposta.

## Risco operacional
- [ ] Não altera banco/schema/migrations
- [ ] Não altera dinheiro (itens, pagamentos, descontos, 10%, caixa)
- [ ] Não altera fiscal (NFC-e)
- [ ] Não altera maquininha/TEF
- [ ] Não altera o formato salvo no aparelho (versão do persist)

Se algum item acima for alterado, explique o impacto e o rollback.

## Evidências
Testes, typecheck, build e o que foi conferido na tela.

## Auditoria GPT
- [ ] Texto gerado com `scripts/auditoria-gpt.mjs` e enviado ao Will (SHA: `…`)
- Veredito: aguardando
