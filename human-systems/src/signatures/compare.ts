/**
 * Comparing two saved snapshots (assumption A23, a DISPLAY convention).
 *  - THE FACT comes first: same | different. "unchanged" = both known and
 *    exactly equal (no threshold); "changed" = both known and different,
 *    at ANY magnitude. changed != crossed the display threshold;
 *  - THE DISPLAY CONVENTION (A23) then sorts the different ones: "within
 *    threshold" = non-zero movement below 0.10 on the normalized scale;
 *    "increased" / "decreased" = movement at or above it — a direction,
 *    never an improvement or a weakening (that would need a declared
 *    normative direction). Neither grouping is persistence, structure,
 *    invariance or continuity;
 *  - variables: exact equality is reported as unchanged (no threshold);
 *    with a reference-range scale on both sides the threshold applies;
 *    without one only the raw difference is reported, never a scaled
 *    judgment;
 *  - relationships recorded in several snapshots: "recorded in k of n
 *    saved snapshots". Relationships are not historically versioned, so
 *    a recurrence across saved snapshots says nothing about the time in
 *    between and is never a demonstration of causation.
 * Series over MANY snapshots and over value HISTORIES belong to the
 * discovery layer (src/discovery, structural discovery checkpoint).
 */
import type { StructuralSignature, VariableSnapshotItem } from "@/types/signature";

export const CHANGE_THRESHOLD = 0.1;
export const CONFIDENCE_CHANGE_THRESHOLD = 0.1;

export type ChangeClass =
  /** moved by at least the threshold on the normalized scale (direction only) */
  | "increased"
  | "decreased"
  /** both known, moved less than the threshold on a defensible normalized scale (A23 display convention) */
  | "within_threshold"
  /** both known and exactly equal (no threshold involved) */
  | "unchanged"
  /** both known and different, but no normalized scale exists; only the raw difference is reported */
  | "differs_no_scale"
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
  /** Normalised movement on the reference-range scale when BOTH snapshots
   *  carry one; null otherwise (no comparability is invented). */
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
  /** The A23 display threshold behind the *AtOrAboveThreshold / *WithinThreshold groupings. */
  changeThreshold: number;
  dimensions: DimensionChange[];
  /* THE FACT: same | different. `changed` means the recorded values
   * differ (both known), whatever the size of the move. */
  /** Known in both and exactly equal (no threshold involved). */
  unchanged: DimensionChange[];
  /** Known in both and different, at any magnitude (within_threshold, increased, decreased). */
  changed: DimensionChange[];
  /* THE DISPLAY CONVENTION (A23) over the different ones. */
  /** Non-zero movement below the display threshold. */
  withinThreshold: DimensionChange[];
  /** increased / decreased: movement at or above the display threshold, largest first. */
  movedAtOrAboveThreshold: DimensionChange[];
  unknownInvolved: DimensionChange[];
  confidenceIncreased: DimensionChange[];
  confidenceDecreased: DimensionChange[];
  variables: VariableChange[];
  /** Exactly equal raw values in both snapshots (no threshold). */
  variablesUnchanged: VariableChange[];
  /** Different raw values at any magnitude: within_threshold, increased, decreased and differs_no_scale. */
  variablesChanged: VariableChange[];
  /** Non-zero scaled movement below the display threshold (A23). */
  variablesWithinThreshold: VariableChange[];
  /** increased / decreased: scaled movement at or above the display threshold. */
  variablesMovedAtOrAboveThreshold: VariableChange[];
  /** Different raw values with no scale to judge the size of the move. */
  variablesDifferNoScale: VariableChange[];
  relationships: { kept: RelationshipPresence[]; added: RelationshipPresence[]; removed: RelationshipPresence[] };
  completenessDelta: number;
}

/** Two normalized (0..1) values: direction of a move at or above the
 *  threshold, otherwise the within-threshold display grouping. */
function classify(before: number | null, after: number | null, threshold: number): ChangeClass {
  if (before === null && after === null) return "unknown_both";
  if (before === null) return "became_known";
  if (after === null) return "became_unknown";
  if (before === after) return "unchanged";
  const d = after - before;
  if (Math.abs(d) < threshold) return "within_threshold";
  return d > 0 ? "increased" : "decreased";
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
    unchanged: dimensions.filter((d) => d.classification === "unchanged"),
    changed: dimensions.filter((d) => d.classification === "within_threshold" || d.classification === "increased" || d.classification === "decreased").sort(byAbsDelta),
    withinThreshold: dimensions.filter((d) => d.classification === "within_threshold"),
    movedAtOrAboveThreshold: dimensions.filter((d) => d.classification === "increased" || d.classification === "decreased").sort(byAbsDelta),
    unknownInvolved: dimensions.filter((d) => d.classification.includes("unknown") || d.classification.includes("became")),
    confidenceIncreased: dimensions.filter((d) => d.confidenceDelta >= CONFIDENCE_CHANGE_THRESHOLD),
    confidenceDecreased: dimensions.filter((d) => d.confidenceDelta <= -CONFIDENCE_CHANGE_THRESHOLD),
    variables,
    variablesUnchanged: variables.filter((v) => v.classification === "unchanged"),
    variablesChanged: variables.filter((v) => ["within_threshold", "increased", "decreased", "differs_no_scale"].includes(v.classification)),
    variablesWithinThreshold: variables.filter((v) => v.classification === "within_threshold"),
    variablesMovedAtOrAboveThreshold: variables.filter((v) => v.classification === "increased" || v.classification === "decreased"),
    variablesDifferNoScale: variables.filter((v) => v.classification === "differs_no_scale"),
    relationships: { kept, added, removed },
    completenessDelta: after.completeness - before.completeness,
  };
}

/** Movement between two snapshot values on the reference-range scale, and
 *  ONLY when both snapshots carry a normalized value. Without a declared
 *  scale there is no defensible way to call a move small or large, so no
 *  relative fallback is computed: the raw difference is reported instead. */
export function variableMovement(b: VariableSnapshotItem, a: VariableSnapshotItem): number | null {
  if (b.currentValue === null || a.currentValue === null) return null;
  if (b.normalized !== null && a.normalized !== null) return a.normalized - b.normalized;
  return null;
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
      else if (b.currentValue === a.currentValue) classification = "unchanged";
      else if (movement === null) classification = "differs_no_scale";
      else if (Math.abs(movement) < threshold) classification = "within_threshold";
      else classification = movement > 0 ? "increased" : "decreased";
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
/* Relationship recurrence across saved snapshots                       */
/* ------------------------------------------------------------------ */

export interface RelationshipRecurrence {
  key: string;
  sourceName: string;
  targetName: string;
  direction: "positive" | "negative";
  /** Saved snapshots in which the edge was recorded (enabled). */
  recordedIn: number;
  snapshotsTotal: number;
  /** The snapshots it was recorded in, oldest first. */
  snapshots: { snapshotId: string; label?: string; createdAt: string; strength: number }[];
  statement: string;
}

/**
 * Relationships recorded (enabled) in several saved snapshots. The count
 * is a fact about the saved snapshots ONLY: relationships are not
 * historically versioned, so nothing is known about the time between
 * snapshots, and a recurrence never demonstrates a cause.
 */
export function relationshipRecurrence(snapshots: readonly StructuralSignature[]): RelationshipRecurrence[] {
  const ordered = [...snapshots].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const total = ordered.length;
  const acc = new Map<string, { sourceName: string; targetName: string; direction: "positive" | "negative"; snapshots: RelationshipRecurrence["snapshots"] }>();
  for (const s of ordered) {
    const seenHere = new Set<string>();
    for (const r of s.relationshipSnapshot) {
      if (!r.enabled) continue;
      const key = `${r.sourceVariableId}>${r.targetVariableId}:${r.direction}`;
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      if (!acc.has(key)) acc.set(key, { sourceName: r.sourceName, targetName: r.targetName, direction: r.direction, snapshots: [] });
      acc.get(key)!.snapshots.push({ snapshotId: s.id, label: s.label, createdAt: s.createdAt, strength: r.strength });
    }
  }
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      sourceName: v.sourceName,
      targetName: v.targetName,
      direction: v.direction,
      recordedIn: v.snapshots.length,
      snapshotsTotal: total,
      snapshots: v.snapshots,
      statement: `${v.sourceName} → ${v.targetName} (${v.direction}): recorded in ${v.snapshots.length} of ${total} saved snapshots. A repeated record, not a demonstrated cause; nothing is known about the time between snapshots.`,
    }))
    .sort((a, b) => b.recordedIn - a.recordedIn || a.key.localeCompare(b.key));
}
