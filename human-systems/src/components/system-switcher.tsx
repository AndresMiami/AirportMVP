"use client";
/**
 * The systems stored in this browser: which one is active, switching,
 * creating a blank one, loading or resetting the fictional sample, and
 * deleting. Display and input only: every change goes through the
 * provider's service methods. A blank system carries the profile and the
 * calculated variables only; no members, income, variables, relationships
 * or constraints are assumed on its behalf.
 */
import { useId, useState } from "react";
import { useModel } from "@/components/model-provider";
import { Note } from "@/components/ui";
import { SAMPLE_MODEL_ID } from "@/services";
import type { SystemType } from "@/types";

const BTN =
  "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50 disabled:hover:border-border";
const BTN_PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const TAG = "inline-block rounded border border-border bg-background px-1.5 py-0.5 text-xs";

/** A button that asks once, inline, before acting. Used wherever a removal
 *  is irreversible. */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm",
  message,
  onConfirm,
  disabled = false,
  title,
  className = "",
}: {
  label: string;
  confirmLabel?: string;
  /** Shown while the button is armed, next to the confirm/cancel pair. */
  message: string;
  onConfirm: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (armed) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label={label}>
        <span className="text-muted">{message}</span>
        <button
          type="button"
          className={`${BTN} border-neg text-neg`}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" className={BTN} onClick={() => setArmed(false)}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button type="button" className={`${BTN} ${className}`} disabled={disabled} title={title} onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}

function fmtSaved(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SystemSwitcher({ compact = false }: { compact?: boolean }) {
  const { model, models, isSample, migratedFrom, createBlank, switchModel, deleteModel, resetToSample } = useModel();
  const ids = useId();
  const [open, setOpen] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [systemType, setSystemType] = useState<SystemType>("household");
  const [location, setLocation] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (!model) return null;

  const sampleStored = models.some((m) => m.id === SAMPLE_MODEL_ID);
  const sorted = [...models].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitBlank = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("A system needs a name.");
      return;
    }
    setFormError(null);
    void run(async () => {
      await createBlank({ name: trimmed, systemType, location: location.trim() || undefined });
      setName("");
      setLocation("");
    });
  };

  return (
    <section className="rounded-lg border border-border bg-surface" aria-label="Stored systems">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <div className="text-sm min-w-0">
          <span className="text-muted">Active system:</span> <span className="font-medium">{model.profile.name}</span>{" "}
          <span className="text-xs text-muted">
            · {model.profile.systemType} · {models.length} stored in this browser
          </span>
        </div>
        <button type="button" className={BTN} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide systems" : "Manage systems"}
        </button>
      </div>

      {migratedFrom !== null ? (
        <div className="px-4 pb-2">
          <Note>This system was upgraded from schema version {migratedFrom} on load.</Note>
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-border px-4 py-3 space-y-4 text-sm">
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>System</th>
                  <th>Type</th>
                  <th>Last saved</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((m) => {
                  const active = m.id === model.id;
                  return (
                    <tr key={m.id} className={active ? "bg-accent-soft" : ""}>
                      <td>
                        <span className="font-medium">{m.name}</span>
                        {m.id === SAMPLE_MODEL_ID ? <span className={`${TAG} ml-2`}>fictional sample</span> : null}
                        {active ? <span className={`${TAG} ml-2 text-accent border-accent`}>active</span> : null}
                      </td>
                      <td className="text-xs">{m.systemType}</td>
                      <td className="text-xs text-muted tabular-nums">{fmtSaved(m.updatedAt)}</td>
                      <td>
                        {active ? (
                          <span className="text-xs text-muted">in use</span>
                        ) : (
                          <button type="button" className={BTN} disabled={busy} onClick={() => void run(() => switchModel(m.id))}>
                            Switch
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-muted mb-2">New blank system</h3>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor={`${ids}-name`} className="block text-xs text-muted">
                  Name
                </label>
                <input
                  id={`${ids}-name`}
                  type="text"
                  className="w-56"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setFormError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitBlank();
                    }
                  }}
                />
              </div>
              <div>
                <label htmlFor={`${ids}-type`} className="block text-xs text-muted">
                  Type
                </label>
                <select id={`${ids}-type`} value={systemType} onChange={(e) => setSystemType(e.target.value as SystemType)}>
                  <option value="individual">individual</option>
                  <option value="household">household</option>
                  <option value="organization" disabled>
                    organization (not yet supported)
                  </option>
                  <option value="country" disabled>
                    country (not yet supported)
                  </option>
                </select>
              </div>
              <div>
                <label htmlFor={`${ids}-location`} className="block text-xs text-muted">
                  Location (optional)
                </label>
                <input id={`${ids}-location`} type="text" className="w-44" value={location} onChange={(e) => setLocation(e.target.value)} />
              </div>
              <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={submitBlank}>
                Create and switch
              </button>
              {formError ? (
                <span className="text-xs text-neg" role="alert">
                  {formError}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted mt-1">
              A blank system starts with its profile and the calculated variables only. Members, income, variables, relationships and
              constraints are added by hand; nothing is assumed.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {sampleStored ? (
              <ConfirmButton
                label="Load / reset sample"
                confirmLabel="Reset sample"
                message="This re-creates the fictional sample; your other systems are untouched."
                disabled={busy}
                onConfirm={() => void run(resetToSample)}
              />
            ) : (
              <button type="button" className={BTN} disabled={busy} onClick={() => void run(resetToSample)}>
                Load / reset sample
              </button>
            )}
            <ConfirmButton
              label="Delete this system"
              confirmLabel="Delete"
              message={`Delete "${model.profile.name}" from this browser? This cannot be undone.`}
              disabled={busy || isSample}
              title={isSample ? "The fictional sample is not deleted; it can be reset instead." : undefined}
              onConfirm={() => void run(() => deleteModel(model.id))}
            />
            {isSample ? <span className="text-xs text-muted">The sample can be reset instead of deleted.</span> : null}
            {actionError ? (
              <span className="text-xs text-neg" role="alert">
                {actionError}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
