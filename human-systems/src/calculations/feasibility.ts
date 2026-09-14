/**
 * Hard-constraint feasibility filter (assumption A14).
 * feasible(action, constraints) is true only when every declared requirement
 * satisfies every constraint on the same dimension.
 */
import type { Action, Constraint } from "@/types";

export interface FeasibilityResult {
  actionId: string;
  feasible: boolean;
  /** Constraints the action's declared requirements violate. */
  violations: { constraint: Constraint; required: number | boolean }[];
  /** Constraints on dimensions the action did not declare. */
  unverified: Constraint[];
}

function satisfies(required: number | boolean, c: Constraint): boolean {
  if (typeof required === "boolean" || typeof c.limit === "boolean") {
    // Boolean dimensions only make sense with eq.
    return c.comparator === "eq" ? required === c.limit : true;
  }
  switch (c.comparator) {
    case "lte":
      return required <= c.limit;
    case "gte":
      return required >= c.limit;
    case "eq":
      return required === c.limit;
  }
}

export function checkFeasibility(action: Action, constraints: readonly Constraint[]): FeasibilityResult {
  const violations: FeasibilityResult["violations"] = [];
  const unverified: Constraint[] = [];
  for (const c of constraints) {
    const required = action.requirements[c.dimension];
    if (required === undefined) {
      unverified.push(c);
      continue;
    }
    if (!satisfies(required, c)) violations.push({ constraint: c, required });
  }
  return { actionId: action.id, feasible: violations.length === 0, violations, unverified };
}

export function feasible(action: Action, constraints: readonly Constraint[]): boolean {
  return checkFeasibility(action, constraints).feasible;
}
