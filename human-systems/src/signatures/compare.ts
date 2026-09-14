/**
 * Comparing snapshots over time (assumption A23).
 *  - "what changed": dimensions whose normalized value moved by at least
 *    the change threshold between two snapshots;
 *  - "what stayed the same": dimensions known in both whose value moved
 *    less than the threshold — the persistent conditions the theory is
 *    interested in;
 *  - persistence indicators over MANY snapshots, at dimension and
 *    variable level, with the count of other things that changed in the
 *    same span, so persistence-amid-change is visible;
 *  - relationships that reappear across snapshots. Reappearance is a
 *    pattern, never a demonstration of causation.
 */
import type { StructuralSignature, VariableSnapshotItem } from "@/types/signature";

export const CHANGE_THRESHOLD = 0.1;
export const CONFIDENCE_CHANGE_THRESHOLD = 0.1;

export type ChangeClass =
  | "improved"
  | "weakened"
  | "persistent"
  | "became_known"
  | "became_unknown"
  | "unknown_both";

export interface DimensionChange {
  dimensionId: string;
  name: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  classification: ChangeClass;
  bandBefore: string;
  bandAfter: string;
  confidenceBefore: number;
  confidenceAfter: number;
  confidenceDelta: number;
}

export interface VariableChange {
  variableId: string;
  name: string;
  unit: string;
  changeSpeed: "fast" | "slow";
  before: number | null;
  after: number | null;
  delta: number | null;
  /** Normalised movement (reference range when both have one, else relative). */
  movement: number | null;
  classification: ChangeClass;
}

export interface RelationshipPresence {
  key: string;
  sourceName: string;
  targetName: string;
  direction: "positive" | "negative";
  inBefore: boolean;
  inAfter: boolean;
}

export interface SignatureComparison {
  before: { id: string; label?: string; createdAt: string };
  after: { id: string; label?: string; createdAt: string };
  changeThreshold: number;
  dimensions: DimensionChange[];
  changed: DimensionChange[];
  persistent: DimensionChange[];
  unknownInvolved: DimensionChange[];
  confidenceImproved: DimensionChange[];
  confidenceWeakened: DimensionChange[];
  variables: VariableChange[];
  variablesChanged: VariableChange[];
  variablesPersistent: VariableChange[];
  relationships: { kept: RelationshipPresence[]; added: RelationshipPresence[]; removed: RelationshipPresence[] };
  completenessDelta: number;
}

function classify(before: number | null, after: number | null, threshold: number): ChangeClass {
  if (before === null && after === null) return "unknown_both";
  if (before === null) return "became_known";
  if (after === null) return "became_unknown";
  const d = after - before;
  if (Math.abs(d) < threshold) return "persistent";
  return d > 0 ? "improved" : "weakened";
}

export function compareSignatures(
  before: StructuralSignature,
  after: StructuralSignature,
  options: { changeThreshold?: number } = {},
): SignatureComparison {
  const threshold = options.changeThreshold ?? CHANGE_THRESHOLD;
  const afterById = new Map(after.dimensions.map((d) => [d.dimensionId, d]));
  const dimensions: DimensionChange[] = before.dimensions.map((b) => {
    const a = afterById.get(b.dimensionId);
    const bv = b.normalizedValue;
    const av = a?.normalizedValue ?? null;
    return {
      dimensionId: b.dimensionId,
      name: b.name,
      before: bv,
      after: av,
      delta: bv === null || av === null ? null : av - bv,
      classification: classify(bv, av, threshold),
      bandBefore: b.bandState,
      bandAfter: a?.bandState ?? "unknown",
      confidenceBefore: b.confidence,
      confidenceAfter: a?.confidence ?? 0,
      confidenceDelta: (a?.confidence ?? 0) - b.confidence,
    };
  });
  for (const a of after.dimensions) {
    if (!before.dimensions.some((b) => b.dimensionId === a.dimensionId)) {
      dimensions.push({
        dimensionId: a.dimensionId,
        name: a.name,
        before: null,
        after: a.normalizedValue,
        delta: null,
        classification: a.normalizedValue === null ? "unknown_both" : "became_known",
        bandBefore: "unknown",
        bandAfter: a.bandState,
        confidenceBefore: 0,
        confidenceAfter: a.confidence,
        confidenceDelta: a.confidence,
      });
    }
  }
  const byAbsDelta = (x: DimensionChange, y: DimensionChange) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0);

  const variables = compareVariables(before.variableSnapshot, after.variableSnapshot, threshold);

  const keyOf = (r: { sourceVariableId: string; targetVariableId: string; direction: string }) =>
    `${r.sourceVariableId}>${r.targetVariableId}:${r.direction}`;
  const bEdges = new Map(before.relationshipSnapshot.filter((r) => r.enabled).map((r) => [keyOf(r), r]));
  const aEdges = new Map(after.relationshipSnapshot.filter((r) => r.enabled).map((r) => [keyOf(r), r]));
  const presence = (key: string, r: { sourceName: string; targetName: string; direction: "positive" | "negative" }): RelationshipPresence => ({
    key,
    sourceName: r.sourceName,
    targetName: r.targetName,
    direction: r.direction,
    inBefore: bEdges.has(key),
    inAfter: aEdges.has(key),
  });
  const kept: RelationshipPresence[] = [];
  const removed: RelationshipPresence[] = [];
  const added: RelationshipPresence[] = [];
  for (const [k, r] of bEdges) (aEdges.has(k) ? kept : removed).push(presence(k, r));
  for (const [k, r] of aEdges) if (!bEdges.has(k)) added.push(presence(k, r));

  return {
    before: { id: before.id, label: before.label, createdAt: before.createdAt },
    after: { id: after.id, label: after.label, createdAt: after.createdAt },
    changeThreshold: threshold,
    dimensions,
    changed: dimensions.filter((d) => d.classification === "improved" || d.classification === "weakened").sort(byAbsDelta),
    persistent: dimensions.filter((d) => d.classification === "persistent"),
    unknownInvolved: dimensions.filter((d) => d.classification.includes("unknown") || d.classification.includes("became")),
    confidenceImproved: dimensions.filter((d) => d.confidenceDelta >= CONFIDENCE_CHANGE_THRESHOLD),
    confidenceWeakened: dimensions.filter((d) => d.confidenceDelta <= -CONFIDENCE_CHANGE_THRESHOLD),
    variables,
    variablesChanged: variables.filter((v) => v.classification === "improved" || v.classification === "weakened"),
    variablesPersistent: variables.filter((v) => v.classification === "persistent"),
    relationships: { kept, added, removed },
    completenessDelta: after.completeness - before.completeness,
  };
}

/** Movement between two raw values on a 0..1 scale: reference-range based
 *  when both snapshots carry a normalised value, else relative change. */
export function variableMovement(b: VariableSnapshotItem, a: VariableSnapshotItem): number | null {
  if (b.currentValue === null || a.currentValue === null) return null;
  if (b.normalized !== null && a.normalized !== null) return a.normalized - b.normalized;
  const scale = Math.max(Math.abs(b.currentValue), Math.abs(a.currentValue));
  if (scale < 1e-9) return 0;
  return (a.currentValue - b.currentValue) / scale;
}

export function compareVariables(
  before: readonly VariableSnapshotItem[],
  after: readonly VariableSnapshotItem[],
  threshold: number,
): VariableChange[] {
  const afterById = new Map(after.map((v) => [v.id, v]));
  return before
    .map((b) => {
      const a = afterById.get(b.id);
      if (!a) return null;
      const movement = variableMovement(b, a);
      let classification: ChangeClass;
      if (b.currentValue === null && a.currentValue === null) classification = "unknown_both";
      else if (b.currentValue === null) classification = "became_known";
      else if (a.currentValue === null) classification = "became_unknown";
      else if (Math.abs(movement ?? 0) < threshold) classification = "persistent";
      else classification = (movement ?? 0) > 0 ? "improved" : "weakened";
      return {
        variableId: b.id,
        name: b.name,
        unit: b.unit,
        changeSpeed: b.changeSpeed,
        before: b.currentValue,
        after: a.currentValue,
        delta: b.currentValue === null || a.currentValue === null ? null : a.currentValue - b.currentValue,
        movement,
        classification,
      };
    })
    .filter((x): x is VariableChange => x !== null);
}

/* ------------------------------------------------------------------ */
/* Persistence over many snapshots                                     */
/* ------------------------------------------------------------------ */

export interface PersistenceIndicator {
  level: "dimension" | "variable";
  id: string;
  name: string;
  snapshotsTotal: number;
  snapshotsKnown: number;
  /** max - min of the normalised value over the known snapshots. */
  range: number | null;
  mean: number | null;
  /** Known in at least two snapshots and range below the threshold. */
  persistent: boolean;
  /** How many OTHER items at the same level changed materially over the
   *  same span (first known -> last known). */
  othersChanged: number;
  values: { snapshotId: string; label?: string; createdAt: string; value: number | null }[];
  statement: string;
}

export function persistenceIndicators(
  snapshots: readonly StructuralSignature[],
  options: { changeThreshold?: number; mode?: "current" | "desired" } = {},
): PersistenceIndicator[] {
  const threshold = options.changeThreshold ?? CHANGE_THRESHOLD;
  const mode = options.mode ?? "current";
  const ordered = [...snapshots].filter((s) => s.mode === mode).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (ordered.length === 0) return [];

  const dimSeries = new Map<string, { name: string; values: PersistenceIndicator["values"] }>();
  const varSeries = new Map<string, { name: string; values: PersistenceIndicator["values"] }>();
  for (const s of ordered) {
    for (const d of s.dimensions) {
      if (!dimSeries.has(d.dimensionId)) dimSeries.set(d.dimensionId, { name: d.name, values: [] });
      dimSeries.get(d.dimensionId)!.values.push({ snapshotId: s.id, label: s.label, createdAt: s.createdAt, value: d.normalizedValue });
    }
    for (const v of s.variableSnapshot) {
      if (!varSeries.has(v.id)) varSeries.set(v.id, { name: v.name, values: [] });
      varSeries.get(v.id)!.values.push({ snapshotId: s.id, label: s.label, createdAt: s.createdAt, value: v.normalized });
    }
  }

  const build = (level: PersistenceIndicator["level"], series: Map<string, { name: string; values: PersistenceIndicator["values"] }>) => {
    const items = [...series.entries()].map(([id, s]) => {
      const known = s.values.filter((v) => v.value !== null).map((v) => v.value as number);
      const range = known.length >= 2 ? Math.max(...known) - Math.min(...known) : null;
      const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
      return { id, name: s.name, values: s.values, known, range, mean };
    });
    const changedIds = new Set(items.filter((i) => i.range !== null && i.range >= threshold).map((i) => i.id));
    return items.map((i): PersistenceIndicator => {
      const persistent = i.range !== null && i.range < threshold;
      const othersChanged = [...changedIds].filter((c) => c !== i.id).length;
      let statement: string;
      if (i.known.length < 2) statement = `${i.name}: known in ${i.known.length} of ${ordered.length} snapshots; not enough to judge persistence.`;
      else if (persistent)
        statement = `${i.name} appears structurally persistent across ${i.known.length} snapshots (range ${i.range!.toFixed(2)})${othersChanged > 0 ? ` while ${othersChanged} other ${level === "dimension" ? "dimensions" : "variables"} changed` : ""}. This pattern has appeared repeatedly; it is not a demonstration of cause.`;
      else statement = `${i.name} moved by ${i.range!.toFixed(2)} across ${i.known.length} snapshots.`;
      return {
        level,
        id: i.id,
        name: i.name,
        snapshotsTotal: ordered.length,
        snapshotsKnown: i.known.length,
        range: i.range,
        mean: i.mean,
        persistent,
        othersChanged,
        values: i.values,
        statement,
      };
    });
  };

  return [...build("dimension", dimSeries), ...build("variable", varSeries)];
}

export interface RecurringRelationship {
  key: string;
  sourceName: string;
  targetName: string;
  direction: "positive" | "negative";
  appearances: number;
  snapshotsTotal: number;
  meanStrength: number;
  statement: string;
}

/** Relationships present (enabled) in several snapshots. */
export function recurringRelationships(snapshots: readonly StructuralSignature[]): RecurringRelationship[] {
  const total = snapshots.length;
  const acc = new Map<string, { sourceName: string; targetName: string; direction: "positive" | "negative"; strengths: number[] }>();
  for (const s of snapshots) {
    const seenHere = new Set<string>();
    for (const r of s.relationshipSnapshot) {
      if (!r.enabled) continue;
      const key = `${r.sourceVariableId}>${r.targetVariableId}:${r.direction}`;
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      if (!acc.has(key)) acc.set(key, { sourceName: r.sourceName, targetName: r.targetName, direction: r.direction, strengths: [] });
      acc.get(key)!.strengths.push(r.strength);
    }
  }
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      sourceName: v.sourceName,
      targetName: v.targetName,
      direction: v.direction,
      appearances: v.strengths.length,
      snapshotsTotal: total,
      meanStrength: v.strengths.reduce((a, b) => a + b, 0) / v.strengths.length,
      statement: `${v.sourceName} → ${v.targetName} (${v.direction}) has appeared in ${v.strengths.length} of ${total} snapshots. A repeated pattern, not a demonstrated cause.`,
    }))
    .sort((a, b) => b.appearances - a.appearances || b.meanStrength - a.meanStrength || a.key.localeCompare(b.key));
}
