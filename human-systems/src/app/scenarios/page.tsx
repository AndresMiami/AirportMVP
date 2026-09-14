"use client";
import { useId, useMemo, useState } from "react";
import { formatMonths, type Horizon } from "@/calculations/lag";
import { NumberField } from "@/components/fields";
import { HorizonBadge } from "@/components/horizon-badge";
import { useModel } from "@/components/model-provider";
import { fmtDelta, fmtPct, fmtValue } from "@/components/format";
import { Sparkline } from "@/components/sparkline";
import { Card, Loading, Note, PageHeader, Stat } from "@/components/ui";
import { INPUT_IDS } from "@/domains/household/keys";
import { resolveVariable, subjectRef, systemRef, type SubjectScope, type VariableRef } from "@/model/domain";
import { compareScenario } from "@/scenarios/compare";
import type { Member, Scenario, ScenarioChange, SystemModel } from "@/types";

interface Draft {
  variableDeltas: Record<string, number>;
  incomeAmounts: Record<string, number>;
  horizonMonths: number;
}

const EMPTY: Draft = { variableDeltas: {}, incomeAmounts: {}, horizonMonths: 24 };

/** A preset names domain KEYS, never variable ids: each key is resolved
 *  for the chosen subject at click time (system-scope keys for the whole
 *  system, member-scope keys for the member picked on the left). */
interface Preset {
  name: string;
  description: string;
  deltas: { key: string; scope: SubjectScope; delta: number }[];
}

const PRESETS: Preset[] = [
  {
    name: "Reserves +$10,000",
    description: "A one-off addition to liquid reserves.",
    deltas: [{ key: INPUT_IDS.liquidReserves, scope: "system", delta: 10000 }],
  },
  {
    name: "Protected time +15 h/week",
    description: "More hours reliably reserved for compounding, for the chosen member.",
    deltas: [{ key: INPUT_IDS.protectedHours, scope: "member", delta: 15 }],
  },
  {
    name: "One path instead of three",
    description: "Major paths −2, switching frequency −1.5/yr, for the chosen member.",
    deltas: [
      { key: INPUT_IDS.majorPaths, scope: "member", delta: -2 },
      { key: INPUT_IDS.switchingFrequency, scope: "member", delta: -1.5 },
    ],
  },
];

const NOT_IN_SYSTEM = "not in this system";

/** Select value meaning "no member chosen" for member-scope presets. */
const NO_MEMBER = "";

/** Heading per horizon group (A16): the EARLIEST a tendency could show,
 *  given the entered lags along the fastest path that reached it. */
const HORIZON_HEADING: Record<Horizon, string> = {
  immediate: "Immediate",
  days: "Could show within days",
  weeks: "Could show within weeks",
  months: "Could show within months",
  years: "Could show within years",
};

/** Display only. Cumulative lags are shown with ≈ because they are sums
 *  converted to a natural unit, not the unit entered on any one edge. The
 *  longest path is mentioned when it is more than 10% beyond the shortest
 *  and still reads differently once formatted. */
function lagRangeText(minLagMonths: number, maxLagMonths: number): string {
  const earliest = minLagMonths <= 0 ? "earliest: immediate" : `earliest ≈ ${formatMonths(minLagMonths)}`;
  const spread = maxLagMonths - minLagMonths;
  const scale = Math.max(Math.abs(maxLagMonths), 1e-9);
  const latest = formatMonths(maxLagMonths);
  if (spread <= 0 || spread / scale < 0.1 || latest === formatMonths(minLagMonths)) return earliest;
  return `${earliest}, up to ≈ ${latest}`;
}

function memberOptionLabel(m: Member): string {
  return m.status === "archived" ? `${m.label} (archived)` : m.label;
}

/** "whole system", the member's label, "unassigned", or a marker for an unknown id. */
function subjectLabel(subjectId: string | null, model: SystemModel): string {
  if (subjectId === null) return "unassigned";
  if (subjectId === model.id) return "whole system";
  const m = model.profile.members.find((x) => x.id === subjectId);
  return m ? memberOptionLabel(m) : `unknown subject (${subjectId})`;
}

export default function ScenariosPage() {
  const { evaluated } = useModel();
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  /** Member the member-scope presets apply to; null until chosen or when none is active. */
  const [presetMember, setPresetMember] = useState<string | null>(null);

  const scenario = useMemo<Scenario | null>(() => {
    if (!evaluated) return null;
    const changes: ScenarioChange[] = [];
    for (const [variableId, delta] of Object.entries(draft.variableDeltas)) {
      if (delta !== 0) changes.push({ kind: "adjustVariable", variableId, delta });
    }
    for (const [incomeSourceId, monthlyAmount] of Object.entries(draft.incomeAmounts)) {
      const current = evaluated.model.incomeSources.find((s) => s.id === incomeSourceId)?.monthlyAmount;
      if (current !== undefined && monthlyAmount !== current) changes.push({ kind: "setIncomeSourceAmount", incomeSourceId, monthlyAmount });
    }
    return { id: "draft", name: "Draft scenario", description: "", changes, horizonMonths: draft.horizonMonths };
  }, [draft, evaluated]);

  const comparison = useMemo(() => (evaluated && scenario ? compareScenario(evaluated.model, scenario) : null), [evaluated, scenario]);

  if (!evaluated || !scenario || !comparison) return <Loading />;
  const { model, variableById } = evaluated;
  const members = model.profile.members;
  const activeMembers = members.filter((m) => m.status === "active");
  const inputs = evaluated.variables.filter((v) => v.kind === "input" && v.currentValue !== null);
  const hasChanges = scenario.changes.length > 0;
  const changedDerived = comparison.variableDeltas.filter((d) => d.delta !== null && Math.abs(d.delta) > 1e-9);

  /* ---- presets resolved for the chosen subject ---- */
  const chosenMember = presetMember !== null && members.some((m) => m.id === presetMember) ? presetMember : (activeMembers[0]?.id ?? null);
  /** The reference a preset key resolves through; null when a member-scope key has no member to point at. */
  const presetRef = (key: string, scope: SubjectScope): VariableRef | null =>
    scope === "system" ? systemRef(key) : chosenMember === null ? null : subjectRef(key, chosenMember);
  /** Variable ids a preset would adjust, or null when any of its keys is absent for the subject. */
  const resolvePreset = (p: Preset): { variableId: string; delta: number }[] | null => {
    const out: { variableId: string; delta: number }[] = [];
    for (const d of p.deltas) {
      const ref = presetRef(d.key, d.scope);
      const v = ref ? resolveVariable(evaluated.variables, model.id, ref) : undefined;
      if (!v || v.kind !== "input") return null;
      out.push({ variableId: v.id, delta: d.delta });
    }
    return out;
  };
  const applyPreset = (p: Preset) => {
    const resolved = resolvePreset(p);
    if (!resolved) return;
    setDraft((d) => {
      const variableDeltas = { ...d.variableDeltas };
      for (const r of resolved) variableDeltas[r.variableId] = r.delta;
      return { ...d, variableDeltas };
    });
  };
  const memberPresets = PRESETS.some((p) => p.deltas.some((d) => d.scope === "member"));

  return (
    <div>
      <PageHeader
        title="Scenario simulator — structural scenario analysis"
        lede="Change one or more inputs and see which derived values, gaps and feedback loops move under the same model assumptions. This is not a prediction of the future; it is a consistency check of the structure."
      />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <Card title="Presets">
            {memberPresets ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <label htmlFor={`${ids}-preset-member`} className="text-muted">
                  Per-person presets apply to
                </label>
                <select
                  id={`${ids}-preset-member`}
                  className="text-xs"
                  value={chosenMember ?? NO_MEMBER}
                  onChange={(e) => setPresetMember(e.target.value === NO_MEMBER ? null : e.target.value)}
                >
                  {activeMembers.length === 0 ? <option value={NO_MEMBER}>no active member</option> : null}
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {memberOptionLabel(m)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => {
                const available = resolvePreset(p) !== null;
                return (
                  <button
                    key={p.name}
                    type="button"
                    title={available ? p.description : NOT_IN_SYSTEM}
                    disabled={!available}
                    className="rounded border border-border bg-background px-2 py-1 text-xs hover:border-accent disabled:opacity-50 disabled:hover:border-border"
                    onClick={() => applyPreset(p)}
                  >
                    {p.name}
                  </button>
                );
              })}
              <button type="button" className="rounded border border-border px-2 py-1 text-xs text-muted" onClick={() => setDraft(EMPTY)}>
                Clear
              </button>
            </div>
            <p className="text-xs text-muted mt-2">A preset is greyed out when its variables are not present for the chosen subject in this system.</p>
          </Card>
          <Card title="Adjust inputs (delta from current)">
            <div className="max-h-[28rem] overflow-y-auto pr-1">
              <table className="data">
                <tbody>
                  {inputs.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div className="text-xs">
                          {v.name}
                          {v.subjectId !== model.id ? <span className="text-muted"> — {subjectLabel(v.subjectId, model)}</span> : null}
                        </div>
                        <div className="text-xs text-muted tabular-nums">now {fmtValue(v.currentValue, v.unit)}</div>
                      </td>
                      <td>
                        <NumberField
                          value={draft.variableDeltas[v.id] ?? 0}
                          className="w-24"
                          ariaLabel={`Delta ${v.name}${v.subjectId !== model.id ? ` (${subjectLabel(v.subjectId, model)})` : ""}`}
                          onCommit={(n) => setDraft((d) => ({ ...d, variableDeltas: { ...d.variableDeltas, [v.id]: n ?? 0 } }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Income sources (set monthly amount)">
            <table className="data">
              <tbody>
                {model.incomeSources.map((s) => (
                  <tr key={s.id}>
                    <td className="text-xs">
                      {s.name}
                      <div className="text-muted tabular-nums">now ${s.monthlyAmount.toLocaleString()}</div>
                    </td>
                    <td>
                      <NumberField
                        value={draft.incomeAmounts[s.id] ?? s.monthlyAmount}
                        min={0}
                        className="w-24"
                        ariaLabel={`Amount ${s.name}`}
                        onCommit={(n) => setDraft((d) => ({ ...d, incomeAmounts: { ...d.incomeAmounts, [s.id]: n ?? 0 } }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted mt-2">Income concentration and volatility are calculated, so they change here by changing the sources.</p>
          </Card>
          <Card title="Projection horizon">
            <NumberField value={draft.horizonMonths} min={1} max={240} className="w-24" onCommit={(n) => setDraft((d) => ({ ...d, horizonMonths: Math.max(1, Math.min(240, Math.round(n ?? 24))) }))} /> <span className="text-xs text-muted">months</span>
          </Card>
        </div>

        <div className="space-y-4">
          {!hasChanges ? <Note>No changes yet. Pick a preset or enter a delta on the left.</Note> : null}
          {comparison.applied.rejected.length > 0 ? (
            <Note tone="warn">{comparison.applied.rejected.map((r) => r.reason).join(" ")}</Note>
          ) : null}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Gaps shrinking" value={comparison.gapsShrinking} sub="closer to the desired value" tone="desired" />
            <Stat label="Gaps growing" value={comparison.gapsGrowing} sub="further from the desired value" />
            <Stat label="Open gaps — current" value={comparison.openGapsBefore} sub="variables not yet at target" tone="current" />
            <Stat label="Open gaps — scenario" value={comparison.openGapsAfter} sub="variables not yet at target" tone="desired" />
          </div>
          <Note>Counts only: each gap is compared with itself before and after. No mean or total gap is shown, because one number across different variables would read as a score.</Note>

          <Card title="Feedback loops under the scenario">
            <table className="data">
              <thead>
                <tr>
                  <th>Loop</th>
                  <th>Polarity</th>
                  <th title="Sum of the edge lags around the loop (A16), shown ≈ in a natural unit. The badge is the horizon class of the slowest step.">
                    Cycle time
                  </th>
                  <th>Pressure now</th>
                  <th>Pressure in scenario</th>
                  <th>Reading</th>
                </tr>
              </thead>
              <tbody>
                {comparison.loopDeltas.map((d) => (
                  <tr key={d.loop.id}>
                    <td>{d.loop.annotation?.name ?? d.loop.id}</td>
                    <td className={d.loop.polarity === "reinforcing" ? "text-warn" : "text-desired"}>{d.loop.polarity}</td>
                    <td>
                      <div className="tabular-nums">≈ {formatMonths(d.loop.cycleTimeMonths)}</div>
                      <HorizonBadge horizon={d.loop.slowestHorizon} prefix="slowest step:" />
                    </td>
                    <td className="tabular-nums">{d.basePressure?.toFixed(3) ?? "—"}</td>
                    <td className="tabular-nums">{d.scenarioPressure?.toFixed(3) ?? "—"}</td>
                    <td>
                      {d.change === "weakens" ? (
                        <span className="text-desired">This loop appears to weaken</span>
                      ) : d.change === "strengthens" ? (
                        <span className="text-warn">This loop appears to strengthen</span>
                      ) : d.change === "unchanged" ? (
                        <span className="text-muted">Little change (&lt;5%)</span>
                      ) : (
                        <span className="text-muted">Not assessable (no targets on the loop)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3">
              <Note>Pressure = mean edge strength × mean normalised gap of the loop&apos;s variables (A10). A reinforcing loop losing pressure means its variables sit closer to the desired state under the scenario; the loop structure itself is unchanged. Cycle time is the plain sum of the entered edge lags (A16): a rough time for one trip around the loop, not a measured period.</Note>
            </div>
          </Card>

          <Card title="Values that move (same model assumptions)">
            <p className="text-xs text-muted mb-2">
              Calculated values update instantly because they are definitions; the feedback effects below are the ones that take time.
            </p>
            {changedDerived.length === 0 ? (
              <p className="text-sm text-muted">Nothing moves yet.</p>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Current</th>
                    <th>Scenario</th>
                    <th>Change</th>
                    <th>Gap now → scenario</th>
                  </tr>
                </thead>
                <tbody>
                  {changedDerived.map((d) => {
                    const v = variableById.get(d.variableId);
                    const subject = v && v.subjectId !== model.id ? subjectLabel(v.subjectId, model) : null;
                    return (
                      <tr key={d.variableId}>
                        <td>
                          {d.name}
                          {subject ? <span className="text-xs text-muted"> — {subject}</span> : null}{" "}
                          {d.kind === "derived" ? <span className="text-xs text-muted">(calculated)</span> : null}
                        </td>
                        <td className="tabular-nums text-accent">{fmtValue(d.base, d.unit)}</td>
                        <td className="tabular-nums text-desired">{fmtValue(d.scenario, d.unit)}</td>
                        <td className="tabular-nums">{fmtDelta(d.delta, d.unit)}</td>
                        <td className="tabular-nums text-xs">
                          {d.baseGap === null ? "—" : `${fmtPct(d.baseGap)} → ${fmtPct(d.scenarioGap)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Directional tendencies through the feedback map">
            {comparison.directionalByHorizon.length === 0 ? (
              <p className="text-sm text-muted">No downstream tendencies (no changes, or the changed variables have no outgoing edges).</p>
            ) : (
              <div className="space-y-3">
                {comparison.directionalByHorizon.map((group) => (
                  <section key={group.horizon} aria-labelledby={`horizon-${group.horizon}`}>
                    <h3 id={`horizon-${group.horizon}`} className="text-xs font-semibold text-muted mb-1 flex items-center gap-2">
                      {HORIZON_HEADING[group.horizon]}
                      <HorizonBadge horizon={group.horizon} />
                    </h3>
                    <ul className="text-sm space-y-1">
                      {group.tendencies.map((p) => (
                        <li key={p.variableId}>
                          <span className="font-medium">{variableById.get(p.variableId)?.name ?? p.variableId}</span>{" "}
                          {p.tendency === "up" ? (
                            <span className="text-accent">may be pushed up</span>
                          ) : p.tendency === "down" ? (
                            <span className="text-warn">may be pushed down</span>
                          ) : (
                            <span className="text-muted">receives mixed pressure</span>
                          )}
                          <span className="text-xs text-muted tabular-nums">
                            {" "}
                            ({lagRangeText(p.minLagMonths, p.maxLagMonths)} · net weight {p.score.toFixed(2)} over {p.pathCount} path
                            {p.pathCount > 1 ? "s" : ""})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            <div className="mt-3 space-y-2">
              <Note>Sign-only propagation up to four steps along the edges (A12). The weights order each group; they are not magnitudes of change.</Note>
              <Note>
                Effects propagate on different time horizons (A16). Groups are ordered by the earliest a tendency could show given the entered lags, and the range is the shortest and longest cumulative lag along the paths found; &quot;Immediate&quot; means a lag entered as zero, not an instantaneous response. Nothing here is a forecast.
              </Note>
            </div>
          </Card>

          {comparison.projectionsSkipped.length > 0 ? (
            <Card title="Not projected (an input is unknown, never filled with zero)">
              <ul className="text-sm space-y-1">
                {comparison.projectionsSkipped.map((p) => (
                  <li key={`${p.label}:${p.subjectId}`}>
                    <span className="font-medium">{p.label}</span>
                    <span className="text-xs text-muted"> · subject: {subjectLabel(p.subjectId, model)}</span>
                    <div className="text-xs text-warn">missing {p.missingInputs.join(", ")}</div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {comparison.projections.length > 0 ? (
            <Card title={`Compounding trajectories over ${scenario.horizonMonths} months — model assumptions, not forecasts`}>
              <div className="grid gap-4 md:grid-cols-2">
                {comparison.projections.map((p) => {
                  const last = p.base.length - 1;
                  return (
                    <div key={p.label}>
                      <div className="text-sm font-medium">{p.label}</div>
                      <Sparkline base={p.base} scenario={p.scenario} />
                      <div className="text-xs text-muted tabular-nums">
                        <span className="text-accent">current path → {fmtValue(p.base[last], p.unit)}</span> ·{" "}
                        <span className="text-desired">scenario → {fmtValue(p.scenario[last], p.unit)}</span> · assumptions {p.assumptionIds.join(", ")}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted mt-2">Per-person trajectories are labelled with the member they belong to; one is drawn per member for whom every input is known.</p>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
