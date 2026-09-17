"use client";
/**
 * Simple SVG network: nodes on a circle grouped by category, curved
 * directed edges. Positive edges are solid blue, negative are dashed amber.
 * Edges that are enabled but take no part in dynamics (unclassified,
 * association, constraint, or definitional not opted in) are thin, grey
 * and finely dotted; disabled edges are thin, lighter gray and dotted with
 * a longer gap. Each edge carries a small lag
 * label at its midpoint (omitted when the lag is immediate). Highlighted
 * edge ids are drawn thicker; everything else fades.
 *
 * Interaction is delegated to the owner: onNodeClick / onEdgeClick report
 * ids, `selectedEdgeId` draws the edge being edited, and in connect mode
 * `pendingSourceId` rings the node picked as the source.
 */
import { useMemo } from "react";
import { formatLag } from "@/calculations/lag";
import { categoryMeta } from "@/domain/vocabulary";
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

const COLOR = {
  positive: "#2f5d8a",
  negative: "#9a6b1f",
  disabled: "#9aa3ad",
  /** Enabled but not part of dynamics: darker than disabled, still neutral. */
  nonDynamics: "#6b7580",
  ink: "#1f2933",
  muted: "#5f6b7a",
  isolated: "#b8c0c9",
  pending: "#3d7a5e",
  derivedFill: "#e6eef7",
};

interface LaidOutEdge {
  r: Relationship;
  d: string;
  /** Midpoint of the curve (t = 0.5), where the lag label sits. */
  lx: number;
  ly: number;
}

function activate(e: React.KeyboardEvent, fn: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}

/** The complete legend for the network: every stroke, the lag label, the calculated-variable ring, and the selection / pending markers when relevant. Rendered under the graph by default, or wherever a simplified surface keeps its full legend. */
export function NetworkLegend({ selectedEdge = false, connectMode = false }: { selectedEdge?: boolean; connectMode?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted mt-2">
      <span>
        <span className="inline-block w-6 border-t-2 border-accent align-middle mr-1" /> positive (same direction)
      </span>
      <span>
        <span className="inline-block w-6 border-t-2 border-dashed border-warn align-middle mr-1" /> negative (opposite direction)
      </span>
      <span>
        <span className="inline-block w-6 border-t border-dotted align-middle mr-1" style={{ borderColor: COLOR.nonDynamics }} /> not in dynamics (unclassified / association / constraint)
      </span>
      <span>
        <span className="inline-block w-6 border-t border-dotted align-middle mr-1" style={{ borderColor: COLOR.disabled, opacity: 0.6 }} /> disabled (kept, excluded from loops)
      </span>
      <span>
        <span className="inline-block rounded border border-border bg-surface px-1 align-middle mr-1 tabular-nums" style={{ fontSize: "0.65rem" }}>
          2 weeks
        </span>
        label = lag (none shown when immediate)
      </span>
      <span>
        <span className="inline-block w-3 h-3 rounded-full border border-dashed border-muted bg-accent-soft align-middle mr-1" /> calculated variable
      </span>
      {selectedEdge ? (
        <span>
          <span className="inline-block w-6 border-t-4 align-middle mr-1" style={{ borderColor: COLOR.ink, opacity: 0.3 }} /> selected edge (open in the editor)
        </span>
      ) : null}
      {connectMode ? (
        <span>
          <span className="inline-block w-3 h-3 rounded-full border-2 border-dashed border-desired align-middle mr-1" /> pending source
        </span>
      ) : null}
    </div>
  );
}

export function NetworkDiagram({
  variables,
  relationships,
  highlightEdgeIds,
  highlightNodeIds,
  selectedEdgeId = null,
  pendingSourceId = null,
  connectMode = false,
  showIsolatedNodes = false,
  showLagLabels = true,
  showLegend = true,
  onNodeClick,
  onEdgeClick,
}: {
  variables: readonly Variable[];
  relationships: readonly Relationship[];
  highlightEdgeIds?: ReadonlySet<string>;
  highlightNodeIds?: ReadonlySet<string>;
  /** The edge open in an editor: drawn with a halo, never faded. */
  selectedEdgeId?: string | null;
  /** Connect mode: the node already picked as the source. */
  pendingSourceId?: string | null;
  /** Connect mode: nothing fades, so every node stays pickable. */
  connectMode?: boolean;
  /** Also lay out variables that have no edge yet (used in connect mode). */
  showIsolatedNodes?: boolean;
  showLagLabels?: boolean;
  /** The full technical legend under the graph (default). A simplified surface renders NetworkLegend elsewhere instead. */
  showLegend?: boolean;
  onNodeClick?: (id: string) => void;
  /** Clicking an edge's path or its lag label. */
  onEdgeClick?: (id: string) => void;
}) {
  const W = 860;
  const H = 620;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 70;

  const { nodes, edges } = useMemo(() => {
    const connected = new Set(relationships.flatMap((r) => [r.sourceVariableId, r.targetVariableId]));
    const includeAll = showIsolatedNodes || relationships.length === 0;
    const listed = variables
      .filter((v) => includeAll || connected.has(v.id))
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
      .map((r): LaidOutEdge | null => {
        const a = pos.get(r.sourceVariableId);
        const b = pos.get(r.targetVariableId);
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
        // Point on the quadratic curve at t = 0.5.
        const lx = 0.25 * a.x + 0.5 * cxp + 0.25 * endX;
        const ly = 0.25 * a.y + 0.5 * cyp + 0.25 * endY;
        return { r, d: `M ${a.x} ${a.y} Q ${cxp} ${cyp} ${endX} ${endY}`, lx, ly };
      })
      .filter((e): e is LaidOutEdge => e !== null);
    return {
      nodes: listed.map((v) => ({ v, p: pos.get(v.id)!, isolated: !connected.has(v.id) })),
      edges,
    };
  }, [variables, relationships, showIsolatedNodes, cx, cy, R]);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of variables) m.set(v.id, v.name);
    return (id: string) => m.get(id) ?? id;
  }, [variables]);

  const anyHighlight =
    !connectMode &&
    ((highlightEdgeIds && highlightEdgeIds.size > 0) || (highlightNodeIds && highlightNodeIds.size > 0) || !!selectedEdgeId);

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted">
        {variables.length === 0
          ? "No variables yet, so there is nothing to connect."
          : "No relationships yet. Add one with the form, or switch on Connect mode to pick two variables here."}
      </p>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full min-w-[520px] h-auto"
        role="group"
        aria-label={connectMode ? "Feedback map, connect mode" : "Feedback map"}
      >
        <defs>
          <marker id="arrow-pos" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COLOR.positive} />
          </marker>
          <marker id="arrow-neg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COLOR.negative} />
          </marker>
          <marker id="arrow-off" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COLOR.disabled} />
          </marker>
          <marker id="arrow-nd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COLOR.nonDynamics} />
          </marker>
        </defs>
        {edges.map(({ r, d, lx, ly }) => {
          const selected = selectedEdgeId === r.id;
          const hl = selected || (highlightEdgeIds?.has(r.id) ?? false);
          const faded = anyHighlight && !hl;
          const neg = r.direction === "negative";
          const off = !r.enabled;
          // Enabled but excluded from loops/propagation by its kind or opt-in.
          const outside = !off && !r.participatesInDynamics;
          const stroke = off ? COLOR.disabled : outside ? COLOR.nonDynamics : neg ? COLOR.negative : COLOR.positive;
          const width = off || outside ? 1 : selected ? 3.5 : hl ? 3 : 1 + r.strength * 1.5;
          const dash = off ? "2 3" : outside ? "1 2.5" : neg ? "6 4" : undefined;
          const opacity = faded ? 0.15 : off ? 0.45 : outside ? 0.6 : 0.85;
          const marker = off ? "arrow-off" : outside ? "arrow-nd" : neg ? "arrow-neg" : "arrow-pos";
          const clickable = Boolean(onEdgeClick);
          const lagText = showLagLabels && r.lag.value > 0 ? formatLag(r.lag) : null;
          const kindLabel = r.kind.replace("_", " ");
          const describe = `${nameOf(r.sourceVariableId)} → ${nameOf(r.targetVariableId)}: ${r.direction}, strength ${r.strength} (model judgment), lag ${formatLag(r.lag)}${off ? ", disabled" : outside ? `, ${kindLabel} — not part of dynamics` : ""}`;
          const tooltip = outside ? `${kindLabel} — not part of dynamics\n${describe}` : describe;
          const handle = clickable ? () => onEdgeClick!(r.id) : undefined;
          return (
            <g
              key={r.id}
              opacity={opacity}
              onClick={handle}
              onKeyDown={handle ? (e) => activate(e, handle) : undefined}
              tabIndex={clickable ? 0 : undefined}
              role={clickable ? "button" : undefined}
              aria-label={clickable ? `Edit relationship ${describe}` : undefined}
              aria-pressed={clickable ? selected : undefined}
              style={{ cursor: clickable ? "pointer" : "default", outline: "none" }}
            >
              <title>{`${tooltip}${r.explanation ? `\n${r.explanation}` : ""}`}</title>
              {selected ? <path d={d} fill="none" stroke={COLOR.ink} strokeWidth={width + 6} opacity={0.18} /> : null}
              <path d={d} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={dash} markerEnd={`url(#${marker})`} />
              {/* Wide invisible stroke so thin edges are easy to click. */}
              <path d={d} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
              {lagText ? (
                <text
                  x={lx}
                  y={ly + 3}
                  textAnchor="middle"
                  fontSize="9.5"
                  fontWeight={selected ? 600 : 400}
                  fill={off || outside ? COLOR.muted : stroke}
                  stroke="#ffffff"
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {lagText}
                </text>
              ) : null}
            </g>
          );
        })}
        {nodes.map(({ v, p, isolated }) => {
          const pending = pendingSourceId === v.id;
          const hl = pending || (highlightNodeIds?.has(v.id) ?? false);
          const faded = anyHighlight && !hl;
          const derived = v.kind === "derived";
          const onRight = Math.cos(p.angle) > 0.15;
          const onLeft = Math.cos(p.angle) < -0.15;
          const anchor = onRight ? "start" : onLeft ? "end" : "middle";
          const lx = p.x + (onRight ? 26 : onLeft ? -26 : 0);
          const ly = p.y + (onRight || onLeft ? 4 : Math.sin(p.angle) > 0 ? 36 : -28);
          const handle = onNodeClick ? () => onNodeClick(v.id) : undefined;
          const nodeLabel = connectMode
            ? pending
              ? `${v.name}: picked as source; click again to unpick`
              : pendingSourceId
                ? `${v.name}: pick as target`
                : `${v.name}: pick as source`
            : `${v.name}: show its edges`;
          return (
            <g
              key={v.id}
              opacity={faded ? 0.3 : 1}
              onClick={handle}
              onKeyDown={handle ? (e) => activate(e, handle) : undefined}
              tabIndex={handle ? 0 : undefined}
              role={handle ? "button" : undefined}
              aria-label={handle ? nodeLabel : undefined}
              aria-pressed={handle ? hl : undefined}
              style={{ cursor: handle ? "pointer" : "default", outline: "none" }}
            >
              {pending ? <circle cx={p.x} cy={p.y} r={27} fill="none" stroke={COLOR.pending} strokeWidth={2} strokeDasharray="4 3" /> : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={20}
                fill={derived ? COLOR.derivedFill : "#ffffff"}
                stroke={pending ? COLOR.pending : hl ? COLOR.ink : isolated ? COLOR.isolated : COLOR.muted}
                strokeWidth={pending || hl ? 2.5 : 1.25}
                strokeDasharray={derived ? "3 2" : undefined}
              />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="10" fill={COLOR.muted}>
                {categoryMeta(v.category).short.slice(0, 5)}
              </text>
              <text x={lx} y={ly} textAnchor={anchor} fontSize="12" fill={isolated ? COLOR.muted : COLOR.ink}>
                {v.name.length > 26 ? `${v.name.slice(0, 25)}…` : v.name}
              </text>
              <title>{`${v.name}\n${v.description}`}</title>
            </g>
          );
        })}
      </svg>
      {showLegend ? <NetworkLegend selectedEdge={selectedEdgeId !== null} connectMode={connectMode} /> : null}
    </div>
  );
}
