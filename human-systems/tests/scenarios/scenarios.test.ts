import { describe, expect, it } from "vitest";
import { incomeSourcesOf } from "@/services/household-income";
import { currentValueOf } from "@/services/mutations";
import { registerBuiltInDomains } from "@/domains";
registerBuiltInDomains();
import { createSampleHousehold } from "@/data/sample-household";
import { DERIVED_IDS, INPUT_IDS } from "@/domains/household/keys";
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
    expect(currentValueOf(r.model.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!)).toBe(12800);
    expect(currentValueOf(r.model.variables.find((v) => v.id === INPUT_IDS.protectedHours)!)).toBe(17);
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
  it("edits, adds and removes items of a declared collection (income sources), in memory only", () => {
    const base = createSampleHousehold();
    const first = incomeSourcesOf(base)[0];
    const r = applyScenario(base, scenario([
      { kind: "updateCollectionItem", collection: "incomeSources", itemId: "inc_rideshare", patch: { monthlyAmount: 1000 } },
      { kind: "removeCollectionItem", collection: "incomeSources", itemId: "inc_catering" },
      { kind: "addCollectionItem", collection: "incomeSources", item: { ...first, id: "inc_new", name: "New", monthlyAmount: 800, correlationGroup: "other" } },
      { kind: "removeCollectionItem", collection: "incomeSources", itemId: "missing" },
      { kind: "addCollectionItem", collection: "incomeSources", item: { ...first } },
      { kind: "updateCollectionItem", collection: "incomeSources", itemId: "inc_rideshare", patch: { monthlyAmount: -5 } },
      { kind: "addCollectionItem", collection: "customers", item: { id: "c1" } },
    ]));
    expect(r.collectionsChanged).toEqual(["incomeSources"]);
    const after = incomeSourcesOf(r.model);
    expect(after.map((s) => s.id).sort()).toEqual(["inc_new", "inc_rideshare", "inc_warehouse"]);
    expect(after.find((s) => s.id === "inc_rideshare")!.monthlyAmount).toBe(1000);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      expect.stringMatching(/Unknown item "missing"/),
      expect.stringMatching(/already exists/),
      expect.stringMatching(/does not match the incomeSources schema/),
      expect.stringMatching(/not declared by this domain/),
    ]);
    expect(incomeSourcesOf(base)).toHaveLength(3); // the stored model is untouched
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
    expect(c.gapsShrinking).toBeGreaterThanOrEqual(1);
    expect(c.gapsGrowing).toBe(0);
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
    const c = compareScenario(createSampleHousehold(), scenario([{ kind: "updateCollectionItem", collection: "incomeSources", itemId: "inc_rideshare", patch: { monthlyAmount: 2600 } }]));
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
    expect(c.gapsShrinking).toBe(0);
    expect(c.gapsGrowing).toBe(0);
    expect(c.openGapsAfter).toBe(c.openGapsBefore);
  });
  it("projections use the requested horizon and both step models", () => {
    const c = compareScenario(createSampleHousehold(), scenario([], 6));
    expect(c.projections.map((p) => p.label)).toEqual(["Career capital (index) — Dani", "Productive assets"]);
    expect(c.projections.every((p) => p.base.length === 7 && p.scenario.length === 7)).toBe(true);
  });
});
