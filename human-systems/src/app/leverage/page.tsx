"use client";
import { useModel } from "@/components/model-provider";
import { fmtPct } from "@/components/format";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import { UTILITY_DIMENSION_META } from "@/domain/vocabulary";

export default function LeveragePage() {
  const { evaluated } = useModel();
  if (!evaluated) return <Loading />;
  const { variableLeverage, unassessedVariables, actions, networkInfluence, variableById, model } = evaluated;
  const feasibleActions = actions.filter((a) => a.feasibility.feasible).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const infeasible = actions.filter((a) => !a.feasibility.feasible);

  return (
    <div>
      <PageHeader
        title="Leverage points"
        lede="L = (impact × controllability × durability) / (cost × uncertainty), all five 0–1 judgments (assumption A8). Only the ranking is meaningful. Network influence is a separate, calculated reach measure and is shown for comparison, never folded into the score."
      />
      <Card title="Variables ranked by leverage judgment">
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Variable</th>
                <th>Score</th>
                <th>Impact</th>
                <th>Control</th>
                <th>Durab.</th>
                <th>Cost</th>
                <th>Uncert.</th>
                <th>Network influence</th>
              </tr>
            </thead>
            <tbody>
              {variableLeverage.map(({ variable: v, leverage: l, rank }) => (
                <tr key={v.id}>
                  <td className="tabular-nums">{rank}</td>
                  <td>{v.name}</td>
                  <td className="tabular-nums font-medium">
                    {l.score.toFixed(1)}
                    {l.floored ? <span title="A denominator factor was raised to the 0.05 floor" className="text-warn"> *</span> : null}
                  </td>
                  <td className="tabular-nums">{l.factors.impact.toFixed(2)}</td>
                  <td className="tabular-nums">{l.factors.controllability.toFixed(2)}</td>
                  <td className="tabular-nums">{l.factors.durability.toFixed(2)}</td>
                  <td className="tabular-nums">{l.factors.cost.toFixed(2)}</td>
                  <td className="tabular-nums">{l.factors.uncertainty.toFixed(2)}</td>
                  <td className="tabular-nums">{fmtPct(networkInfluence.get(v.id) ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {unassessedVariables.length > 0 ? (
          <p className="text-xs text-muted mt-3">
            Not ranked (no impact judgment recorded): {unassessedVariables.map((v) => v.name).join(", ")}.
          </p>
        ) : null}
      </Card>

      <Card title="Candidate actions — feasible, ranked" className="mt-4">
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Targets</th>
                <th>Leverage</th>
                <th>Utility view (−1…1 per dimension)</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {feasibleActions.map((a) => (
                <tr key={a.action.id}>
                  <td className="tabular-nums">{a.rank}</td>
                  <td>
                    <div className="font-medium">{a.action.name}</div>
                    <div className="text-xs text-muted max-w-xs">{a.action.description}</div>
                    {a.feasibility.unverified.length > 0 ? (
                      <div className="text-xs text-warn">Unverified against: {a.feasibility.unverified.map((c) => c.name).join(", ")}</div>
                    ) : null}
                  </td>
                  <td className="text-xs">{a.action.targetVariables.map((t) => variableById.get(t)?.name ?? t).join(", ")}</td>
                  <td className="tabular-nums">{a.leverage.score.toFixed(1)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1 max-w-md">
                      {a.utility.dimensions
                        .filter((d) => d.value !== null)
                        .map((d) => {
                          const meta = UTILITY_DIMENSION_META[d.dimension];
                          const good = meta.higherIsBetter ? (d.value ?? 0) >= 0 : (d.value ?? 0) <= 0;
                          return (
                            <span key={d.dimension} className={`rounded px-1.5 py-0.5 text-xs ${good ? "bg-desired-soft text-desired" : "bg-neg-soft text-neg"}`}>
                              {meta.label} {d.value! > 0 ? "+" : ""}
                              {d.value!.toFixed(1)}
                            </span>
                          );
                        })}
                    </div>
                    {a.utility.weightedTotal !== null ? (
                      <div className="text-xs mt-1">Weighted total {a.utility.weightedTotal.toFixed(2)} (your priorities)</div>
                    ) : (
                      <div className="text-xs text-muted mt-1">Unweighted — no priorities set</div>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-col gap-1 items-start">
                      <SourceBadge sourceType={a.action.sourceType} />
                      <ConfidenceBadge confidence={a.action.confidence} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Excluded by a hard constraint (not ranked)" className="mt-4">
        <ul className="text-sm space-y-2">
          {infeasible.map((a) => (
            <li key={a.action.id}>
              <span className="font-medium">{a.action.name}</span>
              <ul className="text-xs text-muted list-disc pl-5">
                {a.feasibility.hardViolations.map((v) => (
                  <li key={v.constraint.id}>
                    Conflicts with the stated constraint &ldquo;{v.constraint.name}&rdquo; (requires {String(v.required)}, limit{" "}
                    {v.constraint.check?.comparator} {String(v.constraint.check?.limit)}).
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <Note>
            Constraints in force: {model.constraints.map((c) => c.name).join("; ")}. A mathematically attractive option that conflicts with a constraint is excluded rather than down-weighted (A14).
          </Note>
        </div>
      </Card>
    </div>
  );
}
