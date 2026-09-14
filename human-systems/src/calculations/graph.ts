/**
 * Directed-graph calculations over relationships (assumptions A9, A10, A12).
 *
 * Loops are DERIVED from the edges, never stored: if the edges change, the
 * loops change with them. Loop ids are canonical (rotation-invariant) so
 * annotations can be attached to them stably.
 */
import type { EdgeDirection, Relationship } from "@/types";

export type LoopPolarity = "reinforcing" | "balancing";

export interface FeedbackLoop {
  id: string;
  /** Variable ids in traversal order, starting at the lexically smallest. */
  variableIds: string[];
  /** Edge ids in the same order (edge i goes from variable i to i+1 mod n). */
  edgeIds: string[];
  polarity: LoopPolarity;
  negativeEdgeCount: number;
  /** Product of edge strengths (A9). */
  gain: number;
  /** Geometric mean of edge strengths: comparable across loop lengths. */
  meanStrength: number;
  /** Sum of edge lags: rough time for one trip around the loop. */
  cycleTimeMonths: number;
  /** Minimum edge confidence along the loop. */
  minConfidence: number;
}

/** Rotate a cycle so the lexically smallest variable id comes first. */
export function canonicalRotation(ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  let minIdx = 0;
  for (let i = 1; i < ids.length; i += 1) if (ids[i] < ids[minIdx]) minIdx = i;
  return [...ids.slice(minIdx), ...ids.slice(0, minIdx)];
}

export function loopIdFor(ids: readonly string[]): string {
  return canonicalRotation(ids).join(">");
}

/** A9: even number of negative edges -> reinforcing. */
export function loopPolarity(directions: readonly EdgeDirection[]): LoopPolarity {
  const negatives = directions.filter((d) => d === "negative").length;
  return negatives % 2 === 0 ? "reinforcing" : "balancing";
}

/** A9: gain = product of edge strengths. */
export function loopGain(strengths: readonly number[]): number {
  return strengths.reduce((p, s) => p * s, 1);
}

/** Geometric mean of edge strengths (A10). 0 when any edge is 0. */
export function loopMeanStrength(strengths: readonly number[]): number {
  if (strengths.length === 0) return 0;
  return Math.pow(loopGain(strengths), 1 / strengths.length);
}

function outgoing(relationships: readonly Relationship[]): Map<string, Relationship[]> {
  const out = new Map<string, Relationship[]>();
  for (const r of relationships) {
    if (!out.has(r.sourceVariable)) out.set(r.sourceVariable, []);
    out.get(r.sourceVariable)!.push(r);
  }
  return out;
}

/**
 * Enumerate all simple cycles (no repeated vertex) with a bound on length.
 * A DFS from each vertex only visits vertices that sort after the start,
 * which yields every cycle exactly once. Parallel edges between the same
 * pair produce distinct loops whose ids get a "#n" suffix.
 */
export function findFeedbackLoops(
  relationships: readonly Relationship[],
  options: { maxLength?: number } = {},
): FeedbackLoop[] {
  const maxLength = options.maxLength ?? 12;
  const vertices = Array.from(
    new Set(relationships.flatMap((r) => [r.sourceVariable, r.targetVariable])),
  ).sort();
  const index = new Map(vertices.map((v, i) => [v, i]));
  const out = outgoing(relationships);

  const loops: FeedbackLoop[] = [];
  const idCounts = new Map<string, number>();

  for (const start of vertices) {
    const startIdx = index.get(start)!;
    const pathVars: string[] = [start];
    const pathEdges: Relationship[] = [];
    const onPath = new Set<string>([start]);

    const dfs = (current: string) => {
      for (const edge of out.get(current) ?? []) {
        const next = edge.targetVariable;
        const nextIdx = index.get(next)!;
        if (nextIdx < startIdx) continue; // found from the smaller start vertex instead
        if (next === start) {
          const loop = buildLoop(pathVars, [...pathEdges, edge]);
          const n = (idCounts.get(loop.id) ?? 0) + 1;
          idCounts.set(loop.id, n);
          if (n > 1) loop.id = `${loop.id}#${n}`;
          loops.push(loop);
          continue;
        }
        if (onPath.has(next) || pathVars.length >= maxLength) continue;
        onPath.add(next);
        pathVars.push(next);
        pathEdges.push(edge);
        dfs(next);
        pathEdges.pop();
        pathVars.pop();
        onPath.delete(next);
      }
    };
    dfs(start);
  }
  loops.sort((a, b) => b.meanStrength - a.meanStrength || a.id.localeCompare(b.id));
  return loops;
}

function buildLoop(vars: readonly string[], edges: readonly Relationship[]): FeedbackLoop {
  const rotated = canonicalRotation(vars);
  const offset = vars.indexOf(rotated[0]);
  const edgeIds = edges.map((_, i) => edges[(i + offset) % edges.length].id);
  const directions = edges.map((e) => e.direction);
  return {
    id: rotated.join(">"),
    variableIds: rotated,
    edgeIds,
    polarity: loopPolarity(directions),
    negativeEdgeCount: directions.filter((d) => d === "negative").length,
    gain: loopGain(edges.map((e) => e.strength)),
    meanStrength: loopMeanStrength(edges.map((e) => e.strength)),
    cycleTimeMonths: edges.reduce((s, e) => s + e.lagMonths, 0),
    minConfidence: Math.min(...edges.map((e) => e.confidence)),
  };
}

/**
 * A10: loop pressure = mean edge strength x mean normalised gap over the
 * loop's variables that have a gap. Returns null when no loop variable has
 * a gap.
 */
export function loopPressure(
  loop: FeedbackLoop,
  normalizedGapById: ReadonlyMap<string, number>,
): number | null {
  const gaps = loop.variableIds
    .map((id) => normalizedGapById.get(id))
    .filter((g): g is number => g !== undefined);
  if (gaps.length === 0) return null;
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  return loop.meanStrength * mean;
}

export type Tendency = "up" | "down" | "mixed" | "none";

export interface DirectionalPressure {
  variableId: string;
  /** Signed sum of path weights; positive pushes up. */
  score: number;
  tendency: Tendency;
  /** Number of distinct paths that reached this variable. */
  pathCount: number;
}

/**
 * A12: propagate the SIGN of a change through the graph.
 * `seeds` maps variable id -> +1 (pushed up) or -1 (pushed down).
 * Each simple path contributes sign x product(strength) to its endpoint.
 * Seeds themselves are excluded from the output.
 */
export function propagateDirectionalPressure(
  relationships: readonly Relationship[],
  seeds: ReadonlyMap<string, 1 | -1>,
  options: { maxDepth?: number; mixedThreshold?: number } = {},
): DirectionalPressure[] {
  const maxDepth = options.maxDepth ?? 4;
  const mixedThreshold = options.mixedThreshold ?? 0.25;
  const out = outgoing(relationships);
  const positive = new Map<string, number>();
  const negative = new Map<string, number>();
  const paths = new Map<string, number>();

  const walk = (node: string, sign: number, weight: number, depth: number, visited: Set<string>) => {
    if (depth >= maxDepth) return;
    for (const edge of out.get(node) ?? []) {
      const next = edge.targetVariable;
      if (visited.has(next)) continue;
      const nextSign = edge.direction === "positive" ? sign : -sign;
      const nextWeight = weight * edge.strength;
      if (nextWeight <= 0) continue;
      if (!seeds.has(next)) {
        if (nextSign > 0) positive.set(next, (positive.get(next) ?? 0) + nextWeight);
        else negative.set(next, (negative.get(next) ?? 0) + nextWeight);
        paths.set(next, (paths.get(next) ?? 0) + 1);
      }
      visited.add(next);
      walk(next, nextSign, nextWeight, depth + 1, visited);
      visited.delete(next);
    }
  };

  for (const [seed, sign] of seeds) walk(seed, sign, 1, 0, new Set([seed]));

  const ids = new Set([...positive.keys(), ...negative.keys()]);
  const results: DirectionalPressure[] = [];
  for (const id of ids) {
    const up = positive.get(id) ?? 0;
    const down = negative.get(id) ?? 0;
    const score = up - down;
    const total = up + down;
    let tendency: Tendency = "none";
    if (total > 0) {
      const dominance = Math.abs(score) / total;
      tendency = dominance < mixedThreshold ? "mixed" : score > 0 ? "up" : "down";
    }
    results.push({ variableId: id, score, tendency, pathCount: paths.get(id) ?? 0 });
  }
  results.sort(
    (a, b) => Math.abs(b.score) - Math.abs(a.score) || a.variableId.localeCompare(b.variableId),
  );
  return results;
}

/** Weighted out-reach: how much of the graph a variable can influence, scaled 0..1. */
export function networkInfluence(relationships: readonly Relationship[]): Map<string, number> {
  const vertices = Array.from(
    new Set(relationships.flatMap((r) => [r.sourceVariable, r.targetVariable])),
  );
  const raw = new Map<string, number>();
  for (const v of vertices) {
    const pressures = propagateDirectionalPressure(relationships, new Map([[v, 1]]), { maxDepth: 4 });
    raw.set(v, pressures.reduce((s, p) => s + Math.abs(p.score), 0));
  }
  const max = Math.max(0, ...raw.values());
  const scaled = new Map<string, number>();
  for (const [v, r] of raw) scaled.set(v, max > 0 ? r / max : 0);
  return scaled;
}
