"use client";
import { useModel } from "@/components/model-provider";
import { fmtDelta, fmtPct, fmtValue } from "@/components/format";
import { Card, CategoryBadge, Loading, Note, PageHeader, Stat } from "@/components/ui";

export default function GapPage() {
  const { evaluated } = useModel();
  if (!evaluated) return <Loading />;
  const { gap, variableById, model } = evaluated;
  const rows = [...gap.gaps].sort((a, b) => b.normalizedGap - a.normalizedGap);
  const subjectLabel = (subjectId: string | null): string => {
    if (subjectId === null) return "unassigned";
    if (subjectId === model.id) return "whole system";
    const m = model.profile.members.find((x) => x.id === subjectId);
    return m ? (m.status === "archived" ? `${m.label} (archived)` : m.label) : `unknown subject (${subjectId})`;
  };
  return (
    <div>
      <PageHeader
        title="Structural gap"
        lede="G = X* − X for every variable with both a current and a desired value. The normalised column divides the gap by the variable's reference range so a $ gap and an hours gap can sit side by side (assumption A11). The gap is a vector: one entry per variable, never summed into one number."
      />
      <div className="grid grid-cols-3 gap-2 mb-4">
        <Stat label="Variables with targets" value={gap.gaps.length} sub="current and desired both set" />
        <Stat label="Open" value={gap.openCount} sub="not yet at the desired value" />
        <Stat label="At target" value={gap.closedCount} sub="desired value reached" />
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Subject</th>
                <th>Category</th>
                <th>Current</th>
                <th>Desired</th>
                <th>Gap</th>
                <th>Normalised</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const v = variableById.get(g.variableId)!;
                return (
                  <tr key={g.variableId}>
                    <td>{v.name}</td>
                    <td className="text-xs text-muted">{subjectLabel(v.subjectId)}</td>
                    <td>
                      <CategoryBadge category={v.category} />
                    </td>
                    <td className="tabular-nums text-accent">{fmtValue(g.current, v.unit)}</td>
                    <td className="tabular-nums text-desired">
                      <span className="text-xs text-muted mr-1">{v.targetMode === "at_least" ? "≥" : v.targetMode === "at_most" ? "≤" : "="}</span>
                      {fmtValue(g.desired, v.unit)}
                    </td>
                    <td className="tabular-nums">{fmtDelta(g.absoluteGap, v.unit)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-32 rounded bg-background border border-border overflow-hidden">
                          <div className="h-full bg-accent" style={{ width: `${Math.round(g.normalizedGap * 100)}%` }} />
                        </div>
                        <span className="tabular-nums text-xs">{fmtPct(g.normalizedGap)}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="mt-4">
        <Note>
          No single number summarises these gaps: a mean would weight every variable equally and read as a universal score. Compare entries one by one, and use the Leverage page
          for which gaps may be worth closing first.
        </Note>
      </div>
    </div>
  );
}
