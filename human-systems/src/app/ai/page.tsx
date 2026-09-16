"use client";
/**
 * AI screen (Step 5B state):
 *   1. "What would be sent to AI": the deterministic, inspectable context
 *      the builder assembles for a task (items, manifest, hash). Read-only;
 *      no provider, no network.
 *   2. LEGACY, READ-ONLY: the old mock analysis is still displayed, clearly
 *      labelled, until the output-schema replacement lands. It can no
 *      longer write to the model: every write goes through the proposal
 *      kernel, and the old candidate schema is not routed into proposals.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { AI_TASKS, TASK_POLICIES, buildAiContext, hashedContent, type AiContext, type AiTask } from "@/ai/context";
import { MockAiProvider } from "@/ai/mock-provider";
import { ANALYSIS_SYSTEM_PROMPT } from "@/ai/prompt";
import type { AiAnalysis } from "@/ai/schema";
import { formatLag } from "@/calculations/lag";
import { useModel } from "@/components/model-provider";
import { Card, CategoryBadge, ConfidenceBadge, Loading, Note, PageHeader } from "@/components/ui";

const TASK_WORDS: Record<AiTask, string> = {
  extract_statements: "Extract statements from my text",
  interpret_free_text: "Interpret my text against the model",
  suggest_explanations_for_pattern: "Suggest explanations for an Explore pattern",
  suggest_questions_to_reduce_uncertainty: "Suggest questions that would reduce uncertainty",
  summarize_model: "Summarize the model",
  propose_observation_from_user_statement: "Turn one statement of mine into an observation",
};

function ContextPanel() {
  const { model, evaluated } = useModel();
  const [task, setTask] = useState<AiTask>("interpret_free_text");
  const [subjectId, setSubjectId] = useState<string>("");
  const [userText, setUserText] = useState("My hours dropped from 40 to 15 in March.");
  const [includeSensitive, setIncludeSensitive] = useState(false);
  // "values as of" is part of the context's content, so it is chosen explicitly (date-only = end of that day)
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [showHashed, setShowHashed] = useState(false);
  const built = useMemo<{ ctx: AiContext } | { error: string } | null>(() => {
    if (!model) return null;
    try {
      const subject = subjectId || model.id;
      const selection = { subjectId: subject, subjectIds: [subject], userText, includeSensitive, asOf };
      return { ctx: buildAiContext(model, task, selection) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [model, task, subjectId, userText, includeSensitive, asOf]);
  if (!model || !evaluated) return null;
  const policy = TASK_POLICIES[task];
  const needsPattern = policy.requires.includes("pattern");
  return (
    <Card title="What would be sent to AI (read-only preview; nothing is sent)">
      <div className="grid gap-3 md:grid-cols-2 text-sm">
        <label className="block">
          <span className="text-xs text-muted">Task</span>
          <select className="mt-0.5 block w-full" value={task} onChange={(e) => setTask(e.target.value as AiTask)} aria-label="AI task">
            {AI_TASKS.map((t) => (
              <option key={t} value={t}>
                {TASK_WORDS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted">Subject</span>
          <select className="mt-0.5 block w-full" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} aria-label="Subject">
            <option value="">{model.profile.name} (the system)</option>
            {model.profile.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block md:col-span-2">
          <span className="text-xs text-muted">Your text (only sent for tasks that use it)</span>
          <textarea className="mt-0.5 block w-full" rows={2} value={userText} onChange={(e) => setUserText(e.target.value)} aria-label="Your text" />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Values as of (part of the content; never the clock)</span>
          <input type="date" className="mt-0.5 block" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="Values as of" />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={includeSensitive} onChange={(e) => setIncludeSensitive(e.target.checked)} />
          Include items the domain marks sensitive (explicit, per call)
        </label>
      </div>
      <p className="mt-2 text-xs text-muted">
        Allowed item kinds for this task: {policy.kinds.join(", ")}. Scope: {policy.scope === "subject" ? "the chosen subject plus the system" : policy.scope === "pattern" ? "the pattern's deterministic Explore scope" : "the selected subjects plus the system"}.
        {needsPattern ? " This task takes a pattern from Explore; the preview here has none." : ""}
      </p>
      {built && "error" in built ? (
        <Note tone="warn">{built.error}</Note>
      ) : built ? (
        <div className="mt-3 space-y-3 text-sm" data-testid="ai-context">
          <div className="grid gap-2 md:grid-cols-3 text-xs">
            <div className="rounded border border-border p-2">
              <div className="text-muted">Context hash (content only, never the clock)</div>
              <div className="font-mono" data-testid="context-hash">
                {built.ctx.contextHash}
              </div>
              <div className="text-muted mt-1">{built.ctx.manifest.approxChars.toLocaleString()} characters canonical</div>
            </div>
            <div className="rounded border border-border p-2">
              <div className="text-muted">Included</div>
              <ul>
                {Object.entries(built.ctx.manifest.included).map(([k, n]) => (
                  <li key={k}>
                    {k}: {n}
                  </li>
                ))}
              </ul>
              <div className="text-muted mt-1">Subjects: {built.ctx.manifest.subjectsIncluded.join(", ")}</div>
            </div>
            <div className="rounded border border-border p-2">
              <div className="text-muted">Excluded</div>
              <ul>
                {built.ctx.manifest.subjectsExcluded.map((s) => (
                  <li key={s.id}>
                    subject {s.id}: {s.reason}
                  </li>
                ))}
                {built.ctx.manifest.exclusions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
                {built.ctx.manifest.sensitiveExcluded.length > 0 ? <li>sensitive, not included: {built.ctx.manifest.sensitiveExcluded.join(", ")}</li> : null}
              </ul>
            </div>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted">Items ({built.ctx.items.length})</summary>
            <ul className="mt-1 space-y-1 text-xs">
              {built.ctx.items.map((it) => (
                <li key={it.id} className="rounded border border-border p-2" data-item-kind={it.kind}>
                  <div className="font-mono">{it.id}</div>
                  <pre className="whitespace-pre-wrap break-all text-muted">{JSON.stringify(it.payload, null, 1)}</pre>
                </li>
              ))}
            </ul>
          </details>
          <details onToggle={(e) => setShowHashed((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-xs text-muted">Exact hashed content</summary>
            {showHashed ? <pre className="mt-1 whitespace-pre-wrap break-all text-xs text-muted max-h-96 overflow-auto">{hashedContent(built.ctx)}</pre> : null}
          </details>
        </div>
      ) : null}
    </Card>
  );
}

export default function AiPage() {
  const { evaluated } = useModel();
  const [text, setText] = useState("My brother works four days per week and spends much of his free time sleeping or playing games, but he has saved $10,000 over 18 months toward buying a car.");
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!evaluated) return <Loading />;

  const run = async () => {
    setBusy(true);
    setError(null);
    setAnalysis(null);
    const provider = new MockAiProvider(evaluated.domain.promptFragment?.exampleAnalysis);
    const r = await provider.analyze({ text });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else setAnalysis(r.analysis);
  };

  return (
    <div>
      <PageHeader title="AI" lede="AI interprets; evidence constrains; the model calculates; the human approves. Below: exactly what a task would send to an AI provider, and the legacy mock analysis, now read-only." />
      <ContextPanel />

      <Card className="mt-6" title="Legacy analysis (read-only)">
        <Note tone="warn">
          LEGACY, READ-ONLY. This is the old mock analysis contract: it asks the AI for numeric confidences, strengths and lags, which the current architecture no longer accepts. Nothing here can enter the model. Every change to the model goes through{" "}
          <Link href="/proposals" className="underline">
            Proposals
          </Link>
          ; the old candidate schema is not routed there and will be replaced.
        </Note>
        <textarea className="w-full mt-3" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-2 flex gap-2 items-center">
          <button className="rounded border border-border bg-background px-3 py-1.5 text-sm disabled:opacity-50" disabled={busy || text.trim().length === 0} onClick={run}>
            {busy ? "Showing…" : "Show the legacy mock analysis (no network)"}
          </button>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Legacy system prompt</summary>
            <pre className="whitespace-pre-wrap mt-2 max-w-2xl">{ANALYSIS_SYSTEM_PROMPT}</pre>
          </details>
        </div>
        {error ? <p className="text-sm text-neg mt-2">{error}</p> : null}
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
            <Card title="Candidate variables (legacy; display only, cannot be added)">
              <table className="data">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Reading</th>
                    <th>Evidence</th>
                    <th>Legacy confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.candidate_variables.map((c, i) => (
                    <tr key={i}>
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
                          <div className="text-xs">
                            stated: {c.statedValue} {c.unit}
                          </div>
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
                        <div className="text-xs text-muted">invented by the legacy contract</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Candidate relationships (legacy; display only)">
                {analysis.candidate_relationships.length === 0 ? (
                  <p className="text-sm text-muted">None proposed.</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {analysis.candidate_relationships.map((r, i) => (
                      <li key={i}>
                        {r.sourceVariable} → {r.targetVariable} ({r.direction}, legacy strength ≈ {r.strengthEstimate}, legacy lag {formatLag(r.lagEstimate)}) <ConfidenceBadge confidence={r.confidence} />
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
      </Card>
    </div>
  );
}
