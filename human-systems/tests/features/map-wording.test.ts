/**
 * MAP WORDING AND SELECTION (6E): the first layer of Map over the
 * UNCHANGED evaluation. Presentation only — kind labels map the exact
 * enum, sentences follow the stored direction, loop chains are the
 * engine's own order and polarity, counts are read not recounted, and the
 * highlight rule is the original feedback map's. Neutral domain; household
 * mocked to throw.
 */
import { describe, expect, it, vi } from "vitest";
import { evaluateSystem } from "@/model/evaluate";
import { KIND_LABELS, KIND_MEANINGS, connectionSentence, connectionTitle, connectionUseNote, loopChainSentence, mapCounts, orphanNotice, patternLabel, unclassifiedNotice } from "@/features/map/wording";
import { connectionsOf, highlightFor } from "@/features/map/selection";
import * as M from "@/services/mutations";
import { RelationshipKindSchema } from "@/types";
import { ccSystem } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

const rel = (id: string, source: string, target: string, extra: Partial<Parameters<typeof M.addRelationship>[1]> = {}) => ({ id, sourceVariableId: source, targetVariableId: target, kind: "causal_hypothesis" as const, participatesInDynamics: true, direction: "positive" as const, strength: 0.6, lag: { value: 0, unit: "months" as const }, confidence: 0.7, sourceType: "self_reported" as const, evidence: [], explanation: "", notes: "", enabled: true, ...extra });

/** The neutral system with a two-edge loop, a negative edge, an unclassified edge and a disabled edge. */
function system() {
  let m = ccSystem();
  m = M.addRelationship(m, rel("r_ab", "income_stability", "buffer"));
  m = M.addRelationship(m, rel("r_ba", "buffer", "income_stability", { direction: "negative", lag: { value: 2, unit: "months" }, explanation: "A bigger buffer lets contracts be chosen more slowly." }));
  m = M.addRelationship(m, rel("r_un", "autonomy_pref", "work_arrangement", { kind: "unclassified", participatesInDynamics: false }));
  m = M.addRelationship(m, rel("r_off", "health_cover", "buffer", { enabled: false }));
  return m;
}

describe("wording over the stored enum and direction", () => {
  it("labels every stored kind (and only those) and never turns a hypothesis into a fact", () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...RelationshipKindSchema.options].sort());
    expect(Object.keys(KIND_MEANINGS).sort()).toEqual([...RelationshipKindSchema.options].sort());
    expect(KIND_LABELS).toEqual({ causal_hypothesis: "Causal hypothesis", association: "Association", definitional: "Defined relationship", constraint: "Constraint", unclassified: "Not classified yet" });
    for (const text of [...Object.values(KIND_LABELS), ...Object.values(KIND_MEANINGS)]) expect(text).not.toMatch(/\bcauses\b|proves|\bis the cause\b/);
    expect(KIND_MEANINGS.causal_hypothesis).toMatch(/hypothesis/);
    expect(KIND_MEANINGS.causal_hypothesis).toMatch(/not an established cause/); // named as a hypothesis, never as a fact
  });
  it("the connection sentence follows the stored direction; the use note explains a muted connection", () => {
    const name = (id: string) => ({ a: "Income stability", b: "Cash reserves" })[id] ?? id;
    expect(connectionSentence({ sourceVariableId: "a", targetVariableId: "b", direction: "positive" }, name)).toBe("When Income stability rises, Cash reserves is recorded as tending to rise.");
    expect(connectionSentence({ sourceVariableId: "a", targetVariableId: "b", direction: "negative" }, name)).toBe("When Income stability rises, Cash reserves is recorded as tending to fall.");
    expect(connectionTitle({ sourceVariableId: "a", targetVariableId: "b" }, name)).toBe("Income stability → Cash reserves");
    expect(connectionUseNote({ enabled: true, participatesInDynamics: true, kind: "causal_hypothesis" })).toBeNull();
    expect(connectionUseNote({ enabled: false, participatesInDynamics: true, kind: "causal_hypothesis" })).toMatch(/Switched off/);
    expect(connectionUseNote({ enabled: true, participatesInDynamics: false, kind: "unclassified" })).toMatch(/Not classified yet/);
    expect(connectionUseNote({ enabled: true, participatesInDynamics: false, kind: "association" })).toBe("Association: not used in feedback patterns.");
  });
  it("notices count exactly and vanish at zero", () => {
    expect(unclassifiedNotice(0)).toBeNull();
    expect(unclassifiedNotice(1)).toBe("1 connection still needs classification, so it is not included in feedback patterns.");
    expect(unclassifiedNotice(3)).toBe("3 connections still need classification, so they are not included in feedback patterns.");
    expect(orphanNotice(0)).toBeNull();
    expect(orphanNotice(2)).toMatch(/^2 stored connections refer to variables that no longer exist/);
  });
});

describe("over the unchanged evaluation", () => {
  const m = system();
  const e = evaluateSystem(m);
  it("counts are read from the evaluation, loops are the engine's (ids, polarity, edges, variables), and the chain follows the loop's own order", () => {
    expect(mapCounts(e)).toEqual({ stored: 4, inDynamics: 2, excluded: 1, disabled: 1, loops: e.loops.length, unclassified: 1 });
    expect(e.loops.length).toBe(1);
    const l = e.loops[0];
    expect(l.edgeIds.sort()).toEqual(["r_ab", "r_ba"]);
    expect(l.polarity).toBe("balancing"); // one negative edge
    expect(patternLabel(l.polarity)).toBe("Balancing feedback pattern");
    expect(patternLabel("reinforcing")).toBe("Reinforcing feedback pattern");
    const names = l.variableIds.map((id) => e.variableById.get(id)?.name ?? id);
    expect(loopChainSentence(l, (id) => e.variableById.get(id)?.name ?? id)).toBe(`${names.join(" → ")} → back to ${names[0]}`);
  });
  it("highlights exactly the original rule: a loop's own edges and variables; a variable's incident connections and endpoints; a selected connection with its endpoints", () => {
    const l = e.loops[0];
    const loopHl = highlightFor(e, { loopId: l.id, nodeId: null, edgeId: null });
    expect([...loopHl.edges].sort()).toEqual([...l.edgeIds].sort());
    expect([...loopHl.nodes].sort()).toEqual([...l.variableIds].sort());
    const nodeHl = highlightFor(e, { loopId: null, nodeId: "buffer", edgeId: null });
    expect([...nodeHl.edges].sort()).toEqual(["r_ab", "r_ba", "r_off"]);
    expect([...nodeHl.nodes].sort()).toEqual(["buffer", "health_cover", "income_stability"]);
    expect(connectionsOf(e.allRelationships, "buffer").map((r) => r.id)).toEqual(["r_ab", "r_ba", "r_off"]);
    const edgeHl = highlightFor(e, { loopId: null, nodeId: null, edgeId: "r_un" });
    expect([...edgeHl.edges]).toEqual(["r_un"]);
    expect([...edgeHl.nodes].sort()).toEqual(["autonomy_pref", "work_arrangement"]);
    // a loop selection wins over a node selection, exactly as before; an edited/selected edge is always added
    const both = highlightFor(e, { loopId: l.id, nodeId: "health_cover", edgeId: "r_un" });
    expect([...both.edges].sort()).toEqual([...l.edgeIds, "r_un"].sort());
    expect(highlightFor(e, { loopId: null, nodeId: null, edgeId: null })).toEqual({ edges: new Set(), nodes: new Set() });
  });
  it("the unclassified filter and orphan detection are the same predicates the page uses", () => {
    expect(e.allRelationships.filter((r) => r.kind === "unclassified").map((r) => r.id)).toEqual(["r_un"]);
    const withOrphan = { ...m, relationships: [...m.relationships, rel("r_ghost", "gone", "buffer")] };
    const e2 = evaluateSystem(withOrphan);
    const shown = new Set(e2.allRelationships.map((r) => r.id));
    expect(withOrphan.relationships.filter((r) => !shown.has(r.id)).map((r) => r.id)).toEqual(["r_ghost"]);
    expect(e2.loops.length).toBe(1); // an orphan never changes the loops
  });
});
