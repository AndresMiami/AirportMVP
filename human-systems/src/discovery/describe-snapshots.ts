/**
 * Saved structural snapshots as SECONDARY evidence: raw series facts per
 * dimension and per variable ("recorded in 4 of 5 saved snapshots"), never
 * a persistence verdict. Snapshots are moments the person chose to save;
 * nothing is known about the time between them, and relationships are not
 * historically versioned at all.
 */
import { relationshipRecurrence, type RelationshipRecurrence } from "@/signatures/compare";
import type { StructuralSignature } from "@/types/signature";
import { requestedInterval, type IntervalRequest } from "./interval";

export interface SnapshotRef {
  snapshotId: string;
  label?: string;
  createdAt: string;
  /** The instant the values were resolved at (createdAt when not an as-of reconstruction). */
  valuesAt: string;
}

export interface SeriesPoint extends SnapshotRef {
  value: number | null;
}

export interface DimensionSeries {
  dimensionId: string;
  name: string;
  /** Snapshots in which the dimension had a known value. */
  recordedIn: number;
  snapshotsTotal: number;
  values: SeriesPoint[];
  min: number | null;
  max: number | null;
  /** Dimension values are already 0..1, so their range is a normalized range. */
  normalizedRange: number | null;
  /** Every known value strictly equal (no threshold). */
  allEqual: boolean;
  /** Other dimensions whose known recorded values were not all equal over the same snapshots. */
  otherDimensionsWithDifferentValues: string[];
  statement: string;
}

export interface VariableSeries {
  variableId: string;
  name: string;
  unit: string;
  kind: "input" | "derived";
  recordedIn: number;
  snapshotsTotal: number;
  values: SeriesPoint[];
  min: number | null;
  max: number | null;
  rawRange: number | null;
  /** Range of the reference-range position; null unless every known snapshot carried one. */
  normalizedRange: number | null;
  allEqual: boolean;
  statement: string;
}

export interface SnapshotSeriesDescription {
  mode: "current" | "desired";
  snapshotsTotal: number;
  first: SnapshotRef | null;
  last: SnapshotRef | null;
  dimensions: DimensionSeries[];
  variables: VariableSeries[];
  relationships: RelationshipRecurrence[];
}

export interface DescribeSnapshotsOptions {
  mode?: "current" | "desired";
  /** Keep only snapshots whose values instant lies inside the interval. */
  interval?: IntervalRequest;
  /** Keep only snapshots of this subject. */
  subjectId?: string;
}

function ref(s: StructuralSignature): SnapshotRef {
  return { snapshotId: s.id, label: s.label, createdAt: s.createdAt, valuesAt: s.valuesAsOf ?? s.createdAt };
}

function recordedStatement(name: string, recordedIn: number, total: number, allEqual: boolean, values: number[]): string {
  if (recordedIn === 0) return `${name}: not recorded in any of the ${total} saved snapshots.`;
  const base = `${name}: recorded in ${recordedIn} of ${total} saved snapshots`;
  if (recordedIn === 1) return `${base}; one recorded value (${values[0]}). Nothing is known about the time between snapshots.`;
  return `${base}; ${allEqual ? `the same value (${values[0]}) each time` : `recorded values ${Math.min(...values)} to ${Math.max(...values)}`}. Nothing is known about the time between snapshots.`;
}

export function describeSnapshotSeries(snapshots: readonly StructuralSignature[], options: DescribeSnapshotsOptions = {}): SnapshotSeriesDescription {
  const mode = options.mode ?? "current";
  const iv = options.interval ? requestedInterval(options.interval) : null;
  const inScope = [...snapshots]
    .filter((s) => s.mode === mode)
    .filter((s) => options.subjectId === undefined || s.subjectId === options.subjectId)
    .filter((s) => !iv || (ref(s).valuesAt >= iv.from && ref(s).valuesAt <= iv.to))
    .sort((a, b) => ref(a).valuesAt.localeCompare(ref(b).valuesAt) || a.createdAt.localeCompare(b.createdAt));
  const total = inScope.length;

  const dimSeries = new Map<string, { name: string; values: SeriesPoint[] }>();
  const varSeries = new Map<string, { name: string; unit: string; kind: "input" | "derived"; values: SeriesPoint[]; normalized: (number | null)[] }>();
  for (const s of inScope) {
    for (const d of s.dimensions) {
      if (!dimSeries.has(d.dimensionId)) dimSeries.set(d.dimensionId, { name: d.name, values: [] });
      dimSeries.get(d.dimensionId)!.values.push({ ...ref(s), value: d.normalizedValue });
    }
    for (const v of s.variableSnapshot) {
      if (!varSeries.has(v.id)) varSeries.set(v.id, { name: v.name, unit: v.unit, kind: v.kind, values: [], normalized: [] });
      varSeries.get(v.id)!.values.push({ ...ref(s), value: v.currentValue });
      varSeries.get(v.id)!.normalized.push(v.currentValue === null ? null : v.normalized);
    }
  }

  const dims = [...dimSeries.entries()].map(([dimensionId, s]) => {
    const known = s.values.map((v) => v.value).filter((v): v is number => v !== null);
    const min = known.length ? Math.min(...known) : null;
    const max = known.length ? Math.max(...known) : null;
    return { dimensionId, name: s.name, values: s.values, known, min, max, allEqual: known.length >= 2 && new Set(known).size === 1 };
  });
  const dimensions: DimensionSeries[] = dims.map((d) => ({
    dimensionId: d.dimensionId,
    name: d.name,
    recordedIn: d.known.length,
    snapshotsTotal: total,
    values: d.values,
    min: d.min,
    max: d.max,
    normalizedRange: d.min !== null && d.max !== null && d.known.length >= 2 ? d.max - d.min : null,
    allEqual: d.allEqual,
    otherDimensionsWithDifferentValues: dims.filter((o) => o.dimensionId !== d.dimensionId && o.known.length >= 2 && !o.allEqual).map((o) => o.dimensionId),
    statement: recordedStatement(d.name, d.known.length, total, d.allEqual, d.known),
  }));

  const variables: VariableSeries[] = [...varSeries.entries()].map(([variableId, s]) => {
    const known = s.values.map((v) => v.value).filter((v): v is number => v !== null);
    const min = known.length ? Math.min(...known) : null;
    const max = known.length ? Math.max(...known) : null;
    const knownNormalized = s.normalized.filter((n): n is number => n !== null);
    const allNormalized = known.length >= 2 && knownNormalized.length === known.length;
    const allEqual = known.length >= 2 && new Set(known).size === 1;
    return {
      variableId,
      name: s.name,
      unit: s.unit,
      kind: s.kind,
      recordedIn: known.length,
      snapshotsTotal: total,
      values: s.values,
      min,
      max,
      rawRange: min !== null && max !== null && known.length >= 2 ? max - min : null,
      normalizedRange: allNormalized ? Math.max(...knownNormalized) - Math.min(...knownNormalized) : null,
      allEqual,
      statement: recordedStatement(s.name, known.length, total, allEqual, known),
    };
  });

  return {
    mode,
    snapshotsTotal: total,
    first: inScope[0] ? ref(inScope[0]) : null,
    last: inScope.at(-1) ? ref(inScope.at(-1) as StructuralSignature) : null,
    dimensions,
    variables,
    relationships: relationshipRecurrence(inScope),
  };
}
