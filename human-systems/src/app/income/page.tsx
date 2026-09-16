"use client";
import { useCallback, useId, useState } from "react";
import { NumberField } from "@/components/fields";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { fmtValue } from "@/components/format";
import { ConfirmButton } from "@/components/system-switcher";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge, Stat } from "@/components/ui";
import { SOURCE_TYPE_META } from "@/domain/vocabulary";
import { DERIVED_IDS } from "@/domains/household/keys";
import { incomeShares } from "@/domains/household/calculations";
import { addIncomeSource, incomeSourcesOf, removeIncomeSource, updateIncomeSource as updateIncomeSourceMutation } from "@/features/household/income";
import type { IncomeSource } from "@/domains/household/income";
import { resolveVariable, systemRef } from "@/model/domain";
import { SourceTypeSchema, type Member, type SourceType } from "@/types";

const SUMMARY = [
  DERIVED_IDS.totalIncome,
  DERIVED_IDS.reliableFloor,
  DERIVED_IDS.incomeConcentration,
  DERIVED_IDS.failureCorrelation,
  DERIVED_IDS.incomeVolatility,
  DERIVED_IDS.replacementLatency,
];

const BTN_PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SOURCE_TYPES = SourceTypeSchema.options;

/** Select value meaning "not attributed to any member" (stored as null). */
const UNASSIGNED = "";

function memberOptionLabel(m: Member): string {
  return m.status === "archived" ? `${m.label} (archived)` : m.label;
}

function UnassignedTag() {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-warn-soft text-warn" title="No member is recorded as the earner.">
      unassigned
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Add form: drafts are strings so half-typed numbers never reach the  */
/* model; parsing happens once, on submit.                             */
/* ------------------------------------------------------------------ */

interface IncomeDraft {
  name: string;
  /** "" = unassigned; otherwise a member id. */
  earnerId: string;
  monthlyAmount: string;
  reliability: string;
  volatility: string;
  correlationGroup: string;
  replacementLatencyMonths: string;
  sourceType: SourceType;
  confidence: string;
  evidenceText: string;
  notes: string;
}

const EMPTY_DRAFT: IncomeDraft = {
  name: "",
  earnerId: UNASSIGNED,
  monthlyAmount: "",
  reliability: "",
  volatility: "",
  correlationGroup: "",
  replacementLatencyMonths: "",
  sourceType: "self_reported",
  confidence: "",
  evidenceText: "",
  notes: "",
};

/** Parses a required number field; returns a message when it cannot be used. */
function parseNumber(label: string, text: string, opts: { min?: number; max?: number }): { value: number } | { error: string } {
  if (text.trim() === "") return { error: `${label} is needed.` };
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

export default function IncomePage() {
  const { evaluated, apply, lastError, clearError } = useModel();
  const ids = useId();
  const [errorOwner, setErrorOwner] = useState<string | null>(null);
  const [draft, setDraft] = useState<IncomeDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);

  const commit = useCallback(
    (owner: string, mutation: ModelMutation): boolean => {
      setErrorOwner(owner);
      return apply(mutation);
    },
    [apply],
  );
  const errorFor = useCallback((owner: string) => (errorOwner === owner && lastError ? lastError : null), [errorOwner, lastError]);

  /** Inline table edits go through the household wrapper over the generic
   *  collection tools; the owner is recorded first so a refusal shows
   *  beside the row that caused it. */
  const inlineEdit = useCallback(
    (id: string, patch: Partial<IncomeSource> & { id: string }) => {
      setErrorOwner(`income:${id}`);
      const { id: _id, ...rest } = patch;
      void _id;
      apply((m) => updateIncomeSourceMutation(m, id, rest));
    },
    [apply],
  );
  const incomeSources = evaluated ? incomeSourcesOf(evaluated.model) : [];

  /** Edits to the add form clear both the local validation message and the provider's last refusal. */
  const edit = useCallback(
    (patch: Partial<IncomeDraft>) => {
      setDraft((d) => ({ ...d, ...patch }));
      setFormError(null);
      clearError();
    },
    [clearError],
  );

  if (!evaluated) return <Loading />;
  const { model } = evaluated;
  const members = model.profile.members;
  const memberById = new Map(members.map((m) => [m.id, m]));
  const shares = new Map(incomeShares(incomeSources).map((s) => [s.id, s.share]));
  const existingGroups = Array.from(new Set(incomeSources.map((s) => s.correlationGroup))).sort();
  const earnerLabel = (earnerId: string | null, fallback: string) => {
    if (earnerId === null) return fallback;
    const m = memberById.get(earnerId);
    return m ? memberOptionLabel(m) : `unknown member (${earnerId})`;
  };

  const setEarner = (id: string, value: string) => {
    const earnerId = value === UNASSIGNED ? null : value;
    inlineEdit(id, { id, earnerId, earner: earnerId === null ? "" : (memberById.get(earnerId)?.label ?? "") });
  };

  const submit = () => {
    const name = draft.name.trim();
    if (!name) return setFormError("A source needs a name.");
    const correlationGroup = draft.correlationGroup.trim();
    if (!correlationGroup) return setFormError("A failure group is needed; sources in the same group are assumed to disappear together.");
    const monthlyAmount = parseNumber("Monthly amount", draft.monthlyAmount, { min: 0 });
    if ("error" in monthlyAmount) return setFormError(monthlyAmount.error);
    const reliability = parseNumber("Reliability", draft.reliability, { min: 0, max: 1 });
    if ("error" in reliability) return setFormError(reliability.error);
    const volatility = parseNumber("Volatility", draft.volatility, { min: 0, max: 1 });
    if ("error" in volatility) return setFormError(volatility.error);
    const latency = parseNumber("Replacement latency", draft.replacementLatencyMonths, { min: 0 });
    if ("error" in latency) return setFormError(latency.error);
    const confidence = parseNumber("Confidence", draft.confidence, { min: 0, max: 1 });
    if ("error" in confidence) return setFormError(confidence.error);
    setFormError(null);
    const evidenceText = draft.evidenceText.trim();
    const sourceType = draft.sourceType;
    const earnerId = draft.earnerId === UNASSIGNED ? null : draft.earnerId;
    const ok = commit("income:add", (m) =>
      addIncomeSource(m, {
        name,
        earnerId,
        earner: earnerId === null ? "" : (memberById.get(earnerId)?.label ?? ""),
        monthlyAmount: monthlyAmount.value,
        reliability: reliability.value,
        volatility: volatility.value,
        correlationGroup,
        replacementLatencyMonths: latency.value,
        sourceType,
        confidence: confidence.value,
        evidence: evidenceText ? [{ text: evidenceText, sourceType }] : [],
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
        title="Income sources"
        lede="Each source carries its own reliability, volatility and failure group, and names the member who earns it. The household-level numbers below are calculated from this list, never entered directly."
      />
      <Card title={`Sources (${incomeSources.length})`}>
        {incomeSources.length === 0 ? (
          <p className="text-sm text-muted">No income sources recorded yet. The calculated household numbers fill in once one is added below.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Earner</th>
                  <th>$/month</th>
                  <th>Share</th>
                  <th>Reliability</th>
                  <th>Volatility</th>
                  <th>Failure group</th>
                  <th>Replace (months)</th>
                  <th>Provenance</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {incomeSources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="font-medium">{s.name}</div>
                      {s.notes ? <div className="text-xs text-muted">{s.notes}</div> : null}
                    </td>
                    <td>
                      <div className="flex flex-col gap-1 items-start">
                        <div className="text-xs flex flex-wrap items-center gap-1">
                          {s.earnerId === null ? (
                            <>
                              <UnassignedTag />
                              {s.earner ? <span className="text-muted">{s.earner}</span> : null}
                            </>
                          ) : (
                            <span>{earnerLabel(s.earnerId, "")}</span>
                          )}
                        </div>
                        <select aria-label={`Earner of ${s.name}`} className="text-xs" value={s.earnerId ?? UNASSIGNED} onChange={(e) => setEarner(s.id, e.target.value)}>
                          <option value={UNASSIGNED}>unassigned</option>
                          {members.map((m) => (
                            <option key={m.id} value={m.id}>
                              {memberOptionLabel(m)}
                            </option>
                          ))}
                          {s.earnerId !== null && !memberById.has(s.earnerId) ? <option value={s.earnerId}>{earnerLabel(s.earnerId, "")}</option> : null}
                        </select>
                      </div>
                    </td>
                    <td>
                      <NumberField
                        value={s.monthlyAmount}
                        min={0}
                        ariaLabel={`Monthly amount of ${s.name}`}
                        onCommit={(v) => inlineEdit(s.id, { id: s.id, monthlyAmount: v ?? 0 })}
                      />
                    </td>
                    <td className="tabular-nums">{((shares.get(s.id) ?? 0) * 100).toFixed(0)}%</td>
                    <td>
                      <NumberField
                        value={s.reliability}
                        min={0}
                        max={1}
                        step={0.05}
                        ariaLabel={`Reliability of ${s.name}`}
                        onCommit={(v) => inlineEdit(s.id, { id: s.id, reliability: v ?? 0 })}
                        className="w-20"
                      />
                    </td>
                    <td>
                      <NumberField
                        value={s.volatility}
                        min={0}
                        max={1}
                        step={0.05}
                        ariaLabel={`Volatility of ${s.name}`}
                        onCommit={(v) => inlineEdit(s.id, { id: s.id, volatility: v ?? 0 })}
                        className="w-20"
                      />
                    </td>
                    <td className="font-mono text-xs">{s.correlationGroup}</td>
                    <td>
                      <NumberField
                        value={s.replacementLatencyMonths}
                        min={0}
                        step={0.5}
                        ariaLabel={`Replacement latency of ${s.name}`}
                        onCommit={(v) => inlineEdit(s.id, { id: s.id, replacementLatencyMonths: v ?? 0 })}
                        className="w-20"
                      />
                    </td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <SourceBadge sourceType={s.sourceType} />
                        <ConfidenceBadge confidence={s.confidence} />
                      </div>
                    </td>
                    <td>
                      <ConfirmButton
                        label="Remove"
                        confirmLabel="Remove source"
                        message={`Remove ${s.name}? The calculated household numbers will change.`}
                        onConfirm={() => commit(`income:${s.id}`, (m) => removeIncomeSource(m, s.id))}
                      />
                      <ErrorLine msg={errorFor(`income:${s.id}`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4">
        <Card title="Add income source">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field id={`${ids}-name`} label="Name">
              <input
                id={`${ids}-name`}
                type="text"
                className="w-full"
                placeholder="e.g. Salary, main job"
                value={draft.name}
                onChange={(e) => edit({ name: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field
              id={`${ids}-earner`}
              label="Earner"
              hint={members.length === 0 ? "No members recorded in the profile yet; add one there to attribute the source." : "The member who earns it; leave unassigned when not yet known."}
            >
              <select id={`${ids}-earner`} className="w-full" value={draft.earnerId} onChange={(e) => edit({ earnerId: e.target.value })}>
                <option value={UNASSIGNED}>unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {memberOptionLabel(m)}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${ids}-amount`} label="Monthly amount">
              <input
                id={`${ids}-amount`}
                type="number"
                min={0}
                className="w-full tabular-nums"
                value={draft.monthlyAmount}
                onChange={(e) => edit({ monthlyAmount: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-reliability`} label="Reliability (0–1)" hint="Fraction of the amount that can be counted on in a bad month.">
              <input
                id={`${ids}-reliability`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-full tabular-nums"
                value={draft.reliability}
                onChange={(e) => edit({ reliability: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-volatility`} label="Volatility (0–1)" hint="0 = fixed salary, 1 = fully unpredictable month to month.">
              <input
                id={`${ids}-volatility`}
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-full tabular-nums"
                value={draft.volatility}
                onChange={(e) => edit({ volatility: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-group`} label="Failure group" hint="Sources sharing a group are assumed to disappear together.">
              <input
                id={`${ids}-group`}
                type="text"
                className="w-full font-mono text-xs"
                list={`${ids}-groups`}
                placeholder="e.g. employer_a"
                value={draft.correlationGroup}
                onChange={(e) => edit({ correlationGroup: e.target.value })}
                onKeyDown={onEnter}
              />
              <datalist id={`${ids}-groups`}>
                {existingGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>

            <Field id={`${ids}-latency`} label="Replacement latency (months)" hint="Months needed to replace this source if it disappears.">
              <input
                id={`${ids}-latency`}
                type="number"
                min={0}
                step={0.5}
                className="w-full tabular-nums"
                value={draft.replacementLatencyMonths}
                onChange={(e) => edit({ replacementLatencyMonths: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-source`} label="Source type">
              <select id={`${ids}-source`} className="w-full" value={draft.sourceType} onChange={(e) => edit({ sourceType: e.target.value as SourceType })}>
                {SOURCE_TYPES.map((t) => (
                  <option key={t} value={t} title={SOURCE_TYPE_META[t].description}>
                    {SOURCE_TYPE_META[t].label}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${ids}-confidence`} label="Confidence (0–1)">
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
                placeholder="e.g. pay stub, March"
                value={draft.evidenceText}
                onChange={(e) => edit({ evidenceText: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>

            <Field id={`${ids}-notes`} label="Notes (optional)">
              <input
                id={`${ids}-notes`}
                type="text"
                className="w-full"
                value={draft.notes}
                onChange={(e) => edit({ notes: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={submit}>
              Add income source
            </button>
            {formError ? (
              <span className="text-xs text-neg" role="alert">
                {formError}
              </span>
            ) : null}
            {errorFor("income:add") ? (
              <span className="text-xs text-neg" role="alert">
                {errorFor("income:add")}
              </span>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-4">
        {SUMMARY.map((key) => {
          const v = resolveVariable(evaluated.variables, model.id, systemRef(key));
          if (!v) return null;
          return <Stat key={key} label={v.name} value={fmtValue(v.currentValue, v.unit)} sub={`calculated · ${Math.round(v.confidence * 100)}% conf. (min of inputs)`} />;
        })}
      </div>
      <div className="mt-4">
        <Note>
          Reliability is the fraction of the amount that can be counted on in a bad month (assumption A1). Sources in the same failure group are assumed to disappear together (A4). Both are judgments, not measurements.
        </Note>
      </div>
    </div>
  );
}
