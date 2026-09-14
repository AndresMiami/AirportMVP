"use client";
/**
 * Create/edit form for ONE constraint. It holds a local draft and hands
 * back plain values on submit; the page turns them into a mutation
 * (services/mutations addConstraint / updateConstraint). Display and
 * input only: no model logic lives here.
 */
import { useId, useState, type ReactNode } from "react";
import { NumberField } from "@/components/fields";
import { fmtConfidence, fmtPct } from "@/components/format";
import { SourceBadge } from "@/components/ui";
import { SOURCE_TYPE_META, confidenceLabel } from "@/domain/vocabulary";
import type { ConstraintInput } from "@/services/mutations";
import {
  SourceTypeSchema,
  type Constraint,
  type ConstraintCheck,
  type ConstraintType,
  type Evidence,
  type SourceType,
} from "@/types";

/* ------------------------------------------------------------------ */
/* Display helpers (pure, exported for the Constraints screen)         */
/* ------------------------------------------------------------------ */

export type ConstraintComparator = ConstraintCheck["comparator"];

export const COMPARATOR_SYMBOL: Record<ConstraintComparator, string> = { lte: "≤", gte: "≥", eq: "=" };

const COMPARATOR_WORDS: Record<ConstraintComparator, string> = { lte: "at most", gte: "at least", eq: "exactly" };

/** One-line meaning shown next to each type wherever it appears. */
export const TYPE_MEANING: Record<ConstraintType, string> = {
  hard: "excludes actions",
  soft: "lowers suitability, never excludes",
};

/** Dimension keys actions declare requirements on (see the sample fixture). */
export const DIMENSION_SUGGESTIONS = [
  "hoursPerWeek",
  "capitalRequired",
  "requiresRelocation",
  "requiresDriving",
  "requiresLicense",
  "heavyLifting",
  "physicalDemand",
  "riskLevel",
  "minimumMonthlyIncome",
] as const;

function limitWord(limit: number | boolean): string {
  return typeof limit === "boolean" ? (limit ? "yes" : "no") : String(limit);
}

/** A machine check in words, e.g. "hoursPerWeek ≤ 8" or "requiresDriving = no". */
export function describeCheck(check: ConstraintCheck): string {
  const base = `${check.dimension} ${COMPARATOR_SYMBOL[check.comparator]} ${limitWord(check.limit)}`;
  if (typeof check.limit === "boolean" && check.comparator !== "eq") {
    return `${base} (a yes/no limit is only checked with =)`;
  }
  return base;
}

/** What the check asks of an action, in a sentence fragment. */
export function explainCheck(check: ConstraintCheck): string {
  const target =
    typeof check.limit === "boolean" ? limitWord(check.limit) : `${COMPARATOR_WORDS[check.comparator]} ${check.limit}`;
  return `an action's ${check.dimension} requirement must be ${target}`;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export interface ConstraintTemplate {
  label: string;
  name: string;
  description: string;
  type: ConstraintType;
  /** limit null = the person supplies the number after prefill. */
  check?: { dimension: string; comparator: ConstraintComparator; limit: number | boolean | null };
  softPenalty?: number;
}

export const CONSTRAINT_TEMPLATES: ConstraintTemplate[] = [
  {
    label: "Physical limitation",
    name: "No sustained heavy lifting",
    description: "A physical demand the person cannot take on (as stated; not diagnosed here).",
    type: "hard",
    check: { dimension: "heavyLifting", comparator: "eq", limit: false },
  },
  {
    label: "Available hours",
    name: "Available hours per week",
    description: "Hours that can be committed each week after existing obligations.",
    type: "hard",
    check: { dimension: "hoursPerWeek", comparator: "lte", limit: null },
  },
  {
    label: "Minimum required income",
    name: "Minimum required income",
    description: "An option has to bring in at least this much per month.",
    type: "hard",
    check: { dimension: "minimumMonthlyIncome", comparator: "gte", limit: null },
  },
  {
    label: "Transportation requirement",
    name: "No driving required",
    description: "Options that depend on driving are not available (no vehicle, no licence, or the person does not drive).",
    type: "hard",
    check: { dimension: "requiresDriving", comparator: "eq", limit: false },
  },
  {
    label: "Licensing requirement",
    name: "No licence held",
    description: "Options that need a licence or certification the person does not hold.",
    type: "hard",
    check: { dimension: "requiresLicense", comparator: "eq", limit: false },
  },
  {
    label: "Startup capital limit",
    name: "Startup capital limit",
    description: "Upfront money that can be committed without consuming the reserve.",
    type: "hard",
    check: { dimension: "capitalRequired", comparator: "lte", limit: null },
  },
  {
    label: "Location",
    name: "No relocation",
    description: "The household stays where it is; options that require moving are out.",
    type: "hard",
    check: { dimension: "requiresRelocation", comparator: "eq", limit: false },
  },
  {
    label: "Family responsibility",
    name: "Family responsibility",
    description: "A recurring obligation the model cannot check yet; listed as unchecked for every action.",
    type: "hard",
  },
  {
    label: "Risk tolerance",
    name: "Prefers predictable income",
    description: "Options with higher income risk are less suitable, not excluded.",
    type: "soft",
    check: { dimension: "riskLevel", comparator: "lte", limit: 0.4 },
    softPenalty: 0.4,
  },
];

/* ------------------------------------------------------------------ */
/* Draft                                                               */
/* ------------------------------------------------------------------ */

/** What the form hands back; the page passes it to a mutation. */
export type ConstraintFormValues = Omit<ConstraintInput, "id">;

type LimitKind = "number" | "boolean";

interface Draft {
  name: string;
  description: string;
  type: ConstraintType;
  hasCheck: boolean;
  dimension: string;
  comparator: ConstraintComparator;
  limitKind: LimitKind;
  limitNumber: number | null;
  limitBoolean: boolean;
  softPenalty: number;
  sourceType: SourceType;
  confidence: number;
  evidence: Evidence[];
  userConfirmed: boolean;
  notes: string;
}

function checkFields(check: { dimension: string; comparator: ConstraintComparator; limit: number | boolean | null } | undefined) {
  return {
    hasCheck: check !== undefined,
    dimension: check?.dimension ?? "",
    comparator: check?.comparator ?? "lte",
    limitKind: (check && typeof check.limit === "boolean" ? "boolean" : "number") as LimitKind,
    limitNumber: check && typeof check.limit === "number" ? check.limit : null,
    limitBoolean: check && typeof check.limit === "boolean" ? check.limit : false,
  };
}

function draftFrom(initial?: Constraint): Draft {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    type: initial?.type ?? "hard",
    ...checkFields(initial?.check),
    softPenalty: initial?.softPenalty ?? 0.5,
    sourceType: initial?.sourceType ?? "self_reported",
    confidence: initial?.confidence ?? 0.5,
    evidence: initial?.evidence ?? [],
    userConfirmed: initial?.userConfirmed ?? false,
    notes: initial?.notes ?? "",
  };
}

function applyTemplate(d: Draft, t: ConstraintTemplate): Draft {
  return {
    ...d,
    name: t.name,
    description: t.description,
    type: t.type,
    ...checkFields(t.check),
    softPenalty: t.softPenalty ?? d.softPenalty,
  };
}

/** The check the draft currently describes, or null while incomplete. */
function checkFromDraft(d: Draft): ConstraintCheck | null {
  if (!d.hasCheck) return null;
  const dimension = d.dimension.trim();
  if (!dimension) return null;
  if (d.limitKind === "boolean") return { dimension, comparator: "eq", limit: d.limitBoolean };
  if (d.limitNumber === null) return null;
  return { dimension, comparator: d.comparator, limit: d.limitNumber };
}

const looksBoolean = (dimension: string) => /^requires/i.test(dimension.trim());

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SECONDARY = "rounded border border-border px-3 py-1.5 text-sm hover:bg-background disabled:opacity-50";

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
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

export function ConstraintForm({
  initial,
  onSubmit,
  onCancel,
  error = null,
  onEdit,
  submitLabel,
}: {
  /** The constraint being edited; absent when creating. */
  initial?: Constraint;
  onSubmit: (values: ConstraintFormValues) => void;
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
  const [evidenceText, setEvidenceText] = useState("");
  const [evidenceSource, setEvidenceSource] = useState<SourceType>("self_reported");

  const update = (patch: Partial<Draft> | ((d: Draft) => Draft)) => {
    setDraft((d) => (typeof patch === "function" ? patch(d) : { ...d, ...patch }));
    setLocalError(null);
    onEdit?.();
  };

  const setDimension = (dimension: string) =>
    update((d) => {
      // A "requires…" dimension is a yes/no question; switch once, on the
      // transition, so a person who chose "number" on purpose keeps it.
      if (looksBoolean(dimension) && !looksBoolean(d.dimension)) {
        return { ...d, dimension, limitKind: "boolean", comparator: "eq" };
      }
      return { ...d, dimension };
    });

  const setLimitKind = (limitKind: LimitKind) =>
    update(limitKind === "boolean" ? { limitKind, comparator: "eq" } : { limitKind });

  const addEvidence = () => {
    const text = evidenceText.trim();
    if (!text) return;
    const recordedAt = new Date().toISOString().slice(0, 10);
    update((d) => ({ ...d, evidence: [...d.evidence, { text, sourceType: evidenceSource, recordedAt }] }));
    setEvidenceText("");
  };

  const removeEvidence = (index: number) =>
    update((d) => ({ ...d, evidence: d.evidence.filter((_, i) => i !== index) }));

  const submit = () => {
    const name = draft.name.trim();
    if (!name) {
      setLocalError("A constraint needs a name.");
      return;
    }
    let check: ConstraintCheck | undefined;
    if (draft.hasCheck) {
      if (!draft.dimension.trim()) {
        setLocalError("Enter the dimension the check applies to, or turn the check off.");
        return;
      }
      const built = checkFromDraft(draft);
      if (!built) {
        setLocalError("Enter the limit as a number, or turn the check off.");
        return;
      }
      check = built;
    }
    setLocalError(null);
    onSubmit({
      name,
      description: draft.description.trim(),
      type: draft.type,
      check,
      softPenalty: draft.softPenalty,
      sourceType: draft.sourceType,
      confidence: draft.confidence,
      evidence: draft.evidence,
      userConfirmed: draft.userConfirmed,
      notes: draft.notes.trim(),
    });
  };

  const preview = checkFromDraft(draft);
  const listId = `${ids}-dimensions`;
  const sourceOptions = SourceTypeSchema.options.filter((s) => s !== "calculated" || s === draft.sourceType);

  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="text-xs text-muted mb-1">Quick start — prefills name, description, type and check; everything can be changed afterwards.</div>
        <div className="flex flex-wrap gap-1.5">
          {CONSTRAINT_TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent-soft"
              title={t.check ? `${t.type}: ${t.check.dimension} ${COMPARATOR_SYMBOL[t.check.comparator]} ${t.check.limit === null ? "n" : limitWord(t.check.limit)}` : `${t.type}, descriptive (no check)`}
              onClick={() => update((d) => applyTemplate(d, t))}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <Field label="Name" htmlFor={`${ids}-name`}>
        <input id={`${ids}-name`} type="text" className="w-full max-w-md" value={draft.name} onChange={(e) => update({ name: e.target.value })} />
      </Field>

      <Field label="Description" htmlFor={`${ids}-description`}>
        <textarea id={`${ids}-description`} className="w-full max-w-xl" rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} />
      </Field>

      <Field label="Type">
        <div className="flex flex-col gap-1">
          {(["hard", "soft"] as const).map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="radio" name={`${ids}-type`} checked={draft.type === t} onChange={() => update({ type: t })} />
              <span className="font-medium capitalize">{t}</span>
              <span className="text-muted">— {TYPE_MEANING[t]}</span>
            </label>
          ))}
        </div>
      </Field>

      {draft.type === "soft" ? (
        <Field label="Soft penalty" htmlFor={`${ids}-penalty`} hint="How much one violation lowers suitability.">
          <div className="flex items-center gap-3">
            <input
              id={`${ids}-penalty`}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.softPenalty}
              onChange={(e) => update({ softPenalty: Number(e.target.value) })}
            />
            <span className="tabular-nums">{fmtPct(draft.softPenalty)}</span>
            <span className="text-xs text-muted">a violation multiplies suitability by {(1 - draft.softPenalty).toFixed(2)}</span>
          </div>
        </Field>
      ) : null}

      <Field label="Machine check">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.hasCheck} onChange={(e) => update({ hasCheck: e.target.checked })} />
          Can the model check this against an action?
        </label>
        {draft.hasCheck ? (
          <div className="mt-2">
            <div className="grid gap-2 sm:grid-cols-[minmax(10rem,1fr)_auto_auto]">
              <div>
                <label htmlFor={`${ids}-dimension`} className="block text-xs text-muted">
                  Dimension
                </label>
                <input
                  id={`${ids}-dimension`}
                  type="text"
                  list={listId}
                  className="w-full font-mono"
                  placeholder="e.g. hoursPerWeek"
                  value={draft.dimension}
                  onChange={(e) => setDimension(e.target.value)}
                />
                <datalist id={listId}>
                  {DIMENSION_SUGGESTIONS.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              </div>
              <div>
                <label htmlFor={`${ids}-comparator`} className="block text-xs text-muted">
                  Comparator
                </label>
                <select
                  id={`${ids}-comparator`}
                  value={draft.limitKind === "boolean" ? "eq" : draft.comparator}
                  disabled={draft.limitKind === "boolean"}
                  title={draft.limitKind === "boolean" ? "A yes/no limit is only checked with =" : undefined}
                  onChange={(e) => update({ comparator: e.target.value as ConstraintComparator })}
                >
                  <option value="lte">≤ at most</option>
                  <option value="gte">≥ at least</option>
                  <option value="eq">= exactly</option>
                </select>
              </div>
              <div>
                <span className="block text-xs text-muted">Limit</span>
                <div className="flex items-center gap-1">
                  <select aria-label="Limit kind" value={draft.limitKind} onChange={(e) => setLimitKind(e.target.value === "boolean" ? "boolean" : "number")}>
                    <option value="number">number</option>
                    <option value="boolean">yes / no</option>
                  </select>
                  {draft.limitKind === "number" ? (
                    <NumberField value={draft.limitNumber} nullable onCommit={(n) => update({ limitNumber: n })} ariaLabel="Limit" />
                  ) : (
                    <select aria-label="Limit (yes or no)" value={draft.limitBoolean ? "yes" : "no"} onChange={(e) => update({ limitBoolean: e.target.value === "yes" })}>
                      <option value="no">no</option>
                      <option value="yes">yes</option>
                    </select>
                  )}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted mt-1">
              {preview ? (
                <>
                  Reads as <span className="font-mono">{describeCheck(preview)}</span>: {explainCheck(preview)}.
                </>
              ) : (
                "Enter a dimension and a limit to see how the check reads."
              )}{" "}
              Actions that do not declare this dimension are reported as unverified, not as violations.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted mt-1">Descriptive only: listed as unchecked for every action.</p>
        )}
      </Field>

      <Field label="Source" htmlFor={`${ids}-source`}>
        <select id={`${ids}-source`} value={draft.sourceType} onChange={(e) => update({ sourceType: e.target.value as SourceType })}>
          {sourceOptions.map((s) => (
            <option key={s} value={s}>
              {SOURCE_TYPE_META[s].label}
            </option>
          ))}
        </select>
        <span className="ml-2 text-xs text-muted">{SOURCE_TYPE_META[draft.sourceType].description}</span>
      </Field>

      <Field label="Confidence" htmlFor={`${ids}-confidence`} hint="How sure the statement itself is.">
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

      <Field label="Evidence">
        {draft.evidence.length === 0 ? (
          <p className="text-xs text-muted">None recorded.</p>
        ) : (
          <ul className="space-y-1">
            {draft.evidence.map((e, i) => (
              <li key={i} className="flex items-start gap-2">
                <SourceBadge sourceType={e.sourceType} />
                <span className="flex-1">
                  {e.text}
                  {e.recordedAt ? <span className="text-xs text-muted"> ({e.recordedAt})</span> : null}
                </span>
                <button type="button" className="text-xs underline text-muted" onClick={() => removeEvidence(i)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <input
            type="text"
            className="flex-1 min-w-[12rem]"
            aria-label="New evidence"
            placeholder="What was seen, said or read"
            value={evidenceText}
            onChange={(e) => setEvidenceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addEvidence();
              }
            }}
          />
          <select aria-label="Evidence source" value={evidenceSource} onChange={(e) => setEvidenceSource(e.target.value as SourceType)}>
            {SourceTypeSchema.options
              .filter((s) => s !== "calculated")
              .map((s) => (
                <option key={s} value={s}>
                  {SOURCE_TYPE_META[s].label}
                </option>
              ))}
          </select>
          <button type="button" className={SECONDARY} disabled={evidenceText.trim().length === 0} onClick={addEvidence}>
            Add evidence
          </button>
        </div>
      </Field>

      <Field label="Confirmed">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.userConfirmed} onChange={(e) => update({ userConfirmed: e.target.checked })} />
          I confirm this applies
        </label>
        {!draft.userConfirmed ? <p className="text-xs text-muted mt-1">Until confirmed, violations on the Leverage screen carry a &ldquo;not confirmed&rdquo; note.</p> : null}
      </Field>

      <Field label="Notes" htmlFor={`${ids}-notes`}>
        <textarea id={`${ids}-notes`} className="w-full max-w-xl" rows={2} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" className={PRIMARY} onClick={submit}>
          {submitLabel ?? (initial ? "Save changes" : "Add constraint")}
        </button>
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
        {localError ? <span className="text-xs text-neg">{localError}</span> : null}
        {error ? <span className="text-xs text-neg">{error}</span> : null}
      </div>
    </div>
  );
}
