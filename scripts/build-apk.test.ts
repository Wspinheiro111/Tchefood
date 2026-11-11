import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Testa scripts/build-apk.sh num repositório de mentira: Java, Node, npm, curl, unzip, sdkmanager e Gradle são
// substitutos que só imitam a saída. O que está em teste é a validação e a troca da pasta apk/, não o Android.
const SCRIPT = resolve(__dirname, 'build-apk.sh');
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
const GRADLE_FALSO = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Gradle 8.7"; exit 0; fi
for v in $FAKE_GERAR; do
  d="android/app/build/outputs/apk/$v/debug"
  mkdir -p "$d"
  if [ "$FAKE_VAZIO" = "$v" ]; then : > "$d/app-$v-debug.apk"; else printf '%s' "$FAKE_BUILD-$v" > "$d/app-$v-debug.apk"; fi
done
[ "$FAKE_FALHAR" = "1" ] && exit 1
exit 0
`;

function criarRepo() {
  const raiz = mkdtempSync(join(tmpdir(), 'build-apk-'));
  pastas.push(raiz);
  mkdirSync(join(raiz, 'scripts'));
  copyFileSync(SCRIPT, join(raiz, 'scripts', 'build-apk.sh'));
  mkdirSync(join(raiz, 'android'));
  writeFileSync(join(raiz, 'android', 'settings.gradle.kts'), '');

  const sdk = join(raiz, 'sdk');
  executavel(join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'), '#!/bin/sh\nexit 0\n');
  mkdirSync(join(sdk, 'platforms', 'android-34'), { recursive: true });
  mkdirSync(join(sdk, 'build-tools', '34.0.0'), { recursive: true });

  const bin = join(raiz, 'bin');
  executavel(join(bin, 'java'), '#!/bin/sh\necho \'openjdk version "17.0.9" 2023-10-17\' >&2\n');
  executavel(join(bin, 'node'), '#!/bin/sh\necho v20.11.0\n');
  for (const nome of ['npm', 'curl', 'unzip']) executavel(join(bin, nome), '#!/bin/sh\nexit 0\n');
  executavel(join(bin, 'gradle'), GRADLE_FALSO);
  return raiz;
}

type Opcoes = { gerar: string; build?: string; vazio?: string; falhar?: boolean };

function rodar(raiz: string, variante: string, o: Opcoes) {
  const r = spawnSync('bash', ['scripts/build-apk.sh', variante], {
    cwd: raiz,
    encoding: 'utf8',
    env: {
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
    },
  });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

function apks(raiz: string) {
  const pasta = join(raiz, 'apk');
  if (!existsSync(pasta)) return {} as Record<string, string>;
  return Object.fromEntries(readdirSync(pasta).sort().map((n) => [n, readFileSync(join(pasta, n), 'utf8')]));
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
    expect(readdirSync(raiz).filter((n) => n.startsWith('.apk-staging'))).toEqual([]);
  });
});
