import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
if [ -n "$FAKE_MARCA" ]; then
  : > "$FAKE_MARCA"
  while [ -e "$FAKE_PAUSA" ]; do sleep 0.1; done
fi
[ "$FAKE_FALHAR" = "1" ] && exit 1
exit 0
`;

// mv falso: falha UMA vez (a primeira que casar com FAKE_MV_FALHAR) e depois age como o mv de verdade, para a
// restauração também ser testada. Modos: guardar (apk/ -> pasta de backup), instalar (pasta nova -> apk/),
// primeiro / segundo (arquivo individual dentro de apk/, como fazia a publicação antiga).
const MV_FALSO = `#!/bin/sh
for ultimo; do :; done
if [ -n "$FAKE_MV_FALHAR" ] && [ ! -e "$FAKE_MV_MARCA" ]; then
  case "$FAKE_MV_FALHAR:$ultimo" in
    guardar:*/.apk-old.*|instalar:*/apk|primeiro:*apk/tchefood-pagbank-*|segundo:*apk/tchefood-tablet-*)
      : > "$FAKE_MV_MARCA"; exit 5 ;;
  esac
fi
exec /bin/mv "$@"
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
  executavel(join(bin, 'mv'), MV_FALSO);
  return raiz;
}

type Opcoes = { gerar: string; build?: string; vazio?: string; falhar?: boolean; mv?: string; pausa?: string; marca?: string };

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
    FAKE_MV_FALHAR: o.mv ?? '',
    FAKE_MV_MARCA: join(raiz, 'mv-falhou'),
    FAKE_PAUSA: o.pausa ?? '',
    FAKE_MARCA: o.marca ?? '',
  };
}

function rodar(raiz: string, variante: string, o: Opcoes) {
  const r = spawnSync('bash', ['scripts/build-apk.sh', variante], { cwd: raiz, encoding: 'utf8', env: ambiente(raiz, o) });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

function rodarEmSegundoPlano(raiz: string, variante: string, o: Opcoes) {
  const filho = spawn('bash', ['scripts/build-apk.sh', variante], { cwd: raiz, env: ambiente(raiz, o), stdio: 'ignore' });
  const fim = new Promise<number | null>((ok) => filho.on('close', (c) => ok(c)));
  return { filho, fim };
}

async function esperar(cond: () => boolean, ms = 10000) {
  const limite = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > limite) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 50));
  }
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

  describe('publicação atômica', () => {
    for (const modo of ['guardar', 'instalar', 'primeiro', 'segundo']) {
      it(`falha na troca (${modo}): nunca fica um conjunto parcial`, () => {
        const raiz = criarRepo();
        expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
        const antes = apks(raiz);
        expect(antes).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank', 'tchefood-tablet-debug.apk': 'A-tablet' });
        const r = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B', mv: modo });
        // nunca um conjunto misto ou parcial: ou o build B inteiro (troca ok), ou o A inteiro (troca falhou)
        const depois = apks(raiz);
        if (r.codigo === 0) {
          expect(depois).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
        } else {
          expect(depois).toEqual(antes);
        }
        // os modos que mexem na pasta inteira (guardar e instalar) têm de falhar e manter o A
        if (modo === 'guardar' || modo === 'instalar') expect(r.codigo).not.toBe(0);
        expect(readdirSync(raiz).filter((n) => n.startsWith('.apk-old') || n.startsWith('.apk-staging'))).toEqual([]);
        // e a próxima execução funciona
        expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'C' }).codigo).toBe(0);
        expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'C-pagbank', 'tchefood-tablet-debug.apk': 'C-tablet' });
      });
    }

    it('processo morto à força entre as duas renomeações: a próxima execução devolve o conjunto anterior', () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'A' }).codigo).toBe(0);
      // estado deixado por um kill -9: apk/ já foi guardado e o novo ainda não entrou
      renameSync(join(raiz, 'apk'), join(raiz, '.apk-old.99999'));
      // build que falha antes de publicar: só a recuperação inicial age
      const r = rodar(raiz, 'all', { gerar: '', build: 'B' });
      expect(r.codigo).not.toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank', 'tchefood-tablet-debug.apk': 'A-tablet' });
    });
  });

  describe('trava entre execuções', () => {
    it('a segunda execução falha sem tocar em nada enquanto a primeira roda, e cada uma publica só o seu', async () => {
      const raiz = criarRepo();
      const pausa = join(raiz, 'pausa');
      const marca = join(raiz, 'gradle-rodando');
      writeFileSync(pausa, '');
      const a = rodarEmSegundoPlano(raiz, 'all', { gerar: 'pagbank tablet', build: 'A', pausa, marca });
      await esperar(() => existsSync(marca));

      const saidaA = readdirSync(join(raiz, 'android/app/build/outputs/apk')).sort();
      const b = rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' });
      expect(b.codigo).not.toBe(0);
      expect(b.saida).toContain('outra execução');
      expect(apks(raiz)).toEqual({});
      expect(readdirSync(join(raiz, 'android/app/build/outputs/apk')).sort()).toEqual(saidaA);
      expect(readFileSync(join(raiz, 'android/app/build/outputs/apk/pagbank/debug/app-pagbank-debug.apk'), 'utf8')).toBe('A-pagbank');

      rmSync(pausa);
      expect(await a.fim).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'A-pagbank', 'tchefood-tablet-debug.apk': 'A-tablet' });

      expect(rodar(raiz, 'all', { gerar: 'pagbank tablet', build: 'B' }).codigo).toBe(0);
      expect(apks(raiz)).toEqual({ 'tchefood-pagbank-debug.apk': 'B-pagbank', 'tchefood-tablet-debug.apk': 'B-tablet' });
    }, 30000);

    it('a trava é solta quando o build falha', () => {
      const raiz = criarRepo();
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank', falhar: true }).codigo).not.toBe(0);
      expect(existsSync(join(raiz, '.apk-build.lock'))).toBe(false);
      expect(rodar(raiz, 'pagbank', { gerar: 'pagbank' }).codigo).toBe(0);
    });

    it('trava velha de um processo que já morreu não bloqueia', () => {
      const raiz = criarRepo();
      mkdirSync(join(raiz, '.apk-build.lock'));
      writeFileSync(join(raiz, '.apk-build.lock', 'pid'), '999999');
      const r = rodar(raiz, 'pagbank', { gerar: 'pagbank' });
      expect(r.codigo).toBe(0);
      expect(existsSync(join(raiz, '.apk-build.lock'))).toBe(false);
    });
  });
});
