"use client";
import { useState } from "react";
import { NumberField } from "@/components/fields";
import { useModel } from "@/components/model-provider";
import { fmtValue } from "@/components/format";
import { Card, CategoryBadge, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import { CATEGORY_META } from "@/domain/vocabulary";
import type { Variable, VariableCategory } from "@/types";

const ORDER: VariableCategory[] = ["structure", "asset", "buffer", "dependency", "event", "agency", "person_fit", "constraint", "shock"];

export default function VariablesPage() {
  const { evaluated, updateVariable } = useModel();
  const [open, setOpen] = useState<string | null>(null);
  if (!evaluated) return <Loading />;
  const groups = new Map<VariableCategory, Variable[]>();
  for (const v of evaluated.variables) {
    if (!groups.has(v.category)) groups.set(v.category, []);
    groups.get(v.category)!.push(v);
  }
  return (
    <div>
      <PageHeader
        title="Structural variables"
        lede="Every variable records where its value came from and how confident that value is. Calculated variables cannot be edited directly; change their inputs instead. Desired values are always editable."
      />
      <div className="space-y-4">
        {ORDER.filter((c) => groups.has(c)).map((c) => (
          <Card key={c} title={`${CATEGORY_META[c].label} — ${CATEGORY_META[c].description}`}>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Speed</th>
                    <th>Current</th>
                    <th>Desired</th>
                    <th>Unit</th>
                    <th>Provenance</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.get(c)!.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div className="font-medium">{v.name}</div>
                        {v.description ? <div className="text-xs text-muted max-w-xs">{v.description}</div> : null}
                      </td>
                      <td className="text-xs">{v.changeSpeed}</td>
                      <td>
                        {v.kind === "derived" ? (
                          <span className="tabular-nums" title="Calculated; edit its inputs">
                            {fmtValue(v.currentValue, v.unit)}
                          </span>
                        ) : (
                          <NumberField value={v.currentValue} nullable onCommit={(n) => updateVariable({ id: v.id, currentValue: n })} ariaLabel={`Current ${v.name}`} />
                        )}
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <select
                            aria-label={`Target mode ${v.name}`}
                            className="text-xs w-12 px-1"
                            value={v.targetMode}
                            title="at least (floor) / at most (ceiling) / exact"
                            onChange={(e) => updateVariable({ id: v.id, targetMode: e.target.value as typeof v.targetMode })}
                          >
                            <option value="at_least">≥</option>
                            <option value="at_most">≤</option>
                            <option value="exact">=</option>
                          </select>
                          <NumberField value={v.desiredValue} nullable onCommit={(n) => updateVariable({ id: v.id, desiredValue: n })} ariaLabel={`Desired ${v.name}`} />
                        </div>
                      </td>
                      <td className="text-xs text-muted">{v.unit}</td>
                      <td>
                        <div className="flex flex-col gap-1 items-start">
                          <SourceBadge sourceType={v.sourceType} />
                          <ConfidenceBadge confidence={v.confidence} />
                          <CategoryBadge category={v.category} />
                        </div>
                      </td>
                      <td className="text-xs">
                        {v.kind === "derived" ? (
                          <span className="text-muted">formula {v.formulaId}</span>
                        ) : v.evidence.length === 0 ? (
                          <span className="text-neg">none recorded</span>
                        ) : (
                          <button className="underline" onClick={() => setOpen(open === v.id ? null : v.id)}>
                            {v.evidence.length} item{v.evidence.length > 1 ? "s" : ""}
                          </button>
                        )}
                        {open === v.id ? (
                          <ul className="mt-1 space-y-1 max-w-xs">
                            {v.evidence.map((e, i) => (
                              <li key={i}>
                                <SourceBadge sourceType={e.sourceType} /> {e.text}
                              </li>
                            ))}
                            {v.notes ? <li className="text-muted">Note: {v.notes}</li> : null}
                          </ul>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>
      <div className="mt-4">
        <Note>Confidence on a calculated variable is the minimum confidence of its inputs (assumption A13).</Note>
      </div>
    </div>
  );
}
