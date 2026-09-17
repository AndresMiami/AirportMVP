"use client";
/**
 * RESEARCH (Step 7B, first increment): one thesis, one source file.
 *
 *   thesis (a hypothesis whose predictions or kill criteria name a variable)
 *   + an imported source snapshot
 *   -> the collector's proposals, one per matching item
 *   -> Review, where the person decides
 *   -> an approved value record with the source's own provenance
 *   -> History, Explore and the kill-criterion readings recompute
 *
 * The collector can only propose recording values; it never touches the
 * thesis. Sources are kept, version by version, so a changed source makes
 * the pending proposals it fed go stale.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { parseSourceSnapshot, runAgent, theses, type AgentRunResult, type SourceSnapshot, type SourceSummary } from "@/agents";
import { useModel } from "@/components/model-provider";
import { Loading, Note } from "@/components/ui";

const PRIMARY = "rounded-full bg-accent px-4 py-2 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";

export default function ResearchPage() {
  const { status, model, proposals, proposalRecovery, sources } = useModel();
  const [thesisId, setThesisId] = useState("");
  const [parsed, setParsed] = useState<{ ok: true; snapshot: SourceSnapshot; fileName: string } | { ok: false; error: string } | null>(null);
  const [onFile, setOnFile] = useState<SourceSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ run: AgentRunResult; stored: boolean } | { error: string } | null>(null);

  useEffect(() => {
    // the source store is read once storage is ready and after every run
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnFile(sources ? sources.list() : []);
  }, [sources, result]);

  const candidates = useMemo(() => (model ? theses(model) : []), [model]);
  const chosen = candidates.find((c) => c.thesis.id === thesisId) ?? candidates[0] ?? null;
  const ready = proposals !== null && sources !== null && proposalRecovery.status === "done";

  if (status === "loading" || !model) return <Loading />;

  const onFileChosen = async (file: File | undefined) => {
    setResult(null);
    if (!file) return setParsed(null);
    const text = await file.text();
    const r = parseSourceSnapshot(text);
    setParsed(r.ok ? { ok: true, snapshot: r.snapshot, fileName: file.name } : r);
  };

  const collect = async () => {
    if (!ready || !proposals || !sources || !chosen || !parsed || !parsed.ok) return;
    setBusy(true);
    setResult(null);
    try {
      const added = sources.add(parsed.snapshot);
      const run = await runAgent(proposals, model, chosen.thesis, parsed.snapshot);
      setResult({ run, stored: added.stored });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Research</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">Collect evidence for an explanation you are testing, from a source file. Every item becomes a proposal you decide on in Review; nothing is recorded until you approve it.</p>
      </header>

      <section className="mb-8" data-testid="thesis">
        <h2 className="text-lg font-semibold tracking-tight">The explanation to collect for</h2>
        {candidates.length === 0 ? (
          <p className="mt-2 text-[15px] leading-relaxed text-muted" data-testid="no-thesis">
            None of your explanations names a variable yet. Add a kill criterion or a prediction that names a variable on the{" "}
            <Link href="/hypotheses" className="underline">
              Hypotheses
            </Link>{" "}
            page, then come back.
          </p>
        ) : (
          <>
            <select className="mt-2 block w-full rounded-lg border border-border/70 bg-surface px-3 py-2 text-[15px]" value={chosen?.thesis.id ?? ""} onChange={(e) => setThesisId(e.target.value)} aria-label="Explanation">
              {candidates.map((c) => (
                <option key={c.thesis.id} value={c.thesis.id}>
                  {c.thesis.statement}
                </option>
              ))}
            </select>
            {chosen ? (
              <ul className="mt-3 space-y-1 text-[15px] leading-relaxed text-muted" data-testid="targets">
                {chosen.thesis.targets.map((t) => {
                  const v = model.variables.find((x) => x.id === t.variableId);
                  return (
                    <li key={t.id}>
                      {t.kind === "prediction" ? "Prediction" : "Kill criterion"}: “{t.statement}” · watches <span className="text-foreground">{v?.name ?? t.variableId}</span> (source key <code className="text-sm">{v?.key ?? "?"}</code>)
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        )}
      </section>

      <section className="mb-8" data-testid="source">
        <h2 className="text-lg font-semibold tracking-tight">The source</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          A JSON snapshot of one retrieval: the source&apos;s name, its version marker, when it was retrieved, and items that each quote the exact content, the period it applies to, the value and how the source came by it.{" "}
          <a href="/research/example-source.json" className="underline" download>
            Download an example
          </a>
          .
        </p>
        <input type="file" accept="application/json,.json" className="mt-3 block text-[15px]" aria-label="Source snapshot file" onChange={(e) => void onFileChosen(e.target.files?.[0])} />
        {parsed && !parsed.ok ? <Note tone="warn">{parsed.error}</Note> : null}
        {parsed && parsed.ok ? (
          <p className="mt-2 text-[15px] leading-relaxed" data-testid="parsed">
            {parsed.snapshot.name}, version {parsed.snapshot.version}, retrieved {parsed.snapshot.retrievedAt.slice(0, 10)}: {parsed.snapshot.items.length} item{parsed.snapshot.items.length === 1 ? "" : "s"}.
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className={PRIMARY} disabled={!ready || busy || !chosen || !parsed || !parsed.ok} onClick={() => void collect()} data-testid="collect">
            {busy ? "Collecting…" : "Collect evidence"}
          </button>
          <span className="text-sm text-muted">Creates proposals for Review. The explanation itself is never changed.</span>
        </div>
        {result && "error" in result ? <Note tone="warn">{result.error}</Note> : null}
        {result && "run" in result ? (
          <div className="mt-4 rounded-xl border border-border/70 bg-surface px-5 py-4 text-[15px] leading-relaxed" data-testid="run-result">
            <p>
              {result.run.created.length === 0 ? "Nothing new to propose." : result.run.created.length === 1 ? "1 proposal is waiting for you." : `${result.run.created.length} proposals are waiting for you.`}
              {!result.stored ? " This version of the source was already on file." : ""}
            </p>
            {result.run.skipped.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-muted">
                {result.run.skipped.map((s) => (
                  <li key={s.capture.identity}>
                    {s.capture.item.period.text}, {s.capture.variableName}: {s.reason === "already_recorded" ? "already recorded from this source" : "already proposed"}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.run.created.length > 0 ? (
              <Link href={`/proposals?focus=${encodeURIComponent(result.run.created[0].id)}`} className="mt-3 inline-block text-[15px] font-medium text-accent hover:underline">
                Review them →
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>

      <section data-testid="on-file">
        <h2 className="text-lg font-semibold tracking-tight">Sources on file</h2>
        {onFile.length === 0 ? (
          <p className="mt-2 text-[15px] text-muted">None yet. Every retrieval you collect from is kept, version by version.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border/70 text-[15px] leading-relaxed">
            {onFile.map((s) => (
              <li key={s.id} className="py-2">
                {s.name} · {s.versions} version{s.versions === 1 ? "" : "s"} · latest {s.latestVersion}, retrieved {s.latestRetrievedAt.slice(0, 10)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
