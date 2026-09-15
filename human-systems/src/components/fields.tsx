"use client";
import { useState } from "react";

/** Number input that commits on blur / Enter so half-typed values never
 *  reach the model. Empty commits null when `nullable`. */
export function NumberField({
  value,
  onCommit,
  nullable = false,
  step,
  min,
  max,
  className = "",
  ariaLabel,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  nullable?: boolean;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  // Resync the draft when the committed value changes from outside
  // (e.g. a reset). Derived-state-during-render, per React guidance.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(value === null ? "" : String(value));
  }
  const commit = () => {
    if (text.trim() === "") {
      if (nullable) onCommit(null);
      else setText(value === null ? "" : String(value));
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(value === null ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      className={`w-28 tabular-nums ${className}`}
      value={text}
      step={step}
      min={min}
      max={max}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
