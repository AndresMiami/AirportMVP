/**
 * STEP 5B — the deterministic AI context builder. Same model, task and
 * selection -> the same context and hash at any clock time; a relevant
 * record changes the hash; updatedAt does not; other subjects are excluded;
 * the Explore task reuses the deterministic pattern scope and comparison;
 * carried-forward, explicit-unknown and ambiguous values are said as such
 * and never as zero; notes, the ledger and drafts are never included.
 * Neutral domain; every household module mocked to throw.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AI_TASKS, AiContextError, TASK_POLICIES, buildAiContext, contentHash, hashedContent, refId, type ContextItem } from "@/ai/context";
import { contextSubjectsFor, crossContext } from "@/discovery/cross-context";
import { domainRegistry } from "@/model/domain";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";
import { CC_C, CC_DATE, CC_DOMAIN, CC_PATTERN, ccEntry, ccSystem, ccVariable } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains/index", armed("@/domains/index"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

const NOW = "2026-09-16T12:00:00.000Z";
const LATER = "2027-01-01T00:00:00.000Z";

/** The recurrence fixture plus notes, a hypothesis and an ambiguous record. */
function system(): SystemModel {
  let m = ccSystem();
  m = { ...m, variables: m.variables.map((v) => (v.id === "buffer" ? { ...v, notes: "SECRET NOTE about buffer" } : v)) };
  m = M.addHypothesis(m, { id: "hyp_a", statement: "A working hypothesis", subjectId: "p1" });
  m = M.addObservation(m, { id: "obs_p1", statement: "Part one said something", sourceType: "self_reported", confidence: 0.6, subjectId: "p1", notes: "SECRET NOTE about obs" });
  // ambiguous: two active records at the same start with different values
  const amb = ccVariable("ambiguous_z", "p1", [ccEntry(1, CC_DATE("2026-05-01")), ccEntry(2, CC_DATE("2026-05-01"))]);
  return { ...m, variables: [...m.variables, amb] };
}
const kinds = (items: ContextItem[]) => [...new Set(items.map((i) => i.kind))].sort();
const byKind = (items: ContextItem[], k: ContextItem["kind"]) => items.filter((i) => i.kind === k);

describe("context identity", () => {
  it("same model, task and selection -> identical items and hash at different clock times; builtAt is metadata only", () => {
    const m = system();
    const sel = { subjectId: "p1", userText: "My hours dropped from 40 to 15.", asOf: "2026-09-01" };
    const a = buildAiContext(m, "interpret_free_text", sel, { now: NOW });
    const b = buildAiContext(m, "interpret_free_text", sel, { now: LATER });
    expect(a.contextHash).toBe(b.contextHash);
    expect(a.items).toEqual(b.items);
    expect(hashedContent(a)).toBe(hashedContent(b));
    expect(a.builtAt).not.toBe(b.builtAt);
    expect(hashedContent(a)).not.toContain(a.builtAt);
    expect(a.contextHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.revisionHash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashedContent(a).length).toBeLessThan(JSON.stringify(m).length); // the model itself is never embedded
  });

  it("changing only updatedAt keeps the hash; changing a relevant record changes it; a different task changes it", () => {
    const m = system();
    const sel = { subjectId: "p1", userText: "text", asOf: "2026-09-01" };
    const base = buildAiContext(m, "interpret_free_text", sel, { now: NOW }).contextHash;
    expect(buildAiContext({ ...m, updatedAt: "2030-01-01T00:00:00.000Z" }, "interpret_free_text", sel, { now: NOW }).contextHash).toBe(base);
    const edited = M.updateObservation(m, "obs_p1", { statement: "Part one said something else" });
    expect(buildAiContext(edited, "interpret_free_text", sel, { now: NOW }).contextHash).not.toBe(base);
    expect(buildAiContext(m, "extract_statements", sel, { now: NOW }).contextHash).not.toBe(base);
    expect(buildAiContext(m, "interpret_free_text", { ...sel, userText: "other text" }, { now: NOW }).contextHash).not.toBe(base);
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});

describe("scope and allowlists", () => {
  it("a subject-scoped task includes the subject and the system and excludes the other subject with a reason; every task has an allowlist and nothing outside it appears", () => {
    const m = system();
    const ctx = buildAiContext(m, "interpret_free_text", { subjectId: "p1", userText: "t", asOf: "2026-09-01" }, { now: NOW });
    expect(ctx.manifest.subjectsIncluded).toEqual(["p1", "sys_cc"]);
    expect(ctx.manifest.subjectsExcluded).toEqual([{ id: "p2", reason: "another subject; not part of this task" }]);
    expect(ctx.items.some((i) => i.subjectId === "p2")).toBe(false);
    expect(ctx.items.some((i) => i.id === "variable:other_subject")).toBe(false);
    for (const k of kinds(ctx.items)) expect(TASK_POLICIES.interpret_free_text.kinds).toContain(k);
    for (const t of AI_TASKS) expect(TASK_POLICIES[t].kinds.length).toBeGreaterThan(0);
    expect(TASK_POLICIES.propose_observation_from_user_statement.kinds).toEqual(["system", "user_text"]);
    expect(TASK_POLICIES.extract_statements.kinds).not.toContain("value");
  });

  it("no task receives the whole model: relationships, constraints and hypotheses never reach text tasks; summarize_model sees only selected subjects", () => {
    const m = M.addRelationship(system(), { sourceVariableId: "buffer", targetVariableId: "health_cover", direction: "positive", strength: 0.5, lag: { value: 1, unit: "months" }, confidence: 0.6, sourceType: "self_reported", kind: "causal_hypothesis" });
    const text = buildAiContext(m, "interpret_free_text", { subjectId: "p1", userText: "t", asOf: "2026-09-01" }, { now: NOW });
    expect(kinds(text.items)).not.toContain("relationship");
    expect(kinds(text.items)).not.toContain("hypothesis");
    const sum = buildAiContext(m, "summarize_model", { asOf: "2026-09-01" }, { now: NOW });
    expect(sum.manifest.subjectsIncluded).toEqual(["sys_cc"]);
    expect(sum.items.some((i) => i.subjectId === "p1")).toBe(false);
    expect(byKind(sum.items, "relationship")).toHaveLength(1);
    expect(byKind(sum.items, "relationship")[0].payload.storedJudgments).toMatchObject({ strength: 0.5, confidence: 0.6, note: expect.stringMatching(/judgments.*not measurements/) });
    const sumP1 = buildAiContext(m, "summarize_model", { subjectIds: ["p1"], asOf: "2026-09-01" }, { now: NOW });
    expect(sumP1.manifest.subjectsIncluded).toEqual(["sys_cc", "p1"]);
    expect(sumP1.items.some((i) => i.id === "hypothesis:hyp_a")).toBe(true);
  });

  it("required inputs are refused, never defaulted: a text task without text, a pattern task without a pattern, an unknown subject", () => {
    const m = system();
    expect(() => buildAiContext(m, "extract_statements", {}, { now: NOW })).toThrow(AiContextError);
    expect(() => buildAiContext(m, "suggest_explanations_for_pattern", {}, { now: NOW })).toThrow(/needs a pattern/);
    expect(() => buildAiContext(m, "interpret_free_text", { subjectId: "ghost", userText: "t" }, { now: NOW })).toThrow(/Unknown subject/);
    // "values as of" is content: a task that carries values refuses to default it from the clock
    expect(() => buildAiContext(m, "interpret_free_text", { subjectId: "p1", userText: "t" }, { now: NOW })).toThrow(/explicit "values as of"/);
    expect(() => buildAiContext(m, "extract_statements", { subjectId: "p1", userText: "t" }, { now: NOW })).not.toThrow();
  });
});

describe("provenance of values", () => {
  it("recorded-here, carried-forward, explicit-unknown and ambiguous readings are said as such; unknown is never serialized as zero", () => {
    const m = system();
    // health_cover: recorded 1 on 2025-02-10 (asserted, one day). As of 2025-02-10 recorded_here; as of 2025-03-01 carried_forward.
    const at = (asOf: string) => byKind(buildAiContext(m, "summarize_model", { subjectIds: ["p1"], asOf }, { now: NOW }).items, "value");
    const hc0 = at("2025-02-10").find((i) => i.id.startsWith("value:health_cover@"))!;
    expect(hc0.payload).toMatchObject({ value: 1, basis: "recorded_here", resolution: "resolved" });
    const hc1 = at("2025-03-01").find((i) => i.id.startsWith("value:health_cover@"))!;
    expect(hc1.payload).toMatchObject({ value: 1, basis: "carried_forward", note: expect.stringMatching(/carries an earlier record forward/) });
    // health_cover recorded as unknown on 2026-01-10
    const hcU = at("2026-01-10").find((i) => i.id.startsWith("value:health_cover@"))!;
    expect(hcU.payload).toMatchObject({ value: null, basis: "explicit_unknown" });
    // ambiguous_z: two records at the same start disagree
    const amb = at("2026-06-01").find((i) => i.id.startsWith("value:ambiguous_z@"))!;
    expect(amb.payload).toMatchObject({ value: null, basis: "ambiguous", resolution: "ambiguous" });
    // before the first record: unknown, not 0
    const early = at("2024-01-01").find((i) => i.id.startsWith("value:health_cover@"))!;
    expect(early.payload).toMatchObject({ value: null, basis: "unknown", resolution: "before_first" });
    for (const it of [hcU, amb, early]) expect(JSON.stringify(it.payload)).not.toMatch(/"value":0(?![.\d])/);
  });

  it("stored confidences and judgments are labelled as judgments; a not-assessed hypothesis says so", () => {
    const m = system();
    const ctx = buildAiContext(m, "summarize_model", { subjectIds: ["p1"], asOf: "2026-09-01" }, { now: NOW });
    const v = byKind(ctx.items, "variable")[0];
    expect(v.payload.storedJudgments).toMatchObject({ note: expect.stringMatching(/not measurements, not facts/) });
    const val = byKind(ctx.items, "value").find((i) => (i.payload as { basis: string }).basis !== "unknown" && (i.payload as { basis: string }).basis !== "ambiguous")!;
    expect(val.payload.storedConfidence).toMatchObject({ note: expect.any(String), value: expect.any(Number) });
    expect(byKind(ctx.items, "hypothesis")[0].payload.confidence).toBe("not assessed");
  });

  it("the uncertainty task carries only what is uncertain: no recorded-here value, no fully computed derived", () => {
    const m = system();
    const ctx = buildAiContext(m, "suggest_questions_to_reduce_uncertainty", { subjectId: "p1", asOf: "2026-09-01" }, { now: NOW });
    expect(byKind(ctx.items, "value").every((i) => (i.payload as { basis: string }).basis !== "recorded_here")).toBe(true);
    expect(byKind(ctx.items, "value").some((i) => (i.payload as { basis: string }).basis === "ambiguous")).toBe(true);
  });
});

describe("the Explore task", () => {
  it("uses exactly the deterministic pattern scope and comparison: contextSubjectsFor decides the subjects and the cross_context item equals crossContext", () => {
    const m = system();
    const ctx = buildAiContext(m, "suggest_explanations_for_pattern", { pattern: CC_PATTERN }, { now: NOW });
    expect(ctx.manifest.subjectsIncluded).toEqual(contextSubjectsFor(m, CC_PATTERN, CC_DOMAIN));
    expect(ctx.manifest.subjectsExcluded).toEqual([{ id: "p2", reason: "outside the pattern's deterministic Explore context scope" }]);
    const cc = byKind(ctx.items, "cross_context")[0];
    const direct = crossContext(m, CC_PATTERN, { contextSubjectIds: contextSubjectsFor(m, CC_PATTERN, CC_DOMAIN) });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect((cc.payload.result as { groups: unknown }).groups).toEqual(direct.groups);
    expect((cc.payload.result as { conditions: unknown[] }).conditions).toEqual(direct.conditions);
    expect(cc.id).toBe(refId({ kind: "cross_context", pattern: CC_PATTERN }));
    expect(byKind(ctx.items, "pattern")[0].payload).toMatchObject({ repeatedValue: 5, occurrenceTimes: CC_PATTERN.occurrenceTimes });
    expect(byKind(ctx.items, "catalogue_prompt").map((i) => i.payload.question)).toEqual(CC_DOMAIN.explanationCatalogue!.prompts.map((p) => p.question));
    // observations and events enter only when explicitly selected
    expect(byKind(ctx.items, "observation")).toEqual([]);
    const withObs = buildAiContext(m, "suggest_explanations_for_pattern", { pattern: CC_PATTERN, observationIds: ["obs_p1", "obs_unrelated"] }, { now: NOW });
    expect(byKind(withObs.items, "observation").map((i) => i.id)).toEqual(["observation:obs_p1"]); // obs_unrelated is p2's
    // a changed contrast reading changes the hash (the comparison is content)
    const b = m.variables.find((v) => v.id === "buffer")!;
    const changed = { ...m, variables: m.variables.map((v) => (v.id === "buffer" ? { ...v, values: b.values.map((e) => (e.valid.start === CC_C[1] ? { ...e, value: 1.5 } : e)) } : v)) };
    expect(buildAiContext(changed, "suggest_explanations_for_pattern", { pattern: CC_PATTERN }, { now: NOW }).contextHash).not.toBe(ctx.contextHash);
  });
});

describe("privacy manifest", () => {
  it("notes, evidence text, superseded entries, the ledger and browser drafts are never included; the manifest says so; sensitive items need explicit inclusion", () => {
    const m = system();
    const ctx = buildAiContext(m, "summarize_model", { subjectIds: ["p1"], asOf: "2026-09-01" }, { now: NOW });
    const text = hashedContent(ctx);
    expect(text).not.toContain("SECRET NOTE");
    expect(text).not.toContain("proposals");
    expect(text).not.toContain("human-systems.explore-drafts");
    expect(ctx.manifest.exclusions).toEqual(expect.arrayContaining([expect.stringMatching(/notes fields/), expect.stringMatching(/proposal ledger/), expect.stringMatching(/browser drafts/), expect.stringMatching(/superseded and retracted/)]));
    expect(ctx.manifest.approxChars).toBe(text.length);
    // domain-configured sensitivity
    const sensitiveDomain = { ...CC_DOMAIN, aiContext: { sensitive: { variableKeys: ["health_cover"], itemKinds: ["hypothesis"] } } };
    domainRegistry.register({ ...sensitiveDomain, version: 9 });
    const m9 = { ...m, domainDefinitionVersion: 9 };
    const hidden = buildAiContext(m9, "summarize_model", { subjectIds: ["p1"], asOf: "2026-09-01" }, { now: NOW });
    expect(hidden.items.some((i) => i.id.startsWith("variable:health_cover") || i.id.startsWith("value:health_cover"))).toBe(false);
    expect(hidden.items.some((i) => i.kind === "hypothesis")).toBe(false);
    expect(hidden.manifest.sensitiveExcluded).toEqual(expect.arrayContaining(["variable:health_cover", "hypothesis:hyp_a"]));
    const shown = buildAiContext(m9, "summarize_model", { subjectIds: ["p1"], asOf: "2026-09-01", includeSensitive: true }, { now: NOW });
    expect(shown.items.some((i) => i.id === "variable:health_cover")).toBe(true);
    expect(shown.manifest.sensitiveExcluded).toEqual([]);
    expect(shown.contextHash).not.toBe(hidden.contextHash);
  });
});

describe("source pins", () => {
  it("the legacy /ai page has no mutation, apply, replaceModel or proposal-creation path, and is labelled read-only", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/ai/page.tsx"), "utf8");
    expect(src).not.toMatch(/@\/services\/mutations/);
    expect(src).not.toMatch(/\bapply\b\s*[(,}]/);
    expect(src).not.toMatch(/replaceModel|updateVariable|addApproved|ai_inferred/);
    expect(src).not.toMatch(/proposals\.create|ProposalService/);
    expect(src).toMatch(/LEGACY, READ-ONLY/);
    expect(src).toMatch(/What would be sent to AI/);
  });
  it("the context builder is pure engine code: no React, no kernel, no household, no network", () => {
    const src = readFileSync(path.join(process.cwd(), "src/ai/context.ts"), "utf8");
    expect(src).not.toMatch(/from "react"|@\/kernel|@\/domains|fetch\(|XMLHttpRequest|@\/repositories|localStorage/);
  });
});
