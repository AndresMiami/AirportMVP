/**
 * Household domain: derived formulas (configuration of the generic derived
 * engine in model/derived.ts). Every formula cites its assumption id.
 * UNKNOWN IS NOT ZERO: each formula returns null when a needed input is
 * null; the engine reports the missing input.
 */
import {
  bufferMonths,
  debtBurden,
  failureCorrelation,
  floorRatio,
  incomeConcentration,
  incomeVolatility,
  monthlySurplus,
  reliableIncomeFloor,
  replacementLatency,
  totalMonthlyIncome,
} from "./calculations";
import type { DerivedDefinition, DerivedInputRef } from "@/model/domain";
import { DERIVED_IDS as D, INPUT_IDS as I } from "./keys";

/** Every household formula is SYSTEM-scoped and reads system-scope keys:
 *  that is what the v2 household formulas represented, and migration keeps
 *  their records system-attributed. */
const sys = (keys: string[]): DerivedInputRef[] => keys.map((key) => ({ key, from: "system" }));

export const HOUSEHOLD_DERIVED: DerivedDefinition[] = [
  {
    key: D.totalIncome,
    name: "Total monthly income",
    description: "Sum of all income sources' gross monthly amounts.",
    unit: "$/month",
    category: "event",
    changeSpeed: "fast",
    targetMode: "at_least",
    scope: "system",
    inputs: sys([]),
    derivedInputs: sys([]),
    usesIncomeSources: true,
    assumptionIds: [],
    compute: (ctx) => (ctx.incomeSources.length ? totalMonthlyIncome(ctx.incomeSources) : null),
  },
  {
    key: D.reliableFloor,
    name: "Reliable income floor",
    description: "Income that can be counted on in a bad month (amount x reliability per source). Renamed 'reliability-weighted income' in a later migration.",
    unit: "$/month",
    category: "structure",
    changeSpeed: "slow",
    targetMode: "at_least",
    scope: "system",
    inputs: sys([]),
    derivedInputs: sys([]),
    usesIncomeSources: true,
    assumptionIds: ["A1"],
    compute: (ctx) => (ctx.incomeSources.length ? reliableIncomeFloor(ctx.incomeSources) : null),
  },
  {
    key: D.monthlySurplus,
    name: "Monthly surplus / deficit",
    description: "Total income minus essential, discretionary and debt payments. Unknown when any expense class is unknown.",
    unit: "$/month",
    category: "event",
    changeSpeed: "fast",
    targetMode: "at_least",
    scope: "system",
    inputs: sys([I.essentialExpenses, I.discretionaryExpenses, I.monthlyDebtPayments]),
    derivedInputs: sys([D.totalIncome]),
    usesIncomeSources: false,
    assumptionIds: [],
    compute: (ctx) => {
      const income = ctx.derived(D.totalIncome);
      const essentialExpenses = ctx.value(I.essentialExpenses);
      const discretionaryExpenses = ctx.value(I.discretionaryExpenses);
      const debtPayments = ctx.value(I.monthlyDebtPayments);
      if (income === null || essentialExpenses === null || discretionaryExpenses === null || debtPayments === null) return null;
      return monthlySurplus({ totalIncome: income, essentialExpenses, discretionaryExpenses, debtPayments });
    },
    defaultReferenceRange: { min: -2000, max: 2000 },
  },
  {
    key: D.floorRatio,
    name: "Floor ratio",
    description: "Reliable income floor / essential monthly expenses. Below 1 means essentials are not covered in a bad month.",
    unit: "ratio",
    category: "structure",
    changeSpeed: "slow",
    targetMode: "at_least",
    scope: "system",
    inputs: sys([I.essentialExpenses]),
    derivedInputs: sys([D.reliableFloor]),
    usesIncomeSources: false,
    assumptionIds: ["A1"],
    compute: (ctx) => {
      const floor = ctx.derived(D.reliableFloor);
      const ess = ctx.value(I.essentialExpenses);
      if (floor === null || ess === null) return null;
      return floorRatio(floor, ess);
    },
    defaultReferenceRange: { min: 0, max: 2 },
  },
  {
    key: D.bufferMonths,
    name: "Buffer months",
    description: "Liquid reserves / essential monthly expenses.",
    unit: "months",
    category: "buffer",
    changeSpeed: "slow",
    targetMode: "at_least",
    scope: "system",
    inputs: sys([I.liquidReserves, I.essentialExpenses]),
    derivedInputs: sys([]),
    usesIncomeSources: false,
    assumptionIds: ["A2"],
    compute: (ctx) => {
      const res = ctx.value(I.liquidReserves);
      const ess = ctx.value(I.essentialExpenses);
      if (res === null || ess === null) return null;
      return bufferMonths(res, ess);
    },
    defaultReferenceRange: { min: 0, max: 12 },
  },
  {
    key: D.incomeConcentration,
    name: "Income concentration (HHI)",
    description: "Sum of squared income shares. 1 = one source; lower = more diversified.",
    unit: "index 0-1",
    category: "dependency",
    changeSpeed: "slow",
    targetMode: "at_most",
    scope: "system",
    inputs: sys([]),
    derivedInputs: sys([]),
    usesIncomeSources: true,
    assumptionIds: ["A3"],
    compute: (ctx) => incomeConcentration(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 1 },
  },
  {
    key: D.incomeVolatility,
    name: "Income volatility",
    description: "Income-share-weighted month-to-month variability of sources.",
    unit: "index 0-1",
    category: "structure",
    changeSpeed: "slow",
    targetMode: "at_most",
    scope: "system",
    inputs: sys([]),
    derivedInputs: sys([]),
    usesIncomeSources: true,
    assumptionIds: ["A5"],
    compute: (ctx) => incomeVolatility(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 1 },
  },
  {
    key: D.failureCorrelation,
    name: "Income-source failure correlation",
    description: "Largest share of income that would disappear together (same employer, platform or industry).",
    unit: "share 0-1",
    category: "dependency",
    changeSpeed: "slow",
    targetMode: "at_most",
    scope: "system",
    inputs: sys([]),
    derivedInputs: sys([]),
    usesIncomeSources: true,
    assumptionIds: ["A4"],
    compute: (ctx) => failureCorrelation(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 1 },
  },
  {
    key: D.replacementLatency,
    name: "Replacement latency",
    description: "Income-share-weighted months needed to replace a lost source.",
    unit: "months",
    category: "structure",
    changeSpeed: "slow",
    targetMode: "at_most",
    scope: "system",
    inputs: sys([]),
    derivedInputs: sys([]),
    usesIncomeSources: true,
    assumptionIds: ["A5"],
    compute: (ctx) => replacementLatency(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 6 },
  },
  {
    key: D.debtBurden,
    name: "Debt burden",
    description: "Monthly debt payments / total monthly income.",
    unit: "share 0-1",
    category: "structure",
    changeSpeed: "slow",
    targetMode: "at_most",
    scope: "system",
    inputs: sys([I.monthlyDebtPayments]),
    derivedInputs: sys([D.totalIncome]),
    usesIncomeSources: false,
    assumptionIds: [],
    compute: (ctx) => {
      const income = ctx.derived(D.totalIncome);
      const pay = ctx.value(I.monthlyDebtPayments);
      if (income === null || pay === null) return null;
      return debtBurden(pay, income);
    },
    defaultReferenceRange: { min: 0, max: 0.5 },
  },
];
