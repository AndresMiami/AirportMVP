import { describe, expect, it } from "vitest";
import {
  canonicalRotation,
  findFeedbackLoops,
  loopGain,
  loopIdFor,
  loopMeanStrength,
  loopPolarity,
  loopPressure,
  networkInfluence,
  propagateDirectionalPressure,
} from "@/calculations/graph";
import type { Relationship } from "@/types";

const edge = (id: string, from: string, to: string, direction: "positive" | "negative", strength = 0.5, lagMonths = 0): Relationship => ({
  id,
  sourceVariableId: from,
  targetVariableId: to,
  kind: "causal_hypothesis",
  participatesInDynamics: true,
  direction,
  strength,
  lag: { value: lagMonths, unit: "months" },
  confidence: 0.6,
  sourceType: "self_reported",
  evidence: [],
  explanation: "",
  notes: "",
  enabled: true,
});

describe("A9 polarity and gain", () => {
  it("even negatives -> reinforcing, odd -> balancing", () => {
    expect(loopPolarity(["positive", "positive"])).toBe("reinforcing");
    expect(loopPolarity(["negative", "negative"])).toBe("reinforcing");
    expect(loopPolarity(["negative"])).toBe("balancing");
    expect(loopPolarity(["negative", "negative", "negative"])).toBe("balancing");
  });
  it("gain is the product, mean strength the geometric mean", () => {
    expect(loopGain([0.5, 0.5])).toBeCloseTo(0.25, 9);
    expect(loopMeanStrength([0.5, 0.5])).toBeCloseTo(0.5, 9);
    expect(loopMeanStrength([0.25, 1])).toBeCloseTo(0.5, 9);
    expect(loopMeanStrength([])).toBe(0);
  });
  it("canonical rotation starts at the smallest id", () => {
    expect(canonicalRotation(["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(loopIdFor(["c", "a", "b"])).toBe("a>b>c");
    expect(loopIdFor(["b", "c", "a"])).toBe(loopIdFor(["a", "b", "c"]));
  });
});

describe("findFeedbackLoops", () => {
  it("finds a simple 3-cycle once with edges in rotated order", () => {
    const loops = findFeedbackLoops([edge("e1", "b", "c", "positive"), edge("e2", "c", "a", "negative"), edge("e3", "a", "b", "negative")]);
    expect(loops).toHaveLength(1);
    expect(loops[0].variableIds).toEqual(["a", "b", "c"]);
    expect(loops[0].edgeIds).toEqual(["e3", "e1", "e2"]);
    expect(loops[0].polarity).toBe("reinforcing");
    expect(loops[0].negativeEdgeCount).toBe(2);
  });
  it("ignores paths that do not close and finds two overlapping cycles", () => {
    const loops = findFeedbackLoops([
      edge("e1", "a", "b", "positive"),
      edge("e2", "b", "a", "positive"),
      edge("e3", "b", "c", "positive"),
      edge("e4", "c", "a", "negative"),
      edge("e5", "c", "d", "positive"), // dead end
    ]);
    const ids = loops.map((l) => l.id).sort();
    expect(ids).toEqual(["a>b", "a>b>c"]);
    expect(loops.find((l) => l.id === "a>b>c")!.polarity).toBe("balancing");
  });
  it("sums lags into cycle time and takes the min confidence", () => {
    const loops = findFeedbackLoops([edge("e1", "a", "b", "positive", 0.5, 2), { ...edge("e2", "b", "a", "positive", 0.5, 3), confidence: 0.2 }]);
    expect(loops[0].cycleTimeMonths).toBe(5);
    expect(loops[0].minConfidence).toBe(0.2);
  });
  it("distinguishes parallel edges with a #n suffix", () => {
    const loops = findFeedbackLoops([edge("e1", "a", "b", "positive"), edge("e2", "b", "a", "positive"), edge("e3", "b", "a", "negative")]);
    expect(loops.map((l) => l.id).sort()).toEqual(["a>b", "a>b#2"]);
  });
  it("respects maxLength", () => {
    const ring = ["a", "b", "c", "d", "e"].map((v, i, arr) => edge(`e${i}`, v, arr[(i + 1) % arr.length], "positive"));
    expect(findFeedbackLoops(ring)).toHaveLength(1);
    expect(findFeedbackLoops(ring, { maxLength: 4 })).toHaveLength(0);
  });
  it("returns nothing for an acyclic graph", () => {
    expect(findFeedbackLoops([edge("e1", "a", "b", "positive"), edge("e2", "b", "c", "positive")])).toEqual([]);
  });
});

describe("A10 loop pressure", () => {
  it("is mean strength x mean gap over variables with gaps", () => {
    const [loop] = findFeedbackLoops([edge("e1", "a", "b", "positive", 0.25), edge("e2", "b", "a", "positive", 1)]);
    expect(loopPressure(loop, new Map([["a", 0.4], ["b", 0.8]]))).toBeCloseTo(0.5 * 0.6, 9);
    expect(loopPressure(loop, new Map([["a", 0.4]]))).toBeCloseTo(0.5 * 0.4, 9);
    expect(loopPressure(loop, new Map())).toBeNull();
  });
});

describe("A12 directional propagation", () => {
  const edges = [
    edge("e1", "floor", "pressure", "negative", 0.8),
    edge("e2", "pressure", "horizon", "negative", 0.5),
    edge("e3", "horizon", "hours", "positive", 0.5),
  ];
  it("flips sign on negative edges and multiplies strength along the path", () => {
    const out = propagateDirectionalPressure(edges, new Map([["floor", 1]]));
    const by = new Map(out.map((p) => [p.variableId, p]));
    expect(by.get("pressure")!.tendency).toBe("down");
    expect(by.get("pressure")!.score).toBeCloseTo(-0.8, 9);
    expect(by.get("horizon")!.tendency).toBe("up");
    expect(by.get("horizon")!.score).toBeCloseTo(0.4, 9);
    expect(by.get("hours")!.score).toBeCloseTo(0.2, 9);
  });
  it("excludes seeds, respects depth, and reports mixed pressure", () => {
    const out = propagateDirectionalPressure(edges, new Map([["floor", 1]]), { maxDepth: 1 });
    expect(out.map((p) => p.variableId)).toEqual(["pressure"]);
    const mixed = propagateDirectionalPressure(
      [edge("e1", "a", "t", "positive", 0.5), edge("e2", "b", "t", "negative", 0.5)],
      new Map([["a", 1], ["b", 1]]),
    );
    expect(mixed[0].tendency).toBe("mixed");
    expect(mixed[0].pathCount).toBe(2);
  });
  it("terminates on cycles", () => {
    const out = propagateDirectionalPressure([edge("e1", "a", "b", "positive"), edge("e2", "b", "a", "positive")], new Map([["a", 1]]));
    expect(out).toHaveLength(1);
    expect(out[0].variableId).toBe("b");
  });
});

describe("network influence", () => {
  it("scales the most influential node to 1 and sinks to 0", () => {
    const inf = networkInfluence([edge("e1", "a", "b", "positive", 1), edge("e2", "b", "c", "positive", 1)]);
    expect(inf.get("a")).toBe(1);
    expect(inf.get("c")).toBe(0);
    expect(inf.get("b")!).toBeGreaterThan(0);
    expect(inf.get("b")!).toBeLessThan(1);
  });
});
