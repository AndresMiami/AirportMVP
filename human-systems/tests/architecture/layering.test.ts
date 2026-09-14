/**
 * The model layer must stay independent of the UI. This test fails if any
 * file under the pure directories imports React, Next, or a component.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PURE_DIRS = ["types", "domain", "calculations", "model", "scenarios", "ai", "data", "repositories", "services"];
const FORBIDDEN = [/from\s+["']react["']/, /from\s+["']react-dom/, /from\s+["']next\//, /from\s+["']@\/components/, /from\s+["']@\/app/];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

describe("layering", () => {
  it("pure directories do not import UI code", () => {
    const root = path.resolve(import.meta.dirname, "../../src");
    const offenders: string[] = [];
    for (const d of PURE_DIRS) {
      for (const file of walk(path.join(root, d))) {
        const src = readFileSync(file, "utf8");
        if (file.endsWith(".tsx") || FORBIDDEN.some((re) => re.test(src))) offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
