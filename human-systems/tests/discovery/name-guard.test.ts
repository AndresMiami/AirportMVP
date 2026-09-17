/**
 * Review finding (Astra, 2026-09-17): the engine's language guard checked
 * its finished sentences with the person's variable names inside them, so
 * a variable named "Improved cash flow" made Explore throw. The guard now
 * polices only the engine's own words: names and units are masked first.
 */
import { describe, expect, it } from "vitest";
import { containsForbiddenPhrase, contextSubjectsFor, crossContext } from "@/discovery";
import { CC_DOMAIN, CC_PATTERN, ccSystem } from "../helpers/cross-context-fixture";

const rename = (id: string, name: string) => {
  const m = ccSystem();
  return { ...m, variables: m.variables.map((v) => (v.id === id ? { ...v, name } : v)) };
};

describe("a person's variable name never trips the engine's language guard", () => {
  it("'Improved cash flow' as a context condition, and as the pattern variable, both compare normally", () => {
    for (const id of ["buffer", "income_stability"]) {
      const m = rename(id, "Improved cash flow");
      const r = crossContext(m, CC_PATTERN, { contextSubjectIds: contextSubjectsFor(m, CC_PATTERN, CC_DOMAIN) });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.statements.join("\n")).toContain("Improved cash flow");
    }
    const weakened = rename("buffer", "Weakened structure causes");
    expect(crossContext(weakened, CC_PATTERN, { contextSubjectIds: contextSubjectsFor(weakened, CC_PATTERN, CC_DOMAIN) }).ok).toBe(true);
  });
  it("the guard still catches the engine's own wording", () => {
    expect(containsForbiddenPhrase("this condition causes the pattern")).toBe("causes");
    expect(containsForbiddenPhrase("the buffer was recorded at 2 u")).toBeNull();
  });
});
