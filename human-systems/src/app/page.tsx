"use client";
import Link from "next/link";
import { GettingStarted } from "@/components/getting-started";
import { useModel } from "@/components/model-provider";
import { fmtPct, fmtValue } from "@/components/format";
import { SystemSwitcher } from "@/components/system-switcher";
import { Card, Loading, Note, PageHeader, Stat } from "@/components/ui";
import { DERIVED_IDS, INPUT_IDS } from "@/model/ids";

const HEADLINE_IDS = [
  DERIVED_IDS.floorRatio,
  DERIVED_IDS.bufferMonths,
  DERIVED_IDS.reliableFloor,
  DERIVED_IDS.monthlySurplus,
  DERIVED_IDS.incomeConcentration,
  DERIVED_IDS.failureCorrelation,
  INPUT_IDS.protectedHours,
  INPUT_IDS.careerCapital,
  INPUT_IDS.majorPaths,
  "financial_pressure",
];

export default function DashboardPage() {
  const { status, evaluated, isSample, migratedFrom, models, resetToSample, error } = useModel();
  if (status === "error") return <Note tone="warn">Could not load the model: {error}</Note>;
  if (status === "loading" || !evaluated) return <Loading />;

  const { model, variableById, loops, gap, issues } = evaluated;
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
              {HEADLINE_IDS.map((id) => {
                const v = variableById.get(id);
                if (!v) return null;
                return (
                  <Stat
                    key={id}
                    tone="current"
                    label={v.name}
                    value={fmtValue(v.currentValue, v.unit)}
                    sub={`${v.sourceType.replace("_", " ")} · ${Math.round(v.confidence * 100)}% conf.`}
                  />
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted mt-3">{model.currentAttractor.summary || "No current attractor described yet (System profile)."}</p>
        </Card>
        <Card tone="desired" title={<span className="text-desired">DESIRED SYSTEM</span>}>
          {isEmpty ? (
            <p className="text-sm text-muted">No targets yet. A desired value can be set on any variable once one exists.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {HEADLINE_IDS.map((id) => {
                const v = variableById.get(id);
                if (!v) return null;
                const g = gap.gaps.find((x) => x.variableId === id);
                return (
                  <Stat
                    key={id}
                    tone="desired"
                    label={v.name}
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
            <div className="text-2xl font-semibold tabular-nums">{fmtPct(gap.meanNormalizedGap)}</div>
            <div className="text-xs text-muted">
              mean normalised gap across {gap.gaps.length} variables with targets · {gap.openCount} open
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
