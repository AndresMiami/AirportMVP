import { describe, expect, it } from "vitest";
import { incomeSourcesOf } from "@/services/household-income";
import { registerBuiltInDomains } from "@/domains";
registerBuiltInDomains();
import { createSampleHousehold } from "@/data/sample-household";
import { HOUSEHOLD_DERIVED } from "@/domains/household/derived";
import { evaluateSystem } from "@/model/evaluate";
import { DERIVED_IDS, INPUT_IDS } from "@/domains/household/keys";
import { SystemModelSchema } from "@/types";

describe("sample household", () => {
  it("validates against the schema", () => {
    expect(() => SystemModelSchema.parse(createSampleHousehold())).not.toThrow();
  });
  it("has a record for every derived definition and a definition for every derived record", () => {
    const m = createSampleHousehold();
    const derivedIds = m.variables.filter((v) => v.kind === "derived").map((v) => v.id).sort();
    expect(derivedIds).toEqual(HOUSEHOLD_DERIVED.map((d) => d.key).sort());
  });
  it("every relationship endpoint exists and every input has evidence", () => {
    const m = createSampleHousehold();
    const ids = new Set(m.variables.map((v) => v.id));
    for (const r of m.relationships) {
      expect(ids.has(r.sourceVariableId), r.id).toBe(true);
      expect(ids.has(r.targetVariableId), r.id).toBe(true);
    }
    for (const v of m.variables.filter((x) => x.kind === "input")) expect(v.evidence.length, v.id).toBeGreaterThan(0);
  });
});

describe("computeDerivedVariables (through evaluateSystem)", () => {
  it("recomputes values, stamps calculated, and a stored derived value entry is refused by the schema", () => {
    const m = createSampleHousehold();
    const fr = evaluateSystem(m).variableById.get(DERIVED_IDS.floorRatio)!;
    expect(fr.currentValue).toBeCloseTo(2970 / 3600, 9);
    expect(fr.sourceType).toBe("calculated");
    expect(fr.kind).toBe("derived");
    // derived != entered: a shell carrying a value entry does not validate
    const tampered = m.variables.map((v) =>
      v.id === DERIVED_IDS.floorRatio
        ? { ...v, values: [{ id: "x", value: 99, valid: { kind: "instant", start: "2026-09-01T00:00:00.000Z", precision: "datetime", text: "" }, validBasis: "recorded", recordedAt: "2026-09-01T00:00:00.000Z", sourceType: "measured", confidence: 1, evidence: [], observationIds: [], note: "", status: "active" }] }
        : v,
    );
    expect(SystemModelSchema.safeParse({ ...m, variables: tampered }).success).toBe(false);
  });
  it("keeps stored targets and notes on derived shells", () => {
    const m = createSampleHousehold();
    expect(evaluateSystem(m).variableById.get(DERIVED_IDS.floorRatio)!.desiredValue).toBe(1.1);
  });
  it("A13: confidence is the minimum of inputs, 0 when a value cannot be computed", () => {
    const m = createSampleHousehold();
    const ev = evaluateSystem(m);
    const minSourceConf = Math.min(...incomeSourcesOf(m).map((s) => s.confidence));
    expect(ev.variableById.get(DERIVED_IDS.reliableFloor)!.confidence).toBe(minSourceConf);
    // buffer months = reserves (0.95) + essentials (0.85) -> 0.85
    expect(ev.variableById.get(DERIVED_IDS.bufferMonths)!.confidence).toBe(0.85);
    const noIncome = evaluateSystem({ ...m, collections: {} });
    const ti = noIncome.variableById.get(DERIVED_IDS.totalIncome)!;
    expect(ti.currentValue).toBeNull();
    expect(ti.confidence).toBe(0);
    expect(noIncome.derived.find((c) => c.definition.key === DERIVED_IDS.totalIncome)!.missingInputs).toContain("incomeSources");
    expect(ev.derived.every((c) => c.missingInputs.length === 0)).toBe(true);
  });
  it("creates a default shell when the stored model lacks a derived variable", () => {
    const m = createSampleHousehold();
    const without = { ...m, variables: m.variables.filter((v) => v.id !== DERIVED_IDS.debtBurden) };
    const db = evaluateSystem(without).variableById.get(DERIVED_IDS.debtBurden)!;
    expect(db.currentValue).toBeCloseTo(320 / 4300, 9);
    expect(db.desiredValue).toBeNull();
  });
  it("derived values chain in definition order (surplus uses total income)", () => {
    const m = createSampleHousehold();
    expect(evaluateSystem(m).variableById.get(DERIVED_IDS.monthlySurplus)!.currentValue).toBe(4300 - 3600 - 400 - 320);
  });
});

describe("evaluateSystem on the sample", () => {
  const ev = evaluateSystem(createSampleHousehold());
  it("detects the four annotated loops with the expected polarity", () => {
    const named = Object.fromEntries(ev.loops.map((l) => [l.annotation?.name, l.polarity]));
    expect(named["Survival-work trap"]).toBe("reinforcing");
    expect(named["Belt-tightening"]).toBe("balancing");
    expect(named["Plan churn"]).toBe("reinforcing");
    expect(named["Effort erosion"]).toBe("reinforcing");
    expect(ev.loops).toHaveLength(4);
    expect(ev.loops.every((l) => l.pressure !== null && l.pressure > 0)).toBe(true);
  });
  it("reports no issues and keeps every relationship", () => {
    expect(ev.issues).toEqual([]);
    expect(ev.relationships).toHaveLength(ev.model.relationships.length);
  });
  it("ranks only variables with an impact judgment", () => {
    expect(ev.variableLeverage.length).toBeGreaterThan(0);
    expect(ev.variableLeverage.every((r) => r.variable.impact !== undefined)).toBe(true);
    expect(ev.unassessedVariables.every((v) => v.impact === undefined)).toBe(true);
    expect(ev.variableLeverage.length + ev.unassessedVariables.length).toBe(ev.variables.length);
    for (let i = 1; i < ev.variableLeverage.length; i += 1) {
      expect(ev.variableLeverage[i - 1].leverage.score).toBeGreaterThanOrEqual(ev.variableLeverage[i].leverage.score);
    }
  });
  it("ranks feasible actions only; infeasible ones carry violations", () => {
    const cdl = ev.actions.find((a) => a.action.id === "a_cdl")!;
    const relocate = ev.actions.find((a) => a.action.id === "a_relocate")!;
    expect(cdl.feasibility.feasible).toBe(false);
    expect(cdl.rank).toBeNull();
    expect(cdl.feasibility.hardViolations.map((v) => v.constraint.id).sort()).toEqual(["c_capital", "c_hours"]);
    expect(relocate.feasibility.hardViolations.map((v) => v.constraint.id)).toEqual(["c_capital", "c_relocation"]);
    // The soft "prefers predictable income" constraint lowers suitability without excluding.
    expect(relocate.feasibility.softViolations.map((v) => v.constraint.id)).toEqual(["c_risk"]);
    expect(relocate.feasibility.suitability).toBeCloseTo(0.6, 9);
    const forklift = ev.actions.find((a) => a.action.id === "a_forklift")!;
    expect(forklift.feasibility.suitability).toBe(1);
    expect(forklift.feasibility.unchecked.map((c) => c.id)).toEqual(["c_pickup"]);
    const ranked = ev.actions.filter((a) => a.rank !== null).sort((a, b) => a.rank! - b.rank!);
    expect(ranked.map((a) => a.rank)).toEqual(ranked.map((_, i) => i + 1));
    expect(ranked.every((a) => a.feasibility.feasible)).toBe(true);
  });
  it("flags a relationship to a missing variable as an error and drops it", () => {
    const m = createSampleHousehold();
    m.relationships.push({ ...m.relationships[0], id: "bad", targetVariableId: "does_not_exist" });
    const e = evaluateSystem(m);
    expect(e.issues.some((i) => i.level === "error" && i.message.includes("bad"))).toBe(true);
    expect(e.relationships.find((r) => r.id === "bad")).toBeUndefined();
  });
  it("warns when a derived input is missing", () => {
    const m = createSampleHousehold();
    m.variables = m.variables.map((v) => (v.id === INPUT_IDS.liquidReserves ? { ...v, values: [] } : v));
    const e = evaluateSystem(m);
    expect(e.variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBeNull();
    expect(e.issues.some((i) => i.message.includes("Buffer months"))).toBe(true);
  });
});
