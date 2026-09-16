/**
 * Hypothesis confidence may be NOT ASSESSED. No code path manufactures a
 * 0.5 for a hypothesis any more; no other entity's confidence contract
 * changed; no calculation reads Hypothesis.confidence.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { householdServiceOptions } from "@/bootstrap/household-app";
import { createSampleHousehold } from "@/data/sample-household";
import { registerBuiltInDomains } from "@/domains";
import { MemoryProposalRepository, ProposalService, checkShape, dryRun, materialize } from "@/kernel";
import { evaluateSystem } from "@/model/evaluate";
import { loopIdFor } from "@/calculations/graph";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { AttractorDescriptionSchema, ConstraintSchema, EventSchema, HypothesisSchema, ObservationSchema, RelationshipSchema, ValueEntrySchema } from "@/types";

registerBuiltInDomains();
const NOW = "2026-09-16T12:00:00.000Z";

describe("addHypothesis", () => {
  it("with no confidence creates null (not assessed), never 0.5; explicit numbers and explicit null are kept", () => {
    const base = createSampleHousehold();
    const a = M.addHypothesis(base, { id: "h_none", statement: "No judgment yet" });
    expect(a.hypotheses.find((h) => h.id === "h_none")?.confidence).toBeNull();
    const b = M.addHypothesis(base, { id: "h_num", statement: "Judged", confidence: 0.7 });
    expect(b.hypotheses.find((h) => h.id === "h_num")?.confidence).toBe(0.7);
    const c = M.addHypothesis(base, { id: "h_null", statement: "Explicitly not assessed", confidence: null });
    expect(c.hypotheses.find((h) => h.id === "h_null")?.confidence).toBeNull();
    const d = M.addHypothesis(base, { id: "h_half", statement: "Deliberate half", confidence: 0.5 });
    expect(d.hypotheses.find((h) => h.id === "h_half")?.confidence).toBe(0.5);
    expect(() => M.addHypothesis(base, { id: "h_bad", statement: "Out of range", confidence: 1.5 })).toThrow();
  });

  it("updateHypothesis can clear a numeric confidence back to not assessed and set one again", () => {
    const base = createSampleHousehold();
    const cleared = M.updateHypothesis(base, "hyp_belt", { confidence: null });
    expect(cleared.hypotheses.find((h) => h.id === "hyp_belt")?.confidence).toBeNull();
    const set = M.updateHypothesis(cleared, "hyp_belt", { confidence: 0.7 });
    expect(set.hypotheses.find((h) => h.id === "hyp_belt")?.confidence).toBe(0.7);
  });

  it("ensureLoopHypothesis creates an unassessed loop hypothesis unless a confidence is explicitly supplied", () => {
    const base = { ...createSampleHousehold(), hypotheses: [] };
    const ev = evaluateSystem(base, { now: NOW });
    const loop = ev.loops[0];
    const id = loopIdFor(loop.variableIds);
    const a = M.ensureLoopHypothesis(base, { loopId: id, statement: "A loop reading", relationshipIds: [...loop.edgeIds] });
    expect(a.hypotheses.find((h) => h.loopId === id)?.confidence).toBeNull();
    const b = M.ensureLoopHypothesis(base, { loopId: id, statement: "A loop reading", relationshipIds: [...loop.edgeIds], confidence: 0.6 });
    expect(b.hypotheses.find((h) => h.loopId === id)?.confidence).toBe(0.6);
    expect(M.ensureLoopHypothesis(a, { loopId: id, statement: "again" })).toBe(a); // idempotent, no second hypothesis
  });
});

describe("schema: only the hypothesis contract relaxed", () => {
  it("HypothesisSchema accepts null and omitted confidence (-> null) and still refuses out-of-range numbers", () => {
    const min = { id: "h", statement: "s" };
    expect(HypothesisSchema.parse(min).confidence).toBeNull();
    expect(HypothesisSchema.parse({ ...min, confidence: null }).confidence).toBeNull();
    expect(HypothesisSchema.parse({ ...min, confidence: 0 }).confidence).toBe(0);
    expect(HypothesisSchema.safeParse({ ...min, confidence: 2 }).success).toBe(false);
    expect(HypothesisSchema.safeParse({ ...min, confidence: "0.5" }).success).toBe(false);
  });

  it("observations, relationships, events, constraints and value entries still REQUIRE a numeric confidence; the attractor default is untouched", () => {
    expect(ObservationSchema.safeParse({ id: "o", statement: "s", sourceType: "measured" }).success).toBe(false);
    expect(ObservationSchema.safeParse({ id: "o", statement: "s", sourceType: "measured", confidence: null }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ id: "r", sourceVariableId: "a", targetVariableId: "b", direction: "positive", strength: 0.5, lag: { value: 1, unit: "months" }, sourceType: "measured", kind: "causal_hypothesis" }).success).toBe(false);
    expect(EventSchema.safeParse({ id: "e", kind: "shock", type: "other", title: "t", occurred: { kind: "instant", start: "2026-01-01", precision: "date", text: "" }, recordedAt: NOW, sourceType: "measured" }).success).toBe(false);
    expect(ConstraintSchema.safeParse({ id: "c", name: "n", type: "soft", sourceType: "measured" }).success).toBe(false);
    expect(ValueEntrySchema.safeParse({ id: "v", value: 1, valid: { kind: "instant", start: "2026-01-01", precision: "date", text: "" }, validBasis: "asserted", recordedAt: NOW, sourceType: "measured" }).success).toBe(false);
    expect(AttractorDescriptionSchema.parse({}).confidence).toBe(0.5);
  });

  it("PIN: the schema file has exactly one nullable confidence (the hypothesis) and the same required ones as before", () => {
    const src = readFileSync(path.join(process.cwd(), "src/types/index.ts"), "utf8");
    expect((src.match(/confidence: unitInterval\.nullable\(\)\.default\(null\)/g) ?? []).length).toBe(1);
    expect((src.match(/confidence: unitInterval,/g) ?? []).length).toBe(6);
    expect((src.match(/confidence: unitInterval\.default\(0\.5\)/g) ?? []).length).toBe(1);
  });
});

describe("no calculation reads Hypothesis.confidence", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
    });
  }
  it("by source: the engine directories never touch a hypothesis confidence", () => {
    const offenders: string[] = [];
    for (const d of ["calculations", "model", "scenarios", "signatures", "discovery"]) {
      for (const f of walk(path.join(process.cwd(), "src", d))) {
        const src = readFileSync(f, "utf8");
        if (/hypothes\w*\.confidence|\bh\.confidence\b/.test(src)) offenders.push(path.relative(process.cwd(), f));
      }
    }
    expect(offenders).toEqual([]);
  });
  it("by evaluation: a hypothesis at null, at 0.5 and at 1 evaluates identically", () => {
    const base = createSampleHousehold();
    const at = (c: number | null) => evaluateSystem(M.updateHypothesis(base, "hyp_trap", { confidence: c }), { now: NOW });
    // the evaluation passes hypothesis RECORDS through (model, loop.hypothesis); everything computed must be identical
    const strip = (ev: ReturnType<typeof evaluateSystem>) => JSON.parse(JSON.stringify({ ...ev, model: undefined, loops: ev.loops.map((l) => ({ ...l, hypothesis: l.hypothesis ? { ...l.hypothesis, confidence: "stripped" } : undefined })) }));
    expect(strip(at(null))).toEqual(strip(at(0.5)));
    expect(strip(at(1))).toEqual(strip(at(0.5)));
  });
});

describe("no manufactured 0.5 for hypotheses anywhere in the tree", () => {
  it("the hypotheses form starts unassessed and the loop helper has no fallback", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/hypotheses/page.tsx"), "utf8");
    expect(page).toMatch(/confidence: initial\?\.confidence \?\? null/);
    expect(page).not.toMatch(/confidence: initial\?\.confidence \?\? 0\.5/);
    expect(page).not.toMatch(/type="range"/);
    expect(page).toMatch(/Not assessed/);
    const mutations = readFileSync(path.join(process.cwd(), "src/services/mutations.ts"), "utf8");
    expect(mutations).toMatch(/confidence: input\.confidence \?\? null/);
    expect(mutations).not.toMatch(/confidence: input\.confidence \?\? 0\.5/);
    const compose = readFileSync(path.join(process.cwd(), "src/components/proposal-compose.tsx"), "utf8");
    expect(compose).not.toMatch(/case "addHypothesis":\s*return \{[^}]*confidence: 0/);
  });
});

describe("proposal kernel: addHypothesis without confidence", () => {
  it("passes the shape check, materializes without inserting a confidence, previews 'Confidence: not assessed.' and dry-runs to null", async () => {
    const repo = new MemoryModelRepository();
    const models = new ModelService(repo, householdServiceOptions({ now: () => NOW }));
    const { model } = await models.loadActiveOrSeed();
    const request = [{ kind: "addHypothesis" as const, args: { statement: "Proposed without certainty" } }];
    expect(() => checkShape(request)).not.toThrow();
    const materialized = materialize(request, model, { now: () => NOW });
    expect("confidence" in (materialized[0].args as object)).toBe(false);
    const preview = dryRun(materialized, model);
    expect(preview.ok).toBe(true);
    expect(preview.semantic[0].details).toContain("Confidence: not assessed.");
    expect((preview.changes[0].after as { confidence: unknown }).confidence).toBeNull();
    const numeric = dryRun(materialize([{ kind: "addHypothesis", args: { statement: "Judged", confidence: 0.7 } }], model, { now: () => NOW }), model);
    expect(numeric.semantic[0].details).toContain("Confidence: 70%.");
    const explicitNull = dryRun(materialize([{ kind: "addHypothesis", args: { statement: "Null", confidence: null } }], model, { now: () => NOW }), model);
    expect(explicitNull.ok).toBe(true);
    expect(explicitNull.semantic[0].details).toContain("Confidence: not assessed.");
    // end to end through the service: the applied hypothesis is not assessed
    const svc = new ProposalService(new MemoryProposalRepository(), models, { now: () => NOW }, () => "prop_h");
    const p = await svc.create({ modelId: model.id, request, proposedBy: { kind: "person" } });
    await svc.review(p.id);
    const r = await svc.approve(p.id);
    expect(r.ok).toBe(true);
    expect(r.ok && r.model.hypotheses.find((h) => h.statement === "Proposed without certainty")?.confidence).toBeNull();
  });
});
