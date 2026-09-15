"use client";
import { Fragment, useCallback, useId, useState } from "react";
import { HistoryToggle, TargetEditor, TargetHistoryList } from "@/components/history";
import { HypothesisStatusBadge } from "@/components/loop-list";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { fmtValue } from "@/components/format";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import * as mutations from "@/services/mutations";
import type { Variable } from "@/types";

/** Inline refusal message for one control. */
function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? (
    <div className="text-xs text-neg mt-1" role="alert">
      {msg}
    </div>
  ) : null;
}

export default function DesiredPage() {
  const { evaluated, replaceModel, apply, lastError } = useModel();
  const ids = useId();
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [errorOwner, setErrorOwner] = useState<string | null>(null);

  const commit = useCallback(
    (owner: string, mutation: ModelMutation): boolean => {
      setErrorOwner(owner);
      return apply(mutation);
    },
    [apply],
  );
  const errorFor = useCallback((owner: string) => (errorOwner === owner && lastError ? lastError : null), [errorOwner, lastError]);

  if (!evaluated) return <Loading />;
  const { model, variables, loops } = evaluated;
  const d = model.desiredAttractor;
  const withTargets = variables.filter((v) => v.desiredValue !== null);
  const withoutTargets = variables.filter((v) => v.desiredValue === null);
  const pressing = loops.filter((l) => l.polarity === "reinforcing" && (l.pressure ?? 0) > 0);
  const reinforcing = pressing.filter((l) => l.status !== "rejected");
  const rejectedCount = pressing.length - reinforcing.length;

  /** A target edit records a NEW target entry; the earlier ones stay in the history. */
  const targetEditor = (v: Variable) => (
    <TargetEditor
      variable={v}
      onSave={(draft) =>
        commit(`tgt:${v.id}`, (m) =>
          mutations.updateVariable(m, v.id, { desiredValue: draft.desiredValue, targetMode: draft.targetMode, valid: draft.valid, note: draft.note }),
        )
      }
      error={errorFor(`tgt:${v.id}`)}
    />
  );
  const historyToggle = (v: Variable) =>
    v.targets.length > 0 ? (
      <HistoryToggle
        open={historyOpen === v.id}
        controls={`${ids}-history-${v.id}`}
        count={v.targets.length}
        onToggle={() => setHistoryOpen(historyOpen === v.id ? null : v.id)}
      />
    ) : null;
  const historyPanel = (v: Variable) =>
    historyOpen === v.id ? (
      <div className="rounded border border-border bg-background p-2">
        <div className="text-xs font-medium mb-1">History of targets for {v.name} — newest first</div>
        <TargetHistoryList
          id={`${ids}-history-${v.id}`}
          variable={v}
          onRetract={(entryId, reason) => commit(`hist:${v.id}`, (m) => mutations.retractTarget(m, v.id, entryId, reason))}
        />
        <ErrorLine msg={errorFor(`hist:${v.id}`)} />
        <p className="text-xs text-muted mt-1">
          The current target is the newest entry that applies today. Retracting keeps the entry in the list, marked retracted, and the next applicable entry becomes current.
        </p>
      </div>
    ) : null;

  return (
    <div>
      <PageHeader
        title="Desired state"
        lede="The structural state the person wants the system to settle into. Desired values live on the same variables as current values; setting one here is the same as editing it on the Variables page. Changing a goal records a new target with the date it applies as of — earlier targets stay in the history."
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
          <p className="text-xs text-muted mb-2">Earlier targets stay in the history: open a variable&apos;s History to see every target it has had and when each applied.</p>
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
                <Fragment key={v.id}>
                  <tr>
                    <td>
                      {v.name} <span className="text-xs text-muted">({v.unit})</span>
                    </td>
                    <td className="tabular-nums text-accent">{fmtValue(v.currentValue, v.unit)}</td>
                    <td>
                      <div className="flex flex-col gap-1 items-start">
                        {targetEditor(v)}
                        {historyToggle(v)}
                      </div>
                    </td>
                  </tr>
                  {historyOpen === v.id ? (
                    <tr>
                      <td colSpan={3}>{historyPanel(v)}</td>
                    </tr>
                  ) : null}
                </Fragment>
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
            <ul className="text-sm space-y-2">
              {withoutTargets.map((v) => (
                <li key={v.id} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="flex-1 min-w-32">
                      {v.name} <span className="text-xs text-muted">({v.unit})</span>
                    </span>
                    <div className="flex flex-col gap-1 items-start">
                      {targetEditor(v)}
                      {historyToggle(v)}
                    </div>
                  </div>
                  {historyPanel(v)}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
