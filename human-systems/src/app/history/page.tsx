"use client";
/**
 * HISTORY — what the records show between two dates. The first structural
 * discovery surface: What changed? What repeated or stayed similar in the
 * records? What is only a carried-forward value? What has too little
 * history? What is unknown? Every line comes from the deterministic
 * discovery layer (src/discovery) and describes RECORDS; nothing here
 * names a cause, ranks anything, or writes to the model. "Explore this
 * pattern" opens an explanatory card only.
 */
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { temporalInterval } from "@/calculations/time";
import { useModel } from "@/components/model-provider";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import {
  CAUSATION_DISCLAIMER,
  DiscoveryError,
  dayMonthYear,
  describeInterval,
  explorePatternText,
  formatValue,
  historySentenceFor,
  monthYear,
  normalizeIntervalStart,
  type DescribedVariable,
  type HistoryLens,
  type IntervalDescription,
} from "@/discovery";
import { subjectLabelPluralOf } from "@/model/domain";
import { subjectLabelFor, subjectsOf } from "@/model/subjects";
import type { SystemModel } from "@/types";

const A23 = { assumptionId: "A23" as const, tolerance: 0.1 };
const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50";
const ALL = "";

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

function ExploreCard({ item, description, onClose }: { item: DescribedVariable; description: IntervalDescription; onClose: () => void }) {
  const ctx = description.context.find((c) => c.variableId === item.description.variableId);
  const changedNames = (ctx?.variablesChanged ?? []).map((id) => description.variables.find((v) => v.description.variableId === id)?.description.name ?? id);
  return (
    <div className="mt-2 rounded-md border border-accent bg-accent-soft px-3 py-2 text-sm" role="region" aria-label={`Explore ${item.description.name}`}>
      <p>{explorePatternText(item.description.facts, ctx ? { variablesChanged: ctx.variablesChanged.length, eventsInInterval: ctx.eventsInInterval } : undefined)}</p>
      {ctx && changedNames.length > 0 ? <p className="text-xs text-muted mt-2">The other variables that changed: {changedNames.join(", ")}. That is context to examine, not a cause.</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Link href="/hypotheses" className={BTN}>
          View hypotheses
        </Link>
        <button type="button" className={BTN} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="text-xs text-muted mt-2">Nothing is created from here; proposing a hypothesis is a later, explicit step.</p>
    </div>
  );
}

function RecordRow({ item, lens, description, model, explorable = false }: { item: DescribedVariable; lens: HistoryLens; description: IntervalDescription; model: SystemModel; explorable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [explore, setExplore] = useState(false);
  const d = item.description;
  // the SECTION decides the lens; the description is the same object everywhere
  const sentences = historySentenceFor(d, lens);
  const subject = d.subjectId === model.id ? null : subjectLabelFor(model, d.subjectId);
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm">
          {sentences.headline}
          {subject ? <span className="text-xs text-muted"> · {subject}</span> : null}
        </p>
        <span className="flex gap-1.5">
          {explorable ? (
            <button type="button" className={BTN} aria-expanded={explore} onClick={() => setExplore((x) => !x)}>
              Explore this pattern
            </button>
          ) : null}
          <button type="button" className={BTN} aria-expanded={open} onClick={() => setOpen((x) => !x)}>
            {open ? "Hide details" : "Details"}
          </button>
        </span>
      </div>
      {explore ? <ExploreCard item={item} description={description} onClose={() => setExplore(false)} /> : null}
      {open ? (
        <div className="mt-2 space-y-2 text-xs">
          {sentences.details.length > 0 ? (
            <ul className="list-disc pl-5 text-muted space-y-0.5">
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
                      {r.orderable ? (r.validText || dayMonthYear(r.validStart as string)) : `no orderable time${r.validText ? ` (“${r.validText}”)` : ""}`}
                      {r.approximate ? <span className="text-muted"> · approximate</span> : null}
                      {r.validKind === "range" ? <span className="text-muted"> · stated period</span> : null}
                      {!r.overlapsRequestedInterval && r.orderable ? <span className="text-muted"> · outside the interval</span> : null}
                    </td>
                    <td className="tabular-nums">{formatValue(r.value, d.unit)}</td>
                    <td>
                      <SourceBadge sourceType={r.sourceType} />
                    </td>
                    <td>
                      <ConfidenceBadge confidence={r.confidence} />
                    </td>
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
      ) : null}
    </li>
  );
}

/** One row per (variable, lens): a variable qualifying by two facts shows one sentence per fact. */
function Section({ title, hint, entries, description, model, explorable = false }: { title: string; hint: string; entries: { item: DescribedVariable; lens: HistoryLens }[]; description: IntervalDescription; model: SystemModel; explorable?: boolean }) {
  return (
    <Card title={`${title} (${entries.length})`}>
      <p className="text-xs text-muted mb-2">{hint}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">Nothing in this group for the chosen period.</p>
      ) : (
        <ul className="-mx-4 divide-y divide-border border-t border-border">
          {entries.map(({ item, lens }) => (
            <RecordRow key={`${item.description.variableId}:${lens}`} item={item} lens={lens} description={description} model={model} explorable={explorable} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function HistoryPage() {
  const { status, model, evaluated, error } = useModel();
  const ids = useId();
  const [fromInput, setFrom] = useState<string | null>(null);
  const [toInput, setTo] = useState<string | null>(null);
  const [subject, setSubject] = useState<string>(ALL);
  const [convention, setConvention] = useState(true);
  const [includeDerived, setIncludeDerived] = useState(false);

  const earliest = useMemo(() => (model ? earliestRecordedDate(model) : null), [model]);
  const today = todayIso();
  const from = fromInput ?? earliest ?? today;
  const to = toInput ?? today;

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
  const { domain } = evaluated;
  const subjects = subjectsOf(model, { includeArchived: true });

  return (
    <div>
      <PageHeader title="History" lede="What the records show between two dates: what changed, what was recorded again, what is only an old value still standing, and what is not known. Every line describes records; none names a cause." />

      <Card title="Period">
        <div className="flex flex-wrap items-end gap-3 text-xs">
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
            <select id={`${ids}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value={ALL}>Everything</option>
              <option value={model.id}>The whole system ({model.profile.name})</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.status === "archived" ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={convention} onChange={(e) => setConvention(e.target.checked)} />
            Show low variation (display convention A23: within 10% of a variable&apos;s reference range)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={includeDerived} onChange={(e) => setIncludeDerived(e.target.checked)} />
            Include calculated values (recomputed under today&apos;s structure)
          </label>
        </div>
        {earliest === null ? <p className="text-xs text-muted mt-2">No dated values are recorded yet; the period starts today.</p> : null}
      </Card>

      {!result.ok ? (
        <div className="mt-4">
          <Note tone="warn">{result.error}</Note>
        </div>
      ) : (
        <HistoryBody description={result.description} model={model} subjectPlural={subjectLabelPluralOf(domain)} />
      )}
    </div>
  );
}

function HistoryBody({ description, model, subjectPlural }: { description: IntervalDescription; model: SystemModel; subjectPlural: string }) {
  const d = description;
  const datedRecords = d.variables.reduce((n, v) => n + v.description.knownRecordCount, 0);
  // one entry per fact: a variable that repeated AND stayed within A23 gets one sentence per lens
  const similar: { item: DescribedVariable; lens: HistoryLens }[] = [
    ...d.buckets.repeated.map((item) => ({ item, lens: "repeated" as const })),
    ...d.buckets.lowVariation.map((item) => ({ item, lens: "low_variation" as const })),
    ...d.buckets.explicitClaims.map((item) => ({ item, lens: "explicit_claim" as const })),
  ];
  const withLens = (items: DescribedVariable[], lens: HistoryLens) => items.map((item) => ({ item, lens }));
  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm">
        <span className="font-medium">
          {monthYear(d.interval.from)} → {monthYear(d.interval.to)}
        </span>
        <span className="text-muted">
          {" "}
          · {d.variables.length} recorded variable{d.variables.length === 1 ? "" : "s"}, {datedRecords} dated value{datedRecords === 1 ? "" : "s"}, {d.events.inInterval.length} event
          {d.events.inInterval.length === 1 ? "" : "s"} in this period{d.subjectId ? "" : ` · all ${subjectPlural.toLowerCase()} and the whole system`}
        </span>
      </p>

      <Card title={`What changed (${d.buckets.changed.length + d.events.inInterval.length})`}>
        <p className="text-xs text-muted mb-2">Variables whose recorded values differ within the period, and the events recorded in it. How much they differ is shown raw unless a reference range exists. A variable can appear here and under &ldquo;repeated&rdquo; at once: values can change and one of them can still be recorded again.</p>
        {d.buckets.changed.length === 0 && d.events.inInterval.length === 0 ? (
          <p className="text-sm text-muted">No recorded value differs and no event is recorded in this period.</p>
        ) : (
          <ul className="-mx-4 divide-y divide-border border-t border-border">
            {d.buckets.changed.map((item) => (
              <RecordRow key={item.description.variableId} item={item} lens="changed" description={d} model={model} />
            ))}
            {d.events.inInterval.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                Event: {e.title} <span className="text-xs text-muted">· {e.kind} · {e.occurredText}{e.subjectId ? ` · ${subjectLabelFor(model, e.subjectId)}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
        {d.events.unorderable.length > 0 ? (
          <p className="text-xs text-muted mt-2">
            {d.events.unorderable.length} event{d.events.unorderable.length > 1 ? "s have" : " has"} no orderable time and could not be placed: {d.events.unorderable.map((e) => e.title).join(", ")}.
          </p>
        ) : null}
      </Card>

      <Section
        title="What repeated or stayed similar in the records"
        hint="The same value recorded on more than one date, values within the low-variation display convention, or a period the person stated explicitly. These are facts about the records and can overlap with &ldquo;what changed&rdquo;. A repeated record does not show that the value held in between."
        entries={similar}
        description={d}
        model={model}
        explorable
      />
      <Section title="Only an old value still standing" hint="Nothing was recorded in this period; the last recorded value still resolves because nothing replaced it. That is the model's state, not an observation made in the period." entries={withLens(d.buckets.lastKnownOnly, "last_known_only")} description={d} model={model} />
      <Section title="Not enough history" hint="At most one dated value in this period; nothing can be said about repetition." entries={withLens(d.buckets.insufficient, "insufficient")} description={d} model={model} />
      <Section title="Unknown" hint="Recorded as unknown, recorded twice for the same time with different values, or recorded without an orderable time." entries={withLens(d.buckets.unresolved, "unresolved")} description={d} model={model} />

      {d.recomputed.length > 0 ? (
        <Card title={`Calculated values, recomputed (${d.recomputed.length})`}>
          <Note tone="warn">{d.recomputed[0].caveat}</Note>
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
                    {r.subjectId && r.subjectId !== model.id ? <span className="text-xs text-muted"> · {subjectLabelFor(model, r.subjectId)}</span> : null}
                  </td>
                  <td className="tabular-nums">{formatValue(r.atStart, r.unit)}</td>
                  <td className="tabular-nums">{formatValue(r.atEnd, r.unit)}</td>
                  <td>{r.differs === null ? "unknown" : r.differs ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {d.snapshots ? (
        <Card title={`Saved snapshots in this period (${d.snapshots.snapshotsTotal})`}>
          <p className="text-xs text-muted mb-2">Moments the person chose to save. Counts are over saved snapshots only; nothing is known about the time between them.</p>
          <ul className="text-sm space-y-1">
            {d.snapshots.dimensions.map((x) => (
              <li key={x.dimensionId}>{x.statement}</li>
            ))}
            {d.snapshots.relationships.map((x) => (
              <li key={x.key} className="text-muted">
                {x.statement}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="space-y-1">
        <Note>{CAUSATION_DISCLAIMER}</Note>
        {d.caveats.map((c) => (
          <Note key={c.code}>{c.text}</Note>
        ))}
      </div>
    </div>
  );
}
