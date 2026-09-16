/**
 * The whole-system question for one interval: what changed, what
 * repeated or stayed similar in the records, what is only a carried
 * forward value, what has too little history, what is unresolved. It
 * composes describeVariableHistory over the INPUT variables in scope,
 * adds events as context, saved snapshots as secondary evidence, and
 * (only on request) derived values recomputed at the two boundaries
 * under TODAY'S structure. Context is evidence, never a score; nothing
 * here ranks "most structural" or names a cause.
 */
import { formatTemporal, temporalInterval } from "@/calculations/time";
import { evaluateSystem } from "@/model/evaluate";
import type { Event, StoredVariable, SystemModel } from "@/types";
import { describeVariableHistory, type Caveat, type LowVariationConvention, type VariableHistoryDescription } from "./describe-history";
import { describeSnapshotSeries, type SnapshotSeriesDescription } from "./describe-snapshots";
import { extentInstants, requestedInterval, type IntervalRequest, type RequestedInterval } from "./interval";
import { CAUSATION_DISCLAIMER, historySentences, type HistorySentences } from "./language";

export interface DescribeIntervalOptions extends IntervalRequest {
  /** Only variables and events of this subject (the system id for system-level). Omitted = everything, unassigned included. */
  subjectId?: string;
  /** Recompute derived variables at the two boundaries (default false; always caveated). */
  includeDerived?: boolean;
  lowVariation?: LowVariationConvention;
  /** The clock for derived recomputation; defaults to the real clock. */
  now?: string;
  /** Snapshot mode for the secondary evidence. */
  snapshotMode?: "current" | "desired";
}

export interface EventContext {
  id: string;
  kind: Event["kind"];
  type: string;
  title: string;
  subjectId: string | null;
  occurredStart: string | null;
  occurredEnd: string | null;
  occurredText: string;
  orderable: boolean;
}

export interface DescribedVariable {
  description: VariableHistoryDescription;
  sentences: HistorySentences;
}

/** What else the records show changing over the same interval: context, not a score. */
export interface CandidateContext {
  variableId: string;
  /** Other in-scope variables whose recorded values differ over the interval. */
  variablesChanged: string[];
  eventsInInterval: number;
}

export interface DerivedRecomputation {
  variableId: string;
  key: string;
  subjectId: string | null;
  name: string;
  unit: string;
  atStart: number | null;
  atEnd: number | null;
  /** null when either end is unknown. */
  differs: boolean | null;
  caveat: string;
}

export const DERIVED_RECOMPUTATION_CAVEAT = "Recomputed from historical values using today's relationships, collections and domain definition; not a recorded value.";

export interface IntervalDescription {
  interval: RequestedInterval;
  subjectId: string | null;
  variables: DescribedVariable[];
  /** changed / repeated / lowVariation / explicitClaims are FACTUAL and may
   *  overlap; lastKnownOnly / insufficient / unresolved are status groups. */
  buckets: {
    changed: DescribedVariable[];
    repeated: DescribedVariable[];
    lowVariation: DescribedVariable[];
    explicitClaims: DescribedVariable[];
    lastKnownOnly: DescribedVariable[];
    insufficient: DescribedVariable[];
    unresolved: DescribedVariable[];
  };
  /** One per candidate (repeated, low variation or explicit claim), de-duplicated. */
  context: CandidateContext[];
  events: { inInterval: EventContext[]; unorderable: EventContext[]; outsideInterval: number };
  /** Empty unless includeDerived. */
  recomputed: DerivedRecomputation[];
  /** Saved snapshots whose values instant lies inside the interval; null when none. */
  snapshots: SnapshotSeriesDescription | null;
  caveats: Caveat[];
  disclaimer: string;
}

/** An event as context for an interval: placed by its OWN occurred extent. */
export function eventContext(e: Event, iv: Pick<RequestedInterval, "from" | "to">): { ctx: EventContext; inInterval: boolean } {
  const extent = temporalInterval(e.occurred);
  const inst = extent ? extentInstants(extent) : null;
  const ctx: EventContext = {
    id: e.id,
    kind: e.kind,
    type: e.type,
    title: e.title,
    subjectId: e.subjectId,
    occurredStart: inst?.start ?? null,
    occurredEnd: inst?.end ?? null,
    occurredText: e.occurred.text || formatTemporal(e.occurred),
    orderable: inst !== null,
  };
  return { ctx, inInterval: inst !== null && inst.start <= iv.to && inst.end >= iv.from };
}

export function describeInterval(model: SystemModel, options: DescribeIntervalOptions): IntervalDescription {
  const iv = requestedInterval({ from: options.from, to: options.to });
  const inScope = (subjectId: string | null) => options.subjectId === undefined || subjectId === options.subjectId;
  const inputs: StoredVariable[] = model.variables.filter((v) => v.kind === "input" && inScope(v.subjectId));

  const variables: DescribedVariable[] = inputs.map((v) => {
    const description = describeVariableHistory(v, { from: options.from, to: options.to }, options.lowVariation ? { lowVariation: options.lowVariation } : {});
    return { description, sentences: historySentences(description) };
  });
  // FACTUAL groups are NON-EXCLUSIVE: 3000 -> 5000 -> 5000 both changed and
  // repeated, and both facts are shown. The status groups (last-known
  // only, insufficient, unresolved) come from the derived summary class.
  const by = (cls: VariableHistoryDescription["summaryClass"]) => variables.filter((v) => v.description.summaryClass === cls);
  const buckets = {
    /** Recorded known values differ (two or more distinct known values in the period). */
    changed: variables.filter((v) => v.description.distinctKnownValues.length >= 2),
    /** Exact repetition exists (some value at two or more distinct application times). */
    repeated: variables.filter((v) => v.description.facts.exactRepetition),
    /** The A23 low-variation condition is met (convention supplied, reference range, non-equal values). */
    lowVariation: variables.filter((v) => v.description.facts.lowRecordedVariation),
    /** An explicit interval claim overlaps the period. */
    explicitClaims: variables.filter((v) => v.description.facts.explicitIntervalClaim),
    lastKnownOnly: by("last_known_only"),
    insufficient: by("insufficient"),
    unresolved: by("unresolved"),
  };

  const events = { inInterval: [] as EventContext[], unorderable: [] as EventContext[], outsideInterval: 0 };
  for (const e of model.events.filter((ev) => inScope(ev.subjectId))) {
    const { ctx, inInterval } = eventContext(e, iv);
    if (!ctx.orderable) events.unorderable.push(ctx);
    else if (inInterval) events.inInterval.push(ctx);
    else events.outsideInterval += 1;
  }
  events.inInterval.sort((a, b) => (a.occurredStart as string).localeCompare(b.occurredStart as string));

  const changedIds = buckets.changed.map((v) => v.description.variableId);
  const candidateIds = [...new Set([...buckets.repeated, ...buckets.lowVariation, ...buckets.explicitClaims].map((c) => c.description.variableId))];
  const context: CandidateContext[] = candidateIds.map((variableId) => ({
    variableId,
    variablesChanged: changedIds.filter((id) => id !== variableId),
    eventsInInterval: events.inInterval.length,
  }));

  let recomputed: DerivedRecomputation[] = [];
  if (options.includeDerived) {
    const now = options.now ?? new Date().toISOString();
    const start = evaluateSystem(model, { now, asOf: iv.from, includeArchivedMembers: true });
    const end = evaluateSystem(model, { now, asOf: iv.to, includeArchivedMembers: true });
    recomputed = end.variables
      .filter((v) => v.kind === "derived" && inScope(v.subjectId))
      .map((v) => {
        const atStart = start.variableById.get(v.id)?.currentValue ?? null;
        const atEnd = v.currentValue;
        return { variableId: v.id, key: v.key, subjectId: v.subjectId, name: v.name, unit: v.unit, atStart, atEnd, differs: atStart === null || atEnd === null ? null : atStart !== atEnd, caveat: DERIVED_RECOMPUTATION_CAVEAT };
      });
  }

  const series = describeSnapshotSeries(model.signatures, { mode: options.snapshotMode ?? "current", interval: { from: options.from, to: options.to }, ...(options.subjectId !== undefined ? { subjectId: options.subjectId } : {}) });
  const snapshots = series.snapshotsTotal > 0 ? series : null;

  const caveats: Caveat[] = [
    { code: "records_not_continuity", text: "Every statement describes what was recorded. A value that appears again is a repeated record, not evidence that it held in between." },
    { code: "context_not_cause", text: "What else changed in the same interval is context for examination, not a cause or a score." },
  ];
  if (recomputed.length > 0) caveats.push({ code: "derived_today_structure", text: DERIVED_RECOMPUTATION_CAVEAT });
  if (snapshots) caveats.push({ code: "snapshots_secondary", text: "Saved snapshots are moments the person chose to save; nothing is known about the time between them." });
  if (events.unorderable.length > 0) caveats.push({ code: "events_unorderable", text: `${events.unorderable.length} event${events.unorderable.length > 1 ? "s have" : " has"} no orderable time and could not be placed in the interval.` });

  return { interval: iv, subjectId: options.subjectId ?? null, variables, buckets, context, events, recomputed, snapshots, caveats, disclaimer: CAUSATION_DISCLAIMER };
}
