/**
 * Schema v4 -> v5: the universal `incomeSources` field becomes a domain
 * collection. Twelve explicit fixtures, one per rule:
 *
 *  1. household v4, non-empty incomeSources   -> collections.incomeSources, origin "domain"
 *  2. household v4, empty incomeSources       -> declared, legitimately empty
 *  3. non-household v4, empty                 -> field dropped, no collection
 *  4. non-household v4, non-empty             -> preserved as legacy_universal, never evaluated
 *  5. unregistered domain, non-empty          -> same preservation, no interpretation
 *  6. event linked to an income source        -> collectionItemRefs, verbatim
 *  7. archived subject referenced by an item  -> reference survives, deletion still refused
 *  8. invalid collection item after migration -> loads, reported, withheld, never saved uncorrected
 *  9. failed migration                        -> repository byte-identical
 * 10. v5 export / import round trip
 * 11. v4 export imported into v5
 * 12. migration called twice does nothing on the second pass
 *
 * Dispatch is by `schemaVersion` only: a v5 record carrying an `incomeSources`
 * field is NOT re-migrated (the field is simply not part of the v5 schema).
 * Corrupt v4 inputs are covered by migration-v5-corrupt.test.ts.
 */
import { describe, expect, it } from "vitest";
import { foldCollectionsToV4 } from "../helpers/legacy-shapes";
import { createSampleHousehold } from "@/data/sample-household";
import { registerBuiltInDomains } from "@/domains";
import { INCOME_SOURCES } from "@/domains/household/income";
import { DERIVED_IDS } from "@/domains/household/keys";
import { createBlankModel } from "@/model/blank";
import { domainRegistry, type DomainDefinition } from "@/model/domain";
import { evaluateSystem } from "@/model/evaluate";
import { migrateModel, migrateV4toV5, migrationOptionsFor } from "@/model/migrations";
import { LocalStorageModelRepository, STORAGE_KEY, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { addIncomeSource, incomeSourcesOf } from "@/features/household/income";
import { MODEL_SCHEMA_VERSION, SystemModelSchema, type SystemModel } from "@/types";

type Raw = Record<string, unknown>;
const NOW = "2026-09-15T12:00:00.000Z";

/** A registered domain that declares NO collections. */
const LEDGER: DomainDefinition = {
  id: "ledger_test",
  version: 1,
  name: "Ledger (test)",
  description: "A registered domain without collections, used to prove non-household migration.",
  kinds: [{ id: "book", label: "Book" }],
  subjectLabel: "Account",
  variables: [{ key: "balance", name: "Balance", description: "", unit: "USD", category: "asset", changeSpeed: "fast", scope: "system", targetMode: "at_least" }],
  derived: [],
  projections: [],
  signatureDefinition: { id: "ledger_v1", version: 1, domainId: "ledger_test", name: "Ledger v1", maturity: "experimental", description: "", dimensions: [] },
  constraintTemplates: [],
  eventTypes: [],
};

registerBuiltInDomains();
domainRegistry.register(LEDGER);

class FakeStorage implements KeyValueStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** The sample household as the schema-v4 storage shape. */
function householdV4(): Raw {
  return foldCollectionsToV4(JSON.parse(JSON.stringify(createSampleHousehold())) as Raw);
}

/** A blank ledger system as a schema-v4 record carrying the universal field. */
function ledgerV4(incomeSources: Raw[]): Raw {
  const v5 = JSON.parse(JSON.stringify(createBlankModel({ id: "ledger1", name: "Ledger", systemType: "book", now: NOW, domain: LEDGER }))) as Raw;
  return foldCollectionsToV4({ ...v5, collections: { incomeSources: { items: incomeSources, origin: "domain" } } });
}

const SAMPLE_ITEMS = () => (householdV4().incomeSources as Raw[]).map((i) => ({ ...i }));

function migrate(raw: Raw): SystemModel {
  const r = migrateModel(raw, migrationOptionsFor(raw, { migratedAt: NOW }));
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

function omit(obj: Raw, keys: readonly string[]): Raw {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

/** Everything the v4 -> v5 step is allowed to touch, removed. */
function stripVolatile(m: Raw): Raw {
  return omit(m, ["collections", "incomeSources", "events", "schemaVersion"]);
}

describe("schema v5 migration: incomeSources -> collections", () => {
  it("MODEL_SCHEMA_VERSION is 6 (v5 introduced collections) and the schema has no universal incomeSources field", () => {
    expect(MODEL_SCHEMA_VERSION).toBe(6);
    expect(SystemModelSchema.safeParse(householdV4()).success).toBe(false);
    const v5 = createSampleHousehold();
    expect("incomeSources" in v5).toBe(false);
    expect(v5.collections.incomeSources?.origin).toBe("domain");
  });

  it("1. household v4 with non-empty incomeSources -> collections.incomeSources, items and ids preserved, evaluated", () => {
    const v4 = householdV4();
    const items = v4.incomeSources as Raw[];
    expect(items.length).toBeGreaterThan(0);
    const m = migrate(v4);
    expect(m.schemaVersion).toBe(6);
    expect("incomeSources" in m).toBe(false);
    expect(m.collections.incomeSources).toEqual({ items, origin: "domain" });
    expect(incomeSourcesOf(m).map((i) => i.id)).toEqual(items.map((i) => i.id));
    const ev = evaluateSystem(m, { now: NOW });
    expect(ev.variableById.get(DERIVED_IDS.totalIncome)!.currentValue).toBe(evaluateSystem(createSampleHousehold(), { now: NOW }).variableById.get(DERIVED_IDS.totalIncome)!.currentValue);
    expect(ev.issues.some((i) => /preserved record/.test(i.message))).toBe(false);
    // everything else is carried over untouched
    expect(stripVolatile(m as unknown as Raw)).toEqual(stripVolatile(v4));
  });

  it("2. household v4 with empty incomeSources -> declared, legitimately empty; income derived values are unknown, not zero", () => {
    const m = migrate({ ...householdV4(), incomeSources: [] });
    expect(m.collections.incomeSources).toEqual({ items: [], origin: "domain" });
    expect(incomeSourcesOf(m)).toEqual([]);
    const total = evaluateSystem(m, { now: NOW }).variableById.get(DERIVED_IDS.totalIncome)!;
    expect(total.currentValue).toBeNull();
    // and it is editable through the typed tools
    const added = addIncomeSource(m, { name: "Salary", monthlyAmount: 1000, reliability: 0.8, volatility: 0.1, correlationGroup: "employer", replacementLatencyMonths: 2, sourceType: "self_reported", confidence: 0.6, earnerId: "dani" });
    expect(incomeSourcesOf(added)).toHaveLength(1);
  });

  it("3. non-household registered domain, empty incomeSources -> field dropped, no collection created", () => {
    const v4 = ledgerV4([]);
    expect(v4.incomeSources).toEqual([]);
    const m = migrate(v4);
    expect(m.collections).toEqual({});
    expect("incomeSources" in m).toBe(false);
    expect(evaluateSystem(m, { now: NOW }).issues.filter((i) => /preserved/.test(i.message))).toEqual([]);
  });

  it("4. non-household registered domain, non-empty -> preserved as legacy_universal: not evaluated, not editable, exported as is, never invalid", () => {
    const items = SAMPLE_ITEMS();
    const m = migrate(ledgerV4(items));
    const env = m.collections.incomeSources!;
    expect(env.origin).toBe("legacy_universal");
    expect(env.items).toEqual(items);
    expect(env.note).toMatch(/does not declare it/);
    expect(SystemModelSchema.safeParse(m).success).toBe(true);
    expect(M.collectionProblems(m)).toBeNull();
    // never evaluated as household income: no such derived variable, only an info notice
    const ev = evaluateSystem(m, { now: NOW });
    expect(ev.variables.some((v) => v.id === DERIVED_IDS.totalIncome)).toBe(false);
    const notice = ev.issues.find((i) => /Collection "incomeSources"/.test(i.message));
    expect(notice?.level).toBe("info");
    expect(notice?.message).toMatch(/kept from an older format/);
    // not mutable through the typed collection tools
    expect(() => M.addCollectionItem(m, INCOME_SOURCES, { id: "x" })).toThrow(/not declared by the Ledger/);
    expect(() => M.updateCollectionItem(m, INCOME_SOURCES, items[0].id as string, { monthlyAmount: 1 })).toThrow(/not declared/);
    expect(() => M.removeCollectionItem(m, INCOME_SOURCES, items[0].id as string)).toThrow(/not declared/);
    expect(M.collectionItems(m, INCOME_SOURCES)).toEqual([]);
    expect(M.unresolvedCollections(m)).toEqual(["incomeSources"]);
    // other edits still work and keep the preserved records byte for byte
    const edited = M.updateProfile(m, { description: "edited" });
    expect(edited.collections.incomeSources).toEqual(env);
  });

  it("5. unregistered domain, non-empty -> preserved without interpretation; edits refused because the domain is unavailable", () => {
    const items = SAMPLE_ITEMS();
    const v4 = { ...ledgerV4(items), domainDefinitionId: "nobody_registered_this", domainDefinitionVersion: 1 };
    const m = migrate(v4);
    expect(m.collections.incomeSources).toMatchObject({ origin: "legacy_universal", items });
    expect(SystemModelSchema.safeParse(m).success).toBe(true);
    expect(M.collectionProblems(m)).toBeNull();
    expect(() => M.addCollectionItem(m, INCOME_SOURCES, { id: "x" })).toThrow(/not available/);
    expect(M.unresolvedCollections(m)).toEqual(["incomeSources"]);
    // an unregistered domain implies nothing for the migration
    expect(migrationOptionsFor(v4)).toEqual({});
    expect(migrationOptionsFor(v4, { migratedAt: NOW })).toEqual({ migratedAt: NOW });
  });

  it("6. an event linked to an income source -> a generic collection item ref, id verbatim, other links untouched", () => {
    const v4 = householdV4();
    const linked = (v4.events as Raw[]).filter((e) => ((e.links as Raw).incomeSourceIds as string[]).length > 0);
    expect(linked.length).toBeGreaterThan(0);
    const m = migrate(v4);
    for (const e of linked) {
      const after = m.events.find((x) => x.id === e.id)!;
      const { incomeSourceIds, ...otherLinks } = e.links as Raw;
      expect(after.links.collectionItemRefs).toEqual((incomeSourceIds as string[]).map((id) => ({ collection: "incomeSources", id })));
      expect({ ...after.links, collectionItemRefs: undefined }).toEqual({ ...otherLinks, collectionItemRefs: undefined });
      expect("incomeSourceIds" in after.links).toBe(false);
    }
    // events without such links get an empty ref list and nothing else changes
    const unlinked = (v4.events as Raw[]).filter((e) => ((e.links as Raw).incomeSourceIds as string[]).length === 0);
    for (const e of unlinked) {
      const after = m.events.find((x) => x.id === e.id)!;
      expect(after.links.collectionItemRefs).toEqual([]);
      expect(omit(after as unknown as Raw, ["links"])).toEqual(omit(e, ["links"]));
    }
    // the same shape holds when the domain does not own the collection: refs are preserved, not dropped
    const foreign = migrate({ ...ledgerV4(SAMPLE_ITEMS()), events: (v4.events as Raw[]).map((e) => ({ ...e, subjectId: undefined })) });
    expect(foreign.events.flatMap((e) => e.links.collectionItemRefs)).toEqual([{ collection: "incomeSources", id: "inc_warehouse" }]);
  });

  it("7. an archived subject referenced by an income source: the reference survives and blocks hard deletion; the item stays evaluable", () => {
    const v4 = householdV4();
    const members = (v4.profile as Raw).members as Raw[];
    const earner = (v4.incomeSources as Raw[])[0].earnerId as string;
    (v4.profile as Raw).members = members.map((mm) => (mm.id === earner ? { ...mm, status: "archived" } : mm));
    const m = migrate(v4);
    expect(m.profile.members.find((mm) => mm.id === earner)?.status).toBe("archived");
    expect(incomeSourcesOf(m)[0].earnerId).toBe(earner);
    const refs = M.memberReferences(m, earner);
    expect(refs.byCollection.incomeSources).toBeGreaterThan(0);
    expect(refs.unresolvedCollections).toEqual([]);
    expect(() => M.removeMember(m, earner)).toThrow(/incomeSources/);
    // an archived earner is still a valid subject for the item
    expect(M.collectionProblems(m)).toBeNull();
    expect(() => M.updateCollectionItem(m, INCOME_SOURCES, incomeSourcesOf(m)[0].id, { notes: "x" })).not.toThrow();
  });

  it("8. an invalid collection item after migration: the record loads (schema-valid), is reported and withheld from calculations, and cannot be saved until corrected", async () => {
    const v4 = householdV4();
    const items = v4.incomeSources as Raw[];
    items[0] = { ...items[0], monthlyAmount: "a lot" };
    const m = migrate(v4); // schema-valid: collection items are opaque to the storage schema
    expect(m.collections.incomeSources!.items[0]).toEqual(items[0]);
    expect(M.collectionProblems(m)).toMatch(/Invalid income sources? "inc_warehouse"/);
    const ev = evaluateSystem(m, { now: NOW });
    expect(ev.issues.some((i) => i.level === "warning" && /"inc_warehouse"/.test(i.message) && /withheld/.test(i.message))).toBe(true);
    expect(ev.variableById.get(DERIVED_IDS.totalIncome)!.currentValue).toBeNull();
    // the repository loads it and reports a clean migration; the service refuses to persist it uncorrected
    const svc = new ModelService(new MemoryModelRepository(), { now: () => NOW });
    await expect(svc.save(m)).rejects.toThrow(/Invalid income source/);
    expect(() => M.updateProfile(m, { description: "x" })).toThrow(/Invalid income source/);
    // correction through the typed tool repairs the record
    const fixed = M.updateCollectionItem(m, INCOME_SOURCES, "inc_warehouse", { monthlyAmount: 3000 });
    expect(M.collectionProblems(fixed)).toBeNull();
    await expect(svc.save(fixed)).resolves.toMatchObject({ id: fixed.id });
    // and removal is an equally valid correction
    expect(M.collectionProblems(M.removeCollectionItem(m, INCOME_SOURCES, "inc_warehouse"))).toBeNull();
  });

  it("9. a failed migration leaves the stored record byte-identical, keeps no backup and reports the error", async () => {
    const v4 = householdV4();
    (v4.relationships as Raw[])[0] = { ...(v4.relationships as Raw[])[0], strength: "strong" };
    const s = new FakeStorage();
    const before = JSON.stringify({ activeId: v4.id, models: { [v4.id as string]: v4 }, backups: {} });
    s.setItem(STORAGE_KEY, before);
    const repo = new LocalStorageModelRepository(s);
    expect(await repo.load(v4.id as string)).toBeNull();
    expect(repo.reports.get(v4.id as string)).toMatchObject({ ok: false, migratedFrom: null });
    expect((repo.reports.get(v4.id as string) as { error: string }).error).toMatch(/failed validation/);
    expect(s.getItem(STORAGE_KEY)).toBe(before);
    expect(await repo.backupsFor(v4.id as string)).toEqual({});
  });

  it("9b. a successful migration keeps an exact v4 backup and rewrites the v5 shape once", async () => {
    const v4 = householdV4();
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, JSON.stringify({ activeId: v4.id, models: { [v4.id as string]: v4 }, backups: {} }));
    const repo = new LocalStorageModelRepository(s);
    const loaded = await repo.load(v4.id as string);
    expect(loaded).toEqual(migrate(householdV4()));
    expect(repo.reports.get(v4.id as string)).toEqual({ id: v4.id, ok: true, migratedFrom: 4 });
    expect((await repo.backupsFor(v4.id as string))["4"]).toEqual(v4);
    const stored = JSON.parse(s.getItem(STORAGE_KEY)!) as { models: Record<string, Raw> };
    expect(stored.models[v4.id as string].schemaVersion).toBe(6);
    expect("incomeSources" in stored.models[v4.id as string]).toBe(false);
    const again = await repo.load(v4.id as string);
    expect(again).toEqual(loaded);
    expect(repo.reports.get(v4.id as string)).toEqual({ id: v4.id, ok: true, migratedFrom: null });
  });

  it("10. v5 export / import round-trips collections, refs and preserved legacy envelopes exactly", async () => {
    const svc = new ModelService(new MemoryModelRepository(), { now: () => NOW });
    const household = createSampleHousehold();
    await svc.save(household);
    const text = await svc.exportModel(household.id);
    const target = new ModelService(new MemoryModelRepository(), { now: () => NOW });
    const r = await target.importModel(text);
    if (!r.ok) throw new Error(r.error);
    expect(r.migratedFrom).toBeNull();
    expect(r.model.collections).toEqual(household.collections);
    expect(r.model.events.map((e) => e.links.collectionItemRefs)).toEqual(household.events.map((e) => e.links.collectionItemRefs));
    // a preserved legacy envelope survives export / import untouched
    const legacy = migrate(ledgerV4(SAMPLE_ITEMS()));
    await svc.save(legacy);
    const r2 = await target.importModel(await svc.exportModel(legacy.id));
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.model.collections).toEqual(legacy.collections);
    expect(r2.model.collections.incomeSources!.origin).toBe("legacy_universal");
  });

  it("11. a v4 export imported into a v5 build migrates by the record's own domain", async () => {
    const svc = new ModelService(new MemoryModelRepository(), { now: () => NOW });
    const v4 = householdV4();
    const file = JSON.stringify({ format: "human-systems-model", formatVersion: 1, exportedAt: NOW, schemaVersion: 4, model: v4 });
    const r = await svc.importModel(file);
    if (!r.ok) throw new Error(r.error);
    expect(r.migratedFrom).toBe(4);
    expect(r.model).toEqual(migrate(householdV4()));
    expect(r.model.collections.incomeSources!.origin).toBe("domain");
    const ledger = JSON.stringify({ format: "human-systems-model", formatVersion: 1, exportedAt: NOW, schemaVersion: 4, model: ledgerV4(SAMPLE_ITEMS()) });
    const r2 = await svc.importModel(ledger);
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.migratedFrom).toBe(4);
    expect(r2.model.collections.incomeSources!.origin).toBe("legacy_universal");
  });

  it("12. migration is idempotent: a second pass changes nothing, and dispatch is by schemaVersion alone", () => {
    const v4 = householdV4();
    const opts = migrationOptionsFor(v4);
    const once = migrateV4toV5(v4, opts);
    // The step itself has no defined transformation for its own output (a
    // v5 shape is not a v4 shape): it refuses rather than re-folding;
    // idempotence lives in migrateModel's dispatch by schemaVersion.
    expect(() => migrateV4toV5(once, opts)).toThrow(/must not carry a "collections" field/);
    const m = migrate(v4);
    const again = migrateModel(m, migrationOptionsFor(m, { migratedAt: "2027-01-01T00:00:00.000Z" }));
    if (!again.ok) throw new Error(again.error);
    expect(again.migratedFrom).toBeNull();
    expect(again.model).toEqual(m);
    // a v5 record is never re-migrated by field presence: a stray `incomeSources`
    // key is not a migration trigger (the v5 schema simply does not carry it)
    const stray = migrateModel({ ...JSON.parse(JSON.stringify(m)), incomeSources: [{ id: "ghost" }] }, migrationOptionsFor(m));
    if (!stray.ok) throw new Error(stray.error);
    expect(stray.migratedFrom).toBeNull();
    expect(stray.model.collections).toEqual(m.collections);
    // and older versions chain through: the sample folded to v4 came from v1 tests elsewhere;
    // here a v4 record with domainDefinitionId of the ledger runs exactly the v4 step
    const ledger = migrateModel(ledgerV4([]), migrationOptionsFor(ledgerV4([])));
    if (!ledger.ok) throw new Error(ledger.error);
    expect(ledger.migratedFrom).toBe(4);
  });
});
