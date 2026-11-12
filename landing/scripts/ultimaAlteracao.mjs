import { execFileSync } from 'node:child_process';

/**
 * Data (AAAA-MM-DD) do último commit que mexeu na pasta `pasta`, para o <lastmod> do sitemap.
 * Devolve null quando a data não é confiável: fora de um repositório git, sem o git instalado
 * ou num clone raso (`--depth`), onde o `git log -- <pasta>` atribui à pasta o commit da
 * borda do histórico mesmo que ele não a tenha alterado.
 *
 * @param {string} pasta
 * @param {Record<string, string>} [envExtra] variáveis de ambiente extras (usado nos testes)
 * @returns {string | null}
 */
export function dataUltimaAlteracao(pasta, envExtra = {}) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: pasta,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...envExtra },
    }).trim();
  try {
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') return null;
    const data = git(['log', '-1', '--format=%cs', '--', '.']);
    return /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : null;
  } catch {
    return null;
  }
}
