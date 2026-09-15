/**
 * The foundation document (docs/FOUNDATIONS.md) must stay referenced from
 * the principal developer guidance, must keep its constitution, and the
 * codebase must not grow the fields the constitution forbids.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYSIS_SYSTEM_PROMPT, buildSystemPrompt } from "@/ai/prompt";
import { HOUSEHOLD_DOMAIN } from "@/domains/household/definition";
import { categoryVocabulary } from "@/model/domain";

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
  "decision quality != outcome quality",
  "good outcome != good decision",
  "bad outcome != bad decision",
  "uncertainty != ignorance",
  "unknown != probability",
  "source != truth",
  "action != identity",
  "experiment failure != human failure",
  "preserving optionality has value",
  "the model serves the person",
  "human judgment retains final authority",
  "current != historical",
  "recordedAt != effectiveAt",
  "missing history != permission to backfill",
  "target change != state change",
  "derived != entered",
  "approximate time != exact time",
];

/** Prescriptive or probabilistic phrasing no screen, prompt or engine text may carry. */
const PRESCRIPTIVE = /\b(you should|you must|we recommend|the right choice|therefore (you|do)|% chance|percent chance|probability of success)\b/i;

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
      "Part G — Decision-making under uncertainty",
      "Part F — Backend constitution",
    ]) {
      expect(doc, heading).toContain(heading);
    }
    for (const line of CONSTITUTION) expect(doc, line).toContain(line);
    // the measurement boundary's three classes
    for (const cls of ["Measurable / estimable", "Interpretive", "Human meaning"]) expect(doc).toContain(cls);
    // Part G corrections: provenance is not truth; prescription is conditional, never authoritative
    expect(doc).toContain("NO AUTHORITATIVE PRESCRIPTION");
    expect(doc).toContain("records PROVENANCE, the origin of a value, never its truth");
    expect(doc).not.toMatch(/`measured`, `observed` are facts/);
  });

  it("the principal developer guidance references the foundation", () => {
    for (const file of ["CLAUDE.md", "README.md", "docs/EDITING-CONTRACT.md", "docs/SCHEMA-V3-PROPOSAL.md", "src/domain/assumptions.ts"]) {
      expect(read(file), file).toContain("docs/FOUNDATIONS.md");
    }
    // CLAUDE.md carries the constitution verbatim so it is in every session's context
    const claude = read("CLAUDE.md");
    for (const line of CONSTITUTION) expect(claude, line).toContain(line);
  });

  it("the AI prompt keeps human meaning and intuition qualitative and never prescribes or states odds", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("HUMAN MEANING");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("Never classify an intuition");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("never the person");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("You never issue an authoritative prescription");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("Only when the person explicitly asks for help choosing");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("A source type is provenance, not truth");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("You never state a probability");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("never judge a past decision by its outcome alone");
  });

  it("the generic AI constitution names no kind of system; domain vocabulary comes only from the pack's fragment", () => {
    const generic = buildSystemPrompt();
    expect(generic).not.toMatch(/household|person's|income|career|family|employ|salary|\bjob\b/i);
    expect(generic).toContain("Category vocabulary: event");
    expect(generic).not.toContain("person_fit");
    const household = buildSystemPrompt(HOUSEHOLD_DOMAIN, categoryVocabulary(HOUSEHOLD_DOMAIN));
    expect(household.startsWith(ANALYSIS_SYSTEM_PROMPT)).toBe(true);
    expect(household).toMatch(/income sources/);
    expect(household).toContain("person_fit (Values, preferences");
  });

  it("no screen, component, engine or domain text prescribes a choice or states odds of an outcome", () => {
    const offenders: string[] = [];
    for (const dir of ["src/app", "src/components", "src/model", "src/calculations", "src/scenarios", "src/signatures", "src/domains", "src/services"]) {
      for (const file of walk(path.join(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        const m = PRESCRIPTIVE.exec(src);
        if (m) offenders.push(`${path.relative(ROOT, file)}: "${m[0]}"`);
      }
    }
    expect(offenders).toEqual([]);
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
