/**
 * AI OUTPUT -> HUMAN-INITIATED PROPOSAL (Step 5D). Pure; persists nothing;
 * imports no repository.
 *
 *   AiResponse != AiProposalSet != MutationProposal != SystemModel
 *
 * The ONLY mapping in 5D: a validated CandidateExplanation from the
 * pattern task -> exactly one registered addHypothesis with the draft's
 * words, the PATTERN's subject and confidence null. Nothing else is
 * invented (no status, prediction, evidence attachment, condition, kill
 * criterion, relationship, notes); weakenedBy / alternatives stay prose.
 *
 * The person submits the proposal ("Review as hypothesis"), so
 * proposedBy is the person; the AI's part is recorded as an immutable
 * ai_output ORIGIN basis beside the re-resolvable EVIDENCE basis (pattern,
 * Explore comparison, every cited record). A cited context kind that has
 * no re-resolvable basis makes the whole set unbridgeable, visibly:
 * nothing is snapshotted to fake staleness protection.
 */
import { monthYear, formatValue } from "@/discovery/language";
import type { PatternRef } from "@/discovery/cross-context";
import type { MutationStep } from "@/kernel/registry";
import type { MutationBatch, MutationProposal, ProposalBasisRef } from "@/kernel/types";
import type { AiCallIdentity, AiContext, ContextItem, EpistemicState } from "./context";
import { providerPayload } from "./context";
import type { AiResponse } from "./response";

export const CROSS_CONTEXT_BASIS_SUMMARY = "the occurrence and contrast comparison shown to the AI";

/** Identity of one AI-origin suggestion: the same output from the same call. */
export interface AiSuggestionIdentity {
  adapterId: string;
  contextHash: string;
  outputItemId: string;
}

export interface AiProposalCandidate {
  identity: AiSuggestionIdentity;
  outputKind: "candidate_explanation";
  uncertainty: EpistemicState;
  /** The exact registered mutation the person would submit. */
  mutation: MutationStep;
  request: MutationBatch;
  rationale: string;
  basis: ProposalBasisRef[];
}

export interface AiProposalSet {
  call: AiCallIdentity;
  adapterId: string;
  candidates: AiProposalCandidate[];
  /** Output items shown for information only; they create no candidate. */
  informational: { id: string; kind: string }[];
}

export type BridgeResult = { ok: true; set: AiProposalSet } | { ok: false; error: string };

function patternSummaryFrom(item: ContextItem): string {
  const p = item.payload as { variable?: string; unit?: string; repeatedValue?: number; occurrenceTimes?: string[]; interval?: { from: string; to: string } };
  const n = p.occurrenceTimes?.length ?? 0;
  return `${p.variable ?? "the record"} was recorded at ${formatValue(p.repeatedValue ?? null, p.unit ?? "")} at ${n} distinct time${n === 1 ? "" : "s"} between ${p.interval ? monthYear(p.interval.from) : "?"} and ${p.interval ? monthYear(p.interval.to) : "?"}.`;
}

/** A cited context item as a RE-RESOLVABLE kernel basis, or null when none exists for that kind. */
function basisFor(item: ContextItem): ProposalBasisRef | null {
  const ref = item.ref;
  switch (ref.kind) {
    case "pattern":
      return { kind: "pattern", ref: ref.pattern, summary: patternSummaryFrom(item) };
    case "cross_context":
      return { kind: "cross_context", pattern: ref.pattern, summary: CROSS_CONTEXT_BASIS_SUMMARY };
    case "observation":
      return { kind: "observation", id: ref.id };
    case "event":
      return { kind: "event", id: ref.id };
    case "hypothesis":
      return { kind: "hypothesis", id: ref.id };
    case "relationship":
      return { kind: "relationship", id: ref.id };
    case "variable":
      return { kind: "variable", id: ref.id };
    case "catalogue_prompt":
      return { kind: "catalogue_prompt", domainId: ref.domainId, domainVersion: ref.domainVersion, promptId: ref.promptId, question: String((item.payload as { question?: unknown }).question ?? "") };
    case "user_text":
      return { kind: "user_statement", text: String((item.payload as { text?: unknown }).text ?? "") };
    case "system":
    case "value":
    case "derived":
    case "variable_history":
    case "constraint":
      return null; // no re-resolvable kernel basis for this kind yet
  }
}

const sameBasis = (a: ProposalBasisRef, b: ProposalBasisRef) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Build the proposal set for a validated response. Never persists.
 * Candidate explanations become addHypothesis candidates; every other
 * output kind is informational. One unbridgeable candidate fails the set.
 */
export function toProposalSet(context: AiContext, response: AiResponse, adapterId: string): BridgeResult {
  if (response.contextHash !== context.contextHash) return { ok: false, error: "The response does not belong to this context (contextHash mismatch)." };
  const payload = providerPayload(context);
  const byId = new Map(payload.items.map((i) => [i.id, i]));
  const call: AiCallIdentity = { task: context.task, contextHash: context.contextHash, sourceRevisionHash: context.sourceRevisionHash };
  const candidates: AiProposalCandidate[] = [];
  const informational: AiProposalSet["informational"] = [];
  for (const item of response.items) {
    if (item.kind !== "candidate_explanation") {
      informational.push({ id: item.id, kind: item.kind });
      continue;
    }
    const patternItem = byId.get(item.forPattern);
    if (!patternItem || patternItem.ref.kind !== "pattern") return { ok: false, error: `${item.id}: forPattern does not name a pattern item in this context.` };
    const pattern: PatternRef = patternItem.ref.pattern;
    if (pattern.subjectId === null) return { ok: false, error: `${item.id}: the pattern has no attributed subject; a hypothesis cannot be proposed for it.` };
    const statement = item.text.trim();
    if (!statement) return { ok: false, error: `${item.id}: empty explanation text.` };
    const origin: ProposalBasisRef = { kind: "ai_output", adapterId, task: context.task, contextHash: context.contextHash, sourceRevisionHash: context.sourceRevisionHash, outputItemId: item.id, outputKind: item.kind, text: statement, state: item.state };
    const basis: ProposalBasisRef[] = [origin, { kind: "pattern", ref: pattern, summary: patternSummaryFrom(patternItem) }];
    const cc = payload.items.find((i) => i.ref.kind === "cross_context" && JSON.stringify(i.ref.pattern) === JSON.stringify(pattern));
    if (cc) basis.push(basisFor(cc) as ProposalBasisRef);
    for (const ref of [item.forPattern, ...item.restsOn]) {
      const cited = byId.get(ref);
      if (!cited) return { ok: false, error: `${item.id}: cites "${ref}", which is not in this context.` };
      const b = basisFor(cited);
      if (!b) return { ok: false, error: `${item.id}: cites ${ref}, a "${cited.kind}" item that has no re-resolvable proposal basis yet; the proposal cannot be protected against that record changing, so it is not created.` };
      if (!basis.some((x) => sameBasis(x, b))) basis.push(b);
    }
    const mutation: MutationStep = { kind: "addHypothesis", args: { statement, subjectId: pattern.subjectId, confidence: null } };
    candidates.push({
      identity: { adapterId, contextHash: context.contextHash, outputItemId: item.id },
      outputKind: "candidate_explanation",
      uncertainty: item.state,
      mutation,
      request: [mutation],
      rationale: `Suggested by the AI task ${context.task} as one possibility to test (${item.state}) for a repeated record: ${patternSummaryFrom(patternItem)} The person chose to review it.`,
      basis,
    });
  }
  return { ok: true, set: { call, adapterId, candidates, informational } };
}

/** Proposals in a ledger listing that originated from the SAME AI output. */
export function proposalsFromSuggestion(proposals: readonly MutationProposal[], identity: AiSuggestionIdentity): MutationProposal[] {
  return proposals
    .filter((p) => p.basis.some((b) => b.kind === "ai_output" && b.adapterId === identity.adapterId && b.contextHash === identity.contextHash && b.outputItemId === identity.outputItemId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type SuggestionState = { state: "none" } | { state: "open"; proposal: MutationProposal } | { state: "applied"; proposal: MutationProposal } | { state: "rejected"; proposal: MutationProposal };

/** Duplicate protection: what already exists for this suggestion. Open wins over decided. */
export function suggestionState(proposals: readonly MutationProposal[], identity: AiSuggestionIdentity): SuggestionState {
  const mine = proposalsFromSuggestion(proposals, identity);
  const open = mine.find((p) => ["proposed", "reviewed", "stale", "failed", "applying"].includes(p.status));
  if (open) return { state: "open", proposal: open };
  const applied = mine.find((p) => p.status === "applied");
  if (applied) return { state: "applied", proposal: applied };
  const rejected = mine.find((p) => p.status === "rejected");
  if (rejected) return { state: "rejected", proposal: rejected };
  return { state: "none" };
}
