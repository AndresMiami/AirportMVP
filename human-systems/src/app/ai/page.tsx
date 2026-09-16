"use client";
/**
 * AI screen (Step 5B state):
 *   1. "What would be sent to AI": literally providerPayload(context), the
 *      only object a provider may receive, with its contextHash; beside it,
 *      LOCAL audit: "What was intentionally left out" (the manifest).
 *      The deterministic task mock can be run against that exact payload
 *      and its validated output shown: "Mock interpretation — nothing will
 *      be added to your model." No provider, no network, no write.
 *   2. LEGACY, READ-ONLY: the old mock analysis is still displayed, clearly
 *      labelled, until the output-schema replacement lands. It can no
 *      longer write to the model: every write goes through the proposal
 *      kernel, and the old candidate schema is not routed into proposals.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { AI_TASKS, TASK_POLICIES, buildAiContext, hashedContent, providerPayload, type AiContext, type AiTask } from "@/ai/context";
import type { AiOutputItem, AiResponse } from "@/ai/response";
import { MockAiTaskProvider } from "@/ai/task-mock";
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
  const [mock, setMock] = useState<{ forHash: string; result: { ok: true; response: AiResponse } | { ok: false; error: string } } | null>(null);
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
  const ctx = built && "ctx" in built ? built.ctx : null;
  const payload = ctx ? providerPayload(ctx) : null;
  const runMock = async () => {
    if (!ctx || !payload) return;
    const result = await new MockAiTaskProvider().run(payload, ctx.contextHash);
    setMock({ forHash: ctx.contextHash, result });
  };
  const mockShown = mock && ctx && mock.forHash === ctx.contextHash ? mock.result : null;
  return (
    <>
      <Card title="What would be sent to AI (the provider payload; read-only preview, nothing is sent)">
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
        ) : ctx && payload ? (
          <div className="mt-3 space-y-3 text-sm" data-testid="ai-context">
            <div className="rounded border border-border p-2 text-xs">
              <div className="text-muted">Context hash = hash of exactly this payload (task + items; never the manifest, the model revision or the clock)</div>
              <div className="font-mono" data-testid="context-hash">
                {ctx.contextHash}
              </div>
              <div className="text-muted mt-1">
                {payload.items.length} item{payload.items.length === 1 ? "" : "s"} · {ctx.manifest.approxChars.toLocaleString()} characters canonical
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-muted">Provider payload items ({payload.items.length})</summary>
              <ul className="mt-1 space-y-1 text-xs">
                {payload.items.map((it) => (
                  <li key={it.id} className="rounded border border-border p-2" data-item-kind={it.kind}>
                    <div className="font-mono">{it.id}</div>
                    <pre className="whitespace-pre-wrap break-all text-muted">{JSON.stringify(it.payload, null, 1)}</pre>
                  </li>
                ))}
              </ul>
            </details>
            <details onToggle={(e) => setShowHashed((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-xs text-muted">Exact provider payload (the hashed content)</summary>
              {showHashed ? (
                <pre className="mt-1 whitespace-pre-wrap break-all text-xs text-muted max-h-96 overflow-auto" data-testid="provider-payload">
                  {hashedContent(ctx)}
                </pre>
              ) : null}
            </details>
          </div>
        ) : null}
      </Card>

      {ctx ? (
        <Card title="What was intentionally left out (local audit; never sent)" className="mt-4">
          <div className="grid gap-2 md:grid-cols-3 text-xs" data-testid="ai-manifest">
            <div className="rounded border border-border p-2">
              <div className="text-muted">Included</div>
              <ul>
                {Object.entries(ctx.manifest.included).map(([k, n]) => (
                  <li key={k}>
                    {k}: {n}
                  </li>
                ))}
              </ul>
              <div className="text-muted mt-1">Subjects: {ctx.manifest.subjectsIncluded.join(", ")}</div>
            </div>
            <div className="rounded border border-border p-2">
              <div className="text-muted">Excluded</div>
              <ul>
                {ctx.manifest.subjectsExcluded.map((s) => (
                  <li key={s.id}>
                    subject {s.id}: {s.reason}
                  </li>
                ))}
                {ctx.manifest.exclusions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div className="rounded border border-border p-2">
              <div className="text-muted">Sensitive material withheld</div>
              {ctx.manifest.sensitiveExcluded.length === 0 ? (
                <p>None for this call.</p>
              ) : (
                <ul>
                  {ctx.manifest.withheld.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                  <li className="text-muted">ids: {ctx.manifest.sensitiveExcluded.join(", ")}</li>
                </ul>
              )}
              <div className="text-muted mt-1">Source model state (local audit id): {ctx.sourceRevisionHash}</div>
            </div>
          </div>
        </Card>
      ) : null}

      {ctx && payload ? (
        <Card title="Mock interpretation — nothing will be added to your model" className="mt-4">
          <p className="text-xs text-muted mb-2">A deterministic mock answers the exact payload above under the new contract; its output is validated against that payload before it is shown. There is nothing here to approve: no model write, no proposal.</p>
          <button type="button" className="rounded border border-border bg-background px-3 py-1.5 text-sm hover:border-accent" onClick={() => void runMock()}>
            Run the task mock (no network)
          </button>
          {mockShown ? (
            mockShown.ok ? (
              <ul className="mt-3 space-y-2 text-sm" data-testid="mock-output">
                {mockShown.response.items.map((it) => (
                  <MockItem key={it.id} it={it} />
                ))}
                {mockShown.response.items.length === 0 ? <li className="text-muted">The mock has nothing to say for this payload.</li> : null}
              </ul>
            ) : (
              <Note tone="warn">The mock output was rejected by the contract: {mockShown.error}</Note>
            )
          ) : mock && ctx && mock.forHash !== ctx.contextHash ? (
            <p className="mt-2 text-xs text-muted">The payload changed since the mock ran; run it again for this payload.</p>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

function MockItem({ it }: { it: AiOutputItem }) {
  const cites = (refs: string[]) => (refs.length ? <div className="text-xs text-muted">cites: {refs.join(", ")}</div> : null);
  switch (it.kind) {
    case "extraction":
      return (
        <li className="rounded border border-border p-2" data-output-kind={it.kind}>
          <div>
            <span className="text-xs rounded bg-background border border-border px-1 mr-1">extraction · directly stated</span>
            {it.text}
          </div>
          <div className="text-xs text-muted">quote: “{it.quote}”</div>
          {cites([it.sourceRef, ...(it.subjectRef ? [it.subjectRef] : [])])}
        </li>
      );
    case "interpretation":
      return (
        <li className="rounded border border-border p-2" data-output-kind={it.kind}>
          <div>
            <span className="text-xs rounded bg-background border border-border px-1 mr-1">interpretation · {it.state}</span>
            {it.text}
          </div>
          {it.caveat ? <div className="text-xs text-muted">caveat: {it.caveat}</div> : null}
          {cites(it.restsOn)}
        </li>
      );
    case "candidate_explanation":
      return (
        <li className="rounded border border-border p-2" data-output-kind={it.kind}>
          <div>
            <span className="text-xs rounded bg-background border border-border px-1 mr-1">candidate explanation · {it.state}</span>
            {it.text}
          </div>
          {it.weakenedBy.length ? <div className="text-xs text-muted">weakened by: {it.weakenedBy.join(" · ")}</div> : null}
          {it.alternatives.length ? <div className="text-xs text-muted">alternatives: {it.alternatives.join(" · ")}</div> : null}
          {cites([it.forPattern, ...it.restsOn])}
        </li>
      );
    case "question":
      return (
        <li className="rounded border border-border p-2" data-output-kind={it.kind}>
          <div>
            <span className="text-xs rounded bg-background border border-border px-1 mr-1">question</span>
            {it.text}
          </div>
          <div className="text-xs text-muted">why it matters: {it.whyItMatters}</div>
          {cites(it.targets)}
        </li>
      );
    case "summary":
      return (
        <li className="rounded border border-border p-2" data-output-kind={it.kind}>
          {it.sections.map((s) => (
            <div key={s.heading} className="mb-1">
              <div className="text-xs font-semibold">{s.heading}</div>
              <div>{s.text}</div>
              {cites(s.cites)}
            </div>
          ))}
        </li>
      );
  }
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

      <details className="mt-6">
        <summary className="cursor-pointer text-sm text-muted">Legacy analysis (read-only, superseded contract)</summary>
      <Card className="mt-2" title="Legacy analysis (read-only)">
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
      </details>
    </div>
  );
}
