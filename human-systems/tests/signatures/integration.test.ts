/**
 * Fictional user walk-through: incomplete observations -> first signature
 * with unknowns -> targeted questions -> more evidence -> higher
 * confidence -> snapshot -> changes -> second snapshot -> comparison ->
 * persistence -> same state, different dynamics -> reload.
 */
import { describe, expect, it } from "vitest";
import { evaluateSystem } from "@/model/evaluate";
import { INPUT_IDS } from "@/model/ids";
import { LocalStorageModelRepository, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import {
  HOUSEHOLD_SIGNATURE_V1,
  compareSignatures,
  computeSignature,
  persistenceIndicators,
  questionPriorities,
  recurringRelationships,
} from "@/signatures";
import type { SystemModel } from "@/types";

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

const T1 = "2026-01-15T10:00:00.000Z";
const T2 = "2026-09-14T12:00:00.000Z";
const dim = (m: SystemModel, id: string, now = T2) =>
  computeSignature(evaluateSystem(m), { id: "tmp", now, mode: "current" }).dimensions.find((d) => d.dimensionId === id)!;

describe("fictional user: from incomplete observations to a compared history", () => {
  it("walks the loop end to end", async () => {
    const storage = new FakeStorage();
    const svc = new ModelService(new LocalStorageModelRepository(storage), { now: () => T2, newId: () => "sys_ren" });
    let m = await svc.createBlank({ name: "Ren's household", systemType: "household" });
    m = M.addMember(m, { id: "ren", label: "Ren", role: "adult" });
    m = M.addMember(m, { id: "mai", label: "Mai", role: "adult" });

    // 1. Incomplete observations: income and expenses are stated; reserves and career are not.
    m = M.addObservation(m, { id: "o1", statement: "Ren earns about $2,400 a month from a warehouse job.", subjectId: "ren", sourceType: "self_reported", confidence: 0.7, dateOrPeriod: "2026" });
    m = M.addObservation(m, { id: "o2", statement: "Mai's home-care income depends mainly on one client.", subjectId: "mai", sourceType: "self_reported", confidence: 0.6 });
    m = M.addObservation(m, { id: "o3", statement: "Rent, food and utilities come to roughly $3,000 a month.", sourceType: "self_reported", confidence: 0.6 });
    m = M.addIncomeSource(m, { id: "inc_ren", name: "Warehouse job", earner: "Ren", monthlyAmount: 2400, reliability: 0.85, volatility: 0.1, correlationGroup: "employer", replacementLatencyMonths: 2, sourceType: "self_reported", confidence: 0.7 });
    m = M.addIncomeSource(m, { id: "inc_mai", name: "Home care (one client)", earner: "Mai", monthlyAmount: 1600, reliability: 0.5, volatility: 0.4, correlationGroup: "single_client", replacementLatencyMonths: 1.5, sourceType: "self_reported", confidence: 0.6 });
    m = M.addVariable(m, { id: INPUT_IDS.essentialExpenses, name: "Essential monthly expenses", category: "structure", changeSpeed: "slow", unit: "$/month", sourceType: "self_reported", confidence: 0.6, currentValue: 3000, referenceRange: { min: 0, max: 6000 } });
    m = M.addVariable(m, { id: INPUT_IDS.careerCapital, name: "Career capital (index)", category: "asset", changeSpeed: "slow", unit: "index 0-100", sourceType: "self_reported", confidence: 0.35, currentValue: 30, referenceRange: { min: 0, max: 100 } });
    m = M.linkObservation(m, "o3", { kind: "variable", id: INPUT_IDS.essentialExpenses });

    // 2-3. First signature: several dimensions unknown, the known ones at low confidence.
    const first = computeSignature(evaluateSystem(m), { id: "sig_first", now: T1, mode: "current" });
    const state = Object.fromEntries(first.dimensions.map((d) => [d.dimensionId, d.state]));
    expect(state.income_floor).toBe("known");
    expect(state.income_resilience).toBe("known");
    expect(state.career_capital).toBe("known");
    expect(state.financial_buffer).toBe("unknown");
    expect(state.focus_commitment).toBe("unknown");
    expect(state.physical_feasibility).toBe("unknown");
    expect(state.social_support).toBe("unknown");
    expect(state.planning_horizon).toBe("unknown");
    expect(first.completeness).toBeCloseTo(3 / 10, 9);
    expect(first.dimensions.find((d) => d.dimensionId === "financial_buffer")!.normalizedValue).toBeNull();
    expect(first.dimensions.find((d) => d.dimensionId === "income_floor")!.confidence).toBeLessThanOrEqual(0.6);
    expect(first.dimensions.find((d) => d.dimensionId === "career_capital")!.confidence).toBe(0.35);
    expect(first.compactStrip).toMatch(/^[01?]{10}$/);
    expect(first.compactStrip.split("?").length - 1).toBe(7);

    // The next question targets an unknown, high-importance dimension; buffer is asked before career.
    const questions = questionPriorities(evaluateSystem(m), first, HOUSEHOLD_SIGNATURE_V1);
    expect(questions[0].state).toBe("unknown");
    expect(questions[0].importance).toBeGreaterThanOrEqual(0.85);
    const bufferQ = questions.find((q) => q.dimensionId === "financial_buffer")!;
    const careerQ = questions.find((q) => q.dimensionId === "career_capital")!;
    expect(bufferQ.priority).toBeGreaterThan(careerQ.priority);
    expect(bufferQ.question).toMatch(/available within days/);

    // 4-6. New evidence: reserves measured; career capital re-assessed from records.
    m = M.addVariable(m, { id: INPUT_IDS.liquidReserves, name: "Liquid reserves", category: "buffer", changeSpeed: "slow", unit: "$", sourceType: "measured", confidence: 0.95, currentValue: 1500, referenceRange: { min: 0, max: 20000 }, evidence: [{ text: "Savings balance 2026-01-10", sourceType: "measured" }] });
    m = M.addObservation(m, { id: "o4", statement: "Savings account held $1,500 on 10 January 2026.", sourceType: "measured", confidence: 0.95, evidenceSource: "bank statement", links: { variableIds: [INPUT_IDS.liquidReserves], relationshipIds: [], constraintIds: [], hypothesisIds: [] } });
    m = M.updateVariable(m, INPUT_IDS.careerCapital, { confidence: 0.7, sourceType: "observed", evidence: [{ text: "Certificates and references reviewed together", sourceType: "observed" }] });
    const second = computeSignature(evaluateSystem(m), { id: "sig_second", now: T1, mode: "current" });
    expect(second.dimensions.find((d) => d.dimensionId === "financial_buffer")!.state).toBe("known");
    expect(second.dimensions.find((d) => d.dimensionId === "financial_buffer")!.confidence).toBeCloseTo(Math.min(0.95, 0.6), 9);
    // Provenance follows the formula chain: buffer_months reads liquid_reserves (o4) AND essential_expenses (o3).
    expect(second.dimensions.find((d) => d.dimensionId === "financial_buffer")!.evidenceIds).toEqual(["o4", "o3"]);
    expect(second.dimensions.find((d) => d.dimensionId === "career_capital")!.confidence).toBe(0.7);
    expect(second.completeness).toBeGreaterThan(first.completeness);
    expect(second.overallConfidence!).toBeGreaterThan(first.overallConfidence!);

    // 7. Save the first snapshot (label "T1") and persist.
    m = M.addSignatureSnapshot(m, computeSignature(evaluateSystem(m), { id: M.nextSignatureId(m), now: T1, mode: "current", label: "Ren household 2026-01" }));
    m = await svc.save(m);

    // 8-9. Income and buffer change; a second snapshot.
    m = M.updateIncomeSource(m, "inc_ren", { monthlyAmount: 3200, reliability: 0.9 });
    m = M.updateVariable(m, INPUT_IDS.liquidReserves, { currentValue: 9000 });
    m = M.addSignatureSnapshot(m, computeSignature(evaluateSystem(m), { id: M.nextSignatureId(m), now: T2, mode: "current", label: "Ren household 2026-09" }));
    m = await svc.save(m);
    expect(m.signatures.map((s) => s.id)).toEqual(["sig_1", "sig_2"]);

    // 10-11. Compare: buffer and floor changed; career capital and resilience persisted.
    const cmp = compareSignatures(m.signatures[0], m.signatures[1]);
    const changedIds = cmp.changed.map((c) => c.dimensionId);
    expect(changedIds).toContain("financial_buffer");
    expect(changedIds).toContain("income_floor");
    expect(cmp.changed.find((c) => c.dimensionId === "financial_buffer")!.classification).toBe("improved");
    expect(cmp.changed.find((c) => c.dimensionId === "financial_buffer")!.before).toBeCloseTo(1500 / 3000 / 6, 9);
    expect(cmp.changed.find((c) => c.dimensionId === "financial_buffer")!.after).toBeCloseTo(9000 / 3000 / 6, 9);
    const persistentIds = cmp.persistent.map((c) => c.dimensionId);
    expect(persistentIds).toContain("career_capital");
    expect(persistentIds).toContain("income_resilience"); // shares moved a little, well under the threshold
    expect(cmp.unknownInvolved.map((c) => c.dimensionId)).toContain("physical_feasibility");
    expect(cmp.variablesChanged.map((v) => v.variableId)).toEqual(expect.arrayContaining([INPUT_IDS.liquidReserves, "total_income"]));
    expect(cmp.variablesPersistent.map((v) => v.variableId)).toContain(INPUT_IDS.careerCapital);
    const persistence = persistenceIndicators(m.signatures);
    const career = persistence.find((p) => p.level === "dimension" && p.id === "career_capital")!;
    expect(career.persistent).toBe(true);
    expect(career.snapshotsKnown).toBe(2);
    expect(career.othersChanged).toBeGreaterThanOrEqual(2);
    expect(career.statement).toMatch(/appears structurally persistent across 2 snapshots/);
    expect(career.statement).toMatch(/not a demonstration of cause/);
    expect(persistence.find((p) => p.level === "dimension" && p.id === "financial_buffer")!.persistent).toBe(false);
    expect(persistence.find((p) => p.level === "dimension" && p.id === "social_support")!.snapshotsKnown).toBe(0);

    // 12. Same state values, different relationship graph -> same V, different dynamics.
    m = M.addVariable(m, { id: "financial_pressure", name: "Financial pressure", category: "event", changeSpeed: "fast", unit: "self-rating 0-10", sourceType: "self_reported", confidence: 0.6, currentValue: 6, referenceRange: { min: 0, max: 10 } });
    m = M.addVariable(m, { id: INPUT_IDS.protectedHours, name: "Protected hours", category: "asset", changeSpeed: "slow", unit: "hours/week", sourceType: "self_reported", confidence: 0.5, currentValue: 3, referenceRange: { min: 0, max: 20 } });
    const personA = M.addRelationship(m, { sourceVariableId: "financial_pressure", targetVariableId: INPUT_IDS.protectedHours, direction: "positive", strength: 0.7, lag: { value: 2, unit: "weeks" }, confidence: 0.5, sourceType: "observed", explanation: "Pressure increases work effort." });
    const personB = M.addRelationship(m, { sourceVariableId: "financial_pressure", targetVariableId: INPUT_IDS.protectedHours, direction: "negative", strength: 0.7, lag: { value: 2, unit: "weeks" }, confidence: 0.5, sourceType: "observed", explanation: "Pressure leads to avoidance." });
    const sigA = computeSignature(evaluateSystem(personA), { id: "a", now: T2, mode: "current" });
    const sigB = computeSignature(evaluateSystem(personB), { id: "b", now: T2, mode: "current" });
    expect(sigA.dimensions.map((d) => d.normalizedValue)).toEqual(sigB.dimensions.map((d) => d.normalizedValue));
    expect(sigA.compactStrip).toBe(sigB.compactStrip);
    expect(sigA.relationshipSnapshot[0].direction).toBe("positive");
    expect(sigB.relationshipSnapshot[0].direction).toBe("negative");
    expect(sigA.dynamics.strongestIncomingInfluences[0].direction).not.toBe(sigB.dynamics.strongestIncomingInfluences[0].direction);
    // Reappearance is counted, never asserted as cause.
    const twoA = [sigA, computeSignature(evaluateSystem(personA), { id: "a2", now: T2, mode: "current" })];
    const recurring = recurringRelationships(twoA);
    expect(recurring[0].appearances).toBe(2);
    expect(recurring[0].statement).toMatch(/not a demonstrated cause/);

    // Reload: history intact, the stored snapshots still evaluate the same.
    const svc2 = new ModelService(new LocalStorageModelRepository(storage), { now: () => T2 });
    const { model: reloaded } = await svc2.loadActiveOrSeed();
    expect(reloaded.id).toBe("sys_ren");
    expect(reloaded.signatures).toEqual(m.signatures);
    expect(reloaded.signatures[0].label).toBe("Ren household 2026-01");
    expect(compareSignatures(reloaded.signatures[0], reloaded.signatures[1]).changed.map((c) => c.dimensionId)).toEqual(changedIds);
    // The dimension helper still agrees with the stored history for an unchanged dimension.
    expect(dim(reloaded, "career_capital").normalizedValue).toBe(reloaded.signatures[1].dimensions.find((d) => d.dimensionId === "career_capital")!.normalizedValue);
  });
});
