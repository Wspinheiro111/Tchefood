# idbStorage: invariantes das cópias de emergência (PR #54, rodada 26)

Arquivo: `src/lib/idbStorage.ts`. Testes: `src/__tests__/gptR18Persist.test.tsx`.

## Regra, em uma frase

**Nenhum conteúdo é apagado sem antes ter sido provado incluído no estado que fica, ou guardado em `::conflito`.**
Resultado de leitura que não completou uma seleção estável nunca vira estado definitivo.

1. Cada cópia no localStorage é uma chave **própria e só de escrita**: `<nome>::copia::<seq>.<instância>` (a chave antiga
   única `<nome>::copia` continua lida, como cópia de id vazio). Duas gravações com o mesmo número viram duas chaves.
2. **Um único caminho apaga cópia: `retire`.** Para cada cópia lida: se a chave já não tem o texto lido, não faz nada
   (outra instância trocou ou apagou); se a cópia está provadamente incluída no estado que vale (é ele, tem o mesmo
   conteúdo, ou está em `absorbs` de uma cópia que ele inclui), apaga sem registro; qualquer outra, de conteúdo diferente,
   é guardada em `<nome>::conflito::<seq>.<id>.<impressão>` **antes**, e só é apagada se a guarda deu certo.
3. Ordem total: (número, id da instância); o IndexedDB fica com o empate. Texto de versão anterior do app (impressão de
   106 bits não bate com `k::seq`) vale mais que qualquer cópia, menos a feita em cima desse mesmo texto (`base`).
4. `getItem` só dá o resultado por concluído numa **seleção estável**: depois de qualquer espera (recuperação no
   IndexedDB, com sucesso ou erro) confere se apareceu ou mudou cópia e, se sim, escolhe de novo (até 6 vezes).
5. Esgotadas as 6 tentativas, o resultado é **provisório**: devolve o mais novo visto (nunca `null`, que hidrataria uma
   loja vazia), não apaga nada e, enquanto durar, `setItem` também não apaga cópia. A próxima leitura estável resolve e
   guarda em `::conflito` o que não entrou.
6. O IndexedDB só é sobrescrito pela recuperação se `k` e `k::seq` continuarem exatamente como na leitura (mesma transação).
   Se a cópia foi feita em cima de outro texto que não é o de agora (bifurcação), o texto de agora é guardado em
   `::conflito` antes de ser sobrescrito.

## Todo caminho que apaga, sobrescreve ou ignora uma cópia

| Caminho | O que faz | Por que não se perde conteúdo | Teste |
|---|---|---|---|
| `setItem`, IndexedDB bom (`writeDb`) | `retire` das cópias lidas na última seleção | só as incluídas saem sem registro; as lidas com conteúdo diferente vão para conflito; cópia não lida fica | r24 P2-02, r24 P2-03 escrita boa |
| `setItem`, IndexedDB bom, seleção provisória | não apaga nenhuma cópia | nada é removido | r25 P2-04 |
| `setItem`, IndexedDB recusando | grava chave nova; `retire` das lidas | chave única por gravação; `absorbs` registra o que ela inclui | r23 vizinho, r24 P2-03 fallback |
| `setItem`, as duas recusando | guarda na memória (com `base` e `absorbs`) | memória é só desta aba; cópias de outras ficam | falha total devolve false |
| `getItem` escolhe o IndexedDB | `retire` das cópias lidas | as de conteúdo diferente vão para conflito | r24 P2-03, r25 P2-01 |
| `getItem`: IndexedDB com texto de versão anterior vence (foreign) | `retire` das cópias | a cópia feita em cima dele ganha; as outras (ex.: S1 com S2 antigo no lugar) vão para conflito, também depois de reiniciar | r21 P2-01, **r25 P2-01** |
| `getItem` escolhe uma cópia (`healFromCopy`) | grava no IndexedDB só se `k`/`k::seq` não mudaram; depois `retire` | se mudou, relê; se chegou cópia no meio, relê; texto bifurcado do IndexedDB é guardado antes | r21 P2-02, r24 P2-01, r25 P2-04 |
| `getItem`, recuperação **recusada** (`healFromCopy` lança) | confere se apareceu ou mudou cópia: se sim, escolhe de novo; se não, devolve a escolhida sem apagar nada | o resultado só é dado por concluído numa seleção estável | **r25 P2-03** (store real) |
| `getItem`, leitura do IndexedDB **recusada** (`snap` nulo) | escolhe entre cópias e memória; não apaga | empate com conteúdo diferente: o de id maior vale e o outro vai para conflito na próxima gravação boa (`retire` do `setItem`) | **r25 P2-02** |
| `getItem`, 6 seleções instáveis | devolve o mais novo visto, marca provisório | nada é apagado; leitura estável seguinte resolve | **r25 P2-04** |
| Cópia da chave antiga única trocada por outra instância | `retire` confere o texto lido antes de apagar | a troca não é apagada; a leitura recomeça e vê o conteúdo novo | r25 chave antiga |
| Hidratação do Zustand + gravação automática | grava o estado hidratado | o estado hidratado é o resultado de uma seleção estável (ou o provisório, que não apaga) | r24 P2-01 e r25 P2-03 com a store real |
| `removeItem` | apaga estado, cópias e conflitos | decisão explícita de limpar a loja | — |

## Limitações conhecidas (o que o navegador não garante)

- Não há transação entre localStorage e IndexedDB nem "apagar se igual" no localStorage; por isso há chaves imutáveis,
  exclusão pela chave exata e conferência do texto lido antes de cada exclusão.
- Cópia que outra aba grava **depois** do fim da leitura desta e antes de esta gravar de volta concorre com a gravação
  desta pela regra do último que grava (como duas abas no IndexedDB). Ela não é apagada e, se perder, vai para
  `::conflito` na próxima leitura.
- No resultado provisório, o estado hidratado pode ser o da penúltima cópia; a mais nova segue na chave dela e é
  resolvida na próxima leitura estável.
- Os testes usam IndexedDB e localStorage simulados no mesmo processo: provam a lógica de ordem e de chaves, não a
  intercalação entre processos reais.
