"use client";
/**
 * Loop list shared by the feedback map, the current attractor and the
 * hypotheses screen. Display only: nothing here changes the model.
 *
 * A detected loop is presented as a HYPOTHESIS (A18): its status is the
 * status of the hypothesis recorded for it ("proposed" when none is), and
 * "accepted" is a working reading, never established fact. Strength is a
 * model judgment, not a measured effect.
 */
import { formatLag, formatMonths } from "@/calculations/lag";
import type { EvaluatedLoop } from "@/model/evaluate";
import type { HypothesisStatus, Relationship, Variable } from "@/types";

/* ------------------------------------------------------------------ */
/* Display helpers (pure, reused by the hypotheses / attractor screens) */
/* ------------------------------------------------------------------ */

/** Muted, distinct tone per hypothesis status. Proposed stays neutral. */
export const HYPOTHESIS_STATUS_META: Record<HypothesisStatus, { label: string; className: string; meaning: string }> = {
  proposed: {
    label: "proposed",
    className: "bg-background border border-border text-muted",
    meaning: "recorded, not yet reviewed",
  },
  accepted: {
    label: "accepted",
    className: "bg-desired-soft text-desired",
    meaning: "a working reading the person is willing to act on; not a proof",
  },
  rejected: {
    label: "rejected",
    className: "bg-neg-soft text-neg",
    meaning: "set aside as a reading; the edges that form it are unchanged",
  },
  uncertain: {
    label: "uncertain",
    className: "bg-warn-soft text-warn",
    meaning: "reviewed and left open",
  },
};

export function HypothesisStatusBadge({ status, prefix }: { status: HypothesisStatus; prefix?: string }) {
  const meta = HYPOTHESIS_STATUS_META[status];
  return (
    <span title={meta.meaning} className={`inline-block rounded px-1.5 py-0.5 text-xs ${meta.className}`}>
      {prefix ? `${prefix} ` : ""}
      {meta.label}
    </span>
  );
}

const nameOf = (variableById: ReadonlyMap<string, Variable>, id: string) => variableById.get(id)?.name ?? id;

/** The variable chain of a loop, e.g. "A → B → C". */
export function loopChain(loop: Pick<EvaluatedLoop, "variableIds">, variableById: ReadonlyMap<string, Variable>): string {
  return loop.variableIds.map((id) => nameOf(variableById, id)).join(" → ");
}

/** Annotation name when the person gave one, otherwise the variable chain. */
export function loopLabel(loop: Pick<EvaluatedLoop, "variableIds" | "annotation">, variableById: ReadonlyMap<string, Variable>): string {
  return loop.annotation?.name?.trim() || loopChain(loop, variableById);
}

/**
 * A neutral, editable first draft of a loop hypothesis, built only from the
 * variable names and edge signs. The sign carried along the chain is the
 * PROPAGATED one (a lowered variable pushes its positive edge downward), so
 * the sentence describes what the entered judgments imply, nothing more.
 * Edge i runs from variable i to variable i+1 (mod n).
 */
export function draftLoopStatement(
  loop: Pick<EvaluatedLoop, "variableIds" | "edgeIds">,
  variableById: ReadonlyMap<string, Variable>,
  relationshipById?: ReadonlyMap<string, Relationship>,
): string {
  const n = loop.variableIds.length;
  if (n === 0) return "";
  const parts: string[] = [];
  let sign: 1 | -1 = 1;
  for (let i = 0; i < n; i += 1) {
    const from = nameOf(variableById, loop.variableIds[i]);
    const to = nameOf(variableById, loop.variableIds[(i + 1) % n]);
    const direction = relationshipById?.get(loop.edgeIds[i])?.direction;
    const effect: 1 | -1 | 0 = direction === undefined ? 0 : direction === "positive" ? sign : sign === 1 ? -1 : 1;
    const verb = effect === 0 ? "change" : effect === 1 ? "raise" : "lower";
    const subject = i === 0 ? `Rising ${from}` : `${sign === 1 ? "higher" : "lower"} ${from}`;
    parts.push(`${subject} appears to ${verb} ${to}`);
    if (effect !== 0) sign = effect;
  }
  return `${parts.join("; ")}, feeding back to where the loop started.`;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function LoopList({
  loops,
  variableById,
  selected,
  onSelect,
  relationshipById,
}: {
  loops: readonly EvaluatedLoop[];
  variableById: ReadonlyMap<string, Variable>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** When present, each step's lag is shown in the unit the person chose
   *  for that edge; otherwise the month value is converted (marked ≈). */
  relationshipById?: ReadonlyMap<string, Relationship>;
}) {
  if (loops.length === 0) return <p className="text-sm text-muted">No closed loops in the current relationships.</p>;
  return (
    <ul className="space-y-2">
      {loops.map((l) => {
        const active = selected === l.id;
        const tone = l.polarity === "reinforcing" ? "text-warn bg-warn-soft" : "text-desired bg-desired-soft";
        const n = l.variableIds.length;
        const obsCount = l.observationIds.length;
        return (
          <li
            key={l.id}
            className={`rounded-md border p-3 text-sm ${active ? "border-foreground" : "border-border"} ${onSelect ? "cursor-pointer" : ""}`}
            onClick={onSelect ? () => onSelect(active ? null : l.id) : undefined}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>{l.polarity}</span>
              <span className="font-medium">{l.annotation?.name ?? "Unnamed loop"}</span>
              <HypothesisStatusBadge status={l.status} prefix="hypothesis:" />
            </div>
            <div className="text-xs text-muted tabular-nums mt-1">
              mean strength {l.meanStrength.toFixed(2)} · pressure {l.pressure === null ? "—" : l.pressure.toFixed(2)} · cycle ≈{" "}
              {formatMonths(l.cycleTimeMonths)} (slowest step: {l.slowestHorizon}) · min conf. {Math.round(l.minConfidence * 100)}%
            </div>
            <div className="text-xs mt-1">
              {l.variableIds.map((id, i) => (
                <span key={`${id}-${i}`}>
                  {nameOf(variableById, id)}
                  {i < n - 1 ? " → " : " → (back to start)"}
                </span>
              ))}
            </div>
            <ul className="text-xs text-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5" aria-label="Lag per step">
              {l.edgeIds.map((edgeId, i) => {
                const rel = relationshipById?.get(edgeId);
                const lag = rel ? formatLag(rel.lag) : `≈ ${formatMonths(l.edgeLagMonths[i] ?? 0)}`;
                return (
                  <li key={`${edgeId}-${i}`} className="tabular-nums">
                    {nameOf(variableById, l.variableIds[i])} → {nameOf(variableById, l.variableIds[(i + 1) % n])} ({lag})
                  </li>
                );
              })}
            </ul>
            <div className="text-xs text-muted mt-1">
              {obsCount} linked observation{obsCount === 1 ? "" : "s"}
            </div>
            {l.annotation?.notes ? <div className="text-xs text-muted mt-1">{l.annotation.notes}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
