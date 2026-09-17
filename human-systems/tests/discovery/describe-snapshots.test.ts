/**
 * Snapshot series: raw facts per dimension/variable/relationship across
 * SAVED snapshots. "Recorded in k of n saved snapshots", never persistence.
 */
import { describe, expect, it } from "vitest";
import { describeSnapshotSeries } from "@/discovery";
import type { StructuralSignature } from "@/types/signature";

function snap(id: string, createdAt: string, dims: [string, number | null][], vars: [string, number | null, number | null][] = [], edges: [string, string, boolean][] = [], extra: Partial<StructuralSignature> = {}): StructuralSignature {
  return {
    id,
    systemId: "sys",
    subjectId: "sys",
    createdAt,
    schemaVersion: 1,
    definitionId: "d",
    definitionVersion: 1,
    mode: "current",
    dimensions: dims.map(([dimensionId, normalizedValue]) => ({ dimensionId, name: dimensionId, state: normalizedValue === null ? "unknown" : "known", normalizedValue, binaryState: "weak", bandState: "unknown", confidence: 0.5, knownWeightFraction: 1, contributingVariableIds: [], contributions: [], evidenceIds: [], calculationMethod: "", explanation: "", missingInformation: [], binaryThreshold: 0.5, bandThresholds: { veryWeak: 0.2, weak: 0.4, strong: 0.6, veryStrong: 0.8 }, assumptionIds: [] })),
    relationshipSnapshot: edges.map(([s, t, enabled]) => ({ id: `${s}>${t}`, sourceVariableId: s, targetVariableId: t, sourceName: s, targetName: t, direction: "positive", strength: 0.5, lag: { value: 1, unit: "months" }, confidence: 0.5, sourceType: "self_reported", enabled })),
    loopSnapshot: [],
    variableSnapshot: vars.map(([vid, currentValue, normalized]) => ({ id: vid, name: vid, unit: "u", kind: "input", category: "structure", changeSpeed: "slow", currentValue, desiredValue: null, targetMode: "exact", normalized, confidence: 0.5, sourceType: "measured" })),
    dynamics: { strongestReinforcingLoops: [], strongestBalancingLoops: [], highCentralityVariables: [], strongestIncomingInfluences: [], strongestOutgoingInfluences: [], importantLags: [], relationshipConfidence: { count: 0, mean: null, min: null, evidencedShare: null }, loopCounts: { reinforcing: 0, balancing: 0, accepted: 0, rejected: 0 } },
    completeness: 1,
    overallConfidence: 0.5,
    sourceObservationIds: [],
    compactStrip: "",
    ...extra,
  } as StructuralSignature;
}

describe("describeSnapshotSeries", () => {
  const snaps = [
    snap("s1", "2026-01-01T00:00:00.000Z", [["buf", 0.2], ["dep", 0.9]], [["reserves", 1800, 0.3], ["hours", 3, null]], [["a", "b", true]]),
    snap("s2", "2026-04-01T00:00:00.000Z", [["buf", 0.4], ["dep", 0.9]], [["reserves", 2600, 0.43], ["hours", 3, null]], [["a", "b", true], ["b", "c", true]]),
    snap("s3", "2026-07-01T00:00:00.000Z", [["buf", null], ["dep", 0.9]], [["reserves", null, null], ["hours", 3, null]], [["a", "b", false]]),
    snap("s4", "2026-10-01T00:00:00.000Z", [["buf", 0.7], ["dep", 0.9]], [["reserves", 4200, 0.7], ["hours", 3, null]], [["a", "b", true]]),
    snap("s5", "2026-11-01T00:00:00.000Z", [["buf", 0.7]], [], [], { mode: "desired" }),
  ];

  it("reports appearances over total, first and last, values, ranges and equality; no persistence verdict", () => {
    const s = describeSnapshotSeries(snaps);
    expect(s.snapshotsTotal).toBe(4); // the desired-mode one is out of scope
    expect(s.first?.snapshotId).toBe("s1");
    expect(s.last?.snapshotId).toBe("s4");
    const dep = s.dimensions.find((d) => d.dimensionId === "dep")!;
    expect(dep).toMatchObject({ recordedIn: 4, snapshotsTotal: 4, min: 0.9, max: 0.9, normalizedRange: 0, allEqual: true, otherDimensionsWithDifferentValues: ["buf"] });
    expect(dep.statement).toBe("dep: recorded in 4 of 4 saved snapshots; the same value (0.9) each time. Nothing is known about the time between snapshots.");
    const buf = s.dimensions.find((d) => d.dimensionId === "buf")!;
    expect(buf).toMatchObject({ recordedIn: 3, min: 0.2, max: 0.7, allEqual: false });
    expect(buf.normalizedRange).toBeCloseTo(0.5, 9);
    expect(buf.statement).toMatch(/recorded in 3 of 4 saved snapshots; recorded values 0.2 to 0.7/);
    expect("persistent" in dep).toBe(false);
    expect("mean" in dep).toBe(false);
  });

  it("variables: raw range always, normalized range only when every known snapshot carried one", () => {
    const s = describeSnapshotSeries(snaps);
    const reserves = s.variables.find((v) => v.variableId === "reserves")!;
    expect(reserves).toMatchObject({ recordedIn: 3, rawRange: 2400, allEqual: false });
    expect(reserves.normalizedRange).toBeCloseTo(0.4, 9);
    const hours = s.variables.find((v) => v.variableId === "hours")!;
    expect(hours).toMatchObject({ recordedIn: 4, rawRange: 0, normalizedRange: null, allEqual: true });
    expect(hours.statement).toMatch(/the same value \(3\) each time/);
  });

  it("relationships: recorded in k of n saved snapshots (enabled only), nothing about the time between", () => {
    const s = describeSnapshotSeries(snaps);
    const ab = s.relationships.find((r) => r.key === "a>b:positive")!;
    expect(ab).toMatchObject({ recordedIn: 3, snapshotsTotal: 4 });
    expect(ab.statement).toMatch(/recorded in 3 of 4 saved snapshots/);
    expect(ab.statement).not.toMatch(/persist/);
    expect(s.relationships.find((r) => r.key === "b>c:positive")!.recordedIn).toBe(1);
  });

  it("interval and subject scoping use the values instant (valuesAsOf when present)", () => {
    const asOf = snap("s6", "2026-12-01T00:00:00.000Z", [["buf", 0.1]], [], [], { valuesAsOf: "2026-02-15T00:00:00.000Z" });
    const s = describeSnapshotSeries([...snaps, asOf], { interval: { from: "2026-02-01", to: "2026-05-31" } });
    expect(s.snapshotsTotal).toBe(2); // s2 (April) and s6 (values as of February)
    expect(s.first?.snapshotId).toBe("s6");
    expect(s.first?.valuesAt).toBe("2026-02-15T00:00:00.000Z");
    expect(describeSnapshotSeries(snaps, { subjectId: "nobody" }).snapshotsTotal).toBe(0);
    expect(describeSnapshotSeries([]).first).toBeNull();
  });
});
