import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Testa scripts/build-apk.sh num repositório de mentira: Java, Node, npm, curl, unzip, sdkmanager, Gradle, keytool,
// zipalign, apksigner e aapt2 são substitutos que só imitam a saída. O que está em teste é a validação, a
// assinatura e a troca da pasta apk/, não o Android.
const SCRIPT = resolve(__dirname, 'build-apk.sh');
// Certificado público da chave oficial, versionado no repositório. O SHA-256 dele é calculado aqui, sem ler o
// script: se a constante do script não for a deste certificado, os testes de release falham.
const CERT_OFICIAL_PEM = readFileSync(resolve(__dirname, '..', 'android', 'tchefood-release-cert.pem'), 'utf8');
const CERT_OFICIAL_DER = Buffer.from(CERT_OFICIAL_PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
const DIGEST_OFICIAL = createHash('sha256').update(CERT_OFICIAL_DER).digest('hex');
const sha256 = (dado: string | Buffer) => createHash('sha256').update(dado).digest('hex');
// Certificado de uma chave de mentira que não é a oficial (o keytool falso devolve "certificado-<id>").
const digestDe = (id: string) => (id === 'oficial' ? DIGEST_OFICIAL : sha256(`certificado-${id}`));
const DIGEST_DEBUG = '1'.repeat(64);

// Toda ferramenta falsa grava em FAKE_REG (uma pasta) a linha de comando e o ambiente que recebeu, num arquivo
// <nome>.<pid>.env. keytool e apksigner gravam também o que leram da entrada padrão, em <nome>.stdin.
const REG = `reg() { [ -n "$FAKE_REG" ] || return 0; n="$1"; shift; { printf 'ARGV:'; printf ' %s' "$@"; echo; env; } >> "$FAKE_REG/$n.$$.env"; }
`;
const simples = (nome: string, resto = 'exit 0\n') => `#!/bin/sh\n${REG}reg ${nome} "$@"\n${resto}`;
const pastas: string[] = [];

afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

function executavel(caminho: string, conteudo: string) {
  mkdirSync(join(caminho, '..'), { recursive: true });
  writeFileSync(caminho, conteudo);
  chmodSync(caminho, 0o755);
}

// Gradle falso, controlado por variáveis de ambiente:
//   FAKE_GERAR  variantes que "compilam" (ex.: "pagbank tablet")
//   FAKE_VAZIO  variante cujo APK sai com 0 byte
//   FAKE_FALHAR 1 = termina com erro depois de gerar os arquivos
//   FAKE_BUILD  texto gravado em cada APK, para distinguir um build do outro
//   FAKE_FUNDO  arquivo onde grava o pid de um processo deixado em segundo plano (fora do grupo, vivo 30 s,
//               herdando todo descritor aberto que o Gradle recebeu), como um daemon que sobrevive ao build
//   FAKE_PID    arquivo onde grava o próprio pid
//   FAKE_DEPOIS segundos que espera (depois da pausa) antes de gravar FAKE_ESCRITA, como um Gradle ainda escrevendo
//   FAKE_GRADLE_VERSAO versão que o "gradle --version" responde (padrão 8.7, a que o script exige)
// No debug o APK sai "assinado" (como o Gradle de verdade faz com a chave de debug) e o conteúdo é só o texto do
// build. No release sai app-<variante>-release-unsigned.apk, com a linha SEM-ASSINATURA: o apksigner falso troca
// essa linha por ASSINADO:<id da chave>.
const GRADLE_FALSO = `#!/bin/sh
${REG}reg gradle "$@"
if [ "$1" = "--version" ]; then echo "Gradle \${FAKE_GRADLE_VERSAO:-8.7}"; exit 0; fi
[ -n "$FAKE_PID" ] && echo $$ > "$FAKE_PID"
[ -n "$FAKE_ARGS" ] && { printf '%s\n' "$*"; env | grep '^ORG_GRADLE_PROJECT_' | sort; } > "$FAKE_ARGS"
tipo=debug
case "$*" in *Release*) tipo=release ;; esac
for v in $FAKE_GERAR; do
  d="android/app/build/outputs/apk/$v/$tipo"
  mkdir -p "$d"
  if [ "$tipo" = "release" ]; then
    if [ "$FAKE_VAZIO" = "$v" ]; then : > "$d/app-$v-release-unsigned.apk"; else printf '%s\nSEM-ASSINATURA\n' "$FAKE_BUILD-$v" > "$d/app-$v-release-unsigned.apk"; fi
  elif [ "$FAKE_VAZIO" = "$v" ]; then : > "$d/app-$v-$tipo.apk"; else printf '%s' "$FAKE_BUILD-$v" > "$d/app-$v-$tipo.apk"; fi
done
if [ -n "$FAKE_FUNDO" ]; then
  perl -e 'setpgrp(0, 0); sleep 30' </dev/null >/dev/null 2>&1 &
  echo $! > "$FAKE_FUNDO"
fi
if [ -n "$FAKE_MARCA" ]; then
  : > "$FAKE_MARCA"
  while [ -e "$FAKE_PAUSA" ]; do sleep 0.1; done
fi
if [ -n "$FAKE_DEPOIS" ]; then
  sleep "$FAKE_DEPOIS"
  : > "$FAKE_ESCRITA"
fi
[ "$FAKE_FALHAR" = "1" ] && exit 1
exit 0
`;

// mv falso: age como o mv de verdade, com três pontos de parada controlados por variáveis de ambiente:
//   FAKE_TROCA_MARCA/PAUSA   logo depois de tirar um apk/ de verdade do caminho (publicação da rodada 3)
//   FAKE_LEGADO_MARCA/PAUSA  logo depois de guardar a pasta apk/ antiga em .apk-releases/legado.* (migração)
//   FAKE_LOCK_MARCA/PAUSA    logo ANTES de renomear uma trava velha para .velha.* (recuperação da rodada 3,
//                            entre "vi que o dono morreu" e "tirei a trava")
const MV_FALSO = `#!/bin/sh
${REG}reg mv "$@"
for ultimo; do :; done
case "$ultimo" in
  *.apk-build.lock.velha.*)
    if [ -n "$FAKE_LOCK_MARCA" ]; then : > "$FAKE_LOCK_MARCA"; while [ -e "$FAKE_LOCK_PAUSA" ]; do sleep 0.1; done; fi ;;
esac
/bin/mv "$@" || exit $?
case "$ultimo" in
  */.apk-old.*)
    if [ -n "$FAKE_TROCA_MARCA" ]; then : > "$FAKE_TROCA_MARCA"; while [ -e "$FAKE_TROCA_PAUSA" ]; do sleep 0.1; done; fi ;;
  */.apk-releases/legado.*)
    if [ -n "$FAKE_LEGADO_MARCA" ]; then : > "$FAKE_LEGADO_MARCA"; while [ -e "$FAKE_LEGADO_PAUSA" ]; do sleep 0.1; done; fi ;;
esac
`;

// perl falso: repassa tudo ao perl de verdade, exceto as renomeações da publicação (o script usa
// rename($ARGV[0], ...)), onde pode falhar (FAKE_RENAME_FALHAR: todas; FAKE_RENAME_APK_FALHAR: só a que troca apk/;
// FAKE_RENAME_ANTERIOR_FALHAR: só a que registra .apk-anterior, depois da troca) ou parar logo antes
// (FAKE_TROCA_MARCA/PAUSA; com FAKE_TROCA_ALVO, só na renomeação para esse nome).
function perlFalso(real: string) {
  return `#!/bin/sh
${REG}reg perl "$@"
case "$*" in
  *'rename($ARGV[0]'*)
    for destino; do :; done
    if [ -n "$FAKE_RENAME_FALHAR" ]; then exit 5; fi
    case "$destino" in */apk) [ -n "$FAKE_RENAME_APK_FALHAR" ] && exit 5 ;; esac
    case "$destino" in */.apk-anterior) [ -n "$FAKE_RENAME_ANTERIOR_FALHAR" ] && exit 5 ;; esac
    if [ -n "$FAKE_TROCA_MARCA" ] && { [ -z "$FAKE_TROCA_ALVO" ] || [ "\${destino##*/}" = "$FAKE_TROCA_ALVO" ]; }; then
      : > "$FAKE_TROCA_MARCA"; while [ -e "$FAKE_TROCA_PAUSA" ]; do sleep 0.1; done
    fi ;;
esac
exec ${real} "$@"
`;
}
// sdkmanager falso: em --licenses grava o próprio pid (FAKE_SDK_PID), cria FAKE_SDK_MARCA e espera enquanto
// FAKE_SDK_PAUSA existir; depois grava FAKE_SDK_ESCRITA (um sdkmanager que ainda mexe no SDK). Na instalação cria
// as pastas da plataforma e do build-tools.
const SDKMANAGER_FALSO = `#!/bin/sh
${REG}reg sdkmanager "$@"
if [ "$1" = "--licenses" ]; then
  [ -n "$FAKE_SDK_PID" ] && echo $$ > "$FAKE_SDK_PID"
  if [ -n "$FAKE_SDK_MARCA" ]; then
    : > "$FAKE_SDK_MARCA"
    while [ -e "$FAKE_SDK_PAUSA" ]; do sleep 0.1; done
    : > "$FAKE_SDK_ESCRITA"
  fi
  exit 0
fi
mkdir -p "$ANDROID_HOME/platforms/android-34" "$ANDROID_HOME/build-tools/34.0.0"
exit 0
`;
// Chave de mentira: um arquivo de texto com id (quem é a chave), senha e alias. id "oficial" é a chave do Tchê
// Food: o keytool falso devolve o certificado de verdade (o .pem versionado) e o apksigner falso mostra o SHA-256
// dele. Qualquer outro id é uma chave válida que não é a oficial.
//
// keytool falso (-exportcert): lê a senha da entrada padrão, confere senha e alias e escreve o certificado.
const KEYTOOL_FALSO = `#!/bin/sh
${REG}reg keytool "$@"
ks=""; alias=""
while [ $# -gt 0 ]; do case "$1" in -keystore) ks="$2"; shift ;; -alias) alias="$2"; shift ;; esac; shift; done
IFS= read -r senha
[ -n "$FAKE_REG" ] && printf '%s\n' "$senha" >> "$FAKE_REG/keytool.stdin"
echo "Enter keystore password:  " >&2
if [ "$senha" != "$(sed -n 's/^senha=//p' "$ks")" ]; then echo "keytool error: java.io.IOException: keystore password was incorrect"; exit 1; fi
if [ "$alias" != "$(sed -n 's/^alias=//p' "$ks")" ]; then echo "keytool error: java.lang.Exception: Alias <$alias> does not exist"; exit 1; fi
id="$(sed -n 's/^id=//p' "$ks")"
if [ "$id" = "oficial" ]; then cat "$FAKE_CERT_OFICIAL"; else printf 'certificado-%s' "$id"; fi
exit 0
`;
// apksigner falso.
//   sign: exige --ks-pass stdin, lê a senha da entrada padrão, confere senha e alias com a chave de mentira e grava
//         em --out o APK com a linha ASSINADO:<id> no lugar de SEM-ASSINATURA. Como o de verdade, liga a assinatura
//         v3 e o arquivo .idsig (v4) se as opções não os desligarem: o APK ganha a linha ESQUEMA:v3.
//         FAKE_ASSINA_COMO troca o id gravado ("debug" = assinatura da chave de debug), para simular um APK que
//         não saiu com a chave conferida. FAKE_ASSINA_V3=1 e FAKE_IDSIG=1 forçam v3 e .idsig.
//   verify -v --print-certs: responde como o de verdade. Falha em APK com SEM-ASSINATURA ou com o conteúdo de
//         FAKE_SEM_ASSINATURA. Sem linha ASSINADO é a chave de debug do Gradle. O DN é o MESMO para toda chave que
//         não é de debug: só o SHA-256 distingue a oficial. FAKE_DOIS_SIGNATARIOS=1 acrescenta um segundo
//         signatário; FAKE_CARIMBO=1, um carimbo de origem de outra chave; FAKE_ROTACIONADA=1 responde como um APK
//         com troca de chave embutida (duas linhas "Signer (minSdkVersion=...)"). FAKE_N_SIGNATARIOS troca só o
//         número da linha "Number of signers" (as linhas de certificado ficam); FAKE_V2=false e FAKE_V31=true
//         trocam o que o apksigner diz dos esquemas v2 e v3.1.
function apksignerFalso(perl: string) {
  return `#!/bin/sh
${REG}reg apksigner "$@"
if [ "$1" = "sign" ]; then
  shift; ks=""; alias=""; saida=""; senhaDe=""; v3=""; v4=""
  while [ $# -gt 1 ]; do
    case "$1" in
      --ks) ks="$2"; shift ;; --ks-key-alias) alias="$2"; shift ;; --ks-pass) senhaDe="$2"; shift ;;
      --out) saida="$2"; shift ;; --v3-signing-enabled) v3="$2"; shift ;; --v4-signing-enabled) v4="$2"; shift ;;
      --v1-signing-enabled|--v2-signing-enabled) shift ;;
    esac
    shift
  done
  entrada="$1"
  if [ "$senhaDe" != "stdin" ]; then echo "apksigner falso: esperava --ks-pass stdin" >&2; exit 2; fi
  echo "Keystore password for signer #1: "
  IFS= read -r senha
  [ -n "$FAKE_REG" ] && printf '%s\n' "$senha" >> "$FAKE_REG/apksigner.stdin"
  if [ "$senha" != "$(sed -n 's/^senha=//p' "$ks")" ]; then echo "java.io.IOException: keystore password was incorrect" >&2; exit 2; fi
  if [ "$alias" != "$(sed -n 's/^alias=//p' "$ks")" ]; then echo "alias nao encontrado" >&2; exit 2; fi
  id="\${FAKE_ASSINA_COMO:-$(sed -n 's/^id=//p' "$ks")}"
  grep -v '^SEM-ASSINATURA$' "$entrada" > "$saida"
  [ "$id" = "debug" ] || echo "ASSINADO:$id" >> "$saida"
  if [ "$FAKE_ASSINA_V3" = "1" ] || [ "$v3" != "false" ]; then echo "ESQUEMA:v3" >> "$saida"; fi
  if [ "$FAKE_IDSIG" = "1" ] || [ "$v4" != "false" ]; then : > "$saida.idsig"; fi
  exit 0
fi
for apk; do :; done
if [ -n "$FAKE_SEM_ASSINATURA" ] && [ "$(cat "$apk")" = "$FAKE_SEM_ASSINATURA" ]; then
  echo "DOES NOT VERIFY" >&2; exit 1
fi
if grep -q '^SEM-ASSINATURA$' "$apk"; then echo "DOES NOT VERIFY" >&2; exit 1; fi
id="$(sed -n 's/^ASSINADO://p' "$apk")"
if [ -z "$id" ]; then dn="C=US, O=Android, CN=Android Debug"; digest="${DIGEST_DEBUG}"
elif [ "$id" = "oficial" ]; then dn="CN=Tche Food, O=Tche Food, L=Santo Angelo, ST=RS, C=BR"; digest="$FAKE_DIGEST_OFICIAL"
else dn="CN=Tche Food, O=Tche Food, L=Santo Angelo, ST=RS, C=BR"; digest="$(${perl} -MDigest::SHA=sha256_hex -e 'print sha256_hex($ARGV[0])' "certificado-$id")"
fi
v3=false; grep -q '^ESQUEMA:v3$' "$apk" && v3=true
n=1; [ "$FAKE_DOIS_SIGNATARIOS" = "1" ] && n=2
[ -n "$FAKE_N_SIGNATARIOS" ] && n="$FAKE_N_SIGNATARIOS"
echo "Verifies"
echo "Verified using v1 scheme (JAR signing): false"
echo "Verified using v2 scheme (APK Signature Scheme v2): \${FAKE_V2:-true}"
echo "Verified using v3 scheme (APK Signature Scheme v3): $v3"
echo "Verified using v3.1 scheme (APK Signature Scheme v3.1): \${FAKE_V31:-false}"
echo "Verified using v4 scheme (APK Signature Scheme v4): false"
echo "Verified for SourceStamp: false"
echo "Number of signers: $n"
if [ "$FAKE_ROTACIONADA" = "1" ]; then
  echo "Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate DN: CN=Outro"
  echo "Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${'3'.repeat(64)}"
  echo "Signer (minSdkVersion=24, maxSdkVersion=32) certificate DN: $dn"
  echo "Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: $digest"
  exit 0
fi
echo "Signer #1 certificate DN: $dn"
echo "Signer #1 certificate SHA-256 digest: $digest"
echo "Signer #1 certificate SHA-1 digest: 0000"
if [ "$FAKE_DOIS_SIGNATARIOS" = "1" ]; then
  echo "Signer #2 certificate DN: CN=Outro"
  echo "Signer #2 certificate SHA-256 digest: ${'2'.repeat(64)}"
fi
if [ "$FAKE_CARIMBO" = "1" ]; then
  echo "Source Stamp Signer certificate DN: CN=Outro"
  echo "Source Stamp Signer certificate SHA-256 digest: ${'4'.repeat(64)}"
fi
exit 0
`;
}
// zipalign falso: só aceita a conferência (-c 4 <apk>), que é o que o script usa; nunca escreve em arquivo
// (FAKE_ZIPALIGN_FALHAR=1 responde que o APK não está alinhado).
const ZIPALIGN_FALSO = `#!/bin/sh
${REG}reg zipalign "$@"
if [ "$1" != "-c" ] || [ "$2" != "4" ] || [ $# -ne 3 ]; then echo "zipalign falso: esperava -c 4 <apk>" >&2; exit 2; fi
[ "$FAKE_ZIPALIGN_FALHAR" = "1" ] && { echo "Verification FAILED"; exit 1; }
echo "Verification succesful"
`;
// aapt2 falso ("dump badging"): a variante sai do conteúdo do APK falso (primeira linha, "<build>-<variante>").
//   FAKE_VC / FAKE_VC_PAGBANK / FAKE_VC_TABLET  versionCode (padrão 412)
//   FAKE_PACOTE_TABLET / FAKE_PACOTE_PAGBANK    applicationId diferente do esperado
//   FAKE_AAPT2_FALHAR=<variante>                termina com erro para essa variante
//   FAKE_AAPT2_VAZIO=<variante>                 não imprime nada (e termina com sucesso) para essa variante
//   FAKE_COMMIT                                 commit que entra no versionName (padrão abc1234)
//   FAKE_VN                                     versionName inteiro, do jeito que vier (o aapt2 não escapa aspas)
//   FAKE_DEBUGGABLE=1                           o APK é depurável (linha application-debuggable, como num debug)
//   FAKE_PACOTE_DUAS_VEZES=<variante>           imprime uma segunda linha package: (de outro pacote) para essa variante
const AAPT2_FALSO = `#!/bin/sh
${REG}reg aapt2 "$@"
for apk; do :; done
v="$(sed -n 1p "$apk")"; v="\${v##*-}"
vc="\${FAKE_VC:-412}"
case "$v" in
  pagbank) pacote="\${FAKE_PACOTE_PAGBANK:-food.tche.smartpos}"; vc="\${FAKE_VC_PAGBANK:-$vc}" ;;
  tablet) pacote="\${FAKE_PACOTE_TABLET:-food.tche.smartpos.tablet}"; vc="\${FAKE_VC_TABLET:-$vc}" ;;
  *) pacote="desconhecido" ;;
esac
[ "$FAKE_AAPT2_FALHAR" = "$v" ] && { echo "ERROR: dump failed" >&2; exit 1; }
[ "$FAKE_AAPT2_VAZIO" = "$v" ] && exit 0
vn="\${FAKE_VN:-0.1.$vc-\${FAKE_COMMIT:-abc1234}}"
echo "package: name='$pacote' versionCode='$vc' versionName='$vn' platformBuildVersionName='14' platformBuildVersionCode='34' compileSdkVersion='34' compileSdkVersionCodename='14'"
[ "$FAKE_PACOTE_DUAS_VEZES" = "$v" ] && echo "package: name='outro.pacote' versionCode='999' versionName='9.9.9'"
echo "sdkVersion:'25'"
echo "targetSdkVersion:'34'"
[ "$FAKE_DEBUGGABLE" = "1" ] && echo "application-debuggable"
echo "application-label:'Tchê Food'"
`;
const PERL_REAL = spawnSync('sh', ['-c', 'command -v perl'], { encoding: 'utf8' }).stdout.trim();

function criarRepo() {
  const raiz = mkdtempSync(join(tmpdir(), 'build-apk-'));
  pastas.push(raiz);
  mkdirSync(join(raiz, 'scripts'));
  copyFileSync(SCRIPT, join(raiz, 'scripts', 'build-apk.sh'));
  mkdirSync(join(raiz, 'android'));
  writeFileSync(join(raiz, 'android', 'settings.gradle.kts'), '');

  const sdk = join(raiz, 'sdk');
  executavel(join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), SDKMANAGER_FALSO);
  mkdirSync(join(sdk, 'platforms', 'android-34'), { recursive: true });
  executavel(join(sdk, 'build-tools', '34.0.0', 'apksigner'), apksignerFalso(PERL_REAL));
  executavel(join(sdk, 'build-tools', '34.0.0', 'aapt2'), AAPT2_FALSO);
  executavel(join(sdk, 'build-tools', '34.0.0', 'zipalign'), ZIPALIGN_FALSO);
  writeFileSync(join(raiz, 'cert-oficial.der'), CERT_OFICIAL_DER);
  mkdirSync(join(raiz, 'reg'));

  const bin = join(raiz, 'bin');
  executavel(join(bin, 'java'), simples('java', 'echo \'openjdk version "17.0.9" 2023-10-17\' >&2\n'));
  executavel(join(bin, 'node'), simples('node', 'echo v20.11.0\n'));
  for (const nome of ['npm', 'curl', 'unzip']) executavel(join(bin, nome), simples(nome));
  executavel(join(bin, 'keytool'), KEYTOOL_FALSO);
  executavel(join(bin, 'gradle'), GRADLE_FALSO);
  executavel(join(bin, 'mv'), MV_FALSO);
  executavel(join(bin, 'perl'), perlFalso(PERL_REAL));
  return raiz;
}

type Opcoes = {
  gerar: string; build?: string; vazio?: string; falhar?: boolean; renameFalhar?: boolean;
  pausa?: string; marca?: string; trocaPausa?: string; trocaMarca?: string;
  lockPausa?: string; lockMarca?: string; legadoPausa?: string; legadoMarca?: string;
  fundo?: string; extra?: Record<string, string>;
  pid?: string; depois?: number; escrita?: string; renameApkFalhar?: boolean; trocaAlvo?: string;
  sdkPid?: string; sdkMarca?: string; sdkPausa?: string; sdkEscrita?: string;
};

function ambiente(raiz: string, o: Opcoes) {
  return {
    PATH: `${join(raiz, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: raiz,
    ANDROID_HOME: join(raiz, 'sdk'),
    TCHEFOOD_ANDROID_CACHE: join(raiz, 'cache'),
    // URL https: o script pula o npm ci / npm run build
    TCHEFOOD_APP_URL: 'https://exemplo.test',
    FAKE_GERAR: o.gerar,
    FAKE_BUILD: o.build ?? 'A',
    FAKE_VAZIO: o.vazio ?? '',
    FAKE_FALHAR: o.falhar ? '1' : '0',
    FAKE_RENAME_FALHAR: o.renameFalhar ? '1' : '',
    FAKE_TROCA_PAUSA: o.trocaPausa ?? '',
    FAKE_TROCA_MARCA: o.trocaMarca ?? '',
    FAKE_LOCK_PAUSA: o.lockPausa ?? '',
    FAKE_LOCK_MARCA: o.lockMarca ?? '',
    FAKE_LEGADO_PAUSA: o.legadoPausa ?? '',
    FAKE_LEGADO_MARCA: o.legadoMarca ?? '',
    FAKE_PAUSA: o.pausa ?? '',
    FAKE_MARCA: o.marca ?? '',
    FAKE_FUNDO: o.fundo ?? '',
    FAKE_PID: o.pid ?? '',
    FAKE_DEPOIS: o.depois === undefined ? '' : String(o.depois),
    FAKE_ESCRITA: o.escrita ?? '',
    FAKE_RENAME_APK_FALHAR: o.renameApkFalhar ? '1' : '',
    FAKE_TROCA_ALVO: o.trocaAlvo ?? '',
    FAKE_SDK_PID: o.sdkPid ?? '',
    FAKE_SDK_MARCA: o.sdkMarca ?? '',
    FAKE_SDK_PAUSA: o.sdkPausa ?? '',
    FAKE_SDK_ESCRITA: o.sdkEscrita ?? '',
    FAKE_REG: join(raiz, 'reg'),
    FAKE_CERT_OFICIAL: join(raiz, 'cert-oficial.der'),
    FAKE_DIGEST_OFICIAL: DIGEST_OFICIAL,
    ...(o.extra ?? {}),
  };
}

function rodar(raiz: string, variante: string, o: Opcoes) {
  const r = spawnSync('bash', ['scripts/build-apk.sh', variante], { cwd: raiz, encoding: 'utf8', env: ambiente(raiz, o) });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

function rodarEmSegundoPlano(raiz: string, variante: string, o: Opcoes) {
  const filho = spawn('bash', ['scripts/build-apk.sh', variante], { cwd: raiz, env: ambiente(raiz, o), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let saida = '';
  filho.stdout?.on('data', (d) => { saida += String(d); });
  filho.stderr?.on('data', (d) => { saida += String(d); });
  let terminou = false;
  const fim = new Promise<number | null>((ok) => filho.on('close', (c) => { terminou = true; ok(c); }));
  // 'exit' = o bash principal saiu (o 'close' ainda espera quem herdou a saída dele)
  const saiu = new Promise<{ codigo: number | null; sinal: NodeJS.Signals | null }>((ok) =>
    filho.on('exit', (codigo, sinal) => ok({ codigo, sinal })));
  return { filho, fim, saiu, saida: () => saida, terminou: () => terminou };
}

// Processos que têm aberto o arquivo da trava (Linux: /proc/<pid>/fd); fora do Linux devolve null.
function donosDaTrava(raiz: string): number[] | null {
  if (process.platform !== 'linux') return null;
  const alvo = join(raiz, '.apk-build.flock');
  const donos: number[] = [];
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    let fds: string[] = [];
    try { fds = readdirSync(`/proc/${p}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { if (readlinkSync(`/proc/${p}/fd/${fd}`) === alvo) { donos.push(Number(p)); break; } } catch { /* saiu */ }
    }
  }
  return donos;
}

function pidDe(arquivo: string) {
  return existsSync(arquivo) ? Number(readFileSync(arquivo, 'utf8')) : 0;
}

// Leitor que resolve um caminho (cd -P: fica com a pasta da versão aberta) e só lê os APKs quando liberado.
function abrirLeitor(raiz: string, caminho: string) {
  const pausa = join(raiz, `pausa-leitor-${Math.random().toString(36).slice(2)}`);
  const marca = `${pausa}.aberto`;
  writeFileSync(pausa, '');
  const leitor = spawn('bash', ['-c', `cd -P ${caminho} && : > "${marca}" && while [ -e "${pausa}" ]; do sleep 0.05; done; ` +
    'cat tchefood-pagbank-debug.apk; echo; cat tchefood-tablet-debug.apk'], { cwd: raiz });
  let lido = '';
  leitor.stdout.on('data', (d) => { lido += String(d); });
  leitor.stderr.on('data', (d) => { lido += String(d); });
  const fim = new Promise<number | null>((ok) => leitor.on('close', (c) => ok(c)));
  return {
    aberto: () => esperar(() => existsSync(marca)),
    ler: async () => { rmSync(pausa, { force: true }); const c = await fim; return { codigo: c, lido }; },
  };
}

async function esperar(cond: () => boolean, ms = 10000) {
  const limite = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > limite) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function vivo(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function matarFundo(arquivo: string) {
  if (!existsSync(arquivo)) return;
  const pid = Number(readFileSync(arquivo, 'utf8'));
  if (pid > 0 && vivo(pid)) process.kill(pid, 'SIGKILL');
}

function apks(raiz: string) {
  const pasta = join(raiz, 'apk');
  if (!existsSync(pasta)) return {} as Record<string, string>;
  return Object.fromEntries(readdirSync(pasta).sort().map((n) => [n, readFileSync(join(pasta, n), 'utf8')]));
}

// Chave de mentira (id "oficial" = a do Tchê Food) com o arquivo da senha ao lado. `env` são as variáveis de um
// release; `registro` é o registro de releases que o script mantém junto da chave.
function chaveFalsa(raiz: string, id = 'oficial', o: { senha?: string; alias?: string; conteudoSenha?: string } = {}) {
  const pasta = join(raiz, 'chaves');
  mkdirSync(pasta, { recursive: true });
  const senha = o.senha ?? 'senha-secreta-1';
  const chave = join(pasta, `${id}.jks`);
  writeFileSync(chave, `id=${id}\nsenha=${senha}\nalias=${o.alias ?? 'tchefood'}\n`);
  const arquivoSenha = join(pasta, `${id}.senha`);
  writeFileSync(arquivoSenha, o.conteudoSenha ?? `${senha}\n`);
  return {
    chave, arquivoSenha, senha, registro: `${chave}.releases.tsv`,
    env: { TCHEFOOD_KEYSTORE: chave, TCHEFOOD_KEYSTORE_PASSWORD_FILE: arquivoSenha } as Record<string, string>,
  };
}
// Conteúdo de um APK de release depois do apksigner falso.
const assinado = (conteudo: string, id = 'oficial') => `${conteudo}\nASSINADO:${id}\n`;
// O que as ferramentas falsas gravaram: nome da ferramenta e o texto (linha de comando + ambiente).
function chamadas(raiz: string) {
  return readdirSync(join(raiz, 'reg')).filter((n) => n.endsWith('.env'))
    .map((n) => ({ nome: n.split('.')[0], texto: readFileSync(join(raiz, 'reg', n), 'utf8') }));
}
function entradaDe(raiz: string, nome: string) {
  const arquivo = join(raiz, 'reg', `${nome}.stdin`);
  return existsSync(arquivo) ? readFileSync(arquivo, 'utf8') : '';
}
// Linhas de release do registro (sem o cabeçalho): [variante, versionCode, versionName, sha256, data].
function linhasDoRegistro(arquivo: string) {
  if (!existsSync(arquivo)) return [];
  return readFileSync(arquivo, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
}
// Troca, na cópia do script do repositório de mentira, os SHA-256 fixados pelo SHA-256 de um conteúdo conhecido:
// é o que permite testar o caminho em que o download confere (o arquivo de verdade tem mais de 100 MB).
function fixarSha(raiz: string, conteudo: string) {
  const arquivo = join(raiz, 'scripts', 'build-apk.sh');
  let trocas = 0;
  const texto = readFileSync(arquivo, 'utf8').replace(
    /^(CMDLINE_TOOLS_SHA256_LINUX|CMDLINE_TOOLS_SHA256_MAC|GRADLE_SHA256)="[0-9a-f]{64}"$/gm,
    (_, nome: string) => { trocas += 1; return `${nome}="${sha256(conteudo)}"`; },
  );
  if (trocas !== 3) throw new Error(`esperava trocar 3 constantes de SHA-256 e troquei ${trocas}`);
  writeFileSync(arquivo, texto);
}
// curl falso que "baixa" um conteúdo fixo e unzip falso que registra o que recebeu e "descompacta" as ferramentas
// (o sdkmanager e o Gradle falsos), como os zips de verdade fariam.
function comDownloads(raiz: string, baixado: string) {
  executavel(join(raiz, 'bin', 'curl'), simples('curl', `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && saida="$2"; shift; done\nprintf '%s' '${baixado}' > "$saida"\n`));
  executavel(join(raiz, 'sdkmanager-falso'), SDKMANAGER_FALSO);
  executavel(join(raiz, 'gradle-falso'), GRADLE_FALSO);
  executavel(join(raiz, 'bin', 'unzip'), simples('unzip', `zip=""; destino=""
while [ $# -gt 0 ]; do case "$1" in -q) ;; -d) destino="$2"; shift ;; *) zip="$1" ;; esac; shift; done
printf '%s %s\\n' "$(basename "$zip")" "$(cat "$zip")" >> "$HOME/unzip-chamado"
case "$zip" in
  *cmdline-tools-*) mkdir -p "$destino/cmdline-tools/bin"; cp "$HOME/sdkmanager-falso" "$destino/cmdline-tools/bin/sdkmanager" ;;
  *gradle-*) mkdir -p "$destino/gradle-8.7/bin"; cp "$HOME/gradle-falso" "$destino/gradle-8.7/bin/gradle" ;;
esac
exit 0
`));
}

describe.skipIf(process.platform === 'win32')('scripts/build-apk.sh', () => {
  it('all + só pagbank presente: falha e não publica nada', () => {
    const raiz = criarRepo();
    const r = rodar(raiz, 'all', { gerar: 'pagbank' });
    expect(r.codigo).not.toBe(0);
    expect(r.saida).toContain('variante tablet');
    expect(apks(raiz)).toEqual({});
  });

  it('all + só tablet presente: falha', () => {
    const raiz = criarRepo();
    const r = rodar(raiz, 'all', { gerar: 'tablet' });
    expect(r.codigo).not.toBe(0);
    expect(r.saida).toContain('variante pagbank');
    expect(apks(raiz)).toEqual({});
  });

  it('all + os dois presentes: sucesso e os dois APKs em apk/', () => {
    const raiz = criarRepo();
    const r = rodar(raiz, 'all', { gerar: 'pagbank tablet' });
    expect(r.codigo).toBe(0);
    expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank', 'tchefood-tablet-debug.apk': 'A-tablet' });
  });

  it('pagbank + só o APK pagbank presente: sucesso', () => {
    const raiz = criarRepo();
    const r = rodar(raiz, 'pagbank', { gerar: 'pagbank' });
    expect(r.codigo).toBe(0);
    expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank' });
  });

  it('APK vazio: erro explícito e nada publicado', () => {
    const raiz = criarRepo();
    const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', vazio: 'tablet' });
    expect(r.codigo).not.toBe(0);
    expect(r.saida).toContain('vazio');
    expect(apks(raiz)).toEqual({});
  });

  it('all e depois pagbank: sobra só o APK do último build', () => {
    const raiz = criarRepo();
    expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
    expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'B' }).codigo).toBe(0);
    expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank' });
  });

  it('pagbank e depois tablet: o APK anterior não permanece', () => {
    const raiz = criarRepo();
    expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'A' }).codigo).toBe(0);
    expect(rodar(raiz, 'tablet', { gerar: 'tablet', build: 'B' }).codigo).toBe(0);
    expect(apks(raiz)).toEqual({ 'tchefood-tablet-debug.apk': 'B-tablet' });
  });

  it('o Gradle falha: o último conjunto válido fica intacto', () => {
    const raiz = criarRepo();
    expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
    const antes = apks(raiz);
    const r = rodar(raiz, 'tablet', { gerar: 'tablet', build: 'B', falhar: true });
    expect(r.codigo).not.toBe(0);
    expect(apks(raiz)).toEqual(antes);
  });

  it('validação falha depois do build: o último conjunto válido fica intacto', () => {
    const raiz = criarRepo();
    expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
    const antes = apks(raiz);
    const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', vazio: 'tablet' });
    expect(r.codigo).not.toBe(0);
    expect(apks(raiz)).toEqual(antes);
  });

  it('o Gradle não gera nada: o APK de um build anterior não passa por novo', () => {
    const raiz = criarRepo();
    expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'A' }).codigo).toBe(0);
    const antes = apks(raiz);
    const r = rodar(raiz, 'pagbank', { gerar: '', build: 'B' });
    expect(r.codigo).not.toBe(0);
    expect(apks(raiz)).toEqual(antes);
  });

  it('não deixa pasta temporária para trás', () => {
    const raiz = criarRepo();
    rodar(raiz, 'all', { gerar: 'pagbank tablet' });
    rodar(raiz, 'all', { gerar: 'pagbank' });
    expect(readdirSync(raiz).filter((n) => n.startsWith('.apk-link'))).toEqual([]);
    expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(1);
  });

  it('a instrução final de download lista só os APKs da execução', () => {
    const raiz = criarRepo();
    const pb = rodar(raiz, 'pagbank', { gerar: 'pagbank' });
    expect(pb.saida).toContain('cloudshell download apk/tchefood-pagbank-debug.apk');
    expect(pb.saida).not.toContain('tchefood-tablet-debug.apk');
    const tb = rodar(raiz, 'tablet', { gerar: 'tablet' });
    expect(tb.saida).toContain('cloudshell download apk/tchefood-tablet-debug.apk');
    expect(tb.saida).not.toContain('tchefood-pagbank-debug.apk');
    const todos = rodar(raiz, 'all', { gerar: 'pagbank tablet' });
    expect(todos.saida).toContain('cloudshell download apk/tchefood-pagbank-debug.apk');
    expect(todos.saida).toContain('cloudshell download apk/tchefood-tablet-debug.apk');
  });

  it('quando o build falha, nenhuma instrução de download aparece', () => {
    const raiz = criarRepo();
    const r = rodar(raiz, 'all', { gerar: 'pagbank' });
    expect(r.codigo).not.toBe(0);
    expect(r.saida).not.toContain('cloudshell download');
  });

  describe('downloads conferidos por SHA-256', () => {
    // Sem o sdkmanager, o script baixa as ferramentas do Android.
    function semSdk(raiz: string) {
      rmSync(join(raiz, 'sdk', 'cmdline-tools'), { recursive: true, force: true });
    }
    const zipDoSdk = `cmdline-tools-${process.platform === 'darwin' ? 'mac' : 'linux'}.zip`;

    it('arquivo baixado que não confere: para antes de descompactar e não deixa o arquivo no cache', () => {
      const raiz = criarRepo();
      semSdk(raiz);
      comDownloads(raiz, 'conteudo-trocado');
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank' });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('não confere');
      expect(existsSync(join(raiz, 'unzip-chamado'))).toBe(false);
      expect(readdirSync(join(raiz, 'cache'))).toEqual([]);
      expect(apks(raiz)).toEqual({});
    });

    it('ferramentas do Android: o arquivo com o SHA-256 certo chega à descompactação e o build segue; adulterado, nunca chega', () => {
      const certo = criarRepo();
      semSdk(certo);
      fixarSha(certo, 'zip-conhecido');
      comDownloads(certo, 'zip-conhecido');
      const r = rodar(certo, 'pagbank', { gerar: 'pagbank' });
      expect(r.codigo).toBe(0);
      // o unzip recebeu exatamente o arquivo conferido
      expect(readFileSync(join(certo, 'unzip-chamado'), 'utf8')).toBe(`${zipDoSdk} zip-conhecido\n`);
      expect(existsSync(join(certo, 'sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))).toBe(true);
      expect(apks(certo)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank' });

      const adulterado = criarRepo();
      semSdk(adulterado);
      fixarSha(adulterado, 'zip-conhecido');
      comDownloads(adulterado, 'zip-conhecido-com-um-byte-a-mais');
      const r2 = rodar(adulterado, 'pagbank', { gerar: 'pagbank' });
      expect(r2.codigo).not.toBe(0);
      expect(r2.saida).toContain('não confere');
      expect(existsSync(join(adulterado, 'unzip-chamado'))).toBe(false);
      expect(existsSync(join(adulterado, 'sdk', 'cmdline-tools'))).toBe(false);
      expect(apks(adulterado)).toEqual({});
    });

    it('Gradle: o arquivo com o SHA-256 certo chega à descompactação e compila; adulterado, nunca chega', () => {
      const certo = criarRepo();
      fixarSha(certo, 'gradle-conhecido');
      comDownloads(certo, 'gradle-conhecido');
      // o gradle do PATH é de outra versão: o script baixa a 8.7
      const r = rodar(certo, 'pagbank', { gerar: 'pagbank', extra: { FAKE_GRADLE_VERSAO: '8.5' } });
      expect(r.codigo).toBe(0);
      expect(readFileSync(join(certo, 'unzip-chamado'), 'utf8')).toBe('gradle-8.7-bin.zip gradle-conhecido\n');
      expect(apks(certo)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank' });

      const adulterado = criarRepo();
      fixarSha(adulterado, 'gradle-conhecido');
      comDownloads(adulterado, 'gradle-adulterado');
      const r2 = rodar(adulterado, 'pagbank', { gerar: 'pagbank', extra: { FAKE_GRADLE_VERSAO: '8.5' } });
      expect(r2.codigo).not.toBe(0);
      expect(r2.saida).toContain('não confere');
      expect(existsSync(join(adulterado, 'unzip-chamado'))).toBe(false);
      expect(existsSync(join(adulterado, 'cache', 'gradle-8.7'))).toBe(false);
      expect(apks(adulterado)).toEqual({});
    });

    it('os SHA-256 fixados não mudam por engano e são os mesmos que a documentação cita com a procedência', () => {
      const texto = readFileSync(SCRIPT, 'utf8');
      const doc = readFileSync(resolve(__dirname, '..', 'docs', 'apk-release.md'), 'utf8');
      const fixados: Record<string, string> = {
        CMDLINE_TOOLS_SHA256_LINUX: '2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258',
        CMDLINE_TOOLS_SHA256_MAC: '7bc5c72ba0275c80a8f19684fb92793b83a6b5c94d4d179fc5988930282d7e64',
        GRADLE_SHA256: '544c35d6bd849ae8a5ed0bcea39ba677dc40f49df7d1835561582da2009b961d',
      };
      expect(texto).toContain('CMDLINE_TOOLS_VERSION="11076708"');
      expect(texto).toContain('GRADLE_VERSION="8.7"');
      for (const [nome, valor] of Object.entries(fixados)) {
        expect(texto).toContain(`${nome}="${valor}"`);
        expect(doc).toContain(valor);
      }
    });
  });

  describe('assinatura', () => {
    it('sem chave: debug, com versão e certificado no fim, e nenhuma ferramenta de assinatura roda', () => {
      const raiz = criarRepo();
      const args = join(raiz, 'args');
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { FAKE_ARGS: args } });
      expect(r.codigo).toBe(0);
      expect(readFileSync(args, 'utf8')).toContain('assemblePagbankDebug');
      expect(r.saida).toContain('Versão: 0.1.412-abc1234 (código 412) (debug)');
      expect(r.saida).toContain(`pagbank: ${DIGEST_DEBUG}`);
      const nomes = chamadas(raiz).map((c) => c.nome);
      expect(nomes).not.toContain('keytool');
      expect(nomes).not.toContain('zipalign');
      expect(existsSync(join(raiz, 'chaves'))).toBe(false);
      expect(chamadas(raiz).filter((c) => c.nome === 'apksigner' && c.texto.startsWith('ARGV: sign'))).toEqual([]);
    });

    it('chave oficial: o Gradle gera sem assinatura, o apksigner assina e saem tchefood-<variante>.apk', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const args = join(raiz, 'args');
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', extra: { ...k.env, FAKE_ARGS: args, TCHEFOOD_PRIMEIRO_RELEASE: '1' } });
      expect(r.saida).toContain('chave oficial conferida');
      expect(r.codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank'), 'tchefood-tablet.apk': assinado('A-tablet') });
      // o Gradle recebe só as tarefas de release: nenhuma propriedade de assinatura, nem na linha de comando nem no ambiente
      expect(readFileSync(args, 'utf8').trim()).toBe('-p android --no-daemon -PTCHEFOOD_APP_URL=https://exemplo.test assemblePagbankRelease assembleTabletRelease');
      expect(r.saida).toContain(`pagbank: ${DIGEST_OFICIAL}`);
      expect(r.saida).toContain(`tablet: ${DIGEST_OFICIAL}`);
      expect(r.saida).toContain('Versão: 0.1.412-abc1234 (código 412) (release)');
      expect(r.saida).toContain('cloudshell download apk/tchefood-pagbank.apk');
      expect(r.saida).not.toContain(k.senha);
      // nada da assinatura sobra na pasta publicada nem em .apk-releases
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(1);
    });

    it('o certificado fixado no script é o do arquivo android/tchefood-release-cert.pem', () => {
      expect(readFileSync(SCRIPT, 'utf8')).toContain(`CERT_OFICIAL_SHA256="${DIGEST_OFICIAL}"`);
      expect(CERT_OFICIAL_DER.length).toBeGreaterThan(500);
    });

    it('P1-01: nenhuma variável de ambiente troca o certificado oficial', () => {
      const raiz = criarRepo();
      const outra = chaveFalsa(raiz, 'outra');
      const args = join(raiz, 'args');
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: {
        ...outra.env, FAKE_ARGS: args, TCHEFOOD_PRIMEIRO_RELEASE: '1',
        CERT_OFICIAL_SHA256: digestDe('outra'), TCHEFOOD_CERT_SHA256: digestDe('outra'),
      } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('não é a chave oficial do Tchê Food');
      expect(existsSync(args)).toBe(false);
      expect(apks(raiz)).toEqual({});
    });

    it('P1-01: duas chaves válidas, só a oficial publica; a outra para antes de compilar e apk/ fica intacto', () => {
      const raiz = criarRepo();
      const oficial = chaveFalsa(raiz, 'oficial');
      // mesma senha, mesmo alias e (no apksigner falso) o mesmo nome no certificado: só o SHA-256 é diferente
      const outra = chaveFalsa(raiz, 'outra');
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', extra: { ...oficial.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' } }).codigo).toBe(0);
      const antes = apks(raiz);
      const registroAntes = readFileSync(oficial.registro, 'utf8');
      expect(antes).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank'), 'tchefood-tablet.apk': assinado('A-tablet') });

      const args = join(raiz, 'args');
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', extra: { ...outra.env, FAKE_ARGS: args, FAKE_VC: '413', TCHEFOOD_PRIMEIRO_RELEASE: '1' } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('não é a chave oficial do Tchê Food');
      expect(r.saida).toContain(digestDe('outra'));
      expect(existsSync(args)).toBe(false);
      expect(apks(raiz)).toEqual(antes);
      expect(readFileSync(oficial.registro, 'utf8')).toBe(registroAntes);
      expect(existsSync(outra.registro)).toBe(false);
      expect(entradaDe(raiz, 'apksigner').trim().split('\n')).toHaveLength(2); // só as duas assinaturas do release A
    });

    it.each(['outra', 'debug'])('P1-01: APK que sai assinado com a chave "%s" depois de a oficial ser conferida: a conferência final recusa e apk/ fica intacto', (id) => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' } }).codigo).toBe(0);
      const antes = apks(raiz);
      const registroAntes = readFileSync(k.registro, 'utf8');
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', extra: { ...k.env, FAKE_VC: '413', FAKE_ASSINA_COMO: id } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('não está assinado com a chave oficial do Tchê Food');
      expect(apks(raiz)).toEqual(antes);
      expect(readFileSync(k.registro, 'utf8')).toBe(registroAntes);
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(1);
    });

    it('P1-01: dois signatários no APK: recusa, no release e no debug', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const rel = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_DOIS_SIGNATARIOS: '1' } });
      expect(rel.codigo).not.toBe(0);
      expect(rel.saida).toContain('exatamente 1 signatário');
      expect(rel.saida).toContain('achei 2');
      expect(linhasDoRegistro(k.registro)).toEqual([]);
      const deb = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { FAKE_DOIS_SIGNATARIOS: '1' } });
      expect(deb.codigo).not.toBe(0);
      expect(deb.saida).toContain('exatamente 1 signatário');
      expect(apks(raiz)).toEqual({});
    });

    it.each([
      ['carimbo de origem de outra chave', { FAKE_CARIMBO: '1' }, 'exatamente 1 signatário'],
      ['troca de chave embutida (duas linhas de signatário por faixa de Android)', { FAKE_ROTACIONADA: '1' }, 'exatamente 1 signatário'],
      ['assinatura v3 além da v2', { FAKE_ASSINA_V3: '1' }, 'não saiu com a assinatura v2 e sem v3/v3.1'],
      ['assinatura v3.1 além da v2', { FAKE_V31: 'true' }, 'não saiu com a assinatura v2 e sem v3/v3.1'],
      ['assinatura v2 ausente', { FAKE_V2: 'false' }, 'não saiu com a assinatura v2 e sem v3/v3.1'],
      ['contagem de signatários diferente de 1, mesmo com uma só linha de certificado', { FAKE_N_SIGNATARIOS: '2' }, 'o apksigner não confirma isso'],
    ] as [string, Record<string, string>, string][])('P1-01: release com %s: recusa antes de publicar', (_, knob, mensagem) => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' } }).codigo).toBe(0);
      const antes = apks(raiz);
      const registroAntes = readFileSync(k.registro, 'utf8');
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', extra: { ...k.env, FAKE_VC: '413', ...knob } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain(mensagem);
      expect(apks(raiz)).toEqual(antes);
      expect(readFileSync(k.registro, 'utf8')).toBe(registroAntes);
    });

    it('a assinatura pede só o esquema v2, e a senha só pela entrada padrão', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' } }).codigo).toBe(0);
      const sign = chamadas(raiz).filter((c) => c.nome === 'apksigner' && c.texto.startsWith('ARGV: sign'));
      expect(sign).toHaveLength(1);
      expect(sign[0].texto.split('\n')[0]).toContain(
        `sign --ks ${k.chave} --ks-key-alias tchefood --ks-pass stdin --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled false --v4-signing-enabled false --out `,
      );
      // o zipalign só confere o APK já assinado (não reescreve nada depois da assinatura)
      const alinhamento = chamadas(raiz).filter((c) => c.nome === 'zipalign').map((c) => c.texto.split('\n')[0]);
      expect(alinhamento).toHaveLength(1);
      expect(alinhamento[0]).toMatch(/^ARGV: -c 4 .*\/\.apk-releases\/r\.[^/]+\/tchefood-pagbank\.apk$/);
    });

    it('APK sem assinatura válida: falha e o conjunto anterior fica', () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'A' }).codigo).toBe(0);
      const antes = apks(raiz);
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'B', extra: { FAKE_SEM_ASSINATURA: 'B-pagbank' } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('assinatura válida');
      expect(apks(raiz)).toEqual(antes);
    });

    it('APK assinado que não passa na conferência de alinhamento, ou arquivo a mais ao lado dele: não publica', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const extra = { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' };
      const z = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...extra, FAKE_ZIPALIGN_FALHAR: '1' } });
      expect(z.codigo).not.toBe(0);
      expect(z.saida).toContain('não passou na conferência de alinhamento');
      const i = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...extra, FAKE_IDSIG: '1' } });
      expect(i.codigo).not.toBe(0);
      expect(i.saida).toContain('arquivo a mais ou a menos');
      expect(apks(raiz)).toEqual({});
      expect(linhasDoRegistro(k.registro)).toEqual([]);
      expect(readdirSync(join(raiz, '.apk-releases'))).toEqual([]);
    });

    it('chave indicada por caminho relativo (com ou sem pasta): o registro fica ao lado do arquivo de verdade e as ferramentas recebem o caminho inteiro', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      // com pasta: chaves/oficial.jks, a partir da raiz do projeto
      const r1 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, TCHEFOOD_KEYSTORE: 'chaves/oficial.jks', TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_VC: '400' } });
      expect(r1.codigo, r1.saida).toBe(0);
      expect(linhasDoRegistro(k.registro).map((l) => `${l[0]} ${l[1]}`)).toEqual(['pagbank 400']);
      const sign = chamadas(raiz).filter((c) => c.nome === 'apksigner' && c.texto.startsWith('ARGV: sign'));
      expect(sign).toHaveLength(1);
      expect(sign[0].texto.split('\n')[0]).toContain(`--ks ${realpathSync(k.chave)} `);
      // sem pasta: a chave na pasta de onde o script é chamado
      copyFileSync(k.chave, join(raiz, 'solta.jks'));
      const r2 = rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'B', extra: { ...k.env, TCHEFOOD_KEYSTORE: 'solta.jks', TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_VC: '401' } });
      expect(r2.codigo, r2.saida).toBe(0);
      expect(linhasDoRegistro(join(realpathSync(raiz), 'solta.jks.releases.tsv')).map((l) => `${l[0]} ${l[1]}`)).toEqual(['pagbank 401']);
    });

    it('chave apontada por um link simbólico é recusada (o registro de releases fica ao lado do arquivo de verdade)', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const link = join(raiz, 'atalho.jks');
      symlinkSync(k.chave, link);
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, TCHEFOOD_KEYSTORE: link, TCHEFOOD_PRIMEIRO_RELEASE: '1' } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('é um link simbólico');
      expect(existsSync(`${link}.releases.tsv`)).toBe(false);
      expect(entradaDe(raiz, 'keytool')).toBe('');
    });

    it('senha errada ou alias que não existe: para antes de compilar, sem mostrar a senha', () => {
      const raiz = criarRepo();
      const args = join(raiz, 'args');
      const errada = chaveFalsa(raiz, 'oficial', { conteudoSenha: 'senha-digitada-errada\n' });
      const r1 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...errada.env, FAKE_ARGS: args, TCHEFOOD_PRIMEIRO_RELEASE: '1' } });
      expect(r1.codigo).not.toBe(0);
      expect(r1.saida).toContain('não consegui abrir a chave');
      expect(r1.saida).not.toContain('senha-digitada-errada');
      const k = chaveFalsa(raiz);
      const r2 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, FAKE_ARGS: args, TCHEFOOD_PRIMEIRO_RELEASE: '1', TCHEFOOD_KEY_ALIAS: 'outro-alias' } });
      expect(r2.codigo).not.toBe(0);
      expect(r2.saida).toContain('alias "outro-alias"');
      expect(existsSync(args)).toBe(false);
      expect(entradaDe(raiz, 'apksigner')).toBe('');
      expect(apks(raiz)).toEqual({});
    });

    it('arquivo da senha salvo no Windows (CR no fim, marca BOM no começo) ou sem quebra de linha: a senha é a primeira linha', () => {
      for (const conteudoSenha of ['senha-secreta-1\r\n', 'senha-secreta-1', 'senha-secreta-1\nsegunda linha ignorada\n', '\uFEFFsenha-secreta-1\r\n']) {
        const raiz = criarRepo();
        const k = chaveFalsa(raiz, 'oficial', { conteudoSenha });
        const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' } });
        expect(r.codigo).toBe(0);
        expect(entradaDe(raiz, 'apksigner')).toBe('senha-secreta-1\n');
      }
    });

    it('chave que não existe, arquivo de senha sem chave, arquivo de senha ausente ou vazio, sem terminal: para antes do Gradle', () => {
      const raiz = criarRepo();
      const args = join(raiz, 'args');
      const k = chaveFalsa(raiz);
      const base = { FAKE_ARGS: args, TCHEFOOD_PRIMEIRO_RELEASE: '1' };
      const r1 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...base, ...k.env, TCHEFOOD_KEYSTORE: join(raiz, 'nao-existe.jks') } });
      expect(r1.codigo).not.toBe(0);
      expect(r1.saida).toContain('TCHEFOOD_KEYSTORE não existe');
      const r2 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { FAKE_ARGS: args, TCHEFOOD_KEYSTORE_PASSWORD_FILE: k.arquivoSenha } });
      expect(r2.codigo).not.toBe(0);
      expect(r2.saida).toContain('sem TCHEFOOD_KEYSTORE');
      const r3 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...base, ...k.env, TCHEFOOD_KEYSTORE_PASSWORD_FILE: join(raiz, 'sem-senha.txt') } });
      expect(r3.codigo).not.toBe(0);
      expect(r3.saida).toContain('TCHEFOOD_KEYSTORE_PASSWORD_FILE não existe');
      writeFileSync(join(raiz, 'vazio.txt'), '');
      const r4 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...base, ...k.env, TCHEFOOD_KEYSTORE_PASSWORD_FILE: join(raiz, 'vazio.txt') } });
      expect(r4.codigo).not.toBe(0);
      expect(r4.saida).toContain('está vazio');
      // sem arquivo de senha e sem terminal (a entrada do teste não é um terminal): não tem como perguntar
      const r5 = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...base, TCHEFOOD_KEYSTORE: k.chave } });
      expect(r5.codigo).not.toBe(0);
      expect(r5.saida).toContain('sem terminal para perguntar a senha');
      expect(existsSync(args)).toBe(false);
      expect(entradaDe(raiz, 'keytool')).toBe('');
      expect(apks(raiz)).toEqual({});
    });
  });

  describe('senha da chave (P1-02 e P2-03)', () => {
    // nem as variáveis que entram pelo ambiente, nem as internas do script (que `bash -a` exportaria)
    const PROIBIDAS = ['TCHEFOOD_KEYSTORE=', 'TCHEFOOD_KEYSTORE_PASSWORD_FILE=', 'TCHEFOOD_KEY_ALIAS=', 'TCHEFOOD_KEYSTORE_PASSWORD=',
      'TCHEFOOD_KEY_PASSWORD=', 'ORG_GRADLE_PROJECT_TCHEFOOD_KEY', 'chave_senha=', 'chave_arquivo=', 'chave_senha_arquivo=', 'chave_alias=',
      'chave_pasta=', 'registro=', 'motivo=', 'senha_no_ambiente='];

    // Confere, em TODAS as ferramentas que rodaram: nenhuma recebeu a senha (nem no ambiente, nem na linha de
    // comando), nenhuma herdou as variáveis da chave, e o caminho da chave e do arquivo da senha só aparece na
    // linha de comando do keytool e do apksigner. A senha só entra pela entrada padrão desses dois.
    function conferirSegredos(raiz: string, k: ReturnType<typeof chaveFalsa>, assinaturas: number) {
      const todas = chamadas(raiz);
      for (const c of todas) {
        expect(c.texto, `${c.nome} recebeu a senha`).not.toContain(k.senha);
        expect(c.texto, `${c.nome} recebeu o caminho do arquivo da senha`).not.toContain(k.arquivoSenha);
        const ambiente = c.texto.split('\n').slice(1);
        for (const proibida of PROIBIDAS) {
          expect(ambiente.filter((l) => l.startsWith(proibida)), `${c.nome} herdou ${proibida}`).toEqual([]);
        }
        // o caminho da chave só vai para quem abre a chave (o registro de releases, ao lado dela, não é a chave)
        if (c.nome !== 'keytool' && c.nome !== 'apksigner') {
          expect(c.texto.split(k.registro).join('<registro>'), `${c.nome} recebeu o caminho da chave`).not.toContain(k.chave);
        }
      }
      expect(entradaDe(raiz, 'keytool')).toBe(`${k.senha}\n`);
      expect(entradaDe(raiz, 'apksigner')).toBe(`${k.senha}\n`.repeat(assinaturas));
      return [...new Set(todas.map((c) => c.nome))].sort();
    }

    it('P1-02: build completo de release (baixa o SDK, instala a plataforma, npm, Gradle, assina): só o keytool e o apksigner recebem a senha, pela entrada padrão', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      // sem SDK (curl + unzip), sem plataforma (sdkmanager) e sem TCHEFOOD_APP_URL (npm ci e npm run build)
      rmSync(join(raiz, 'sdk', 'cmdline-tools'), { recursive: true, force: true });
      rmSync(join(raiz, 'sdk', 'platforms'), { recursive: true, force: true });
      fixarSha(raiz, 'zip-conhecido');
      comDownloads(raiz, 'zip-conhecido');
      executavel(join(raiz, 'bin', 'npm'), simples('npm', 'mkdir -p dist; : > dist/index.html\nexit 0\n'));
      const args = join(raiz, 'args');
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', extra: {
        ...k.env, TCHEFOOD_KEY_ALIAS: 'tchefood', TCHEFOOD_APP_URL: '', TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_ARGS: args,
      } });
      expect(r.codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank'), 'tchefood-tablet.apk': assinado('A-tablet') });
      expect(r.saida).not.toContain(k.senha);
      const rodaram = conferirSegredos(raiz, k, 2);
      // todas as etapas rodaram de verdade neste teste
      expect(rodaram).toEqual(['aapt2', 'apksigner', 'curl', 'gradle', 'java', 'keytool', 'mv', 'node', 'npm', 'perl', 'sdkmanager', 'unzip', 'zipalign']);
      // o Gradle não recebe nenhuma propriedade de assinatura
      expect(readFileSync(args, 'utf8').trim()).toBe('-p android --no-daemon assemblePagbankRelease assembleTabletRelease');
      // e as linhas de comando do keytool e do apksigner pedem a senha pela entrada padrão
      const sign = chamadas(raiz).filter((c) => c.nome === 'apksigner' && c.texto.startsWith('ARGV: sign'));
      expect(sign).toHaveLength(2);
      for (const c of sign) expect(c.texto.split('\n')[0]).toContain(`--ks ${k.chave} --ks-key-alias tchefood --ks-pass stdin`);
    });

    it('P1-02: com `bash -a` (toda variável exportada) a senha e os caminhos da chave continuam fora do ambiente dos programas', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const r = spawnSync('bash', ['-a', 'scripts/build-apk.sh', 'all'], { cwd: raiz, encoding: 'utf8',
        env: ambiente(raiz, { gerar: 'pagbank tablet', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' } }) });
      expect(r.status).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank'), 'tchefood-tablet.apk': assinado('A-tablet') });
      conferirSegredos(raiz, k, 2);
    });

    it('P1-02: variáveis com os nomes internos do script já exportadas por quem chama não levam a senha nem os caminhos aos programas', () => {
      // o bash mantém exportada a variável que veio do ambiente: sem apagar esses nomes, `chave_senha=<a senha>`
      // seguiria para o Gradle e para todo programa filho
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', extra: {
        ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1',
        chave_senha: 'herdada', chave_arquivo: 'herdada', chave_senha_arquivo: 'herdada', chave_alias: 'herdada',
        chave_pasta: 'herdada', registro: 'herdada', motivo: 'herdada', senha_no_ambiente: 'herdada',
      } });
      expect(r.codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank'), 'tchefood-tablet.apk': assinado('A-tablet') });
      const rodaram = conferirSegredos(raiz, k, 2);
      expect(rodaram).toEqual(expect.arrayContaining(['aapt2', 'apksigner', 'gradle', 'java', 'keytool', 'node', 'perl', 'zipalign']));
      // o alias usado é o padrão, não o valor herdado
      const sign = chamadas(raiz).filter((c) => c.nome === 'apksigner' && c.texto.startsWith('ARGV: sign'));
      for (const c of sign) expect(c.texto.split('\n')[0]).toContain(`--ks ${k.chave} --ks-key-alias tchefood --ks-pass stdin`);
    });

    it('SHELLOPTS exportado por quem chama não segue para os programas do build (os lançadores do SDK são scripts bash e parariam com as opções deste script)', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      for (const [build, extra] of [['A', { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_VC: '400' }], ['B', {}]] as [string, Record<string, string>][]) {
        rmSync(join(raiz, 'reg'), { recursive: true, force: true });
        mkdirSync(join(raiz, 'reg'));
        const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', build, extra: { ...extra, SHELLOPTS: 'allexport' } });
        expect(r.codigo, r.saida).toBe(0);
        const todas = chamadas(raiz);
        expect(todas.length).toBeGreaterThan(3);
        for (const c of todas) {
          expect(c.texto.split('\n').slice(1).filter((l) => l.startsWith('SHELLOPTS=')), `${c.nome} herdou SHELLOPTS`).toEqual([]);
        }
        if (build === 'A') conferirSegredos(raiz, k, 1);
      }
    });

    it('P1-02/P2-03: senha pelo ambiente é recusada antes de qualquer programa rodar, com ou sem chave', () => {
      for (const extra of [
        { TCHEFOOD_KEYSTORE_PASSWORD: 'senha-no-ambiente' },
        { TCHEFOOD_KEY_PASSWORD: 'senha-no-ambiente' },
        // as variáveis que a versão anterior do script entregava ao Gradle
        { ORG_GRADLE_PROJECT_TCHEFOOD_KEYSTORE_PASSWORD: 'senha-no-ambiente' },
        { ORG_GRADLE_PROJECT_TCHEFOOD_KEY_PASSWORD: 'senha-no-ambiente' },
      ] as Record<string, string>[]) {
        const raiz = criarRepo();
        const k = chaveFalsa(raiz);
        const com = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, ...extra, TCHEFOOD_PRIMEIRO_RELEASE: '1' } });
        expect(com.codigo).not.toBe(0);
        expect(com.saida).toContain('a senha da chave não entra pelo ambiente');
        expect(com.saida).not.toContain('senha-no-ambiente');
        const sem = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra });
        expect(sem.codigo).not.toBe(0);
        expect(sem.saida).toContain('a senha da chave não entra pelo ambiente');
        // nem a trava foi pedida: nenhuma ferramenta (java, node, perl...) chegou a rodar
        expect(chamadas(raiz)).toEqual([]);
        expect(apks(raiz)).toEqual({});
        // nem com rastro de comandos (bash -x) o valor é escrito
        const x = spawnSync('bash', ['-x', 'scripts/build-apk.sh', 'pagbank'], { cwd: raiz, encoding: 'utf8',
          env: ambiente(raiz, { gerar: 'pagbank', extra: { ...k.env, ...extra } }) });
        expect(x.status).not.toBe(0);
        expect(`${x.stdout}${x.stderr}`).not.toContain('senha-no-ambiente');
      }
    });

    it('P1-02: variáveis ORG_GRADLE_PROJECT_TCHEFOOD_* herdadas (caminho e alias) não chegam a nenhum programa', () => {
      const raiz = criarRepo();
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: {
        ORG_GRADLE_PROJECT_TCHEFOOD_KEYSTORE_FILE: '/caminho/antigo.jks', ORG_GRADLE_PROJECT_TCHEFOOD_KEY_ALIAS: 'alias-antigo',
      } });
      expect(r.codigo).toBe(0);
      expect(chamadas(raiz).length).toBeGreaterThan(3);
      for (const c of chamadas(raiz)) expect(c.texto, c.nome).not.toContain('ORG_GRADLE_PROJECT_TCHEFOOD');
    });

    it('P1-02: release com rastro de comandos (bash -x) é recusado antes de ler a senha', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const r = spawnSync('bash', ['-x', 'scripts/build-apk.sh', 'pagbank'], { cwd: raiz, encoding: 'utf8',
        env: ambiente(raiz, { gerar: 'pagbank', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1' } }) });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('release não roda com rastro de comandos');
      expect(`${r.stdout}${r.stderr}`).not.toContain(k.senha);
      expect(entradaDe(raiz, 'keytool')).toBe('');
      expect(apks(raiz)).toEqual({});
    });

    // Terminal de verdade (pty) pelo `script` do util-linux: o teste espera a pergunta aparecer e só então digita.
    const temScript = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;
    it.skipIf(!temScript)('P2-03: sem arquivo de senha, pergunta no terminal sem mostrar o que foi digitado, e o release sai', async () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const env = ambiente(raiz, { gerar: 'pagbank', extra: { TCHEFOOD_KEYSTORE: k.chave, TCHEFOOD_PRIMEIRO_RELEASE: '1' } });
      const filho = spawn('script', ['-qec', 'bash scripts/build-apk.sh pagbank', '/dev/null'], { cwd: raiz, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let tela = '';
      filho.stdout.on('data', (d) => { tela += String(d); });
      filho.stderr.on('data', (d) => { tela += String(d); });
      const fim = new Promise<number | null>((ok) => filho.on('close', (c) => ok(c)));
      await esperar(() => tela.includes('Senha da chave do Tchê Food'));
      await new Promise((r) => setTimeout(r, 200)); // o bash já desligou o eco quando mostra a pergunta
      filho.stdin.write(`${k.senha}\n`);
      const codigo = await fim;
      expect(tela).toContain('Pronto.');
      expect(codigo).toBe(0);
      expect(tela).not.toContain(k.senha);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank') });
      conferirSegredos(raiz, k, 1);
    }, 30000);

    it('P2-03: a documentação e a ajuda do script não mandam digitar a senha em comando nenhum', () => {
      const doc = readFileSync(resolve(__dirname, '..', 'docs', 'apk-release.md'), 'utf8');
      const ajuda = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' }).stdout;
      for (const texto of [doc, ajuda]) {
        // nenhuma atribuição de senha em linha de comando, nem opção de senha em keytool/apksigner
        expect(texto).not.toMatch(/PASSWORD=/);
        expect(texto).not.toMatch(/-(storepass|keypass)\b|--(ks|key)-pass\s+pass:/);
      }
      expect(doc).toContain('TCHEFOOD_KEYSTORE_PASSWORD_FILE');
      expect(ajuda).toContain('pergunta a senha');
    });
  });

  describe('metadados conferidos antes de publicar (P2-02)', () => {
    const casos: [string, Record<string, string>, string][] = [
      ['o aapt2 termina com erro', { FAKE_AAPT2_FALHAR: 'tablet' }, 'o aapt2 não conseguiu ler o APK da variante tablet'],
      ['o aapt2 não devolve nada', { FAKE_AAPT2_VAZIO: 'tablet' }, 'não consegui ler os dados do APK da variante tablet (esperava 1 linha package:'],
      ['o aapt2 devolve duas linhas package:', { FAKE_PACOTE_DUAS_VEZES: 'tablet' }, 'esperava 1 linha package: na resposta do aapt2 e achei 2'],
      ['versionCode diferente entre pagbank e tablet', { FAKE_VC_TABLET: '413' }, 'as variantes saíram com versões diferentes'],
      ['pacote do tablet trocado pelo do pagbank', { FAKE_PACOTE_TABLET: 'food.tche.smartpos' }, 'e o esperado é "food.tche.smartpos.tablet"'],
      ['versionCode que não é número', { FAKE_VC: 'abc' }, 'versionCode que não é número: "abc"'],
      ['versionCode com zero à esquerda', { FAKE_VC: '0412' }, 'versionCode que não é número: "0412"'],
      ['versionCode acima do limite do Android', { FAKE_VC: '2100000001' }, 'versionCode fora do limite'],
      // o aapt2 não escapa aspas: um versionName com aspas não pode fazer o script ler outra versão
      ['versionName com aspas que imita outro versionCode', { FAKE_VN: "0.1.5' versionCode='7' versionName='falso" }, 'versionCode ou versionName repetido'],
      ['versionName com caractere inesperado', { FAKE_VN: '0.1 412' }, 'versionName vazio ou com caractere inesperado'],
    ];
    it.each(casos)('debug: %s: não publica e o conjunto anterior fica intacto', (_, extra, mensagem) => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const antes = apks(raiz);
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', extra });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain(mensagem);
      expect(r.saida).not.toContain('cloudshell download');
      expect(apks(raiz)).toEqual(antes);
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(1);
    });

    it.each(casos)('release: %s: não publica, o conjunto anterior fica intacto e nada entra no registro', (_, extra, mensagem) => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', extra: { ...k.env, FAKE_VC: '400', TCHEFOOD_PRIMEIRO_RELEASE: '1' } }).codigo).toBe(0);
      const antes = apks(raiz);
      const registroAntes = readFileSync(k.registro, 'utf8');
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', extra: { ...k.env, FAKE_VC: '401', ...extra } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain(mensagem);
      expect(apks(raiz)).toEqual(antes);
      expect(readFileSync(k.registro, 'utf8')).toBe(registroAntes);
    });

    it('release depurável (um build de debug na pasta de release) não é publicado; no debug a linha é normal', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_DEBUGGABLE: '1' } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('é depurável (application-debuggable)');
      expect(apks(raiz)).toEqual({});
      expect(linhasDoRegistro(k.registro)).toEqual([]);
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { FAKE_DEBUGGABLE: '1' } }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank' });
    });

    it('cada variante é lida: o aapt2 roda uma vez por APK, antes da troca de apk/', () => {
      const raiz = criarRepo();
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet' });
      expect(r.codigo).toBe(0);
      const lidos = chamadas(raiz).filter((c) => c.nome === 'aapt2').map((c) => c.texto.split('\n')[0].replace(/.*\//, ''));
      expect(lidos.sort()).toEqual(['tchefood-pagbank-debug.apk', 'tchefood-tablet-debug.apk']);
      // o aapt2 leu os arquivos na pasta da versão nova (.apk-releases/r.*), não em apk/
      for (const c of chamadas(raiz).filter((x) => x.nome === 'aapt2')) expect(c.texto.split('\n')[0]).toContain('/.apk-releases/r.');
    });

    it('o Gradle não assina release e o workflow do GitHub só gera debug, sem segredo nenhum', () => {
      const gradle = readFileSync(resolve(__dirname, '..', 'android', 'app', 'build.gradle.kts'), 'utf8');
      expect(gradle).not.toMatch(/signingConfigs?\s*[={(.]|storePassword|keyPassword|TCHEFOOD_KEY/);
      const workflow = readFileSync(resolve(__dirname, '..', '.github', 'workflows', 'android-apk.yml'), 'utf8');
      expect(workflow).toContain('assembleDebug');
      expect(workflow).not.toMatch(/secrets\.|Release|KEYSTORE|apksigner/);
      const ignorados = readFileSync(resolve(__dirname, '..', '.gitignore'), 'utf8').split('\n');
      for (const padrao of ['*.jks', '*.keystore', '*.releases.tsv']) expect(ignorados).toContain(padrao);
    });

    it('os pacotes que o script espera são os do android/app/build.gradle.kts', () => {
      const gradle = readFileSync(resolve(__dirname, '..', 'android', 'app', 'build.gradle.kts'), 'utf8');
      const script = readFileSync(SCRIPT, 'utf8');
      const base = /applicationId = "([^"]+)"/.exec(gradle)?.[1];
      const sufixo = /applicationIdSuffix = "([^"]+)"/.exec(gradle)?.[1];
      expect(base).toBe('food.tche.smartpos');
      expect(script).toContain(`pagbank) echo "${base}" ;;`);
      expect(script).toContain(`tablet) echo "${base}${sufixo}" ;;`);
    });

    it('depois de publicado, uma saída fechada não transforma o build em falha', async () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const trocaPausa = join(raiz, 'pausa-troca');
      const trocaMarca = join(raiz, 'na-troca');
      writeFileSync(trocaPausa, '');
      // para logo depois da troca de apk/ (antes de registrar .apk-anterior), fecha a saída e solta
      const b = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', trocaPausa, trocaMarca, trocaAlvo: '.apk-anterior' });
      await esperar(() => existsSync(trocaMarca) || b.terminou());
      expect(b.terminou()).toBe(false);
      b.filho.stdout?.destroy();
      b.filho.stderr?.destroy();
      rmSync(trocaPausa);
      const { codigo, sinal } = await b.saiu;
      expect({ codigo, sinal }).toEqual({ codigo: 0, sinal: null });
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
    }, 30000);

    it('depois de publicado, um TERM não muda o resultado: sai com sucesso, apk/ é a versão nova e a anterior fica registrada', async () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const trocaPausa = join(raiz, 'pausa-troca');
      const trocaMarca = join(raiz, 'na-troca');
      writeFileSync(trocaPausa, '');
      const b = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', trocaPausa, trocaMarca, trocaAlvo: '.apk-anterior' });
      await esperar(() => existsSync(trocaMarca) || b.terminou());
      expect(b.terminou()).toBe(false);
      // TERM no grupo inteiro (o script e o comando que ele espera), com apk/ já trocado
      process.kill(-(b.filho.pid as number), 'SIGTERM');
      rmSync(trocaPausa);
      const { codigo, sinal } = await b.saiu;
      expect({ codigo, sinal }).toEqual({ codigo: 0, sinal: null });
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
      expect(existsSync(join(raiz, '.apk-pendente'))).toBe(false);
      expect(readFileSync(join(raiz, '.apk-anterior', 'tchefood-pagbank-debug.apk'), 'utf8')).toBe('A-pagbank');
    }, 30000);

    it('depois de publicado, um segundo TERM no meio da limpeza também não muda o resultado', async () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const trocaPausa = join(raiz, 'pausa-troca');
      const trocaMarca = join(raiz, 'na-troca');
      writeFileSync(trocaPausa, '');
      const b = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', trocaPausa, trocaMarca, trocaAlvo: '.apk-anterior' });
      await esperar(() => existsSync(trocaMarca) || b.terminou());
      expect(b.terminou()).toBe(false);
      // primeiro TERM, com apk/ já trocado: a limpeza começa e para de novo na mesma renomeação (a pausa continua lá)
      rmSync(trocaMarca);
      process.kill(-(b.filho.pid as number), 'SIGTERM');
      await esperar(() => existsSync(trocaMarca) || b.terminou());
      expect(b.terminou()).toBe(false);
      // segundo TERM, agora no meio da limpeza
      process.kill(-(b.filho.pid as number), 'SIGTERM');
      await new Promise((ok) => setTimeout(ok, 300));
      rmSync(trocaPausa);
      const { codigo, sinal } = await b.saiu;
      expect({ codigo, sinal }).toEqual({ codigo: 0, sinal: null });
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
      expect(existsSync(join(raiz, '.apk-pendente'))).toBe(false);
      expect(readFileSync(join(raiz, '.apk-anterior', 'tchefood-pagbank-debug.apk'), 'utf8')).toBe('A-pagbank');
    }, 30000);

    it('depois de publicado, falhar ao registrar a versão anterior vira aviso: o build termina bem e a execução seguinte conclui', () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'A' }).codigo).toBe(0);
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'B', extra: { FAKE_RENAME_ANTERIOR_FALHAR: '1' } });
      expect(r.saida).toContain('AVISO: apk/ já tem a versão nova');
      expect(r.codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank' });
      // a versão que saiu (A) continua guardada, pelo registro pendente
      const pastaA = readlinkSync(join(raiz, '.apk-pendente'));
      expect(readFileSync(join(raiz, pastaA, 'tchefood-pagbank-debug.apk'), 'utf8')).toBe('A-pagbank');
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'C' }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'C-pagbank' });
      expect(existsSync(join(raiz, '.apk-pendente'))).toBe(false);
      expect(readFileSync(join(raiz, '.apk-anterior', 'tchefood-pagbank-debug.apk'), 'utf8')).toBe('B-pagbank');
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(2);
    });
  });

  describe('registro de releases: o versionCode só sobe (P2-01)', () => {
    const release = (raiz: string, k: ReturnType<typeof chaveFalsa>, variante: string, build: string, vc: number, extra: Record<string, string> = {}) =>
      rodar(raiz, variante, { gerar: variante === 'all' ? 'pagbank tablet' : variante, build, extra: { ...k.env, FAKE_VC: String(vc), ...extra } });
    const resumo = (k: ReturnType<typeof chaveFalsa>) => linhasDoRegistro(k.registro).map((l) => `${l[0]} ${l[1]}`);

    it('primeiro release: sem TCHEFOOD_PRIMEIRO_RELEASE=1 para antes de compilar; com ela publica e registra cada APK', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      const args = join(raiz, 'args');
      const sem = release(raiz, k, 'all', 'A', 400, { FAKE_ARGS: args });
      expect(sem.codigo).not.toBe(0);
      expect(sem.saida).toContain('não achei release nenhum registrado para esta chave');
      expect(existsSync(args)).toBe(false);
      expect(existsSync(k.registro)).toBe(false);
      expect(entradaDe(raiz, 'keytool')).toBe(''); // nem chegou a ler a senha

      const com = release(raiz, k, 'all', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' });
      expect(com.codigo).toBe(0);
      expect(readFileSync(k.registro, 'utf8').split('\n')[0]).toMatch(/^# Tchê Food: releases publicados com esta chave/);
      expect(readFileSync(k.registro, 'utf8').endsWith('\n')).toBe(true);
      const linhas = linhasDoRegistro(k.registro);
      expect(linhas.map((l) => l.slice(0, 4))).toEqual([
        ['pagbank', '400', '0.1.400-abc1234', sha256(assinado('A-pagbank'))],
        ['tablet', '400', '0.1.400-abc1234', sha256(assinado('A-tablet'))],
      ]);
      for (const l of linhas) expect(l[4]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(com.saida).toContain('-> registro de releases: pagbank 400: registrado; tablet 400: registrado');
      expect(com.saida).toContain(`Registro de releases: ${k.registro}`);
    });

    it('critério do achado: depois do 400, o 399 e um 400 com outro conteúdo são recusados antes de publicar; o 401 passa', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'all', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      const publicado = apks(raiz);
      const registrado = readFileSync(k.registro, 'utf8');

      const menor = release(raiz, k, 'all', 'B', 399);
      expect(menor.codigo).not.toBe(0);
      expect(menor.saida).toContain('o release 399 da variante pagbank é mais antigo que o último publicado com esta chave (400)');
      expect(menor.saida).toContain('TCHEFOOD_VERSION_CODE=401');
      expect(apks(raiz)).toEqual(publicado);
      expect(readFileSync(k.registro, 'utf8')).toBe(registrado);

      const igualDiferente = release(raiz, k, 'all', 'B', 400);
      expect(igualDiferente.codigo).not.toBe(0);
      expect(igualDiferente.saida).toContain('já existe um release 400 da variante pagbank publicado com esta chave, e o APK de agora é outro');
      expect(apks(raiz)).toEqual(publicado);
      expect(readFileSync(k.registro, 'utf8')).toBe(registrado);
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(1);

      const maior = release(raiz, k, 'all', 'B', 401);
      expect(maior.codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('B-pagbank'), 'tchefood-tablet.apk': assinado('B-tablet') });
      expect(resumo(k)).toEqual(['pagbank 400', 'tablet 400', 'pagbank 401', 'tablet 401']);
      expect(readFileSync(k.registro, 'utf8').startsWith(registrado)).toBe(true);
    });

    it('o mesmo número só passa de novo se o APK for idêntico ao registrado, e aí nada novo entra no registro', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'all', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      const registrado = readFileSync(k.registro, 'utf8');
      // debug no meio: apk/ muda, o registro não
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'D' }).codigo).toBe(0);
      const denovo = release(raiz, k, 'all', 'A', 400);
      expect(denovo.codigo).toBe(0);
      expect(denovo.saida).toContain('pagbank 400: já registrado, APK idêntico');
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank'), 'tchefood-tablet.apk': assinado('A-tablet') });
      expect(readFileSync(k.registro, 'utf8')).toBe(registrado);
    });

    it('a sequência é uma só para as duas variantes: nenhuma volta, e o mesmo número é sempre o mesmo commit', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'all', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      expect(release(raiz, k, 'pagbank', 'B', 401).codigo).toBe(0);
      // o tablet não pode sair no 400 depois de o pagbank já estar no 401, nem com o APK idêntico ao 400 registrado
      const volta = release(raiz, k, 'tablet', 'A', 400);
      expect(volta.codigo).not.toBe(0);
      expect(volta.saida).toContain('o release 400 da variante tablet é mais antigo que o último publicado com esta chave (401)');
      // tablet 401 de outro commit (versionName diferente do pagbank 401 registrado): recusado
      const outroCommit = release(raiz, k, 'tablet', 'B', 401, { FAKE_COMMIT: 'def5678' });
      expect(outroCommit.codigo).not.toBe(0);
      expect(outroCommit.saida).toContain('o release 401 já foi registrado com esta chave como 0.1.401-abc1234, e o APK de agora é 0.1.401-def5678');
      // all no 401: o pagbank tem de ser idêntico ao 401 registrado (build B); com outro conteúdo, nada entra
      const antes = readFileSync(k.registro, 'utf8');
      expect(release(raiz, k, 'all', 'C', 401).codigo).not.toBe(0);
      expect(readFileSync(k.registro, 'utf8')).toBe(antes);
      expect(release(raiz, k, 'all', 'B', 401).codigo).toBe(0);
      expect(resumo(k)).toEqual(['pagbank 400', 'tablet 400', 'pagbank 401', 'tablet 401']);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('B-pagbank'), 'tchefood-tablet.apk': assinado('B-tablet') });
    });

    it('piso: nem o primeiro release de um registro novo sai com número igual ou menor que o último publicado antes do registro (364)', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      for (const vc of [1, 363, 364]) {
        const r = release(raiz, k, 'pagbank', 'A', vc, { TCHEFOOD_PRIMEIRO_RELEASE: '1' });
        expect(r.codigo, String(vc)).not.toBe(0);
        expect(r.saida).toContain(`o release ${vc} da variante pagbank não é maior que o último publicado antes de existir o registro (364)`);
        expect(r.saida).toContain('TCHEFOOD_VERSION_CODE=365');
        expect(existsSync(k.registro)).toBe(false); // nem um registro vazio fica para trás
        expect(apks(raiz)).toEqual({});
      }
      expect(release(raiz, k, 'pagbank', 'A', 365, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      expect(resumo(k)).toEqual(['pagbank 365']);
    });

    it('registro com o 364 já publicado (como o da chave oficial): o mesmo APK passa de novo, outro conteúdo no 364 não, e o 365 entra', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      writeFileSync(k.registro, `pagbank\t364\t0.1.364-abc1234\t${sha256(assinado('A-pagbank'))}\t2026-11-26T03:00:00Z\n`);
      expect(release(raiz, k, 'pagbank', 'A', 364).codigo).toBe(0);
      expect(release(raiz, k, 'pagbank', 'B', 364).codigo).not.toBe(0);
      expect(release(raiz, k, 'pagbank', 'B', 365).codigo).toBe(0);
      expect(resumo(k)).toEqual(['pagbank 364', 'pagbank 365']);
    });

    it('TCHEFOOD_PRIMEIRO_RELEASE=1 com release já registrado é recusado (a variável não vira hábito que esconde a perda do registro)', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'pagbank', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      const args = join(raiz, 'args');
      const r = release(raiz, k, 'pagbank', 'B', 401, { TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_ARGS: args });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('TCHEFOOD_PRIMEIRO_RELEASE=1 só vale quando ainda não há release registrado');
      expect(existsSync(args)).toBe(false);
      // registro perdido (apagado ou zerado): volta a exigir a confirmação explícita
      writeFileSync(k.registro, '');
      const perdido = release(raiz, k, 'pagbank', 'B', 399);
      expect(perdido.codigo).not.toBe(0);
      expect(perdido.saida).toContain('não achei release nenhum registrado para esta chave');
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank') });
    });

    it('registro fora do formato: para antes de pedir a senha e de compilar, e o arquivo não é tocado', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'pagbank', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      const bom = readFileSync(k.registro, 'utf8');
      const senhasAntes = entradaDe(raiz, 'keytool');
      const args = join(raiz, 'args');
      const linha = (v: string, vc: string, vn: string, sha: string) => `${v}\t${vc}\t${vn}\t${sha}\t2026-01-01T00:00:00Z\n`;
      const ruins: [string, string][] = [
        ['linha solta', `${bom}linha solta\n`],
        ['linha em branco', `${bom}\n`],
        ['arquivo que é só uma linha em branco', '\n'],
        ['versionCode acima do limite do Android', bom + linha('pagbank', '2100000001', '0.1.2100000001-x', 'a'.repeat(64))],
        ['versionCode que não é número', bom + linha('pagbank', 'abc', '0.1.1-x', 'a'.repeat(64))],
        ['SHA-256 curto', bom + linha('pagbank', '401', '0.1.401-x', 'abc')],
        ['variante desconhecida', bom + linha('outra', '401', '0.1.401-x', 'a'.repeat(64))],
        ['a mesma variante e número duas vezes', bom + linha('pagbank', '400', '0.1.400-abc1234', 'b'.repeat(64))],
        ['o mesmo número com dois versionName', bom + linha('tablet', '400', '0.1.400-outro', 'b'.repeat(64))],
        ['número menor depois de um maior', bom + linha('tablet', '399', '0.1.399-x', 'b'.repeat(64))],
        ['campo a mais', `${bom}pagbank\t401\t0.1.401-x\t${'a'.repeat(64)}\t2026-01-01T00:00:00Z\textra\n`],
        ['fim de linha do Windows', bom.replace(/\n/g, '\r\n')],
        ['última linha sem fim de linha', bom.replace(/\n$/, '')],
        ['marca BOM no começo', `\uFEFF${bom}`],
      ];
      for (const [nome, ruim] of ruins) {
        writeFileSync(k.registro, ruim);
        const r = release(raiz, k, 'pagbank', 'B', 402, { FAKE_ARGS: args });
        expect(r.codigo, nome).not.toBe(0);
        expect(r.saida, nome).toContain('o registro de releases está fora do formato');
        expect(existsSync(args), nome).toBe(false);
        expect(readFileSync(k.registro, 'utf8'), nome).toBe(ruim);
      }
      expect(entradaDe(raiz, 'keytool')).toBe(senhasAntes);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank') });
      // a cópia boa de volta: segue normalmente
      writeFileSync(k.registro, bom);
      expect(release(raiz, k, 'pagbank', 'B', 401).codigo).toBe(0);
      expect(resumo(k)).toEqual(['pagbank 400', 'pagbank 401']);
    });

    it('a troca de apk/ falha depois de a linha ser gravada: a linha fica (o número está amarrado àquele APK); o mesmo APK passa depois, outro pede número maior', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'pagbank', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'B', renameApkFalhar: true, extra: { ...k.env, FAKE_VC: '401' } });
      expect(r.codigo).not.toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank') });
      expect(resumo(k)).toEqual(['pagbank 400', 'pagbank 401']);
      const outro = release(raiz, k, 'pagbank', 'C', 401);
      expect(outro.codigo).not.toBe(0);
      expect(outro.saida).toContain('TCHEFOOD_VERSION_CODE=402');
      expect(release(raiz, k, 'pagbank', 'B', 401).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('B-pagbank') });
      expect(release(raiz, k, 'pagbank', 'C', 402).codigo).toBe(0);
      expect(resumo(k)).toEqual(['pagbank 400', 'pagbank 401', 'pagbank 402']);
    });

    it('SIGKILL entre gravar a linha e trocar apk/: o registro fica à frente (lado seguro); o mesmo APK ainda publica e um diferente não', async () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'pagbank', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      const trocaPausa = join(raiz, 'pausa-troca');
      const trocaMarca = join(raiz, 'na-troca');
      writeFileSync(trocaPausa, '');
      const b = rodarEmSegundoPlano(raiz, 'pagbank', { gerar: 'pagbank', build: 'B', trocaPausa, trocaMarca, trocaAlvo: 'apk', extra: { ...k.env, FAKE_VC: '401' } });
      await esperar(() => existsSync(trocaMarca) || b.terminou());
      expect(b.terminou()).toBe(false);
      process.kill(-(b.filho.pid as number), 'SIGKILL');
      await b.fim;
      rmSync(trocaPausa);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank') });
      expect(resumo(k)).toEqual(['pagbank 400', 'pagbank 401']);
      expect(release(raiz, k, 'pagbank', 'C', 401).codigo).not.toBe(0);
      expect(release(raiz, k, 'pagbank', 'B', 401).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('B-pagbank') });
      expect(linhasDoRegistro(k.registro)).toHaveLength(2);
    }, 30000);

    it('duas cópias do projeto com a mesma chave, ao mesmo tempo, com o mesmo número e APKs diferentes: só uma publica', async () => {
      const a = criarRepo();
      const b = criarRepo();
      const k = chaveFalsa(a);
      expect(release(a, k, 'pagbank', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      // as duas param no Gradle, já compilando, e são soltas juntas
      const pausa = join(a, 'pausa-gradle');
      writeFileSync(pausa, '');
      const marcaA = join(a, 'no-gradle');
      const marcaB = join(b, 'no-gradle');
      const ra = rodarEmSegundoPlano(a, 'pagbank', { gerar: 'pagbank', build: 'XA', pausa, marca: marcaA, extra: { ...k.env, FAKE_VC: '401' } });
      const rb = rodarEmSegundoPlano(b, 'pagbank', { gerar: 'pagbank', build: 'XB', pausa, marca: marcaB, extra: { ...k.env, FAKE_VC: '401' } });
      await esperar(() => (existsSync(marcaA) || ra.terminou()) && (existsSync(marcaB) || rb.terminou()));
      rmSync(pausa);
      const [fa, fb] = await Promise.all([ra.saiu, rb.saiu]);
      const codigos = [fa.codigo, fb.codigo];
      expect(codigos.filter((c) => c === 0)).toHaveLength(1);
      expect(resumo(k)).toEqual(['pagbank 400', 'pagbank 401']);
      const vencedor = fa.codigo === 0 ? 'XA' : 'XB';
      expect(linhasDoRegistro(k.registro)[1][3]).toBe(sha256(assinado(`${vencedor}-pagbank`)));
      expect(apks(fa.codigo === 0 ? a : b)).toEqual({ 'tchefood-pagbank.apk': assinado(`${vencedor}-pagbank`) });
      expect(apks(fa.codigo === 0 ? b : a)).toEqual(fa.codigo === 0 ? {} : { 'tchefood-pagbank.apk': assinado('A-pagbank') });
    }, 30000);

    // Um processo à parte segura a trava (flock) do registro, como um release rodando em outra cópia do projeto.
    // soltar() faz esse processo sair; com apagar, ele apaga o registro antes de sair (o que faz um primeiro
    // release recusado por uma regra, com o registro vazio que criou).
    async function segurarTravaDoRegistro(raiz: string, registro: string, apagar = false) {
      const solta = join(raiz, `solta-a-trava-${Math.random().toString(36).slice(2)}`);
      const travou = `${solta}.travou`;
      writeFileSync(solta, '');
      const dono = spawn(PERL_REAL, ['-e',
        'use Fcntl qw(:flock); open(my $f, "+>>", $ARGV[0]) or die "abrir: $!"; flock($f, LOCK_EX) or die "trava: $!"; ' +
        'open(my $m, ">", $ARGV[2]) or die; close($m); select(undef, undef, undef, 0.05) while -e $ARGV[1]; ' +
        'unlink($ARGV[0]) if $ARGV[3];',
        registro, solta, travou, apagar ? '1' : ''], { stdio: 'ignore' });
      const saiu = new Promise((ok) => dono.on('close', ok));
      await esperar(() => existsSync(travou));
      return { soltar: async () => { rmSync(solta, { force: true }); await saiu; } };
    }
    // O release compila, assina e confere; ao chegar no registro, fica esperando a trava. Devolve quando o APK
    // assinado já está na pasta da versão nova e passou um tempo sem o script terminar.
    async function esperarNaTrava(raiz: string, r: ReturnType<typeof rodarEmSegundoPlano>, conteudo: string) {
      const novaAssinada = () => existsSync(join(raiz, '.apk-releases')) && readdirSync(join(raiz, '.apk-releases'))
        .some((d) => { try { return readFileSync(join(raiz, '.apk-releases', d, 'tchefood-pagbank.apk'), 'utf8') === conteudo; } catch { return false; } });
      await esperar(() => novaAssinada() || r.terminou());
      await new Promise((ok) => setTimeout(ok, 1500));
      expect(r.terminou(), r.saida()).toBe(false);
    }

    it('enquanto outro processo segura a trava do registro, o release espera: nada é gravado nem publicado antes de a trava sair', async () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(release(raiz, k, 'pagbank', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      const trava = await segurarTravaDoRegistro(raiz, k.registro);
      try {
        const r = rodarEmSegundoPlano(raiz, 'pagbank', { gerar: 'pagbank', build: 'B', extra: { ...k.env, FAKE_VC: '401' } });
        await esperarNaTrava(raiz, r, assinado('B-pagbank'));
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank') });
        expect(resumo(k)).toEqual(['pagbank 400']);
        await trava.soltar();
        const fim = await r.saiu;
        expect(fim.codigo, r.saida()).toBe(0);
        expect(resumo(k)).toEqual(['pagbank 400', 'pagbank 401']);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('B-pagbank') });
      } finally {
        await trava.soltar();
      }
    }, 30000);

    it('registro apagado por outro release enquanto este esperava a trava: para sem gravar nem publicar, e rodar de novo funciona', async () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      // o outro release criou o registro (vazio), está com a trava e vai apagá-lo ao sair
      const trava = await segurarTravaDoRegistro(raiz, k.registro, true);
      try {
        const r = rodarEmSegundoPlano(raiz, 'pagbank', { gerar: 'pagbank', build: 'A', extra: { ...k.env, TCHEFOOD_PRIMEIRO_RELEASE: '1', FAKE_VC: '400' } });
        await esperarNaTrava(raiz, r, assinado('A-pagbank'));
        await trava.soltar();
        const fim = await r.saiu;
        expect(fim.codigo, r.saida()).not.toBe(0);
        expect(r.saida()).toContain('o registro de releases foi trocado por outro release enquanto este esperava a vez');
        expect(r.saida()).toContain('Rode de novo');
        expect(apks(raiz)).toEqual({});
        expect(existsSync(k.registro)).toBe(false);
      } finally {
        await trava.soltar();
      }
      expect(release(raiz, k, 'pagbank', 'A', 400, { TCHEFOOD_PRIMEIRO_RELEASE: '1' }).codigo).toBe(0);
      expect(resumo(k)).toEqual(['pagbank 400']);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank.apk': assinado('A-pagbank') });
    }, 30000);

    it('TCHEFOOD_VERSION_CODE vai para o Gradle como propriedade; valor que não é número de 1 a 2100000000 para antes de tudo', () => {
      const raiz = criarRepo();
      const args = join(raiz, 'args');
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { FAKE_ARGS: args, TCHEFOOD_VERSION_CODE: '500' } });
      expect(r.codigo).toBe(0);
      expect(readFileSync(args, 'utf8').trim()).toBe('-p android --no-daemon -PTCHEFOOD_APP_URL=https://exemplo.test -PTCHEFOOD_VERSION_CODE=500 assemblePagbankDebug');
      rmSync(args);
      for (const ruim of ['abc', '0', '012', '-1', '1.5', '2100000001', '99999999999']) {
        const x = rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'X', extra: { FAKE_ARGS: args, TCHEFOOD_VERSION_CODE: ruim } });
        expect(x.codigo, ruim).not.toBe(0);
        expect(x.saida).toContain('TCHEFOOD_VERSION_CODE precisa ser um número inteiro de 1 a 2100000000');
      }
      expect(existsSync(args)).toBe(false);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank' });
    });

    it('build de debug não lê nem escreve registro nenhum', () => {
      const raiz = criarRepo();
      const k = chaveFalsa(raiz);
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', extra: { FAKE_VC: '5' } }).codigo).toBe(0);
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'B', extra: { FAKE_VC: '4' } }).codigo).toBe(0);
      expect(existsSync(k.registro)).toBe(false);
    });
  });

  describe('publicação atômica (apk/ é um link trocado de uma vez)', () => {
    it('a troca falha: o conjunto anterior continua inteiro e não sobra nada', () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const antes = apks(raiz);
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', renameFalhar: true });
      expect(r.codigo).not.toBe(0);
      expect(apks(raiz)).toEqual(antes);
      expect(readdirSync(raiz).filter((n) => n.startsWith('.apk-link'))).toEqual([]);
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(1);
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'C' }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'C-pagbank', 'tchefood-tablet-debug.apk': 'C-tablet' });
      // ficam só a versão atual (C) e a anterior (A)
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(2);
    });

    it('SIGKILL no meio da publicação: sem rodar o script de novo, apk/ continua inteiro no conjunto anterior', async () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const antes = { 'tchefood-pagbank-debug.apk': 'A-pagbank', 'tchefood-tablet-debug.apk': 'A-tablet' };
      expect(apks(raiz)).toEqual(antes);

      const trocaPausa = join(raiz, 'pausa-troca');
      const trocaMarca = join(raiz, 'na-troca');
      writeFileSync(trocaPausa, '');
      const b = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', trocaPausa, trocaMarca });
      await esperar(() => existsSync(trocaMarca));
      // B está parado na etapa de troca, com o conjunto novo já pronto; mata o grupo inteiro à força
      process.kill(-(b.filho.pid as number), 'SIGKILL');
      await b.fim;

      // sem recuperação nenhuma: apk/ existe e é exatamente o conjunto A
      expect(existsSync(join(raiz, 'apk'))).toBe(true);
      expect(apks(raiz)).toEqual(antes);

      // e a execução seguinte funciona e limpa as sobras
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'C' }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'C-pagbank', 'tchefood-tablet-debug.apk': 'C-tablet' });
      // a pasta do B morto sai; ficam C (atual) e A (anterior)
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(2);
      expect(readdirSync(raiz).filter((n) => n.startsWith('.apk-link'))).toEqual([]);
    }, 30000);

    it('quem lê apk/ durante várias publicações nunca encontra o arquivo ausente', async () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A0' }).codigo).toBe(0);
      const erros: string[] = [];
      let parar = false;
      const leitor = (async () => {
        while (!parar) {
          try {
            const txt = readFileSync(join(raiz, 'apk', 'tchefood-pagbank-debug.apk'), 'utf8');
            if (!/^A\d+-pagbank$/.test(txt)) erros.push(`conteúdo estranho: ${txt}`);
          } catch (e) {
            erros.push(String(e));
          }
          await new Promise((r) => setImmediate(r));
        }
      })();
      for (let i = 1; i <= 12; i++) {
        const { fim } = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: `A${i}` });
        expect(await fim).toBe(0);
      }
      parar = true;
      await leitor;
      expect(erros).toEqual([]);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A12-pagbank', 'tchefood-tablet-debug.apk': 'A12-tablet' });
    }, 60000);

    it('quem já abriu a versão anterior termina de ler os dois APKs dela depois da troca', async () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const pausa = join(raiz, 'pausa-leitor');
      const marca = join(raiz, 'leitor-aberto');
      writeFileSync(pausa, '');
      // o leitor resolve apk/ (cd -P fica com a pasta da versão A aberta) e só lê os arquivos depois da troca
      const leitor = spawn('bash', ['-c', `cd -P apk && : > "${marca}" && while [ -e "${pausa}" ]; do sleep 0.05; done; ` +
        'cat tchefood-pagbank-debug.apk; echo; cat tchefood-tablet-debug.apk'], { cwd: raiz });
      let lido = '';
      leitor.stdout.on('data', (d) => { lido += String(d); });
      leitor.stderr.on('data', (d) => { lido += String(d); });
      const fimLeitor = new Promise<number | null>((ok) => leitor.on('close', (c) => ok(c)));
      await esperar(() => existsSync(marca));

      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' }).codigo).toBe(0);
      // quem chega agora por apk/ vê B inteiro
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
      rmSync(pausa);
      expect(await fimLeitor).toBe(0);
      // e o leitor que já estava na versão A lê o conjunto A inteiro, sem erro
      expect(lido).toBe('A-pagbank\nA-tablet');
    }, 30000);

    it('a troca de apk/ falha depois de B publicado: a referência a A continua e uma execução que falha no Gradle não apaga A', async () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      const leitor = abrirLeitor(raiz, 'apk');
      await leitor.aberto();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' }).codigo).toBe(0);
      // C falha só na renomeação que troca apk/
      const c = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'C', renameApkFalhar: true });
      expect(c.codigo).not.toBe(0);
      expect(c.saida).toContain('não consegui publicar o novo apk/');
      // D falha no Gradle (e passa pela limpeza do início)
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'D', falhar: true }).codigo).not.toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
      expect(await leitor.ler()).toEqual({ codigo: 0, lido: 'A-pagbank\nA-tablet' });
      expect(existsSync(join(raiz, '.apk-pendente'))).toBe(false);
    }, 30000);

    for (const alvo of ['.apk-pendente', 'apk', '.apk-anterior']) {
      it(`SIGKILL antes da renomeação para ${alvo}: quem lia a versão que saía termina de ler, e a seguinte se recupera`, async () => {
        const raiz = criarRepo();
        expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
        expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' }).codigo).toBe(0);
        const leitor = abrirLeitor(raiz, 'apk');
        await leitor.aberto();
        const trocaPausa = join(raiz, 'pausa-troca');
        const trocaMarca = join(raiz, 'na-troca');
        writeFileSync(trocaPausa, '');
        const c = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'C', trocaPausa, trocaMarca, trocaAlvo: alvo });
        await esperar(() => existsSync(trocaMarca) || c.terminou());
        expect(c.terminou()).toBe(false);
        process.kill(-(c.filho.pid as number), 'SIGKILL');
        await c.fim;
        // apk/ é sempre um conjunto inteiro: B (antes da troca) ou C (depois)
        const B = { 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' };
        const C = { 'tchefood-pagbank-debug.apk': 'C-pagbank', 'tchefood-tablet-debug.apk': 'C-tablet' };
        expect([B, C]).toContainEqual(apks(raiz));
        // D falha no Gradle: a limpeza do início não pode apagar a versão B que o leitor tem aberta
        expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'D', falhar: true }).codigo).not.toBe(0);
        expect([B, C]).toContainEqual(apks(raiz));
        expect(await leitor.ler()).toEqual({ codigo: 0, lido: 'B-pagbank\nB-tablet' });
        expect(existsSync(join(raiz, '.apk-pendente'))).toBe(false);
        expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'E' }).codigo).toBe(0);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'E-pagbank', 'tchefood-tablet-debug.apk': 'E-tablet' });
        expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(2);
      }, 30000);
    }

    it('apk/ pasta de verdade, de uma versão antiga do script, é migrada para o formato novo', () => {
      const raiz = criarRepo();
      mkdirSync(join(raiz, 'apk'));
      writeFileSync(join(raiz, 'apk', 'tchefood-pagbank-debug.apk'), 'velho');
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'N' }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'N-pagbank' });
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(2);
    });
    it('SIGKILL na migração da pasta apk/ antiga: a execução seguinte devolve o conjunto antigo antes de limpar', async () => {
      const raiz = criarRepo();
      mkdirSync(join(raiz, 'apk'));
      writeFileSync(join(raiz, 'apk', 'tchefood-pagbank-debug.apk'), 'velho');
      const legadoPausa = join(raiz, 'pausa-legado');
      const legadoMarca = join(raiz, 'na-migracao');
      writeFileSync(legadoPausa, '');
      const b = rodarEmSegundoPlano(raiz, 'pagbank', { gerar: 'pagbank', build: 'N', legadoPausa, legadoMarca });
      await esperar(() => existsSync(legadoMarca) || b.terminou());
      process.kill(-(b.filho.pid as number), 'SIGKILL');
      await b.fim;
      // a execução seguinte falha no Gradle: o conjunto antigo tem de continuar em apk/, não apagado como sobra
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', falhar: true }).codigo).not.toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'velho' });
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', build: 'M' }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'M-pagbank' });
      expect(readdirSync(join(raiz, '.apk-releases'))).toHaveLength(2);
    }, 30000);
  });

  describe('trava entre execuções (flock do sistema operacional)', () => {
    it('trava velha de processo morto e três execuções, uma parada entre ver a trava velha e tirá-la: só uma compila', async () => {
      const raiz = criarRepo();
      // sobras de um processo morto nos dois formatos: a pasta de trava da rodada 3 (com pid morto) e o arquivo de flock
      mkdirSync(join(raiz, '.apk-build.lock'));
      writeFileSync(join(raiz, '.apk-build.lock', 'pid'), '999999');
      writeFileSync(join(raiz, '.apk-build.flock'), '');
      const pausa = join(raiz, 'pausa-gradle');
      writeFileSync(pausa, '');
      const lockPausa = join(raiz, 'pausa-trava');
      const lockMarca = join(raiz, 'na-trava');
      writeFileSync(lockPausa, '');
      const marcaB = join(raiz, 'gradle-B');
      const marcaA = join(raiz, 'gradle-A');

      // B vê a trava velha e para logo antes de tirá-la (só o script com recuperação por PID chega nesse ponto)
      const b = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', pausa, marca: marcaB, lockPausa, lockMarca });
      await esperar(() => existsSync(lockMarca) || existsSync(marcaB) || b.terminou());
      // A chega enquanto B está parado
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', pausa, marca: marcaA });
      await esperar(() => existsSync(marcaA) || a.terminou());
      // B continua
      rmSync(lockPausa);
      await esperar(() => (existsSync(marcaB) || b.terminou()) && (existsSync(marcaA) || a.terminou()));
      // C chega com uma execução ativa
      const c = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'C' });
      expect(c.codigo).not.toBe(0);
      expect(c.saida).toContain('outra execução');

      // só uma das execuções chegou ao Gradle; a outra parou com aviso, sem compilar
      const noGradle = [existsSync(marcaA), existsSync(marcaB)].filter(Boolean).length;
      expect(noGradle).toBe(1);
      const vencedora = existsSync(marcaA) ? 'A' : 'B';
      const perdedora = vencedora === 'A' ? b : a;
      expect(await perdedora.fim).not.toBe(0);
      expect(perdedora.saida()).toContain('outra execução');
      expect(apks(raiz)).toEqual({});

      rmSync(pausa);
      const [fa, fb] = await Promise.all([a.fim, b.fim]);
      expect([fa, fb].filter((x) => x === 0)).toHaveLength(1);
      expect(apks(raiz)).toEqual({
        'tchefood-pagbank-debug.apk': `${vencedora}-pagbank`,
        'tchefood-tablet-debug.apk': `${vencedora}-tablet`,
      });
    }, 30000);

    it('com a trava ocupada, as outras execuções falham sem tocar em nada e a vencedora publica só o seu', async () => {
      const raiz = criarRepo();
      // arquivo de trava deixado por um processo morto: não pode bloquear nem confundir
      writeFileSync(join(raiz, '.apk-build.flock'), '99999');
      const pausa = join(raiz, 'pausa');
      const marca = join(raiz, 'gradle-rodando');
      writeFileSync(pausa, '');
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', pausa, marca });
      await esperar(() => existsSync(marca));

      const saidaA = readdirSync(join(raiz, 'android/app/build/outputs/apk')).sort();
      for (const build of ['B', 'C']) {
        const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build });
        expect(r.codigo).not.toBe(0);
        expect(r.saida).toContain('outra execução');
        expect(apks(raiz)).toEqual({});
        expect(readdirSync(join(raiz, 'android/app/build/outputs/apk')).sort()).toEqual(saidaA);
        expect(readFileSync(join(raiz, 'android/app/build/outputs/apk/pagbank/debug/app-pagbank-debug.apk'), 'utf8')).toBe('A-pagbank');
      }

      rmSync(pausa);
      expect(await a.fim).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank', 'tchefood-tablet-debug.apk': 'A-tablet' });

      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
    }, 30000);

    it('processo morto com SIGKILL solta a trava na hora, sem recuperação', async () => {
      const raiz = criarRepo();
      const pausa = join(raiz, 'pausa');
      const marca = join(raiz, 'gradle-rodando');
      writeFileSync(pausa, '');
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', pausa, marca });
      await esperar(() => existsSync(marca));
      process.kill(-(a.filho.pid as number), 'SIGKILL');
      await a.fim;
      rmSync(pausa);
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
      expect(r.codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
    }, 30000);

    it('um processo deixado em segundo plano pelo Gradle não segura a trava depois do build', () => {
      const raiz = criarRepo();
      const fundo = join(raiz, 'pid-fundo');
      try {
        expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', fundo }).codigo).toBe(0);
        expect(vivo(Number(readFileSync(fundo, 'utf8')))).toBe(true);
        const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
        expect(r.saida).not.toContain('outra execução');
        expect(r.codigo).toBe(0);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
      } finally {
        matarFundo(fundo);
      }
    }, 30000);

    it('A morto no meio do Gradle, com um processo dele ainda vivo: a trava fica livre para B', async () => {
      const raiz = criarRepo();
      const fundo = join(raiz, 'pid-fundo');
      const pausa = join(raiz, 'pausa');
      const marca = join(raiz, 'gradle-rodando');
      writeFileSync(pausa, '');
      try {
        const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', pausa, marca, fundo });
        await esperar(() => existsSync(marca));
        // enquanto A compila, B é recusado
        const durante = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
        expect(durante.codigo).not.toBe(0);
        expect(durante.saida).toContain('outra execução');
        process.kill(-(a.filho.pid as number), 'SIGKILL');
        await a.fim;
        expect(vivo(Number(readFileSync(fundo, 'utf8')))).toBe(true);
        rmSync(pausa);
        const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
        expect(r.codigo).toBe(0);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
      } finally {
        matarFundo(fundo);
      }
    }, 30000);

    it('kill -9 só no bash principal com o Gradle parado: o Gradle é encerrado, ninguém fica com a trava e B roda', async () => {
      const raiz = criarRepo();
      const pausa = join(raiz, 'pausa');
      const marca = join(raiz, 'gradle-rodando');
      const pid = join(raiz, 'pid-gradle');
      writeFileSync(pausa, '');
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', pausa, marca, pid });
      try {
        await esperar(() => existsSync(marca));
        const gradle = pidDe(pid);
        expect(gradle).toBeGreaterThan(0);
        const durante = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
        expect(durante.saida).toContain('outra execução');
        // só o PID do bash, não o grupo
        process.kill(a.filho.pid as number, 'SIGKILL');
        await a.saiu;
        // o Gradle de A (parado, que nunca terminaria sozinho) é encerrado, e nenhum processo de A segura a trava
        await esperar(() => !vivo(gradle), 15000);
        const donos = donosDaTrava(raiz);
        if (donos) await esperar(() => (donosDaTrava(raiz) ?? []).length === 0, 5000);
        const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
        expect(r.codigo).toBe(0);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
      } finally {
        rmSync(pausa, { force: true });
        const g = pidDe(pid);
        if (g > 0 && vivo(g)) process.kill(g, 'SIGKILL');
      }
    }, 30000);

    it('kill -9 só no bash principal com um Gradle que terminaria sozinho: B nunca roda junto com ele', async () => {
      const raiz = criarRepo();
      const marca = join(raiz, 'gradle-rodando');
      const pid = join(raiz, 'pid-gradle');
      const escrita = join(raiz, 'gradle-escreveu');
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', marca, pid, depois: 2, escrita });
      try {
        await esperar(() => existsSync(marca));
        const gradle = pidDe(pid);
        process.kill(a.filho.pid as number, 'SIGKILL');
        await a.saiu;
        // B tenta até conseguir; quando consegue, o Gradle de A já não existe
        let r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
        const limite = Date.now() + 15000;
        while (r.codigo !== 0 && r.saida.includes('outra execução') && Date.now() < limite) {
          await new Promise((ok) => setTimeout(ok, 100));
          r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', pid: join(raiz, 'pid-b') });
        }
        expect(r.codigo).toBe(0);
        expect(vivo(gradle)).toBe(false);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
        // e nada de A escreve depois de B
        await new Promise((ok) => setTimeout(ok, 2500));
        expect(existsSync(escrita)).toBe(false);
      } finally {
        const g = pidDe(pid);
        if (g > 0 && vivo(g)) process.kill(g, 'SIGKILL');
      }
    }, 40000);

    it('SIGTERM só no bash principal: o Gradle é encerrado antes de a trava sair e não escreve depois que B começa', async () => {
      const raiz = criarRepo();
      const marca = join(raiz, 'gradle-rodando');
      const pid = join(raiz, 'pid-gradle');
      const escrita = join(raiz, 'gradle-escreveu');
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', marca, pid, depois: 2, escrita });
      try {
        await esperar(() => existsSync(marca));
        const gradle = pidDe(pid);
        process.kill(a.filho.pid as number, 'SIGTERM');
        const { codigo } = await a.saiu;
        expect(codigo).not.toBe(0);
        // quando o bash de A sai, o Gradle dele já foi encerrado
        expect(vivo(gradle)).toBe(false);
        // B começa logo depois e não é bloqueado
        const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
        expect(r.codigo).toBe(0);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
        // o Gradle de A teria escrito 2 s depois da marca: não escreveu
        await new Promise((ok) => setTimeout(ok, 2500));
        expect(existsSync(escrita)).toBe(false);
      } finally {
        const g = pidDe(pid);
        if (g > 0 && vivo(g)) process.kill(g, 'SIGKILL');
      }
    }, 30000);

    for (const sinal of ['SIGKILL', 'SIGTERM'] as const) {
      it(`${sinal} só no bash principal durante a aceitação das licenças do SDK: B não roda enquanto o sdkmanager de A existir`, async () => {
        const raiz = criarRepo();
        // SDK sem a plataforma: o script passa por sdkmanager --licenses e pela instalação
        rmSync(join(raiz, 'sdk', 'platforms'), { recursive: true, force: true });
        const sdkPid = join(raiz, 'pid-sdk');
        const sdkMarca = join(raiz, 'sdk-licencas');
        const sdkPausa = join(raiz, 'pausa-sdk');
        const sdkEscrita = join(raiz, 'sdk-escreveu');
        writeFileSync(sdkPausa, '');
        const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', sdkPid, sdkMarca, sdkPausa, sdkEscrita });
        try {
          await esperar(() => existsSync(sdkMarca) || a.terminou());
          expect(a.terminou()).toBe(false);
          const sdk = pidDe(sdkPid);
          expect(sdk).toBeGreaterThan(0);
          process.kill(a.filho.pid as number, sinal);
          await a.saiu;
          // B tenta até conseguir; enquanto o sdkmanager de A existir, B tem de ser recusado
          let r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
          const limite = Date.now() + 15000;
          while (r.codigo !== 0 && r.saida.includes('outra execução') && Date.now() < limite) {
            await new Promise((ok) => setTimeout(ok, 100));
            r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
          }
          expect(vivo(sdk)).toBe(false);
          expect(r.codigo).toBe(0);
          expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
          // o sdkmanager de A foi encerrado parado: nunca chegou a escrever, nem depois de B
          rmSync(sdkPausa, { force: true });
          await new Promise((ok) => setTimeout(ok, 500));
          expect(existsSync(sdkEscrita)).toBe(false);
        } finally {
          rmSync(sdkPausa, { force: true });
          const g = pidDe(sdkPid);
          if (g > 0 && vivo(g)) process.kill(g, 'SIGKILL');
        }
      }, 40000);
    }

    it('variável TCHEFOOD_BUILD_LOCK_HELD definida por quem chama não pula a trava', async () => {
      const raiz = criarRepo();
      const pausa = join(raiz, 'pausa');
      const marca = join(raiz, 'gradle-rodando');
      writeFileSync(pausa, '');
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', pausa, marca });
      await esperar(() => existsSync(marca));
      const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', extra: { TCHEFOOD_BUILD_LOCK_HELD: '1' } });
      expect(r.codigo).not.toBe(0);
      expect(r.saida).toContain('outra execução');
      expect(readFileSync(join(raiz, 'android/app/build/outputs/apk/pagbank/debug/app-pagbank-debug.apk'), 'utf8')).toBe('A-pagbank');
      expect(apks(raiz)).toEqual({});
      rmSync(pausa);
      expect(await a.fim).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank', 'tchefood-tablet-debug.apk': 'A-tablet' });
    }, 30000);

    it('a trava é solta quando o build falha', () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', falhar: true }).codigo).not.toBe(0);
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank' }).codigo).toBe(0);
    });
  });
});
