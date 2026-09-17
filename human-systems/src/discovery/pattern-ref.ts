/**
 * The History -> Explore hand-off: a PatternRef as URL search parameters
 * and back. Strict: a malformed or incomplete reference decodes to null
 * and the screen refuses it, never repairs it.
 */
import { normalizeIntervalEnd, normalizeIntervalStart } from "./interval";
import type { PatternRef } from "./cross-context";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodePatternRef(ref: PatternRef): string {
  const p = new URLSearchParams();
  p.set("variable", ref.variableId);
  if (ref.subjectId !== null) p.set("subject", ref.subjectId);
  p.set("from", ref.interval.from);
  p.set("to", ref.interval.to);
  p.set("value", String(ref.repeatedValue));
  p.set("times", ref.occurrenceTimes.join(","));
  return p.toString();
}

export function decodePatternRef(params: URLSearchParams): PatternRef | null {
  const variableId = params.get("variable");
  const from = params.get("from");
  const to = params.get("to");
  const value = params.get("value");
  const times = params.get("times");
  if (!variableId || !from || !to || value === null || !times) return null;
  const repeatedValue = Number(value);
  if (!Number.isFinite(repeatedValue)) return null;
  try {
    normalizeIntervalStart(from);
    normalizeIntervalEnd(to);
  } catch {
    return null;
  }
  const occurrenceTimes = times.split(",").filter((t) => t.length > 0);
  if (occurrenceTimes.length < 2 || occurrenceTimes.some((t) => !ISO_INSTANT.test(t))) return null;
  return { variableId, subjectId: params.get("subject"), interval: { from, to }, repeatedValue, occurrenceTimes };
}
