# idbStorage: invariantes das cópias de emergência (PR #54, rodada 27)

Arquivo: `src/lib/idbStorage.ts`. Testes: `src/__tests__/gptR18Persist.test.tsx`.

## Modelo (simplificado na r27)

A. **Um único escritor por aparelho.** Só a instância que obtém o lock exclusivo `navigator.locks` (`tchefood-idb-writer`)
   grava, recupera ou apaga. Outra aba/instância do app no mesmo aparelho só **lê** (devolve o mais novo que vê, sem mudar
   nada); a gravação dela é ignorada com aviso no console. Sem `navigator.locks` (jsdom, navegadores antigos), a instância é
   a escritora. No APK há uma WebView por aparelho. Isso fecha a classe de concorrência entre escritores do app novo; sobram
   só o texto que uma **versão anterior** do app deixa (foreign) e a chave antiga `<nome>::copia`.
B. **Nenhum conteúdo é apagado sem estar provado incluído no estado que fica, ou guardado em `::conflito`.** Único caminho
   de exclusão: `retire`. Sai sem registro só a cópia de mesmo conteúdo do estado que vale ou de gravação **anterior do mesmo
   escritor** (mesmo id, número menor ou igual: o estado de um escritor só avança). Qualquer outra de conteúdo diferente é
   guardada em `<nome>::conflito::…` antes e só é apagada se a guarda deu certo. Confere o texto lido antes de apagar.
   **A chave antiga `<nome>::copia` nunca é apagada** (mutável por versões anteriores; só preservada e lida como candidata).
   Não há mais lista `absorbs` nem fecho transitivo.
C. **`select` (getItem) só conclui numa seleção estável**: depois de qualquer espera (recuperação com sucesso ou erro)
   confere se mudou cópia **ou o próprio IndexedDB** e escolhe de novo (até 6 vezes). Esgotadas as tentativas, ou com o
   IndexedDB ilegível depois de uma recuperação recusada, o resultado é **provisório**: devolve o mais novo visto (nunca
   null), não apaga nada e **toda gravação é recusada** até uma nova seleção estável devolver exatamente o que foi hidratado
   (se devolver outra coisa, a gravação segue recusada e a próxima abertura do app hidrata o estado certo).

## Todo caminho que apaga, sobrescreve ou ignora uma cópia

| Caminho | O que faz | Por que não se perde conteúdo | Teste |
|---|---|---|---|
| Instância sem o lock | `getItem` só lê; `setItem`/`removeItem` não fazem nada | não muda disco nem cópias | r26 segunda instância |
| `setItem`, IndexedDB bom (`writeDb`) | `retire` das cópias lidas | mesmo escritor anterior: sem registro; outras: conflito; chave antiga: fica | r24 P2-02/P2-03, r26 P3-01 |
| `setItem` com seleção provisória | recusado (a menos que a seleção estável devolva o hidratado) | provisório nunca vira definitivo | **r26 P2-02** |
| `setItem`, IndexedDB recusando | grava chave nova `{seq,id,v,base}`; `retire` das lidas | chave por gravação; tamanho constante, sem histórico | r23 vizinho, r24 P2-03, **r26 P2-04** |
| `setItem`, as duas recusando | guarda na memória (com `base`) | memória só desta instância; cópias ficam | falha total devolve false |
| `select` escolhe o IndexedDB | `retire` das cópias lidas | conflito para as de conteúdo diferente | r24 P2-03, r25 P2-01 |
| `select`: texto de versão anterior vence (foreign) | `retire` com vencedor sem escritor | a feita em cima dele ganha; as outras vão para conflito | r21 P2-01, r25 P2-01 |
| `select` escolhe uma cópia (`healFromCopy`) | grava no IndexedDB só se `k`/`k::seq` não mudaram; texto bifurcado do IndexedDB vai para conflito antes; depois `retire` | se mudou, relê; cópia que chegou no meio, relê | r21 P2-02, r24 P2-01, r25 P2-04 |
| `select`, recuperação **recusada** | relê o IndexedDB: mudou texto/número ou cópia → escolhe de novo; igual → devolve sem apagar; ilegível → provisório | atualização concorrente do IndexedDB não é sobrescrita | r25 P2-03, **r26 P2-03** |
| `select`, leitura do IndexedDB recusada (`snap` nulo) | escolhe entre cópias e memória; não apaga | empate com conteúdo diferente: o de id maior vale, o outro vai para conflito na próxima gravação boa | r25 P2-02 |
| `select`, 6 seleções instáveis | devolve o mais novo visto, provisório | nada apagado; gravação recusada | r25 P2-04, **r26 P2-02** |
| Chave antiga `::copia` trocada por outra instância | nunca removida por `retire` | conteúdo novo continua lá e é candidato | **r26 P2-01a/b** |
| Hidratação do Zustand + gravação automática | grava o estado hidratado só se a seleção foi estável | ver provisório | r24 P2-01 e r25 P2-03 com a store real |
| `removeItem` (só escritor) | apaga estado, cópias e conflitos | decisão explícita de limpar a loja | — |

## Limitações conhecidas

- Sem `navigator.locks` não há exclusão entre instâncias; vale então a regra de conflito/leitura estável das rodadas anteriores
  (chaves por gravação, exclusão pela chave exata, conferência do texto lido).
- Se a instância escritora morre, outra só vira escritora ao recarregar (o lock é solto ao fechar a página; há 4 tentativas
  de 200 ms ao abrir).
- Os testes usam IndexedDB e localStorage simulados no mesmo processo.
