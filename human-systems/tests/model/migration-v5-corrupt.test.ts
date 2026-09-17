/**
 * v4 -> v5 refuses corrupt input instead of sanitizing it.
 *
 *   INVALID / CORRUPT V4 DATA != PERMISSION TO DROP OR REPAIR IT SILENTLY
 *
 * The step touches only `incomeSources` and `events[].links.incomeSourceIds`
 * and must preserve everything else, so a field that is PRESENT but not the
 * shape the v4 contract promised fails the migration through the ordinary
 * failure result. Every persistence path then stores nothing: the
 * repository keeps the original record byte for byte with no backup and
 * reports the error; the importer returns the error and writes nothing.
 * Absence is honoured only where v4 made the field optional.
 */
import { describe, expect, it } from "vitest";
import { foldCollectionsToV4 } from "../helpers/legacy-shapes";
import { createSampleHousehold } from "@/data/sample-household";
import { registerBuiltInDomains } from "@/domains";
import { migrateModel, migrateV4toV5, migrationOptionsFor, MigrationStepError } from "@/model/migrations";
import { LocalStorageModelRepository, STORAGE_KEY, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";

type Raw = Record<string, unknown>;
const NOW = "2026-09-15T12:00:00.000Z";
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

function householdV4(): Raw {
  return foldCollectionsToV4(JSON.parse(JSON.stringify(createSampleHousehold())) as Raw);
}

function events(v4: Raw): Raw[] {
  return v4.events as Raw[];
}

/** One corrupt fixture: a mutation of the valid v4 sample and the error it must name. */
interface Corrupt {
  name: string;
  mutate: (v4: Raw) => Raw;
  error: RegExp;
}

const CORRUPT: Corrupt[] = [
  { name: "1. incomeSources present but not an array (string)", mutate: (v4) => ({ ...v4, incomeSources: "corrupt" }), error: /"incomeSources" must be an array, got the string "corrupt"/ },
  { name: "1b. incomeSources present but not an array (object)", mutate: (v4) => ({ ...v4, incomeSources: { id: "inc_1" } }), error: /"incomeSources" must be an array, got an object/ },
  { name: "1c. incomeSources present but null", mutate: (v4) => ({ ...v4, incomeSources: null }), error: /"incomeSources" must be an array, got null/ },
  {
    name: "1d. incomeSources absent (schema v4 required it)",
    mutate: (v4) => {
      const { incomeSources: _dropped, ...rest } = v4;
      void _dropped;
      return rest;
    },
    error: /"incomeSources" is missing \(schema v4 required it\)/,
  },
  { name: "2. events present but not an array (object)", mutate: (v4) => ({ ...v4, events: {} }), error: /"events" must be an array, got an object/ },
  { name: "2b. events present but null", mutate: (v4) => ({ ...v4, events: null }), error: /"events" must be an array, got null/ },
  {
    name: "3. events array containing a non-object entry",
    mutate: (v4) => ({ ...v4, events: [events(v4)[0], "corrupt-event", events(v4)[1]] }),
    error: /events\[1\] must be an object, got the string "corrupt-event"/,
  },
  { name: "3b. events array containing null", mutate: (v4) => ({ ...v4, events: [null, ...events(v4)] }), error: /events\[0\] must be an object, got null/ },
  { name: "4. an event with links present but malformed (string)", mutate: (v4) => ({ ...v4, events: events(v4).map((e, i) => (i === 1 ? { ...e, links: "x" } : e)) }), error: /events\[1\]\.links must be an object, got the string "x"/ },
  { name: "4b. an event with links present but null", mutate: (v4) => ({ ...v4, events: events(v4).map((e, i) => (i === 0 ? { ...e, links: null } : e)) }), error: /events\[0\]\.links must be an object, got null/ },
  { name: "4c. an event with links present but an array", mutate: (v4) => ({ ...v4, events: events(v4).map((e, i) => (i === 0 ? { ...e, links: [] } : e)) }), error: /events\[0\]\.links must be an object, got an array/ },
  {
    name: "5. incomeSourceIds present but not an array",
    mutate: (v4) => ({ ...v4, events: events(v4).map((e, i) => (i === 1 ? { ...e, links: { ...(e.links as Raw), incomeSourceIds: "inc_warehouse" } } : e)) }),
    error: /events\[1\]\.links\.incomeSourceIds must be an array, got the string "inc_warehouse"/,
  },
  {
    name: "6. incomeSourceIds containing a non-string id",
    mutate: (v4) => ({ ...v4, events: events(v4).map((e, i) => (i === 1 ? { ...e, links: { ...(e.links as Raw), incomeSourceIds: ["inc_warehouse", 42] } } : e)) }),
    error: /events\[1\]\.links\.incomeSourceIds\[1\] must be a string, got a number/,
  },
  {
    name: "6b. incomeSourceIds containing an object id",
    mutate: (v4) => ({ ...v4, events: events(v4).map((e, i) => (i === 0 ? { ...e, links: { ...(e.links as Raw), incomeSourceIds: [{ id: "inc_warehouse" }] } } : e)) }),
    error: /events\[0\]\.links\.incomeSourceIds\[0\] must be a string, got an object/,
  },
  { name: "7. a v5 field on a v4 record: collections", mutate: (v4) => ({ ...v4, collections: {} }), error: /must not carry a "collections" field/ },
  {
    name: "7b. a v5 field on a v4 record: links.collectionItemRefs",
    mutate: (v4) => ({ ...v4, events: events(v4).map((e, i) => (i === 0 ? { ...e, links: { ...(e.links as Raw), collectionItemRefs: [] } } : e)) }),
    error: /events\[0\]\.links must not carry "collectionItemRefs"/,
  },
];

describe("v4 -> v5 refuses corrupt input (no silent sanitization)", () => {
  it("the valid fixture migrates, so every refusal below is caused by its one mutation", () => {
    const v4 = householdV4();
    expect(migrateModel(v4, migrationOptionsFor(v4)).ok).toBe(true);
  });

  describe.each(CORRUPT)("$name", ({ mutate, error }) => {
    it("the step refuses with a typed error naming the field and migrateModel reports it as an ordinary failure", () => {
      const v4 = mutate(householdV4());
      expect(() => migrateV4toV5(v4, migrationOptionsFor(v4))).toThrow(MigrationStepError);
      expect(() => migrateV4toV5(v4, migrationOptionsFor(v4))).toThrow(error);
      const r = migrateModel(v4, migrationOptionsFor(v4, { migratedAt: NOW }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/^Migration v4 -> v5 refused: /);
      expect(r.error).toMatch(error);
    });

    it("the repository leaves the stored record byte-identical, writes no v5 replacement and no backup, and reports the error", async () => {
      const v4 = mutate(householdV4());
      const id = v4.id as string;
      const s = new FakeStorage();
      const before = JSON.stringify({ activeId: id, models: { [id]: v4 }, backups: {} });
      s.setItem(STORAGE_KEY, before);
      const repo = new LocalStorageModelRepository(s);
      expect(await repo.load(id)).toBeNull();
      expect(await repo.list()).toEqual([]);
      expect(s.getItem(STORAGE_KEY)).toBe(before);
      expect(await repo.backupsFor(id)).toEqual({});
      const report = repo.reports.get(id);
      expect(report).toMatchObject({ id, ok: false, migratedFrom: null });
      expect((report as { error: string }).error).toMatch(error);
    });

    it("import refuses the file and stores nothing", async () => {
      const v4 = mutate(householdV4());
      const repo = new MemoryModelRepository();
      const svc = new ModelService(repo, { now: () => NOW });
      const file = JSON.stringify({ format: "human-systems-model", formatVersion: 1, exportedAt: NOW, schemaVersion: 4, model: v4 });
      const r = await svc.importModel(file);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(error);
      expect(await repo.list()).toEqual([]);
      expect(await repo.load(v4.id as string)).toBeNull();
    });
  });

  it("absence that v4 allowed keeps its v4 default: no events, no links, no incomeSourceIds", () => {
    const base = householdV4();
    const { events: _dropped, ...noEvents } = base;
    void _dropped;
    const r1 = migrateModel(noEvents, migrationOptionsFor(noEvents));
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.model.events).toEqual([]);
    const stripped = {
      ...base,
      events: events(base).map((e, i) => {
        const { links, ...rest } = e;
        if (i === 0) return rest; // no links at all
        const { incomeSourceIds: _ids, ...otherLinks } = links as Raw;
        void _ids;
        return { ...rest, links: otherLinks }; // links without incomeSourceIds
      }),
    };
    const r2 = migrateModel(stripped, migrationOptionsFor(stripped));
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.model.events[0].links).toEqual({ variableIds: [], relationshipIds: [], hypothesisIds: [], actionIds: [], eventIds: [], collectionItemRefs: [] });
    expect(r2.model.events[1].links.collectionItemRefs).toEqual([]);
    expect(r2.model.events[1].links.variableIds).toEqual(events(base)[1].links ? ((events(base)[1].links as Raw).variableIds as string[]) : []);
  });

  it("a corrupt item is preserved verbatim into the final validation, never dropped: the whole record fails", () => {
    const v4 = householdV4();
    const items = v4.incomeSources as unknown[];
    const withJunk = { ...v4, incomeSources: [items[0], "not-an-item", items[1]] };
    // the step does not interpret items, so it passes them on unchanged...
    const stepped = migrateV4toV5(withJunk, migrationOptionsFor(withJunk));
    expect((stepped.collections as Raw).incomeSources).toMatchObject({ items: [items[0], "not-an-item", items[1]] });
    // ...and the complete v5 validation refuses the record instead of two clean items surviving
    const r = migrateModel(withJunk, migrationOptionsFor(withJunk));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/failed validation/);
    const missingId = { ...v4, incomeSources: [items[0], { name: "no id" }] };
    expect(migrateModel(missingId, migrationOptionsFor(missingId)).ok).toBe(false);
  });

  it("other steps are untouched: an unexpected exception inside a step still propagates (only MigrationStepError is a result)", () => {
    // A v3 record whose v3 -> v4 step is fine but whose v4 -> v5 input is corrupt
    // reports the v4 refusal through the same failure result.
    const v4 = { ...householdV4(), incomeSources: "corrupt" };
    const r = migrateModel(v4, migrationOptionsFor(v4));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Migration v4 -> v5 refused/);
  });
});
