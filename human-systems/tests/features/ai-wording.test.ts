/**
 * STEP 7A — the words Home and Explore use for the AI boundary: what leaves
 * the browser, from the LOCAL manifest; epistemic states as words; cited
 * items as human labels; the single failure line.
 */
import { describe, expect, it, vi } from "vitest";
import { buildAiContext } from "@/ai/context";
import { CONSENT_KEY } from "@/features/ai/consent";
import { DISCLOSURE_NOTE, DISCLOSURE_PATTERN, REFLECTION_FAILED, STATE_WORDS, THINKING_FAILED, citedLabels, needsDisclosure, providerBadge, responseHeading, sharedLines, stateWords } from "@/features/ai/wording";
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

describe("what is shared", () => {
  it("lists the note, the system and the counted records from the manifest, in plain words, and names withheld sensitive items", () => {
    const ctx = buildAiContext(ccSystem(), "interpret_free_text", { subjectId: ccSystem().id, userText: "A note.", asOf: "2026-09-16" });
    const lines = sharedLines(ctx.manifest);
    expect(lines[0]).toBe("your note");
    expect(lines).toContain("the system description");
    expect(lines.some((l) => /^\d+ recorded values$/.test(l))).toBe(true);
    expect(lines.join(" ")).not.toMatch(/user_text|contextHash|payload|[0-9a-f]{16}/);
    const withheld = sharedLines({ ...ctx.manifest, sensitiveExcluded: ["variable:x", "value:x@2026"] });
    expect(withheld.at(-1)).toBe("2 sensitive items are left out");
    expect(sharedLines({ ...ctx.manifest, sensitiveExcluded: ["variable:x"] }).at(-1)).toBe("1 sensitive item is left out");
  });
  it("a pattern context names the pattern and the comparison", () => {
    const ctx = buildAiContext(ccSystem(), "suggest_explanations_for_pattern", { pattern: CC_PATTERN });
    const lines = sharedLines(ctx.manifest);
    expect(lines.slice(0, 2)).toEqual(["the pattern", "the occurrence and contrast comparison"]);
    expect(citedLabels(["pattern:" + ctx.items.find((i) => i.kind === "pattern")!.id.slice(8), ctx.items.find((i) => i.kind === "cross_context")!.id, "not:there"], ctx.items)).toEqual(["the pattern", "the occurrence and contrast comparison"]);
    const prompt = ctx.items.find((i) => i.kind === "catalogue_prompt");
    if (prompt) expect(citedLabels([prompt.id], ctx.items)[0]).toMatch(/^an explanation prompt: /);
  });
});

describe("boundary and states", () => {
  it("the disclosure is required exactly once for the real provider and never for the demo", () => {
    expect(needsDisclosure("remote", false)).toBe(true);
    expect(needsDisclosure("remote", true)).toBe(false);
    expect(needsDisclosure("mock", false)).toBe(false);
    expect(CONSENT_KEY).toBe("human-systems.ai-consent.v1");
    expect(DISCLOSURE_NOTE).toBe("AI reflection sends this note and the relevant notebook context to the AI provider.");
    expect(DISCLOSURE_PATTERN).toMatch(/^Help me think sends this pattern/);
  });
  it("states are words, never numbers; the demo keeps its badge and heading", () => {
    for (const w of Object.values(STATE_WORDS)) expect(w).not.toMatch(/\d/);
    expect(stateWords("tentative")).toMatch(/^Tentative/);
    expect(stateWords("unresolved")).toMatch(/^Can't be told/);
    expect(providerBadge("mock")).toBe("Demo");
    expect(providerBadge("remote")).toBeNull();
    expect(responseHeading("mock")).toBe("Demo response");
    expect(responseHeading("remote")).toBe("Reflection");
    expect(REFLECTION_FAILED).toBe("Reflection couldn't be completed. Try again.");
    expect(THINKING_FAILED).toMatch(/Try again\.$/);
  });
});
