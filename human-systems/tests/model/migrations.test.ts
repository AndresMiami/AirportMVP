import { describe, expect, it } from "vitest";
import { foldCollectionsToV4 } from "../helpers/legacy-shapes";
import { lagToMonths } from "@/calculations/lag";
import { createSampleHousehold } from "@/data/sample-household";
import { migrateModel, migrationOptionsFor } from "@/model/migrations";
import { LocalStorageModelRepository, STORAGE_KEY, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { MODEL_SCHEMA_VERSION, SystemModelSchema, type SystemModel } from "@/types";

type Raw = Record<string, unknown>;

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

/** Months each sample relationship carried in the v1 shape (lagMonths). */
function v1LagMonths(): Record<string, number> {
  return Object.fromEntries(createSampleHousehold().relationships.map((r) => [r.id, lagToMonths(r.lag)]));
}

/** A v1-shaped raw object built by hand from the sample. */
function buildV1(): Raw {
  const v2 = foldCollectionsToV4(JSON.parse(JSON.stringify(createSampleHousehold())) as Raw);
  const lagMonths = v1LagMonths();
  const relationships = (v2.relationships as Raw[]).map((r) => {
    const { sourceVariableId, targetVariableId, lag: _lag, evidence: _e, notes: _n, enabled: _en, ...rest } = r;
    void _lag;
    void _e;
    void _n;
    void _en;
    return {
      ...rest,
      sourceVariable: sourceVariableId,
      targetVariable: targetVariableId,
      lagMonths: lagMonths[r.id as string],
    };
  });
  const constraints = (v2.constraints as Raw[]).map((c) => {
    const { type: _t, check, evidence: _e, userConfirmed: _u, softPenalty: _p, ...rest } = c;
    void _t;
    void _e;
    void _u;
    void _p;
    const chk = check as Raw | undefined;
    return chk ? { ...rest, dimension: chk.dimension, comparator: chk.comparator, limit: chk.limit } : rest;
  });
  const profile = v2.profile as Raw;
  const members = (profile.members as Raw[]).map((m) => {
    const { id: _id, ...rest } = m;
    void _id;
    return rest;
  });
  const raw: Raw = {
    ...v2,
    schemaVersion: 1,
    profile: { ...profile, members },
    relationships,
    constraints,
  };
  delete raw.observations;
  delete raw.hypotheses;
  delete raw.signatures;
  delete raw.domainDefinitionId;
  return raw;
}

describe("buildV1 (test fixture sanity)", () => {
  it("really is a v1 shape that the current schema refuses", () => {
    const v1 = buildV1();
    expect(v1.schemaVersion).toBe(1);
    expect((v1.relationships as Raw[])[0]).not.toHaveProperty("lag");
    expect((v1.relationships as Raw[])[0]).toHaveProperty("lagMonths");
    expect((v1.relationships as Raw[])[0]).toHaveProperty("sourceVariable");
    expect((v1.constraints as Raw[])[0]).not.toHaveProperty("type");
    expect((v1.constraints as Raw[])[0]).toHaveProperty("dimension");
    expect(((v1.profile as Raw).members as Raw[])[0]).not.toHaveProperty("id");
    expect(v1).not.toHaveProperty("observations");
    expect(SystemModelSchema.safeParse(v1).success).toBe(false);
  });
});


describe("migrateModel v1 -> v2 -> v3", () => {
  const v1 = buildV1();
  const result = migrateModel(v1, migrationOptionsFor(v1));

  it("reports ok with migratedFrom 1 and a schema-valid model", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.model.schemaVersion).toBe(5);
    expect(SystemModelSchema.safeParse(result.model).success).toBe(true);
    expect(result.model.id).toBe("sample_household_okafor_reyes");
  });

  it("rebuilds relationships: lag {value: lagMonths, unit: months}, enabled true, evidence [], notes ''", () => {
    if (!result.ok) throw new Error(result.error);
    const lagMonths = v1LagMonths();
    const sample = createSampleHousehold();
    expect(result.model.relationships).toHaveLength(sample.relationships.length);
    for (const r of result.model.relationships) {
      const original = sample.relationships.find((x) => x.id === r.id)!;
      expect(r.sourceVariableId, r.id).toBe(original.sourceVariableId);
      expect(r.targetVariableId, r.id).toBe(original.targetVariableId);
      expect(r.lag, r.id).toEqual({ value: lagMonths[r.id], unit: "months" });
      expect(r.enabled, r.id).toBe(true);
      expect(r.evidence, r.id).toEqual([]);
      expect(r.notes, r.id).toBe("");
      expect(r.direction, r.id).toBe(original.direction);
      expect(r.strength, r.id).toBe(original.strength);
      expect(r).not.toHaveProperty("sourceVariable");
      expect(r).not.toHaveProperty("lagMonths");
    }
    // Concrete values: r06 was 1 year, r04 two weeks, r07 immediate.
    const byId = Object.fromEntries(result.model.relationships.map((r) => [r.id, r]));
    expect(byId.r06.lag).toEqual({ value: 12, unit: "months" });
    expect(byId.r04.lag).toEqual({ value: 14 / 30.4375, unit: "months" });
    expect(byId.r07.lag).toEqual({ value: 0, unit: "months" });
  });

  it("rebuilds constraints as hard with the check populated and userConfirmed false", () => {
    if (!result.ok) throw new Error(result.error);
    const hours = result.model.constraints.find((c) => c.id === "c_hours")!;
    expect(hours.type).toBe("hard");
    expect(hours.check).toEqual({ dimension: "hoursPerWeek", comparator: "lte", limit: 8 });
    expect(hours.userConfirmed).toBe(false);
    expect(hours.evidence).toEqual([]);
    expect(hours.softPenalty).toBe(0.5);
    expect(hours).not.toHaveProperty("dimension");
    // The sample's soft constraint had no v1 type either: it comes back hard.
    const risk = result.model.constraints.find((c) => c.id === "c_risk")!;
    expect(risk.type).toBe("hard");
    expect(risk.check).toEqual({ dimension: "riskLevel", comparator: "lte", limit: 0.4 });
    // A boolean limit survives.
    expect(result.model.constraints.find((c) => c.id === "c_relocation")!.check).toEqual({
      dimension: "requiresRelocation",
      comparator: "eq",
      limit: false,
    });
    // A descriptive constraint (no dimension) gets no check.
    expect(result.model.constraints.find((c) => c.id === "c_pickup")!.check).toBeUndefined();
    expect(result.model.constraints.every((c) => c.type === "hard" && c.userConfirmed === false)).toBe(true);
  });

  it("assigns member ids in order and empties the new collections", () => {
    if (!result.ok) throw new Error(result.error);
    expect(result.model.profile.members.map((m) => m.id)).toEqual(["member_1", "member_2", "member_3"]);
    expect(result.model.profile.members.map((m) => m.label)).toEqual(["Dani", "Marisol", "Child"]);
    expect(result.model.observations).toEqual([]);
    expect(result.model.hypotheses).toEqual([]);
    expect(result.model.signatures).toEqual([]);
    expect(result.model.domainDefinitionId).toBe("household");
    // Everything untouched by the migration is carried over as is.
    expect(result.model.variables).toEqual(createSampleHousehold().variables);
    expect(result.model.collections.incomeSources).toEqual(createSampleHousehold().collections.incomeSources);
    expect(result.model.loopAnnotations).toEqual(createSampleHousehold().loopAnnotations);
  });

  it("does not mutate its input", () => {
    const fresh = buildV1();
    const before = JSON.stringify(fresh);
    migrateModel(fresh);
    expect(JSON.stringify(fresh)).toBe(before);
  });
});

describe("migrateModel on current and invalid input", () => {
  it("a current v2 model passes through with migratedFrom null", () => {
    const input = createSampleHousehold();
    const r = migrateModel(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBeNull();
    expect(r.model).toEqual(input);
    expect(MODEL_SCHEMA_VERSION).toBe(5);
  });

  it("a future version fails with a message naming both versions", () => {
    const r = migrateModel({ ...createSampleHousehold(), schemaVersion: 99 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("version 99");
    expect(r.error).toContain("up to 5");
  });

  it("non-objects and objects without schemaVersion fail", () => {
    for (const bad of [null, undefined, 42, "model", [1, 2]]) {
      const r = migrateModel(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("Stored model is not an object");
    }
    const noVersion = migrateModel({ id: "x", profile: {} });
    expect(noVersion.ok).toBe(false);
    if (!noVersion.ok) expect(noVersion.error).toBe("Stored model has no schemaVersion");
    const stringVersion = migrateModel({ ...createSampleHousehold(), schemaVersion: "2" });
    expect(stringVersion.ok).toBe(false);
    if (!stringVersion.ok) expect(stringVersion.error).toBe("Stored model has no schemaVersion");
  });

  it("a v1 object that fails validation after migration reports ok:false with an error string", () => {
    const v1 = buildV1();
    (v1.relationships as Raw[])[0] = { ...(v1.relationships as Raw[])[0], strength: 5 };
    const r = migrateModel(v1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(typeof r.error).toBe("string");
    expect(r.error).toMatch(/^Migrated model failed validation: /);
    expect(r.error.length).toBeGreaterThan("Migrated model failed validation: ".length);
  });
});

describe("LocalStorageModelRepository migrates on load and persists the upgraded shape once", () => {
  it("load(id) returns the migrated model, reports migratedFrom 1, rewrites storage, and then reports null", async () => {
    const v1 = buildV1();
    const id = v1.id as string;
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, JSON.stringify({ activeId: id, models: { [id]: v1 } }));
    const repo = new LocalStorageModelRepository(s);

    const loaded = await repo.load(id);
    expect(loaded).not.toBeNull();
    const expected = migrateModel(v1, migrationOptionsFor(v1));
    if (!expected.ok) throw new Error(expected.error);
    expect(loaded).toEqual(expected.model);
    expect(loaded!.schemaVersion).toBe(5);
    expect(loaded!.relationships.find((r) => r.id === "r06")!.lag).toEqual({ value: 12, unit: "months" });
    expect(repo.reports.get(id)).toEqual({ id, ok: true, migratedFrom: 1 });

    const stored = JSON.parse(s.getItem(STORAGE_KEY)!) as { activeId: string; models: Record<string, Raw> };
    expect(stored.activeId).toBe(id);
    expect(stored.models[id].schemaVersion).toBe(5);
    expect((stored.models[id].relationships as Raw[])[0]).toHaveProperty("lag");
    expect((stored.models[id].relationships as Raw[])[0]).not.toHaveProperty("lagMonths");
    expect(stored.models[id].observations).toEqual([]);
    expect(SystemModelSchema.safeParse(stored.models[id]).success).toBe(true);

    const again = await repo.load(id);
    expect(again).toEqual(loaded);
    expect(repo.reports.get(id)).toEqual({ id, ok: true, migratedFrom: null });
    expect(await repo.getActiveId()).toBe(id);
  });

  it("list() also migrates and a v1 record that cannot be upgraded is reported, not half-loaded", async () => {
    const good = buildV1();
    const bad = buildV1();
    bad.id = "broken";
    (bad.relationships as Raw[])[0] = { ...(bad.relationships as Raw[])[0], strength: 5 };
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, JSON.stringify({ activeId: null, models: { [good.id as string]: good, broken: bad } }));
    const repo = new LocalStorageModelRepository(s);
    const listed = await repo.list();
    expect(listed.map((m) => m.id)).toEqual([good.id]);
    expect(repo.reports.get("broken")?.ok).toBe(false);
    expect(repo.reports.get("broken")?.error).toMatch(/failed validation/);
    expect(await repo.load("broken")).toBeNull();
    // list() does not rewrite storage; the good record is still v1 until it is loaded.
    const stored = JSON.parse(s.getItem(STORAGE_KEY)!) as { models: Record<string, Raw> };
    expect(stored.models[good.id as string].schemaVersion).toBe(1);
    const loaded = (await repo.load(good.id as string)) as SystemModel;
    expect(loaded.schemaVersion).toBe(5);
    expect((JSON.parse(s.getItem(STORAGE_KEY)!) as { models: Record<string, Raw> }).models[good.id as string].schemaVersion).toBe(5);
  });
});
