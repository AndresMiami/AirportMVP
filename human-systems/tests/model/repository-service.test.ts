import { describe, expect, it } from "vitest";
import { createSampleHousehold } from "@/data/sample-household";
import { DERIVED_IDS, INPUT_IDS } from "@/model/ids";
import { LocalStorageModelRepository, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { MemoryModelRepository } from "@/repositories/memory-repository";
import { ModelService } from "@/services/model-service";

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
  it("round-trips a model and treats corrupt data as absent", async () => {
    const s = new FakeStorage();
    const repo = new LocalStorageModelRepository(s);
    expect(await repo.load()).toBeNull();
    const m = createSampleHousehold();
    await repo.save(m);
    expect(await repo.load()).toEqual(m);
    s.setItem("human-systems.model.v1", "{ not json");
    expect(await repo.load()).toBeNull();
    s.setItem("human-systems.model.v1", JSON.stringify({ schemaVersion: 1 }));
    expect(await repo.load()).toBeNull();
    await repo.clear();
    expect(s.data.size).toBe(0);
  });
});

describe("ModelService", () => {
  it("seeds the sample when storage is empty and reloads it afterwards", async () => {
    const svc = new ModelService(new MemoryModelRepository());
    const first = await svc.loadOrSeed();
    expect(first.seeded).toBe(true);
    const second = await svc.loadOrSeed();
    expect(second.seeded).toBe(false);
    expect(second.model.id).toBe(first.model.id);
  });
  it("updateVariable protects computed fields on derived variables", () => {
    const svc = new ModelService(new MemoryModelRepository());
    const m = createSampleHousehold();
    const next = svc.updateVariable(m, { id: DERIVED_IDS.floorRatio, currentValue: 42, desiredValue: 1.3, sourceType: "measured", confidence: 1 });
    const fr = next.variables.find((v) => v.id === DERIVED_IDS.floorRatio)!;
    expect(fr.desiredValue).toBe(1.3);
    expect(fr.currentValue).toBeNull(); // stored derived values are never authoritative
    expect(fr.sourceType).toBe("calculated");
    const input = svc.updateVariable(m, { id: INPUT_IDS.liquidReserves, currentValue: 5000 });
    expect(input.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!.currentValue).toBe(5000);
    expect(m.variables.find((v) => v.id === INPUT_IDS.liquidReserves)!.currentValue).toBe(2800);
  });
  it("save stamps updatedAt and validates", async () => {
    const repo = new MemoryModelRepository();
    const svc = new ModelService(repo);
    const m = createSampleHousehold();
    const saved = await svc.save(m);
    expect(saved.updatedAt).not.toBe(m.updatedAt);
    await expect(svc.save({ ...m, variables: [{ ...m.variables[0], confidence: 3 }] })).rejects.toThrow();
  });
});
