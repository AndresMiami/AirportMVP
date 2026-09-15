"use client";
/**
 * Create/edit form for ONE observation. It holds a local draft and hands
 * back plain values on submit; the page turns them into a mutation
 * (services/mutations addObservation / updateObservation). Display and
 * input only: no model logic lives here.
 *
 * An observation is kept as stated. The form offers no value field and no
 * way to turn the statement into a variable: the interpretation, if any,
 * belongs to a variable, a relationship or a hypothesis and is linked from
 * the Observations screen.
 */
import { useId, useState, type ReactNode } from "react";
import { NumberField } from "@/components/fields";
import { fmtConfidence } from "@/components/format";
import { SOURCE_TYPE_META, confidenceLabel } from "@/domain/vocabulary";
import type { ObservationInput } from "@/services/mutations";
import { SourceTypeSchema, type Member, type Observation, type SourceType } from "@/types";

/** What the form hands back; the page passes it to a mutation. */
export type ObservationFormValues = Omit<ObservationInput, "id" | "links">;

const SOURCE_TYPES: readonly SourceType[] = SourceTypeSchema.options;

/** Placeholder only (never prefilled): an example of something noticed or reported, as stated. */
export const STATEMENT_PLACEHOLDER = "Mother's HHA income depends primarily on one client.";

const EVIDENCE_SOURCE_PLACEHOLDER = "bank statement · pay stubs · conversation 2026-09-01";

const DATE_PLACEHOLDER = "2019-2021 · March 2026 · ongoing";

/** Subject label for display: "whole system" for "" or the system id,
 *  the member's label otherwise. Kept here so the list and the form agree. */
export function subjectLabelOf(subjectId: string, members: readonly Member[], systemId: string): string {
  if (subjectId === "" || subjectId === systemId) return "whole system";
  return members.find((m) => m.id === subjectId)?.label ?? `unknown subject (${subjectId})`;
}

/** True when the subject means the system as a whole. */
export function isWholeSystem(subjectId: string, systemId: string): boolean {
  return subjectId === "" || subjectId === systemId;
}

interface Draft {
  statement: string;
  dateOrPeriod: string;
  subjectId: string;
  sourceType: SourceType;
  confidence: number;
  evidenceSource: string;
  notes: string;
}

function draftFrom(initial?: Observation): Draft {
  return {
    statement: initial?.statement ?? "",
    dateOrPeriod: initial?.dateOrPeriod ?? "",
    subjectId: initial?.subjectId ?? "",
    sourceType: initial?.sourceType ?? "self_reported",
    confidence: initial?.confidence ?? 0.5,
    evidenceSource: initial?.evidenceSource ?? "",
    notes: initial?.notes ?? "",
  };
}

const PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SECONDARY = "rounded border border-border px-3 py-1.5 text-sm hover:bg-background disabled:opacity-50";

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
      <div>{children}</div>
    </div>
  );
}

export function ObservationForm({
  initial,
  members,
  systemId,
  onSubmit,
  onCancel,
  error = null,
  onEdit,
  submitLabel,
}: {
  /** The observation being edited; absent when creating. */
  initial?: Observation;
  /** Members from model.profile.members, for the subject select. */
  members: readonly Member[];
  /** model.id: a stored subjectId equal to it also means "whole system". */
  systemId: string;
  onSubmit: (values: ObservationFormValues) => void;
  onCancel: () => void;
  /** Refusal from the last apply, shown next to the submit control. */
  error?: string | null;
  /** Called whenever the person edits a field, so a stale refusal can be cleared. */
  onEdit?: () => void;
  submitLabel?: string;
}) {
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [localError, setLocalError] = useState<string | null>(null);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setLocalError(null);
    onEdit?.();
  };

  // The select shows one "whole system" option for both spellings of it;
  // an untouched system-id subject is handed back unchanged.
  const subjectValue = isWholeSystem(draft.subjectId, systemId) ? "" : draft.subjectId;
  const subjectKnown = subjectValue === "" || members.some((m) => m.id === subjectValue);

  const submit = () => {
    const statement = draft.statement.trim();
    if (!statement) {
      setLocalError("An observation needs a statement: what was noticed or reported, as stated.");
      return;
    }
    if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
      setLocalError("Confidence must be between 0 and 1.");
      return;
    }
    setLocalError(null);
    onSubmit({
      statement,
      dateOrPeriod: draft.dateOrPeriod.trim(),
      subjectId: draft.subjectId,
      sourceType: draft.sourceType,
      confidence: draft.confidence,
      evidenceSource: draft.evidenceSource.trim(),
      notes: draft.notes.trim(),
    });
  };

  const shownError = localError ?? error;

  return (
    <div className="space-y-4 text-sm">
      <Field
        label="Statement"
        htmlFor={`${ids}-statement`}
        hint="What was noticed or reported, as stated. Not a value, not a judgment. Kept verbatim."
      >
        <textarea
          id={`${ids}-statement`}
          className="w-full max-w-xl"
          rows={3}
          required
          placeholder={STATEMENT_PLACEHOLDER}
          value={draft.statement}
          onChange={(e) => update({ statement: e.target.value })}
        />
      </Field>

      <Field label="Date or period" htmlFor={`${ids}-date`} hint="Free text, as entered; never parsed.">
        <input
          id={`${ids}-date`}
          type="text"
          className="w-full max-w-md"
          placeholder={DATE_PLACEHOLDER}
          value={draft.dateOrPeriod}
          onChange={(e) => update({ dateOrPeriod: e.target.value })}
        />
      </Field>

      <Field label="Subject" htmlFor={`${ids}-subject`} hint="Who or what the observation is about.">
        <select
          id={`${ids}-subject`}
          className="w-full max-w-md"
          value={subjectValue}
          onChange={(e) => update({ subjectId: e.target.value })}
        >
          <option value="">whole system</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.status === "archived" ? " (archived)" : ""}
              {m.role ? ` — ${m.role}` : ""}
            </option>
          ))}
          {!subjectKnown ? <option value={subjectValue}>unknown subject ({subjectValue})</option> : null}
        </select>
        {members.length === 0 ? (
          <p className="text-xs text-muted mt-1">No members recorded in the profile yet; the whole system is the only subject available.</p>
        ) : null}
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

      <Field
        label="Confidence"
        htmlFor={`${ids}-confidence`}
        hint="How sure the record is that this was noticed or reported as written (0–1). Not a judgment about what it means."
      >
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

      <Field label="Evidence source" htmlFor={`${ids}-evidence`} hint="Where it came from.">
        <input
          id={`${ids}-evidence`}
          type="text"
          className="w-full max-w-md"
          placeholder={EVIDENCE_SOURCE_PLACEHOLDER}
          value={draft.evidenceSource}
          onChange={(e) => update({ evidenceSource: e.target.value })}
        />
      </Field>

      <Field label="Notes" htmlFor={`${ids}-notes`} hint="Context about the record itself, not an interpretation of it.">
        <textarea
          id={`${ids}-notes`}
          className="w-full max-w-xl"
          rows={2}
          value={draft.notes}
          onChange={(e) => update({ notes: e.target.value })}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button type="button" className={PRIMARY} onClick={submit}>
          {submitLabel ?? (initial ? "Save observation" : "Add observation")}
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
