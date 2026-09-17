/**
 * STEP 7A — the wire contract between browser and reflection service.
 * Shapes both sides validate, the fixed per-task output schema, the safe
 * failure table, and the promise that the provider receives the payload
 * verbatim.
 */
import { describe, expect, it, vi } from "vitest";
import { buildAiContext, providerPayload } from "@/ai/context";
import { FAILURE_CATEGORIES, FAILURE_WORDS, REMOTE_ENABLED_TASKS, REMOTE_LIMITS, RemoteRequestSchema, RemoteResponseSchema, TASK_PROVIDER_SYSTEM_PROMPT, describeFailure, isRemoteEnabledTask, outputSchemaFor, userMessageFor } from "@/ai/remote-contract";
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

const NOTE = "My hours dropped from 40 to 15 in March.";
const homeCtx = () => buildAiContext(ccSystem(), "interpret_free_text", { subjectId: ccSystem().id, userText: NOTE, asOf: "2026-09-16" });

describe("request envelope", () => {
  it("accepts exactly { version, payload: providerPayload(ctx), contextHash } for an enabled task and nothing more", () => {
    const ctx = homeCtx();
    const ok = RemoteRequestSchema.safeParse({ version: 1, payload: providerPayload(ctx), contextHash: ctx.contextHash });
    expect(ok.success).toBe(true);
    expect(RemoteRequestSchema.safeParse({ version: 1, payload: providerPayload(ctx), contextHash: ctx.contextHash, manifest: ctx.manifest }).success).toBe(false);
    expect(RemoteRequestSchema.safeParse({ version: 1, payload: providerPayload(ctx), contextHash: "not-a-hash" }).success).toBe(false);
    expect(RemoteRequestSchema.safeParse({ version: 1, payload: { ...providerPayload(ctx), manifest: ctx.manifest }, contextHash: ctx.contextHash }).success).toBe(false);
  });
  it("refuses tasks the service does not answer (extraction, summary, observation proposals stay off the wire)", () => {
    const ctx = homeCtx();
    for (const task of ["extract_statements", "summarize_model", "propose_observation_from_user_statement"] as const) {
      expect(isRemoteEnabledTask(task)).toBe(false);
      expect(RemoteRequestSchema.safeParse({ version: 1, payload: { ...providerPayload(ctx), task }, contextHash: ctx.contextHash }).success).toBe(false);
    }
    expect([...REMOTE_ENABLED_TASKS]).toEqual(["interpret_free_text", "suggest_explanations_for_pattern", "suggest_questions_to_reduce_uncertainty"]);
  });
  it("the provider receives the payload verbatim: the user message is JSON.stringify(providerPayload(ctx))", () => {
    const ctx = homeCtx();
    expect(userMessageFor(providerPayload(ctx))).toBe(JSON.stringify(providerPayload(ctx)));
    expect(userMessageFor(providerPayload(ctx))).not.toContain("manifest");
    expect(userMessageFor(providerPayload(ctx))).not.toContain(ctx.sourceRevisionHash);
  });
});

describe("output schema", () => {
  it("is fixed per task, closed everywhere, and names only the kinds the response contract allows for that task", () => {
    const closed = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") (Array.isArray(v) ? v : [v]).forEach(closed);
    };
    const kinds = (task: (typeof REMOTE_ENABLED_TASKS)[number]) => {
      const s = outputSchemaFor(task) as { properties: { items: { items: { anyOf: { properties: { kind: { const: string } } }[] } } } };
      return s.properties.items.items.anyOf.map((k) => k.properties.kind.const);
    };
    for (const task of REMOTE_ENABLED_TASKS) closed(outputSchemaFor(task));
    expect(kinds("interpret_free_text")).toEqual(["interpretation", "question"]);
    expect(kinds("suggest_explanations_for_pattern")).toEqual(["candidate_explanation", "question"]);
    expect(kinds("suggest_questions_to_reduce_uncertainty")).toEqual(["question"]);
    expect(JSON.stringify(outputSchemaFor("interpret_free_text"))).toBe(JSON.stringify(outputSchemaFor("interpret_free_text")));
    // no numeric epistemics can be asked for
    expect(JSON.stringify(outputSchemaFor("suggest_explanations_for_pattern"))).not.toMatch(/confidence|probability|score|likelihood|strength/);
  });
});

describe("failure table", () => {
  it("every category has safe words: no identifiers, no provider text, no stack, and the wire response is exactly ok/response or ok/category", () => {
    for (const c of FAILURE_CATEGORIES) {
      expect(describeFailure(c)).toBe(FAILURE_WORDS[c]);
      expect(describeFailure(c)).not.toMatch(/https?:|sk-|\{|\bat\b .*\.ts|Error:/);
    }
    expect(RemoteResponseSchema.safeParse({ ok: false, category: "timeout" }).success).toBe(true);
    expect(RemoteResponseSchema.safeParse({ ok: false, category: "timeout", message: "raw provider text" }).success).toBe(false);
    expect(RemoteResponseSchema.safeParse({ ok: false, category: "something_else" }).success).toBe(false);
    expect(RemoteResponseSchema.safeParse({ ok: true, response: { version: 1 } }).success).toBe(true);
    expect(RemoteResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });
  it("limits are bounded and finite", () => {
    expect(REMOTE_LIMITS.maxRequestBytes).toBeLessThanOrEqual(1_000_000);
    expect(REMOTE_LIMITS.browserTimeoutMs).toBeGreaterThan(REMOTE_LIMITS.providerTimeoutMs);
    expect(REMOTE_LIMITS.maxOutputTokens).toBeLessThanOrEqual(4000);
  });
});

describe("the constitution the provider receives", () => {
  it("carries the epistemic rules and the citation discipline", () => {
    for (const phrase of ["Cite only item ids that appear in the payload", "Never assert cause, proof, likelihood, odds or percentages", "Unknown is not zero", "Never prescribe", "not measurements and not facts", "An empty items array is allowed"]) expect(TASK_PROVIDER_SYSTEM_PROMPT).toContain(phrase);
    expect(TASK_PROVIDER_SYSTEM_PROMPT).not.toMatch(/household|income|career/i);
  });
  it("a pattern context also fits the envelope (Explore's task)", () => {
    const ctx = buildAiContext(ccSystem(), "suggest_explanations_for_pattern", { pattern: CC_PATTERN });
    expect(RemoteRequestSchema.safeParse({ version: 1, payload: providerPayload(ctx), contextHash: ctx.contextHash }).success).toBe(true);
  });
});
