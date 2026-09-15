/**
 * Ordering of structured time references (TemporalRef). Comparison never
 * guesses: two references are "before"/"after" only when their intervals
 * do not overlap, "overlaps" when they do, and "not_orderable" when either
 * side has no usable dates.
 */
import type { TemporalRef } from "@/types/primitives";

export type TemporalOrder = "before" | "after" | "overlaps" | "not_orderable";

/** [start, end] as ISO strings, end inclusive of the precision's period. */
export function temporalInterval(t: TemporalRef): { start: string; end: string } | null {
  if (t.kind === "unknown" || !t.start) return null;
  if (t.kind === "instant" || t.kind === "date") return { start: t.start, end: t.end ?? endOfPeriod(t.start, t.precision) };
  if (t.kind === "range") return t.end ? { start: t.start, end: t.end } : null;
  // approx: the stated period, widened to its precision
  return { start: t.start, end: t.end ?? endOfPeriod(t.start, t.precision) };
}

/** Sort key: the start of the interval, null when not orderable. */
export function temporalSortKey(t: TemporalRef): string | null {
  return temporalInterval(t)?.start ?? null;
}

export function compareTemporal(a: TemporalRef, b: TemporalRef): TemporalOrder {
  const ia = temporalInterval(a);
  const ib = temporalInterval(b);
  if (!ia || !ib) return "not_orderable";
  if (ia.end < ib.start) return "before";
  if (ia.start > ib.end) return "after";
  return "overlaps";
}

/** Extend an ISO start to the end of its stated precision period. */
export function endOfPeriod(startIso: string, precision: TemporalRef["precision"]): string {
  const datePart = startIso.slice(0, 10);
  const [y, m] = datePart.split("-").map(Number);
  switch (precision) {
    case "year":
      return `${y}-12-31`;
    case "month": {
      const last = new Date(Date.UTC(y, (m ?? 1), 0)).getUTCDate();
      return `${y}-${String(m ?? 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    }
    case "day":
      return datePart;
    case "datetime":
      return startIso;
    default:
      return startIso.length > 10 ? startIso : datePart;
  }
}

/** Build a reference from a plain ISO date the app is sure about. */
export function exactDate(iso: string, text = iso): TemporalRef {
  return { kind: "date", start: iso, precision: iso.length > 10 ? "datetime" : "day", text };
}

/** Keep the person's words; parse nothing. */
export function unknownTime(text: string): TemporalRef {
  return { kind: "unknown", precision: "unspecified", text };
}

export function formatTemporal(t: TemporalRef): string {
  if (t.text) return t.text;
  const iv = temporalInterval(t);
  if (!iv) return "unknown time";
  if (t.kind === "range") return `${iv.start} to ${iv.end}`;
  if (t.kind === "approx") return `around ${iv.start}`;
  return iv.start;
}
