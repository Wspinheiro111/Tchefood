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
import { isManagerRole, selectCurrentUser, useTcheStore } from './useTcheStore';
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
  /**
   * Loja que estava no aparelho quando ele abriu esta versão com taxas antigas (a única
   * pista de origem: a v3 não gravava a loja). Null = ainda não anotada. Só o proprietário
   * DESSA loja pode confirmar e trazer as antigas; para qualquer outra loja elas ficam em
   * quarentena (nem os valores aparecem).
   */
  legacyOrigin: string | null;
  /** Loja cujo proprietário confirmou que as antigas são dela (os valores só aparecem para ela). */
  legacyConfirmedTenantId: string | null;
  /**
   * O proprietário da loja de origem confirma que as taxas antigas são dela e as traz, sem
   * sobrescrever nada: a regra da mesma maquininha, forma e bandeira (ou a comissão do mesmo
   * app) com valor diferente fica nas antigas, marcada como conflito; a igual não duplica.
   * Só vale para a loja que está no aparelho agora.
   */
  adoptLegacyFees: (tenantId: string) => string | null;
  /**
   * Tira as taxas antigas da lista de pendentes, sem apagar: vão para `legacyArchive`, de onde
   * a gerência pode restaurar (não se sabe de qual loja são; outra loja pode precisar delas).
   */
  discardLegacyFees: () => string | null;
  /** Taxas antigas tiradas da lista (mais recente por último), guardadas para restaurar. */
  legacyArchive: LegacyBatch[];
  /** Volta as últimas taxas antigas tiradas para a lista de pendentes. */
  restoreLegacyFees: () => string | null;
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

/** Taxas antigas guardadas fora da lista, com a pista de origem e a confirmação que tinham. */
export interface LegacyBatch {
  fees: StoreFees;
  origin: string;
  confirmedTenantId: string | null;
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

/** Só gerente ou proprietário mexe nas taxas antigas (sem loja definida). */
const NOT_MANAGER = 'Só gerente ou proprietário revisa as taxas antigas.';
const currentIsManager = (): boolean => isManagerRole(selectCurrentUser(useTcheStore.getState())?.role);
/** Origem das taxas antigas que não dá mais para saber (fica em quarentena). */
export const UNKNOWN_ORIGIN = '?';
const currentIsOwner = (): boolean => selectCurrentUser(useTcheStore.getState())?.role === 'OWNER';

/**
 * O que a loja atual pode fazer com as taxas antigas:
 * - 'revealed': o proprietário desta loja já confirmou que são dela (valores à vista para a gerência);
 * - 'confirm': o aparelho estava nesta loja quando atualizou; o proprietário pode confirmar (sem ver os valores antes);
 * - 'quarantine': origem desconhecida ou outra loja: ninguém aqui vê os valores nem pode trazê-las.
 */
export type LegacyAccess = 'revealed' | 'confirm' | 'quarantine';
export function legacyAccess(s: Pick<OwnerSettingsState, 'legacyOrigin' | 'legacyConfirmedTenantId'>, tenantId: string): LegacyAccess {
  if (s.legacyConfirmedTenantId === tenantId) return 'revealed';
  if (s.legacyConfirmedTenantId === null && s.legacyOrigin === tenantId) return 'confirm';
  return 'quarantine';
}

/** Loja que está neste aparelho agora (quem grava uma taxa grava para ela). */
const currentTenantId = (): string => useTcheStore.getState().tenant.id;

const hasAnyFee = (f: StoreFees | null | undefined): boolean =>
  !!f && (f.feeRules.length > 0 || Object.values(f.appCommissionPct).some((v) => v !== null && v !== undefined));

const sameSlot = (a: FeeRule, b: FeeRule) => a.acquirer === b.acquirer && a.method === b.method && a.brand === b.brand;
const sameValues = (a: FeeRule, b: FeeRule) => a.pct === b.pct && a.fixed === b.fixed && a.days === b.days && a.businessDays === b.businessDays;

/**
 * Junta as taxas antigas às da loja sem sobrescrever: o que não existe na loja entra; o que
 * já existe igual não duplica (sai das antigas); o que existe com valor diferente é conflito
 * e fica nas antigas (`left`), nunca troca a taxa da loja sozinho.
 */
export function mergeLegacyFees(store: StoreFees, legacy: StoreFees): { merged: StoreFees; left: StoreFees; conflicts: { rules: FeeRule[]; channels: string[] } } {
  const rules = [...store.feeRules];
  const leftRules: FeeRule[] = [];
  for (const r of legacy.feeRules) {
    const cur = rules.find((x) => sameSlot(x, r));
    if (!cur) rules.push(rules.some((x) => x.id === r.id) ? { ...r, id: uuid() } : r);
    else if (!sameValues(cur, r)) leftRules.push(r);
  }
  const commissions = { ...store.appCommissionPct };
  const leftCommissions: Record<string, number | null> = {};
  for (const [ch, v] of Object.entries(legacy.appCommissionPct)) {
    if (v === null || v === undefined) continue;
    const cur = commissions[ch];
    if (cur === null || cur === undefined) commissions[ch] = v;
    else if (cur !== v) leftCommissions[ch] = v;
  }
  return {
    merged: { feeRules: rules, appCommissionPct: commissions },
    left: { feeRules: leftRules, appCommissionPct: leftCommissions },
    conflicts: { rules: leftRules, channels: Object.keys(leftCommissions) },
  };
}

/** Taxas antigas que ainda esperam decisão (null = nenhuma). */
export function pendingLegacyFees(s: Pick<OwnerSettingsState, 'legacyFees'>): StoreFees | null {
  return hasAnyFee(s.legacyFees) ? s.legacyFees : null;
}

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
      legacyOrigin: null,
      legacyConfirmedTenantId: null,
      adoptLegacyFees: (tenantId) => {
        if (!currentIsOwner()) return 'Só o proprietário confirma de qual loja são as taxas antigas.';
        if (tenantId !== currentTenantId()) return 'Só dá para trazer as taxas antigas para a loja que está neste aparelho.';
        let err: string | null = null;
        set((s) => {
          if (!hasAnyFee(s.legacyFees)) {
            err = 'Não há taxas antigas para trazer.';
            return {};
          }
          if (legacyAccess(s, tenantId) === 'quarantine') {
            err = 'Estas taxas antigas não são desta loja (ou a origem é desconhecida): ficam guardadas, sem uso aqui.';
            return {};
          }
          const { merged, left } = mergeLegacyFees(storeFees(s, tenantId), s.legacyFees!);
          const rest = hasAnyFee(left);
          return {
            feesByTenant: { ...s.feesByTenant, [tenantId]: merged },
            legacyFees: rest ? left : null,
            legacyConfirmedTenantId: rest ? tenantId : null,
            legacyOrigin: rest ? s.legacyOrigin : null,
          };
        });
        return err;
      },
      legacyArchive: [],
      discardLegacyFees: () => {
        if (!currentIsManager()) return NOT_MANAGER;
        let err: string | null = null;
        set((s) => {
          if (!hasAnyFee(s.legacyFees)) {
            err = 'Não há taxas antigas para tirar da lista.';
            return {};
          }
          // Sem pista anotada, guarda como origem desconhecida (nunca é anotada depois, em outra loja).
          const batch: LegacyBatch = { fees: s.legacyFees!, origin: s.legacyOrigin ?? UNKNOWN_ORIGIN, confirmedTenantId: s.legacyConfirmedTenantId };
          return { legacyArchive: [...s.legacyArchive, batch], legacyFees: null, legacyOrigin: null, legacyConfirmedTenantId: null };
        });
        return err;
      },
      restoreLegacyFees: () => {
        if (!currentIsManager()) return NOT_MANAGER;
        let err: string | null = null;
        set((s) => {
          const last = s.legacyArchive[s.legacyArchive.length - 1];
          if (!last) {
            err = 'Não há taxas antigas guardadas para restaurar.';
            return {};
          }
          if (hasAnyFee(s.legacyFees)) {
            err = 'Resolva antes as taxas antigas que estão na lista.';
            return {};
          }
          // Volta com a mesma pista de origem e a mesma confirmação: restaurar não revela nada.
          return { legacyFees: last.fees, legacyOrigin: last.origin, legacyConfirmedTenantId: last.confirmedTenantId, legacyArchive: s.legacyArchive.slice(0, -1) };
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
        legacyArchive: s.legacyArchive,
        legacyOrigin: s.legacyOrigin,
        legacyConfirmedTenantId: s.legacyConfirmedTenantId,
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
        out.legacyArchive = Array.isArray(out.legacyArchive)
          ? (out.legacyArchive as unknown[]).map((b) => (b && typeof b === 'object' && 'fees' in b ? b : { fees: b, origin: UNKNOWN_ORIGIN, confirmedTenantId: null }))
          : [];
        if (typeof out.legacyOrigin !== 'string') out.legacyOrigin = null;
        if (typeof out.legacyConfirmedTenantId !== 'string') out.legacyConfirmedTenantId = null;
        if (typeof out.winbackCampaign !== 'object' || out.winbackCampaign === null) out.winbackCampaign = DEFAULT_CAMPAIGN;
        if (!Array.isArray(out.winbackContacts)) out.winbackContacts = [];
        return out as unknown as OwnerSettingsState;
      },
    },
  ),
);

/**
 * Anota a pista de origem das taxas antigas: a loja que está no aparelho quando ele abre esta
 * versão pela primeira vez (com os dados da loja já carregados). Só anota uma vez.
 */
export function stampLegacyOrigin(): void {
  const s = useOwnerSettings.getState();
  if (!hasAnyFee(s.legacyFees) || s.legacyOrigin !== null || s.legacyConfirmedTenantId !== null) return;
  useOwnerSettings.setState({ legacyOrigin: useTcheStore.getState().tenant.id });
}
const tryStampLegacyOrigin = () => {
  if (useOwnerSettings.persist.hasHydrated() && useTcheStore.persist.hasHydrated()) stampLegacyOrigin();
};
useOwnerSettings.persist.onFinishHydration(tryStampLegacyOrigin);
useTcheStore.persist.onFinishHydration(tryStampLegacyOrigin);
tryStampLegacyOrigin();
