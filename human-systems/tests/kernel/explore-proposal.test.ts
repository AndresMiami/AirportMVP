/**
 * STEP 4 — Explore -> Investigate -> proposal -> review -> approved
 * hypothesis, and the staleness that makes it honest: the proposal's
 * basis RE-RESOLVES the pattern, the deterministic Explore comparison and
 * the catalogue question, so the review expires when what the person saw
 * changes, even when the hypothesis mutation itself is identical.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crossContext, contextSubjectsFor, type CrossContext } from "@/discovery";
import { buildExploreProposal, createdFromPattern, mergeRelated, patternSummary, reconcileDraft, CROSS_CONTEXT_SUMMARY } from "@/features/explore/proposal";
import { MemoryProposalRepository, ProposalService, describeProposal, resolveBasis, resolveCrossContext, staleComparison, type MutationProposal } from "@/kernel";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";
import { CC_C, CC_DATE, CC_DOMAIN, CC_PATTERN, ccEntry, ccSystem } from "../helpers/cross-context-fixture";

const NOW = "2026-09-16T12:00:00.000Z";

async function harness() {
  const repo = new MemoryModelRepository();
  const models = new ModelService(repo, { now: () => NOW });
  const model = await models.save(ccSystem());
  let n = 0;
  const svc = new ProposalService(new MemoryProposalRepository(), models, { now: () => NOW }, () => `prop_${++n}`);
  const r = crossContext(model, CC_PATTERN, { contextSubjectIds: contextSubjectsFor(model, CC_PATTERN, CC_DOMAIN) }) as CrossContext;
  expect(r.ok).toBe(true);
  return { repo, models, model, svc, r };
}
const stored = async (h: { models: ModelService; model: SystemModel }) => (await h.models.load(h.model.id)) as SystemModel;
const setEntries = (m: SystemModel, id: string, values: SystemModel["variables"][number]["values"]) => ({ ...m, variables: m.variables.map((v) => (v.id === id ? { ...v, values } : v)) });

describe("what Investigate proposes", () => {
  it("one addHypothesis: the draft's words, the pattern's subject, confidence null; nothing else invented; basis = pattern + Explore comparison + the person's words (+ the question only when it prompted the draft)", async () => {
    const h = await harness();
    const input = buildExploreProposal({ text: "  The work available was mostly short contracts. " }, h.r, CC_DOMAIN);
    expect(input.request).toEqual([{ kind: "addHypothesis", args: { statement: "The work available was mostly short contracts.", subjectId: "p1", confidence: null } }]);
    expect(input.basis.map((b) => b.kind)).toEqual(["pattern", "cross_context", "user_statement"]);
    expect(input.basis[0]).toEqual({ kind: "pattern", ref: CC_PATTERN, summary: patternSummary(h.r) });
    expect(patternSummary(h.r)).toBe("income_stability was recorded at 5 u at 4 distinct times between Jan 2025 and Dec 2026.");
    expect(input.basis[1]).toEqual({ kind: "cross_context", pattern: CC_PATTERN, summary: CROSS_CONTEXT_SUMMARY });
    const prompted = buildExploreProposal({ text: "Mostly short contracts.", promptId: "q_work" }, h.r, CC_DOMAIN);
    expect(prompted.basis.at(-1)).toEqual({ kind: "catalogue_prompt", domainId: CC_DOMAIN.id, domainVersion: 1, promptId: "q_work", question: "Could the work available have been mostly short contracts?" });
    expect(buildExploreProposal({ text: "x", promptId: "q_missing" }, h.r, CC_DOMAIN).basis.map((b) => b.kind)).toEqual(["pattern", "cross_context", "user_statement"]);
    expect(() => buildExploreProposal({ text: "   " }, h.r, CC_DOMAIN)).toThrow(/empty/);
    // the applied hypothesis stays proposed and not assessed, with no invented structure
    const p = await h.svc.create({ modelId: h.model.id, request: input.request, proposedBy: { kind: "person" }, rationale: input.rationale, basis: input.basis });
    expect(p.preview.ok).toBe(true);
    expect(p.preview.consequenceClass).toBe("ordinary");
    expect(p.preview.nothingElseChanges).toBe(true);
    await h.svc.review(p.id);
    const a = await h.svc.approve(p.id);
    expect(a.ok).toBe(true);
    const created = (a.ok ? a.model : h.model).hypotheses.find((x) => x.statement === "The work available was mostly short contracts.")!;
    expect(created).toMatchObject({ status: "proposed", confidence: null, subjectId: "p1", kind: "general", predictions: [], disconfirmingConditions: [], killCriteria: [], relationshipIds: [], supportingObservationIds: [], contradictingObservationIds: [], notes: "" });
  });

  it("the review card wording: subject, status proposed, confidence not assessed, pattern, Explore comparison, your words, the question; never proof or cause", async () => {
    const h = await harness();
    const input = buildExploreProposal({ text: "Mostly short contracts.", promptId: "q_work" }, h.r, CC_DOMAIN);
    const p = await h.svc.create({ modelId: h.model.id, request: input.request, proposedBy: { kind: "person" }, rationale: input.rationale, basis: input.basis });
    const w = describeProposal(p);
    expect(w.what).toEqual(["Create hypothesis “Mostly short contracts.”."]);
    expect(w.willChange[0].subject).toBe("Part one");
    expect(w.willChange[0].details).toEqual(["Status: proposed.", "Confidence: not assessed.", "No disconfirming condition stated yet."]);
    expect(w.basis.map((b) => b.text)).toEqual([
      "Pattern: income_stability was recorded at 5 u at 4 distinct times between Jan 2025 and Dec 2026. — recorded at 4 distinct times in the current records.",
      "Explore comparison: 4 occurrences compared with 3 times recorded at another value; 1 condition differed across the occurrences; 2 recorded the same at every occurrence; of those, 1 also true at every contrast time, 1 different at every contrast time, 0 mixed; 1 unresolved.",
      "You wrote: “Mostly short contracts.”",
      "Question that prompted the draft: “Could the work available have been mostly short contracts?”",
    ]);
    expect(w.basis.every((b) => b.resolved)).toBe(true);
    for (const t of [...w.basis.map((b) => b.text), ...w.what, w.why]) expect(t.toLowerCase()).not.toMatch(/\b(proof|proves|support(s|ed)?|confirm(s|ed)?|cause[sd]?|evidence for)\b/);
  });
});

describe("staleness: the basis is re-resolved, not a stored snapshot", () => {
  async function reviewedExploreProposal(h: Awaited<ReturnType<typeof harness>>, promptId?: string) {
    const input = buildExploreProposal({ text: "Mostly short contracts.", promptId }, h.r, CC_DOMAIN);
    const p = await h.svc.create({ modelId: h.model.id, request: input.request, proposedBy: { kind: "person" }, rationale: input.rationale, basis: input.basis });
    await h.svc.review(p.id);
    return p;
  }

  it("A. the pattern's recurrence changes (a new occurrence) -> stale; the hypothesis mutation is unchanged; approval unavailable until a fresh review", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h);
    const m = await stored(h);
    const y = m.variables.find((v) => v.id === "income_stability")!;
    await h.models.save(setEntries(m, "income_stability", [...y.values, ccEntry(5, CC_DATE("2026-08-01"))]));
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("stale");
    expect(r.preview.changes).toEqual(r.previousPreview?.changes); // identical mutation diff
    expect(r.preview.ok).toBe(true);
    const cmp = staleComparison(r)!;
    expect(cmp.changedSince.some((l) => l.startsWith("A cited record changed. It read: Pattern:"))).toBe(true);
    expect((await h.svc.approve(p.id)).ok).toBe(false);
    await h.svc.review(p.id);
    expect((await h.svc.approve(p.id)).ok).toBe(true);
  });

  it("B. THE ESSENTIAL CASE: the recurrence is unchanged, a contextual record changes and the Explore classification changes; the addHypothesis diff is identical -> the review fingerprint changes -> stale", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h);
    const before = resolveCrossContext(await stored(h), CC_PATTERN) as CrossContext;
    expect(before.groups.differentiatingComplete).toEqual(["buffer"]);
    // one contrast reading of "buffer" becomes 1.5: differentiating -> mixed. Y itself is untouched.
    const m = await stored(h);
    const b = m.variables.find((v) => v.id === "buffer")!;
    await h.models.save(setEntries(m, "buffer", b.values.map((e) => (e.valid.start === CC_C[1] ? { ...e, value: 1.5 } : e))));
    const after = resolveCrossContext(await stored(h), CC_PATTERN) as CrossContext;
    expect(after.groups.differentiatingComplete).toEqual([]);
    expect(after.groups.mixedComplete).toEqual(["buffer"]);
    expect(after.occurrences.map((s) => s.application.start)).toEqual(before.occurrences.map((s) => s.application.start)); // recurrence unchanged
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("stale");
    expect(r.preview.changes).toEqual(r.previousPreview?.changes); // the hypothesis mutation diff is identical
    expect(r.reviewFingerprint).not.toBe(p.reviewFingerprint);
    const cmp = staleComparison(r)!;
    expect(cmp.changedSince).toEqual([expect.stringMatching(/^A cited record changed\. It read: Explore comparison: .*1 different at every contrast time, 0 mixed.* It now reads: Explore comparison: .*0 different at every contrast time, 1 mixed/)]);
    expect((await h.svc.approve(p.id)).ok).toBe(false);
  });

  it("B''. a reading changes without changing the summary counts (a common value moves): stale, and the card names the condition that moved", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h);
    const m = await stored(h);
    const a = m.variables.find((v) => v.id === "autonomy_pref")!;
    await h.models.save(setEntries(m, "autonomy_pref", a.values.map((e) => ({ ...e, value: 0.9 }))));
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("stale");
    expect(describeProposal(r).basis[1].text).toBe(describeProposal(p).basis[1].text); // same counts, same words
    const cmp = staleComparison(r)!;
    expect(cmp.changedSince).toEqual(["The reading of “autonomy_pref” in the Explore comparison changed: it was common across occurrences at 0.8, contrasts same (complete coverage); it is now common across occurrences at 0.9, contrasts same (complete coverage)."]);
  });

  it("B3. a reading at ONE contrast time changes without touching any classification (health_cover, unresolved at the occurrences): stale, and the card names the time and the values", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h);
    const m = await stored(h);
    const hc = m.variables.find((v) => v.id === "health_cover")!;
    await h.models.save(setEntries(m, "health_cover", hc.values.map((e) => (e.valid.start === CC_C[0] ? { ...e, value: 2 } : e))));
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("stale");
    expect(staleComparison(r)!.changedSince).toEqual([`The reading of “health_cover” at ${CC_C[0]} (a contrast time) changed: it was 1 (asserted coverage); it is now 2 (asserted coverage).`]);
  });

  it("B'. an occurrence-window event or a contrast set change also expires the review; an out-of-scope subject's record does not", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h);
    // out of scope: part two's record changes -> harmless
    let m = await stored(h);
    const o = m.variables.find((v) => v.id === "other_subject")!;
    await h.models.save(setEntries(m, "other_subject", o.values.map((e) => ({ ...e, value: 2 }))));
    expect((await h.svc.revalidate(p.id)).status).toBe("reviewed");
    // in scope: an event near the July occurrence for part one -> stale
    m = await stored(h);
    await h.models.save(M.addEvent(m, { kind: "shock", type: "other", title: "Near the July occurrence", occurred: CC_DATE("2025-07-20"), recordedAt: "2025-07-21T00:00:00.000Z", sourceType: "observed", confidence: 0.8, subjectId: "p1" }));
    expect((await h.svc.revalidate(p.id)).status).toBe("stale");
  });

  it("C. an unrelated change (an observation about another subject) -> harmless revalidation; the review stands and approval succeeds", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h, "q_work");
    await h.models.save(M.updateObservation(await stored(h), "obs_unrelated", { statement: "Edited elsewhere" }));
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("reviewed");
    expect(r.reviewFingerprint).toBe(p.reviewFingerprint);
    expect(r.lastValidatedRevision).not.toBe(p.lastValidatedRevision);
    expect((await h.svc.approve(p.id)).ok).toBe(true);
  });

  it("D. the catalogue question is re-resolved: a reworded question under the model's domain version expires the review; a missing one is said to be missing with the reviewed wording kept", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h, "q_work");
    const fresh = resolveBasis(await stored(h), p.basis).at(-1)!;
    expect(fresh.content).toEqual({ question: "Could the work available have been mostly short contracts?", locus: "external_to_subject", hint: null });
    // the proposal's ref names domain version 1; version 2 rewords the question -> a different resolution
    const v2 = resolveBasis(await stored(h), [{ ...(p.basis.at(-1) as Extract<MutationProposal["basis"][number], { kind: "catalogue_prompt" }>), domainVersion: 2 }])[0];
    expect((v2.content as { question: string }).question).toBe("Was the available work mostly gig work?");
    expect(v2.content).not.toEqual(fresh.content);
    const gone = resolveBasis(await stored(h), [{ kind: "catalogue_prompt", domainId: CC_DOMAIN.id, domainVersion: 1, promptId: "q_gone", question: "As reviewed" }])[0];
    expect(gone.content).toBeNull();
    const w = describeProposal({ ...p, basis: [gone.ref], resolvedBasis: [gone] });
    expect(w.basis[0]).toEqual({ ref: gone.ref, text: "Question that prompted the draft is no longer in the catalogue (q_gone); it read: “As reviewed”", resolved: false });
  });

  it("the cross-context basis resolves to null (unresolved) when the pattern no longer resolves, and the card says so", async () => {
    const h = await harness();
    const p = await reviewedExploreProposal(h);
    const m = await stored(h);
    await h.models.save(M.assignVariableSubject(m, "income_stability", null)); // unassigned subject: the engine refuses
    const r = await h.svc.revalidate(p.id);
    expect(r.status).toBe("stale");
    expect(r.resolvedBasis[1].content).toBeNull();
    const w = describeProposal(r);
    expect(w.basis[1]).toMatchObject({ resolved: false, text: expect.stringMatching(/^Explore comparison \(the occurrence and contrast comparison shown in Explore\): it can no longer be resolved/) });
  });
});

describe("discoverability and draft reconciliation", () => {
  it("createdFromPattern: applied proposals with this exact pattern basis and an affected hypothesis id; merged with model-linked hypotheses without duplicates", async () => {
    const h = await harness();
    const input = buildExploreProposal({ text: "Mostly short contracts." }, h.r, CC_DOMAIN);
    const p = await h.svc.create({ modelId: h.model.id, request: input.request, proposedBy: { kind: "person" }, rationale: input.rationale, basis: input.basis });
    await h.svc.review(p.id);
    const a = await h.svc.approve(p.id);
    const model = a.ok ? a.model : h.model;
    const all = await h.svc.list(h.model.id);
    const created = createdFromPattern(all, CC_PATTERN, model.hypotheses);
    expect(created.map((c) => [c.hypothesis.statement, c.proposalId])).toEqual([["Mostly short contracts.", p.id]]);
    // a different interval is a different pattern; a pending proposal does not count
    expect(createdFromPattern(all, { ...CC_PATTERN, interval: { from: "2024-01-01", to: "2026-12-31" } }, model.hypotheses)).toEqual([]);
    const pending = await h.svc.create({ modelId: h.model.id, request: [{ kind: "addHypothesis", args: { statement: "Pending", subjectId: "p1" } }], proposedBy: { kind: "person" }, basis: input.basis });
    expect(createdFromPattern(await h.svc.list(h.model.id), CC_PATTERN, model.hypotheses).map((c) => c.proposalId)).toEqual([p.id]);
    void pending;
    const rows = mergeRelated([{ hypothesis: created[0].hypothesis, linkedVia: ["relationship"] }], created);
    expect(rows).toEqual([{ hypothesis: created[0].hypothesis, linkedVia: ["relationship"], createdFromThisPattern: true }]);
    expect(mergeRelated([], created)).toEqual([{ hypothesis: created[0].hypothesis, linkedVia: [], createdFromThisPattern: true }]);
  });

  it("reconcileDraft: open statuses keep the link, superseded follows the replacement, applied and rejected release the draft, missing unlinks", () => {
    const mk = (id: string, status: MutationProposal["status"], supersededBy: string | null = null) => ({ id, status, supersededBy }) as MutationProposal;
    const ledger = new Map([mk("a", "superseded", "b"), mk("b", "superseded", "c"), mk("c", "reviewed"), mk("d", "applied"), mk("e", "rejected"), mk("f", "failed"), mk("g", "superseded", "zz")].map((p) => [p.id, p]));
    const lookup = (id: string) => ledger.get(id) ?? null;
    expect(reconcileDraft("c", lookup)).toEqual({ action: "keep", proposalId: "c", status: "reviewed" });
    expect(reconcileDraft("f", lookup)).toEqual({ action: "keep", proposalId: "f", status: "failed" });
    expect(reconcileDraft("a", lookup)).toEqual({ action: "relink", proposalId: "c", status: "reviewed" });
    expect(reconcileDraft("d", lookup)).toEqual({ action: "remove", reason: "applied" });
    expect(reconcileDraft("e", lookup)).toEqual({ action: "remove", reason: "rejected" });
    expect(reconcileDraft("nope", lookup)).toEqual({ action: "unlink" });
    expect(reconcileDraft("g", lookup)).toEqual({ action: "keep", proposalId: "g", status: "superseded" }); // replacement missing: keep what we have
  });
});

describe("source pins: Explore can only propose", () => {
  const explore = readFileSync(path.join(process.cwd(), "src/app/explore/page.tsx"), "utf8");
  const helper = readFileSync(path.join(process.cwd(), "src/features/explore/proposal.ts"), "utf8");
  it("Explore and its helper import no mutation function, no ModelService, and call no apply / replaceModel / save path", () => {
    for (const src of [explore, helper]) {
      expect(src).not.toMatch(/@\/services\/mutations/);
      expect(src).not.toMatch(/@\/services\/model-service|from "@\/services"/);
      expect(src).not.toMatch(/\bapply\(|replaceModel|updateVariable|\.save\(|saveIfRevision/);
    }
    expect(explore).toMatch(/proposals\.create\(/);
    expect(explore).toMatch(/router\.push\(`\/proposals\?focus=/);
    expect(explore).toMatch(/INVESTIGATE_UNAVAILABLE_TEXT/);
  });
  it("the hypothesis discovery engine does not depend on the kernel", () => {
    const linked = readFileSync(path.join(process.cwd(), "src/discovery/linked-hypotheses.ts"), "utf8");
    expect(linked).not.toMatch(/@\/kernel|@\/features/);
  });
});
