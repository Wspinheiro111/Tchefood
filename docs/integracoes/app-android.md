# App Android do Tchê Food (APK)

Projeto em `android/`. É uma casca nativa: uma WebView com o Tchê Food e as pontes de hardware.
O sistema é o mesmo do navegador (`npm run build` → `dist/`), então toda tela nova já entra no APK.

## Dois APKs

| Variante | Onde instalar | Cobrança | Impressão |
|---|---|---|---|
| `pagbank` (`food.tche.smartpos`) | Moderninha Smart / SmartPOS PagBank | PlugPag dentro da máquina (`window.PlugPagBridge`) | Bobina pelo PlugPag; rede e Bluetooth pelo `SmartPosNative` |
| `tablet` (`food.tche.smartpos.tablet`) | Celular ou tablet Android comum | Pela nuvem: Stone Connect, Mercado Pago Point (ou simulador) | Rede e Bluetooth pelo `SmartPosNative` |

As duas podem ficar instaladas juntas. No iPhone/iPad o caminho é o PWA (instalar pelo navegador), com TEF pela nuvem.

## Pontes

- `SmartPosJsBridge` (main): ESC/POS por rede (porta 9100) e Bluetooth SPP. É exposta como `SmartPosNative`
  através de `ExternalPrinterBridge`, sem `printInternalEscPos`, para a bobina da PagBank ir pelo PlugPag.
- `PlugPagJsBridge` (só `pagbank`): pagamento, última transação aprovada e impressão. Mesmas regras do
  W9 Smart PagBank do Tchê Vendas: uma instância, comandos serializados, `isServiceBusy()` antes, resultado cru
  para o `terminalGuard.ts` decidir. Nada inventa NSU.

A WebView só navega na origem do app. Links externos (WhatsApp, consulta da NFC-e) abrem fora, para as pontes
nunca ficarem visíveis a uma página de terceiros.

## De onde vem o sistema web

- Padrão: o `dist/` vai dentro do APK (`assets/www`) e é servido em `https://appassets.androidplatform.net`.
  Funciona sem internet; atualizar o sistema exige novo APK.
- `-PTCHEFOOD_APP_URL=https://app.seudominio.com.br`: o APK abre o sistema publicado. Atualiza sem reinstalar,
  mas precisa de internet para abrir. Só aceita https.

## Gerar o APK

### 1. Script (sem GitHub Actions, sem custo)

`scripts/build-apk.sh` faz tudo: confere Java 17 a 21 e Node, baixa o SDK Android e o Gradle 8.7 se faltarem
(em `~/.cache/tchefood-android`, fora do projeto), roda `npm ci && npm run build`, compila e deixa os APKs
debug em `apk/`. A pasta `apk/` só guarda os APKs da última execução e é trocada inteira, de uma vez:
os antigos saem, e se o build ou a troca falhar ela fica como estava. Só roda um build por vez no mesmo
repositório (trava em `.apk-build.lock`): uma segunda execução simultânea para com aviso e não altera nada.
Não guarde outros arquivos em `apk/`.

```bash
bash scripts/build-apk.sh            # pagbank e tablet
bash scripts/build-apk.sh pagbank    # só a Moderninha Smart
```

**Google Cloud Shell** (grátis, só precisa de conta Google; abre em shell.cloud.google.com):

```bash
git clone https://github.com/Wspinheiro111/Tchefood && cd Tchefood
bash scripts/build-apk.sh pagbank
cloudshell download apk/tchefood-pagbank-debug.apk
```

Também serve em Linux, no Mac e no WSL do Windows. O script aceita as licenças do SDK do Google
(`sdkmanager --licenses`) em seu nome: leia-as antes se for usar numa máquina de terceiros.

### 2. Android Studio

`npm ci && npm run build` na raiz e abrir a pasta `android/`; em Build, *Build APK(s)* na variante desejada.

### 3. GitHub Actions

A action **APK Android** roda em todo PR que mexe no app e deixa os dois APKs (debug) em *Artifacts*
(`tchefood-apk`); também dá para rodar à mão em Actions → APK Android → Run workflow. Só funciona com a
cobrança da conta GitHub em dia.

Instalar na maquininha para teste: ativar instalação de fontes desconhecidas (ou `adb install`). Publicar na loja
PagBank exige cadastro de desenvolvedor PagBank e APK de release assinado (ainda não configurado).

## Ainda não feito

- Stone embarcado (`window.StoneBridge`, deeplink `stone-sdk://pay`): a Stone hoje vai pelo Connect 2.0, pela nuvem.
- Assinatura de release e publicação nas lojas (PagBank, Play).
