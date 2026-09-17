/**
 * Household domain: financial-resilience calculations (pack-owned; the
 * generic engine never imports this module).
 * Pure functions. Each cites the model assumption it rests on (domain/assumptions).
 */
import type { IncomeSource } from "./income";

const EPS = 1e-9;

export interface IncomeShare {
  id: string;
  share: number;
}

/** Sum of gross monthly amounts. */
export function totalMonthlyIncome(sources: readonly IncomeSource[]): number {
  return sources.reduce((sum, s) => sum + s.monthlyAmount, 0);
}

/** A1: floor = sum(amount x reliability). */
export function reliableIncomeFloor(sources: readonly IncomeSource[]): number {
  return sources.reduce((sum, s) => sum + s.monthlyAmount * s.reliability, 0);
}

/** Share of household income per source. Empty / zero income -> []. */
export function incomeShares(sources: readonly IncomeSource[]): IncomeShare[] {
  const total = totalMonthlyIncome(sources);
  if (total <= EPS) return [];
  return sources.map((s) => ({ id: s.id, share: s.monthlyAmount / total }));
}

/** A3: Herfindahl-Hirschman index of income shares. null when no income. */
export function incomeConcentration(sources: readonly IncomeSource[]): number | null {
  const shares = incomeShares(sources);
  if (shares.length === 0) return null;
  return shares.reduce((sum, s) => sum + s.share * s.share, 0);
}

/** A4: largest share of income held by one correlation group. null when no income. */
export function failureCorrelation(sources: readonly IncomeSource[]): number | null {
  const total = totalMonthlyIncome(sources);
  if (total <= EPS) return null;
  const byGroup = new Map<string, number>();
  for (const s of sources) {
    byGroup.set(s.correlationGroup, (byGroup.get(s.correlationGroup) ?? 0) + s.monthlyAmount);
  }
  let max = 0;
  for (const amount of byGroup.values()) max = Math.max(max, amount / total);
  return max;
}

/** A5: income-share-weighted mean volatility. null when no income. */
export function incomeVolatility(sources: readonly IncomeSource[]): number | null {
  const shares = incomeShares(sources);
  if (shares.length === 0) return null;
  const byId = new Map(sources.map((s) => [s.id, s]));
  return shares.reduce((sum, sh) => sum + sh.share * (byId.get(sh.id)?.volatility ?? 0), 0);
}

/** A5: income-share-weighted mean replacement latency in months. null when no income. */
export function replacementLatency(sources: readonly IncomeSource[]): number | null {
  const shares = incomeShares(sources);
  if (shares.length === 0) return null;
  const byId = new Map(sources.map((s) => [s.id, s]));
  return shares.reduce(
    (sum, sh) => sum + sh.share * (byId.get(sh.id)?.replacementLatencyMonths ?? 0),
    0,
  );
}

/** A1: floor ratio = reliable floor / essential expenses. null when expenses are not positive. */
export function floorRatio(reliableFloor: number, essentialExpenses: number): number | null {
  if (!(essentialExpenses > 0)) return null;
  return reliableFloor / essentialExpenses;
}

/** A2: buffer months = liquid reserves / essential expenses. null when expenses are not positive. */
export function bufferMonths(liquidReserves: number, essentialExpenses: number): number | null {
  if (!(essentialExpenses > 0)) return null;
  return liquidReserves / essentialExpenses;
}

/** Monthly surplus (or deficit when negative). */
export function monthlySurplus(input: {
  totalIncome: number;
  essentialExpenses: number;
  discretionaryExpenses: number;
  debtPayments: number;
}): number {
  return (
    input.totalIncome - input.essentialExpenses - input.discretionaryExpenses - input.debtPayments
  );
}

/** Debt burden = monthly debt payments / total income. null when income is not positive. */
export function debtBurden(monthlyDebtPayments: number, totalIncome: number): number | null {
  if (!(totalIncome > 0)) return null;
  return monthlyDebtPayments / totalIncome;
}
