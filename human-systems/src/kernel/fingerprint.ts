/**
 * The REVIEW FINGERPRINT: everything the person materially reviewed,
 * canonicalized. Harmless revalidation is decided by this, not by the
 * mutation result alone: a proposal based on observation A whose statement
 * later changes must go stale even when the mutation diff is identical.
 */
import { describeVariableHistory } from "@/discovery/describe-history";
import type { SystemModel } from "@/types";
import { canonicalJSON } from "./revision";
import type { DryRunResult, MutationBatch, ProposalBasisRef, ResolvedBasis } from "./types";

/** Resolve every basis ref to the content it points at RIGHT NOW. */
export function resolveBasis(model: SystemModel, basis: readonly ProposalBasisRef[]): ResolvedBasis[] {
  return basis.map((ref): ResolvedBasis => {
    switch (ref.kind) {
      case "observation":
        return { ref, content: model.observations.find((o) => o.id === ref.id) ?? null };
      case "event":
        return { ref, content: model.events.find((e) => e.id === ref.id) ?? null };
      case "relationship":
        return { ref, content: model.relationships.find((r) => r.id === ref.id) ?? null };
      case "hypothesis":
        return { ref, content: model.hypotheses.find((h) => h.id === ref.id) ?? null };
      case "variable":
        return { ref, content: model.variables.find((v) => v.id === ref.id) ?? null };
      case "variable_history": {
        const v = model.variables.find((x) => x.id === ref.variableId);
        return { ref, content: v && v.kind === "input" ? describeVariableHistory(v, ref.interval).records : null };
      }
      case "pattern": {
        const v = model.variables.find((x) => x.id === ref.ref.variableId);
        if (!v || v.kind !== "input") return { ref, content: null };
        const d = describeVariableHistory(v, ref.ref.interval);
        return { ref, content: { subjectId: v.subjectId, occurrences: d.repeatedValues.find((r) => r.value === ref.ref.repeatedValue)?.applicationTimes ?? null } };
      }
      case "cross_context":
      case "user_statement":
      case "catalogue_prompt":
        return { ref, content: ref };
    }
  });
}

export function reviewFingerprint(materialized: MutationBatch, preview: DryRunResult, resolvedBasis: readonly ResolvedBasis[]): string {
  return canonicalJSON({
    materialized,
    changes: preview.changes,
    semantic: preview.semantic,
    nothingElseChanges: preview.nothingElseChanges,
    alsoChanged: preview.alsoChanged,
    basis: resolvedBasis,
    warnings: preview.warnings,
    consequenceClass: preview.consequenceClass,
    expectedOutputs: preview.expectedOutputs,
    ok: preview.ok,
    errors: preview.errors,
  });
}
