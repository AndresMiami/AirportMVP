/**
 * Generic derived-variable engine. The FORMULAS come from the active domain
 * definition (model/domain.ts); this module only evaluates them in order,
 * once per applicable subject (the system for a system-scope definition,
 * each member for a member-scope one), resolves each declared input from
 * the source it names (system / same subject), propagates confidence and
 * reports what was missing. Members are never averaged into a system value.
 *
 * A derived Variable record still lives in model.variables so the person
 * can set a desired value, notes and leverage factors for it, but its
 * currentValue / sourceType / confidence are ALWAYS overwritten here.
 */
import { derivedConfidence } from "@/calculations/confidence";
import type { IncomeSource, SubjectId, Variable } from "@/types";
import {
  refFor,
  resolveVariable,
  systemRef,
  variableIdFor,
  type DerivedContext,
  type DerivedDefinition,
  type DerivedInputRef,
  type VariableRef,
} from "./domain";

/** Confidence of the income-source list as a whole (A13: the minimum). */
export function incomeSourcesConfidence(sources: readonly IncomeSource[]): number {
  return derivedConfidence(sources.map((s) => s.confidence));
}

/** A placeholder Variable record for a derived definition, used when the
 *  stored model lacks one (e.g. a definition added after the data was saved). */
export function defaultDerivedVariable(def: DerivedDefinition, subjectId: SubjectId, systemId: string): Variable {
  return {
    id: variableIdFor(def.key, subjectId, systemId),
    key: def.key,
    subjectId,
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
  /** The subject this computation is for (system id or member id). */
  subjectId: SubjectId;
  /** Keys of inputs that were missing (null or unresolved), for the evidence screen. */
  missingInputs: string[];
}

/** The reference a declared input resolves to for a given subject. */
function inputRef(input: DerivedInputRef, subjectId: SubjectId, systemId: string): VariableRef {
  return input.from === "system" ? systemRef(input.key) : refFor(input.key, subjectId, systemId);
}

/**
 * Recompute every derived variable of the domain. Input variables are
 * passed through untouched. Order follows the domain's list so earlier
 * derived values are available to later ones. A system-scope definition
 * is computed once for the system; a member-scope definition once per id
 * in `memberIds`, independently. UNKNOWN IS NOT ZERO: a missing input is
 * reported, never substituted.
 */
export function computeDerivedVariables(
  variables: readonly Variable[],
  incomeSources: readonly IncomeSource[],
  definitions: readonly DerivedDefinition[],
  systemId: string,
  memberIds: readonly SubjectId[] = [],
): { variables: Variable[]; computations: DerivedComputation[] } {
  const inputs = variables.filter((v) => v.kind === "input");
  const storedKey = (key: string, subjectId: SubjectId | null) => `${key}\u0000${subjectId ?? ""}`;
  const stored = new Map(variables.filter((v) => v.kind === "derived").map((v) => [storedKey(v.key, v.subjectId), v]));
  /** derived key -> subject id -> value / confidence */
  const derivedValues = new Map<string, Map<SubjectId, number | null>>();
  const derivedConf = new Map<string, Map<SubjectId, number>>();
  const computations: DerivedComputation[] = [];
  const srcConf = incomeSourcesConfidence(incomeSources);

  const declared = (def: DerivedDefinition, list: DerivedInputRef[], key: string, what: string): DerivedInputRef => {
    const found = list.find((i) => i.key === key);
    if (!found) throw new Error(`Derived definition "${def.key}" reads undeclared ${what} "${key}"; declare it with its source`);
    return found;
  };

  for (const def of definitions) {
    const subjects: SubjectId[] = def.scope === "system" ? [systemId] : [...memberIds];
    for (const subjectId of subjects) {
      const inputVariable = (key: string): Variable | undefined =>
        resolveVariable(inputs, systemId, inputRef(declared(def, def.inputs, key, "input"), subjectId, systemId));
      const derivedSubject = (key: string): SubjectId => {
        const ref = declared(def, def.derivedInputs, key, "derived input");
        return ref.from === "system" ? systemId : subjectId;
      };
      const ctx: DerivedContext = {
        subjectId,
        incomeSources,
        value: (key) => inputVariable(key)?.currentValue ?? null,
        derived: (key) => derivedValues.get(key)?.get(derivedSubject(key)) ?? null,
      };
      const current = def.compute(ctx);
      const confidences: number[] = [];
      const missingInputs: string[] = [];
      for (const input of def.inputs) {
        const v = resolveVariable(inputs, systemId, inputRef(input, subjectId, systemId));
        if (!v || v.currentValue === null) missingInputs.push(input.key);
        else confidences.push(v.confidence);
      }
      for (const input of def.derivedInputs) {
        const target = input.from === "system" ? systemId : subjectId;
        const dv = derivedValues.get(input.key)?.get(target);
        if (dv === null || dv === undefined) missingInputs.push(input.key);
        else confidences.push(derivedConf.get(input.key)?.get(target) ?? 0);
      }
      if (def.usesIncomeSources) {
        if (incomeSources.length === 0) missingInputs.push("incomeSources");
        else confidences.push(srcConf);
      }
      const confidence = current === null ? 0 : derivedConfidence(confidences);
      const base = stored.get(storedKey(def.key, subjectId)) ?? defaultDerivedVariable(def, subjectId, systemId);
      const variable: Variable = {
        ...base,
        key: def.key,
        subjectId,
        kind: "derived",
        formulaId: def.key,
        unit: def.unit,
        currentValue: current,
        sourceType: "calculated",
        confidence,
        referenceRange: base.referenceRange ?? def.defaultReferenceRange,
      };
      if (!derivedValues.has(def.key)) derivedValues.set(def.key, new Map());
      if (!derivedConf.has(def.key)) derivedConf.set(def.key, new Map());
      derivedValues.get(def.key)!.set(subjectId, current);
      derivedConf.get(def.key)!.set(subjectId, confidence);
      computations.push({ variable, definition: def, subjectId, missingInputs });
    }
  }

  // A stored derived record whose definition no longer exists, or whose
  // subject is not evaluated (e.g. an archived member), cannot be
  // recomputed, so it must not carry a value: it is dropped from the view.
  return { variables: [...inputs, ...computations.map((c) => c.variable)], computations };
}
