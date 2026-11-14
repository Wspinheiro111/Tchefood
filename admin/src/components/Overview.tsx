import type { AdminClient, Overview as OverviewData } from '../lib/api';
import { dateBr, money } from '../lib/format';
import { Erro, Numero, useLoad } from './ui';

export default function Overview({ client, today, irPara }: { client: AdminClient; today: string; irPara: (aba: 'lojas' | 'cobrancas') => void }) {
  // Valores com a data do servidor: relê quando o dia muda.
  const { data, error } = useLoad<OverviewData>(() => client.overview(), [client, today]);
  if (error) return <Erro>{error}</Erro>;
  if (!data) return <p className="text-sm text-slate-500">Carregando…</p>;
  const s = data.stores;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-slate-900">Visão geral · {dateBr(data.today)}</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Numero titulo="Receita mensal (lojas ativas)" valor={money(data.mrr)} destaque="verde" />
        <Numero titulo="Recebido neste mês" valor={money(data.received_this_month)} />
        <Numero titulo="A receber" valor={money(data.open_amount)} detalhe={`${data.open_count} cobrança(s) em aberto`} />
        <Numero
          titulo="Vencidas"
          valor={money(data.overdue_amount)}
          detalhe={`${data.overdue_count} cobrança(s) com vencimento passado`}
          destaque={data.overdue_count > 0 ? 'vermelho' : undefined}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Numero titulo="Ativas" valor={String(s.active)} />
        <Numero titulo="Em teste" valor={String(s.trial)} detalhe={data.trials_ending_7d ? `${data.trials_ending_7d} terminam em até 7 dias` : undefined} />
        <Numero titulo="Suspensas" valor={String(s.suspended)} />
        <Numero titulo="Canceladas" valor={String(s.cancelled)} />
        <Numero titulo="Sem assinatura" valor={String(s.without_subscription)} detalhe={s.without_subscription ? 'Lojas criadas à mão: cadastre a assinatura' : undefined} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primario" onClick={() => irPara('cobrancas')}>
          Ver cobranças do dia
        </button>
        <button type="button" className="btn-secundario" onClick={() => irPara('lojas')}>
          Ver lojas
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Vencida = cobrança em aberto com vencimento antes de hoje. Cobrança que ainda vai vencer conta em "A receber". O painel ainda não bloqueia loja em atraso.
      </p>
    </div>
  );
}
