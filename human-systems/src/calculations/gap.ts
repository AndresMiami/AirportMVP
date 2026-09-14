/**
 * Structural gap G = X* - X per variable (assumption A11 for normalisation).
 */
import type { Variable } from "@/types";

export interface VariableGap {
  variableId: string;
  current: number;
  desired: number;
  /** Shortfall in the variable's own unit (desired - current, or 0 when a
   *  floor is already met / a ceiling already respected). */
  absoluteGap: number;
  /** 0..1, comparable across units. */
  normalizedGap: number;
  /** Direction the variable has to move to close the gap. */
  direction: "up" | "down" | "none";
}

const EPS = 1e-9;

export function normalizeGap(v: Pick<Variable, "referenceRange">, current: number, desired: number): number {
  const abs = Math.abs(desired - current);
  if (abs <= EPS) return 0;
  let span: number;
  if (v.referenceRange) {
    span = v.referenceRange.max - v.referenceRange.min;
  } else {
    span = Math.max(Math.abs(desired), Math.abs(current));
  }
  if (span <= EPS) return 1;
  return Math.min(1, abs / span);
}

/** Signed shortfall honouring targetMode: 0 when a floor is met or a ceiling respected. */
export function effectiveGap(mode: Variable["targetMode"], current: number, desired: number): number {
  const raw = desired - current;
  if (mode === "at_least" && raw < 0) return 0;
  if (mode === "at_most" && raw > 0) return 0;
  return raw;
}

/** Gap for one variable, or null when either side is missing. */
export function variableGap(v: Variable): VariableGap | null {
  if (v.currentValue === null || v.desiredValue === null) return null;
  const absoluteGap = effectiveGap(v.targetMode, v.currentValue, v.desiredValue);
  const direction = Math.abs(absoluteGap) <= EPS ? "none" : absoluteGap > 0 ? "up" : "down";
  return {
    variableId: v.id,
    current: v.currentValue,
    desired: v.desiredValue,
    absoluteGap,
    normalizedGap: absoluteGap === 0 ? 0 : normalizeGap(v, v.currentValue, v.desiredValue),
    direction,
  };
}

/** A VECTOR of gaps plus counts. There is deliberately no mean: averaging
 *  heterogeneous gaps into one number would be a universal score. */
export interface GapSummary {
  gaps: VariableGap[];
  /** Variables with both values that are not yet at the desired value. */
  openCount: number;
  closedCount: number;
}

export function structuralGap(variables: readonly Variable[]): GapSummary {
  const gaps = variables.map(variableGap).filter((g): g is VariableGap => g !== null);
  const openCount = gaps.filter((g) => g.direction !== "none").length;
  return { gaps, openCount, closedCount: gaps.length - openCount };
}
