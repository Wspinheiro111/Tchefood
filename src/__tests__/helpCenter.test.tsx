// @vitest-environment jsdom
/** Central de ajuda: conteúdo válido, tabelas de acesso iguais ao código e tela funcionando. */
import { existsSync, readdirSync } from 'node:fs';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpCenter, searchArticles } from '../screens/HelpCenter';
import { useBackOfficeTabs } from '../screens/BackOffice';
import { BACKOFFICE_HELP, HELP_ARTICLES } from '../lib/help/articles';
import { CATEGORIES } from '../lib/help/types';
import { useTcheStore } from '../store/useTcheStore';
import type { StaffUser, UserRole } from '../types';

afterEach(cleanup);
window.scrollTo = () => undefined;

describe('conteúdo', () => {
  it('ids únicos, categorias válidas e artigos relacionados existentes', () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of HELP_ARTICLES) {
      expect(CATEGORIES).toContain(a.category);
      expect(a.title.length).toBeGreaterThan(3);
      expect(a.blocks.length).toBeGreaterThan(0);
      for (const r of a.related ?? []) expect(ids, `${a.id} → ${r}`).toContain(r);
    }
  });

  it('toda imagem citada existe em public/ajuda e tem texto alternativo', () => {
    for (const a of HELP_ARTICLES) {
      for (const b of a.blocks) {
        if (b.t !== 'img') continue;
        expect(existsSync(`public/ajuda/${b.src}`), `${a.id}: ${b.src}`).toBe(true);
        expect(b.alt.length).toBeGreaterThan(5);
      }
    }
  });

  it('não sobra imagem sem uso em public/ajuda', () => {
    const used = new Set(HELP_ARTICLES.flatMap((a) => a.blocks.flatMap((b) => (b.t === 'img' ? [b.src] : []))));
    const files = readdirSync('public/ajuda').filter((f) => f.endsWith('.jpg'));
    expect(files.filter((f) => !used.has(f))).toEqual([]);
  });

  it('cobre cadastro de pessoa, PIN e permissões', () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(ids).toContain('cadastrar-pessoa');
    expect(HELP_ARTICLES.some((a) => a.blocks.some((b) => b.t === 'permMatrix'))).toBe(true);
    expect(HELP_ARTICLES.some((a) => a.blocks.some((b) => b.t === 'menuMatrix'))).toBe(true);
  });
});

describe('Retaguarda: a tabela da ajuda confere com as abas reais', () => {
  const roles: Array<'OWNER' | 'MANAGER' | 'CASHIER'> = ['OWNER', 'MANAGER', 'CASHIER'];
  for (const role of roles) {
    it(`perfil ${role}`, () => {
      act(() => {
        useTcheStore.setState({
          staff: [{ id: 'u', name: 'U', role, active: true }] as unknown as StaffUser[],
          currentUserId: 'u',
          rolePermissions: [],
        } as never);
      });
      const { result } = renderHook(() => useBackOfficeTabs());
      const real = result.current.map((t) => t.label).sort();
      const help = BACKOFFICE_HELP.filter((t) => t.roles.includes(role)).map((t) => t.label).sort();
      expect(help).toEqual(real);
    });
  }
});

describe('busca', () => {
  it('acha sem acento e filtra por perfil', () => {
    expect(searchArticles(HELP_ARTICLES, 'garcom', 'ALL').length).toBeGreaterThan(0);
    const kitchen = searchArticles(HELP_ARTICLES, '', 'KITCHEN');
    expect(kitchen.some((a) => a.id === 'kds')).toBe(true);
    expect(kitchen.some((a) => a.id === 'caixa')).toBe(false);
    expect(searchArticles(HELP_ARTICLES, 'xyzxyzxyz', 'ALL')).toEqual([]);
  });
});

describe('tela', () => {
  it('abre sem login, busca, abre um artigo e volta', () => {
    const onClose = () => undefined;
    render(<HelpCenter onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText(/Buscar/), { target: { value: 'esqueci' } });
    const first = screen.getAllByRole('button').find((b) => /esqueci|PIN/i.test(b.textContent ?? '') && b.className.includes('rounded-xl'));
    expect(first).toBeTruthy();
    fireEvent.click(first!);
    expect(screen.getByRole('button', { name: /Voltar/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Voltar/ }));
    expect(screen.getByRole('heading', { name: 'Central de ajuda' })).toBeTruthy();
  });

  it('já filtra pelo perfil de quem está logado e o botão Fechar chama onClose', () => {
    let closed = false;
    render(<HelpCenter user={{ role: 'WAITER' as UserRole }} onClose={() => { closed = true; }} />);
    expect(within(screen.getByRole('group', { name: /Filtrar/ })).getByRole('button', { name: 'Garçom' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Fechar a ajuda/ }));
    expect(closed).toBe(true);
  });

  it('bloqueia os atalhos de teclado das telas escondidas (F2 do PDV) enquanto aberta', () => {
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', onKey);
    const { unmount } = render(<HelpCenter onClose={() => undefined} />);
    fireEvent.keyDown(document.body, { key: 'F2' });
    fireEvent.change(screen.getByPlaceholderText(/Buscar/), { target: { value: 'pin' } });
    expect(seen).toEqual([]);
    unmount();
    fireEvent.keyDown(document.body, { key: 'F2' });
    expect(seen).toEqual(['F2']);
    window.removeEventListener('keydown', onKey);
  });

  it('todo artigo renderiza sem erro', () => {
    for (const a of HELP_ARTICLES) {
      const { unmount } = render(<HelpCenter onClose={() => undefined} />);
      fireEvent.click(screen.getByText(a.title, { selector: 'span' }));
      expect(screen.getByRole('heading', { level: 2, name: a.title })).toBeTruthy();
      unmount();
    }
  });
});
