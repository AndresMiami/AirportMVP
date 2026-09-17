/**
 * EXPLORE WORDING (Step 6C): the first layer of Explore reads as five
 * ordinary questions over the deterministic cross-context result. This
 * module only WORDS what the engine already decided: every row comes from
 * one ConditionAssessment, every section from one engine group, exactly
 * as the engine grouped it. Nothing is recomputed, reordered by strength,
 * scored, or promoted: partial contrast coverage stays unresolved, a
 * carried-forward value never counts, and no sentence names a cause. The
 * engine's own statement and counts sit under each row's Details. Pure;
 * no React; no household.
 */
import type { ConditionAssessment, CrossContext } from "@/discovery";
import { plainQuantity, recurrenceSentence } from "@/features/plain-language";

export type ContrastGroup = "backgroundComplete" | "differentiatingComplete" | "mixedComplete";
export type UnresolvedGroup = "insufficientAtOccurrences" | "undecided" | "contrastPartial";

/** The three complete-contrast meanings, worded for people. Same meaning, same membership. */
export const CONTRAST_HEADINGS: Record<ContrastGroup, string> = {
  backgroundComplete: "Also true when this did not happen",
  differentiatingComplete: "Different when this did not happen",
  mixedComplete: "Mixed in the other recorded times",
};

/** The unresolved distinctions keep their own quiet tags; none is merged into another. */
export const UNRESOLVED_TAGS: Record<UnresolvedGroup, string> = {
  insufficientAtOccurrences: "Not readable at every time",
  undecided: "No usable comparison",
  contrastPartial: "Comparison incomplete",
};

export interface ExploreRow {
  variableId: string;
  /** Which engine group the row came from (unchanged membership). */
  group: keyof CrossContext["groups"];
  /** A quiet distinction label for unresolved rows; null elsewhere. */
  tag: string | null;
  /** The ordinary-language sentence. */
  text: string;
  /** The engine's own statement, for Details. */
  statement: string;
  /** Counts for Details: occurrences readable / total, contrast same / different / readable / total. */
  counts: { occurrenceUsable: number; occurrenceTotal: number; contrastSame: number; contrastDifferent: number; contrastUsable: number; contrastTotal: number; reliesOnRecordedBasis: boolean };
}

export interface ExploreSections {
  /** "This kept happening." — the pattern in plain words, from the result only. */
  pattern: string;
  different: ExploreRow[];
  same: ExploreRow[];
  /** Only groups with entries are listed, in the engine's order. */
  compared: { group: ContrastGroup; heading: string; rows: ExploreRow[] }[];
  unresolved: ExploreRow[];
}

const fmt = (v: number | null, unit: string) => plainQuantity(v, unit);

function row(c: ConditionAssessment, group: keyof CrossContext["groups"], text: string, tag: string | null = null): ExploreRow {
  return {
    variableId: c.variableId,
    group,
    tag,
    text,
    statement: c.statement,
    counts: { occurrenceUsable: c.occurrenceUsable, occurrenceTotal: c.occurrenceTotal, contrastSame: c.contrastSame, contrastDifferent: c.contrastDifferent, contrastUsable: c.contrastUsable, contrastTotal: c.contrastTotal, reliesOnRecordedBasis: c.reliesOnRecordedBasis },
  };
}

/** One plain sentence per condition, by the group the engine put it in. */
export function conditionSentence(c: ConditionAssessment, group: keyof CrossContext["groups"]): string {
  const v = fmt(c.commonValue, c.unit);
  switch (group) {
    case "differingAtOccurrences":
      return `${c.name} changed each time: ${c.occurrenceValues.map((x) => fmt(x, c.unit)).join(" → ")}.`;
    case "commonAtOccurrences":
      return `${c.name} was ${v} each time.`;
    case "backgroundComplete":
      return `${c.name} was ${v} each time, and also at every other recorded time.`;
    case "differentiatingComplete":
      return `${c.name} was ${v} each time, and different in all of the recorded comparison cases.`;
    case "mixedComplete":
      return `${c.name} was ${v} each time; at the other recorded times it was sometimes the same and sometimes different.`;
    case "insufficientAtOccurrences":
      return `${c.name} could not be read at every one of these times.`;
    case "undecided":
      return `${c.name} was ${v} each time, but no other recorded time can be read to compare it with.`;
    case "contrastPartial":
      return `${c.name} was ${v} each time; some of the other recorded times cannot be read, so the comparison is incomplete.`;
  }
}

/** The five questions over one cross-context result. Membership is the engine's, row by row. */
export function exploreSections(r: CrossContext): ExploreSections {
  const byId = new Map(r.conditions.map((c) => [c.variableId, c]));
  const rows = (group: keyof CrossContext["groups"], tag: string | null = null) =>
    r.groups[group].map((id) => byId.get(id)).filter((c): c is ConditionAssessment => Boolean(c)).map((c) => row(c, group, conditionSentence(c, group), tag));
  const contrastGroups: ContrastGroup[] = ["backgroundComplete", "differentiatingComplete", "mixedComplete"];
  return {
    pattern: recurrenceSentence(r.variableName, r.pattern.repeatedValue, r.unit, r.occurrences.map((s) => s.application.start)),
    different: rows("differingAtOccurrences"),
    same: rows("commonAtOccurrences"),
    compared: contrastGroups.map((group) => ({ group, heading: CONTRAST_HEADINGS[group], rows: rows(group) })).filter((g) => g.rows.length > 0),
    unresolved: [...rows("insufficientAtOccurrences", UNRESOLVED_TAGS.insufficientAtOccurrences), ...rows("undecided", UNRESOLVED_TAGS.undecided), ...rows("contrastPartial", UNRESOLVED_TAGS.contrastPartial)],
  };
}

/** How a draft's proposal reads on Explore. Plain status, never hidden; review happens in Proposals only. */
export function proposalStatusLine(status: string | null): string {
  switch (status) {
    case "proposed":
    case "reviewed":
      return "Waiting for your review";
    case "stale":
      return "Needs a fresh review: something it rested on has changed";
    case "applying":
      return "Being applied";
    case "failed":
      return "Could not be applied; you can check again in review";
    case "superseded":
      return "Replaced by a newer proposal";
    default:
      return "A proposal exists for this explanation";
  }
}

export const EXPLORE_CAVEAT = "These comparisons can help you form explanations. They do not establish a cause.";
export const NO_CONTRASTS_YET = "There are no other recorded values to compare with yet.";
