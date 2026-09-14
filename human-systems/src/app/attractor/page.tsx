"use client";
import Link from "next/link";
import { LoopList } from "@/components/loop-list";
import { useModel } from "@/components/model-provider";
import { fmtPct, fmtValue } from "@/components/format";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import type { Relationship } from "@/types";

export default function AttractorPage() {
  const { evaluated, replaceModel } = useModel();
  if (!evaluated) return <Loading />;
  const { model, loops, gap, variableById, allRelationships } = evaluated;
  const relationshipById = new Map<string, Relationship>(allRelationships.map((r) => [r.id, r]));
  const byPressure = (a: (typeof loops)[number], b: (typeof loops)[number]) => (b.pressure ?? -1) - (a.pressure ?? -1);
  const rejected = [...loops.filter((l) => l.status === "rejected")].sort(byPressure);
  const reinforcing = [...loops.filter((l) => l.polarity === "reinforcing" && l.status !== "rejected")].sort(byPressure);
  const balancing = loops.filter((l) => l.polarity === "balancing" && l.status !== "rejected");
  const slowOpen = gap.gaps
    .filter((g) => g.direction !== "none")
    .map((g) => ({ g, v: variableById.get(g.variableId)! }))
    .filter((x) => x.v.changeSpeed === "slow")
    .sort((a, b) => b.g.normalizedGap - a.g.normalizedGap)
    .slice(0, 8);
  const a = model.currentAttractor;

  return (
    <div>
      <PageHeader
        title="Current attractor"
        lede="The recurring state the system tends to return to. The description is the person's own account; the loop hypotheses and slow variables below are the model's reading of what may keep reproducing it. Neither is a diagnosis."
      />
      <Card tone="current" title="As described">
        <textarea
          className="w-full max-w-2xl"
          rows={3}
          value={a.summary}
          onChange={(e) => replaceModel({ ...model, currentAttractor: { ...a, summary: e.target.value } })}
        />
        <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
          {a.recurringOutcomes.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <SourceBadge sourceType={a.sourceType} />
          <ConfidenceBadge confidence={a.confidence} />
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <div className="space-y-4 min-w-0">
          <Card title="Reinforcing loop hypotheses that may hold this state in place">
            <div className="mb-3">
              <Note>
                A loop is a structural consequence of the relationships entered as judgments, not something observed on its own. It stays a hypothesis until it is reviewed on the{" "}
                <Link href="/hypotheses" className="underline">
                  Hypotheses
                </Link>{" "}
                screen; &quot;accepted&quot; is a working reading, not established fact (A18).
              </Note>
            </div>
            <LoopList loops={reinforcing} variableById={variableById} relationshipById={relationshipById} />
            {balancing.length > 0 ? (
              <p className="text-xs text-muted mt-3">
                {balancing.length} balancing loop hypothes{balancing.length > 1 ? "es" : "is"} also present (
                {balancing.map((l) => l.annotation?.name ?? l.id).join(", ")}); these tend to stabilise rather than escalate.
              </p>
            ) : null}
          </Card>
          {rejected.length > 0 ? (
            <Card title={`Rejected loop hypotheses (still formed by the edges) (${rejected.length})`}>
              <p className="text-xs text-muted mb-3">
                These readings were set aside by the person. The relationships that form them are unchanged, so the loops remain in the map; they are kept out of the list above.
              </p>
              <LoopList loops={rejected} variableById={variableById} relationshipById={relationshipById} />
            </Card>
          ) : null}
        </div>
        <Card title="Slow variables farthest from the desired state">
          <table className="data">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Current</th>
                <th>Desired</th>
                <th>Gap</th>
              </tr>
            </thead>
            <tbody>
              {slowOpen.map(({ g, v }) => (
                <tr key={v.id}>
                  <td>{v.name}</td>
                  <td className="tabular-nums text-accent">{fmtValue(g.current, v.unit)}</td>
                  <td className="tabular-nums text-desired">{fmtValue(g.desired, v.unit)}</td>
                  <td className="tabular-nums">{fmtPct(g.normalizedGap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3">
            <Note>
              Slow variables change over months or years and tend to persist across events. Gaps are normalised against each variable&apos;s reference range (A11) so different units can be compared.
            </Note>
          </div>
        </Card>
      </div>
    </div>
  );
}
