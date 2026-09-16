/**
 * REVIEW WORDING (Step 6D): the first layer of a review card answers four
 * questions — what am I deciding, what would change, why am I seeing it,
 * what is it based on — in ordinary language over the kernel's OWN
 * describeProposal() wording. Presentation only: nothing here reads the
 * model, recomputes a preview, or changes what a proposal is; the kernel's
 * full wording (what else changes, what will not, every uncertainty line,
 * the mechanical diff) stays available under Details. Pure; no React.
 */
import { AI_OUTPUT_NOT_EVIDENCE, ENGINE_CANNOT_JUDGE } from "@/kernel/wording";
import type { BasisLine, MutationProposal, ProposalWording } from "@/kernel";

export interface DecisionHeading {
  /** The question the person is deciding. */
  question: string;
  /** The thing itself, quoted or named; null when nothing can be described. */
  detail: string | null;
  /** Further steps the request carries beyond the first. */
  moreSteps: number;
}

/**
 * The decision as a question. A single registered addHypothesis step reads
 * "Keep this as a working hypothesis?" with the statement quoted; any other
 * kind falls back to the kernel's own first summary line.
 */
export function decisionHeading(p: Pick<MutationProposal, "materialized">, w: Pick<ProposalWording, "what">): DecisionHeading {
  const steps = p.materialized;
  if (steps.length === 1 && steps[0].kind === "addHypothesis") {
    const statement = (steps[0].args as { statement?: unknown }).statement;
    if (typeof statement === "string" && statement.trim()) return { question: "Keep this as a working hypothesis?", detail: `“${statement}”`, moreSteps: 0 };
  }
  if (w.what.length === 0) return { question: "This change cannot be applied", detail: null, moreSteps: 0 };
  return { question: "Apply this change?", detail: w.what[0], moreSteps: Math.max(0, w.what.length - 1) };
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

/** The kernel's basis lines, labelled for people. The text is the kernel's own resolved wording minus its kind prefix; unresolved lines keep their full sentence. */
export function basisRows(basis: readonly BasisLine[]): BasisRow[] {
  return basis.map((b) => {
    const base = { note: null, resolved: b.resolved };
    switch (b.ref.kind) {
      case "user_statement":
        return { ...base, label: "You wrote", text: strip(b.text, "You wrote: ") };
      case "pattern":
        return { ...base, label: "Pattern", text: strip(b.text, "Pattern: ") };
      case "cross_context":
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

/** The proposal-specific uncertainty for the first layer: the kernel's fixed "cannot judge" sentence is shown under Details instead, so a card with nothing uncertain shows no section. */
export function specificUncertainty(w: Pick<ProposalWording, "uncertainty">): string[] {
  return w.uncertainty.filter((u) => u !== ENGINE_CANNOT_JUDGE);
}

/** One plain status line per state (the kernel's status words stay under Details). */
export const STATE_LINES: Record<MutationProposal["status"], string | null> = {
  proposed: null,
  reviewed: "Ready for your decision",
  stale: "Something changed since you reviewed this",
  failed: "Nothing was written.",
  applying: "Being applied",
  applied: "Added to your notebook",
  rejected: "Rejected",
  superseded: "Replaced by an edited version",
};

/** Startup recovery outcomes in ordinary words. Every outcome stays visible; the id stays for the record. */
export function recoveryLine(o: { outcome: "reconciled_applied" | "commit_never_landed" | "conflict"; proposalId: string }): string {
  switch (o.outcome) {
    case "reconciled_applied":
      return `A change you approved had already been saved; it is recorded as applied. (${o.proposalId})`;
    case "commit_never_landed":
      return `A change you approved never reached your notebook. Nothing was written; you can check again and retry it. (${o.proposalId})`;
    case "conflict":
      return `Your notebook is neither as it was before a change you approved nor as it would be after it. Nothing was written; it needs a fresh look before any retry. (${o.proposalId})`;
  }
}
