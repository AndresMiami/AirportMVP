"use client";
import Link from "next/link";
import { useId } from "react";
import { GettingStarted } from "@/components/getting-started";
import { useModel } from "@/components/model-provider";
import { fmtPct, fmtValue } from "@/components/format";
import { SystemSwitcher } from "@/components/system-switcher";
import { Card, Loading, Note, PageHeader, Stat } from "@/components/ui";
import { resolveVariable, subjectRef, systemRef } from "@/model/domain";
import { subjectsOf } from "@/model/subjects";
import type { Variable } from "@/types";

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50";

/** Today's calendar date in the browser's zone, as the date input expects it. */
function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "View as of": a date input plus a way back to today. The date input
 *  cannot pick a future day; the engine treats a date as the end of that
 *  day. Display and input only: it changes how values are READ, never what
 *  is stored. */
function ViewAsOfControl({ asOf, setAsOf }: { asOf: string | null; setAsOf: (d: string | null) => void }) {
  const id = useId();
  const today = todayIso();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={id} className="text-muted">
        View as of
      </label>
      <input
        id={id}
        type="date"
        max={today}
        value={asOf ? asOf.slice(0, 10) : ""}
        onChange={(e) => {
          const v = e.target.value;
          setAsOf(v && v <= today ? v : null);
        }}
      />
      <button type="button" className={BTN} disabled={!asOf} onClick={() => setAsOf(null)}>
        Back to today
      </button>
      {asOf ? null : <span className="text-muted">Showing today&apos;s values.</span>}
    </div>
  );
}

export default function DashboardPage() {
  const { status, evaluated, isSample, seedLabel, migratedFrom, models, resetToSample, error, asOf, setAsOf } = useModel();
  if (status === "error") return <Note tone="warn">Could not load the model: {error}</Note>;
  if (status === "loading" || !evaluated) return <Loading />;

  const { model, loops, gap, issues, unassignedVariables } = evaluated;
  const infoNotes = issues.filter((i) => i.level === "info");
  const problems = issues.filter((i) => i.level !== "info");
  const activeMembers = subjectsOf(model);
  /** Headline variables the ACTIVE DOMAIN names (presentation configuration),
   *  present in this system; system keys resolve once, member keys once per
   *  active subject. A domain without headline keys shows none. */
  const headline: { variable: Variable; label: string }[] = [];
  for (const { key, scope } of evaluated.domain.presentation?.headlineKeys ?? []) {
    if (scope === "system") {
      const v = resolveVariable(evaluated.variables, model.id, systemRef(key));
      if (v) headline.push({ variable: v, label: v.name });
    } else {
      for (const m of activeMembers) {
        const v = resolveVariable(evaluated.variables, model.id, subjectRef(key, m.id));
        if (v) headline.push({ variable: v, label: `${v.name} — ${m.label}` });
      }
    }
  }
  const reinforcing = loops.filter((l) => l.polarity === "reinforcing");
  const balancing = loops.filter((l) => l.polarity === "balancing");
  const topLoop = [...loops].sort((a, b) => (b.pressure ?? -1) - (a.pressure ?? -1))[0];
  const inputVariableCount = model.variables.filter((v) => v.kind === "input").length;
  const isEmpty = Object.values(model.collections).every((c) => c.items.length === 0) && inputVariableCount === 0;
  const otherSystems = Math.max(0, models.length - 1);

  return (
    <div>
      <div className="mb-4">
        <SystemSwitcher compact />
      </div>

      <div className="mb-4">
        <ViewAsOfControl asOf={asOf} setAsOf={setAsOf} />
      </div>

      {asOf ? (
        <div className="mb-4">
          <Card tone="warn" title="Showing a past date">
            <p className="text-sm">
              Showing values and targets as of <span className="font-medium tabular-nums">{asOf.slice(0, 10)}</span>. Relationships, constraints,
              hypotheses and calculations use today&apos;s structure. A saved snapshot is the record of the whole system at a past date.
            </p>
            <p className="text-xs text-muted mt-1">Anything not recorded by that date shows as unknown, never as a later value.</p>
            <button type="button" className={`${BTN} mt-2`} onClick={() => setAsOf(null)}>
              Back to today
            </button>
          </Card>
        </div>
      ) : null}

      {infoNotes.length > 0 ? (
        <div className="mb-4 space-y-2">
          {infoNotes.map((i, k) => (
            <Note key={k}>{i.message}</Note>
          ))}
        </div>
      ) : null}

      <PageHeader
        title={model.profile.name}
        lede={`Current system versus desired system. Values on the left are what the model ${asOf ? `held as of ${asOf.slice(0, 10)}` : "holds today"}; values on the right are the ${asOf ? "targets recorded by then" : "stated targets"}. Every number carries a source type and a confidence on the Structural variables page.`}
      />

      {migratedFrom !== null ? (
        <div className="mb-4">
          <Note>
            {model.profile.name} was stored under schema version {migratedFrom} and was upgraded on load. Its values are unchanged; the stored copy now uses the current schema.
          </Note>
        </div>
      ) : null}

      {isSample ? (
        <div className="mb-4">
          <Note>
            This is the {seedLabel ?? "fictional sample"}. Edit values on its pages; changes stay in this browser only.{" "}
            <button type="button" className="underline" onClick={() => void resetToSample()}>
              Reset to sample
            </button>
          </Note>
        </div>
      ) : (
        <div className="mb-4">
          <Note>
            {model.profile.name} · {model.profile.systemType} ·{" "}
            {otherSystems === 0 ? "no other systems stored in this browser" : `${otherSystems} other system${otherSystems > 1 ? "s" : ""} stored in this browser`}
          </Note>
        </div>
      )}

      {unassignedVariables.length > 0 ? (
        <div className="mb-4">
          <Note tone="warn">
            {unassignedVariables.length} variable{unassignedVariables.length > 1 ? "s have" : " has"} no subject assigned and feed{unassignedVariables.length > 1 ? "" : "s"} no calculation.{" "}
            <Link href="/variables" className="underline">
              Assign subjects
            </Link>
          </Note>
        </div>
      ) : null}

      {isEmpty ? (
        <div className="mb-4">
          <GettingStarted model={model} evaluated={evaluated} defaultOpen />
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card tone="current" title={<span className="text-accent">CURRENT SYSTEM</span>}>
          {isEmpty ? (
            <p className="text-sm text-muted">No values yet. The calculated variables fill in once the domain&apos;s records and input variables exist.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {headline.map(({ variable: v, label }) => (
                <Stat
                  key={v.id}
                  tone="current"
                  label={label}
                  value={fmtValue(v.currentValue, v.unit)}
                  sub={`${v.sourceType.replace("_", " ")} · ${Math.round(v.confidence * 100)}% conf.`}
                />
              ))}
            </div>
          )}
          <p className="text-xs text-muted mt-3">{model.currentAttractor.summary || "No current attractor described yet (System profile)."}</p>
        </Card>
        <Card tone="desired" title={<span className="text-desired">DESIRED SYSTEM</span>}>
          {isEmpty ? (
            <p className="text-sm text-muted">No targets yet. A desired value can be set on any variable once one exists.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {headline.map(({ variable: v, label }) => {
                const g = gap.gaps.find((x) => x.variableId === v.id);
                return (
                  <Stat
                    key={v.id}
                    tone="desired"
                    label={label}
                    value={fmtValue(v.desiredValue, v.unit)}
                    sub={g ? `gap ${fmtPct(g.normalizedGap)} of range` : "no target set"}
                  />
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted mt-3">{model.desiredAttractor.summary || "No desired attractor described yet (System profile)."}</p>
        </Card>
      </div>

      {isEmpty ? null : (
        <div className="grid gap-4 md:grid-cols-3 mt-4">
          <Card title="Structural gap">
            <div className="text-2xl font-semibold tabular-nums">
              {gap.openCount} <span className="text-sm font-normal text-muted">open</span> · {gap.closedCount}{" "}
              <span className="text-sm font-normal text-muted">at target</span>
            </div>
            <div className="text-xs text-muted">
              across {gap.gaps.length} variable{gap.gaps.length === 1 ? "" : "s"} with targets; one gap per variable, never summed
            </div>
            <Link href="/gap" className="text-xs underline mt-2 inline-block">
              Per-variable gap
            </Link>
          </Card>
          <Card title="Feedback loops">
            <div className="text-2xl font-semibold tabular-nums">
              {reinforcing.length} <span className="text-sm font-normal text-muted">reinforcing</span> · {balancing.length}{" "}
              <span className="text-sm font-normal text-muted">balancing</span>
            </div>
            {topLoop ? (
              <div className="text-xs text-muted mt-1">
                Highest pressure: {topLoop.annotation?.name ?? topLoop.id} ({topLoop.polarity}, index{" "}
                {topLoop.pressure?.toFixed(2)})
              </div>
            ) : null}
            <Link href="/feedback-map" className="text-xs underline mt-2 inline-block">
              Feedback map
            </Link>
          </Card>
          <Card title="Model health">
            {problems.length === 0 ? (
              <div className="text-sm">No structural issues detected.</div>
            ) : (
              <ul className="text-xs space-y-1">
                {problems.map((i, k) => (
                  <li key={k} className={i.level === "error" ? "text-neg" : "text-warn"}>
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
            <Link href="/evidence" className="text-xs underline mt-2 inline-block">
              Evidence and assumptions
            </Link>
          </Card>
        </div>
      )}

      {isEmpty ? null : (
        <div className="mt-4">
          <GettingStarted model={model} evaluated={evaluated} defaultOpen={false} />
        </div>
      )}
    </div>
  );
}
