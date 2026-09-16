/**
 * Requested-interval boundaries for discovery questions ("what happened
 * between March and September?"). These are DISTINCT from the resolver's
 * `normalizeInstant`, which turns every date-only instant into the END of
 * that day (an as-of question includes the whole day). An interval has two
 * ends: a date-only START is the beginning of its day, a date-only END is
 * the end of its day. Datetime inputs stay exact. `from` after `to` is a
 * programming error, never silently swapped.
 */
import { DiscoveryError } from "./errors";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A real ISO 8601 timestamp: date, "T", time to at least minutes, optional
 *  seconds and fraction, and an explicit zone (Z or ±hh:mm). Nothing looser
 *  (no "March 1", no "2026-3-1", no zone-less datetime) is accepted. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Strict ISO parsing. A date-only string stays a calendar day (the caller
 *  chooses which end of it); a timestamp is re-serialized in UTC so that
 *  the same instant written with different zone offsets compares equal.
 *  Instants are compared as strings everywhere in the engine, so every
 *  normalized instant has the exact same shape. */
function strictIso(iso: string, what: string): { dateOnly: string } | { instant: string } {
  if (typeof iso === "string" && DATE_ONLY.test(iso)) {
    const ms = Date.parse(`${iso}T00:00:00.000Z`);
    if (!Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === iso) return { dateOnly: iso };
  } else if (typeof iso === "string" && ISO_DATETIME.test(iso)) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return { instant: new Date(ms).toISOString() };
  }
  throw new DiscoveryError(`Interval ${what} must be an ISO date (YYYY-MM-DD) or an ISO timestamp with a zone, got ${JSON.stringify(iso)}`);
}

/** Date-only -> the first instant of that day; timestamp -> the same instant in UTC. */
export function normalizeIntervalStart(iso: string): string {
  const p = strictIso(iso, "start");
  return "dateOnly" in p ? `${p.dateOnly}T00:00:00.000Z` : p.instant;
}

/** Date-only -> the last instant of that day; timestamp -> the same instant in UTC. */
export function normalizeIntervalEnd(iso: string): string {
  const p = strictIso(iso, "end");
  return "dateOnly" in p ? `${p.dateOnly}T23:59:59.999Z` : p.instant;
}

export interface IntervalRequest {
  from: string;
  to: string;
}

/** Normalized interval as two ISO instants, `from` <= `to`. */
export interface RequestedInterval {
  from: string;
  to: string;
  /** The request as given, for echoing back. */
  requested: IntervalRequest;
}

export function requestedInterval(request: IntervalRequest): RequestedInterval {
  const from = normalizeIntervalStart(request.from);
  const to = normalizeIntervalEnd(request.to);
  if (from > to) throw new DiscoveryError(`Interval start ${request.from} is after its end ${request.to}; the interval is not swapped`);
  return { from, to, requested: { from: request.from, to: request.to } };
}

/** A stored temporal extent (from `temporalInterval`, whose parts may be
 *  date-only) as two instants comparable with a RequestedInterval. */
export function extentInstants(extent: { start: string; end: string }): { start: string; end: string } {
  return { start: normalizeIntervalStart(extent.start), end: normalizeIntervalEnd(extent.end) };
}
