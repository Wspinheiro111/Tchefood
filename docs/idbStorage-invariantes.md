# idbStorage: invariantes das cópias de emergência (PR #54, rodada 25)

Arquivo: `src/lib/idbStorage.ts`. Testes: `src/__tests__/gptR18Persist.test.tsx`.

## Regra

1. Cada cópia no localStorage é uma chave **própria e só de escrita**: `<nome>::copia::<seq>.<instância>`. Ninguém troca
   o valor da cópia de outra aba; duas gravações com o mesmo número viram duas chaves.
2. Uma aba só apaga cópias **pela chave exata que ela leu (ou escreveu)**, quando o estado dela já inclui o conteúdo.
   Cópia que apareceu depois da leitura não é conhecida e nunca é apagada por essa aba.
3. Ordem total: (número, id da instância). Empate de número com conteúdo diferente: vale o id maior (ou o IndexedDB, que
   fica com o empate), e a outra vai para `<nome>::conflito::…`, que nada apaga sozinho (só `removeItem`).
4. `getItem` só devolve depois de uma seleção estável: depois de recuperar uma cópia no IndexedDB, lê tudo de novo e, se
   apareceu cópia que não tinha visto, recomeça (até 6 vezes). O que o Zustand hidrata é o mais novo ao fim da leitura.
5. O IndexedDB só é sobrescrito pela recuperação se `k` e `k::seq` continuarem exatamente como na leitura que escolheu a
   cópia (comparação do texto inteiro, na mesma transação).
6. Texto de versão anterior do app (impressão de 106 bits não bate com `k::seq`) vale mais que qualquer cópia, menos a
   feita em cima desse mesmo texto (`base`).

## Todo caminho que apaga, sobrescreve ou ignora uma cópia

| Caminho | O que faz com a cópia | Por que um estado mais novo de outra instância não se perde | Teste |
|---|---|---|---|
| `setItem` com IndexedDB bom (`writeDb`) | apaga só as chaves em `knownCopies` (lidas na última seleção ou gravadas por esta aba) | cópia de outra aba não está no conjunto; fica | r24 P2-02 (cópia de B no meio da gravação de A), r24 P2-03 escrita boa |
| `setItem` com IndexedDB recusando | grava chave nova; apaga só as conhecidas e mais velhas | chave única por gravação: não troca a de outra aba, mesmo com o mesmo número | r23 vizinho, r24 P2-03 fallback |
| `setItem` com as duas recusando | guarda na memória desta aba | memória é só desta aba; as cópias de outras ficam | (existente: falha total devolve false) |
| `getItem` escolhe o IndexedDB | apaga as cópias lidas (mais velhas); empate com conteúdo diferente vai para conflito | só chaves lidas; empate nunca é apagado sem guardar | r24 P2-03 escrita boa |
| `getItem` escolhe uma cópia (`healFromCopy`) | grava no IndexedDB só se `k` e `k::seq` não mudaram; depois apaga as lidas | se outra versão gravou, relê; se outra aba criou cópia no meio, relê e a nova passa a ser candidata | r21 P2-02, r24 P2-01/P2-02 (S2 durante a recuperação) |
| `getItem` com o IndexedDB recusando | não apaga nada; devolve a mais nova | nada é removido | r18 P1-01 |
| Hidratação do Zustand + gravação automática | grava o estado hidratado | o estado hidratado já inclui a mais nova vista; só as lidas saem | r24 P2-01 com a store real |
| Texto de versão anterior no IndexedDB (foreign) | vence, exceto cópia com `base` igual à impressão dele | cópia feita em cima dele é posterior; a que tem outra base é mais velha | r21 P2-01 |
| Formato antigo (chave única `<nome>::copia`, envelope `{seq,v}` no IndexedDB) | lido como cópia com id vazio / candidato do IndexedDB | apagada só pela chave exata, como as outras | r19, r20 |
| `removeItem` | apaga estado, cópias e conflitos | decisão explícita de limpar a loja | — |

## Limitações conhecidas (o que o navegador não garante)

- Não há transação entre localStorage e IndexedDB nem "apagar se igual" no localStorage; por isso a regra evita
  comparar-e-apagar e usa chaves exatas.
- Cópia que outra aba grava **depois** do fim da leitura desta e antes de esta gravar de volta concorre com a gravação
  desta pela regra do último que grava (como duas abas gravando no IndexedDB). Ela segue na chave dela e vale se tiver
  número maior na próxima leitura; se o número for menor, é coberta e sai nessa leitura.
- Relógios diferentes entre abas do mesmo aparelho são raros (mesma máquina); o desempate por id cobre o empate exato.
- Os testes usam um IndexedDB e um localStorage simulados no mesmo processo: provam a lógica de ordem e de chaves, não
  a intercalação entre processos reais.
