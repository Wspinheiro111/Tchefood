import { useState, type FormEvent } from 'react';
import { MessageCircle } from 'lucide-react';
import { linkWhatsApp, PLANOS } from '../lib/config';

const TIPOS = ['Restaurante', 'Churrascaria', 'Pizzaria', 'Bar ou pub', 'Lancheria ou café', 'Delivery', 'Eventos', 'Outro'];

export interface DadosContato {
  nome: string;
  estabelecimento: string;
  cidade: string;
  tipo: string;
  plano: string;
}

/** Monta a mensagem que abre no WhatsApp comercial. Nada é enviado para servidor nenhum. */
export function mensagemContato(d: DadosContato): string {
  const linhas = ['Olá! Quero agendar uma demonstração gratuita do Tchê Food.'];
  if (d.nome.trim()) linhas.push(`Nome: ${d.nome.trim()}`);
  if (d.estabelecimento.trim()) linhas.push(`Estabelecimento: ${d.estabelecimento.trim()}`);
  if (d.tipo.trim()) linhas.push(`Tipo: ${d.tipo.trim()}`);
  if (d.cidade.trim()) linhas.push(`Cidade: ${d.cidade.trim()}`);
  if (d.plano.trim()) linhas.push(`Plano de interesse: ${d.plano.trim()}`);
  return linhas.join('\n');
}

export default function Contato() {
  const [dados, setDados] = useState<DadosContato>({ nome: '', estabelecimento: '', cidade: '', tipo: '', plano: '' });

  const campo = (k: keyof DadosContato) => ({
    value: dados[k],
    onChange: (e: { target: { value: string } }) => setDados((d) => ({ ...d, [k]: e.target.value })),
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    window.open(linkWhatsApp(mensagemContato(dados)), '_blank', 'noopener,noreferrer');
  }

  const classeCampo =
    'mt-1 w-full rounded-xl border border-borda bg-white px-3 py-2.5 text-slate-900 outline-none transition focus:border-brasa focus:ring-2 focus:ring-brasa/20';

  return (
    <section id="contato" className="border-t border-borda/60 bg-surface/30 py-20" aria-labelledby="titulo-contato">
      <div className="container-lp grid gap-10 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="eyebrow">Demonstração gratuita</p>
          <h2 id="titulo-contato" className="mt-3 text-3xl font-bold sm:text-4xl">
            Veja o Tchê Food funcionando com o seu cardápio
          </h2>
          <p className="mt-4 text-slate-700">
            Em 20 minutos mostramos a comanda no celular, o PDV, a tela da cozinha, o totem e o painel do dono. Preencha
            e a conversa abre no nosso WhatsApp com os seus dados, sem cadastro.
          </p>
        </div>
        <form onSubmit={enviar} className="card grid gap-4 p-6 sm:grid-cols-2" aria-label="Agendar demonstração">
          <label className="text-sm font-medium text-slate-800">
            Seu nome
            <input name="nome" autoComplete="name" className={classeCampo} {...campo('nome')} />
          </label>
          <label className="text-sm font-medium text-slate-800">
            Nome do estabelecimento
            <input name="estabelecimento" autoComplete="organization" className={classeCampo} {...campo('estabelecimento')} />
          </label>
          <label className="text-sm font-medium text-slate-800">
            Cidade
            <input name="cidade" autoComplete="address-level2" className={classeCampo} {...campo('cidade')} />
          </label>
          <label className="text-sm font-medium text-slate-800">
            Tipo de negócio
            <select name="tipo" className={classeCampo} {...campo('tipo')}>
              <option value="">Escolha</option>
              {TIPOS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-800 sm:col-span-2">
            Plano de interesse
            <select name="plano" className={classeCampo} {...campo('plano')}>
              <option value="">Ainda não sei</option>
              {PLANOS.map((p) => (
                <option key={p.id}>{p.nome}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-primario sm:col-span-2">
            <MessageCircle className="h-5 w-5" aria-hidden />
            Agendar pelo WhatsApp
          </button>
        </form>
      </div>
    </section>
  );
}
