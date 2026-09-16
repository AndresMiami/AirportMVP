import * as M from "@/services/mutations";
import { evaluateSystem } from "@/model/evaluate";
import { describe, expect, it } from "vitest";
import { createSampleHousehold } from "@/data/sample-household";
import { DERIVED_IDS, INPUT_IDS } from "@/domains/household/keys";
import { LocalStorageModelRepository, LEGACY_V1_KEY, STORAGE_KEY, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";
import { HOUSEHOLD_APP, householdServiceOptions } from "@/bootstrap/household-app";

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

describe("LocalStorageModelRepository", () => {
  it("round-trips several models, tracks the active id, and treats corrupt data as absent", async () => {
    const s = new FakeStorage();
    const repo = new LocalStorageModelRepository(s);
    expect(await repo.list()).toEqual([]);
    expect(await repo.getActiveId()).toBeNull();
    const m = createSampleHousehold();
    await repo.save(m);
    await repo.save({ ...m, id: "second", profile: { ...m.profile, name: "Second" } });
    await repo.setActiveId("second");
    expect((await repo.list()).map((x) => x.id).sort()).toEqual([m.id, "second"]);
    expect(await repo.load(m.id)).toEqual(m);
    expect(await repo.getActiveId()).toBe("second");
    await repo.delete("second");
    expect(await repo.getActiveId()).toBeNull();
    expect(await repo.load("second")).toBeNull();

    s.setItem(STORAGE_KEY, "{ not json");
    expect(await repo.list()).toEqual([]);
    s.setItem(STORAGE_KEY, JSON.stringify({ activeId: "x", models: { x: { schemaVersion: 2 } } }));
    expect(await repo.load("x")).toBeNull();
    expect(repo.reports.get("x")?.ok).toBe(false);
    await repo.clear();
    expect(s.data.size).toBe(0);
  });

  it("imports the legacy single-model key once and removes it", async () => {
    const s = new FakeStorage();
    const m = createSampleHousehold();
    s.setItem(LEGACY_V1_KEY, JSON.stringify(m));
    const repo = new LocalStorageModelRepository(s);
    expect((await repo.list()).map((x) => x.id)).toEqual([m.id]);
    expect(await repo.getActiveId()).toBe(m.id);
    expect(s.getItem(LEGACY_V1_KEY)).toBeNull();
  });
});

describe("ModelService", () => {
  const clock = () => "2026-09-14T12:00:00.000Z";

  it("seeds the sample when storage is empty and reloads it afterwards", async () => {
    const svc = new ModelService(new MemoryModelRepository(), householdServiceOptions({ now: clock }));
    const first = await svc.loadActiveOrSeed();
    expect(first.seeded).toBe(true);
    expect(first.model.id).toBe(HOUSEHOLD_APP.seed.id);
    const second = await svc.loadActiveOrSeed();
    expect(second.seeded).toBe(false);
    expect(second.model.id).toBe(first.model.id);
  });

  it("creates a blank system, activates it, lists both, and switches back", async () => {
    const repo = new MemoryModelRepository();
    const svc = new ModelService(repo, householdServiceOptions({ now: clock, newId: () => "sys_test" }));
    await svc.loadActiveOrSeed();
    const blank = await svc.createBlank({ name: "Real household", systemType: "household", domainId: HOUSEHOLD_APP.defaultDomain.id });
    expect(blank.id).toBe("sys_test");
    expect(blank.relationships).toEqual([]);
    expect(blank.variables.every((v) => v.kind === "derived")).toBe(true);
    expect(await repo.getActiveId()).toBe("sys_test");
    expect((await svc.listModels()).map((m) => m.id).sort()).toEqual([HOUSEHOLD_APP.seed.id, "sys_test"]);
    const back = await svc.switchActive(HOUSEHOLD_APP.seed.id);
    expect(back.id).toBe(HOUSEHOLD_APP.seed.id);
    await svc.deleteModel("sys_test");
    expect((await svc.listModels()).map((m) => m.id)).toEqual([HOUSEHOLD_APP.seed.id]);
    await expect(svc.switchActive("sys_test")).rejects.toThrow();
  });

  it("updateVariable protects computed fields on derived variables", () => {
    const svc = new ModelService(new MemoryModelRepository());
    const m = createSampleHousehold();
    expect(() => svc.updateVariable(m, { id: DERIVED_IDS.floorRatio, currentValue: 42, sourceType: "measured", confidence: 1 })).toThrow(/never takes an entered value/);
    const next = svc.updateVariable(m, { id: DERIVED_IDS.floorRatio, desiredValue: 1.3 });
    const fr = next.variables.find((v) => v.id === DERIVED_IDS.floorRatio)!;
    expect(M.currentTargetOf(fr)).toBe(1.3);
    expect(fr.values).toEqual([]); // a derived shell never stores a value entry
    expect(evaluateSystem(next).variableById.get(DERIVED_IDS.floorRatio)!.sourceType).toBe("calculated");
    const input = svc.updateVariable(m, { id: INPUT_IDS.liquidReserves, currentValue: 5000 });
    expect(M.currentValueOf(input.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!)).toBe(5000);
    expect(M.currentValueOf(m.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!)).toBe(2800);
  });

  it("save stamps updatedAt and validates", async () => {
    const repo = new MemoryModelRepository();
    const svc = new ModelService(repo, { now: clock });
    const m = createSampleHousehold();
    const saved = await svc.save(m);
    expect(saved.updatedAt).toBe(clock());
    await expect(svc.save({ ...m, variables: [{ ...m.variables[0], controllability: 3 }] })).rejects.toThrow();
  });
});
