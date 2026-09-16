/**
 * Explore step 2: the History -> Explore hand-off codec, deterministic
 * hypothesis linking (links, never wording), the domain-owned explanation
 * catalogue (questions, never candidates; generic loci in the engine), and
 * the Explore language constants.
 */
import { describe, expect, it } from "vitest";
import { createSampleHousehold } from "@/data/sample-household";
import { HOUSEHOLD_DOMAIN } from "@/domains/household/definition";
import { INPUT_IDS } from "@/domains/household/keys";
import { EXPLORE_QUESTIONS, INVESTIGATE_INERT_TEXT, NO_GROUNDED_CANDIDATE, containsForbiddenPhrase, decodePatternRef, encodePatternRef, linkedHypotheses, type PatternRef } from "@/discovery";
import { DEFAULT_LOCUS_LABELS, locusLabel } from "@/model/domain";
import * as M from "@/services/mutations";

const REF: PatternRef = { variableId: "liquid_reserves", subjectId: "sys", interval: { from: "2025-01-01", to: "2026-12-31" }, repeatedValue: 2000, occurrenceTimes: ["2025-02-10T00:00:00.000Z", "2026-06-01T00:00:00.000Z"] };

describe("pattern reference codec", () => {
  it("round-trips exactly, keeps an unassigned subject as null, and refuses malformed references instead of repairing them", () => {
    expect(decodePatternRef(new URLSearchParams(encodePatternRef(REF)))).toEqual(REF);
    const unassigned = { ...REF, subjectId: null };
    expect(decodePatternRef(new URLSearchParams(encodePatternRef(unassigned)))).toEqual(unassigned);
    const bad = (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(encodePatternRef(REF));
      mutate(p);
      return decodePatternRef(p);
    };
    expect(bad((p) => p.delete("variable"))).toBeNull();
    expect(bad((p) => p.set("value", "lots"))).toBeNull();
    expect(bad((p) => p.set("from", "March 2025"))).toBeNull();
    expect(bad((p) => p.set("times", "2025-02-10T00:00:00.000Z"))).toBeNull(); // one time is not a recurrence
    expect(bad((p) => p.set("times", "2025-02-10,2026-06-01"))).toBeNull(); // not normalized instants
    expect(bad((p) => p.set("from", "2026-12-31"))).not.toBeNull(); // from > to is the engine's refusal, not the codec's
  });
});

describe("linked hypotheses", () => {
  it("links only through predictions, kill criteria, relationships and observations; wording alone never links", () => {
    let m = createSampleHousehold();
    const target = INPUT_IDS.liquidReserves;
    const other = INPUT_IDS.totalDebt;
    m = M.addObservation(m, { id: "obs_t", statement: "Reserves were rebuilt after the repair.", sourceType: "self_reported", confidence: 0.6, links: { variableIds: [target], relationshipIds: [], constraintIds: [], hypothesisIds: [] } });
    m = M.addObservation(m, { id: "obs_o", statement: "Debt was refinanced.", sourceType: "self_reported", confidence: 0.6, links: { variableIds: [other], relationshipIds: [], constraintIds: [], hypothesisIds: [] } });
    const edge = m.relationships.find((r) => r.sourceVariableId === target || r.targetVariableId === target)!;
    const farEdge = m.relationships.find((r) => r.sourceVariableId !== target && r.targetVariableId !== target)!;
    m = M.addHypothesis(m, { id: "h_pred", statement: "Something", confidence: 0.4, predictions: [{ statement: "reserves rise", variableId: target, expectedDirection: "up" }] });
    m = M.addHypothesis(m, { id: "h_kill", statement: "Something else", confidence: 0.4, killCriteria: [{ id: "k1", statement: "reserves fall below 500", variableId: target, comparator: "lt", threshold: 500, status: "open", observationIds: [] }] });
    m = M.addHypothesis(m, { id: "h_rel", statement: "Edge based", confidence: 0.4, relationshipIds: [edge.id] });
    m = M.addHypothesis(m, { id: "h_sup", statement: "Observation based", confidence: 0.4, supportingObservationIds: ["obs_t"] });
    m = M.addHypothesis(m, { id: "h_con", statement: "Contradicted", confidence: 0.4, contradictingObservationIds: ["obs_t"] });
    m = M.addHypothesis(m, { id: "h_obslink", statement: "Linked from the observation side", confidence: 0.4 });
    m = M.linkObservation(m, "obs_t", { kind: "hypothesis", id: "h_obslink" });
    // decoys: the variable's NAME in the statement, a far edge, an observation about another variable
    m = M.addHypothesis(m, { id: "h_text", statement: "Liquid reserves are the whole story of liquid reserves", confidence: 0.4 });
    m = M.addHypothesis(m, { id: "h_far", statement: "Far edge", confidence: 0.4, relationshipIds: [farEdge.id] });
    m = M.addHypothesis(m, { id: "h_other", statement: "Other observation", confidence: 0.4, supportingObservationIds: ["obs_o"] });
    const linked = linkedHypotheses(m, target);
    // the sample's own loop hypothesis is linked through a relationship touching reserves: that is a real link, kept
    const sampleLinked = linked.filter((l) => !l.hypothesis.id.startsWith("h_"));
    expect(sampleLinked).toHaveLength(1);
    expect(sampleLinked[0].linkedVia).toContain("relationship"); // (it is also supported by a sample observation naming reserves)
    const via = Object.fromEntries(linked.filter((l) => l.hypothesis.id.startsWith("h_")).map((l) => [l.hypothesis.id, l.linkedVia]));
    expect(via).toEqual({
      h_pred: ["prediction"],
      h_kill: ["kill_criterion"],
      h_rel: ["relationship"],
      h_sup: ["supporting_observation"],
      h_con: ["contradicting_observation"],
      h_obslink: ["observation_link"],
    });
    expect(Object.keys(via)).not.toContain("h_text");
    expect(Object.keys(via)).not.toContain("h_far");
    expect(Object.keys(via)).not.toContain("h_other");
    expect(linkedHypotheses(m, "nonexistent")).toEqual([]);
  });
});

describe("explanation catalogue", () => {
  it("household prompts are questions under the three generic loci with household labels; nothing is a candidate", () => {
    const cat = HOUSEHOLD_DOMAIN.explanationCatalogue!;
    expect(cat.locusLabels).toEqual({ internal_to_subject: "Person", external_to_subject: "Environment", interaction: "Interaction" });
    expect(cat.prompts.length).toBeGreaterThan(5);
    for (const p of cat.prompts) {
      expect(["internal_to_subject", "external_to_subject", "interaction"]).toContain(p.locus);
      expect(p.question.trim().endsWith("?"), p.id).toBe(true);
      expect(containsForbiddenPhrase(p.question), p.question).toBeNull();
      expect(p.question, p.question).not.toMatch(/\byou are\b|\bpersonality\b|\barchetype\b|\bdefect\b|\bfault\b/i);
      expect("statement" in p).toBe(false); // a prompt has a question, never a hypothesis statement
      expect("confidence" in p).toBe(false);
    }
    expect(new Set(cat.prompts.map((p) => p.id)).size).toBe(cat.prompts.length);
    // every locus has at least one question here; that is the household's choice, not an engine quota
    for (const locus of ["internal_to_subject", "external_to_subject", "interaction"] as const) expect(cat.prompts.some((p) => p.locus === locus), locus).toBe(true);
  });

  it("the engine's locus words are generic; a domain without a catalogue gets them unchanged", () => {
    expect(DEFAULT_LOCUS_LABELS).toEqual({ internal_to_subject: "Internal to the subject", external_to_subject: "External to the subject", interaction: "Interaction" });
    expect(locusLabel(undefined, "internal_to_subject")).toBe("Internal to the subject");
    expect(locusLabel({ explanationCatalogue: undefined }, "external_to_subject")).toBe("External to the subject");
    expect(locusLabel(HOUSEHOLD_DOMAIN, "internal_to_subject")).toBe("Person");
  });
});

describe("explore language", () => {
  it("the fixed copy examines, never concludes, and the empty-heading line is not a prompt in disguise", () => {
    expect(EXPLORE_QUESTIONS).toEqual(["This kept happening.", "What was different each time?", "What was the same each time?", "What was also true when this did not happen?", "What is still unresolved?", "Possible explanations to investigate"]);
    expect(NO_GROUNDED_CANDIDATE).toBe("No grounded candidate of this kind yet.");
    expect(INVESTIGATE_INERT_TEXT).toMatch(/nothing is created from here/);
    for (const t of [...EXPLORE_QUESTIONS, NO_GROUNDED_CANDIDATE, INVESTIGATE_INERT_TEXT]) expect(containsForbiddenPhrase(t), t).toBeNull();
  });
});
