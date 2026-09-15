/**
 * A second, minimal domain must work end to end WITHOUT touching engine
 * code: registration, blank system, derived values, per-member projection,
 * signature, migration attribution and evaluation all read the definition
 * through the engine-owned registry.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createBlankModel } from "@/model/blank";
import { domainRegistry, resolveVariable, subjectRef, systemRef, variableIdFor, type DomainDefinition } from "@/model/domain";
import { evaluateSystem } from "@/model/evaluate";
import { migrateModel } from "@/model/migrations";
import { compareScenario } from "@/scenarios/compare";
import { computeSignature } from "@/signatures/compute";
import * as M from "@/services/mutations";
import { SystemModelSchema, type SystemModel } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";

const NOW = "2026-09-14T12:00:00.000Z";

/** A tiny "workshop" domain: three inputs, one system-scoped and two
 *  member-scoped derived values, one projection. */
const WORKSHOP: DomainDefinition = {
  id: "workshop",
  version: 1,
  name: "Workshop (test)",
  description: "A fake domain used only to prove the engine is domain-agnostic.",
  kinds: [{ id: "organization", label: "Organisation" }],
  subjectLabel: "Member of staff",
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
      scope: "system",
      inputs: [
        { key: "orders_per_month", from: "system" },
        { key: "hours_per_order", from: "system" },
      ],
      derivedInputs: [],
      usesIncomeSources: false,
      assumptionIds: [],
      compute: (ctx) => {
        const o = ctx.value("orders_per_month");
        const h = ctx.value("hours_per_order");
        return o === null || h === null ? null : o * h;
      },
    },
    {
      key: "capacity_hours",
      name: "Capacity hours",
      description: "skill level × 10, per member",
      unit: "h",
      category: "asset",
      changeSpeed: "slow",
      targetMode: "at_least",
      scope: "member",
      inputs: [{ key: "skill_level", from: "subject" }],
      derivedInputs: [],
      usesIncomeSources: false,
      assumptionIds: [],
      compute: (ctx) => {
        const s = ctx.value("skill_level");
        return s === null ? null : s * 10;
      },
    },
    {
      key: "load_share",
      name: "Load share",
      description: "this member's capacity relative to the workshop's hours per month (a member formula reading a SYSTEM derived value explicitly)",
      unit: "ratio",
      category: "structure",
      changeSpeed: "slow",
      targetMode: "at_most",
      scope: "member",
      inputs: [],
      derivedInputs: [
        { key: "hours_per_month", from: "system" },
        { key: "capacity_hours", from: "subject" },
      ],
      usesIncomeSources: false,
      assumptionIds: [],
      compute: (ctx) => {
        const total = ctx.derived("hours_per_month");
        const mine = ctx.derived("capacity_hours");
        return total === null || mine === null || total === 0 ? null : mine / total;
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
    domainId: "workshop",
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
    expect(resolveVariable(ev.variables, m.id, subjectRef("skill_level", "ana"))?.currentValue).toBe(4);
    expect(resolveVariable(ev.variables, m.id, systemRef("skill_level"))).toBeUndefined();

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

  it("member-scoped derived values are computed independently per member, never averaged", () => {
    let m = workshop();
    m = M.addMember(m, { id: "bo", label: "Bo", role: "Apprentice" });
    m = M.addMember(m, { id: "cy", label: "Cy", role: "Retired" });
    m = M.archiveMember(m, "cy");
    m = M.addVariable(m, input("Skill level", "skill_level", "ana", 4));
    m = M.addVariable(m, input("Skill level", "skill_level", "bo", 1));
    m = M.addVariable(m, input("Orders per month", "orders_per_month", "shop", 20));
    m = M.addVariable(m, input("Hours per order", "hours_per_order", "shop", 4));
    const ev = evaluateSystem(m);
    const capacity = ev.variables.filter((v) => v.key === "capacity_hours");
    // one record per ACTIVE member, attributed to that member, with its own id
    expect(capacity.map((v) => [v.subjectId, v.id, v.currentValue])).toEqual([
      ["ana", variableIdFor("capacity_hours", "ana", "shop"), 40],
      ["bo", variableIdFor("capacity_hours", "bo", "shop"), 10],
    ]);
    expect(capacity.every((v) => v.kind === "derived" && v.sourceType === "calculated")).toBe(true);
    // no system-level capacity exists: the engine did not sum or average the members
    expect(resolveVariable(ev.variables, m.id, systemRef("capacity_hours"))).toBeUndefined();
    // a member formula may read a SYSTEM derived value when it declares from: "system"
    expect(resolveVariable(ev.variables, m.id, subjectRef("load_share", "ana"))!.currentValue).toBeCloseTo(40 / 80);
    expect(resolveVariable(ev.variables, m.id, subjectRef("load_share", "bo"))!.currentValue).toBeCloseTo(10 / 80);
    // confidence follows the member's own inputs
    expect(resolveVariable(ev.variables, m.id, subjectRef("capacity_hours", "ana"))!.confidence).toBe(0.7);
    // the computations name their subject
    expect(ev.derived.filter((c) => c.definition.key === "load_share").map((c) => c.subjectId)).toEqual(["ana", "bo"]);
  });

  it("a member without the input gets an UNKNOWN member derived value, not a zero or a neighbour's number", () => {
    let m = workshop();
    m = M.addMember(m, { id: "bo", label: "Bo", role: "Apprentice" });
    m = M.addVariable(m, input("Skill level", "skill_level", "ana", 4));
    const ev = evaluateSystem(m);
    const bo = resolveVariable(ev.variables, m.id, subjectRef("capacity_hours", "bo"))!;
    expect(bo.currentValue).toBeNull();
    expect(bo.confidence).toBe(0);
    expect(ev.derived.find((c) => c.definition.key === "capacity_hours" && c.subjectId === "bo")!.missingInputs).toEqual(["skill_level"]);
    expect(resolveVariable(ev.variables, m.id, subjectRef("capacity_hours", "ana"))!.currentValue).toBe(40);
    // an UNASSIGNED skill level feeds nobody
    let u = workshop();
    u = M.addVariable(u, input("Skill level", "skill_level", null, 9));
    expect(resolveVariable(evaluateSystem(u).variables, u.id, subjectRef("capacity_hours", "ana"))!.currentValue).toBeNull();
  });

  it("a formula that reads an undeclared input is a definition bug and is refused loudly", () => {
    const broken: DomainDefinition = {
      ...WORKSHOP,
      id: "broken",
      derived: [{ ...WORKSHOP.derived[0], inputs: [{ key: "orders_per_month", from: "system" }] }],
    };
    domainRegistry.register(broken);
    let m = createBlankModel({ id: "b", name: "B", systemType: "organization", now: NOW, domain: broken });
    m = M.addVariable(m, input("Orders per month", "orders_per_month", "b", 20));
    expect(() => evaluateSystem(m)).toThrow(/undeclared input "hours_per_order"/);
  });

  it("an unregistered domain is refused at evaluation with a plain message", () => {
    const m = { ...workshop(), domainDefinitionId: "not_registered" };
    expect(() => evaluateSystem(m)).toThrow(/not registered/);
  });
});
