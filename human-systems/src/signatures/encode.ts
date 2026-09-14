/**
 * Display classifications derived from the canonical continuous value.
 * They are conveniences for a compact strip or a tile; the number is the
 * representation. Unknown is its own symbol ("?"), never a zero.
 */
import type { BandState, BinaryState, StructuralDimensionSnapshot } from "@/types/signature";

export function binaryStateOf(value: number | null, threshold: number): BinaryState {
  if (value === null) return "unknown";
  return value >= threshold ? "strong" : "weak";
}

export function bandStateOf(value: number | null, thresholds: readonly [number, number, number, number]): BandState {
  if (value === null) return "unknown";
  if (value < thresholds[0]) return "very_weak";
  if (value < thresholds[1]) return "weak";
  if (value < thresholds[2]) return "mixed";
  if (value < thresholds[3]) return "strong";
  return "very_strong";
}

export const BINARY_CHAR: Record<BinaryState, string> = { strong: "1", weak: "0", unknown: "?" };

export function compactStrip(dimensions: readonly Pick<StructuralDimensionSnapshot, "binaryState">[]): string {
  return dimensions.map((d) => BINARY_CHAR[d.binaryState]).join("");
}

export const BAND_LABEL: Record<BandState, string> = {
  very_weak: "very weak",
  weak: "weak",
  mixed: "mixed",
  strong: "strong",
  very_strong: "very strong",
  unknown: "unknown",
};

export function clip01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
