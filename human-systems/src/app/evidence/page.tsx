"use client";
import { useModel } from "@/components/model-provider";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { SOURCE_TYPE_META } from "@/domain/vocabulary";
import type { SourceType } from "@/types";

export default function EvidencePage() {
  const { evaluated } = useModel();
  if (!evaluated) return <Loading />;
  const { variables, derived, issues, model } = evaluated;
  const counts = new Map<SourceType, number>();
  for (const v of variables) counts.set(v.sourceType, (counts.get(v.sourceType) ?? 0) + 1);
  for (const s of model.incomeSources) counts.set(s.sourceType, (counts.get(s.sourceType) ?? 0) + 1);
  for (const r of model.relationships) counts.set(r.sourceType, (counts.get(r.sourceType) ?? 0) + 1);
  const lowConfidence = variables.filter((v) => v.confidence < 0.5).sort((a, b) => a.confidence - b.confidence);

  return (
    <div>
      <PageHeader
        title="Evidence and assumptions"
        lede="What kind of knowledge each number rests on, which formulas the calculated values use, and the model assumptions behind those formulas. None of the assumptions are established scientific laws."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Provenance mix (variables, income sources, edges)">
          <table className="data">
            <tbody>
              {(Object.keys(SOURCE_TYPE_META) as SourceType[]).map((t) => (
                <tr key={t}>
                  <td>
                    <SourceBadge sourceType={t} />
                  </td>
                  <td className="text-xs text-muted">{SOURCE_TYPE_META[t].description}</td>
                  <td className="tabular-nums text-right">{counts.get(t) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Lowest-confidence values">
          {lowConfidence.length === 0 ? (
            <p className="text-sm text-muted">Every value is at or above 50% confidence.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {lowConfidence.map((v) => (
                <li key={v.id} className="flex items-center gap-2">
                  <span className="flex-1">{v.name}</span>
                  <SourceBadge sourceType={v.sourceType} />
                  <ConfidenceBadge confidence={v.confidence} />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <Note>Low confidence is information, not a fault. It marks where a measurement would change the model most.</Note>
          </div>
        </Card>
      </div>

      <Card title="Calculated variables and their inputs" className="mt-4">
        <table className="data">
          <thead>
            <tr>
              <th>Variable</th>
              <th>Reads</th>
              <th>Assumptions</th>
              <th>Confidence</th>
              <th>Missing</th>
            </tr>
          </thead>
          <tbody>
            {derived.map((d) => (
              <tr key={d.definition.id}>
                <td>
                  <div className="font-medium">{d.definition.name}</div>
                  <div className="text-xs text-muted max-w-sm">{d.definition.description}</div>
                </td>
                <td className="text-xs font-mono">
                  {[...d.definition.inputVariables, ...d.definition.inputDerived, ...(d.definition.usesIncomeSources ? ["incomeSources[]"] : [])].join(", ") || "—"}
                </td>
                <td className="text-xs">{d.definition.assumptionIds.join(", ") || "arithmetic only"}</td>
                <td>
                  <ConfidenceBadge confidence={d.variable.confidence} />
                </td>
                <td className="text-xs text-warn">{d.missingInputs.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Model assumptions" className="mt-4">
        <table className="data">
          <thead>
            <tr>
              <th>Id</th>
              <th>Assumption</th>
              <th>Status</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            {ASSUMPTIONS.map((a) => (
              <tr key={a.id}>
                <td className="font-mono text-xs">{a.id}</td>
                <td>
                  <div className="font-medium">{a.title}</div>
                  <div className="text-xs text-muted max-w-xl">{a.statement}</div>
                </td>
                <td>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${a.status === "hypothesis" ? "bg-warn-soft text-warn" : "bg-background border border-border"}`}>{a.status}</span>
                </td>
                <td className="text-xs font-mono">{a.usedBy.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {issues.length > 0 ? (
        <Card title="Model issues" className="mt-4" tone="warn">
          <ul className="text-sm space-y-1">
            {issues.map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
