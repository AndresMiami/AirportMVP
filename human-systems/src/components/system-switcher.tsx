"use client";
/**
 * The systems stored in this browser: which one is active, switching,
 * creating a blank one, loading or resetting the fictional sample, and
 * deleting. Display and input only: every change goes through the
 * provider's service methods. A blank system carries the profile and the
 * calculated variables only; no subjects, records, variables, relationships
 * or constraints are assumed on its behalf. A new system names its DOMAIN
 * explicitly (from the registered definitions); its KIND is a free label
 * the domain merely suggests and never implies the domain.
 */
import { useId, useRef, useState } from "react";
import { useModel } from "@/components/model-provider";
import { Note } from "@/components/ui";
import { subjectLabelPluralOf } from "@/model/domain";

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

/** Today's calendar date in the browser's zone, for the export file name. */
function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Hand the browser a file to save. The object URL is revoked once the
 *  click has been dispatched. */
function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The service refuses an id that is already stored; the wording is its. */
function isAlreadyExists(error: string): boolean {
  return /already exists/i.test(error);
}

function fmtSaved(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SystemSwitcher({ compact = false }: { compact?: boolean }) {
  const { model, models, isSample, seedId, migratedFrom, createBlank, switchModel, deleteModel, resetToSample, exportModel, importModel, availableDomains, defaultDomain } =
    useModel();
  const ids = useId();
  const [open, setOpen] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Export / import feedback, inline: a one-line notice or an error. */
  const [transferNote, setTransferNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  /** A file whose id is already stored, waiting for an explicit Replace. */
  const [pendingReplace, setPendingReplace] = useState<{ text: string; fileName: string } | null>(null);
  const [name, setName] = useState("");
  const [domainKey, setDomainKey] = useState(`${defaultDomain.id}@${defaultDomain.version}`);
  const [kind, setKind] = useState<string | null>(null);
  const [location, setLocation] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (!model) return null;

  const sampleStored = seedId !== null && models.some((m) => m.id === seedId);
  const selectedDomain = availableDomains.find((d) => `${d.id}@${d.version}` === domainKey) ?? availableDomains[0];
  /** The kind: what the person typed, else the selected domain's first suggestion. */
  const kindValue = kind ?? selectedDomain?.kinds[0]?.id ?? "";
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

  const doExport = () =>
    void run(async () => {
      setTransferNote(null);
      const text = await exportModel();
      downloadText(`${model.id}-${todayIso()}.json`, text);
      setTransferNote({ tone: "ok", text: `Exported ${model.profile.name} (${model.id}-${todayIso()}.json).` });
    });

  const doCopy = () =>
    void run(async () => {
      setTransferNote(null);
      const text = await exportModel();
      if (!navigator.clipboard) throw new Error("This browser does not offer clipboard access here; use Export instead.");
      await navigator.clipboard.writeText(text);
      setTransferNote({ tone: "ok", text: `Copied ${model.profile.name} as JSON to the clipboard.` });
    });

  /** One import attempt. An id that is already stored is never overwritten
   *  here: it parks the file behind an explicit Replace instead. */
  const finishImport = async (text: string, replace: boolean, fileName: string) => {
    const result = await importModel(text, replace);
    if (result.ok) {
      setPendingReplace(null);
      setTransferNote({
        tone: "ok",
        text: `Imported ${result.model.profile.name}${result.replaced ? " (replaced the stored copy)" : ""}${
          result.migratedFrom !== null ? " (upgraded from an older format)" : ""
        }.`,
      });
    } else if (!replace && isAlreadyExists(result.error)) {
      setPendingReplace({ text, fileName });
    } else {
      setPendingReplace(null);
      setTransferNote({ tone: "error", text: result.error });
    }
  };

  const onFileChosen = (file: File | null) => {
    if (!file) return;
    setTransferNote(null);
    setPendingReplace(null);
    void run(async () => finishImport(await file.text(), false, file.name));
  };

  const submitBlank = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("A system needs a name.");
      return;
    }
    if (!selectedDomain) {
      setFormError("No domain is registered; a system cannot be created.");
      return;
    }
    if (!kindValue.trim()) {
      setFormError("A system needs a kind (a short label; the domain suggests some).");
      return;
    }
    setFormError(null);
    void run(async () => {
      await createBlank({ name: trimmed, systemType: kindValue.trim(), domainId: selectedDomain.id, domainVersion: selectedDomain.version, location: location.trim() || undefined });
      setName("");
      setKind(null);
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
                        {seedId !== null && m.id === seedId ? <span className={`${TAG} ml-2`}>fictional sample</span> : null}
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
                <label htmlFor={`${ids}-domain`} className="block text-xs text-muted">
                  Domain
                </label>
                <select
                  id={`${ids}-domain`}
                  value={domainKey}
                  onChange={(e) => {
                    setDomainKey(e.target.value);
                    setKind(null);
                  }}
                >
                  {availableDomains.map((d) => (
                    <option key={`${d.id}@${d.version}`} value={`${d.id}@${d.version}`}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${ids}-kind`} className="block text-xs text-muted">
                  Kind
                </label>
                <input
                  id={`${ids}-kind`}
                  type="text"
                  className="w-36"
                  list={`${ids}-kinds`}
                  value={kindValue}
                  placeholder={selectedDomain?.kinds[0]?.label ?? "any label"}
                  onChange={(e) => setKind(e.target.value)}
                />
                <datalist id={`${ids}-kinds`}>
                  {(selectedDomain?.kinds ?? []).map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </datalist>
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
              A blank system starts with its profile and the {selectedDomain ? selectedDomain.name : "domain"}&apos;s calculated variables only.{" "}
              {selectedDomain ? subjectLabelPluralOf(selectedDomain) : "Subjects"}, records, variables, relationships and constraints are added by hand; nothing is
              assumed. The kind is a label the domain suggests; any label is allowed and it never changes the domain.
            </p>
          </div>

          <div className="border-t border-border pt-3">
            <h3 className="text-xs font-semibold text-muted mb-2">Export / import</h3>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BTN} disabled={busy} onClick={doExport}>
                Export this system
              </button>
              <button type="button" className={BTN} disabled={busy} onClick={doCopy}>
                Copy as JSON
              </button>
              <button type="button" className={BTN} disabled={busy} onClick={() => fileInputRef.current?.click()}>
                Import from file…
              </button>
              <input
                ref={fileInputRef}
                id={`${ids}-import`}
                type="file"
                accept=".json,application/json"
                className="sr-only"
                aria-label="Import a system from a JSON file"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  onFileChosen(file);
                }}
              />
            </div>
            <p className="text-xs text-muted mt-1">
              An export is one system with its whole history, as a JSON file named {model.id}-{todayIso()}.json. An import is checked
              before anything is stored; a file that fails the check stores nothing.
            </p>
            {pendingReplace ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Replace an existing system">
                <span className="text-warn">
                  A system with this id already exists. Replace it? Its stored history will be overwritten.
                  {pendingReplace.fileName ? ` (${pendingReplace.fileName})` : ""}
                </span>
                <button
                  type="button"
                  className={`${BTN} border-neg text-neg`}
                  disabled={busy}
                  onClick={() => void run(() => finishImport(pendingReplace.text, true, pendingReplace.fileName))}
                >
                  Replace
                </button>
                <button type="button" className={BTN} disabled={busy} onClick={() => setPendingReplace(null)}>
                  Cancel
                </button>
              </div>
            ) : null}
            {transferNote ? (
              <p className={`mt-2 text-xs ${transferNote.tone === "error" ? "text-neg" : "text-desired"}`} role={transferNote.tone === "error" ? "alert" : "status"}>
                {transferNote.text}
              </p>
            ) : null}
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
