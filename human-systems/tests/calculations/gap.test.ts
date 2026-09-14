import { describe, expect, it } from "vitest";
import { effectiveGap, normalizeGap, structuralGap, variableGap } from "@/calculations/gap";
import type { Variable } from "@/types";

const v = (over: Partial<Variable>): Variable => ({
  id: "v",
  name: "v",
  description: "",
  category: "structure",
  changeSpeed: "slow",
  kind: "input",
  currentValue: 1,
  desiredValue: 2,
  targetMode: "exact",
  unit: "u",
  sourceType: "measured",
  confidence: 1,
  evidence: [],
  controllability: 0.5,
  durability: 0.5,
  estimatedCostToChange: 0.5,
  notes: "",
  ...over,
});

describe("A11 gap", () => {
  it("absolute gap is desired - current with direction", () => {
    const g = variableGap(v({ currentValue: 0.8, desiredValue: 1.1 }))!;
    expect(g.absoluteGap).toBeCloseTo(0.3, 9);
    expect(g.direction).toBe("up");
    expect(variableGap(v({ currentValue: 3, desiredValue: 1 }))!.direction).toBe("down");
    expect(variableGap(v({ currentValue: 1, desiredValue: 1 }))!.direction).toBe("none");
  });
  it("honours targetMode: a met floor or respected ceiling is a closed gap", () => {
    expect(effectiveGap("at_least", 17, 10)).toBe(0);
    expect(effectiveGap("at_least", 2, 10)).toBe(8);
    expect(effectiveGap("at_most", 1, 3)).toBe(0);
    expect(effectiveGap("at_most", 7, 3)).toBe(-4);
    expect(effectiveGap("exact", 17, 10)).toBe(-7);
    const over = variableGap(v({ currentValue: 17, desiredValue: 10, targetMode: "at_least", referenceRange: { min: 0, max: 20 } }))!;
    expect(over.direction).toBe("none");
    expect(over.normalizedGap).toBe(0);
  });
  it("is null when either value is missing", () => {
    expect(variableGap(v({ currentValue: null }))).toBeNull();
    expect(variableGap(v({ desiredValue: null }))).toBeNull();
  });
  it("normalises against the reference range when present, clipped to 1", () => {
    expect(normalizeGap({ referenceRange: { min: 0, max: 10 } }, 2, 7)).toBeCloseTo(0.5, 9);
    expect(normalizeGap({ referenceRange: { min: 0, max: 1 } }, 0, 5)).toBe(1);
  });
  it("falls back to relative magnitude without a range", () => {
    expect(normalizeGap({}, 2800, 10800)).toBeCloseTo(8000 / 10800, 9);
    expect(normalizeGap({}, 0, 0)).toBe(0);
    expect(normalizeGap({}, 0, 5)).toBe(1);
  });
  it("summary counts open/closed and averages", () => {
    const s = structuralGap([
      v({ id: "a", currentValue: 0, desiredValue: 10, referenceRange: { min: 0, max: 10 } }),
      v({ id: "b", currentValue: 5, desiredValue: 5 }),
      v({ id: "c", currentValue: null }),
    ]);
    expect(s.gaps.length).toBe(2);
    expect(s.openCount).toBe(1);
    expect(s.closedCount).toBe(1);
    expect(s.meanNormalizedGap).toBeCloseTo(0.5, 9);
    expect(structuralGap([]).meanNormalizedGap).toBeNull();
  });
});
