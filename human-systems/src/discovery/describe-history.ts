/**
 * The lowest-level factual description of ONE input variable's stored
 * value history over ONE requested interval.
 *
 *     RESOLUTION != OBSERVATION != RECURRENCE
 *     RECORDED AGAIN != CONTINUOUSLY PRESENT != STRUCTURAL != CAUSAL
 *
 * The function reports evidence facts; it interprets nothing. Facts are
 * NON-EXCLUSIVE (a repeated value and an explicit unknown between the
 * repetitions coexist). Only ACTIVE entries drive the evidence; superseded
 * and retracted entries are counted so the history stays inspectable.
 * Temporal extents are preserved (an approximate month or an explicit
 * range never becomes a fake exact point); unknown-time entries stay
 * unorderable and are reported as evidence with unresolved timing. A value
 * that still resolves at a boundary because nothing replaced it is
 * RESOLUTION coverage (carry-forward), never an observation there.
 */
import { formatTemporal, temporalInterval } from "@/calculations/time";
import { resolveValue } from "@/model/history";
import type { HistoryResolutionState, SourceType, StoredVariable, TemporalRef, ValidBasis, ValueEntry } from "@/types";
import { DiscoveryError } from "./errors";
import { extentInstants, requestedInterval, type IntervalRequest, type RequestedInterval } from "./interval";

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

/** An ACTIVE value entry with its temporal extent preserved. */
export interface HistoryRecord {
  entryId: string;
  /** null = the person recorded that the value is unknown at this time. */
  value: number | null;
  validBasis: ValidBasis;
  validKind: TemporalRef["kind"];
  /** Normalized instants of the entry's own asserted extent; null when unorderable. */
  validStart: string | null;
  validEnd: string | null;
  validPrecision: TemporalRef["precision"];
  /** The person's own words for the time, when given. */
  validText: string;
  /** From the explicit `observed` field ONLY; never substituted from valid or recordedAt. */
  observedKind: TemporalRef["kind"] | null;
  observedStart: string | null;
  observedEnd: string | null;
  observedPrecision: TemporalRef["precision"] | null;
  observedText: string | null;
  /** When the app recorded the entry (its own clock; never an application or observation time). */
  recordedAt: string;
  sourceType: SourceType;
  confidence: number;
  note: string;
  orderable: boolean;
  approximate: boolean;
  /** Its asserted start lies inside the requested interval. */
  startsInsideRequestedInterval: boolean;
  /** Its own asserted extent overlaps the requested interval (a carried-forward value does NOT). */
  overlapsRequestedInterval: boolean;
  coversStartBoundary: boolean;
  coversEndBoundary: boolean;
}

/** One asserted start shared by one or more overlapping records, after the
 *  resolver's tie rule: identical values collapse to one time; a null and
 *  a known value, or two different known values, make the time ambiguous. */
export interface ApplicationTime {
  start: string;
  kind: "known" | "unknown" | "ambiguous";
  /** The value when kind is "known"; null otherwise. */
  value: number | null;
  entryIds: string[];
  approximate: boolean;
  recordedBasis: boolean;
}

export interface BoundaryState {
  instant: string;
  value: number | null;
  resolutionState: HistoryResolutionState;
  entryId: string | null;
  /** Resolved to an entry that records the value as unknown. */
  recordedUnknown: boolean;
  /** The resolving entry's own extent does not cover this instant: the
   *  value is carried forward by the resolver, not asserted here. */
  carriedForward: boolean;
  /** The resolving entry's asserted start when carried forward. */
  carriedFrom: string | null;
  /** Competing entry ids when the boundary is ambiguous. */
  candidateEntryIds: string[];
}

export interface ExplicitIntervalClaim {
  entryId: string;
  value: number | null;
  assertedStart: string;
  assertedEnd: string;
  text: string;
  coversRequestedInterval: boolean;
  /** The overlap with the requested interval. */
  overlapStart: string;
  overlapEnd: string;
}

export interface LowVariationConvention {
  assumptionId: "A23";
  tolerance: number;
}

export interface VariationFacts {
  /** Over the known application times overlapping the interval. */
  min: number | null;
  max: number | null;
  rawRange: number | null;
  /** (max - min) / reference-range width; null without a reference range,
   *  without the convention, with fewer than two known times, or when the
   *  known values are all equal. */
  normalizedRange: number | null;
  referenceRange: { min: number; max: number } | null;
  convention: (LowVariationConvention & { applied: boolean; applicable: boolean }) | null;
}

/** Independent evidence facts. None of them is a classification; all may hold at once. */
export interface EvidenceFacts {
  /** Some known value recorded at two or more distinct usable application times (strict equality, no threshold). */
  exactRepetition: boolean;
  /** Every known application time carries the same value (a stronger form of repetition). */
  allKnownValuesEqual: boolean;
  /** Under the explicitly applied A23 convention and a reference range only. */
  lowRecordedVariation: boolean;
  /** An active `range` assertion overlaps the requested interval. */
  explicitIntervalClaim: boolean;
  /** A boundary is resolved from an entry whose own extent does not cover it. */
  lastKnownCarryForward: boolean;
  explicitUnknownPresent: boolean;
  /** An explicit unknown lies between two known application times. */
  unknownInterruption: boolean;
  ambiguityPresent: boolean;
  unorderableEvidencePresent: boolean;
  approximateTimingPresent: boolean;
  /** A repeated value relies on at least one approximate application time. */
  recurrenceReliesOnApproximateTiming: boolean;
  recordedBasisPresent: boolean;
  /** A repeated value relies on at least one recorded-basis date. */
  recurrenceReliesOnRecordedBasis: boolean;
  /** Fewer than two distinct usable application times with known values. */
  insufficientForRecurrence: boolean;
}

/** A presentation grouping DERIVED from the facts; it never replaces them. */
export type HistorySummaryClass = "repeated" | "low_variation" | "changed" | "explicit_claim" | "last_known_only" | "insufficient" | "unresolved";

export interface Caveat {
  code: string;
  text: string;
}

export interface VariableHistoryDescription {
  variableId: string;
  key: string;
  subjectId: string | null;
  name: string;
  unit: string;
  interval: RequestedInterval;
  atStart: BoundaryState;
  atEnd: BoundaryState;
  entries: { total: number; active: number; superseded: number; retracted: number; orderable: number; unorderable: number };
  /** Every ACTIVE entry, oldest asserted start first; unorderable ones last. */
  records: HistoryRecord[];
  recordsStartingInsideInterval: number;
  recordsOverlappingInterval: number;
  unorderableRecordCount: number;
  /** Distinct asserted starts among the overlapping orderable records. */
  applicationTimes: ApplicationTime[];
  /** Overlapping records with a known value (records, not times). */
  knownRecordCount: number;
  /** Usable application times with a known value. */
  distinctApplicationTimeCount: number;
  distinctKnownValues: number[];
  /** Values recorded at two or more distinct application times. */
  repeatedValues: { value: number; applicationTimes: string[] }[];
  /** Overlapping records recording an explicit unknown. */
  explicitUnknownCount: number;
  unknownInterruptions: number;
  ambiguousApplicationTimes: string[];
  /** Consecutive known application times whose values differ: a count of
   *  RECORD comparisons, never of real-world changes (unknown gaps may
   *  hide any number of them). */
  differingRecordedPairs: number;
  variation: VariationFacts;
  explicitIntervalClaims: ExplicitIntervalClaim[];
  /** From explicit `observed` fields only. */
  firstObserved: string | null;
  lastObserved: string | null;
  /** Earliest / latest asserted start over the whole orderable active history. */
  firstApplicable: string | null;
  lastApplicable: string | null;
  /** Over the overlapping records. */
  provenance: Partial<Record<SourceType, number>>;
  confidence: { min: number; max: number } | null;
  facts: EvidenceFacts;
  summaryClass: HistorySummaryClass;
  caveats: Caveat[];
}

export interface DescribeHistoryOptions {
  /** Apply the A23 low-variation display convention (never applied by default). */
  lowVariation?: LowVariationConvention;
}

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

function refFacts(t: TemporalRef | undefined): { kind: TemporalRef["kind"] | null; start: string | null; end: string | null; precision: TemporalRef["precision"] | null; text: string | null } {
  if (!t) return { kind: null, start: null, end: null, precision: null, text: null };
  const extent = temporalInterval(t);
  const inst = extent ? extentInstants(extent) : null;
  return { kind: t.kind, start: inst?.start ?? null, end: inst?.end ?? null, precision: t.precision, text: t.text || formatTemporal(t) };
}

function toRecord(e: ValueEntry, iv: RequestedInterval): HistoryRecord {
  const valid = refFacts(e.valid);
  const observed = refFacts(e.observed);
  const orderable = valid.start !== null && valid.end !== null;
  const overlaps = orderable && (valid.start as string) <= iv.to && (valid.end as string) >= iv.from;
  return {
    entryId: e.id,
    value: e.value,
    validBasis: e.validBasis,
    validKind: e.valid.kind,
    validStart: valid.start,
    validEnd: valid.end,
    validPrecision: e.valid.precision,
    validText: valid.text ?? "",
    observedKind: observed.kind,
    observedStart: observed.start,
    observedEnd: observed.end,
    observedPrecision: observed.precision,
    observedText: observed.text,
    recordedAt: e.recordedAt,
    sourceType: e.sourceType,
    confidence: e.confidence,
    note: e.note,
    orderable,
    approximate: e.valid.kind === "approx",
    startsInsideRequestedInterval: orderable && (valid.start as string) >= iv.from && (valid.start as string) <= iv.to,
    overlapsRequestedInterval: overlaps,
    coversStartBoundary: orderable && (valid.start as string) <= iv.from && (valid.end as string) >= iv.from,
    coversEndBoundary: orderable && (valid.start as string) <= iv.to && (valid.end as string) >= iv.to,
  };
}

function boundary(entries: readonly ValueEntry[], instant: string, records: Map<string, HistoryRecord>, covers: (r: HistoryRecord) => boolean): BoundaryState {
  const r = resolveValue(entries, instant);
  const rec = r.entry ? records.get(r.entry.id) ?? null : null;
  const carriedForward = rec !== null && !covers(rec);
  return {
    instant,
    value: r.entry ? r.entry.value : null,
    resolutionState: r.state,
    entryId: r.entry?.id ?? null,
    recordedUnknown: r.entry !== null && r.entry.value === null,
    carriedForward,
    carriedFrom: carriedForward ? rec!.validStart : null,
    candidateEntryIds: r.candidates.map((c) => c.id),
  };
}

function applicationTimes(overlapping: readonly HistoryRecord[]): ApplicationTime[] {
  const groups = new Map<string, HistoryRecord[]>();
  for (const r of overlapping) {
    const start = r.validStart as string;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start)!.push(r);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([start, recs]) => {
      // The resolver's tie rule: identical payloads collapse; anything else is ambiguous.
      const payloads = new Set(recs.map((r) => JSON.stringify(r.value)));
      const kind: ApplicationTime["kind"] = payloads.size > 1 ? "ambiguous" : recs[0].value === null ? "unknown" : "known";
      return {
        start,
        kind,
        value: kind === "known" ? recs[0].value : null,
        entryIds: recs.map((r) => r.entryId),
        approximate: recs.some((r) => r.approximate),
        recordedBasis: recs.some((r) => r.validBasis === "recorded"),
      };
    });
}

function summarize(f: EvidenceFacts, d: { knownTimes: number; overlappingKnown: number; explicitUnknown: number; orderableActive: number; boundaryKnown: boolean }): HistorySummaryClass {
  if (f.ambiguityPresent) return "unresolved";
  if (d.knownTimes >= 2) {
    if (f.allKnownValuesEqual) return "repeated";
    if (f.lowRecordedVariation) return "low_variation";
    return "changed";
  }
  if (f.explicitIntervalClaim) return "explicit_claim";
  if (d.orderableActive === 0 && f.unorderableEvidencePresent) return "unresolved";
  // Nothing known overlaps and what the resolver offers is a recorded unknown
  // (inside the interval or carried to a boundary): the model says "unknown".
  if (d.knownTimes === 0 && f.explicitUnknownPresent && !d.boundaryKnown) return "unresolved";
  if (d.knownTimes === 0 && f.lastKnownCarryForward && d.boundaryKnown) return "last_known_only";
  return "insufficient";
}

/**
 * Describe an INPUT variable's value history over a requested interval.
 * A derived variable is a programming error here (its historical
 * recomputation belongs to describeInterval, with its own caveat).
 */
export function describeVariableHistory(variable: StoredVariable, request: IntervalRequest, options: DescribeHistoryOptions = {}): VariableHistoryDescription {
  if (variable.kind !== "input") {
    throw new DiscoveryError(`describeVariableHistory describes input variables only; "${variable.id}" is derived (its historical recomputation belongs to describeInterval)`);
  }
  const iv = requestedInterval(request);
  const active = variable.values.filter((e) => e.status === "active");
  const records = active.map((e) => toRecord(e, iv));
  const orderable = records.filter((r) => r.orderable).sort((a, b) => ((a.validStart as string) < (b.validStart as string) ? -1 : (a.validStart as string) > (b.validStart as string) ? 1 : a.recordedAt < b.recordedAt ? -1 : 1));
  const unorderable = records.filter((r) => !r.orderable);
  const byId = new Map(records.map((r) => [r.entryId, r]));
  const overlapping = orderable.filter((r) => r.overlapsRequestedInterval);

  const atStart = boundary(active, iv.from, byId, (r) => r.coversStartBoundary);
  const atEnd = boundary(active, iv.to, byId, (r) => r.coversEndBoundary);

  const times = applicationTimes(overlapping);
  const knownTimes = times.filter((t) => t.kind === "known");
  const knownValues = knownTimes.map((t) => t.value as number);
  const distinctKnownValues = [...new Set(knownValues)].sort((a, b) => a - b);
  const repeatedValues = distinctKnownValues
    .map((value) => ({ value, applicationTimes: knownTimes.filter((t) => t.value === value).map((t) => t.start) }))
    .filter((r) => r.applicationTimes.length >= 2);
  const repeatedTimes = new Set(repeatedValues.flatMap((r) => r.applicationTimes));

  // Unknown interruptions: explicit-unknown times strictly between two known times.
  let unknownInterruptions = 0;
  const firstKnownIdx = times.findIndex((t) => t.kind === "known");
  const lastKnownIdx = times.map((t) => t.kind).lastIndexOf("known");
  if (firstKnownIdx >= 0) for (let i = firstKnownIdx + 1; i < lastKnownIdx; i++) if (times[i].kind === "unknown") unknownInterruptions += 1;

  let differingRecordedPairs = 0;
  for (let i = 1; i < knownTimes.length; i++) if (knownTimes[i].value !== knownTimes[i - 1].value) differingRecordedPairs += 1;

  const min = knownValues.length ? Math.min(...knownValues) : null;
  const max = knownValues.length ? Math.max(...knownValues) : null;
  const rawRange = min !== null && max !== null ? max - min : null;
  const referenceRange = variable.referenceRange ?? null;
  const convention = options.lowVariation ?? null;
  const allKnownValuesEqual = knownTimes.length >= 2 && distinctKnownValues.length === 1;
  const variationApplicable = referenceRange !== null && knownTimes.length >= 2 && !allKnownValuesEqual;
  const normalizedRange = convention && variationApplicable && rawRange !== null ? rawRange / (referenceRange!.max - referenceRange!.min) : null;
  const lowRecordedVariation = normalizedRange !== null && normalizedRange < (convention as LowVariationConvention).tolerance;

  const explicitIntervalClaims: ExplicitIntervalClaim[] = overlapping
    .filter((r) => r.validKind === "range")
    .map((r) => ({
      entryId: r.entryId,
      value: r.value,
      assertedStart: r.validStart as string,
      assertedEnd: r.validEnd as string,
      text: r.validText,
      coversRequestedInterval: (r.validStart as string) <= iv.from && (r.validEnd as string) >= iv.to,
      overlapStart: (r.validStart as string) > iv.from ? (r.validStart as string) : iv.from,
      overlapEnd: (r.validEnd as string) < iv.to ? (r.validEnd as string) : iv.to,
    }));

  const explicitUnknownCount = overlapping.filter((r) => r.value === null).length;
  const ambiguousApplicationTimes = times.filter((t) => t.kind === "ambiguous").map((t) => t.start);
  const observedStarts = records.map((r) => r.observedStart).filter((s): s is string => s !== null).sort();
  const observedEnds = records.map((r) => r.observedEnd).filter((s): s is string => s !== null).sort();
  const provenance: Partial<Record<SourceType, number>> = {};
  for (const r of overlapping) provenance[r.sourceType] = (provenance[r.sourceType] ?? 0) + 1;
  const confidences = overlapping.map((r) => r.confidence);

  const facts: EvidenceFacts = {
    exactRepetition: repeatedValues.length > 0,
    allKnownValuesEqual,
    lowRecordedVariation,
    explicitIntervalClaim: explicitIntervalClaims.length > 0,
    lastKnownCarryForward: atStart.carriedForward || atEnd.carriedForward,
    explicitUnknownPresent: explicitUnknownCount > 0 || atStart.recordedUnknown || atEnd.recordedUnknown,
    unknownInterruption: unknownInterruptions > 0,
    ambiguityPresent: ambiguousApplicationTimes.length > 0 || atStart.resolutionState === "ambiguous" || atEnd.resolutionState === "ambiguous",
    unorderableEvidencePresent: unorderable.length > 0,
    approximateTimingPresent: overlapping.some((r) => r.approximate),
    recurrenceReliesOnApproximateTiming: times.some((t) => repeatedTimes.has(t.start) && t.approximate),
    recordedBasisPresent: overlapping.some((r) => r.validBasis === "recorded"),
    recurrenceReliesOnRecordedBasis: times.some((t) => repeatedTimes.has(t.start) && t.recordedBasis),
    insufficientForRecurrence: knownTimes.length < 2,
  };

  const caveats: Caveat[] = [];
  if (facts.lastKnownCarryForward) caveats.push({ code: "carry_forward", text: "A boundary value is the last recorded value carried forward by the resolver; nothing was recorded at that instant." });
  if (facts.exactRepetition) caveats.push({ code: "repetition_not_continuity", text: "A value recorded again at a later application time is a repeated record; it does not show that the value held in between." });
  if (facts.unknownInterruption) caveats.push({ code: "unknown_interruption", text: "An explicit unknown was recorded between repeated values; the period between them is unresolved." });
  if (facts.ambiguityPresent) caveats.push({ code: "ambiguous", text: "Two active records start at the same time and disagree; that time cannot be used as evidence until one is corrected or retracted." });
  if (facts.unorderableEvidencePresent) caveats.push({ code: "unorderable", text: "Some records have no orderable time; they are kept as evidence with unresolved timing and take no part in the chronology." });
  if (facts.recurrenceReliesOnApproximateTiming) caveats.push({ code: "approximate_timing", text: "A repeated value relies on an approximate application time; the dates are as stated, not exact." });
  if (facts.recurrenceReliesOnRecordedBasis) caveats.push({ code: "recorded_basis", text: "A repeated value relies on a recorded-basis date: the earliest applicability the app can defend, not necessarily when the condition began or was observed." });
  if (facts.explicitIntervalClaim) caveats.push({ code: "explicit_claim", text: "A record explicitly asserts a period; the assertion is the person's, as stated, and is reported with its own extent." });
  if (facts.lowRecordedVariation) caveats.push({ code: "a23_display", text: "Low recorded variation is a display convention (A23) over the recorded values on the variable's reference range; it is not persistence, structure or continuity." });
  if (facts.insufficientForRecurrence && !facts.explicitIntervalClaim) caveats.push({ code: "insufficient", text: "Fewer than two dated known records overlap the interval; nothing can be said about recurrence." });

  const boundaryKnown = (atStart.value !== null && atStart.resolutionState === "resolved") || (atEnd.value !== null && atEnd.resolutionState === "resolved");
  const summaryClass = summarize(facts, { knownTimes: knownTimes.length, overlappingKnown: overlapping.filter((r) => r.value !== null).length, explicitUnknown: explicitUnknownCount, orderableActive: orderable.length, boundaryKnown });

  return {
    variableId: variable.id,
    key: variable.key,
    subjectId: variable.subjectId,
    name: variable.name,
    unit: variable.unit,
    interval: iv,
    atStart,
    atEnd,
    entries: {
      total: variable.values.length,
      active: active.length,
      superseded: variable.values.filter((e) => e.status === "superseded").length,
      retracted: variable.values.filter((e) => e.status === "retracted").length,
      orderable: orderable.length,
      unorderable: unorderable.length,
    },
    records: [...orderable, ...unorderable],
    recordsStartingInsideInterval: orderable.filter((r) => r.startsInsideRequestedInterval).length,
    recordsOverlappingInterval: overlapping.length,
    unorderableRecordCount: unorderable.length,
    applicationTimes: times,
    knownRecordCount: overlapping.filter((r) => r.value !== null).length,
    distinctApplicationTimeCount: knownTimes.length,
    distinctKnownValues,
    repeatedValues,
    explicitUnknownCount,
    unknownInterruptions,
    ambiguousApplicationTimes,
    differingRecordedPairs,
    variation: {
      min,
      max,
      rawRange,
      normalizedRange,
      referenceRange,
      convention: convention ? { ...convention, applied: true, applicable: variationApplicable } : null,
    },
    explicitIntervalClaims,
    firstObserved: observedStarts[0] ?? null,
    lastObserved: observedEnds.at(-1) ?? null,
    firstApplicable: orderable[0]?.validStart ?? null,
    lastApplicable: orderable.at(-1)?.validStart ?? null,
    provenance,
    confidence: confidences.length ? { min: Math.min(...confidences), max: Math.max(...confidences) } : null,
    facts,
    summaryClass,
    caveats,
  };
}
