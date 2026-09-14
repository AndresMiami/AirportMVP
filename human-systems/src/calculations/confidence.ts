/** A13: a derived value is only as confident as its least confident input. */
export function derivedConfidence(inputConfidences: readonly number[]): number {
  if (inputConfidences.length === 0) return 0;
  return Math.min(...inputConfidences);
}
