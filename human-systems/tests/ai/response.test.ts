/**
 * STEP 5C — the strict AI output contract and the deterministic task mock.
 * Every citation is validated against the exact provider payload; one bad
 * item rejects the whole response; no numeric epistemics exist; the mock
 * is byte-deterministic and validates its own output.
 */
import { describe, expect, it, vi } from "vitest";
import { buildAiContext, providerPayload, type AiProviderPayload } from "@/ai/context";
import { AiResponseSchema, FORBIDDEN_CLAIMS, NUMERIC_EPISTEMIC_FIELDS, TASK_OUTPUT_KINDS, forbiddenClaim, validateAiResponse } from "@/ai/response";
import { MockAiTaskProvider, mockItemsFor } from "@/ai/task-mock";
import * as M from "@/services/mutations";
import { CC_PATTERN, ccSystem } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

const NOW = "2026-09-16T12:00:00.000Z";
const TEXT = "My hours dropped from 40 to 15 in March. I was tired.";
function world() {
  const m = M.addHypothesis(ccSystem(), { id: "hyp_a", statement: "A working hypothesis", subjectId: "p1" });
  const ctx = (task: Parameters<typeof buildAiContext>[1], extra = {}) => buildAiContext(m, task, { subjectId: "p1", subjectIds: ["p1"], userText: TEXT, asOf: "2026-09-01", pattern: CC_PATTERN, ...extra }, { now: NOW });
  return { m, ctx };
}
const ok = (payload: AiProviderPayload, hash: string, items: unknown[]) => validateAiResponse({ version: 1, task: payload.task, contextHash: hash, items }, payload, hash);
const err = (r: ReturnType<typeof validateAiResponse>) => (r.ok ? "" : r.error);

describe("validation against the exact payload", () => {
  it("accepts a well-formed extraction whose quote is verbatim in the cited user text; rejects a paraphrase, a missing ref, a non-textual source and an excluded ref", () => {
    const { ctx } = world();
    const c = ctx("extract_statements");
    const p = providerPayload(c);
    const ut = p.items.find((i) => i.kind === "user_text")!.id;
    const sys = p.items.find((i) => i.kind === "system")!.id;
    const good = { kind: "extraction", id: "o1", text: "Hours dropped.", quote: "My hours dropped from 40 to 15 in March.", sourceRef: ut, state: "directly_stated" };
    expect(ok(p, c.contextHash, [good]).ok).toBe(true);
    expect(err(ok(p, c.contextHash, [{ ...good, quote: "hours fell from 40 to 15" }]))).toMatch(/not a verbatim substring/);
    expect(err(ok(p, c.contextHash, [{ ...good, sourceRef: "user_text:nope" }]))).toMatch(/not in the supplied context/);
    expect(err(ok(p, c.contextHash, [{ ...good, sourceRef: sys }]))).toMatch(/not a textual source/);
    // the AI never assigns a subject: a subjectRef is an unknown key and rejects the response
    expect(err(ok(p, c.contextHash, [{ ...good, subjectRef: sys }]))).toMatch(/did not match the contract/);
  });

  it("rejects the whole response on: contextHash mismatch, wrong task, unknown key, disallowed kind for the task, duplicate ids, interpretation claiming directly_stated, a numeric epistemic field", () => {
    const { ctx } = world();
    const c = ctx("interpret_free_text");
    const p = providerPayload(c);
    const ut = p.items.find((i) => i.kind === "user_text")!.id;
    const interp = { kind: "interpretation", id: "o1", text: "One tentative reading is that hours may have been reduced.", restsOn: [ut], state: "tentative", caveat: "" };
    expect(ok(p, c.contextHash, [interp]).ok).toBe(true);
    expect(err(validateAiResponse({ version: 1, task: p.task, contextHash: "0000000000000000", items: [interp] }, p, c.contextHash))).toMatch(/contextHash mismatch/);
    expect(err(validateAiResponse({ version: 1, task: "summarize_model", contextHash: c.contextHash, items: [] }, p, c.contextHash))).toMatch(/for task summarize_model/);
    expect(err(validateAiResponse({ version: 1, task: p.task, contextHash: c.contextHash, items: [interp], extra: 1 }, p, c.contextHash))).toMatch(/did not match the contract/);
    expect(err(ok(p, c.contextHash, [{ kind: "extraction", id: "o1", text: "x", quote: "I was tired.", sourceRef: ut, state: "directly_stated" }]))).toMatch(/not allowed for task interpret_free_text/);
    expect(err(ok(p, c.contextHash, [interp, { ...interp }]))).toMatch(/Duplicate output item id/);
    expect(err(ok(p, c.contextHash, [{ ...interp, state: "directly_stated" }]))).toMatch(/did not match the contract/);
    for (const f of NUMERIC_EPISTEMIC_FIELDS) expect(err(ok(p, c.contextHash, [{ ...interp, [f]: 0.7 }])), f).toMatch(/did not match the contract/);
    // and the contract itself never declares those fields
    const declared = JSON.stringify(AiResponseSchema.shape.items.element.options.map((o) => Object.keys(o.shape)));
    for (const f of NUMERIC_EPISTEMIC_FIELDS) expect(declared).not.toContain(`"${f}"`);
  });

  it("forbids causal, proof and probability claims in interpretations, explanations and summaries while allowing conditional language", () => {
    const { ctx } = world();
    const c = ctx("suggest_explanations_for_pattern");
    const p = providerPayload(c);
    const pat = p.items.find((i) => i.kind === "pattern")!.id;
    const base = { kind: "candidate_explanation", id: "o1", forPattern: pat, restsOn: [pat], state: "tentative", weakenedBy: [], alternatives: [] };
    expect(ok(p, c.contextHash, [{ ...base, text: "One possibility is that the work available may have been mostly short contracts." }]).ok).toBe(true);
    for (const bad of ["This caused the repetition.", "This proves the pattern.", "It is the real reason.", "This is 82% likely.", "It will happen again.", "This definitely explains it.", "Short contracts are the cause of the repetition."]) {
      expect(err(ok(p, c.contextHash, [{ ...base, text: bad }])), bad).toMatch(/may not claim/);
    }
    expect(err(ok(p, c.contextHash, [{ ...base, text: "One possibility.", weakenedBy: ["this proves nothing"] }]))).toMatch(/may not claim/);
    expect(err(ok(p, c.contextHash, [{ ...base, forPattern: p.items.find((i) => i.kind === "cross_context")!.id, text: "One possibility." }]))).toMatch(/not a pattern item/);
    expect(forbiddenClaim("There is a 40% chance this holds")).toBe("a probability claim");
    expect(forbiddenClaim("It might be that hours could matter")).toBeNull();
    expect(FORBIDDEN_CLAIMS).toContain("the real reason");
  });

  it("task envelopes: every task has an output allowlist and a question with an unknown target is refused", () => {
    expect(TASK_OUTPUT_KINDS.extract_statements).toEqual(["extraction"]);
    expect(TASK_OUTPUT_KINDS.summarize_model).toEqual(["summary"]);
    const { ctx } = world();
    const c = ctx("suggest_questions_to_reduce_uncertainty");
    const p = providerPayload(c);
    expect(err(ok(p, c.contextHash, [{ kind: "question", id: "q1", text: "?", targets: ["value:nope@x"], whyItMatters: "y" }]))).toMatch(/target "value:nope@x" is not in the supplied context/);
  });
});

describe("the deterministic task mock", () => {
  it("returns a validated response for every task, byte-identical for the same payload, citing only supplied items", async () => {
    const { ctx } = world();
    const mock = new MockAiTaskProvider();
    for (const task of ["extract_statements", "propose_observation_from_user_statement", "interpret_free_text", "suggest_explanations_for_pattern", "suggest_questions_to_reduce_uncertainty", "summarize_model"] as const) {
      const c = ctx(task);
      const p = providerPayload(c);
      const a = await mock.run(p, c.contextHash);
      const b = await mock.run(p, c.contextHash);
      expect(a.ok, task).toBe(true);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      if (!a.ok) continue;
      expect(a.response.items.length, task).toBeGreaterThan(0);
      expect(a.response.contextHash).toBe(c.contextHash);
      const ids = new Set(p.items.map((i) => i.id));
      for (const it of a.response.items) {
        const cited = it.kind === "extraction" ? [it.sourceRef] : it.kind === "interpretation" ? it.restsOn : it.kind === "candidate_explanation" ? [it.forPattern, ...it.restsOn] : it.kind === "question" ? it.targets : it.sections.flatMap((s) => s.cites);
        for (const r of cited) expect(ids.has(r), `${task} cites ${r}`).toBe(true);
      }
    }
    // extraction quotes the supplied text exactly
    const ex = mockItemsFor(providerPayload(ctx("extract_statements")))[0];
    expect(ex.kind === "extraction" && ex.quote).toBe("My hours dropped from 40 to 15 in March.");
    // the mock never emits numbers as fields
    expect(JSON.stringify(mockItemsFor(providerPayload(ctx("interpret_free_text"))))).not.toMatch(/"(confidence|probability|strengthEstimate)"/);
  });

  it("the mock's tentative reading for the Explore task frames a possibility and a question; a payload without the comparison yields an unresolved candidate", () => {
    const { ctx } = world();
    const c = ctx("suggest_explanations_for_pattern");
    const items = mockItemsFor(providerPayload(c));
    expect(items.map((i) => i.kind)).toEqual(["candidate_explanation", "question"]);
    expect(items[0].kind === "candidate_explanation" && items[0].state).toBe("tentative");
    expect(items[0].kind === "candidate_explanation" && items[0].text).toMatch(/^One possibility is/);
    const without = { ...providerPayload(c), items: providerPayload(c).items.filter((i) => i.kind !== "cross_context") };
    const u = mockItemsFor(without);
    expect(u[0].kind === "candidate_explanation" && u[0].state).toBe("unresolved");
  });
});
