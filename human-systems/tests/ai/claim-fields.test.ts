/**
 * Review finding (Astra, 2026-09-17): the forbidden-claim check ran on an
 * interpretation's text but not its caveat, and on nothing a question
 * carries. Every prose field the contract renders is checked the same way,
 * and one bad field rejects the whole response.
 */
import { describe, expect, it, vi } from "vitest";
import { buildAiContext, providerPayload } from "@/ai/context";
import { validateAiResponse } from "@/ai/response";
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
const home = () => buildAiContext(ccSystem(), "interpret_free_text", { subjectId: ccSystem().id, userText: "My hours dropped in March.", asOf: "2026-09-01" }, { now: NOW });
const explore = () => buildAiContext(ccSystem(), "suggest_explanations_for_pattern", { pattern: CC_PATTERN }, { now: NOW });

describe("every displayed field is checked for forbidden claims", () => {
  it("an interpretation's caveat is checked like its text", () => {
    const ctx = home();
    const note = ctx.items.find((i) => i.kind === "user_text")!.id;
    const good = { version: 1, task: "interpret_free_text", contextHash: ctx.contextHash, items: [{ kind: "interpretation", id: "o1", text: "One reading of the note.", restsOn: [note], state: "tentative", caveat: "This rests on the note alone." }] };
    expect(validateAiResponse(good, providerPayload(ctx), ctx.contextHash).ok).toBe(true);
    const bad = { ...good, items: [{ ...good.items[0], caveat: "This proves that you will definitely succeed." }] };
    const r = validateAiResponse(bad, providerPayload(ctx), ctx.contextHash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/o1: an interpretation may not claim/);
  });
  it("a question's text and whyItMatters are checked; a probability claim in either rejects the whole response", () => {
    const ctx = home();
    const note = ctx.items.find((i) => i.kind === "user_text")!.id;
    const base = { version: 1, task: "interpret_free_text", contextHash: ctx.contextHash, items: [{ kind: "interpretation", id: "o1", text: "One reading.", restsOn: [note], state: "tentative", caveat: "" }, { kind: "question", id: "o2", text: "What was recorded for March?", targets: [note], whyItMatters: "A recorded value would let the note be compared." }] };
    expect(validateAiResponse(base, providerPayload(ctx), ctx.contextHash).ok).toBe(true);
    const badWhy = { ...base, items: [base.items[0], { ...base.items[1], whyItMatters: "There is a 99% chance you will succeed." }] };
    const r1 = validateAiResponse(badWhy, providerPayload(ctx), ctx.contextHash);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/o2: a question may not claim/);
    const badText = { ...base, items: [base.items[0], { ...base.items[1], text: "Since this caused the drop, what next?" }] };
    expect(validateAiResponse(badText, providerPayload(ctx), ctx.contextHash).ok).toBe(false);
  });
  it("a summary heading is checked like its section text", () => {
    const ctx = buildAiContext(ccSystem(), "summarize_model", { subjectIds: [ccSystem().id], asOf: "2026-09-01" }, { now: NOW });
    const sys = ctx.items.find((i) => i.kind === "system")!.id;
    const bad = { version: 1, task: "summarize_model", contextHash: ctx.contextHash, items: [{ kind: "summary", id: "o1", sections: [{ heading: "The real reason", text: "A neutral sentence.", cites: [sys] }] }] };
    expect(validateAiResponse(bad, providerPayload(ctx), ctx.contextHash).ok).toBe(false);
  });
  it("a candidate explanation's fields stay covered (regression)", () => {
    const ctx = explore();
    const pat = ctx.items.find((i) => i.kind === "pattern")!.id;
    const bad = { version: 1, task: "suggest_explanations_for_pattern", contextHash: ctx.contextHash, items: [{ kind: "candidate_explanation", id: "o1", text: "One possibility.", forPattern: pat, restsOn: [pat], state: "tentative", weakenedBy: ["This proves that nothing else matters."], alternatives: [] }] };
    expect(validateAiResponse(bad, providerPayload(ctx), ctx.contextHash).ok).toBe(false);
  });
});
