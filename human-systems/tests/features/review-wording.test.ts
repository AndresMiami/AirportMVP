/**
 * REVIEW WORDING (6D): the first layer of a review card in ordinary
 * language over the kernel's own describeProposal() wording. Presentation
 * only: the decision heading detects the registered mutation kind, basis
 * rows carry human labels (never basis-kind names), the kernel's fixed
 * "cannot judge" sentence moves under Details, and recovery outcomes are
 * translated without hiding any of the three.
 */
import { describe, expect, it } from "vitest";
import { AI_OUTPUT_NOT_EVIDENCE, ENGINE_CANNOT_JUDGE, type BasisLine, type MutationProposal } from "@/kernel";
import type { ResolvedBasis } from "@/kernel";
import { NO_BASIS, STATE_LINES, basisRows, comparisonSentence, decisionDate, decisionHeading, explorePatternHref, firstLayerChanges, firstLayerWhy, isExploreOrigin, recoveryLine, specificUncertainty } from "@/features/review/wording";

describe("decisionHeading", () => {
  it("reads an addHypothesis proposal as a question with the statement quoted; anything else falls back to the kernel's first summary", () => {
    const hyp = { materialized: [{ kind: "addHypothesis", args: { statement: "The work available was mostly short contracts." } }] } as unknown as Pick<MutationProposal, "materialized">;
    expect(decisionHeading(hyp, { what: ["Add hypothesis “The work …”"] })).toEqual({ question: "Keep this as a working hypothesis?", detail: "“The work available was mostly short contracts.”", moreSteps: 0 });
    const obs = { materialized: [{ kind: "addObservation", args: { statement: "x" } }] } as unknown as Pick<MutationProposal, "materialized">;
    expect(decisionHeading(obs, { what: ["Add observation “x”", "Link it"] })).toEqual({ question: "Apply this change?", detail: "Add observation “x”", moreSteps: 1 });
    expect(decisionHeading(obs, { what: [] })).toEqual({ question: "This change cannot be applied", detail: null, moreSteps: 0 });
    // two steps, even if the first adds a hypothesis, never masquerade as one hypothesis decision
    const two = { materialized: [{ kind: "addHypothesis", args: { statement: "a" } }, { kind: "addObservation", args: {} }] } as unknown as Pick<MutationProposal, "materialized">;
    expect(decisionHeading(two, { what: ["Add hypothesis “a”", "Add observation"] }).question).toBe("Apply this change?");
  });
});

describe("basisRows", () => {
  it("labels every basis kind for people and strips the kernel's kind prefix; an unresolved line keeps its sentence; AI wording is origin with the not-evidence note", () => {
    const line = (ref: BasisLine["ref"], text: string, resolved = true): BasisLine => ({ ref, text, resolved });
    const rows = basisRows([
      line({ kind: "user_statement", text: "It was contracts." }, "You wrote: “It was contracts.”"),
      line({ kind: "pattern", ref: { variableId: "v", subjectId: "p1", interval: { from: "2025-01-01", to: "2026-01-01" }, repeatedValue: 5, occurrenceTimes: [] }, summary: "s" }, "Pattern: s — recorded at 4 distinct times in the current records."),
      line({ kind: "cross_context", pattern: { variableId: "v", subjectId: "p1", interval: { from: "2025-01-01", to: "2026-01-01" }, repeatedValue: 5, occurrenceTimes: [] }, summary: "c" }, "Explore comparison: 4 occurrences compared with 3 times recorded at another value; 1 condition differed."),
      line({ kind: "catalogue_prompt", domainId: "d", domainVersion: 1, promptId: "q", question: "Q?" }, "Question that prompted the draft: “Q?”"),
      line({ kind: "ai_output", adapterId: "mock", task: "t", contextHash: "h", sourceRevisionHash: "r", outputItemId: "o", outputKind: "candidate_explanation", text: "Maybe contracts." }, "AI wording that prompted this proposal: “Maybe contracts.” (tentative; adapter mock). ..."),
      line({ kind: "observation", id: "o1" }, "Observation: “Seen.” (2026-09)."),
      line({ kind: "observation", id: "o2" }, "Observation o2 no longer exists in the model.", false),
      line({ kind: "event", id: "e1" }, "Event: “Contract ended”."),
      line({ kind: "hypothesis", id: "h1" }, "Hypothesis: “H” (proposed)."),
      line({ kind: "variable", id: "v1" }, "Variable: Total debt."),
      line({ kind: "relationship", id: "r1" }, "Relationship: a → b (positive)."),
      line({ kind: "variable_history", variableId: "v1", interval: { from: "2025-01-01", to: "2026-01-01" } }, "Value history of v1 from 2025-01-01 to 2026-01-01: 3 records."),
    ]);
    expect(rows.map((r) => [r.label, r.text])).toEqual([
      ["You wrote", "“It was contracts.”"],
      ["Pattern", "s — recorded at 4 distinct times in the current records."],
      ["Comparison", "4 occurrences compared with 3 times recorded at another value; 1 condition differed."],
      ["Question", "“Q?”"],
      ["Suggested wording", "“Maybe contracts.”"],
      ["Record", "“Seen.” (2026-09)."],
      ["Record", "Observation o2 no longer exists in the model."],
      ["Event", "“Contract ended”."],
      ["Hypothesis", "“H” (proposed)."],
      ["Variable", "Total debt."],
      ["Relationship", "a → b (positive)."],
      ["Value history", "Value history of v1 from 2025-01-01 to 2026-01-01: 3 records."],
    ]);
    expect(rows[4].note).toBe(AI_OUTPUT_NOT_EVIDENCE);
    expect(rows.filter((r) => r.note !== null)).toHaveLength(1);
    expect(rows[6].resolved).toBe(false);
    for (const r of rows) expect(r.label).not.toMatch(/ai_output|cross_context|catalogue_prompt|user_statement|variable_history|PatternRef|fingerprint/);
  });
});

describe("6D.1: Explore-origin basis, rationale and hypothesis metadata on the first layer", () => {
  const pattern = { variableId: "total_debt", subjectId: "sys", interval: { from: "2025-01-01", to: "2026-09-16" }, repeatedValue: 4000, occurrenceTimes: [] };
  const occurrences = ["2025-02-10T00:00:00.000Z", "2025-07-10T00:00:00.000Z", "2026-06-12T00:00:00.000Z"];
  const comparison = { variableName: "Total debt", unit: "$", occurrences: occurrences.map((t) => ({ application: { start: t } })), contrasts: [{}], groups: { differingAtOccurrences: ["a"], commonAtOccurrences: [], insufficientAtOccurrences: ["b", "c"], undecided: [], contrastPartial: ["d"], backgroundComplete: [], differentiatingComplete: [], mixedComplete: [] } };
  const refs = { pattern: { kind: "pattern", ref: pattern, summary: "Total debt was recorded at 4000 $ at 3 distinct times between Jan 2025 and Sep 2026." }, cc: { kind: "cross_context", pattern, summary: "the occurrence and contrast comparison shown in Explore" }, you: { kind: "user_statement", text: "Short contracts." } } as const;
  const lines: BasisLine[] = [
    { ref: refs.pattern, text: `Pattern: ${refs.pattern.summary} — recorded at 3 distinct times in the current records.`, resolved: true },
    { ref: refs.cc, text: "Explore comparison: 3 occurrences compared with 1 time recorded at another value; 1 condition differed across the occurrences; 0 recorded the same at every occurrence; 3 unresolved.", resolved: true },
    { ref: refs.you, text: "You wrote: “Short contracts.”", resolved: true },
  ];
  const resolved: ResolvedBasis[] = [
    { ref: refs.pattern, content: { subjectId: "sys", occurrences } },
    { ref: refs.cc, content: comparison },
    { ref: refs.you, content: refs.you },
  ];

  it("words a RESOLVED pattern and comparison in product language from the resolved content only, and keeps the kernel text for an unresolved one", () => {
    const rows = basisRows(lines, resolved);
    expect(rows[0]).toMatchObject({ label: "Pattern", text: "Total debt was $4,000 on 3 recorded dates between February 2025 and June 2026." });
    expect(rows[1]).toMatchObject({ label: "Comparison", text: "3 repeated times were compared with 1 other recorded time. 1 condition differed across the repeated times; none were recorded the same every time; 3 conditions are still unresolved." });
    expect(rows[1].text).not.toMatch(/occurrence|contrast time|4000 \$/);
    expect(rows[1].text).not.toMatch(/caused|explains|strong evidence|likely cause|predictor/);
    // no resolved content -> the kernel's own sentence, prefix stripped (nothing invented)
    expect(basisRows(lines)[0].text).toBe(`${refs.pattern.summary} — recorded at 3 distinct times in the current records.`);
    const gone: BasisLine = { ref: refs.pattern, text: `Pattern: ${refs.pattern.summary} — the repetition is no longer in the records.`, resolved: false };
    expect(basisRows([gone], [{ ref: refs.pattern, content: { subjectId: "sys", occurrences: null } }])[0].text).toMatch(/no longer in the records/);
  });

  it("the comparison sentence surfaces every count it uses and splits the same-every-time conditions only when other times exist", () => {
    const withSame = { ...comparison, groups: { ...comparison.groups, commonAtOccurrences: ["x", "y", "z"], backgroundComplete: ["x"], differentiatingComplete: ["y"], mixedComplete: ["z"] } };
    expect(comparisonSentence(withSame)).toBe("3 repeated times were compared with 1 other recorded time. 1 condition differed across the repeated times; 3 were recorded the same every time (1 also true at the other times, 1 different, 1 mixed); 3 conditions are still unresolved.");
    expect(comparisonSentence({ ...withSame, contrasts: [] })).toBe("3 repeated times were compared with 0 other recorded times. 1 condition differed across the repeated times; 3 were recorded the same every time; 3 conditions are still unresolved.");
  });

  it("an Explore-origin proposal links back to its own pattern, encoded exactly as Explore reads it; nothing else gets a link", () => {
    expect(explorePatternHref([refs.pattern, refs.cc, refs.you])).toBe("/explore?variable=total_debt&subject=sys&from=2025-01-01&to=2026-09-16&value=4000&times=");
    expect(explorePatternHref([refs.you])).toBeNull();
    expect(explorePatternHref([refs.pattern])).toBeNull();
  });

  it("Explore origin is provenance (pattern + comparison basis), never wording; the humanized rationale applies only then", () => {
    expect(isExploreOrigin([refs.pattern, refs.cc, refs.you])).toBe(true);
    expect(isExploreOrigin([refs.you])).toBe(false);
    expect(isExploreOrigin([refs.pattern])).toBe(false);
    expect(firstLayerWhy([refs.pattern, refs.cc, refs.you], { why: "Written in Explore as a condition to test for a repeated record (…)" })).toBe("You chose to investigate this explanation in Explore.");
    expect(firstLayerWhy([refs.you], { why: "Written in Explore as a condition to test" })).toBe("Written in Explore as a condition to test");
  });

  it("a single addHypothesis reads 'Create this working hypothesis.' on the first layer with its status / confidence / disconfirming state left to Details; other kinds keep the kernel's summaries", () => {
    const hyp = { materialized: [{ kind: "addHypothesis", args: { statement: "S" } }] } as unknown as Pick<MutationProposal, "materialized">;
    const w = { willChange: [{ summary: "Create hypothesis “S”.", details: ["Status: proposed. Confidence: not assessed. No disconfirming condition stated yet."], subject: "Okafor-Reyes household" }] };
    expect(firstLayerChanges(hyp, w)).toEqual([{ summary: "Create this working hypothesis.", details: [], subject: "Okafor-Reyes household" }]);
    const obs = { materialized: [{ kind: "addObservation", args: {} }] } as unknown as Pick<MutationProposal, "materialized">;
    expect(firstLayerChanges(obs, w)).toBe(w.willChange);
  });

  it("zero basis has its own sentence and dates read as calendar words", () => {
    expect(basisRows([])).toEqual([]);
    expect(NO_BASIS).toBe("No supporting record was cited for this proposal.");
    expect(decisionDate({ status: "applied", commit: { approvedAt: "2026-09-16T22:29:00.000Z" } as MutationProposal["commit"], review: [] })).toBe("September 16, 2026");
    expect(decisionDate({ status: "rejected", commit: null as unknown as MutationProposal["commit"], review: [{ at: "2026-09-17T01:00:00.000Z", status: "rejected", by: "person", note: "" }] })).toBe("September 17, 2026");
    expect(decisionDate({ status: "superseded", commit: null as unknown as MutationProposal["commit"], review: [] })).toBeNull();
  });
});

describe("first-layer uncertainty, state lines and recovery words", () => {
  it("keeps only proposal-specific uncertainty on the first layer; the kernel's fixed sentence stays for Details", () => {
    expect(specificUncertainty({ uncertainty: [ENGINE_CANNOT_JUDGE] })).toEqual([]);
    expect(specificUncertainty({ uncertainty: ["A cited record is gone: x", ENGINE_CANNOT_JUDGE] })).toEqual(["A cited record is gone: x"]);
  });
  it("every status has a plain line or none, and the three recovery outcomes stay distinct and named", () => {
    expect(STATE_LINES.proposed).toBeNull();
    expect(STATE_LINES.reviewed).toBe("Ready for your decision");
    expect(STATE_LINES.stale).toBe("Something changed since you reviewed this");
    expect(STATE_LINES.failed).toBe("Nothing was written.");
    expect(recoveryLine({ outcome: "reconciled_applied", proposalId: "p1" })).toMatch(/already been saved.*applied.*\(p1\)/);
    expect(recoveryLine({ outcome: "commit_never_landed", proposalId: "p2" })).toMatch(/never reached your notebook\. Nothing was written.*retry.*\(p2\)/);
    const conflict = recoveryLine({ outcome: "conflict", proposalId: "p3" });
    expect(conflict).toBe("Your notebook no longer matches either the state before this change or the state this change expected to produce. It needs a fresh look before any retry. (p3)");
    expect(conflict).not.toMatch(/Nothing was written/);
    expect(STATE_LINES.applied).toBe("Change applied");
    expect(Object.values(STATE_LINES).join(" ")).not.toMatch(/added/i);
  });
});
