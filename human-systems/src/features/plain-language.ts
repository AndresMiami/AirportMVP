/**
 * PLAIN LANGUAGE (6A.1 / 6B): ordinary-language formatting shared by the
 * product screens (Home, History). Wording only, over facts the engines
 * already computed; nothing here rounds beyond display, ranks, or names a
 * cause. Pure; no React; no domain.
 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "June 2025" from an ISO date or instant (calendar fields, no clock). */
export function monthName(iso: string): string {
  const m = Number(iso.slice(5, 7));
  return `${MONTHS[m - 1] ?? "?"} ${iso.slice(0, 4)}`;
}

/** "June 1, 2025" from an ISO date or instant (calendar fields, no clock). */
export function longDate(iso: string): string {
  return `${monthName(iso).replace(" ", ` ${Number(iso.slice(8, 10))}, `)}`;
}

const number = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * A quantity in ordinary language. Currency leads with the sign
 * ("$4,000", "$150 a month"); a bare or placeholder unit is dropped;
 * everything else keeps the model's unit after the number ("1.5 months").
 * null is the word "unknown" — never a number.
 */
export function plainQuantity(value: number | null, unit: string): string {
  if (value === null) return "unknown";
  const u = unit.trim();
  if (u.startsWith("$")) {
    const rest = u.slice(1).replace(/^\/(.+)$/, " a $1");
    return `${value < 0 ? "-" : ""}$${number(Math.abs(value))}${rest}`;
  }
  if (u === "" || u === "u") return number(value);
  return `${number(value)} ${u}`;
}

/** " between February 2025 and June 2026", " in February 2025", or "" for no dates. */
export function plainSpan(times: readonly string[]): string {
  const sorted = [...times].sort();
  if (sorted.length === 0) return "";
  const first = monthName(sorted[0]);
  const last = monthName(sorted[sorted.length - 1]);
  return first === last ? ` in ${first}` : ` between ${first} and ${last}`;
}

/**
 * The sentence for one exact repetition: the variable's name, the
 * repeated value, how many recorded dates, and the calendar span. Same
 * facts as the History engine's sentence, no record-count or
 * application-time vocabulary.
 */
export function recurrenceSentence(name: string, value: number, unit: string, times: readonly string[]): string {
  const count = times.length === 1 ? "one recorded date" : `${times.length} recorded dates`;
  return `${name} was ${plainQuantity(value, unit)} on ${count}${plainSpan(times)}.`;
}
