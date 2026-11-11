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
| #37 | 0bd052e | 1 | REPROVADO | 2 P2 confirmados (P2-01 logo some se o WebP falhar; P2-02 animada estica com max-w); 0 descartados. Falha do workflow Android: não é do PR (job sem runner, 1 s, igual em todos os PRs desde #35) | 7bba396: carrega/decodifica a animada antes de esconder a parada; encaixe em px medido sobre o desenho real; testes unitários + aceite Playwright (12 falhas em 0bd052e, 0 em 7bba396) |
| #37 | (cabeça após 7bba396) | 2 | aguardando | | |
