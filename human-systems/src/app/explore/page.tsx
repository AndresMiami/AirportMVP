"use client";
/**
 * EXPLORE THIS PATTERN — read-only. "This kept happening. Why might that
 * be?" answered from the deterministic cross-context engine: what was
 * different each time, what was the same, what was also true when it did
 * NOT happen, what is still unresolved, and possible explanations to
 * investigate. Candidates come only from the person's own drafts (kept in
 * this browser, never in the model) and from hypotheses deterministically
 * linked to the record. Catalogue prompts are questions to consider, never
 * candidates. Nothing here writes to the model; "Investigate this
 * explanation" is inert until the review step exists.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useState } from "react";
import { useModel } from "@/components/model-provider";
import { Card, Loading, Note, PageHeader } from "@/components/ui";
import {
  CAUSATION_DISCLAIMER,
  EXPLORE_QUESTIONS,
  INVESTIGATE_INERT_TEXT,
  NO_CANDIDATE_YET,
  RELATED_HYPOTHESES_HEADING,
  RELATED_HYPOTHESES_NOTE,
  contextSubjectsFor,
  crossContext,
  dayMonthYear,
  decodePatternRef,
  encodePatternRef,
  formatValue,
  linkedHypotheses,
  monthYear,
  type ConditionAssessment,
  type CrossContext,
  type PatternRef,
} from "@/discovery";
import { locusLabel, type DomainDefinition, type Locus } from "@/model/domain";
import { subjectLabelFor } from "@/model/subjects";
import type { SystemModel } from "@/types";

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50 disabled:cursor-not-allowed";
const LOCI: Locus[] = ["external_to_subject", "internal_to_subject", "interaction"];
const DRAFTS_KEY = "human-systems.explore-drafts.v1";

interface Draft {
  id: string;
  locus: Locus;
  text: string;
  promptId?: string;
}

/** Per-viewer drafts, in this browser only: never model state. */
function readDrafts(scope: string): Draft[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, Draft[]>;
    return Array.isArray(all[scope]) ? all[scope] : [];
  } catch {
    return [];
  }
}
function writeDrafts(scope: string, drafts: Draft[]): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, Draft[]>;
    all[scope] = drafts;
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: drafts live for this page only */
  }
}

function conditionLabel(c: ConditionAssessment): string {
  if (c.atOccurrences === "differing") return "differed";
  if (c.atOccurrences === "insufficient") return "unresolved";
  if (c.contrastCoverage === "none") return "no usable contrast";
  if (c.contrastCoverage === "partial") return "comparison incomplete";
  if (c.contrastShows === "same") return "also true when this did not happen";
  if (c.contrastShows === "different") return "different every time we have complete contrast evidence";
  return "partly distinguishes";
}

function ConditionList({ items, empty }: { items: ConditionAssessment[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="-mx-4 divide-y divide-border border-t border-border">
      {items.map((c) => (
        <li key={c.variableId} className="px-4 py-2 text-sm">
          {c.statement} <span className="text-xs text-muted">· {conditionLabel(c)}</span>
        </li>
      ))}
    </ul>
  );
}

function Occurrences({ r, model }: { r: CrossContext; model: SystemModel }) {
  const fmtExtent = (s: CrossContext["occurrences"][number]) => (s.application.text ? s.application.text : s.application.start === s.application.end ? dayMonthYear(s.application.start) : `${dayMonthYear(s.application.start)} to ${dayMonthYear(s.application.end)}`);
  return (
    <div className="grid gap-3 md:grid-cols-2 text-sm">
      <div>
        <p className="text-xs text-muted mb-1">Recorded at {formatValue(r.pattern.repeatedValue, r.unit)}:</p>
        <ul className="space-y-0.5">
          {r.occurrences.map((s) => (
            <li key={s.application.start}>
              {fmtExtent(s)}
              {s.application.kind === "approx" ? <span className="text-xs text-muted"> · approximate</span> : null}
              {s.application.kind === "range" ? <span className="text-xs text-muted"> · stated period</span> : null}
              {s.eventsNear.length > 0 ? <span className="text-xs text-muted"> · events nearby: {s.eventsNear.map((e) => e.title).join(", ")}</span> : null}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-xs text-muted mb-1">Recorded at other values:</p>
        {r.contrasts.length === 0 ? (
          <p className="text-muted">None in this period, so nothing can be said about what distinguishes the occurrences.</p>
        ) : (
          <ul className="space-y-0.5">
            {r.contrasts.map((s) => (
              <li key={s.application.start}>
                {fmtExtent(s)} · {formatValue(s.patternValue, r.unit)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted md:col-span-2">
        {subjectLabelFor(model, r.pattern.subjectId)} · {monthYear(r.pattern.interval.from)} → {monthYear(r.pattern.interval.to)} · events counted within {r.window.days} days of an occurrence (a display convention)
      </p>
    </div>
  );
}

function Explanations({ r, model, domain }: { r: CrossContext; model: SystemModel; domain: DomainDefinition }) {
  const ids = useId();
  // drafts are keyed by the FULL pattern reference (interval included): a wider
  // evidence window has different contrast cases and is a different investigation
  const scope = `${model.id}|${encodePatternRef(r.pattern)}`;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<{ locus: Locus; text: string; promptId?: string } | null>(null);
  useEffect(() => {
    // localStorage is a per-viewer convenience: read once per pattern in an effect, never during render
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts(readDrafts(scope));
  }, [scope]);
  const save = (next: Draft[]) => {
    setDrafts(next);
    writeDrafts(scope, next);
  };
  const linked = linkedHypotheses(model, r.pattern.variableId);
  const prompts = domain.explanationCatalogue?.prompts ?? [];
  const linkWords: Record<string, string> = {
    prediction: "a prediction names this record",
    kill_criterion: "a decision rule names this record",
    relationship: "a linked relationship touches this record",
    supporting_observation: "a supporting observation names this record",
    contradicting_observation: "a contradicting observation names this record",
    observation_link: "an observation links both",
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold text-muted mb-1">{RELATED_HYPOTHESES_HEADING}</h3>
        <p className="text-xs text-muted mb-1">{RELATED_HYPOTHESES_NOTE}</p>
        {linked.length === 0 ? (
          <p className="text-sm text-muted">No hypothesis is linked to this record yet (links, never wording, decide this).</p>
        ) : (
          <ul className="text-sm space-y-1">
            {linked.map(({ hypothesis, linkedVia }) => (
              <li key={hypothesis.id}>
                <Link href="/hypotheses" className="underline">
                  {hypothesis.statement}
                </Link>{" "}
                <span className="text-xs text-muted">
                  · {hypothesis.status} · {linkedVia.map((v) => linkWords[v]).join("; ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {LOCI.map((locus) => {
        const mine = drafts.filter((d) => d.locus === locus);
        const questions = prompts.filter((p) => p.locus === locus);
        return (
          <div key={locus}>
            <h3 className="text-xs font-semibold text-muted mb-1">{locusLabel(domain, locus)}</h3>
            {mine.length === 0 ? (
              <p className="text-sm text-muted">{NO_CANDIDATE_YET}</p>
            ) : (
              <ul className="text-sm space-y-2">
                {mine.map((d) => (
                  <li key={d.id} className="rounded border border-border px-3 py-2">
                    <p>{d.text}</p>
                    {d.promptId ? <p className="text-xs text-muted">from the question: {prompts.find((p) => p.id === d.promptId)?.question}</p> : null}
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      <button type="button" className={BTN} disabled title={INVESTIGATE_INERT_TEXT} aria-describedby={`${ids}-inert`}>
                        Investigate this explanation
                      </button>
                      <button type="button" className={BTN} onClick={() => save(drafts.filter((x) => x.id !== d.id))}>
                        Remove draft
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {questions.length > 0 ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-xs text-muted">Questions to consider ({questions.length})</summary>
                <ul className="mt-1 space-y-1">
                  {questions.map((q) => (
                    <li key={q.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span>{q.question}</span>
                      {q.hint ? <span className="text-xs text-muted">({q.hint})</span> : null}
                      <button type="button" className={BTN} onClick={() => setEditing({ locus, text: "", promptId: q.id })}>
                        Write an explanation from this
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {editing?.locus === locus ? (
              <div className="mt-2 rounded border border-accent bg-accent-soft p-3 text-sm">
                {editing.promptId ? <p className="text-xs text-muted mb-1">{prompts.find((p) => p.id === editing.promptId)?.question}</p> : null}
                <label htmlFor={`${ids}-draft-${locus}`} className="block text-xs text-muted">
                  Your explanation, as a condition to test (not a verdict about anyone)
                </label>
                <textarea id={`${ids}-draft-${locus}`} className="w-full mt-1" rows={2} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={BTN}
                    disabled={editing.text.trim().length === 0}
                    onClick={() => {
                      save([...drafts, { id: `d_${Date.now().toString(36)}`, locus, text: editing.text.trim(), promptId: editing.promptId }]);
                      setEditing(null);
                    }}
                  >
                    Keep as a candidate (this browser only)
                  </button>
                  <button type="button" className={BTN} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className={`${BTN} mt-2`} onClick={() => setEditing({ locus, text: "" })}>
                Write your own
              </button>
            )}
          </div>
        );
      })}
      <p id={`${ids}-inert`} className="text-xs text-muted">
        {INVESTIGATE_INERT_TEXT} Drafts stay in this browser and are not part of the model.
      </p>
    </div>
  );
}

function ExploreBody({ pattern, model, domain }: { pattern: PatternRef; model: SystemModel; domain: DomainDefinition }) {
  // context scope is domain configuration (a household reads its members for a household-level pattern); the math is unchanged
  const result = useMemo(() => crossContext(model, pattern, { contextSubjectIds: contextSubjectsFor(model, pattern, domain) }), [model, pattern, domain]);
  // back to History with the same period the pattern was found in (the reference carries it; nothing else is invented)
  const back = `/history?${new URLSearchParams({ from: pattern.interval.from, to: pattern.interval.to }).toString()}`;
  if (!result.ok) {
    return (
      <div className="space-y-3">
        <Note tone="warn">{result.message}</Note>
        <Link href={back} className="underline text-sm">
          Back to History
        </Link>
      </div>
    );
  }
  const r = result;
  const byId = new Map(r.conditions.map((c) => [c.variableId, c]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)!).filter(Boolean);
  const unresolved = pick([...r.groups.insufficientAtOccurrences, ...r.groups.undecided, ...r.groups.contrastPartial]);
  return (
    <div className="space-y-4">
      <Card title={EXPLORE_QUESTIONS[0]}>
        <p className="text-sm mb-3">{r.statements[0]}</p>
        <Occurrences r={r} model={model} />
      </Card>
      <Card title={`${EXPLORE_QUESTIONS[1]} (${r.groups.differingAtOccurrences.length})`}>
        <ConditionList items={pick(r.groups.differingAtOccurrences)} empty="Nothing recorded changed between the occurrences." />
      </Card>
      <Card title={`${EXPLORE_QUESTIONS[2]} (${r.groups.commonAtOccurrences.length})`}>
        <p className="text-xs text-muted mb-2">Recorded at the same value at every occurrence. A value only carried forward by the resolver never counts. Recorded together is not caused by.</p>
        <ConditionList items={pick(r.groups.commonAtOccurrences)} empty="Nothing readable was recorded the same at every occurrence." />
      </Card>
      <Card title={`${EXPLORE_QUESTIONS[3]} (${r.groups.backgroundComplete.length + r.groups.differentiatingComplete.length + r.groups.mixedComplete.length})`}>
        <p className="text-xs text-muted mb-2">
          Conditions recorded the same at every occurrence, compared with the times the pattern was recorded at another value. Only comparisons with complete contrast coverage appear here; incomplete ones are under unresolved. True in both cases is not the difference.
        </p>
        {r.contrasts.length === 0 ? (
          <p className="text-sm text-muted">No contrast case is recorded, so nothing can be compared yet.</p>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold text-muted mb-1">Also true at every contrast time ({r.groups.backgroundComplete.length})</p>
              <ConditionList items={pick(r.groups.backgroundComplete)} empty="None." />
            </div>
            <div>
              <p className="text-xs font-semibold text-muted mb-1">Different at every contrast time, complete coverage ({r.groups.differentiatingComplete.length})</p>
              <ConditionList items={pick(r.groups.differentiatingComplete)} empty="None." />
            </div>
            <div>
              <p className="text-xs font-semibold text-muted mb-1">Mixed across contrast times ({r.groups.mixedComplete.length})</p>
              <ConditionList items={pick(r.groups.mixedComplete)} empty="None." />
            </div>
          </div>
        )}
      </Card>
      <Card title={`${EXPLORE_QUESTIONS[4]} (${unresolved.length})`}>
        <p className="text-xs text-muted mb-2">Missing, conflicting for the same time, varied within a broad period, only an older value standing, or contrast evidence incomplete. Each is a different thing, and each is said as it is.</p>
        <ConditionList items={unresolved} empty="Nothing is unresolved for this pattern." />
      </Card>
      <Card title={EXPLORE_QUESTIONS[5]}>
        <p className="text-xs text-muted mb-3">
          An explanation is a condition to test, never a verdict. The three headings are examined alike; a heading with no candidate stays empty rather than being filled in. A draft is a candidate, not evidence.
        </p>
        <Explanations r={r} model={model} domain={domain} />
      </Card>
      <div className="space-y-1">
        <Note>{CAUSATION_DISCLAIMER}</Note>
        {r.caveats.map((c) => (
          <Note key={c.code}>{c.text}</Note>
        ))}
      </div>
      <Link href={back} className="underline text-sm">
        Back to History
      </Link>
    </div>
  );
}

function ExploreInner() {
  const { status, model, evaluated, error } = useModel();
  const params = useSearchParams();
  const pattern = useMemo(() => decodePatternRef(new URLSearchParams(params.toString())), [params]);
  if (status === "error") return <Note tone="warn">Could not load the model: {error}</Note>;
  if (status === "loading" || !model || !evaluated) return <Loading />;
  return (
    <div>
      <PageHeader title="Explore this pattern" lede="This kept happening. Why might that be? What follows is what the records let us investigate: what differed, what was the same, what was also true when it did not happen, and what is still unresolved. Nothing here is a cause or a conclusion." />
      {pattern === null ? (
        <div className="space-y-3">
          <Note>Open a repeated record from History to explore it: every pattern here starts from something recorded more than once.</Note>
          <Link href="/history" className="underline text-sm">
            Go to History
          </Link>
        </div>
      ) : (
        <ExploreBody pattern={pattern} model={model} domain={evaluated.domain} />
      )}
    </div>
  );
}

export default function ExplorePage() {
  return (
    <Suspense fallback={<Loading />}>
      <ExploreInner />
    </Suspense>
  );
}
