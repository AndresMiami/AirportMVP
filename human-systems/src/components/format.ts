/** Display formatting only. No model logic here. */
export function fmtValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (unit.startsWith("$")) {
    const money = Math.round(Math.abs(value)).toLocaleString("en-US");
    const sign = value < 0 ? "−" : "";
    return unit === "$" ? `${sign}$${money}` : `${sign}$${money}${unit.slice(1)}`;
  }
  if (unit === "ratio" || unit.startsWith("index") || unit.startsWith("share") || unit.startsWith("rate")) {
    return value.toFixed(2);
  }
  if (unit === "months" || unit.startsWith("hours") || unit.startsWith("switches")) {
    return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
  }
  if (unit === "count" || unit.startsWith("flag")) return `${value}`;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} ${unit}`.trim();
}

export function fmtDelta(delta: number | null, unit: string): string {
  if (delta === null) return "—";
  if (Math.abs(delta) < 1e-9) return "no change";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${fmtValue(Math.abs(delta), unit)}`;
}

export function fmtPct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}
