/**
 * Conceptual leverage score (assumption A8).
 * All factors are 0..1 ordinal judgments. Floors on the denominator keep a
 * "free" or "certain" change from producing an infinite score. Only the
 * RANK of the results is meaningful.
 */
export const LEVERAGE_FLOOR = 0.05;

export interface LeverageFactors {
  impact: number;
  controllability: number;
  durability: number;
  cost: number;
  uncertainty: number;
}

export interface LeverageResult {
  score: number;
  factors: LeverageFactors;
  /** True when a denominator factor was raised to the floor. */
  floored: boolean;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function leverageScore(raw: LeverageFactors): LeverageResult {
  const factors: LeverageFactors = {
    impact: clamp01(raw.impact),
    controllability: clamp01(raw.controllability),
    durability: clamp01(raw.durability),
    cost: clamp01(raw.cost),
    uncertainty: clamp01(raw.uncertainty),
  };
  const cost = Math.max(factors.cost, LEVERAGE_FLOOR);
  const uncertainty = Math.max(factors.uncertainty, LEVERAGE_FLOOR);
  const floored = cost !== factors.cost || uncertainty !== factors.uncertainty;
  const score = (factors.impact * factors.controllability * factors.durability) / (cost * uncertainty);
  return { score, factors, floored };
}

/** Sort descending by score; ties keep input order. */
export function rankByLeverage<T>(
  items: readonly T[],
  factorsOf: (item: T) => LeverageFactors | null,
): { item: T; leverage: LeverageResult; rank: number }[] {
  const scored = items
    .map((item) => ({ item, factors: factorsOf(item) }))
    .filter((x): x is { item: T; factors: LeverageFactors } => x.factors !== null)
    .map((x) => ({ item: x.item, leverage: leverageScore(x.factors) }));
  scored.sort((a, b) => b.leverage.score - a.leverage.score);
  return scored.map((x, i) => ({ ...x, rank: i + 1 }));
}
