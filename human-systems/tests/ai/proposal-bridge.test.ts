/**
 * STEP 5D — validated AI output -> human-initiated proposal. The bridge is
 * pure and emits exactly one registered addHypothesis per candidate
 * explanation (the pattern's subject, confidence null, nothing else
 * invented); the person is the proposer and the AI output is recorded as
 * ORIGIN beside the re-resolvable evidence basis, so Step 4 staleness
 * holds unchanged; the same AI output never opens a second proposal.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAiContext, providerPayload, type AiContext } from "@/ai/context";
import { proposalsFromSuggestion, suggestionState, toProposalSet } from "@/ai/proposal-bridge";
import type { AiResponse } from "@/ai/response";
import { MockAiTaskProvider } from "@/ai/task-mock";
import { MemoryProposalRepository, ProposalService, describeProposal, revisionOf, staleComparison } from "@/kernel";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";
import { CC_C, CC_DATE, CC_PATTERN, ccEntry, ccSystem } from "../helpers/cross-context-fixture";

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
const ADAPTER = "task-mock";

async function harness() {
  const repo = new MemoryModelRepository();
  const models = new ModelService(repo, { now: () => NOW });
  const model = await models.save(M.addObservation(ccSystem(), { id: "obs_p1", statement: "Part one said something", sourceType: "self_reported", confidence: 0.6, subjectId: "p1" }));
  let n = 0;
  const svc = new ProposalService(new MemoryProposalRepository(), models, { now: () => NOW }, () => `prop_${++n}`);
  const context = (m: SystemModel = model, extra = {}) => buildAiContext(m, "suggest_explanations_for_pattern", { pattern: CC_PATTERN, ...extra }, { now: NOW });
  const mocked = async (ctx: AiContext) => {
    const r = await new MockAiTaskProvider().run(providerPayload(ctx), ctx.contextHash);
    if (!r.ok) throw new Error(r.error);
    return r.response;
  };
  return { repo, models, model, svc, context, mocked };
}
const stored = async (h: { models: ModelService; model: SystemModel }) => (await h.models.load(h.model.id)) as SystemModel;
const setEntries = (m: SystemModel, id: string, values: SystemModel["variables"][number]["values"]) => ({ ...m, variables: m.variables.map((v) => (v.id === id ? { ...v, values } : v)) });

describe("the bridge", () => {
  it("a CandidateExplanation becomes exactly one addHypothesis: the AI's words, the PATTERN's subject, confidence null, nothing else; questions are informational", async () => {
    const h = await harness();
    const ctx = h.context();
    const response = await h.mocked(ctx);
    const r = toProposalSet(ctx, response, ADAPTER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.call).toEqual({ task: "suggest_explanations_for_pattern", contextHash: ctx.contextHash, sourceRevisionHash: ctx.sourceRevisionHash });
    expect(r.set.candidates).toHaveLength(1);
    expect(r.set.informational).toEqual([{ id: "out_2", kind: "question" }]);
    const c = r.set.candidates[0];
    expect(c.request).toEqual([{ kind: "addHypothesis", args: { statement: expect.stringMatching(/^One possibility is/), subjectId: "p1", confidence: null } }]);
    expect(Object.keys((c.mutation as { args: object }).args).sort()).toEqual(["confidence", "statement", "subjectId"]);
    expect(c.uncertainty).toBe("tentative");
    expect(c.identity).toEqual({ adapterId: ADAPTER, contextHash: ctx.contextHash, outputItemId: "out_1" });
    expect(c.basis.map((b) => b.kind)).toEqual(["ai_output", "pattern", "cross_context"]);
    const origin = c.basis[0];
    expect(origin).toMatchObject({ kind: "ai_output", adapterId: ADAPTER, task: "suggest_explanations_for_pattern", contextHash: ctx.contextHash, sourceRevisionHash: ctx.sourceRevisionHash, outputItemId: "out_1", outputKind: "candidate_explanation", state: "tentative" });
    expect(JSON.stringify(c.basis)).not.toMatch(/subjectsExcluded|sensitiveExcluded|manifest|"items"/);
  });

  it("cited observations, events, catalogue questions and user text become their exact kernel basis kinds; a cited kind with no re-resolvable basis fails the WHOLE set visibly; other kinds create nothing", async () => {
    const h = await harness();
    const ctx = h.context(h.model, { observationIds: ["obs_p1"] });
    const p = providerPayload(ctx);
    const pat = p.items.find((i) => i.kind === "pattern")!.id;
    const cc = p.items.find((i) => i.kind === "cross_context")!.id;
    const prompt = p.items.find((i) => i.kind === "catalogue_prompt")!.id;
    const obs = p.items.find((i) => i.kind === "observation")!.id;
    const resp = (restsOn: string[]): AiResponse => ({ version: 1, task: "suggest_explanations_for_pattern", contextHash: ctx.contextHash, items: [{ kind: "candidate_explanation", id: "x1", text: "One possibility.", forPattern: pat, restsOn, state: "interpretive", weakenedBy: [], alternatives: [] }] });
    const r = toProposalSet(ctx, resp([cc, prompt, obs]), ADAPTER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.candidates[0].basis.map((b) => b.kind)).toEqual(["ai_output", "pattern", "cross_context", "catalogue_prompt", "observation"]);
    expect(r.set.candidates[0].basis[3]).toEqual({ kind: "catalogue_prompt", domainId: "explore_proposal_test", domainVersion: 1, promptId: "q_work", question: "Could the work available have been mostly short contracts?" });
    // the system item is citable by the contract but has no re-resolvable basis: the set is not bridgeable
    const sys = p.items.find((i) => i.kind === "system")!.id;
    const bad = toProposalSet(ctx, resp([sys]), ADAPTER);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/a "system" item that has no re-resolvable proposal basis yet/);
    // a response for another context is refused
    expect(toProposalSet(ctx, { ...resp([cc]), contextHash: "0000000000000000" }, ADAPTER).ok).toBe(false);
    // non-explanation kinds never create candidates
    const q: AiResponse = { version: 1, task: "suggest_explanations_for_pattern", contextHash: ctx.contextHash, items: [{ kind: "question", id: "q1", text: "?", targets: [pat], whyItMatters: "w" }] };
    const only = toProposalSet(ctx, q, ADAPTER);
    expect(only.ok && only.set.candidates).toEqual([]);
    expect(only.ok && only.set.informational).toEqual([{ id: "q1", kind: "question" }]);
  });
});

describe("through the kernel: person submits, staleness holds, approval creates the working hypothesis", () => {
  async function submitted(h: Awaited<ReturnType<typeof harness>>) {
    const ctx = h.context();
    const set = toProposalSet(ctx, await h.mocked(ctx), ADAPTER);
    if (!set.ok) throw new Error(set.error);
    const c = set.set.candidates[0];
    const before = revisionOf(await stored(h));
    const p = await h.svc.create({ modelId: h.model.id, request: c.request, proposedBy: { kind: "person" }, rationale: c.rationale, basis: c.basis });
    expect(revisionOf(await stored(h))).toBe(before); // byte-identical after creation
    return { ctx, candidate: c, proposal: p };
  }

  it("proposedBy is the person; the card says the AI wording is origin, not evidence; approval yields a proposed, not-assessed hypothesis for the pattern subject", async () => {
    const h = await harness();
    const { proposal } = await submitted(h);
    expect(proposal.proposedBy).toEqual({ kind: "person" });
    expect(proposal.preview.ok).toBe(true);
    const w = describeProposal(proposal);
    expect(w.basis[0].text).toMatch(/^AI wording that prompted this proposal: “One possibility is .*” \(tentative; adapter task-mock\)\. The AI output is not evidence\. The cited records below are the basis for reviewing the proposal\.$/);
    expect(w.basis[1].text).toMatch(/^Pattern: income_stability was recorded at 5 u at 4 distinct times/);
    expect(w.basis[2].text).toMatch(/^Explore comparison: 4 occurrences compared with 3 times/);
    expect(w.willChange[0].details).toContain("Confidence: not assessed.");
    await h.svc.review(proposal.id);
    const a = await h.svc.approve(proposal.id);
    expect(a.ok).toBe(true);
    const hyp = (a.ok ? a.model : h.model).hypotheses.find((x) => x.statement.startsWith("One possibility is"))!;
    expect(hyp).toMatchObject({ status: "proposed", confidence: null, subjectId: "p1", kind: "general", predictions: [], disconfirmingConditions: [], killCriteria: [], relationshipIds: [], notes: "" });
  });

  it("rejection leaves the model byte-identical; the same AI output is then reported rejected and not recreated", async () => {
    const h = await harness();
    const { candidate, proposal } = await submitted(h);
    const before = revisionOf(await stored(h));
    await h.svc.reject(proposal.id, "no");
    expect(revisionOf(await stored(h))).toBe(before);
    const st = suggestionState(await h.svc.list(h.model.id), candidate.identity);
    expect(st.state).toBe("rejected");
  });

  it("duplicate protection: an open proposal for the same adapter + contextHash + output id is found instead of recreated; applied is reported as already added", async () => {
    const h = await harness();
    const { candidate, proposal } = await submitted(h);
    const open = suggestionState(await h.svc.list(h.model.id), candidate.identity);
    expect(open).toEqual({ state: "open", proposal: expect.objectContaining({ id: proposal.id, status: "proposed" }) });
    expect(proposalsFromSuggestion(await h.svc.list(h.model.id), { ...candidate.identity, outputItemId: "out_9" })).toEqual([]);
    expect(proposalsFromSuggestion(await h.svc.list(h.model.id), { ...candidate.identity, contextHash: "ffffffffffffffff" })).toEqual([]);
    await h.svc.review(proposal.id);
    await h.svc.approve(proposal.id);
    expect(suggestionState(await h.svc.list(h.model.id), candidate.identity).state).toBe("applied");
  });

  it("Step 4 staleness holds for an AI-origin proposal: a changed Explore comparison goes stale with identical AI wording; an unrelated change revalidates harmlessly", async () => {
    const h = await harness();
    const { proposal } = await submitted(h);
    await h.svc.review(proposal.id);
    // unrelated: another subject's record
    let m = await stored(h);
    const o = m.variables.find((v) => v.id === "other_subject")!;
    await h.models.save(setEntries(m, "other_subject", o.values.map((e) => ({ ...e, value: 2 }))));
    expect((await h.svc.revalidate(proposal.id)).status).toBe("reviewed");
    // the comparison: one contrast reading of buffer moves, differentiating -> mixed
    m = await stored(h);
    const b = m.variables.find((v) => v.id === "buffer")!;
    await h.models.save(setEntries(m, "buffer", b.values.map((e) => (e.valid.start === CC_C[1] ? { ...e, value: 1.5 } : e))));
    const r = await h.svc.revalidate(proposal.id);
    expect(r.status).toBe("stale");
    expect(r.preview.changes).toEqual(r.previousPreview?.changes);
    expect(r.resolvedBasis[0].content).toEqual(proposal.resolvedBasis[0].content); // the AI origin snapshot never moves
    expect(staleComparison(r)!.changedSince.some((l) => /Explore comparison/.test(l))).toBe(true);
    expect((await h.svc.approve(proposal.id)).ok).toBe(false);
    // the recurrence itself
    await h.svc.review(proposal.id);
    m = await stored(h);
    const y = m.variables.find((v) => v.id === "income_stability")!;
    await h.models.save(setEntries(m, "income_stability", [...y.values, ccEntry(5, CC_DATE("2026-08-01"))]));
    expect((await h.svc.revalidate(proposal.id)).status).toBe("stale");
  });
});

describe("source pins", () => {
  it("the bridge imports no repository or service and emits addHypothesis only; /ai imports no mutation function and calls no save/apply path", () => {
    const bridge = readFileSync(path.join(process.cwd(), "src/ai/proposal-bridge.ts"), "utf8");
    expect(bridge).not.toMatch(/@\/repositories|@\/services|localStorage|@\/kernel\/service|ProposalService/);
    expect(bridge.match(/kind: "add\w+"/g)).toEqual(['kind: "addHypothesis"']);
    expect(bridge).not.toMatch(/addDisconfirmingCondition|addKillCriterion|addObservation|addVariable/);
    const page = readFileSync(path.join(process.cwd(), "src/app/ai/page.tsx"), "utf8");
    expect(page).not.toMatch(/@\/services\/mutations|replaceModel|updateVariable|\.save\(|saveIfRevision|\bapply\(/);
    expect(page).toMatch(/proposedBy: \{ kind: "person" \}/);
    expect(page).toMatch(/Review as hypothesis/);
    expect(page).not.toMatch(/Accept as true|Add to the model|Save hypothesis/);
  });
});
