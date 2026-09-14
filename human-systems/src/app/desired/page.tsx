"use client";
import { NumberField } from "@/components/fields";
import { HypothesisStatusBadge } from "@/components/loop-list";
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
  const pressing = loops.filter((l) => l.polarity === "reinforcing" && (l.pressure ?? 0) > 0);
  const reinforcing = pressing.filter((l) => l.status !== "rejected");
  const rejectedCount = pressing.length - reinforcing.length;

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
          <Card title="Loop hypotheses that would need to weaken">
            {reinforcing.length === 0 ? (
              <p className="text-sm text-muted">No reinforcing loop hypothesis currently carries pressure.</p>
            ) : (
              <ul className="text-sm space-y-1.5">
                {reinforcing.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{l.annotation?.name ?? l.id}</span>
                    <HypothesisStatusBadge status={l.status} prefix="hypothesis:" />
                    <span className="text-xs text-muted tabular-nums">pressure {l.pressure?.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
            {rejectedCount > 0 ? (
              <p className="text-xs text-muted mt-2">
                {rejectedCount} rejected loop hypothes{rejectedCount > 1 ? "es" : "is"} left out; the edges still form {rejectedCount > 1 ? "those loops" : "that loop"}.
              </p>
            ) : null}
            <div className="mt-3">
              <Note>
                Reaching the desired state is expected to show up as these reinforcing loops losing pressure in the Scenario simulator. That is a consistency check, not a guarantee. A loop&apos;s status is the status of its hypothesis; &quot;accepted&quot; is a working reading, not established fact.
              </Note>
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
