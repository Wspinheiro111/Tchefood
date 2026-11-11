import Logo from './Logo';
import { EMPRESA, linkWhatsApp, WHATSAPP_NUMERO } from '../lib/config';
import { GRUPOS_FUNCOES } from '../lib/funcionalidades';

function telefoneLegivel(n: string): string {
  const m = n.match(/^55(\d{2})(\d{5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n;
}

export default function Rodape() {
  const ano = __ANO_BUILD__;
  return (
    <footer className="border-t border-borda py-12">
      <div className="container-lp grid gap-8 text-sm text-slate-600 md:grid-cols-[1.2fr_2fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-sm">
            {EMPRESA.produto}: sistema para restaurantes, bares, churrascarias, pizzarias, lancherias e delivery. Um
            produto {EMPRESA.fabricante}.
          </p>
          <p className="mt-3">
            WhatsApp comercial:{' '}
            <a
              className="font-semibold text-slate-900 underline-offset-2 hover:underline"
              href={linkWhatsApp('Olá! Quero saber mais sobre o Tchê Food.')}
              target="_blank"
              rel="noopener noreferrer"
            >
              {telefoneLegivel(WHATSAPP_NUMERO)}
            </a>
          </p>
        </div>
        <nav aria-label="Funcionalidades no rodapé">
          <p className="font-semibold text-slate-900">Funcionalidades</p>
          <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {GRUPOS_FUNCOES.map((g) => (
              <li key={g.id}>
                <a className="hover:text-slate-900" href={`#func-${g.id}`}>
                  {g.titulo}
                </a>
              </li>
            ))}
            <li>
              <a className="hover:text-slate-900" href="#planos">
                Planos e preços
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <p className="container-lp mt-10 text-xs text-slate-500">
        © {ano} {EMPRESA.fabricante}. Stone, PagBank, Mercado Pago, iFood e demais marcas citadas pertencem aos seus
        respectivos donos.
      </p>
    </footer>
  );
}
