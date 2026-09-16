/**
 * NEUTRAL-DOMAIN PROOF (Checkpoint 3): the generic engine, services and
 * prompt assembly do not require a household. A minimal neutral domain —
 * two system inputs, one subject input, one ratio, one signature
 * dimension, no collections, no categories, no evaluation dimensions, no
 * assumptions, no prompt fragment, no presentation — runs system creation
 * through the generic service, variables with histories, a derived value,
 * a relationship graph with loop detection, a signature, evaluation,
 * scenarios, export / import and prompt assembly.
 *
 * RUNTIME GUARD: every household module, the sample, the application
 * bootstrap and the household feature are mocked with a throwing factory.
 * If anything this test imports loaded one of them, the import itself
 * would fail; the last test proves the guard is armed.
 */
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "@/ai/prompt";
import { describeVariableHistory } from "@/discovery";
import { createBlankModel } from "@/model/blank";
import { categoryVocabulary, domainRegistry, evaluationDimensionKeys, resolveVariable, subjectLabelPluralOf, subjectRef, systemRef, type DomainDefinition } from "@/model/domain";
import { evaluateSystem } from "@/model/evaluate";
import { subjectsOf } from "@/model/subjects";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { compareScenario } from "@/scenarios/compare";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { computeSignature } from "@/signatures/compute";
import { SystemModelSchema, type SystemModel } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";

const HOUSEHOLD_MODULES = [
  "@/domains/household/definition",
  "@/domains/household/keys",
  "@/domains/household/derived",
  "@/domains/household/calculations",
  "@/domains/household/compounding",
  "@/domains/household/income",
  "@/domains/household/presentation",
  "@/domains/household/index",
  "@/domains/household",
  "@/domains/index",
  "@/domains",
  "@/data/sample-household",
  "@/bootstrap/household-app",
  "@/features/household/income",
] as const;
// vi.mock calls are hoisted above every import, so the factory helper must
// be hoisted too.
const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household/definition", armed("@/domains/household/definition"));
vi.mock("@/domains/household/keys", armed("@/domains/household/keys"));
vi.mock("@/domains/household/derived", armed("@/domains/household/derived"));
vi.mock("@/domains/household/calculations", armed("@/domains/household/calculations"));
vi.mock("@/domains/household/compounding", armed("@/domains/household/compounding"));
vi.mock("@/domains/household/income", armed("@/domains/household/income"));
vi.mock("@/domains/household/presentation", armed("@/domains/household/presentation"));
vi.mock("@/domains/household/index", armed("@/domains/household/index"));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains/index", armed("@/domains/index"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));
vi.mock("@/features/household/income", armed("@/features/household/income"));

const NOW = "2026-09-16T12:00:00.000Z";

const NEUTRAL: DomainDefinition = {
  id: "neutral_test",
  version: 1,
  name: "Neutral (test)",
  description: "Two inputs and a ratio. Nothing about people, money or households.",
  kinds: [{ id: "unit", label: "Unit" }],
  subjectLabel: "Part",
  variables: [
    { key: "input_a", name: "Input A", description: "", unit: "u", category: "structure", changeSpeed: "slow", scope: "system", targetMode: "at_least" },
    { key: "input_b", name: "Input B", description: "", unit: "u", category: "buffer", changeSpeed: "fast", scope: "system", targetMode: "at_most" },
    { key: "part_load", name: "Part load", description: "", unit: "u", category: "event", changeSpeed: "fast", scope: "member", targetMode: "at_most" },
  ],
  derived: [
    {
      key: "ratio",
      name: "Ratio",
      description: "input_a / input_b",
      unit: "ratio",
      category: "structure",
      changeSpeed: "slow",
      targetMode: "at_least",
      scope: "system",
      inputs: [
        { key: "input_a", from: "system" },
        { key: "input_b", from: "system" },
      ],
      derivedInputs: [],
      collectionsRead: [],
      assumptionIds: [],
      compute: (ctx) => {
        const a = ctx.value("input_a");
        const b = ctx.value("input_b");
        return a === null || b === null || b === 0 ? null : a / b;
      },
    },
  ],
  projections: [],
  signatureDefinition: SignatureDefinitionSchema.parse({
    id: "neutral_v1",
    name: "Neutral signature",
    domainId: "neutral_test",
    version: 1,
    dimensions: [{ id: "a_level", name: "A level", explanation: "Input A relative to 100", inputs: [{ variableKey: "input_a", transform: { kind: "ratio", strongAt: 100 }, question: "How much A?" }] }],
  }),
  constraintTemplates: [],
  eventTypes: ["other"],
};
domainRegistry.register(NEUTRAL);

const edge = { kind: "causal_hypothesis" as const, participatesInDynamics: true, strength: 0.5, lag: { value: 1, unit: "months" as const }, confidence: 0.6, sourceType: "self_reported" as const };

async function neutralSystem(): Promise<{ svc: ModelService; repo: MemoryModelRepository; model: SystemModel }> {
  const repo = new MemoryModelRepository();
  const svc = new ModelService(repo, { now: () => NOW, newId: () => "sys_neutral" });
  let m = await svc.createBlank({ name: "Neutral system", systemType: "unit", domainId: NEUTRAL.id, domainVersion: NEUTRAL.version });
  m = M.addMember(m, { id: "p1", label: "Part one", role: "" });
  m = M.addVariable(m, { id: "input_a", name: "Input A", key: "input_a", subjectId: m.id, category: "structure", changeSpeed: "slow", unit: "u", currentValue: 50, sourceType: "measured", confidence: 0.9 });
  m = M.addVariable(m, { id: "input_b", name: "Input B", key: "input_b", subjectId: m.id, category: "buffer", changeSpeed: "fast", unit: "u", currentValue: 25, sourceType: "estimated", confidence: 0.5 });
  m = M.addVariable(m, { id: "part_load_p1", name: "Part load", key: "part_load", subjectId: "p1", category: "event", changeSpeed: "fast", unit: "u", currentValue: 4, sourceType: "self_reported", confidence: 0.7 });
  m = M.addRelationship(m, { sourceVariableId: "input_a", targetVariableId: "input_b", direction: "positive", ...edge });
  m = M.addRelationship(m, { sourceVariableId: "input_b", targetVariableId: "input_a", direction: "negative", ...edge });
  m = await svc.save(m);
  return { svc, repo, model: m };
}

describe("neutral-domain proof: the engine does not require a household", () => {
  it("the generic service creates a system only under an EXPLICIT domain; the kind is a free label and never implies one", async () => {
    const svc = new ModelService(new MemoryModelRepository(), { now: () => NOW, newId: () => "sys_x" });
    const m = await svc.createBlank({ name: "N", systemType: "anything at all", domainId: NEUTRAL.id });
    expect(m.domainDefinitionId).toBe("neutral_test");
    expect(m.profile.systemType).toBe("anything at all");
    expect(m.collections).toEqual({});
    expect(m.variables.map((v) => v.key)).toEqual(["ratio"]); // the domain's system-scope derived shells only
    await expect(svc.createBlank({ name: "N", systemType: "unit", domainId: "" })).rejects.toThrow(/needs a domain id/);
    await expect(svc.createBlank({ name: "N", systemType: "household", domainId: "not_registered" })).rejects.toThrow(/not registered/);
  });

  it("an empty store with no seed configured is an error, never an invented system", async () => {
    const svc = new ModelService(new MemoryModelRepository(), { now: () => NOW });
    expect(svc.seedId).toBeNull();
    await expect(svc.loadActiveOrSeed()).rejects.toThrow(/no seed is configured/);
    await expect(svc.resetSeed()).rejects.toThrow(/No seed is configured/);
    // a stored system loads without any seed
    const { repo, model } = await neutralSystem();
    const svc2 = new ModelService(repo, { now: () => NOW });
    const loaded = await svc2.loadActiveOrSeed();
    expect(loaded.seeded).toBe(false);
    expect(loaded.model.id).toBe(model.id);
  });

  it("variables with histories, a derived value, subjects and as-of evaluation work with neutral names", async () => {
    const { model } = await neutralSystem();
    const ev = evaluateSystem(model, { now: NOW });
    expect(ev.domain.id).toBe("neutral_test");
    expect(resolveVariable(ev.variables, model.id, systemRef("ratio"))!.currentValue).toBe(2);
    expect(resolveVariable(ev.variables, model.id, subjectRef("part_load", "p1"))!.currentValue).toBe(4);
    expect(subjectsOf(model).map((s) => s.id)).toEqual(["p1"]);
    expect(subjectLabelPluralOf(NEUTRAL)).toBe("Parts");
    // a later value supersedes the current view; the earlier one stays known as of its date
    const later = M.recordValue(model, "input_a", { value: 75, sourceType: "measured", confidence: 0.9, recordedAt: "2026-09-20T00:00:00.000Z" });
    expect(resolveVariable(evaluateSystem(later, { now: "2026-09-21T00:00:00.000Z" }).variables, model.id, systemRef("ratio"))!.currentValue).toBe(3);
    expect(resolveVariable(evaluateSystem(later, { now: "2026-09-21T00:00:00.000Z", asOf: "2026-09-17" }).variables, model.id, systemRef("ratio"))!.currentValue).toBe(2);
    // unknown stays unknown: no input_b value -> ratio null, never 0
    const noB = M.retractValue(model, "input_b", model.variables.find((v) => v.id === "input_b")!.values[0].id, "test");
    expect(resolveVariable(evaluateSystem(noB, { now: NOW }).variables, model.id, systemRef("ratio"))!.currentValue).toBeNull();
  });

  it("no household vocabulary is required: no collections, no categories, no evaluation dimensions, no assumptions, no presentation, no prompt fragment", async () => {
    const { model } = await neutralSystem();
    const ev = evaluateSystem(model, { now: NOW });
    expect(NEUTRAL.collections).toBeUndefined();
    expect(categoryVocabulary(NEUTRAL)).toEqual(categoryVocabulary());
    expect(evaluationDimensionKeys(NEUTRAL)).toEqual([]);
    expect(NEUTRAL.assumptions).toBeUndefined();
    expect(NEUTRAL.presentation).toBeUndefined();
    expect(ev.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(ev.issues.some((i) => /collection/i.test(i.message))).toBe(false);
    // every derived value present belongs to this domain
    expect(ev.variables.filter((v) => v.kind === "derived").map((v) => v.key)).toEqual(["ratio"]);
  });

  it("relationship graph, loop detection, signature and scenarios work", async () => {
    const { model } = await neutralSystem();
    const ev = evaluateSystem(model, { now: NOW });
    expect(ev.loops).toHaveLength(1);
    expect(ev.loops[0].polarity).toBe("balancing");
    const sig = computeSignature(ev, { id: "sig1", now: NOW, mode: "current" });
    expect(sig.dimensions.map((d) => d.dimensionId)).toEqual(["a_level"]);
    expect(sig.dimensions[0].normalizedValue).toBeCloseTo(0.5, 5);
    const cmp = compareScenario(model, { id: "s", name: "s", description: "", changes: [{ kind: "adjustVariable", variableId: "input_a", delta: 50 }], horizonMonths: 12 });
    expect(cmp.applied.rejected).toEqual([]);
    expect(cmp.variableDeltas.find((d) => d.variableId === "ratio")?.delta).toBe(2);
    // a collection scenario op is refused, not silently applied: the domain declares none
    const refused = compareScenario(model, { id: "s2", name: "s2", description: "", changes: [{ kind: "addCollectionItem", collection: "incomeSources", item: { id: "x" } }], horizonMonths: 12 });
    expect(refused.applied.rejected).toHaveLength(1);
    expect(refused.applied.rejected[0].reason).toMatch(/not declared/);
  });

  it("export / import round-trips the neutral system through the generic service without any seed", async () => {
    const { svc, model } = await neutralSystem();
    const text = await svc.exportModel(model.id);
    const target = new ModelService(new MemoryModelRepository(), { now: () => NOW });
    const r = await target.importModel(text);
    if (!r.ok) throw new Error(r.error);
    expect(r.migratedFrom).toBeNull();
    expect(r.model).toEqual(model);
    expect(SystemModelSchema.safeParse(r.model).success).toBe(true);
    expect(evaluateSystem(r.model, { now: NOW }).domain.id).toBe("neutral_test");
  });

  it("prompt assembly needs no domain fragment: the constitution plus the generic categories, and only the neutral vocabulary when given", () => {
    const generic = buildSystemPrompt(NEUTRAL, categoryVocabulary(NEUTRAL));
    expect(generic).toBe(buildSystemPrompt(undefined, categoryVocabulary()));
    const withFragment = buildSystemPrompt({ ...NEUTRAL, promptFragment: { vocabulary: "inputs and a ratio", questions: ["What limits input B?"] } }, categoryVocabulary(NEUTRAL));
    expect(withFragment).toContain("Domain vocabulary (Neutral (test)): inputs and a ratio");
    expect(withFragment).toContain("What limits input B?");
    expect(withFragment.startsWith(generic.split("\n")[0])).toBe(true);
  });

  it("blank models and the getting-started data need no household: a domain without collections yields no collection step", async () => {
    // setupSteps lives in a component module (next/link), so its logic is
    // mirrored here from the same domain metadata the component reads.
    const m = createBlankModel({ id: "b", name: "B", systemType: "unit", now: NOW, domain: NEUTRAL });
    const collectionSteps = (NEUTRAL.collections ?? []).filter((c) => c.onboarding && c.route);
    expect(collectionSteps).toEqual([]);
    expect(Object.keys(m.collections)).toEqual([]);
    const links = (NEUTRAL.collections ?? []).filter((c) => c.route).map((c) => c.route);
    expect(links).toEqual([]); // no Income link for a neutral domain
  });

  it("the discovery layer describes a neutral variable's history with no household dependency", async () => {
    const { model } = await neutralSystem();
    const later = M.recordValue(model, "input_a", { value: 50, sourceType: "measured", confidence: 0.9, valid: { kind: "date", start: "2026-11-01", precision: "day", text: "2026-11-01" } });
    const stored = later.variables.find((v) => v.id === "input_a")!;
    const d = describeVariableHistory(stored, { from: "2026-01-01", to: "2026-12-31" });
    expect(d.facts.exactRepetition).toBe(true);
    expect(d.repeatedValues[0].value).toBe(50);
    expect(d.facts.recurrenceReliesOnRecordedBasis).toBe(true); // the first entry was recorded, not asserted
    expect(d.summaryClass).toBe("repeated");
    expect(() => describeVariableHistory(later.variables.find((v) => v.key === "ratio")!, { from: "2026-01-01", to: "2026-12-31" })).toThrow(/input variables only/);
  });

  it("the runtime guard is armed: importing any household module in this file fails, importing an engine module does not", async () => {
    // vitest wraps a throwing mock factory in its own error message, so the
    // proof is the rejection itself (plus the cause when vitest exposes it).
    for (const name of HOUSEHOLD_MODULES) {
      let failed = false;
      try {
        await import(/* @vite-ignore */ name);
      } catch (e) {
        failed = true;
        const msg = e instanceof Error ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ""}` : String(e);
        expect(msg, name).toMatch(/household module loaded at runtime|error when mocking a module/);
      }
      expect(failed, `${name} must not load`).toBe(true);
    }
    await expect(import("@/model/blank")).resolves.toHaveProperty("createBlankModel");
  });
});
