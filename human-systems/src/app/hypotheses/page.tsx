"use client";
/**
 * Hypotheses: interpretations under review. Every loop the model detects is
 * presented here as a hypothesis (A18); "accepted" is a working reading the
 * person is willing to act on, never a proof. Observations are attached as
 * supporting or contradicting and are shown verbatim; they are never values.
 * Every change goes through useModel().apply with a pure mutation.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import { NumberField } from "@/components/fields";
import { fmtConfidence } from "@/components/format";
import { HypothesisStatusBadge, HYPOTHESIS_STATUS_META, draftLoopStatement, loopChain, loopLabel } from "@/components/loop-list";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge, Stat } from "@/components/ui";
import { confidenceLabel } from "@/domain/vocabulary";
import type { EvaluatedLoop } from "@/model/evaluate";
import * as mutations from "@/services/mutations";
import {
  HypothesisKindSchema,
  HypothesisStatusSchema,
  type Hypothesis,
  type HypothesisKind,
  type HypothesisReviewEntry,
  type HypothesisStatus,
  type KillCriterion,
  type Observation,
  type Relationship,
  type Variable,
} from "@/types";

type KillComparator = NonNullable<KillCriterion["comparator"]>;
type KillStatus = KillCriterion["status"];
type KillReading = "triggered" | "cleared" | "unknown";

/** What the add form hands the page for addKillCriterion. */
interface KillCriterionInput {
  statement: string;
  variableId?: string;
  comparator?: KillComparator;
  threshold?: number;
}

const COMPARATORS: { value: KillComparator; label: string }[] = [
  { value: "lt", label: "below (<)" },
  { value: "lte", label: "at or below (≤)" },
  { value: "gt", label: "above (>)" },
  { value: "gte", label: "at or above (≥)" },
];
const COMPARATOR_SIGN: Record<KillComparator, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥" };

const KILL_STATUS_ACTIONS: { status: KillStatus; label: string }[] = [
  { status: "triggered", label: "Mark triggered" },
  { status: "cleared", label: "Mark cleared" },
  { status: "open", label: "Reopen" },
];

const READING_TONE: Record<KillReading, string> = {
  triggered: "bg-warn-soft text-warn",
  cleared: "bg-desired-soft text-desired",
  unknown: "bg-background border border-border text-muted",
};

/** ISO timestamps read as "2026-09-14 10:32"; anything else is shown as stored. */
function fmtAt(at: string): string {
  if (!at) return "no time recorded";
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(at);
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : at;
}

/* ------------------------------------------------------------------ */
/* Display constants                                                   */
/* ------------------------------------------------------------------ */

const PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SECONDARY = "rounded border border-border px-3 py-1.5 text-sm hover:bg-background disabled:opacity-50";
const SMALL = "rounded border border-border bg-background px-2 py-1 text-xs hover:border-accent disabled:opacity-50";
const SMALL_PRESSED = "rounded border border-accent bg-accent-soft text-accent px-2 py-1 text-xs";

const KIND_META: Record<HypothesisKind, { label: string; description: string }> = {
  loop: { label: "loop", description: "about a feedback loop detected from the enabled relationships" },
  relationship: { label: "relationship", description: "about one or more directed relationships" },
  general: { label: "general", description: "a reading of the system not tied to one structure" },
};

const STATUS_ACTIONS: { status: HypothesisStatus; label: string }[] = [
  { status: "accepted", label: "Accept" },
  { status: "rejected", label: "Reject" },
  { status: "uncertain", label: "Mark uncertain" },
  { status: "proposed", label: "Reset to proposed" },
];

const STATUS_LEGEND = "Accepted = a working reading the person is willing to act on. It is not a proof.";

type Mode = { kind: "idle" } | { kind: "create" } | { kind: "edit"; id: string };

/** What the form hands back; the page turns it into a mutation. */
interface FormValues {
  statement: string;
  kind: HypothesisKind;
  loopId?: string;
  relationshipIds: string[];
  confidence: number;
  notes: string;
}

const nameOf = (variableById: ReadonlyMap<string, Variable>, id: string) => variableById.get(id)?.name ?? id;

function relationshipLabel(r: Relationship | undefined, id: string, variableById: ReadonlyMap<string, Variable>): string {
  if (!r) return `${id} (no longer stored)`;
  const base = `${nameOf(variableById, r.sourceVariableId)} → ${nameOf(variableById, r.targetVariableId)}`;
  return r.enabled ? base : `${base} (disabled)`;
}

function truncate(text: string, max = 96): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function KindBadge({ kind }: { kind: HypothesisKind }) {
  const meta = KIND_META[kind];
  return (
    <span title={meta.description} className="inline-block rounded px-1.5 py-0.5 text-xs bg-background border border-border">
      {meta.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit form                                                  */
/* ------------------------------------------------------------------ */

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 md:grid-cols-[10rem_1fr] md:gap-3">
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
      <div>{children}</div>
    </div>
  );
}

function HypothesisForm({
  initial,
  loops,
  relationships,
  variableById,
  loopHypothesisByLoopId,
  onSubmit,
  onCancel,
  error,
  onEdit,
}: {
  initial?: Hypothesis;
  loops: readonly EvaluatedLoop[];
  relationships: readonly Relationship[];
  variableById: ReadonlyMap<string, Variable>;
  /** Existing loop hypotheses, so the loop select can say which loops are taken. */
  loopHypothesisByLoopId: ReadonlyMap<string, Hypothesis>;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
  /** Refusal from the last apply, shown next to the submit control. */
  error: ReactNode;
  /** Called on every edit so a stale refusal can be cleared. */
  onEdit: () => void;
}) {
  const ids = useId();
  const [draft, setDraft] = useState<FormValues>(() => ({
    statement: initial?.statement ?? "",
    kind: initial?.kind ?? "general",
    loopId: initial?.loopId,
    relationshipIds: initial?.relationshipIds ?? [],
    confidence: initial?.confidence ?? 0.5,
    notes: initial?.notes ?? "",
  }));
  const [localError, setLocalError] = useState<string | null>(null);

  const update = (patch: Partial<FormValues>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setLocalError(null);
    onEdit();
  };

  const pickLoop = (loopId: string) => {
    const loop = loops.find((l) => l.id === loopId);
    update({ loopId: loopId || undefined, relationshipIds: loop ? [...loop.edgeIds] : draft.relationshipIds });
  };

  const submit = () => {
    const statement = draft.statement.trim();
    if (!statement) {
      setLocalError("A hypothesis needs a statement.");
      return;
    }
    if (draft.kind === "loop" && !draft.loopId) {
      setLocalError("Pick the detected loop this hypothesis is about.");
      return;
    }
    setLocalError(null);
    onSubmit({
      statement,
      kind: draft.kind,
      loopId: draft.kind === "loop" ? draft.loopId : undefined,
      relationshipIds: draft.relationshipIds,
      confidence: draft.confidence,
      notes: draft.notes.trim(),
    });
  };

  const loopStillFormed = draft.loopId ? loops.some((l) => l.id === draft.loopId) : true;

  return (
    <div className="space-y-4 text-sm">
      <Field label="Statement" htmlFor={`${ids}-statement`} hint="A reading of the system, phrased as something that could turn out otherwise.">
        <textarea id={`${ids}-statement`} className="w-full max-w-xl" rows={3} value={draft.statement} onChange={(e) => update({ statement: e.target.value })} />
      </Field>

      <Field label="Kind">
        <div className="flex flex-col gap-1">
          {HypothesisKindSchema.options.map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="radio" name={`${ids}-kind`} checked={draft.kind === k} onChange={() => update({ kind: k })} />
              <span className="font-medium">{KIND_META[k].label}</span>
              <span className="text-muted">— {KIND_META[k].description}</span>
            </label>
          ))}
        </div>
      </Field>

      {draft.kind === "loop" ? (
        <Field label="Detected loop" htmlFor={`${ids}-loop`} hint="Choosing a loop prefills the related relationships with its edges.">
          <select id={`${ids}-loop`} className="w-full max-w-xl" value={draft.loopId ?? ""} onChange={(e) => pickLoop(e.target.value)}>
            <option value="">Select a loop…</option>
            {loops.map((l) => {
              const taken = loopHypothesisByLoopId.get(l.id);
              const takenByOther = taken && taken.id !== initial?.id;
              return (
                <option key={l.id} value={l.id}>
                  {loopLabel(l, variableById)} ({l.polarity}
                  {takenByOther ? ", already has a hypothesis" : ""})
                </option>
              );
            })}
            {draft.loopId && !loopStillFormed ? (
              <option value={draft.loopId}>(no longer formed by the enabled relationships) {draft.loopId}</option>
            ) : null}
          </select>
          {draft.loopId && !loopStillFormed ? (
            <p className="text-xs text-muted mt-1">This loop is no longer formed by the enabled relationships; the hypothesis keeps its id.</p>
          ) : null}
          {loops.length === 0 ? <p className="text-xs text-muted mt-1">No loops are detected from the enabled relationships.</p> : null}
        </Field>
      ) : null}

      {draft.kind === "loop" || draft.kind === "relationship" ? (
        <Field
          label="Related relationships"
          htmlFor={`${ids}-relationships`}
          hint={draft.kind === "loop" ? "Prefilled from the loop's edges; adjust if needed." : "Hold Ctrl / Cmd to select several."}
        >
          <select
            id={`${ids}-relationships`}
            multiple
            size={Math.min(8, Math.max(3, relationships.length))}
            className="w-full max-w-xl"
            value={draft.relationshipIds}
            onChange={(e) => update({ relationshipIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}
          >
            {relationships.map((r) => (
              <option key={r.id} value={r.id}>
                {relationshipLabel(r, r.id, variableById)}
              </option>
            ))}
          </select>
          {relationships.length === 0 ? <p className="text-xs text-muted mt-1">No relationships stored yet.</p> : null}
        </Field>
      ) : null}

      <Field label="Confidence" htmlFor={`${ids}-confidence`} hint="How sure the person is of this reading.">
        <div className="flex items-center gap-3">
          <input
            id={`${ids}-confidence`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.confidence}
            onChange={(e) => update({ confidence: Number(e.target.value) })}
          />
          <span className="tabular-nums">{fmtConfidence(draft.confidence)}</span>
          <span className="text-xs text-muted">{confidenceLabel(draft.confidence)}</span>
        </div>
      </Field>

      <Field label="Notes" htmlFor={`${ids}-notes`}>
        <textarea id={`${ids}-notes`} className="w-full max-w-xl" rows={2} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" className={PRIMARY} onClick={submit}>
          {initial ? "Save changes" : "Add hypothesis"}
        </button>
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
        {localError ? <span className="text-xs text-neg">{localError}</span> : null}
        {error}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One hypothesis                                                      */
/* ------------------------------------------------------------------ */

function ObservationChips({
  ids,
  role,
  observationById,
  onDetach,
}: {
  ids: readonly string[];
  role: "supporting" | "contradicting";
  observationById: ReadonlyMap<string, Observation>;
  onDetach: (observationId: string) => void;
}) {
  if (ids.length === 0) return <p className="text-xs text-muted">None attached.</p>;
  return (
    <ul className="space-y-1">
      {ids.map((id) => {
        const o = observationById.get(id);
        return (
          <li key={id} className="flex items-start gap-2 rounded border border-border bg-background px-2 py-1 text-xs">
            <span className="flex-1">
              {o ? (
                <>
                  {o.statement}
                  {o.dateOrPeriod ? <span className="text-muted"> ({o.dateOrPeriod})</span> : null}{" "}
                  <SourceBadge sourceType={o.sourceType} />
                </>
              ) : (
                <span className="text-muted">Observation {id} is no longer stored.</span>
              )}
            </span>
            <button
              type="button"
              className="text-muted hover:text-neg"
              aria-label={`Remove from ${role}: ${o ? truncate(o.statement, 60) : id}`}
              title={`Remove from ${role}`}
              onClick={() => onDetach(id)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Status buttons with an optional one-line reason; every change lands in the review log. */
function StatusControls({
  status,
  disabled,
  onSetStatus,
  error,
}: {
  status: HypothesisStatus;
  disabled: boolean;
  /** Returns true when the change was applied (the note is then cleared). */
  onSetStatus: (status: HypothesisStatus, note: string) => boolean;
  error: ReactNode;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Status</span>
        {STATUS_ACTIONS.map((a) => {
          const current = status === a.status;
          return (
            <button
              key={a.status}
              type="button"
              className={current ? SMALL_PRESSED : SMALL}
              aria-pressed={current}
              disabled={current || disabled}
              title={HYPOTHESIS_STATUS_META[a.status].meaning}
              onClick={() => {
                if (onSetStatus(a.status, note.trim())) setNote("");
              }}
            >
              {a.label}
            </button>
          );
        })}
        <label htmlFor={noteId} className="sr-only">
          Reason for the status change
        </label>
        <input
          id={noteId}
          type="text"
          className="max-w-xs flex-1 min-w-[12rem]"
          placeholder="Reason (optional, one line) — kept in the review log"
          value={note}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted mt-1">{STATUS_LEGEND}</p>
      {error}
    </div>
  );
}

function ReviewLog({ entries }: { entries: readonly HypothesisReviewEntry[] }) {
  if (entries.length === 0) return <p className="text-xs text-muted">No status change recorded yet.</p>;
  const newestFirst = [...entries].reverse();
  return (
    <ol className="space-y-1">
      {newestFirst.map((e, i) => (
        <li key={`${entries.length - 1 - i}-${e.at}`} className="flex flex-wrap items-baseline gap-1.5 text-xs">
          <span className="text-muted tabular-nums">{fmtAt(e.at)}</span>
          <HypothesisStatusBadge status={e.status} />
          {e.note ? <span>{e.note}</span> : <span className="text-muted">no reason given</span>}
        </li>
      ))}
    </ol>
  );
}

/** "What would weaken this?" — the conditions the person has said would count against the reading. */
function DisconfirmingConditions({
  conditions,
  accepted,
  disabled,
  onAdd,
  onRemove,
  error,
}: {
  conditions: readonly string[];
  /** An accepted reading with nothing that could weaken it is worth flagging. */
  accepted: boolean;
  disabled: boolean;
  /** Returns true when the condition was recorded (the input is then cleared). */
  onAdd: (text: string) => boolean;
  onRemove: (index: number) => void;
  error: ReactNode;
}) {
  const inputId = useId();
  const [text, setText] = useState("");
  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (onAdd(trimmed)) setText("");
  };
  return (
    <div>
      <div className="text-xs text-muted mb-1">What would weaken this?</div>
      {conditions.length === 0 ? (
        accepted ? (
          <p className="text-sm rounded-md border border-warn bg-warn-soft px-3 py-2 text-warn" role="note">
            No disconfirming condition recorded yet. This reading is accepted; say what would make you set it aside.
          </p>
        ) : (
          <p className="text-xs text-muted">No disconfirming condition recorded yet.</p>
        )
      ) : (
        <ul className="space-y-1">
          {conditions.map((c, i) => (
            <li key={`${i}-${c}`} className="flex items-start gap-2 rounded border border-border bg-background px-2 py-1 text-xs">
              <span className="flex-1">{c}</span>
              <button
                type="button"
                className="text-muted hover:text-neg"
                aria-label={`Remove condition: ${truncate(c, 60)}`}
                title="Remove condition"
                disabled={disabled}
                onClick={() => onRemove(i)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          New disconfirming condition
        </label>
        <input
          id={inputId}
          type="text"
          className="max-w-md flex-1 min-w-[14rem]"
          placeholder="e.g. the reserve still falls three months after the change"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" className={SMALL} disabled={disabled || text.trim().length === 0} onClick={add}>
          Add condition
        </button>
      </div>
      {error}
    </div>
  );
}

/** Kill criteria: decision rules the person set. The engine only reads them
 *  against the named variable; the person records the status. */
function KillCriteria({
  criteria,
  variables,
  variableById,
  readKill,
  disabled,
  onAdd,
  onSetStatus,
  error,
}: {
  criteria: readonly KillCriterion[];
  variables: readonly Variable[];
  variableById: ReadonlyMap<string, Variable>;
  readKill: (criterion: KillCriterion) => KillReading;
  disabled: boolean;
  /** Returns true when the criterion was recorded (the form is then cleared). */
  onAdd: (input: KillCriterionInput) => boolean;
  onSetStatus: (criterionId: string, status: KillStatus) => void;
  error: ReactNode;
}) {
  const ids = useId();
  const [statement, setStatement] = useState("");
  const [variableId, setVariableId] = useState("");
  const [comparator, setComparator] = useState<KillComparator>("lt");
  const [threshold, setThreshold] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const sorted = [...variables].sort((a, b) => a.name.localeCompare(b.name));

  const add = () => {
    const text = statement.trim();
    if (!text) {
      setLocalError("A kill criterion needs a statement.");
      return;
    }
    if (variableId && threshold === null) {
      setLocalError("Give a threshold for the chosen variable, or leave the variable empty for a plain statement.");
      return;
    }
    setLocalError(null);
    const input: KillCriterionInput = variableId ? { statement: text, variableId, comparator, threshold: threshold ?? undefined } : { statement: text };
    if (onAdd(input)) {
      setStatement("");
      setVariableId("");
      setComparator("lt");
      setThreshold(null);
    }
  };

  return (
    <div>
      <div className="text-xs text-muted mb-1">Kill criteria</div>
      {criteria.length === 0 ? (
        <p className="text-xs text-muted">No kill criterion set yet. A kill criterion is your own rule for when this reading should be set aside.</p>
      ) : (
        <ul className="space-y-2">
          {criteria.map((k) => {
            const reading = readKill(k);
            const rule =
              k.variableId && k.comparator && k.threshold !== undefined
                ? `${nameOf(variableById, k.variableId)} ${COMPARATOR_SIGN[k.comparator]} ${k.threshold}`
                : null;
            return (
              <li key={k.id} className="rounded border border-border bg-background px-2 py-1.5 text-xs">
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <span className="text-sm">{k.statement}</span>
                  {rule ? <span className="text-muted tabular-nums">({rule})</span> : null}
                  <span className="text-muted font-mono">{k.id}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className={`inline-block rounded px-1.5 py-0.5 ${READING_TONE[reading]}`} title="Engine reading of the current value against the rule">
                    reading: {reading}
                  </span>
                  <span className="text-muted">— the engine only reads; you decide</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-muted">
                    Your status: <span className="text-foreground">{k.status}</span>
                  </span>
                  {KILL_STATUS_ACTIONS.map((a) => (
                    <button
                      key={a.status}
                      type="button"
                      className={k.status === a.status ? SMALL_PRESSED : SMALL}
                      aria-pressed={k.status === a.status}
                      disabled={disabled || k.status === a.status}
                      onClick={() => onSetStatus(k.id, a.status)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 space-y-2 rounded border border-border p-2">
        <div className="text-xs text-muted">Add a kill criterion</div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${ids}-statement`} className="sr-only">
            Statement
          </label>
          <input
            id={`${ids}-statement`}
            type="text"
            className="max-w-md flex-1 min-w-[14rem]"
            placeholder="Set this aside if…"
            value={statement}
            disabled={disabled}
            onChange={(e) => {
              setStatement(e.target.value);
              setLocalError(null);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${ids}-variable`} className="text-xs text-muted">
            Variable (optional)
          </label>
          <select
            id={`${ids}-variable`}
            className="max-w-xs"
            value={variableId}
            disabled={disabled}
            onChange={(e) => {
              setVariableId(e.target.value);
              setLocalError(null);
            }}
          >
            <option value="">none — plain statement</option>
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.kind === "derived" ? " (calculated)" : ""}
              </option>
            ))}
          </select>
          {variableId ? (
            <>
              <label htmlFor={`${ids}-comparator`} className="sr-only">
                Comparator
              </label>
              <select id={`${ids}-comparator`} value={comparator} disabled={disabled} onChange={(e) => setComparator(e.target.value as KillComparator)}>
                {COMPARATORS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <NumberField
                value={threshold}
                nullable
                className="w-28"
                ariaLabel="Threshold"
                onCommit={(n) => {
                  setThreshold(n);
                  setLocalError(null);
                }}
              />
              <span className="text-xs text-muted">{variableById.get(variableId)?.unit ?? ""}</span>
            </>
          ) : null}
          <button type="button" className={SMALL} disabled={disabled || statement.trim().length === 0} onClick={add}>
            Add kill criterion
          </button>
        </div>
        {localError ? (
          <p className="text-xs text-neg" role="alert">
            {localError}
          </p>
        ) : null}
        {error}
      </div>
    </div>
  );
}

function HypothesisCard({
  h,
  loop,
  variables,
  variableById,
  relationshipById,
  observationById,
  observations,
  readKill,
  editor,
  onEdit,
  removing,
  onRequestRemove,
  onCancelRemove,
  onRemove,
  pickedObservation,
  onPickObservation,
  onAttach,
  onDetach,
  onSetStatus,
  onAddCondition,
  onRemoveCondition,
  onAddKillCriterion,
  onSetKillStatus,
  statusError,
  conditionError,
  killError,
  evidenceError,
  removeError,
}: {
  h: Hypothesis;
  loop: EvaluatedLoop | undefined;
  variables: readonly Variable[];
  variableById: ReadonlyMap<string, Variable>;
  relationshipById: ReadonlyMap<string, Relationship>;
  observationById: ReadonlyMap<string, Observation>;
  observations: readonly Observation[];
  /** Engine reading of a kill criterion against the live model (readKillCriterion). */
  readKill: (criterion: KillCriterion) => KillReading;
  /** The edit form when this hypothesis is being edited; replaces the display. */
  editor: ReactNode | null;
  onEdit: () => void;
  removing: boolean;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  pickedObservation: string;
  onPickObservation: (id: string) => void;
  onAttach: (role: "supporting" | "contradicting") => void;
  onDetach: (observationId: string) => void;
  onSetStatus: (status: HypothesisStatus, note: string) => boolean;
  onAddCondition: (text: string) => boolean;
  onRemoveCondition: (index: number) => void;
  onAddKillCriterion: (input: KillCriterionInput) => boolean;
  onSetKillStatus: (criterionId: string, status: KillStatus) => void;
  statusError: ReactNode;
  conditionError: ReactNode;
  killError: ReactNode;
  evidenceError: ReactNode;
  removeError: ReactNode;
}) {
  const selectId = useId();
  const supporting = h.supportingObservationIds.length;
  const contradicting = h.contradictingObservationIds.length;

  if (editor) {
    return (
      <Card title={`Edit hypothesis ${h.id}`} className="border-accent">
        {editor}
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-[16rem]">
          <p className="text-sm font-medium">{h.statement}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <KindBadge kind={h.kind} />
            <HypothesisStatusBadge status={h.status} />
            <ConfidenceBadge confidence={h.confidence} />
            <span className="text-xs text-muted font-mono">{h.id}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={SMALL} onClick={onEdit} disabled={removing}>
            Edit
          </button>
          <button type="button" className={SMALL} onClick={onRequestRemove} disabled={removing}>
            Remove
          </button>
        </div>
      </div>

      {removing ? (
        <div className="mt-3 rounded-md bg-neg-soft px-3 py-2 text-sm">
          <p className="mb-2">
            Remove this hypothesis? Observations attached to it are kept; only their link to it is dropped.
            {h.kind === "loop" ? " The loop itself is still formed by the edges and would read as proposed again." : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="rounded bg-neg text-white px-2 py-1 text-xs" onClick={onRemove}>
              Remove
            </button>
            <button type="button" className="rounded border border-border bg-surface px-2 py-1 text-xs text-foreground" onClick={onCancelRemove}>
              Cancel
            </button>
          </div>
          {removeError}
        </div>
      ) : null}

      {h.kind === "loop" ? (
        <div className="mt-3 text-sm">
          <div className="text-xs text-muted mb-1">Loop</div>
          {loop ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-xs ${loop.polarity === "reinforcing" ? "text-warn bg-warn-soft" : "text-desired bg-desired-soft"}`}>
                {loop.polarity}
              </span>
              {loop.annotation?.name ? <span className="font-medium">{loop.annotation.name}</span> : null}
              <span className="text-xs">{loopChain(loop, variableById)} → (back to start)</span>
              <span className="text-xs text-muted tabular-nums">
                mean strength {loop.meanStrength.toFixed(2)} · pressure {loop.pressure === null ? "—" : loop.pressure.toFixed(2)}
              </span>
            </div>
          ) : (
            <p className="text-xs text-warn bg-warn-soft rounded px-2 py-1 inline-block">
              This loop is no longer formed by the enabled relationships.
              {h.loopId ? <span className="font-mono"> ({h.loopId})</span> : null}
            </p>
          )}
        </div>
      ) : null}

      {h.relationshipIds.length > 0 ? (
        <div className="mt-3 text-sm">
          <div className="text-xs text-muted mb-1">Related relationships</div>
          <ul className="flex flex-wrap gap-1.5">
            {h.relationshipIds.map((id) => (
              <li key={id} className="rounded border border-border bg-background px-1.5 py-0.5 text-xs">
                {relationshipLabel(relationshipById.get(id), id, variableById)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3">
        <StatusControls status={h.status} disabled={removing} onSetStatus={onSetStatus} error={statusError} />
      </div>

      <div className="mt-3">
        <div className="text-xs text-muted mb-1">Review log</div>
        <ReviewLog entries={h.reviewLog} />
      </div>

      <div className="mt-3">
        <DisconfirmingConditions
          conditions={h.disconfirmingConditions}
          accepted={h.status === "accepted"}
          disabled={removing}
          onAdd={onAddCondition}
          onRemove={onRemoveCondition}
          error={conditionError}
        />
      </div>

      <div className="mt-3">
        <KillCriteria
          criteria={h.killCriteria}
          variables={variables}
          variableById={variableById}
          readKill={readKill}
          disabled={removing}
          onAdd={onAddKillCriterion}
          onSetStatus={onSetKillStatus}
          error={killError}
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-xs text-muted mb-1">Supporting observations</div>
          <ObservationChips ids={h.supportingObservationIds} role="supporting" observationById={observationById} onDetach={onDetach} />
        </div>
        <div>
          <div className="text-xs text-muted mb-1">Contradicting observations</div>
          <ObservationChips ids={h.contradictingObservationIds} role="contradicting" observationById={observationById} onDetach={onDetach} />
        </div>
      </div>

      <div className="mt-3">
        <div className="text-xs text-muted mb-1">
          {supporting} supporting · {contradicting} contradicting
        </div>
        {observations.length === 0 ? (
          <p className="text-xs text-muted">No observations recorded yet.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={selectId} className="sr-only">
              Observation to attach
            </label>
            <select id={selectId} className="max-w-md" value={pickedObservation} onChange={(e) => onPickObservation(e.target.value)}>
              <option value="">Select an observation…</option>
              {observations.map((o) => {
                const attached = h.supportingObservationIds.includes(o.id)
                  ? " (supporting)"
                  : h.contradictingObservationIds.includes(o.id)
                    ? " (contradicting)"
                    : "";
                return (
                  <option key={o.id} value={o.id}>
                    {truncate(o.statement)}
                    {attached}
                  </option>
                );
              })}
            </select>
            <button type="button" className={SMALL} disabled={!pickedObservation || removing} onClick={() => onAttach("supporting")}>
              Add as supporting
            </button>
            <button type="button" className={SMALL} disabled={!pickedObservation || removing} onClick={() => onAttach("contradicting")}>
              Add as contradicting
            </button>
          </div>
        )}
        {evidenceError}
      </div>

      {h.notes ? (
        <div className="mt-3 text-sm">
          <div className="text-xs text-muted mb-0.5">Notes</div>
          <p className="text-sm">{h.notes}</p>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function HypothesesPage() {
  const { evaluated, apply, lastError, clearError } = useModel();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** Which control caused the last refusal, so lastError renders next to it. */
  const [errorAt, setErrorAt] = useState<string | null>(null);
  /** Observation picked in each hypothesis's attach control, by hypothesis id. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  /** Edited draft statements for loops without a hypothesis, by loop id. */
  const [loopDrafts, setLoopDrafts] = useState<Record<string, string>>({});

  const relationshipById = useMemo(
    () => new Map<string, Relationship>((evaluated?.model.relationships ?? []).map((r) => [r.id, r])),
    [evaluated],
  );
  const observationById = useMemo(
    () => new Map<string, Observation>((evaluated?.model.observations ?? []).map((o) => [o.id, o])),
    [evaluated],
  );
  const loopById = useMemo(() => new Map<string, EvaluatedLoop>((evaluated?.loops ?? []).map((l) => [l.id, l])), [evaluated]);
  const loopHypothesisByLoopId = useMemo(
    () =>
      new Map<string, Hypothesis>(
        (evaluated?.model.hypotheses ?? []).filter((h) => h.kind === "loop" && h.loopId).map((h) => [h.loopId!, h]),
      ),
    [evaluated],
  );

  if (!evaluated) return <Loading />;
  const { model, loops, variables, variableById } = evaluated;
  const hypotheses = model.hypotheses;
  const observations = model.observations;
  const loopsWithoutHypothesis = loops.filter((l) => !l.hypothesis);
  const counts = Object.fromEntries(HypothesisStatusSchema.options.map((s) => [s, hypotheses.filter((h) => h.status === s).length])) as Record<
    HypothesisStatus,
    number
  >;

  /** Run a mutation and remember which control asked for it. */
  const run = (at: string, mutation: ModelMutation): boolean => {
    setErrorAt(at);
    const ok = apply(mutation);
    if (ok) setErrorAt(null);
    return ok;
  };
  const errorFor = (at: string): ReactNode =>
    lastError && errorAt === at ? (
      <p className="text-xs text-neg mt-1" role="alert">
        {lastError}
      </p>
    ) : null;
  const settle = () => {
    clearError();
    setErrorAt(null);
    setMode({ kind: "idle" });
  };
  const editingId = mode.kind === "edit" ? mode.id : null;

  const submitForm = (values: FormValues) => {
    const ok =
      mode.kind === "edit"
        ? run(`form:${mode.id}`, (m) => mutations.updateHypothesis(m, mode.id, values))
        : run("form:create", (m) => mutations.addHypothesis(m, values));
    if (ok) setMode({ kind: "idle" });
  };

  const formFor = (initial?: Hypothesis) => (
    <HypothesisForm
      key={initial?.id ?? "create"}
      initial={initial}
      loops={loops}
      relationships={model.relationships}
      variableById={variableById}
      loopHypothesisByLoopId={loopHypothesisByLoopId}
      onSubmit={submitForm}
      onCancel={settle}
      error={errorFor(initial ? `form:${initial.id}` : "form:create")}
      onEdit={clearError}
    />
  );

  return (
    <div>
      <PageHeader
        title="Hypotheses"
        lede="Interpretations under review. A hypothesis is a reading of the system, not a finding: it can be supported or contradicted by observations, accepted as a working reading, set aside, or left open. Every detected loop is listed here as a hypothesis."
      />
      <Note>
        A loop is a structural consequence of the relationships entered as judgments, so it is never more than a hypothesis until the person reviews it (A18). Relationship strength is a model judgment; nothing here estimates a causal effect or proves a reading. Observations stay verbatim and are never turned into values.
      </Note>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
        {HypothesisStatusSchema.options.map((s) => (
          <Stat key={s} label={HYPOTHESIS_STATUS_META[s].label} value={counts[s]} sub={HYPOTHESIS_STATUS_META[s].meaning} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          disabled={mode.kind === "create"}
          onClick={() => {
            clearError();
            setErrorAt(null);
            setConfirmRemove(null);
            setMode({ kind: "create" });
          }}
        >
          New hypothesis
        </button>
        <span className="text-xs text-muted">
          {hypotheses.length} recorded · {loops.length} loop{loops.length === 1 ? "" : "s"} detected · {loopsWithoutHypothesis.length} without a hypothesis
        </span>
      </div>

      {mode.kind === "create" ? (
        <div className="mt-4">
          <Card title="New hypothesis" className="border-accent">
            {formFor()}
          </Card>
        </div>
      ) : null}

      {loopsWithoutHypothesis.length > 0 ? (
        <div className="mt-4">
          <Card title={`Detected loops without a hypothesis (${loopsWithoutHypothesis.length})`}>
            <p className="text-xs text-muted mb-3">
              Each of these loops is formed by the enabled relationships but has no hypothesis record yet, so it reads as proposed. The drafted statement below is built from the variable names and edge signs only; edit it before creating the record.
            </p>
            <ul className="space-y-3">
              {loopsWithoutHypothesis.map((l) => {
                const draftId = `loop-draft-${l.id}`;
                const text = loopDrafts[l.id] ?? draftLoopStatement(l, variableById, relationshipById);
                return (
                  <li key={l.id} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${l.polarity === "reinforcing" ? "text-warn bg-warn-soft" : "text-desired bg-desired-soft"}`}>
                        {l.polarity}
                      </span>
                      <span className="font-medium">{l.annotation?.name ?? "Unnamed loop"}</span>
                      <HypothesisStatusBadge status={l.status} prefix="hypothesis:" />
                      <span className="text-xs text-muted tabular-nums">
                        mean strength {l.meanStrength.toFixed(2)} · pressure {l.pressure === null ? "—" : l.pressure.toFixed(2)}
                      </span>
                    </div>
                    <div className="text-xs mt-1">{loopChain(l, variableById)} → (back to start)</div>
                    <label htmlFor={draftId} className="block text-xs text-muted mt-2 mb-1">
                      Statement (editable draft)
                    </label>
                    <textarea
                      id={draftId}
                      className="w-full max-w-2xl"
                      rows={3}
                      value={text}
                      onChange={(e) => {
                        clearError();
                        setLoopDrafts((d) => ({ ...d, [l.id]: e.target.value }));
                      }}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={SECONDARY}
                        disabled={text.trim().length === 0}
                        onClick={() => {
                          const statement = text.trim();
                          const ok = run(`ensure:${l.id}`, (m) =>
                            mutations.ensureLoopHypothesis(m, { loopId: l.id, statement, relationshipIds: [...l.edgeIds] }),
                          );
                          if (ok) {
                            setLoopDrafts((d) => {
                              const next = { ...d };
                              delete next[l.id];
                              return next;
                            });
                          }
                        }}
                      >
                        Create hypothesis for this loop
                      </button>
                      <span className="text-xs text-muted">Starts as proposed, with the loop&apos;s {l.edgeIds.length} edges attached.</span>
                    </div>
                    {errorFor(`ensure:${l.id}`)}
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        <h2 className="text-sm font-semibold">Recorded hypotheses ({hypotheses.length})</h2>
        {hypotheses.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No hypotheses recorded yet. Create one above, or create a record for a detected loop.</p>
          </Card>
        ) : (
          hypotheses.map((h) => (
            <HypothesisCard
              key={h.id}
              h={h}
              loop={h.kind === "loop" && h.loopId ? loopById.get(h.loopId) : undefined}
              variables={variables}
              variableById={variableById}
              relationshipById={relationshipById}
              observationById={observationById}
              observations={observations}
              readKill={(k) => mutations.readKillCriterion(model, k)}
              editor={editingId === h.id ? formFor(h) : null}
              onEdit={() => {
                clearError();
                setErrorAt(null);
                setConfirmRemove(null);
                setMode({ kind: "edit", id: h.id });
              }}
              removing={confirmRemove === h.id}
              onRequestRemove={() => {
                clearError();
                setErrorAt(null);
                setConfirmRemove(h.id);
              }}
              onCancelRemove={() => {
                clearError();
                setErrorAt(null);
                setConfirmRemove(null);
              }}
              onRemove={() => {
                const ok = run(`remove:${h.id}`, (m) => mutations.removeHypothesis(m, h.id));
                if (ok) {
                  setConfirmRemove(null);
                  if (editingId === h.id) setMode({ kind: "idle" });
                }
              }}
              pickedObservation={picked[h.id] ?? ""}
              onPickObservation={(id) => {
                clearError();
                setPicked((p) => ({ ...p, [h.id]: id }));
              }}
              onAttach={(role) => {
                const obsId = picked[h.id];
                if (!obsId) return;
                const ok = run(`evidence:${h.id}`, (m) => mutations.attachObservationToHypothesis(m, h.id, obsId, role));
                if (ok) setPicked((p) => ({ ...p, [h.id]: "" }));
              }}
              onDetach={(obsId) => run(`evidence:${h.id}`, (m) => mutations.detachObservationFromHypothesis(m, h.id, obsId))}
              onSetStatus={(status, note) =>
                run(`status:${h.id}`, (m) => mutations.setHypothesisStatus(m, h.id, status, { at: new Date().toISOString(), note }))
              }
              onAddCondition={(text) => run(`condition:${h.id}`, (m) => mutations.addDisconfirmingCondition(m, h.id, text))}
              onRemoveCondition={(index) => run(`condition:${h.id}`, (m) => mutations.removeDisconfirmingCondition(m, h.id, index))}
              onAddKillCriterion={(input) => run(`kill:${h.id}`, (m) => mutations.addKillCriterion(m, h.id, input))}
              onSetKillStatus={(criterionId, status) => run(`kill:${h.id}`, (m) => mutations.setKillCriterionStatus(m, h.id, criterionId, status))}
              statusError={errorFor(`status:${h.id}`)}
              conditionError={errorFor(`condition:${h.id}`)}
              killError={errorFor(`kill:${h.id}`)}
              evidenceError={errorFor(`evidence:${h.id}`)}
              removeError={errorFor(`remove:${h.id}`)}
            />
          ))
        )}
      </div>

      <div className="mt-4">
        <Note>{STATUS_LEGEND} Rejecting a loop hypothesis sets the reading aside; the loop is still formed by the edges until a relationship is disabled or removed on the feedback map.</Note>
      </div>
    </div>
  );
}
