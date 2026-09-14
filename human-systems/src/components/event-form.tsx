"use client";
/**
 * Create/edit form for ONE event (shock, change, intervention, outcome or
 * decision). It holds a local draft and hands back plain values on submit;
 * the page turns them into a mutation (services/mutations addEvent /
 * updateEvent). Display and input only: no model logic lives here.
 *
 * An event is a dated fact, never a numeric variable. An intervention may
 * state what it is EXPECTED to move; that expectation is the person's,
 * recorded so the outcome can later be compared with it.
 */
import { useId, useState, type ReactNode } from "react";
import { NumberField } from "@/components/fields";
import { fmtConfidence } from "@/components/format";
import { TemporalField, emptyTemporal, temporalProblem } from "@/components/temporal-field";
import { SOURCE_TYPE_META, confidenceLabel } from "@/domain/vocabulary";
import {
  EventKindSchema,
  InterventionStatusSchema,
  SourceTypeSchema,
  type Event,
  type EventKind,
  type Member,
  type SourceType,
  type TemporalRef,
  type Variable,
} from "@/types";

export type InterventionStatus = Event["status"] & string;
export type ExpectedEffect = { variableId: string; direction: "up" | "down" };

/** What the form hands back; the page passes it to a mutation. */
export interface EventFormValues {
  kind: EventKind;
  type: string;
  title: string;
  description: string;
  occurred: TemporalRef;
  /** A member id, the system id (whole system) or null (unassigned). */
  subjectId: string | null;
  sourceType: SourceType;
  confidence: number;
  /** Interventions only; undefined otherwise. */
  status: InterventionStatus | undefined;
  /** Interventions only; empty otherwise. */
  expected: ExpectedEffect[];
  notes: string;
}

export const EVENT_KIND_META: Record<EventKind, { label: string; description: string }> = {
  shock: { label: "shock", description: "something external that hit the system" },
  change: { label: "change", description: "a change in circumstances, not chosen as an intervention" },
  intervention: { label: "intervention", description: "something tried on purpose, with an expected effect" },
  outcome: { label: "outcome", description: "what followed; compared later with what was expected" },
  decision: { label: "decision", description: "a choice made, recorded as a dated fact" },
};

export const INTERVENTION_STATUS_META: Record<InterventionStatus, string> = {
  planned: "planned",
  in_progress: "in progress",
  done: "done",
  abandoned: "abandoned",
};

const SOURCE_TYPES: readonly SourceType[] = SourceTypeSchema.options;
const EVENT_KINDS: readonly EventKind[] = EventKindSchema.options;
const INTERVENTION_STATUSES: readonly InterventionStatus[] = InterventionStatusSchema.options;

/** The "other" choice in the type select: the person types the vocabulary word. */
const OTHER_TYPE = "__other__";
/** The "unassigned" choice in the subject select (stored as null). */
const UNASSIGNED = "__unassigned__";

interface Draft {
  kind: EventKind;
  typeChoice: string;
  typeText: string;
  title: string;
  description: string;
  occurred: TemporalRef;
  subjectId: string | null;
  sourceType: SourceType;
  confidence: number;
  status: InterventionStatus;
  expected: ExpectedEffect[];
  notes: string;
}

function draftFrom(initial: Event | undefined, eventTypes: readonly string[]): Draft {
  const type = initial?.type ?? "";
  const listed = type !== "" && eventTypes.includes(type);
  return {
    kind: initial?.kind ?? "change",
    typeChoice: initial ? (listed ? type : OTHER_TYPE) : (eventTypes[0] ?? OTHER_TYPE),
    typeText: listed ? "" : type,
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    occurred: initial?.occurred ?? emptyTemporal(""),
    subjectId: initial?.subjectId ?? null,
    sourceType: initial?.sourceType ?? "self_reported",
    confidence: initial?.confidence ?? 0.5,
    status: initial?.status ?? "planned",
    expected: initial?.expected.map((x) => ({ variableId: x.variableId, direction: x.direction })) ?? [],
    notes: initial?.notes ?? "",
  };
}

/** Display label for a subject id: member label (archived marked), whole system, or unassigned. */
export function eventSubjectLabel(subjectId: string | null, members: readonly Member[], systemId: string): string {
  if (subjectId === null) return "unassigned";
  if (subjectId === systemId) return "whole system";
  const m = members.find((x) => x.id === subjectId);
  if (!m) return `unknown subject (${subjectId})`;
  return m.status === "archived" ? `${m.label} (archived)` : m.label;
}

const PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SECONDARY = "rounded border border-border px-3 py-1.5 text-sm hover:bg-background disabled:opacity-50";
const SMALL = "rounded border border-border bg-background px-2 py-1 text-xs hover:border-accent disabled:opacity-50";

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 md:grid-cols-[11rem_1fr] md:gap-3">
      <div className="pt-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-muted">
            {label}
          </label>
        ) : (
          <span className="text-muted">{label}</span>
        )}
        {hint ? <div className="text-xs text-muted">{hint}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EventForm({
  initial,
  eventTypes,
  members,
  systemId,
  variables,
  onSubmit,
  onCancel,
  error = null,
  onEdit,
}: {
  /** The event being edited; absent when creating. */
  initial?: Event;
  /** Domain vocabulary for `type` (evaluated.domain.eventTypes). */
  eventTypes: readonly string[];
  /** Members from model.profile.members, archived included. */
  members: readonly Member[];
  /** model.id: the subject id meaning "whole system". */
  systemId: string;
  /** Variables an intervention may expect to move (evaluated.variables). */
  variables: readonly Variable[];
  onSubmit: (values: EventFormValues) => void;
  onCancel: () => void;
  /** Refusal from the last apply, shown next to the submit control. */
  error?: string | null;
  /** Called whenever the person edits a field, so a stale refusal can be cleared. */
  onEdit?: () => void;
}) {
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial, eventTypes));
  const [localError, setLocalError] = useState<string | null>(null);
  const [pick, setPick] = useState<ExpectedEffect>({ variableId: "", direction: "up" });

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setLocalError(null);
    onEdit?.();
  };

  const sortedVariables = [...variables].sort((a, b) => a.name.localeCompare(b.name));
  const variableName = (id: string) => variables.find((v) => v.id === id)?.name ?? `${id} (no longer stored)`;
  const isIntervention = draft.kind === "intervention";
  const subjectValue = draft.subjectId === null ? UNASSIGNED : draft.subjectId;
  const subjectKnown = draft.subjectId === null || draft.subjectId === systemId || members.some((m) => m.id === draft.subjectId);

  const addExpected = () => {
    if (!pick.variableId) return;
    if (draft.expected.some((x) => x.variableId === pick.variableId)) {
      setLocalError("That variable is already in the expected list; remove it first to change its direction.");
      return;
    }
    update({ expected: [...draft.expected, pick] });
    setPick({ variableId: "", direction: "up" });
  };

  const submit = () => {
    const title = draft.title.trim();
    if (!title) {
      setLocalError("An event needs a title.");
      return;
    }
    const type = (draft.typeChoice === OTHER_TYPE ? draft.typeText : draft.typeChoice).trim();
    if (!type) {
      setLocalError("An event needs a type: pick one from the list or write one.");
      return;
    }
    const timeProblem = temporalProblem(draft.occurred);
    if (timeProblem) {
      setLocalError(`When it occurred: ${timeProblem}`);
      return;
    }
    if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
      setLocalError("Confidence must be between 0 and 1.");
      return;
    }
    setLocalError(null);
    onSubmit({
      kind: draft.kind,
      type,
      title,
      description: draft.description.trim(),
      occurred: { ...draft.occurred, text: draft.occurred.text.trim() },
      subjectId: draft.subjectId,
      sourceType: draft.sourceType,
      confidence: draft.confidence,
      status: isIntervention ? draft.status : undefined,
      expected: isIntervention ? draft.expected : [],
      notes: draft.notes.trim(),
    });
  };

  const shownError = localError ?? error;

  return (
    <div className="space-y-4 text-sm">
      <Field label="Kind" hint={EVENT_KIND_META[draft.kind].description}>
        <div className="flex flex-col gap-1">
          {EVENT_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="radio" name={`${ids}-kind`} checked={draft.kind === k} onChange={() => update({ kind: k })} />
              <span className="font-medium">{EVENT_KIND_META[k].label}</span>
              <span className="text-muted">— {EVENT_KIND_META[k].description}</span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="Type" htmlFor={`${ids}-type`} hint="The domain's vocabulary for this event, or your own word.">
        <div className="flex flex-wrap items-center gap-2">
          <select id={`${ids}-type`} className="max-w-md" value={draft.typeChoice} onChange={(e) => update({ typeChoice: e.target.value })}>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value={OTHER_TYPE}>other…</option>
          </select>
          {draft.typeChoice === OTHER_TYPE ? (
            <input
              type="text"
              aria-label="Type, in your own words"
              className="max-w-xs"
              placeholder="e.g. lease_renewed"
              value={draft.typeText}
              onChange={(e) => update({ typeText: e.target.value })}
            />
          ) : null}
        </div>
      </Field>

      <Field label="Title" htmlFor={`${ids}-title`}>
        <input id={`${ids}-title`} type="text" required className="w-full max-w-xl" value={draft.title} onChange={(e) => update({ title: e.target.value })} />
      </Field>

      <Field label="Description" htmlFor={`${ids}-description`} hint="What happened, as a fact. Interpretation belongs to a hypothesis.">
        <textarea
          id={`${ids}-description`}
          className="w-full max-w-xl"
          rows={3}
          value={draft.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </Field>

      <Field label="When it occurred">
        <TemporalField value={draft.occurred} onChange={(occurred) => update({ occurred })} label="When it occurred" />
      </Field>

      <Field label="Subject" htmlFor={`${ids}-subject`} hint="Who or what it concerns. Unassigned means nobody has said yet.">
        <select
          id={`${ids}-subject`}
          className="w-full max-w-md"
          value={subjectValue}
          onChange={(e) => update({ subjectId: e.target.value === UNASSIGNED ? null : e.target.value })}
        >
          <option value={systemId}>whole system</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.role ? ` — ${m.role}` : ""}
              {m.status === "archived" ? " (archived)" : ""}
            </option>
          ))}
          <option value={UNASSIGNED}>unassigned</option>
          {!subjectKnown && draft.subjectId ? <option value={draft.subjectId}>unknown subject ({draft.subjectId})</option> : null}
        </select>
      </Field>

      <Field label="Source type" htmlFor={`${ids}-source`} hint={SOURCE_TYPE_META[draft.sourceType].description}>
        <select
          id={`${ids}-source`}
          className="w-full max-w-md"
          value={draft.sourceType}
          onChange={(e) => update({ sourceType: e.target.value as SourceType })}
        >
          {SOURCE_TYPES.map((s) => (
            <option key={s} value={s} title={SOURCE_TYPE_META[s].description}>
              {SOURCE_TYPE_META[s].label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Confidence" htmlFor={`${ids}-confidence`} hint="How sure the record is that this happened as written (0–1).">
        <div className="flex flex-wrap items-center gap-3">
          <input
            id={`${ids}-confidence`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.confidence}
            onChange={(e) => update({ confidence: Number(e.target.value) })}
          />
          <NumberField
            value={draft.confidence}
            min={0}
            max={1}
            step={0.05}
            className="w-20"
            ariaLabel="Confidence as a number"
            onCommit={(n) => {
              if (n === null) return;
              if (n < 0 || n > 1) {
                setLocalError("Confidence must be between 0 and 1.");
                return;
              }
              update({ confidence: n });
            }}
          />
          <span className="tabular-nums">{fmtConfidence(draft.confidence)}</span>
          <span className="text-xs text-muted">{confidenceLabel(draft.confidence)}</span>
        </div>
      </Field>

      {isIntervention ? (
        <>
          <Field label="Status" htmlFor={`${ids}-status`} hint="Where the intervention stands.">
            <select id={`${ids}-status`} className="max-w-md" value={draft.status} onChange={(e) => update({ status: e.target.value as InterventionStatus })}>
              {INTERVENTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {INTERVENTION_STATUS_META[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Expected effects" hint="What this was expected to move, and which way. Your expectation, recorded so the outcome can be compared with it later.">
            {draft.expected.length === 0 ? (
              <p className="text-xs text-muted mb-2">No expected effect recorded yet.</p>
            ) : (
              <ul className="space-y-1 mb-2">
                {draft.expected.map((x) => (
                  <li key={x.variableId} className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1 text-xs">
                    <span className="flex-1">
                      {variableName(x.variableId)} <span className="text-muted">expected {x.direction}</span>
                    </span>
                    <button
                      type="button"
                      className="text-muted hover:text-neg"
                      aria-label={`Remove expected effect on ${variableName(x.variableId)}`}
                      onClick={() => update({ expected: draft.expected.filter((y) => y.variableId !== x.variableId) })}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {variables.length === 0 ? (
              <p className="text-xs text-muted">No variables recorded yet, so there is nothing to expect an effect on.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={`${ids}-expected-var`} className="sr-only">
                  Variable
                </label>
                <select
                  id={`${ids}-expected-var`}
                  className="max-w-xs"
                  value={pick.variableId}
                  onChange={(e) => setPick((p) => ({ ...p, variableId: e.target.value }))}
                >
                  <option value="">Select a variable…</option>
                  {sortedVariables.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.kind === "derived" ? " (calculated)" : ""}
                    </option>
                  ))}
                </select>
                <label htmlFor={`${ids}-expected-dir`} className="sr-only">
                  Direction
                </label>
                <select
                  id={`${ids}-expected-dir`}
                  value={pick.direction}
                  onChange={(e) => setPick((p) => ({ ...p, direction: e.target.value as "up" | "down" }))}
                >
                  <option value="up">up</option>
                  <option value="down">down</option>
                </select>
                <button type="button" className={SMALL} disabled={!pick.variableId} onClick={addExpected}>
                  Add expected effect
                </button>
              </div>
            )}
          </Field>
        </>
      ) : null}

      <Field label="Notes" htmlFor={`${ids}-notes`} hint="Context about the record itself.">
        <textarea id={`${ids}-notes`} className="w-full max-w-xl" rows={2} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
      </Field>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button type="button" className={PRIMARY} onClick={submit}>
          {initial ? "Save event" : "Add event"}
        </button>
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
        {shownError ? (
          <span className="text-xs text-neg" role="alert">
            {shownError}
          </span>
        ) : null}
      </div>
    </div>
  );
}
