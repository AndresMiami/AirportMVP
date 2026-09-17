/**
 * MAP WORDING (Step 6E): the first layer of Map — "What seems connected?" —
 * in ordinary language over the UNCHANGED evaluated relationships and
 * detected loops. Presentation only: every label maps the exact stored
 * enum, every sentence respects the stored direction, nothing is ranked,
 * inferred or recomputed, and "causes" never appears except to name a
 * recorded causal HYPOTHESIS as a hypothesis. Pure; no React; no domain.
 */
import type { EvaluatedLoop } from "@/model/evaluate";
import type { Relationship, RelationshipKind } from "@/types";

/** Human labels for the exact stored relationship kinds. The enum is untouched. */
export const KIND_LABELS: Record<RelationshipKind, string> = {
  causal_hypothesis: "Causal hypothesis",
  association: "Association",
  definitional: "Defined relationship",
  constraint: "Constraint",
  unclassified: "Not classified yet",
};

/** What each kind claims, in a sentence that never promotes it to fact. */
export const KIND_MEANINGS: Record<RelationshipKind, string> = {
  causal_hypothesis: "A recorded hypothesis that one influences the other. It is a working reading, not an established cause.",
  association: "Recorded as tending to occur together. Not a causal claim.",
  definitional: "True by definition or formula.",
  constraint: "One limits the other. Not a mechanism.",
  unclassified: "Not yet classified, so it takes no part in feedback patterns.",
};

export type NameOf = (variableId: string) => string;

/** "When Income stability rises, Cash reserves is recorded as tending to rise." — from the stored direction only. */
export function connectionSentence(r: Pick<Relationship, "sourceVariableId" | "targetVariableId" | "direction">, nameOf: NameOf): string {
  const verb = r.direction === "negative" ? "fall" : "rise";
  return `When ${nameOf(r.sourceVariableId)} rises, ${nameOf(r.targetVariableId)} is recorded as tending to ${verb}.`;
}

/** "Income stability → Cash reserves" */
export function connectionTitle(r: Pick<Relationship, "sourceVariableId" | "targetVariableId">, nameOf: NameOf): string {
  return `${nameOf(r.sourceVariableId)} → ${nameOf(r.targetVariableId)}`;
}

/** Why a connection is muted on the map, in a phrase; null when it is in use. */
export function connectionUseNote(r: Pick<Relationship, "enabled" | "participatesInDynamics" | "kind">): string | null {
  if (!r.enabled) return "Switched off: kept for the record, not used in feedback patterns.";
  if (!r.participatesInDynamics) return r.kind === "unclassified" ? "Not classified yet, so not used in feedback patterns." : `${KIND_LABELS[r.kind]}: not used in feedback patterns.`;
  return null;
}

/** "Reinforcing feedback pattern" / "Balancing feedback pattern" — the engine's polarity, untouched. */
export function patternLabel(polarity: EvaluatedLoop["polarity"]): string {
  return polarity === "reinforcing" ? "Reinforcing feedback pattern" : "Balancing feedback pattern";
}

/** "A → B → C → back to A" over the loop's own variable order. */
export function loopChainSentence(loop: Pick<EvaluatedLoop, "variableIds">, nameOf: NameOf): string {
  const names = loop.variableIds.map(nameOf);
  if (names.length === 0) return "";
  return `${names.join(" → ")} → back to ${names[0]}`;
}

/** The compact notice for connections still waiting to be classified; null when none. */
export function unclassifiedNotice(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 connection still needs classification, so it is not included in feedback patterns." : `${n} connections still need classification, so they are not included in feedback patterns.`;
}

/** The data-integrity warning for connections that reference a missing variable; null when none. Never hidden. */
export function orphanNotice(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 stored connection refers to a variable that no longer exists. It takes no part in the map until it is fixed or removed." : `${n} stored connections refer to variables that no longer exist. They take no part in the map until they are fixed or removed.`;
}

export interface MapCounts {
  stored: number;
  inDynamics: number;
  excluded: number;
  disabled: number;
  loops: number;
  unclassified: number;
}

/** The technical counts, read straight from the evaluation (nothing recounted). */
export function mapCounts(e: { allRelationships: readonly unknown[]; relationships: readonly unknown[]; nonDynamicsRelationshipCount: number; disabledRelationshipCount: number; unclassifiedRelationshipCount: number; loops: readonly unknown[] }): MapCounts {
  return { stored: e.allRelationships.length, inDynamics: e.relationships.length, excluded: e.nonDynamicsRelationshipCount, disabled: e.disabledRelationshipCount, loops: e.loops.length, unclassified: e.unclassifiedRelationshipCount };
}

export const MAP_EPISTEMIC = "Connections are recorded relationships and working hypotheses. The map does not prove that one thing causes another.";
export const MAP_READING_HINT = "Blue and amber arrows show the recorded direction of connections. Muted connections are not being used in feedback patterns.";
export const MAP_SWIPE_HINT = "Swipe sideways to explore the map.";
export const STRENGTH_NOTE = "Strength is a judgment the person entered (0 to 1), not an estimated effect. Nothing here measures one.";
