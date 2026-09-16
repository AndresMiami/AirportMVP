/**
 * STORAGE SAFETY (Checkpoint 3.1):
 *
 *   unreadable != empty
 *   If the system does not understand your data, its first duty is to preserve it.
 *
 * Automatic startup behavior never overwrites or deletes unreadable data:
 * an unreadable model still counts as stored (no seed), a malformed store
 * envelope is refused (no normalization, no write), a legacy record is
 * removed only after its import landed in the primary store.
 */
import { describe, expect, it } from "vitest";
import { householdServiceOptions } from "@/bootstrap/household-app";
import { SAMPLE_SYSTEM_ID, createSampleHousehold } from "@/data/sample-household";
import { LEGACY_V1_KEY, LocalStorageModelRepository, STORAGE_KEY, StorageError, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { ModelService } from "@/services/model-service";
import type { SystemModel } from "@/types";

type Raw = Record<string, unknown>;
const NOW = "2026-09-16T12:00:00.000Z";

class FakeStorage implements KeyValueStorage {
  data = new Map<string, string>();
  writes = 0;
  removes = 0;
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.writes += 1;
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.removes += 1;
    this.data.delete(k);
  }
}

/** A record no build can read: a schema-5 shape whose hypothesis confidence is null (v5 -> v6 refuses it). */
function unreadableRecord(id: string): Raw {
  const raw = JSON.parse(JSON.stringify(createSampleHousehold())) as Raw;
  const hyps = raw.hypotheses as Raw[];
  return { ...raw, id, schemaVersion: 5, hypotheses: [{ ...hyps[0], confidence: null }, ...hyps.slice(1)] };
}
const storeWith = (models: Record<string, unknown>, activeId: string | null = null) => JSON.stringify({ activeId, models, backups: {} });
const service = (s: FakeStorage) => new ModelService(new LocalStorageModelRepository(s), householdServiceOptions({ now: () => NOW }));

describe("truly empty storage", () => {
  it("no primary key and no legacy key -> the seed is created normally", async () => {
    const s = new FakeStorage();
    const { model, seeded } = await service(s).loadActiveOrSeed();
    expect(seeded).toBe(true);
    expect(model.id).toBe(SAMPLE_SYSTEM_ID);
    expect(JSON.parse(s.getItem(STORAGE_KEY) as string).activeId).toBe(SAMPLE_SYSTEM_ID);
  });
  it("an empty models container is an empty store too", async () => {
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, storeWith({}));
    expect((await service(s).loadActiveOrSeed()).seeded).toBe(true);
  });
});

describe("unreadable model records count as stored: no seed, no overwrite", () => {
  it("PINNED REGRESSION: an unreadable record with the SEED's id -> startup refuses, the sample is not substituted, bytes identical", async () => {
    const s = new FakeStorage();
    const bad = unreadableRecord(SAMPLE_SYSTEM_ID);
    s.setItem(STORAGE_KEY, storeWith({ [SAMPLE_SYSTEM_ID]: bad }, SAMPLE_SYSTEM_ID));
    const before = s.getItem(STORAGE_KEY);
    s.writes = 0;
    await expect(service(s).loadActiveOrSeed()).rejects.toThrow(/could not be read by this build, so no sample was created and nothing was changed/);
    await expect(service(s).loadActiveOrSeed()).rejects.toThrow(/Migration v5 -> v6 refused: hypotheses\[0\]\.confidence/);
    expect(s.getItem(STORAGE_KEY)).toBe(before);
    expect(s.writes).toBe(0);
    expect(JSON.parse(s.getItem(STORAGE_KEY) as string).models[SAMPLE_SYSTEM_ID]).toEqual(bad);
  });

  it("an unreadable record with a DIFFERENT id -> no seed added, exact store preserved, the record is reported", async () => {
    const s = new FakeStorage();
    const bad = unreadableRecord("sys_old");
    s.setItem(STORAGE_KEY, storeWith({ sys_old: bad }, "sys_old"));
    const before = s.getItem(STORAGE_KEY);
    s.writes = 0;
    const repo = new LocalStorageModelRepository(s);
    await expect(new ModelService(repo, householdServiceOptions({ now: () => NOW })).loadActiveOrSeed()).rejects.toThrow(/1 stored system could not be read \(sys_old: Migration v5 -> v6 refused/);
    expect(s.getItem(STORAGE_KEY)).toBe(before);
    expect(s.writes).toBe(0);
    expect(await repo.hasStoredModels()).toBe(true);
    expect(await repo.list()).toEqual([]);
    expect(await repo.unreadable()).toEqual([{ id: "sys_old", error: expect.stringMatching(/^Migration v5 -> v6 refused/) }]);
  });

  it("a valid model beside an unreadable one: the valid one loads, the unreadable raw record stays untouched, and saving over it is refused", async () => {
    const s = new FakeStorage();
    const good = createSampleHousehold();
    const bad = unreadableRecord("sys_old");
    s.setItem(STORAGE_KEY, storeWith({ sys_old: bad, [good.id]: good }, "sys_old"));
    const repo = new LocalStorageModelRepository(s);
    const svc = new ModelService(repo, householdServiceOptions({ now: () => NOW }));
    const { model, seeded } = await svc.loadActiveOrSeed();
    expect(seeded).toBe(false);
    expect(model.id).toBe(good.id);
    const store = JSON.parse(s.getItem(STORAGE_KEY) as string) as { activeId: string; models: Record<string, unknown> };
    expect(store.activeId).toBe(good.id); // the loadable one became active
    expect(store.models.sys_old).toEqual(bad); // byte for byte
    expect(await repo.unreadable()).toEqual([{ id: "sys_old", error: expect.any(String) }]);
    // an ordinary save under the unreadable id is refused; a save of the valid model is fine
    await expect(repo.save({ ...good, id: "sys_old" } as SystemModel)).rejects.toThrow(StorageError);
    await expect(repo.save({ ...good, id: "sys_old" } as SystemModel)).rejects.toThrow(/cannot be read by this build; saving would overwrite it/);
    expect((JSON.parse(s.getItem(STORAGE_KEY) as string) as { models: Record<string, unknown> }).models.sys_old).toEqual(bad);
    await repo.save({ ...good, profile: { ...good.profile, description: "edited" } });
    expect((await repo.load(good.id))?.profile.description).toBe("edited");
    expect((JSON.parse(s.getItem(STORAGE_KEY) as string) as { models: Record<string, unknown> }).models.sys_old).toEqual(bad);
  });

  it("resetting to the sample cannot overwrite an unreadable record carrying the seed id", async () => {
    const s = new FakeStorage();
    const good = createSampleHousehold();
    const bad = unreadableRecord(SAMPLE_SYSTEM_ID);
    s.setItem(STORAGE_KEY, storeWith({ [SAMPLE_SYSTEM_ID]: bad, sys_good: { ...good, id: "sys_good" } }, "sys_good"));
    const svc = service(s);
    await svc.loadActiveOrSeed();
    await expect(svc.resetSeed()).rejects.toThrow(StorageError);
    expect((JSON.parse(s.getItem(STORAGE_KEY) as string) as { models: Record<string, unknown> }).models[SAMPLE_SYSTEM_ID]).toEqual(bad);
  });
});

describe("a malformed primary store is refused, never normalized", () => {
  const MALFORMED: [string, string][] = [
    ["invalid JSON", "{ not json"],
    ["an array", "[]"],
    ["a string", JSON.stringify("store")],
    ["null", "null"],
    ["no models container", JSON.stringify({ activeId: null, backups: {} })],
    ["models is an array", JSON.stringify({ activeId: null, models: [], backups: {} })],
    ["models is a string", JSON.stringify({ activeId: null, models: "x", backups: {} })],
    ["backups is malformed", JSON.stringify({ activeId: null, models: {}, backups: 3 })],
    ["activeId is malformed", JSON.stringify({ activeId: 7, models: {}, backups: {} })],
  ];
  it.each(MALFORMED)("%s: every read and write refuses with a StorageError; the exact string is preserved; no seed", async (_name, raw) => {
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, raw);
    s.writes = 0;
    s.removes = 0;
    const repo = new LocalStorageModelRepository(s);
    await expect(repo.list()).rejects.toThrow(StorageError);
    await expect(repo.load("x")).rejects.toThrow(StorageError);
    await expect(repo.getActiveId()).rejects.toThrow(StorageError);
    await expect(repo.hasStoredModels()).rejects.toThrow(StorageError);
    await expect(repo.save(createSampleHousehold())).rejects.toThrow(StorageError);
    await expect(repo.setActiveId("x")).rejects.toThrow(StorageError);
    await expect(repo.delete("x")).rejects.toThrow(StorageError);
    await expect(repo.saveIfRevision(createSampleHousehold(), null, () => null)).rejects.toThrow(StorageError);
    await expect(service(s).loadActiveOrSeed()).rejects.toThrow(/Nothing was changed/);
    expect(s.getItem(STORAGE_KEY)).toBe(raw);
    expect(s.writes).toBe(0);
    expect(s.removes).toBe(0);
  });
  it("the error names the key and says nothing was changed", async () => {
    const s = new FakeStorage();
    s.setItem(STORAGE_KEY, "{ not json");
    await expect(new LocalStorageModelRepository(s).list()).rejects.toThrow(/human-systems\.store\.v2.*not valid JSON\. Nothing was changed/);
  });
});

describe("the legacy single-model key", () => {
  it("malformed legacy JSON: refused, the legacy bytes remain, nothing deleted or written", async () => {
    const s = new FakeStorage();
    s.setItem(LEGACY_V1_KEY, "{ legacy but broken");
    s.writes = 0;
    s.removes = 0;
    const repo = new LocalStorageModelRepository(s);
    await expect(repo.list()).rejects.toThrow(StorageError);
    await expect(repo.list()).rejects.toThrow(/human-systems\.model\.v1.*not valid JSON.*kept exactly as it is/);
    await expect(service(s).loadActiveOrSeed()).rejects.toThrow(StorageError);
    expect(s.getItem(LEGACY_V1_KEY)).toBe("{ legacy but broken");
    expect(s.getItem(STORAGE_KEY)).toBeNull();
    expect(s.writes).toBe(0);
    expect(s.removes).toBe(0);
  });

  it("a legacy record without a usable id is kept and refused", async () => {
    const s = new FakeStorage();
    s.setItem(LEGACY_V1_KEY, JSON.stringify({ profile: { name: "no id" } }));
    const before = s.getItem(LEGACY_V1_KEY);
    await expect(new LocalStorageModelRepository(s).list()).rejects.toThrow(/no usable id/);
    expect(s.getItem(LEGACY_V1_KEY)).toBe(before);
    expect(s.getItem(STORAGE_KEY)).toBeNull();
  });

  it("legacy id collision: both records preserved, no overwrite, the legacy key remains", async () => {
    const s = new FakeStorage();
    const m = createSampleHousehold();
    const primary = storeWith({ [m.id]: { ...m, profile: { ...m.profile, name: "Primary copy" } } }, m.id);
    const legacy = JSON.stringify({ ...m, profile: { ...m.profile, name: "Legacy copy" } });
    s.setItem(STORAGE_KEY, primary);
    s.setItem(LEGACY_V1_KEY, legacy);
    s.writes = 0;
    s.removes = 0;
    await expect(new LocalStorageModelRepository(s).list()).rejects.toThrow(/same id.*Both were kept; neither was overwritten/);
    expect(s.getItem(STORAGE_KEY)).toBe(primary);
    expect(s.getItem(LEGACY_V1_KEY)).toBe(legacy);
    expect(s.writes).toBe(0);
    expect(s.removes).toBe(0);
  });

  it("successful import: the primary record is written FIRST and the legacy key removed only afterwards", async () => {
    const s = new FakeStorage();
    const m = createSampleHousehold();
    s.setItem(LEGACY_V1_KEY, JSON.stringify(m));
    const order: string[] = [];
    const origSet = s.setItem.bind(s);
    const origRemove = s.removeItem.bind(s);
    s.setItem = (k, v) => {
      order.push(`set:${k}`);
      origSet(k, v);
    };
    s.removeItem = (k) => {
      order.push(`remove:${k}`);
      origRemove(k);
    };
    const repo = new LocalStorageModelRepository(s);
    expect((await repo.list()).map((x) => x.id)).toEqual([m.id]);
    expect(order).toEqual([`set:${STORAGE_KEY}`, `remove:${LEGACY_V1_KEY}`]);
    expect(s.getItem(LEGACY_V1_KEY)).toBeNull();
    expect(await repo.getActiveId()).toBe(m.id);
  });

  it("a primary write that throws leaves the legacy key intact", async () => {
    const s = new FakeStorage();
    const m = createSampleHousehold();
    const legacy = JSON.stringify(m);
    s.setItem(LEGACY_V1_KEY, legacy);
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    await expect(new LocalStorageModelRepository(s).list()).rejects.toThrow(/QuotaExceededError/);
    expect(s.getItem(LEGACY_V1_KEY)).toBe(legacy);
    expect(s.getItem(STORAGE_KEY)).toBeNull();
  });
});
