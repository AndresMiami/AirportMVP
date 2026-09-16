/**
 * changed != crossed the A23 display threshold, and exact equality lives
 * outside the convention. The four pinned cases:
 *   1. 0.50 -> 0.50  unchanged, not within threshold, not changed
 *   2. 0.50 -> 0.55  changed AND within threshold, not at/above
 *   3. 0.50 -> 0.70  changed, increased, at/above threshold
 *   4. raw 100 -> 101 with no normalization: changed, differs_no_scale,
 *      no threshold classification at all
 */
import { describe, expect, it } from "vitest";
import { CHANGE_THRESHOLD, compareSignatures, compareVariables, variableMovement } from "@/signatures/compare";
import type { StructuralSignature, VariableSnapshotItem } from "@/types/signature";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-09-01T00:00:00.000Z";

function dim(id: string, normalizedValue: number | null) {
  return {
    dimensionId: id,
    name: id,
    normalizedValue,
    binaryState: normalizedValue !== null && normalizedValue >= 0.5 ? ("strong" as const) : ("weak" as const),
    bandState: "unknown" as const,
    confidence: 0.8,
    unknownMask: [],
    contributions: [],
    explanation: "",
  };
}

function snapshot(id: string, createdAt: string, dims: ReturnType<typeof dim>[], variables: VariableSnapshotItem[] = []): StructuralSignature {
  return {
    id,
    definitionId: "test_v1",
    definitionVersion: 1,
    domainId: "test",
    subjectId: "sys",
    createdAt,
    mode: "current",
    dimensions: dims,
    compactStrip: "",
    completeness: 1,
    overallConfidence: 0.8,
    variableSnapshot: variables,
    relationshipSnapshot: [],
    loopSnapshot: [],
    dynamics: { strongestIncomingInfluences: [], strongestOutgoingInfluences: [], loopMemberships: [] },
    unknownDimensionIds: [],
    notes: "",
  } as unknown as StructuralSignature;
}

function variable(id: string, currentValue: number | null, normalized: number | null): VariableSnapshotItem {
  return { id, name: id, unit: "u", kind: "input", category: "structure", changeSpeed: "slow", currentValue, desiredValue: null, targetMode: "exact", normalized, sourceType: "measured", confidence: 0.8 } as VariableSnapshotItem;
}

describe("two-snapshot comparison: the fact (same | different) is separate from the A23 display convention", () => {
  const before = snapshot("s1", T1, [dim("same", 0.5), dim("small", 0.5), dim("big", 0.5)]);
  const after = snapshot("s2", T2, [dim("same", 0.5), dim("small", 0.55), dim("big", 0.7)]);
  const cmp = compareSignatures(before, after);
  const ids = (xs: { dimensionId: string }[]) => xs.map((x) => x.dimensionId);

  it("1. 0.50 -> 0.50: unchanged, not within threshold, not changed", () => {
    expect(cmp.dimensions.find((d) => d.dimensionId === "same")!.classification).toBe("unchanged");
    expect(ids(cmp.unchanged)).toEqual(["same"]);
    expect(ids(cmp.withinThreshold)).not.toContain("same");
    expect(ids(cmp.changed)).not.toContain("same");
    expect(ids(cmp.movedAtOrAboveThreshold)).not.toContain("same");
  });

  it("2. 0.50 -> 0.55: changed AND within the display threshold, not at/above it", () => {
    expect(cmp.dimensions.find((d) => d.dimensionId === "small")!.classification).toBe("within_threshold");
    expect(ids(cmp.changed)).toContain("small");
    expect(ids(cmp.withinThreshold)).toEqual(["small"]);
    expect(ids(cmp.movedAtOrAboveThreshold)).not.toContain("small");
    expect(ids(cmp.unchanged)).not.toContain("small");
  });

  it("3. 0.50 -> 0.70: changed, increased, at/above the threshold", () => {
    expect(cmp.dimensions.find((d) => d.dimensionId === "big")!.classification).toBe("increased");
    expect(ids(cmp.changed)).toContain("big");
    expect(ids(cmp.movedAtOrAboveThreshold)).toEqual(["big"]);
    expect(ids(cmp.withinThreshold)).not.toContain("big");
    expect(cmp.changeThreshold).toBe(CHANGE_THRESHOLD);
  });

  it("the groupings partition the known pairs: changed = withinThreshold + movedAtOrAboveThreshold, disjoint from unchanged", () => {
    expect([...ids(cmp.withinThreshold), ...ids(cmp.movedAtOrAboveThreshold)].sort()).toEqual(ids(cmp.changed).sort());
    expect(ids(cmp.changed).filter((id) => ids(cmp.unchanged).includes(id))).toEqual([]);
  });

  it("4. raw 100 -> 101 with no normalization: changed, differs_no_scale, no threshold classification", () => {
    const b = [variable("raw", 100, null), variable("eq", 7, null), variable("scaled_small", 10, 0.5), variable("scaled_big", 10, 0.5)];
    const a = [variable("raw", 101, null), variable("eq", 7, null), variable("scaled_small", 11, 0.55), variable("scaled_big", 14, 0.7)];
    const vars = compareVariables(b, a, CHANGE_THRESHOLD);
    const byId = new Map(vars.map((v) => [v.variableId, v]));
    expect(byId.get("raw")!.classification).toBe("differs_no_scale");
    expect(byId.get("raw")!.movement).toBeNull();
    expect(byId.get("raw")!.delta).toBe(1);
    expect(variableMovement(b[0], a[0])).toBeNull(); // no relative fallback
    expect(byId.get("eq")!.classification).toBe("unchanged");
    expect(byId.get("scaled_small")!.classification).toBe("within_threshold");
    expect(byId.get("scaled_big")!.classification).toBe("increased");

    const cmpV = compareSignatures(snapshot("v1", T1, [], b), snapshot("v2", T2, [], a));
    const vids = (xs: { variableId: string }[]) => xs.map((x) => x.variableId).sort();
    expect(vids(cmpV.variablesUnchanged)).toEqual(["eq"]);
    expect(vids(cmpV.variablesChanged)).toEqual(["raw", "scaled_big", "scaled_small"]);
    expect(vids(cmpV.variablesWithinThreshold)).toEqual(["scaled_small"]);
    expect(vids(cmpV.variablesMovedAtOrAboveThreshold)).toEqual(["scaled_big"]);
    expect(vids(cmpV.variablesDifferNoScale)).toEqual(["raw"]);
  });
});
