/**
 * Schema v5 -> v6: hypothesis confidence may be NOT ASSESSED (null).
 *
 *   unknown confidence != 50% confidence
 *
 * v6 RELAXES a field, so the step must first enforce the v5 contract on
 * every hypothesis it meets: previously corrupt v5 data (missing, null,
 * string, out-of-range confidence) is refused, never laundered into a
 * valid v6 "not assessed". Valid v5 knowledge is preserved exactly — an
 * existing 0.5 stays 0.5, because nobody can tell a deliberate 0.5 from
 * the old form's default. Same refusal discipline as v4 -> v5: nothing
 * stored, no backup, the original byte-identical, the importer writes
 * nothing.
 */
import { describe, expect, it } from "vitest";
import { householdServiceOptions } from "@/bootstrap/household-app";
import { createSampleHousehold } from "@/data/sample-household";
import { registerBuiltInDomains } from "@/domains";
import { MemoryProposalRepository, ProposalService, revisionOf } from "@/kernel";
import { migrateModel, migrateV5toV6, migrationOptionsFor, MigrationStepError } from "@/model/migrations";
import { LocalStorageModelRepository, STORAGE_KEY, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { MODEL_SCHEMA_VERSION, SystemModelSchema, type SystemModel } from "@/types";

type Raw = Record<string, unknown>;
const NOW = "2026-09-16T12:00:00.000Z";
registerBuiltInDomains();

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

/** A valid v5 record: the sample (v6, every hypothesis numeric) with schemaVersion 5. */
function householdV5(): Raw {
  const raw = JSON.parse(JSON.stringify(createSampleHousehold())) as Raw;
  return { ...raw, schemaVersion: 5 };
}
const hyps = (raw: Raw) => raw.hypotheses as Raw[];
const withConfidence = (raw: Raw, index: number, confidence: unknown): Raw => ({ ...raw, hypotheses: hyps(raw).map((h, i) => (i === index ? { ...h, confidence } : h)) });
const withoutConfidence = (raw: Raw, index: number): Raw => ({
  ...raw,
  hypotheses: hyps(raw).map((h, i) => {
    if (i !== index) return h;
    const { confidence: _c, ...rest } = h;
    void _c;
    return rest;
  }),
});

describe("v5 -> v6 preserves valid v5 knowledge exactly", () => {
  it("MODEL_SCHEMA_VERSION is 6; the sample carries 0.55 / 0.7 / 0.5 / 0.35 and every value survives byte for byte", () => {
    expect(MODEL_SCHEMA_VERSION).toBe(6);
    const v5 = householdV5();
    expect(hyps(v5).map((h) => h.confidence)).toEqual([0.55, 0.7, 0.5, 0.35]);
    const v6 = migrateV5toV6(v5);
    expect(v6.schemaVersion).toBe(6);
    expect(hyps(v6).map((h) => h.confidence)).toEqual([0.55, 0.7, 0.5, 0.35]);
    const { schemaVersion: _a, ...restV5 } = v5;
    const { schemaVersion: _b, ...restV6 } = v6;
    void _a;
    void _b;
    expect(restV6).toEqual(restV5); // nothing but the version changes
  });

  it("an existing 0.5 stays 0.5 (never null); 0 stays 0; 1 stays 1", () => {
    const v5 = withConfidence(withConfidence(householdV5(), 0, 0), 1, 1);
    const r = migrateModel(v5, migrationOptionsFor(v5));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.migratedFrom).toBe(5);
    expect(r.model.hypotheses.map((h) => h.confidence)).toEqual([0, 1, 0.5, 0.35]);
    expect(r.model.hypotheses.some((h) => h.confidence === null)).toBe(false);
  });

  it("absent hypotheses (v5 default []) migrate to []; the step is idempotent and dispatch is by schemaVersion alone", () => {
    const { hypotheses: _h, ...noHyps } = householdV5();
    void _h;
    expect(migrateV5toV6(noHyps).hypotheses).toEqual([]);
    const once = migrateModel(householdV5(), {});
    expect(once.ok && once.migratedFrom).toBe(5);
    const twice = migrateModel(once.ok ? once.model : {}, {});
    expect(twice.ok && twice.migratedFrom).toBeNull();
    expect(twice.ok && twice.model).toEqual(once.ok && once.model);
  });
});

interface Corrupt {
  name: string;
  mutate: (v5: Raw) => Raw;
  error: RegExp;
}
const CORRUPT: Corrupt[] = [
  { name: "missing confidence", mutate: (v5) => withoutConfidence(v5, 2), error: /hypotheses\[2\]\.confidence is missing \(schema v5 required a number\)/ },
  { name: "null confidence", mutate: (v5) => withConfidence(v5, 1, null), error: /hypotheses\[1\]\.confidence must be a finite number, got null/ },
  { name: "string confidence", mutate: (v5) => withConfidence(v5, 0, "0.7"), error: /hypotheses\[0\]\.confidence must be a finite number, got the string "0\.7"/ },
  { name: "confidence above 1", mutate: (v5) => withConfidence(v5, 3, 1.5), error: /hypotheses\[3\]\.confidence must be between 0 and 1, got 1\.5/ },
  { name: "negative confidence", mutate: (v5) => withConfidence(v5, 0, -0.1), error: /hypotheses\[0\]\.confidence must be between 0 and 1, got -0\.1/ },
  { name: "NaN confidence", mutate: (v5) => withConfidence(v5, 0, Number.NaN), error: /hypotheses\[0\]\.confidence must be a finite number/ },
  { name: "hypotheses not an array", mutate: (v5) => ({ ...v5, hypotheses: { id: "hyp_1" } }), error: /"hypotheses" must be an array, got an object/ },
  { name: "a hypothesis that is not an object", mutate: (v5) => ({ ...v5, hypotheses: [...hyps(v5), "hyp"] }), error: /hypotheses\[4\] must be an object, got the string "hyp"/ },
];

describe.each(CORRUPT)("v5 -> v6 refuses malformed v5 data: $name", ({ mutate, error }) => {
  it("the step throws a typed refusal naming the field; migrateModel reports it as an ordinary failure", () => {
    const bad = mutate(householdV5());
    expect(() => migrateV5toV6(bad)).toThrow(MigrationStepError);
    expect(() => migrateV5toV6(bad)).toThrow(error);
    const r = migrateModel(bad, migrationOptionsFor(bad));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^Migration v5 -> v6 refused: /);
    expect(!r.ok && r.error).toMatch(error);
  });

  it("the repository keeps the stored record byte-identical, writes no v6 replacement and no backup, and reports the error", async () => {
    const bad = mutate(householdV5());
    const id = bad.id as string;
    const storage = new FakeStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ activeId: id, models: { [id]: bad }, backups: {} }));
    const before = storage.getItem(STORAGE_KEY);
    const repo = new LocalStorageModelRepository(storage);
    expect(await repo.load(id)).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBe(before);
    expect(await repo.backupsFor(id)).toEqual({});
    expect(repo.reports.get(id)).toMatchObject({ ok: false, error: expect.stringMatching(error) });
    expect(await repo.list()).toEqual([]);
  });

  it("import refuses the file and stores nothing", async () => {
    const bad = mutate(householdV5());
    const svc = new ModelService(new LocalStorageModelRepository(new FakeStorage()), { now: () => NOW });
    const r = await svc.importModel(JSON.stringify({ format: "human-systems-model", formatVersion: 1, exportedAt: NOW, schemaVersion: 5, model: bad }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(error);
    expect(await svc.listModels()).toEqual([]);
  });
});

describe("v5 -> v6 through the repository backup path and the importer", () => {
  it("a stored v5 record loads as v6, keeps an exact v5 backup under \"5\", and is rewritten once", async () => {
    const v5 = householdV5();
    const id = v5.id as string;
    const storage = new FakeStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ activeId: id, models: { [id]: v5 }, backups: {} }));
    const repo = new LocalStorageModelRepository(storage);
    const loaded = await repo.load(id);
    expect(loaded?.schemaVersion).toBe(6);
    expect(loaded?.hypotheses.map((h) => h.confidence)).toEqual([0.55, 0.7, 0.5, 0.35]);
    expect(repo.reports.get(id)).toMatchObject({ ok: true, migratedFrom: 5 });
    expect((await repo.backupsFor(id))["5"]).toEqual(v5);
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) as string) as { models: Record<string, Raw> };
    expect(stored.models[id].schemaVersion).toBe(6);
    const again = await repo.load(id);
    expect(repo.reports.get(id)).toMatchObject({ ok: true, migratedFrom: null });
    expect(again).toEqual(loaded);
  });

  it("a v5 export imports into a v6 build with migratedFrom 5 and every confidence intact", async () => {
    const v5 = householdV5();
    const svc = new ModelService(new LocalStorageModelRepository(new FakeStorage()), { now: () => NOW });
    const r = await svc.importModel(JSON.stringify({ format: "human-systems-model", formatVersion: 1, exportedAt: NOW, schemaVersion: 5, model: v5 }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.migratedFrom).toBe(5);
    expect(r.ok && r.model.hypotheses.map((h) => h.confidence)).toEqual([0.55, 0.7, 0.5, 0.35]);
  });

  it("a v6 model with a not-assessed hypothesis exports and re-imports with null intact (never 0, never 0.5)", async () => {
    const svcA = new ModelService(new LocalStorageModelRepository(new FakeStorage()), householdServiceOptions({ now: () => NOW }));
    const { model } = await svcA.loadActiveOrSeed();
    const withNull = M.addHypothesis(model, { id: "hyp_unassessed", statement: "Not yet judged" });
    await svcA.save(withNull);
    const text = await svcA.exportModel(model.id);
    const svcB = new ModelService(new LocalStorageModelRepository(new FakeStorage()), { now: () => NOW });
    const r = await svcB.importModel(text);
    expect(r.ok).toBe(true);
    expect(r.ok && r.model.hypotheses.find((h) => h.id === "hyp_unassessed")?.confidence).toBeNull();
  });
});

describe("a pending reviewed proposal created under v5 survives the v5 -> v6 model migration", () => {
  it("revalidates harmlessly: still reviewed, lastValidatedRevision advances to the v6 revision, fingerprint and materialized request untouched", async () => {
    const storage = new FakeStorage();
    const repo = new LocalStorageModelRepository(storage);
    const models = new ModelService(repo, householdServiceOptions({ now: () => NOW }));
    const { model } = await models.loadActiveOrSeed();
    const ledger = new MemoryProposalRepository();
    const svc = new ProposalService(ledger, models, { now: () => NOW }, () => "prop_v5");
    // the proposal is created against the model as the v5 build stored it
    const p = await svc.create({ modelId: model.id, request: [{ kind: "addHypothesis", args: { statement: "Made under v5", confidence: 0.4 } }], proposedBy: { kind: "person" }, basis: [{ kind: "hypothesis", id: "hyp_churn" }] });
    await svc.review(p.id);
    const asV5 = { ...(JSON.parse(JSON.stringify(model)) as Raw), schemaVersion: 5 };
    const v5Revision = revisionOf(asV5 as unknown as SystemModel) as string;
    const reviewed = await svc.get(p.id);
    await ledger.put({ ...reviewed, createdAgainstRevision: v5Revision, lastValidatedRevision: v5Revision });
    const store = JSON.parse(storage.getItem(STORAGE_KEY) as string) as { models: Record<string, Raw> };
    store.models[model.id] = asV5;
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
    // the v6 build starts: the model migrates on load, the proposal is revalidated
    const migrated = await repo.load(model.id);
    expect(migrated?.schemaVersion).toBe(6);
    const after = await svc.revalidate(p.id);
    expect(after.status).toBe("reviewed");
    expect(after.createdAgainstRevision).toBe(v5Revision);
    expect(after.lastValidatedRevision).toBe(revisionOf(migrated));
    expect(after.lastValidatedRevision).not.toBe(v5Revision);
    expect(after.reviewFingerprint).toBe(reviewed.reviewFingerprint);
    expect(after.materialized).toEqual(reviewed.materialized);
    expect(after.previousPreview).toBeNull();
    expect(after.review.at(-1)?.note).toMatch(/unaffected/);
    const r = await svc.approve(p.id);
    expect(r.ok).toBe(true);
    expect(r.ok && r.model.hypotheses.find((h) => h.statement === "Made under v5")?.confidence).toBe(0.4);
    expect(SystemModelSchema.safeParse(r.ok ? r.model : null).success).toBe(true);
  });
});
