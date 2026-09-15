/**
 * Constraint filter (assumptions A14, A17).
 * HARD constraints exclude: an action is infeasible if any hard constraint
 * whose dimension the action declares is violated.
 * SOFT constraints never exclude: each violated soft constraint multiplies
 * suitability by (1 - softPenalty).
 * Constraints without a machine-checkable rule are descriptive and are
 * reported as "unchecked" for every action.
 */
import type { Action, Constraint } from "@/types";

export interface ConstraintViolation {
  constraint: Constraint;
  required: number | boolean;
}

export interface FeasibilityResult {
  actionId: string;
  /** False only when a HARD constraint is violated. */
  feasible: boolean;
  hardViolations: ConstraintViolation[];
  softViolations: ConstraintViolation[];
  /** 1 when no soft constraint is violated; product of (1 - penalty) otherwise. */
  suitability: number;
  /** Checkable constraints on dimensions the action did not declare. */
  unverified: Constraint[];
  /** Descriptive constraints with no check at all. */
  unchecked: Constraint[];
  /** Violated constraints the person has not confirmed apply to them. */
  unconfirmedViolations: Constraint[];
}

function satisfies(required: number | boolean, c: NonNullable<Constraint["check"]>): boolean {
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
  const hardViolations: ConstraintViolation[] = [];
  const softViolations: ConstraintViolation[] = [];
  const unverified: Constraint[] = [];
  const unchecked: Constraint[] = [];
  for (const c of constraints) {
    if (!c.check) {
      unchecked.push(c);
      continue;
    }
    const required = action.requirements[c.check.dimension];
    if (required === undefined) {
      unverified.push(c);
      continue;
    }
    if (satisfies(required, c.check)) continue;
    (c.type === "hard" ? hardViolations : softViolations).push({ constraint: c, required });
  }
  const suitability = softViolations.reduce((s, v) => s * (1 - v.constraint.softPenalty), 1);
  const unconfirmedViolations = [...hardViolations, ...softViolations]
    .map((v) => v.constraint)
    .filter((c) => !c.userConfirmed);
  return {
    actionId: action.id,
    feasible: hardViolations.length === 0,
    hardViolations,
    softViolations,
    suitability,
    unverified,
    unchecked,
    unconfirmedViolations,
  };
}

export function feasible(action: Action, constraints: readonly Constraint[]): boolean {
  return checkFeasibility(action, constraints).feasible;
}
