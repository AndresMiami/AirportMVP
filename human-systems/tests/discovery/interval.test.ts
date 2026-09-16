/**
 * Interval boundaries for discovery questions are NOT the resolver's
 * normalizeInstant (which makes every date-only instant the END of its
 * day). A date-only start is the beginning of its day; a date-only end is
 * the end of its day; datetimes stay exact; from > to is refused, never
 * swapped.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryError, extentInstants, normalizeIntervalEnd, normalizeIntervalStart, requestedInterval } from "@/discovery";
import { normalizeInstant } from "@/model/history";

describe("interval boundary helpers", () => {
  it("N. date-only start -> first instant of the day; date-only end -> last instant of the day", () => {
    expect(normalizeIntervalStart("2026-03-01")).toBe("2026-03-01T00:00:00.000Z");
    expect(normalizeIntervalEnd("2026-03-01")).toBe("2026-03-01T23:59:59.999Z");
    // and this is deliberately different from the resolver's as-of rule
    expect(normalizeInstant("2026-03-01")).toBe("2026-03-01T23:59:59.999Z");
    expect(normalizeIntervalStart("2026-03-01")).not.toBe(normalizeInstant("2026-03-01"));
  });

  it("datetime inputs remain exact at both ends", () => {
    expect(normalizeIntervalStart("2026-03-01T12:34:56.000Z")).toBe("2026-03-01T12:34:56.000Z");
    expect(normalizeIntervalEnd("2026-03-01T12:34:56.000Z")).toBe("2026-03-01T12:34:56.000Z");
  });

  it("requestedInterval echoes the request and normalizes both ends; a same-day request spans the whole day", () => {
    const iv = requestedInterval({ from: "2026-03-01", to: "2026-03-01" });
    expect(iv).toEqual({ from: "2026-03-01T00:00:00.000Z", to: "2026-03-01T23:59:59.999Z", requested: { from: "2026-03-01", to: "2026-03-01" } });
  });

  it("O. from > to is a DiscoveryError, never a silent swap; malformed input is refused too", () => {
    expect(() => requestedInterval({ from: "2026-09-01", to: "2026-03-01" })).toThrow(DiscoveryError);
    expect(() => requestedInterval({ from: "2026-09-01", to: "2026-03-01" })).toThrow(/not swapped/);
    expect(() => requestedInterval({ from: "2026-03-01T12:00:00.000Z", to: "2026-03-01T11:59:59.999Z" })).toThrow(DiscoveryError);
    expect(() => requestedInterval({ from: "not a date", to: "2026-03-01" })).toThrow(/Interval start/);
    expect(() => requestedInterval({ from: "2026-03-01", to: "" })).toThrow(/Interval end/);
  });

  it("a stored extent with date-only parts becomes two comparable instants", () => {
    expect(extentInstants({ start: "2026-03-01", end: "2026-03-31" })).toEqual({ start: "2026-03-01T00:00:00.000Z", end: "2026-03-31T23:59:59.999Z" });
  });
});
