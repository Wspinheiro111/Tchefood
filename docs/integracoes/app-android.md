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

Pelo GitHub: a action **APK Android** roda em todo PR que mexe no app e deixa os dois APKs (debug) em
*Artifacts* (`tchefood-apk`). Também dá para rodar à mão em Actions → APK Android → Run workflow.

Na máquina (Android Studio ou SDK + Gradle 8.7, Java 17):

```bash
npm ci && npm run build
gradle -p android assemblePagbankDebug   # ou assembleTabletDebug
# APK em android/app/build/outputs/apk/<variante>/debug/
```

Instalar na maquininha para teste: ativar instalação de fontes desconhecidas (ou `adb install`). Publicar na loja
PagBank exige cadastro de desenvolvedor PagBank e APK de release assinado (ainda não configurado).

## Ainda não feito

- Stone embarcado (`window.StoneBridge`, deeplink `stone-sdk://pay`): a Stone hoje vai pelo Connect 2.0, pela nuvem.
- Assinatura de release e publicação nas lojas (PagBank, Play).
