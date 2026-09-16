/**
 * PROPOSAL / APPROVAL KERNEL — the service: state machine, revalidation
 * against the STORED model, the guarded two-phase approval, startup
 * recovery of "applying" proposals, provenance, and the ledger
 * repositories. Neutral domain; every household module mocked to throw.
 *
 * Invariants executed here:
 *   - canonical state changes ONLY after the guarded save succeeds;
 *   - reviewed request = materialized request = dry-run request = approval request;
 *   - a stale or conflicting approval writes NOTHING to the model;
 *   - recovery reconciles from the stored revision, never from a guess.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalStorageProposalRepository, MemoryProposalRepository, PROPOSALS_KEY, ProposalError, ProposalService, revisionOf, type MutationBatch, type MutationProposal } from "@/kernel";
import { LocalStorageModelRepository, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService, RevisionConflictError } from "@/services/model-service";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";
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

const OBS: MutationBatch = [{ kind: "addObservation", args: { statement: "B was low after A rose", sourceType: "self_reported", confidence: 0.6 } }];
const HYP: MutationBatch = [{ kind: "addHypothesis", args: { statement: "B follows A with a lag", confidence: 0.3 } }];

interface Harness {
  models: ModelService;
  repo: MemoryModelRepository;
  ledger: MemoryProposalRepository;
  svc: ProposalService;
  model: SystemModel;
  tick: () => void;
}

/** A ticking clock so every review record and commit stamp is distinct and deterministic. */
async function harness(): Promise<Harness> {
  let t = 0;
  const now = () => new Date(Date.parse(KERNEL_NOW) + t * 60_000).toISOString();
  const repo = new MemoryModelRepository();
  const models = new ModelService(repo, { now, newId: () => "sys_kernel" });
  const model = await seedNeutralSystem(models);
  const ledger = new MemoryProposalRepository();
  let n = 0;
  const svc = new ProposalService(ledger, models, { now }, () => `prop_${++n}`);
  return { models, repo, ledger, svc, model, tick: () => (t += 1) };
}

const storedRevision = async (h: Harness) => revisionOf(await h.repo.load(h.model.id));

describe("create: materialize + dry-run + fingerprint; the model is untouched", () => {
  it("stores a proposed record with frozen materialization, preview, both revisions and a review trail; writes nothing to the model", async () => {
    const h = await harness();
    const base = await storedRevision(h);
    const save = vi.spyOn(h.repo, "save");
    const guarded = vi.spyOn(h.repo, "saveIfRevision");
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" }, rationale: "seen twice", basis: [{ kind: "observation", id: "obs_a" }] });
    expect(p.status).toBe("proposed");
    expect(p.id).toBe("prop_1");
    expect(p.request).toEqual(OBS);
    expect(p.materialized[0].args).toMatchObject({ id: "obs_1" });
    expect(p.createdAgainstRevision).toBe(base);
    expect(p.lastValidatedRevision).toBe(base);
    expect(p.preview.ok).toBe(true);
    expect(p.preview.resultRevision).not.toBe(base);
    expect(p.consequenceClass).toBe("ordinary");
    expect(p.resolvedBasis[0].content).toMatchObject({ id: "obs_a" });
    expect(p.review).toEqual([{ at: expect.any(String), status: "proposed", by: "person", note: "" }]);
    expect(p.commit).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(guarded).not.toHaveBeenCalled();
    expect(await storedRevision(h)).toBe(base);
    expect((await h.ledger.get("prop_1"))?.reviewFingerprint).toBe(p.reviewFingerprint);
  });

  it("refuses an unsupported kind for the WHOLE set with a report and records nothing", async () => {
    const h = await harness();
    await expect(h.svc.create({ modelId: h.model.id, request: [OBS[0], { kind: "removeObservation", args: { id: "obs_a" } } as never], proposedBy: { kind: "ai", adapterId: "test-adapter" } })).rejects.toThrow(/Step 2: mutation "removeObservation" is not registered/);
    expect(await h.svc.list(h.model.id)).toEqual([]);
  });

  it("an invalid proposal is stored with its errors and can never be approved", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: [{ kind: "recordValue", args: { variableId: "nope", input: { value: 1, sourceType: "measured", confidence: 1 } } }], proposedBy: { kind: "person" } });
    expect(p.preview.ok).toBe(false);
    await h.svc.review(p.id);
    const r = await h.svc.approve(p.id);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("invalid");
    expect((await h.svc.get(p.id)).status).toBe("reviewed");
  });
});

describe("state machine", () => {
  it("proposed -> reviewed -> applied; approve is refused from proposed; applied is terminal", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    const early = await h.svc.approve(p.id);
    expect(early.ok).toBe(false);
    expect(early.ok === false && early.reason).toBe("not_reviewable");
    expect((await h.svc.get(p.id)).status).toBe("proposed");
    const reviewed = await h.svc.review(p.id, "looks right");
    expect(reviewed.status).toBe("reviewed");
    expect(reviewed.review.at(-1)).toMatchObject({ status: "reviewed", by: "person", note: "looks right" });
    const r = await h.svc.approve(p.id, "go");
    expect(r.ok).toBe(true);
    const applied = await h.svc.get(p.id);
    expect(applied.status).toBe("applied");
    expect(applied.review.map((x) => x.status)).toEqual(["proposed", "reviewed", "applying", "applied"]);
    await expect(h.svc.reject(p.id)).rejects.toThrow(ProposalError);
    await expect(h.svc.review(p.id)).rejects.toThrow(/applied and cannot be reviewed/);
    await expect(h.svc.edit(p.id, HYP)).rejects.toThrow(ProposalError);
    expect((await h.svc.approve(p.id)).ok).toBe(false);
  });

  it("reject from proposed or reviewed; edit supersedes with a NEW proposal; stale can be reviewed again", async () => {
    const h = await harness();
    const a = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    expect((await h.svc.reject(a.id, "no")).status).toBe("rejected");
    await expect(h.svc.reject(a.id)).rejects.toThrow(/rejected and cannot be rejected/);
    const b = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" }, rationale: "why", basis: [{ kind: "user_statement", text: "said so" }] });
    const { superseded, proposal } = await h.svc.edit(b.id, HYP, "changed my mind");
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBe(proposal.id);
    expect(proposal.id).not.toBe(b.id);
    expect(proposal.status).toBe("proposed");
    expect(proposal.request).toEqual(HYP);
    expect(proposal.rationale).toBe("why");
    expect(proposal.basis).toEqual(b.basis);
    expect(proposal.proposedBy).toEqual({ kind: "person" });
    expect(await storedRevision(h)).toBe(revisionOf(h.model));
    // stale -> review again -> reviewed -> approve succeeds
    await h.svc.review(proposal.id);
    const changed = M.updateObservation(await h.models.load(h.model.id) as SystemModel, "obs_a", { statement: "different" });
    await h.models.save(changed);
    const c = await h.svc.create({ modelId: h.model.id, request: HYP, proposedBy: { kind: "person" }, basis: [{ kind: "observation", id: "obs_a" }] });
    await h.svc.review(c.id);
    await h.models.save(M.updateObservation(await h.models.load(h.model.id) as SystemModel, "obs_a", { statement: "different again" }));
    expect((await h.svc.revalidate(c.id)).status).toBe("stale");
    expect((await h.svc.review(c.id)).status).toBe("reviewed");
    expect((await h.svc.approve(c.id)).ok).toBe(true);
  });
});

describe("revalidation against the stored model", () => {
  it("PINNED: basis observation A's statement changes, mutation diff identical -> stale, with the previous preview kept", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: HYP, proposedBy: { kind: "person" }, basis: [{ kind: "observation", id: "obs_a" }] });
    await h.svc.review(p.id);
    await h.models.save(M.updateObservation(await h.models.load(h.model.id) as SystemModel, "obs_a", { statement: "Input A was read ONCE this month" }));
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("stale");
    expect(r.previousPreview?.changes).toEqual(r.preview.changes); // identical mutation diff
    expect(r.preview.ok).toBe(true);
    expect(r.reviewFingerprint).not.toBe(p.reviewFingerprint);
    expect(r.resolvedBasis[0].content).toMatchObject({ statement: "Input A was read ONCE this month" });
    expect(r.createdAgainstRevision).toBe(p.createdAgainstRevision); // immutable
    expect(r.lastValidatedRevision).toBe(await storedRevision(h));
    expect(r.review.at(-1)).toMatchObject({ status: "stale", by: "kernel" });
    const a = await h.svc.approve(p.id);
    expect(a.ok).toBe(false);
    expect(a.ok === false && a.reason).toBe("stale");
  });

  it("an unrelated change advances lastValidatedRevision only; the same revision is a no-op", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: HYP, proposedBy: { kind: "person" }, basis: [{ kind: "observation", id: "obs_a" }] });
    const reviewed = await h.svc.review(p.id);
    expect(await h.svc.revalidate(p.id)).toEqual(reviewed);
    await h.models.save(M.recordTarget(await h.models.load(h.model.id) as SystemModel, "input_b", { desiredValue: 20, recordedAt: KERNEL_NOW }));
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("reviewed");
    expect(r.reviewFingerprint).toBe(p.reviewFingerprint);
    expect(r.lastValidatedRevision).toBe(await storedRevision(h));
    expect(r.lastValidatedRevision).not.toBe(p.lastValidatedRevision);
    expect(r.createdAgainstRevision).toBe(p.createdAgainstRevision);
    expect(r.previousPreview).toBeNull();
    expect(r.review.at(-1)?.note).toMatch(/unaffected/);
    expect((await h.svc.approve(p.id)).ok).toBe(true);
  });

  it("a change that makes the request unapplicable (its frozen id taken) goes stale with the errors, never silently re-materialized", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    await h.svc.review(p.id);
    await h.models.save(M.addObservation(await h.models.load(h.model.id) as SystemModel, { statement: "someone else's", sourceType: "measured", confidence: 1 }));
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("stale");
    expect(r.preview.ok).toBe(false);
    expect(r.materialized).toEqual(p.materialized);
    expect(r.review.at(-1)?.note).toMatch(/can no longer be applied/);
  });
});

describe("approve: guarded two-phase commit", () => {
  it("success: applying (expected revisions) -> guarded save -> applied (actual revision, approval, affected ids); model updatedAt is commit metadata", async () => {
    const h = await harness();
    const base = await storedRevision(h);
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    await h.svc.review(p.id);
    const puts: string[] = [];
    const orig = h.ledger.put.bind(h.ledger);
    vi.spyOn(h.ledger, "put").mockImplementation(async (x) => {
      puts.push(`${x.status}:${revisionOf(await h.repo.load(h.model.id)) === base ? "model@base" : "model@result"}`);
      return orig(x);
    });
    h.tick();
    const r = await h.svc.approve(p.id, "approved");
    expect(r.ok).toBe(true);
    // the ledger records intent BEFORE the model moves and completion AFTER
    expect(puts).toEqual(["applying:model@base", "applied:model@result"]);
    const stored = (await h.repo.load(h.model.id)) as SystemModel;
    expect(revisionOf(stored)).toBe(p.preview.resultRevision);
    expect(stored.observations.map((o) => o.id)).toEqual(["obs_a", "obs_1"]);
    expect(stored.updatedAt).not.toBe(h.model.updatedAt);
    const applied = await h.svc.get(p.id);
    expect(applied.commit).toEqual({ expectedBaseRevision: base, expectedResultRevision: p.preview.resultRevision, actualResultRevision: revisionOf(stored), approvedAt: expect.any(String), affectedIds: ["observations:obs_1"] });
    expect(applied.review.filter((x) => x.status === "applying")[0]).toMatchObject({ by: "person", note: "approved" });
    expect(r.ok && r.model).toEqual(stored);
  });

  it("the model changes between review and approval -> stale, nothing written, the foreign change survives", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: HYP, proposedBy: { kind: "person" }, basis: [{ kind: "observation", id: "obs_a" }] });
    await h.svc.review(p.id);
    const foreign = await h.models.save(M.updateObservation(await h.models.load(h.model.id) as SystemModel, "obs_a", { statement: "edited elsewhere" }));
    const guarded = vi.spyOn(h.repo, "saveIfRevision");
    const r = await h.svc.approve(p.id);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("stale");
    expect(guarded).not.toHaveBeenCalled();
    expect(await storedRevision(h)).toBe(revisionOf(foreign));
    expect((await h.svc.get(p.id)).status).toBe("stale");
    expect((await h.svc.get(p.id)).commit).toBeNull();
  });

  it("a write that lands between phase 1 and the guarded save -> conflict, failed, nothing overwritten", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    await h.svc.review(p.id);
    // simulate another tab writing right after the ledger says "applying"
    const origPut = h.ledger.put.bind(h.ledger);
    let intruded: SystemModel | null = null;
    vi.spyOn(h.ledger, "put").mockImplementation(async (x) => {
      await origPut(x);
      if (x.status === "applying") intruded = await h.models.save(M.updateProfile((await h.models.load(h.model.id)) as SystemModel, { description: "intruder" }));
    });
    const r = await h.svc.approve(p.id);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("conflict");
    expect(r.ok === false && r.message).toMatch(/nothing was written/);
    expect(await storedRevision(h)).toBe(revisionOf(intruded));
    const failed = await h.svc.get(p.id);
    expect(failed.status).toBe("failed");
    expect(failed.commit?.actualResultRevision).toBeNull();
    expect(((await h.repo.load(h.model.id)) as SystemModel).observations.map((o) => o.id)).toEqual(["obs_a"]);
  });

  it("persistence failure -> failed with the reason, model unchanged, no React-facing model returned", async () => {
    const h = await harness();
    const base = await storedRevision(h);
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    await h.svc.review(p.id);
    vi.spyOn(h.repo, "saveIfRevision").mockRejectedValueOnce(new Error("QuotaExceededError"));
    const r = await h.svc.approve(p.id);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("persist_failed");
    expect(r.ok === false && r.message).toMatch(/QuotaExceededError/);
    expect(await storedRevision(h)).toBe(base);
    expect((await h.svc.get(p.id)).status).toBe("failed");
    expect("model" in r).toBe(false);
  });

  it("approval applies EXACTLY the materialized request reviewed: the stored result equals the preview's result revision", async () => {
    const h = await harness();
    const batch: MutationBatch = [
      OBS[0],
      { kind: "addHypothesis", args: { statement: "B follows A", confidence: 0.3 } },
      { kind: "attachObservationToHypothesis", args: { hypothesisId: "hyp_2", observationId: "obs_1", role: "supporting" } },
      { kind: "recordValue", args: { variableId: "input_b", input: { value: 31, sourceType: "measured", confidence: 0.9 } } },
    ];
    const p = await h.svc.create({ modelId: h.model.id, request: batch, proposedBy: { kind: "person" } });
    expect(p.preview.ok).toBe(true);
    expect(p.preview.nothingElseChanges).toBe(true);
    await h.svc.review(p.id);
    const r = await h.svc.approve(p.id);
    expect(r.ok).toBe(true);
    const stored = (await h.repo.load(h.model.id)) as SystemModel;
    expect(revisionOf(stored)).toBe(p.preview.resultRevision);
    expect(stored.hypotheses.find((x) => x.id === "hyp_2")?.supportingObservationIds).toEqual(["obs_1"]);
    expect(stored.variables.find((v) => v.id === "input_b")?.values.at(-1)).toMatchObject({ value: 31, recordedAt: expect.any(String) });
    expect((await h.svc.get(p.id)).commit?.affectedIds).toEqual(["variables:input_b", "observations:obs_1", "hypotheses:hyp_2"]);
  });
});

describe("failed proposals leave only through an EXPLICIT retry", () => {
  async function failedAfterPersistence(h: Harness) {
    const p = await h.svc.create({ modelId: h.model.id, request: HYP, proposedBy: { kind: "person" }, basis: [{ kind: "observation", id: "obs_a" }] });
    await h.svc.review(p.id);
    vi.spyOn(h.repo, "saveIfRevision").mockRejectedValueOnce(new Error("QuotaExceededError"));
    const r = await h.svc.approve(p.id);
    expect(r.ok).toBe(false);
    expect((await h.svc.get(p.id)).status).toBe("failed");
    return p;
  }

  it("the kernel never retries on its own: revalidate leaves failed alone, review and approve refuse it", async () => {
    const h = await harness();
    const p = await failedAfterPersistence(h);
    const guarded = vi.spyOn(h.repo, "saveIfRevision");
    guarded.mockClear();
    expect((await h.svc.revalidate(p.id)).status).toBe("failed");
    await expect(h.svc.review(p.id)).rejects.toThrow(/failed and cannot be reviewed/);
    const a = await h.svc.approve(p.id);
    expect(a.ok).toBe(false);
    expect(a.ok === false && a.reason).toBe("not_reviewable");
    expect(guarded).not.toHaveBeenCalled();
    expect((await h.svc.get(p.id)).status).toBe("failed");
    expect((await h.svc.get(p.id)).commit).not.toBeNull(); // the failed attempt's expectations are kept until a retry
  });

  it("retry with the review material unchanged -> reviewed again (commit record dropped), then approve succeeds", async () => {
    const h = await harness();
    const base = await storedRevision(h);
    const p = await failedAfterPersistence(h);
    const r = await h.svc.retry(p.id);
    expect(r.status).toBe("reviewed");
    expect(r.commit).toBeNull();
    expect(r.reviewFingerprint).toBe(p.reviewFingerprint);
    expect(r.lastValidatedRevision).toBe(base);
    expect(r.review.at(-1)).toMatchObject({ status: "reviewed", by: "person" });
    expect(r.review.at(-1)?.note).toMatch(/retry/);
    expect(await storedRevision(h)).toBe(base); // the retry itself writes nothing
    const a = await h.svc.approve(p.id);
    expect(a.ok).toBe(true);
    expect(await storedRevision(h)).toBe(p.preview.resultRevision);
  });

  it("retry after the review material changed -> stale with the previous preview and basis kept; approve stays unavailable", async () => {
    const h = await harness();
    const p = await failedAfterPersistence(h);
    await h.models.save(M.updateObservation((await h.models.load(h.model.id)) as SystemModel, "obs_a", { statement: "corrected since" }));
    const r = await h.svc.retry(p.id);
    expect(r.status).toBe("stale");
    expect(r.commit).toBeNull();
    expect(r.previousPreview).toEqual(p.preview);
    expect(r.previousResolvedBasis).toEqual(p.resolvedBasis);
    expect(r.resolvedBasis[0].content).toMatchObject({ statement: "corrected since" });
    expect((await h.svc.approve(p.id)).ok).toBe(false);
    await expect(h.svc.retry(p.id)).rejects.toThrow(/only a failed proposal can be retried/);
    expect((await h.svc.review(p.id)).status).toBe("reviewed");
    expect((await h.svc.approve(p.id)).ok).toBe(true);
  });

  it("a failed proposal can still be rejected or replaced by an edit; a commit that never landed retries the same way", async () => {
    const h = await harness();
    const a = await failedAfterPersistence(h);
    expect((await h.svc.reject(a.id, "give up")).status).toBe("rejected");
    const b = await failedAfterPersistence(h);
    const { superseded, proposal } = await h.svc.edit(b.id, OBS);
    expect(superseded.status).toBe("superseded");
    expect(proposal.status).toBe("proposed");
    // commit-never-landed (from recovery) -> retry -> reviewed
    const c = await h.svc.create({ modelId: h.model.id, request: [{ kind: "addDisconfirmingCondition", args: { hypothesisId: "hyp_1", condition: "A rises while B stays" } }], proposedBy: { kind: "person" } });
    await h.ledger.put({ ...c, status: "applying", commit: { expectedBaseRevision: await storedRevision(h), expectedResultRevision: c.preview.resultRevision, actualResultRevision: null, approvedAt: null, affectedIds: [] } });
    expect((await h.svc.recover(h.model.id))[0]?.outcome).toBe("commit_never_landed");
    expect((await h.svc.retry(c.id)).status).toBe("reviewed");
    expect((await h.svc.approve(c.id)).ok).toBe(true);
  });

  it("the status vocabulary has no unused approved state: the successful sequence is proposed -> reviewed -> applying -> applied", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    await h.svc.review(p.id);
    await h.svc.approve(p.id);
    expect((await h.svc.get(p.id)).review.map((r) => r.status)).toEqual(["proposed", "reviewed", "applying", "applied"]);
    const src = readFileSync(path.join(process.cwd(), "src/kernel/types.ts"), "utf8");
    expect(src).not.toMatch(/"approved"/);
  });
});

describe("startup recovery of proposals stranded in applying", () => {
  async function stranded(h: Harness): Promise<MutationProposal> {
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    const base = await storedRevision(h);
    const applying: MutationProposal = { ...p, status: "applying", commit: { expectedBaseRevision: base as string, expectedResultRevision: p.preview.resultRevision as string, actualResultRevision: null, approvedAt: null, affectedIds: [] }, review: [...p.review, { at: KERNEL_NOW, status: "applying", by: "person", note: "" }] };
    await h.ledger.put(applying);
    return applying;
  }

  it("current == expectedResultRevision -> reconciled to applied", async () => {
    const h = await harness();
    const p = await stranded(h);
    await h.models.save(M.addObservation((await h.models.load(h.model.id)) as SystemModel, p.materialized[0].args as M.ObservationInput));
    expect(await h.svc.recover(h.model.id)).toEqual([{ proposalId: p.id, outcome: "reconciled_applied" }]);
    const r = await h.svc.get(p.id);
    expect(r.status).toBe("applied");
    expect(r.commit?.actualResultRevision).toBe(await storedRevision(h));
    expect(r.commit?.affectedIds).toEqual(["observations:obs_1"]);
    expect(r.review.at(-1)?.note).toMatch(/carries the approved change/);
  });

  it("current == expectedBaseRevision -> the commit never landed; failed and reviewable again", async () => {
    const h = await harness();
    const p = await stranded(h);
    expect(await h.svc.recover(h.model.id)).toEqual([{ proposalId: p.id, outcome: "commit_never_landed" }]);
    const r = await h.svc.get(p.id);
    expect(r.status).toBe("failed");
    expect(r.commit).toBeNull();
    expect(r.review.at(-1)?.note).toMatch(/never landed/);
  });

  it("anything else -> recovery conflict, failed, inspection needed; nothing is written to the model", async () => {
    const h = await harness();
    const p = await stranded(h);
    const other = await h.models.save(M.updateProfile((await h.models.load(h.model.id)) as SystemModel, { description: "elsewhere" }));
    const guarded = vi.spyOn(h.repo, "saveIfRevision");
    expect(await h.svc.recover(h.model.id)).toEqual([{ proposalId: p.id, outcome: "conflict" }]);
    expect((await h.svc.get(p.id)).status).toBe("failed");
    expect((await h.svc.get(p.id)).review.at(-1)?.note).toMatch(/recovery conflict/);
    expect(guarded).not.toHaveBeenCalled();
    expect(await storedRevision(h)).toBe(revisionOf(other));
  });

  it("recovery leaves every other status alone", async () => {
    const h = await harness();
    const a = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "person" } });
    await h.svc.review(a.id);
    expect(await h.svc.recover(h.model.id)).toEqual([]);
    expect((await h.svc.get(a.id)).status).toBe("reviewed");
  });
});

describe("provenance", () => {
  it("an AI-authored proposal keeps the observation's own sourceType; the author lives in the ledger, never in the model", async () => {
    const h = await harness();
    const p = await h.svc.create({ modelId: h.model.id, request: OBS, proposedBy: { kind: "ai", adapterId: "adapter-x", conversationTurnId: "turn-9" }, rationale: "the person said so in turn 9" });
    expect(p.review[0]).toMatchObject({ status: "proposed", by: "kernel" });
    await h.svc.review(p.id);
    const r = await h.svc.approve(p.id);
    expect(r.ok).toBe(true);
    const stored = (await h.repo.load(h.model.id)) as SystemModel;
    const obs = stored.observations.find((o) => o.id === "obs_1");
    expect(obs?.sourceType).toBe("self_reported");
    expect(JSON.stringify(stored)).not.toContain("adapter-x");
    expect((await h.svc.get(p.id)).proposedBy).toEqual({ kind: "ai", adapterId: "adapter-x", conversationTurnId: "turn-9" });
  });
});

describe("ModelService.saveIfRevision and the repositories' guarded primitive", () => {
  it("writes only when the stored revision matches; a conflict throws and writes nothing; validation still applies", async () => {
    const repo = new MemoryModelRepository();
    const models = new ModelService(repo, { now: () => KERNEL_NOW, newId: () => "sys_kernel" });
    const model = await seedNeutralSystem(models);
    const base = revisionOf(model) as string;
    const next = M.updateProfile(model, { description: "guarded" });
    const written = await models.saveIfRevision(next, base, revisionOf);
    expect(written.updatedAt).toBe(KERNEL_NOW);
    expect(revisionOf(await repo.load(model.id))).toBe(revisionOf(next));
    await expect(models.saveIfRevision(M.updateProfile(model, { description: "late" }), base, revisionOf)).rejects.toThrow(RevisionConflictError);
    expect(revisionOf(await repo.load(model.id))).toBe(revisionOf(next));
    await expect(models.saveIfRevision({ ...next, variables: [{ bad: true }] } as unknown as SystemModel, revisionOf(next), revisionOf)).rejects.toThrow();
    expect(revisionOf(await repo.load(model.id))).toBe(revisionOf(next));
    // null = "no such model yet"
    const fresh = { ...model, id: "sys_other" };
    expect(await repo.saveIfRevision(fresh, null, revisionOf)).toEqual({ ok: true });
    expect(await repo.saveIfRevision(fresh, null, revisionOf)).toEqual({ ok: false, currentRevision: revisionOf(fresh) });
  });

  it("LocalStorageModelRepository: read-compare-write in one turn; an unreadable stored model never matches", async () => {
    const storage = new FakeStorage();
    const repo = new LocalStorageModelRepository(storage);
    const models = new ModelService(repo, { now: () => KERNEL_NOW, newId: () => "sys_kernel" });
    const model = await seedNeutralSystem(models);
    const base = revisionOf(model) as string;
    expect(await repo.saveIfRevision(M.updateProfile(model, { description: "a" }), "wrong", revisionOf)).toEqual({ ok: false, currentRevision: base });
    expect(await repo.saveIfRevision(M.updateProfile(model, { description: "a" }), base, revisionOf)).toEqual({ ok: true });
    expect((await repo.load(model.id))?.profile.description).toBe("a");
    const raw = JSON.parse(storage.getItem("human-systems.store.v2") as string) as { models: Record<string, unknown> };
    raw.models[model.id] = { garbage: true };
    storage.setItem("human-systems.store.v2", JSON.stringify(raw));
    const r = await repo.saveIfRevision(model, base, revisionOf);
    expect(r).toEqual({ ok: false, currentRevision: `unreadable:${model.id}` });
  });

  it("LocalStorageProposalRepository round-trips and refuses to write over an unreadable ledger", async () => {
    const storage = new FakeStorage();
    const ledger = new LocalStorageProposalRepository(storage);
    const models = new ModelService(new MemoryModelRepository(), { now: () => KERNEL_NOW, newId: () => "sys_kernel" });
    const model = await seedNeutralSystem(models);
    const svc = new ProposalService(ledger, models, { now: () => KERNEL_NOW }, () => "prop_ls");
    const p = await svc.create({ modelId: model.id, request: OBS, proposedBy: { kind: "person" } });
    expect(await ledger.get("prop_ls")).toEqual(p);
    expect(await ledger.list(model.id)).toEqual([p]);
    expect(await ledger.list("other")).toEqual([]);
    storage.setItem(PROPOSALS_KEY, "{not json");
    await expect(ledger.put(p)).rejects.toThrow(/unreadable/);
    await expect(svc.create({ modelId: model.id, request: OBS, proposedBy: { kind: "person" } })).rejects.toThrow(/unreadable/);
    expect(storage.getItem(PROPOSALS_KEY)).toBe("{not json");
  });
});
