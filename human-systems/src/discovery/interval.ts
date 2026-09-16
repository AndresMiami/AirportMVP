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

function requireIso(iso: string, what: string): void {
  if (typeof iso !== "string" || iso.length === 0 || Number.isNaN(Date.parse(iso))) {
    throw new DiscoveryError(`Interval ${what} must be an ISO date or instant, got ${JSON.stringify(iso)}`);
  }
}

/** Date-only -> the first instant of that day; datetime -> unchanged. */
export function normalizeIntervalStart(iso: string): string {
  requireIso(iso, "start");
  return DATE_ONLY.test(iso) ? `${iso}T00:00:00.000Z` : iso;
}

/** Date-only -> the last instant of that day; datetime -> unchanged. */
export function normalizeIntervalEnd(iso: string): string {
  requireIso(iso, "end");
  return DATE_ONLY.test(iso) ? `${iso}T23:59:59.999Z` : iso;
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
