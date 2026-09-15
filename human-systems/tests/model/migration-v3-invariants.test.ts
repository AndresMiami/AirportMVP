/**
 * MIGRATION 3a invariants. A migration creates NO new knowledge claim:
 *  - v2 -> v3 is idempotent (a migrated model passes through unchanged);
 *  - the repository keeps a backup equal to the pre-migration record;
 *  - a failed migration leaves the stored record byte-identical;
 *  - no feedback loop exists solely because of migration;
 *  - person-level variables come out UNASSIGNED, never household;
 *  - extension envelopes survive migration and reload.
 */
import { describe, expect, it } from "vitest";
import { registerBuiltInDomains } from "@/domains";
import { createSampleHousehold } from "@/data/sample-household";
import { HOUSEHOLD_VARIABLES } from "@/domains/household/variables";
import { evaluateSystem } from "@/model/evaluate";
import { migrateModel, migrateV2toV3 } from "@/model/migrations";
import { LocalStorageModelRepository, STORAGE_KEY, type KeyValueStorage } from "@/repositories/local-storage-repository";
import * as M from "@/services/mutations";
import { SystemModelSchema } from "@/types";

registerBuiltInDomains();

type Raw = Record<string, unknown>;
const SYSTEM_SCOPE_KEYS = new Set(HOUSEHOLD_VARIABLES.filter((v) => v.scope === "system").map((v) => v.key));
/** Keys the AUTHORED sample attributes to Dani (a person). */
const DANI_KEYS = new Set(createSampleHousehold().variables.filter((v) => v.subjectId === "dani").map((v) => v.key));

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

/** A v2-shaped raw record: the v3 sample with every 3a field removed. */
function buildV2(): Raw {
  const v3 = JSON.parse(JSON.stringify(createSampleHousehold())) as Raw;
  const strip = (rows: unknown, keys: string[]) =>
    (rows as Raw[]).map((row) => {
      const out = { ...row };
      for (const k of keys) delete out[k];
      return out;
    });
  const raw: Raw = {
    ...v3,
    schemaVersion: 2,
    signatureDefinitionId: "household_v1",
    variables: strip(v3.variables, ["key", "subjectId"]),
    relationships: strip(v3.relationships, ["kind", "participatesInDynamics", "hypothesisId"]),
    incomeSources: strip(v3.incomeSources, ["earnerId"]),
    constraints: strip(v3.constraints, ["subjectId"]),
    actions: strip(v3.actions, ["subjectId", "extensions"]),
    hypotheses: strip(v3.hypotheses, ["subjectId", "disconfirmingConditions", "predictions", "reviewLog", "killCriteria"]),
    signatures: strip(v3.signatures, ["subjectId"]),
  };
  delete raw.events;
  delete raw.domainDefinitionId;
  delete raw.domainDefinitionVersion;
  return raw;
}

function migrated() {
  const r = migrateModel(buildV2(), { systemScopeKeys: SYSTEM_SCOPE_KEYS });
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("buildV2 (fixture sanity)", () => {
  it("is refused by the v3 schema and carries no 3a field", () => {
    const v2 = buildV2();
    expect(SystemModelSchema.safeParse(v2).success).toBe(false);
    expect((v2.variables as Raw[]).every((v) => !("subjectId" in v) && !("key" in v))).toBe(true);
    expect((v2.relationships as Raw[]).every((r) => !("kind" in r))).toBe(true);
  });
});

describe("v2 -> v3 idempotence", () => {
  it("migrates once, then passes through unchanged with migratedFrom null", () => {
    const first = migrated();
    expect(first.migratedFrom).toBe(2);
    expect(first.model.schemaVersion).toBe(4);
    const again = migrateModel(first.model, { systemScopeKeys: SYSTEM_SCOPE_KEYS });
    if (!again.ok) throw new Error(again.error);
    expect(again.migratedFrom).toBeNull();
    expect(again.model).toEqual(first.model);
  });

  it("the v2->v3 step applied to an already-v3-shaped record changes nothing", () => {
    const once = migrateV2toV3(buildV2(), { systemScopeKeys: SYSTEM_SCOPE_KEYS });
    const twice = migrateV2toV3(once, { systemScopeKeys: SYSTEM_SCOPE_KEYS });
    expect(twice).toEqual(once);
  });

  it("does not mutate its input", () => {
    const v2 = buildV2();
    const snapshot = JSON.stringify(v2);
    migrateModel(v2, { systemScopeKeys: SYSTEM_SCOPE_KEYS });
    expect(JSON.stringify(v2)).toBe(snapshot);
  });
});

describe("no knowledge claim is created", () => {
  it("no relationship takes part in dynamics and no feedback loop exists after migration", () => {
    const { model } = migrated();
    expect(model.relationships.length).toBeGreaterThan(0);
    expect(model.relationships.every((r) => r.participatesInDynamics === false)).toBe(true);
    expect(model.relationships.every((r) => r.kind === "unclassified" || r.kind === "definitional")).toBe(true);
    // calculated edges are definitional (they restate a formula), everything else is unclassified
    for (const r of model.relationships) expect(r.kind).toBe(r.sourceType === "calculated" ? "definitional" : "unclassified");
    const ev = evaluateSystem(model);
    expect(ev.loops).toEqual([]);
    expect(ev.relationships).toEqual([]);
    expect(ev.unclassifiedRelationshipCount).toBe(model.relationships.filter((r) => r.kind === "unclassified").length);
    expect(ev.issues.some((i) => /unclassified/.test(i.message))).toBe(true);
    // The authored v3 sample opts its hypotheses in, so it DOES have loops: the difference is the opt-in, not the data.
    expect(evaluateSystem(createSampleHousehold()).loops.length).toBeGreaterThan(0);
  });

  it("person-level variables are UNASSIGNED, never attributed to the household", () => {
    const { model } = migrated();
    const systemId = model.id;
    for (const v of model.variables) {
      if (v.kind === "derived") expect(v.subjectId).toBe(systemId);
      else if (SYSTEM_SCOPE_KEYS.has(v.key)) expect(v.subjectId).toBe(systemId);
      else expect(v.subjectId).toBeNull();
    }
    // The sample authored these as Dani's; migration must not guess that.
    for (const key of DANI_KEYS) {
      const v = model.variables.find((x) => x.key === key);
      expect(v, key).toBeDefined();
      expect(v!.subjectId).toBeNull();
    }
    const ev = evaluateSystem(model);
    expect(ev.unassignedVariables.map((v) => v.key).sort()).toEqual([...DANI_KEYS].sort());
    expect(ev.issues.some((i) => /no subject assigned/.test(i.message))).toBe(true);
    // Keys default to the v2 id, so every formula still resolves.
    expect(model.variables.every((v) => v.key === v.id)).toBe(true);
  });

  it("income earners, constraint/action/hypothesis subjects are null; stored snapshots keep the system as subject", () => {
    const { model } = migrated();
    expect(model.incomeSources.every((s) => s.earnerId === null)).toBe(true);
    expect(model.constraints.every((c) => c.subjectId === null)).toBe(true);
    expect(model.actions.every((a) => a.subjectId === null && Object.keys(a.extensions).length === 0)).toBe(true);
    expect(model.hypotheses.every((h) => h.subjectId === null && h.reviewLog.length === 0 && h.killCriteria.length === 0)).toBe(true);
    expect(model.signatures.every((s) => s.subjectId === model.id)).toBe(true);
    expect(model.events).toEqual([]);
    expect(model.domainDefinitionId).toBe("household");
    expect(model.domainDefinitionVersion).toBe(1);
    expect("signatureDefinitionId" in model).toBe(false);
  });

  it("without a registered domain's system-scope keys, EVERY input variable stays unassigned", () => {
    const r = migrateModel(buildV2());
    if (!r.ok) throw new Error(r.error);
    expect(r.model.variables.filter((v) => v.kind !== "derived").every((v) => v.subjectId === null)).toBe(true);
  });
});

describe("repository: backup and failure discipline", () => {
  it("keeps a backup equal to the pre-migration record and rewrites the upgraded shape once", async () => {
    const v2 = buildV2();
    const id = v2.id as string;
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, JSON.stringify({ activeId: id, models: { [id]: v2 } }));
    const repo = new LocalStorageModelRepository(s);
    const loaded = await repo.load(id);
    expect(loaded?.schemaVersion).toBe(4);
    expect(repo.reports.get(id)).toEqual({ id, ok: true, migratedFrom: 2 });
    const backups = await repo.backupsFor(id);
    expect(backups["2"]).toEqual(v2);
    const stored = JSON.parse(s.getItem(STORAGE_KEY)!) as { models: Record<string, Raw>; backups: Record<string, Record<string, Raw>> };
    expect(stored.models[id].schemaVersion).toBe(4);
    expect(stored.backups[id]["2"]).toEqual(v2);
    // second load: no migration, backup untouched
    await repo.load(id);
    expect(repo.reports.get(id)).toEqual({ id, ok: true, migratedFrom: null });
    expect((await repo.backupsFor(id))["2"]).toEqual(v2);
    // deleting the model removes its backups too
    await repo.delete(id);
    expect(await repo.backupsFor(id)).toEqual({});
  });

  it("a migration that fails validation leaves the stored record byte-identical and reports the error", async () => {
    const v2 = buildV2();
    (v2.variables as Raw[])[0].category = "not_a_category";
    const id = v2.id as string;
    const s = new FakeStorage();
    const before = JSON.stringify({ activeId: id, models: { [id]: v2 } });
    s.setItem(STORAGE_KEY, before);
    const repo = new LocalStorageModelRepository(s);
    expect(await repo.load(id)).toBeNull();
    expect(repo.reports.get(id)).toMatchObject({ id, ok: false, migratedFrom: null });
    expect(typeof repo.reports.get(id)?.error).toBe("string");
    expect(s.getItem(STORAGE_KEY)).toBe(before);
    expect(await repo.backupsFor(id)).toEqual({});
  });

  it("an extension envelope on an action survives migration, save and reload", async () => {
    const v2 = buildV2();
    const id = v2.id as string;
    const envelope = { schemaVersion: 1, payload: { note: "opaque domain data", numbers: [1, 2, 3] } };
    (v2.actions as Raw[])[0].extensions = { some_future_domain: envelope };
    const r = migrateModel(v2, { systemScopeKeys: SYSTEM_SCOPE_KEYS });
    if (!r.ok) throw new Error(r.error);
    expect(r.model.actions[0].extensions.some_future_domain).toEqual(envelope);
    const s = new FakeStorage();
    const repo = new LocalStorageModelRepository(s);
    const withMore = M.setActionExtension(r.model, r.model.actions[0].id, "another", { schemaVersion: 2, payload: "x" });
    await repo.save(withMore);
    const back = await repo.load(id);
    expect(back!.actions[0].extensions).toEqual({ some_future_domain: envelope, another: { schemaVersion: 2, payload: "x" } });
    expect(() => M.setActionExtension(back!, back!.actions[0].id, "bad", { schemaVersion: 0, payload: null })).toThrow();
  });
});
