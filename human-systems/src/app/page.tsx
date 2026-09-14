"use client";
import Link from "next/link";
import { GettingStarted } from "@/components/getting-started";
import { useModel } from "@/components/model-provider";
import { fmtPct, fmtValue } from "@/components/format";
import { SystemSwitcher } from "@/components/system-switcher";
import { Card, Loading, Note, PageHeader, Stat } from "@/components/ui";
import { DERIVED_IDS, INPUT_IDS, OTHER_KEYS } from "@/domains/household/keys";
import { resolveVariable, type SubjectScope } from "@/model/domain";
import type { Variable } from "@/types";

/** Headline keys of the household domain. System-scope keys resolve once;
 *  member-scope keys resolve once per active member. */
const HEADLINE_KEYS: { key: string; scope: SubjectScope }[] = [
  { key: DERIVED_IDS.floorRatio, scope: "system" },
  { key: DERIVED_IDS.bufferMonths, scope: "system" },
  { key: DERIVED_IDS.reliableFloor, scope: "system" },
  { key: DERIVED_IDS.monthlySurplus, scope: "system" },
  { key: DERIVED_IDS.incomeConcentration, scope: "system" },
  { key: DERIVED_IDS.failureCorrelation, scope: "system" },
  { key: OTHER_KEYS.financialPressure, scope: "system" },
  { key: INPUT_IDS.protectedHours, scope: "member" },
  { key: INPUT_IDS.careerCapital, scope: "member" },
  { key: INPUT_IDS.majorPaths, scope: "member" },
];

export default function DashboardPage() {
  const { status, evaluated, isSample, migratedFrom, models, resetToSample, error } = useModel();
  if (status === "error") return <Note tone="warn">Could not load the model: {error}</Note>;
  if (status === "loading" || !evaluated) return <Loading />;

  const { model, loops, gap, issues, unassignedVariables } = evaluated;
  const activeMembers = model.profile.members.filter((m) => m.status === "active");
  /** Headline variables present in this system, labelled per member where the key is per person. */
  const headline: { variable: Variable; label: string }[] = [];
  for (const { key, scope } of HEADLINE_KEYS) {
    if (scope === "system") {
      const v = resolveVariable(evaluated.variables, model.id, { key, subjectId: null });
      if (v) headline.push({ variable: v, label: v.name });
    } else {
      for (const m of activeMembers) {
        const v = resolveVariable(evaluated.variables, model.id, { key, subjectId: m.id });
        if (v) headline.push({ variable: v, label: `${v.name} — ${m.label}` });
      }
    }
  }
  const reinforcing = loops.filter((l) => l.polarity === "reinforcing");
  const balancing = loops.filter((l) => l.polarity === "balancing");
  const topLoop = [...loops].sort((a, b) => (b.pressure ?? -1) - (a.pressure ?? -1))[0];
  const inputVariableCount = model.variables.filter((v) => v.kind === "input").length;
  const isEmpty = model.incomeSources.length === 0 && inputVariableCount === 0;
  const otherSystems = Math.max(0, models.length - 1);

  return (
    <div>
      <div className="mb-4">
        <SystemSwitcher compact />
      </div>

      <PageHeader
        title={model.profile.name}
        lede="Current system versus desired system. Values on the left are what the model holds today; values on the right are the stated targets. Every number carries a source type and a confidence on the Structural variables page."
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
            This is the fictional sample household. Edit values on the Income and Variables pages; changes stay in this browser only.{" "}
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
            <p className="text-sm text-muted">No values yet. The calculated variables fill in once income sources and input variables exist.</p>
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
            {issues.length === 0 ? (
              <div className="text-sm">No structural issues detected.</div>
            ) : (
              <ul className="text-xs space-y-1">
                {issues.map((i, k) => (
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
