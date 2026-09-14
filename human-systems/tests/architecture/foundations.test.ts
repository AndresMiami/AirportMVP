/**
 * The foundation document (docs/FOUNDATIONS.md) must stay referenced from
 * the principal developer guidance, must keep its constitution, and the
 * codebase must not grow the fields the constitution forbids.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYSIS_SYSTEM_PROMPT } from "@/ai/prompt";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const CONSTITUTION = [
  "unknown != zero",
  "observation != interpretation",
  "association != causation",
  "immeasurable != nonexistent",
  "pattern != identity",
  "model != person",
  "optimization != meaning",
  "understanding vulnerability != permission to exploit it",
  "the model serves the person",
  "human judgment retains final authority",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

describe("foundations", () => {
  it("the foundation document exists and carries the three-part distinction, the measurement boundary and the constitution", () => {
    expect(existsSync(path.join(ROOT, "docs/FOUNDATIONS.md"))).toBe(true);
    const doc = read("docs/FOUNDATIONS.md");
    for (const heading of [
      "Part A — Empirical and mathematical foundations",
      "Part B — Modeling conventions and hypotheses",
      "Part C — Normative design principles",
      "Limits of quantification, human meaning, and sovereignty",
      "Part F — Backend constitution",
    ]) {
      expect(doc, heading).toContain(heading);
    }
    for (const line of CONSTITUTION) expect(doc, line).toContain(line);
    // the measurement boundary's three classes
    for (const cls of ["Measurable / estimable", "Interpretive", "Human meaning"]) expect(doc).toContain(cls);
  });

  it("the principal developer guidance references the foundation", () => {
    for (const file of ["CLAUDE.md", "README.md", "docs/EDITING-CONTRACT.md", "docs/SCHEMA-V3-PROPOSAL.md", "src/domain/assumptions.ts"]) {
      expect(read(file), file).toContain("docs/FOUNDATIONS.md");
    }
    // CLAUDE.md carries the constitution verbatim so it is in every session's context
    const claude = read("CLAUDE.md");
    for (const line of CONSTITUTION) expect(claude, line).toContain(line);
  });

  it("the AI prompt keeps human meaning and intuition qualitative", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("HUMAN MEANING");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("Never classify an intuition");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("never the person");
  });

  it("no schema or domain declares a numeric field or variable for meaning, spirituality, intuition, faith or a personality type", () => {
    const forbidden = /(meaning|spiritual|intuition|faith|love|dignity|grief|purpose)(Score|Index|Weight|Value|Level)\b|personalityType|behaviou?ralCode|errorCode|lifeScore|successProbability/i;
    const offenders: string[] = [];
    for (const dir of ["src/types", "src/domains", "src/model", "src/calculations", "src/signatures", "src/ai"]) {
      for (const file of walk(path.join(ROOT, dir))) {
        if (forbidden.test(readFileSync(file, "utf8"))) offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
