"use client";
import { NumberField } from "@/components/fields";
import { useModel } from "@/components/model-provider";
import { fmtValue } from "@/components/format";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";

export default function DesiredPage() {
  const { evaluated, replaceModel, updateVariable } = useModel();
  if (!evaluated) return <Loading />;
  const { model, variables, loops } = evaluated;
  const d = model.desiredAttractor;
  const withTargets = variables.filter((v) => v.desiredValue !== null);
  const withoutTargets = variables.filter((v) => v.desiredValue === null);
  const reinforcing = loops.filter((l) => l.polarity === "reinforcing" && (l.pressure ?? 0) > 0);

  return (
    <div>
      <PageHeader
        title="Desired state"
        lede="The structural state the person wants the system to settle into. Desired values live on the same variables as current values; setting one here is the same as editing it on the Variables page."
      />
      <Card tone="desired" title="As described">
        <textarea
          className="w-full max-w-2xl"
          rows={3}
          value={d.summary}
          onChange={(e) => replaceModel({ ...model, desiredAttractor: { ...d, summary: e.target.value } })}
        />
        <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
          {d.recurringOutcomes.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <SourceBadge sourceType={d.sourceType} />
          <ConfidenceBadge confidence={d.confidence} />
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <Card title={`Targets set (${withTargets.length})`}>
          <table className="data">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Current</th>
                <th>Desired</th>
              </tr>
            </thead>
            <tbody>
              {withTargets.map((v) => (
                <tr key={v.id}>
                  <td>
                    {v.name} <span className="text-xs text-muted">({v.unit})</span>
                  </td>
                  <td className="tabular-nums text-accent">{fmtValue(v.currentValue, v.unit)}</td>
                  <td>
                    <NumberField value={v.desiredValue} nullable onCommit={(n) => updateVariable({ id: v.id, desiredValue: n })} ariaLabel={`Desired ${v.name}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="space-y-4">
          <Card title="Loops that would need to weaken">
            <ul className="text-sm space-y-1">
              {reinforcing.map((l) => (
                <li key={l.id}>
                  <span className="font-medium">{l.annotation?.name ?? l.id}</span>
                  <span className="text-xs text-muted"> — pressure {l.pressure?.toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <Note>Reaching the desired state is expected to show up as these reinforcing loops losing pressure in the Scenario simulator. That is a consistency check, not a guarantee.</Note>
            </div>
          </Card>
          <Card title={`No target yet (${withoutTargets.length})`}>
            <ul className="text-sm space-y-1">
              {withoutTargets.map((v) => (
                <li key={v.id} className="flex items-center gap-2">
                  <span className="flex-1">{v.name}</span>
                  <NumberField value={null} nullable onCommit={(n) => updateVariable({ id: v.id, desiredValue: n })} ariaLabel={`Desired ${v.name}`} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
