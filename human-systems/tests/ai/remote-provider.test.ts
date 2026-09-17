/**
 * STEP 7A — the real provider's browser adapter, exercised with a FAKE
 * transport only (no network, no key, no paid call). The quality bar:
 * the transport receives exactly providerPayload(ctx) with its
 * contextHash; a valid answer passes the strict contract and keeps the
 * hash; a changed note, date or model hides the old answer; malformed
 * output, unsupported references, timeouts and network failures are whole
 * failures with safe words and one attempt; unsupported or oversized
 * requests never reach the transport; the mock path needs no transport.
 */
import { describe, expect, it, vi } from "vitest";
import { buildAiContext, providerPayload, type AiProviderPayload } from "@/ai/context";
import { describeFailure } from "@/ai/remote-contract";
import { mockItemsFor } from "@/ai/task-mock";
import { RemoteAiTaskProvider, type RemoteTransport, type RemoteTransportInput } from "@/ai/task-remote";
import { ADAPTER_IDS, CONFIGURED_PROVIDER_KIND, createTaskProvider, providerKindFrom } from "@/ai/task-select";
import { homeContext, visibleReflection } from "@/features/home/reflection";
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

const TODAY = "2026-09-16";
const NOTE = "My hours dropped from 40 to 15 in March.";

/** A fake service: answers like the deterministic mock would, framed the way the function frames it. */
function fakeService(mutate: (items: unknown[], payload: AiProviderPayload) => unknown = (items) => items): { transport: RemoteTransport; calls: RemoteTransportInput[] } {
  const calls: RemoteTransportInput[] = [];
  const transport: RemoteTransport = async (input) => {
    calls.push(input);
    const req = JSON.parse(input.body) as { payload: AiProviderPayload; contextHash: string };
    const items = mutate(mockItemsFor(req.payload), req.payload);
    return { status: 200, text: `  ${JSON.stringify({ ok: true, response: { version: 1, task: req.payload.task, contextHash: req.contextHash, items } })}` };
  };
  return { transport, calls };
}
const home = (model = ccSystem(), draft = NOTE, asOf: string | null = null) => {
  const c = homeContext(model, draft, asOf, TODAY);
  if (!c || "error" in c) throw new Error("context expected");
  return c.ctx;
};

describe("Home note -> reflection service -> validated response", () => {
  it("sends exactly providerPayload(ctx) and its contextHash, once, with a same-origin endpoint; the validated answer keeps the hash", async () => {
    const ctx = home();
    const svc = fakeService();
    const provider = new RemoteAiTaskProvider({ transport: svc.transport });
    const r = await provider.run(providerPayload(ctx), ctx.contextHash);
    expect(r.ok).toBe(true);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].url).toBe("/api/ai-task");
    const sent = JSON.parse(svc.calls[0].body);
    expect(sent).toEqual({ version: 1, payload: providerPayload(ctx), contextHash: ctx.contextHash });
    expect(Object.keys(sent).sort()).toEqual(["contextHash", "payload", "version"]);
    expect(svc.calls[0].body).not.toContain(ctx.sourceRevisionHash);
    expect(svc.calls[0].body).not.toContain("manifest");
    if (r.ok) {
      expect(r.response.contextHash).toBe(ctx.contextHash);
      expect(r.response.task).toBe("interpret_free_text");
      expect(r.response.items.length).toBeGreaterThan(0);
    }
  });
  it("a changed note, as-of date or relevant model value hides the old reflection; nothing reruns the provider", async () => {
    const m = ccSystem();
    const ctx = home(m);
    const svc = fakeService();
    const r = await new RemoteAiTaskProvider({ transport: svc.transport }).run(providerPayload(ctx), ctx.contextHash);
    if (!r.ok) throw new Error(r.error);
    const reflection = { forHash: ctx.contextHash, result: { ok: true as const, items: r.response.items } };
    expect(visibleReflection(reflection, homeContext(m, NOTE, null, TODAY))).toEqual(reflection.result);
    expect(visibleReflection(reflection, homeContext(m, `${NOTE} More.`, null, TODAY))).toBeNull();
    expect(visibleReflection(reflection, homeContext(m, NOTE, "2025-06-01", TODAY))).toBeNull();
    const changed = M.recordValue(m, "buffer", { value: 9, valid: { kind: "date", start: "2026-09-10", precision: "day", text: "2026-09-10" }, sourceType: "self_reported", confidence: 0.6 });
    expect(visibleReflection(reflection, homeContext(changed, NOTE, null, TODAY))).toBeNull();
    expect(svc.calls).toHaveLength(1);
  });
  it("a malformed answer is rejected WHOLE: one forbidden claim, one unknown key or one unsupported reference discards every item", async () => {
    const ctx = home();
    const cases: Array<(items: unknown[]) => unknown> = [
      (items) => [{ ...(items[0] as object), text: "This caused the drop." }],
      (items) => [{ ...(items[0] as object), confidence: 0.7 }],
      (items) => [{ ...(items[0] as object), restsOn: ["value:not_in_context@2026-09-16"] }],
      (items) => [...items, { kind: "candidate_explanation", id: "out_9", text: "x", forPattern: "pattern:none", restsOn: ["user_text:x"], state: "tentative", weakenedBy: [], alternatives: [] }],
      (items) => [{ ...(items[0] as object), state: "directly_stated" }],
      () => "not even an array",
    ];
    for (const mutate of cases) {
      const svc = fakeService(mutate);
      const r = await new RemoteAiTaskProvider({ transport: svc.transport }).run(providerPayload(ctx), ctx.contextHash);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.startsWith(describeFailure("invalid_output"))).toBe(true);
      expect(svc.calls).toHaveLength(1);
    }
  });
  it("a response for another context or task is refused", async () => {
    const ctx = home();
    const wrongHash: RemoteTransport = async () => ({ status: 200, text: JSON.stringify({ ok: true, response: { version: 1, task: "interpret_free_text", contextHash: "0000000000000000", items: [] } }) });
    const r = await new RemoteAiTaskProvider({ transport: wrongHash }).run(providerPayload(ctx), ctx.contextHash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("did not meet the contract");
  });
});

describe("failures leave nothing behind and try once", () => {
  it("timeout, network failure, non-JSON body, unexpected shape and a service category each become safe words after ONE attempt", async () => {
    const ctx = home();
    const payload = providerPayload(ctx);
    const table: Array<[RemoteTransport, string]> = [
      [({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))), describeFailure("timeout")],
      [async () => Promise.reject(new TypeError("Failed to fetch")), describeFailure("unreachable")],
      [async () => ({ status: 502, text: "<html>Bad gateway</html>" }), describeFailure("unreachable")],
      [async () => ({ status: 200, text: "{}" }), describeFailure("service_error")],
      [async () => ({ status: 200, text: JSON.stringify({ ok: true, response: {}, extra: 1 }) }), describeFailure("service_error")],
      [async () => ({ status: 503, text: JSON.stringify({ ok: false, category: "not_configured" }) }), describeFailure("not_configured")],
      [async () => ({ status: 429, text: JSON.stringify({ ok: false, category: "rate_limited" }) }), describeFailure("rate_limited")],
      [async () => ({ status: 200, text: JSON.stringify({ ok: false, category: "refused" }) }), describeFailure("refused")],
    ];
    for (const [transport, words] of table) {
      let calls = 0;
      const counting: RemoteTransport = (i) => {
        calls += 1;
        return transport(i);
      };
      const r = await new RemoteAiTaskProvider({ transport: counting, timeoutMs: 15 }).run(payload, ctx.contextHash);
      expect(r).toEqual({ ok: false, error: words });
      expect(calls).toBe(1);
    }
  });
  it("an unsupported task or an oversized request never reaches the transport", async () => {
    const ctx = buildAiContext(ccSystem(), "summarize_model", { subjectIds: [ccSystem().id], asOf: TODAY });
    const svc = fakeService();
    const r = await new RemoteAiTaskProvider({ transport: svc.transport }).run(providerPayload(ctx), ctx.contextHash);
    expect(r).toEqual({ ok: false, error: describeFailure("unsupported_task") });
    const big = home(ccSystem(), "x".repeat(250_000));
    const r2 = await new RemoteAiTaskProvider({ transport: svc.transport }).run(providerPayload(big), big.contextHash);
    expect(r2).toEqual({ ok: false, error: describeFailure("too_large") });
    expect(svc.calls).toHaveLength(0);
  });
});

describe("provider selection", () => {
  it("is explicit: only the literal 'remote' selects the service; tests and unset builds get the offline mock", async () => {
    expect(providerKindFrom(undefined)).toBe("mock");
    expect(providerKindFrom("")).toBe("mock");
    expect(providerKindFrom("true")).toBe("mock");
    expect(providerKindFrom("anthropic")).toBe("mock");
    expect(providerKindFrom("remote")).toBe("remote");
    expect(providerKindFrom(" Remote ")).toBe("remote");
    expect(CONFIGURED_PROVIDER_KIND).toBe("mock"); // vitest never sets the flag
    const mock = createTaskProvider("mock");
    expect(mock.name).toBe(ADAPTER_IDS.mock);
    const ctx = buildAiContext(ccSystem(), "suggest_explanations_for_pattern", { pattern: CC_PATTERN });
    const r = await mock.run(providerPayload(ctx), ctx.contextHash);
    expect(r.ok).toBe(true);
    const remote = createTaskProvider("remote", { transport: async () => Promise.reject(new Error("offline")) });
    expect(remote.name).toBe(ADAPTER_IDS.remote);
    expect(await remote.run(providerPayload(ctx), ctx.contextHash)).toEqual({ ok: false, error: describeFailure("unreachable") });
  });
});
