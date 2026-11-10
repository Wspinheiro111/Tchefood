/**
 * Preferências do Painel do dono guardadas no aparelho: a meta de venda de cada dia
 * da semana, as taxas da maquininha do contrato e a comissão de cada app de delivery.
 * Não movimentam dinheiro (só as contas do painel), então ficam fora da fila da nuvem;
 * cada aparelho da gerência guarda as suas.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { idbStorage } from '../lib/idbStorage';
import { round2 } from '../lib/money';
import { validateFeeRule, type FeeRule } from '../lib/cardFees';
import { uuid } from '../lib/ids';

/** 0 = domingo … 6 = sábado (Date.getDay()). Null = sem meta naquele dia. */
export type WeekdayGoals = Record<0 | 1 | 2 | 3 | 4 | 5 | 6, number | null>;

const NO_GOALS: WeekdayGoals = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };

export const WEEKDAY_LABEL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;

/** Maior meta aceita (evita digitar centavos como reais). */
export const MAX_DAILY_GOAL = 10_000_000;

interface OwnerSettingsState {
  dailyGoals: WeekdayGoals;
  /** Grava a meta do dia da semana. Valor inválido devolve o erro. */
  setDailyGoal: (weekday: number, value: number | null) => string | null;
  /** Taxas da maquininha do contrato da loja (vazio até o proprietário cadastrar). */
  feeRules: FeeRule[];
  /** Grava (novo ou edição) uma regra de taxa. Devolve o erro, ou null. */
  saveFeeRule: (rule: Omit<FeeRule, 'id'> & { id?: string }) => string | null;
  removeFeeRule: (id: string) => void;
  /** Comissão de cada app de delivery em % (chave do canal). Null = não cadastrada. */
  appCommissionPct: Record<string, number | null>;
  setAppCommission: (channel: string, pct: number | null) => string | null;
}

export const useOwnerSettings = create<OwnerSettingsState>()(
  persist(
    (set) => ({
      dailyGoals: NO_GOALS,
      setDailyGoal: (weekday, value) => {
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return 'Dia da semana inválido.';
        if (value !== null && (!Number.isFinite(value) || value <= 0 || value > MAX_DAILY_GOAL)) return 'Informe uma meta maior que zero.';
        set((s) => ({ dailyGoals: { ...s.dailyGoals, [weekday]: value === null ? null : round2(value) } }));
        return null;
      },
      feeRules: [],
      saveFeeRule: (input) => {
        const rule: FeeRule = {
          id: input.id ?? uuid(),
          acquirer: input.acquirer,
          method: input.method,
          brand: input.method === 'PIX' ? null : input.brand,
          pct: round2(input.pct),
          fixed: round2(input.fixed),
          days: input.days,
          businessDays: input.businessDays,
        };
        const err = validateFeeRule(rule);
        if (err) return err;
        let dup = false;
        set((s) => {
          dup = s.feeRules.some((r) => r.id !== rule.id && r.acquirer === rule.acquirer && r.method === rule.method && r.brand === rule.brand);
          if (dup) return {};
          const exists = s.feeRules.some((r) => r.id === rule.id);
          return { feeRules: exists ? s.feeRules.map((r) => (r.id === rule.id ? rule : r)) : [...s.feeRules, rule] };
        });
        return dup ? 'Já existe uma taxa para essa maquininha, forma e bandeira. Edite a que existe.' : null;
      },
      removeFeeRule: (id) => set((s) => ({ feeRules: s.feeRules.filter((r) => r.id !== id) })),
      appCommissionPct: {},
      setAppCommission: (channel, pct) => {
        if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 50)) return 'Comissão entre 0% e 50%.';
        set((s) => ({ appCommissionPct: { ...s.appCommissionPct, [channel]: pct === null ? null : round2(pct) } }));
        return null;
      },
    }),
    {
      name: 'tchefood-owner-settings',
      storage: createJSONStorage(() => idbStorage),
      // v2 = taxas da maquininha e comissão dos apps.
      version: 2,
      partialize: (s) => ({ dailyGoals: s.dailyGoals, feeRules: s.feeRules, appCommissionPct: s.appCommissionPct }),
      migrate: (persisted) => {
        const out = { ...(persisted as Record<string, unknown>) };
        if (!Array.isArray(out.feeRules)) out.feeRules = [];
        if (typeof out.appCommissionPct !== 'object' || out.appCommissionPct === null) out.appCommissionPct = {};
        return out as unknown as OwnerSettingsState;
      },
    },
  ),
);
