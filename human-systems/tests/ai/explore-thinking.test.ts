/**
 * STEP 7A — Explore "Help me think" end to end with a FAKE transport:
 * pattern -> reflection service -> validated candidate explanation -> the
 * unchanged 5D bridge -> ONE addHypothesis proposal the person submits ->
 * the stored model byte-identical -> review -> approve -> a canonical
 * hypothesis with confidence null. A failed call writes nothing anywhere.
 */
import { describe, expect, it, vi } from "vitest";
import { providerPayload } from "@/ai/context";
import { toProposalSet } from "@/ai/proposal-bridge";
import { describeFailure } from "@/ai/remote-contract";
import { mockItemsFor } from "@/ai/task-mock";
import { RemoteAiTaskProvider, type RemoteTransport } from "@/ai/task-remote";
import { ADAPTER_IDS } from "@/ai/task-select";
import { exploreContext, visibleThinking } from "@/features/explore/thinking";
import { MemoryProposalRepository, ProposalService, revisionOf } from "@/kernel";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import type { SystemModel } from "@/types";
import { CC_DATE, CC_PATTERN, ccEntry, ccSystem } from "../helpers/cross-context-fixture";

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

const service: RemoteTransport = async ({ body }) => {
  const req = JSON.parse(body);
  return { status: 200, text: JSON.stringify({ ok: true, response: { version: 1, task: req.payload.task, contextHash: req.contextHash, items: mockItemsFor(req.payload) } }) };
};

async function harness() {
  const repo = new MemoryModelRepository();
  const models = new ModelService(repo, { now: () => NOW });
  const model = await models.save(ccSystem());
  let n = 0;
  const svc = new ProposalService(new MemoryProposalRepository(), models, { now: () => NOW }, () => `prop_${++n}`);
  const stored = async () => (await models.load(model.id)) as SystemModel;
  return { models, model, svc, stored };
}

describe("Explore pattern -> service -> candidate -> Review as hypothesis", () => {
  it("the whole path: model unchanged until approval, then a hypothesis with confidence null and the AI wording as origin", async () => {
    const h = await harness();
    const current = exploreContext(h.model, CC_PATTERN);
    if (!("ctx" in current)) throw new Error(current.error);
    const ctx = current.ctx;
    expect(ctx.task).toBe("suggest_explanations_for_pattern");
    const r = await new RemoteAiTaskProvider({ transport: service }).run(providerPayload(ctx), ctx.contextHash);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(visibleThinking({ forHash: ctx.contextHash, result: r }, current)).toEqual(r);
    const set = toProposalSet(ctx, r.response, ADAPTER_IDS.remote);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.set.candidates).toHaveLength(1);
    const c = set.set.candidates[0];
    expect(c.identity).toEqual({ adapterId: "task-remote", contextHash: ctx.contextHash, outputItemId: "out_1" });
    expect(c.uncertainty).toBe("tentative");
    const before = revisionOf(await h.stored());
    const p = await h.svc.create({ modelId: h.model.id, request: c.request, proposedBy: { kind: "person" }, rationale: c.rationale, basis: c.basis });
    expect(p.proposedBy).toEqual({ kind: "person" });
    expect(p.request.map((s) => s.kind)).toEqual(["addHypothesis"]);
    expect(revisionOf(await h.stored())).toBe(before);
    await h.svc.review(p.id);
    expect(revisionOf(await h.stored())).toBe(before);
    const a = await h.svc.approve(p.id);
    expect(a.ok).toBe(true);
    const after = await h.stored();
    expect(revisionOf(after)).not.toBe(before);
    const hyp = after.hypotheses.find((x) => x.statement.startsWith("One possibility is"));
    expect(hyp).toMatchObject({ status: "proposed", confidence: null, subjectId: CC_PATTERN.subjectId, predictions: [], killCriteria: [] });
    expect(after.hypotheses).toHaveLength(h.model.hypotheses.length + 1);
  });
  it("a failed call writes nothing: the ledger stays empty and the model byte-identical; the failure hides once the pattern context changes", async () => {
    const h = await harness();
    const current = exploreContext(h.model, CC_PATTERN);
    if (!("ctx" in current)) throw new Error(current.error);
    const before = revisionOf(await h.stored());
    const failing: RemoteTransport = async () => Promise.reject(new Error("offline"));
    const r = await new RemoteAiTaskProvider({ transport: failing }).run(providerPayload(current.ctx), current.ctx.contextHash);
    expect(r).toEqual({ ok: false, error: describeFailure("unreachable") });
    expect(toProposalSet(current.ctx, { version: 1, task: "suggest_explanations_for_pattern", contextHash: current.ctx.contextHash, items: [] }, ADAPTER_IDS.remote)).toMatchObject({ ok: true, set: { candidates: [] } });
    expect(await h.svc.list(h.model.id)).toEqual([]);
    expect(revisionOf(await h.stored())).toBe(before);
    const thinking = { forHash: current.ctx.contextHash, result: r };
    expect(visibleThinking(thinking, current)).toEqual(r);
    const y = h.model.variables.find((v) => v.id === "income_stability")!;
    const changed = { ...h.model, variables: h.model.variables.map((v) => (v.id === y.id ? { ...v, values: [...v.values, ccEntry(5, CC_DATE("2026-08-01"))] } : v)) };
    expect(visibleThinking(thinking, exploreContext(changed, CC_PATTERN))).toBeNull();
    expect(visibleThinking(thinking, exploreContext(h.model, { ...CC_PATTERN, interval: { from: "2025-06-01", to: "2026-12-31" } }))).toBeNull();
    expect(visibleThinking(null, current)).toBeNull();
  });
});
