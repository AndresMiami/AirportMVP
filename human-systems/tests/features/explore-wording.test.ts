/**
 * EXPLORE WORDING (6C): five ordinary questions over the deterministic
 * cross-context result. Presentation only — every row comes from one
 * assessment in the group the engine put it in, membership is the
 * engine's exactly, incomplete coverage stays unresolved, and no sentence
 * names a cause. Neutral domain; household mocked to throw.
 */
import { describe, expect, it, vi } from "vitest";
import { containsForbiddenPhrase, contextSubjectsFor, crossContext, type ConditionAssessment } from "@/discovery";
import { CONTRAST_HEADINGS, EXPLORE_CAVEAT, UNRESOLVED_TAGS, conditionSentence, exploreSections, proposalStatusLine } from "@/features/explore/wording";
import { CC_C, CC_DATE, CC_DOMAIN, CC_O, CC_PATTERN, ccEntry, ccSystem, ccVariable } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

const CAUSAL = /\bcaused\b|\bexplains\b|strong evidence|likely cause|\bpredictor\b|\bproves\b|\bconfirms\b/i;

/** The neutral system plus one condition that is common at every occurrence but recorded UNKNOWN at one contrast time: coverage partial, never promoted. */
const system = () => {
  const m = ccSystem();
  const partial = ccVariable("partial_cond", "p1", [...CC_O.map((d) => ccEntry(2, CC_DATE(d))), ccEntry(2, CC_DATE("2026-06-01")), ccEntry(5, CC_DATE(CC_C[0])), ccEntry(null, CC_DATE(CC_C[1])), ccEntry(5, CC_DATE(CC_C[2]))]);
  return { ...m, variables: [...m.variables, partial] };
};
const result = () => {
  const m = system();
  const r = crossContext(m, CC_PATTERN, { contextSubjectIds: contextSubjectsFor(m, CC_PATTERN, CC_DOMAIN) });
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe("exploreSections", () => {
  it("is the engine's grouping, row by row: same ids, same order, every condition exactly once, partial coverage under unresolved", () => {
    const r = result();
    const s = exploreSections(r);
    expect(s.different.map((x) => x.variableId)).toEqual(r.groups.differingAtOccurrences);
    expect(s.same.map((x) => x.variableId)).toEqual(r.groups.commonAtOccurrences);
    for (const g of s.compared) expect(g.rows.map((x) => x.variableId)).toEqual(r.groups[g.group]);
    expect(s.compared.map((g) => g.group)).toEqual((["backgroundComplete", "differentiatingComplete", "mixedComplete"] as const).filter((g) => r.groups[g].length > 0));
    expect(s.unresolved.map((x) => x.variableId)).toEqual([...r.groups.insufficientAtOccurrences, ...r.groups.undecided, ...r.groups.contrastPartial]);
    // the "same each time" ids are partitioned exactly across compared + unresolved(undecided/partial)
    const comparedIds = s.compared.flatMap((g) => g.rows.map((x) => x.variableId));
    const partialIds = s.unresolved.filter((x) => x.group !== "insufficientAtOccurrences").map((x) => x.variableId);
    expect([...comparedIds, ...partialIds].sort()).toEqual([...r.groups.commonAtOccurrences].sort());
    // every condition appears exactly once in different / same-derived / unresolved-insufficient
    const all = [...s.different, ...comparedIds.map((id) => ({ variableId: id })), ...s.unresolved].map((x) => x.variableId).sort();
    expect(all).toEqual(r.conditions.map((c) => c.variableId).sort());
    expect(s.compared.some((g) => g.group === "differentiatingComplete")).toBe(true);
    expect(s.unresolved.some((x) => x.group === "contrastPartial")).toBe(true);
  });

  it("words the pattern from the result only and every sentence without causal or forbidden language; the engine's statement and counts ride under Details", () => {
    const r = result();
    const s = exploreSections(r);
    expect(s.pattern).toBe("income_stability was 5 on 4 recorded dates between February 2025 and June 2026.");
    const rows = [...s.different, ...s.same, ...s.compared.flatMap((g) => g.rows), ...s.unresolved];
    for (const row of rows) {
      expect(containsForbiddenPhrase(row.text), row.text).toBeNull();
      expect(row.text, row.text).not.toMatch(CAUSAL);
      expect(row.statement).toBe(r.conditions.find((c) => c.variableId === row.variableId)!.statement);
      expect(row.counts.occurrenceTotal).toBe(r.occurrences.length);
    }
    for (const h of [...Object.values(CONTRAST_HEADINGS), ...Object.values(UNRESOLVED_TAGS), EXPLORE_CAVEAT]) expect(h).not.toMatch(CAUSAL);
    const diff = s.compared.find((g) => g.group === "differentiatingComplete")!.rows[0];
    expect(diff.text).toMatch(/ each time, and different in all of the recorded comparison cases\.$/);
    expect(diff.tag).toBeNull();
    const partial = s.unresolved.find((x) => x.group === "contrastPartial")!;
    expect(partial.tag).toBe("Comparison incomplete");
    expect(partial.text).toMatch(/so the comparison is incomplete\.$/);
  });

  it("one sentence shape per group, over the assessment's own facts", () => {
    const base: ConditionAssessment = { variableId: "x", name: "Buffer", unit: "months", occurrenceValues: [1.5, 3, 1.5], occurrenceBases: [], occurrenceUsable: 3, occurrenceTotal: 3, atOccurrences: "differing", commonValue: null, contrastTotal: 2, contrastUsable: 2, contrastSame: 0, contrastDifferent: 2, contrastShows: "different", contrastCoverage: "complete", reliesOnRecordedBasis: false, statement: "" };
    expect(conditionSentence(base, "differingAtOccurrences")).toBe("Buffer changed each time: 1.5 months → 3 months → 1.5 months.");
    const common: ConditionAssessment = { ...base, occurrenceValues: [3, 3, 3], atOccurrences: "common", commonValue: 3 };
    expect(conditionSentence(common, "commonAtOccurrences")).toBe("Buffer was 3 months each time.");
    expect(conditionSentence(common, "backgroundComplete")).toBe("Buffer was 3 months each time, and also at every other recorded time.");
    expect(conditionSentence(common, "mixedComplete")).toBe("Buffer was 3 months each time; at the other recorded times it was sometimes the same and sometimes different.");
    expect(conditionSentence(common, "undecided")).toBe("Buffer was 3 months each time, but no other recorded time can be read to compare it with.");
    expect(conditionSentence(common, "insufficientAtOccurrences")).toBe("Buffer could not be read at every one of these times.");
  });

  it("proposal states read plainly and none is hidden", () => {
    expect(proposalStatusLine("proposed")).toBe("Waiting for your review");
    expect(proposalStatusLine("reviewed")).toBe("Waiting for your review");
    expect(proposalStatusLine("stale")).toMatch(/fresh review/);
    expect(proposalStatusLine("failed")).toMatch(/Could not be applied/);
    expect(proposalStatusLine("superseded")).toMatch(/Replaced/);
    expect(proposalStatusLine(null)).toBe("A proposal exists for this explanation");
  });
});
