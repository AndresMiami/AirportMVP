/**
 * EXPLORE -> PROPOSAL integration helpers (pure, no React).
 *
 *   Investigate this explanation -> a PROPOSAL -> human review -> human
 *   approval -> canonical hypothesis.
 *
 * Explore never mutates the model: it builds a proposal request and its
 * basis, and reads the proposal ledger to reconcile drafts and to surface
 * hypotheses created from a pattern. The discovery engine does not depend
 * on the kernel; this module sits above both.
 */
import type { CrossContext, PatternRef } from "@/discovery/cross-context";
import { formatValue, monthYear } from "@/discovery/language";
import type { LinkedHypothesis } from "@/discovery/linked-hypotheses";
import { canonicalJSON, type MutationBatch, type MutationProposal, type ProposalBasisRef } from "@/kernel";
import type { DomainDefinition } from "@/model/domain";
import type { Hypothesis } from "@/types";

/** The person's Explore draft, as the page keeps it in this browser. */
export interface ExploreDraft {
  id: string;
  text: string;
  promptId?: string;
  /** Set once a proposal was created from this draft; never a second one while it is open. */
  proposalId?: string;
}

export interface ExploreProposalInput {
  request: MutationBatch;
  basis: ProposalBasisRef[];
  rationale: string;
}

/** Plain-language pattern summary: what repeated, how often, over which period. */
export function patternSummary(r: CrossContext): string {
  const n = r.occurrences.length;
  return `${r.variableName} was recorded at ${formatValue(r.pattern.repeatedValue, r.unit)} at ${n} distinct time${n === 1 ? "" : "s"} between ${monthYear(r.pattern.interval.from)} and ${monthYear(r.pattern.interval.to)}.`;
}

export const CROSS_CONTEXT_SUMMARY = "the occurrence and contrast comparison shown in Explore";

/**
 * What Investigate proposes: ONE addHypothesis with the draft's words as
 * the statement, the pattern's subject as the hypothesis subject, and
 * confidence NOT ASSESSED. No status, prediction, condition, evidence
 * attachment, relationship or link is invented; the Explore locus is
 * presentation context and is not written into the hypothesis.
 */
export function buildExploreProposal(draft: Pick<ExploreDraft, "text" | "promptId">, r: CrossContext, domain: Pick<DomainDefinition, "id" | "version" | "explanationCatalogue">): ExploreProposalInput {
  const statement = draft.text.trim();
  if (!statement) throw new Error("The draft is empty; there is nothing to propose.");
  const basis: ProposalBasisRef[] = [
    { kind: "pattern", ref: r.pattern, summary: patternSummary(r) },
    { kind: "cross_context", pattern: r.pattern, summary: CROSS_CONTEXT_SUMMARY },
    { kind: "user_statement", text: statement },
  ];
  if (draft.promptId) {
    const prompt = domain.explanationCatalogue?.prompts.find((p) => p.id === draft.promptId);
    if (prompt) basis.push({ kind: "catalogue_prompt", domainId: domain.id, domainVersion: domain.version, promptId: prompt.id, question: prompt.question });
  }
  return {
    request: [{ kind: "addHypothesis", args: { statement, subjectId: r.pattern.subjectId, confidence: null } }],
    basis,
    rationale: `Written in Explore as a condition to test for a repeated record (${patternSummary(r)})`,
  };
}

const samePattern = (a: PatternRef, b: PatternRef) => canonicalJSON(a) === canonicalJSON(b);

export interface CreatedFromPattern {
  hypothesis: Hypothesis;
  proposalId: string;
}

/**
 * Hypotheses whose creation is RECORDED in the ledger: an applied proposal
 * with a pattern basis equal to this Explore pattern and an affected
 * hypothesis id that still exists in the model. Deterministic provenance;
 * never wording similarity.
 */
export function createdFromPattern(proposals: readonly MutationProposal[], pattern: PatternRef, hypotheses: readonly Hypothesis[]): CreatedFromPattern[] {
  const byId = new Map(hypotheses.map((h) => [h.id, h]));
  const out: CreatedFromPattern[] = [];
  for (const p of proposals) {
    if (p.status !== "applied" || !p.commit) continue;
    if (!p.basis.some((b) => b.kind === "pattern" && samePattern(b.ref, pattern))) continue;
    for (const key of p.commit.affectedIds) {
      const [collection, id] = key.split(":");
      if (collection !== "hypotheses") continue;
      const h = byId.get(id);
      if (h && !out.some((x) => x.hypothesis.id === id)) out.push({ hypothesis: h, proposalId: p.id });
    }
  }
  return out;
}

export interface RelatedHypothesisRow {
  hypothesis: Hypothesis;
  linkedVia: LinkedHypothesis["linkedVia"];
  createdFromThisPattern: boolean;
}

/** Model-linked hypotheses merged with ledger-recorded ones, one row per hypothesis. */
export function mergeRelated(linked: readonly LinkedHypothesis[], created: readonly CreatedFromPattern[]): RelatedHypothesisRow[] {
  const rows: RelatedHypothesisRow[] = linked.map((l) => ({ hypothesis: l.hypothesis, linkedVia: l.linkedVia, createdFromThisPattern: created.some((c) => c.hypothesis.id === l.hypothesis.id) }));
  for (const c of created) if (!rows.some((r) => r.hypothesis.id === c.hypothesis.id)) rows.push({ hypothesis: c.hypothesis, linkedVia: [], createdFromThisPattern: true });
  return rows;
}

export type DraftReconciliation =
  | { action: "keep"; proposalId: string; status: MutationProposal["status"] }
  | { action: "relink"; proposalId: string; status: MutationProposal["status"] }
  | { action: "remove"; reason: "applied" | "rejected" }
  | { action: "unlink" };

/**
 * A draft that references a proposal is reconciled from the ledger:
 * open (proposed / reviewed / stale / failed / applying) -> keep and link;
 * superseded -> follow the replacement chain and relink; applied or
 * rejected -> the draft may leave browser storage; missing -> unlink.
 * Creation alone never removes a draft.
 */
export function reconcileDraft(proposalId: string, lookup: (id: string) => MutationProposal | null): DraftReconciliation {
  let p = lookup(proposalId);
  if (!p) return { action: "unlink" };
  let hops = 0;
  while (p.status === "superseded" && p.supersededBy && hops < 50) {
    const next = lookup(p.supersededBy);
    if (!next) break;
    p = next;
    hops += 1;
  }
  if (p.status === "applied") return { action: "remove", reason: "applied" };
  if (p.status === "rejected") return { action: "remove", reason: "rejected" };
  if (p.status === "superseded") return { action: "keep", proposalId: p.id, status: p.status };
  return p.id === proposalId ? { action: "keep", proposalId: p.id, status: p.status } : { action: "relink", proposalId: p.id, status: p.status };
}
