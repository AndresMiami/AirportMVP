import { describe, expect, it } from "vitest";
import { createSampleHousehold } from "@/data/sample-household";
import { DERIVED_IDS, INPUT_IDS } from "@/model/ids";
import { applyScenario } from "@/scenarios/apply";
import { classifyLoopChange, compareScenario } from "@/scenarios/compare";
import type { Scenario } from "@/types";

const scenario = (changes: Scenario["changes"], horizonMonths = 24): Scenario => ({ id: "s", name: "s", description: "", changes, horizonMonths });

describe("applyScenario", () => {
  it("adjusts and sets inputs without mutating the base model", () => {
    const base = createSampleHousehold();
    const before = JSON.stringify(base);
    const r = applyScenario(base, scenario([
      { kind: "adjustVariable", variableId: INPUT_IDS.liquidReserves, delta: 10000 },
      { kind: "setVariable", variableId: INPUT_IDS.protectedHours, value: 17 },
    ]));
    expect(JSON.stringify(base)).toBe(before);
    expect(r.model.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!.currentValue).toBe(12800);
    expect(r.model.variables.find((v) => v.id === INPUT_IDS.protectedHours)!.currentValue).toBe(17);
    expect(r.changedVariables.get(INPUT_IDS.liquidReserves)).toBe(1);
    expect(r.rejected).toEqual([]);
  });
  it("records the sign of each change", () => {
    const r = applyScenario(createSampleHousehold(), scenario([{ kind: "adjustVariable", variableId: INPUT_IDS.majorPaths, delta: -2 }]));
    expect(r.changedVariables.get(INPUT_IDS.majorPaths)).toBe(-1);
  });
  it("rejects derived variables, unknown ids and non-finite values", () => {
    const r = applyScenario(createSampleHousehold(), scenario([
      { kind: "setVariable", variableId: DERIVED_IDS.incomeConcentration, value: 0.2 },
      { kind: "setVariable", variableId: "nope", value: 1 },
      { kind: "adjustVariable", variableId: INPUT_IDS.liquidReserves, delta: Number.POSITIVE_INFINITY },
    ]));
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected[0].reason).toMatch(/calculated/);
    expect(r.changedVariables.size).toBe(0);
  });
  it("edits, adds and removes income sources", () => {
    const base = createSampleHousehold();
    const r = applyScenario(base, scenario([
      { kind: "setIncomeSourceAmount", incomeSourceId: "inc_rideshare", monthlyAmount: 1000 },
      { kind: "removeIncomeSource", incomeSourceId: "inc_catering" },
      { kind: "addIncomeSource", source: { ...base.incomeSources[0], id: "inc_new", name: "New", monthlyAmount: 800, correlationGroup: "other" } },
      { kind: "removeIncomeSource", incomeSourceId: "missing" },
      { kind: "addIncomeSource", source: { ...base.incomeSources[0] } },
    ]));
    expect(r.incomeSourcesChanged).toBe(true);
    expect(r.model.incomeSources.map((s) => s.id).sort()).toEqual(["inc_new", "inc_rideshare", "inc_warehouse"]);
    expect(r.model.incomeSources.find((s) => s.id === "inc_rideshare")!.monthlyAmount).toBe(1000);
    expect(r.rejected).toHaveLength(2);
    expect(base.incomeSources).toHaveLength(3);
  });
});

describe("classifyLoopChange", () => {
  it("uses a 5% relative threshold", () => {
    expect(classifyLoopChange(0.10, 0.104)).toBe("unchanged");
    expect(classifyLoopChange(0.10, 0.08)).toBe("weakens");
    expect(classifyLoopChange(0.10, 0.12)).toBe("strengthens");
    expect(classifyLoopChange(null, 0.1)).toBe("not_assessable");
    expect(classifyLoopChange(0, 0)).toBe("unchanged");
  });
});

describe("compareScenario", () => {
  it("adding reserves raises buffer months, lowers the mean gap, and weakens belt-tightening", () => {
    const c = compareScenario(createSampleHousehold(), scenario([{ kind: "adjustVariable", variableId: INPUT_IDS.liquidReserves, delta: 10000 }]));
    const bm = c.variableDeltas.find((d) => d.variableId === DERIVED_IDS.bufferMonths)!;
    expect(bm.base).toBeCloseTo(2800 / 3600, 9);
    expect(bm.scenario).toBeCloseTo(12800 / 3600, 9);
    expect(c.meanGapAfter!).toBeLessThan(c.meanGapBefore!);
    const belt = c.loopDeltas.find((d) => d.loop.annotation?.name === "Belt-tightening")!;
    expect(belt.change).toBe("weakens");
    // Directional: reserves up -> financial pressure down (negative edge r07).
    const fp = c.directional.find((p) => p.variableId === "financial_pressure")!;
    expect(fp.tendency).toBe("down");
  });
  it("more protected hours weakens the survival-work trap and lifts the career-capital trajectory", () => {
    const c = compareScenario(createSampleHousehold(), scenario([{ kind: "adjustVariable", variableId: INPUT_IDS.protectedHours, delta: 15 }], 12));
    const trap = c.loopDeltas.find((d) => d.loop.annotation?.name === "Survival-work trap")!;
    expect(trap.change).toBe("weakens");
    const cc = c.projections.find((p) => p.label.startsWith("Career capital"))!;
    expect(cc.base).toHaveLength(13);
    expect(cc.scenario[12]).toBeGreaterThan(cc.base[12]);
    expect(cc.scenario[0]).toBe(cc.base[0]);
    const capital = c.directional.find((p) => p.variableId === INPUT_IDS.careerCapital)!;
    expect(capital.tendency).toBe("up");
  });
  it("changing an income source moves calculated values and seeds propagation from them", () => {
    const c = compareScenario(createSampleHousehold(), scenario([{ kind: "setIncomeSourceAmount", incomeSourceId: "inc_rideshare", monthlyAmount: 2600 }]));
    const hhi = c.variableDeltas.find((d) => d.variableId === DERIVED_IDS.incomeConcentration)!;
    expect(hhi.delta!).toBeLessThan(0); // two equal large sources -> less concentrated
    const floor = c.variableDeltas.find((d) => d.variableId === DERIVED_IDS.reliableFloor)!;
    expect(floor.delta).toBeCloseTo(1200 * 0.5, 9);
    expect(c.applied.changedVariables.size).toBe(0);
    expect(c.directional.find((p) => p.variableId === "financial_pressure")!.tendency).toBe("down");
  });
  it("an empty scenario changes nothing", () => {
    const c = compareScenario(createSampleHousehold(), scenario([]));
    expect(c.variableDeltas.every((d) => d.delta === null || d.delta === 0)).toBe(true);
    expect(c.loopDeltas.every((d) => d.change === "unchanged")).toBe(true);
    expect(c.directional).toEqual([]);
    expect(c.meanGapAfter).toBe(c.meanGapBefore);
  });
  it("projections use the requested horizon and both step models", () => {
    const c = compareScenario(createSampleHousehold(), scenario([], 6));
    expect(c.projections.map((p) => p.label)).toEqual(["Career capital (index)", "Productive assets"]);
    expect(c.projections.every((p) => p.base.length === 7 && p.scenario.length === 7)).toBe(true);
  });
});
