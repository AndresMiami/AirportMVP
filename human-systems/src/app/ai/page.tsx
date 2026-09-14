"use client";
import { useState } from "react";
import { MockAiProvider } from "@/ai/mock-provider";
import { ANALYSIS_SYSTEM_PROMPT } from "@/ai/prompt";
import type { AiAnalysis } from "@/ai/schema";
import { useModel } from "@/components/model-provider";
import { Card, CategoryBadge, ConfidenceBadge, Loading, Note, PageHeader } from "@/components/ui";
import type { Variable } from "@/types";

const provider = new MockAiProvider();

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export default function AiPage() {
  const { evaluated, replaceModel } = useModel();
  const [text, setText] = useState(
    "My brother works four days per week and spends much of his free time sleeping or playing games, but he has saved $10,000 over 18 months toward buying a car.",
  );
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  if (!evaluated) return <Loading />;
  const { model } = evaluated;

  const run = async () => {
    setBusy(true);
    setError(null);
    setAnalysis(null);
    setApproved(new Set());
    setAdded([]);
    const r = await provider.analyze({ text, existingVariableNames: model.variables.map((v) => v.name) });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else setAnalysis(r.analysis);
  };

  const addApproved = () => {
    if (!analysis) return;
    const existing = new Set(model.variables.map((v) => v.id));
    const created: Variable[] = [];
    analysis.candidate_variables.forEach((c, i) => {
      if (!approved.has(i)) return;
      let id = `ai_${slug(c.name)}`;
      let n = 2;
      while (existing.has(id)) id = `ai_${slug(c.name)}_${n++}`;
      existing.add(id);
      created.push({
        id,
        name: c.name,
        description: c.description,
        category: c.category,
        changeSpeed: c.changeSpeed,
        kind: "input",
        currentValue: c.statedValue,
        desiredValue: null,
        targetMode: "exact",
        unit: c.unit,
        sourceType: "ai_inferred",
        confidence: c.confidence,
        evidence: [
          { text: `${c.qualitativeValue} — ${c.evidence}`, sourceType: "ai_inferred" },
          ...(c.caveat ? [{ text: `Caveat: ${c.caveat}`, sourceType: "ai_inferred" as const }] : []),
        ],
        controllability: 0.5,
        durability: 0.5,
        estimatedCostToChange: 0.5,
        notes: "Approved from AI analysis; review the judgments before relying on them.",
      });
    });
    if (created.length === 0) return;
    replaceModel({ ...model, variables: [...model.variables, ...created] });
    setAdded(created.map((v) => v.name));
    setApproved(new Set());
  };

  return (
    <div>
      <PageHeader
        title="Analyze my situation"
        lede="Paste a description. The provider returns strictly-shaped JSON that is validated before anything is shown. Nothing enters the model until you approve it here, and approved items are stamped ai_inferred with the evidence the AI cited."
      />
      <Note tone="warn">
        The MVP ships with a deterministic mock provider (no network, fixed output) so the review contract can be exercised. A real provider is a one-file swap behind the same interface (src/ai/provider.ts).
      </Note>
      <Card className="mt-4">
        <textarea className="w-full" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-2 flex gap-2 items-center">
          <button className="rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50" disabled={busy || text.trim().length === 0} onClick={run}>
            {busy ? "Analyzing…" : `Analyze with ${provider.name} provider`}
          </button>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">System prompt</summary>
            <pre className="whitespace-pre-wrap mt-2 max-w-2xl">{ANALYSIS_SYSTEM_PROMPT}</pre>
          </details>
        </div>
        {error ? <p className="text-sm text-neg mt-2">{error}</p> : null}
      </Card>

      {analysis ? (
        <div className="mt-4 space-y-4">
          <Card title="Observations (restated from the text)">
            <ul className="list-disc pl-5 text-sm space-y-1">
              {analysis.observations.map((o, i) => (
                <li key={i}>
                  {o.text} {o.quote ? <span className="text-xs text-muted">— &ldquo;{o.quote}&rdquo;</span> : null}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Candidate variables — review before they enter the model">
            <table className="data">
              <thead>
                <tr>
                  <th>Approve</th>
                  <th>Candidate</th>
                  <th>Reading</th>
                  <th>Evidence</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {analysis.candidate_variables.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Approve ${c.name}`}
                        checked={approved.has(i)}
                        onChange={(e) => {
                          const next = new Set(approved);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          setApproved(next);
                        }}
                      />
                    </td>
                    <td>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted max-w-xs">{c.description}</div>
                      <div className="mt-1 flex gap-1">
                        <CategoryBadge category={c.category} /> <span className="text-xs text-muted">{c.changeSpeed}</span>
                      </div>
                    </td>
                    <td>
                      <div>{c.qualitativeValue}</div>
                      {c.statedValue !== null ? (
                        <div className="text-xs">stated: {c.statedValue} {c.unit}</div>
                      ) : (
                        <div className="text-xs text-muted">no number (none stated)</div>
                      )}
                    </td>
                    <td className="text-xs max-w-xs">
                      {c.evidence}
                      {c.caveat ? <div className="text-muted mt-1">Caveat: {c.caveat}</div> : null}
                    </td>
                    <td>
                      <ConfidenceBadge confidence={c.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center gap-3">
              <button className="rounded bg-desired text-white px-3 py-1.5 text-sm disabled:opacity-50" disabled={approved.size === 0} onClick={addApproved}>
                Add {approved.size} approved to the model
              </button>
              {added.length > 0 ? <span className="text-xs text-desired">Added: {added.join(", ")}</span> : null}
            </div>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Candidate relationships (not yet importable)">
              {analysis.candidate_relationships.length === 0 ? (
                <p className="text-sm text-muted">None proposed.</p>
              ) : (
                <ul className="text-sm space-y-1">
                  {analysis.candidate_relationships.map((r, i) => (
                    <li key={i}>
                      {r.sourceVariable} → {r.targetVariable} ({r.direction}, strength ≈ {r.strengthEstimate}) <ConfidenceBadge confidence={r.confidence} />
                      <div className="text-xs text-muted">{r.explanation}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Missing information / contradictions / confidence notes">
              <ul className="list-disc pl-5 text-sm space-y-1">
                {analysis.missing_information.map((m, i) => (
                  <li key={`m${i}`}>Missing: {m}</li>
                ))}
                {analysis.contradictions.map((m, i) => (
                  <li key={`c${i}`} className="text-warn">
                    Contradiction: {m}
                  </li>
                ))}
                {analysis.confidence_notes.map((m, i) => (
                  <li key={`n${i}`} className="text-muted">
                    {m}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
