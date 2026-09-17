/**
 * STEP 7A — the reflection service (netlify/functions/ai-task.ts), run
 * in-process with an injected provider call: no network, no key. Every
 * gate answers a category; a good answer is framed with the request's own
 * task and contextHash; the provider receives the payload verbatim; the
 * one log line never carries the note.
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildAiContext, providerPayload } from "@/ai/context";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, REMOTE_LIMITS } from "@/ai/remote-contract";
import { mockItemsFor } from "@/ai/task-mock";
import { RateLimiter, categorizeProviderError, handleAiTask, type FunctionDeps, type ProviderCallInput } from "../../netlify/functions/ai-task";
import { ccSystem } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

const ORIGIN = "https://lens.example";
const NOTE = "My hours dropped from 40 to 15 in March. Private detail: rent is late.";
const ctxOf = () => buildAiContext(ccSystem(), "interpret_free_text", { subjectId: ccSystem().id, userText: NOTE, asOf: "2026-09-16" });

function request(body: unknown, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, [CLIENT_HEADER]: CLIENT_HEADER_VALUE, "x-nf-client-connection-ip": "203.0.113.5", ...init.headers };
  return new Request(`${ORIGIN}/api/ai-task`, { method: init.method ?? "POST", headers, body: init.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}
const envelope = () => {
  const ctx = ctxOf();
  return { ctx, body: { version: 1, payload: providerPayload(ctx), contextHash: ctx.contextHash } };
};
function deps(overrides: Partial<FunctionDeps> & { env?: Record<string, string | undefined> } = {}): FunctionDeps & { logs: string[]; calls: ProviderCallInput[] } {
  const logs: string[] = [];
  const calls: ProviderCallInput[] = [];
  return {
    env: { ANTHROPIC_API_KEY: "test-key-not-real", ...overrides.env },
    call:
      overrides.call ??
      (async (input) => {
        calls.push(input);
        const payload = JSON.parse(input.userMessage);
        return { ok: true, text: JSON.stringify({ items: mockItemsFor(payload) }), stopReason: "end_turn" };
      }),
    limiter: overrides.limiter ?? new RateLimiter(100),
    keepAliveMs: 5,
    log: (l) => logs.push(l),
    now: overrides.now,
    logs,
    calls,
  };
}
const read = async (res: Response) => ({ status: res.status, body: JSON.parse(await res.text()) as { ok: boolean; category?: string; response?: unknown } });

describe("gates", () => {
  it("method, client header and origin", async () => {
    const { body } = envelope();
    expect((await read(await handleAiTask(request(body, { method: "GET" }), deps()))).status).toBe(405);
    expect((await read(await handleAiTask(request(body, { headers: { [CLIENT_HEADER]: "" } }), deps()))).status).toBe(403);
    const cross = new Request(`${ORIGIN}/api/ai-task`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", [CLIENT_HEADER]: CLIENT_HEADER_VALUE }, body: JSON.stringify(body) });
    expect((await read(await handleAiTask(cross, deps()))).status).toBe(403);
  });
  it("not configured: no key or the kill switch -> 503 not_configured, and the provider is never called", async () => {
    const { body } = envelope();
    const d1 = deps({ env: { ANTHROPIC_API_KEY: undefined } });
    expect(await read(await handleAiTask(request(body), d1))).toEqual({ status: 503, body: { ok: false, category: "not_configured" } });
    const d2 = deps({ env: { HSL_AI_DISABLED: "1" } });
    expect(await read(await handleAiTask(request(body), d2))).toEqual({ status: 503, body: { ok: false, category: "not_configured" } });
    expect(d1.calls).toHaveLength(0);
    expect(d2.calls).toHaveLength(0);
  });
  it("bad JSON, a wrong hash, an extra field and an unsupported task are 400s; oversized is 413", async () => {
    const { body } = envelope();
    const d = deps();
    expect(await read(await handleAiTask(request("{not json"), d))).toEqual({ status: 400, body: { ok: false, category: "bad_request" } });
    expect(await read(await handleAiTask(request({ ...body, contextHash: "0000000000000000" }), d))).toEqual({ status: 400, body: { ok: false, category: "bad_request" } });
    expect(await read(await handleAiTask(request({ ...body, manifest: {} }), d))).toEqual({ status: 400, body: { ok: false, category: "bad_request" } });
    expect(await read(await handleAiTask(request({ ...body, payload: { ...body.payload, task: "summarize_model" } }), d))).toEqual({ status: 400, body: { ok: false, category: "unsupported_task" } });
    expect(await read(await handleAiTask(request({ ...body, payload: { ...body.payload, items: [...body.payload.items, { ref: {}, id: "x", kind: "user_text", subjectId: null, payload: { text: "x".repeat(REMOTE_LIMITS.maxRequestBytes) } }] } }), d))).toEqual({ status: 413, body: { ok: false, category: "too_large" } });
    expect(d.calls).toHaveLength(0);
  });
  it("rate limit per client address, best effort", async () => {
    const { body } = envelope();
    const d = deps({ limiter: new RateLimiter(2) });
    expect((await read(await handleAiTask(request(body), d))).body.ok).toBe(true);
    expect((await read(await handleAiTask(request(body), d))).body.ok).toBe(true);
    expect(await read(await handleAiTask(request(body), d))).toEqual({ status: 429, body: { ok: false, category: "rate_limited" } });
    expect(d.calls).toHaveLength(2);
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 500)).toBe(false);
    expect(limiter.allow("b", 500)).toBe(true);
    expect(limiter.allow("a", 1500)).toBe(true);
  });
});

describe("a good answer", () => {
  it("the provider receives the payload verbatim with the defaults; the response is framed with the REQUEST's task and hash; whitespace heartbeat keeps the body valid JSON", async () => {
    const { ctx, body } = envelope();
    const d = deps();
    const res = await handleAiTask(request(body), d);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    expect(text.startsWith(" ") || text.startsWith("{")).toBe(true);
    const out = JSON.parse(text) as { ok: true; response: { version: number; task: string; contextHash: string; items: unknown[] } };
    expect(out.ok).toBe(true);
    expect(out.response.version).toBe(1);
    expect(out.response.task).toBe("interpret_free_text");
    expect(out.response.contextHash).toBe(ctx.contextHash);
    expect(out.response.items).toEqual(mockItemsFor(providerPayload(ctx)));
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].userMessage).toBe(JSON.stringify(providerPayload(ctx)));
    expect(d.calls[0]).toMatchObject({ apiKey: "test-key-not-real", model: "claude-opus-5", effort: "low", maxOutputTokens: REMOTE_LIMITS.maxOutputTokens, timeoutMs: REMOTE_LIMITS.providerTimeoutMs, task: "interpret_free_text" });
  });
  it("environment overrides model, effort, output and timeout bounds; junk values fall back", async () => {
    const { body } = envelope();
    const d = deps({ env: { HSL_AI_MODEL: "claude-sonnet-5", HSL_AI_EFFORT: "medium", HSL_AI_MAX_OUTPUT_TOKENS: "900", HSL_AI_TIMEOUT_MS: "abc" } });
    await (await handleAiTask(request(body), d)).text();
    expect(d.calls[0]).toMatchObject({ model: "claude-sonnet-5", effort: "medium", maxOutputTokens: 900, timeoutMs: REMOTE_LIMITS.providerTimeoutMs });
  });
  it("the one log line names task, outcome and duration, never the note or the answer", async () => {
    const { body } = envelope();
    const d = deps();
    await (await handleAiTask(request(body), d)).text();
    expect(d.logs).toHaveLength(1);
    expect(JSON.parse(d.logs[0])).toMatchObject({ event: "ai-task", task: "interpret_free_text", outcome: "ok" });
    expect(d.logs[0]).not.toContain("rent");
    expect(d.logs[0]).not.toContain("One tentative reading");
    expect(d.logs[0]).not.toContain("test-key");
  });
});

describe("provider outcomes", () => {
  const withCall = (outcome: Awaited<ReturnType<NonNullable<FunctionDeps["call"]>>> | Error) =>
    deps({
      call: async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    });
  it("refusal, truncation, non-JSON text, an itemless object, a category and a thrown error each become a category, never provider text", async () => {
    const { body } = envelope();
    const table: Array<[Parameters<typeof withCall>[0], string]> = [
      [{ ok: true, text: "I cannot help with that.", stopReason: "refusal" }, "refused"],
      [{ ok: true, text: '{"items":[{"kind":"interp', stopReason: "max_tokens" }, "output_truncated"],
      [{ ok: true, text: "Sure! Here is JSON: {}", stopReason: "end_turn" }, "invalid_output"],
      [{ ok: true, text: '{"answer":"x"}', stopReason: "end_turn" }, "invalid_output"],
      [{ ok: false, category: "rate_limited" }, "rate_limited"],
      [{ ok: false, category: "timeout" }, "timeout"],
      [new Error("boom with secret sk-ant-000"), "provider_error"],
    ];
    for (const [outcome, category] of table) {
      const d = withCall(outcome);
      const text = await (await handleAiTask(request(body), d)).text();
      expect(JSON.parse(text)).toEqual({ ok: false, category });
      expect(text).not.toContain("sk-ant");
      expect(d.logs.join("\n")).not.toContain("sk-ant");
    }
  });
  it("SDK errors map to categories without their messages", () => {
    expect(categorizeProviderError(new Anthropic.APIConnectionTimeoutError())).toBe("timeout");
    expect(categorizeProviderError(new Anthropic.APIConnectionError({ message: "x" }))).toBe("unreachable");
    expect(categorizeProviderError(new Anthropic.RateLimitError(429, {}, "slow down", new Headers()))).toBe("rate_limited");
    expect(categorizeProviderError(new Anthropic.AuthenticationError(401, {}, "bad key", new Headers()))).toBe("not_configured");
    expect(categorizeProviderError(new Anthropic.PermissionDeniedError(403, {}, "no", new Headers()))).toBe("not_configured");
    expect(categorizeProviderError(new Anthropic.InternalServerError(500, {}, "oops", new Headers()))).toBe("provider_error");
    expect(categorizeProviderError(new Error("anything"))).toBe("provider_error");
    expect(categorizeProviderError("string")).toBe("provider_error");
  });
});
