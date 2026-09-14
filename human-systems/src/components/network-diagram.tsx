"use client";
/**
 * Simple SVG network: nodes on a circle grouped by category, curved
 * directed edges. Positive edges are solid blue, negative are dashed amber.
 * Highlighted edge ids are drawn thicker; everything else fades.
 */
import { useMemo } from "react";
import { CATEGORY_META } from "@/domain/vocabulary";
import type { Relationship, Variable, VariableCategory } from "@/types";

const CATEGORY_ORDER: VariableCategory[] = [
  "asset",
  "structure",
  "event",
  "buffer",
  "dependency",
  "shock",
  "constraint",
  "person_fit",
  "agency",
];

export function NetworkDiagram({
  variables,
  relationships,
  highlightEdgeIds,
  highlightNodeIds,
  onNodeClick,
}: {
  variables: readonly Variable[];
  relationships: readonly Relationship[];
  highlightEdgeIds?: ReadonlySet<string>;
  highlightNodeIds?: ReadonlySet<string>;
  onNodeClick?: (id: string) => void;
}) {
  const W = 860;
  const H = 620;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 70;

  const { nodes, edges } = useMemo(() => {
    const connected = new Set(relationships.flatMap((r) => [r.sourceVariable, r.targetVariable]));
    const listed = variables
      .filter((v) => connected.has(v.id))
      .sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
          a.name.localeCompare(b.name),
      );
    const n = listed.length;
    const pos = new Map<string, { x: number; y: number; angle: number }>();
    listed.forEach((v, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2;
      pos.set(v.id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle), angle });
    });
    const edges = relationships
      .map((r) => {
        const a = pos.get(r.sourceVariable);
        const b = pos.get(r.targetVariable);
        if (!a || !b) return null;
        // Control point pulled toward the centre and offset to the right of
        // the direction of travel, so A->B and B->A do not overlap.
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const pull = 0.35;
        const cxp = mx + (cx - mx) * pull + nx * 18;
        const cyp = my + (cy - my) * pull + ny * 18;
        // Shorten the end so the arrowhead sits on the node edge.
        const tx = cxp - b.x;
        const ty = cyp - b.y;
        const tl = Math.hypot(tx, ty) || 1;
        const endX = b.x + (tx / tl) * 22;
        const endY = b.y + (ty / tl) * 22;
        return { r, d: `M ${a.x} ${a.y} Q ${cxp} ${cyp} ${endX} ${endY}` };
      })
      .filter((e): e is { r: Relationship; d: string } => e !== null);
    return { nodes: listed.map((v) => ({ v, p: pos.get(v.id)! })), edges };
  }, [variables, relationships, cx, cy, R]);

  const anyHighlight = (highlightEdgeIds && highlightEdgeIds.size > 0) || (highlightNodeIds && highlightNodeIds.size > 0);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px] h-auto" role="img" aria-label="Feedback map">
        <defs>
          <marker id="arrow-pos" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#2f5d8a" />
          </marker>
          <marker id="arrow-neg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#9a6b1f" />
          </marker>
        </defs>
        {edges.map(({ r, d }) => {
          const hl = highlightEdgeIds?.has(r.id) ?? false;
          const faded = anyHighlight && !hl;
          const neg = r.direction === "negative";
          return (
            <path
              key={r.id}
              d={d}
              fill="none"
              stroke={neg ? "#9a6b1f" : "#2f5d8a"}
              strokeWidth={hl ? 3 : 1 + r.strength * 1.5}
              strokeDasharray={neg ? "6 4" : undefined}
              opacity={faded ? 0.15 : 0.85}
              markerEnd={`url(#${neg ? "arrow-neg" : "arrow-pos"})`}
            >
              <title>
                {`${r.sourceVariable} → ${r.targetVariable} (${r.direction}, strength ${r.strength}, lag ${r.lagMonths} mo)\n${r.explanation}`}
              </title>
            </path>
          );
        })}
        {nodes.map(({ v, p }) => {
          const hl = highlightNodeIds?.has(v.id) ?? false;
          const faded = anyHighlight && !hl;
          const derived = v.kind === "derived";
          const onRight = Math.cos(p.angle) > 0.15;
          const onLeft = Math.cos(p.angle) < -0.15;
          const anchor = onRight ? "start" : onLeft ? "end" : "middle";
          const lx = p.x + (onRight ? 26 : onLeft ? -26 : 0);
          const ly = p.y + (onRight || onLeft ? 4 : Math.sin(p.angle) > 0 ? 36 : -28);
          return (
            <g
              key={v.id}
              opacity={faded ? 0.3 : 1}
              onClick={onNodeClick ? () => onNodeClick(v.id) : undefined}
              style={{ cursor: onNodeClick ? "pointer" : "default" }}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={20}
                fill={derived ? "#e6eef7" : "#ffffff"}
                stroke={hl ? "#1f2933" : "#5f6b7a"}
                strokeWidth={hl ? 2.5 : 1.25}
                strokeDasharray={derived ? "3 2" : undefined}
              />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="10" fill="#5f6b7a">
                {CATEGORY_META[v.category].short.slice(0, 5)}
              </text>
              <text x={lx} y={ly} textAnchor={anchor} fontSize="12" fill="#1f2933">
                {v.name.length > 26 ? `${v.name.slice(0, 25)}…` : v.name}
              </text>
              <title>{`${v.name}\n${v.description}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs text-muted mt-2">
        <span>
          <span className="inline-block w-6 border-t-2 border-accent align-middle mr-1" /> positive (same direction)
        </span>
        <span>
          <span className="inline-block w-6 border-t-2 border-dashed border-warn align-middle mr-1" /> negative (opposite direction)
        </span>
        <span>
          <span className="inline-block w-3 h-3 rounded-full border border-dashed border-muted bg-accent-soft align-middle mr-1" /> calculated variable
        </span>
      </div>
    </div>
  );
}
