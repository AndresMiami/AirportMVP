"use client";
import { useMemo, useState } from "react";
import { NumberField } from "@/components/fields";
import { useModel } from "@/components/model-provider";
import { fmtDelta, fmtPct, fmtValue } from "@/components/format";
import { Sparkline } from "@/components/sparkline";
import { Card, Loading, Note, PageHeader } from "@/components/ui";
import { INPUT_IDS } from "@/model/ids";
import { compareScenario } from "@/scenarios/compare";
import type { Scenario, ScenarioChange } from "@/types";

interface Draft {
  variableDeltas: Record<string, number>;
  incomeAmounts: Record<string, number>;
  horizonMonths: number;
}

const EMPTY: Draft = { variableDeltas: {}, incomeAmounts: {}, horizonMonths: 24 };

const PRESETS: { name: string; description: string; draft: (d: Draft) => Draft }[] = [
  {
    name: "Reserves +$10,000",
    description: "A one-off addition to liquid reserves.",
    draft: (d) => ({ ...d, variableDeltas: { ...d.variableDeltas, [INPUT_IDS.liquidReserves]: 10000 } }),
  },
  {
    name: "Protected time +15 h/week",
    description: "More hours reliably reserved for compounding.",
    draft: (d) => ({ ...d, variableDeltas: { ...d.variableDeltas, [INPUT_IDS.protectedHours]: 15 } }),
  },
  {
    name: "One path instead of three",
    description: "Major paths −2, switching frequency −1.5/yr.",
    draft: (d) => ({
      ...d,
      variableDeltas: { ...d.variableDeltas, [INPUT_IDS.majorPaths]: -2, [INPUT_IDS.switchingFrequency]: -1.5 },
    }),
  },
];

export default function ScenariosPage() {
  const { evaluated } = useModel();
  const [draft, setDraft] = useState<Draft>(EMPTY);

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
  const inputs = evaluated.variables.filter((v) => v.kind === "input" && v.currentValue !== null);
  const hasChanges = scenario.changes.length > 0;
  const changedDerived = comparison.variableDeltas.filter((d) => d.delta !== null && Math.abs(d.delta) > 1e-9);

  return (
    <div>
      <PageHeader
        title="Scenario simulator — structural scenario analysis"
        lede="Change one or more inputs and see which derived values, gaps and feedback loops move under the same model assumptions. This is not a prediction of the future; it is a consistency check of the structure."
      />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <Card title="Presets">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.name} title={p.description} className="rounded border border-border bg-background px-2 py-1 text-xs hover:border-accent" onClick={() => setDraft((d) => p.draft(d))}>
                  {p.name}
                </button>
              ))}
              <button className="rounded border border-border px-2 py-1 text-xs text-muted" onClick={() => setDraft(EMPTY)}>
                Clear
              </button>
            </div>
          </Card>
          <Card title="Adjust inputs (delta from current)">
            <div className="max-h-[28rem] overflow-y-auto pr-1">
              <table className="data">
                <tbody>
                  {inputs.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div className="text-xs">{v.name}</div>
                        <div className="text-xs text-muted tabular-nums">now {fmtValue(v.currentValue, v.unit)}</div>
                      </td>
                      <td>
                        <NumberField
                          value={draft.variableDeltas[v.id] ?? 0}
                          className="w-24"
                          ariaLabel={`Delta ${v.name}`}
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

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-accent bg-surface px-3 py-2">
              <div className="text-xs text-muted">Mean normalised gap — current</div>
              <div className="text-lg font-semibold tabular-nums text-accent">{fmtPct(comparison.meanGapBefore)}</div>
            </div>
            <div className="rounded-md border border-desired bg-surface px-3 py-2">
              <div className="text-xs text-muted">Mean normalised gap — scenario</div>
              <div className="text-lg font-semibold tabular-nums text-desired">{fmtPct(comparison.meanGapAfter)}</div>
            </div>
          </div>

          <Card title="Feedback loops under the scenario">
            <table className="data">
              <thead>
                <tr>
                  <th>Loop</th>
                  <th>Polarity</th>
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
              <Note>Pressure = mean edge strength × mean normalised gap of the loop&apos;s variables (A10). A reinforcing loop losing pressure means its variables sit closer to the desired state under the scenario; the loop structure itself is unchanged.</Note>
            </div>
          </Card>

          <Card title="Values that move (same model assumptions)">
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
                  {changedDerived.map((d) => (
                    <tr key={d.variableId}>
                      <td>
                        {d.name} {d.kind === "derived" ? <span className="text-xs text-muted">(calculated)</span> : null}
                      </td>
                      <td className="tabular-nums text-accent">{fmtValue(d.base, d.unit)}</td>
                      <td className="tabular-nums text-desired">{fmtValue(d.scenario, d.unit)}</td>
                      <td className="tabular-nums">{fmtDelta(d.delta, d.unit)}</td>
                      <td className="tabular-nums text-xs">
                        {d.baseGap === null ? "—" : `${fmtPct(d.baseGap)} → ${fmtPct(d.scenarioGap)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Directional tendencies through the feedback map">
            {comparison.directional.length === 0 ? (
              <p className="text-sm text-muted">No downstream tendencies (no changes, or the changed variables have no outgoing edges).</p>
            ) : (
              <ul className="text-sm space-y-1">
                {comparison.directional.map((p) => (
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
                      (net weight {p.score.toFixed(2)} over {p.pathCount} path{p.pathCount > 1 ? "s" : ""})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              <Note>Sign-only propagation up to four steps along the edges (A12). The weights order the list; they are not magnitudes of change.</Note>
            </div>
          </Card>

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
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
