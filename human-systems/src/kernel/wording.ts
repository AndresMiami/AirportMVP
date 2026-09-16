/**
 * Ordinary-language answers a review card gives, built ONLY from what the
 * kernel recorded (materialized request, dry-run, resolved basis). Pure;
 * no React. Every sentence here is either derived from the diff or a fixed
 * epistemic line. "Nothing else changes." appears only when the diff
 * proves it.
 */
import { consequenceReasons } from "./registry";
import type { DryRunResult, MutationBatch, MutationProposal, ProposalBasisRef, ResolvedBasis } from "./types";

export const BASIS_DISCLAIMER = "These records explain why this proposal was made. They do not make the proposal true.";
export const NOTHING_ELSE_CHANGES = "Nothing else changes.";
export const NO_RATIONALE = "No reason was given.";
export const ENGINE_CANNOT_JUDGE = "The engine cannot tell whether this change is right; it only shows exactly what it does.";

export interface BasisLine {
  ref: ProposalBasisRef;
  /** What the cited record says NOW (or said, for a previous resolution). */
  text: string;
  /** False when the record no longer exists or could not be resolved. */
  resolved: boolean;
}

export interface ProposalWording {
  /** What is being proposed? one line per step */
  what: string[];
  /** Why was it proposed? */
  why: string;
  /** What will change? step summaries with their details */
  willChange: { summary: string; details: string[]; subject?: string }[];
  /** What else will change? rows the request did not name */
  elseChanges: string[];
  /** What will not change? */
  willNotChange: string;
  /** What records is this based on? */
  basis: BasisLine[];
  /** What uncertainty remains? */
  uncertainty: string[];
  /** Named consequences (empty for an ordinary proposal). */
  consequences: string[];
  /** Why it cannot be applied, when the dry-run failed. */
  errors: string[];
}

function basisText(b: ResolvedBasis): BasisLine {
  const c = b.content as Record<string, unknown> | null;
  const missing = (what: string) => ({ ref: b.ref, text: `${what} no longer exists in the model.`, resolved: false });
  switch (b.ref.kind) {
    case "observation":
      return c ? { ref: b.ref, text: `Observation: “${String(c.statement)}”${c.dateOrPeriod ? ` (${String(c.dateOrPeriod)})` : ""}.`, resolved: true } : missing(`Observation ${b.ref.id}`);
    case "event":
      return c ? { ref: b.ref, text: `Event: “${String(c.title)}”.`, resolved: true } : missing(`Event ${b.ref.id}`);
    case "hypothesis":
      return c ? { ref: b.ref, text: `Hypothesis: “${String(c.statement)}” (${String(c.status)}).`, resolved: true } : missing(`Hypothesis ${b.ref.id}`);
    case "variable":
      return c ? { ref: b.ref, text: `Variable: ${String(c.name)}.`, resolved: true } : missing(`Variable ${b.ref.id}`);
    case "relationship":
      return c ? { ref: b.ref, text: `Relationship: ${String(c.sourceVariableId)} → ${String(c.targetVariableId)} (${String(c.direction)}).`, resolved: true } : missing(`Relationship ${b.ref.id}`);
    case "variable_history":
      return b.content ? { ref: b.ref, text: `Value history of ${b.ref.variableId} from ${b.ref.interval.from} to ${b.ref.interval.to}: ${(b.content as unknown[]).length} record${(b.content as unknown[]).length === 1 ? "" : "s"}.`, resolved: true } : missing(`Variable ${b.ref.variableId}`);
    case "pattern": {
      const occ = c?.occurrences as string[] | null | undefined;
      return occ ? { ref: b.ref, text: `Pattern: ${b.ref.summary} — recorded at ${occ.length} distinct times in the current records.`, resolved: true } : { ref: b.ref, text: `Pattern: ${b.ref.summary} — the repetition is no longer in the records.`, resolved: false };
    }
    case "cross_context":
      return { ref: b.ref, text: `Cross-context reading: ${b.ref.reading}`, resolved: true };
    case "user_statement":
      return { ref: b.ref, text: `You said: “${b.ref.text}”`, resolved: true };
    case "catalogue_prompt":
      return { ref: b.ref, text: `A question from the catalogue (${b.ref.promptId}).`, resolved: true };
  }
}

export function consequencesOf(materialized: MutationBatch): string[] {
  return materialized.flatMap((s) => consequenceReasons(s.kind, s.args));
}

/** Wording for one preview (current or previous) with its resolved basis. */
export function describePreview(materialized: MutationBatch, preview: DryRunResult, resolvedBasis: readonly ResolvedBasis[], rationale: string): ProposalWording {
  const basis = resolvedBasis.map(basisText);
  const uncertainty: string[] = [...preview.warnings];
  for (const b of basis) if (!b.resolved) uncertainty.push(`A cited record is gone: ${b.text}`);
  uncertainty.push(ENGINE_CANNOT_JUDGE);
  const willNotChange = !preview.ok ? "It cannot be applied, so nothing changes." : preview.nothingElseChanges ? NOTHING_ELSE_CHANGES : "Other records change as well; see “What else will change”.";
  return {
    what: preview.semantic.map((s) => s.summary),
    why: rationale.trim() === "" ? NO_RATIONALE : rationale,
    willChange: preview.semantic.map((s) => ({ summary: s.summary, details: s.details, subject: s.subject })),
    elseChanges: preview.alsoChanged,
    willNotChange,
    basis,
    uncertainty,
    consequences: consequencesOf(materialized),
    errors: preview.errors.map((e) => (e.step > 0 ? `Step ${e.step}: ${e.message}` : e.message)),
  };
}

export function describeProposal(p: MutationProposal): ProposalWording {
  return describePreview(p.materialized, p.preview, p.resolvedBasis, p.rationale);
}

export interface StaleComparison {
  /** What you reviewed before. */
  before: ProposalWording;
  /** What changed since then (ordinary language, derived by comparison). */
  changedSince: string[];
  /** What the proposal would do now. */
  now: ProposalWording;
}

const diffLines = (label: string, before: string[], after: string[], out: string[]) => {
  const b = new Set(before);
  const a = new Set(after);
  for (const x of after) if (!b.has(x)) out.push(`${label} now: ${x}`);
  for (const x of before) if (!a.has(x)) out.push(`${label} no longer: ${x}`);
};

/** null when the proposal carries no previous preview (it is not stale). */
export function staleComparison(p: MutationProposal): StaleComparison | null {
  if (!p.previousPreview) return null;
  const before = describePreview(p.materialized, p.previousPreview, p.previousResolvedBasis ?? p.resolvedBasis, p.rationale);
  const now = describeProposal(p);
  const changedSince: string[] = [];
  if (p.previousPreview.ok && !p.preview.ok) changedSince.push(`It can no longer be applied: ${now.errors.join("; ")}`);
  if (!p.previousPreview.ok && p.preview.ok) changedSince.push("It can be applied again.");
  diffLines("Would change", before.what, now.what, changedSince);
  diffLines("Would also change", before.elseChanges, now.elseChanges, changedSince);
  diffLines("Warning", p.previousPreview.warnings, p.preview.warnings, changedSince);
  if (p.previousPreview.consequenceClass !== p.preview.consequenceClass) changedSince.push(`This proposal is now ${p.preview.consequenceClass} (it was ${p.previousPreview.consequenceClass}).`);
  const prevBasis = new Map(before.basis.map((b, i) => [i, b.text]));
  now.basis.forEach((b, i) => {
    const was = prevBasis.get(i);
    if (was !== undefined && was !== b.text) changedSince.push(`A cited record changed. It read: ${was} It now reads: ${b.text}`);
  });
  if (p.previousPreview.nothingElseChanges !== p.preview.nothingElseChanges) changedSince.push(p.preview.nothingElseChanges ? "Nothing else changes any more." : "Something else changes now.");
  const outsBefore = JSON.stringify(p.previousPreview.expectedOutputs);
  const outsNow = JSON.stringify(p.preview.expectedOutputs);
  if (outsBefore !== outsNow) changedSince.push("The records it would create get different identifiers now.");
  if (changedSince.length === 0) changedSince.push("The difference is in the mechanical detail only; open Details to compare.");
  return { before, changedSince, now };
}

export const STATUS_WORDS: Record<MutationProposal["status"], string> = {
  proposed: "Needs your review",
  reviewed: "Reviewed — you can decide",
  applying: "Being applied",
  applied: "Applied",
  failed: "Could not be applied",
  rejected: "Rejected",
  stale: "Changed since you reviewed it",
  superseded: "Replaced by an edit",
};
