"use client";
import { useCallback, useId, useState } from "react";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { ConfirmButton, SystemSwitcher } from "@/components/system-switcher";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge } from "@/components/ui";
import { subjectLabelPluralOf } from "@/model/domain";
import * as mutations from "@/services/mutations";
import { memberReferences, type MemberReferences } from "@/services/mutations";
import type { AttractorDescription } from "@/types";

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50";
const BTN_PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";

/* ------------------------------------------------------------------ */
/* Commit-on-blur text inputs (display only, same idea as NumberField)  */
/* ------------------------------------------------------------------ */

function TextField({
  id,
  value,
  onCommit,
  onEdit,
  className = "",
  placeholder,
  ariaLabel,
  list,
}: {
  id?: string;
  value: string;
  onCommit: (v: string) => void;
  onEdit?: () => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** id of a datalist of suggestions (any value stays allowed). */
  list?: string;
}) {
  const [text, setText] = useState(value);
  // Resync the draft when the committed value changes from outside
  // (a switch to another system). Derived-state-during-render.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(value);
  }
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <input
      id={id}
      type="text"
      list={list}
      aria-label={ariaLabel}
      className={className}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onEdit?.();
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function TextAreaField({
  id,
  value,
  onCommit,
  onEdit,
  rows = 3,
  className = "",
  placeholder,
}: {
  id?: string;
  value: string;
  onCommit: (v: string) => void;
  onEdit?: () => void;
  rows?: number;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(value);
  }
  return (
    <textarea
      id={id}
      rows={rows}
      className={className}
      placeholder={placeholder}
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

/** Add/remove list of recurring-outcome lines. Reports the next array;
 *  the page decides how to commit it. */
function OutcomeList({
  items,
  onChange,
  onEdit,
  label,
}: {
  items: readonly string[];
  onChange: (next: string[]) => void;
  onEdit?: () => void;
  label: string;
}) {
  const uid = useId();
  const [draft, setDraft] = useState("");
  const add = () => {
    const line = draft.trim();
    if (!line) return;
    onChange([...items, line]);
    setDraft("");
  };
  return (
    <div className="mt-3">
      <div className="text-xs text-muted mb-1">{label}</div>
      {items.length === 0 ? (
        <p className="text-xs text-muted">None listed.</p>
      ) : (
        <ul className="list-disc pl-5 text-sm space-y-1">
          {items.map((o, i) => (
            <li key={`${i}:${o}`}>
              <span>{o}</span>{" "}
              <button
                type="button"
                className="text-xs text-neg hover:underline"
                aria-label={`Remove line ${i + 1}`}
                onClick={() => onChange(items.filter((_, k) => k !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <label htmlFor={`${uid}-line`} className="sr-only">
          {label}: new line
        </label>
        <input
          id={`${uid}-line`}
          type="text"
          className="flex-1 min-w-[12rem]"
          placeholder="One recurring outcome, in the person's words"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onEdit?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className={BTN} disabled={draft.trim().length === 0} onClick={add}>
          Add line
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

/** Display order and wording of the per-entity reference counts. */
const REFERENCE_KINDS: { key: Exclude<keyof MemberReferences, "total" | "collections" | "byCollection" | "unresolvedCollections">; singular: string; plural: string }[] = [
  { key: "observations", singular: "observation", plural: "observations" },
  { key: "variables", singular: "variable", plural: "variables" },
  { key: "constraints", singular: "constraint", plural: "constraints" },
  { key: "actions", singular: "action", plural: "actions" },
  { key: "hypotheses", singular: "hypothesis", plural: "hypotheses" },
  { key: "events", singular: "event", plural: "events" },
  { key: "signatures", singular: "snapshot", plural: "snapshots" },
];

/** "3 observations · 2 variables", or "nothing yet". */
function referencesText(refs: MemberReferences): string {
  const parts = REFERENCE_KINDS.filter((k) => refs[k.key] > 0).map((k) => `${refs[k.key]} ${refs[k.key] === 1 ? k.singular : k.plural}`);
  for (const [name, n] of Object.entries(refs.byCollection)) if (n > 0) parts.push(`${n} ${name}`);
  for (const name of refs.unresolvedCollections) parts.push(`references in ${name} not verifiable here`);
  return parts.length === 0 ? "nothing yet" : parts.join(" · ");
}

/** Inline refusal message for one control; hoisted so it is not re-created on every render. */
function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? (
    <div className="text-xs text-neg mt-1" role="alert">
      {msg}
    </div>
  ) : null;
}

export default function ProfilePage() {
  const { model, evaluated, apply, lastError, clearError } = useModel();
  const ids = useId();
  const [errorOwner, setErrorOwner] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newRole, setNewRole] = useState("");
  const [memberFormError, setMemberFormError] = useState<string | null>(null);

  const commit = useCallback(
    (owner: string, mutation: ModelMutation): boolean => {
      setErrorOwner(owner);
      return apply(mutation);
    },
    [apply],
  );
  const errorFor = useCallback((owner: string) => (errorOwner === owner && lastError ? lastError : null), [errorOwner, lastError]);

  if (!model || !evaluated) return <Loading />;
  const p = model.profile;
  const { domain } = evaluated;
  const subjectSingular = domain.subjectLabel;
  const subjectPlural = subjectLabelPluralOf(domain);

  const addMember = () => {
    const label = newLabel.trim();
    if (!label) {
      setMemberFormError("A member needs a label.");
      return;
    }
    setMemberFormError(null);
    if (commit("member:add", (m) => mutations.addMember(m, { label, role: newRole.trim() }))) {
      setNewLabel("");
      setNewRole("");
    }
  };

  const attractorCard = (
    key: "current" | "desired",
    title: string,
    a: AttractorDescription,
    setter: (m: Parameters<ModelMutation>[0], patch: Partial<AttractorDescription>) => ReturnType<ModelMutation>,
    placeholder: string,
  ) => (
    <Card tone={key} title={title}>
      <label htmlFor={`${ids}-${key}-summary`} className="sr-only">
        {title} summary
      </label>
      <TextAreaField
        id={`${ids}-${key}-summary`}
        className="w-full"
        rows={3}
        value={a.summary}
        placeholder={placeholder}
        onEdit={clearError}
        onCommit={(summary) => commit(`${key}:summary`, (m) => setter(m, { summary }))}
      />
      <ErrorLine msg={errorFor(`${key}:summary`)} />
      <OutcomeList
        label="Recurring outcomes"
        items={a.recurringOutcomes}
        onEdit={clearError}
        onChange={(recurringOutcomes) => commit(`${key}:outcomes`, (m) => setter(m, { recurringOutcomes }))}
      />
      <ErrorLine msg={errorFor(`${key}:outcomes`)} />
      <div className="mt-3 flex gap-2">
        <SourceBadge sourceType={a.sourceType} />
        <ConfidenceBadge confidence={a.confidence} />
      </div>
    </Card>
  );

  return (
    <div>
      <PageHeader
        title="System profile"
        lede={`Who and what the model describes. This system uses the ${domain.name} domain; its kind is a label the domain suggests and never changes the domain. Text fields save when they lose focus.`}
      />

      <div className="mb-4">
        <SystemSwitcher />
      </div>

      <Card title="Profile">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-3 text-sm items-start">
          <dt className="text-muted pt-1">
            <label htmlFor={`${ids}-name`}>Name</label>
          </dt>
          <dd>
            <TextField
              id={`${ids}-name`}
              className="w-full max-w-md"
              value={p.name}
              onEdit={clearError}
              onCommit={(name) => commit("profile:name", (m) => mutations.updateProfile(m, { name }))}
            />
            <ErrorLine msg={errorFor("profile:name")} />
          </dd>

          <dt className="text-muted pt-1">
            <label htmlFor={`${ids}-type`}>Kind of system</label>
          </dt>
          <dd>
            <TextField
              id={`${ids}-type`}
              value={p.systemType}
              list={`${ids}-kinds`}
              onCommit={(systemType) => commit("profile:type", (m) => mutations.updateProfile(m, { systemType }))}
            />
            <datalist id={`${ids}-kinds`}>
              {domain.kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </datalist>
            <p className="text-xs text-muted mt-1">A label ({domain.kinds.map((k) => k.label).join(", ")} are the {domain.name} domain&apos;s suggestions); any label is allowed.</p>
            <ErrorLine msg={errorFor("profile:type")} />
          </dd>
          <dt className="text-muted pt-1">Domain</dt>
          <dd>
            <span className="text-sm">{domain.name}</span> <span className="text-xs text-muted">(definition {domain.id} v{domain.version}; fixed for this system)</span>
          </dd>

          <dt className="text-muted pt-1">
            <label htmlFor={`${ids}-location`}>Location</label>
          </dt>
          <dd>
            <TextField
              id={`${ids}-location`}
              className="w-full max-w-md"
              value={p.location}
              placeholder="optional"
              onEdit={clearError}
              onCommit={(location) => commit("profile:location", (m) => mutations.updateProfile(m, { location }))}
            />
            <ErrorLine msg={errorFor("profile:location")} />
          </dd>

          <dt className="text-muted pt-1">Currency</dt>
          <dd className="pt-1">{p.currency}</dd>

          <dt className="text-muted pt-1">
            <label htmlFor={`${ids}-description`}>Description</label>
          </dt>
          <dd>
            <TextAreaField
              id={`${ids}-description`}
              className="w-full max-w-xl"
              rows={3}
              value={p.description}
              placeholder="What this system is, in a sentence or two."
              onEdit={clearError}
              onCommit={(description) => commit("profile:description", (m) => mutations.updateProfile(m, { description }))}
            />
            <ErrorLine msg={errorFor("profile:description")} />
          </dd>
        </dl>
      </Card>

      <div className="mt-4">
        <Card title={`${subjectPlural} (${p.members.length})`}>
          {p.members.length === 0 ? (
            <p className="text-sm text-muted mb-3">No {subjectPlural.toLowerCase()} recorded yet. Variables, collection records, constraints and observations can name a {subjectSingular.toLowerCase()} as their subject once one exists.</p>
          ) : (
            <div className="overflow-x-auto mb-3">
              <table className="data">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Role</th>
                    <th>Referenced by</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {p.members.map((m) => {
                    const refs = memberReferences(model, m.id);
                    return (
                      <tr key={m.id}>
                        <td>
                          <TextField
                            className="w-40"
                            ariaLabel={`Label of member ${m.label}`}
                            value={m.label}
                            onEdit={clearError}
                            onCommit={(label) => commit(`member:${m.id}`, (mm) => mutations.updateMember(mm, m.id, { label }))}
                          />
                        </td>
                        <td>
                          <TextField
                            className="w-56"
                            ariaLabel={`Role of member ${m.label}`}
                            value={m.role}
                            placeholder="optional"
                            onEdit={clearError}
                            onCommit={(role) => commit(`member:${m.id}`, (mm) => mutations.updateMember(mm, m.id, { role }))}
                          />
                        </td>
                        <td className="text-xs text-muted">{referencesText(refs)}</td>
                        <td>
                          <div className="flex flex-wrap gap-2 items-center">
                            {m.status === "archived" ? (
                              <>
                                <span className="rounded px-1.5 py-0.5 text-xs bg-background border border-border">archived</span>
                                <button
                                  type="button"
                                  className="rounded border border-border bg-background px-2 py-1 text-xs"
                                  onClick={() => commit(`member:${m.id}`, (mm) => mutations.restoreMember(mm, m.id))}
                                >
                                  Restore
                                </button>
                              </>
                            ) : (
                              <ConfirmButton
                                label="Archive"
                                confirmLabel="Archive member"
                                message={`Archive ${m.label}? The id and everything naming it are kept; ${m.label} is marked as no longer part of the system.`}
                                onConfirm={() => commit(`member:${m.id}`, (mm) => mutations.archiveMember(mm, m.id))}
                              />
                            )}
                            {refs.total === 0 ? (
                              <ConfirmButton
                                label="Delete"
                                confirmLabel="Delete member"
                                message={`Delete ${m.label}? Nothing in the history names them, so no attribution is lost.`}
                                onConfirm={() => commit(`member:${m.id}`, (mm) => mutations.removeMember(mm, m.id))}
                              />
                            ) : null}
                          </div>
                          <ErrorLine msg={errorFor(`member:${m.id}`)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${ids}-new-label`} className="block text-xs text-muted">
                Label
              </label>
              <input
                id={`${ids}-new-label`}
                type="text"
                className="w-40"
                placeholder="e.g. Adult 1"
                value={newLabel}
                onChange={(e) => {
                  setNewLabel(e.target.value);
                  setMemberFormError(null);
                  clearError();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addMember();
                  }
                }}
              />
            </div>
            <div>
              <label htmlFor={`${ids}-new-role`} className="block text-xs text-muted">
                Role (optional)
              </label>
              <input
                id={`${ids}-new-role`}
                type="text"
                className="w-56"
                placeholder="e.g. Adult, part-time nurse"
                value={newRole}
                onChange={(e) => {
                  setNewRole(e.target.value);
                  clearError();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addMember();
                  }
                }}
              />
            </div>
            <button type="button" className={BTN_PRIMARY} onClick={addMember}>
              Add member
            </button>
            {memberFormError ? (
              <span className="text-xs text-neg" role="alert">
                {memberFormError}
              </span>
            ) : null}
            {errorFor("member:add") ? (
              <span className="text-xs text-neg" role="alert">
                {errorFor("member:add")}
              </span>
            ) : null}
          </div>
          <div className="mt-3">
            <Note>
              Archiving is the normal way a {subjectSingular.toLowerCase()} leaves: the id stays and everything naming it keeps its subject. Delete is offered only while nothing references a{" "}
              {subjectSingular.toLowerCase()}; once a variable, collection record, constraint, observation or other record names one, archive instead.
            </Note>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 mt-4">
        {attractorCard(
          "current",
          "Current attractor (as described)",
          model.currentAttractor,
          mutations.setCurrentAttractor,
          "The recurring state the system keeps returning to, in the person's own words.",
        )}
        {attractorCard(
          "desired",
          "Desired attractor (as described)",
          model.desiredAttractor,
          mutations.setDesiredAttractor,
          "The state the person wants the system to settle into, in their own words.",
        )}
      </div>
      <p className="text-xs text-muted mt-4">Model last saved: {new Date(model.updatedAt).toLocaleString()}</p>
    </div>
  );
}
