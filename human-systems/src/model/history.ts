/**
 * History resolution: which value / target entry applies at a clock
 * instant. The stored truth is the append-only history; "current" is a
 * view computed here. UNKNOWN IS NOT ZERO and MISSING HISTORY IS NOT
 * PERMISSION TO BACKFILL: an instant before the first orderable entry
 * resolves to nothing, never to the later value. Entries whose time is
 * not orderable are preserved and reported, never sorted by guess.
 */
import { temporalInterval } from "@/calculations/time";
import type { HistoryResolutionState, StoredVariable, TargetEntry, TargetMode, ValueEntry, Variable } from "@/types";

export interface HistoryEntryLike {
  id: string;
  valid: ValueEntry["valid"];
  recordedAt: string;
  status: ValueEntry["status"];
}

export interface Resolution<E extends HistoryEntryLike> {
  entry: E | null;
  state: HistoryResolutionState;
  /** Active entries competing at the same start with different values. */
  candidates: E[];
  /** Active entries whose time cannot be ordered (kept, not used). */
  unorderable: E[];
}

/** A date-only instant means the END of that day, so "as of March 1"
 *  includes what was asserted on March 1. */
export function normalizeInstant(iso: string): string {
  return iso.length === 10 ? `${iso}T23:59:59.999Z` : iso;
}

function startOf<E extends HistoryEntryLike>(e: E): string | null {
  return temporalInterval(e.valid)?.start ?? null;
}

/**
 * Resolve the entry that applies at `asOf`. Rule: among ACTIVE entries with
 * an orderable `valid` whose start is at or before `asOf`, the latest start
 * wins. Equal starts: identical payloads collapse to the most recently
 * recorded; different payloads are AMBIGUOUS and nothing is chosen.
 */
export function resolveEntries<E extends HistoryEntryLike>(entries: readonly E[], asOf: string, payloadOf: (e: E) => unknown): Resolution<E> {
  const at = normalizeInstant(asOf);
  const active = entries.filter((e) => e.status === "active");
  if (active.length === 0) return { entry: null, state: "no_entries", candidates: [], unorderable: [] };
  const unorderable = active.filter((e) => startOf(e) === null);
  const orderable = active.filter((e) => startOf(e) !== null);
  if (orderable.length === 0) return { entry: null, state: "unorderable_only", candidates: [], unorderable };
  const applicable = orderable.filter((e) => (startOf(e) as string) <= at);
  if (applicable.length === 0) return { entry: null, state: "before_first", candidates: [], unorderable };
  const latestStart = applicable.map((e) => startOf(e) as string).sort().at(-1) as string;
  const tied = applicable.filter((e) => startOf(e) === latestStart);
  const payloads = new Set(tied.map((e) => JSON.stringify(payloadOf(e))));
  if (payloads.size > 1) return { entry: null, state: "ambiguous", candidates: tied, unorderable };
  const winner = [...tied].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0))[0];
  return { entry: winner, state: "resolved", candidates: [], unorderable };
}

export function resolveValue(entries: readonly ValueEntry[], asOf: string): Resolution<ValueEntry> {
  return resolveEntries(entries, asOf, (e) => e.value);
}

export function resolveTarget(entries: readonly TargetEntry[], asOf: string): Resolution<TargetEntry> {
  return resolveEntries(entries, asOf, (e) => [e.desiredValue, e.targetMode]);
}

/** The resolved VIEW of a stored INPUT variable at `asOf`. Derived
 *  variables get their value from the formula (model/derived.ts); this
 *  only resolves their target. */
export function resolveVariableAt(stored: StoredVariable, asOf: string): Variable {
  const value = stored.kind === "input" ? resolveValue(stored.values, asOf) : { entry: null, state: "no_entries" as const, candidates: [], unorderable: [] };
  const target = resolveTarget(stored.targets, asOf);
  const targetMode: TargetMode = target.entry?.targetMode ?? stored.targetMode;
  return {
    ...stored,
    targetMode,
    currentValue: value.entry ? value.entry.value : null,
    desiredValue: target.entry ? target.entry.desiredValue : null,
    sourceType: stored.kind === "derived" ? "calculated" : (value.entry?.sourceType ?? "unknown"),
    confidence: value.entry?.confidence ?? 0,
    valueEntry: value.entry,
    targetEntry: target.entry,
    valueResolution: value.state,
    targetResolution: target.state,
  };
}

/** Human-readable reason a value did not resolve (for issues and screens). */
export function describeResolution(state: HistoryResolutionState): string | null {
  switch (state) {
    case "resolved":
      return null;
    case "no_entries":
      return "no value recorded";
    case "before_first":
      return "no value recorded that early; the later value is not carried back";
    case "unorderable_only":
      return "the only recorded values have no orderable time";
    case "ambiguous":
      return "two recorded values start at the same time and disagree; correct or retract one";
  }
}
