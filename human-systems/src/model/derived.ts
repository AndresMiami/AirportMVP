/**
 * Derived-variable definitions. Each names its inputs (variable ids and/or
 * the income-source list), the formula, and the assumption ids it rests on.
 *
 * A derived Variable record still lives in model.variables so the person
 * can set a desired value, notes and leverage factors for it, but its
 * currentValue / sourceType / confidence are ALWAYS overwritten here.
 */
import {
  bufferMonths,
  debtBurden,
  derivedConfidence,
  failureCorrelation,
  floorRatio,
  incomeConcentration,
  incomeVolatility,
  monthlySurplus,
  reliableIncomeFloor,
  replacementLatency,
  totalMonthlyIncome,
} from "@/calculations";
import type { IncomeSource, Variable, VariableCategory, ChangeSpeed } from "@/types";
import { DERIVED_IDS, INPUT_IDS } from "./ids";

export interface DerivedContext {
  /** Current values of input variables by id (null when missing). */
  value: (id: string) => number | null;
  incomeSources: readonly IncomeSource[];
  /** Values already computed for earlier derived variables (evaluation order). */
  derived: (id: string) => number | null;
}

export interface DerivedDefinition {
  id: string;
  name: string;
  description: string;
  unit: string;
  category: VariableCategory;
  changeSpeed: ChangeSpeed;
  /** Input variable ids the formula reads. */
  inputVariables: string[];
  /** Derived ids the formula reads (must appear earlier in DERIVED_DEFINITIONS). */
  inputDerived: string[];
  usesIncomeSources: boolean;
  assumptionIds: string[];
  compute: (ctx: DerivedContext) => number | null;
  /** Sensible default reference range for gap normalisation. */
  defaultReferenceRange?: { min: number; max: number };
  /** How a desired value on this variable is meant. */
  targetMode: "at_least" | "at_most" | "exact";
}

export const DERIVED_DEFINITIONS: DerivedDefinition[] = [
  {
    id: DERIVED_IDS.totalIncome,
    targetMode: "at_least",
    name: "Total monthly income",
    description: "Sum of all income sources' gross monthly amounts.",
    unit: "$/month",
    category: "event",
    changeSpeed: "fast",
    inputVariables: [],
    inputDerived: [],
    usesIncomeSources: true,
    assumptionIds: [],
    compute: (ctx) => (ctx.incomeSources.length ? totalMonthlyIncome(ctx.incomeSources) : null),
  },
  {
    id: DERIVED_IDS.reliableFloor,
    targetMode: "at_least",
    name: "Reliable income floor",
    description: "Income that can be counted on in a bad month (amount x reliability per source).",
    unit: "$/month",
    category: "structure",
    changeSpeed: "slow",
    inputVariables: [],
    inputDerived: [],
    usesIncomeSources: true,
    assumptionIds: ["A1"],
    compute: (ctx) => (ctx.incomeSources.length ? reliableIncomeFloor(ctx.incomeSources) : null),
  },
  {
    id: DERIVED_IDS.monthlySurplus,
    targetMode: "at_least",
    name: "Monthly surplus / deficit",
    description: "Total income minus essential, discretionary and debt payments.",
    unit: "$/month",
    category: "event",
    changeSpeed: "fast",
    inputVariables: [INPUT_IDS.essentialExpenses, INPUT_IDS.discretionaryExpenses, INPUT_IDS.monthlyDebtPayments],
    inputDerived: [DERIVED_IDS.totalIncome],
    usesIncomeSources: false,
    assumptionIds: [],
    compute: (ctx) => {
      // UNKNOWN IS NOT ZERO (A20): a missing expense class makes the surplus
      // unknown rather than silently larger. The missing input is reported by
      // computeDerivedVariables as a model issue.
      const income = ctx.derived(DERIVED_IDS.totalIncome);
      const essentialExpenses = ctx.value(INPUT_IDS.essentialExpenses);
      const discretionaryExpenses = ctx.value(INPUT_IDS.discretionaryExpenses);
      const debtPayments = ctx.value(INPUT_IDS.monthlyDebtPayments);
      if (income === null || essentialExpenses === null || discretionaryExpenses === null || debtPayments === null) return null;
      return monthlySurplus({ totalIncome: income, essentialExpenses, discretionaryExpenses, debtPayments });
    },
    defaultReferenceRange: { min: -2000, max: 2000 },
  },
  {
    id: DERIVED_IDS.floorRatio,
    targetMode: "at_least",
    name: "Floor ratio",
    description: "Reliable income floor / essential monthly expenses. Below 1 means essentials are not covered in a bad month.",
    unit: "ratio",
    category: "structure",
    changeSpeed: "slow",
    inputVariables: [INPUT_IDS.essentialExpenses],
    inputDerived: [DERIVED_IDS.reliableFloor],
    usesIncomeSources: false,
    assumptionIds: ["A1"],
    compute: (ctx) => {
      const floor = ctx.derived(DERIVED_IDS.reliableFloor);
      const ess = ctx.value(INPUT_IDS.essentialExpenses);
      if (floor === null || ess === null) return null;
      return floorRatio(floor, ess);
    },
    defaultReferenceRange: { min: 0, max: 2 },
  },
  {
    id: DERIVED_IDS.bufferMonths,
    targetMode: "at_least",
    name: "Buffer months",
    description: "Liquid reserves / essential monthly expenses.",
    unit: "months",
    category: "buffer",
    changeSpeed: "slow",
    inputVariables: [INPUT_IDS.liquidReserves, INPUT_IDS.essentialExpenses],
    inputDerived: [],
    usesIncomeSources: false,
    assumptionIds: ["A2"],
    compute: (ctx) => {
      const res = ctx.value(INPUT_IDS.liquidReserves);
      const ess = ctx.value(INPUT_IDS.essentialExpenses);
      if (res === null || ess === null) return null;
      return bufferMonths(res, ess);
    },
    defaultReferenceRange: { min: 0, max: 12 },
  },
  {
    id: DERIVED_IDS.incomeConcentration,
    targetMode: "at_most",
    name: "Income concentration (HHI)",
    description: "Sum of squared income shares. 1 = one source; lower = more diversified.",
    unit: "index 0-1",
    category: "dependency",
    changeSpeed: "slow",
    inputVariables: [],
    inputDerived: [],
    usesIncomeSources: true,
    assumptionIds: ["A3"],
    compute: (ctx) => incomeConcentration(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 1 },
  },
  {
    id: DERIVED_IDS.incomeVolatility,
    targetMode: "at_most",
    name: "Income volatility",
    description: "Income-share-weighted month-to-month variability of sources.",
    unit: "index 0-1",
    category: "structure",
    changeSpeed: "slow",
    inputVariables: [],
    inputDerived: [],
    usesIncomeSources: true,
    assumptionIds: ["A5"],
    compute: (ctx) => incomeVolatility(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 1 },
  },
  {
    id: DERIVED_IDS.failureCorrelation,
    targetMode: "at_most",
    name: "Income-source failure correlation",
    description: "Largest share of income that would disappear together (same employer, platform or industry).",
    unit: "share 0-1",
    category: "dependency",
    changeSpeed: "slow",
    inputVariables: [],
    inputDerived: [],
    usesIncomeSources: true,
    assumptionIds: ["A4"],
    compute: (ctx) => failureCorrelation(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 1 },
  },
  {
    id: DERIVED_IDS.replacementLatency,
    targetMode: "at_most",
    name: "Replacement latency",
    description: "Income-share-weighted months needed to replace a lost source.",
    unit: "months",
    category: "structure",
    changeSpeed: "slow",
    inputVariables: [],
    inputDerived: [],
    usesIncomeSources: true,
    assumptionIds: ["A5"],
    compute: (ctx) => replacementLatency(ctx.incomeSources),
    defaultReferenceRange: { min: 0, max: 6 },
  },
  {
    id: DERIVED_IDS.debtBurden,
    targetMode: "at_most",
    name: "Debt burden",
    description: "Monthly debt payments / total monthly income.",
    unit: "share 0-1",
    category: "structure",
    changeSpeed: "slow",
    inputVariables: [INPUT_IDS.monthlyDebtPayments],
    inputDerived: [DERIVED_IDS.totalIncome],
    usesIncomeSources: false,
    assumptionIds: [],
    compute: (ctx) => {
      const income = ctx.derived(DERIVED_IDS.totalIncome);
      const pay = ctx.value(INPUT_IDS.monthlyDebtPayments);
      if (income === null || pay === null) return null;
      return debtBurden(pay, income);
    },
    defaultReferenceRange: { min: 0, max: 0.5 },
  },
];

export const DERIVED_BY_ID: Record<string, DerivedDefinition> = Object.fromEntries(
  DERIVED_DEFINITIONS.map((d) => [d.id, d]),
);

/** Confidence of the income-source list as a whole (A13: the minimum). */
export function incomeSourcesConfidence(sources: readonly IncomeSource[]): number {
  return derivedConfidence(sources.map((s) => s.confidence));
}

/** A placeholder Variable record for a derived definition, used when the
 *  stored model lacks one (e.g. a definition added after the data was saved). */
export function defaultDerivedVariable(def: DerivedDefinition): Variable {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    changeSpeed: def.changeSpeed,
    kind: "derived",
    formulaId: def.id,
    currentValue: null,
    desiredValue: null,
    targetMode: def.targetMode,
    unit: def.unit,
    sourceType: "calculated",
    confidence: 0,
    evidence: [],
    controllability: 0.3,
    durability: 0.5,
    estimatedCostToChange: 0.5,
    referenceRange: def.defaultReferenceRange,
    notes: "",
  };
}

export interface DerivedComputation {
  variable: Variable;
  definition: DerivedDefinition;
  /** Ids of inputs that were missing (null), for the evidence screen. */
  missingInputs: string[];
}

/**
 * Recompute every derived variable. Input variables are passed through
 * untouched. Order follows DERIVED_DEFINITIONS so earlier derived values
 * are available to later ones.
 */
export function computeDerivedVariables(
  variables: readonly Variable[],
  incomeSources: readonly IncomeSource[],
): { variables: Variable[]; computations: DerivedComputation[] } {
  const byId = new Map(variables.map((v) => [v.id, v]));
  const inputs = variables.filter((v) => v.kind === "input");
  const value = (id: string): number | null => {
    const v = byId.get(id);
    return v && v.kind === "input" ? v.currentValue : null;
  };
  const derivedValues = new Map<string, number | null>();
  const derivedConf = new Map<string, number>();
  const computations: DerivedComputation[] = [];
  const srcConf = incomeSourcesConfidence(incomeSources);

  for (const def of DERIVED_DEFINITIONS) {
    const ctx: DerivedContext = {
      value,
      incomeSources,
      derived: (id) => derivedValues.get(id) ?? null,
    };
    const current = def.compute(ctx);
    const confidences: number[] = [];
    const missingInputs: string[] = [];
    for (const id of def.inputVariables) {
      const v = byId.get(id);
      if (!v || v.currentValue === null) missingInputs.push(id);
      else confidences.push(v.confidence);
    }
    for (const id of def.inputDerived) {
      if (derivedValues.get(id) === null || derivedValues.get(id) === undefined) missingInputs.push(id);
      else confidences.push(derivedConf.get(id) ?? 0);
    }
    if (def.usesIncomeSources) {
      if (incomeSources.length === 0) missingInputs.push("incomeSources");
      else confidences.push(srcConf);
    }
    const confidence = current === null ? 0 : derivedConfidence(confidences);
    const stored = byId.get(def.id);
    const base = stored ?? defaultDerivedVariable(def);
    const variable: Variable = {
      ...base,
      kind: "derived",
      formulaId: def.id,
      unit: def.unit,
      currentValue: current,
      sourceType: "calculated",
      confidence,
      referenceRange: base.referenceRange ?? def.defaultReferenceRange,
    };
    derivedValues.set(def.id, current);
    derivedConf.set(def.id, confidence);
    computations.push({ variable, definition: def, missingInputs });
  }

  // Keep any stored derived variables whose definition no longer exists out
  // of the model: they cannot be recomputed, so they must not show a value.
  const derivedVars = computations.map((c) => c.variable);
  return { variables: [...inputs, ...derivedVars], computations };
}
