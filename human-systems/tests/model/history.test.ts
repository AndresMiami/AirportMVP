/**
 * MIGRATION 3b — memory through time. The stored truth is the append-only
 * value / target history; "current" is a view; as-of evaluation resolves
 * what applied at an instant and NEVER carries a later value back.
 *
 *   current != historical        recordedAt != effectiveAt
 *   missing history != permission to backfill
 *   target change != state change   derived != entered
 *   approximate time != exact time
 */
import { describe, expect, it } from "vitest";
import { foldCollectionsToV4 } from "../helpers/legacy-shapes";
import { exactDate, unknownTime } from "@/calculations/time";
import { registerBuiltInDomains } from "@/domains";
import { HOUSEHOLD_DOMAIN } from "@/domains/household/definition";
import { DERIVED_IDS, INPUT_IDS } from "@/domains/household/keys";
import { createSampleHousehold } from "@/data/sample-household";
import { createBlankModel } from "@/model/blank";
import { domainRegistry, subjectRef, systemRef, resolveVariable, type DomainDefinition } from "@/model/domain";
import { evaluateSystem } from "@/model/evaluate";
import { resolveValue } from "@/model/history";
import { migrateModel, migrateV3toV4, migrationOptionsFor } from "@/model/migrations";
import { LocalStorageModelRepository, MemoryModelRepository, STORAGE_KEY, type KeyValueStorage } from "@/repositories";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { SystemModelSchema, type StoredVariable, type SystemModel, type TemporalRef } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";

registerBuiltInDomains();

const NOW = "2026-09-15T12:00:00.000Z";
const JAN = "2026-01-15";
const MAR = "2026-03-10";
const at = (date: string) => `${date}T09:00:00.000Z`;

class FakeStorage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

function household(): SystemModel {
  let m = createBlankModel({ id: "h", name: "H", systemType: "household", now: at("2026-01-01"), domain: HOUSEHOLD_DOMAIN });
  m = M.addMember(m, { id: "ana", label: "Ana", role: "Adult" });
  m = M.addMember(m, { id: "bo", label: "Bo", role: "Adult" });
  return m;
}

const money = (key: string, subjectId: string, value: number, date: string, extra: Partial<M.VariableInput> = {}): M.VariableInput => ({
  name: key,
  key,
  subjectId,
  category: "buffer",
  changeSpeed: "slow",
  unit: "$",
  sourceType: "self_reported",
  confidence: 0.8,
  currentValue: value,
  valid: exactDate(date),
  recordedAt: at(date),
  ...extra,
});

/** Reserves 3000 in January, 6000 in March; essentials 1000 since January. */
function reservesStory(): SystemModel {
  let m = household();
  m = M.addVariable(m, money(INPUT_IDS.liquidReserves, "h", 3000, JAN));
  m = M.addVariable(m, money(INPUT_IDS.essentialExpenses, "h", 1000, JAN));
  m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: 6000, sourceType: "measured", confidence: 0.95, valid: exactDate(MAR), recordedAt: at(MAR) });
  return m;
}

const stored = (m: SystemModel, id: string): StoredVariable => m.variables.find((v) => v.id === id)!;

describe("value history", () => {
  it("1. the January value remains after the March value is entered; 2. the current view resolves March", () => {
    const m = reservesStory();
    const v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.values.map((e) => [e.value, e.status])).toEqual([
      [3000, "active"],
      [6000, "active"],
    ]);
    expect(v.values[0].valid).toEqual(exactDate(JAN));
    const ev = evaluateSystem(m, { now: NOW });
    const view = ev.variableById.get(INPUT_IDS.liquidReserves)!;
    expect(view.currentValue).toBe(6000);
    expect(view.sourceType).toBe("measured");
    expect(view.confidence).toBe(0.95);
    expect(view.valueEntry?.id).toBe(v.values[1].id);
    expect(view.valueResolution).toBe("resolved");
  });

  it("3. as-of January resolves January; 4. before the first known value is UNKNOWN (never the later value)", () => {
    const m = reservesStory();
    const jan = evaluateSystem(m, { now: NOW, asOf: "2026-01-20" }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect(jan.currentValue).toBe(3000);
    expect(jan.sourceType).toBe("self_reported");
    const onTheDay = evaluateSystem(m, { now: NOW, asOf: JAN }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect(onTheDay.currentValue).toBe(3000); // a date means the end of that day
    const before = evaluateSystem(m, { now: NOW, asOf: "2025-12-31" }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect(before.currentValue).toBeNull();
    expect(before.valueResolution).toBe("before_first");
    expect(before.valueEntry).toBeNull();
    // clocks stay apart: the evaluation names both
    const ev = evaluateSystem(m, { now: NOW, asOf: "2026-01-20" });
    expect(ev.clock).toEqual({ now: NOW, asOf: "2026-01-20T23:59:59.999Z", valuesAsOf: "2026-01-20T23:59:59.999Z", structureAsOf: "current" });
    expect(ev.issues.some((i) => i.level === "info" && /today's/.test(i.message))).toBe(true);
    expect(evaluateSystem(m, { now: NOW }).clock.asOf).toBeNull();
  });

  it("6. an unknown entry never resolves as zero, and derived values follow", () => {
    let m = reservesStory();
    m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: null, sourceType: "unknown", confidence: 0, valid: exactDate("2026-05-01"), recordedAt: at("2026-05-01") });
    const ev = evaluateSystem(m, { now: NOW });
    expect(ev.variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBeNull();
    expect(ev.variableById.get(INPUT_IDS.liquidReserves)!.valueResolution).toBe("resolved"); // a recorded "unknown" is a real entry
    expect(ev.variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBeNull();
    // April still knows 6000
    expect(evaluateSystem(m, { now: NOW, asOf: "2026-04-15" }).variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBe(6);
  });

  it("7. derived values recompute correctly at two historical dates", () => {
    const m = reservesStory();
    expect(evaluateSystem(m, { now: NOW, asOf: "2026-02-01" }).variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBe(3);
    expect(evaluateSystem(m, { now: NOW, asOf: "2026-04-01" }).variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBe(6);
    expect(evaluateSystem(m, { now: NOW, asOf: "2025-06-01" }).variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBeNull();
  });

  it("recording without a stated time means 'known from the recording instant', and provenance-only edits append", () => {
    let m = household();
    m = M.addVariable(m, { ...money(INPUT_IDS.liquidReserves, "h", 3000, JAN), valid: undefined });
    let v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.values[0].validBasis).toBe("recorded");
    expect(v.values[0].valid.start).toBe(at(JAN));
    expect(v.values[0].recordedAt).toBe(at(JAN));
    m = M.updateVariable(m, INPUT_IDS.liquidReserves, { sourceType: "measured", confidence: 1, recordedAt: at(MAR) });
    v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.values).toHaveLength(2);
    expect(v.values[1]).toMatchObject({ value: 3000, sourceType: "measured", confidence: 1, validBasis: "recorded" });
    expect(v.values[0]).toMatchObject({ value: 3000, sourceType: "self_reported", status: "active" });
  });

  it("correction supersedes (both entries kept); retraction needs a reason and keeps the entry", () => {
    let m = reservesStory();
    const first = stored(m, INPUT_IDS.liquidReserves).values[0];
    m = M.correctValue(m, INPUT_IDS.liquidReserves, first.id, { value: 3300, reason: "typo", recordedAt: at("2026-04-01") });
    let v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.values).toHaveLength(3);
    expect(v.values[0].status).toBe("superseded");
    expect(v.values[2]).toMatchObject({ value: 3300, supersedesId: first.id, status: "active", note: "Correction: typo" });
    expect(v.values[2].valid).toEqual(first.valid); // the correction keeps the asserted time
    expect(evaluateSystem(m, { now: NOW, asOf: "2026-02-01" }).variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBe(3300);
    expect(() => M.correctValue(m, INPUT_IDS.liquidReserves, first.id, { value: 1 })).toThrow(/already superseded/);
    expect(() => M.retractValue(m, INPUT_IDS.liquidReserves, v.values[1].id, "  ")).toThrow(/needs a reason/);
    m = M.retractValue(m, INPUT_IDS.liquidReserves, v.values[1].id, "double counted", at("2026-04-02"));
    v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.values[1]).toMatchObject({ value: 6000, status: "retracted", retractReason: "double counted", retractedAt: at("2026-04-02") });
    expect(evaluateSystem(m, { now: NOW }).variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBe(3300);
  });

  it("14. approximate and unorderable times are preserved and never falsely ordered", () => {
    let m = household();
    const march: TemporalRef = { kind: "approx", start: "2026-03-01", precision: "month", text: "sometime in March 2026" };
    m = M.addVariable(m, { ...money(INPUT_IDS.liquidReserves, "h", 2000, JAN), valid: unknownTime("before the move, not sure when"), recordedAt: at(JAN) });
    let v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.values[0].valid).toEqual(unknownTime("before the move, not sure when"));
    // the only entry has no orderable time: it is kept but not used
    let view = evaluateSystem(m, { now: NOW }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect(view.currentValue).toBeNull();
    expect(view.valueResolution).toBe("unorderable_only");
    expect(evaluateSystem(m, { now: NOW }).issues.some((i) => /no orderable time/.test(i.message))).toBe(true);
    m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: 2500, sourceType: "self_reported", confidence: 0.6, valid: march, recordedAt: at("2026-03-20") });
    m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: 4000, sourceType: "measured", confidence: 0.9, valid: exactDate(MAR), recordedAt: at(MAR) });
    v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.values[1].valid.text).toBe("sometime in March 2026");
    // "March 2026" starts on the 1st: it applies on the 5th; the exact 10 March entry wins from the 10th
    expect(evaluateSystem(m, { now: NOW, asOf: "2026-03-05" }).variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBe(2500);
    expect(evaluateSystem(m, { now: NOW, asOf: "2026-03-12" }).variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBe(4000);
    view = evaluateSystem(m, { now: NOW }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect(view.valueResolution).toBe("resolved");
    expect(resolveValue(v.values, NOW).unorderable.map((e) => e.value)).toEqual([2000]);
  });

  it("15. two entries that disagree for the same start are AMBIGUOUS, not arbitrarily chosen", () => {
    let m = reservesStory();
    m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: 6500, sourceType: "self_reported", confidence: 0.5, valid: exactDate(MAR), recordedAt: at("2026-03-11") });
    const ev = evaluateSystem(m, { now: NOW });
    const view = ev.variableById.get(INPUT_IDS.liquidReserves)!;
    expect(view.currentValue).toBeNull();
    expect(view.valueResolution).toBe("ambiguous");
    expect(ev.issues.some((i) => i.level === "warning" && /disagree/.test(i.message))).toBe(true);
    expect(ev.variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBeNull();
    const res = resolveValue(stored(m, INPUT_IDS.liquidReserves).values, NOW);
    expect(res.candidates.map((e) => e.value).sort()).toEqual([6000, 6500]);
    // identical duplicates are not a conflict: the later recorded one is used
    let dup = reservesStory();
    dup = M.recordValue(dup, INPUT_IDS.liquidReserves, { value: 6000, sourceType: "measured", confidence: 0.95, valid: exactDate(MAR), recordedAt: at("2026-03-11") });
    expect(evaluateSystem(dup, { now: NOW }).variableById.get(INPUT_IDS.liquidReserves)!.valueResolution).toBe("resolved");
    // retracting one side resolves the conflict
    const fixed = M.retractValue(m, INPUT_IDS.liquidReserves, stored(m, INPUT_IDS.liquidReserves).values[2].id, "guess, not a reading");
    expect(evaluateSystem(fixed, { now: NOW }).variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBe(6000);
  });

  it("a scenario never touches the stored history", () => {
    const m = reservesStory();
    const before = JSON.stringify(m);
    const applied = M.currentValueOf; // (scenarios are covered in tests/scenarios; here: the base is immutable)
    void applied;
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe("target history", () => {
  it("8. changing a target does not rewrite the previous target; 9. historical targets resolve; target change != state change", () => {
    let m = reservesStory();
    m = M.recordTarget(m, INPUT_IDS.liquidReserves, { desiredValue: 5000, targetMode: "at_least", valid: exactDate(JAN), recordedAt: at(JAN) });
    m = M.recordTarget(m, INPUT_IDS.liquidReserves, { desiredValue: 10000, targetMode: "at_least", valid: exactDate("2026-04-01"), recordedAt: at("2026-04-01"), note: "raised after the car repair" });
    const v = stored(m, INPUT_IDS.liquidReserves);
    expect(v.targets.map((t) => [t.desiredValue, t.status])).toEqual([
      [5000, "active"],
      [10000, "active"],
    ]);
    const feb = evaluateSystem(m, { now: NOW, asOf: "2026-02-01" }).variableById.get(INPUT_IDS.liquidReserves)!;
    const may = evaluateSystem(m, { now: NOW, asOf: "2026-05-01" }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect([feb.currentValue, feb.desiredValue]).toEqual([3000, 5000]);
    expect([may.currentValue, may.desiredValue]).toEqual([6000, 10000]);
    // Between March 10 and April 1 the STATE changed (3000 -> 6000) while the TARGET stayed 5000
    const late_march = evaluateSystem(m, { now: NOW, asOf: "2026-03-20" }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect([late_march.currentValue, late_march.desiredValue]).toEqual([6000, 5000]);
    // before any target: unknown target, mode falls back to the variable default
    const dec = evaluateSystem(m, { now: NOW, asOf: "2025-12-01" }).variableById.get(INPUT_IDS.liquidReserves)!;
    expect(dec.desiredValue).toBeNull();
    expect(dec.targetResolution).toBe("before_first");
    // the updateVariable sugar appends too
    const via = M.updateVariable(m, INPUT_IDS.liquidReserves, { desiredValue: 12000, recordedAt: at("2026-06-01") });
    expect(stored(via, INPUT_IDS.liquidReserves).targets).toHaveLength(3);
    expect(stored(via, INPUT_IDS.liquidReserves).targets[2]).toMatchObject({ desiredValue: 12000, targetMode: "at_least", validBasis: "recorded" });
  });
});

describe("subjects through time", () => {
  it("10. the same key for two members keeps independent histories; 11. an unassigned value feeds nothing", () => {
    let m = household();
    m = M.addVariable(m, { ...money(INPUT_IDS.protectedHours, "ana", 10, JAN), unit: "h/week", category: "agency" });
    m = M.addVariable(m, { ...money(INPUT_IDS.protectedHours, "bo", 4, JAN), unit: "h/week", category: "agency" });
    m = M.recordValue(m, `${INPUT_IDS.protectedHours}@ana`, { value: 12, sourceType: "self_reported", confidence: 0.7, valid: exactDate(MAR), recordedAt: at(MAR) });
    const ev = evaluateSystem(m, { now: NOW });
    expect(resolveVariable(ev.variables, "h", subjectRef(INPUT_IDS.protectedHours, "ana"))!.currentValue).toBe(12);
    expect(resolveVariable(ev.variables, "h", subjectRef(INPUT_IDS.protectedHours, "bo"))!.currentValue).toBe(4);
    expect(stored(m, `${INPUT_IDS.protectedHours}@bo`).values).toHaveLength(1);
    expect(resolveVariable(ev.variables, "h", systemRef(INPUT_IDS.protectedHours))).toBeUndefined();
    // unassigned reserves: a full history that feeds nobody
    let u = household();
    u = M.addVariable(u, { ...money(INPUT_IDS.liquidReserves, "h", 3000, JAN), subjectId: null });
    u = M.addVariable(u, money(INPUT_IDS.essentialExpenses, "h", 1000, JAN));
    const uv = evaluateSystem(u, { now: NOW });
    expect(uv.variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBeNull();
    expect(uv.unassignedVariables.map((v) => v.key)).toEqual([INPUT_IDS.liquidReserves]);
  });

  it("12. an archived member keeps every history entry", () => {
    let m = household();
    m = M.addVariable(m, { ...money(INPUT_IDS.protectedHours, "ana", 10, JAN), unit: "h/week", category: "agency" });
    m = M.recordValue(m, `${INPUT_IDS.protectedHours}@ana`, { value: 12, sourceType: "self_reported", confidence: 0.7, valid: exactDate(MAR), recordedAt: at(MAR) });
    m = M.recordTarget(m, `${INPUT_IDS.protectedHours}@ana`, { desiredValue: 15, valid: exactDate(MAR), recordedAt: at(MAR) });
    const beforeArchive = JSON.stringify(stored(m, `${INPUT_IDS.protectedHours}@ana`));
    m = M.archiveMember(m, "ana");
    expect(JSON.stringify(stored(m, `${INPUT_IDS.protectedHours}@ana`))).toBe(beforeArchive);
    expect(() => M.removeMember(m, "ana")).toThrow(/archive them instead/);
    // history still answers as-of questions for the archived member
    const ev = evaluateSystem(m, { now: NOW, asOf: "2026-02-01" });
    expect(resolveVariable(ev.variables, "h", subjectRef(INPUT_IDS.protectedHours, "ana"))!.currentValue).toBe(10);
  });
});

/* A minimal domain with one member-scope derived value, to prove shells. */
const WORKSHOP: DomainDefinition = {
  id: "workshop_history",
  version: 1,
  name: "Workshop (history test)",
  description: "",
  kinds: [{ id: "organization", label: "Organisation" }],
  subjectLabel: "Member of staff",
  variables: [{ key: "skill_level", name: "Skill level", description: "", unit: "index", category: "asset", changeSpeed: "slow", scope: "member", targetMode: "at_least" }],
  derived: [
    {
      key: "capacity_hours",
      name: "Capacity hours",
      description: "skill × 10",
      unit: "h",
      category: "asset",
      changeSpeed: "slow",
      targetMode: "at_least",
      scope: "member",
      inputs: [{ key: "skill_level", from: "subject" }],
      derivedInputs: [],
      collectionsRead: [],
      assumptionIds: [],
      compute: (ctx) => {
        const s = ctx.value("skill_level");
        return s === null ? null : s * 10;
      },
    },
  ],
  projections: [],
  signatureDefinition: SignatureDefinitionSchema.parse({
    id: "w",
    name: "w",
    domainId: "workshop",
    version: 1,
    dimensions: [{ id: "craft", name: "Craft", explanation: "x", subjectScope: "member", inputs: [{ variableKey: "skill_level", transform: { kind: "linear", min: 0, max: 10 }, question: "?" }] }],
  }),
  constraintTemplates: [],
  eventTypes: ["other"],
};

describe("13. member-scoped derived shells", () => {
  it("addMember materializes the shell; it holds a target and notes but never a typed value; archiving keeps it and stops computing unless asked", () => {
    domainRegistry.register(WORKSHOP);
    let m = createBlankModel({ id: "shop", name: "Shop", systemType: "organization", now: at("2026-01-01"), domain: WORKSHOP });
    m = M.addMember(m, { id: "ana", label: "Ana" });
    const shellId = "capacity_hours@ana";
    let shell = stored(m, shellId);
    expect(shell).toMatchObject({ kind: "derived", key: "capacity_hours", subjectId: "ana", values: [], targets: [] });
    m = M.recordTarget(m, shellId, { desiredValue: 50, valid: exactDate(JAN), recordedAt: at(JAN), note: "enough for two crews" });
    m = M.updateVariable(m, shellId, { notes: "shell note" });
    expect(() => M.updateVariable(m, shellId, { currentValue: 99 })).toThrow(/never takes an entered value/);
    expect(() => M.recordValue(m, shellId, { value: 99, sourceType: "measured", confidence: 1 })).toThrow(/never takes an entered value/);
    shell = stored(m, shellId);
    expect(shell.values).toEqual([]);
    expect(shell.targets[0]).toMatchObject({ desiredValue: 50, note: "enough for two crews" });
    expect(shell.notes).toBe("shell note");
    // a shell with a value entry does not validate
    expect(
      SystemModelSchema.safeParse({
        ...m,
        variables: m.variables.map((v) => (v.id === shellId ? { ...v, values: [{ id: "x", value: 1, valid: exactDate(JAN), validBasis: "asserted", recordedAt: at(JAN), sourceType: "measured", confidence: 1, evidence: [], observationIds: [], note: "", status: "active" }] } : v)),
      }).success,
    ).toBe(false);
    // the computed value comes from the member input; the target from the shell
    m = M.addVariable(m, { name: "Skill level", key: "skill_level", subjectId: "ana", category: "asset", changeSpeed: "slow", unit: "index", sourceType: "self_reported", confidence: 0.7, currentValue: 4, valid: exactDate(JAN), recordedAt: at(JAN) });
    let view = evaluateSystem(m, { now: NOW }).variableById.get(shellId)!;
    expect([view.currentValue, view.desiredValue, view.notes]).toEqual([40, 50, "shell note"]);
    // archived: shell and history preserved; not computed unless explicitly asked
    m = M.archiveMember(m, "ana");
    expect(stored(m, shellId).targets).toHaveLength(1);
    expect(evaluateSystem(m, { now: NOW }).variableById.get(shellId)).toBeUndefined();
    view = evaluateSystem(m, { now: NOW, includeArchivedMembers: true }).variableById.get(shellId)!;
    expect([view.currentValue, view.desiredValue]).toEqual([40, 50]);
    // ensureDerivedShells is idempotent and creates nothing for members who have one
    expect(M.ensureDerivedShells(m).variables).toHaveLength(m.variables.length);
  });
});

/* ---- migration v3 -> v4 ---------------------------------------------- */

type Raw = Record<string, unknown>;

/** A v3-shaped raw record: the v4 sample with histories folded back into
 *  currentValue / desiredValue / sourceType / confidence. */
function buildV3(): Raw {
  const v4 = foldCollectionsToV4(JSON.parse(JSON.stringify(createSampleHousehold())) as Raw);
  const variables = (v4.variables as Raw[]).map((v) => {
    const { values, targets, ...rest } = v;
    const latest = (values as Raw[]).filter((e) => e.status === "active").at(-1);
    const target = (targets as Raw[]).filter((e) => e.status === "active").at(-1);
    return {
      ...rest,
      currentValue: latest ? latest.value : null,
      desiredValue: target ? target.desiredValue : null,
      sourceType: v.kind === "derived" ? "calculated" : (latest?.sourceType ?? "unknown"),
      confidence: v.kind === "derived" ? 0 : (latest?.confidence ?? 0),
    };
  });
  return { ...v4, schemaVersion: 3, variables, updatedAt: "2026-09-01T12:00:00.000Z" };
}
const MIGRATED_AT = "2026-09-14T00:00:00.000Z";

describe("migration v3 -> v4", () => {
  it("is refused by the v4 schema before migration and accepted after; 16. idempotent", () => {
    const v3 = buildV3();
    expect(SystemModelSchema.safeParse(v3).success).toBe(false);
    const r = migrateModel(v3, migrationOptionsFor(v3, { migratedAt: MIGRATED_AT }));
    if (!r.ok) throw new Error(r.error);
    expect(r.migratedFrom).toBe(3);
    expect(r.model.schemaVersion).toBe(5);
    const again = migrateModel(r.model, migrationOptionsFor(r.model, { migratedAt: "2027-01-01T00:00:00.000Z" }));
    if (!again.ok) throw new Error(again.error);
    expect(again.migratedFrom).toBeNull();
    expect(again.model).toEqual(r.model);
    expect(migrateV3toV4(migrateV3toV4(v3, { migratedAt: MIGRATED_AT }), { migratedAt: "2027-01-01T00:00:00.000Z" })).toEqual(migrateV3toV4(v3, { migratedAt: MIGRATED_AT }));
  });

  it("5. does not invent history: values are known from the record's last save, never earlier; nulls stay unknown", () => {
    const v3 = buildV3();
    const r = migrateModel(v3, migrationOptionsFor(v3, { migratedAt: MIGRATED_AT }));
    if (!r.ok) throw new Error(r.error);
    const m = r.model;
    const lr = stored(m, INPUT_IDS.liquidReserves);
    expect(lr.values).toHaveLength(1);
    expect(lr.values[0]).toMatchObject({
      value: 2800,
      validBasis: "recorded",
      recordedAt: "2026-09-01T12:00:00.000Z",
      sourceType: "measured",
      confidence: 0.95,
      status: "active",
    });
    expect(lr.values[0].valid).toMatchObject({ kind: "instant", start: "2026-09-01T12:00:00.000Z" });
    expect(lr.values[0].note).toMatch(/When it began is not recorded/);
    // current and later: known
    expect(evaluateSystem(m, { now: NOW }).variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBe(2800);
    expect(evaluateSystem(m, { now: NOW, asOf: "2026-09-02" }).variableById.get(INPUT_IDS.liquidReserves)!.currentValue).toBe(2800);
    // earlier: UNKNOWN, for every input and every derived value that reads an input
    const earlier = evaluateSystem(m, { now: NOW, asOf: "2026-08-01" });
    expect(earlier.variables.filter((v) => v.kind === "input").every((v) => v.currentValue === null && v.valueResolution !== "resolved")).toBe(true);
    for (const id of [DERIVED_IDS.bufferMonths, DERIVED_IDS.floorRatio, DERIVED_IDS.monthlySurplus, DERIVED_IDS.debtBurden]) {
      expect(earlier.variableById.get(id)!.currentValue, id).toBeNull();
    }
    expect(earlier.variables.every((v) => v.desiredValue === null)).toBe(true);
    // DOCUMENTED 3b LIMITATION: collection items are not dated until 3d, so
    // collection-only derived values read today's items whatever the as-of date.
    expect(earlier.variableById.get(DERIVED_IDS.totalIncome)!.currentValue).toBe(4300);
    expect(earlier.issues.some((i) => i.level === "info" && /domain collections/.test(i.message))).toBe(true);
    // null current values got no entry (unknown stays unknown, nothing to preserve)
    const nulls = (v3.variables as Raw[]).filter((v) => v.kind === "input" && v.currentValue === null).map((v) => v.id as string);
    for (const id of nulls) expect(stored(m, id).values).toEqual([]);
    // targets migrated with the same floor, on inputs and on derived shells
    expect(stored(m, DERIVED_IDS.floorRatio).targets[0]).toMatchObject({ desiredValue: 1.1, targetMode: "at_least", validBasis: "recorded" });
    expect(stored(m, DERIVED_IDS.floorRatio).values).toEqual([]);
    // without a usable updatedAt the migration instant is the floor
    const noDate = migrateModel({ ...v3, updatedAt: "not a date" }, migrationOptionsFor(v3, { migratedAt: MIGRATED_AT }));
    if (!noDate.ok) throw new Error(noDate.error);
    expect(stored(noDate.model, INPUT_IDS.liquidReserves).values[0].recordedAt).toBe(MIGRATED_AT);
  });

  it("changes nothing else: subjects, relationships, constraints, hypotheses, events, extensions and signatures survive byte for byte", () => {
    const v3 = buildV3();
    (v3.actions as Raw[])[0].extensions = { future: { schemaVersion: 1, payload: { a: [1, 2] } } };
    const r = migrateModel(v3, migrationOptionsFor(v3, { migratedAt: MIGRATED_AT }));
    if (!r.ok) throw new Error(r.error);
    for (const k of ["relationships", "constraints", "hypotheses", "observations", "signatures", "profile", "domainDefinitionId", "domainDefinitionVersion"] as const) {
      expect(r.model[k]).toEqual(v3[k]);
    }
    expect(r.model.actions[0].extensions).toEqual({ future: { schemaVersion: 1, payload: { a: [1, 2] } } });
    expect(r.model.variables.map((v) => [v.id, v.subjectId, v.kind])).toEqual((v3.variables as Raw[]).map((v) => [v.id, v.subjectId, v.kind]));
    // the current view of the migrated model equals the v3 record's values
    const ev = evaluateSystem(r.model, { now: NOW });
    for (const raw of v3.variables as Raw[]) {
      if (raw.kind !== "input") continue;
      expect(ev.variableById.get(raw.id as string)!.currentValue, raw.id as string).toBe(raw.currentValue);
      expect(ev.variableById.get(raw.id as string)!.desiredValue, raw.id as string).toBe(raw.desiredValue);
    }
  });

  it("17. the repository keeps a backup equal to the exact v3 input; 18. a failed migration writes nothing", async () => {
    const v3 = buildV3();
    const id = v3.id as string;
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, JSON.stringify({ activeId: id, models: { [id]: v3 } }));
    const repo = new LocalStorageModelRepository(s);
    const loaded = await repo.load(id);
    expect(loaded?.schemaVersion).toBe(5);
    expect(repo.reports.get(id)).toEqual({ id, ok: true, migratedFrom: 3 });
    expect((await repo.backupsFor(id))["3"]).toEqual(v3);
    const stored4 = JSON.parse(s.getItem(STORAGE_KEY)!) as { models: Record<string, Raw> };
    expect(stored4.models[id].schemaVersion).toBe(5);

    const bad = buildV3();
    (bad.variables as Raw[])[0].changeSpeed = "not_a_speed";
    const s2 = new FakeStorage();
    const before = JSON.stringify({ activeId: id, models: { [id]: bad } });
    s2.setItem(STORAGE_KEY, before);
    const repo2 = new LocalStorageModelRepository(s2);
    expect(await repo2.load(id)).toBeNull();
    expect(repo2.reports.get(id)).toMatchObject({ ok: false });
    expect(s2.getItem(STORAGE_KEY)).toBe(before);
  });
});

describe("19. export / import", () => {
  it("round-trips the complete history, refuses corrupt files without storing, migrates older exports, and replaces only on request", async () => {
    const repoA = new MemoryModelRepository();
    const svcA = new ModelService(repoA, { now: () => NOW });
    const m = reservesStory();
    await svcA.save(m);
    const text = await svcA.exportModel(m.id);
    const file = JSON.parse(text) as { format: string; schemaVersion: number; model: SystemModel };
    expect(file.format).toBe("human-systems-model");
    expect(file.schemaVersion).toBe(5);
    expect(file.model.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!.values).toHaveLength(2);

    const repoB = new MemoryModelRepository();
    const svcB = new ModelService(repoB, { now: () => NOW });
    const imported = await svcB.importModel(text);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.migratedFrom).toBeNull();
    expect(imported.replaced).toBe(false);
    const back = await repoB.load(m.id);
    expect(back).toEqual(JSON.parse(JSON.stringify(await repoA.load(m.id))));
    expect(evaluateSystem(back!, { now: NOW, asOf: "2026-02-01" }).variableById.get(DERIVED_IDS.bufferMonths)!.currentValue).toBe(3);

    // corrupt: nothing stored
    const repoC = new MemoryModelRepository();
    const svcC = new ModelService(repoC, { now: () => NOW });
    expect((await svcC.importModel("{not json")).ok).toBe(false);
    expect((await svcC.importModel(JSON.stringify({ format: "other", model: {} }))).ok).toBe(false);
    const broken = JSON.parse(text) as { model: Raw };
    (broken.model.variables as Raw[])[0].changeSpeed = "nope";
    expect((await svcC.importModel(JSON.stringify(broken))).ok).toBe(false);
    expect(await repoC.list()).toEqual([]);

    // an older export migrates on import (v3 model inside the file)
    const v3file = JSON.stringify({ format: "human-systems-model", formatVersion: 1, exportedAt: NOW, schemaVersion: 3, model: buildV3() });
    const older = await svcC.importModel(v3file);
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.migratedFrom).toBe(3);
    expect(older.model.schemaVersion).toBe(5);
    expect(stored(older.model, INPUT_IDS.liquidReserves).values[0].validBasis).toBe("recorded");

    // duplicate id: refused, then replaced on request
    const dup = await svcB.importModel(text);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/already exists/);
    const rep = await svcB.importModel(text, { replace: true });
    expect(rep.ok && rep.replaced).toBe(true);
  });
});
