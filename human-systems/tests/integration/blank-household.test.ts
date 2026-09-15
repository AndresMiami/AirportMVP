/**
 * Real-household walk-through, no React: a blank system is built up through
 * the service + mutation layers, evaluated at every step, compared against a
 * scenario, saved through the localStorage repository (JSON round trip),
 * reloaded by a fresh service, and finally filtered by constraints.
 * Every expected number below is computed from the inputs, never copied
 * from a run.
 */
import { describe, expect, it } from "vitest";
import { addIncomeSource, incomeSourcesOf } from "@/services/household-income";
import { registerBuiltInDomains } from "@/domains";
registerBuiltInDomains();
import { horizonOfMonths, lagToMonths } from "@/calculations/lag";
import { loopIdFor } from "@/calculations/graph";
import { createSampleHousehold } from "@/data/sample-household";
import { evaluateSystem, type EvaluatedSystem } from "@/model/evaluate";
import { DERIVED_IDS, INPUT_IDS } from "@/domains/household/keys";
import { LocalStorageModelRepository, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { compareScenario } from "@/scenarios/compare";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { SystemModelSchema, type Action, type Lag, type Relationship, type Scenario, type SystemModel } from "@/types";

class FakeStorage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const NOW = "2026-09-14T12:00:00.000Z";
const SYSTEM_ID = "sys_it";

/* ------------------------------------------------------------------ */
/* Inputs (the single source of every expectation below)               */
/* ------------------------------------------------------------------ */

const SOURCES = [
  { id: "inc_salary", name: "Salary", earner: "p1", monthlyAmount: 3000, reliability: 0.9, volatility: 0.1, correlationGroup: "employer_a", replacementLatencyMonths: 2 },
  { id: "inc_gig", name: "Gig work", earner: "p2", monthlyAmount: 1200, reliability: 0.5, volatility: 0.5, correlationGroup: "gig", replacementLatencyMonths: 0.5 },
  { id: "inc_rental", name: "Rental unit", earner: "", monthlyAmount: 800, reliability: 0.8, volatility: 0.1, correlationGroup: "property", replacementLatencyMonths: 3 },
] as const;
const GIG_ID = SOURCES[1].id;

const ESSENTIAL = 3500;
const RESERVES = 7000;
const PRESSURE = 6;
const HORIZON = 2;
const HOURS = 3;
const ESSENTIAL_CONF = 0.9;
const RESERVES_CONF = 0.95;

const FP = "financial_pressure";
const PH = "planning_horizon";
const PROT = INPUT_IDS.protectedHours;
const RF = DERIVED_IDS.reliableFloor;

const LAG_FLOOR_PRESSURE: Lag = { value: 1, unit: "weeks" };
const LAG_PRESSURE_HORIZON: Lag = { value: 1, unit: "months" };
const LAG_HORIZON_HOURS: Lag = { value: 2, unit: "weeks" };
const LAG_HOURS_FLOOR: Lag = { value: 1, unit: "years" };

const DESIRED_PRESSURE = 3;
const DESIRED_HOURS = 10;
const DESIRED_FLOOR_RATIO = 1.1;

const SCENARIO_HOURS_DELTA = 7;
const SCENARIO_GIG_AMOUNT = 1800;

/* ------------------------------------------------------------------ */
/* Expectations derived from the inputs                                */
/* ------------------------------------------------------------------ */

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const total = (amounts: readonly number[]) => sum(amounts);
const floorOf = (rows: readonly { monthlyAmount: number; reliability: number }[]) => sum(rows.map((s) => s.monthlyAmount * s.reliability));
const sharesOf = (rows: readonly { monthlyAmount: number }[]) => {
  const t = total(rows.map((s) => s.monthlyAmount));
  return rows.map((s) => s.monthlyAmount / t);
};
const hhiOf = (rows: readonly { monthlyAmount: number }[]) => sum(sharesOf(rows).map((sh) => sh * sh));
const latencyOf = (rows: readonly { monthlyAmount: number; replacementLatencyMonths: number }[]) =>
  sum(sharesOf(rows).map((sh, i) => sh * rows[i].replacementLatencyMonths));
const failureCorrelationOf = (rows: readonly { monthlyAmount: number; correlationGroup: string }[]) => {
  const t = total(rows.map((s) => s.monthlyAmount));
  const byGroup = new Map<string, number>();
  for (const s of rows) byGroup.set(s.correlationGroup, (byGroup.get(s.correlationGroup) ?? 0) + s.monthlyAmount);
  return Math.max(...[...byGroup.values()].map((a) => a / t));
};

const EXPECTED_TOTAL = total(SOURCES.map((s) => s.monthlyAmount));
const EXPECTED_FLOOR = floorOf(SOURCES);
const EXPECTED_HHI = hhiOf(SOURCES);
const EXPECTED_FAILURE_CORRELATION = failureCorrelationOf(SOURCES);
const EXPECTED_LATENCY = latencyOf(SOURCES);
const EXPECTED_FLOOR_RATIO = EXPECTED_FLOOR / ESSENTIAL;
const EXPECTED_BUFFER_MONTHS = RESERVES / ESSENTIAL;

/* ------------------------------------------------------------------ */
/* Helpers for repeated shapes                                         */
/* ------------------------------------------------------------------ */

function addSource(m: SystemModel, s: (typeof SOURCES)[number]): SystemModel {
  return addIncomeSource(m, { ...s, sourceType: "self_reported", confidence: 0.7 });
}

function addInput(
  m: SystemModel,
  spec: { id: string; name: string; unit: string; value: number; confidence: number; sourceType?: "measured" | "self_reported"; range?: { min: number; max: number }; subjectId?: string | null },
): SystemModel {
  return M.addVariable(m, {
    id: spec.id,
    subjectId: spec.subjectId ?? "sys_it",
    name: spec.name,
    category: "structure",
    changeSpeed: "slow",
    unit: spec.unit,
    sourceType: spec.sourceType ?? "self_reported",
    confidence: spec.confidence,
    currentValue: spec.value,
    referenceRange: spec.range,
  });
}

function addEdge(m: SystemModel, id: string, from: string, to: string, direction: Relationship["direction"], lag: Lag): SystemModel {
  return M.addRelationship(m, {
      kind: "causal_hypothesis",
      participatesInDynamics: true,
    id,
    sourceVariableId: from,
    targetVariableId: to,
    direction,
    strength: 0.6,
    lag,
    confidence: 0.5,
    sourceType: "self_reported",
  });
}

function derivedValue(ev: EvaluatedSystem, id: string): number | null {
  return ev.variableById.get(id)?.currentValue ?? null;
}

function derivedSnapshot(ev: EvaluatedSystem): [string, number | null][] {
  return ev.derived.map((c) => [c.definition.key, c.variable.currentValue]);
}

/** Expected for the whole walk: this household never enters discretionary expenses or debt payments,
 *  so surplus and debt burden stay partially computed. Anything else is a real issue. */
const MISSING_INPUT_RE = /cannot be computed fully/;
function otherIssues(ev: EvaluatedSystem) {
  return ev.issues.filter((i) => !MISSING_INPUT_RE.test(i.message));
}

describe("blank household end to end (service + repository, no React)", () => {
  it("builds, evaluates, compares, persists, reloads and filters a real household", async () => {
    const storage = new FakeStorage();
    const repo = new LocalStorageModelRepository(storage);
    const service = new ModelService(repo, { now: () => NOW, newId: () => SYSTEM_ID });

    // 1. Blank system: derived records only, nothing entered, activated.
    let m = await service.createBlank({ name: "Test household", systemType: "household" });
    expect(m.id).toBe(SYSTEM_ID);
    expect(incomeSourcesOf(m)).toHaveLength(0);
    expect(m.relationships).toHaveLength(0);
    expect(m.variables.length).toBeGreaterThan(0);
    expect(m.variables.every((v) => v.kind === "derived")).toBe(true);
    expect(await repo.getActiveId()).toBe(SYSTEM_ID);
    expect(derivedValue(evaluateSystem(m), DERIVED_IDS.totalIncome)).toBeNull();

    // 2. Members.
    m = M.addMember(m, { id: "p1", label: "Adult 1", role: "adult" });
    m = M.addMember(m, { id: "p2", label: "Adult 2", role: "adult" });
    m = M.addMember(m, { id: "p3", label: "Child", role: "child" });
    expect(m.profile.members.map((x) => x.id)).toEqual(["p1", "p2", "p3"]);

    // 3. Income sources -> income-side derived values.
    for (const s of SOURCES) m = addSource(m, s);
    expect(incomeSourcesOf(m)).toHaveLength(SOURCES.length);
    let ev = evaluateSystem(m);
    expect(derivedValue(ev, DERIVED_IDS.totalIncome)).toBe(EXPECTED_TOTAL);
    expect(EXPECTED_TOTAL).toBe(5000);
    expect(derivedValue(ev, DERIVED_IDS.reliableFloor)).toBeCloseTo(EXPECTED_FLOOR, 9);
    expect(EXPECTED_FLOOR).toBeCloseTo(3000 * 0.9 + 1200 * 0.5 + 800 * 0.8, 9);
    expect(derivedValue(ev, DERIVED_IDS.incomeConcentration)).toBeCloseTo(EXPECTED_HHI, 9);
    expect(derivedValue(ev, DERIVED_IDS.failureCorrelation)).toBeCloseTo(EXPECTED_FAILURE_CORRELATION, 9);
    expect(EXPECTED_FAILURE_CORRELATION).toBeCloseTo(0.6, 9);
    expect(derivedValue(ev, DERIVED_IDS.replacementLatency)).toBeCloseTo(EXPECTED_LATENCY, 9);
    // Expense-dependent values are still missing.
    expect(derivedValue(ev, DERIVED_IDS.floorRatio)).toBeNull();
    expect(ev.issues.some((i) => i.message.includes(INPUT_IDS.essentialExpenses))).toBe(true);

    // 4. Observations, one per member; an unknown subject is refused.
    m = M.addObservation(m, { id: "o1", statement: "Rent and groceries run about $3,500 a month.", subjectId: "p1", sourceType: "self_reported", confidence: 0.7 });
    m = M.addObservation(m, { id: "o2", statement: "Savings balance was $7,000 on 1 September.", subjectId: "p2", sourceType: "measured", confidence: 0.95, evidenceSource: "bank statement" });
    m = M.addObservation(m, { id: "o3", statement: "Money worries come up at every dinner lately.", subjectId: "p3", sourceType: "observed", confidence: 0.6 });
    expect(m.observations.map((o) => o.subjectId)).toEqual(["p1", "p2", "p3"]);
    expect(() => M.addObservation(m, { statement: "x", subjectId: "nobody", sourceType: "observed", confidence: 0.5 })).toThrow(M.MutationError);
    expect(() => M.addObservation(m, { statement: "x", subjectId: "nobody", sourceType: "observed", confidence: 0.5 })).toThrow(/Unknown subject/);

    // 5. Input variables -> expense-side derived values, A13 confidence, links.
    m = addInput(m, { id: INPUT_IDS.essentialExpenses, name: "Essential expenses", unit: "$/month", value: ESSENTIAL, confidence: ESSENTIAL_CONF, sourceType: "measured" });
    m = addInput(m, { id: INPUT_IDS.liquidReserves, name: "Liquid reserves", unit: "$", value: RESERVES, confidence: RESERVES_CONF, sourceType: "measured" });
    m = addInput(m, { id: FP, name: "Financial pressure", unit: "self-rating 0-10", value: PRESSURE, confidence: 0.6, range: { min: 0, max: 10 } });
    m = addInput(m, { id: PH, name: "Planning horizon", unit: "months", value: HORIZON, confidence: 0.5, range: { min: 0, max: 12 } });
    m = addInput(m, { id: PROT, name: "Protected hours", unit: "hours/week", value: HOURS, confidence: 0.5, range: { min: 0, max: 20 } });
    // A derived id can never become an input: the blank model already holds its record, so the
    // "already exists" guard fires first (the "reserved" guard covers a model missing that record).
    expect(() => M.addVariable(m, { id: DERIVED_IDS.floorRatio, subjectId: "sys_it", name: "x", category: "structure", changeSpeed: "slow", unit: "", sourceType: "estimated", confidence: 0.5 })).toThrow(/calculated variable|already exists/);
    ev = evaluateSystem(m);
    expect(derivedValue(ev, DERIVED_IDS.floorRatio)).toBeCloseTo(EXPECTED_FLOOR_RATIO, 9);
    expect(derivedValue(ev, DERIVED_IDS.bufferMonths)).toBeCloseTo(EXPECTED_BUFFER_MONTHS, 9);
    expect(EXPECTED_BUFFER_MONTHS).toBe(2);
    expect(ev.variableById.get(DERIVED_IDS.bufferMonths)!.confidence).toBe(Math.min(RESERVES_CONF, ESSENTIAL_CONF));
    expect(ev.issues.map((i) => i.level)).toEqual(["warning", "warning"]);
    expect(ev.issues.map((i) => i.message)).toEqual([
      `Monthly surplus / deficit cannot be computed fully: missing ${INPUT_IDS.discretionaryExpenses}, ${INPUT_IDS.monthlyDebtPayments}.`,
      `Debt burden cannot be computed fully: missing ${INPUT_IDS.monthlyDebtPayments}.`,
    ]);
    expect(derivedValue(ev, DERIVED_IDS.monthlySurplus)).toBeNull(); // UNKNOWN IS NOT ZERO: missing expense classes make the surplus unknown
    expect(derivedValue(ev, DERIVED_IDS.debtBurden)).toBeNull();

    m = M.linkObservation(m, "o1", { kind: "variable", id: INPUT_IDS.essentialExpenses });
    m = M.linkObservation(m, "o2", { kind: "variable", id: INPUT_IDS.liquidReserves });
    m = M.linkObservation(m, "o3", { kind: "variable", id: FP });
    m = M.linkObservation(m, "o3", { kind: "variable", id: FP }); // idempotent
    ev = evaluateSystem(m);
    expect(ev.observations.byVariable.get(INPUT_IDS.essentialExpenses)!.map((o) => o.id)).toEqual(["o1"]);
    expect(ev.observations.byVariable.get(INPUT_IDS.liquidReserves)!.map((o) => o.id)).toEqual(["o2"]);
    expect(ev.observations.byVariable.get(FP)!.map((o) => o.id)).toEqual(["o3"]);
    expect(ev.observations.byVariable.has(PH)).toBe(false);

    // 6. One loop through a derived variable; hypothesis lifecycle; disable/enable.
    m = addEdge(m, "e_floor_pressure", RF, FP, "negative", LAG_FLOOR_PRESSURE);
    m = addEdge(m, "e_pressure_horizon", FP, PH, "negative", LAG_PRESSURE_HORIZON);
    m = addEdge(m, "e_horizon_hours", PH, PROT, "positive", LAG_HORIZON_HOURS);
    m = addEdge(m, "e_hours_floor", PROT, RF, "positive", LAG_HOURS_FLOOR);
    expect(() => addEdge(m, "dup", RF, FP, "positive", LAG_FLOOR_PRESSURE)).toThrow(/already exists/);
    ev = evaluateSystem(m);
    expect(ev.loops).toHaveLength(1);
    const loop = ev.loops[0];
    const expectedLoopId = loopIdFor([RF, FP, PH, PROT]);
    expect(loop.id).toBe(expectedLoopId);
    expect(loop.variableIds).toEqual([FP, PH, PROT, RF]); // canonical rotation: lexically smallest first
    expect(loop.edgeIds).toEqual(["e_pressure_horizon", "e_horizon_hours", "e_hours_floor", "e_floor_pressure"]);
    expect(loop.polarity).toBe("reinforcing");
    expect(loop.negativeEdgeCount).toBe(2);
    const lags = [LAG_FLOOR_PRESSURE, LAG_PRESSURE_HORIZON, LAG_HORIZON_HOURS, LAG_HOURS_FLOOR];
    const expectedCycleMonths = sum(lags.map(lagToMonths));
    expect(loop.cycleTimeMonths).toBeCloseTo(expectedCycleMonths, 9);
    expect(expectedCycleMonths).toBeCloseTo(7 / 30.4375 + 1 + 14 / 30.4375 + 12, 9);
    expect(loop.slowestHorizon).toBe(horizonOfMonths(Math.max(...lags.map(lagToMonths))));
    expect(loop.slowestHorizon).toBe("years");
    expect(loop.status).toBe("proposed");
    expect(loop.hypothesis).toBeUndefined();
    expect(loop.pressure).toBeNull(); // no desired values yet
    expect(loop.observationIds).toEqual([]);

    m = M.ensureLoopHypothesis(m, { loopId: loop.id, statement: "Low floor -> pressure -> short horizon -> no protected time -> floor stays low.", relationshipIds: loop.edgeIds });
    const hypothesis = m.hypotheses.find((h) => h.kind === "loop" && h.loopId === loop.id)!;
    expect(hypothesis).toBeDefined();
    expect(m.hypotheses).toHaveLength(1);
    expect(M.ensureLoopHypothesis(m, { loopId: loop.id, statement: "again" })).toBe(m); // one per loop
    m = M.attachObservationToHypothesis(m, hypothesis.id, "o3", "supporting");
    expect(() => M.attachObservationToHypothesis(m, hypothesis.id, "nope", "supporting")).toThrow(M.MutationError);
    m = M.setHypothesisStatus(m, hypothesis.id, "accepted");
    ev = evaluateSystem(m);
    expect(ev.loops).toHaveLength(1);
    expect(ev.loops[0].status).toBe("accepted");
    expect(ev.loops[0].hypothesis?.id).toBe(hypothesis.id);
    expect(ev.loops[0].observationIds).toContain("o3");

    m = M.setRelationshipEnabled(m, "e_hours_floor", false);
    ev = evaluateSystem(m);
    expect(ev.loops).toHaveLength(0);
    expect(ev.relationships).toHaveLength(3);
    expect(ev.allRelationships).toHaveLength(4);
    expect(ev.disabledRelationshipCount).toBe(1);
    expect(ev.issues.some((i) => i.level === "warning" && i.message.includes("no longer form"))).toBe(true);
    m = M.setRelationshipEnabled(m, "e_hours_floor", true);
    ev = evaluateSystem(m);
    expect(ev.loops).toHaveLength(1);
    expect(ev.loops[0].id).toBe(expectedLoopId);
    expect(otherIssues(ev)).toEqual([]);

    // 7. Desired states -> structural gap.
    m = M.updateVariable(m, FP, { desiredValue: DESIRED_PRESSURE, targetMode: "at_most" });
    m = M.updateVariable(m, PROT, { desiredValue: DESIRED_HOURS, targetMode: "at_least" });
    // A derived variable never takes an entered value: the edit is refused outright, then applied without it.
    expect(() => service.updateVariable(m, { id: DERIVED_IDS.floorRatio, desiredValue: DESIRED_FLOOR_RATIO, targetMode: "at_least", currentValue: 99 })).toThrow(/never takes an entered value/);
    m = service.updateVariable(m, { id: DERIVED_IDS.floorRatio, desiredValue: DESIRED_FLOOR_RATIO, targetMode: "at_least" });
    expect(m.variables.find((v) => v.id === DERIVED_IDS.floorRatio)!.values).toEqual([]); // derived shells hold no value entries
    ev = evaluateSystem(m);
    const expectedDirection = (mode: "at_least" | "at_most", current: number, desired: number): "up" | "down" | "none" => {
      const raw = desired - current;
      if (mode === "at_least") return raw > 0 ? "up" : "none";
      return raw < 0 ? "down" : "none";
    };
    const expectedGaps: Record<string, { direction: "up" | "down" | "none"; normalized: number }> = {
      [FP]: { direction: expectedDirection("at_most", PRESSURE, DESIRED_PRESSURE), normalized: Math.abs(DESIRED_PRESSURE - PRESSURE) / 10 },
      [PROT]: { direction: expectedDirection("at_least", HOURS, DESIRED_HOURS), normalized: Math.abs(DESIRED_HOURS - HOURS) / 20 },
      // reliable floor / essentials already exceeds 1.1, so the floor target is met: direction "none", gap 0.
      [DERIVED_IDS.floorRatio]: {
        direction: expectedDirection("at_least", EXPECTED_FLOOR_RATIO, DESIRED_FLOOR_RATIO),
        normalized: EXPECTED_FLOOR_RATIO >= DESIRED_FLOOR_RATIO ? 0 : (DESIRED_FLOOR_RATIO - EXPECTED_FLOOR_RATIO) / 2,
      },
    };
    expect(expectedGaps[FP].direction).toBe("down");
    expect(expectedGaps[PROT].direction).toBe("up");
    expect(expectedGaps[DERIVED_IDS.floorRatio].direction).toBe("none");
    expect(ev.gap.gaps).toHaveLength(3);
    for (const g of ev.gap.gaps) {
      expect(g.direction, g.variableId).toBe(expectedGaps[g.variableId].direction);
      expect(g.normalizedGap, g.variableId).toBeCloseTo(expectedGaps[g.variableId].normalized, 9);
    }
    const expectedOpen = Object.values(expectedGaps).filter((g) => g.direction !== "none").length;
    expect(ev.gap.openCount).toBe(expectedOpen);
    expect(ev.gap.closedCount).toBe(3 - expectedOpen);
    // No mean gap exists (it would be a universal score); the vector carries the per-variable values.
    expect("meanNormalizedGap" in ev.gap).toBe(false);
    for (const [id, g] of Object.entries(expectedGaps)) expect(ev.gap.gaps.find((x) => x.variableId === id)!.normalizedGap).toBeCloseTo(g.normalized, 9);
    // Loop pressure (A10): mean strength x mean gap over loop variables that have a gap (FP and PROT).
    const expectedBasePressure = ev.loops[0].meanStrength * ((expectedGaps[FP].normalized + expectedGaps[PROT].normalized) / 2);
    expect(ev.loops[0].pressure).toBeCloseTo(expectedBasePressure, 9);

    // 8. Scenario: more protected hours + a bigger gig -> loop weakens, pressure tends down.
    const scenario: Scenario = {
      id: "sc_1",
      name: "Protect an evening, grow the gig",
      description: "",
      changes: [
        { kind: "adjustVariable", variableId: PROT, delta: SCENARIO_HOURS_DELTA },
        { kind: "updateCollectionItem", collection: "incomeSources", itemId: GIG_ID, patch: { monthlyAmount: SCENARIO_GIG_AMOUNT } },
      ],
      horizonMonths: 12,
    };
    const cmp = compareScenario(m, scenario);
    expect(cmp.applied.rejected).toEqual([]);
    expect(cmp.loopDeltas).toHaveLength(1);
    const scenarioSources = SOURCES.map((s) => (s.id === GIG_ID ? { ...s, monthlyAmount: SCENARIO_GIG_AMOUNT } : s));
    const expectedScenarioHoursGap = Math.max(0, DESIRED_HOURS - (HOURS + SCENARIO_HOURS_DELTA)) / 20;
    const expectedScenarioPressure = ev.loops[0].meanStrength * ((expectedGaps[FP].normalized + expectedScenarioHoursGap) / 2);
    expect(cmp.loopDeltas[0].basePressure).toBeCloseTo(expectedBasePressure, 9);
    expect(cmp.loopDeltas[0].scenarioPressure).toBeCloseTo(expectedScenarioPressure, 9);
    expect(expectedScenarioPressure).toBeLessThan(expectedBasePressure);
    expect(cmp.loopDeltas[0].change).toBe("weakens");
    const totalDelta = cmp.variableDeltas.find((d) => d.variableId === DERIVED_IDS.totalIncome)!;
    expect(totalDelta.delta).toBe(SCENARIO_GIG_AMOUNT - SOURCES[1].monthlyAmount);
    expect(totalDelta.delta).toBe(600);
    const floorDelta = cmp.variableDeltas.find((d) => d.variableId === RF)!;
    expect(floorDelta.delta).toBeCloseTo(floorOf(scenarioSources) - EXPECTED_FLOOR, 9);
    expect(cmp.variableDeltas.find((d) => d.variableId === DERIVED_IDS.incomeConcentration)!.delta).toBeCloseTo(hhiOf(scenarioSources) - EXPECTED_HHI, 9);
    expect(cmp.variableDeltas.find((d) => d.variableId === PROT)!.scenario).toBe(HOURS + SCENARIO_HOURS_DELTA);
    expect(cmp.gapsShrinking).toBeGreaterThanOrEqual(1);
    expect(cmp.gapsGrowing).toBe(0);
    expect(cmp.openGapsBefore).toBe(ev.gap.openCount);
    expect(M.currentValueOf(m.variables.find((v) => v.id === PROT)!)).toBe(HOURS); // base untouched

    // Directional (A12): reliable_floor rises -> 1-week negative edge -> pressure down.
    const fp = cmp.directional.find((p) => p.variableId === FP)!;
    expect(fp.tendency).toBe("down");
    const oneWeekMonths = lagToMonths(LAG_FLOOR_PRESSURE);
    expect(fp.minLagMonths).toBeCloseTo(oneWeekMonths, 9);
    expect(fp.earliestHorizon).toBe(horizonOfMonths(oneWeekMonths));
    expect(fp.earliestHorizon).toBe("weeks"); // exactly one week is not "under a week"
    // The long path (protected_hours -> floor over a year -> pressure) is also counted.
    expect(fp.pathCount).toBe(2);
    expect(fp.maxLagMonths).toBeCloseTo(lagToMonths(LAG_HOURS_FLOOR) + oneWeekMonths, 9);
    const ph = cmp.directional.find((p) => p.variableId === PH)!;
    expect(ph.tendency).toBe("up"); // pressure down, negative edge -> horizon up
    const phEarliest = horizonOfMonths(oneWeekMonths + lagToMonths(LAG_PRESSURE_HORIZON));
    expect(phEarliest).toBe("months");
    expect(ph.earliestHorizon).toBe(phEarliest);
    expect(cmp.directional.map((p) => p.variableId).sort()).toEqual([FP, PH]); // seeds are never reported
    expect(cmp.directionalByHorizon.map((g) => g.horizon)).toEqual(["weeks", "months"]);
    expect(cmp.directionalByHorizon[0].tendencies.map((t) => t.variableId)).toEqual([FP]);
    expect(cmp.directionalByHorizon[1].tendencies.map((t) => t.variableId)).toEqual([PH]);
    expect(cmp.projections).toEqual([]); // no career-capital / productive-asset inputs entered

    // 9. Save through the service; a fresh service over the same storage reloads it byte-for-byte.
    const saved = await service.save(m);
    expect(saved.updatedAt).toBe(NOW);
    expect(storage.data.size).toBe(1);
    const service2 = new ModelService(new LocalStorageModelRepository(storage), { now: () => NOW });
    const reload = await service2.loadActiveOrSeed();
    expect(reload.seeded).toBe(false);
    expect(reload.model.id).toBe(SYSTEM_ID);
    expect(reload.model).toEqual(saved);
    expect((await service2.listModels()).map((s) => s.id)).toEqual([SYSTEM_ID]);
    const evSaved = evaluateSystem(saved);
    const evReloaded = evaluateSystem(reload.model);
    expect(evReloaded.loops.map((l) => [l.id, l.status])).toEqual(evSaved.loops.map((l) => [l.id, l.status]));
    expect(evReloaded.loops[0].id).toBe(expectedLoopId);
    expect(evReloaded.loops[0].status).toBe("accepted");
    expect(derivedSnapshot(evReloaded)).toEqual(derivedSnapshot(evSaved));
    expect(derivedValue(evReloaded, DERIVED_IDS.floorRatio)).toBeCloseTo(EXPECTED_FLOOR_RATIO, 9);
    expect(evReloaded.gap.openCount).toBe(expectedOpen);

    // 10. Constraints and one action that violates only the soft one.
    m = reload.model;
    m = M.addConstraint(m, { id: "c_hours", name: "At most 8 new hours per week", type: "hard", check: { dimension: "hoursPerWeek", comparator: "lte", limit: 8 }, sourceType: "self_reported", confidence: 0.7, userConfirmed: true });
    m = M.addConstraint(m, { id: "c_risk", name: "Prefers predictable income", type: "soft", check: { dimension: "riskLevel", comparator: "lte", limit: 0.4 }, softPenalty: 0.4, sourceType: "self_reported", confidence: 0.6 });
    const action: Action = {
      id: "a_evening_course",
      name: "Evening certification course",
      description: "",
      subjectId: "p1",
      extensions: {},
      targetVariables: [PROT, RF],
      requirements: { hoursPerWeek: 6, riskLevel: 0.7 },
      utility: { financialImprovement: 0.4, timeRequirement: -0.3 },
      impact: 0.6,
      controllability: 0.8,
      durability: 0.7,
      cost: 0.3,
      uncertainty: 0.4,
      sourceType: "self_reported",
      confidence: 0.6,
      notes: "",
    };
    m = SystemModelSchema.parse({ ...m, actions: [...m.actions, action] });
    ev = evaluateSystem(m);
    expect(ev.actions).toHaveLength(1);
    const evaluated = ev.actions[0];
    expect(evaluated.feasibility.feasible).toBe(true);
    expect(evaluated.feasibility.hardViolations).toEqual([]);
    expect(evaluated.feasibility.softViolations.map((v) => v.constraint.id)).toEqual(["c_risk"]);
    expect(evaluated.feasibility.suitability).toBeCloseTo(1 - 0.4, 9);
    expect(evaluated.feasibility.unconfirmedViolations.map((c) => c.id)).toEqual(["c_risk"]);
    expect(evaluated.rank).toBe(1);
    expect(evaluated.leverage.score).toBeCloseTo((0.6 * 0.8 * 0.7) / (0.3 * 0.4), 9);
    expect(otherIssues(ev)).toEqual([]);
    expect(ev.loops).toHaveLength(1);

    // The fictional fixture is untouched by any of the above.
    expect(evaluateSystem(createSampleHousehold()).loops).toHaveLength(4);
  });
});
