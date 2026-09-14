"use client";
import Link from "next/link";
import { useModel } from "@/components/model-provider";
import { fmtPct, fmtValue } from "@/components/format";
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
  const { status, evaluated, seededFromSample, resetToSample, error } = useModel();
  if (status === "loading" || !evaluated) return <Loading />;
  if (status === "error") return <Note tone="warn">Could not load the model: {error}</Note>;

  const { model, variableById, loops, gap, issues } = evaluated;
  const reinforcing = loops.filter((l) => l.polarity === "reinforcing");
  const balancing = loops.filter((l) => l.polarity === "balancing");
  const topLoop = [...loops].sort((a, b) => (b.pressure ?? -1) - (a.pressure ?? -1))[0];

  return (
    <div>
      <PageHeader
        title={model.profile.name}
        lede="Current system versus desired system. Values on the left are what the model holds today; values on the right are the stated targets. Every number carries a source type and a confidence on the Structural variables page."
      />
      {seededFromSample ? (
        <div className="mb-4">
          <Note>
            This browser holds the fictional sample household. Edit values on the Income and Variables pages; changes stay in this browser only.{" "}
            <button className="underline" onClick={resetToSample}>
              Reset to sample
            </button>
          </Note>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card tone="current" title={<span className="text-accent">CURRENT SYSTEM</span>}>
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
          <p className="text-xs text-muted mt-3">{model.currentAttractor.summary}</p>
        </Card>
        <Card tone="desired" title={<span className="text-desired">DESIRED SYSTEM</span>}>
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
          <p className="text-xs text-muted mt-3">{model.desiredAttractor.summary}</p>
        </Card>
      </div>

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
    </div>
  );
}
