import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Info, Search, TriangleAlert, X } from 'lucide-react';
import type { StaffUser, UserRole } from '../types';
import { ROLE_LABEL } from '../lib/catalog';
import { NAV_ACCESS } from '../lib/navAccess';
import { DEFAULT_PERMISSIONS, PERMISSIONS, PERMISSION_LABEL } from '../lib/permissions';
import { BACKOFFICE_HELP, HELP_ARTICLES } from '../lib/help/articles';
import { AUDIENCES, AUDIENCE_LABEL, CATEGORIES, type Audience, type HelpArticle, type HelpBlock } from '../lib/help/types';

const MATRIX_ROLES: ReadonlyArray<UserRole> = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'];
const imgSrc = (name: string) => `${import.meta.env.BASE_URL}ajuda/${name}`;

/** Texto simples sem acento, para a busca achar "garcom" e "garçom". */
export function normalizeHelp(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function articleText(a: HelpArticle): string {
  const parts: string[] = [a.title, a.summary, a.category];
  for (const b of a.blocks) {
    if ('text' in b) parts.push(b.text);
    if ('items' in b) for (const i of b.items) parts.push(typeof i === 'string' ? i : `${i.q} ${i.a}`);
    if (b.t === 'img') parts.push(b.caption);
  }
  return normalizeHelp(parts.join(' '));
}

export function searchArticles(articles: ReadonlyArray<HelpArticle>, query: string, audience: Audience | 'ALL'): HelpArticle[] {
  const words = normalizeHelp(query).split(/\s+/).filter(Boolean);
  return articles.filter((a) => {
    if (audience !== 'ALL' && a.audience !== 'ALL' && !a.audience.includes(audience)) return false;
    if (!words.length) return true;
    const text = articleText(a);
    return words.every((w) => text.includes(w));
  });
}

function Mark({ on }: { on: boolean }) {
  return on ? <span aria-label="sim" className="font-bold text-verde">✓</span> : <span aria-label="não" className="text-slate-300">—</span>;
}

function MatrixTable({ head, rows }: { head: string[]; rows: Array<{ label: string; note?: string; cells: boolean[] }> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-100 text-slate-600">
          <tr>
            <th className="px-3 py-2 font-semibold">O quê</th>
            {head.map((h) => <th key={h} className="px-2 py-2 text-center font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-slate-100">
              <td className="px-3 py-2">
                <span className="font-medium">{r.label}</span>
                {r.note && <span className="block text-xs text-slate-500">{r.note}</span>}
              </td>
              {r.cells.map((c, i) => <td key={i} className="px-2 py-2 text-center"><Mark on={c} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ b }: { b: HelpBlock }) {
  switch (b.t) {
    case 'p': return <p className="leading-relaxed text-slate-700">{b.text}</p>;
    case 'h': return <h3 className="pt-2 text-lg font-bold text-slate-900">{b.text}</h3>;
    case 'steps': return <ol className="list-decimal space-y-2 pl-6 text-slate-700">{b.items.map((i) => <li key={i}>{i}</li>)}</ol>;
    case 'list': return <ul className="list-disc space-y-2 pl-6 text-slate-700">{b.items.map((i) => <li key={i}>{i}</li>)}</ul>;
    case 'note': {
      const warn = b.tone === 'warn';
      const Icon = warn ? TriangleAlert : Info;
      return (
        <div role="note" className={`flex gap-2 rounded-xl border p-3 text-sm ${warn ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-sky-200 bg-sky-50 text-sky-900'}`}>
          <Icon size={18} className="mt-0.5 shrink-0" aria-hidden />
          <span>{b.text}</span>
        </div>
      );
    }
    case 'img':
      return (
        <figure className={b.wide ? '' : 'mx-auto max-w-sm'}>
          <img src={imgSrc(b.src)} alt={b.alt} loading="lazy" className="w-full rounded-xl border border-slate-200 shadow-sm" />
          <figcaption className="mt-1 text-center text-xs text-slate-500">{b.caption}</figcaption>
        </figure>
      );
    case 'faq':
      return (
        <div className="space-y-2">
          {b.items.map((i) => (
            <details key={i.q} className="rounded-xl border border-slate-200 bg-white p-3">
              <summary className="cursor-pointer font-semibold text-slate-900">{i.q}</summary>
              <p className="mt-2 leading-relaxed text-slate-700">{i.a}</p>
            </details>
          ))}
        </div>
      );
    case 'menuMatrix':
      return (
        <MatrixTable
          head={MATRIX_ROLES.map((r) => ROLE_LABEL[r])}
          rows={NAV_ACCESS.filter((n) => n.roles.length > 0).map((n) => ({ label: n.label, cells: MATRIX_ROLES.map((r) => n.roles.includes(r)) }))}
        />
      );
    case 'permMatrix':
      return (
        <MatrixTable
          head={MATRIX_ROLES.map((r) => ROLE_LABEL[r])}
          rows={PERMISSIONS.map((p) => ({ label: PERMISSION_LABEL[p], cells: MATRIX_ROLES.map((r) => r === 'OWNER' || DEFAULT_PERMISSIONS[p].includes(r)) }))}
        />
      );
    case 'backofficeMatrix':
      return (
        <MatrixTable
          head={['Dono', 'Gerente', 'Caixa']}
          rows={BACKOFFICE_HELP.map((t) => ({ label: t.label, note: t.about, cells: [t.roles.includes('OWNER'), t.roles.includes('MANAGER'), t.roles.includes('CASHIER')] }))}
        />
      );
  }
}

/**
 * Central de ajuda. Funciona também sem login (esqueci meu PIN, primeiros passos).
 * Abrir a ajuda não desmonta as telas do app (App.tsx só as esconde), então uma cobrança em andamento continua.
 */
export function HelpCenter({ user, onClose }: { user?: Pick<StaffUser, 'role'> | null; onClose: () => void }) {
  const initial: Audience | 'ALL' = user && user.role !== 'KIOSK' ? user.role : 'ALL';
  const [query, setQuery] = useState('');
  const [audience, setAudience] = useState<Audience | 'ALL'>(initial);
  const [openId, setOpenId] = useState<string | null>(null);

  const results = useMemo(() => searchArticles(HELP_ARTICLES, query, audience), [query, audience]);
  const article = openId ? HELP_ARTICLES.find((a) => a.id === openId) : undefined;
  const open = (id: string) => { setOpenId(id); try { window.scrollTo(0, 0); } catch { /* sem rolagem (testes) */ } };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col bg-base p-4 pb-24" role="region" aria-label="Central de ajuda">
      <header className="mb-4 flex items-center gap-2">
        {article ? (
          <button type="button" onClick={() => setOpenId(null)} className="flex min-h-touch items-center gap-1 rounded-xl px-3 font-semibold text-slate-700 active:bg-slate-100">
            <ArrowLeft size={20} aria-hidden /> Voltar
          </button>
        ) : (
          <h1 className="flex-1 text-2xl font-extrabold text-slate-900">Central de ajuda</h1>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Fechar a ajuda" className="flex min-h-touch min-w-touch items-center justify-center gap-1 rounded-xl bg-slate-200 px-3 font-semibold text-slate-900 active:bg-slate-300">
          <X size={20} aria-hidden /> Fechar
        </button>
      </header>

      {article ? (
        <article className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-brasa">{article.category}</p>
            <h2 className="text-2xl font-extrabold text-slate-900">{article.title}</h2>
            <p className="text-slate-600">{article.summary}</p>
            <p className="mt-1 text-xs text-slate-500">
              Para: {article.audience === 'ALL' ? 'todos' : article.audience.map((a) => AUDIENCE_LABEL[a]).join(', ')}
            </p>
          </div>
          {article.blocks.map((b, i) => <Block key={i} b={b} />)}
          {article.related && article.related.length > 0 && (
            <nav aria-label="Veja também" className="space-y-2 border-t border-slate-200 pt-4">
              <h3 className="font-bold text-slate-900">Veja também</h3>
              {article.related.map((id) => {
                const r = HELP_ARTICLES.find((x) => x.id === id);
                if (!r) return null;
                return (
                  <button key={id} type="button" onClick={() => open(id)} className="flex min-h-touch w-full items-center justify-between rounded-xl border border-slate-200 px-3 text-left font-medium active:bg-slate-100">
                    {r.title} <ChevronRight size={18} aria-hidden />
                  </button>
                );
              })}
            </nav>
          )}
        </article>
      ) : (
        <>
          <label className="relative mb-3 block">
            <span className="sr-only">Buscar na ajuda</span>
            <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar: PIN, cancelar item, caixa…"
              className="min-h-touch w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 text-base"
            />
          </label>
          <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por perfil">
            {(['ALL', ...AUDIENCES] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={audience === a}
                onClick={() => setAudience(a)}
                className={`min-h-[40px] rounded-full border px-3 text-sm font-semibold ${audience === a ? 'border-brasa bg-brasa text-white' : 'border-slate-300 bg-white text-slate-700'}`}
              >
                {a === 'ALL' ? 'Todos' : AUDIENCE_LABEL[a]}
              </button>
            ))}
          </div>
          {results.length === 0 && <p className="rounded-xl bg-slate-100 p-4 text-slate-600">Nada encontrado. Tente outra palavra ou escolha "Todos".</p>}
          {CATEGORIES.map((c) => {
            const list = results.filter((a) => a.category === c);
            if (!list.length) return null;
            return (
              <section key={c} className="mb-5">
                <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">{c}</h2>
                <ul className="space-y-2">
                  {list.map((a) => (
                    <li key={a.id}>
                      <button type="button" onClick={() => open(a.id)} className="flex min-h-touch w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left active:bg-slate-100">
                        <span>
                          <span className="block font-semibold text-slate-900">{a.title}</span>
                          <span className="block text-sm text-slate-600">{a.summary}</span>
                        </span>
                        <ChevronRight size={18} className="shrink-0 text-slate-400" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
