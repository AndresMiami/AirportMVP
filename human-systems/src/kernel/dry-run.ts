/**
 * Materialization and dry-run. A proposal is frozen (ids, clocks) against
 * the working model, then applied step by step on a CLONE through the real
 * mutations, then validated exactly as ModelService.save validates. Nothing
 * here can save. The mechanical diff is computed by the kernel; the
 * semantic description is built on it.
 */
import { collectionProblems } from "@/services/mutations";
import { SystemModelSchema, type SystemModel } from "@/types";
import { describeExtraChange, entityDiff } from "./diff";
import { consequenceOf, entry, isRegisteredKind, type Clock, type MutationStep } from "./registry";
import { revisionOf } from "./revision";
import type { DryRunResult, EntityChange, MutationBatch, SemanticChange } from "./types";

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

/** Shape-check a batch: registered kinds and serializable arguments. Throws ProposalError. */
export function checkShape(batch: MutationBatch): void {
  if (!Array.isArray(batch) || batch.length === 0) throw new ProposalError("A proposal needs at least one step");
  batch.forEach((step, i) => {
    if (!step || typeof step !== "object" || typeof (step as { kind?: unknown }).kind !== "string") throw new ProposalError(`Step ${i + 1} has no mutation kind`);
    if (!isRegisteredKind(step.kind)) throw new ProposalError(`Step ${i + 1}: mutation "${step.kind}" is not registered for proposals`);
    const problem = entry(step.kind).shape(step.args);
    if (problem) throw new ProposalError(`Step ${i + 1} (${step.kind}): ${problem}`);
  });
}

/**
 * Freeze every implicit value. Steps are applied to a working clone as
 * they are materialized so a later create step's id follows an earlier
 * one's. Pure given (batch, model, clock).
 */
export function materialize(batch: MutationBatch, model: SystemModel, clock: Clock): MutationBatch {
  checkShape(batch);
  let working = structuredClone(model);
  const out: MutationBatch = [];
  for (const step of batch) {
    const e = entry(step.kind);
    const args = e.materialize(step.args as never, working, clock);
    out.push({ kind: step.kind, args } as MutationStep);
    try {
      working = e.apply(working, args as never);
    } catch {
      // the dry-run reports the failure; materialization of later steps proceeds against the last good state
    }
  }
  return out;
}

export function dryRun(materialized: MutationBatch, model: SystemModel): DryRunResult {
  const before = structuredClone(model);
  let after = structuredClone(model);
  const errors: DryRunResult["errors"] = [];
  const semantic: SemanticChange[] = [];
  const warnings: string[] = [];
  const named: { collection: string; id: string }[] = [];
  let expectedOutputs: Record<string, string> = {};
  let consequenceClass: DryRunResult["consequenceClass"] = "ordinary";
  materialized.forEach((step, i) => {
    if (errors.length > 0) return;
    const e = entry(step.kind);
    if (consequenceOf(step.kind, step.args, after) === "consequential") consequenceClass = "consequential";
    const stepBefore = after;
    try {
      after = e.apply(after, step.args as never);
    } catch (err) {
      errors.push({ step: i + 1, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const stepChanges = entityDiff(stepBefore, after);
    named.push(...e.names(step.args as never));
    expectedOutputs = { ...expectedOutputs, ...Object.fromEntries(Object.entries(e.expectedOutputs(step.args as never, stepChanges)).map(([k, v]) => [`step${i + 1}.${k}`, v])) };
    semantic.push(...e.describe(step.args as never, stepChanges, stepBefore, after));
    if (step.kind === "addVariable" && (step.args as { subjectId: string | null }).subjectId === null) warnings.push("The variable is unassigned; it feeds no calculation until a subject is assigned.");
  });
  if (errors.length === 0) {
    const parsed = SystemModelSchema.safeParse(after);
    if (!parsed.success) errors.push({ step: 0, message: `The result would not be a valid model: ${parsed.error.message}` });
    else {
      after = parsed.data;
      const problem = collectionProblems(after);
      if (problem) errors.push({ step: 0, message: problem });
    }
  }
  const ok = errors.length === 0;
  const changes: EntityChange[] = ok ? entityDiff(before, after) : [];
  const namedKeys = new Set(named.map((n) => `${n.collection}:${n.id}`));
  const extra = changes.filter((c) => !namedKeys.has(`${c.collection}:${c.id}`));
  const affected: Record<string, string[]> = {};
  for (const c of changes) (affected[c.collection] ??= []).push(c.id);
  return {
    ok,
    errors,
    changes,
    semantic,
    nothingElseChanges: ok && extra.length === 0,
    alsoChanged: extra.map(describeExtraChange),
    warnings,
    affected,
    expectedOutputs,
    consequenceClass,
    resultRevision: ok ? revisionOf(after) : null,
  };
}

/** The model a successful dry-run produces (recomputed, never cached). */
export function applyBatch(materialized: MutationBatch, model: SystemModel): SystemModel {
  let after = structuredClone(model);
  for (const step of materialized) after = entry(step.kind).apply(after, step.args as never);
  return after;
}
