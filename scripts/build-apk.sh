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
# compila e deixa os APKs em ./apk/ (só os desta execução: os antigos saem, e se o build falhar a
# pasta fica como estava; apk/ é um link para a versão atual, trocado de uma vez, e a versão anterior fica até a
# publicação seguinte). O APK é debug: instala direto na maquininha ou no
# tablet (fontes desconhecidas ou `adb install`). Release assinado e loja ficam fora daqui.
set -euo pipefail

CMDLINE_TOOLS_VERSION="11076708"   # commandline-tools 12.0
GRADLE_VERSION="8.7"
PLATFORM="android-34"
BUILD_TOOLS="34.0.0"
CACHE="${TCHEFOOD_ANDROID_CACHE:-$HOME/.cache/tchefood-android}"

uso() {
  sed -n '2,/^set -/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
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

# --- Trava: uma execução por repositório --------------------------------------------------------------------
# A limpeza, o Gradle e a publicação usam as mesmas pastas. A exclusão mútua é um flock do sistema operacional
# no arquivo .apk-build.flock, aberto no descritor 9 deste próprio processo: o perl (presente no Linux e no macOS)
# só pede o flock sobre esse descritor e sai, e a trava fica com este bash até ele terminar. O sistema a solta
# quando o processo morre (até com kill -9), então não há "trava velha" para recuperar nem PID para conferir, e
# não existe nenhum caminho que entre no corpo do script sem passar por aqui (nada de variável que pule a trava).
# A pasta .apk-build.lock de uma versão antiga do script, se sobrou, é ignorada.
command -v perl >/dev/null 2>&1 || falha "perl não encontrado (usado para a trava de execução única)."
exec 9>>"$raiz/.apk-build.flock" || falha "não consegui abrir a trava $raiz/.apk-build.flock"
codigo_trava=0
perl -e 'use Fcntl qw(:flock); open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1; exit 0' \
  || codigo_trava=$?
case "$codigo_trava" in
  0) ;;
  1) falha "outra execução do build-apk.sh está em andamento (trava $raiz/.apk-build.flock); nada foi alterado. Espere terminar e rode de novo." ;;
  *) falha "não consegui pegar a trava $raiz/.apk-build.flock" ;;
esac

# Programas externos que podem deixar processos vivos (npm, Gradle, SDK, downloads) rodam sem o descritor 9:
# um daemon que sobreviva ao build nunca fica segurando a trava.
sem_trava() { "$@" 9>&-; }

staging=""
link_novo=""
link_ant=""
pid_gradle=""

limpar() {
  local codigo=$?
  trap - EXIT
  # interrompido (Ctrl-C, kill) no meio da compilação: o Gradle não continua sozinho depois que a trava sai
  if [ -n "$pid_gradle" ]; then kill "$pid_gradle" 2>/dev/null || true; wait "$pid_gradle" 2>/dev/null || true; fi
  if [ -n "$link_novo" ]; then rm -f "$link_novo"; fi
  if [ -n "$link_ant" ]; then rm -f "$link_ant"; fi
  if [ -n "$staging" ]; then rm -rf "$staging"; fi
  exit "$codigo"
}
trap limpar EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Sobras de uma execução morta à força (kill -9): só o conjunto atual (apk/) e o anterior (.apk-anterior) ficam.
rm -f "$raiz"/.apk-link.*
# Migração da pasta apk/ antiga interrompida entre as duas etapas (pasta já guardada, link ainda não criado):
# devolve o conjunto guardado antes de qualquer limpeza, para ele não ser apagado como sobra.
if [ ! -e "$raiz/apk" ] && [ ! -L "$raiz/apk" ]; then
  for r in "$raiz"/.apk-releases/legado.*; do
    [ -d "$r" ] || continue
    ln -s ".apk-releases/$(basename "$r")" "$raiz/apk" && break
  done
fi
# Mantém a versão atual e a anterior; apaga o resto (pastas de builds que morreram antes de publicar).
manter_so_atual_e_anterior() {
  local atual="" anterior="" r n
  if [ -L "$raiz/apk" ]; then atual="$(basename "$(readlink "$raiz/apk")")"; fi
  if [ -L "$raiz/.apk-anterior" ]; then anterior="$(basename "$(readlink "$raiz/.apk-anterior")")"; fi
  for r in "$raiz"/.apk-releases/*; do
    [ -e "$r" ] || continue
    n="$(basename "$r")"
    [ "$n" = "$atual" ] || [ "$n" = "$anterior" ] || rm -rf "$r"
  done
}
manter_so_atual_e_anterior

# --- Java 17 a 21 (o plugin Android 8.4 exige 17 ou mais; o Gradle 8.7 roda até o 21) ----------
command -v java >/dev/null 2>&1 || falha "Java não encontrado. Instale o JDK 17 (Cloud Shell já traz)."
java_major="$(sem_trava java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
{ [ -n "$java_major" ] && [ "$java_major" -ge 17 ] && [ "$java_major" -le 21 ]; } \
  || falha "precisa de Java 17 a 21; achei: ${java_major:-desconhecido}"

command -v node >/dev/null 2>&1 || falha "Node não encontrado (precisa do Node 20 para gerar o sistema web)."
node_major="$(sem_trava node -v 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p')"
{ [ -n "$node_major" ] && [ "$node_major" -ge 20 ]; } || falha "precisa do Node 20 ou mais; achei: ${node_major:-desconhecido}"
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
  sem_trava curl -fL --retry 3 --retry-delay 2 -o "$2.part" "$1" || falha "falha ao baixar $1"
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
  sem_trava unzip -q "$zip" -d "$CACHE/cmdline-tools-extract"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$CACHE/cmdline-tools-extract/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$CACHE/cmdline-tools-extract" "$zip"
fi

if [ ! -d "$ANDROID_HOME/platforms/$PLATFORM" ] || [ ! -d "$ANDROID_HOME/build-tools/$BUILD_TOOLS" ]; then
  echo "-> instalando plataforma $PLATFORM e build-tools $BUILD_TOOLS (aceitando as licenças do Google)"
  # `yes` fecha o pipe quando o sdkmanager termina; o SIGPIPE não é erro aqui.
  set +o pipefail
  sem_trava yes | sem_trava "$sdkmanager" --licenses >/dev/null
  set -o pipefail
  sem_trava "$sdkmanager" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" "platform-tools"
fi

# --- Gradle ----------------------------------------------------------------------------------
if command -v gradle >/dev/null 2>&1 && sem_trava gradle --version 2>/dev/null | grep -qx "Gradle $GRADLE_VERSION"; then
  gradle_cmd="gradle"
else
  gradle_dir="$CACHE/gradle-$GRADLE_VERSION"
  if [ ! -x "$gradle_dir/bin/gradle" ]; then
    zip="$CACHE/gradle-$GRADLE_VERSION-bin.zip"
    baixar "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" "$zip"
    sem_trava unzip -q "$zip" -d "$CACHE"
    rm -f "$zip"
  fi
  gradle_cmd="$gradle_dir/bin/gradle"
fi

# --- Sistema web (vai embutido no APK) -------------------------------------------------------
if [ -z "${TCHEFOOD_APP_URL:-}" ]; then
  echo "-> gerando o sistema web (npm ci && npm run build)"
  sem_trava npm ci
  sem_trava npm run build
  [ -f dist/index.html ] || falha "o build web não gerou dist/index.html"
fi

# --- APK -------------------------------------------------------------------------------------
case "$variante" in
  pagbank) variantes=(pagbank); tarefas=(assemblePagbankDebug) ;;
  tablet) variantes=(tablet); tarefas=(assembleTabletDebug) ;;
  all) variantes=(pagbank tablet); tarefas=(assemblePagbankDebug assembleTabletDebug) ;;
esac

# Apaga a saída antiga das variantes pedidas: um APK de um build anterior nunca pode passar por novo.
for v in "${variantes[@]}"; do
  rm -rf "android/app/build/outputs/apk/$v/debug"
done

echo "-> compilando: ${tarefas[*]}"
# Em segundo plano só para guardar o pid: se este script for interrompido, `limpar` encerra o Gradle.
sem_trava "$gradle_cmd" -p android --no-daemon ${gradle_props[@]+"${gradle_props[@]}"} "${tarefas[@]}" &
pid_gradle=$!
codigo_gradle=0
wait "$pid_gradle" || codigo_gradle=$?
pid_gradle=""
[ "$codigo_gradle" -eq 0 ] || falha "o Gradle falhou (código $codigo_gradle); apk/ ficou como estava"

# Cada variante pedida precisa ter exatamente um APK, não vazio, antes de qualquer coisa ir para apk/.
# Os arquivos vão primeiro para uma pasta de versão nova em .apk-releases/, que ainda não aparece em apk/.
mkdir -p "$raiz/.apk-releases"
staging="$(mktemp -d "$raiz/.apk-releases/r.XXXXXX")"
for v in "${variantes[@]}"; do
  saida="android/app/build/outputs/apk/$v/debug"
  achados=()
  for f in "$saida"/*.apk; do
    [ -f "$f" ] && achados+=("$f")
  done
  [ "${#achados[@]}" -eq 1 ] || falha "esperava 1 APK da variante $v em $saida e achei ${#achados[@]}; apk/ ficou como estava"
  [ -s "${achados[0]}" ] || falha "o APK da variante $v está vazio (${achados[0]}); apk/ ficou como estava"
  cp "${achados[0]}" "$staging/tchefood-$v-debug.apk"
done

# Tudo validado: apk/ é um link simbólico para a pasta da versão atual e a troca é uma única renomeação
# (rename do link novo sobre o antigo), atômica no Linux e no macOS: quem lê apk/ vê sempre o conjunto anterior
# inteiro ou o novo inteiro, nunca apk/ ausente nem um conjunto misto, mesmo se o processo morrer a qualquer momento.
chmod 755 "$staging"
nome="$(basename "$staging")"
if [ -d "$raiz/apk" ] && [ ! -L "$raiz/apk" ]; then
  # apk/ de uma versão antiga do script era uma pasta de verdade: migra uma única vez para o formato de link.
  # Uma pasta não pode ser trocada por um link numa operação só; se o processo morrer entre as duas linhas abaixo,
  # a próxima execução devolve o link para esse mesmo conjunto logo no início (ver acima), sem apagá-lo.
  mv "$raiz/apk" "$raiz/.apk-releases/legado.$$" || falha "não consegui migrar o apk/ antigo; nada foi alterado"
  ln -s ".apk-releases/legado.$$" "$raiz/apk" || falha "não consegui migrar o apk/ antigo"
fi
antes=""
if [ -L "$raiz/apk" ]; then antes="$(basename "$(readlink "$raiz/apk")")"; fi
# A versão que sai de apk/ vira a "anterior" ANTES da troca: quem já abriu apk/ (um download em andamento)
# continua lendo a pasta dela até a próxima publicação, que é quando ela sai.
if [ -n "$antes" ]; then
  link_ant="$raiz/.apk-link.ant.$$"
  ln -s ".apk-releases/$antes" "$link_ant" || falha "não consegui preparar o link da versão anterior; nada foi alterado"
  perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$link_ant" "$raiz/.apk-anterior" \
    || falha "não consegui guardar a versão anterior; nada foi alterado"
  link_ant=""
fi
link_novo="$raiz/.apk-link.$$"
ln -s ".apk-releases/$nome" "$link_novo" || falha "não consegui preparar o link do novo apk/; o conjunto anterior foi mantido"
perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$link_novo" "$raiz/apk" \
  || falha "não consegui publicar o novo apk/; o conjunto anterior foi mantido"
link_novo=""
staging=""
# Ficam a versão nova e a anterior; as mais velhas saem.
manter_so_atual_e_anterior
for v in "${variantes[@]}"; do
  echo "OK: apk/tchefood-$v-debug.apk"
done

echo
echo "Pronto. No Cloud Shell, baixe com:"
for v in "${variantes[@]}"; do
  echo "  cloudshell download apk/tchefood-$v-debug.apk"
done
