/**
 * Current vs desired signature: a VECTOR of per-dimension gaps (A24).
 * There is deliberately no total: the question is "what needs to change",
 * not "how good is the life".
 */
import type { StructuralSignature } from "@/types/signature";

export type GapBand = "unknown" | "none" | "small" | "moderate" | "large" | "very_large";

export interface DimensionGap {
  dimensionId: string;
  name: string;
  current: number | null;
  desired: number | null;
  /** desired - current on the 0..1 scale; null when either is unknown. */
  gap: number | null;
  band: GapBand;
  /** Current is known, already at/above the strong threshold, and no gap. */
  alreadyStrong: boolean;
  label: string;
  currentConfidence: number;
  desiredConfidence: number;
}

export const GAP_BANDS: { band: GapBand; below: number; label: string }[] = [
  { band: "none", below: 0.05, label: "no meaningful gap" },
  { band: "small", below: 0.15, label: "small gap" },
  { band: "moderate", below: 0.3, label: "moderate gap" },
  { band: "large", below: 0.5, label: "large gap" },
  { band: "very_large", below: Infinity, label: "very large gap" },
];

export function gapBand(gap: number | null): GapBand {
  if (gap === null) return "unknown";
  const abs = Math.abs(gap);
  return GAP_BANDS.find((b) => abs < b.below)!.band;
}

export function signatureGap(current: StructuralSignature, desired: StructuralSignature): DimensionGap[] {
  const desiredById = new Map(desired.dimensions.map((d) => [d.dimensionId, d]));
  return current.dimensions.map((c) => {
    const d = desiredById.get(c.dimensionId);
    const cv = c.normalizedValue;
    const dv = d?.normalizedValue ?? null;
    const gap = cv === null || dv === null ? null : dv - cv;
    const band = gapBand(gap);
    const alreadyStrong = cv !== null && band === "none" && cv >= c.binaryThreshold;
    let label: string;
    if (gap === null) label = cv === null ? "unknown (current value missing)" : "unknown (desired value missing)";
    else if (alreadyStrong) label = "already strong";
    else if (gap < -0.05) label = `desired is lower (${GAP_BANDS.find((b) => b.band === band)!.label})`;
    else label = GAP_BANDS.find((b) => b.band === band)!.label;
    return {
      dimensionId: c.dimensionId,
      name: c.name,
      current: cv,
      desired: dv,
      gap,
      band,
      alreadyStrong,
      label,
      currentConfidence: c.confidence,
      desiredConfidence: d?.confidence ?? 0,
    };
  });
}
