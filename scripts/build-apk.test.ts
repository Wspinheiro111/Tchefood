import { spawn, spawnSync } from 'node:child_process';
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
//   FAKE_FUNDO  arquivo onde grava o pid de um processo deixado em segundo plano (fora do grupo, vivo 30 s,
//               herdando todo descritor aberto que o Gradle recebeu), como um daemon que sobrevive ao build
const GRADLE_FALSO = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Gradle 8.7"; exit 0; fi
for v in $FAKE_GERAR; do
  d="android/app/build/outputs/apk/$v/debug"
  mkdir -p "$d"
  if [ "$FAKE_VAZIO" = "$v" ]; then : > "$d/app-$v-debug.apk"; else printf '%s' "$FAKE_BUILD-$v" > "$d/app-$v-debug.apk"; fi
done
if [ -n "$FAKE_FUNDO" ]; then
  perl -e 'setpgrp(0, 0); sleep 30' </dev/null >/dev/null 2>&1 &
  echo $! > "$FAKE_FUNDO"
fi
if [ -n "$FAKE_MARCA" ]; then
  : > "$FAKE_MARCA"
  while [ -e "$FAKE_PAUSA" ]; do sleep 0.1; done
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

// perl falso: repassa tudo ao perl de verdade, exceto a renomeação que publica o novo apk/ (o script usa
// rename($ARGV[0], ...)), onde pode falhar (FAKE_RENAME_FALHAR) ou parar logo antes (FAKE_TROCA_MARCA/PAUSA).
function perlFalso(real: string) {
  return `#!/bin/sh
case "$*" in
  *'rename($ARGV[0]'*)
    if [ -n "$FAKE_RENAME_FALHAR" ]; then exit 5; fi
    if [ -n "$FAKE_TROCA_MARCA" ]; then : > "$FAKE_TROCA_MARCA"; while [ -e "$FAKE_TROCA_PAUSA" ]; do sleep 0.1; done; fi ;;
esac
exec ${real} "$@"
`;
}
const PERL_REAL = spawnSync('sh', ['-c', 'command -v perl'], { encoding: 'utf8' }).stdout.trim();

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
  executavel(join(bin, 'perl'), perlFalso(PERL_REAL));
  return raiz;
}

type Opcoes = {
  gerar: string; build?: string; vazio?: string; falhar?: boolean; renameFalhar?: boolean;
  pausa?: string; marca?: string; trocaPausa?: string; trocaMarca?: string;
  lockPausa?: string; lockMarca?: string; legadoPausa?: string; legadoMarca?: string;
  fundo?: string; extra?: Record<string, string>;
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
  return { filho, fim, saida: () => saida, terminou: () => terminou };
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
