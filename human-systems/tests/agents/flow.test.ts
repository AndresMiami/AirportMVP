/**
 * STEP 7B — the whole first increment through the kernel:
 *   captured evidence -> proposal -> human review -> approved record ->
 *   updated comparison,
 * with the source store wired into review fingerprints. Repeated retrieval
 * manufactures nothing; a materially changed source stales the pending
 * review; approval preserves provenance and leaves the thesis untouched.
 */
import { describe, expect, it, vi } from "vitest";
import { runAgent, planRun } from "@/agents/agent";
import { MemorySourceRepository } from "@/agents/source";
import { thesisOf } from "@/agents/thesis";
import { describeVariableHistory } from "@/discovery/describe-history";
import { basisRows } from "@/features/review/wording";
import { MemoryProposalRepository, ProposalService, describeProposal, revisionOf, staleComparison } from "@/kernel";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import type { SystemModel } from "@/types";
import { THESIS_ID, researchSystem, snapshot } from "../helpers/research-fixture";

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

async function harness() {
  const models = new ModelService(new MemoryModelRepository(), { now: () => NOW });
  const model = await models.save(researchSystem());
  const sources = new MemorySourceRepository();
  let n = 0;
  const svc = new ProposalService(new MemoryProposalRepository(), models, { now: () => NOW }, () => `prop_${++n}`, sources);
  const stored = async () => (await models.load(model.id)) as SystemModel;
  const thesis = thesisOf(model.hypotheses.find((h) => h.id === THESIS_ID)!);
  return { models, model, sources, svc, stored, thesis };
}
const hypothesesOf = (m: SystemModel) => JSON.stringify(m.hypotheses);

describe("captured evidence -> proposal -> review -> approved record -> updated comparison", () => {
  it("runs end to end; the thesis is byte-identical throughout; the record carries the source's provenance and an unassessed confidence", async () => {
    const h = await harness();
    h.sources.add(snapshot());
    const before = revisionOf(await h.stored());
    const hypBefore = hypothesesOf(await h.stored());
    const run = await runAgent(h.svc, h.model, h.thesis, snapshot());
    expect(run.created.map((p) => p.status)).toEqual(["proposed", "proposed"]);
    expect(run.skipped).toEqual([]);
    expect(revisionOf(await h.stored())).toBe(before);
    // the review card reads the source in words
    const buf = run.created.find((p) => p.basis.some((b) => b.kind === "source_item" && b.itemKey === "buf-2026-07"))!;
    const w = describeProposal(buf);
    expect(w.basis[0].text).toBe("Source: Bank export (version 2026-07-31), 31 July 2026: “Closing balance covers 2.0 months of essentials” → 2");
    expect(basisRows(w.basis, buf.resolvedBasis)[0]).toMatchObject({ label: "Source", text: "Bank export (version 2026-07-31), 31 July 2026: “Closing balance covers 2.0 months of essentials” → 2" });
    expect(w.willChange.some((c) => c.details.some((d) => /confidence not assessed/.test(d)))).toBe(true);
    // the person decides
    await h.svc.review(buf.id, "checked the statement");
    const a = await h.svc.approve(buf.id);
    expect(a.ok).toBe(true);
    const after = await h.stored();
    expect(hypothesesOf(after)).toBe(hypBefore);
    const bufVar = after.variables.find((v) => v.id === "buffer")!;
    const entry = bufVar.values.at(-1)!;
    expect(entry).toMatchObject({ value: 2, sourceType: "measured", confidence: null, status: "active", valid: { kind: "date", start: "2026-07-31" } });
    expect(entry.evidence[0]).toMatchObject({ source: { id: "bank-export", version: "2026-07-31", locator: "row 12" }, quote: "Closing balance covers 2.0 months of essentials", period: "31 July 2026" });
    // the deterministic comparison sees the new record
    const history = describeVariableHistory(bufVar, { from: "2026-07-01", to: "2026-08-31" });
    expect(history.records.some((r) => r.value === 2 && r.confidence === null)).toBe(true);
    // the other proposal is untouched and the run was the only author
    expect((await h.svc.list(h.model.id)).map((p) => p.proposedBy.kind)).toEqual(["agent", "agent"]);
  });

  it("repeated retrieval manufactures nothing: the same snapshot, then the same content under a new version, add no proposal; an approved item is recognised as already recorded", async () => {
    const h = await harness();
    h.sources.add(snapshot());
    const first = await runAgent(h.svc, h.model, h.thesis, snapshot());
    expect(first.created).toHaveLength(2);
    const again = await runAgent(h.svc, h.model, h.thesis, snapshot());
    expect(again.created).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(["already_proposed", "already_proposed"]);
    const newer = snapshot({ version: "2026-08-31", retrievedAt: "2026-09-01T09:00:00.000Z" });
    h.sources.add(newer);
    const third = await runAgent(h.svc, h.model, h.thesis, newer);
    expect(third.created).toEqual([]);
    // unchanged content in a newer version leaves the pending reviews as they are
    for (const p of first.created) expect((await h.svc.revalidate(p.id)).status).toBe("proposed");
    // approve one, then a fresh run sees it as recorded, not merely proposed
    const buf = first.created.find((p) => p.basis.some((b) => b.kind === "source_item" && b.itemKey === "buf-2026-07"))!;
    await h.svc.review(buf.id);
    expect((await h.svc.approve(buf.id)).ok).toBe(true);
    const plan = planRun(await h.stored(), await h.svc.list(h.model.id), h.thesis, newer);
    expect(plan.skipped.map((s) => [s.capture.item.key, s.reason])).toEqual([
      ["inc-2026-07", "already_proposed"],
      ["buf-2026-07", "already_recorded"],
    ]);
    expect((await h.stored()).variables.find((v) => v.id === "buffer")!.values.filter((e) => e.evidence.some((ev) => ev.source?.id === "bank-export"))).toHaveLength(1);
  });

  it("a material change to the source stales the pending review, blocks approval, and is proposed afresh; the thesis edit path stales it too", async () => {
    const h = await harness();
    h.sources.add(snapshot());
    const first = await runAgent(h.svc, h.model, h.thesis, snapshot());
    const buf = first.created.find((p) => p.basis.some((b) => b.kind === "source_item" && b.itemKey === "buf-2026-07"))!;
    await h.svc.review(buf.id);
    const corrected = snapshot({ version: "2026-07-31-corrected", retrievedAt: "2026-08-02T09:00:00.000Z", items: snapshot().items.map((i) => (i.key === "buf-2026-07" ? { ...i, value: 2.5, quote: "Closing balance covers 2.5 months of essentials" } : i)) });
    h.sources.add(corrected);
    const stale = await h.svc.revalidate(buf.id);
    expect(stale.status).toBe("stale");
    expect(staleComparison(stale)?.changedSince.some((l) => /Source/.test(l))).toBe(true);
    expect((await h.svc.approve(buf.id)).ok).toBe(false);
    const rerun = await runAgent(h.svc, h.model, h.thesis, corrected);
    expect(rerun.created.map((p) => p.basis[0])).toMatchObject([{ kind: "source_item", itemKey: "buf-2026-07", version: "2026-07-31-corrected" }]);
    expect(rerun.skipped.map((s) => [s.capture.item.key, s.reason])).toEqual([["inc-2026-07", "already_proposed"]]);
    // an item that disappears from the current version is a missing basis
    h.sources.add(snapshot({ version: "2026-09-30", retrievedAt: "2026-10-01T09:00:00.000Z", items: [snapshot().items[1]] }));
    const gone = await h.svc.revalidate(rerun.created[0].id);
    expect(gone.status).toBe("stale");
    expect(describeProposal(gone).basis[0].resolved).toBe(false);
  });

  it("without a source store the reviewed snapshot stands in and nothing goes stale on its own", async () => {
    const models = new ModelService(new MemoryModelRepository(), { now: () => NOW });
    const model = await models.save(researchSystem());
    const svc = new ProposalService(new MemoryProposalRepository(), models, { now: () => NOW });
    const run = await runAgent(svc, model, thesisOf(model.hypotheses.find((x) => x.id === THESIS_ID)!), snapshot());
    expect(run.created).toHaveLength(2);
    expect((await svc.revalidate(run.created[0].id)).status).toBe("proposed");
  });
});
