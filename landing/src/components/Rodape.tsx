import Logo from './Logo';

export default function Rodape() {
  return (
    <footer className="border-t border-borda py-10">
      <div className="container-lp flex flex-col items-center justify-between gap-4 text-sm text-slate-500 sm:flex-row">
        <Logo />
        <p>
          © {new Date().getFullYear()} W9 Sistemas. Stone e PagBank são marcas de seus respectivos donos.
        </p>
      </div>
    </footer>
  );
}
