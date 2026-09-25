/**
 * Ordinary-language answers a review card gives, built ONLY from what the
 * kernel recorded (materialized request, dry-run, resolved basis). Pure;
 * no React. Every sentence here is either derived from the diff or a fixed
 * epistemic line. "Nothing else changes." appears only when the diff
 * proves it.
 */
import { consequenceReasons } from "./registry";
import { canonicalJSON } from "./revision";
import type { DryRunResult, MutationBatch, MutationProposal, ProposalBasisRef, ResolvedBasis } from "./types";

export const BASIS_DISCLAIMER = "These records explain why this proposal was made. They do not make the proposal true.";
export const NOTHING_ELSE_CHANGES = "Nothing else changes.";
export const NO_RATIONALE = "No reason was given.";
export const ENGINE_CANNOT_JUDGE = "The engine cannot tell whether this change is right; it only shows exactly what it does.";
export const AI_OUTPUT_NOT_EVIDENCE = "The AI output is not evidence. The cited records below are the basis for reviewing the proposal.";

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
      return c ? { ref: b.ref, text: `Explore comparison: ${crossContextSummary(c)}`, resolved: true } : { ref: b.ref, text: `Explore comparison (${b.ref.summary}): it can no longer be resolved from the current records.`, resolved: false };
    case "user_statement":
      return { ref: b.ref, text: `You wrote: “${b.ref.text}”`, resolved: true };
    case "catalogue_prompt":
      return c ? { ref: b.ref, text: `Question that prompted the draft: “${String(c.question)}”`, resolved: true } : { ref: b.ref, text: `Question that prompted the draft is no longer in the catalogue (${b.ref.promptId}); it read: “${b.ref.question}”`, resolved: false };
    case "ai_output":
      return { ref: b.ref, text: `AI wording that prompted this proposal: “${b.ref.text}” (${b.ref.state ?? "unstated"}; adapter ${b.ref.adapterId}). ${AI_OUTPUT_NOT_EVIDENCE}`, resolved: true };
    case "source_item": {
      // the words follow the CURRENT content, so a changed item reads differently on the stale card
      if (!c) return { ref: b.ref, text: `Source item ${b.ref.itemKey} is no longer in the current version of ${b.ref.sourceId}; as reviewed it read: ${b.ref.summary}`, resolved: false };
      return { ref: b.ref, text: `Source: ${sourceItemSummary(c, b.ref.version) ?? b.ref.summary}`, resolved: true };
    }
  }
}

/** Plain words for a resolved source item: name, version, period and the exact quote. */
export function sourceItemSummary(c: Record<string, unknown>, version: string): string | null {
  const item = c.item as Record<string, unknown> | undefined;
  if (!item || typeof c.name !== "string") return null;
  const period = item.period as { text?: unknown } | undefined;
  const value = item.value === null ? "unknown" : String(item.value);
  return `${c.name} (version ${version}), ${typeof period?.text === "string" ? period.text : "period not stated"}: “${String(item.quote)}” → ${value}`;
}

/** Plain words for a resolved Explore comparison. Counts and classifications
 *  only, straight from the engine's factual groups; never cause, support,
 *  confirmation or evidence for truth. */
export function crossContextSummary(c: Record<string, unknown>): string {
  const occ = (c.occurrences as unknown[] | undefined)?.length ?? 0;
  const con = (c.contrasts as unknown[] | undefined)?.length ?? 0;
  const g = (c.groups ?? {}) as Record<string, string[] | undefined>;
  const n = (k: string) => g[k]?.length ?? 0;
  const unresolved = n("insufficientAtOccurrences") + n("undecided") + n("contrastPartial");
  const parts = [
    `${occ} occurrence${occ === 1 ? "" : "s"} compared with ${con} time${con === 1 ? "" : "s"} recorded at another value`,
    `${n("differingAtOccurrences")} condition${n("differingAtOccurrences") === 1 ? "" : "s"} differed across the occurrences`,
    `${n("commonAtOccurrences")} recorded the same at every occurrence`,
  ];
  if (con > 0) parts.push(`of those, ${n("backgroundComplete")} also true at every contrast time, ${n("differentiatingComplete")} different at every contrast time, ${n("mixedComplete")} mixed`);
  parts.push(`${unresolved} unresolved`);
  return `${parts.join("; ")}.`;
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
  const prevContent = p.previousResolvedBasis ?? p.resolvedBasis;
  now.basis.forEach((b, i) => {
    const was = prevBasis.get(i);
    if (was === undefined) return;
    if (was !== b.text) {
      changedSince.push(`A cited record changed. It read: ${was} It now reads: ${b.text}`);
      return;
    }
    // same words, different resolved content: say WHAT moved, never guess why
    const beforeC = prevContent[i]?.content;
    const afterC = p.resolvedBasis[i]?.content;
    if (canonicalJSON(beforeC) === canonicalJSON(afterC)) return;
    if (b.ref.kind === "cross_context") changedSince.push(...crossContextDelta(beforeC, afterC));
    else changedSince.push(`A cited record changed in detail while its summary stayed the same: ${b.text}`);
  });
  if (p.previousPreview.nothingElseChanges !== p.preview.nothingElseChanges) changedSince.push(p.preview.nothingElseChanges ? "Nothing else changes any more." : "Something else changes now.");
  const outsBefore = JSON.stringify(p.previousPreview.expectedOutputs);
  const outsNow = JSON.stringify(p.preview.expectedOutputs);
  if (outsBefore !== outsNow) changedSince.push("The records it would create get different identifiers now.");
  if (changedSince.length === 0) changedSince.push("The difference is in the mechanical detail only; open Details to compare.");
  return { before, changedSince, now };
}

/** Which readings of an Explore comparison moved between two resolutions:
 *  occurrence and contrast sets, then each condition whose readings or
 *  classification changed. Factual deltas only. */
export function crossContextDelta(before: unknown, after: unknown): string[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const starts = (x: Record<string, unknown>, key: string) => ((x[key] as { application?: { start?: string } }[] | undefined) ?? []).map((s) => s.application?.start ?? "").join(", ");
  if (starts(b, "occurrences") !== starts(a, "occurrences")) out.push(`The occurrence times of the Explore comparison changed (were: ${starts(b, "occurrences") || "none"}; now: ${starts(a, "occurrences") || "none"}).`);
  if (starts(b, "contrasts") !== starts(a, "contrasts")) out.push(`The contrast times of the Explore comparison changed (were: ${starts(b, "contrasts") || "none"}; now: ${starts(a, "contrasts") || "none"}).`);
  type Cond = { variableId: string; name?: string; occurrenceValues?: unknown[]; atOccurrences?: string; contrastShows?: string; contrastCoverage?: string; commonValue?: unknown };
  const bc = new Map((((b.conditions as Cond[] | undefined) ?? [])).map((c) => [c.variableId, c]));
  const ac = new Map((((a.conditions as Cond[] | undefined) ?? [])).map((c) => [c.variableId, c]));
  const sig = (c: Cond | undefined) => (c ? canonicalJSON({ v: c.occurrenceValues, o: c.atOccurrences, s: c.contrastShows, k: c.contrastCoverage, m: c.commonValue }) : "absent");
  const reportedConditions = new Set<string>();
  for (const id of new Set([...bc.keys(), ...ac.keys()])) {
    const x = bc.get(id);
    const y = ac.get(id);
    if (sig(x) === sig(y)) continue;
    reportedConditions.add(id);
    const name = y?.name ?? x?.name ?? id;
    const word = (c: Cond | undefined) => (c ? `${c.atOccurrences ?? "?"} across occurrences${c.atOccurrences === "common" ? ` at ${String(c.commonValue)}` : ""}${c.contrastShows && c.contrastShows !== "none" ? `, contrasts ${c.contrastShows} (${c.contrastCoverage} coverage)` : ""}` : "not part of the comparison");
    out.push(`The reading of “${name}” in the Explore comparison changed: it was ${word(x)}; it is now ${word(y)}.`);
  }
  // per-slice context readings (what each occurrence and contrast time showed for every condition)
  type SliceLike = { role?: string; application?: { start?: string }; context?: { variableId: string; value: unknown; basis?: string }[] };
  const slices = (x: Record<string, unknown>) => [...((x.occurrences as SliceLike[] | undefined) ?? []), ...((x.contrasts as SliceLike[] | undefined) ?? [])];
  const readings = (x: Record<string, unknown>) => {
    const m = new Map<string, { value: unknown; basis?: string; role?: string; start?: string; variableId: string }>();
    for (const sl of slices(x)) for (const c of sl.context ?? []) m.set(`${sl.application?.start ?? ""}|${c.variableId}`, { value: c.value, basis: c.basis, role: sl.role, start: sl.application?.start, variableId: c.variableId });
    return m;
  };
  const rb = readings(b);
  const ra = readings(a);
  const nameOf = (id: string) => ac.get(id)?.name ?? bc.get(id)?.name ?? id;
  const said = (v: { value: unknown; basis?: string } | undefined) => (v === undefined ? "not read" : `${v.value === null ? "unknown" : String(v.value)}${v.basis ? ` (${String(v.basis).replace(/_/g, " ")})` : ""}`);
  for (const key of new Set([...rb.keys(), ...ra.keys()])) {
    const x = rb.get(key);
    const y = ra.get(key);
    if (canonicalJSON({ v: x?.value, b: x?.basis }) === canonicalJSON({ v: y?.value, b: y?.basis })) continue;
    const at = (y ?? x)!;
    if (reportedConditions.has(at.variableId)) continue; // the condition-level line already names it
    out.push(`The reading of “${nameOf(at.variableId)}” at ${(at.start ?? "").slice(0, 10)} (${at.role === "contrast" ? "a contrast time" : "an occurrence"}) changed: it was ${said(x)}; it is now ${said(y)}.`);
  }
  const ev = (x: Record<string, unknown>) => canonicalJSON(((x.occurrences as { eventsNear?: unknown }[] | undefined) ?? []).map((s) => s.eventsNear));
  if (ev(b) !== ev(a)) out.push("The events recorded near the occurrences changed.");
  if (out.length === 0) out.push("The Explore comparison changed in a detail its summary does not show; open Details to compare.");
  return out;
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
