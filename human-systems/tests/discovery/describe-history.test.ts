/**
 * describeVariableHistory: non-exclusive evidence facts over ONE input
 * variable's value history and ONE requested interval.
 *
 *   RESOLUTION != OBSERVATION != RECURRENCE
 *   RECORDED AGAIN != CONTINUOUSLY PRESENT != STRUCTURAL != CAUSAL
 *
 * Cases A-M from the checkpoint's test matrix, on a synthetic generic
 * variable (no domain at all: the function reads only the stored record).
 */
import { describe, expect, it } from "vitest";
import { describeVariableHistory, DiscoveryError, type VariableHistoryDescription } from "@/discovery";
import { VariableSchema, type StoredVariable, type TemporalRef, type ValueEntry } from "@/types";

const A23 = { assumptionId: "A23" as const, tolerance: 0.1 };

type EntrySpec = Partial<ValueEntry> & { id: string; value: number | null; valid: TemporalRef };

function entry(spec: EntrySpec): ValueEntry {
  return {
    validBasis: "asserted",
    recordedAt: "2026-09-01T00:00:00.000Z",
    sourceType: "self_reported",
    confidence: 0.7,
    evidence: [],
    observationIds: [],
    note: "",
    status: "active",
    ...spec,
  };
}

const date = (iso: string, text = iso): TemporalRef => ({ kind: "date", start: iso, precision: "day", text });
const instant = (iso: string): TemporalRef => ({ kind: "instant", start: iso, precision: "datetime", text: iso });
const range = (start: string, end: string, text = `${start} to ${end}`): TemporalRef => ({ kind: "range", start, end, precision: "day", text });
const approx = (start: string, text: string): TemporalRef => ({ kind: "approx", start, precision: "month", text });
const unknownTime = (text: string): TemporalRef => ({ kind: "unknown", precision: "unspecified", text });

function variable(entries: ValueEntry[], extra: Partial<StoredVariable> = {}): StoredVariable {
  return VariableSchema.parse({
    id: "input_a",
    key: "input_a",
    subjectId: "sys",
    name: "Input A",
    category: "structure",
    changeSpeed: "slow",
    kind: "input",
    unit: "u",
    controllability: 0.5,
    durability: 0.5,
    estimatedCostToChange: 0.5,
    values: entries,
    ...extra,
  });
}

const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const noFacts = (d: VariableHistoryDescription, keys: (keyof VariableHistoryDescription["facts"])[]) => {
  for (const k of keys) expect(d.facts[k], k).toBe(false);
};

describe("describeVariableHistory", () => {
  it("refuses a derived variable deterministically (its recomputation belongs to describeInterval)", () => {
    const derived = variable([], { kind: "derived", formulaId: "ratio" });
    expect(() => describeVariableHistory(derived, YEAR)).toThrow(DiscoveryError);
    expect(() => describeVariableHistory(derived, YEAR)).toThrow(/input variables only/);
  });

  it("A. exact repetition: Jan 5, Jun 5 -> the same value at two distinct application times, and nothing about the months between", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: date("2026-01-10") }), entry({ id: "e2", value: 5, valid: date("2026-06-10") })]), YEAR);
    expect(d.facts.exactRepetition).toBe(true);
    expect(d.facts.allKnownValuesEqual).toBe(true);
    expect(d.repeatedValues).toEqual([{ value: 5, applicationTimes: ["2026-01-10T00:00:00.000Z", "2026-06-10T00:00:00.000Z"] }]);
    expect(d.distinctApplicationTimeCount).toBe(2);
    expect(d.knownRecordCount).toBe(2);
    expect(d.differingRecordedPairs).toBe(0);
    expect(d.variation).toMatchObject({ min: 5, max: 5, rawRange: 0, normalizedRange: null, convention: null });
    noFacts(d, ["explicitIntervalClaim", "explicitUnknownPresent", "unknownInterruption", "ambiguityPresent", "unorderableEvidencePresent", "insufficientForRecurrence", "lowRecordedVariation"]);
    // the end boundary (Dec 31) resolves to the June record by carry-forward: resolution, not observation
    expect(d.atEnd).toMatchObject({ value: 5, resolutionState: "resolved", entryId: "e2", carriedForward: true, carriedFrom: "2026-06-10T00:00:00.000Z" });
    expect(d.atStart).toMatchObject({ value: null, resolutionState: "before_first", entryId: null, carriedForward: false });
    expect(d.facts.lastKnownCarryForward).toBe(true);
    expect(d.caveats.map((c) => c.code)).toEqual(expect.arrayContaining(["repetition_not_continuity", "carry_forward"]));
    expect(d.summaryClass).toBe("repeated");
  });

  it("B. repetition interrupted by an explicit unknown: Jan 5, Mar null, Jun 5 -> repetition AND unknown AND interruption, all at once", () => {
    const d = describeVariableHistory(
      variable([entry({ id: "e1", value: 5, valid: date("2026-01-10") }), entry({ id: "e2", value: null, valid: date("2026-03-10") }), entry({ id: "e3", value: 5, valid: date("2026-06-10") })]),
      YEAR,
    );
    expect(d.facts.exactRepetition).toBe(true);
    expect(d.facts.explicitUnknownPresent).toBe(true);
    expect(d.facts.unknownInterruption).toBe(true);
    expect(d.unknownInterruptions).toBe(1);
    expect(d.explicitUnknownCount).toBe(1);
    expect(d.applicationTimes.map((t) => t.kind)).toEqual(["known", "unknown", "known"]);
    expect(d.facts.ambiguityPresent).toBe(false);
    expect(d.caveats.map((c) => c.code)).toContain("unknown_interruption");
    expect(d.caveats.find((c) => c.code === "unknown_interruption")!.text).toMatch(/unresolved/);
    // the summary keeps the repetition; the facts keep the unknown
    expect(d.summaryClass).toBe("repeated");
    // and a request for March alone resolves to the recorded unknown, not to 5
    const march = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: date("2026-01-10") }), entry({ id: "e2", value: null, valid: date("2026-03-10") })]), { from: "2026-03-15", to: "2026-03-31" });
    expect(march.atStart).toMatchObject({ value: null, recordedUnknown: true, entryId: "e2", carriedForward: true });
    expect(march.summaryClass).toBe("unresolved");
  });

  it("differing records are counted as RECORD comparisons, never as real-world changes: Jan 5, Mar null, Jun 10", () => {
    const d = describeVariableHistory(
      variable([entry({ id: "e1", value: 5, valid: date("2026-01-10") }), entry({ id: "e2", value: null, valid: date("2026-03-10") }), entry({ id: "e3", value: 10, valid: date("2026-06-10") })]),
      YEAR,
    );
    expect(d.differingRecordedPairs).toBe(1);
    expect(d.distinctKnownValues).toEqual([5, 10]);
    expect(d.facts.exactRepetition).toBe(false);
    expect(d.facts.unknownInterruption).toBe(true);
    expect("valueChanges" in d).toBe(false);
    expect(d.summaryClass).toBe("changed");
  });

  it("C. low recorded variation: a reference range AND the explicitly applied A23 convention", () => {
    const v = variable([entry({ id: "e1", value: 1800, valid: date("2026-01-10") }), entry({ id: "e2", value: 2100, valid: date("2026-08-10") })], { referenceRange: { min: 0, max: 6000 } });
    const withConvention = describeVariableHistory(v, YEAR, { lowVariation: A23 });
    expect(withConvention.variation).toMatchObject({ min: 1800, max: 2100, rawRange: 300, normalizedRange: 0.05, referenceRange: { min: 0, max: 6000 }, convention: { assumptionId: "A23", tolerance: 0.1, applied: true, applicable: true } });
    expect(withConvention.facts.lowRecordedVariation).toBe(true);
    expect(withConvention.facts.exactRepetition).toBe(false);
    expect(withConvention.summaryClass).toBe("low_variation");
    expect(withConvention.caveats.map((c) => c.code)).toContain("a23_display");
    // without the convention the output still exists: raw range only, no classification
    const without = describeVariableHistory(v, YEAR);
    expect(without.variation).toMatchObject({ min: 1800, max: 2100, rawRange: 300, normalizedRange: null, convention: null });
    expect(without.facts.lowRecordedVariation).toBe(false);
    expect(without.summaryClass).toBe("changed");
    // a wider move is not low variation under the same convention
    const wide = describeVariableHistory(variable([entry({ id: "e1", value: 1800, valid: date("2026-01-10") }), entry({ id: "e2", value: 3000, valid: date("2026-08-10") })], { referenceRange: { min: 0, max: 6000 } }), YEAR, { lowVariation: A23 });
    expect(wide.variation.normalizedRange).toBeCloseTo(0.2, 9);
    expect(wide.facts.lowRecordedVariation).toBe(false);
    // exact equality never goes through the convention
    const equal = describeVariableHistory(variable([entry({ id: "e1", value: 1800, valid: date("2026-01-10") }), entry({ id: "e2", value: 1800, valid: date("2026-08-10") })], { referenceRange: { min: 0, max: 6000 } }), YEAR, { lowVariation: A23 });
    expect(equal.facts.exactRepetition).toBe(true);
    expect(equal.variation.normalizedRange).toBeNull();
    expect(equal.variation.convention).toMatchObject({ applied: true, applicable: false });
    expect(equal.facts.lowRecordedVariation).toBe(false);
  });

  it("D. the same raw movement without a reference range: raw range reported, no low-variation classification, no relative substitute", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 1800, valid: date("2026-01-10") }), entry({ id: "e2", value: 2100, valid: date("2026-08-10") })]), YEAR, { lowVariation: A23 });
    expect(d.variation).toMatchObject({ min: 1800, max: 2100, rawRange: 300, normalizedRange: null, referenceRange: null, convention: { assumptionId: "A23", tolerance: 0.1, applied: true, applicable: false } });
    expect(d.facts.lowRecordedVariation).toBe(false);
    expect(d.summaryClass).toBe("changed");
  });

  it("E. last known only: one January instant, requested June-September -> carry-forward at both boundaries, no repetition, no claim", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5000, valid: instant("2026-01-15T10:00:00.000Z") })]), { from: "2026-06-01", to: "2026-09-30" });
    expect(d.atStart).toMatchObject({ value: 5000, resolutionState: "resolved", entryId: "e1", carriedForward: true, carriedFrom: "2026-01-15T10:00:00.000Z" });
    expect(d.atEnd).toMatchObject({ value: 5000, resolutionState: "resolved", entryId: "e1", carriedForward: true });
    expect(d.facts.lastKnownCarryForward).toBe(true);
    expect(d.facts.exactRepetition).toBe(false);
    expect(d.facts.explicitIntervalClaim).toBe(false);
    expect(d.facts.insufficientForRecurrence).toBe(true);
    expect(d.recordsOverlappingInterval).toBe(0); // the January instant does not overlap June-September
    expect(d.recordsStartingInsideInterval).toBe(0);
    expect(d.records[0]).toMatchObject({ overlapsRequestedInterval: false, coversStartBoundary: false, coversEndBoundary: false });
    expect(d.knownRecordCount).toBe(0);
    expect(d.summaryClass).toBe("last_known_only");
    expect(d.caveats.map((c) => c.code)).toContain("carry_forward");
  });

  it("F. an explicit range covering the requested period is an explicit claim with its own extent, not stale carry-forward", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5000, valid: range("2026-01-01", "2026-12-31", "all of 2026") })]), { from: "2026-06-01", to: "2026-09-30" });
    expect(d.facts.explicitIntervalClaim).toBe(true);
    expect(d.explicitIntervalClaims).toEqual([
      {
        entryId: "e1",
        value: 5000,
        assertedStart: "2026-01-01T00:00:00.000Z",
        assertedEnd: "2026-12-31T23:59:59.999Z",
        text: "all of 2026",
        coversRequestedInterval: true,
        overlapStart: "2026-06-01T00:00:00.000Z",
        overlapEnd: "2026-09-30T23:59:59.999Z",
      },
    ]);
    expect(d.records[0]).toMatchObject({ overlapsRequestedInterval: true, coversStartBoundary: true, coversEndBoundary: true, startsInsideRequestedInterval: false });
    expect(d.atStart).toMatchObject({ value: 5000, carriedForward: false, carriedFrom: null });
    expect(d.atEnd).toMatchObject({ value: 5000, carriedForward: false });
    expect(d.facts.lastKnownCarryForward).toBe(false);
    expect(d.facts.exactRepetition).toBe(false);
    expect(d.summaryClass).toBe("explicit_claim");
  });

  it("G. an explicit range partially overlapping the requested period reports the overlap and does not cover the far boundary", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5000, valid: range("2026-03-01", "2026-07-15") })]), { from: "2026-06-01", to: "2026-09-30" });
    expect(d.explicitIntervalClaims[0]).toMatchObject({ coversRequestedInterval: false, overlapStart: "2026-06-01T00:00:00.000Z", overlapEnd: "2026-07-15T23:59:59.999Z" });
    expect(d.records[0]).toMatchObject({ overlapsRequestedInterval: true, coversStartBoundary: true, coversEndBoundary: false });
    expect(d.atStart.carriedForward).toBe(false);
    expect(d.atEnd).toMatchObject({ value: 5000, carriedForward: true, carriedFrom: "2026-03-01T00:00:00.000Z" });
    expect(d.facts.lastKnownCarryForward).toBe(true);
    expect(d.facts.explicitIntervalClaim).toBe(true);
    // a range that ends before the interval does not overlap it at all
    const before = describeVariableHistory(variable([entry({ id: "e1", value: 5000, valid: range("2026-01-01", "2026-02-28") })]), { from: "2026-06-01", to: "2026-09-30" });
    expect(before.facts.explicitIntervalClaim).toBe(false);
    expect(before.recordsOverlappingInterval).toBe(0);
    expect(before.facts.lastKnownCarryForward).toBe(true);
  });

  it("H. duplicate same-start same-value records: two records, ONE application time, not enough for recurrence", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: date("2026-04-01"), recordedAt: "2026-04-01T00:00:00.000Z" }), entry({ id: "e2", value: 5, valid: date("2026-04-01"), recordedAt: "2026-04-02T00:00:00.000Z" })]), YEAR);
    expect(d.records).toHaveLength(2);
    expect(d.knownRecordCount).toBe(2);
    expect(d.applicationTimes).toEqual([{ start: "2026-04-01T00:00:00.000Z", kind: "known", value: 5, entryIds: ["e1", "e2"], approximate: false, recordedBasis: false }]);
    expect(d.distinctApplicationTimeCount).toBe(1);
    expect(d.facts.exactRepetition).toBe(false);
    expect(d.facts.insufficientForRecurrence).toBe(true);
    expect(d.facts.ambiguityPresent).toBe(false);
    expect(d.summaryClass).toBe("insufficient");
  });

  it("I. same-start conflicting values: ambiguity, that time is unusable, the resolver agrees", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: date("2026-04-01") }), entry({ id: "e2", value: 7, valid: date("2026-04-01") }), entry({ id: "e3", value: 5, valid: date("2026-08-01") })]), YEAR);
    expect(d.facts.ambiguityPresent).toBe(true);
    expect(d.ambiguousApplicationTimes).toEqual(["2026-04-01T00:00:00.000Z"]);
    expect(d.applicationTimes.map((t) => t.kind)).toEqual(["ambiguous", "known"]);
    expect(d.distinctApplicationTimeCount).toBe(1); // the ambiguous time is not usable
    expect(d.facts.exactRepetition).toBe(false);
    expect(d.summaryClass).toBe("unresolved");
    // null versus known at the same start is ambiguous too; the known value is not silently chosen
    const nullVsKnown = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: date("2026-04-01") }), entry({ id: "e2", value: null, valid: date("2026-04-01") })]), YEAR);
    expect(nullVsKnown.applicationTimes[0].kind).toBe("ambiguous");
    expect(nullVsKnown.atEnd.resolutionState).toBe("ambiguous");
    expect(nullVsKnown.atEnd.candidateEntryIds.sort()).toEqual(["e1", "e2"]);
    expect(nullVsKnown.facts.ambiguityPresent).toBe(true);
  });

  it("J. an unknown-time record is preserved, counted, flagged, and takes no part in the chronology", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: unknownTime("at some point"), sourceType: "observed" }), entry({ id: "e2", value: 5, valid: date("2026-06-01") })]), YEAR);
    expect(d.entries).toMatchObject({ active: 2, orderable: 1, unorderable: 1 });
    expect(d.unorderableRecordCount).toBe(1);
    expect(d.facts.unorderableEvidencePresent).toBe(true);
    expect(d.records.at(-1)).toMatchObject({ entryId: "e1", orderable: false, validStart: null, validEnd: null, validText: "at some point", overlapsRequestedInterval: false });
    expect(d.applicationTimes).toHaveLength(1); // only the dated record
    expect(d.facts.exactRepetition).toBe(false); // the undated 5 does not make a repetition
    expect(d.provenance).toEqual({ self_reported: 1 }); // overlapping records only
    expect(d.caveats.map((c) => c.code)).toContain("unorderable");
    // only unorderable records -> unresolved, never zero evidence
    const only = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: unknownTime("once") })]), YEAR);
    expect(only.summaryClass).toBe("unresolved");
    expect(only.atEnd.resolutionState).toBe("unorderable_only");
  });

  it("K. an approximate month is dated evidence that stays approximate; recurrence relying on it says so", () => {
    const d = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: approx("2026-03-01", "around March") }), entry({ id: "e2", value: 5, valid: date("2026-08-01") })]), YEAR);
    expect(d.records[0]).toMatchObject({ approximate: true, validKind: "approx", validStart: "2026-03-01T00:00:00.000Z", validEnd: "2026-03-31T23:59:59.999Z", validText: "around March", orderable: true });
    expect(d.facts.approximateTimingPresent).toBe(true);
    expect(d.facts.exactRepetition).toBe(true);
    expect(d.facts.recurrenceReliesOnApproximateTiming).toBe(true);
    expect(d.caveats.map((c) => c.code)).toContain("approximate_timing");
    expect(d.applicationTimes[0].approximate).toBe(true);
  });

  it("L. observed time comes only from the explicit field; absent means null, never valid or recordedAt", () => {
    const d = describeVariableHistory(
      variable([
        entry({ id: "e1", value: 5, valid: date("2026-02-01"), recordedAt: "2026-02-03T00:00:00.000Z" }),
        entry({ id: "e2", value: 5, valid: date("2026-07-01"), observed: { kind: "date", start: "2026-07-04", precision: "day", text: "checked on July 4" } }),
      ]),
      YEAR,
    );
    expect(d.records[0]).toMatchObject({ observedKind: null, observedStart: null, observedEnd: null, observedPrecision: null, observedText: null });
    expect(d.records[1]).toMatchObject({ observedKind: "date", observedStart: "2026-07-04T00:00:00.000Z", observedEnd: "2026-07-04T23:59:59.999Z", observedText: "checked on July 4" });
    expect(d.firstObserved).toBe("2026-07-04T00:00:00.000Z");
    expect(d.lastObserved).toBe("2026-07-04T23:59:59.999Z");
    expect(d.firstApplicable).toBe("2026-02-01T00:00:00.000Z");
    // no observed field anywhere -> nulls
    const none = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: date("2026-02-01") })]), YEAR);
    expect(none.firstObserved).toBeNull();
    expect(none.lastObserved).toBeNull();
  });

  it("M. validBasis 'recorded' stays visible per record and carries a caveat when recurrence relies on it", () => {
    const d = describeVariableHistory(
      variable([entry({ id: "e1", value: 5, valid: instant("2026-02-01T00:00:00.000Z"), validBasis: "recorded" }), entry({ id: "e2", value: 5, valid: date("2026-07-01"), validBasis: "asserted" })]),
      YEAR,
    );
    expect(d.records.map((r) => r.validBasis)).toEqual(["recorded", "asserted"]);
    expect(d.facts.recordedBasisPresent).toBe(true);
    expect(d.facts.recurrenceReliesOnRecordedBasis).toBe(true);
    expect(d.caveats.find((c) => c.code === "recorded_basis")!.text).toMatch(/not necessarily when the condition began or was observed/);
    // asserted-only recurrence carries no such caveat
    const asserted = describeVariableHistory(variable([entry({ id: "e1", value: 5, valid: date("2026-02-01") }), entry({ id: "e2", value: 5, valid: date("2026-07-01") })]), YEAR);
    expect(asserted.facts.recurrenceReliesOnRecordedBasis).toBe(false);
    expect(asserted.caveats.map((c) => c.code)).not.toContain("recorded_basis");
  });

  it("superseded and retracted entries are counted but drive no evidence", () => {
    const d = describeVariableHistory(
      variable([
        entry({ id: "e1", value: 5, valid: date("2026-02-01"), status: "superseded" }),
        entry({ id: "e2", value: 5, valid: date("2026-07-01"), status: "retracted", retractedAt: "2026-07-02T00:00:00.000Z", retractReason: "typo" }),
        entry({ id: "e3", value: 9, valid: date("2026-08-01") }),
      ]),
      YEAR,
    );
    expect(d.entries).toMatchObject({ total: 3, active: 1, superseded: 1, retracted: 1 });
    expect(d.records.map((r) => r.entryId)).toEqual(["e3"]);
    expect(d.facts.exactRepetition).toBe(false);
    expect(d.distinctKnownValues).toEqual([9]);
    expect(d.atStart.resolutionState).toBe("before_first");
  });

  it("no entries at all: insufficient, every boundary unresolved, nothing invented", () => {
    const d = describeVariableHistory(variable([]), YEAR);
    expect(d.entries.total).toBe(0);
    expect(d.atStart.resolutionState).toBe("no_entries");
    expect(d.variation).toMatchObject({ min: null, max: null, rawRange: null, normalizedRange: null });
    expect(d.confidence).toBeNull();
    expect(d.provenance).toEqual({});
    expect(d.summaryClass).toBe("insufficient");
    expect(Object.values(d.facts).filter(Boolean)).toEqual([true]); // only insufficientForRecurrence
  });

  it("provenance counts and confidence min/max cover the overlapping records only; nothing is averaged", () => {
    const d = describeVariableHistory(
      variable([
        entry({ id: "e0", value: 1, valid: date("2025-01-01"), sourceType: "estimated", confidence: 0.1 }),
        entry({ id: "e1", value: 5, valid: date("2026-02-01"), sourceType: "measured", confidence: 0.9 }),
        entry({ id: "e2", value: 6, valid: date("2026-07-01"), sourceType: "self_reported", confidence: 0.4 }),
      ]),
      YEAR,
    );
    expect(d.provenance).toEqual({ measured: 1, self_reported: 1 });
    expect(d.confidence).toEqual({ min: 0.4, max: 0.9 });
    expect("mean" in d.variation).toBe(false);
  });
});
