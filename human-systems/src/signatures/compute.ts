/**
 * computeSignature: the ONLY way a StructuralSignature comes into being.
 * It reads the evaluated model (never raw input) and a definition, and
 * returns an immutable snapshot with full provenance per dimension.
 *
 * Rules (assumptions A19-A21):
 *  - a missing or null variable is UNKNOWN; it is never treated as 0;
 *  - a required unknown input, or fewer known inputs than the minimum,
 *    makes the dimension unknown (value null, confidence 0);
 *  - the continuous normalized value is canonical; binary and band
 *    states are derived for display and stored alongside for the record;
 *  - confidence = aggregate of the known inputs' confidences, scaled by
 *    the share of input weight that was known.
 */
import { effectiveGap } from "@/calculations/gap";
import { DERIVED_BY_ID } from "@/model/derived";
import type { EvaluatedSystem } from "@/model/evaluate";
import type { Variable } from "@/types";
import {
  StructuralSignatureSchema,
  type Contribution,
  type DimensionInput,
  type SignatureDefinition,
  type SignatureDimensionDefinition,
  type StructuralDimensionSnapshot,
  type StructuralSignature,
  type VariableSnapshotItem,
} from "@/types/signature";
import { HOUSEHOLD_SIGNATURE_V1 } from "./definitions/household-v1";
import { computeDynamicsSignature, toLoopSnapshot, toRelationshipSnapshot } from "./dynamics";
import { bandStateOf, binaryStateOf, clip01, compactStrip } from "./encode";

export interface ComputeSignatureOptions {
  id: string;
  now: string;
  mode: "current" | "desired";
  definition?: SignatureDefinition;
  label?: string;
  notes?: string;
}

export const SIGNATURE_ASSUMPTION_IDS = ["A19", "A20", "A21"];

/** Transform a raw value to 0..1 per the input's transform and inversion. */
export function normalizeInput(raw: number, input: Pick<DimensionInput, "transform" | "invert">): number {
  let t: number;
  if (input.transform.kind === "linear") {
    const span = input.transform.max - input.transform.min;
    t = span > 0 ? (raw - input.transform.min) / span : 0;
  } else {
    t = raw / input.transform.strongAt;
  }
  t = clip01(t);
  return input.invert ? 1 - t : t;
}

/** The raw value to read for a mode. In desired mode a floor already met
 *  (or ceiling already respected) keeps the current value; a variable
 *  with no target is read at its current value. */
export function rawValueFor(v: Variable, mode: "current" | "desired"): number | null {
  if (mode === "current") return v.currentValue;
  if (v.desiredValue === null) return v.currentValue;
  if (v.currentValue !== null && effectiveGap(v.targetMode, v.currentValue, v.desiredValue) === 0) return v.currentValue;
  return v.desiredValue;
}

/**
 * Observations bearing on a variable: those linked to it directly and,
 * for a calculated variable, those linked to any variable its formula
 * reads (recursively). Provenance follows the definition chain so that a
 * dimension reading "buffer months" still shows the evidence recorded on
 * "liquid reserves".
 */
export function observationIdsForVariable(evaluated: EvaluatedSystem, variableId: string, seen = new Set<string>()): string[] {
  if (seen.has(variableId)) return [];
  seen.add(variableId);
  const direct = (evaluated.observations.byVariable.get(variableId) ?? []).map((o) => o.id);
  const def = DERIVED_BY_ID[variableId];
  if (!def) return direct;
  const upstream = [...def.inputVariables, ...def.inputDerived].flatMap((id) => observationIdsForVariable(evaluated, id, seen));
  return [...new Set([...direct, ...upstream])];
}

function contributionFor(input: DimensionInput, evaluated: EvaluatedSystem, mode: "current" | "desired"): Contribution {
  const v = evaluated.variableById.get(input.variableId);
  const raw = v ? rawValueFor(v, mode) : null;
  return {
    variableId: input.variableId,
    name: v?.name ?? input.variableId,
    unit: v?.unit ?? "",
    rawValue: raw,
    normalized: raw === null ? null : normalizeInput(raw, input),
    weight: input.weight,
    required: input.required,
    sourceType: v?.sourceType ?? null,
    confidence: v ? v.confidence : null,
    evidenceTexts: v?.evidence.map((e) => e.text) ?? [],
    observationIds: observationIdsForVariable(evaluated, input.variableId),
    transform: input.transform,
    invert: input.invert,
  };
}

export function computeDimension(
  def: SignatureDimensionDefinition,
  evaluated: EvaluatedSystem,
  mode: "current" | "desired",
): StructuralDimensionSnapshot {
  const contributions = def.inputs.map((input) => contributionFor(input, evaluated, mode));
  const known = contributions.filter((c) => c.normalized !== null);
  const totalWeight = contributions.reduce((s, c) => s + c.weight, 0);
  const knownWeight = known.reduce((s, c) => s + c.weight, 0);
  const knownWeightFraction = totalWeight > 0 ? knownWeight / totalWeight : 0;
  const missing = contributions.filter((c) => c.normalized === null);
  const missingRequired = missing.filter((c) => c.required);
  const missingInformation = missing.map((c) =>
    evaluated.variableById.has(c.variableId) ? c.variableId : `${c.variableId} (not in the model)`,
  );
  const evidenceIds = [...new Set(contributions.flatMap((c) => c.observationIds))];

  const isUnknown = missingRequired.length > 0 || known.length < def.minimumKnownInputs;
  let value: number | null = null;
  let confidence = 0;
  let explanation: string;

  if (isUnknown) {
    const why =
      missingRequired.length > 0
        ? `required input ${missingRequired.map((c) => c.name).join(", ")} has no value`
        : `${known.length} of ${contributions.length} inputs known; at least ${def.minimumKnownInputs} needed`;
    explanation = `Unknown: ${why}. This is missing information, not a low value.`;
  } else {
    const values = known.map((c) => c.normalized as number);
    if (def.aggregation === "min") value = Math.min(...values);
    else if (def.aggregation === "max") value = Math.max(...values);
    else value = known.reduce((s, c) => s + c.weight * (c.normalized as number), 0) / knownWeight;
    value = clip01(value);
    const confs = known.map((c) => c.confidence ?? 0);
    const baseConf =
      def.confidenceMethod === "min"
        ? Math.min(...confs)
        : known.reduce((s, c) => s + c.weight * (c.confidence ?? 0), 0) / knownWeight;
    confidence = clip01(baseConf * knownWeightFraction);
    const parts = known.map((c) => `${c.name} ${fmt(c.rawValue)} ${c.unit} → ${fmt(c.normalized)}${c.invert ? " (inverted)" : ""}`);
    explanation =
      `${aggLabel(def.aggregation)} of ${known.length} known input${known.length > 1 ? "s" : ""}` +
      `${missing.length > 0 ? ` (${missing.length} unknown, excluded)` : ""}: ${parts.join("; ")}.` +
      ` Confidence ${Math.round(confidence * 100)}% = ${def.confidenceMethod === "min" ? "minimum" : "weighted mean"} of input confidence` +
      `${knownWeightFraction < 1 ? ` × ${Math.round(knownWeightFraction * 100)}% of input weight known` : ""}.`;
  }

  return {
    dimensionId: def.id,
    name: def.name,
    state: isUnknown ? "unknown" : "known",
    normalizedValue: value,
    binaryState: binaryStateOf(value, def.binaryThreshold),
    bandState: bandStateOf(value, def.bandThresholds),
    confidence,
    knownWeightFraction,
    contributingVariableIds: def.inputs.map((i) => i.variableId),
    contributions,
    evidenceIds,
    calculationMethod: `${def.aggregation} over known inputs after ${def.inputs.map((i) => i.transform.kind).join("/")} transforms; confidence = ${def.confidenceMethod} × known-weight fraction; unknown when a required input is missing or fewer than ${def.minimumKnownInputs} inputs are known`,
    explanation,
    missingInformation,
    binaryThreshold: def.binaryThreshold,
    bandThresholds: def.bandThresholds,
    assumptionIds: SIGNATURE_ASSUMPTION_IDS,
  };
}

export function variableSnapshotOf(v: Variable): VariableSnapshotItem {
  const normalized =
    v.currentValue !== null && v.referenceRange
      ? clip01((v.currentValue - v.referenceRange.min) / (v.referenceRange.max - v.referenceRange.min))
      : null;
  return {
    id: v.id,
    name: v.name,
    unit: v.unit,
    kind: v.kind,
    category: v.category,
    changeSpeed: v.changeSpeed,
    currentValue: v.currentValue,
    desiredValue: v.desiredValue,
    targetMode: v.targetMode,
    normalized,
    confidence: v.confidence,
    sourceType: v.sourceType,
  };
}

export function computeSignature(evaluated: EvaluatedSystem, opts: ComputeSignatureOptions): StructuralSignature {
  const definition = opts.definition ?? HOUSEHOLD_SIGNATURE_V1;
  const dimensions = definition.dimensions.map((d) => computeDimension(d, evaluated, opts.mode));
  const known = dimensions.filter((d) => d.state === "known");
  const signature: StructuralSignature = {
    id: opts.id,
    systemId: evaluated.model.id,
    createdAt: opts.now,
    schemaVersion: 1,
    definitionId: definition.id,
    definitionVersion: definition.version,
    mode: opts.mode,
    dimensions,
    relationshipSnapshot: evaluated.allRelationships.map((r) => toRelationshipSnapshot(r, evaluated)),
    loopSnapshot: evaluated.loops.map(toLoopSnapshot),
    variableSnapshot: evaluated.variables.map(variableSnapshotOf),
    dynamics: computeDynamicsSignature(evaluated),
    completeness: dimensions.length ? known.length / dimensions.length : 0,
    overallConfidence: known.length ? known.reduce((s, d) => s + d.confidence, 0) / known.length : null,
    sourceObservationIds: [...new Set(dimensions.flatMap((d) => d.evidenceIds))],
    compactStrip: compactStrip(dimensions),
    label: opts.label,
    notes: opts.notes,
  };
  // Validate, then freeze: history must never be edited in place.
  return deepFreeze(StructuralSignatureSchema.parse(signature));
}

export function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) deepFreeze(value);
  }
  return obj;
}

function fmt(n: number | null): string {
  if (n === null) return "unknown";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function aggLabel(a: SignatureDimensionDefinition["aggregation"]): string {
  return a === "weighted_mean" ? "Weighted mean" : a === "min" ? "Minimum" : "Maximum";
}
