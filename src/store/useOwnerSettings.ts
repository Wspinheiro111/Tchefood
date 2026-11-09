/**
 * Preferências do Painel do dono guardadas no aparelho: a meta de venda de cada dia
 * da semana. Não é dinheiro da loja (só a régua do painel), então fica fora da fila
 * da nuvem; cada aparelho da gerência guarda a sua.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { idbStorage } from '../lib/idbStorage';
import { round2 } from '../lib/money';

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
    }),
    { name: 'tchefood-owner-settings', storage: createJSONStorage(() => idbStorage), version: 1 },
  ),
);
