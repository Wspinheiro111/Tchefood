# Registro das auditorias GPT

Uma linha por rodada. Processo em `docs/auditoria-gpt.md`.

| PR | SHA auditado | Rodada | Veredito | Achados (confirmados / descartados) | O que foi feito |
|---|---|---|---|---|---|
| #21 | 68d34c1 | 1 | aguardando | | |
| #22 | 540e02a | 1 | aguardando | | |
| #23 | 411b4b6 | 1 | aguardando | | |
| #24 | 2f28819 | 1 | aguardando | | |
| #25 | 48328a9 | 1 | aguardando | | |
| #26 | fa54976 | 1 | aguardando | | |
| #27 | 8095cb7 | 1 | aguardando | | |
| #28 | c487f94 | 1 | aguardando | | |
| #29 | bafe9d6 | 1 | aguardando | | |
| #30 | 875b9ac | 1 | aguardando | | |
| #31 | b888e6e | 1 | aguardando | | |
| #36 | 73d020c | 1 | REPROVADO | P0-01 autorização de preço não presa a produto, quantidade, sabores e adicionais (confirmado); P0-02 `created_at`/`priced_at` forjados davam happy hour fora da janela (confirmado); P0-03 produto de outra loja vazava preço na mensagem (confirmado); P2-01 metadata sem validação quebrava a conferência (confirmado) | Rodada 2 em e043fa0: os quatro corrigidos, teste no Postgres para cada um, que falha sem a trava |
| #36 | e043fa0 | 2 | REPROVADO | P2-01 `NaN` aceito em quantity, unit_price e modifiers_unit_price da autorização (confirmado: passa no cast e nas comparações); P2-02 `server_verified` true no alerta sem o servidor calcular o preço (confirmado). Os quatro achados da rodada 1 conferidos como corrigidos (P2-01 parcial). A verificar: sabores/adicionais alteráveis depois da inserção, validade da autorização após desativar o gerente, pesado e combo, PIN na outbox | Rodada 3: `NaN` recusado em cada campo; `server_verified` só com preço esperado calculado. Junto: a autorização registra a troca do desconto manual por um menor (mesma mudança do #35). Teste no Postgres para cada um, que falha sem a trava |
