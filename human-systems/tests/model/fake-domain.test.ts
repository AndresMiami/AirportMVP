/**
 * A second, minimal domain must work end to end WITHOUT touching engine
 * code: registration, blank system, derived values, per-member projection,
 * signature, migration attribution and evaluation all read the definition
 * through the engine-owned registry.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createBlankModel } from "@/model/blank";
import { domainRegistry, resolveVariable, type DomainDefinition } from "@/model/domain";
import { evaluateSystem } from "@/model/evaluate";
import { migrateModel } from "@/model/migrations";
import { compareScenario } from "@/scenarios/compare";
import { computeSignature } from "@/signatures/compute";
import * as M from "@/services/mutations";
import { SystemModelSchema, type SystemModel } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";

const NOW = "2026-09-14T12:00:00.000Z";

/** A tiny "workshop" domain: two inputs, one derived value, one projection. */
const WORKSHOP: DomainDefinition = {
  id: "workshop",
  version: 1,
  name: "Workshop (test)",
  description: "A fake domain used only to prove the engine is domain-agnostic.",
  systemTypes: ["organization"],
  variables: [
    { key: "orders_per_month", name: "Orders per month", description: "", unit: "orders", category: "event", changeSpeed: "fast", scope: "system", targetMode: "at_least" },
    { key: "hours_per_order", name: "Hours per order", description: "", unit: "h", category: "structure", changeSpeed: "slow", scope: "system", targetMode: "at_most" },
    { key: "skill_level", name: "Skill level", description: "", unit: "index", category: "asset", changeSpeed: "slow", scope: "member", targetMode: "at_least", referenceRange: { min: 0, max: 10 } },
  ],
  derived: [
    {
      key: "hours_per_month",
      name: "Hours per month",
      description: "orders × hours per order",
      unit: "h",
      category: "structure",
      changeSpeed: "fast",
      targetMode: "at_most",
      inputKeys: ["orders_per_month", "hours_per_order"],
      inputDerivedKeys: [],
      usesIncomeSources: false,
      assumptionIds: [],
      compute: (ctx) => {
        const o = ctx.value("orders_per_month");
        const h = ctx.value("hours_per_order");
        return o === null || h === null ? null : o * h;
      },
    },
  ],
  projections: [
    {
      id: "skill",
      label: "Skill level",
      unit: "index",
      assumptionIds: [],
      scope: "member",
      inputs: [{ key: "skill_level", scope: "member" }],
      compute: (values, months) => Array.from({ length: months + 1 }, (_, i) => (values.get("skill_level") ?? 0) + i * 0.1),
    },
  ],
  signatureDefinition: SignatureDefinitionSchema.parse({
    id: "workshop_v1",
    name: "Workshop signature",
    domain: "organization",
    version: 1,
    dimensions: [
      { id: "load", name: "Load", explanation: "Orders relative to a full book", inputs: [{ variableKey: "orders_per_month", transform: { kind: "ratio", strongAt: 40 }, question: "How many orders?" }] },
      { id: "craft", name: "Craft", explanation: "Skill of one member", subjectScope: "member", inputs: [{ variableKey: "skill_level", transform: { kind: "linear", min: 0, max: 10 }, question: "How skilled?" }] },
    ],
  }),
  constraintTemplates: [{ id: "max_hours", label: "Max hours", name: "Maximum hours", description: "", type: "hard", check: { dimension: "hours", comparator: "lte", limit: null } }],
  eventTypes: ["machine_broke", "other"],
};

function workshop(): SystemModel {
  let m = createBlankModel({ id: "shop", name: "Shop", systemType: "organization", now: NOW, domain: WORKSHOP });
  m = M.addMember(m, { id: "ana", label: "Ana", role: "Owner" });
  return m;
}

const input = (name: string, key: string, subjectId: string | null, currentValue: number | null) =>
  ({ name, key, subjectId, currentValue, category: "event" as const, changeSpeed: "fast" as const, unit: "u", sourceType: "self_reported" as const, confidence: 0.7 });

describe("a second minimal domain works without engine changes", () => {
  beforeEach(() => {
    domainRegistry.register(WORKSHOP);
  });

  it("a blank system records the domain id and version and evaluates against it", () => {
    const m = workshop();
    expect(m.domainDefinitionId).toBe("workshop");
    expect(m.domainDefinitionVersion).toBe(1);
    expect(SystemModelSchema.safeParse(m).success).toBe(true);
    const ev = evaluateSystem(m);
    expect(ev.domain.id).toBe("workshop");
    // The derived variable exists, unknown until both inputs are known.
    const derived = ev.variables.find((v) => v.key === "hours_per_month");
    expect(derived?.kind).toBe("derived");
    expect(derived?.currentValue).toBeNull();
  });

  it("derived values are computed from the fake formulas; unknown stays unknown", () => {
    let m = workshop();
    m = M.addVariable(m, input("Orders per month", "orders_per_month", "shop", 20));
    expect(evaluateSystem(m).variables.find((v) => v.key === "hours_per_month")!.currentValue).toBeNull();
    m = M.addVariable(m, input("Hours per order", "hours_per_order", "shop", 3));
    expect(evaluateSystem(m).variables.find((v) => v.key === "hours_per_month")!.currentValue).toBe(60);
    // Entering the derived key by hand is refused for this domain too.
    expect(() => M.addVariable(m, input("Hours per month", "hours_per_month", "shop", 1))).toThrow(/calculated variable/);
  });

  it("member-scope projections and signature dimensions resolve per member", () => {
    let m = workshop();
    m = M.addVariable(m, input("Skill level", "skill_level", "ana", 4));
    const ev = evaluateSystem(m);
    expect(resolveVariable(ev.variables, m.id, { key: "skill_level", subjectId: "ana" })?.currentValue).toBe(4);
    expect(resolveVariable(ev.variables, m.id, { key: "skill_level", subjectId: null })).toBeUndefined();

    const cmp = compareScenario(m, { id: "s", name: "s", description: "", changes: [], horizonMonths: 12 });
    expect(cmp.projections.map((p) => p.label)).toEqual(["Skill level — Ana"]);
    expect(cmp.projections[0].scenario[0]).toBe(4);

    const ana = computeSignature(ev, { id: "sig", now: NOW, mode: "current", subjectId: "ana" });
    expect(ana.subjectId).toBe("ana");
    expect(ana.dimensions.find((d) => d.dimensionId === "craft")!.normalizedValue).toBeCloseTo(0.4);
    // The system-scope dimension is unknown for a member subject, and vice versa.
    expect(ana.dimensions.find((d) => d.dimensionId === "load")!.state).toBe("unknown");
    const shop = computeSignature(ev, { id: "sig2", now: NOW, mode: "current" });
    expect(shop.dimensions.find((d) => d.dimensionId === "craft")!.state).toBe("unknown");
  });

  it("migration attributes only the fake domain's system-scope keys; member keys stay unassigned", () => {
    const systemScopeKeys = new Set(WORKSHOP.variables.filter((v) => v.scope === "system").map((v) => v.key));
    let m = workshop();
    m = M.addVariable(m, input("Orders per month", "orders_per_month", "shop", 20));
    m = M.addVariable(m, { ...input("Skill level", "skill_level", "ana", 4), id: "skill_level" });
    // Pretend the record predates attribution (v2 ids doubled as keys).
    const v2 = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
    v2.schemaVersion = 2;
    for (const v of v2.variables as Record<string, unknown>[]) {
      delete v.subjectId;
      delete v.key;
    }
    const r = migrateModel(v2, { systemScopeKeys });
    if (!r.ok) throw new Error(r.error);
    const byId = new Map(r.model.variables.map((v) => [v.id, v]));
    expect(byId.get("orders_per_month")!.subjectId).toBe("shop");
    expect(byId.get("hours_per_month")!.subjectId).toBe("shop");
    const skill = r.model.variables.find((v) => v.key === "skill_level")!;
    expect(skill.subjectId).toBeNull();
    expect(r.model.domainDefinitionId).toBe("workshop");
  });

  it("an unregistered domain is refused at evaluation with a plain message", () => {
    const m = { ...workshop(), domainDefinitionId: "not_registered" };
    expect(() => evaluateSystem(m)).toThrow(/not registered/);
  });
});
