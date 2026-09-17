/**
 * Fixed descriptive sentence templates for the discovery layer, and the
 * phrase discipline the tests pin. Ordinary words: recorded, repeated,
 * changed, unknown, not enough history. Never: causes, structurally
 * persistent, invariant, hidden cause, generator, will continue, improved,
 * weakened. Every sentence describes records; none describes the person
 * or a cause.
 */
import type { EvidenceFacts, VariableHistoryDescription } from "./describe-history";

/** Phrases the default descriptive output must never contain. */
export const FORBIDDEN_PHRASES = [
  "causes",
  "is the cause",
  "structurally persistent",
  "invariant",
  "hidden cause",
  "generator",
  "will continue",
  "improved",
  "weakened",
  "explains the outcome",
] as const;

/** The fixed disclaimer shown with every discovery result. */
export const CAUSATION_DISCLAIMER = "Repeated or stable observations do not establish cause.";

/** The caution every "Explore this pattern" card ends with (no write path exists yet). */
export const EXPLORE_PATTERN_CAUTION =
  "That makes it a pattern worth examining, but none of this establishes the underlying cause. Competing explanations (circumstances, structure, outside shocks, incentives, habits, or a mix) deserve the same look before any one of them becomes a working model.";

/** Surrounding context for an Explore card: what the interval description
 *  actually found around the candidate. Absent = nothing is claimed. */
export interface ExploreContext {
  /** Other recorded variables whose values differ over the same period. */
  variablesChanged: number;
  /** Events recorded during the period. */
  eventsInInterval: number;
}

/** The read-only "Explore this pattern" card. PATTERN EVIDENCE (from the
 *  variable's own facts) is worded separately from SURROUNDING CONTEXT
 *  (from the interval description), and context is stated only when it
 *  exists: the facts alone cannot know whether anything else changed. */
export function explorePatternText(facts: Pick<EvidenceFacts, "exactRepetition" | "lowRecordedVariation" | "explicitIntervalClaim">, context?: ExploreContext): string {
  const leads: string[] = [];
  if (facts.exactRepetition) leads.push("This condition was recorded more than once.");
  if (facts.lowRecordedVariation) leads.push("These recorded values stayed within a narrow range (display convention A23).");
  if (facts.explicitIntervalClaim) leads.push("This condition was explicitly stated for a period, as the person's own assertion.");
  if (leads.length === 0) leads.push("This condition is shown here because of what the records contain.");
  const around: string[] = [];
  if (context && context.variablesChanged > 0) around.push(`During the same period, ${context.variablesChanged} other recorded variable${context.variablesChanged > 1 ? "s" : ""} changed.`);
  if (context && context.eventsInInterval > 0) around.push(`${context.eventsInInterval} event${context.eventsInInterval > 1 ? "s were" : " was"} also recorded during the period.`);
  return [...leads, ...around, EXPLORE_PATTERN_CAUTION].join(" ");
}

/** Shown under a locus heading with no candidate. A draft is a candidate,
 *  not a grounded one, so the line claims nothing about evidence. */
export const NO_CANDIDATE_YET = "No candidate of this kind yet.";

/** Linked hypotheses are RELATED to the record; nothing yet says they explain the recurrence. */
export const RELATED_HYPOTHESES_HEADING = "Related hypotheses already in the model";
export const RELATED_HYPOTHESES_NOTE = "These are linked to this record. That does not mean they explain this recurrence.";

/** What "Investigate this explanation" does: it PROPOSES; only the review step creates anything. */
export const INVESTIGATE_TEXT = "Investigating an explanation proposes a hypothesis for your review. Nothing is created from here; a hypothesis exists only once you approve the proposal, and even then it is a working hypothesis to test, not a conclusion.";
/** Why Investigate may be unavailable: never a reason to write directly. */
export const INVESTIGATE_UNAVAILABLE_TEXT = "Investigating is unavailable until the proposal ledger can be read; nothing is written around it.";

/** The seven Explore questions, in order, as the screen shows them. */
export const EXPLORE_QUESTIONS = [
  "This kept happening.",
  "What was different each time?",
  "What was the same each time?",
  "How did the other recorded times compare?",
  "What is still unresolved?",
  "Possible explanations to investigate",
] as const;

/** A presentation lens: the section a sentence is written for. The
 *  underlying description is unchanged; only the sentence differs. */
export type HistoryLens = VariableHistoryDescription["summaryClass"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 2026" from an ISO instant or date (UTC). */
export function monthYear(iso: string): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  return `${MONTHS[m - 1] ?? "?"} ${y}`;
}

/** "10 Mar 2026" from an ISO instant or date (UTC). */
export function dayMonthYear(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${monthYear(iso)}`;
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null) return "unknown";
  const n = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  return unit ? `${n} ${unit}` : n;
}

export interface HistorySentences {
  /** Level 1: one ordinary-language line. */
  headline: string;
  /** Level 2: evidence lines (dates, counts, caveats), in order. */
  details: string[];
}

/** Sentences for one variable's history description under its own
 *  summary lens. Pure and total. */
export function historySentences(d: VariableHistoryDescription): HistorySentences {
  return historySentenceFor(d, d.summaryClass);
}

/** Sentences for one variable's history description under the LENS of the
 *  section showing it. A value that changed and was also recorded again
 *  gets a "changed" sentence in one section and a "repeated" sentence in
 *  the other; each states its own fact and neither claims continuity. */
export function historySentenceFor(d: VariableHistoryDescription, lens: HistoryLens): HistorySentences {
  const n = d.distinctApplicationTimeCount;
  const first = d.applicationTimes.find((t) => t.kind === "known")?.start;
  const last = [...d.applicationTimes].reverse().find((t) => t.kind === "known")?.start;
  const span = first && last && first !== last ? `${monthYear(first)} → ${monthYear(last)}` : first ? monthYear(first) : null;
  const details: string[] = [];
  let headline: string;

  switch (lens) {
    case "repeated": {
      const parts = d.repeatedValues.map((r) => {
        const times = r.applicationTimes;
        const rspan = times.length > 1 && times[0] !== times.at(-1) ? `, ${monthYear(times[0])} → ${monthYear(times.at(-1) as string)}` : "";
        return `${formatValue(r.value, d.unit)} was recorded on ${times.length} dates${rspan}`;
      });
      headline = `${d.name}: ${parts.length > 0 ? parts.join("; ") : "no value was recorded on more than one date"}.`;
      details.push(`${d.knownRecordCount} dated records with a known value; ${d.distinctApplicationTimeCount} distinct application times.`);
      details.push("A value recorded again is a repeated record; it does not show that the value held between the dates.");
      break;
    }
    case "low_variation": {
      headline = `${d.name}: ${n} recorded values, ${formatValue(d.variation.min, d.unit)} → ${formatValue(d.variation.max, d.unit)}${span ? `, ${span}` : ""}; low recorded variation under display convention A23.`;
      details.push(`Raw range ${formatValue(d.variation.rawRange, d.unit)}; ${((d.variation.normalizedRange ?? 0) * 100).toFixed(0)}% of the reference range (${d.variation.referenceRange?.min} to ${d.variation.referenceRange?.max}); convention threshold ${((d.variation.convention?.tolerance ?? 0) * 100).toFixed(0)}%.`);
      details.push("Low variation is a display convention over the recorded values, not persistence, structure or continuity.");
      break;
    }
    case "changed": {
      headline = `${d.name}: ${n} recorded values ranged from ${formatValue(d.variation.min, d.unit)} to ${formatValue(d.variation.max, d.unit)}${span ? `, ${span}` : ""}; the recorded values differ.`;
      details.push(`${d.differingRecordedPairs} of ${Math.max(0, n - 1)} consecutive record pairs differ (a count of records compared, not of changes that happened).`);
      if (d.variation.referenceRange === null) details.push("No reference range is declared, so the size of the change is reported raw, never as small or large.");
      break;
    }
    case "explicit_claim": {
      const c = d.explicitIntervalClaims[0];
      headline = `${d.name}: recorded as ${formatValue(c.value, d.unit)} for ${c.text || `${dayMonthYear(c.assertedStart)} to ${dayMonthYear(c.assertedEnd)}`}, as stated.`;
      details.push(`The period is the person's own assertion (${dayMonthYear(c.assertedStart)} to ${dayMonthYear(c.assertedEnd)}); it ${c.coversRequestedInterval ? "covers" : "partly covers"} the requested interval.`);
      break;
    }
    case "last_known_only": {
      const b = d.atEnd.value !== null ? d.atEnd : d.atStart;
      headline = `${d.name}: no value recorded in this period; the last recorded value (${formatValue(b.value, d.unit)}${b.carriedFrom ? `, ${monthYear(b.carriedFrom)}` : ""}) still resolves because nothing replaced it.`;
      details.push("This is the model's resolved value, not an observation made during the period.");
      break;
    }
    case "insufficient": {
      headline = n === 1 ? `${d.name}: only one dated value in this period${span ? ` (${span})` : ""}; not enough history to say whether it repeated.` : `${d.name}: no dated values in this period; not enough history.`;
      break;
    }
    case "unresolved": {
      const why = d.facts.ambiguityPresent
        ? "two records start at the same time and disagree"
        : d.facts.unorderableEvidencePresent && d.entries.orderable === 0
          ? "the only records have no orderable time"
          : "the value was recorded as unknown";
      headline = `${d.name}: unknown for this period; ${why}.`;
      break;
    }
  }

  for (const c of d.caveats) {
    if (c.code === "repetition_not_continuity" || c.code === "a23_display" || c.code === "insufficient") continue; // already in the level-2 lines above
    details.push(c.text);
  }
  if (d.unorderableRecordCount > 0) details.push(`${d.unorderableRecordCount} record${d.unorderableRecordCount > 1 ? "s" : ""} with no orderable time kept aside.`);
  return { headline, details };
}

/** True when a sentence contains a forbidden phrase (word-boundary, case-insensitive). */
/** A person's own words (variable names, units) are masked before the
 *  check, so the guard polices the engine's sentences and never throws on
 *  a variable named "Improved cash flow" (review finding, 2026-09-17). */
export function containsForbiddenPhrase(text: string, options: { ignoring?: readonly string[] } = {}): string | null {
  let lower = text.toLowerCase();
  const names = [...new Set((options.ignoring ?? []).map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
  for (const n of names) lower = lower.split(n).join("\u2026");
  for (const p of FORBIDDEN_PHRASES) if (new RegExp(`\\b${p.replace(/\s+/g, "\\s+")}\\b`).test(lower)) return p;
  return null;
}
