# Roteiro de homologação — maquininha Stone (Connect Stone 2.0)

Roteiro para testar a integração com a maquininha **real**, antes ou junto com o roteiro oficial que a Stone manda.
Cada caso diz o que fazer no caixa, o que fazer na maquininha, o que o sistema deve mostrar e o que anotar.

O Connect **não tem ambiente de testes**: tudo acontece em produção, com dinheiro de verdade. Use **R$ 1,00**, cartão
real, e estorne no App de Cancelamento da maquininha logo depois. Avise a equipe, porque mexe no domicílio bancário da
loja de teste.

## Antes de começar

**Servidor**

- [ ] `STONE_CONNECT_SERVICE_REFERER_NAME` configurada com o identificador recebido no Partner Hub.
- [ ] `STONE_CONNECT_WEBHOOK_TOKEN` configurada com um segredo longo e aleatório (32 caracteres ou mais).
- [ ] Migração `docs/migracoes-manuais/0097_stone_connect_lookup.sql` aplicada (PASSO 0 deu 0, PASSO 2 deu 2).
- [ ] Webhook cadastrado no painel do Pagar.me da conta de teste (Configurações > Webhooks), com a URL
      `https://<domínio>/api/webhooks/stone-connect?token=<STONE_CONNECT_WEBHOOK_TOKEN>` e os eventos `charge.paid` e
      `charge.refunded`.
- [ ] Teste de envio do painel do Pagar.me responde **200** (um evento sem pedido volta `{"ignored":true}`).

**Loja de teste no Tchê Food**

- [ ] Configurações > Maquininha Stone: chave secreta (`sk_...`) e número de série salvos; "Cobrar cartão na
      maquininha Stone pelo caixa" ligado; o selo mostra **Cobrança ligada** (e não "aguardando liberação").
- [ ] Caixa aberto e um produto de **R$ 1,00** cadastrado.

**Maquininha**

- [ ] Modelo compatível (S920, Q92, T8 ou D400). Anote o modelo: ________
- [ ] App de Pagamento aberto na tela **"Aguardando Pagamentos"**. Anote a versão do app: ________
- [ ] Internet estável (Wi-Fi ou chip).

## Como anotar cada caso

Para cada caso, anote: horário, pedido (`or_...`), cobrança (`ch_...`), NSU, o que a maquininha mostrou, o que o caixa
mostrou e se o resultado bateu com o esperado. O pedido aparece em Configurações > Maquininha Stone quando a cobrança
vai para conferência, e no painel do Pagar.me (Pedidos).

## Casos

### 1. Crédito à vista aprovado

1. Caixa: produto de R$ 1,00, forma **Cartão de crédito**, marcar **Cobrar na maquininha Stone**, finalizar.
2. Maquininha: a tela de pagamento abre sozinha. Passe um cartão de crédito e aprove.

**Esperado:** o caixa mostra "Pagamento aprovado. Venda registrada." em até ~5 s; a venda aparece em Vendas; no painel
do Pagar.me o pedido fica **fechado** com status **paid**; a maquininha volta para "Aguardando Pagamentos" sem o pedido.

### 2. Débito aprovado

Igual ao caso 1, com **Cartão de débito** e cartão de débito. **Esperado:** igual ao caso 1.

### 3. Cartão negado e depois aprovado no mesmo pedido

1. Caixa: cobrança de R$ 1,00 no crédito.
2. Maquininha: provoque uma recusa (por exemplo, senha errada até a maquininha recusar, ou um cartão bloqueado).
3. Veja o que a maquininha faz depois da recusa e **anote** (volta para a tela de pagamento do mesmo pedido? some o
   pedido? volta para "Aguardando Pagamentos"?). Essa é uma das perguntas abertas para a Stone.
4. Se a maquininha deixar, pague o mesmo pedido com outro cartão.

**Esperado:** depois da recusa, o caixa continua em "Aguardando o cliente pagar" e mostra "O último cartão foi recusado
na maquininha". Com o segundo cartão aprovado, a venda é registrada. Se a maquininha não deixar tentar de novo, use
"Cancelar cobrança" no caixa (caso 4).

### 4. Cancelar antes de pagar

1. Caixa: cobrança de R$ 1,00. Com o pedido na tela da maquininha, clique em **Cancelar cobrança**.
2. Maquininha: **não** pague. Veja quanto tempo o pedido leva para sair da tela (até ~1 minuto) ou toque no **X**
   vermelho.

**Esperado:** o caixa mostra "Cobrança cancelada. Nada foi cobrado"; no Pagar.me o pedido fica fechado com status
**canceled**. Anote quanto tempo o pedido levou para sumir da maquininha.

### 5. Pagamento depois do cancelamento (pedido ainda na tela)

1. Repita o caso 4, mas pague na maquininha **logo depois** de cancelar no caixa, antes de o pedido sumir.

**Esperado:** se a maquininha aceitar o pagamento, a cobrança aparece em Configurações > Maquininha Stone > Cobranças
para conferir como "A maquininha aprovou um pagamento depois de a cobrança ser encerrada", e **não** dá para marcar
"Não foi cobrado". Resolva com **Foi cobrado** (a venda é gravada) ou estorne na maquininha. Se a maquininha recusar o
pagamento, anote: é a resposta para "pedido fechado ainda pode ser pago?".

### 6. Fechar a tela no meio da cobrança

1. Caixa: cobrança de R$ 1,00. Com o pedido na maquininha, **feche a aba** do navegador (ou recarregue a página).
2. Maquininha: pague.
3. Abra o caixa de novo.

**Esperado:** a venda é gravada mesmo com a tela fechada (o aviso da Stone grava pelo servidor). Ao abrir o caixa, a
cobrança aparece como concluída ou é retomada e concluída.

### 7. Estorno na maquininha depois da venda gravada

1. Use a venda do caso 1. Na maquininha, abra o **App de Cancelamento**, senha de administrador, cartão e estorne.

**Esperado:** o painel do Pagar.me mostra a cobrança estornada; o Tchê Food registra "Estorno feito na maquininha
depois da venda" (Configurações > Maquininha Stone). A venda **não** é desfeita sozinha: cancele-a em Vendas (com NFC-e
autorizada, cancele antes a nota fiscal: o sistema não cancela a venda com a nota valendo) e marque o estorno como conferido.

### 8. Aviso (webhook) fora do ar

1. No painel do Pagar.me, troque temporariamente a URL do webhook (por exemplo, apague o `token=`).
2. Faça uma cobrança de R$ 1,00 e pague.
3. Volte a URL certa.

**Esperado:** a venda é gravada mesmo sem o aviso, pela consulta do caixa (a cada 5 s). O painel do Pagar.me mostra o
aviso com falha (401); depois de corrigir a URL, reenvie-o pelo painel: deve responder 200 e **não** gravar uma segunda
venda.

### 9. Aviso repetido

1. No painel do Pagar.me, reenvie o aviso `charge.paid` de uma venda já gravada.

**Esperado:** resposta 200; nenhuma venda nova; o pedido continua fechado.

### 10. Fila da maquininha

1. Faça três vendas seguidas (casos 1 e 2).

**Esperado:** depois de cada uma, a maquininha volta a "Aguardando Pagamentos" sem pedidos antigos na lista. No painel
do Pagar.me, nenhum pedido pago fica **aberto** (o limite é de 30 pedidos abertos por maquininha).

### 11. Número de série digitado em minúsculas

1. Em Configurações > Maquininha Stone, apague o número de série e digite-o em minúsculas. Salve.
2. Faça o caso 1.

**Esperado:** o campo mostra o número em maiúsculas; o pagamento é aprovado e a venda gravada (confirma que a Stone
devolve o número de série em maiúsculas; se for para conferência com "O pagamento veio de outra maquininha", anote).

### 12. Cartão pré-pago no débito (se houver um à mão)

**Esperado:** venda gravada como débito. Se for para conferência por modalidade, anote o que o painel do Pagar.me mostra
em `account_funding_source`.

### 13. Crédito parcelado

1. Caixa: produto de valor que permita parcelar (ex.: R$ 30,00), crédito, **3x**, uma vez com "Loja paga os juros" e
   outra com "Cliente paga os juros".
2. Maquininha: confira se mostra 3 parcelas e o tipo certo (sem juros / com juros); pague.

**Esperado:** venda gravada com 3 parcelas; o valor pago na Stone é igual ao da venda nos dois casos (com juros, os
juros vão na fatura do cliente pelo emissor). Estorne depois.

## Depois dos testes

- [ ] Todas as cobranças de teste estornadas na maquininha e as vendas de teste canceladas em Vendas.
- [ ] Nenhuma cobrança da loja de teste parada em "Cobranças para conferir".
- [ ] Respostas às perguntas abertas (anotadas nos casos 3, 4, 5, 11 e 12) levadas ao gerente da Stone e copiadas para
      `docs/integracoes/stone/README.md`.

O que **não** precisa ser testado na maquininha, porque já é coberto por testes automáticos com a Stone simulada: a
resposta da criação do pedido perdida no caminho (o sistema procura o pedido pela referência e nunca envia outro), mais
de um pagamento no mesmo pedido, e aviso com segredo errado.
