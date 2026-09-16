/**
 * HISTORY WORDING (Step 6B): the first layer of History reads as three
 * ordinary questions — what changed, what keeps showing up, what still
 * needs more information — over the deterministic discovery engine's
 * description. PRESENTATION ONLY: every distinction the engine makes
 * (change, exact recurrence, low recorded variation, an explicitly
 * stated period, a carried-forward value, insufficient history,
 * ambiguity, unknowns) keeps its own row, tag and Explore hand-off; the
 * engine's own sentence, record counts and caveats stay available under
 * Details. The Explore PatternRef is encoded exactly as before. Pure; no
 * React; no household.
 */
import { dayMonthYear, encodePatternRef, type HistoryLens, type IntervalDescription, type VariableHistoryDescription } from "@/discovery";
import { monthName, plainQuantity, plainSpan, recurrenceSentence } from "@/features/plain-language";

export type HistoryQuestion = "changed" | "recurring" | "needs_information";

export interface HistoryRow {
  key: string;
  variableId: string;
  subjectId: string | null;
  lens: HistoryLens;
  /** Which of the three questions the row answers. */
  question: HistoryQuestion;
  /** A quiet distinction label ("Same value", "Stayed close", "As stated", "Old value still standing", "Not enough history", "Unknown"); null for plain change. */
  tag: string | null;
  /** The ordinary-language sentence. */
  text: string;
  /** The exact Explore hand-off for an exact repetition of ONE value (same PatternRef as always); null otherwise. */
  exploreHref: string | null;
  /** The value this row is about when the lens is "repeated" (one row per repeated value). */
  repeatedValue: number | null;
}

const knownTimes = (d: VariableHistoryDescription) => d.applicationTimes.filter((t) => t.kind === "known").map((t) => t.start);

/** The Explore hand-off: the pattern's variable, subject, requested interval, repeated value and its occurrence times. Unchanged from the original History screen. */
export function explorePatternHref(d: VariableHistoryDescription, repeatedValue: number, occurrenceTimes: readonly string[]): string | null {
  if (d.subjectId === null) return null;
  return `/explore?${encodePatternRef({ variableId: d.variableId, subjectId: d.subjectId, interval: { from: d.interval.requested.from, to: d.interval.requested.to }, repeatedValue, occurrenceTimes: [...occurrenceTimes] })}`;
}

/** The plain sentence(s) for one described variable under one lens. "repeated" yields one row per repeated value. */
export function historyRows(d: VariableHistoryDescription, lens: HistoryLens): HistoryRow[] {
  const n = d.distinctApplicationTimeCount;
  const span = plainSpan(knownTimes(d));
  const base = { variableId: d.variableId, subjectId: d.subjectId, lens };
  switch (lens) {
    case "changed":
      return [
        {
          ...base,
          key: `${d.variableId}:changed`,
          question: "changed",
          tag: null,
          text: `${d.name} ranged from ${plainQuantity(d.variation.min, d.unit)} to ${plainQuantity(d.variation.max, d.unit)} across ${n} recorded values${span}.`,
          exploreHref: null,
          repeatedValue: null,
        },
      ];
    case "repeated":
      return d.repeatedValues.map((rv) => ({
        ...base,
        key: `${d.variableId}:repeated:${rv.value}`,
        question: "recurring",
        tag: "Same value",
        text: recurrenceSentence(d.name, rv.value, d.unit, rv.applicationTimes),
        exploreHref: explorePatternHref(d, rv.value, rv.applicationTimes),
        repeatedValue: rv.value,
      }));
    case "low_variation":
      return [
        {
          ...base,
          key: `${d.variableId}:low_variation`,
          question: "recurring",
          tag: "Stayed close",
          text: `${d.name} stayed between ${plainQuantity(d.variation.min, d.unit)} and ${plainQuantity(d.variation.max, d.unit)} across ${n} recorded values${span}.`,
          exploreHref: null,
          repeatedValue: null,
        },
      ];
    case "explicit_claim": {
      const c = d.explicitIntervalClaims[0];
      return [
        {
          ...base,
          key: `${d.variableId}:explicit_claim`,
          question: "recurring",
          tag: "As stated",
          text: `${d.name} was recorded as ${plainQuantity(c.value, d.unit)} for ${c.text || `${dayMonthYear(c.assertedStart)} to ${dayMonthYear(c.assertedEnd)}`}, in the person's own words.`,
          exploreHref: null,
          repeatedValue: null,
        },
      ];
    }
    case "last_known_only": {
      const b = d.atEnd.value !== null ? d.atEnd : d.atStart;
      return [
        {
          ...base,
          key: `${d.variableId}:last_known_only`,
          question: "needs_information",
          tag: "Old value still standing",
          text: `${d.name}: nothing new was recorded in this period. The last recorded value, ${plainQuantity(b.value, d.unit)}${b.carriedFrom ? ` from ${monthName(b.carriedFrom)}` : ""}, still stands because nothing replaced it.`,
          exploreHref: null,
          repeatedValue: null,
        },
      ];
    }
    case "insufficient":
      return [
        {
          ...base,
          key: `${d.variableId}:insufficient`,
          question: "needs_information",
          tag: "Not enough history",
          text: n === 1 ? `${d.name} has only one recorded value in this period${span}, so nothing can be said about it repeating.` : `${d.name} has no dated values in this period.`,
          exploreHref: null,
          repeatedValue: null,
        },
      ];
    case "unresolved": {
      const why = d.facts.ambiguityPresent ? "two records start at the same time and disagree" : d.facts.unorderableEvidencePresent && d.entries.orderable === 0 ? "its only records have no orderable time" : "it was recorded as unknown";
      return [
        {
          ...base,
          key: `${d.variableId}:unresolved`,
          question: "needs_information",
          tag: "Unknown",
          text: `${d.name} is unknown for this period: ${why}.`,
          exploreHref: null,
          repeatedValue: null,
        },
      ];
    }
  }
}

export interface HistoryQuestions {
  changed: HistoryRow[];
  recurring: HistoryRow[];
  needsInformation: HistoryRow[];
}

/** The three questions over an interval description. Same buckets as the engine, one row per (variable, fact), repeated values one row each. */
export function historyQuestions(d: IntervalDescription): HistoryQuestions {
  const rows = (items: IntervalDescription["variables"], lens: HistoryLens) => items.flatMap((v) => historyRows(v.description, lens));
  return {
    changed: rows(d.buckets.changed, "changed"),
    recurring: [...rows(d.buckets.repeated, "repeated"), ...rows(d.buckets.lowVariation, "low_variation"), ...rows(d.buckets.explicitClaims, "explicit_claim")],
    needsInformation: [...rows(d.buckets.lastKnownOnly, "last_known_only"), ...rows(d.buckets.insufficient, "insufficient"), ...rows(d.buckets.unresolved, "unresolved")],
  };
}

export interface RowGroup {
  tag: string;
  rows: HistoryRow[];
  /** One ordinary sentence standing in for the rows while the group is collapsed. */
  summary: string;
  /** Groups above the threshold start collapsed; the rows are one tap away and keep their Details. */
  collapsed: boolean;
}

export const GROUP_THRESHOLD = 3;

const GROUP_SUMMARY: Record<string, (n: number, months: string[]) => string> = {
  "Not enough history": (n, months) => `${n} variables have only one recorded value in this period${months.length === 1 ? ` (all in ${months[0]})` : ""}, so nothing can be said about them repeating.`,
  "Old value still standing": (n) => `${n} variables had nothing new recorded in this period; their last recorded values still stand because nothing replaced them.`,
  Unknown: (n) => `${n} variables are unknown for this period.`,
};

/**
 * "What still needs more information?" grouped by its distinction, in the
 * engine's order (old value still standing, not enough history, unknown).
 * A group with more than GROUP_THRESHOLD rows collapses to one summary
 * sentence; nothing is dropped and every row keeps its own text.
 */
export function needsInformationGroups(rows: HistoryRow[]): RowGroup[] {
  const order = ["Old value still standing", "Not enough history", "Unknown"];
  return order
    .map((tag) => rows.filter((r) => r.tag === tag))
    .filter((g) => g.length > 0)
    .map((g) => {
      const tag = g[0].tag as string;
      const months = [...new Set(g.map((r) => r.text.match(/ in ([A-Z][a-z]+ \d{4}),/)?.[1]).filter((m): m is string => Boolean(m)))];
      return { tag, rows: g, summary: GROUP_SUMMARY[tag](g.length, months), collapsed: g.length > GROUP_THRESHOLD };
    });
}

/** "3 recorded variables, 12 dated values and 2 events" for the period line. */
export function periodSummary(d: IntervalDescription): string {
  const dated = d.variables.reduce((n, v) => n + v.description.knownRecordCount, 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${plural(d.variables.length, "recorded variable", "recorded variables")}, ${plural(dated, "dated value", "dated values")} and ${plural(d.events.inInterval.length, "event", "events")}`;
}
