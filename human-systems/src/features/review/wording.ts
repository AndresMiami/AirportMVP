/**
 * REVIEW WORDING (Step 6D / 6D.1): the first layer of a review card answers
 * four questions — what am I deciding, what would change, why am I seeing
 * it, what is it based on — in ordinary language over the kernel's OWN
 * describeProposal() wording and its ALREADY-RESOLVED basis content.
 * Presentation only: nothing here reads the model, recomputes a preview
 * or a comparison, or changes what a proposal is; the kernel's full
 * wording (what else changes, what will not, every uncertainty line, the
 * complete rationale, the raw basis lines, the mechanical diff) stays
 * available under Details. Pure; no React.
 */
import { AI_OUTPUT_NOT_EVIDENCE, ENGINE_CANNOT_JUDGE } from "@/kernel/wording";
import type { BasisLine, MutationProposal, ProposalWording, ResolvedBasis } from "@/kernel";
import { longDate, recurrenceSentence } from "@/features/plain-language";

export interface DecisionHeading {
  /** The question the person is deciding. */
  question: string;
  /** The thing itself, quoted or named; null when nothing can be described. */
  detail: string | null;
  /** Further steps the request carries beyond the first. */
  moreSteps: number;
}

/** True when the single registered step adds a hypothesis with a statement. */
export function isSingleHypothesis(p: Pick<MutationProposal, "materialized">): boolean {
  const steps = p.materialized;
  if (steps.length !== 1 || steps[0].kind !== "addHypothesis") return false;
  const statement = (steps[0].args as { statement?: unknown }).statement;
  return typeof statement === "string" && statement.trim().length > 0;
}

/**
 * The decision as a question. A single registered addHypothesis step reads
 * "Keep this as a working hypothesis?" with the statement quoted; any other
 * kind falls back to the kernel's own first summary line.
 */
export function decisionHeading(p: Pick<MutationProposal, "materialized">, w: Pick<ProposalWording, "what">): DecisionHeading {
  if (isSingleHypothesis(p)) return { question: "Keep this as a working hypothesis?", detail: `“${String((p.materialized[0].args as { statement: string }).statement)}”`, moreSteps: 0 };
  if (w.what.length === 0) return { question: "This change cannot be applied", detail: null, moreSteps: 0 };
  return { question: "Apply this change?", detail: w.what[0], moreSteps: Math.max(0, w.what.length - 1) };
}

/**
 * "What this would change" for the first layer. A single addHypothesis
 * step reads "Create this working hypothesis." with its subject; its
 * status, confidence and disconfirming-condition state stay under Details
 * (the kernel's willChange is untouched). Every other kind keeps the
 * kernel's own summaries.
 */
export function firstLayerChanges(p: Pick<MutationProposal, "materialized">, w: Pick<ProposalWording, "willChange">): ProposalWording["willChange"] {
  if (isSingleHypothesis(p) && w.willChange.length === 1) return [{ summary: "Create this working hypothesis.", details: [], subject: w.willChange[0].subject }];
  return w.willChange;
}

/** Provenance, never wording: an Explore-created proposal carries both the pattern and the Explore comparison as basis. */
export function isExploreOrigin(basis: readonly { kind: string }[]): boolean {
  return basis.some((b) => b.kind === "pattern") && basis.some((b) => b.kind === "cross_context");
}

/** "Why you're seeing this" for the first layer; the complete kernel rationale stays under Details. */
export function firstLayerWhy(basis: readonly { kind: string }[], w: Pick<ProposalWording, "why">): string {
  return isExploreOrigin(basis) ? "You chose to investigate this explanation in Explore." : w.why;
}

export interface BasisRow {
  /** A human label for the kind of record; never a basis-kind name. */
  label: string;
  text: string;
  /** A quiet note under the row (only for AI-origin wording). */
  note: string | null;
  resolved: boolean;
}

const strip = (text: string, prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length) : text);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Already-resolved Explore comparison content (the kernel stored the engine's whole result). Read-only; counts only. */
interface ComparisonContent {
  variableName?: unknown;
  unit?: unknown;
  occurrences?: unknown[];
  contrasts?: unknown[];
  groups?: Record<string, string[] | undefined>;
}

/**
 * The Explore comparison in product language, from the resolved content
 * only: how many repeated times, how many other recorded times, how many
 * conditions differed, how many were the same every time (and, when other
 * times exist, how those split), how many are unresolved. No recomputation,
 * no ranking, no cause.
 */
export function comparisonSentence(c: ComparisonContent): string {
  const occ = c.occurrences?.length ?? 0;
  const con = c.contrasts?.length ?? 0;
  const g = c.groups ?? {};
  const n = (k: string) => g[k]?.length ?? 0;
  const same = n("commonAtOccurrences");
  const unresolved = n("insufficientAtOccurrences") + n("undecided") + n("contrastPartial");
  const parts = [`${plural(occ, "repeated time was", "repeated times were")} compared with ${plural(con, "other recorded time", "other recorded times")}.`, `${plural(n("differingAtOccurrences"), "condition", "conditions")} differed across the repeated times; ${same === 1 ? "1 was" : `${same} were`} recorded the same every time`];
  if (con > 0 && same > 0) parts.push(`(${n("backgroundComplete")} also true at the other times, ${n("differentiatingComplete")} different, ${n("mixedComplete")} mixed)`);
  return `${parts[0]} ${parts.slice(1).join(" ")}; ${plural(unresolved, "condition is", "conditions are")} still unresolved.`;
}

/**
 * The kernel's basis lines, labelled for people. The text is the kernel's
 * own resolved wording minus its kind prefix — except a RESOLVED Explore
 * pattern or comparison, which is re-worded in product language from the
 * already-resolved content (the pattern's current occurrence times; the
 * comparison's counts). Unresolved lines keep their full sentence, so a
 * gone record is never dressed up.
 */
export function basisRows(basis: readonly BasisLine[], resolved: readonly ResolvedBasis[] = []): BasisRow[] {
  const comparison = resolved.find((r) => r.ref.kind === "cross_context" && r.content && typeof r.content === "object")?.content as ComparisonContent | undefined;
  return basis.map((b, i) => {
    const base = { note: null, resolved: b.resolved };
    const content = resolved[i]?.ref === b.ref ? resolved[i]?.content : undefined;
    switch (b.ref.kind) {
      case "user_statement":
        return { ...base, label: "You wrote", text: strip(b.text, "You wrote: ") };
      case "pattern": {
        const occ = (content as { occurrences?: unknown } | null | undefined)?.occurrences;
        const name = typeof comparison?.variableName === "string" ? comparison.variableName : null;
        const unit = typeof comparison?.unit === "string" ? comparison.unit : null;
        if (b.resolved && Array.isArray(occ) && occ.every((t) => typeof t === "string") && name !== null && unit !== null) return { ...base, label: "Pattern", text: recurrenceSentence(name, b.ref.ref.repeatedValue, unit, occ as string[]) };
        return { ...base, label: "Pattern", text: strip(b.text, "Pattern: ") };
      }
      case "cross_context":
        if (b.resolved && content && typeof content === "object") return { ...base, label: "Comparison", text: comparisonSentence(content as ComparisonContent) };
        return { ...base, label: "Comparison", text: strip(strip(b.text, "Explore comparison: "), "Explore comparison ") };
      case "catalogue_prompt":
        return { ...base, label: "Question", text: strip(b.text, "Question that prompted the draft: ") };
      case "ai_output":
        return { ...base, label: "Suggested wording", text: `“${b.ref.text}”`, note: AI_OUTPUT_NOT_EVIDENCE };
      case "observation":
        return { ...base, label: "Record", text: strip(b.text, "Observation: ") };
      case "event":
        return { ...base, label: "Event", text: strip(b.text, "Event: ") };
      case "hypothesis":
        return { ...base, label: "Hypothesis", text: strip(b.text, "Hypothesis: ") };
      case "variable":
        return { ...base, label: "Variable", text: strip(b.text, "Variable: ") };
      case "relationship":
        return { ...base, label: "Relationship", text: strip(b.text, "Relationship: ") };
      case "variable_history":
        return { ...base, label: "Value history", text: b.text };
    }
  });
}

export const NO_BASIS = "No supporting record was cited for this proposal.";

/** The proposal-specific uncertainty for the first layer: the kernel's fixed "cannot judge" sentence is shown under Details instead, so a card with nothing uncertain shows no section. */
export function specificUncertainty(w: Pick<ProposalWording, "uncertainty">): string[] {
  return w.uncertainty.filter((u) => u !== ENGINE_CANNOT_JUDGE);
}

/** One plain status line per state (the kernel's status words stay under Details). Generic wording means CHANGE, never "added". */
export const STATE_LINES: Record<MutationProposal["status"], string | null> = {
  proposed: null,
  reviewed: "Ready for your decision",
  stale: "Something changed since you reviewed this",
  failed: "Nothing was written.",
  applying: "Being applied",
  applied: "Change applied",
  rejected: "Rejected",
  superseded: "Replaced by an edited version",
};

/** The date a past decision was made, as calendar words: the approval instant for an applied change, otherwise the last review entry. */
export function decisionDate(p: Pick<MutationProposal, "status" | "commit" | "review">): string | null {
  const at = p.status === "applied" ? (p.commit?.approvedAt ?? p.review.at(-1)?.at) : p.review.at(-1)?.at;
  return at ? longDate(at) : null;
}

/** Startup recovery outcomes in ordinary words. Every outcome stays visible; the id stays for the record. Only a commit that never landed may say nothing was written: a conflict means the stored model is neither state. */
export function recoveryLine(o: { outcome: "reconciled_applied" | "commit_never_landed" | "conflict"; proposalId: string }): string {
  switch (o.outcome) {
    case "reconciled_applied":
      return `A change you approved had already been saved; it is recorded as applied. (${o.proposalId})`;
    case "commit_never_landed":
      return `A change you approved never reached your notebook. Nothing was written; you can check again and retry it. (${o.proposalId})`;
    case "conflict":
      return `Your notebook no longer matches either the state before this change or the state this change expected to produce. It needs a fresh look before any retry. (${o.proposalId})`;
  }
}
