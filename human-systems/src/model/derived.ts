/**
 * Generic derived-variable engine. The FORMULAS come from the active domain
 * definition (model/domain.ts); this module only evaluates them in order,
 * resolves inputs at system scope, propagates confidence and reports what
 * was missing.
 *
 * A derived Variable record still lives in model.variables so the person
 * can set a desired value, notes and leverage factors for it, but its
 * currentValue / sourceType / confidence are ALWAYS overwritten here.
 */
import { derivedConfidence } from "@/calculations/confidence";
import type { IncomeSource, Variable } from "@/types";
import { resolveVariable, type DerivedContext, type DerivedDefinition } from "./domain";

/** Confidence of the income-source list as a whole (A13: the minimum). */
export function incomeSourcesConfidence(sources: readonly IncomeSource[]): number {
  return derivedConfidence(sources.map((s) => s.confidence));
}

/** A placeholder Variable record for a derived definition, used when the
 *  stored model lacks one (e.g. a definition added after the data was saved). */
export function defaultDerivedVariable(def: DerivedDefinition, systemId: string): Variable {
  return {
    id: def.key,
    key: def.key,
    subjectId: systemId,
    name: def.name,
    description: def.description,
    category: def.category,
    changeSpeed: def.changeSpeed,
    kind: "derived",
    formulaId: def.key,
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
  /** Keys of inputs that were missing (null or unresolved), for the evidence screen. */
  missingInputs: string[];
}

/**
 * Recompute every derived variable of the domain. Input variables are
 * passed through untouched. Order follows the domain's list so earlier
 * derived values are available to later ones. UNKNOWN IS NOT ZERO: a
 * missing input is reported, never substituted.
 */
export function computeDerivedVariables(
  variables: readonly Variable[],
  incomeSources: readonly IncomeSource[],
  definitions: readonly DerivedDefinition[],
  systemId: string,
): { variables: Variable[]; computations: DerivedComputation[] } {
  const inputs = variables.filter((v) => v.kind === "input");
  const stored = new Map(variables.filter((v) => v.kind === "derived").map((v) => [v.key, v]));
  const value = (key: string): number | null => {
    const v = resolveVariable(inputs, systemId, { key, subjectId: null });
    return v ? v.currentValue : null;
  };
  const derivedValues = new Map<string, number | null>();
  const derivedConf = new Map<string, number>();
  const computations: DerivedComputation[] = [];
  const srcConf = incomeSourcesConfidence(incomeSources);

  for (const def of definitions) {
    const ctx: DerivedContext = { value, incomeSources, derived: (key) => derivedValues.get(key) ?? null };
    const current = def.compute(ctx);
    const confidences: number[] = [];
    const missingInputs: string[] = [];
    for (const key of def.inputKeys) {
      const v = resolveVariable(inputs, systemId, { key, subjectId: null });
      if (!v || v.currentValue === null) missingInputs.push(key);
      else confidences.push(v.confidence);
    }
    for (const key of def.inputDerivedKeys) {
      const dv = derivedValues.get(key);
      if (dv === null || dv === undefined) missingInputs.push(key);
      else confidences.push(derivedConf.get(key) ?? 0);
    }
    if (def.usesIncomeSources) {
      if (incomeSources.length === 0) missingInputs.push("incomeSources");
      else confidences.push(srcConf);
    }
    const confidence = current === null ? 0 : derivedConfidence(confidences);
    const base = stored.get(def.key) ?? defaultDerivedVariable(def, systemId);
    const variable: Variable = {
      ...base,
      key: def.key,
      subjectId: systemId,
      kind: "derived",
      formulaId: def.key,
      unit: def.unit,
      currentValue: current,
      sourceType: "calculated",
      confidence,
      referenceRange: base.referenceRange ?? def.defaultReferenceRange,
    };
    derivedValues.set(def.key, current);
    derivedConf.set(def.key, confidence);
    computations.push({ variable, definition: def, missingInputs });
  }

  // A stored derived record whose definition no longer exists cannot be
  // recomputed, so it must not carry a value: it is dropped from the view.
  return { variables: [...inputs, ...computations.map((c) => c.variable)], computations };
}
