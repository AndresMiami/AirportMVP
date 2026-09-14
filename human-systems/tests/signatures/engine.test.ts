import { describe, expect, it } from "vitest";
import { registerBuiltInDomains } from "@/domains";
registerBuiltInDomains();
import { HOUSEHOLD_DOMAIN } from "@/domains/household/definition";
import { HOUSEHOLD_SIGNATURE_V1 } from "@/domains/household/signature-v1";
import { createSampleHousehold } from "@/data/sample-household";
import { createBlankModel } from "@/model/blank";
import { evaluateSystem } from "@/model/evaluate";
import { DERIVED_IDS, INPUT_IDS } from "@/domains/household/keys";
import * as M from "@/services/mutations";
import {
  bandStateOf,
  binaryStateOf,
  compactStrip,
  computeDynamicsSignature,
  computeSignature,
  normalizeInput,
  questionPriorities,
  rawValueFor,
  signatureGap,
  understandingSummary,
} from "@/signatures";
import { StructuralSignatureSchema, type SignatureDefinition } from "@/types/signature";
import type { SystemModel } from "@/types";

const NOW = "2026-09-14T12:00:00.000Z";
// The sample's person-level variables belong to Dani, so the fixture's
// signature is computed for Dani unless a test says otherwise.
const sig = (model: SystemModel, mode: "current" | "desired" = "current", id = "sig_1", subjectId: string | undefined = "dani") =>
  computeSignature(evaluateSystem(model), { id, now: NOW, mode, subjectId });

const setValue = (model: SystemModel, id: string, value: number | null) => M.updateVariable(model, id, { currentValue: value });

describe("unknown data is not converted to zero (A20)", () => {
  it("a dimension with a missing required input is unknown, not weak", () => {
    const s = sig(createSampleHousehold());
    const phys = s.dimensions.find((d) => d.dimensionId === "physical_feasibility")!;
    expect(phys.state).toBe("unknown");
    expect(phys.normalizedValue).toBeNull();
    expect(phys.binaryState).toBe("unknown");
    expect(phys.bandState).toBe("unknown");
    expect(phys.confidence).toBe(0);
    expect(phys.missingInformation).toContain("physical_capacity (not in the model for this subject)");
    expect(phys.explanation).toMatch(/missing information, not a low value/);
    expect(s.compactStrip[s.dimensions.indexOf(phys)]).toBe("?");
  });
  it("an optional unknown input is excluded from the mean rather than counted as 0", () => {
    const base = createSampleHousehold();
    const withVehicle = sig(base).dimensions.find((d) => d.dimensionId === "income_resilience")!;
    const without = sig(setValue(base, "single_vehicle_dependency", null)).dimensions.find((d) => d.dimensionId === "income_resilience")!;
    // vehicle dependency = 1 contributes 0 (inverted); dropping it must RAISE the mean, not leave it as if 0.
    expect(without.normalizedValue!).toBeGreaterThan(withVehicle.normalizedValue!);
    expect(without.knownWeightFraction).toBeLessThan(1);
    expect(without.missingInformation).toEqual(["single_vehicle_dependency"]);
    // and the confidence is scaled down by the known-weight fraction
    expect(without.confidence).toBeLessThan(withVehicle.confidence + 1e-9);
  });
  it("a blank model yields an all-unknown signature with zero completeness", () => {
    const blank = createBlankModel({ id: "b", name: "Blank", systemType: "household", now: NOW , domain: HOUSEHOLD_DOMAIN });
    const s = computeSignature(evaluateSystem(blank), { id: "sig_1", now: NOW, mode: "current" });
    expect(s.dimensions.every((d) => d.state === "unknown" && d.normalizedValue === null)).toBe(true);
    expect(s.completeness).toBe(0);
    expect(s.overallConfidence).toBeNull();
    expect(s.compactStrip).toBe("?".repeat(s.dimensions.length));
  });
  it("a zero value is a KNOWN low value, distinct from unknown", () => {
    const m = setValue(createSampleHousehold(), INPUT_IDS.liquidReserves, 0);
    const buffer = sig(m).dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    expect(buffer.state).toBe("known");
    expect(buffer.normalizedValue).toBe(0);
    expect(buffer.binaryState).toBe("weak");
    expect(buffer.bandState).toBe("very_weak");
  });
});

describe("subjects (3a)", () => {
  it("member-scope dimensions are unknown for the household subject and known for the member", () => {
    const m = createSampleHousehold();
    const household = computeSignature(evaluateSystem(m), { id: "h", now: NOW, mode: "current" });
    const dani = computeSignature(evaluateSystem(m), { id: "d", now: NOW, mode: "current", subjectId: "dani" });
    expect(household.subjectId).toBe(m.id);
    expect(dani.subjectId).toBe("dani");
    const hCareer = household.dimensions.find((d) => d.dimensionId === "career_capital")!;
    expect(hCareer.state).toBe("unknown");
    expect(hCareer.missingInformation).toEqual(["member-scope dimension; compute the signature for a member"]);
    expect(dani.dimensions.find((d) => d.dimensionId === "career_capital")!.normalizedValue).toBeCloseTo(0.35, 9);
    // System-scope dimensions read household keys for either subject.
    expect(household.dimensions.find((d) => d.dimensionId === "financial_buffer")!.normalizedValue).toBe(
      dani.dimensions.find((d) => d.dimensionId === "financial_buffer")!.normalizedValue,
    );
    // Marisol has no person-level variables recorded: her member dimensions are unknown, never borrowed from Dani.
    const marisol = computeSignature(evaluateSystem(m), { id: "m", now: NOW, mode: "current", subjectId: "marisol" });
    expect(marisol.dimensions.find((d) => d.dimensionId === "career_capital")!.state).toBe("unknown");
    expect(marisol.dimensions.find((d) => d.dimensionId === "focus_commitment")!.state).toBe("unknown");
    expect(() => computeSignature(evaluateSystem(m), { id: "x", now: NOW, mode: "current", subjectId: "nobody" })).toThrow(/Unknown subject/);
  });
});

describe("binary signature does not replace continuous values (A19)", () => {
  it("strip characters are derived from the continuous value and thresholds", () => {
    const s = sig(createSampleHousehold());
    for (const [i, d] of s.dimensions.entries()) {
      const ch = s.compactStrip[i];
      if (d.normalizedValue === null) expect(ch).toBe("?");
      else expect(ch).toBe(d.normalizedValue >= d.binaryThreshold ? "1" : "0");
      expect(d.binaryState).toBe(binaryStateOf(d.normalizedValue, d.binaryThreshold));
      expect(d.bandState).toBe(bandStateOf(d.normalizedValue, d.bandThresholds));
    }
    expect(s.compactStrip).toHaveLength(s.dimensions.length);
  });
  it("two different continuous values can share a bit; the values are still stored", () => {
    const a = sig(setValue(createSampleHousehold(), INPUT_IDS.liquidReserves, 1000)).dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    const b = sig(setValue(createSampleHousehold(), INPUT_IDS.liquidReserves, 9000)).dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    expect(a.binaryState).toBe("weak");
    expect(b.binaryState).toBe("weak");
    expect(a.normalizedValue).not.toBe(b.normalizedValue);
    expect(b.normalizedValue).toBeCloseTo(9000 / 3600 / 6, 9);
  });
  it("compactStrip and the thresholds live on the snapshot, and the encoding is display-only", () => {
    expect(compactStrip([{ binaryState: "strong" }, { binaryState: "unknown" }, { binaryState: "weak" }])).toBe("1?0");
    expect(bandStateOf(0.19, [0.2, 0.4, 0.6, 0.8])).toBe("very_weak");
    expect(bandStateOf(0.8, [0.2, 0.4, 0.6, 0.8])).toBe("very_strong");
    expect(binaryStateOf(0.67, 0.67)).toBe("strong");
  });
});

describe("normalisation and provenance", () => {
  it("linear and ratio transforms clip and invert", () => {
    expect(normalizeInput(0.75, { transform: { kind: "linear", min: 0, max: 1.5 }, invert: false })).toBeCloseTo(0.5, 9);
    expect(normalizeInput(9, { transform: { kind: "linear", min: 0, max: 6 }, invert: false })).toBe(1);
    expect(normalizeInput(-1, { transform: { kind: "linear", min: 0, max: 6 }, invert: false })).toBe(0);
    expect(normalizeInput(0.25, { transform: { kind: "linear", min: 0, max: 1 }, invert: true })).toBeCloseTo(0.75, 9);
    expect(normalizeInput(0.75, { transform: { kind: "ratio", strongAt: 1.5 }, invert: false })).toBeCloseTo(0.5, 9);
  });
  it("sample values match the definition arithmetic", () => {
    const ev = evaluateSystem(createSampleHousehold());
    const s = computeSignature(ev, { id: "x", now: NOW, mode: "current", subjectId: "dani" });
    const floor = s.dimensions.find((d) => d.dimensionId === "income_floor")!;
    expect(floor.normalizedValue).toBeCloseTo((2970 / 3600) / 1.5, 9);
    expect(floor.confidence).toBe(ev.variableById.get(DERIVED_IDS.floorRatio)!.confidence);
    const buffer = s.dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    expect(buffer.normalizedValue).toBeCloseTo(2800 / 3600 / 6, 9);
    const career = s.dimensions.find((d) => d.dimensionId === "career_capital")!;
    expect(career.normalizedValue).toBeCloseTo(0.35, 9);
    expect(career.confidence).toBe(0.4);
    expect(s.completeness).toBeCloseTo(8 / 10, 9);
  });
  it("a dimension exposes full evidence provenance", () => {
    const s = sig(createSampleHousehold());
    const focus = s.dimensions.find((d) => d.dimensionId === "focus_commitment")!;
    expect(focus.contributingVariableIds).toEqual([INPUT_IDS.majorPaths, INPUT_IDS.switchingFrequency, INPUT_IDS.persistence, INPUT_IDS.protectedHours, INPUT_IDS.qualityOfEffort]);
    const paths = focus.contributions.find((c) => c.variableId === INPUT_IDS.majorPaths)!;
    expect(paths.rawValue).toBe(3);
    expect(paths.normalized).toBeCloseTo(0.25, 9);
    expect(paths.invert).toBe(true);
    expect(paths.sourceType).toBe("self_reported");
    expect(paths.confidence).toBe(0.7);
    expect(paths.evidenceTexts.length).toBeGreaterThan(0);
    expect(paths.observationIds).toContain("obs_4");
    expect(focus.evidenceIds).toEqual(["obs_4"]);
    expect(focus.calculationMethod).toMatch(/weighted_mean/);
    expect(focus.explanation).toMatch(/inverted/);
    expect(focus.assumptionIds).toEqual(["A19", "A20", "A21"]);
    // obs_6 is linked to liquid_reserves, an input of the calculated buffer_months: provenance follows the formula.
    const buffer = s.dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    expect(buffer.contributions[0].variableId).toBe(DERIVED_IDS.bufferMonths);
    expect(buffer.contributions[0].observationIds).toEqual(["obs_6"]);
    expect(s.sourceObservationIds).toEqual(expect.arrayContaining(["obs_1", "obs_2", "obs_3", "obs_4", "obs_6", "obs_8"]));
    // obs_5 is linked to survival_work_share, which feeds no dimension: it must NOT appear.
    expect(s.sourceObservationIds).not.toContain("obs_5");
  });
});

describe("signature recomputes when source variables change", () => {
  it("raising reserves moves only the buffer dimension", () => {
    const base = createSampleHousehold();
    const before = sig(base);
    const after = sig(setValue(base, INPUT_IDS.liquidReserves, 12800));
    const b = before.dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    const a = after.dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    expect(a.normalizedValue!).toBeGreaterThan(b.normalizedValue!);
    expect(a.binaryState).toBe("strong");
    for (const d of before.dimensions) {
      if (d.dimensionId === "financial_buffer") continue;
      expect(after.dimensions.find((x) => x.dimensionId === d.dimensionId)!.normalizedValue).toBe(d.normalizedValue);
    }
  });
  it("an unknown dimension becomes known once its required input exists", () => {
    let m = createSampleHousehold();
    m = M.addVariable(m, { id: "physical_capacity", subjectId: "dani", name: "Physical capacity", category: "person_fit", changeSpeed: "slow", unit: "index 0-1", sourceType: "self_reported", confidence: 0.6, currentValue: 0.7 });
    const phys = sig(m).dimensions.find((d) => d.dimensionId === "physical_feasibility")!;
    expect(phys.state).toBe("known");
    // required input 0.7 (w1) + schedule_flexibility 0.3 (w0.5)
    expect(phys.normalizedValue).toBeCloseTo((0.7 * 1 + 0.3 * 0.5) / 1.5, 9);
    expect(phys.confidence).toBeCloseTo((0.6 * 1 + 0.6 * 0.5) / 1.5, 9);
  });
});

describe("confidence propagates correctly (A21)", () => {
  it("weighted mean of input confidence, scaled by known weight", () => {
    const m = createSampleHousehold();
    const s = sig(m);
    const focus = s.dimensions.find((d) => d.dimensionId === "focus_commitment")!;
    const ev = evaluateSystem(m);
    const conf = (id: string) => ev.variableById.get(id)!.confidence;
    const expected = (conf(INPUT_IDS.majorPaths) + conf(INPUT_IDS.switchingFrequency) + conf(INPUT_IDS.persistence) + conf(INPUT_IDS.protectedHours) + 0.5 * conf(INPUT_IDS.qualityOfEffort)) / 4.5;
    expect(focus.confidence).toBeCloseTo(expected, 9);
    expect(focus.knownWeightFraction).toBe(1);
  });
  it("measured inputs give higher dimension confidence than self-reported ones", () => {
    const s = sig(createSampleHousehold());
    const buffer = s.dimensions.find((d) => d.dimensionId === "financial_buffer")!;
    const focus = s.dimensions.find((d) => d.dimensionId === "focus_commitment")!;
    expect(buffer.confidence).toBeGreaterThan(focus.confidence);
  });
  it("min confidence method and overall confidence", () => {
    const def: SignatureDefinition = {
      ...HOUSEHOLD_SIGNATURE_V1,
      id: "t",
      dimensions: [{ ...HOUSEHOLD_SIGNATURE_V1.dimensions[5], confidenceMethod: "min" }],
    };
    const s = computeSignature(evaluateSystem(createSampleHousehold()), { id: "x", now: NOW, mode: "current", definition: def, subjectId: "dani" });
    expect(s.dimensions[0].confidence).toBeCloseTo(0.35, 9);
    expect(s.overallConfidence).toBeCloseTo(0.35, 9);
    expect(s.definitionId).toBe("t");
  });
});

describe("different relationship graphs can exist for identical state vectors", () => {
  it("same V, different R and dynamics", () => {
    const a = createSampleHousehold();
    // Person B: same values, but pressure reduces effort instead of spawning plans.
    let b = M.removeRelationship(a, "r16");
    b = M.addRelationship(b, { kind: "causal_hypothesis", participatesInDynamics: true, sourceVariableId: "financial_pressure", targetVariableId: INPUT_IDS.protectedHours, direction: "negative", strength: 0.9, lag: { value: 1, unit: "weeks" }, confidence: 0.6, sourceType: "observed" });
    const sa = sig(a, "current", "a");
    const sb = sig(b, "current", "b");
    expect(sa.dimensions.map((d) => d.normalizedValue)).toEqual(sb.dimensions.map((d) => d.normalizedValue));
    expect(sa.compactStrip).toBe(sb.compactStrip);
    expect(sa.relationshipSnapshot.map((r) => r.id).sort()).not.toEqual(sb.relationshipSnapshot.map((r) => r.id).sort());
    expect(sa.loopSnapshot.map((l) => l.id).sort()).not.toEqual(sb.loopSnapshot.map((l) => l.id).sort());
    expect(sb.relationshipSnapshot.some((r) => r.id === "rel_1")).toBe(true);
    expect(sa.relationshipSnapshot.some((r) => r.id === "rel_1")).toBe(false);
    expect(JSON.stringify(sa.dynamics)).not.toBe(JSON.stringify(sb.dynamics));
    expect(sb.dynamics.strongestIncomingInfluences.map((r) => r.id)).toContain("rel_1");
  });
  it("dynamics signature is derived from enabled edges and detected loops", () => {
    const ev = evaluateSystem(createSampleHousehold());
    const d = computeDynamicsSignature(ev);
    expect(d.strongestReinforcingLoops.length).toBe(3);
    expect(d.strongestBalancingLoops.length).toBe(1);
    expect(d.loopCounts).toEqual({ reinforcing: 3, balancing: 1, accepted: 1, rejected: 0 });
    expect(d.highCentralityVariables[0].variableId).toBe("financial_pressure");
    expect(d.importantLags[0].lag).toEqual({ value: 1, unit: "years" });
    expect(d.relationshipConfidence.count).toBe(21);
    expect(d.relationshipConfidence.evidencedShare).toBeCloseTo(4 / 21, 9); // r09, r10, r14, r15 are by-construction edges
    const disabled = M.setRelationshipEnabled(createSampleHousehold(), "r06", false);
    const d2 = computeDynamicsSignature(evaluateSystem(disabled));
    expect(d2.relationshipConfidence.count).toBe(20);
    expect(d2.loopCounts.reinforcing).toBe(0);
  });
});

describe("snapshots are immutable and valid", () => {
  it("the returned signature is deeply frozen and schema-valid", () => {
    const s = sig(createSampleHousehold());
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.dimensions[0])).toBe(true);
    expect(Object.isFrozen(s.dimensions[0].contributions[0])).toBe(true);
    expect(() => {
      (s.dimensions[0] as { normalizedValue: number | null }).normalizedValue = 1;
    }).toThrow();
    expect(StructuralSignatureSchema.safeParse(JSON.parse(JSON.stringify(s))).success).toBe(true);
  });
  it("editing the model afterwards does not change an existing snapshot", () => {
    const base = createSampleHousehold();
    const s = sig(base);
    const bufferBefore = s.dimensions.find((d) => d.dimensionId === "financial_buffer")!.normalizedValue;
    setValue(base, INPUT_IDS.liquidReserves, 99999);
    expect(s.dimensions.find((d) => d.dimensionId === "financial_buffer")!.normalizedValue).toBe(bufferBefore);
  });
});

describe("current vs desired gaps respect targetMode (A24)", () => {
  it("a floor already met keeps the current value in desired mode", () => {
    let m = createSampleHousehold();
    m = M.updateVariable(m, INPUT_IDS.protectedHours, { currentValue: 12, desiredValue: 10, targetMode: "at_least" });
    const v = evaluateSystem(m).variableById.get(INPUT_IDS.protectedHours)!;
    expect(rawValueFor(v, "desired")).toBe(12);
    m = M.updateVariable(m, INPUT_IDS.protectedHours, { targetMode: "exact" });
    expect(rawValueFor(evaluateSystem(m).variableById.get(INPUT_IDS.protectedHours)!, "desired")).toBe(10);
  });
  it("a ceiling already respected keeps the current value; an unmet target reads the desired value", () => {
    let m = createSampleHousehold();
    m = M.updateVariable(m, INPUT_IDS.majorPaths, { currentValue: 1, desiredValue: 2, targetMode: "at_most" });
    expect(rawValueFor(evaluateSystem(m).variableById.get(INPUT_IDS.majorPaths)!, "desired")).toBe(1);
    expect(rawValueFor(evaluateSystem(createSampleHousehold()).variableById.get(INPUT_IDS.liquidReserves)!, "desired")).toBe(10800);
  });
  it("a variable without a target reads its current value, so its dimension shows no gap", () => {
    const m = createSampleHousehold();
    const cur = sig(m, "current", "c");
    const des = sig(m, "desired", "d");
    const gaps = signatureGap(cur, des);
    const career = gaps.find((g) => g.dimensionId === "career_capital")!;
    expect(career.gap).toBeCloseTo(0.25, 9); // 35 -> 60 on 0..100
    expect(career.band).toBe("moderate");
    const buffer = gaps.find((g) => g.dimensionId === "financial_buffer")!;
    expect(buffer.gap).toBeCloseTo(3 / 6 - 2800 / 3600 / 6, 9);
    expect(buffer.band).toBe("large");
    const phys = gaps.find((g) => g.dimensionId === "physical_feasibility")!;
    expect(phys.band).toBe("unknown");
    expect(phys.label).toMatch(/unknown/);
    const productive = gaps.find((g) => g.dimensionId === "productive_assets")!;
    // productive_assets 1200 -> 5000 (w1) and conversion 0.3 -> 0.5 (w0.5)
    expect(productive.gap).toBeCloseTo(((5000 / 20000) * 1 + 0.5 * 0.5) / 1.5 - ((1200 / 20000) * 1 + 0.3 * 0.5) / 1.5, 9);
    expect(gaps.every((g) => typeof g.label === "string")).toBe(true);
    expect(gaps.find((g) => "total" in g)).toBeUndefined();
  });
  it("already strong is reported when current is strong and there is no gap", () => {
    let m = createSampleHousehold();
    m = M.updateVariable(m, INPUT_IDS.careerCapital, { currentValue: 90, desiredValue: 80, targetMode: "at_least" });
    const g = signatureGap(sig(m, "current", "c"), sig(m, "desired", "d")).find((x) => x.dimensionId === "career_capital")!;
    expect(g.alreadyStrong).toBe(true);
    expect(g.label).toBe("already strong");
  });
});

describe("question priority favours high-uncertainty, high-impact dimensions (A22)", () => {
  it("unknown dimensions with loop participation rank above well-known ones", () => {
    const ev = evaluateSystem(createSampleHousehold());
    const s = computeSignature(ev, { id: "x", now: NOW, mode: "current" });
    const qs = questionPriorities(ev, s, HOUSEHOLD_SIGNATURE_V1);
    expect(qs).toHaveLength(10);
    for (let i = 1; i < qs.length; i += 1) expect(qs[i - 1].priority).toBeGreaterThanOrEqual(qs[i].priority);
    const unknownOnes = qs.filter((q) => q.state === "unknown");
    expect(unknownOnes.every((q) => q.uncertainty === 1)).toBe(true);
    const buffer = qs.find((q) => q.dimensionId === "financial_buffer")!;
    const focus = qs.find((q) => q.dimensionId === "focus_commitment")!;
    expect(buffer.uncertainty).toBeLessThan(focus.uncertainty);
    for (const q of qs) {
      expect(q.priority).toBeCloseTo(q.importance * q.uncertainty * q.influence, 12);
      expect(q.influence).toBeGreaterThanOrEqual(0.1);
      expect(q.question.length).toBeGreaterThan(10);
    }
    // The unknown physical dimension asks for its required input.
    const phys = qs.find((q) => q.dimensionId === "physical_feasibility")!;
    expect(phys.targetVariableId).toBe("physical_capacity");
    expect(phys.question).toMatch(/physical limits/);
    expect(understandingSummary(qs)).toMatch(/understood reasonably well/);
  });
  it("adding evidence lowers a dimension's priority", () => {
    const base = createSampleHousehold();
    const ev0 = evaluateSystem(base);
    const q0 = questionPriorities(ev0, computeSignature(ev0, { id: "a", now: NOW, mode: "current", subjectId: "dani" }), HOUSEHOLD_SIGNATURE_V1).find((q) => q.dimensionId === "career_capital")!;
    const better = M.updateVariable(base, INPUT_IDS.careerCapital, { confidence: 0.9, sourceType: "measured" });
    const ev1 = evaluateSystem(better);
    const q1 = questionPriorities(ev1, computeSignature(ev1, { id: "b", now: NOW, mode: "current", subjectId: "dani" }), HOUSEHOLD_SIGNATURE_V1).find((q) => q.dimensionId === "career_capital")!;
    expect(q1.priority).toBeLessThan(q0.priority);
    expect(q1.uncertainty).toBeCloseTo(0.1, 9);
  });
  it("influence is floored so an isolated unknown dimension is still askable", () => {
    const blank = createBlankModel({ id: "b", name: "Blank", systemType: "household", now: NOW , domain: HOUSEHOLD_DOMAIN });
    const ev = evaluateSystem(blank);
    const qs = questionPriorities(ev, computeSignature(ev, { id: "x", now: NOW, mode: "current" }), HOUSEHOLD_SIGNATURE_V1);
    expect(qs.every((q) => q.influence === 0.1 && q.uncertainty === 1)).toBe(true);
    // Highest importance (0.9) first; the two 0.9 dimensions tie and sort by id.
    expect(qs.slice(0, 2).map((q) => q.dimensionId)).toEqual(["financial_buffer", "income_floor"]);
    expect(qs[0].priority).toBeCloseTo(0.9 * 1 * 0.1, 12);
  });
});
