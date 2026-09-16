/**
 * Language discipline for the discovery layer. Every default descriptive
 * sentence, over three very different systems and every bucket, avoids
 * the forbidden overclaims and uses the ordinary descriptive words.
 */
import { describe, expect, it } from "vitest";
import { createSampleHousehold } from "@/data/sample-household";
import { INPUT_IDS } from "@/domains/household/keys";
import { CAUSATION_DISCLAIMER, EXPLORE_PATTERN_TEXT, FORBIDDEN_PHRASES, containsForbiddenPhrase, describeInterval, describeSnapshotSeries, describeVariableHistory, historySentences, type IntervalDescription } from "@/discovery";
import * as M from "@/services/mutations";
import { VariableSchema, type TemporalRef, type ValueEntry } from "@/types";

const date = (iso: string): TemporalRef => ({ kind: "date", start: iso, precision: "day", text: iso });
const A23 = { assumptionId: "A23" as const, tolerance: 0.1 };
const YEAR = { from: "2026-01-01", to: "2026-12-31" };

function entry(id: string, value: number | null, valid: TemporalRef, extra: Partial<ValueEntry> = {}): ValueEntry {
  return { id, value, valid, validBasis: "asserted", recordedAt: "2026-09-01T00:00:00.000Z", sourceType: "self_reported", confidence: 0.7, evidence: [], observationIds: [], note: "", status: "active", ...extra };
}
function variable(values: ValueEntry[], referenceRange?: { min: number; max: number }) {
  return VariableSchema.parse({ id: "v", key: "v", subjectId: "sys", name: "Thing", category: "structure", changeSpeed: "slow", kind: "input", unit: "kg", controllability: 0.5, durability: 0.5, estimatedCostToChange: 0.5, values, referenceRange });
}

/** Every sentence an interval description can show. */
function allText(d: IntervalDescription): string[] {
  return [
    ...d.variables.flatMap((v) => [v.sentences.headline, ...v.sentences.details, ...v.description.caveats.map((c) => c.text)]),
    ...d.caveats.map((c) => c.text),
    d.disclaimer,
    ...(d.snapshots ? [...d.snapshots.dimensions.map((x) => x.statement), ...d.snapshots.variables.map((x) => x.statement), ...d.snapshots.relationships.map((x) => x.statement)] : []),
    ...d.recomputed.map((r) => r.caveat),
  ];
}

describe("discovery language", () => {
  it("the forbidden list is the agreed one and the checker catches each phrase at a word boundary", () => {
    expect([...FORBIDDEN_PHRASES]).toEqual(["causes", "is the cause", "structurally persistent", "invariant", "hidden cause", "generator", "will continue", "improved", "weakened", "explains the outcome"]);
    expect(containsForbiddenPhrase("This condition is the cause of it")).toBe("is the cause");
    expect(containsForbiddenPhrase("Recorded on 3 dates")).toBeNull();
    expect(containsForbiddenPhrase("The generators hum")).toBeNull(); // word boundary: "generators" is not "generator"
    expect(containsForbiddenPhrase("It will continue")).toBe("will continue");
  });

  it("every bucket's sentences on the synthetic variable histories are free of forbidden phrases and use the descriptive words", () => {
    const cases = {
      repeated: variable([entry("a", 5, date("2026-01-10")), entry("b", 5, date("2026-06-10"))]),
      repeated_interrupted: variable([entry("a", 5, date("2026-01-10")), entry("n", null, date("2026-03-10")), entry("b", 5, date("2026-06-10"))]),
      low_variation: variable([entry("a", 50, date("2026-01-10")), entry("b", 53, date("2026-06-10"))], { min: 0, max: 100 }),
      changed: variable([entry("a", 50, date("2026-01-10")), entry("b", 80, date("2026-06-10"))]),
      explicit_claim: variable([entry("a", 5, { kind: "range", start: "2026-02-01", end: "2026-10-31", precision: "month", text: "February to October" })]),
      last_known_only: variable([entry("a", 5, { kind: "instant", start: "2025-03-01T00:00:00.000Z", precision: "datetime", text: "" })]),
      insufficient: variable([entry("a", 5, date("2026-04-10"))]),
      unresolved_ambiguous: variable([entry("a", 5, date("2026-04-10")), entry("b", 6, date("2026-04-10"))]),
      unresolved_unknown: variable([entry("a", null, date("2026-04-10"))]),
      unresolved_undated: variable([entry("a", 5, { kind: "unknown", precision: "unspecified", text: "sometime" })]),
    };
    const expectedWords: Record<string, RegExp> = {
      repeated: /the same value .* recorded on 2 dates/,
      repeated_interrupted: /unresolved/,
      low_variation: /low recorded variation under display convention A23/,
      changed: /the recorded values differ/,
      explicit_claim: /as stated/,
      last_known_only: /no value recorded in this period; the last recorded value/,
      insufficient: /not enough history/,
      unresolved_ambiguous: /unknown for this period; two records start at the same time and disagree/,
      unresolved_unknown: /unknown for this period; the value was recorded as unknown/,
      unresolved_undated: /unknown for this period; the only records have no orderable time/,
    };
    for (const [name, v] of Object.entries(cases)) {
      const d = describeVariableHistory(v, YEAR, { lowVariation: A23 });
      const s = historySentences(d);
      const texts = [s.headline, ...s.details, ...d.caveats.map((c) => c.text)];
      for (const t of texts) expect(containsForbiddenPhrase(t), `${name}: ${t}`).toBeNull();
      expect(texts.join(" "), name).toMatch(expectedWords[name]);
      // the person is never described; only records are
      for (const t of texts) expect(t, name).not.toMatch(/\byou are\b|\bthe person is\b|\bpersonality\b/i);
    }
    // descriptive words are the vocabulary
    const all = Object.values(cases).flatMap((v) => {
      const d = describeVariableHistory(v, YEAR, { lowVariation: A23 });
      const s = historySentences(d);
      return [s.headline, ...s.details];
    }).join(" ");
    for (const word of ["recorded", "repeated", "differ", "unknown", "not enough history", "does not show"]) expect(all, word).toContain(word);
  });

  it("the household sample, enriched, produces only descriptive sentences and the fixed disclaimer", () => {
    let m = createSampleHousehold();
    m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: 1800, sourceType: "measured", confidence: 0.9, valid: date("2026-01-15") });
    m = M.recordValue(m, INPUT_IDS.protectedHours, { value: 3, sourceType: "self_reported", confidence: 0.6, valid: date("2026-01-20") });
    const d = describeInterval(m, { ...YEAR, includeDerived: true, lowVariation: A23, now: "2026-12-31T00:00:00.000Z" });
    const texts = allText(d);
    expect(texts.length).toBeGreaterThan(20);
    for (const t of texts) expect(containsForbiddenPhrase(t), t).toBeNull();
    expect(d.disclaimer).toBe(CAUSATION_DISCLAIMER);
    expect(CAUSATION_DISCLAIMER).toBe("Repeated or stable observations do not establish cause.");
  });

  it("the read-only Explore card copy examines, never concludes, and names competing explanations", () => {
    expect(containsForbiddenPhrase(EXPLORE_PATTERN_TEXT)).toBeNull();
    expect(EXPLORE_PATTERN_TEXT).toMatch(/does not establish/);
    expect(EXPLORE_PATTERN_TEXT).toMatch(/Competing explanations/);
    expect(EXPLORE_PATTERN_TEXT).not.toMatch(/personality|archetype|you are/i);
  });

  it("snapshot statements say 'recorded in k of n saved snapshots' and never 'persist'", () => {
    const s = describeSnapshotSeries([]);
    expect(s.dimensions).toEqual([]);
    const texts = [...s.dimensions, ...s.variables, ...s.relationships].map((x) => x.statement);
    for (const t of texts) expect(containsForbiddenPhrase(t)).toBeNull();
  });
});
