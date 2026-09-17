/**
 * GOLDEN PARITY: the household domain must mean the same thing after the
 * domain-agnostic cleanup as before it. The fixture was captured from the
 * evaluated sample at the commit before any file moved (2026-09-15).
 * Regenerate ONLY when a household result is deliberately changed:
 *   WRITE_GOLDEN=1 npx vitest run tests/domains/household/parity.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { householdParityFingerprint } from "../../helpers/household-parity";

const GOLDEN = path.join(import.meta.dirname, "parity.golden.json");

describe("household parity", () => {
  it("the evaluated sample household means the same as the golden fixture", () => {
    // JSON round trip: the fixture is JSON, so undefined never counts as a value
    const actual = JSON.parse(JSON.stringify(householdParityFingerprint()));
    if (process.env.WRITE_GOLDEN === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(actual).toEqual(golden);
  });
});
