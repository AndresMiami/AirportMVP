"use client";
import { categoryMeta, SOURCE_TYPE_META, confidenceLabel } from "@/domain/vocabulary";
import type { SourceType, VariableCategory } from "@/types";
import { fmtConfidence } from "./format";
import { useModel } from "./model-provider";

export function PageHeader({ title, lede }: { title: string; lede?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {lede ? <p className="mt-1 text-sm text-muted max-w-3xl">{lede}</p> : null}
    </header>
  );
}

export function Card({
  title,
  children,
  tone = "neutral",
  className = "",
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  tone?: "neutral" | "current" | "desired" | "warn";
  className?: string;
}) {
  const border =
    tone === "current"
      ? "border-accent"
      : tone === "desired"
        ? "border-desired"
        : tone === "warn"
          ? "border-warn"
          : "border-border";
  return (
    <section className={`rounded-lg border ${border} bg-surface p-4 ${className}`}>
      {title ? <h2 className="text-sm font-semibold mb-3">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "neutral" | "current" | "desired";
}) {
  const color = tone === "current" ? "text-accent" : tone === "desired" ? "text-desired" : "";
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {sub ? <div className="text-xs text-muted mt-0.5">{sub}</div> : null}
    </div>
  );
}

export function SourceBadge({ sourceType }: { sourceType: SourceType }) {
  const meta = SOURCE_TYPE_META[sourceType];
  const tone =
    meta.trust >= 4
      ? "bg-desired-soft text-desired"
      : meta.trust === 3
        ? "bg-accent-soft text-accent"
        : meta.trust === 2
          ? "bg-warn-soft text-warn"
          : "bg-neg-soft text-neg";
  return (
    <span title={meta.description} className={`inline-block rounded px-1.5 py-0.5 text-xs ${tone}`}>
      {meta.label}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  return (
    <span
      title={confidenceLabel(confidence)}
      className="inline-block rounded px-1.5 py-0.5 text-xs bg-background border border-border tabular-nums"
    >
      {fmtConfidence(confidence)} conf.
    </span>
  );
}

export function CategoryBadge({ category }: { category: VariableCategory }) {
  const meta = categoryMeta(category);
  return (
    <span title={meta.description} className="inline-block rounded px-1.5 py-0.5 text-xs bg-background border border-border">
      {meta.short}
    </span>
  );
}

export function Note({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <p className={`text-xs rounded-md px-3 py-2 ${tone === "warn" ? "bg-warn-soft text-warn" : "bg-background text-muted"}`}>
      {children}
    </p>
  );
}

/** Page-level placeholder while the model loads. Under a terminal storage
 *  error the storage notice already says what happened, so nothing is shown. */
export function Loading() {
  const { status } = useModel();
  if (status === "error") return null;
  return <p className="text-sm text-muted">Loading the model from this browser…</p>;
}
