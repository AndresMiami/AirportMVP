/**
 * TemporalRef ordering: structured time compares by interval; anything
 * without an interval is not orderable (never "before" by accident).
 */
import { describe, expect, it } from "vitest";
import { compareTemporal, endOfPeriod, exactDate, formatTemporal, temporalSortKey, unknownTime } from "@/calculations/time";
import { TemporalRefSchema, type TemporalRef } from "@/types/primitives";

const approx = (start: string, precision: TemporalRef["precision"], text: string): TemporalRef => TemporalRefSchema.parse({ kind: "approx", start, precision, text });
const range = (start: string, end: string, text = `${start}–${end}`): TemporalRef => TemporalRefSchema.parse({ kind: "range", start, end, text });

describe("compareTemporal", () => {
  const jan = exactDate("2026-01-15");
  const mar = approx("2026-03-01", "month", "March 2026");
  const spring = range("2026-03-10", "2026-05-31", "spring 2026");
  const y2026 = approx("2026-01-01", "year", "sometime in 2026");
  const unknown = unknownTime("before the move, not sure when");

  it("orders disjoint intervals and reports overlap otherwise", () => {
    expect(compareTemporal(jan, mar)).toBe("before");
    expect(compareTemporal(mar, jan)).toBe("after");
    expect(compareTemporal(mar, spring)).toBe("overlaps"); // March 2026 runs to the 31st
    expect(compareTemporal(spring, y2026)).toBe("overlaps");
    expect(compareTemporal(jan, y2026)).toBe("overlaps");
    expect(compareTemporal(exactDate("2026-06-01"), spring)).toBe("after");
  });

  it("never orders an unknown time", () => {
    for (const other of [jan, mar, spring, y2026, unknown]) {
      expect(compareTemporal(unknown, other)).toBe("not_orderable");
      expect(compareTemporal(other, unknown)).toBe("not_orderable");
    }
    expect(temporalSortKey(unknown)).toBeNull();
    expect(temporalSortKey(mar)).toBe("2026-03-01");
  });

  it("extends starts to the end of their precision period", () => {
    expect(endOfPeriod("2026-02-01", "month")).toBe("2026-02-28");
    expect(endOfPeriod("2024-02-01", "month")).toBe("2024-02-29");
    expect(endOfPeriod("2026-05-05", "year")).toBe("2026-12-31");
    expect(endOfPeriod("2026-05-05", "day")).toBe("2026-05-05");
  });

  it("the schema refuses incoherent references", () => {
    expect(TemporalRefSchema.safeParse({ kind: "date", text: "no start" }).success).toBe(false);
    expect(TemporalRefSchema.safeParse({ kind: "range", start: "2026-03-01", text: "no end" }).success).toBe(false);
    expect(TemporalRefSchema.safeParse({ kind: "range", start: "2026-03-01", end: "2026-02-01", text: "backwards" }).success).toBe(false);
    expect(TemporalRefSchema.safeParse({ kind: "unknown", text: "" }).success).toBe(true);
  });

  it("formats keeping the person's own words", () => {
    expect(formatTemporal(unknown)).toContain("before the move");
    expect(formatTemporal(mar)).toContain("March 2026");
  });
});
