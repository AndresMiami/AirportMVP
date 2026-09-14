"use client";
import { NumberField } from "@/components/fields";
import { useModel } from "@/components/model-provider";
import { fmtValue } from "@/components/format";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge, Stat } from "@/components/ui";
import { DERIVED_IDS } from "@/model/ids";
import { incomeShares } from "@/calculations/household";

const SUMMARY = [
  DERIVED_IDS.totalIncome,
  DERIVED_IDS.reliableFloor,
  DERIVED_IDS.incomeConcentration,
  DERIVED_IDS.failureCorrelation,
  DERIVED_IDS.incomeVolatility,
  DERIVED_IDS.replacementLatency,
];

export default function IncomePage() {
  const { evaluated, updateIncomeSource } = useModel();
  if (!evaluated) return <Loading />;
  const { model, variableById } = evaluated;
  const shares = new Map(incomeShares(model.incomeSources).map((s) => [s.id, s.share]));
  return (
    <div>
      <PageHeader
        title="Income sources"
        lede="Each source carries its own reliability, volatility and failure group. The household-level numbers below are calculated from this list, never entered directly."
      />
      <Card>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th>Earner</th>
                <th>$/month</th>
                <th>Share</th>
                <th>Reliability</th>
                <th>Volatility</th>
                <th>Failure group</th>
                <th>Replace (months)</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {model.incomeSources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="font-medium">{s.name}</div>
                    {s.notes ? <div className="text-xs text-muted">{s.notes}</div> : null}
                  </td>
                  <td>{s.earner}</td>
                  <td>
                    <NumberField value={s.monthlyAmount} min={0} onCommit={(v) => updateIncomeSource({ id: s.id, monthlyAmount: v ?? 0 })} />
                  </td>
                  <td className="tabular-nums">{((shares.get(s.id) ?? 0) * 100).toFixed(0)}%</td>
                  <td>
                    <NumberField value={s.reliability} min={0} max={1} step={0.05} onCommit={(v) => updateIncomeSource({ id: s.id, reliability: v ?? 0 })} className="w-20" />
                  </td>
                  <td>
                    <NumberField value={s.volatility} min={0} max={1} step={0.05} onCommit={(v) => updateIncomeSource({ id: s.id, volatility: v ?? 0 })} className="w-20" />
                  </td>
                  <td className="font-mono text-xs">{s.correlationGroup}</td>
                  <td>
                    <NumberField value={s.replacementLatencyMonths} min={0} step={0.5} onCommit={(v) => updateIncomeSource({ id: s.id, replacementLatencyMonths: v ?? 0 })} className="w-20" />
                  </td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <SourceBadge sourceType={s.sourceType} />
                      <ConfidenceBadge confidence={s.confidence} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-4">
        {SUMMARY.map((id) => {
          const v = variableById.get(id);
          if (!v) return null;
          return <Stat key={id} label={v.name} value={fmtValue(v.currentValue, v.unit)} sub={`calculated · ${Math.round(v.confidence * 100)}% conf. (min of inputs)`} />;
        })}
      </div>
      <div className="mt-4">
        <Note>
          Reliability is the fraction of the amount that can be counted on in a bad month (assumption A1). Sources in the same failure group are assumed to disappear together (A4). Both are judgments, not measurements.
        </Note>
      </div>
    </div>
  );
}
