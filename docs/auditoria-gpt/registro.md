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
| #36 | a4c7ea5 | 3 | REPROVADO | P2-01 `NaN`/`Infinity` em `discount_before`/`discount_after` do `DISCOUNT_APPLIED` gravavam autorização (confirmado: `NaN` passa por `< 0` e por `=`); P2-02 produto ou conta fora da loja vinha com `TCHEFOOD_PRECO` e ganhava o botão *Aceitar este preço* (confirmado). As duas da rodada 2 conferidas como corrigidas | Rodada 4: desconto autorizado só com dois números finitos, não negativos e diferentes (texto, `NaN`, `Infinity`, negativo recusados, nada gravado); recusa de loja passa a `TCHEFOOD_REGISTRO_LOJA`, sem botão (inclusive recusa antiga com o texto de loja). P2-01 vale para o #35, que redefine a mesma função: mesma correção lá. Teste no Postgres para cada um, que falha sem a trava |
| #36 | 32db200 | 4 | REPROVADO | P0-01 sabores e adicionais do item podiam ser trocados depois do envio sem nova conferência do preço (confirmado: `tchefood_check_item_price` roda só no INSERT e `tchefood_lock_item_financials` não protegia `half_product_ids` nem `modifier_option_ids`) | `tchefood_lock_item_financials` redefinida na migration do #36 com os dois campos; status, preparo, entrega e cancelamento seguem livres. Teste no Postgres com o token do aparelho: PATCH de adicional pago e de outro sabor recusados (item, total e audit intactos), reenvio e upsert sem mudança aceitos, upsert com outra composição recusado, PENDING → PREPARING aceito; falha sem a trava. Itens de versões antigas: o aparelho guarda os dois campos vazios, igual ao banco |
