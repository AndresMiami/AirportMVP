"use client";
/**
 * Editor for one directed relationship (create or edit). Display-only:
 * every change goes through the `commit(owner, mutation)` callback the page
 * provides (which wraps useModel().apply with mutations from
 * services/mutations). In edit mode each field commits as soon as it is
 * changed; in create mode the fields build a draft and "Add relationship"
 * commits it once. A refusal is shown next to the control that caused it.
 */
import { useId, useState } from "react";
import { formatLag, horizonOfLag } from "@/calculations/lag";
import { EvidenceListEditor } from "@/components/evidence-list-editor";
import { NumberField } from "@/components/fields";
import type { ModelMutation } from "@/components/model-provider";
import { Note, SourceBadge } from "@/components/ui";
import { SOURCE_TYPE_META, confidenceLabel } from "@/domain/vocabulary";
import * as mutations from "@/services/mutations";
import {
  DYNAMICS_ELIGIBLE_KINDS,
  LagUnitSchema,
  RelationshipKindSchema,
  SourceTypeSchema,
  type EdgeDirection,
  type Evidence,
  type LagUnit,
  type Observation,
  type Relationship,
  type RelationshipKind,
  type SourceType,
  type Variable,
} from "@/types";

const SOURCE_TYPES: readonly SourceType[] = SourceTypeSchema.options;
const LAG_UNITS: readonly LagUnit[] = LagUnitSchema.options;
const KINDS: readonly RelationshipKind[] = RelationshipKindSchema.options;

/** One-line meaning of each relationship kind (what the arrow claims). */
export const RELATIONSHIP_KIND_META: Record<RelationshipKind, { label: string; meaning: string }> = {
  unclassified: { label: "unclassified", meaning: "not yet classified; excluded from loops" },
  causal_hypothesis: { label: "causal hypothesis", meaning: "a claimed mechanism, under review" },
  association: { label: "association", meaning: "co-occurs; not a causal claim" },
  definitional: { label: "definitional", meaning: "true by formula" },
  constraint: { label: "constraint", meaning: "limits; not a mechanism" },
};

export const DYNAMICS_RULE = "Only a causal hypothesis or an opted-in definitional dependency can take part in dynamics";

export function isDynamicsEligible(kind: RelationshipKind): boolean {
  return DYNAMICS_ELIGIBLE_KINDS.includes(kind);
}

/** Prominent, always-visible reminder about what strength means. */
export function JudgmentBanner() {
  return (
    <div className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-warn" role="note">
      <span className="font-semibold">Strength is a model judgment.</span> A 0–1 influence weight chosen by the person, not an
      empirically estimated causal coefficient. Nothing in this application estimates causal effects from data.
    </div>
  );
}

/** The editable fields of a relationship (everything except the id). */
export type RelationshipDraft = Omit<Relationship, "id">;

export function defaultRelationshipDraft(sourceVariableId = "", targetVariableId = ""): RelationshipDraft {
  return {
    sourceVariableId,
    targetVariableId,
    // Unknown kind is not causal: the person classifies it and opts in.
    kind: "unclassified",
    participatesInDynamics: false,
    direction: "positive",
    strength: 0.5,
    lag: { value: 0, unit: "months" },
    confidence: 0.5,
    sourceType: "self_reported",
    evidence: [],
    explanation: "",
    notes: "",
    enabled: true,
  };
}

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50";
const BTN_PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";

export function RelationshipEditor({
  relationship,
  initialSourceId,
  initialTargetId,
  variables,
  variableById,
  linkedObservations,
  commit,
  errorFor,
  clearError,
  allocateId,
  onCreated,
  onDeleted,
  onClose,
}: {
  /** The stored relationship to edit, or null to create a new one. */
  relationship: Relationship | null;
  /** Create mode prefill (e.g. from Connect mode on the diagram). */
  initialSourceId?: string;
  initialTargetId?: string;
  /** Every variable the selects may list. */
  variables: readonly Variable[];
  variableById: ReadonlyMap<string, Variable>;
  /** Observations linked to `relationship` (read-only here). */
  linkedObservations: readonly Observation[];
  /** Runs a mutation through useModel().apply; `owner` tags where a refusal is shown. */
  commit: (owner: string, mutation: ModelMutation) => boolean;
  /** lastError when the last refused commit belonged to `owner`, else null. */
  errorFor: (owner: string) => string | null;
  clearError: () => void;
  /** nextId(model, "rel") — computed by the page from the live model. */
  allocateId: () => string;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const uid = useId();
  const editing = relationship !== null;
  const [draft, setDraft] = useState<RelationshipDraft>(() => defaultRelationshipDraft(initialSourceId ?? "", initialTargetId ?? ""));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const values: RelationshipDraft = relationship ?? draft;

  /** Owner key for a field: in create mode every refusal belongs to the
   *  single "create" commit; in edit mode each field commits on its own. */
  const ownerOf = (field: string) => (editing ? `editor:${relationship.id}:${field}` : `editor:create`);

  const set = (field: string, patch: Partial<RelationshipDraft>) => {
    if (editing) {
      commit(ownerOf(field), (m) => mutations.updateRelationship(m, relationship.id, patch));
    } else {
      clearError();
      setDraft((d) => ({ ...d, ...patch }));
    }
  };

  const fieldError = (field: string) => (editing ? errorFor(ownerOf(field)) : null);
  const createError = editing ? null : errorFor("editor:create");

  const create = () => {
    const id = allocateId();
    const ok = commit("editor:create", (m) => mutations.addRelationship(m, { ...draft, id }));
    if (ok) onCreated(id);
  };

  const remove = () => {
    if (!editing) return;
    const ok = commit(ownerOf("delete"), (m) => mutations.removeRelationship(m, relationship.id));
    if (ok) onDeleted();
  };

  const sorted = [...variables].sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: string) => variableById.get(id)?.name ?? (id ? id : "…");
  const sourceName = nameOf(values.sourceVariableId);
  const targetName = nameOf(values.targetVariableId);
  const meaning =
    values.direction === "positive"
      ? `${sourceName} up → ${targetName} up (source up → target up)`
      : `${sourceName} up → ${targetName} down (source up → target down)`;
  const canCreate = !editing && draft.sourceVariableId !== "" && draft.targetVariableId !== "";
  const eligible = isDynamicsEligible(values.kind);
  const inDynamics = eligible && values.participatesInDynamics;

  const setKind = (kind: RelationshipKind) => {
    // A kind that cannot take part in dynamics never leaves the opt-in on.
    const patch: Partial<RelationshipDraft> = isDynamicsEligible(kind) ? { kind } : { kind, participatesInDynamics: false };
    set("kind", patch);
  };

  return (
    <div className="space-y-4">
      <JudgmentBanner />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {editing ? (
            <>
              Editing <span className="font-mono text-xs text-muted">{relationship.id}</span>
            </>
          ) : (
            "New relationship"
          )}
        </h3>
        <button type="button" className={BTN} onClick={onClose}>
          {editing ? "Close" : "Cancel"}
        </button>
      </div>

      {/* Endpoints */}
      <Field
        id={`${uid}-source`}
        label="Source variable"
        error={fieldError("endpoints")}
        hint={editing ? "Changing an endpoint moves this edge; one edge per source → target pair." : undefined}
      >
        <div className="flex flex-col gap-1.5">
          <select
            id={`${uid}-source`}
            className="w-full"
            value={values.sourceVariableId}
            onChange={(e) => set("endpoints", { sourceVariableId: e.target.value })}
          >
            {!editing ? <option value="">— choose the source —</option> : null}
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.kind === "derived" ? " (calculated)" : ""}
              </option>
            ))}
          </select>
          <label htmlFor={`${uid}-target`} className="block text-xs font-medium text-muted">
            Target variable
          </label>
          <select
            id={`${uid}-target`}
            className="w-full"
            value={values.targetVariableId}
            onChange={(e) => set("endpoints", { targetVariableId: e.target.value })}
          >
            {!editing ? <option value="">— choose the target —</option> : null}
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.kind === "derived" ? " (calculated)" : ""}
              </option>
            ))}
          </select>
          <div>
            <button
              type="button"
              className={BTN}
              disabled={!values.sourceVariableId || !values.targetVariableId}
              onClick={() =>
                set("endpoints", { sourceVariableId: values.targetVariableId, targetVariableId: values.sourceVariableId })
              }
            >
              Swap source and target
            </button>
          </div>
        </div>
      </Field>

      {/* Kind */}
      <Field
        id={`${uid}-kind`}
        label="Kind — what this arrow claims"
        error={fieldError("kind")}
        hint={`${RELATIONSHIP_KIND_META[values.kind].meaning}. ${editing ? "" : "New relationships start unclassified; choose what the arrow claims."}`}
      >
        <select id={`${uid}-kind`} className="w-full" value={values.kind} onChange={(e) => setKind(e.target.value as RelationshipKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {RELATIONSHIP_KIND_META[k].label} — {RELATIONSHIP_KIND_META[k].meaning}
            </option>
          ))}
        </select>
      </Field>

      {/* Dynamics opt-in */}
      <Field
        error={fieldError("participatesInDynamics")}
        hint={
          eligible
            ? inDynamics
              ? "Loops, propagation and influence read this edge (while it is enabled)."
              : "Not yet part of dynamics: loops and propagation ignore it until you opt in."
            : DYNAMICS_RULE
        }
      >
        <label className={`flex items-center gap-2 text-sm ${eligible ? "" : "text-muted"}`}>
          <input
            type="checkbox"
            checked={inDynamics}
            disabled={!eligible}
            aria-describedby={`${uid}-dynamics-rule`}
            onChange={(e) => set("participatesInDynamics", { participatesInDynamics: e.target.checked })}
          />
          Takes part in loops and propagation
        </label>
        <span id={`${uid}-dynamics-rule`} className="sr-only">
          {DYNAMICS_RULE}
        </span>
      </Field>

      {/* Direction */}
      <Field id={`${uid}-direction`} label="Direction" error={fieldError("direction")} hint={meaning}>
        <select
          id={`${uid}-direction`}
          className="w-full"
          value={values.direction}
          onChange={(e) => set("direction", { direction: e.target.value as EdgeDirection })}
        >
          <option value="positive">positive — source up → target up</option>
          <option value="negative">negative — source up → target down</option>
        </select>
      </Field>

      {/* Strength */}
      <Field
        id={`${uid}-strength`}
        label="Strength (0–1, model judgment)"
        error={fieldError("strength")}
        hint="How much of a change in the source is judged to carry into the target. A chosen weight, not a measured effect."
      >
        <SliderNumber id={`${uid}-strength`} value={values.strength} ariaLabel="Strength" onCommit={(n) => set("strength", { strength: n })} />
      </Field>

      {/* Lag */}
      <Field
        id={`${uid}-lag`}
        label="Lag before the effect shows"
        error={fieldError("lag")}
        hint={`${formatLag(values.lag)} · horizon class: ${horizonOfLag(values.lag)}`}
      >
        <div className="flex items-center gap-2">
          <NumberField
            value={values.lag.value}
            min={0}
            step={1}
            ariaLabel="Lag value"
            className="w-24"
            onCommit={(n) => {
              if (n === null) return;
              set("lag", { lag: { value: n, unit: values.lag.unit } });
            }}
          />
          <select
            id={`${uid}-lag`}
            aria-label="Lag unit"
            value={values.lag.unit}
            onChange={(e) => set("lag", { lag: { value: values.lag.value, unit: e.target.value as LagUnit } })}
          >
            {LAG_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
      </Field>

      {/* Confidence */}
      <Field
        id={`${uid}-confidence`}
        label="Confidence in this relationship (0–1)"
        error={fieldError("confidence")}
        hint={confidenceLabel(values.confidence)}
      >
        <SliderNumber
          id={`${uid}-confidence`}
          value={values.confidence}
          ariaLabel="Confidence"
          onCommit={(n) => set("confidence", { confidence: n })}
        />
      </Field>

      {/* Source type */}
      <Field
        id={`${uid}-sourceType`}
        label="Where this relationship comes from"
        error={fieldError("sourceType")}
        hint={SOURCE_TYPE_META[values.sourceType].description}
      >
        <select
          id={`${uid}-sourceType`}
          className="w-full"
          value={values.sourceType}
          onChange={(e) => set("sourceType", { sourceType: e.target.value as SourceType })}
        >
          {SOURCE_TYPES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_TYPE_META[s].label}
            </option>
          ))}
        </select>
      </Field>

      {/* Evidence */}
      <Field label="Evidence" error={fieldError("evidence")}>
        <EvidenceListEditor
          items={values.evidence}
          onEdit={clearError}
          onChange={(next: Evidence[]) => set("evidence", { evidence: next })}
        />
      </Field>

      {/* Explanation */}
      <Field id={`${uid}-explanation`} label="Explanation" error={fieldError("explanation")} hint="In plain words, why the source is thought to move the target.">
        <TextAreaField
          id={`${uid}-explanation`}
          value={values.explanation}
          rows={2}
          onEdit={clearError}
          onCommit={(t) => set("explanation", { explanation: t })}
        />
      </Field>

      {/* Notes */}
      <Field id={`${uid}-notes`} label="Notes" error={fieldError("notes")}>
        <TextAreaField id={`${uid}-notes`} value={values.notes} rows={2} onEdit={clearError} onCommit={(t) => set("notes", { notes: t })} />
      </Field>

      {/* Enabled */}
      <Field error={fieldError("enabled")} hint="Disabled edges stay stored and drawn (gray, dotted) but take no part in loops, propagation or influence, whatever their kind.">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => {
              if (editing) commit(ownerOf("enabled"), (m) => mutations.setRelationshipEnabled(m, relationship.id, e.target.checked));
              else set("enabled", { enabled: e.target.checked });
            }}
          />
          Enabled
        </label>
      </Field>

      {/* Actions */}
      {editing ? (
        <div className="space-y-2 border-t border-border pt-3">
          {confirmDelete ? (
            <div className="rounded-md border border-neg bg-neg-soft px-3 py-2 text-sm">
              <p>
                Delete this relationship? Its references are removed from observations and hypotheses; loops that used it are recomputed.
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" className="rounded bg-neg text-white px-3 py-1 text-xs" onClick={remove}>
                  Confirm delete
                </button>
                <button type="button" className={BTN} onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="text-xs text-neg hover:underline" onClick={() => setConfirmDelete(true)}>
              Delete relationship
            </button>
          )}
          {fieldError("delete") ? (
            <p className="text-xs text-neg" role="alert">
              {fieldError("delete")}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} disabled={!canCreate} onClick={create}>
              Add relationship
            </button>
            {!canCreate ? <span className="text-xs text-muted">Choose a source and a target first.</span> : null}
          </div>
          {createError ? (
            <p className="text-xs text-neg" role="alert">
              {createError}
            </p>
          ) : null}
        </div>
      )}

      {/* Linked observations (edit mode only) */}
      {editing ? (
        <div className="border-t border-border pt-3">
          <h4 className="text-sm font-semibold mb-2">Observations linked to this relationship</h4>
          {linkedObservations.length === 0 ? (
            <p className="text-xs text-muted">None linked yet.</p>
          ) : (
            <ul className="space-y-2">
              {linkedObservations.map((o) => (
                <li key={o.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span className="font-mono">{o.id}</span>
                    {o.dateOrPeriod ? <span>· {o.dateOrPeriod}</span> : null}
                    <SourceBadge sourceType={o.sourceType} />
                  </div>
                  <blockquote className="border-l-2 border-border pl-2 mt-0.5">{o.statement}</blockquote>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            <Note>Observations are kept verbatim and are never values. Linking and unlinking is done on the Observations screen.</Note>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Local presentational helpers                                        */
/* ------------------------------------------------------------------ */

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id?: string;
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      {label ? (
        <label htmlFor={id} className="block text-xs font-medium text-muted mb-1">
          {label}
        </label>
      ) : null}
      {children}
      {hint ? <p className="text-xs text-muted mt-1">{hint}</p> : null}
      {error ? (
        <p className="text-xs text-neg mt-1" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Range slider + number input for a 0..1 judgment. The slider commits when
 *  the drag or key press ends so a mutation is not run on every pixel. */
function SliderNumber({
  id,
  value,
  onCommit,
  ariaLabel,
}: {
  id?: string;
  value: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
}) {
  const [local, setLocal] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setLocal(value);
  }
  const [rangeError, setRangeError] = useState<string | null>(null);
  const commitSlider = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={local}
          aria-label={ariaLabel}
          className="flex-1 min-w-0"
          onChange={(e) => setLocal(Number(e.target.value))}
          onPointerUp={commitSlider}
          onKeyUp={commitSlider}
          onBlur={commitSlider}
        />
        <NumberField
          value={value}
          min={0}
          max={1}
          step={0.05}
          className="w-20"
          ariaLabel={`${ariaLabel} as a number`}
          onCommit={(n) => {
            if (n === null) return;
            if (n < 0 || n > 1) {
              setRangeError(`${ariaLabel} must be between 0 and 1.`);
              return;
            }
            setRangeError(null);
            onCommit(n);
          }}
        />
      </div>
      {rangeError ? (
        <p className="text-xs text-neg mt-1" role="alert">
          {rangeError}
        </p>
      ) : null}
    </div>
  );
}

/** Textarea that commits on blur so half-typed text never reaches the model. */
function TextAreaField({
  id,
  value,
  rows,
  onCommit,
  onEdit,
}: {
  id?: string;
  value: string;
  rows: number;
  onCommit: (text: string) => void;
  onEdit?: () => void;
}) {
  const [text, setText] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(value);
  }
  return (
    <textarea
      id={id}
      className="w-full"
      rows={rows}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onEdit?.();
      }}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
    />
  );
}
