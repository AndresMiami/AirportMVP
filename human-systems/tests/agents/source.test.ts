/**
 * STEP 7B — source snapshots: strict parsing, append-only versions, the
 * same version never silently changed, item content re-resolved from the
 * CURRENT version for review fingerprints.
 */
import { describe, expect, it } from "vitest";
import { LocalStorageSourceRepository, MemorySourceRepository, SourceError, itemContentHash, parseSourceSnapshot } from "@/agents/source";
import { snapshot } from "../helpers/research-fixture";

class MemoryStorage {
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

describe("parsing", () => {
  it("accepts a well-formed snapshot and refuses missing quotes, invented provenance, unknown fields and duplicate keys", () => {
    expect(parseSourceSnapshot(JSON.stringify(snapshot())).ok).toBe(true);
    const s = snapshot();
    const noQuote = { ...s, items: [{ ...s.items[0], quote: "" }] };
    expect(parseSourceSnapshot(JSON.stringify(noQuote)).ok).toBe(false);
    const aiInferred = { ...s, items: [{ ...s.items[0], sourceType: "ai_inferred" }] };
    expect(parseSourceSnapshot(JSON.stringify(aiInferred)).ok).toBe(false);
    const extra = { ...s, items: [{ ...s.items[0], confidence: 0.9 }] };
    expect(parseSourceSnapshot(JSON.stringify(extra)).ok).toBe(false);
    const dup = { ...s, items: [s.items[0], s.items[0]] };
    const r = parseSourceSnapshot(JSON.stringify(dup));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate item key/);
    expect(parseSourceSnapshot("{not json").ok).toBe(false);
  });
});

describe("the store", () => {
  for (const [label, make] of [
    ["memory", () => new MemorySourceRepository()],
    ["localStorage", () => new LocalStorageSourceRepository(new MemoryStorage())],
  ] as const) {
    it(`${label}: versions append; the same version with the same content is a no-op; the same version with different content is refused`, () => {
      const repo = make();
      expect(repo.add(snapshot())).toEqual({ stored: true });
      expect(repo.add(snapshot())).toEqual({ stored: false, reason: "same_version_same_content" });
      const changed = snapshot({ items: [{ ...snapshot().items[0], value: 2.5 }] });
      expect(() => repo.add(changed)).toThrow(SourceError);
      expect(repo.add(snapshot({ version: "2026-08-31", items: changed.items }))).toEqual({ stored: true });
      expect(repo.versions("bank-export").map((v) => v.version)).toEqual(["2026-07-31", "2026-08-31"]);
      expect(repo.current("bank-export")?.version).toBe("2026-08-31");
      expect(repo.list()).toEqual([{ id: "bank-export", name: "Bank export", versions: 2, latestVersion: "2026-08-31", latestRetrievedAt: "2026-08-01T09:00:00.000Z" }]);
      expect(repo.current("nope")).toBeNull();
    });
    it(`${label}: item content resolves from the CURRENT version and is null when the item or the source is gone`, () => {
      const repo = make();
      repo.add(snapshot());
      expect(repo.itemContent("bank-export", "buf-2026-07")).toEqual({ name: "Bank export", item: snapshot().items[0] }); // no version: a newer retrieval saying the same thing is not a change
      expect(repo.itemContent("bank-export", "missing")).toBeNull();
      expect(repo.itemContent("other", "buf-2026-07")).toBeNull();
    });
  }
  it("content hashes ignore retrieval facts and change with the reviewed content", () => {
    const a = snapshot().items[0];
    expect(itemContentHash({ ...a, locator: "elsewhere" })).toBe(itemContentHash(a));
    expect(itemContentHash({ ...a, value: 2.5 })).not.toBe(itemContentHash(a));
    expect(itemContentHash({ ...a, quote: "different words" })).not.toBe(itemContentHash(a));
  });
});
