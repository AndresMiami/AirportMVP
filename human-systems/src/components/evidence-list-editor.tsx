"use client";
/**
 * Small reusable add/remove list for Evidence[] items ({text, sourceType,
 * recordedAt?}). Display-only: it never touches the model, it reports the
 * next array through onChange and the owner decides how to commit it.
 */
import { useId, useState } from "react";
import { SourceBadge } from "@/components/ui";
import { SOURCE_TYPE_META } from "@/domain/vocabulary";
import { SourceTypeSchema, type Evidence, type SourceType } from "@/types";

const SOURCE_TYPES: readonly SourceType[] = SourceTypeSchema.options;

export function EvidenceListEditor({
  items,
  onChange,
  onEdit,
  disabled = false,
  label = "Evidence",
}: {
  items: readonly Evidence[];
  /** Called with the complete next list after an add or a remove. */
  onChange: (next: Evidence[]) => void;
  /** Called when the person starts typing (owners use it to clear a refusal). */
  onEdit?: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const uid = useId();
  const [text, setText] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("self_reported");
  const [recordedAt, setRecordedAt] = useState("");
  const canAdd = !disabled && text.trim().length > 0;

  const add = () => {
    if (!canAdd) return;
    const trimmedDate = recordedAt.trim();
    const item: Evidence = trimmedDate
      ? { text: text.trim(), sourceType, recordedAt: trimmedDate }
      : { text: text.trim(), sourceType };
    onChange([...items, item]);
    setText("");
    setRecordedAt("");
  };

  const remove = (index: number) => {
    if (disabled) return;
    onChange(items.filter((_, i) => i !== index));
  };

  return (
    <div>
      {items.length === 0 ? (
        <p className="text-xs text-muted">No evidence recorded for this item.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((e, i) => (
            <li key={`${i}:${e.text}`} className="flex items-start gap-2 text-sm">
              <SourceBadge sourceType={e.sourceType} />
              <span className="flex-1 min-w-0 break-words">
                {e.text}
                {e.recordedAt ? <span className="text-xs text-muted"> · {e.recordedAt}</span> : null}
              </span>
              <button
                type="button"
                className="text-xs text-neg hover:underline shrink-0 disabled:opacity-50"
                disabled={disabled}
                onClick={() => remove(i)}
                aria-label={`Remove evidence item ${i + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        <label htmlFor={`${uid}-text`} className="sr-only">
          {label}: new item text
        </label>
        <input
          id={`${uid}-text`}
          type="text"
          className="w-full"
          placeholder="What was seen, said or read (kept verbatim)"
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            onEdit?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label={`${label}: source type of the new item`}
            className="text-xs"
            value={sourceType}
            disabled={disabled}
            onChange={(e) => setSourceType(e.target.value as SourceType)}
          >
            {SOURCE_TYPES.map((s) => (
              <option key={s} value={s} title={SOURCE_TYPE_META[s].description}>
                {SOURCE_TYPE_META[s].label}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label={`${label}: date recorded (optional)`}
            className="text-xs w-32"
            placeholder="date (optional)"
            value={recordedAt}
            disabled={disabled}
            onChange={(e) => setRecordedAt(e.target.value)}
          />
          <button
            type="button"
            className="rounded border border-border bg-background px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
            disabled={!canAdd}
            onClick={add}
          >
            Add evidence
          </button>
        </div>
      </div>
    </div>
  );
}
