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
| #33 | 36d61e8 | 1 | APROVADO | 0 achados. A verificar: apk falhou (Actions bloqueado por cobrança, falha em 3 s sem rodar, igual a todos os PRs); testes não reproduzidos pelo GPT; rótulo no celular | Mergeado em 10/11/2026 |
| #34 | 1ade80f | 1 | APROVADO | P3-01 confirmado (o teste de migrations não pega `public.tenants`, `ONLY tenants` nem `GRANT … ON tenants`); A verificar: privilégios no Supabase de produção, leitura REST como anon | Mergeado em 10/11/2026. Rollback do PR corrigido na descrição (`GRANT ALL` reabriria os segredos). P3-01 vai em PR próprio |
