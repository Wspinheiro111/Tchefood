#!/usr/bin/env bash
# Gera o APK (debug) do app Android do Tchê Food sem depender do GitHub Actions.
# Serve no Google Cloud Shell (grátis), em Linux, no Mac e no WSL do Windows.
#
#   bash scripts/build-apk.sh              # os dois APKs: pagbank e tablet
#   bash scripts/build-apk.sh pagbank      # só a Moderninha Smart
#   bash scripts/build-apk.sh tablet       # só celular/tablet
#   TCHEFOOD_APP_URL=https://app.exemplo.com.br bash scripts/build-apk.sh
#
# Faz, nessa ordem: confere Java e Node, baixa o SDK Android e o Gradle se faltarem
# (em ~/.cache/tchefood-android, nunca dentro do projeto), roda `npm ci && npm run build`,
# compila e deixa os APKs em ./apk/. O APK é debug: instala direto na maquininha ou no
# tablet (fontes desconhecidas ou `adb install`). Release assinado e loja ficam fora daqui.
set -euo pipefail

CMDLINE_TOOLS_VERSION="11076708"   # commandline-tools 12.0
GRADLE_VERSION="8.7"
PLATFORM="android-34"
BUILD_TOOLS="34.0.0"
CACHE="${TCHEFOOD_ANDROID_CACHE:-$HOME/.cache/tchefood-android}"

uso() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

falha() {
  echo "ERRO: $*" >&2
  exit 1
}

variante="${1:-all}"
case "$variante" in
  -h|--help) uso; exit 0 ;;
  pagbank|tablet|all) ;;
  *) uso >&2; falha "variante desconhecida: $variante (use pagbank, tablet ou all)" ;;
esac

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$raiz"
[ -f android/settings.gradle.kts ] || falha "rode a partir do repositório do Tchê Food (não achei android/settings.gradle.kts)"

# --- Java 17 a 21 (o plugin Android 8.4 exige 17 ou mais; o Gradle 8.7 roda até o 21) ----------
command -v java >/dev/null 2>&1 || falha "Java não encontrado. Instale o JDK 17 (Cloud Shell já traz)."
java_major="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
{ [ -n "$java_major" ] && [ "$java_major" -ge 17 ] && [ "$java_major" -le 21 ]; } \
  || falha "precisa de Java 17 a 21; achei: ${java_major:-desconhecido}"

command -v node >/dev/null 2>&1 || falha "Node não encontrado (precisa do Node 20 para gerar o sistema web)."
command -v npm >/dev/null 2>&1 || falha "npm não encontrado."
command -v curl >/dev/null 2>&1 || falha "curl não encontrado."
command -v unzip >/dev/null 2>&1 || falha "unzip não encontrado."

# URL do sistema publicado, se houver: tem de ser https, como no build do Gradle.
gradle_props=()
if [ -n "${TCHEFOOD_APP_URL:-}" ]; then
  case "$TCHEFOOD_APP_URL" in
    https://*) gradle_props+=("-PTCHEFOOD_APP_URL=$TCHEFOOD_APP_URL") ;;
    *) falha "TCHEFOOD_APP_URL precisa começar com https://" ;;
  esac
fi

baixar() { # url destino
  echo "-> baixando $1"
  curl -fL --retry 3 --retry-delay 2 -o "$2.part" "$1" || falha "falha ao baixar $1"
  mv "$2.part" "$2"
}

mkdir -p "$CACHE"

# --- SDK Android -----------------------------------------------------------------------------
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  export ANDROID_HOME="$CACHE/sdk"
else
  export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
fi
export ANDROID_SDK_ROOT="$ANDROID_HOME"

sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$sdkmanager" ]; then
  case "$(uname -s)" in
    Linux) so="linux" ;;
    Darwin) so="mac" ;;
    *) falha "sistema não suportado: $(uname -s). No Windows use o WSL ou o Android Studio." ;;
  esac
  zip="$CACHE/cmdline-tools-$so.zip"
  baixar "https://dl.google.com/android/repository/commandlinetools-$so-${CMDLINE_TOOLS_VERSION}_latest.zip" "$zip"
  rm -rf "$CACHE/cmdline-tools-extract"
  unzip -q "$zip" -d "$CACHE/cmdline-tools-extract"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$CACHE/cmdline-tools-extract/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$CACHE/cmdline-tools-extract" "$zip"
fi

if [ ! -d "$ANDROID_HOME/platforms/$PLATFORM" ] || [ ! -d "$ANDROID_HOME/build-tools/$BUILD_TOOLS" ]; then
  echo "-> instalando plataforma $PLATFORM e build-tools $BUILD_TOOLS (aceitando as licenças do Google)"
  # `yes` fecha o pipe quando o sdkmanager termina; o SIGPIPE não é erro aqui.
  set +o pipefail
  yes | "$sdkmanager" --licenses >/dev/null
  set -o pipefail
  "$sdkmanager" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" "platform-tools"
fi

# --- Gradle ----------------------------------------------------------------------------------
if command -v gradle >/dev/null 2>&1 && gradle --version 2>/dev/null | grep -qx "Gradle $GRADLE_VERSION"; then
  gradle_cmd="gradle"
else
  gradle_dir="$CACHE/gradle-$GRADLE_VERSION"
  if [ ! -x "$gradle_dir/bin/gradle" ]; then
    zip="$CACHE/gradle-$GRADLE_VERSION-bin.zip"
    baixar "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" "$zip"
    unzip -q "$zip" -d "$CACHE"
    rm -f "$zip"
  fi
  gradle_cmd="$gradle_dir/bin/gradle"
fi

# --- Sistema web (vai embutido no APK) -------------------------------------------------------
if [ -z "${TCHEFOOD_APP_URL:-}" ]; then
  echo "-> gerando o sistema web (npm ci && npm run build)"
  npm ci
  npm run build
  [ -f dist/index.html ] || falha "o build web não gerou dist/index.html"
fi

# --- APK -------------------------------------------------------------------------------------
case "$variante" in
  pagbank) tarefas=(assemblePagbankDebug) ;;
  tablet) tarefas=(assembleTabletDebug) ;;
  all) tarefas=(assemblePagbankDebug assembleTabletDebug) ;;
esac

echo "-> compilando: ${tarefas[*]}"
"$gradle_cmd" -p android --no-daemon ${gradle_props[@]+"${gradle_props[@]}"} "${tarefas[@]}"

mkdir -p apk
encontrados=0
for v in pagbank tablet; do
  for apk in android/app/build/outputs/apk/"$v"/debug/*.apk; do
    [ -f "$apk" ] || continue
    case "$variante" in all|"$v") ;; *) continue ;; esac
    cp "$apk" "apk/tchefood-$v-debug.apk"
    echo "OK: apk/tchefood-$v-debug.apk"
    encontrados=$((encontrados + 1))
  done
done
[ "$encontrados" -gt 0 ] || falha "o Gradle terminou, mas não achei nenhum APK em android/app/build/outputs/apk/"

echo
echo "Pronto. No Cloud Shell, baixe com:  cloudshell download apk/tchefood-pagbank-debug.apk"
