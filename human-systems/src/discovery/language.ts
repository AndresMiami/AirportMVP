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

/** The read-only "Explore this pattern" card, worded from the evidence
 *  that made the variable a candidate. Several facts may hold at once. */
export function explorePatternText(facts: Pick<EvidenceFacts, "exactRepetition" | "lowRecordedVariation" | "explicitIntervalClaim">): string {
  const leads: string[] = [];
  if (facts.exactRepetition) leads.push("This condition was recorded more than once while other things changed.");
  if (facts.lowRecordedVariation) leads.push("These recorded values stayed within a narrow range (display convention A23) while other things changed.");
  if (facts.explicitIntervalClaim) leads.push("This condition was explicitly stated for a period, as the person's own assertion.");
  if (leads.length === 0) leads.push("This condition is shown here because of what the records contain.");
  return `${leads.join(" ")} ${EXPLORE_PATTERN_CAUTION}`;
}

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

/** Sentences for one variable's history description. Pure and total. */
export function historySentences(d: VariableHistoryDescription): HistorySentences {
  const n = d.distinctApplicationTimeCount;
  const first = d.applicationTimes.find((t) => t.kind === "known")?.start;
  const last = [...d.applicationTimes].reverse().find((t) => t.kind === "known")?.start;
  const span = first && last && first !== last ? `${monthYear(first)} → ${monthYear(last)}` : first ? monthYear(first) : null;
  const details: string[] = [];
  let headline: string;

  switch (d.summaryClass) {
    case "repeated": {
      const v = d.repeatedValues.map((r) => formatValue(r.value, d.unit)).join(", ");
      headline = `${d.name}: the same value (${v}) recorded on ${n} dates${span ? `, ${span}` : ""}.`;
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
      const repeat = d.repeatedValues.length > 0 ? `, and ${d.repeatedValues.map((r) => `${formatValue(r.value, d.unit)} was recorded on ${r.applicationTimes.length} dates`).join("; ")}` : "";
      headline = `${d.name}: ${n} recorded values, ${formatValue(d.variation.min, d.unit)} → ${formatValue(d.variation.max, d.unit)}${span ? `, ${span}` : ""}; the recorded values differ${repeat}.`;
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
export function containsForbiddenPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const p of FORBIDDEN_PHRASES) if (new RegExp(`\\b${p.replace(/\s+/g, "\\s+")}\\b`).test(lower)) return p;
  return null;
}
