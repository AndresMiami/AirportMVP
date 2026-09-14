"use client";
import { useModel } from "@/components/model-provider";
import { fmtDelta, fmtPct, fmtValue } from "@/components/format";
import { Card, CategoryBadge, Loading, Note, PageHeader } from "@/components/ui";

export default function GapPage() {
  const { evaluated } = useModel();
  if (!evaluated) return <Loading />;
  const { gap, variableById } = evaluated;
  const rows = [...gap.gaps].sort((a, b) => b.normalizedGap - a.normalizedGap);
  return (
    <div>
      <PageHeader
        title="Structural gap"
        lede="G = X* − X for every variable with both a current and a desired value. The normalised column divides the gap by the variable's reference range so a $ gap and an hours gap can sit side by side (assumption A11)."
      />
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <div className="text-xs text-muted">Mean normalised gap</div>
          <div className="text-lg font-semibold tabular-nums">{fmtPct(gap.meanNormalizedGap)}</div>
        </div>
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <div className="text-xs text-muted">Open</div>
          <div className="text-lg font-semibold tabular-nums">{gap.openCount}</div>
        </div>
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <div className="text-xs text-muted">At target</div>
          <div className="text-lg font-semibold tabular-nums">{gap.closedCount}</div>
        </div>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Variable</th>
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
        <Note>The mean gap is a rough summary; it weights every variable equally regardless of importance. Use the Leverage page for which gaps may be worth closing first.</Note>
      </div>
    </div>
  );
}
