"use client";
import { formatLag, horizonOfLag } from "@/calculations/lag";
import { HorizonBadge } from "@/components/horizon-badge";
import { HypothesisStatusBadge } from "@/components/loop-list";
import { useModel } from "@/components/model-provider";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { SOURCE_TYPE_META } from "@/domain/vocabulary";
import type { HypothesisStatus, SourceType } from "@/types";

const HYPOTHESIS_STATUSES: HypothesisStatus[] = ["proposed", "accepted", "rejected", "uncertain"];

export default function EvidencePage() {
  const { evaluated } = useModel();
  if (!evaluated) return <Loading />;
  const { variables, derived, issues, model, allRelationships, variableById, observations } = evaluated;
  const counts = new Map<SourceType, number>();
  for (const v of variables) counts.set(v.sourceType, (counts.get(v.sourceType) ?? 0) + 1);
  for (const s of model.incomeSources) counts.set(s.sourceType, (counts.get(s.sourceType) ?? 0) + 1);
  for (const r of model.relationships) counts.set(r.sourceType, (counts.get(r.sourceType) ?? 0) + 1);
  const lowConfidence = variables.filter((v) => v.confidence < 0.5).sort((a, b) => a.confidence - b.confidence);
  const nameOf = (id: string) => variableById.get(id)?.name ?? id;
  /** Least evidenced first: lowest confidence, then id for a stable order. */
  const relationshipsByConfidence = [...allRelationships].sort((a, b) => a.confidence - b.confidence || a.id.localeCompare(b.id));
  const observationCounts = new Map<SourceType, number>();
  for (const o of model.observations) observationCounts.set(o.sourceType, (observationCounts.get(o.sourceType) ?? 0) + 1);
  const hypothesisCounts = new Map<HypothesisStatus, number>();
  for (const h of model.hypotheses) hypothesisCounts.set(h.status, (hypothesisCounts.get(h.status) ?? 0) + 1);

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

      <Card title={`Relationship provenance (${allRelationships.length} edges, least evidenced first)`} className="mt-4">
        {relationshipsByConfidence.length === 0 ? (
          <p className="text-sm text-muted">No relationships stored yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>From → To</th>
                  <th title="0–1 model judgment of influence with its sign; not an estimated causal coefficient">Strength (judgment)</th>
                  <th title="Lag in the unit entered; the badge is its horizon class (A16)">Lag</th>
                  <th>Provenance</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {relationshipsByConfidence.map((r) => {
                  const linked = observations.byRelationship.get(r.id)?.length ?? 0;
                  return (
                    <tr key={r.id} className={r.enabled ? "" : "text-muted"}>
                      <td>
                        <div className="font-medium">
                          {nameOf(r.sourceVariableId)} → {nameOf(r.targetVariableId)}
                          {!r.enabled ? (
                            <span className="ml-2 inline-block rounded border border-border bg-background px-1.5 py-0.5 text-xs font-normal" title="Kept for the record; excluded from loops and propagation">
                              disabled
                            </span>
                          ) : null}
                        </div>
                        {r.explanation ? <div className="text-xs text-muted max-w-xs">{r.explanation}</div> : null}
                      </td>
                      <td className="tabular-nums">
                        <span className={r.direction === "negative" ? "text-warn" : "text-accent"} title={r.direction === "negative" ? "source up → target down" : "source up → target up"}>
                          {r.direction === "negative" ? "−" : "+"}
                        </span>{" "}
                        {r.strength.toFixed(2)}
                      </td>
                      <td>
                        <div className="tabular-nums">{formatLag(r.lag)}</div>
                        <HorizonBadge horizon={horizonOfLag(r.lag)} />
                      </td>
                      <td>
                        <div className="flex flex-col gap-1 items-start">
                          <SourceBadge sourceType={r.sourceType} />
                          <ConfidenceBadge confidence={r.confidence} />
                        </div>
                      </td>
                      <td className="text-xs">
                        {r.evidence.length === 0 ? (
                          <span className="text-neg">none recorded</span>
                        ) : (
                          <span>
                            {r.evidence.length} item{r.evidence.length === 1 ? "" : "s"}
                          </span>
                        )}
                        <div className="text-muted">
                          {linked} linked observation{linked === 1 ? "" : "s"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3">
          <Note>
            Strength and sign are model judgments entered by whoever built the model, not estimated causal coefficients; nothing in this application estimates one. Confidence and provenance say what kind of knowledge each judgment rests on. Lags are shown in the unit entered for each edge.
          </Note>
        </div>
      </Card>

      <Card title="Observations by provenance" className="mt-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold text-muted mb-2">
              Observations ({model.observations.length})
            </h3>
            <table className="data">
              <tbody>
                {(Object.keys(SOURCE_TYPE_META) as SourceType[]).map((t) => (
                  <tr key={t}>
                    <td>
                      <SourceBadge sourceType={t} />
                    </td>
                    <td className="text-xs text-muted">{SOURCE_TYPE_META[t].description}</td>
                    <td className="tabular-nums text-right">{observationCounts.get(t) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-muted mb-2">
              Hypotheses by status ({model.hypotheses.length})
            </h3>
            <table className="data">
              <tbody>
                {HYPOTHESIS_STATUSES.map((s) => (
                  <tr key={s}>
                    <td>
                      <HypothesisStatusBadge status={s} />
                    </td>
                    <td className="tabular-nums text-right">{hypothesisCounts.get(s) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="mt-3">
          <Note>
            Observations are kept verbatim and are never values; their provenance says who reported them. A hypothesis status is a review state (A18): &quot;accepted&quot; means the person accepts it as a working reading, never that it is established.
          </Note>
        </div>
      </Card>

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
