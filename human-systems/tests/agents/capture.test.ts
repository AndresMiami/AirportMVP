/**
 * STEP 7B — thesis targets and evidence capture: stable ids, matching by
 * variable key and subject, one recordValue per item, the source's own
 * provenance on the record, confidence not assessed, and a collector that
 * can propose nothing else.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_MUTATION_KINDS, RESEARCH_AGENT_ID, captureEvidence, captureProposal, temporalRefOf } from "@/agents/capture";
import { collectableTargets, predictionId, theses, thesisOf } from "@/agents/thesis";
import * as M from "@/services/mutations";
import { THESIS_ID, researchSystem, snapshot } from "../helpers/research-fixture";

describe("thesis targets", () => {
  it("a prediction keeps its own id, a nameless one gets a content-derived id, and only targets naming an input variable are collectable", () => {
    const m = researchSystem();
    const h = m.hypotheses.find((x) => x.id === THESIS_ID)!;
    const t = thesisOf(h);
    expect(t.targets.map((x) => [x.id, x.kind, x.variableId])).toEqual([
      ["pred_income", "prediction", "income_stability"],
      ["kill_buffer", "kill_criterion", "buffer"],
    ]);
    expect(predictionId({ statement: "same words", variableId: "buffer" })).toBe(predictionId({ statement: "same words", variableId: "buffer" }));
    expect(predictionId({ statement: "same words", variableId: "buffer" })).not.toBe(predictionId({ statement: "other words", variableId: "buffer" }));
    expect(collectableTargets(t, m)).toHaveLength(2);
    const derived = { ...m, variables: m.variables.map((v) => (v.id === "buffer" ? { ...v, kind: "derived" as const, formulaId: "f" } : v)) };
    expect(collectableTargets(t, derived).map((c) => c.target.id)).toEqual(["pred_income"]);
    expect(theses(m).map((x) => x.thesis.id)).toEqual([THESIS_ID]);
    const rejected = { ...m, hypotheses: m.hypotheses.map((x) => (x.id === THESIS_ID ? { ...x, status: "rejected" as const } : x)) };
    expect(theses(rejected)).toEqual([]);
  });
});

describe("capture", () => {
  it("matches items by variable key and subject, ignores the rest, and keeps the period as stated", () => {
    const m = researchSystem();
    const caps = captureEvidence(m, thesisOf(m.hypotheses.find((x) => x.id === THESIS_ID)!), snapshot());
    expect(caps.map((c) => [c.identity, c.target.id, c.variableId])).toEqual([
      ["bank-export#inc-2026-07", "pred_income", "income_stability"],
      ["bank-export#buf-2026-07", "kill_buffer", "buffer"],
    ]);
    const wrongSubject = snapshot({ items: [{ ...snapshot().items[1], subjectId: "p2" }] });
    expect(captureEvidence(m, thesisOf(m.hypotheses[0]), wrongSubject)).toEqual([]);
    expect(temporalRefOf({ text: "July 2026", start: "2026-07-01", end: "2026-07-31" })).toEqual({ kind: "range", start: "2026-07-01", end: "2026-07-31", precision: "day", text: "July 2026" });
    expect(temporalRefOf({ text: "31 July 2026", start: "2026-07-31" })).toEqual({ kind: "date", start: "2026-07-31", precision: "day", text: "31 July 2026" });
    expect(temporalRefOf({ text: "2026-07", start: "2026-07" })).toMatchObject({ kind: "date", precision: "month" });
    expect(temporalRefOf({ text: "sometime" })).toEqual({ kind: "unknown", precision: "unspecified", text: "sometime" });
  });
  it("one recordValue per capture: the source's provenance, confidence null, the exact quote, period and version on the evidence, the collector only on the proposal", () => {
    const m = researchSystem();
    const thesis = thesisOf(m.hypotheses.find((x) => x.id === THESIS_ID)!);
    const [inc, buf] = captureEvidence(m, thesis, snapshot());
    const p = captureProposal(buf, thesis, m.id);
    expect(p.request.map((s) => s.kind)).toEqual(["recordValue"]);
    const step = p.request[0];
    if (step.kind !== "recordValue") throw new Error("expected recordValue");
    expect(step.args.variableId).toBe("buffer");
    expect(step.args.input).toMatchObject({ value: 2, sourceType: "measured", confidence: null, valid: { kind: "date", start: "2026-07-31" } });
    expect(step.args.input.evidence?.[0]).toEqual({
      text: "Bank export (version 2026-07-31), 31 July 2026: “Closing balance covers 2.0 months of essentials”",
      sourceType: "measured",
      recordedAt: "2026-08-01T09:00:00.000Z",
      source: { id: "bank-export", name: "Bank export", url: "https://example.com/export", version: "2026-07-31", retrievedAt: "2026-08-01T09:00:00.000Z", locator: "row 12" },
      period: "31 July 2026",
      quote: "Closing balance covers 2.0 months of essentials",
    });
    expect(p.proposedBy).toEqual({ kind: "agent", agentId: RESEARCH_AGENT_ID, thesisId: THESIS_ID, sourceId: "bank-export" });
    expect(p.basis?.map((b) => b.kind)).toEqual(["source_item", "hypothesis", "variable"]);
    expect(p.basis?.[0]).toMatchObject({ kind: "source_item", sourceId: "bank-export", itemKey: "buf-2026-07", version: "2026-07-31" });
    expect(p.rationale).toMatch(/confidence stays not assessed/);
    expect(JSON.stringify(p)).not.toMatch(/"confidence":0\.\d/);
    const inc2 = captureProposal(inc, thesis, m.id).request[0];
    if (inc2.kind === "recordValue") expect(inc2.args.input.valid).toMatchObject({ kind: "range", start: "2026-07-01", end: "2026-07-31" });
  });
});

describe("what the collector can never do", () => {
  it("proposes only recordValue, and the agents module never imports the mutation functions or names a hypothesis mutation", () => {
    expect([...AGENT_MUTATION_KINDS]).toEqual(["recordValue"]);
    const dir = path.resolve(import.meta.dirname, "../../src/agents");
    for (const f of readdirSync(dir)) {
      const s = readFileSync(path.join(dir, f), "utf8");
      expect(s, f).not.toMatch(/@\/services\/mutations|addHypothesis|addKillCriterion|addDisconfirmingCondition|attachObservationToHypothesis|updateHypothesis|\bapply\(|\.save\(/);
    }
    // the hypothesis-touching mutations exist; the collector simply cannot reach them
    expect(typeof M.addKillCriterion).toBe("function");
  });
});
