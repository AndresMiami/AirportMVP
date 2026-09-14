/**
 * Badge for a lag horizon class (A16). Display only: a horizon class is a
 * convention for reading lags, never a measured response time. The tones
 * run cool -> warm as the lag lengthens; they mark the class and carry no
 * judgment about whether a long lag is good or bad.
 */
import type { Horizon } from "@/calculations/lag";

export const HORIZON_META: Record<Horizon, { label: string; className: string; boundary: string }> = {
  immediate: {
    label: "immediate",
    className: "bg-background border border-border text-muted",
    boundary: "Immediate: a lag entered as zero (A16 horizon class).",
  },
  days: {
    label: "days",
    className: "bg-accent-soft text-accent",
    boundary: "Days: a lag under one week (A16 horizon class).",
  },
  weeks: {
    label: "weeks",
    className: "bg-desired-soft text-desired",
    boundary: "Weeks: a lag of one week or more and under one month (A16 horizon class).",
  },
  months: {
    label: "months",
    className: "bg-warn-soft text-warn",
    boundary: "Months: a lag of one month or more and under one year (A16 horizon class).",
  },
  years: {
    label: "years",
    className: "bg-neg-soft text-neg",
    boundary: "Years: a lag of one year or more (A16 horizon class).",
  },
};

export function HorizonBadge({
  horizon,
  prefix,
  className = "",
}: {
  horizon: Horizon;
  /** Optional lead-in inside the badge, e.g. "slowest step:". */
  prefix?: string;
  className?: string;
}) {
  const meta = HORIZON_META[horizon];
  return (
    <span title={meta.boundary} className={`inline-block rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${meta.className} ${className}`}>
      {prefix ? `${prefix} ` : ""}
      {meta.label}
    </span>
  );
}
