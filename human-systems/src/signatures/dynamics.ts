/**
 * The dynamics half of a signature: what the relationship structure does,
 * derived from the ENABLED edges and detected loops. Never binary.
 */
import { networkInfluence } from "@/calculations/graph";
import type { EvaluatedLoop, EvaluatedSystem } from "@/model/evaluate";
import type { Relationship } from "@/types";
import type { DynamicsSignature, LoopSnapshotItem, RelationshipSnapshotItem } from "@/types/signature";

export const DYNAMICS_TOP_N = 5;

export function toRelationshipSnapshot(r: Relationship, evaluated: EvaluatedSystem): RelationshipSnapshotItem {
  return {
    id: r.id,
    sourceVariableId: r.sourceVariableId,
    targetVariableId: r.targetVariableId,
    sourceName: evaluated.variableById.get(r.sourceVariableId)?.name ?? r.sourceVariableId,
    targetName: evaluated.variableById.get(r.targetVariableId)?.name ?? r.targetVariableId,
    direction: r.direction,
    strength: r.strength,
    lag: r.lag,
    confidence: r.confidence,
    sourceType: r.sourceType,
    enabled: r.enabled,
  };
}

export function toLoopSnapshot(l: EvaluatedLoop): LoopSnapshotItem {
  return {
    id: l.id,
    name: l.annotation?.name ?? null,
    polarity: l.polarity,
    variableIds: l.variableIds,
    meanStrength: l.meanStrength,
    pressure: l.pressure,
    cycleTimeMonths: l.cycleTimeMonths,
    status: l.status,
    minConfidence: l.minConfidence,
  };
}

/** Weighted in-degree scaled 0..1 (max = 1). */
export function incomingInfluence(relationships: readonly Relationship[]): Map<string, number> {
  const raw = new Map<string, number>();
  for (const r of relationships) raw.set(r.targetVariableId, (raw.get(r.targetVariableId) ?? 0) + r.strength);
  const max = Math.max(0, ...raw.values());
  const out = new Map<string, number>();
  for (const [id, v] of raw) out.set(id, max > 0 ? v / max : 0);
  return out;
}

export function computeDynamicsSignature(evaluated: EvaluatedSystem, topN = DYNAMICS_TOP_N): DynamicsSignature {
  const edges = evaluated.relationships; // enabled only
  const outInf = networkInfluence(edges);
  const inInf = incomingInfluence(edges);
  const ids = new Set([...outInf.keys(), ...inInf.keys()]);
  const central = [...ids]
    .map((id) => {
      const o = outInf.get(id) ?? 0;
      const i = inInf.get(id) ?? 0;
      return { variableId: id, name: evaluated.variableById.get(id)?.name ?? id, outInfluence: o, inInfluence: i, centrality: (o + i) / 2 };
    })
    .sort((a, b) => b.centrality - a.centrality || a.variableId.localeCompare(b.variableId))
    .slice(0, topN);

  const byStrengthDesc = (a: Relationship, b: Relationship) => b.strength - a.strength || a.id.localeCompare(b.id);
  const snap = (r: Relationship) => toRelationshipSnapshot(r, evaluated);
  const loops = evaluated.loops.filter((l) => l.status !== "rejected");
  const byPressure = (a: EvaluatedLoop, b: EvaluatedLoop) => (b.pressure ?? -1) - (a.pressure ?? -1) || b.meanStrength - a.meanStrength;

  const confidences = edges.map((e) => e.confidence);
  const evidenced = edges.filter((e) => e.sourceType === "measured" || e.sourceType === "calculated").length;

  return {
    strongestReinforcingLoops: loops.filter((l) => l.polarity === "reinforcing").sort(byPressure).slice(0, topN).map(toLoopSnapshot),
    strongestBalancingLoops: loops.filter((l) => l.polarity === "balancing").sort(byPressure).slice(0, topN).map(toLoopSnapshot),
    highCentralityVariables: central,
    strongestIncomingInfluences: [...edges].sort(byStrengthDesc).slice(0, topN).map(snap),
    strongestOutgoingInfluences: [...edges]
      .sort((a, b) => (outInf.get(b.sourceVariableId) ?? 0) * b.strength - (outInf.get(a.sourceVariableId) ?? 0) * a.strength || a.id.localeCompare(b.id))
      .slice(0, topN)
      .map(snap),
    importantLags: [...edges]
      .map((e) => ({ e, months: lagMonths(e) }))
      .filter((x) => x.months > 0)
      .sort((a, b) => b.months - a.months || a.e.id.localeCompare(b.e.id))
      .slice(0, topN)
      .map((x) => snap(x.e)),
    relationshipConfidence: {
      count: edges.length,
      mean: confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : null,
      min: confidences.length ? Math.min(...confidences) : null,
      evidencedShare: edges.length ? evidenced / edges.length : null,
    },
    loopCounts: {
      reinforcing: evaluated.loops.filter((l) => l.polarity === "reinforcing").length,
      balancing: evaluated.loops.filter((l) => l.polarity === "balancing").length,
      accepted: evaluated.loops.filter((l) => l.status === "accepted").length,
      rejected: evaluated.loops.filter((l) => l.status === "rejected").length,
    },
  };
}

function lagMonths(r: Relationship): number {
  const per = { days: 1 / 30.4375, weeks: 7 / 30.4375, months: 1, years: 12 } as const;
  return r.lag.value * per[r.lag.unit];
}
