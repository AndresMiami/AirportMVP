/**
 * Multidimensional option-evaluation view. There is deliberately no
 * universal score: a weighted total is computed only when the person
 * supplied weights. The dimensions and their meaning come from the domain;
 * the engine sees keys and signed judgments only. A key present on an
 * action but not declared by the domain is a HISTORICAL value: it is shown
 * (flagged undeclared), never dropped and never reinterpreted.
 */
import type { EvaluationDimension } from "@/model/domain";
import type { UtilityVector, UtilityWeights } from "@/types";

export interface UtilityView {
  /** Declared dimensions in the domain's order, then undeclared historical keys. */
  dimensions: { dimension: string; label: string; higherIsBetter: boolean; value: number | null; declared: boolean }[];
  assessedCount: number;
  /** Present only when weights were supplied. */
  weightedTotal: number | null;
}

export function utilityView(vector: UtilityVector, weights: UtilityWeights | undefined, declared: readonly EvaluationDimension[]): UtilityView {
  const dimensions: UtilityView["dimensions"] = declared.map((d) => ({
    dimension: d.key,
    label: d.label,
    higherIsBetter: d.higherIsBetter,
    value: vector[d.key] ?? null,
    declared: true,
  }));
  const declaredKeys = new Set(declared.map((d) => d.key));
  for (const key of Object.keys(vector).sort()) {
    if (declaredKeys.has(key)) continue;
    dimensions.push({ dimension: key, label: key, higherIsBetter: true, value: vector[key] ?? null, declared: false });
  }
  const assessedCount = dimensions.filter((d) => d.value !== null).length;
  let weightedTotal: number | null = null;
  if (weights && Object.keys(weights).length > 0) {
    let sum = 0;
    let weightSum = 0;
    for (const d of dimensions) {
      const w = weights[d.dimension];
      if (w === undefined || d.value === null) continue;
      sum += w * d.value;
      weightSum += w;
    }
    weightedTotal = weightSum > 0 ? sum / weightSum : null;
  }
  return { dimensions, assessedCount, weightedTotal };
}
