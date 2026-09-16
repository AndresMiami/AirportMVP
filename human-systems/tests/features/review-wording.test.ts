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
import { STATE_LINES, basisRows, decisionHeading, recoveryLine, specificUncertainty } from "@/features/review/wording";

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
    expect(recoveryLine({ outcome: "conflict", proposalId: "p3" })).toMatch(/neither as it was before.*nor as it would be after.*Nothing was written.*fresh look.*\(p3\)/);
  });
});
