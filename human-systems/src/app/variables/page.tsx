"use client";
import { useCallback, useId, useState } from "react";
import { NumberField } from "@/components/fields";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { fmtValue } from "@/components/format";
import { ConfirmButton } from "@/components/system-switcher";
import { Card, CategoryBadge, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import { CATEGORY_META, SOURCE_TYPE_META } from "@/domain/vocabulary";
import { refFor, resolveVariable, type SubjectScope, type VariableDefinition } from "@/model/domain";
import * as mutations from "@/services/mutations";
import {
  ChangeSpeedSchema,
  SourceTypeSchema,
  TargetModeSchema,
  VariableCategorySchema,
  type ChangeSpeed,
  type Member,
  type SourceType,
  type SystemModel,
  type TargetMode,
  type Variable,
  type VariableCategory,
} from "@/types";

const ORDER: VariableCategory[] = ["structure", "asset", "buffer", "dependency", "event", "agency", "person_fit", "constraint", "shock"];

const BTN_PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const CATEGORIES = VariableCategorySchema.options;
const CHANGE_SPEEDS = ChangeSpeedSchema.options;
const TARGET_MODES = TargetModeSchema.options;
const SOURCE_TYPES = SourceTypeSchema.options;
const TARGET_MODE_LABEL: Record<TargetMode, string> = { at_least: "at least (floor)", at_most: "at most (ceiling)", exact: "exact" };

/** Select value meaning "no subject assigned" (stored as null). */
const UNASSIGNED = "";

const UNASSIGNED_TEXT = "subject not assigned — feeds no calculation";

/* ------------------------------------------------------------------ */
/* Subject helpers (display only)                                      */
/* ------------------------------------------------------------------ */

function memberOptionLabel(m: Member): string {
  return m.status === "archived" ? `${m.label} (archived)` : m.label;
}

/** "whole system", the member's label, or a marker for an unknown id. */
function subjectLabel(subjectId: string | null, model: SystemModel): string {
  if (subjectId === null) return "unassigned";
  if (subjectId === model.id) return "whole system";
  const m = model.profile.members.find((x) => x.id === subjectId);
  return m ? memberOptionLabel(m) : `unknown subject (${subjectId})`;
}

/** A subject's scope for the domain's variable definitions. */
function scopeOf(subjectId: string, systemId: string): SubjectScope {
  return subjectId === systemId ? "system" : "member";
}

function UnassignedBadge() {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-warn-soft text-warn" title="Assign a subject so the value can take part in calculations.">
      {UNASSIGNED_TEXT}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Add form: drafts are strings so half-typed numbers never reach the  */
/* model; parsing happens once, on submit.                             */
/* ------------------------------------------------------------------ */

interface VariableDraft {
  name: string;
  description: string;
  /** "" = unassigned; otherwise the system id or a member id. */
  subjectId: string;
  category: VariableCategory;
  changeSpeed: ChangeSpeed;
  unit: string;
  currentValue: string;
  desiredValue: string;
  targetMode: TargetMode;
  sourceType: SourceType;
  confidence: string;
  evidenceText: string;
  controllability: string;
  durability: string;
  estimatedCostToChange: string;
  impact: string;
  rangeMin: string;
  rangeMax: string;
  notes: string;
}

const EMPTY_DRAFT: VariableDraft = {
  name: "",
  description: "",
  subjectId: UNASSIGNED,
  category: "structure",
  changeSpeed: "slow",
  unit: "",
  currentValue: "",
  desiredValue: "",
  targetMode: "exact",
  sourceType: "self_reported",
  confidence: "",
  evidenceText: "",
  controllability: "0.5",
  durability: "0.5",
  estimatedCostToChange: "0.5",
  impact: "",
  rangeMin: "",
  rangeMax: "",
  notes: "",
};

type Bounds = { min?: number; max?: number };

/** Parses a required number field; returns a message when it cannot be used. */
function parseNumber(label: string, text: string, opts: Bounds): { value: number } | { error: string } {
  if (text.trim() === "") return { error: `${label} is needed.` };
  return parseFilled(label, text, opts);
}

/** Parses an optional number field: empty yields null. */
function parseOptionalNumber(label: string, text: string, opts: Bounds): { value: number | null } | { error: string } {
  if (text.trim() === "") return { value: null };
  return parseFilled(label, text, opts);
}

function parseFilled(label: string, text: string, opts: Bounds): { value: number } | { error: string } {
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: `${label} must be a number.` };
  if (opts.min !== undefined && n < opts.min) return { error: `${label} cannot be below ${opts.min}.` };
  if (opts.max !== undefined && n > opts.max) return { error: `${label} cannot be above ${opts.max}.` };
  return { value: n };
}

/** Inline refusal message for one control. */
function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? (
    <div className="text-xs text-neg mt-1" role="alert">
      {msg}
    </div>
  ) : null;
}

function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-muted">
        {label}
      </label>
      {children}
      {hint ? <div className="text-xs text-muted mt-0.5">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function VariablesPage() {
  const { evaluated, apply, updateVariable, lastError, clearError } = useModel();
  const ids = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [errorOwner, setErrorOwner] = useState<string | null>(null);
  const [draft, setDraft] = useState<VariableDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  /** Standard-input card: "" until a subject is chosen (the system id is the default once the model is known). */
  const [standardSubject, setStandardSubject] = useState<string | null>(null);
  const [standardKey, setStandardKey] = useState("");

  const commit = useCallback(
    (owner: string, mutation: ModelMutation): boolean => {
      setErrorOwner(owner);
      return apply(mutation);
    },
    [apply],
  );
  const errorFor = useCallback((owner: string) => (errorOwner === owner && lastError ? lastError : null), [errorOwner, lastError]);

  /** Inline table edits keep using the provider's updateVariable; the owner
   *  is recorded first so a refusal shows beside the row that caused it. */
  const inlineEdit = useCallback(
    (patch: Parameters<typeof updateVariable>[0]) => {
      setErrorOwner(`var:${patch.id}`);
      updateVariable(patch);
    },
    [updateVariable],
  );

  /** Edits to the add form clear both the local validation message and the provider's last refusal. */
  const edit = useCallback(
    (patch: Partial<VariableDraft>) => {
      setDraft((d) => ({ ...d, ...patch }));
      setFormError(null);
      clearError();
    },
    [clearError],
  );

  if (!evaluated) return <Loading />;
  const { model, domain, unassignedVariables } = evaluated;
  const members = model.profile.members;
  const groups = new Map<VariableCategory, Variable[]>();
  for (const v of evaluated.variables) {
    if (!groups.has(v.category)) groups.set(v.category, []);
    groups.get(v.category)!.push(v);
  }
  const inputCount = model.variables.filter((v) => v.kind === "input").length;
  const relationshipsTouching = (id: string) =>
    model.relationships.filter((r) => r.sourceVariableId === id || r.targetVariableId === id).length;

  /* ---- standard inputs from the domain ---- */
  const stdSubject =
    standardSubject !== null && (standardSubject === model.id || members.some((m) => m.id === standardSubject)) ? standardSubject : model.id;
  const stdScope = scopeOf(stdSubject, model.id);
  const isPresentFor = (def: VariableDefinition, subjectId: string) =>
    resolveVariable(evaluated.variables, model.id, refFor(def.key, subjectId, model.id)) !== undefined;
  const standardChoices = domain.variables.filter((def) => def.scope === stdScope && !isPresentFor(def, stdSubject));
  const missingStandardTotal =
    domain.variables.filter((def) => def.scope === "system" && !isPresentFor(def, model.id)).length +
    members
      .filter((m) => m.status === "active")
      .reduce((n, m) => n + domain.variables.filter((def) => def.scope === "member" && !isPresentFor(def, m.id)).length, 0);
  const chosenStandard = standardChoices.find((def) => def.key === standardKey);

  const addStandard = () => {
    if (!chosenStandard) return;
    const def = chosenStandard;
    const ok = commit("var:standard", (m) =>
      mutations.addVariable(m, {
        key: def.key,
        subjectId: stdSubject,
        name: def.name,
        description: def.description,
        category: def.category,
        changeSpeed: def.changeSpeed,
        unit: def.unit,
        targetMode: def.targetMode,
        referenceRange: def.referenceRange,
        currentValue: null,
        desiredValue: null,
        sourceType: "unknown",
        confidence: 0,
      }),
    );
    if (ok) setStandardKey("");
  };

  /* ---- add form ---- */
  const submit = () => {
    const name = draft.name.trim();
    if (!name) return setFormError("A variable needs a name.");
    const unit = draft.unit.trim();
    if (!unit) return setFormError("A unit is needed (for example $/month, months, hours/week, index 0-1).");
    const currentValue = parseOptionalNumber("Current value", draft.currentValue, {});
    if ("error" in currentValue) return setFormError(currentValue.error);
    const desiredValue = parseOptionalNumber("Desired value", draft.desiredValue, {});
    if ("error" in desiredValue) return setFormError(desiredValue.error);
    const confidence = parseNumber("Confidence", draft.confidence, { min: 0, max: 1 });
    if ("error" in confidence) return setFormError(confidence.error);
    const controllability = parseNumber("Controllability", draft.controllability, { min: 0, max: 1 });
    if ("error" in controllability) return setFormError(controllability.error);
    const durability = parseNumber("Durability", draft.durability, { min: 0, max: 1 });
    if ("error" in durability) return setFormError(durability.error);
    const cost = parseNumber("Estimated cost to change", draft.estimatedCostToChange, { min: 0, max: 1 });
    if ("error" in cost) return setFormError(cost.error);
    const impact = parseOptionalNumber("Impact", draft.impact, { min: 0, max: 1 });
    if ("error" in impact) return setFormError(impact.error);
    const rangeMin = parseOptionalNumber("Reference range min", draft.rangeMin, {});
    if ("error" in rangeMin) return setFormError(rangeMin.error);
    const rangeMax = parseOptionalNumber("Reference range max", draft.rangeMax, {});
    if ("error" in rangeMax) return setFormError(rangeMax.error);
    if ((rangeMin.value === null) !== (rangeMax.value === null)) {
      return setFormError("A reference range needs both a min and a max, or neither.");
    }
    if (rangeMin.value !== null && rangeMax.value !== null && rangeMax.value <= rangeMin.value) {
      return setFormError("Reference range max must exceed min.");
    }
    setFormError(null);
    const evidenceText = draft.evidenceText.trim();
    const sourceType = draft.sourceType;
    const referenceRange = rangeMin.value !== null && rangeMax.value !== null ? { min: rangeMin.value, max: rangeMax.value } : undefined;
    const subjectId = draft.subjectId === UNASSIGNED ? null : draft.subjectId;
    const ok = commit("var:add", (m) =>
      mutations.addVariable(m, {
        name,
        subjectId,
        description: draft.description.trim(),
        category: draft.category,
        changeSpeed: draft.changeSpeed,
        unit,
        currentValue: currentValue.value,
        desiredValue: desiredValue.value,
        targetMode: draft.targetMode,
        sourceType,
        confidence: confidence.value,
        evidence: evidenceText ? [{ text: evidenceText, sourceType }] : [],
        controllability: controllability.value,
        durability: durability.value,
        estimatedCostToChange: cost.value,
        ...(impact.value !== null ? { impact: impact.value } : {}),
        ...(referenceRange ? { referenceRange } : {}),
        notes: draft.notes.trim(),
      }),
    );
    if (ok) setDraft(EMPTY_DRAFT);
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div>
      <PageHeader
        title="Structural variables"
        lede="Every variable records whose it is, where its value came from and how confident that value is. Calculated variables cannot be edited directly; change their inputs instead. Desired values are always editable."
      />
      {unassignedVariables.length > 0 ? (
        <div className="mb-4">
          <Note tone="warn">
            {unassignedVariables.length} variable{unassignedVariables.length > 1 ? "s have" : " has"} no subject assigned and feed{unassignedVariables.length > 1 ? "" : "s"} no
            calculation until one is chosen in the Subject column below.
          </Note>
        </div>
      ) : null}
      {inputCount === 0 ? (
        <div className="mb-4">
          <Note>
            No input variables recorded yet. The calculated variables below already exist and fill in from the income list and from inputs added with the form further down.
          </Note>
        </div>
      ) : null}
      <div className="space-y-4">
        {ORDER.filter((c) => groups.has(c)).map((c) => (
          <Card key={c} title={`${CATEGORY_META[c].label} — ${CATEGORY_META[c].description}`}>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Subject</th>
                    <th>Speed</th>
                    <th>Current</th>
                    <th>Desired</th>
                    <th>Unit</th>
                    <th>Provenance</th>
                    <th>Evidence</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {groups.get(c)!.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div className="font-medium">{v.name}</div>
                        {v.description ? <div className="text-xs text-muted max-w-xs">{v.description}</div> : null}
                      </td>
                      <td>
                        {v.kind === "derived" ? (
                          <span className="text-xs text-muted">system (calculated)</span>
                        ) : (
                          <div className="flex flex-col gap-1 items-start">
                            <select
                              aria-label={`Subject of ${v.name}`}
                              className="text-xs"
                              value={v.subjectId ?? UNASSIGNED}
                              onChange={(e) => {
                                const value = e.target.value;
                                commit(`var:${v.id}`, (m) => mutations.assignVariableSubject(m, v.id, value === UNASSIGNED ? null : value));
                              }}
                            >
                              <option value={model.id}>whole system</option>
                              {members.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {memberOptionLabel(m)}
                                </option>
                              ))}
                              <option value={UNASSIGNED}>unassigned</option>
                              {v.subjectId !== null && v.subjectId !== model.id && !members.some((m) => m.id === v.subjectId) ? (
                                <option value={v.subjectId}>{subjectLabel(v.subjectId, model)}</option>
                              ) : null}
                            </select>
                            {v.subjectId === null ? <UnassignedBadge /> : null}
                          </div>
                        )}
                      </td>
                      <td className="text-xs">{v.changeSpeed}</td>
                      <td>
                        {v.kind === "derived" ? (
                          <span className="tabular-nums" title="Calculated; edit its inputs">
                            {fmtValue(v.currentValue, v.unit)}
                          </span>
                        ) : (
                          <NumberField value={v.currentValue} nullable onCommit={(n) => inlineEdit({ id: v.id, currentValue: n })} ariaLabel={`Current ${v.name}`} />
                        )}
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <select
                            aria-label={`Target mode ${v.name}`}
                            className="text-xs w-12 px-1"
                            value={v.targetMode}
                            title="at least (floor) / at most (ceiling) / exact"
                            onChange={(e) => inlineEdit({ id: v.id, targetMode: e.target.value as typeof v.targetMode })}
                          >
                            <option value="at_least">≥</option>
                            <option value="at_most">≤</option>
                            <option value="exact">=</option>
                          </select>
                          <NumberField value={v.desiredValue} nullable onCommit={(n) => inlineEdit({ id: v.id, desiredValue: n })} ariaLabel={`Desired ${v.name}`} />
                        </div>
                        <ErrorLine msg={errorFor(`var:${v.id}`)} />
                      </td>
                      <td className="text-xs text-muted">{v.unit}</td>
                      <td>
                        <div className="flex flex-col gap-1 items-start">
                          <SourceBadge sourceType={v.sourceType} />
                          <ConfidenceBadge confidence={v.confidence} />
                          <CategoryBadge category={v.category} />
                        </div>
                      </td>
                      <td className="text-xs">
                        {v.kind === "derived" ? (
                          <span className="text-muted">formula {v.formulaId}</span>
                        ) : v.evidence.length === 0 ? (
                          <span className="text-neg">none recorded</span>
                        ) : (
                          <button type="button" className="underline" onClick={() => setOpen(open === v.id ? null : v.id)}>
                            {v.evidence.length} item{v.evidence.length > 1 ? "s" : ""}
                          </button>
                        )}
                        {open === v.id ? (
                          <ul className="mt-1 space-y-1 max-w-xs">
                            {v.evidence.map((e, i) => (
                              <li key={i}>
                                <SourceBadge sourceType={e.sourceType} /> {e.text}
                              </li>
                            ))}
                            {v.notes ? <li className="text-muted">Note: {v.notes}</li> : null}
                          </ul>
                        ) : null}
                      </td>
                      <td>
                        {v.kind === "derived" ? (
                          <span className="text-xs text-muted">calculated — cannot be removed</span>
                        ) : (
                          <ConfirmButton
                            label="Remove"
                            confirmLabel="Remove variable"
                            message={`Remove ${v.name}? This also removes ${
                              relationshipsTouching(v.id) === 0
                                ? "any relationships touching it (none today)"
                                : `the ${relationshipsTouching(v.id)} relationship${relationshipsTouching(v.id) > 1 ? "s" : ""} touching it`
                            } and clears links to it from observations and actions.`}
                            onConfirm={() => commit(`var:${v.id}`, (m) => mutations.removeVariable(m, v.id))}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-4">
        <Card title="Add a standard input from the domain">
          <p className="text-xs text-muted mb-2">
            The {domain.name} domain defines its inputs by key and subject: household-level keys belong to the whole system, per-person keys to one member. The calculated
            variables and the compounding step models read them through those keys. Adding one here creates it with NO value and no provenance; enter the value in the table
            once it exists. Standard inputs not yet present for the whole system and its active members: {missingStandardTotal}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${ids}-standard-subject`} className="text-sm">
              Subject
            </label>
            <select
              id={`${ids}-standard-subject`}
              value={stdSubject}
              onChange={(e) => {
                clearError();
                setStandardSubject(e.target.value);
                setStandardKey("");
              }}
            >
              <option value={model.id}>whole system</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {memberOptionLabel(m)}
                </option>
              ))}
            </select>
            <label htmlFor={`${ids}-standard`} className="text-sm">
              Standard input
            </label>
            <select
              id={`${ids}-standard`}
              value={chosenStandard ? standardKey : ""}
              onChange={(e) => {
                clearError();
                setStandardKey(e.target.value);
              }}
            >
              <option value="">{standardChoices.length === 0 ? `none missing for ${subjectLabel(stdSubject, model)}` : "Choose…"}</option>
              {standardChoices.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name} ({d.unit})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded border border-border bg-background px-2 py-1 text-sm disabled:opacity-50"
              disabled={!chosenStandard}
              onClick={addStandard}
            >
              Add with no value yet
            </button>
            <ErrorLine msg={errorFor("var:standard")} />
          </div>
          {chosenStandard ? <p className="text-xs text-muted mt-2">{chosenStandard.description}</p> : null}
        </Card>
      </div>

      <div className="mt-4">
        <Card title="Add structural variable">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field id={`${ids}-name`} label="Name">
              <input
                id={`${ids}-name`}
                type="text"
                className="w-full"
                placeholder="e.g. Rent as share of income"
                value={draft.name}
                onChange={(e) => edit({ name: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-subject`} label="Subject" hint="Whose variable this is. Unassigned variables are kept but feed no calculation.">
              <select id={`${ids}-subject`} className="w-full" value={draft.subjectId} onChange={(e) => edit({ subjectId: e.target.value })}>
                <option value={UNASSIGNED}>unassigned</option>
                <option value={model.id}>whole system</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {memberOptionLabel(m)}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${ids}-description`} label="Description (optional)">
              <input
                id={`${ids}-description`}
                type="text"
                className="w-full"
                value={draft.description}
                onChange={(e) => edit({ description: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-category`} label="Category" hint={CATEGORY_META[draft.category].description}>
              <select id={`${ids}-category`} className="w-full" value={draft.category} onChange={(e) => edit({ category: e.target.value as VariableCategory })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_META[c].label}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${ids}-speed`} label="Change speed">
              <select id={`${ids}-speed`} className="w-full" value={draft.changeSpeed} onChange={(e) => edit({ changeSpeed: e.target.value as ChangeSpeed })}>
                {CHANGE_SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${ids}-unit`} label="Unit" hint="e.g. $/month, months, hours/week, index 0-1, count.">
              <input id={`${ids}-unit`} type="text" className="w-full" value={draft.unit} onChange={(e) => edit({ unit: e.target.value })} onKeyDown={onEnter} />
            </Field>

            <Field id={`${ids}-current`} label="Current value" hint="Leave empty when unknown.">
              <input
                id={`${ids}-current`}
                type="number"
                className="w-full tabular-nums"
                value={draft.currentValue}
                onChange={(e) => edit({ currentValue: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-desired`} label="Desired value" hint="Leave empty when no target is set yet.">
              <input
                id={`${ids}-desired`}
                type="number"
                className="w-full tabular-nums"
                value={draft.desiredValue}
                onChange={(e) => edit({ desiredValue: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-target-mode`} label="Target mode" hint="How the desired value is meant.">
              <select id={`${ids}-target-mode`} className="w-full" value={draft.targetMode} onChange={(e) => edit({ targetMode: e.target.value as TargetMode })}>
                {TARGET_MODES.map((t) => (
                  <option key={t} value={t}>
                    {TARGET_MODE_LABEL[t]}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${ids}-source`} label="Source type" hint={SOURCE_TYPE_META[draft.sourceType].description}>
              <select id={`${ids}-source`} className="w-full" value={draft.sourceType} onChange={(e) => edit({ sourceType: e.target.value as SourceType })}>
                {SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SOURCE_TYPE_META[t].label}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${ids}-confidence`} label="Confidence (0–1)" hint="Confidence in the current value.">
              <input
                id={`${ids}-confidence`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-full tabular-nums"
                value={draft.confidence}
                onChange={(e) => edit({ confidence: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-evidence`} label="First evidence line (optional)" hint="Recorded with the source type chosen above.">
              <input
                id={`${ids}-evidence`}
                type="text"
                className="w-full"
                value={draft.evidenceText}
                onChange={(e) => edit({ evidenceText: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-controllability`} label="Controllability (0–1)" hint="Ordinal judgment; 0.5 when unsure.">
              <input
                id={`${ids}-controllability`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-full tabular-nums"
                value={draft.controllability}
                onChange={(e) => edit({ controllability: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-durability`} label="Durability (0–1)" hint="Ordinal judgment; 0.5 when unsure.">
              <input
                id={`${ids}-durability`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-full tabular-nums"
                value={draft.durability}
                onChange={(e) => edit({ durability: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-cost`} label="Estimated cost to change (0–1)" hint="Ordinal judgment; 0.5 when unsure.">
              <input
                id={`${ids}-cost`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-full tabular-nums"
                value={draft.estimatedCostToChange}
                onChange={(e) => edit({ estimatedCostToChange: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-impact`} label="Impact (0–1, optional)" hint="Leverage is only computed when this is present.">
              <input
                id={`${ids}-impact`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-full tabular-nums"
                value={draft.impact}
                onChange={(e) => edit({ impact: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-range-min`} label="Reference range (optional)" hint="A plausible band, min and max together, used to normalise gaps.">
              <div className="flex items-center gap-1">
                <input
                  id={`${ids}-range-min`}
                  type="number"
                  className="w-full tabular-nums"
                  aria-label="Reference range min"
                  placeholder="min"
                  value={draft.rangeMin}
                  onChange={(e) => edit({ rangeMin: e.target.value })}
                  onKeyDown={onEnter}
                />
                <span className="text-xs text-muted">to</span>
                <input
                  type="number"
                  className="w-full tabular-nums"
                  aria-label="Reference range max"
                  placeholder="max"
                  value={draft.rangeMax}
                  onChange={(e) => edit({ rangeMax: e.target.value })}
                  onKeyDown={onEnter}
                />
              </div>
            </Field>

            <Field id={`${ids}-notes`} label="Notes (optional)">
              <input id={`${ids}-notes`} type="text" className="w-full" value={draft.notes} onChange={(e) => edit({ notes: e.target.value })} onKeyDown={onEnter} />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={submit}>
              Add structural variable
            </button>
            {formError ? (
              <span className="text-xs text-neg" role="alert">
                {formError}
              </span>
            ) : null}
            {errorFor("var:add") ? (
              <span className="text-xs text-neg" role="alert">
                {errorFor("var:add")}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted mt-2">
            Adds an input variable keyed by a slug of its name. Calculated variables come only from their formulas and cannot be added here.
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Note>Confidence on a calculated variable is the minimum confidence of its inputs (assumption A13).</Note>
      </div>
    </div>
  );
}
