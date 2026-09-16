/**
 * The review card's ordinary language is derived from the kernel's record
 * only: seven answers, the fixed basis disclaimer, "Nothing else changes."
 * only when the diff proves it, named consequences for the second
 * confirmation, and the stale comparison (before / changed since / now).
 */
import { describe, expect, it, vi } from "vitest";
import { BASIS_DISCLAIMER, ENGINE_CANNOT_JUDGE, MemoryProposalRepository, NOTHING_ELSE_CHANGES, NO_RATIONALE, ProposalService, STATUS_WORDS, consequenceReasons, describeProposal, staleComparison, type MutationBatch, type ProposalStatus } from "@/kernel";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";
import { KERNEL_NOW, seedNeutralSystem } from "../helpers/neutral-kernel-domain";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains/index", armed("@/domains/index"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

async function harness() {
  const repo = new MemoryModelRepository();
  const models = new ModelService(repo, { now: () => KERNEL_NOW, newId: () => "sys_kernel" });
  const model = await seedNeutralSystem(models);
  let n = 0;
  const svc = new ProposalService(new MemoryProposalRepository(), models, { now: () => KERNEL_NOW }, () => `prop_${++n}`);
  return { repo, models, model, svc };
}

describe("describeProposal", () => {
  it("answers the seven questions from the record; 'Nothing else changes.' only when the diff proves it; the disclaimer is fixed text", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: [{ kind: "addHypothesis", args: { statement: "B follows A", confidence: 0.3 } }], proposedBy: { kind: "person" }, rationale: "seen twice", basis: [{ kind: "observation", id: "obs_a" }, { kind: "observation", id: "obs_gone" }, { kind: "user_statement", text: "I think so" }] });
    const w = describeProposal(p);
    expect(w.what).toEqual(["Create hypothesis “B follows A”."]);
    expect(w.why).toBe("seen twice");
    expect(w.willChange[0].details).toContain("No disconfirming condition stated yet.");
    expect(w.elseChanges).toEqual([]);
    expect(w.willNotChange).toBe(NOTHING_ELSE_CHANGES);
    expect(w.basis.map((b) => [b.text, b.resolved])).toEqual([
      ["Observation: “Input A was read twice this month” (2026-09).", true],
      ["Observation obs_gone no longer exists in the model.", false],
      ["You said: “I think so”", true],
    ]);
    expect(w.uncertainty).toEqual(["A cited record is gone: Observation obs_gone no longer exists in the model.", ENGINE_CANNOT_JUDGE]);
    expect(w.consequences).toEqual([]);
    expect(w.errors).toEqual([]);
    expect(BASIS_DISCLAIMER).toBe("These records explain why this proposal was made. They do not make the proposal true.");
  });

  it("a derived shell makes 'else changes' non-empty and withholds 'Nothing else changes.'; no rationale is said plainly", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: [{ kind: "addMember", args: { label: "Part two" } }], proposedBy: { kind: "system_feature", featureId: "test" } });
    const w = describeProposal(p);
    expect(w.why).toBe(NO_RATIONALE);
    expect(w.elseChanges).toEqual(["Adds variable Part share."]);
    expect(w.willNotChange).not.toBe(NOTHING_ELSE_CHANGES);
    expect(w.willNotChange).toMatch(/Other records change as well/);
  });

  it("names the consequence for the second confirmation; an invalid proposal says why it cannot be applied", async () => {
    const h = await harness();
    const hard: MutationBatch = [{ kind: "addConstraint", args: { name: "Never below 10", type: "hard", sourceType: "self_reported", confidence: 1 } }];
    const p = await h.svc.create({ modelId: h.model.id, request: hard, proposedBy: { kind: "person" } });
    expect(p.preview.consequenceClass).toBe("consequential");
    const w = describeProposal(p);
    expect(w.consequences).toEqual([consequenceReasons("addConstraint", hard[0].args)[0]]);
    expect(w.consequences[0]).toMatch(/“Never below 10” becomes a HARD constraint the engine cannot check/);
    expect(consequenceReasons("addConstraint", { ...hard[0].args, check: { dimension: "x", comparator: "lte", limit: 1 } })).toEqual([]);
    expect(consequenceReasons("removeVariable", { id: "x" })[0]).toMatch(/removes, corrects, reassigns or re-judges/);
    expect(consequenceReasons("whatever", {})[0]).toMatch(/not a known mutation/);
    const bad = await h.svc.create({ modelId: h.model.id, request: [{ kind: "recordValue", args: { variableId: "nope", input: { value: 1, sourceType: "measured", confidence: 1 } } }], proposedBy: { kind: "person" } });
    const bw = describeProposal(bad);
    expect(bw.errors).toEqual([expect.stringMatching(/^Step 1: .*nope/)]);
    expect(bw.willNotChange).toBe("It cannot be applied, so nothing changes.");
    expect(bw.what).toEqual([]);
  });

  it("every status has a person-facing phrase", () => {
    const all: ProposalStatus[] = ["proposed", "reviewed", "applying", "applied", "failed", "rejected", "stale", "superseded"];
    for (const s of all) expect(STATUS_WORDS[s].length).toBeGreaterThan(3);
    expect(Object.keys(STATUS_WORDS).sort()).toEqual([...all].sort());
  });
});

describe("staleComparison", () => {
  it("is null for a fresh proposal; for a stale one it shows before, what changed since (the cited record's old and new wording), and now", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: [{ kind: "addHypothesis", args: { statement: "B follows A", confidence: 0.3 } }], proposedBy: { kind: "person" }, basis: [{ kind: "observation", id: "obs_a" }] });
    expect(staleComparison(p)).toBeNull();
    await h.svc.review(p.id);
    await h.models.save(M.updateObservation((await h.models.load(h.model.id)) as SystemModel, "obs_a", { statement: "Input A was read once" }));
    const stale = await h.svc.revalidate(p.id);
    const c = staleComparison(stale);
    expect(c).not.toBeNull();
    expect(c!.before.basis[0].text).toBe("Observation: “Input A was read twice this month” (2026-09).");
    expect(c!.now.basis[0].text).toBe("Observation: “Input A was read once” (2026-09).");
    expect(c!.changedSince).toEqual(["A cited record changed. It read: Observation: “Input A was read twice this month” (2026-09). It now reads: Observation: “Input A was read once” (2026-09)."]);
    expect(c!.before.what).toEqual(c!.now.what);
  });

  it("reports a proposal that can no longer be applied and one whose consequence class changed", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: [{ kind: "addObservation", args: { statement: "x", sourceType: "measured", confidence: 1 } }], proposedBy: { kind: "person" } });
    await h.svc.review(p.id);
    await h.models.save(M.addObservation((await h.models.load(h.model.id)) as SystemModel, { statement: "took the id", sourceType: "measured", confidence: 1 }));
    const c = staleComparison(await h.svc.revalidate(p.id))!;
    expect(c.changedSince[0]).toMatch(/^It can no longer be applied: Step 1: /);
    expect(c.changedSince).toContain("Would change no longer: Record observation “x”.");
  });
});
