/**
 * ProposalService — the constitutional write boundary.
 *
 *   create  : materialize + dry-run against the STORED model, resolve the
 *             basis, fingerprint, store as "proposed". Writes nothing to the model.
 *   review  : revalidate; the person is shown the current preview.
 *   approve : two-phase — ledger "applying" (expected base + result
 *             revisions) -> guarded ModelService.saveIfRevision -> ledger
 *             "applied" (actual revision, approval record, affected ids).
 *             Any stale or conflicting state refuses and writes nothing.
 *   recover : on startup, a proposal stranded in "applying" is reconciled
 *             from the stored model's revision, never guessed.
 *
 * Reviewed request = materialized request = dry-run request = approval
 * request; canonical state changes only after guarded persistence succeeds.
 */
import { ModelService, RevisionConflictError } from "@/services/model-service";
import type { SystemModel } from "@/types";
import { applyBatch, dryRun, materialize, ProposalError } from "./dry-run";
import { resolveBasis, reviewFingerprint } from "./fingerprint";
import type { ProposalRepository } from "./proposal-repository";
import type { Clock } from "./registry";
import { revisionOf } from "./revision";
import type { MutationBatch, MutationProposal, ProposalAuthor, ProposalBasisRef, ProposalStatus, ReviewRecord } from "./types";

export interface CreateProposalInput {
  modelId: string;
  request: MutationBatch;
  proposedBy: ProposalAuthor;
  rationale?: string;
  basis?: ProposalBasisRef[];
}

export type ApproveResult =
  | { ok: true; proposal: MutationProposal; model: SystemModel }
  | { ok: false; reason: "not_reviewable" | "stale" | "invalid" | "conflict" | "persist_failed"; proposal: MutationProposal; message: string };

export type RecoveryOutcome = { proposalId: string; outcome: "reconciled_applied" | "commit_never_landed" | "conflict" };

const REVIEWABLE: ReadonlySet<ProposalStatus> = new Set(["proposed", "reviewed", "stale"]);

export class ProposalService {
  constructor(
    private readonly proposals: ProposalRepository,
    private readonly models: ModelService,
    private readonly clock: Clock = { now: () => new Date().toISOString() },
    private readonly newId: () => string = () => `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  ) {}

  private async storedModel(modelId: string): Promise<SystemModel> {
    const m = await this.models.load(modelId);
    if (!m) throw new ProposalError(`No stored system with id ${modelId}`);
    return m;
  }

  private record(p: MutationProposal, status: ProposalStatus, by: ReviewRecord["by"], note: string): MutationProposal {
    return { ...p, status, review: [...p.review, { at: this.clock.now(), status, by, note }] };
  }

  /** Materialize, dry-run and store. The model is untouched. */
  async create(input: CreateProposalInput): Promise<MutationProposal> {
    const model = await this.storedModel(input.modelId);
    const materialized = materialize(input.request, model, this.clock);
    const preview = dryRun(materialized, model);
    const resolvedBasis = resolveBasis(model, input.basis ?? []);
    const revision = revisionOf(model) as string;
    const proposal: MutationProposal = {
      id: this.newId(),
      modelId: input.modelId,
      request: structuredClone(input.request),
      materialized,
      proposedBy: input.proposedBy,
      createdAt: this.clock.now(),
      rationale: input.rationale ?? "",
      basis: input.basis ?? [],
      consequenceClass: preview.consequenceClass,
      createdAgainstRevision: revision,
      lastValidatedRevision: revision,
      preview,
      resolvedBasis,
      reviewFingerprint: reviewFingerprint(materialized, preview, resolvedBasis),
      status: "proposed",
      review: [{ at: this.clock.now(), status: "proposed", by: input.proposedBy.kind === "person" ? "person" : "kernel", note: "" }],
      commit: null,
      supersededBy: null,
      previousPreview: null,
    };
    await this.proposals.put(proposal);
    return proposal;
  }

  /**
   * Revalidate against the STORED model. Same revision: unchanged. Different
   * revision: rerun; identical review fingerprint -> harmless, advance
   * lastValidatedRevision; otherwise -> stale (invalid preview included).
   */
  async revalidate(id: string): Promise<MutationProposal> {
    const p = await this.get(id);
    if (!REVIEWABLE.has(p.status)) return p;
    const model = await this.storedModel(p.modelId);
    const current = revisionOf(model) as string;
    if (current === p.lastValidatedRevision) return p;
    const preview = dryRun(p.materialized, model);
    const resolvedBasis = resolveBasis(model, p.basis);
    const fp = reviewFingerprint(p.materialized, preview, resolvedBasis);
    let next: MutationProposal;
    if (fp === p.reviewFingerprint) {
      next = this.record({ ...p, lastValidatedRevision: current, preview, resolvedBasis }, p.status, "kernel", "revalidated: the model changed elsewhere; what you reviewed is unaffected");
    } else {
      next = this.record({ ...p, previousPreview: p.preview, preview, resolvedBasis, reviewFingerprint: fp, consequenceClass: preview.consequenceClass, lastValidatedRevision: current }, "stale", "kernel", preview.ok ? "the model changed in a way that alters what you reviewed; a fresh review is needed" : `the proposal can no longer be applied: ${preview.errors.map((e) => e.message).join("; ")}`);
    }
    await this.proposals.put(next);
    return next;
  }

  /** The person has looked at the current preview. */
  async review(id: string, note = ""): Promise<MutationProposal> {
    const p = await this.revalidate(id);
    if (!REVIEWABLE.has(p.status)) throw new ProposalError(`Proposal ${id} is ${p.status} and cannot be reviewed`);
    const next = this.record(p, "reviewed", "person", note);
    await this.proposals.put(next);
    return next;
  }

  async reject(id: string, note = ""): Promise<MutationProposal> {
    const p = await this.get(id);
    if (!REVIEWABLE.has(p.status)) throw new ProposalError(`Proposal ${id} is ${p.status} and cannot be rejected`);
    const next = this.record(p, "rejected", "person", note);
    await this.proposals.put(next);
    return next;
  }

  /** An edit is a NEW proposal; the old one is superseded. Writes nothing to the model. */
  async edit(id: string, request: MutationBatch, note = ""): Promise<{ superseded: MutationProposal; proposal: MutationProposal }> {
    const p = await this.get(id);
    if (!REVIEWABLE.has(p.status)) throw new ProposalError(`Proposal ${id} is ${p.status} and cannot be edited`);
    const proposal = await this.create({ modelId: p.modelId, request, proposedBy: { kind: "person" }, rationale: p.rationale, basis: p.basis });
    const superseded = this.record({ ...p, supersededBy: proposal.id }, "superseded", "person", note);
    await this.proposals.put(superseded);
    return { superseded, proposal };
  }

  /**
   * The ONLY write gate. Refuses unless the proposal was reviewed and its
   * review fingerprint still holds against the stored model.
   */
  async approve(id: string, note = ""): Promise<ApproveResult> {
    let p = await this.revalidate(id);
    if (p.status !== "reviewed") {
      return { ok: false, reason: p.status === "stale" ? "stale" : "not_reviewable", proposal: p, message: p.status === "stale" ? "What you reviewed has changed; review it again before approving." : `Proposal is ${p.status}; only a reviewed proposal can be approved.` };
    }
    if (!p.preview.ok) return { ok: false, reason: "invalid", proposal: p, message: p.preview.errors.map((e) => e.message).join("; ") };
    const model = await this.storedModel(p.modelId);
    const base = revisionOf(model) as string;
    if (base !== p.lastValidatedRevision) {
      p = await this.revalidate(id);
      return { ok: false, reason: "stale", proposal: p, message: "The model changed while approving; review the proposal again." };
    }
    // phase 1: record intent
    const after = applyBatch(p.materialized, model);
    const expectedResultRevision = revisionOf(after) as string;
    if (expectedResultRevision !== p.preview.resultRevision) {
      p = await this.revalidate(id);
      return { ok: false, reason: "stale", proposal: p, message: "The result no longer matches the preview; review the proposal again." };
    }
    p = this.record({ ...p, commit: { expectedBaseRevision: base, expectedResultRevision, actualResultRevision: null, approvedAt: null, affectedIds: [] } }, "applying", "person", note);
    await this.proposals.put(p);
    // phase 2: guarded model commit
    let persisted: SystemModel;
    try {
      persisted = await this.models.saveIfRevision(after, base, revisionOf);
    } catch (e) {
      const failed = this.record(p, "failed", "kernel", e instanceof RevisionConflictError ? "the stored model changed between review and approval; nothing was written" : `persistence failed: ${e instanceof Error ? e.message : String(e)}; nothing was written`);
      await this.proposals.put(failed);
      return { ok: false, reason: e instanceof RevisionConflictError ? "conflict" : "persist_failed", proposal: failed, message: failed.review.at(-1)!.note };
    }
    // phase 3: record completion
    const applied = this.record(
      { ...p, commit: { ...p.commit!, actualResultRevision: revisionOf(persisted) as string, approvedAt: this.clock.now(), affectedIds: p.preview.changes.map((c) => `${c.collection}:${c.id}`) } },
      "applied",
      "kernel",
      "",
    );
    await this.proposals.put(applied);
    return { ok: true, proposal: applied, model: persisted };
  }

  /** Startup: reconcile proposals stranded between the two stores. */
  async recover(modelId: string): Promise<RecoveryOutcome[]> {
    const out: RecoveryOutcome[] = [];
    const model = await this.models.load(modelId);
    const current = revisionOf(model);
    for (const p of await this.proposals.list(modelId)) {
      if (p.status !== "applying" || !p.commit) continue;
      if (current !== null && current === p.commit.expectedResultRevision) {
        await this.proposals.put(this.record({ ...p, commit: { ...p.commit, actualResultRevision: current, approvedAt: p.commit.approvedAt ?? p.review.at(-1)?.at ?? this.clock.now(), affectedIds: p.preview.changes.map((c) => `${c.collection}:${c.id}`) } }, "applied", "kernel", "recovered: the model carries the approved change"));
        out.push({ proposalId: p.id, outcome: "reconciled_applied" });
      } else if (current === p.commit.expectedBaseRevision) {
        await this.proposals.put(this.record({ ...p, commit: null }, "failed", "kernel", "recovered: the commit never landed; the proposal can be reviewed again"));
        out.push({ proposalId: p.id, outcome: "commit_never_landed" });
      } else {
        await this.proposals.put(this.record(p, "failed", "kernel", "recovery conflict: the model is neither the state before nor the state after this proposal; inspection needed"));
        out.push({ proposalId: p.id, outcome: "conflict" });
      }
    }
    return out;
  }

  async get(id: string): Promise<MutationProposal> {
    const p = await this.proposals.get(id);
    if (!p) throw new ProposalError(`No proposal ${id}`);
    return p;
  }

  list(modelId: string): Promise<MutationProposal[]> {
    return this.proposals.list(modelId);
  }
}
