"use client";
import { useMemo, useState } from "react";
import { LoopList } from "@/components/loop-list";
import { useModel } from "@/components/model-provider";
import { NetworkDiagram } from "@/components/network-diagram";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";

export default function FeedbackMapPage() {
  const { evaluated } = useModel();
  const [selectedLoop, setSelectedLoop] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const highlight = useMemo(() => {
    if (!evaluated) return { edges: new Set<string>(), nodes: new Set<string>() };
    if (selectedLoop) {
      const l = evaluated.loops.find((x) => x.id === selectedLoop);
      return { edges: new Set(l?.edgeIds ?? []), nodes: new Set(l?.variableIds ?? []) };
    }
    if (selectedNode) {
      const edges = evaluated.relationships.filter((r) => r.sourceVariable === selectedNode || r.targetVariable === selectedNode);
      return {
        edges: new Set(edges.map((e) => e.id)),
        nodes: new Set([selectedNode, ...edges.flatMap((e) => [e.sourceVariable, e.targetVariable])]),
      };
    }
    return { edges: new Set<string>(), nodes: new Set<string>() };
  }, [evaluated, selectedLoop, selectedNode]);

  if (!evaluated) return <Loading />;
  const { relationships, variables, variableById, loops } = evaluated;

  return (
    <div>
      <PageHeader
        title="Relationships / feedback map"
        lede="Directed edges between variables. Loops are detected from the edges, never stored, so editing an edge changes the loops. Edge strength is a 0–1 judgment of influence, not a measured elasticity."
      />
      <Card>
        <NetworkDiagram
          variables={variables}
          relationships={relationships}
          highlightEdgeIds={highlight.edges}
          highlightNodeIds={highlight.nodes}
          onNodeClick={(id) => {
            setSelectedLoop(null);
            setSelectedNode(selectedNode === id ? null : id);
          }}
        />
        <p className="text-xs text-muted mt-2">Click a node to see its edges, or a loop below to trace it. Hover an edge for its explanation.</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <Card title={`Detected loops (${loops.length})`}>
          <LoopList
            loops={loops}
            variableById={variableById}
            selected={selectedLoop}
            onSelect={(id) => {
              setSelectedNode(null);
              setSelectedLoop(id);
            }}
          />
          <div className="mt-3">
            <Note>
              Reinforcing = even number of negative edges (A9). Pressure = mean edge strength × mean normalised gap of the loop&apos;s variables (A10): a diagnostic index of how actively a loop is reproducing the current state, not a rate.
            </Note>
          </div>
        </Card>
        <Card title={`Edges (${relationships.length})`}>
          <div className="overflow-x-auto max-h-[36rem] overflow-y-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>From → To</th>
                  <th>Sign</th>
                  <th>Str.</th>
                  <th>Lag</th>
                  <th>Provenance</th>
                </tr>
              </thead>
              <tbody>
                {relationships.map((r) => (
                  <tr key={r.id} className={highlight.edges.has(r.id) ? "bg-accent-soft" : ""}>
                    <td>
                      <div>
                        {variableById.get(r.sourceVariable)?.name} → {variableById.get(r.targetVariable)?.name}
                      </div>
                      <div className="text-xs text-muted">{r.explanation}</div>
                    </td>
                    <td className={r.direction === "negative" ? "text-warn" : "text-accent"}>{r.direction === "negative" ? "−" : "+"}</td>
                    <td className="tabular-nums">{r.strength.toFixed(1)}</td>
                    <td className="tabular-nums">{r.lagMonths} mo</td>
                    <td>
                      <div className="flex flex-col gap-1 items-start">
                        <SourceBadge sourceType={r.sourceType} />
                        <ConfidenceBadge confidence={r.confidence} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
