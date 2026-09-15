"use client";
/**
 * Shared pieces for a variable's value and target history.
 *
 * A variable's current value and its current target are read from the
 * newest entry that applies today; earlier entries stay in the history and
 * are never edited in place. These components show that history in plain
 * words, let a person record when a new entry applies, and let them
 * retract an entry with a reason. No model logic here: every change goes
 * through a mutation the screen passes in.
 */
import { useId, useState } from "react";
import { exactDate, formatTemporal } from "@/calculations/time";
import { fmtConfidence, fmtValue } from "@/components/format";
import { SourceBadge } from "@/components/ui";
import type { HistoryResolutionState, TargetEntry, TargetMode, TemporalRef, ValueEntry, Variable } from "@/types";

export const BTN_SMALL = "rounded border border-border bg-background px-2 py-0.5 text-xs hover:border-accent disabled:opacity-50";
export const BTN_SAVE = "rounded bg-accent text-white px-2.5 py-1 text-xs disabled:opacity-50";

export const TARGET_MODE_SYMBOL: Record<TargetMode, string> = { at_least: "≥", at_most: "≤", exact: "=" };

/** Today's date in the browser's local calendar (YYYY-MM-DD). */
export function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** "Applies as of" date -> the reference a mutation takes; empty = not stated (omitted). */
export function validFromDate(date: string): TemporalRef | undefined {
  const d = date.trim();
  return d ? exactDate(d) : undefined;
}

/** Plain-words reason a value or target could not be read from its history; null when it could. */
export function resolutionHint(state: HistoryResolutionState, what: "value" | "target" = "value"): string | null {
  switch (state) {
    case "resolved":
    case "no_entries":
      return null;
    case "before_first":
      return `No ${what} recorded that early.`;
    case "unorderable_only":
      return `Recorded ${what}s have no date, so none is used.`;
    case "ambiguous":
      return `Two recorded ${what}s disagree for the same date — retract or correct one.`;
  }
}

export function ResolutionHint({ state, what = "value" }: { state: HistoryResolutionState; what?: "value" | "target" }) {
  const hint = resolutionHint(state, what);
  return hint ? <div className="text-xs text-muted max-w-xs">{hint}</div> : null;
}

/** "Applies as of …" for an entry, saying so when the start was never stated. */
export function appliesLine(e: { valid: TemporalRef; validBasis: ValueEntry["validBasis"]; recordedAt: string }): string {
  if (e.validBasis === "recorded") return `Applies as of ${e.recordedAt.slice(0, 10)} (when it began is not stated)`;
  return `Applies as of ${formatTemporal(e.valid)}`;
}

/** Date input for "Applies as of"; empty means the start is not stated. */
export function AppliesAsOfField({ value, onChange, disabled = false }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-muted">
        Applies as of
      </label>
      <input id={id} type="date" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <div className="text-xs text-muted mt-0.5">Clear the date to record it without saying when it began.</div>
    </div>
  );
}

export function HistoryToggle({ open, onToggle, controls, count }: { open: boolean; onToggle: () => void; controls: string; count: number }) {
  return (
    <button type="button" className={BTN_SMALL} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      History ({count})
    </button>
  );
}

function StatusTag({ entry }: { entry: ValueEntry | TargetEntry }) {
  if (entry.status === "active") return null;
  const label = entry.status === "superseded" ? "superseded by a correction" : `retracted${entry.retractedAt ? ` on ${entry.retractedAt.slice(0, 10)}` : ""}`;
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-background border border-border text-muted">
      {label}
      {entry.status === "retracted" && entry.retractReason ? `: ${entry.retractReason}` : ""}
    </span>
  );
}

/** "Retract" -> one-line reason + confirm, inline. */
function RetractControl({ label, onRetract }: { label: string; onRetract: (reason: string) => void }) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState("");
  const id = useId();
  if (!armed) {
    return (
      <button type="button" className={BTN_SMALL} onClick={() => setArmed(true)}>
        Retract
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <label htmlFor={id} className="sr-only">
        Reason for retracting
      </label>
      <input id={id} type="text" className="text-xs" placeholder="Reason (one line)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <button
        type="button"
        className={`${BTN_SMALL} border-neg text-neg`}
        disabled={!reason.trim()}
        onClick={() => {
          onRetract(reason.trim());
          setArmed(false);
          setReason("");
        }}
      >
        Confirm retract
      </button>
      <button
        type="button"
        className={BTN_SMALL}
        onClick={() => {
          setArmed(false);
          setReason("");
        }}
      >
        Cancel
      </button>
    </span>
  );
}

function newestFirst<E extends { recordedAt: string }>(entries: readonly E[]): E[] {
  return [...entries].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
}

const ROW = "flex flex-wrap items-center gap-x-2 gap-y-1";
const MUTED_ROW = `${ROW} text-muted`;

/** A variable's recorded values, newest first. Derived variables never have any. */
export function ValueHistoryList({ variable, onRetract, id }: { variable: Variable; onRetract: (entryId: string, reason: string) => void; id?: string }) {
  const entries = newestFirst(variable.values);
  if (entries.length === 0) return <p className="text-xs text-muted">No values recorded yet.</p>;
  return (
    <ul id={id} className="space-y-1.5 text-xs">
      {entries.map((e) => (
        <li key={e.id} className={e.status === "active" ? ROW : MUTED_ROW}>
          <span className="tabular-nums font-medium">{e.value === null ? "unknown" : fmtValue(e.value, variable.unit)}</span>
          <span>{appliesLine(e)}</span>
          <span>Recorded on {e.recordedAt.slice(0, 10)}</span>
          <SourceBadge sourceType={e.sourceType} />
          <span className="tabular-nums">{fmtConfidence(e.confidence)} conf.</span>
          {e.note ? <span>Note: {e.note}</span> : null}
          <StatusTag entry={e} />
          {e.status === "active" ? <RetractControl label={`Retract value recorded on ${e.recordedAt.slice(0, 10)}`} onRetract={(reason) => onRetract(e.id, reason)} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** A variable's recorded targets, newest first. */
export function TargetHistoryList({ variable, onRetract, id }: { variable: Variable; onRetract: (entryId: string, reason: string) => void; id?: string }) {
  const entries = newestFirst(variable.targets);
  if (entries.length === 0) return <p className="text-xs text-muted">No targets recorded yet.</p>;
  return (
    <ul id={id} className="space-y-1.5 text-xs">
      {entries.map((e) => (
        <li key={e.id} className={e.status === "active" ? ROW : MUTED_ROW}>
          <span className="tabular-nums font-medium">
            {e.desiredValue === null ? "no target" : `${TARGET_MODE_SYMBOL[e.targetMode]} ${fmtValue(e.desiredValue, variable.unit)}`}
          </span>
          <span>{appliesLine(e)}</span>
          <span>Recorded on {e.recordedAt.slice(0, 10)}</span>
          {e.note ? <span>Note: {e.note}</span> : null}
          <StatusTag entry={e} />
          {e.status === "active" ? <RetractControl label={`Retract target recorded on ${e.recordedAt.slice(0, 10)}`} onRetract={(reason) => onRetract(e.id, reason)} /> : null}
        </li>
      ))}
    </ul>
  );
}

export interface TargetDraft {
  desiredValue: number | null;
  targetMode: TargetMode;
  valid?: TemporalRef;
  note?: string;
}

/**
 * Current target with a "Change" control that records a NEW target entry.
 * The screen passes the mutation call; the editor only collects the draft.
 */
export function TargetEditor({ variable, onSave, error }: { variable: Variable; onSave: (draft: TargetDraft) => boolean; error: string | null }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<TargetMode>(variable.targetMode);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const ids = useId();

  const begin = () => {
    setValue(variable.desiredValue === null ? "" : String(variable.desiredValue));
    setMode(variable.targetMode);
    setDate(todayIso());
    setNote("");
    setLocalError(null);
    setOpen(true);
  };
  const save = () => {
    let desiredValue: number | null = null;
    if (value.trim() !== "") {
      const n = Number(value);
      if (!Number.isFinite(n)) return setLocalError("The target must be a number.");
      desiredValue = n;
    }
    const ok = onSave({ desiredValue, targetMode: mode, valid: validFromDate(date), note: note.trim() || undefined });
    if (ok) setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="flex items-center gap-2">
        <span className="tabular-nums text-desired">
          {variable.desiredValue === null ? (
            <span className="text-muted">no target</span>
          ) : (
            <>
              <span className="text-xs text-muted mr-1">{TARGET_MODE_SYMBOL[variable.targetMode]}</span>
              {fmtValue(variable.desiredValue, variable.unit)}
            </>
          )}
        </span>
        {!open ? (
          <button type="button" className={BTN_SMALL} onClick={begin}>
            {variable.desiredValue === null ? "Set target" : "Change"}
          </button>
        ) : null}
      </div>
      <ResolutionHint state={variable.targetResolution} what="target" />
      {open ? (
        <div className="rounded border border-border bg-background p-2 space-y-2 text-xs" role="group" aria-label={`New target for ${variable.name}`}>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${ids}-mode`} className="block text-xs text-muted">
                Meaning
              </label>
              <select id={`${ids}-mode`} className="text-xs" value={mode} onChange={(e) => setMode(e.target.value as TargetMode)}>
                <option value="at_least">at least (floor)</option>
                <option value="at_most">at most (ceiling)</option>
                <option value="exact">exact</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${ids}-value`} className="block text-xs text-muted">
                Target ({variable.unit})
              </label>
              <input
                id={`${ids}-value`}
                type="number"
                className="w-28 tabular-nums"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setLocalError(null);
                }}
              />
            </div>
            <AppliesAsOfField value={date} onChange={setDate} />
            <div>
              <label htmlFor={`${ids}-note`} className="block text-xs text-muted">
                Note (optional)
              </label>
              <input id={`${ids}-note`} type="text" className="w-40" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_SAVE} onClick={save}>
              Save target
            </button>
            <button type="button" className={BTN_SMALL} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <span className="text-muted">Leave the target empty to record that there is no target from this date. Earlier targets stay in the history.</span>
          </div>
          {localError ? (
            <div className="text-neg" role="alert">
              {localError}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="text-xs text-neg" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
