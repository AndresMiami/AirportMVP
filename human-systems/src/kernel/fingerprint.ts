/**
 * The REVIEW FINGERPRINT: everything the person materially reviewed,
 * canonicalized. Harmless revalidation is decided by this, not by the
 * mutation result alone: a proposal based on observation A whose statement
 * later changes must go stale even when the mutation diff is identical.
 */
import { contextSubjectsFor, crossContext, type PatternRef } from "@/discovery/cross-context";
import { describeVariableHistory } from "@/discovery/describe-history";
import { domainRegistry } from "@/model/domain";
import type { SystemModel } from "@/types";
import { canonicalJSON } from "./revision";
import type { DryRunResult, MutationBatch, ProposalBasisRef, ResolvedBasis } from "./types";

/** Resolve every basis ref to the content it points at RIGHT NOW. */
/** Where source_item bases re-resolve: the CURRENT version of an imported
 *  source. Without a store the reviewed snapshot stands in (never stale). */
export interface BasisSources {
  itemContent(sourceId: string, itemKey: string): unknown | null;
}

export function resolveBasis(model: SystemModel, basis: readonly ProposalBasisRef[], sources?: BasisSources): ResolvedBasis[] {
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
        return { ref, content: resolveCrossContext(model, ref.pattern) };
      case "catalogue_prompt": {
        const domain = domainRegistry.get(ref.domainId, ref.domainVersion);
        const prompt = domain?.explanationCatalogue?.prompts.find((p) => p.id === ref.promptId);
        return { ref, content: prompt ? { question: prompt.question, locus: prompt.locus, hint: prompt.hint ?? null } : null };
      }
      case "user_statement":
      case "ai_output":
        return { ref, content: ref }; // immutable snapshots: their own content
      case "source_item":
        return { ref, content: sources ? sources.itemContent(ref.sourceId, ref.itemKey) : { contentHash: ref.contentHash, summary: ref.summary } };
    }
  });
}

/**
 * Rerun the SAME deterministic Explore comparison the screen shows, under
 * the model's current domain scope (contextSubjectsFor). The whole result
 * is the content: occurrence set, contrast set, every condition's
 * classification and coverage, unresolved groups, events near occurrences,
 * statements and caveats. null when the pattern no longer resolves. No
 * second comparison algorithm lives here.
 */
export function resolveCrossContext(model: SystemModel, pattern: PatternRef | undefined): unknown {
  if (!pattern || typeof pattern !== "object") return null;
  const domain = domainRegistry.get(model.domainDefinitionId, model.domainDefinitionVersion);
  const r = crossContext(model, pattern, { contextSubjectIds: contextSubjectsFor(model, pattern, domain) });
  return r.ok ? r : null;
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
