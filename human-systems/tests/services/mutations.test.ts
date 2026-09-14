import { describe, expect, it } from "vitest";
import { checkFeasibility } from "@/calculations/feasibility";
import { loopIdFor, loopPolarity } from "@/calculations/graph";
import { createSampleHousehold } from "@/data/sample-household";
import { createBlankModel } from "@/model/blank";
import { evaluateSystem } from "@/model/evaluate";
import { DERIVED_IDS, INPUT_IDS } from "@/model/ids";
import {
  addConstraint,
  addHypothesis,
  addIncomeSource,
  addMember,
  addObservation,
  addRelationship,
  addSignatureSnapshot,
  addVariable,
  attachObservationToHypothesis,
  detachObservationFromHypothesis,
  ensureLoopHypothesis,
  linkObservation,
  MutationError,
  nextSignatureId,
  removeConstraint,
  removeHypothesis,
  archiveMember,
  memberReferences,
  removeMember,
  removeObservation,
  restoreMember,
  removeRelationship,
  removeSignatureSnapshot,
  removeVariable,
  setHypothesisStatus,
  setRelationshipEnabled,
  unlinkObservation,
  updateHypothesis,
  updateRelationship,
  updateSignatureMeta,
  updateVariable,
} from "@/services/mutations";
import { computeSignature } from "@/signatures";
import { ActionSchema, type SystemModel } from "@/types";
import type { VariableInput } from "@/services/mutations";

const NOW = "2026-09-14T12:00:00.000Z";

function blank(): SystemModel {
  return createBlankModel({ id: "sys_blank", name: "Blank", systemType: "household", now: NOW });
}

const inputVar = (name: string, extra: Partial<VariableInput> = {}): VariableInput => ({
  name,
  category: "event",
  changeSpeed: "fast",
  unit: "units",
  sourceType: "self_reported",
  confidence: 0.6,
  ...extra,
});

/** Blank model with two input variables a and b. */
function blankWithAB(): SystemModel {
  let m = blank();
  m = addVariable(m, inputVar("A", { id: "a" }));
  m = addVariable(m, inputVar("B", { id: "b" }));
  return m;
}

const loopNames = (m: SystemModel) => evaluateSystem(m).loops.map((l) => l.annotation?.name);
const byName = (m: SystemModel, name: string) => evaluateSystem(m).loops.find((l) => l.annotation?.name === name);

/* ------------------------------------------------------------------ */
/* Relationships                                                       */
/* ------------------------------------------------------------------ */

describe("relationship create / edit / delete", () => {
  const edge = { direction: "positive" as const, strength: 0.5, lag: { value: 2, unit: "weeks" as const }, confidence: 0.6, sourceType: "self_reported" as const };

  it("addRelationship assigns rel_1 on a blank model and applies defaults", () => {
    const m = addRelationship(blankWithAB(), { sourceVariableId: "a", targetVariableId: "b", ...edge });
    expect(m.relationships).toHaveLength(1);
    const r = m.relationships[0];
    expect(r.id).toBe("rel_1");
    expect(r.enabled).toBe(true);
    expect(r.evidence).toEqual([]);
    expect(r.explanation).toBe("");
    expect(r.notes).toBe("");
    expect(r.lag).toEqual({ value: 2, unit: "weeks" });
    const m2 = addRelationship(m, { sourceVariableId: "b", targetVariableId: "a", ...edge });
    expect(m2.relationships.map((x) => x.id)).toEqual(["rel_1", "rel_2"]);
  });

  it("rejects unknown endpoints, self-edges and duplicate source->target pairs", () => {
    const m = blankWithAB();
    expect(() => addRelationship(m, { sourceVariableId: "a", targetVariableId: "nope", ...edge })).toThrow(MutationError);
    expect(() => addRelationship(m, { sourceVariableId: "nope", targetVariableId: "b", ...edge })).toThrow(/Unknown variable "nope"/);
    expect(() => addRelationship(m, { sourceVariableId: "a", targetVariableId: "a", ...edge })).toThrow(/two different variables/);
    const withEdge = addRelationship(m, { sourceVariableId: "a", targetVariableId: "b", ...edge });
    expect(() => addRelationship(withEdge, { sourceVariableId: "a", targetVariableId: "b", ...edge, direction: "negative" })).toThrow(
      /already exists \(rel_1\)/,
    );
    // The reverse direction is a different pair and is allowed.
    expect(() => addRelationship(withEdge, { sourceVariableId: "b", targetVariableId: "a", ...edge })).not.toThrow();
    // A duplicate id is refused too.
    expect(() => addRelationship(withEdge, { id: "rel_1", sourceVariableId: "b", targetVariableId: "a", ...edge })).toThrow(/already exists/);
  });

  it("updateRelationship changes lag unit/value, strength and direction and revalidates endpoints", () => {
    const base = createSampleHousehold();
    const m = updateRelationship(base, "r01", { lag: { value: 3, unit: "days" }, strength: 0.25, direction: "positive" });
    const r = m.relationships.find((x) => x.id === "r01")!;
    expect(r.lag).toEqual({ value: 3, unit: "days" });
    expect(r.strength).toBe(0.25);
    expect(r.direction).toBe("positive");
    expect(r.sourceVariableId).toBe(DERIVED_IDS.reliableFloor);
    // Endpoints are revalidated on edit.
    expect(() => updateRelationship(base, "r01", { targetVariableId: "does_not_exist" })).toThrow(/Unknown variable/);
    expect(() => updateRelationship(base, "r01", { targetVariableId: DERIVED_IDS.reliableFloor })).toThrow(/two different variables/);
    // r07 is liquid_reserves -> financial_pressure; retargeting it onto buffer_months collides with r14.
    expect(() => updateRelationship(base, "r07", { targetVariableId: DERIVED_IDS.bufferMonths })).toThrow(/\(r14\)/);
    expect(() => updateRelationship(base, "nope", { strength: 0.1 })).toThrow(/Unknown relationship "nope"/);
    expect(() => updateRelationship(base, "r01", { strength: 1.5 })).toThrow();
  });

  it("setRelationshipEnabled(false) keeps the edge stored but evaluate excludes it", () => {
    const base = createSampleHousehold();
    const m = setRelationshipEnabled(base, "r06", false);
    expect(m.relationships).toHaveLength(base.relationships.length);
    expect(m.relationships.find((r) => r.id === "r06")!.enabled).toBe(false);
    const ev = evaluateSystem(m);
    expect(ev.relationships.find((r) => r.id === "r06")).toBeUndefined();
    expect(ev.relationships).toHaveLength(base.relationships.length - 1);
    expect(ev.allRelationships).toHaveLength(base.relationships.length);
    expect(ev.disabledRelationshipCount).toBe(1);
    const back = setRelationshipEnabled(m, "r06", true);
    expect(evaluateSystem(back).disabledRelationshipCount).toBe(0);
  });

  it("removeRelationship prunes observation links and hypothesis relationshipIds", () => {
    const base = createSampleHousehold();
    // obs_5 links r04; hyp_trap lists r04.
    expect(base.observations.find((o) => o.id === "obs_5")!.links.relationshipIds).toEqual(["r04"]);
    expect(base.hypotheses.find((h) => h.id === "hyp_trap")!.relationshipIds).toContain("r04");
    const m = removeRelationship(base, "r04");
    expect(m.relationships.find((r) => r.id === "r04")).toBeUndefined();
    expect(m.relationships).toHaveLength(base.relationships.length - 1);
    expect(m.observations.find((o) => o.id === "obs_5")!.links.relationshipIds).toEqual([]);
    expect(m.observations.find((o) => o.id === "obs_5")!.links.variableIds).toEqual(["survival_work_share"]);
    expect(m.hypotheses.find((h) => h.id === "hyp_trap")!.relationshipIds).toEqual(["r01", "r02", "r03", "r05", "r06"]);
    expect(() => removeRelationship(base, "nope")).toThrow(/Unknown relationship/);
  });

  it("never mutates the base model", () => {
    const base = createSampleHousehold();
    const before = JSON.stringify(base);
    let m = setRelationshipEnabled(base, "r06", false);
    m = removeRelationship(m, "r04");
    m = updateRelationship(m, "r01", { strength: 0.1 });
    m = addRelationship(m, {
      sourceVariableId: INPUT_IDS.protectedHours,
      targetVariableId: "financial_pressure",
      direction: "negative",
      strength: 0.3,
      lag: { value: 1, unit: "months" },
      confidence: 0.5,
      sourceType: "estimated",
    });
    m = removeVariable(m, "single_vehicle_dependency");
    m = removeObservation(m, "obs_3");
    m = removeHypothesis(m, "hyp_belt");
    m = removeConstraint(m, "c_hours");
    expect(m).not.toBe(base);
    expect(JSON.stringify(base)).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* Derived recalculation after relationship edits                      */
/* ------------------------------------------------------------------ */

describe("derived recalculation after relationship edits", () => {
  it("the sample has the four annotated loops", () => {
    const names = loopNames(createSampleHousehold());
    expect(names).toHaveLength(4);
    expect([...names].sort()).toEqual(["Belt-tightening", "Effort erosion", "Plan churn", "Survival-work trap"]);
  });

  it("disabling r06 (career_capital -> reliable_floor) leaves exactly Belt-tightening", () => {
    const base = createSampleHousehold();
    const r06 = base.relationships.find((r) => r.id === "r06")!;
    expect(r06.sourceVariableId).toBe(INPUT_IDS.careerCapital);
    expect(r06.targetVariableId).toBe(DERIVED_IDS.reliableFloor);
    const names = loopNames(setRelationshipEnabled(base, "r06", false));
    expect(names).toEqual(["Belt-tightening"]);
  });

  it("removing r04 drops Survival-work trap only", () => {
    const names = loopNames(removeRelationship(createSampleHousehold(), "r04"));
    expect(names).toHaveLength(3);
    expect(names).not.toContain("Survival-work trap");
    expect([...names].sort()).toEqual(["Belt-tightening", "Effort erosion", "Plan churn"]);
  });

  it("adding protected_hours -> financial_pressure (negative) closes one new loop with the computed polarity", () => {
    const base = createSampleHousehold();
    const m = addRelationship(base, {
      sourceVariableId: INPUT_IDS.protectedHours,
      targetVariableId: "financial_pressure",
      direction: "negative",
      strength: 0.5,
      lag: { value: 1, unit: "months" },
      confidence: 0.5,
      sourceType: "estimated",
    });
    const newEdgeId = m.relationships[m.relationships.length - 1].id;
    expect(newEdgeId).toBe("rel_1");
    const ev = evaluateSystem(m);
    expect(ev.loops).toHaveLength(5);
    // The only path financial_pressure -> protected_hours is r02, r03, r04.
    const cycleVars = ["financial_pressure", "planning_horizon", "survival_work_share", INPUT_IDS.protectedHours];
    const loop = ev.loops.find((l) => l.id === loopIdFor(cycleVars))!;
    expect(loop).toBeDefined();
    expect(loop.annotation).toBeUndefined();
    expect(loop.variableIds).toEqual(cycleVars);
    expect(loop.edgeIds).toEqual(["r02", "r03", "r04", newEdgeId]);
    const directions = loop.edgeIds.map((id) => m.relationships.find((r) => r.id === id)!.direction);
    const negatives = directions.filter((d) => d === "negative").length;
    expect(negatives).toBe(4);
    expect(loop.negativeEdgeCount).toBe(negatives);
    expect(loop.polarity).toBe(loopPolarity(directions));
    expect(loop.polarity).toBe("reinforcing");
    expect(loop.gain).toBeCloseTo(0.7 * 0.6 * 0.8 * 0.5, 12);
    expect(loop.status).toBe("proposed");
    // The four original loops are untouched.
    expect(ev.loops.filter((l) => l.annotation).map((l) => l.annotation!.name).sort()).toEqual([
      "Belt-tightening",
      "Effort erosion",
      "Plan churn",
      "Survival-work trap",
    ]);
  });

  it("removing an input variable removes its relationships and evaluate reports no issues", () => {
    const base = createSampleHousehold();
    const touching = base.relationships.filter(
      (r) => r.sourceVariableId === "single_vehicle_dependency" || r.targetVariableId === "single_vehicle_dependency",
    );
    expect(touching.map((r) => r.id)).toEqual(["r11"]);
    const m = removeVariable(base, "single_vehicle_dependency");
    expect(m.variables.find((v) => v.id === "single_vehicle_dependency")).toBeUndefined();
    expect(m.relationships.map((r) => r.id)).not.toContain("r11");
    expect(m.relationships).toHaveLength(base.relationships.length - 1);
    const ev = evaluateSystem(m);
    expect(ev.issues).toHaveLength(0);
    expect(ev.relationships).toHaveLength(base.relationships.length - 1);
    expect(loopNames(m)).toHaveLength(4);
  });

  it("derived variable values are byte-identical before and after relationship edits", () => {
    const base = createSampleHousehold();
    const derivedIds = [DERIVED_IDS.floorRatio, DERIVED_IDS.bufferMonths, DERIVED_IDS.incomeConcentration];
    const snapshot = (m: SystemModel) => {
      const ev = evaluateSystem(m);
      return JSON.stringify(derivedIds.map((id) => ev.variableById.get(id)!.currentValue));
    };
    const before = snapshot(base);
    expect(JSON.parse(before)[0]).toBeCloseTo(2970 / 3600, 9);
    expect(JSON.parse(before)[1]).toBeCloseTo(2800 / 3600, 9);
    const edits: Array<(m: SystemModel) => SystemModel> = [
      (m) => setRelationshipEnabled(m, "r06", false),
      (m) => removeRelationship(m, "r04"),
      (m) => updateRelationship(m, "r01", { strength: 0.05, lag: { value: 3, unit: "years" } }),
      (m) =>
        addRelationship(m, {
          sourceVariableId: INPUT_IDS.protectedHours,
          targetVariableId: "financial_pressure",
          direction: "negative",
          strength: 0.9,
          lag: { value: 1, unit: "days" },
          confidence: 0.5,
          sourceType: "estimated",
        }),
    ];
    let m = base;
    for (const edit of edits) {
      m = edit(m);
      expect(snapshot(m)).toBe(before);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Constraints                                                         */
/* ------------------------------------------------------------------ */

describe("hard vs soft constraints", () => {
  const action = ActionSchema.parse({
    id: "act",
    name: "Risky move",
    requirements: { riskLevel: 0.6 },
    impact: 0.5,
    controllability: 0.5,
    durability: 0.5,
    cost: 0.5,
    uncertainty: 0.5,
    sourceType: "estimated",
    confidence: 0.5,
  });
  const check = { dimension: "riskLevel", comparator: "lte" as const, limit: 0.3 };

  it("a violated soft constraint lowers suitability without excluding", () => {
    const m = addConstraint(blank(), { name: "Prefers low risk", type: "soft", check, softPenalty: 0.3, sourceType: "self_reported", confidence: 0.7 });
    expect(m.constraints).toHaveLength(1);
    expect(m.constraints[0].id).toBe("con_1");
    expect(m.constraints[0].userConfirmed).toBe(false);
    const f = checkFeasibility(action, m.constraints);
    expect(f.feasible).toBe(true);
    expect(f.hardViolations).toEqual([]);
    expect(f.softViolations.map((v) => v.constraint.id)).toEqual(["con_1"]);
    expect(f.softViolations[0].required).toBe(0.6);
    expect(f.suitability).toBeCloseTo(0.7, 12);
  });

  it("the same check as a hard constraint makes the action infeasible", () => {
    const m = addConstraint(blank(), { name: "No high risk", type: "hard", check, sourceType: "self_reported", confidence: 0.7 });
    const f = checkFeasibility(action, m.constraints);
    expect(f.feasible).toBe(false);
    expect(f.hardViolations.map((v) => v.constraint.id)).toEqual(["con_1"]);
    expect(f.softViolations).toEqual([]);
    expect(f.suitability).toBe(1);
  });

  it("a constraint without a check is unchecked; an unconfirmed violation is reported", () => {
    let m = addConstraint(blank(), { name: "Descriptive", type: "hard", sourceType: "self_reported", confidence: 0.5 });
    m = addConstraint(m, { name: "Unconfirmed", type: "soft", check, softPenalty: 0.2, sourceType: "ai_inferred", confidence: 0.4 });
    m = addConstraint(m, { name: "Confirmed", type: "soft", check, softPenalty: 0.5, userConfirmed: true, sourceType: "self_reported", confidence: 0.9 });
    expect(m.constraints.map((c) => c.id)).toEqual(["con_1", "con_2", "con_3"]);
    const f = checkFeasibility(action, m.constraints);
    expect(f.unchecked.map((c) => c.id)).toEqual(["con_1"]);
    expect(f.softViolations.map((v) => v.constraint.id)).toEqual(["con_2", "con_3"]);
    expect(f.unconfirmedViolations.map((c) => c.id)).toEqual(["con_2"]);
    expect(f.suitability).toBeCloseTo(0.8 * 0.5, 12);
    // A checkable constraint on a dimension the action does not declare is unverified.
    const other = addConstraint(blank(), { name: "Hours", type: "hard", check: { dimension: "hoursPerWeek", comparator: "lte", limit: 8 }, sourceType: "self_reported", confidence: 0.5 });
    expect(checkFeasibility(action, other.constraints).unverified.map((c) => c.id)).toEqual(["con_1"]);
  });

  it("removeConstraint prunes observation links.constraintIds", () => {
    const base = createSampleHousehold();
    expect(base.observations.find((o) => o.id === "obs_8")!.links.constraintIds).toEqual(["c_hours"]);
    const m = removeConstraint(base, "c_hours");
    expect(m.constraints.map((c) => c.id)).not.toContain("c_hours");
    expect(m.constraints).toHaveLength(base.constraints.length - 1);
    expect(m.observations.find((o) => o.id === "obs_8")!.links.constraintIds).toEqual([]);
    expect(m.observations.find((o) => o.id === "obs_8")!.links.variableIds).toEqual(["available_new_hours"]);
    expect(() => removeConstraint(base, "nope")).toThrow(/Unknown constraint/);
  });
});

/* ------------------------------------------------------------------ */
/* Observations                                                        */
/* ------------------------------------------------------------------ */

describe("evidence linking", () => {
  const obs = { statement: "Noticed something", sourceType: "observed" as const, confidence: 0.6 };

  it("addObservation accepts a member id, the system id or empty, and rejects an unknown subject", () => {
    const base = createSampleHousehold();
    const asMember = addObservation(base, { ...obs, subjectId: "dani" });
    expect(asMember.observations).toHaveLength(base.observations.length + 1);
    const added = asMember.observations[asMember.observations.length - 1];
    expect(added.id).toBe("obs_9");
    expect(added.subjectId).toBe("dani");
    expect(added.links).toEqual({ variableIds: [], relationshipIds: [], constraintIds: [], hypothesisIds: [] });
    expect(addObservation(base, { ...obs, subjectId: base.id }).observations.at(-1)!.subjectId).toBe(base.id);
    expect(addObservation(base, { ...obs }).observations.at(-1)!.subjectId).toBe("");
    expect(() => addObservation(base, { ...obs, subjectId: "stranger" })).toThrow(/Unknown subject "stranger"/);
    expect(() => addObservation(base, { ...obs, id: "obs_1" })).toThrow(/already exists/);
  });

  it("links and unlinks to a variable, relationship, constraint and hypothesis; missing entities throw", () => {
    const base = createSampleHousehold();
    let m = addObservation(base, { ...obs, id: "obs_x" });
    m = linkObservation(m, "obs_x", { kind: "variable", id: INPUT_IDS.liquidReserves });
    m = linkObservation(m, "obs_x", { kind: "relationship", id: "r07" });
    m = linkObservation(m, "obs_x", { kind: "constraint", id: "c_risk" });
    m = linkObservation(m, "obs_x", { kind: "hypothesis", id: "hyp_belt" });
    const o = m.observations.find((x) => x.id === "obs_x")!;
    expect(o.links).toEqual({
      variableIds: [INPUT_IDS.liquidReserves],
      relationshipIds: ["r07"],
      constraintIds: ["c_risk"],
      hypothesisIds: ["hyp_belt"],
    });
    // Linking twice is a no-op that returns the same model reference.
    expect(linkObservation(m, "obs_x", { kind: "relationship", id: "r07" })).toBe(m);

    const ev = evaluateSystem(m);
    expect(ev.observations.byVariable.get(INPUT_IDS.liquidReserves)!.map((x) => x.id)).toEqual(["obs_6", "obs_x"]);
    expect(ev.observations.byRelationship.get("r07")!.map((x) => x.id)).toEqual(["obs_x"]);
    expect(ev.observations.byConstraint.get("c_risk")!.map((x) => x.id)).toEqual(["obs_x"]);
    expect(ev.observations.byHypothesis.get("hyp_belt")!.map((x) => x.id)).toEqual(["obs_x"]);
    // The Belt-tightening loop now lists obs_x through its hypothesis and its r07 edge.
    expect(byName(m, "Belt-tightening")!.observationIds).toContain("obs_x");

    const un = unlinkObservation(m, "obs_x", { kind: "relationship", id: "r07" });
    expect(un.observations.find((x) => x.id === "obs_x")!.links.relationshipIds).toEqual([]);
    expect(evaluateSystem(un).observations.byRelationship.get("r07")).toBeUndefined();

    expect(() => linkObservation(m, "obs_x", { kind: "variable", id: "nope" })).toThrow(/Unknown variable "nope"/);
    expect(() => linkObservation(m, "obs_x", { kind: "relationship", id: "r99" })).toThrow(/Unknown relationship "r99"/);
    expect(() => linkObservation(m, "obs_x", { kind: "constraint", id: "c_none" })).toThrow(/Unknown constraint "c_none"/);
    expect(() => linkObservation(m, "obs_x", { kind: "hypothesis", id: "hyp_none" })).toThrow(/Unknown hypothesis "hyp_none"/);
    expect(() => linkObservation(m, "obs_missing", { kind: "variable", id: "a" })).toThrow(/Unknown observation "obs_missing"/);
  });

  it("removeObservation prunes hypotheses' supporting and contradicting lists", () => {
    const base = createSampleHousehold();
    let m = attachObservationToHypothesis(base, "hyp_erosion", "obs_3", "contradicting");
    expect(m.hypotheses.find((h) => h.id === "hyp_erosion")!.contradictingObservationIds).toEqual(["obs_3"]);
    expect(m.hypotheses.find((h) => h.id === "hyp_trap")!.supportingObservationIds).toEqual(["obs_3", "obs_5"]);
    m = removeObservation(m, "obs_3");
    expect(m.observations.find((o) => o.id === "obs_3")).toBeUndefined();
    expect(m.observations).toHaveLength(base.observations.length - 1);
    expect(m.hypotheses.find((h) => h.id === "hyp_trap")!.supportingObservationIds).toEqual(["obs_5"]);
    expect(m.hypotheses.find((h) => h.id === "hyp_erosion")!.contradictingObservationIds).toEqual([]);
    expect(evaluateSystem(m).observations.byVariable.get("financial_pressure")).toBeUndefined();
    expect(() => removeObservation(base, "nope")).toThrow(/Unknown observation/);
  });
});

/* ------------------------------------------------------------------ */
/* Hypotheses                                                          */
/* ------------------------------------------------------------------ */

describe("hypothesis acceptance / rejection", () => {
  it("addHypothesis defaults to proposed/general and setHypothesisStatus walks every status", () => {
    const base = createSampleHousehold();
    let m = addHypothesis(base, { statement: "Something general", confidence: 0.4 });
    const id = m.hypotheses[m.hypotheses.length - 1].id;
    expect(id).toBe("hyp_1");
    const h = m.hypotheses.find((x) => x.id === id)!;
    expect(h.status).toBe("proposed");
    expect(h.kind).toBe("general");
    expect(h.relationshipIds).toEqual([]);
    expect(h.supportingObservationIds).toEqual([]);
    for (const status of ["accepted", "rejected", "uncertain", "proposed"] as const) {
      m = setHypothesisStatus(m, id, status);
      expect(m.hypotheses.find((x) => x.id === id)!.status).toBe(status);
    }
    expect(() => setHypothesisStatus(m, "nope", "accepted")).toThrow(/Unknown hypothesis/);
    expect(() => addHypothesis(base, { statement: "Bad refs", confidence: 0.4, relationshipIds: ["r99"] })).toThrow(/Unknown relationship "r99"/);
    expect(() => addHypothesis(base, { statement: "Loop without id", confidence: 0.4, kind: "loop" })).toThrow(/needs a loopId/);
  });

  it("attachObservationToHypothesis moves an observation across sides; both sides at once is refused", () => {
    const base = createSampleHousehold();
    let m = attachObservationToHypothesis(base, "hyp_churn", "obs_4", "contradicting");
    let h = m.hypotheses.find((x) => x.id === "hyp_churn")!;
    expect(h.supportingObservationIds).toEqual([]);
    expect(h.contradictingObservationIds).toEqual(["obs_4"]);
    m = attachObservationToHypothesis(m, "hyp_churn", "obs_4", "supporting");
    h = m.hypotheses.find((x) => x.id === "hyp_churn")!;
    expect(h.supportingObservationIds).toEqual(["obs_4"]);
    expect(h.contradictingObservationIds).toEqual([]);
    m = detachObservationFromHypothesis(m, "hyp_churn", "obs_4");
    h = m.hypotheses.find((x) => x.id === "hyp_churn")!;
    expect(h.supportingObservationIds).toEqual([]);
    expect(h.contradictingObservationIds).toEqual([]);
    expect(() => attachObservationToHypothesis(base, "hyp_churn", "obs_nope", "supporting")).toThrow(/Unknown observation/);
    expect(() =>
      updateHypothesis(base, "hyp_churn", { supportingObservationIds: ["obs_4"], contradictingObservationIds: ["obs_4"] }),
    ).toThrow(/cannot both support and contradict/);
  });

  it("one loop hypothesis per loop id; ensureLoopHypothesis is idempotent", () => {
    const base = createSampleHousehold();
    const belt = base.hypotheses.find((h) => h.id === "hyp_belt")!;
    expect(() => addHypothesis(base, { statement: "Second reading", confidence: 0.3, kind: "loop", loopId: belt.loopId })).toThrow(
      /already has a hypothesis/,
    );
    expect(ensureLoopHypothesis(base, { loopId: belt.loopId!, statement: "ignored" })).toBe(base);
    expect(ensureLoopHypothesis(base, { loopId: belt.loopId!, statement: "ignored" }).hypotheses).toHaveLength(base.hypotheses.length);
    // A new loop id gets exactly one hypothesis, and a second ensure is a no-op.
    const m = ensureLoopHypothesis(base, { loopId: "x>y", statement: "New loop", relationshipIds: ["r01"], confidence: 0.2 });
    expect(m.hypotheses).toHaveLength(base.hypotheses.length + 1);
    const created = m.hypotheses.at(-1)!;
    expect(created).toMatchObject({ id: "hyp_1", kind: "loop", loopId: "x>y", status: "proposed", confidence: 0.2, relationshipIds: ["r01"] });
    expect(ensureLoopHypothesis(m, { loopId: "x>y", statement: "again" })).toBe(m);
  });

  it("evaluated loops carry the hypothesis status, or proposed when none is recorded", () => {
    const base = createSampleHousehold();
    const belt = byName(base, "Belt-tightening")!;
    expect(belt.status).toBe("accepted");
    expect(belt.hypothesis?.id).toBe("hyp_belt");
    expect(byName(base, "Effort erosion")!.status).toBe("uncertain");
    const m = removeHypothesis(base, "hyp_belt");
    expect(m.hypotheses.map((h) => h.id)).toEqual(["hyp_trap", "hyp_churn", "hyp_erosion"]);
    const after = byName(m, "Belt-tightening")!;
    expect(after.status).toBe("proposed");
    expect(after.hypothesis).toBeUndefined();
    // Rejecting is reflected too.
    expect(byName(setHypothesisStatus(base, "hyp_belt", "rejected"), "Belt-tightening")!.status).toBe("rejected");
  });

  it("a loop hypothesis whose loop no longer forms produces a warning", () => {
    const base = createSampleHousehold();
    expect(evaluateSystem(base).issues).toEqual([]);
    const ev = evaluateSystem(setRelationshipEnabled(base, "r06", false));
    const warnings = ev.issues.filter((i) => i.level === "warning" && i.message.includes("no longer form"));
    // r06 sits on Survival-work trap, Plan churn and Effort erosion.
    expect(warnings).toHaveLength(3);
    expect(ev.issues).toHaveLength(3);
    const trapLoopId = base.hypotheses.find((h) => h.id === "hyp_trap")!.loopId!;
    expect(warnings.some((w) => w.message.includes(trapLoopId))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Members, income, variables                                          */
/* ------------------------------------------------------------------ */

describe("members / income / variables", () => {
  it("a member named by observations can be archived, not deleted; the subject id survives", () => {
    let m = addMember(blank(), { label: "Sam", role: "Adult" });
    expect(m.profile.members).toEqual([{ id: "member_1", label: "Sam", role: "Adult", status: "active" }]);
    m = addObservation(m, { statement: "Sam works nights", sourceType: "self_reported", confidence: 0.8, subjectId: "member_1" });
    expect(() => addMember(m, { id: "member_1", label: "Dup" })).toThrow(/already exists/);
    // History is an asset: hard deletion is refused while an observation names the member.
    expect(() => removeMember(m, "member_1")).toThrow(/archive them instead/);
    expect(m.observations[0].subjectId).toBe("member_1");
    m = archiveMember(m, "member_1");
    expect(m.profile.members[0].status).toBe("archived");
    expect(m.observations[0].subjectId).toBe("member_1");
    expect(memberReferences(m, "member_1")).toEqual({ observations: 1, hypotheses: 0 });
    m = restoreMember(m, "member_1");
    expect(m.profile.members[0].status).toBe("active");
    expect(() => removeMember(m, "nope")).toThrow(/Unknown member/);
  });

  it("an unreferenced member can be deleted outright", () => {
    let m = addMember(blank(), { label: "Temp" });
    m = removeMember(m, "member_1");
    expect(m.profile.members).toEqual([]);
  });

  it("addIncomeSource changes total_income by the amount", () => {
    const base = createSampleHousehold();
    const before = evaluateSystem(base).variableById.get(DERIVED_IDS.totalIncome)!.currentValue!;
    expect(before).toBe(4300);
    const m = addIncomeSource(base, {
      name: "Weekend tutoring",
      monthlyAmount: 500,
      reliability: 0.5,
      volatility: 0.5,
      correlationGroup: "tutoring",
      replacementLatencyMonths: 1,
      sourceType: "self_reported",
      confidence: 0.6,
    });
    expect(m.incomeSources.at(-1)!.id).toBe("inc_1");
    expect(m.incomeSources.at(-1)!.earner).toBe("");
    expect(evaluateSystem(m).variableById.get(DERIVED_IDS.totalIncome)!.currentValue).toBe(before + 500);
    expect(evaluateSystem(base).variableById.get(DERIVED_IDS.totalIncome)!.currentValue).toBe(before);
    expect(() => addIncomeSource(base, { ...m.incomeSources.at(-1)!, id: "inc_warehouse" })).toThrow(/already exists/);
  });

  it("addVariable slugs ids from the name and refuses reserved derived ids", () => {
    const m = addVariable(blank(), inputVar("Care load"));
    const v = m.variables.find((x) => x.id === "care_load")!;
    expect(v).toBeDefined();
    expect(v.kind).toBe("input");
    expect(v.currentValue).toBeNull();
    expect(v.controllability).toBe(0.5);
    expect(v.formulaId).toBeUndefined();
    // A second "Care load" gets a numeric suffix rather than colliding.
    expect(addVariable(m, inputVar("Care load!")).variables.at(-1)!.id).toBe("care_load_2");
    // Explicit reserved id: the blank model already carries the derived record.
    expect(() => addVariable(blank(), inputVar("Floor", { id: DERIVED_IDS.floorRatio }))).toThrow(MutationError);
    // Even without the record present, the id is reserved for the formula.
    const stripped = { ...blank(), variables: blank().variables.filter((x) => x.id !== DERIVED_IDS.floorRatio) };
    expect(() => addVariable(stripped, inputVar("Floor", { id: DERIVED_IDS.floorRatio }))).toThrow(/reserved for a calculated variable/);
    // A name that slugs to a reserved id is moved to a free slug.
    expect(addVariable(blank(), inputVar("Floor ratio")).variables.at(-1)!.id).toBe("floor_ratio_2");
    expect(addVariable(blank(), inputVar("!!!")).variables.at(-1)!.id).toBe("variable");
  });

  it("removeVariable refuses derived variables and cascades for inputs", () => {
    const base = createSampleHousehold();
    expect(() => removeVariable(base, DERIVED_IDS.floorRatio)).toThrow(/calculated and cannot be removed/);
    expect(() => removeVariable(base, "nope")).toThrow(/Unknown variable/);
    // major_paths: r16 in, r17 out, obs_4 links it, a_protected_block targets it.
    const m = removeVariable(base, INPUT_IDS.majorPaths);
    expect(m.relationships.map((r) => r.id)).not.toContain("r16");
    expect(m.relationships.map((r) => r.id)).not.toContain("r17");
    expect(m.relationships).toHaveLength(base.relationships.length - 2);
    const obs4 = m.observations.find((o) => o.id === "obs_4")!;
    expect(obs4.links.variableIds).toEqual([INPUT_IDS.switchingFrequency]);
    expect(obs4.links.relationshipIds).toEqual([]);
    expect(m.actions.find((a) => a.id === "a_protected_block")!.targetVariables).toEqual([INPUT_IDS.protectedHours]);
    expect(m.hypotheses.find((h) => h.id === "hyp_churn")!.relationshipIds).toEqual(["r18"]);
    expect(loopNames(m)).not.toContain("Plan churn");
  });

  it("updateVariable protects derived fields but allows desiredValue on them", () => {
    const base = createSampleHousehold();
    const m = updateVariable(base, DERIVED_IDS.floorRatio, {
      currentValue: 42,
      sourceType: "measured",
      confidence: 1,
      desiredValue: 1.3,
      kind: "input",
      unit: "bananas",
      notes: "noted",
    });
    const fr = m.variables.find((v) => v.id === DERIVED_IDS.floorRatio)!;
    const original = base.variables.find((v) => v.id === DERIVED_IDS.floorRatio)!;
    expect(fr.desiredValue).toBe(1.3);
    expect(fr.notes).toBe("noted");
    expect(fr.currentValue).toBe(original.currentValue);
    expect(fr.sourceType).toBe("calculated");
    expect(fr.confidence).toBe(original.confidence);
    expect(fr.kind).toBe("derived");
    expect(fr.unit).toBe(original.unit);
    expect(fr.formulaId).toBe(original.formulaId);
    // Inputs accept a new value and cannot be promoted to derived.
    const input = updateVariable(base, INPUT_IDS.liquidReserves, { currentValue: 5000, kind: "derived" });
    const lr = input.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!;
    expect(lr.currentValue).toBe(5000);
    expect(lr.kind).toBe("input");
    expect(evaluateSystem(input).variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBeCloseTo(5000 / 3600, 9);
    // NOTE: field-level validation (VariableSchema.parse) runs before commit(),
    // so an out-of-range patch surfaces as a raw ZodError, not a MutationError.
    expect(() => updateVariable(base, INPUT_IDS.liquidReserves, { confidence: 2 })).toThrow(MutationError);
    expect(() => updateVariable(base, INPUT_IDS.liquidReserves, { confidence: 2 })).toThrow(/confidence/);
  });
});

/* ------------------------------------------------------------------ */
/* Signature snapshots                                                 */
/* ------------------------------------------------------------------ */

describe("signature snapshots", () => {
  const snapshotOf = (m: SystemModel, id: string) => computeSignature(evaluateSystem(m), { id, now: NOW, mode: "current" });

  it("adds, relabels and removes snapshots; nextSignatureId skips taken ids", () => {
    const base = createSampleHousehold();
    expect(nextSignatureId(base)).toBe("sig_1");
    const sig = snapshotOf(base, nextSignatureId(base));
    expect(sig.systemId).toBe(base.id);
    let m = addSignatureSnapshot(base, sig);
    expect(m.signatures).toHaveLength(1);
    expect(m.signatures[0]).toEqual(sig);
    expect(m.signatures[0].compactStrip).toBe(sig.compactStrip);
    expect(base.signatures).toHaveLength(0);
    expect(nextSignatureId(m)).toBe("sig_2");
    expect(() => addSignatureSnapshot(m, sig)).toThrow(/already exists/);
    expect(() => addSignatureSnapshot(m, { ...sig, id: "sig_9", systemId: "other" })).toThrow(/different system/);

    m = updateSignatureMeta(m, "sig_1", { label: "Baseline" });
    expect(m.signatures[0].label).toBe("Baseline");
    expect(m.signatures[0].notes).toBeUndefined();
    m = updateSignatureMeta(m, "sig_1", { notes: "first read" });
    expect(m.signatures[0]).toMatchObject({ label: "Baseline", notes: "first read" });
    // Only the metadata changes; the computed body is untouched.
    const stripMeta = (x: typeof sig) => ({ ...x, label: undefined, notes: undefined });
    expect(stripMeta(m.signatures[0])).toEqual(stripMeta(sig));
    expect(() => updateSignatureMeta(m, "sig_x", { label: "x" })).toThrow(/Unknown snapshot "sig_x"/);

    // A gap in ids: sig_2 taken with one stored snapshot -> the next free id is sig_3.
    const gap = addSignatureSnapshot(base, snapshotOf(base, "sig_2"));
    expect(nextSignatureId(gap)).toBe("sig_3");

    m = removeSignatureSnapshot(m, "sig_1");
    expect(m.signatures).toEqual([]);
    expect(nextSignatureId(m)).toBe("sig_1");
    expect(() => removeSignatureSnapshot(m, "sig_1")).toThrow(/Unknown snapshot/);
  });
});
