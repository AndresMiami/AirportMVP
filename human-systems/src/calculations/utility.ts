/**
 * Multidimensional utility view. There is deliberately no universal score:
 * a weighted total is computed only when the person supplied weights.
 */
import { UTILITY_DIMENSIONS } from "@/domain/vocabulary";
import type { UtilityDimension, UtilityVector, UtilityWeights } from "@/types";

export interface UtilityView {
  /** Every dimension, in canonical order; null when not assessed. */
  dimensions: { dimension: UtilityDimension; value: number | null }[];
  assessedCount: number;
  /** Present only when weights were supplied. */
  weightedTotal: number | null;
}

export function utilityView(vector: UtilityVector, weights?: UtilityWeights): UtilityView {
  const dimensions = UTILITY_DIMENSIONS.map((dimension) => ({
    dimension,
    value: vector[dimension] ?? null,
  }));
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
