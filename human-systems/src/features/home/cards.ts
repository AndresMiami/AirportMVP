/**
 * HOME CARDS (Step 6A): plain-language cards over systems that already
 * exist. Nothing here analyses anything new:
 *   - "Something keeps showing up" comes from the deterministic History
 *     engine (describeVariableHistory, exact repetition only);
 *   - "Needs your review" counts the proposal ledger;
 *   - "Working explanations" counts canonical hypotheses.
 * Pure; no React; no household.
 */
import { normalizeIntervalStart, normalizeIntervalEnd } from "@/discovery/interval";
import { describeVariableHistory } from "@/discovery/describe-history";
import { historySentenceFor } from "@/discovery/language";
import { encodePatternRef } from "@/discovery/pattern-ref";
import { temporalInterval } from "@/calculations/time";
import type { MutationProposal } from "@/kernel/types";
import { recurrenceSentence } from "@/features/plain-language";
import type { Hypothesis, StoredVariable, SystemModel } from "@/types";

export interface RecurrenceCard {
  variableId: string;
  subjectId: string;
  /** One ordinary-language line from the History engine (History wording). */
  headline: string;
  /** Evidence lines, in order (History wording). */
  details: string[];
  /** Home wording over the SAME facts: "Total debt was $4,000 on 7
   *  recorded dates between February 2025 and June 2026." */
  sentence: string;
  occurrences: number;
  /** The Explore hand-off for the strongest repetition. */
  exploreHref: string;
  /** Back to History with the same period. */
  historyHref: string;
}

export { longDate, monthName, recurrenceSentence } from "@/features/plain-language";
/** Kept under its Home name; the implementation is shared (6B). */
export { plainQuantity as homeQuantity } from "@/features/plain-language";

const OPEN: ReadonlySet<MutationProposal["status"]> = new Set(["proposed", "reviewed", "stale", "failed", "applying"]);

function earliestStart(v: StoredVariable): string | null {
  let earliest: string | null = null;
  for (const e of v.values) {
    if (e.status !== "active") continue;
    const iv = temporalInterval(e.valid);
    if (!iv) continue;
    const s = normalizeIntervalStart(iv.start);
    if (earliest === null || s < earliest) earliest = s;
  }
  return earliest;
}

/**
 * Repeated records over each assigned input variable's whole recorded span
 * up to `today` (a date). Strongest first (most occurrences, then name).
 * At most `limit` cards; none when nothing repeats.
 */
export function recurrenceCards(model: SystemModel, today: string, limit = 3): RecurrenceCard[] {
  const cards: RecurrenceCard[] = [];
  const to = today.slice(0, 10);
  for (const v of model.variables) {
    if (v.kind !== "input" || v.subjectId === null) continue;
    const earliest = earliestStart(v);
    if (!earliest) continue;
    const from = earliest.slice(0, 10);
    if (normalizeIntervalStart(from) > normalizeIntervalEnd(to)) continue;
    const d = describeVariableHistory(v, { from, to });
    if (!d.facts.exactRepetition || d.repeatedValues.length === 0) continue;
    const strongest = [...d.repeatedValues].sort((a, b) => b.applicationTimes.length - a.applicationTimes.length || a.value - b.value)[0];
    const sentences = historySentenceFor(d, "repeated");
    cards.push({
      variableId: v.id,
      subjectId: v.subjectId,
      headline: sentences.headline,
      details: sentences.details,
      sentence: recurrenceSentence(d.name, strongest.value, d.unit, strongest.applicationTimes),
      occurrences: strongest.applicationTimes.length,
      exploreHref: `/explore?${encodePatternRef({ variableId: v.id, subjectId: v.subjectId, interval: { from, to }, repeatedValue: strongest.value, occurrenceTimes: strongest.applicationTimes })}`,
      historyHref: `/history?${new URLSearchParams({ from, to }).toString()}`,
    });
  }
  cards.sort((a, b) => b.occurrences - a.occurrences || a.headline.localeCompare(b.headline));
  return cards.slice(0, limit);
}

export interface RecurrenceOverview {
  /** The strongest repetition, or null when nothing repeats. */
  strongest: RecurrenceCard | null;
  /** How many further repeated patterns History holds. */
  more: number;
}

/** Home shows ONE pattern and counts the rest; History shows them all. */
export function recurrenceOverview(model: SystemModel, today: string): RecurrenceOverview {
  const all = recurrenceCards(model, today, Number.POSITIVE_INFINITY);
  return { strongest: all[0] ?? null, more: Math.max(0, all.length - 1) };
}

/** Proposals waiting for the person: proposed, reviewed, stale, failed or applying. */
export function openProposalCount(proposals: readonly MutationProposal[]): number {
  return proposals.filter((p) => OPEN.has(p.status)).length;
}

/** Hypotheses the person is currently working with: everything not rejected. */
export function workingHypotheses(model: Pick<SystemModel, "hypotheses">): Hypothesis[] {
  return model.hypotheses.filter((h) => h.status !== "rejected");
}
