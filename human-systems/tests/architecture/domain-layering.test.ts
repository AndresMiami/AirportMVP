/**
 * DOMAIN RESOLVER OWNERSHIP (3a invariant 2): the generic engine owns the
 * domain-resolution interface (src/model/domain.ts); concrete domains only
 * supply configuration. This test fails if any engine module imports a
 * concrete domain module, or if the engine reaches for the household
 * package by any path.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Directories that make up the generic engine. */
const ENGINE_DIRS = ["types", "domain", "calculations", "model", "scenarios", "signatures", "repositories", "ai"];
const FORBIDDEN = [/from\s+["']@\/domains(\/|["'])/, /from\s+["'](\.\.\/)+domains\//, /from\s+["'].*\/household\//];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

describe("domain layering", () => {
  const root = path.resolve(import.meta.dirname, "../../src");

  it("engine modules never import a concrete domain module", () => {
    const offenders: string[] = [];
    for (const d of ENGINE_DIRS) {
      for (const file of walk(path.join(root, d))) {
        const src = readFileSync(file, "utf8");
        if (FORBIDDEN.some((re) => re.test(src))) offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the household domain is a leaf: it imports only the engine's interface and its own files", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, "domains", "household"))) {
      const src = readFileSync(file, "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of imports) {
        const ok = spec.startsWith("./") || spec.startsWith("@/model/domain") || spec.startsWith("@/types") || spec.startsWith("@/domain/") || spec.startsWith("@/calculations/") || spec === "zod";
        if (!ok) offenders.push(`${path.relative(root, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the sanity check: the test itself would catch a domain import", () => {
    expect(FORBIDDEN.some((re) => re.test('import { X } from "@/domains/household/keys";'))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('import { X } from "@/domains";'))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('import { X } from "@/model/domain";'))).toBe(false);
  });
});
