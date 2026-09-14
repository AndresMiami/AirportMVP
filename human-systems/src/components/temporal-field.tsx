"use client";
/**
 * Reusable control for a structured time reference (TemporalRef).
 *
 * The person's words ("As written") are always kept, whatever kind is
 * chosen; the structured part (kind, start, end, precision) is what the
 * app can order by. "unknown" carries the text only. Nothing is parsed
 * from the text: the dates are set by the person.
 */
import { useId } from "react";
import { unknownTime } from "@/calculations/time";
import type { TemporalPrecision, TemporalRef } from "@/types";

/** The kinds this control offers. "instant" is shown as an exact date. */
type FieldKind = "date" | "approx" | "range" | "unknown";

const KIND_OPTIONS: { value: FieldKind; label: string }[] = [
  { value: "date", label: "exact date" },
  { value: "approx", label: "approximate" },
  { value: "range", label: "range" },
  { value: "unknown", label: "unknown" },
];

const APPROX_PRECISIONS: { value: TemporalPrecision; label: string }[] = [
  { value: "day", label: "day" },
  { value: "month", label: "month" },
  { value: "year", label: "year" },
];

/** A reference with the person's words only: unknown kind, no dates. */
export function emptyTemporal(text: string): TemporalRef {
  return unknownTime(text);
}

/** Why a draft reference would be refused by the schema, or null when it is complete. */
export function temporalProblem(t: TemporalRef): string | null {
  if (!t.text.trim()) return "Write the time as you would say it (the words are kept).";
  if (t.kind === "unknown") return null;
  if (!t.start) return t.kind === "range" ? "A range needs a start date." : "Pick the date.";
  if (t.kind === "range" && !t.end) return "A range needs an end date.";
  if (t.start && t.end && t.end < t.start) return "The end date precedes the start date.";
  return null;
}

function fieldKindOf(t: TemporalRef): FieldKind {
  if (t.kind === "instant" || t.kind === "date") return "date";
  return t.kind;
}

/** Rebuild the reference for a newly chosen kind, keeping text and any dates that still apply. */
function withKind(t: TemporalRef, kind: FieldKind): TemporalRef {
  const text = t.text;
  const start = t.start?.slice(0, 10);
  switch (kind) {
    case "unknown":
      return { kind: "unknown", precision: "unspecified", text };
    case "date":
      return { kind: "date", start, precision: "day", text };
    case "approx": {
      const precision: TemporalPrecision = t.precision === "month" || t.precision === "year" ? t.precision : "day";
      return { kind: "approx", start, precision, text };
    }
    case "range":
      return { kind: "range", start, end: t.end?.slice(0, 10), precision: "day", text };
  }
}

export function TemporalField({
  value,
  onChange,
  label = "When",
  disabled = false,
}: {
  value: TemporalRef;
  onChange: (next: TemporalRef) => void;
  /** Group label read by assistive technology. */
  label?: string;
  disabled?: boolean;
}) {
  const ids = useId();
  const kind = fieldKindOf(value);
  const start = value.start?.slice(0, 10) ?? "";
  const end = value.end?.slice(0, 10) ?? "";

  return (
    <fieldset className="space-y-2 min-w-0" disabled={disabled}>
      <legend className="sr-only">{label}</legend>

      <div>
        <label htmlFor={`${ids}-text`} className="block text-xs font-medium text-muted mb-1">
          As written
        </label>
        <input
          id={`${ids}-text`}
          type="text"
          required
          className="w-full max-w-md"
          placeholder="spring 2022 · around March · 2019 to 2021 · not sure"
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
        />
        <p className="text-xs text-muted mt-1">The words are kept as entered, whatever is set below.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${ids}-kind`} className="block text-xs font-medium text-muted mb-1">
            Kind
          </label>
          <select id={`${ids}-kind`} value={kind} onChange={(e) => onChange(withKind(value, e.target.value as FieldKind))}>
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>

        {kind !== "unknown" ? (
          <div>
            <label htmlFor={`${ids}-start`} className="block text-xs font-medium text-muted mb-1">
              {kind === "range" ? "Start" : "Date"}
            </label>
            <input
              id={`${ids}-start`}
              type="date"
              value={start}
              onChange={(e) => onChange({ ...value, start: e.target.value || undefined })}
            />
          </div>
        ) : null}

        {kind === "range" ? (
          <div>
            <label htmlFor={`${ids}-end`} className="block text-xs font-medium text-muted mb-1">
              End
            </label>
            <input id={`${ids}-end`} type="date" value={end} onChange={(e) => onChange({ ...value, end: e.target.value || undefined })} />
          </div>
        ) : null}

        {kind === "approx" ? (
          <div>
            <label htmlFor={`${ids}-precision`} className="block text-xs font-medium text-muted mb-1">
              Precision
            </label>
            <select
              id={`${ids}-precision`}
              value={value.precision === "month" || value.precision === "year" ? value.precision : "day"}
              onChange={(e) => onChange({ ...value, precision: e.target.value as TemporalPrecision })}
            >
              {APPROX_PRECISIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {kind === "approx" ? (
        <p className="text-xs text-muted">Approximate: the date stands for its whole {value.precision === "year" ? "year" : value.precision === "month" ? "month" : "day"} when ordering.</p>
      ) : kind === "unknown" ? (
        <p className="text-xs text-muted">Unknown: kept by the words only; listed after dated entries.</p>
      ) : null}
    </fieldset>
  );
}
