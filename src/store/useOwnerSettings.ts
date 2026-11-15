/**
 * Preferências do Painel do dono guardadas no aparelho: a meta de venda de cada dia
 * da semana, as taxas da maquininha do contrato e a comissão de cada app de delivery.
 * Não movimentam dinheiro (só as contas do painel), então ficam fora da fila da nuvem;
 * cada aparelho da gerência guarda as suas. A campanha "cliente sumido" (mensagem,
 * cupom e quem já recebeu) também fica aqui.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { idbStorage } from '../lib/idbStorage';
import { round2 } from '../lib/money';
import { validateFeeRule, type FeeRule } from '../lib/cardFees';
import { nowISO, uuid } from '../lib/ids';
import { useTcheStore } from './useTcheStore';
import { DEFAULT_WINBACK_TEMPLATE, normalizeCouponCode, validateCampaign, type WinbackCampaign, type WinbackContact } from '../lib/winback';

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
  /**
   * Taxas da maquininha e comissões dos apps, separadas por loja (tenant_id): o aparelho
   * pode ter operado mais de uma loja, e cada uma tem o seu contrato. Toda leitura e
   * gravação usa só a lista da loja que está no aparelho agora (`storeFees`).
   */
  feesByTenant: Record<string, StoreFees>;
  /**
   * Taxas gravadas antes de serem separadas por loja: não se sabe de qual loja são, então
   * não valem para nenhuma até alguém da gerência confirmar (`adoptLegacyFees`).
   */
  legacyFees: StoreFees | null;
  /** As taxas antigas (sem loja) passam a ser da loja indicada, se ela ainda não tem taxas. */
  adoptLegacyFees: (tenantId: string) => string | null;
  /** Grava (novo ou edição) uma regra de taxa DA LOJA ATUAL. Devolve o erro, ou null. */
  saveFeeRule: (rule: Omit<FeeRule, 'id'> & { id?: string }) => string | null;
  removeFeeRule: (id: string) => void;
  /** Comissão de cada app de delivery em % DA LOJA ATUAL. Null = não cadastrada. */
  setAppCommission: (channel: string, pct: number | null) => string | null;
  /** Campanha para chamar de volta o cliente sumido. */
  winbackCampaign: WinbackCampaign;
  saveWinbackCampaign: (c: WinbackCampaign) => string | null;
  /** Quem já recebeu a mensagem (para não mandar duas vezes e medir quem voltou). */
  winbackContacts: WinbackContact[];
  markWinbackSent: (customerId: string) => void;
}

export interface StoreFees {
  feeRules: FeeRule[];
  /** Comissão de cada app de delivery em % (chave do canal). Null = não cadastrada. */
  appCommissionPct: Record<string, number | null>;
}

const NO_FEE_RULES: FeeRule[] = [];
const NO_COMMISSIONS: Record<string, number | null> = {};
const NO_FEES: StoreFees = { feeRules: NO_FEE_RULES, appCommissionPct: NO_COMMISSIONS };

/** Taxas e comissões da loja indicada (vazio se ela não cadastrou: "não cadastrada"). */
export function storeFees(s: Pick<OwnerSettingsState, 'feesByTenant'>, tenantId: string): StoreFees {
  return s.feesByTenant[tenantId] ?? NO_FEES;
}

/** Loja que está neste aparelho agora (quem grava uma taxa grava para ela). */
const currentTenantId = (): string => useTcheStore.getState().tenant.id;

const hasAnyFee = (f: StoreFees | null | undefined): boolean =>
  !!f && (f.feeRules.length > 0 || Object.values(f.appCommissionPct).some((v) => v !== null && v !== undefined));

/** Hook: taxas e comissões da loja que está no aparelho agora. */
export function useStoreFees(): StoreFees {
  const tenantId = useTcheStore((s) => s.tenant.id);
  return useOwnerSettings((s) => storeFees(s, tenantId));
}

const DEFAULT_CAMPAIGN: WinbackCampaign = { template: DEFAULT_WINBACK_TEMPLATE, offer: '10% de desconto', coupon: 'VOLTA10' };

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
      feesByTenant: {},
      legacyFees: null,
      adoptLegacyFees: (tenantId) => {
        let err: string | null = null;
        set((s) => {
          if (!hasAnyFee(s.legacyFees)) {
            err = 'Não há taxas antigas para confirmar.';
            return {};
          }
          if (hasAnyFee(s.feesByTenant[tenantId])) {
            err = 'Esta loja já tem taxas cadastradas: confira as antigas e cadastre de novo o que for dela.';
            return {};
          }
          return { feesByTenant: { ...s.feesByTenant, [tenantId]: s.legacyFees! }, legacyFees: null };
        });
        return err;
      },
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
        const tenantId = currentTenantId();
        set((s) => {
          const cur = storeFees(s, tenantId);
          dup = cur.feeRules.some((r) => r.id !== rule.id && r.acquirer === rule.acquirer && r.method === rule.method && r.brand === rule.brand);
          if (dup) return {};
          const exists = cur.feeRules.some((r) => r.id === rule.id);
          const feeRules = exists ? cur.feeRules.map((r) => (r.id === rule.id ? rule : r)) : [...cur.feeRules, rule];
          return { feesByTenant: { ...s.feesByTenant, [tenantId]: { ...cur, feeRules } } };
        });
        return dup ? 'Já existe uma taxa para essa maquininha, forma e bandeira. Edite a que existe.' : null;
      },
      removeFeeRule: (id) => {
        const tenantId = currentTenantId();
        set((s) => {
          const cur = storeFees(s, tenantId);
          return { feesByTenant: { ...s.feesByTenant, [tenantId]: { ...cur, feeRules: cur.feeRules.filter((r) => r.id !== id) } } };
        });
      },
      setAppCommission: (channel, pct) => {
        if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 50)) return 'Comissão entre 0% e 50%.';
        const tenantId = currentTenantId();
        set((s) => {
          const cur = storeFees(s, tenantId);
          return { feesByTenant: { ...s.feesByTenant, [tenantId]: { ...cur, appCommissionPct: { ...cur.appCommissionPct, [channel]: pct === null ? null : round2(pct) } } } };
        });
        return null;
      },
      winbackCampaign: DEFAULT_CAMPAIGN,
      saveWinbackCampaign: (c) => {
        const err = validateCampaign(c);
        if (err) return err;
        set({ winbackCampaign: { template: c.template.trim(), offer: c.offer.trim(), coupon: normalizeCouponCode(c.coupon)! } });
        return null;
      },
      winbackContacts: [],
      markWinbackSent: (customerId) =>
        set((s) => ({ winbackContacts: [...s.winbackContacts, { customer_id: customerId, coupon: s.winbackCampaign.coupon, contacted_at: nowISO() }] })),
    }),
    {
      name: 'tchefood-owner-settings',
      storage: createJSONStorage(() => idbStorage),
      // v2 = taxas da maquininha e comissão dos apps; v3 = campanha do cliente sumido;
      // v4 = taxas e comissões separadas por loja (as antigas ficam sem loja até confirmar).
      version: 4,
      partialize: (s) => ({
        dailyGoals: s.dailyGoals,
        feesByTenant: s.feesByTenant,
        legacyFees: s.legacyFees,
        winbackCampaign: s.winbackCampaign,
        winbackContacts: s.winbackContacts,
      }),
      migrate: (persisted) => {
        const out = { ...(persisted as Record<string, unknown>) };
        // Até a v3 havia uma lista só no aparelho, sem loja: vira "taxas antigas" (sem loja).
        const oldRules = Array.isArray(out.feeRules) ? (out.feeRules as FeeRule[]) : [];
        const oldCommissions = typeof out.appCommissionPct === 'object' && out.appCommissionPct !== null ? (out.appCommissionPct as Record<string, number | null>) : {};
        delete out.feeRules;
        delete out.appCommissionPct;
        delete out.feeTenantId;
        if (typeof out.feesByTenant !== 'object' || out.feesByTenant === null) out.feesByTenant = {};
        if (out.legacyFees === undefined) {
          const legacy: StoreFees = { feeRules: oldRules, appCommissionPct: oldCommissions };
          out.legacyFees = hasAnyFee(legacy) ? legacy : null;
        }
        if (typeof out.winbackCampaign !== 'object' || out.winbackCampaign === null) out.winbackCampaign = DEFAULT_CAMPAIGN;
        if (!Array.isArray(out.winbackContacts)) out.winbackContacts = [];
        return out as unknown as OwnerSettingsState;
      },
    },
  ),
);
