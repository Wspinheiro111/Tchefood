#!/usr/bin/env bash
# Gera o APK do app Android do Tchê Food sem depender do GitHub Actions.
# Serve no Google Cloud Shell (grátis), em Linux, no Mac e no WSL do Windows.
#
#   bash scripts/build-apk.sh              # os dois APKs: pagbank e tablet
#   bash scripts/build-apk.sh pagbank      # só a Moderninha Smart
#   bash scripts/build-apk.sh tablet       # só celular/tablet
#   TCHEFOOD_APP_URL=https://app.exemplo.com.br bash scripts/build-apk.sh
#
# Sem chave, o APK é debug (tchefood-<variante>-debug.apk). Com a chave oficial do Tchê Food, é release assinado
# (tchefood-<variante>.apk), que instala por cima do anterior em qualquer máquina que gere com a mesma chave:
#   TCHEFOOD_KEYSTORE=~/chave/tchefood-release.jks bash scripts/build-apk.sh
# O script pergunta a senha da chave sem mostrar na tela. Ela nunca vai em comando nem em variável de ambiente
# (sem terminal: TCHEFOOD_KEYSTORE_PASSWORD_FILE aponta para um arquivo só com a senha). Opcionais:
# TCHEFOOD_KEY_ALIAS (padrão "tchefood"), TCHEFOOD_VERSION_CODE=N (número da versão, no lugar da contagem de
# commits) e TCHEFOOD_PRIMEIRO_RELEASE=1 (só no primeiro release de uma chave). Detalhes em docs/apk-release.md.
#
# Faz, nessa ordem: confere Java e Node, baixa o SDK Android e o Gradle se faltarem
# (em ~/.cache/tchefood-android, nunca dentro do projeto) e confere o SHA-256 de cada download, roda
# `npm ci && npm run build`, compila, assina (release), confere assinatura, certificado, pacote e versão de cada
# APK e só então deixa os APKs em ./apk/ (só os desta execução: os antigos saem, e se qualquer etapa falhar a
# pasta fica como estava; apk/ é um link para a versão atual, trocado de uma vez, e a versão anterior fica até a
# publicação seguinte). O APK instala direto na maquininha ou no tablet (fontes desconhecidas ou `adb install`).
# A versão (versionCode) é a contagem de commits do git; release só publica versão maior que a última publicada
# com a mesma chave (ou a mesma versão de novo, quando o APK é idêntico, byte a byte, ao já publicado).
set -euo pipefail
# `bash -a` (ou SHELLOPTS=allexport herdado) exportaria toda variável criada aqui, inclusive a que guarda a senha
# da chave, para todo programa que o build chama: desliga antes de criar qualquer variável.
set +a
# Um SHELLOPTS que veio exportado do ambiente seria reexportado com as opções deste script (errexit, nounset,
# pipefail) para todo programa filho: os lançadores do SDK (apksigner, sdkmanager) são scripts bash e param com
# elas. As opções valem só aqui.
export -n SHELLOPTS 2>/dev/null || true
# O bash mantém exportada uma variável que já veio exportada do ambiente, mesmo depois de receber outro valor. Se
# quem chama tiver, por acaso ou de propósito, uma variável com o nome de uma das internas abaixo, o valor novo
# (a senha, o caminho da chave) seguiria para todo programa filho. Por isso esses nomes são apagados antes de
# serem usados: daqui em diante são variáveis só deste script.
builtin unset chave_arquivo chave_alias chave_senha_arquivo chave_senha senha_no_ambiente registro motivo cert_chave \
  chave_pasta tty_antes

# --- Chave de release: o que veio pelo ambiente sai do ambiente antes de qualquer outro comando -------------
# Daqui para baixo o script chama curl, unzip, sdkmanager, npm e Gradle, que rodam código de terceiros e herdam o
# ambiente. Por isso, antes de rodar qualquer programa: o caminho da chave, o alias e o caminho do arquivo da senha
# passam para variáveis internas (não exportadas) e saem do ambiente. A senha não é aceita pelo ambiente: se
# TCHEFOOD_KEYSTORE_PASSWORD ou TCHEFOOD_KEY_PASSWORD existir (ou as ORG_GRADLE_PROJECT_TCHEFOOD_* que uma versão
# anterior deste script entregava ao Gradle), o script para (mais abaixo), e a variável já saiu daqui. Nenhum
# programa de terceiros (curl, unzip, sdkmanager, npm, Gradle) recebe caminho de chave, de arquivo de senha, nem
# senha. O caminho da chave vai só para quem precisa abrir a chave ou o registro ao lado dela (keytool, apksigner
# e o programa do registro de releases, mais abaixo), e a senha só para o keytool e o apksigner, pela entrada padrão.
chave_arquivo="${TCHEFOOD_KEYSTORE:-}"
chave_alias="${TCHEFOOD_KEY_ALIAS:-tchefood}"
chave_senha_arquivo="${TCHEFOOD_KEYSTORE_PASSWORD_FILE:-}"
# ${VAR:+1} vale "1" se a variável tem valor, sem nunca escrever o valor (nem num rastro de `bash -x`).
senha_no_ambiente="${TCHEFOOD_KEYSTORE_PASSWORD:+1}${TCHEFOOD_KEY_PASSWORD:+1}${ORG_GRADLE_PROJECT_TCHEFOOD_KEYSTORE_PASSWORD:+1}${ORG_GRADLE_PROJECT_TCHEFOOD_KEY_PASSWORD:+1}"
unset TCHEFOOD_KEYSTORE TCHEFOOD_KEY_ALIAS TCHEFOOD_KEYSTORE_PASSWORD_FILE TCHEFOOD_KEYSTORE_PASSWORD \
  TCHEFOOD_KEY_PASSWORD ORG_GRADLE_PROJECT_TCHEFOOD_KEYSTORE_FILE ORG_GRADLE_PROJECT_TCHEFOOD_KEYSTORE_PASSWORD \
  ORG_GRADLE_PROJECT_TCHEFOOD_KEY_ALIAS ORG_GRADLE_PROJECT_TCHEFOOD_KEY_PASSWORD || true
chave_senha=""

# Certificado da chave oficial do Tchê Food (SHA-256 do certificado em DER; o mesmo número que o
# `apksigner verify --print-certs` mostra). É informação pública (vai dentro de todo APK assinado) e o certificado
# inteiro está em android/tchefood-release-cert.pem. Release só é assinado e publicado com esta chave: não existe
# variável que troque este valor. Trocar de chave exige um PR que troque a constante e o certificado, e obriga a
# desinstalar o app de todos os aparelhos.
CERT_OFICIAL_SHA256="a247689aa296179b31e45b67679c8194609c4d93f41e554bc6644b28896ab64f"
# Último versionCode publicado com a chave oficial antes de existir o registro de releases (mais abaixo): os APKs
# 0.1.364, de 26/11/2026. Nenhum release novo sai com número igual ou menor, mesmo se o registro se perder.
RELEASE_PISO=364

# SHA-256 de cada download: o arquivo que não confere é apagado antes de descompactar e o build para. Trocar a
# versão exige trocar o SHA-256 junto. De onde vem cada valor (também em docs/apk-release.md):
#  - commandline-tools 12.0 (build 11076708): desta versão o Google publica o tamanho e o SHA-1, no índice do SDK
#    (https://dl.google.com/android/repository/repository2-3.xml, pacote "cmdline-tools;12.0"):
#      linux: 153607504 bytes, SHA-1 d313adb7aedccf6cf0cfca51ec180f0059f5f8f8
#      mac:   153607488 bytes, SHA-1 37fb7dd41005b3b4ca6ea48ac27074b6fc4e3236
#    O Google não publica o SHA-256 dela. Os dois SHA-256 abaixo foram calculados por nós em 26/11/2026 sobre os
#    arquivos baixados de dl.google.com, que conferem com esse tamanho e esse SHA-1.
#  - Gradle 8.7: SHA-256 publicado pelo Gradle em https://gradle.org/release-checksums/#8.7 (linha "Binary-only
#    (-bin) ZIP"); o arquivo baixado de services.gradle.org dá o mesmo valor.
CMDLINE_TOOLS_VERSION="11076708"
CMDLINE_TOOLS_SHA256_LINUX="2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258"
CMDLINE_TOOLS_SHA256_MAC="7bc5c72ba0275c80a8f19684fb92793b83a6b5c94d4d179fc5988930282d7e64"
GRADLE_VERSION="8.7"
GRADLE_SHA256="544c35d6bd849ae8a5ed0bcea39ba677dc40f49df7d1835561582da2009b961d"
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

if [ -n "$senha_no_ambiente" ]; then
  falha "a senha da chave não entra pelo ambiente (TCHEFOOD_KEYSTORE_PASSWORD, TCHEFOOD_KEY_PASSWORD ou as ORG_GRADLE_PROJECT_TCHEFOOD_* de senha): variável de ambiente é herdada por todo programa que o build chama e, digitada no comando, fica no histórico do terminal. Tire a variável do ambiente e rode de novo só com TCHEFOOD_KEYSTORE: o script pergunta a senha sem mostrar na tela. Sem terminal, use TCHEFOOD_KEYSTORE_PASSWORD_FILE (docs/apk-release.md). Nada foi alterado."
fi

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

# Comandos rápidos de consulta (java -version, node -v, gradle --version) rodam sem o descritor 9.
sem_trava() { "$@" 9>&-; }

# Comandos longos que escrevem no projeto ou no cache (downloads, unzip, sdkmanager e licenças, npm, Gradle) rodam sob um
# supervisor (perl), iniciado direto por este bash, sem subshell no meio:
#  - o supervisor fica com o descritor 9, então a trava continua presa enquanto o comando existir, mesmo se este
#    bash morrer com kill -9: outra execução nunca roda ao mesmo tempo que um Gradle ou npm que ainda escreve;
#  - o comando roda sem o descritor 9 (um daemon que sobreviva ao build não segura a trava) e no mesmo grupo de
#    processos deste bash (Ctrl-C ou um kill no grupo inteiro também o alcançam);
#  - se este bash receber TERM/INT/HUP, ou morrer (o pai do supervisor muda), o supervisor encerra o comando e
#    todos os descendentes dele (TERM e, 10 s depois, KILL), espera e só então sai, soltando a trava.
supervisor_pl='
use strict; use warnings; use POSIX ();
my $pai = getppid();
my $pid = fork();
defined $pid or exit 125;
if ($pid == 0) {
  POSIX::close(9);
  exec { $ARGV[0] } @ARGV;
  print STDERR "ERRO: nao consegui executar $ARGV[0]: $!\n";
  POSIX::_exit(127);
}
my $parar = 0;
$SIG{$_} = sub { $parar = 1 } for qw(TERM INT HUP);
sub dorme { select(undef, undef, undef, $_[0]) }
sub descendentes {
  my %filhos;
  open(my $ps, "-|", "ps", "-A", "-o", "pid=", "-o", "ppid=") or return ();
  while (<$ps>) { my ($p, $pp) = split; push @{ $filhos{$pp} }, $p if defined $pp }
  close($ps);
  my @fila = ($pid); my @todos;
  while (@fila) { for my $f (@{ $filhos{ shift @fila } || [] }) { push @todos, $f; push @fila, $f } }
  return @todos;
}
my $st;
while (1) {
  if (waitpid($pid, POSIX::WNOHANG()) == $pid) { $st = $?; last }
  last if $parar || getppid() != $pai;
  dorme(0.05);
}
exit(($st & 127) ? 128 + ($st & 127) : $st >> 8) if defined $st;
my %alvos = map { $_ => 1 } descendentes();
kill("TERM", $pid, keys %alvos);
for (1 .. 200) {
  $alvos{$_} = 1 for descendentes();
  if (!defined $st && waitpid($pid, POSIX::WNOHANG()) == $pid) { $st = $? }
  delete $alvos{$_} for grep { !kill(0, $_) } keys %alvos;
  last if defined $st && !%alvos;
  dorme(0.05);
}
$alvos{$_} = 1 for descendentes();
kill("KILL", (defined $st ? () : $pid), keys %alvos);
waitpid($pid, 0) unless defined $st;
exit(143);
'
pid_filho=""
supervisionado() {
  local codigo=0
  # Em segundo plano só para este bash poder atender TERM/INT/HUP na hora (o `wait` é interrompido pelo sinal).
  perl -e "$supervisor_pl" "$@" &
  pid_filho=$!
  wait "$pid_filho" || codigo=$?
  pid_filho=""
  return "$codigo"
}

# Publicação interrompida (kill -9) depois de .apk-pendente: se apk/ já aponta para a versão nova, a que saiu
# (guardada em .apk-pendente) vira a anterior, como a publicação teria feito; se apk/ ainda aponta para ela, nada
# mudou e o registro pendente só sai. Assim a versão que acabou de sair de apk/ nunca é apagada como sobra.
resolver_pendente() {
  [ -L "$raiz/.apk-pendente" ] || return 0
  local pendente atual=""
  pendente="$(basename "$(readlink "$raiz/.apk-pendente")")"
  if [ -L "$raiz/apk" ]; then atual="$(basename "$(readlink "$raiz/apk")")"; fi
  if [ "$pendente" != "$atual" ] && [ -d "$raiz/.apk-releases/$pendente" ]; then
    perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$raiz/.apk-pendente" "$raiz/.apk-anterior"
  else
    rm -f "$raiz/.apk-pendente"
  fi
}

# Nome da pasta de versão para a qual apk/ aponta agora (vazio se apk/ não é um link).
apk_atual() {
  if [ -L "$raiz/apk" ]; then basename "$(readlink "$raiz/apk")"; fi
}

staging=""
versao_nova=""
link_novo=""
link_ant=""
tty_antes=""

limpar() {
  local codigo=$?
  trap - EXIT
  # Um segundo Ctrl-C ou kill enquanto a limpeza roda não a interrompe: senão o script sairia com erro com apk/
  # já trocado, ou deixaria a pasta da versão não publicada para trás. A limpeza é curta (o supervisor encerra o
  # comando em até 10 s).
  trap '' INT TERM HUP
  # Ctrl-C no meio da pergunta da senha: o terminal volta a mostrar o que é digitado.
  if [ -n "$tty_antes" ]; then stty "$tty_antes" 2>/dev/null || true; fi
  # interrompido (Ctrl-C, kill) no meio de um comando longo: o supervisor encerra o comando e os descendentes e só sai
  # depois disso; a trava só é solta quando nenhum processo desta execução sobrou
  if [ -n "$pid_filho" ]; then kill "$pid_filho" 2>/dev/null || true; wait "$pid_filho" 2>/dev/null || true; fi
  if [ -n "$link_novo" ]; then rm -f "$link_novo"; fi
  if [ -n "$link_ant" ]; then rm -f "$link_ant"; fi
  # Publicado é publicado. O que decide é para onde apk/ aponta de verdade, não uma variável: se apk/ já é a
  # versão desta execução, a pasta dela fica e o resultado é sucesso, mesmo que um sinal ou um erro de escrita na
  # tela tenha chegado logo depois da troca. Senão, a pasta da versão que não foi publicada sai.
  if [ -n "$versao_nova" ] && [ "$(apk_atual)" = "$versao_nova" ]; then
    codigo=0
  elif [ -n "$staging" ]; then
    rm -rf "$staging"
  fi
  resolver_pendente || true
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
resolver_pendente || falha "não consegui concluir a publicação interrompida (.apk-pendente)"
# Mantém a versão atual e a anterior (e a pendente, se houver); apaga o resto (builds que morreram antes de publicar).
manter_so_atual_e_anterior() {
  local atual="" anterior="" pendente="" r n
  if [ -L "$raiz/apk" ]; then atual="$(basename "$(readlink "$raiz/apk")")"; fi
  if [ -L "$raiz/.apk-anterior" ]; then anterior="$(basename "$(readlink "$raiz/.apk-anterior")")"; fi
  if [ -L "$raiz/.apk-pendente" ]; then pendente="$(basename "$(readlink "$raiz/.apk-pendente")")"; fi
  for r in "$raiz"/.apk-releases/*; do
    [ -e "$r" ] || continue
    n="$(basename "$r")"
    [ "$n" = "$atual" ] || [ "$n" = "$anterior" ] || [ "$n" = "$pendente" ] || rm -rf "$r"
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
# Número da versão escolhido à mão (no lugar da contagem de commits): é o caminho para seguir em frente quando a
# contagem ficou igual ou menor que a do último release publicado.
if [ -n "${TCHEFOOD_VERSION_CODE:-}" ]; then
  case "$TCHEFOOD_VERSION_CODE" in
    0*|*[!0-9]*) falha "TCHEFOOD_VERSION_CODE precisa ser um número inteiro de 1 a 2100000000, sem zero à esquerda" ;;
  esac
  { [ "${#TCHEFOOD_VERSION_CODE}" -le 10 ] && [ "$TCHEFOOD_VERSION_CODE" -le 2100000000 ]; } \
    || falha "TCHEFOOD_VERSION_CODE precisa ser um número inteiro de 1 a 2100000000"
  gradle_props+=("-PTCHEFOOD_VERSION_CODE=$TCHEFOOD_VERSION_CODE")
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_de() { sem_trava sha256sum "$1" | awk '{print $1}'; }
  sha256_entrada() { sem_trava sha256sum | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_de() { sem_trava shasum -a 256 "$1" | awk '{print $1}'; }
  sha256_entrada() { sem_trava shasum -a 256 | awk '{print $1}'; }
else
  falha "sha256sum ou shasum não encontrado (usado para conferir os downloads)."
fi

baixar() { # url destino sha256
  echo "-> baixando $1"
  rm -f "$2.part"
  supervisionado curl -fL --retry 3 --retry-delay 2 -o "$2.part" "$1" || falha "falha ao baixar $1"
  local achado
  achado="$(sha256_de "$2.part")"
  if [ "$achado" != "$3" ]; then
    rm -f "$2.part"
    falha "o arquivo baixado de $1 não confere (SHA-256 $achado, esperado $3); nada foi instalado"
  fi
  mv "$2.part" "$2"
}

# --- Chave de release (opcional) ---------------------------------------------------------------
# Release = TCHEFOOD_KEYSTORE apontando para a chave oficial. A assinatura NÃO passa pelo Gradle: o Gradle gera o
# APK sem assinatura e quem assina é o apksigner, mais abaixo, recebendo a senha só pela entrada padrão. Assim a
# senha nunca está no ambiente, na linha de comando nem em arquivo temporário, e só dois programas a recebem: o
# keytool (aqui, para conferir a chave antes de compilar) e o apksigner (para assinar). curl, unzip, sdkmanager,
# npm, Gradle, zipalign e aapt2 nunca a veem.
#
# Registro de releases: arquivo de texto ao lado da chave (<chave>.releases.tsv), uma linha por APK publicado
# (variante, versionCode, versionName, SHA-256 do APK, data). É ele que garante que o número da versão só sobe:
# o Android recusa instalar por cima um APK com versionCode menor, e a contagem de commits sozinha não garante
# isso (outro branch, número escolhido à mão). Regras, para cada APK desta execução:
#  - número menor que o maior já registrado (de qualquer variante): recusa;
#  - número já registrado para a variante: só passa se o APK for idêntico ao registrado (mesmo SHA-256), e aí
#    nada é gravado; conteúdo diferente com o mesmo número: recusa;
#  - número já registrado (na outra variante) com outro versionName, isto é, de outro commit: recusa;
#  - número novo: tem de ser maior que RELEASE_PISO, e a linha é gravada ANTES da publicação.
# A linha gravada amarra o número ao APK. Se a publicação falhar depois (ou o processo morrer), a linha fica: o
# mesmo APK ainda passa, e um diferente pede um número maior. Release publicado sem linha não existe.
# Conferir e gravar acontecem num processo só (perl), com o arquivo travado (flock): duas cópias do projeto que
# publiquem com a mesma chave ao mesmo tempo não gravam o mesmo número para APKs diferentes. A gravação é uma
# escrita só, levada ao disco e relida; se falhar no meio (disco cheio), o arquivo volta ao tamanho de antes.
# É uma trava contra engano de quem gera o release, não contra quem tem a chave e edita o arquivo.
#   uso: conferir|gravar <registro> <primeiro 0|1> <piso> [variante versionCode versionName sha256]...
#   saída 0 = aceito; 3 = recusado por uma regra; 4 = registro fora do formato; 5 = trava ou gravação.
#   O motivo da recusa sai em uma linha, na saída padrão.
registro_pl='
use strict; use warnings; use Fcntl qw(:flock :seek); use IO::Handle; use POSIX ();
my ($modo, $arq, $primeiro, $piso, @novo) = @ARGV;
my $criou = 0;
sub sair { my ($c, $m) = @_; unlink($arq) if $criou && -z $arq; print "$m\n"; exit $c }
defined $piso && $piso =~ /\A[0-9]+\z/ && defined $modo
  && ($modo eq "conferir" ? !@novo : $modo eq "gravar" && @novo && @novo % 4 == 0)
  or sair(5, "uso incorreto do registro de releases");
my $cab = "# Tchê Food: releases publicados com esta chave (variante, versionCode, versionName, SHA-256 do APK, data UTC). Não edite: guarde este arquivo junto da chave.\n";
my (%sha, %nome); my ($max, $entradas) = (0, 0);
sub ler {
  my ($txt) = @_;
  return if $txt eq "";
  substr($txt, -1) eq "\n"
    or sair(4, "o registro de releases está fora do formato ($arq): a última linha não termina com fim de linha (arquivo cortado ou editado à mão).");
  my $n = 0;
  my @linhas = split /\n/, $txt, -1; pop @linhas;   # o último pedaço é o vazio depois do fim de linha final
  for my $l (@linhas) {
    $n++;
    next if $l =~ /\A#[^\r]*\z/;
    my ($v, $c, $nm, $s) = $l =~ /\A(pagbank|tablet)\t([1-9][0-9]{0,9})\t([0-9A-Za-z._+-]{1,64})\t([0-9a-f]{64})\t[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\z/
      or sair(4, "o registro de releases está fora do formato ($arq): linha $n (linha em branco, fim de linha do Windows ou campo errado).");
    $c <= 2100000000 or sair(4, "o registro de releases está fora do formato ($arq): linha $n, versionCode fora da faixa.");
    $c >= $max or sair(4, "o registro de releases está fora do formato ($arq): linha $n, versionCode $c menor que o de uma linha anterior ($max).");
    exists $sha{"$v\t$c"} and sair(4, "o registro de releases está fora do formato ($arq): linha $n, $v $c aparece duas vezes.");
    exists $nome{$c} && $nome{$c} ne $nm and sair(4, "o registro de releases está fora do formato ($arq): linha $n, versionCode $c com dois versionName.");
    $sha{"$v\t$c"} = $s; $nome{$c} = $nm; $max = $c; $entradas++;
  }
}
sub primeiro_ou_nao {
  if ($entradas == 0) {
    $primeiro or sair(3, "não achei release nenhum registrado para esta chave ($arq). Se já houve release com ela, recupere esse arquivo (ele é guardado junto da chave): sem ele o script não tem como recusar uma versão que não instala por cima da que está nas lojas. Se este é mesmo o primeiro release com este registro, rode de novo com TCHEFOOD_PRIMEIRO_RELEASE=1 (o número da versão terá de ser maior que $piso).");
  } else {
    $primeiro and sair(3, "TCHEFOOD_PRIMEIRO_RELEASE=1 só vale quando ainda não há release registrado, e $arq já tem $entradas. Tire a variável e rode de novo.");
  }
}
my $existia = (-e $arq || -l $arq) ? 1 : 0;
if ($existia) { -f $arq && !-l $arq or sair(4, "o registro de releases está fora do formato ($arq): não é um arquivo comum.") }
if ($modo eq "conferir") {
  # -w perguntando ao sistema (access): um pendrive ou pasta montados só para leitura respondem que não, e o
  # release para aqui, em segundos, em vez de só descobrir na hora de gravar, depois do build inteiro.
  use filetest "access";
  my $txt = "";
  if ($existia) {
    open(my $r, "<", $arq) or sair(5, "não consigo ler o registro de releases ($arq): $!.");
    binmode($r); { local $/; $txt = <$r>; } $txt = "" unless defined $txt; close($r);
    -w $arq or sair(5, "o registro de releases não aceita escrita ($arq).");
  } else {
    my ($pasta) = $arq =~ m{\A(.*)/[^/]*\z};
    defined $pasta && -d $pasta && -w $pasta
      or sair(5, "a pasta da chave não aceita escrita, e o registro de releases fica nela ($arq). Copie a chave para uma pasta onde você possa escrever.");
  }
  ler($txt); primeiro_ou_nao();
  exit 0;
}
open(my $fh, "+>>", $arq) or sair(5, "não consegui abrir o registro de releases ($arq) para gravar: $!.");
binmode($fh);
$criou = !$existia;
my $pegou = 0;
for (1 .. 300) {   # até 30 s: a parte travada dura milissegundos
  if (flock($fh, LOCK_EX | LOCK_NB)) { $pegou = 1; last }
  $!{EWOULDBLOCK} || $!{EAGAIN} or sair(5, "a pasta do registro de releases não aceita trava de arquivo (flock: $!): $arq.");
  select(undef, undef, undef, 0.1);
}
$pegou or sair(5, "outro release com esta chave está usando o registro há mais de 30 s ($arq).");
# O arquivo travado tem de ser o que está no caminho agora: outro release (o primeiro com esta chave, recusado por
# uma regra) pode ter apagado o registro vazio que criou enquanto este esperava a trava. Gravar no arquivo apagado
# perderia a linha; aqui para, sem tocar em nada, e a próxima execução segue normalmente.
{
  my @meu = stat($fh); my @la = stat($arq);
  unless (@meu && @la && $meu[0] == $la[0] && $meu[1] == $la[1]) {
    $criou = 0;
    sair(5, "o registro de releases foi trocado por outro release enquanto este esperava a vez ($arq). Rode de novo.");
  }
}
# A trava tem de excluir outro processo de verdade: há pastas (de rede) onde o flock responde que sim e não trava.
my $pid = fork(); defined $pid or sair(5, "não consegui conferir a trava do registro de releases (fork: $!).");
if ($pid == 0) { open(my $t, "<", $arq) or POSIX::_exit(2); POSIX::_exit(flock($t, LOCK_EX | LOCK_NB) ? 0 : 1) }
waitpid($pid, 0);
($? >> 8) == 1 or sair(5, "a trava do registro de releases não exclui outro processo nesta pasta ($arq).");
seek($fh, 0, SEEK_SET) or sair(5, "não consegui ler o registro de releases ($arq): $!.");
my $txt = do { local $/; <$fh> }; $txt = "" unless defined $txt;
my $tam = length $txt;
ler($txt); primeiro_ou_nao();
my $agora = POSIX::strftime("%Y-%m-%dT%H:%M:%SZ", gmtime());
my $acrescimo = "";
my @feito;
my $proximo = ($max > $piso ? $max : $piso) + 1;
while (my ($v, $c, $nm, $s) = splice(@novo, 0, 4)) {
  $v =~ /\A(pagbank|tablet)\z/ && $c =~ /\A[1-9][0-9]{0,9}\z/ && $c <= 2100000000 && $nm =~ /\A[0-9A-Za-z._+-]{1,64}\z/ && $s =~ /\A[0-9a-f]{64}\z/
    or sair(5, "os dados do APK da variante $v não servem para o registro de releases.");
  $c >= $max or sair(3, "o release $c da variante $v é mais antigo que o último publicado com esta chave ($max): o Android recusaria a atualização. Gere a partir da main atualizada, ou com TCHEFOOD_VERSION_CODE=$proximo ou maior.");
  exists $nome{$c} && $nome{$c} ne $nm
    and sair(3, "o release $c já foi registrado com esta chave como $nome{$c}, e o APK de agora é $nm (outro commit com o mesmo número). Gere com TCHEFOOD_VERSION_CODE=$proximo ou maior.");
  if (exists $sha{"$v\t$c"}) {
    my $reg = $sha{"$v\t$c"};
    $reg eq $s or sair(3, "já existe um release $c da variante $v publicado com esta chave, e o APK de agora é outro (SHA-256 $s, registrado $reg). Dois APKs diferentes com o mesmo número não se atualizam um pelo outro. Gere com TCHEFOOD_VERSION_CODE=$proximo ou maior.");
    push @feito, "$v $c: já registrado, APK idêntico";
  } else {
    $c > $piso or sair(3, "o release $c da variante $v não é maior que o último publicado antes de existir o registro ($piso), e o registro não tem esse APK. Gere com TCHEFOOD_VERSION_CODE=$proximo ou maior.");
    $acrescimo .= "$v\t$c\t$nm\t$s\t$agora\n"; $sha{"$v\t$c"} = $s; $nome{$c} = $nm;
    push @feito, "$v $c: registrado";
  }
}
if (length $acrescimo) {
  $acrescimo = $cab . $acrescimo if $tam == 0;
  my $ok = eval {
    my $w = syswrite($fh, $acrescimo);
    defined $w && $w == length($acrescimo) or die(($! || "escrita incompleta") . "\n");
    $fh->sync or die "$!\n";
    1;
  };
  if (!$ok) {
    my $e = $@; chomp $e;
    truncate($fh, $tam);
    sair(5, "não consegui gravar o registro de releases ($arq): $e.");
  }
  # Relê por outro descritor: é o que a próxima execução vai ver.
  my $depois;
  if (open(my $r, "<", $arq)) { binmode($r); local $/; $depois = <$r>; close($r) }
  if (!defined $depois || $depois ne $txt . $acrescimo) {
    truncate($fh, $tam);
    sair(5, "o registro de releases relido não confere com o gravado ($arq).");
  }
}
close($fh) or sair(5, "não consegui fechar o registro de releases ($arq): $!.");
print "$_\n" for @feito;
exit 0;
'

tipo="debug"
if [ -n "$chave_arquivo" ]; then
  tipo="release"
  [ -f "$chave_arquivo" ] || falha "TCHEFOOD_KEYSTORE não existe: $chave_arquivo"
  [ -r "$chave_arquivo" ] || falha "não consigo ler TCHEFOOD_KEYSTORE: $chave_arquivo"
  # O registro de releases fica ao lado da chave: a chave tem de ter um caminho só (sem link no meio), senão dois
  # caminhos para a mesma chave teriam dois registros.
  [ ! -L "$chave_arquivo" ] || falha "TCHEFOOD_KEYSTORE é um link simbólico ($chave_arquivo): aponte para o arquivo de verdade (o registro de releases fica ao lado dele)."
  # (só comandos internos do bash: o caminho da chave não vira argumento de nenhum outro programa aqui)
  case "$chave_arquivo" in
    */*) chave_pasta="${chave_arquivo%/*}"; [ -n "$chave_pasta" ] || chave_pasta="/" ;;
    *) chave_pasta="." ;;
  esac
  chave_pasta="$(builtin cd "$chave_pasta" && builtin pwd -P)" || falha "não consigo entrar na pasta de TCHEFOOD_KEYSTORE: $chave_arquivo"
  chave_arquivo="${chave_pasta%/}/${chave_arquivo##*/}"
  # Com `bash -x` cada comando é impresso com as variáveis já trocadas pelo valor: a senha iria para a tela ou o log.
  case "$-" in *x*) falha "release não roda com rastro de comandos (bash -x / set -x): a senha da chave apareceria no rastro. Rode sem -x." ;; esac
  command -v keytool >/dev/null 2>&1 || falha "keytool não encontrado (vem com o JDK; usado para conferir a chave antes de compilar)."

  # Registro de releases: formato e primeiro release conferidos já aqui, antes de pedir a senha e de compilar.
  registro="$chave_arquivo.releases.tsv"
  primeiro=0; [ "${TCHEFOOD_PRIMEIRO_RELEASE:-}" = "1" ] && primeiro=1
  motivo="$(perl -e "$registro_pl" conferir "$registro" "$primeiro" "$RELEASE_PISO" 2>&1)" \
    || falha "$motivo Nada foi alterado."

  # Senha: de um arquivo (automação) ou perguntada no terminal sem aparecer na tela. `read` é do próprio bash
  # (`builtin`: nem uma função de mesmo nome herdada do ambiente entra no lugar): nenhum outro programa participa,
  # e nada vai para o histórico do terminal. A senha é a primeira linha; o fim de linha do Windows (CR) e a marca
  # de UTF-8 que o Bloco de Notas põe no começo do arquivo (BOM) não fazem parte dela.
  if [ -n "$chave_senha_arquivo" ]; then
    [ -f "$chave_senha_arquivo" ] && [ -r "$chave_senha_arquivo" ] \
      || falha "TCHEFOOD_KEYSTORE_PASSWORD_FILE não existe ou não pode ser lido: $chave_senha_arquivo"
    IFS= builtin read -r chave_senha < "$chave_senha_arquivo" || [ -n "$chave_senha" ] \
      || falha "TCHEFOOD_KEYSTORE_PASSWORD_FILE está vazio: $chave_senha_arquivo"
  elif [ -t 0 ] && [ -t 2 ]; then
    # o estado do terminal fica guardado: se a leitura for interrompida, a saída do script o devolve (limpar)
    tty_antes="$(stty -g 2>/dev/null || true)"
    IFS= builtin read -r -s -p "Senha da chave do Tchê Food (não aparece na tela): " chave_senha \
      || { echo >&2; falha "não consegui ler a senha da chave (leitura cancelada)"; }
    tty_antes=""
    echo >&2
  else
    falha "sem terminal para perguntar a senha da chave. Rode num terminal, ou aponte TCHEFOOD_KEYSTORE_PASSWORD_FILE para um arquivo só com a senha (docs/apk-release.md)."
  fi
  # Os dois caracteres ficam em variáveis, como o $nl mais abaixo, para não depender de como cada versão do
  # bash lê $'...' dentro de aspas.
  marca_bom=$'\xef\xbb\xbf'; fim_cr=$'\r'
  chave_senha="${chave_senha#"$marca_bom"}"
  chave_senha="${chave_senha%"$fim_cr"}"
  [ -n "$chave_senha" ] || falha "a senha da chave veio vazia"

  # Confere a senha e a chave agora, em segundos, em vez de descobrir depois de compilar tudo: o certificado que
  # sai do arquivo da chave tem de ser o oficial. Chave errada não assina nada.
  cert_chave="$(builtin printf '%s\n' "$chave_senha" | sem_trava keytool -exportcert -keystore "$chave_arquivo" -alias "$chave_alias" 2>/dev/null | sha256_entrada)" \
    || falha "não consegui abrir a chave $chave_arquivo com o alias \"$chave_alias\": senha errada, alias que não existe ou arquivo que não é uma chave. Nada foi compilado."
  [ "$cert_chave" = "$CERT_OFICIAL_SHA256" ] \
    || falha "esta não é a chave oficial do Tchê Food: o certificado dela é $cert_chave e o oficial é $CERT_OFICIAL_SHA256. Um APK assinado com outra chave não instala por cima do que está nos aparelhos. Nada foi compilado."
  echo "-> chave oficial conferida (certificado $CERT_OFICIAL_SHA256)"
elif [ -n "$chave_senha_arquivo" ]; then
  falha "TCHEFOOD_KEYSTORE_PASSWORD_FILE sem TCHEFOOD_KEYSTORE: diga onde está o arquivo da chave"
fi

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
    Linux) so="linux"; sha_cmdline="$CMDLINE_TOOLS_SHA256_LINUX" ;;
    Darwin) so="mac"; sha_cmdline="$CMDLINE_TOOLS_SHA256_MAC" ;;
    *) falha "sistema não suportado: $(uname -s). No Windows use o WSL ou o Android Studio." ;;
  esac
  zip="$CACHE/cmdline-tools-$so.zip"
  baixar "https://dl.google.com/android/repository/commandlinetools-$so-${CMDLINE_TOOLS_VERSION}_latest.zip" "$zip" "$sha_cmdline"
  rm -rf "$CACHE/cmdline-tools-extract"
  supervisionado unzip -q "$zip" -d "$CACHE/cmdline-tools-extract"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$CACHE/cmdline-tools-extract/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$CACHE/cmdline-tools-extract" "$zip"
fi

if [ ! -d "$ANDROID_HOME/platforms/$PLATFORM" ] || [ ! -d "$ANDROID_HOME/build-tools/$BUILD_TOOLS" ]; then
  echo "-> instalando plataforma $PLATFORM e build-tools $BUILD_TOOLS (aceitando as licenças do Google)"
  # As licenças também rodam sob o supervisor: o pipeline inteiro (sh, yes e sdkmanager) é descendente dele e sai
  # junto se este bash for interrompido ou morrer. O status é o do sdkmanager (o SIGPIPE do `yes` não conta).
  supervisionado sh -c 'yes | "$1" --licenses >/dev/null' sh "$sdkmanager"
  supervisionado "$sdkmanager" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" "platform-tools"
fi

# --- Gradle ----------------------------------------------------------------------------------
if command -v gradle >/dev/null 2>&1 && sem_trava gradle --version 2>/dev/null | grep -qx "Gradle $GRADLE_VERSION"; then
  gradle_cmd="gradle"
else
  gradle_dir="$CACHE/gradle-$GRADLE_VERSION"
  if [ ! -x "$gradle_dir/bin/gradle" ]; then
    zip="$CACHE/gradle-$GRADLE_VERSION-bin.zip"
    baixar "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" "$zip" "$GRADLE_SHA256"
    supervisionado unzip -q "$zip" -d "$CACHE"
    rm -f "$zip"
  fi
  gradle_cmd="$gradle_dir/bin/gradle"
fi

# --- Sistema web (vai embutido no APK) -------------------------------------------------------
if [ -z "${TCHEFOOD_APP_URL:-}" ]; then
  echo "-> gerando o sistema web (npm ci && npm run build)"
  supervisionado npm ci
  supervisionado npm run build
  [ -f dist/index.html ] || falha "o build web não gerou dist/index.html"
fi

# --- APK -------------------------------------------------------------------------------------
Tipo="Debug"; [ "$tipo" = "release" ] && Tipo="Release"
case "$variante" in
  pagbank) variantes=(pagbank) ;;
  tablet) variantes=(tablet) ;;
  all) variantes=(pagbank tablet) ;;
esac
tarefas=()
for v in "${variantes[@]}"; do
  V="$(printf '%s' "${v:0:1}" | tr '[:lower:]' '[:upper:]')${v:1}"
  tarefas+=("assemble$V$Tipo")
done
sufixo=""; [ "$tipo" = "debug" ] && sufixo="-debug"
# applicationId de cada variante (android/app/build.gradle.kts): o APK publicado tem de ser o do app certo.
pacote_esperado() {
  case "$1" in
    pagbank) echo "food.tche.smartpos" ;;
    tablet) echo "food.tche.smartpos.tablet" ;;
  esac
}

ferramentas="$ANDROID_HOME/build-tools/$BUILD_TOOLS"
apksigner="$ferramentas/apksigner"
aapt2="$ferramentas/aapt2"
zipalign="$ferramentas/zipalign"
[ -x "$apksigner" ] || falha "apksigner não encontrado em $apksigner; apk/ ficou como estava"
[ -x "$aapt2" ] || falha "aapt2 não encontrado em $aapt2; apk/ ficou como estava"
if [ "$tipo" = "release" ]; then
  [ -x "$zipalign" ] || falha "zipalign não encontrado em $zipalign; apk/ ficou como estava"
fi
nl=$'\n'
# Uma linha exata dentro de um texto de várias linhas, sem pipe nem programa externo.
tem_linha() { # texto linha
  case "$nl$1$nl" in *"$nl$2$nl"*) return 0 ;; esac
  return 1
}
# Lê a saída do `aapt2 dump badging` só com recursos do bash (sem pipe, sem sed). O aapt2 escreve os valores entre
# aspas simples sem escapar nada; por isso a linha "package:" é lida da esquerda para a direita e recusada se
# sobrar um segundo versionCode= ou versionName= (um versionName com aspas não se passa por outra versão). As
# listas de caracteres são por extenso para não depender do idioma do sistema.
# Resultado em m_pacote, m_codigo, m_nome e m_depuravel ("1" se o APK é depurável); se falhar, o motivo em m_erro.
m_digitos="0123456789"
m_letras="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
ler_metadados() { # texto
  local resto="$1" l linha="" n=0 r r2 p
  m_pacote=""; m_codigo=""; m_nome=""; m_depuravel=""; m_erro=""
  while [ -n "$resto" ]; do
    l="${resto%%"$nl"*}"
    if [ "$l" = "$resto" ]; then resto=""; else resto="${resto#*"$nl"}"; fi
    case "$l" in
      "package:"*) n=$((n + 1)); linha="$l" ;;
      "application-debuggable"*) m_depuravel="1" ;;
    esac
  done
  if [ "$n" -ne 1 ]; then m_erro="esperava 1 linha package: na resposta do aapt2 e achei $n"; return 1; fi
  p="package: name='"
  r="${linha#"$p"}"
  if [ "$r" = "$linha" ]; then m_erro="linha package: fora do formato"; return 1; fi
  m_pacote="${r%%\'*}"; r="${r#*\'}"
  p=" versionCode='"
  r2="${r#"$p"}"
  if [ "$r2" = "$r" ]; then m_erro="versionCode fora do lugar na linha package:"; return 1; fi
  m_codigo="${r2%%\'*}"; r="${r2#*\'}"
  p=" versionName='"
  r2="${r#"$p"}"
  if [ "$r2" = "$r" ]; then m_erro="versionName fora do lugar na linha package:"; return 1; fi
  m_nome="${r2%%\'*}"; r="${r2#*\'}"
  case "$r" in ""|" "*) ;; *) m_erro="texto inesperado depois do versionName"; return 1 ;; esac
  case "$r" in *"versionCode="*|*"versionName="*|*" name="*) m_erro="versionCode ou versionName repetido na linha package:"; return 1 ;; esac
  case "$m_codigo" in ""|0*|*[!$m_digitos]*) m_erro="versionCode que não é número: \"$m_codigo\""; return 1 ;; esac
  if [ "${#m_codigo}" -gt 10 ] || [ "$m_codigo" -gt 2100000000 ]; then m_erro="versionCode fora do limite: $m_codigo"; return 1; fi
  case "$m_nome" in ""|*[!$m_digitos$m_letras._+-]*) m_erro="versionName vazio ou com caractere inesperado: \"$m_nome\""; return 1 ;; esac
  if [ "${#m_nome}" -gt 64 ]; then m_erro="versionName longo demais"; return 1; fi
  return 0
}

# Apaga a saída antiga das variantes pedidas: um APK de um build anterior nunca pode passar por novo.
for v in "${variantes[@]}"; do
  rm -rf "android/app/build/outputs/apk/$v/$tipo"
done

echo "-> compilando ($tipo): ${tarefas[*]}"
codigo_gradle=0
supervisionado "$gradle_cmd" -p android --no-daemon ${gradle_props[@]+"${gradle_props[@]}"} "${tarefas[@]}" || codigo_gradle=$?
[ "$codigo_gradle" -eq 0 ] || falha "o Gradle falhou (código $codigo_gradle); apk/ ficou como estava"

# Tudo daqui até a troca de apk/ acontece numa pasta de versão nova em .apk-releases/, que ainda não aparece em
# apk/: cada variante pedida precisa ter exatamente um APK, não vazio, assinado e conferido, antes de qualquer
# coisa ser publicada. Qualquer falha sai por `falha`, e apk/ fica como estava.
mkdir -p "$raiz/.apk-releases"
staging="$(mktemp -d "$raiz/.apk-releases/r.XXXXXX")"
versao_nova="$(basename "$staging")"
for v in "${variantes[@]}"; do
  saida="android/app/build/outputs/apk/$v/$tipo"
  achados=()
  for f in "$saida"/*.apk; do
    [ -f "$f" ] && achados+=("$f")
  done
  [ "${#achados[@]}" -eq 1 ] || falha "esperava 1 APK da variante $v em $saida e achei ${#achados[@]}; apk/ ficou como estava"
  [ -s "${achados[0]}" ] || falha "o APK da variante $v está vazio (${achados[0]}); apk/ ficou como estava"
  destino="$staging/tchefood-$v$sufixo.apk"
  if [ "$tipo" = "release" ]; then
    # O Gradle entregou o APK sem assinatura (já alinhado). O apksigner é rápido e só escreve na pasta desta
    # execução (.apk-releases/r.*), por isso roda direto, sem o supervisor: é o que permite entregar a senha pela
    # entrada padrão. Ela sai do `printf` do próprio bash (não aparece em lista de processos, não passa por
    # arquivo) e só o apksigner a lê. Os esquemas de assinatura são fixos, os mesmos dos releases já publicados:
    # só o v2 (o app exige Android 7.1 ou mais, onde o v1 não é usado; v3 e v4 não são usados).
    builtin printf '%s\n' "$chave_senha" | sem_trava "$apksigner" sign --ks "$chave_arquivo" --ks-key-alias "$chave_alias" \
      --ks-pass stdin --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled false \
      --v4-signing-enabled false --out "$destino" "${achados[0]}" >/dev/null \
      || falha "não consegui assinar o APK da variante $v; apk/ ficou como estava"
    # Assinar não muda o alinhamento, e mexer no APK depois de assinado quebraria a assinatura: aqui só confere.
    sem_trava "$zipalign" -c 4 "$destino" >/dev/null \
      || falha "o APK assinado da variante $v não passou na conferência de alinhamento (zipalign -c); apk/ ficou como estava"
  else
    cp "${achados[0]}" "$destino"
  fi
done
# A senha não é mais necessária: sai da memória do script antes das conferências e da publicação.
chave_senha=""
unset chave_senha

# Conferência de cada APK pronto, ainda antes da publicação:
#  - assinatura válida, de exatamente um signatário;
#  - release: o certificado do signatário é o oficial (não importa o nome que o certificado traz), a assinatura
#    v2 confere e não há v3 nem v3.1 (nenhuma troca de chave embutida no APK). O script pede só a v2 ao apksigner;
#    a v1 não entra nesta conferência porque, para um app que exige Android 7.1 ou mais, o apksigner não a avalia;
#  - pacote (applicationId) da variante, versionCode numérico e versionName presentes (aapt2 tem de conseguir ler);
#  - mesma versão em todas as variantes desta execução.
certificados=()
resumos=()
codigo_versao=""
nome_versao=""
for v in "${variantes[@]}"; do
  apk="$staging/tchefood-$v$sufixo.apk"
  [ -s "$apk" ] || falha "o APK da variante $v não ficou pronto ($apk); apk/ ficou como estava"
  certs="$(sem_trava "$apksigner" verify -v --print-certs "$apk" 2>/dev/null)" \
    || falha "o APK da variante $v não tem assinatura válida; apk/ ficou como estava"
  # Toda linha de certificado conta, com qualquer prefixo (signatário 2, carimbo de origem, chave rotacionada):
  # o APK do Tchê Food tem uma só, a do "Signer #1".
  signatarios="$(printf '%s\n' "$certs" | grep -c 'certificate SHA-256 digest:' || true)"
  [ "$signatarios" = "1" ] || falha "esperava exatamente 1 signatário no APK da variante $v e achei $signatarios; apk/ ficou como estava"
  tem_linha "$certs" "Number of signers: 1" \
    || falha "esperava exatamente 1 signatário no APK da variante $v e o apksigner não confirma isso; apk/ ficou como estava"
  cert="$(printf '%s\n' "$certs" | sed -n 's/^Signer #1 certificate SHA-256 digest: \([0-9a-f]\{64\}\)$/\1/p')"
  [ -n "$cert" ] || falha "não consegui ler o certificado do APK da variante $v; apk/ ficou como estava"
  if [ "$tipo" = "release" ]; then
    [ "$cert" = "$CERT_OFICIAL_SHA256" ] \
      || falha "o APK de release da variante $v não está assinado com a chave oficial do Tchê Food (certificado $cert, oficial $CERT_OFICIAL_SHA256); apk/ ficou como estava"
    { tem_linha "$certs" "Verified using v2 scheme (APK Signature Scheme v2): true" \
      && tem_linha "$certs" "Verified using v3 scheme (APK Signature Scheme v3): false" \
      && tem_linha "$certs" "Verified using v3.1 scheme (APK Signature Scheme v3.1): false"; } \
      || falha "o APK de release da variante $v não saiu com a assinatura v2 e sem v3/v3.1 (o apksigner mostra outro conjunto de esquemas); apk/ ficou como estava"
  fi

  metadados="$(sem_trava "$aapt2" dump badging "$apk" 2>/dev/null)" \
    || falha "o aapt2 não conseguiu ler o APK da variante $v; apk/ ficou como estava"
  ler_metadados "$metadados" \
    || falha "não consegui ler os dados do APK da variante $v ($m_erro); apk/ ficou como estava"
  [ "$m_pacote" = "$(pacote_esperado "$v")" ] \
    || falha "o APK da variante $v saiu com o pacote \"$m_pacote\" e o esperado é \"$(pacote_esperado "$v")\"; apk/ ficou como estava"
  if [ "$tipo" = "release" ] && [ -n "$m_depuravel" ]; then
    falha "o APK de release da variante $v é depurável (application-debuggable): é um build de debug, e não pode sair assinado com a chave oficial; apk/ ficou como estava"
  fi
  codigo="$m_codigo"; nome_v="$m_nome"
  if [ -z "$codigo_versao" ]; then
    codigo_versao="$codigo"; nome_versao="$nome_v"
  elif [ "$codigo" != "$codigo_versao" ] || [ "$nome_v" != "$nome_versao" ]; then
    falha "as variantes saíram com versões diferentes ($nome_versao, código $codigo_versao, e $nome_v, código $codigo, na $v); apk/ ficou como estava"
  fi
  certificados+=("$v: $cert")
  resumos+=("$v $(sha256_de "$apk")")
done
# A pasta que vai virar apk/ tem exatamente os APKs desta execução, nada a mais.
esperados="$(for v in "${variantes[@]}"; do echo "tchefood-$v$sufixo.apk"; done | LC_ALL=C sort | tr '\n' ' ')"
prontos="$(ls -A "$staging" | LC_ALL=C sort | tr '\n' ' ')"
[ "$prontos" = "$esperados" ] || falha "a pasta da versão nova tem arquivo a mais ou a menos ($prontos); apk/ ficou como estava"

# Release: o número da versão tem de subir em relação ao último release publicado com esta chave (regras junto de
# registro_pl, acima). É a última conferência, e a única que grava alguma coisa fora do projeto: a linha de cada
# APK novo entra no registro aqui, antes de qualquer passo da publicação. Recusou, apk/ fica como estava.
if [ "$tipo" = "release" ]; then
  dados=()
  for r in "${resumos[@]}"; do
    dados+=("${r%% *}" "$codigo_versao" "$nome_versao" "${r#* }")
  done
  motivo="$(perl -e "$registro_pl" gravar "$registro" "$primeiro" "$RELEASE_PISO" "${dados[@]}" 2>&1)" \
    || falha "$motivo apk/ ficou como estava."
  echo "-> registro de releases: $(printf '%s\n' "$motivo" | tr '\n' ';' | sed 's/;$//; s/;/; /g')"
fi

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
# Ordem da publicação, para nenhuma versão que alguém possa estar lendo perder a referência:
#  1. a versão que vai sair de apk/ ganha um registro próprio, .apk-pendente (.apk-anterior não muda ainda);
#  2. apk/ troca para a versão nova;
#  3. só depois da troca, .apk-pendente vira .apk-anterior (uma renomeação), e a anterior antiga sai.
# Se a troca falhar, .apk-anterior continua como estava; se o processo morrer entre as etapas, a próxima execução
# conclui ou desfaz o passo pendente antes de limpar (resolver_pendente, acima).
if [ -n "$antes" ]; then
  link_ant="$raiz/.apk-link.ant.$$"
  ln -s ".apk-releases/$antes" "$link_ant" || falha "não consegui preparar o link da versão anterior; nada foi alterado"
  perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$link_ant" "$raiz/.apk-pendente" \
    || falha "não consegui guardar a versão atual antes da troca; nada foi alterado"
  link_ant=""
fi
link_novo="$raiz/.apk-link.$$"
ln -s ".apk-releases/$nome" "$link_novo" || falha "não consegui preparar o link do novo apk/; o conjunto anterior foi mantido"
perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$link_novo" "$raiz/apk" \
  || falha "não consegui publicar o novo apk/; o conjunto anterior foi mantido"

# --- Publicado ---------------------------------------------------------------------------------------------
# apk/ já é a versão nova e nada mais muda o resultado: daqui em diante só há arrumação e avisos. Um erro em
# qualquer um deles (inclusive escrever numa saída fechada) vira aviso, e nem um sinal muda o código de saída:
# `limpar` devolve sucesso sempre que apk/ aponta para a versão desta execução.
set +eu
set +o pipefail
trap '' PIPE
link_novo=""
staging=""
if [ -n "$antes" ]; then
  perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$raiz/.apk-pendente" "$raiz/.apk-anterior" \
    || echo "AVISO: apk/ já tem a versão nova, mas não consegui registrar a anterior; a próxima execução conclui isso." >&2
fi
# Ficam a versão nova e a anterior; as mais velhas saem.
manter_so_atual_e_anterior
for v in "${variantes[@]}"; do
  echo "OK: apk/tchefood-$v$sufixo.apk"
done
echo "Versão: $nome_versao (código $codigo_versao) ($tipo)"
echo "Certificado (SHA-256), igual em todo build com a mesma chave:"
for c in "${certificados[@]}"; do
  echo "  $c"
done
echo "SHA-256 de cada APK:"
for r in "${resumos[@]}"; do
  echo "  ${r%% *}: ${r#* }"
done
if [ "$tipo" = "release" ]; then
  echo "Registro de releases: $registro (ande com ele junto da chave)"
fi

echo
echo "Pronto. No Cloud Shell, baixe com:"
for v in "${variantes[@]}"; do
  echo "  cloudshell download apk/tchefood-$v$sufixo.apk"
done
exit 0
