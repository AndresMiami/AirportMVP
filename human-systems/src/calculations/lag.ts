/**
 * Lag arithmetic. Lags are stored in the unit the person chose; every
 * conversion here is explicit so days, weeks, months and years are never
 * silently collapsed into one instantaneous model.
 */
import type { Lag, LagUnit } from "@/types";

export const DAYS_PER_MONTH = 30.4375; // 365.25 / 12

const MONTHS_PER_UNIT: Record<LagUnit, number> = {
  days: 1 / DAYS_PER_MONTH,
  weeks: 7 / DAYS_PER_MONTH,
  months: 1,
  years: 12,
};

export function lagToMonths(lag: Lag): number {
  return lag.value * MONTHS_PER_UNIT[lag.unit];
}

export function lagToDays(lag: Lag): number {
  return lagToMonths(lag) * DAYS_PER_MONTH;
}

export function sumLagsMonths(lags: readonly Lag[]): number {
  return lags.reduce((s, l) => s + lagToMonths(l), 0);
}

/** Coarse horizon classes for display. Boundaries are conventions (A16). */
export type Horizon = "immediate" | "days" | "weeks" | "months" | "years";

export function horizonOfMonths(months: number): Horizon {
  if (months <= 0) return "immediate";
  if (months < 7 / DAYS_PER_MONTH) return "days"; // under a week
  if (months < 1) return "weeks";
  if (months < 12) return "months";
  return "years";
}

export function horizonOfLag(lag: Lag): Horizon {
  return horizonOfMonths(lagToMonths(lag));
}

export const HORIZON_ORDER: Horizon[] = ["immediate", "days", "weeks", "months", "years"];

/** Pick a natural unit for a month count and format it, e.g. "3 weeks". */
export function monthsToLag(months: number): Lag {
  if (months <= 0) return { value: 0, unit: "days" };
  const days = months * DAYS_PER_MONTH;
  if (days < 14) return { value: round1(days), unit: "days" };
  if (months < 1) return { value: round1(days / 7), unit: "weeks" };
  if (months < 24) return { value: round1(months), unit: "months" };
  return { value: round1(months / 12), unit: "years" };
}

export function formatLag(lag: Lag): string {
  if (lag.value === 0) return "immediate";
  const unit = lag.value === 1 ? lag.unit.slice(0, -1) : lag.unit;
  return `${Number.isInteger(lag.value) ? lag.value : lag.value.toFixed(1)} ${unit}`;
}

export function formatMonths(months: number): string {
  return formatLag(monthsToLag(months));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
