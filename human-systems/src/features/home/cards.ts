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
import type { Hypothesis, StoredVariable, SystemModel } from "@/types";

export interface RecurrenceCard {
  variableId: string;
  subjectId: string;
  /** One ordinary-language line from the History engine. */
  headline: string;
  /** Evidence lines, in order. */
  details: string[];
  occurrences: number;
  /** The Explore hand-off for the strongest repetition. */
  exploreHref: string;
  /** Back to History with the same period. */
  historyHref: string;
}

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
      occurrences: strongest.applicationTimes.length,
      exploreHref: `/explore?${encodePatternRef({ variableId: v.id, subjectId: v.subjectId, interval: { from, to }, repeatedValue: strongest.value, occurrenceTimes: strongest.applicationTimes })}`,
      historyHref: `/history?${new URLSearchParams({ from, to }).toString()}`,
    });
  }
  cards.sort((a, b) => b.occurrences - a.occurrences || a.headline.localeCompare(b.headline));
  return cards.slice(0, limit);
}

/** Proposals waiting for the person: proposed, reviewed, stale, failed or applying. */
export function openProposalCount(proposals: readonly MutationProposal[]): number {
  return proposals.filter((p) => OPEN.has(p.status)).length;
}

/** Hypotheses the person is currently working with: everything not rejected. */
export function workingHypotheses(model: Pick<SystemModel, "hypotheses">): Hypothesis[] {
  return model.hypotheses.filter((h) => h.status !== "rejected");
}
