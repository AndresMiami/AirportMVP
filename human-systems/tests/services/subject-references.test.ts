/**
 * HISTORICAL SUBJECT REFERENCES (3a invariant 1): hard deletion of a
 * member is refused while ANY entity references that subject. Archiving is
 * the normal lifecycle and keeps every reference intact.
 */
import { describe, expect, it } from "vitest";
import { addIncomeSource } from "@/services/household-income";
import { registerBuiltInDomains } from "@/domains";
import { HOUSEHOLD_DOMAIN } from "@/domains/household/definition";
import { createBlankModel } from "@/model/blank";
import { evaluateSystem } from "@/model/evaluate";
import { computeSignature } from "@/signatures/compute";
import * as M from "@/services/mutations";
import { exactDate } from "@/calculations/time";
import type { SystemModel } from "@/types";

registerBuiltInDomains();
const NOW = "2026-09-14T12:00:00.000Z";

function withMember(): SystemModel {
  const m = createBlankModel({ id: "sys", name: "S", systemType: "household", now: NOW, domain: HOUSEHOLD_DOMAIN });
  return M.addMember(m, { id: "sam", label: "Sam", role: "Adult" });
}

const variable = (m: SystemModel, subjectId: string | null, key = "career_capital") =>
  M.addVariable(m, { name: "Career capital", key, subjectId, category: "asset", changeSpeed: "slow", unit: "index", sourceType: "self_reported", confidence: 0.5, currentValue: 3 });

/** One model per entity kind that references Sam, and the reference key it should show up under. */
const CASES: Record<string, (m: SystemModel) => SystemModel> = {
  variables: (m) => variable(m, "sam"),
  collections: (m) =>
    addIncomeSource(m, { name: "Job", monthlyAmount: 1000, earnerId: "sam", reliability: 0.5, volatility: 0.5, correlationGroup: "job", replacementLatencyMonths: 2, sourceType: "self_reported", confidence: 0.5 }),
  constraints: (m) => M.addConstraint(m, { name: "No nights", type: "hard", sourceType: "self_reported", confidence: 0.5, subjectId: "sam" }),
  actions: (m) => ({
    ...m,
    actions: [
      { id: "act", name: "Try", description: "", subjectId: "sam", targetVariables: [], extensions: {}, requirements: {}, utility: {}, impact: 0.5, controllability: 0.5, durability: 0.5, cost: 0.5, uncertainty: 0.5, sourceType: "self_reported", confidence: 0.5, notes: "" },
    ],
  }),
  hypotheses: (m) => M.addHypothesis(m, { statement: "Sam persists", confidence: 0.4, subjectId: "sam" }),
  events: (m) => M.addEvent(m, { kind: "shock", type: "job_lost", title: "Lost job", occurred: exactDate("2026-03-01"), recordedAt: NOW, sourceType: "self_reported", confidence: 0.8, subjectId: "sam" }),
  observations: (m) => M.addObservation(m, { statement: "Sam works nights", sourceType: "self_reported", confidence: 0.8, subjectId: "sam" }),
  signatures: (m) => {
    const hadVar = m.variables.some((v) => v.subjectId === "sam");
    const withVar = hadVar ? m : variable(m, "sam");
    const sig = computeSignature(evaluateSystem(withVar), { id: "sig", now: NOW, mode: "current", subjectId: "sam" });
    const withSig = M.addSignatureSnapshot(withVar, sig);
    // in isolation, remove the variable again so the ONLY reference is the snapshot
    return hadVar ? withSig : M.removeVariable(withSig, withVar.variables.find((v) => v.subjectId === "sam")!.id);
  },
};

describe("member deletion is refused by every referencing entity kind", () => {
  for (const [kind, build] of Object.entries(CASES)) {
    it(`${kind}`, () => {
      const m = build(withMember());
      const refs = M.memberReferences(m, "sam");
      expect(refs[kind as keyof typeof refs]).toBe(1);
      expect(refs.total).toBe(1);
      const named = kind === "collections" ? "incomeSources" : kind;
      expect(() => M.removeMember(m, "sam")).toThrow(new RegExp(`1 ${named}.*archive them instead`));
      expect(m.profile.members.find((x) => x.id === "sam")).toBeDefined();
    });
  }

  it("archiving keeps every reference, the member row, and its id; restore brings it back", () => {
    let m = withMember();
    for (const build of Object.values(CASES)) m = build(m);
    // signatures case removed the career_capital variable; add one more subject-scoped variable for good measure
    m = variable(m, "sam", "protected_hours");
    const refsBefore = M.memberReferences(m, "sam");
    expect(refsBefore.total).toBeGreaterThanOrEqual(8);
    const archived = M.archiveMember(m, "sam");
    expect(archived.profile.members.find((x) => x.id === "sam")?.status).toBe("archived");
    expect(M.memberReferences(archived, "sam")).toEqual(refsBefore);
    // the subject id is untouched on every entity
    expect(archived.variables.filter((v) => v.subjectId === "sam").length).toBe(refsBefore.variables);
    expect(archived.events.every((e) => e.subjectId === "sam")).toBe(true);
    expect(archived.signatures.every((s) => s.subjectId === "sam")).toBe(true);
    // archived subjects still resolve for history, but they leave the active projections
    expect(() => M.removeMember(archived, "sam")).toThrow(/archive them instead/);
    const restored = M.restoreMember(archived, "sam");
    expect(restored.profile.members.find((x) => x.id === "sam")?.status).toBe("active");
    expect(M.memberReferences(restored, "sam")).toEqual(refsBefore);
  });

  it("unassigned entities do not count as references to anyone, and an unknown subject is refused", () => {
    const m = variable(withMember(), null);
    expect(M.memberReferences(m, "sam").total).toBe(0);
    expect(M.removeMember(m, "sam").profile.members).toEqual([]);
    expect(m.variables.at(-1)!.subjectId).toBeNull();
    expect(() => variable(withMember(), "ghost")).toThrow(/Unknown/);
  });

  it("removing a variable does not remove the subject; assigning a subject is explicit", () => {
    let m = variable(withMember(), null);
    const id = m.variables.at(-1)!.id;
    expect(evaluateSystem(m).unassignedVariables.map((v) => v.id)).toEqual([id]);
    m = M.assignVariableSubject(m, id, "sam");
    expect(m.variables.find((v) => v.id === id)!.subjectId).toBe("sam");
    expect(evaluateSystem(m).unassignedVariables).toEqual([]);
    expect(() => M.removeMember(m, "sam")).toThrow(/1 variables/);
    m = M.assignVariableSubject(m, id, null);
    expect(M.memberReferences(m, "sam").total).toBe(0);
  });
});
