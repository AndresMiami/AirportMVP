/**
 * HOME REFLECTION BINDING (6A.1.1): a demo reflection is shown only while
 * the provider-visible context that produced it is the current one. The
 * identity is the same contextHash the technical /ai screen uses; nothing
 * reruns the provider. Neutral domain; household mocked to throw.
 */
import { describe, expect, it, vi } from "vitest";
import { providerPayload } from "@/ai/context";
import { MockAiTaskProvider } from "@/ai/task-mock";
import { homeContext, visibleReflection, type HomeReflection } from "@/features/home/reflection";
import * as M from "@/services/mutations";
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

const TODAY = "2026-09-16";
const TEXT = "My hours dropped from 40 to 15 in March.";

async function reflect(model = ccSystem(), draft = TEXT, asOf: string | null = null): Promise<{ reflection: HomeReflection; hash: string }> {
  const current = homeContext(model, draft, asOf, TODAY);
  if (!current || "error" in current) throw new Error("context expected");
  const r = await new MockAiTaskProvider().run(providerPayload(current.ctx), current.ctx.contextHash);
  if (!r.ok) throw new Error(r.error);
  return { reflection: { forHash: current.ctx.contextHash, result: { ok: true, items: r.response.items } }, hash: current.ctx.contextHash };
}

describe("homeContext", () => {
  it("is null without text, a context with the person's text otherwise, and the as-of date is explicit content", () => {
    const m = ccSystem();
    expect(homeContext(m, "   ", null, TODAY)).toBeNull();
    const c = homeContext(m, TEXT, null, TODAY);
    expect(c && "ctx" in c && c.ctx.task).toBe("interpret_free_text");
    const d = homeContext(m, TEXT, "2025-06-01", TODAY);
    expect(c && d && "ctx" in c && "ctx" in d && c.ctx.contextHash !== d.ctx.contextHash).toBe(true);
  });
});

describe("visibleReflection", () => {
  it("reflect -> result visible while the context is unchanged", async () => {
    const m = ccSystem();
    const { reflection } = await reflect(m);
    expect(visibleReflection(reflection, homeContext(m, TEXT, null, TODAY))).toEqual(reflection.result);
    expect(visibleReflection(reflection, homeContext({ ...m, updatedAt: "2030-01-01T00:00:00.000Z" }, TEXT, null, TODAY))).toEqual(reflection.result);
  });
  it("reflect -> change the as-of date -> the old result is hidden, and nothing reruns the provider", async () => {
    const m = ccSystem();
    const { reflection } = await reflect(m);
    expect(visibleReflection(reflection, homeContext(m, TEXT, "2025-06-01", TODAY))).toBeNull();
    expect(visibleReflection(reflection, homeContext(m, TEXT, null, TODAY))).toEqual(reflection.result);
  });
  it("reflect -> a relevant model value changes -> the old result is hidden", async () => {
    const m = ccSystem();
    const { reflection } = await reflect(m);
    const changed = M.recordValue(m, "buffer", { value: 9, valid: { kind: "date", start: "2026-09-10", precision: "day", text: "2026-09-10" }, sourceType: "self_reported", confidence: 0.6 });
    expect(visibleReflection(reflection, homeContext(changed, TEXT, null, TODAY))).toBeNull();
  });
  it("reflect -> the text changes -> the old result is hidden; no text or a builder refusal shows nothing", async () => {
    const m = ccSystem();
    const { reflection } = await reflect(m);
    expect(visibleReflection(reflection, homeContext(m, `${TEXT} And more.`, null, TODAY))).toBeNull();
    expect(visibleReflection(reflection, null)).toBeNull();
    expect(visibleReflection(reflection, { error: "refused" })).toBeNull();
    expect(visibleReflection(null, homeContext(m, TEXT, null, TODAY))).toBeNull();
  });
});
