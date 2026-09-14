/**
 * Regression suite for the most important rule in the model: UNKNOWN IS
 * NOT ZERO. A calculation that needs an unknown input must say so, never
 * substitute 0 and produce a number that looks measured.
 */
import { describe, expect, it } from "vitest";
import { createBlankModel } from "@/model/blank";
import { createSampleHousehold } from "@/data/sample-household";
import { evaluateSystem } from "@/model/evaluate";
import { DERIVED_IDS, INPUT_IDS } from "@/model/ids";
import * as M from "@/services/mutations";
import { applyScenario, compareScenario } from "@/scenarios";
import { computeSignature } from "@/signatures";
import type { Scenario } from "@/types";

const NOW = "2026-09-14T12:00:00.000Z";
const scenario = (changes: Scenario["changes"]): Scenario => ({ id: "s", name: "s", description: "", changes, horizonMonths: 12 });
const val = (m: ReturnType<typeof createSampleHousehold>, id: string) => evaluateSystem(m).variableById.get(id)!.currentValue;

describe("derived metrics", () => {
  it("monthly surplus is unknown when any expense class is unknown", () => {
    const base = createSampleHousehold();
    expect(val(base, DERIVED_IDS.monthlySurplus)).toBe(4300 - 3600 - 400 - 320);
    for (const id of [INPUT_IDS.essentialExpenses, INPUT_IDS.discretionaryExpenses, INPUT_IDS.monthlyDebtPayments]) {
      const m = M.updateVariable(base, id, { currentValue: null });
      expect(val(m, DERIVED_IDS.monthlySurplus), id).toBeNull();
      const ev = evaluateSystem(m);
      expect(ev.variableById.get(DERIVED_IDS.monthlySurplus)!.confidence).toBe(0);
      expect(ev.issues.some((i) => i.message.includes("Monthly surplus") && i.message.includes(id))).toBe(true);
    }
  });
  it("debt burden, floor ratio and buffer months are unknown without their inputs", () => {
    const base = createSampleHousehold();
    expect(val(M.updateVariable(base, INPUT_IDS.monthlyDebtPayments, { currentValue: null }), DERIVED_IDS.debtBurden)).toBeNull();
    expect(val(M.updateVariable(base, INPUT_IDS.essentialExpenses, { currentValue: null }), DERIVED_IDS.floorRatio)).toBeNull();
    expect(val(M.updateVariable(base, INPUT_IDS.liquidReserves, { currentValue: null }), DERIVED_IDS.bufferMonths)).toBeNull();
  });
  it("income aggregates are unknown with no sources, not zero", () => {
    const blank = createBlankModel({ id: "b", name: "b", systemType: "household", now: NOW });
    const ev = evaluateSystem(blank);
    for (const id of Object.values(DERIVED_IDS)) expect(ev.variableById.get(id)!.currentValue, id).toBeNull();
  });
  it("a recorded zero is a known value, distinct from unknown", () => {
    const m = M.updateVariable(createSampleHousehold(), INPUT_IDS.monthlyDebtPayments, { currentValue: 0 });
    expect(val(m, DERIVED_IDS.debtBurden)).toBe(0);
    expect(val(m, DERIVED_IDS.monthlySurplus)).toBe(4300 - 3600 - 400);
  });
});

describe("scenarios", () => {
  it("adjusting a variable with no value is refused instead of treated as 0 + delta", () => {
    const m = M.updateVariable(createSampleHousehold(), INPUT_IDS.liquidReserves, { currentValue: null });
    const r = applyScenario(m, scenario([{ kind: "adjustVariable", variableId: INPUT_IDS.liquidReserves, delta: 5000 }]));
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/no current value/);
    expect(r.model.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!.currentValue).toBeNull();
    expect(r.changedVariables.size).toBe(0);
    // Setting a value is the honest path.
    const set = applyScenario(m, scenario([{ kind: "setVariable", variableId: INPUT_IDS.liquidReserves, value: 5000 }]));
    expect(set.rejected).toEqual([]);
    expect(set.model.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!.currentValue).toBe(5000);
  });
  it("projections are skipped, with the missing inputs named, instead of zero-filled", () => {
    const full = compareScenario(createSampleHousehold(), scenario([]));
    expect(full.projections.map((p) => p.label)).toEqual(["Career capital (index)", "Productive assets"]);
    expect(full.projectionsSkipped).toEqual([]);
    const noPersistence = M.updateVariable(createSampleHousehold(), INPUT_IDS.persistence, { currentValue: null });
    const c1 = compareScenario(noPersistence, scenario([]));
    expect(c1.projections.map((p) => p.label)).toEqual(["Productive assets"]);
    expect(c1.projectionsSkipped).toEqual([{ label: "Career capital (index)", missingInputs: ["Persistence"] }]);
    const noDebt = M.updateVariable(createSampleHousehold(), INPUT_IDS.monthlyDebtPayments, { currentValue: null });
    const c2 = compareScenario(noDebt, scenario([]));
    expect(c2.projections.map((p) => p.label)).toEqual(["Career capital (index)"]);
    expect(c2.projectionsSkipped[0].missingInputs).toEqual(["Monthly debt payments"]);
    const blank = createBlankModel({ id: "b", name: "b", systemType: "household", now: NOW });
    const c3 = compareScenario(blank, scenario([]));
    expect(c3.projections).toEqual([]);
    expect(c3.projectionsSkipped).toHaveLength(2);
  });
});

describe("signatures", () => {
  it("an unknown input is excluded from a dimension, never counted as 0", () => {
    const base = createSampleHousehold();
    const known = computeSignature(evaluateSystem(base), { id: "a", now: NOW, mode: "current" });
    const m = M.updateVariable(base, INPUT_IDS.qualityOfEffort, { currentValue: null });
    const partial = computeSignature(evaluateSystem(m), { id: "b", now: NOW, mode: "current" });
    const a = known.dimensions.find((d) => d.dimensionId === "focus_commitment")!;
    const b = partial.dimensions.find((d) => d.dimensionId === "focus_commitment")!;
    // Inputs: major_paths 3 -> 0.25 (inv), switching 2 -> 0.5 (inv), persistence 0.6, protected 2/15, quality 0.5 (w 0.5).
    const knownFour = (0.25 + 0.5 + 0.6 + 2 / 15) / 4;
    const zeroFilled = (0.25 + 0.5 + 0.6 + 2 / 15 + 0.5 * 0) / 4.5;
    expect(a.normalizedValue).toBeCloseTo((0.25 + 0.5 + 0.6 + 2 / 15 + 0.5 * 0.5) / 4.5, 9);
    expect(b.normalizedValue).toBeCloseTo(knownFour, 9); // mean over the KNOWN inputs only
    expect(b.normalizedValue!).toBeGreaterThan(zeroFilled); // not what zero-filling would give
    expect(b.knownWeightFraction).toBeCloseTo(4 / 4.5, 9);
    expect(b.missingInformation).toEqual([INPUT_IDS.qualityOfEffort]);
  });
});
