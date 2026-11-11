import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizarSiteUrl } from '../lib/config';
import { dataUltimaAlteracao } from '../../scripts/ultimaAlteracao.mjs';

describe('P2-01: VITE_SITE_URL vazio não cai no domínio padrão', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const carregar = async () => (await import('../lib/config')).SITE_URL;

  it('variável ausente usa o domínio padrão', async () => {
    vi.resetModules();
    expect(await carregar()).toBe('https://tchefood.com.br');
  });

  it.each(['', '   '])('variável definida como %j derruba a configuração', async (valor) => {
    vi.stubEnv('VITE_SITE_URL', valor);
    vi.resetModules();
    await expect(carregar()).rejects.toThrow(/VITE_SITE_URL inválido/);
  });

  it('variável válida atravessa a configuração', async () => {
    vi.stubEnv('VITE_SITE_URL', 'https://www.exemplo.com.br/');
    vi.resetModules();
    expect(await carregar()).toBe('https://www.exemplo.com.br');
  });
});

describe('P2-02: hostname precisa ser um nome DNS válido', () => {
  it.each([
    'https://.com',
    'https://example..com',
    'https://bad_domain.com',
    'https://-tchefood.com.br',
    'https://tchefood-.com.br',
    'https://tchefood.com.br.',
    `https://${'a'.repeat(64)}.com.br`,
    'https://192.168.0.1',
    'https://[::1]',
    'https://tchefood.123',
  ])('recusa %s', (valor) => {
    expect(() => normalizarSiteUrl(valor)).toThrow(/VITE_SITE_URL inválido/);
  });

  it.each([
    ['https://tchefood.com.br', 'https://tchefood.com.br'],
    ['https://w9-sistemas.com.br', 'https://w9-sistemas.com.br'],
    ['https://xn--tch-hma.com.br', 'https://xn--tch-hma.com.br'],
    ['https://tchê.com.br', 'https://xn--tch-hma.com.br'],
  ])('aceita %s', (valor, esperado) => {
    expect(normalizarSiteUrl(valor)).toBe(esperado);
  });
});

describe('P2-03: <lastmod> só com histórico git confiável', () => {
  const pastas: string[] = [];
  afterEach(() => {
    for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[], data?: string) {
    return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...(data ? { GIT_COMMITTER_DATE: data, GIT_AUTHOR_DATE: data } : {}) },
    });
  }

  /** Repositório com o commit A (01/10, mexe em landing/) e o B (10/11, só README.md). */
  function montar(): string {
    const base = mkdtempSync(path.join(tmpdir(), 'lastmod-'));
    pastas.push(base);
    const repo = path.join(base, 'repo');
    mkdirSync(path.join(repo, 'landing'), { recursive: true });
    git(base, ['init', '-q', repo]);
    writeFileSync(path.join(repo, 'landing', 'index.html'), 'a');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'A'], '2026-10-01T12:00:00Z');
    writeFileSync(path.join(repo, 'README.md'), 'b');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'B'], '2026-11-10T12:00:00Z');
    return repo;
  }

  it('histórico completo: data do último commit que mexeu em landing/', () => {
    const repo = montar();
    expect(dataUltimaAlteracao(path.join(repo, 'landing'))).toBe('2026-10-01');
  });

  it('commit novo em landing/ atualiza a data', () => {
    const repo = montar();
    writeFileSync(path.join(repo, 'landing', 'index.html'), 'c');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'C'], '2026-11-11T09:00:00Z');
    expect(dataUltimaAlteracao(path.join(repo, 'landing'))).toBe('2026-11-11');
  });

  it('clone raso (--depth 1): sem data, em vez da data errada', () => {
    const repo = montar();
    const raso = path.join(path.dirname(repo), 'raso');
    git(path.dirname(repo), ['clone', '-q', '--depth', '1', `file://${repo}`, raso]);
    expect(git(path.join(raso, 'landing'), ['log', '-1', '--format=%cs', '--', '.']).trim()).toBe('2026-11-10');
    expect(dataUltimaAlteracao(path.join(raso, 'landing'))).toBeNull();
  });

  it('fora de um repositório git: sem data', () => {
    const pasta = mkdtempSync(path.join(tmpdir(), 'semgit-'));
    pastas.push(pasta);
    expect(dataUltimaAlteracao(pasta, { GIT_CEILING_DIRECTORIES: path.dirname(pasta) })).toBeNull();
  });

  it('git não instalado: sem data', () => {
    const repo = montar();
    expect(dataUltimaAlteracao(path.join(repo, 'landing'), { PATH: '/nao/existe' })).toBeNull();
  });
});
