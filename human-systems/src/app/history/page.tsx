"use client";
/**
 * HISTORY (Step 6B: simplified presentation, same distinctions) — what the
 * records show over a period, read as three ordinary questions:
 *
 *   What changed?                          -> changed values + events
 *   What keeps showing up?                 -> exact repetition (Explore),
 *                                             low recorded variation, an
 *                                             explicitly stated period
 *   What still needs more information?     -> old value still standing,
 *                                             not enough history, unknown
 *
 * Every line comes from the deterministic discovery layer (src/discovery)
 * through the plain wording in src/features/history/wording.ts; nothing
 * here names a cause, ranks anything, or writes to the model. The
 * engine's own sentence, the raw records with source and confidence,
 * resolution states and evidence facts sit under Details; the period,
 * subject, the A23 display convention, calculated values and saved
 * snapshots sit under Change period and Advanced. "Explore what was
 * happening" hands the exact same PatternRef to /explore as before.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useId, useMemo, useState } from "react";
import { temporalInterval } from "@/calculations/time";
import { useModel } from "@/components/model-provider";
import { ConfidenceBadge, Loading, Note, SourceBadge } from "@/components/ui";
import { CAUSATION_DISCLAIMER, DiscoveryError, dayMonthYear, describeInterval, explorePatternText, formatValue, historySentenceFor, normalizeIntervalStart, type DescribedVariable, type HistoryLens, type IntervalDescription } from "@/discovery";
import { eventWhen, historyQuestions, needsInformationGroups, periodSummary, type HistoryRow, type RowGroup } from "@/features/history/wording";
import { monthName } from "@/features/plain-language";
import { subjectLabelFor, subjectsOf } from "@/model/subjects";
import type { SystemModel } from "@/types";

const A23 = { assumptionId: "A23" as const, tolerance: 0.1 };
const ALL = "";
const TOGGLE = "text-sm text-muted hover:text-foreground hover:underline";
const ACTION = "text-[15px] font-medium text-accent hover:underline";

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The earliest orderable asserted start over every active value entry and
 *  every dated event, as a date: the natural start of "the records". */
function earliestRecordedDate(model: SystemModel): string | null {
  let earliest: string | null = null;
  const consider = (extent: { start: string } | null) => {
    if (!extent) return;
    const start = normalizeIntervalStart(extent.start);
    if (earliest === null || start < earliest) earliest = start;
  };
  for (const v of model.variables) for (const e of v.values) if (e.status === "active") consider(temporalInterval(e.valid));
  for (const e of model.events) consider(temporalInterval(e.occurred));
  return earliest ? (earliest as string).slice(0, 10) : null;
}

/** Details: the engine's own sentence and evidence lines, the raw records
 *  with source and confidence, resolution at both ends, evidence facts. */
function Details({ item, lens }: { item: DescribedVariable; lens: HistoryLens }) {
  const d = item.description;
  const sentences = historySentenceFor(d, lens);
  return (
    <div className="mt-3 space-y-3 text-sm" data-testid="history-details">
      <p className="text-muted">{sentences.headline}</p>
      {sentences.details.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-muted">
          {sentences.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Applies</th>
              <th>Value</th>
              <th>Source</th>
              <th>Confidence</th>
              <th>Time basis</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {d.records.map((r) => (
              <tr key={r.entryId} className={r.overlapsRequestedInterval ? "" : "text-muted"}>
                <td>
                  {r.orderable ? r.validText || dayMonthYear(r.validStart as string) : `no orderable time${r.validText ? ` (“${r.validText}”)` : ""}`}
                  {r.approximate ? <span className="text-muted"> · approximate</span> : null}
                  {r.validKind === "range" ? <span className="text-muted"> · stated period</span> : null}
                  {!r.overlapsRequestedInterval && r.orderable ? <span className="text-muted"> · outside the interval</span> : null}
                </td>
                <td className="tabular-nums">{formatValue(r.value, d.unit)}</td>
                <td>
                  <SourceBadge sourceType={r.sourceType} />
                </td>
                <td>{r.confidence === null ? <span className="text-xs text-muted">not assessed</span> : <ConfidenceBadge confidence={r.confidence} />}</td>
                <td>{r.validBasis === "recorded" ? "known from its recording forward" : "as stated"}</td>
                <td className="tabular-nums">{dayMonthYear(r.recordedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted">
        Resolves to {formatValue(d.atStart.value, d.unit)} at the start ({d.atStart.carriedForward ? "carried forward" : d.atStart.resolutionState.replace("_", " ")}) and {formatValue(d.atEnd.value, d.unit)} at the end (
        {d.atEnd.carriedForward ? "carried forward" : d.atEnd.resolutionState.replace("_", " ")}). Evidence facts:{" "}
        {Object.entries(d.facts)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ") || "none"}
        .
      </p>
    </div>
  );
}

/** The read-only look-closer card for a recurrence that is not an exact
 *  repetition (low variation, stated period): the same explanatory text as
 *  before, no hand-off, nothing written. */
function LookCloser({ item, description, onClose }: { item: DescribedVariable; description: IntervalDescription; onClose: () => void }) {
  const ctx = description.context.find((c) => c.variableId === item.description.variableId);
  const changedNames = (ctx?.variablesChanged ?? []).map((id) => description.variables.find((v) => v.description.variableId === id)?.description.name ?? id);
  return (
    <div className="mt-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-[15px] leading-relaxed" role="region" aria-label={`Look closer at ${item.description.name}`}>
      <p>{explorePatternText(item.description.facts, ctx ? { variablesChanged: ctx.variablesChanged.length, eventsInInterval: ctx.eventsInInterval } : undefined)}</p>
      {ctx && changedNames.length > 0 ? <p className="mt-2 text-sm text-muted">The other variables that changed: {changedNames.join(", ")}. That is context to examine, not a cause.</p> : null}
      <div className="mt-2 flex flex-wrap gap-4 text-sm">
        <Link href="/hypotheses" className="text-accent hover:underline">
          View hypotheses →
        </Link>
        <button type="button" className={TOGGLE} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function Row({ row, item, description, model }: { row: HistoryRow; item: DescribedVariable; description: IntervalDescription; model: SystemModel }) {
  const [open, setOpen] = useState(false);
  const [closer, setCloser] = useState(false);
  const d = item.description;
  const subject = d.subjectId === model.id ? null : subjectLabelFor(model, d.subjectId);
  const canLookCloser = row.question === "recurring" && row.lens !== "repeated";
  return (
    <li className="py-4" data-history-row={row.lens} data-variable={row.variableId}>
      {row.tag ? <p className="text-sm text-muted">{row.tag}</p> : null}
      <p className="text-[15px] leading-relaxed">
        {row.text}
        {subject ? <span className="text-sm text-muted"> · {subject}</span> : null}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {row.lens === "repeated" ? (
          row.exploreHref ? (
            <Link href={row.exploreHref} className={ACTION} data-testid="explore-pattern" aria-label={`Explore what was happening with ${d.name}`}>
              Explore what was happening →
            </Link>
          ) : (
            <span className="text-sm text-muted" title="Assign this record to a subject before exploring its surrounding context.">
              Assign this record to someone to explore it
            </span>
          )
        ) : null}
        {canLookCloser ? (
          <button type="button" className={TOGGLE} aria-expanded={closer} onClick={() => setCloser((x) => !x)}>
            Look closer
          </button>
        ) : null}
        <button type="button" className={TOGGLE} aria-expanded={open} aria-label={`${open ? "Hide details" : "Details"} for ${d.name}`} onClick={() => setOpen((x) => !x)}>
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      {closer ? <LookCloser item={item} description={description} onClose={() => setCloser(false)} /> : null}
      {open ? <Details item={item} lens={row.lens} /> : null}
    </li>
  );
}

/** One distinction inside "What still needs more information?": above the
 *  threshold it reads as one sentence until the person asks for the rows. */
function Group({ group, description, model }: { group: RowGroup; description: IntervalDescription; model: SystemModel }) {
  const [open, setOpen] = useState(!group.collapsed);
  const byId = new Map(description.variables.map((v) => [v.description.variableId, v]));
  if (!open) {
    return (
      <li className="py-4" data-history-group={group.tag} data-collapsed="true">
        <p className="text-sm text-muted">{group.tag}</p>
        <p className="text-[15px] leading-relaxed">{group.summary}</p>
        <button type="button" className={`mt-1.5 ${TOGGLE}`} aria-expanded={false} onClick={() => setOpen(true)} data-testid="show-group">
          Show all {group.rows.length}
        </button>
      </li>
    );
  }
  return (
    <>
      {group.rows.map((row) => {
        const item = byId.get(row.variableId);
        return item ? <Row key={row.key} row={row} item={item} description={description} model={model} /> : null;
      })}
      {group.collapsed ? (
        <li className="py-2" data-history-group={group.tag} data-collapsed="false">
          <button type="button" className={TOGGLE} aria-expanded={true} onClick={() => setOpen(false)}>
            Show fewer
          </button>
        </li>
      ) : null}
    </>
  );
}

function Question({ title, rows, empty, description, model, children, groups = [] }: { title: string; rows: HistoryRow[]; empty: string; description: IntervalDescription; model: SystemModel; children?: React.ReactNode; groups?: RowGroup[] }) {
  const byId = new Map(description.variables.map((v) => [v.description.variableId, v]));
  return (
    <section data-history-question={title}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {rows.length === 0 && groups.length === 0 && !children ? (
        <p className="mt-2 text-[15px] text-muted">{empty}</p>
      ) : (
        <ul className="mt-1 divide-y divide-border/70">
          {groups.map((g) => (
            <Group key={g.tag} group={g} description={description} model={model} />
          ))}
          {rows.map((row) => {
            const item = byId.get(row.variableId);
            return item ? <Row key={row.key} row={row} item={item} description={description} model={model} /> : null;
          })}
          {children}
        </ul>
      )}
    </section>
  );
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A URL date is used only when it is a strict calendar date; anything else falls back to the default. */
function urlDate(v: string | null): string | null {
  if (!v || !DATE_ONLY.test(v)) return null;
  try {
    normalizeIntervalStart(v);
    return v;
  } catch {
    return null;
  }
}

function HistoryInner() {
  const { status, model, evaluated, error, asOf } = useModel();
  const ids = useId();
  const params = useSearchParams();
  // initial state from the URL (Home and Explore return here with a period); malformed values fall back
  const [fromInput, setFrom] = useState<string | null>(() => urlDate(params.get("from")));
  const [toInput, setTo] = useState<string | null>(() => urlDate(params.get("to")));
  const [subjectInput, setSubject] = useState<string | null>(() => params.get("subject"));
  const [convention, setConvention] = useState(true);
  const [includeDerived, setIncludeDerived] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [caveatsOpen, setCaveatsOpen] = useState(false);

  const earliest = useMemo(() => (model ? earliestRecordedDate(model) : null), [model]);
  const today = todayIso();
  // while "Values as of" is set, the records shown end at that date too (6F: the as-of strip means the same thing on every screen; Home counts patterns the same way)
  const defaultTo = asOf ? asOf.slice(0, 10) : today;
  const from = fromInput ?? earliest ?? defaultTo;
  const to = toInput ?? defaultTo;
  // a URL subject is honoured only when it names the system or an existing subject
  const subject = subjectInput !== null && model && (subjectInput === model.id || model.profile.members.some((m) => m.id === subjectInput)) ? subjectInput : ALL;

  const result = useMemo<{ ok: true; description: IntervalDescription } | { ok: false; error: string } | null>(() => {
    if (!model) return null;
    try {
      const description = describeInterval(model, {
        from,
        to,
        ...(subject !== ALL ? { subjectId: subject } : {}),
        includeDerived,
        ...(convention ? { lowVariation: A23 } : {}),
        now: new Date().toISOString(),
      });
      return { ok: true, description };
    } catch (e) {
      if (e instanceof DiscoveryError) return { ok: false, error: e.message };
      throw e;
    }
  }, [model, from, to, subject, includeDerived, convention]);

  if (status === "error") return <Note tone="warn">Could not load the model: {error}</Note>;
  if (status === "loading" || !model || !evaluated || !result) return <Loading />;
  const subjects = subjectsOf(model, { includeArchived: true });
  const whose = subject === ALL ? "Everyone" : subject === model.id ? "The whole system" : (subjectLabelFor(model, subject) ?? subject);

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">History</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">What your records show over a period. Every line describes records; none names a cause.</p>
        <p className="mt-4 text-[15px]">
          <span className="font-medium">
            {monthName(from)} → {monthName(to)}
          </span>
          <span className="text-muted"> · {whose}</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" className={TOGGLE} aria-expanded={periodOpen} onClick={() => setPeriodOpen((x) => !x)} data-testid="change-period">
            {periodOpen ? "Done" : "Change period"}
          </button>
          <button type="button" className={TOGGLE} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((x) => !x)} data-testid="advanced">
            {advancedOpen ? "Hide advanced" : "Advanced"}
          </button>
        </div>
        {periodOpen ? (
          <div className="mt-3 flex flex-wrap items-end gap-4 rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm" data-testid="period-controls">
            <div>
              <label htmlFor={`${ids}-from`} className="block text-muted">
                From
              </label>
              <input id={`${ids}-from`} type="date" max={today} value={from} onChange={(e) => setFrom(e.target.value || null)} />
            </div>
            <div>
              <label htmlFor={`${ids}-to`} className="block text-muted">
                To
              </label>
              <input id={`${ids}-to`} type="date" max={today} value={to} onChange={(e) => setTo(e.target.value || null)} />
            </div>
            <div>
              <label htmlFor={`${ids}-subject`} className="block text-muted">
                Whose records
              </label>
              <select id={`${ids}-subject`} value={subject} onChange={(e) => setSubject(e.target.value || null)}>
                <option value={ALL}>Everyone</option>
                <option value={model.id}>The whole system ({model.profile.name})</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.status === "archived" ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </div>
            {earliest === null ? <p className="w-full text-muted">No dated values are recorded yet; the period starts today.</p> : null}
          </div>
        ) : null}
        {advancedOpen ? (
          <div className="mt-3 space-y-2 rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm" data-testid="advanced-controls">
            {result.ok ? (
              <p className="text-muted" data-testid="period-counts">
                In this period: {periodSummary(result.description)}.
              </p>
            ) : null}
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={convention} onChange={(e) => setConvention(e.target.checked)} />
              <span>
                Show values that stayed close <span className="text-muted">(display convention A23: within 10% of a variable&apos;s reference range; a convention over the recorded values, not persistence)</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={includeDerived} onChange={(e) => setIncludeDerived(e.target.checked)} />
              <span>
                Include calculated values <span className="text-muted">(recomputed at both ends of the period under today&apos;s structure; not recorded values)</span>
              </span>
            </label>
          </div>
        ) : null}
      </header>

      {!result.ok ? <Note tone="warn">{result.error}</Note> : <HistoryBody description={result.description} model={model} advancedOpen={advancedOpen} caveatsOpen={caveatsOpen} onToggleCaveats={() => setCaveatsOpen((x) => !x)} />}
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<Loading />}>
      <HistoryInner />
    </Suspense>
  );
}

function HistoryBody({ description, model, advancedOpen, caveatsOpen, onToggleCaveats }: { description: IntervalDescription; model: SystemModel; advancedOpen: boolean; caveatsOpen: boolean; onToggleCaveats: () => void }) {
  const d = description;
  const q = historyQuestions(d);
  const events = d.events.inInterval;
  return (
    <div className="space-y-10">
      <Question title="What changed?" rows={q.changed} empty="No recorded value differs and no event was recorded in this period." description={d} model={model}>
        {events.length > 0
          ? events.map((e) => (
              <li key={e.id} className="py-4" data-history-row="event">
                <p className="text-sm text-muted">Event</p>
                <p className="text-[15px] leading-relaxed">
                  {e.title}
                  <span className="text-sm text-muted">
                    {" "}
                    · {eventWhen(e)}
                    {e.subjectId && e.subjectId !== model.id ? ` · ${subjectLabelFor(model, e.subjectId)}` : ""}
                  </span>
                </p>
              </li>
            ))
          : null}
      </Question>

      <Question title="What keeps showing up?" rows={q.recurring} empty="Nothing was recorded again in this period." description={d} model={model} />

      <Question title="What still needs more information?" rows={[]} empty="Every record in this period is dated and known." description={d} model={model} groups={needsInformationGroups(q.needsInformation)}>
        {d.events.unorderable.length > 0 ? (
          <li className="py-4" data-history-row="unorderable-events">
            <p className="text-sm text-muted">Events without a date</p>
            <p className="text-[15px] leading-relaxed">
              {d.events.unorderable.length === 1 ? "One event has" : `${d.events.unorderable.length} events have`} no orderable time and could not be placed: {d.events.unorderable.map((e) => e.title).join(", ")}.
            </p>
          </li>
        ) : null}
      </Question>

      {advancedOpen && d.recomputed.length > 0 ? (
        <section data-history-question="Calculated values">
          <h2 className="text-lg font-semibold tracking-tight">Calculated values, recomputed</h2>
          <p className="mt-1 text-sm text-muted">{d.recomputed[0].caveat}</p>
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Variable</th>
                <th>At start</th>
                <th>At end</th>
                <th>Differs</th>
              </tr>
            </thead>
            <tbody>
              {d.recomputed.map((r) => (
                <tr key={r.variableId}>
                  <td>
                    {r.name}
                    {r.subjectId && r.subjectId !== model.id ? <span className="text-sm text-muted"> · {subjectLabelFor(model, r.subjectId)}</span> : null}
                  </td>
                  <td className="tabular-nums">{formatValue(r.atStart, r.unit)}</td>
                  <td className="tabular-nums">{formatValue(r.atEnd, r.unit)}</td>
                  <td>{r.differs === null ? "unknown" : r.differs ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {advancedOpen && d.snapshots ? (
        <section data-history-question="Saved snapshots">
          <h2 className="text-lg font-semibold tracking-tight">Saved snapshots in this period ({d.snapshots.snapshotsTotal})</h2>
          <p className="mt-1 text-sm text-muted">Moments the person chose to save. Counts are over saved snapshots only; nothing is known about the time between them.</p>
          <ul className="mt-2 space-y-1 text-[15px]">
            {d.snapshots.dimensions.map((x) => (
              <li key={x.dimensionId}>{x.statement}</li>
            ))}
            {d.snapshots.relationships.map((x) => (
              <li key={x.key} className="text-muted">
                {x.statement}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="space-y-2 text-sm text-muted">
        <p>{CAUSATION_DISCLAIMER}</p>
        {d.caveats.length > 0 ? (
          <div>
            <button type="button" className={TOGGLE} aria-expanded={caveatsOpen} onClick={onToggleCaveats} data-testid="caveats">
              {caveatsOpen ? "Hide" : `About this period (${d.caveats.length})`}
            </button>
            {caveatsOpen ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {d.caveats.map((c) => (
                  <li key={c.code}>{c.text}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </footer>
    </div>
  );
}
