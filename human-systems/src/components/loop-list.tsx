"use client";
import type { EvaluatedLoop } from "@/model/evaluate";
import type { Variable } from "@/types";

export function LoopList({
  loops,
  variableById,
  selected,
  onSelect,
}: {
  loops: readonly EvaluatedLoop[];
  variableById: ReadonlyMap<string, Variable>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  if (loops.length === 0) return <p className="text-sm text-muted">No closed loops in the current relationships.</p>;
  return (
    <ul className="space-y-2">
      {loops.map((l) => {
        const active = selected === l.id;
        const tone = l.polarity === "reinforcing" ? "text-warn bg-warn-soft" : "text-desired bg-desired-soft";
        return (
          <li
            key={l.id}
            className={`rounded-md border p-3 text-sm ${active ? "border-foreground" : "border-border"} ${onSelect ? "cursor-pointer" : ""}`}
            onClick={onSelect ? () => onSelect(active ? null : l.id) : undefined}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>{l.polarity}</span>
              <span className="font-medium">{l.annotation?.name ?? "Unnamed loop"}</span>
              <span className="text-xs text-muted tabular-nums">
                mean strength {l.meanStrength.toFixed(2)} · pressure {l.pressure === null ? "—" : l.pressure.toFixed(2)} · cycle ≈{" "}
                {l.cycleTimeMonths} mo · min conf. {Math.round(l.minConfidence * 100)}%
              </span>
            </div>
            <div className="text-xs mt-1">
              {l.variableIds.map((id, i) => (
                <span key={id}>
                  {variableById.get(id)?.name ?? id}
                  {i < l.variableIds.length - 1 ? " → " : " → (back to start)"}
                </span>
              ))}
            </div>
            {l.annotation?.notes ? <div className="text-xs text-muted mt-1">{l.annotation.notes}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
