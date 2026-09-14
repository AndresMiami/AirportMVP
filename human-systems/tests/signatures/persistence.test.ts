import { describe, expect, it } from "vitest";
import { createSampleHousehold } from "@/data/sample-household";
import { evaluateSystem } from "@/model/evaluate";
import { INPUT_IDS } from "@/model/ids";
import { migrateModel } from "@/model/migrations";
import { LocalStorageModelRepository, type KeyValueStorage } from "@/repositories/local-storage-repository";
import { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import { computeSignature } from "@/signatures";
import { StructuralSignatureSchema, SystemModelSchema } from "@/types";

const NOW = "2026-09-14T12:00:00.000Z";

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

describe("signature snapshots in the model", () => {
  it("addSignatureSnapshot stores a computed snapshot; ids and system are checked", () => {
    const m = createSampleHousehold();
    const s = computeSignature(evaluateSystem(m), { id: M.nextSignatureId(m), now: NOW, mode: "current", label: "T1" });
    expect(s.id).toBe("sig_1");
    const next = M.addSignatureSnapshot(m, s);
    expect(next.signatures).toHaveLength(1);
    expect(m.signatures).toHaveLength(0);
    expect(() => M.addSignatureSnapshot(next, s)).toThrow(/already exists/);
    const foreign = { ...s, id: "sig_2", systemId: "someone_else" };
    expect(() => M.addSignatureSnapshot(next, foreign)).toThrow(/different system/);
    expect(M.nextSignatureId(next)).toBe("sig_2");
  });
  it("only label and notes can change after storing; values are immutable", () => {
    const m = createSampleHousehold();
    const s = computeSignature(evaluateSystem(m), { id: "sig_1", now: NOW, mode: "current" });
    let next = M.addSignatureSnapshot(m, s);
    next = M.updateSignatureMeta(next, "sig_1", { label: "Baseline", notes: "first pass" });
    const stored = next.signatures[0];
    expect(stored.label).toBe("Baseline");
    expect(stored.notes).toBe("first pass");
    expect(stored.dimensions).toEqual(s.dimensions);
    expect(stored.compactStrip).toBe(s.compactStrip);
    expect(() => M.updateSignatureMeta(next, "nope", { label: "x" })).toThrow();
    // Later model edits never touch the stored history.
    const edited = M.updateVariable(next, INPUT_IDS.liquidReserves, { currentValue: 50000 });
    expect(edited.signatures[0]).toEqual(stored);
    const fresh = computeSignature(evaluateSystem(edited), { id: "sig_2", now: NOW, mode: "current" });
    expect(fresh.dimensions.find((d) => d.dimensionId === "financial_buffer")!.normalizedValue).not.toBe(
      stored.dimensions.find((d) => d.dimensionId === "financial_buffer")!.normalizedValue,
    );
    const removed = M.removeSignatureSnapshot(edited, "sig_1");
    expect(removed.signatures).toEqual([]);
    expect(() => M.removeSignatureSnapshot(removed, "sig_1")).toThrow();
  });
});

describe("persisted signatures survive reload and migration", () => {
  it("round-trips through the localStorage repository byte for byte", async () => {
    const storage = new FakeStorage();
    const svc = new ModelService(new LocalStorageModelRepository(storage), { now: () => NOW });
    let m = createSampleHousehold();
    m = M.addSignatureSnapshot(m, computeSignature(evaluateSystem(m), { id: "sig_1", now: NOW, mode: "current", label: "T1" }));
    m = M.addSignatureSnapshot(m, computeSignature(evaluateSystem(m), { id: "sig_2", now: NOW, mode: "desired", label: "Desired" }));
    const saved = await svc.save(m);
    const svc2 = new ModelService(new LocalStorageModelRepository(storage), { now: () => NOW });
    const { model: reloaded, seeded } = await svc2.loadActiveOrSeed();
    expect(seeded).toBe(false);
    expect(reloaded).toEqual(saved);
    expect(reloaded.signatures.map((s) => s.label)).toEqual(["T1", "Desired"]);
    expect(reloaded.signatures[0].dimensions.find((d) => d.dimensionId === "physical_feasibility")!.normalizedValue).toBeNull();
    expect(StructuralSignatureSchema.safeParse(reloaded.signatures[0]).success).toBe(true);
  });
  it("a stored model without a signatures collection migrates to an empty one (never invents snapshots)", () => {
    const raw = JSON.parse(JSON.stringify(createSampleHousehold())) as Record<string, unknown>;
    delete raw.signatures;
    delete raw.signatureDefinitionId;
    const result = migrateModel(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.signatures).toEqual([]);
      expect(result.model.signatureDefinitionId).toBe("household_default");
    }
    const v1 = { ...raw, schemaVersion: 1 };
    const fromV1 = migrateModel(v1);
    expect(fromV1.ok && fromV1.model.signatures).toEqual([]);
  });
  it("a corrupt snapshot is rejected by validation rather than half-loaded", () => {
    const m = createSampleHousehold();
    const s = computeSignature(evaluateSystem(m), { id: "sig_1", now: NOW, mode: "current" });
    const bad = JSON.parse(JSON.stringify({ ...m, signatures: [{ ...s, dimensions: [{ ...s.dimensions[0], normalizedValue: 7 }] }] }));
    expect(SystemModelSchema.safeParse(bad).success).toBe(false);
  });
});
