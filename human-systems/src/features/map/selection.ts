/**
 * MAP SELECTION (Step 6E): which nodes and connections the map highlights
 * for a selection — exactly the rule the original feedback map used. A
 * selected loop highlights its own edge ids and variable ids; a selected
 * variable highlights every relationship touching it and both endpoints;
 * a selected or edited connection is always added with its endpoints.
 * Pure; reads the evaluation only.
 */
import type { EvaluatedLoop } from "@/model/evaluate";
import type { Relationship } from "@/types";

export interface Highlight {
  edges: Set<string>;
  nodes: Set<string>;
}

export function highlightFor(
  e: { loops: readonly Pick<EvaluatedLoop, "id" | "edgeIds" | "variableIds">[]; allRelationships: readonly Pick<Relationship, "id" | "sourceVariableId" | "targetVariableId">[] },
  sel: { loopId: string | null; nodeId: string | null; edgeId: string | null },
): Highlight {
  const edges = new Set<string>();
  const nodes = new Set<string>();
  if (sel.loopId) {
    const l = e.loops.find((x) => x.id === sel.loopId);
    for (const id of l?.edgeIds ?? []) edges.add(id);
    for (const id of l?.variableIds ?? []) nodes.add(id);
  } else if (sel.nodeId) {
    nodes.add(sel.nodeId);
    for (const r of e.allRelationships) {
      if (r.sourceVariableId === sel.nodeId || r.targetVariableId === sel.nodeId) {
        edges.add(r.id);
        nodes.add(r.sourceVariableId);
        nodes.add(r.targetVariableId);
      }
    }
  }
  if (sel.edgeId) {
    const r = e.allRelationships.find((x) => x.id === sel.edgeId);
    if (r) {
      edges.add(r.id);
      nodes.add(r.sourceVariableId);
      nodes.add(r.targetVariableId);
    }
  }
  return { edges, nodes };
}

/** The relationships a selected variable is connected with, in stored order. */
export function connectionsOf(allRelationships: readonly Relationship[], variableId: string): Relationship[] {
  return allRelationships.filter((r) => r.sourceVariableId === variableId || r.targetVariableId === variableId);
}
