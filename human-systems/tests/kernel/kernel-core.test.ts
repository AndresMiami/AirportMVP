/**
 * PROPOSAL / APPROVAL KERNEL — Step 1 core invariants, on a neutral domain
 * with every household module mocked to throw (the kernel must not need
 * one). Covers revision, shape refusal, materialization, dry-run, the
 * exhaustive mechanical diff, the consequence table and the review
 * fingerprint. The service (state machine, guarded commit, recovery) is
 * executed in kernel-service.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { applyBatch, canonicalJSON, checkShape, CONSEQUENTIAL_KINDS, consequenceOf, dryRun, entityDiff, isRegisteredKind, materialize, ORDINARY_KINDS, ProposalError, REGISTERED_KINDS, resolveBasis, reviewFingerprint, revisionOf, type MutationBatch } from "@/kernel";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { SystemModelSchema, type SystemModel } from "@/types";
import { KERNEL_NOW, seedNeutralSystem } from "../helpers/neutral-kernel-domain";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household/definition", armed("@/domains/household/definition"));
vi.mock("@/domains/household/keys", armed("@/domains/household/keys"));
vi.mock("@/domains/household/derived", armed("@/domains/household/derived"));
vi.mock("@/domains/household/calculations", armed("@/domains/household/calculations"));
vi.mock("@/domains/household/compounding", armed("@/domains/household/compounding"));
vi.mock("@/domains/household/income", armed("@/domains/household/income"));
vi.mock("@/domains/household/presentation", armed("@/domains/household/presentation"));
vi.mock("@/domains/household/explanation-catalogue", armed("@/domains/household/explanation-catalogue"));
vi.mock("@/domains/household/index", armed("@/domains/household/index"));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains/index", armed("@/domains/index"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));
vi.mock("@/features/household/income", armed("@/features/household/income"));

const clockAt = (iso: string) => ({ now: () => iso });
const T1 = "2026-09-16T13:00:00.000Z";
const T2 = "2026-09-17T09:30:00.000Z";

async function stored(): Promise<{ svc: ModelService; repo: MemoryModelRepository; model: SystemModel }> {
  const repo = new MemoryModelRepository();
  const svc = new ModelService(repo, { now: () => KERNEL_NOW, newId: () => "sys_kernel" });
  const model = await seedNeutralSystem(svc);
  return { svc, repo, model };
}

const OBS: MutationBatch = [{ kind: "addObservation", args: { statement: "B was low after A rose", sourceType: "self_reported", confidence: 0.6 } }];

describe("revision: exact canonical serialization minus updatedAt", () => {
  it("is independent of key order and of updatedAt, and differs for any content change", async () => {
    const { model } = await stored();
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(model).reverse()))) as SystemModel;
    expect(revisionOf(reordered)).toBe(revisionOf(model));
    expect(revisionOf({ ...model, updatedAt: "2030-01-01T00:00:00.000Z" })).toBe(revisionOf(model));
    expect(revisionOf(M.updateProfile(model, { description: "x" }))).not.toBe(revisionOf(model));
    expect(revisionOf(null)).toBeNull();
    // the revision IS the canonical text: no hashing, no truncation
    const { updatedAt: _u, ...rest } = model;
    void _u;
    expect(revisionOf(model)).toBe(canonicalJSON(rest));
    expect(canonicalJSON({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe("shape check: the registry refuses whole batches it cannot materialize", () => {
  it("rejects unregistered kinds (consequential mutations, reads) with a step-numbered report", () => {
    expect(isRegisteredKind("removeVariable")).toBe(false);
    expect(isRegisteredKind("readKillCriterion")).toBe(false);
    expect(REGISTERED_KINDS).toHaveLength(13);
    const batch = [OBS[0], { kind: "removeVariable", args: { id: "input_a" } }] as unknown as MutationBatch;
    expect(() => checkShape(batch)).toThrow(ProposalError);
    expect(() => checkShape(batch)).toThrow(/Step 2: mutation "removeVariable" is not registered/);
  });
  it("rejects non-JSON arguments, missing required keys and empty batches", () => {
    expect(() => checkShape([])).toThrow(/at least one step/);
    expect(() => checkShape([{ kind: "addObservation", args: { statement: "x", sourceType: "measured", confidence: 1, when: new Date() } } as never])).toThrow(/plain JSON/);
    expect(() => checkShape([{ kind: "addObservation", args: { statement: "x", sourceType: "measured", confidence: 1, f: () => 1 } } as never])).toThrow(/plain JSON/);
    expect(() => checkShape([{ kind: "addObservation", args: { statement: "x" } } as never])).toThrow(/Step 1 \(addObservation\): missing "sourceType"/);
    expect(() => checkShape([{ kind: "addObservation", args: { statement: "x", sourceType: "measured", confidence: Number.NaN } } as never])).toThrow(/plain JSON/);
    expect(() => checkShape([{ args: {} } as never])).toThrow(/no mutation kind/);
  });
});

describe("materialization freezes every implicit value", () => {
  it("assigns ids in sequence across steps and stamps clocks from the injected clock, keeping explicit ids", async () => {
    const { model } = await stored();
    const batch: MutationBatch = [
      OBS[0],
      { kind: "addObservation", args: { statement: "second", sourceType: "measured", confidence: 0.9 } },
      { kind: "recordValue", args: { variableId: "input_b", input: { value: 30, sourceType: "measured", confidence: 0.9 } } },
      { kind: "addHypothesis", args: { id: "hyp_explicit", statement: "B follows A", confidence: 0.3 } },
      { kind: "addKillCriterion", args: { hypothesisId: "hyp_1", input: { statement: "A rises while B stays" } } },
    ];
    const m1 = materialize(batch, model, clockAt(T1));
    expect(m1[0].args).toMatchObject({ id: "obs_1" });
    expect(m1[1].args).toMatchObject({ id: "obs_2" });
    expect(m1[2].args).toMatchObject({ input: { recordedAt: T1 } });
    expect(m1[3].args).toMatchObject({ id: "hyp_explicit" });
    expect(m1[4].args).toMatchObject({ input: { id: "hyp_1_kc_1" } });
    // materialization is pure: same inputs, same output; the clock is the only source of time
    expect(materialize(batch, model, clockAt(T1))).toEqual(m1);
    const m2 = materialize(batch, model, clockAt(T2));
    expect(m2[2].args).toMatchObject({ input: { recordedAt: T2 } });
    expect(canonicalJSON(batch)).toBe(canonicalJSON([OBS[0], batch[1], batch[2], batch[3], batch[4]])); // the request itself is untouched
  });

  it("two dry-runs of one materialized request are identical whatever the wall clock says", async () => {
    const { model } = await stored();
    const materialized = materialize([OBS[0], { kind: "recordValue", args: { variableId: "input_a", input: { value: 55, sourceType: "measured", confidence: 0.9 } } }], model, clockAt(T1));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(T1));
      const a = dryRun(materialized, model);
      vi.setSystemTime(new Date("2027-03-03T03:03:03.000Z"));
      const b = dryRun(materialized, model);
      expect(b).toEqual(a);
      expect(a.resultRevision).toBe(revisionOf(applyBatch(materialized, model)));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dry-run equals the direct mutation and never touches the repository", () => {
  it("produces the same result as applying the canonical mutations directly; the stored model is untouched", async () => {
    const { repo, model } = await stored();
    const saveSpy = vi.spyOn(repo, "save");
    const guardedSpy = vi.spyOn(repo, "saveIfRevision");
    const before = revisionOf(model);
    const materialized = materialize(OBS, model, clockAt(T1));
    const result = dryRun(materialized, model);
    const direct = M.addObservation(model, materialized[0].args as M.ObservationInput);
    expect(result.ok).toBe(true);
    expect(result.resultRevision).toBe(revisionOf(direct));
    expect(result.changes).toEqual([{ collection: "observations", id: "obs_1", op: "added", before: undefined, after: direct.observations.find((o) => o.id === "obs_1") }]);
    expect(result.nothingElseChanges).toBe(true);
    expect(result.alsoChanged).toEqual([]);
    expect(result.affected).toEqual({ observations: ["obs_1"] });
    expect(result.consequenceClass).toBe("ordinary");
    expect(result.semantic[0]).toMatchObject({ verb: "create", noun: "observation" });
    expect(result.semantic[0].summary).toContain("B was low after A rose");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(guardedSpy).not.toHaveBeenCalled();
    expect(revisionOf(await repo.load(model.id))).toBe(before);
    expect(revisionOf(model)).toBe(before); // the input model object is not mutated either
  });

  it("a failing step reports the step, yields no changes and no result revision; the mutation is the authority", async () => {
    const { model } = await stored();
    const batch: MutationBatch = [OBS[0], { kind: "linkObservation", args: { observationId: "obs_1", target: { kind: "variable", id: "no_such_variable" } } }];
    const materialized = materialize(batch, model, clockAt(T1));
    const result = dryRun(materialized, model);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].step).toBe(2);
    expect(result.errors[0].message).toMatch(/no_such_variable/);
    expect(result.changes).toEqual([]);
    expect(result.resultRevision).toBeNull();
    expect(result.nothingElseChanges).toBe(false);
    expect(() => applyBatch(materialized, model)).toThrow(M.MutationError);
  });

  it("registry shape passes what the mutation refuses: a duplicate relationship is caught in dry-run, not by the registry", async () => {
    const { model } = await stored();
    const batch: MutationBatch = [{ kind: "addRelationship", args: { sourceVariableId: "input_a", targetVariableId: "input_b", direction: "negative", strength: 0.2, lag: { value: 0, unit: "days" }, confidence: 0.5, sourceType: "self_reported", kind: "causal_hypothesis" } }];
    expect(() => checkShape(batch)).not.toThrow();
    const r = dryRun(materialize(batch, model, clockAt(T1)), model);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/already exists/);
  });

  it("recordValue exposes the derived entry id as an expected output and carries an unassigned-variable warning only when warranted", async () => {
    const { model } = await stored();
    const r = dryRun(materialize([{ kind: "recordValue", args: { variableId: "input_b", input: { value: 30, sourceType: "measured", confidence: 0.9 } } }], model, clockAt(T1)), model);
    expect(r.ok).toBe(true);
    expect(r.expectedOutputs).toEqual({ "step1.valueEntry0": "input_b__v2" });
    expect(r.warnings).toEqual([]);
    const u = dryRun(materialize([{ kind: "addVariable", args: { name: "Loose", category: "buffer", changeSpeed: "fast", unit: "u", subjectId: null } }], model, clockAt(T1)), model);
    expect(u.ok).toBe(true);
    expect(u.warnings).toEqual(["The variable is unassigned; it feeds no calculation until a subject is assigned."]);
    expect(u.semantic[0].subject).toBe("unassigned");
  });
});

describe("the mechanical diff is exhaustive", () => {
  it("addMember also materializes the member-scope derived shell: the diff shows it and nothingElseChanges is false", async () => {
    const { model } = await stored();
    const r = dryRun(materialize([{ kind: "addMember", args: { label: "Part two" } }], model, clockAt(T1)), model);
    expect(r.ok).toBe(true);
    expect(r.changes.map((c) => `${c.collection}:${c.id}:${c.op}`)).toEqual(["profile.members:member_1:added", "variables:part_share@member_1:added"]);
    expect(r.nothingElseChanges).toBe(false);
    expect(r.alsoChanged).toHaveLength(1);
    expect(r.alsoChanged[0]).toMatch(/Part share/);
    expect(r.affected).toEqual({ "profile.members": ["member_1"], variables: ["part_share@member_1"] });
  });

  it("covers every collection of the model, including the profile singleton, collections envelopes and identity fields", async () => {
    const { model } = await stored();
    const touched = (b: SystemModel, a: SystemModel) => entityDiff(b, a).map((c) => `${c.collection}:${c.id}:${c.op}`);
    expect(touched(model, M.updateProfile(model, { description: "n" }))).toEqual(["profile:profile:modified"]);
    expect(touched(model, M.updateMember(model, "p1", { label: "Renamed" }))).toEqual(["profile.members:p1:modified"]);
    expect(touched(model, M.removeObservation(model, "obs_a"))).toEqual(["observations:obs_a:removed"]);
    expect(touched(model, M.updateHypothesis(model, "hyp_1", { notes: "x" }))).toEqual(["hypotheses:hyp_1:modified"]);
    expect(touched(model, M.setRelationshipEnabled(model, "rel_ab", false))).toEqual(["relationships:rel_ab:modified"]);
    expect(touched(model, M.recordTarget(model, "input_a", { desiredValue: 70, recordedAt: T1 }))).toEqual(["variables:input_a:modified"]);
    expect(touched(model, { ...model, createdAt: "2020-01-01T00:00:00.000Z" })).toEqual(["identity:identity:modified"]);
    expect(touched(model, { ...model, updatedAt: "2031-01-01T00:00:00.000Z" })).toEqual([]);
    expect(touched(model, model)).toEqual([]);
  });

  it("PIN: the diff covers every top-level model key except updatedAt — a schema addition must extend entityDiff", () => {
    const covered = ["schemaVersion", "id", "domainDefinitionId", "domainDefinitionVersion", "createdAt", "profile", "variables", "collections", "relationships", "events", "loopAnnotations", "constraints", "actions", "observations", "hypotheses", "signatures", "utilityWeights", "currentAttractor", "desiredAttractor"];
    const keys = Object.keys(SystemModelSchema.shape).filter((k) => k !== "updatedAt");
    expect([...keys].sort()).toEqual([...covered].sort());
  });
});

describe("consequence classification is a pinned table, never the proposer's choice", () => {
  it("names every canonical write mutation exactly once; readKillCriterion is absent; setKillCriterionStatus is consequential", () => {
    const all = new Set([...ORDINARY_KINDS, ...CONSEQUENTIAL_KINDS]);
    for (const k of ORDINARY_KINDS) expect(CONSEQUENTIAL_KINDS.has(k)).toBe(false);
    for (const k of all) expect(typeof (M as Record<string, unknown>)[k], k).toBe("function");
    expect(all.has("readKillCriterion")).toBe(false);
    expect(CONSEQUENTIAL_KINDS.has("setKillCriterionStatus")).toBe(true);
    for (const k of REGISTERED_KINDS) expect(ORDINARY_KINDS.has(k), k).toBe(true);
    // every exported model-writing mutation is classified (reads and helpers excluded by name)
    const writers = Object.entries(M)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .filter((k) => !["MutationError", "nextId", "slugId", "collectionProblems", "collectionItems", "unresolvedCollections", "currentValueOf", "currentTargetOf", "memberReferences", "readKillCriterion", "ensureDerivedShells", "ensureLoopHypothesis", "nextSignatureId"].includes(k));
    for (const k of writers) expect(all.has(k), `${k} is unclassified`).toBe(true);
  });

  it("classifies by content: a hard constraint without a check, a hypothesis statement change and any unknown kind are consequential", async () => {
    const { model } = await stored();
    expect(consequenceOf("addConstraint", { name: "c", type: "hard", sourceType: "self_reported", confidence: 1 }, model)).toBe("consequential");
    expect(consequenceOf("addConstraint", { name: "c", type: "hard", sourceType: "self_reported", confidence: 1, check: { dimension: "x", comparator: "lte", limit: 1 } }, model)).toBe("ordinary");
    expect(consequenceOf("addConstraint", { name: "c", type: "soft", sourceType: "self_reported", confidence: 1 }, model)).toBe("ordinary");
    expect(consequenceOf("updateHypothesis", { id: "hyp_1", patch: { statement: "changed" } }, model)).toBe("consequential");
    expect(consequenceOf("updateHypothesis", { id: "hyp_1", patch: { notes: "n" } }, model)).toBe("ordinary");
    expect(consequenceOf("readKillCriterion", {}, model)).toBe("consequential");
    expect(consequenceOf("somethingNew", {}, model)).toBe("consequential");
    const r = dryRun(materialize([OBS[0], { kind: "addConstraint", args: { name: "Never below 10", type: "hard", sourceType: "self_reported", confidence: 1 } }], model, clockAt(T1)), model);
    expect(r.consequenceClass).toBe("consequential");
  });
});

describe("review fingerprint: what the person reviewed, not just the mutation result", () => {
  it("PINNED: a proposal based on observation A goes stale when A's statement changes although the mutation diff is identical", async () => {
    const { model } = await stored();
    const materialized = materialize([{ kind: "addHypothesis", args: { statement: "B follows A with a lag", confidence: 0.3 } }], model, clockAt(T1));
    const basis = [{ kind: "observation" as const, id: "obs_a" }];
    const p1 = dryRun(materialized, model);
    const fp1 = reviewFingerprint(materialized, p1, resolveBasis(model, basis));
    const changed = M.updateObservation(model, "obs_a", { statement: "Input A was read ONCE this month" });
    const p2 = dryRun(materialized, changed);
    expect(p2.changes).toEqual(p1.changes); // identical mutation diff
    expect(p2.semantic).toEqual(p1.semantic);
    const fp2 = reviewFingerprint(materialized, p2, resolveBasis(changed, basis));
    expect(fp2).not.toBe(fp1);
    // and the same change with NO basis on obs_a leaves the fingerprint intact
    expect(reviewFingerprint(materialized, p2, resolveBasis(changed, []))).toBe(reviewFingerprint(materialized, p1, resolveBasis(model, [])));
  });

  it("resolves a basis to current content (null when the referent is gone) and a pattern basis to its occurrence times", async () => {
    const { model } = await stored();
    const r = resolveBasis(model, [
      { kind: "observation", id: "obs_a" },
      { kind: "observation", id: "obs_missing" },
      { kind: "user_statement", text: "I think A matters" },
      { kind: "pattern", ref: { variableId: "input_a", subjectId: model.id, interval: { from: "2026-01-01", to: "2026-12-31" }, repeatedValue: 50, occurrenceTimes: [] }, summary: "A read 50" },
    ]);
    expect(r[0].content).toMatchObject({ id: "obs_a", statement: "Input A was read twice this month" });
    expect(r[1].content).toBeNull();
    expect(r[2].content).toEqual({ kind: "user_statement", text: "I think A matters" });
    expect(r[3].content).toEqual({ subjectId: model.id, occurrences: null }); // one reading is not a repetition
  });
});
