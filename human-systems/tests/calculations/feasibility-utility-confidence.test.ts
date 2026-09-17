import { describe, expect, it } from "vitest";
import { HOUSEHOLD_EVALUATION_DIMENSIONS } from "@/domains/household/evaluation-dimensions";
import { derivedConfidence } from "@/calculations/confidence";
import { checkFeasibility, feasible } from "@/calculations/feasibility";
import { utilityView } from "@/calculations/utility";
import type { Action, Constraint } from "@/types";

const constraint = (over: Partial<Constraint> & { dimension?: string; comparator?: "lte" | "gte" | "eq"; limit?: number | boolean }): Constraint => {
  const { dimension = "hoursPerWeek", comparator = "lte", limit = 8, ...rest } = over;
  return {
    id: "c",
    name: "c",
    description: "",
    subjectId: null,
    type: "hard",
    check: { dimension, comparator, limit },
    softPenalty: 0.5,
    sourceType: "self_reported",
    confidence: 0.7,
    evidence: [],
    userConfirmed: true,
    notes: "",
    ...rest,
  };
};
const action = (requirements: Action["requirements"]): Action => ({
  id: "a",
  name: "a",
  description: "",
  subjectId: null,
  targetVariables: [],
  extensions: {},
  requirements,
  utility: {},
  impact: 0.5,
  controllability: 0.5,
  durability: 0.5,
  cost: 0.5,
  uncertainty: 0.5,
  sourceType: "self_reported",
  confidence: 0.5,
  notes: "",
});

describe("A14 feasibility", () => {
  const constraints = [
    constraint({ id: "hours", dimension: "hoursPerWeek", comparator: "lte", limit: 8 }),
    constraint({ id: "capital", dimension: "capitalRequired", comparator: "lte", limit: 1500 }),
    constraint({ id: "reloc", dimension: "requiresRelocation", comparator: "eq", limit: false }),
  ];
  it("passes when every declared requirement satisfies its constraint", () => {
    const r = checkFeasibility(action({ hoursPerWeek: 4, capitalRequired: 250, requiresRelocation: false }), constraints);
    expect(r.feasible).toBe(true);
    expect(r.hardViolations).toEqual([]);
    expect(r.unverified).toEqual([]);
    expect(r.suitability).toBe(1);
  });
  it("fails on any violated constraint and lists each", () => {
    const r = checkFeasibility(action({ hoursPerWeek: 15, capitalRequired: 4000, requiresRelocation: false }), constraints);
    expect(r.feasible).toBe(false);
    expect(r.hardViolations.map((v) => v.constraint.id)).toEqual(["hours", "capital"]);
  });
  it("boolean constraints use eq", () => {
    expect(feasible(action({ requiresRelocation: true }), [constraints[2]])).toBe(false);
    expect(feasible(action({ requiresRelocation: false }), [constraints[2]])).toBe(true);
  });
  it("undeclared dimensions are unverified, not violations", () => {
    const r = checkFeasibility(action({ hoursPerWeek: 2 }), constraints);
    expect(r.feasible).toBe(true);
    expect(r.unverified.map((c) => c.id)).toEqual(["capital", "reloc"]);
  });
  it("supports gte", () => {
    const c = constraint({ dimension: "minAge", comparator: "gte", limit: 21 });
    expect(feasible(action({ minAge: 18 }), [c])).toBe(false);
    expect(feasible(action({ minAge: 25 }), [c])).toBe(true);
  });
});

describe("utility view", () => {
  it("lists every dimension and computes no total without weights", () => {
    const v = utilityView({ stability: 0.5, risk: -0.2 }, undefined, HOUSEHOLD_EVALUATION_DIMENSIONS);
    expect(v.dimensions).toHaveLength(14);
    expect(v.dimensions.every((d) => d.declared)).toBe(true);
    expect(v.assessedCount).toBe(2);
    expect(v.weightedTotal).toBeNull();
  });
  it("weighted total is a weight-normalised sum over assessed dimensions", () => {
    const v = utilityView({ stability: 0.5, risk: -0.5, upside: 1 }, { stability: 1, risk: 1, autonomy: 1 }, HOUSEHOLD_EVALUATION_DIMENSIONS);
    // autonomy unassessed -> ignored; (1*0.5 + 1*-0.5)/(1+1) = 0
    expect(v.weightedTotal).toBeCloseTo(0, 9);
    expect(utilityView({ stability: 0.5 }, { risk: 1 }, HOUSEHOLD_EVALUATION_DIMENSIONS).weightedTotal).toBeNull();
  });
  it("a historical key the domain does not declare is shown as undeclared, never dropped or reinterpreted", () => {
    const v = utilityView({ personalityFit: 0.3, stability: 0.5 }, { personalityFit: 1, stability: 1 }, [{ key: "stability", label: "Stability", higherIsBetter: true }]);
    expect(v.dimensions.map((d) => [d.dimension, d.declared])).toEqual([
      ["stability", true],
      ["personalityFit", false],
    ]);
    expect(v.assessedCount).toBe(2);
    expect(v.weightedTotal).toBeCloseTo(0.4, 9);
    // a domain that declares nothing sees only historical keys
    expect(utilityView({ upside: 1 }, undefined, []).dimensions).toEqual([{ dimension: "upside", label: "upside", higherIsBetter: true, value: 1, declared: false }]);
  });
});

describe("A13 derived confidence", () => {
  it("is the minimum of inputs, 0 for none", () => {
    expect(derivedConfidence([0.9, 0.5, 0.7])).toBe(0.5);
    expect(derivedConfidence([])).toBe(0);
  });
});
