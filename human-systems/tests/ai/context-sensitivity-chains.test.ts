/**
 * Review finding (Astra, 2026-09-17): sensitivity used to stop one step
 * out. A calculation that read a sensitive variable was withheld, but a
 * second calculation reading the first one passed into the payload, and a
 * hypothesis supported by a withheld observation passed too. The closure
 * is now complete, and explicit inclusion still restores everything.
 */
import { describe, expect, it, vi } from "vitest";
import { buildAiContext, hashedContent } from "@/ai/context";
import { defaultDerivedVariable } from "@/model/derived";
import { domainRegistry, type DerivedDefinition } from "@/model/domain";
import * as M from "@/services/mutations";
import { CC_DOMAIN, ccSystem } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

const NOW = "2026-09-16T12:00:00.000Z";
const def = (key: string, name: string, inputs: DerivedDefinition["inputs"], derivedInputs: DerivedDefinition["derivedInputs"], compute: DerivedDefinition["compute"]): DerivedDefinition => ({ key, name, description: "test", unit: "u", category: "structure", changeSpeed: "slow", targetMode: "at_least", scope: "system", inputs, derivedInputs, collectionsRead: [], assumptionIds: [], compute });
const D_ONE = def("d_one", "First calculation", [{ key: "buffer", from: "system" }], [], (c) => c.value("buffer"));
const D_TWO = def("d_two", "Second calculation", [], [{ key: "d_one", from: "system" }], (c) => c.derived("d_one"));
const D_FREE = def("d_free", "Unrelated calculation", [{ key: "health_cover", from: "system" }], [], (c) => c.value("health_cover"));
if (!domainRegistry.get(CC_DOMAIN.id, 9)) domainRegistry.register({ ...CC_DOMAIN, version: 9, derived: [D_ONE, D_TWO, D_FREE], aiContext: { sensitive: { variableKeys: ["buffer"] } } });

function world() {
  let m = ccSystem();
  m = { ...m, domainDefinitionVersion: 9, variables: [...m.variables, defaultDerivedVariable(D_ONE, "sys_cc", "sys_cc"), defaultDerivedVariable(D_TWO, "sys_cc", "sys_cc"), defaultDerivedVariable(D_FREE, "sys_cc", "sys_cc")] };
  m = M.addObservation(m, { id: "obs_buf", statement: "Buffer note", sourceType: "self_reported", confidence: 0.5, subjectId: "p1", links: { variableIds: ["buffer"], relationshipIds: [], constraintIds: [], hypothesisIds: [] } });
  m = M.addHypothesis(m, { id: "hyp_obs", statement: "Supported by the buffer note", subjectId: "p1", supportingObservationIds: ["obs_buf"] });
  return m;
}
const leaks = (text: string) => /\bbuffer\b|First calculation|Second calculation|d_one|d_two|Buffer note|hyp_obs/.test(text);

describe("sensitivity closes over calculations and citations", () => {
  it("a calculation of a calculation of a sensitive variable is withheld; an unrelated calculation still passes", () => {
    const m = world();
    const ctx = buildAiContext(m, "interpret_free_text", { subjectId: m.id, userText: "A note.", asOf: "2026-09-01" }, { now: NOW });
    expect(leaks(hashedContent(ctx))).toBe(false);
    expect(ctx.items.some((i) => i.kind === "derived" && i.payload.variable === "Unrelated calculation")).toBe(true);
    expect(ctx.manifest.withheld).toEqual(expect.arrayContaining([expect.stringMatching(/“First calculation” withheld/), expect.stringMatching(/“Second calculation” withheld/)]));
  });
  it("a hypothesis supported by a withheld observation is withheld with it", () => {
    const m = world();
    const ctx = buildAiContext(m, "summarize_model", { subjectIds: ["p1"], asOf: "2026-09-01" }, { now: NOW });
    expect(leaks(hashedContent(ctx))).toBe(false);
    expect(ctx.items.some((i) => i.id === "hypothesis:hyp_obs")).toBe(false);
    expect(ctx.manifest.sensitiveExcluded).toEqual(expect.arrayContaining(["observation:obs_buf", "hypothesis:hyp_obs"]));
  });
  it("explicit inclusion restores the whole chain, unchanged", () => {
    const m = world();
    const ctx = buildAiContext(m, "summarize_model", { subjectIds: ["p1"], asOf: "2026-09-01", includeSensitive: true }, { now: NOW });
    expect(ctx.items.some((i) => i.id === "hypothesis:hyp_obs")).toBe(true);
    expect(ctx.items.some((i) => i.kind === "derived" && i.payload.variable === "Second calculation")).toBe(true);
    expect(ctx.manifest.sensitiveExcluded).toEqual([]);
  });
});
