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
| #38 | ac760d3 | 1 | APROVADO | 0 P0/P1/P2. P3-01 lastmod do sitemap = data do build (confirmado); P3-02 VITE_SITE_URL sem validação (confirmado). "A verificar": hidratação do dist, assets 200, og 1200×630, JSON-LD com texto hostil (conferidos) | Mergeado em 1e217f0. P3-01, P3-02 e teste de JSON-LD hostil no PR de seguimento #39 |
| #39 | b4c6c61 | 1 | REPROVADO | 3 P2 confirmados: P2-01 `||` deixava VITE_SITE_URL="" cair no padrão; P2-02 hostname só exigia ponto (aceitava .com, example..com, bad_domain.com); P2-03 em clone raso o git log atribuía a landing/ a data do commit da borda (reproduzido: 2026-11-10 em vez de 2026-10-01) | Rodada 2: `??`, validação de rótulos DNS (punycode aceito, IP recusado), lastmod omitido em clone raso/sem git (scripts/ultimaAlteracao.mjs), testes de integração com git real |
