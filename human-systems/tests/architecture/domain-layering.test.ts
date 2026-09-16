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

  /**
   * CHECKPOINT 3: household knowledge lives ONLY in explicit application /
   * feature files. Everything else under src — engine, services,
   * repositories, ai, generic components and generic screens — imports no
   * household module, no sample, no bootstrap and no feature module.
   */
  const HOUSEHOLD_SOURCES = [/from\s+["']@\/domains\/household/, /from\s+["']@\/domains["']/, /from\s+["']@\/domains\/index["']/, /from\s+["'].*\/household\//, /from\s+["']@\/data\/sample-household["']/, /from\s+["']@\/bootstrap\//, /from\s+["']@\/features\//];
  /** The documented exceptions: application configuration, the household
   *  feature, the sample fixture, and the ONE household feature route. */
  const HOUSEHOLD_APPLICATION_FILES = new Set([
    "domains/index.ts", // registers the built-in domains (bootstrap)
    "data/sample-household.ts", // the fictional sample IS household data
    "bootstrap/household-app.ts", // application configuration: seed + default domain
    "features/household/income.ts", // household feature wrappers
    "app/income/page.tsx", // the household collection route (declared by the pack via `route`)
    "components/model-provider.tsx", // composition root: injects the bootstrap into the generic service
  ]);
  const ALLOWED_IMPORTS: Record<string, RegExp[]> = {
    // the composition root may import the bootstrap and nothing else household-specific
    "components/model-provider.tsx": [/from\s+["']@\/bootstrap\/household-app["']/],
  };

  it("no generic module imports household, sample, bootstrap or feature code (explicit application files excepted)", () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = path.relative(root, file);
      if (rel.startsWith("domains/household/") || rel.startsWith("features/household/") || rel === "bootstrap/household-app.ts" || rel === "data/sample-household.ts" || rel === "domains/index.ts" || rel === "app/income/page.tsx") continue;
      const src = readFileSync(file, "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[0]);
      for (const imp of imports) {
        if (!HOUSEHOLD_SOURCES.some((re) => re.test(imp))) continue;
        if ((ALLOWED_IMPORTS[rel] ?? []).some((re) => re.test(imp))) continue;
        offenders.push(`${rel} -> ${imp}`);
      }
    }
    expect(offenders).toEqual([]);
    // and the exception list is exactly the set of files that DO import household code
    const householdImporters = walk(root)
      .map((f) => path.relative(root, f))
      .filter((rel) => !rel.startsWith("domains/household/") && !rel.startsWith("features/household/"))
      .filter((rel) => HOUSEHOLD_SOURCES.some((re) => re.test(readFileSync(path.join(root, rel), "utf8"))))
      .sort();
    expect(householdImporters).toEqual([...HOUSEHOLD_APPLICATION_FILES].filter((f) => !f.startsWith("features/")).sort());
  });

  it("engine, services, repositories and ai have ZERO household, sample, bootstrap or feature imports", () => {
    const offenders: string[] = [];
    for (const d of ["types", "domain", "calculations", "model", "scenarios", "signatures", "repositories", "services", "ai"]) {
      for (const file of walk(path.join(root, d))) {
        const src = readFileSync(file, "utf8");
        const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[0]);
        for (const imp of imports) if (HOUSEHOLD_SOURCES.some((re) => re.test(imp))) offenders.push(`${path.relative(root, file)} -> ${imp}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("features and bootstrap point upward only: the engine never imports them, and the household feature never imports a screen", () => {
    const featureSrc = readFileSync(path.join(root, "features/household/income.ts"), "utf8");
    expect(/from\s+["']@\/(components|app)/.test(featureSrc)).toBe(false);
    const bootstrapSrc = readFileSync(path.join(root, "bootstrap/household-app.ts"), "utf8");
    expect(/from\s+["']@\/(components|app)/.test(bootstrapSrc)).toBe(false);
  });

  it("the sanity check: the test itself would catch a domain import", () => {
    expect(FORBIDDEN.some((re) => re.test('import { X } from "@/domains/household/keys";'))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('import { X } from "@/domains";'))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('import { X } from "@/model/domain";'))).toBe(false);
  });
});
