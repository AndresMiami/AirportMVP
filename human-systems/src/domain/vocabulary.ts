/**
 * Human-readable labels and explanations for the enums in types/.
 * Kept out of the UI so tests and future exports can reuse the wording.
 */
import type { SourceType, UtilityDimension, VariableCategory } from "@/types";

export const CATEGORY_META: Record<
  VariableCategory,
  { label: string; short: string; description: string }
> = {
  event: {
    label: "Visible event / state",
    short: "Event",
    description: "Fast-changing, visible. What people notice day to day.",
  },
  structure: {
    label: "Structural condition",
    short: "Structure",
    description:
      "Slow-changing condition that stays true across events and keeps producing similar outcomes.",
  },
  constraint: {
    label: "Constraint",
    short: "Constraint",
    description: "Limits which actions are possible at all.",
  },
  dependency: {
    label: "Dependency",
    short: "Dependency",
    description: "Something many outcomes rely on; a source of fragility.",
  },
  buffer: {
    label: "Buffer / redundancy",
    short: "Buffer",
    description: "Reserve or slack that absorbs shocks; a source of resilience.",
  },
  person_fit: {
    label: "Person fit",
    short: "Fit",
    description: "Values, preferences, physical feasibility, work style, risk tolerance.",
  },
  agency: {
    label: "Agency / readiness",
    short: "Agency",
    description: "Execution, persistence, willingness and readiness to change.",
  },
  shock: {
    label: "External shock",
    short: "Shock",
    description: "Event from outside the system that the system does not control.",
  },
  asset: {
    label: "Productive asset / capital",
    short: "Asset",
    description: "Career capital or productive assets that compound over time.",
  },
};

export const SOURCE_TYPE_META: Record<
  SourceType,
  { label: string; description: string; trust: 1 | 2 | 3 | 4 }
> = {
  measured: {
    label: "Measured",
    description: "Read from a record: bank statement, pay stub, contract.",
    trust: 4,
  },
  calculated: {
    label: "Calculated",
    description: "Recomputed from other variables by a named formula.",
    trust: 3,
  },
  self_reported: {
    label: "Self-reported",
    description: "Stated by the person about themselves or their household.",
    trust: 2,
  },
  observed: {
    label: "Observed",
    description: "Reported by someone else who observed it.",
    trust: 2,
  },
  estimated: {
    label: "Estimated",
    description: "A rough estimate by whoever built the model; not stated by the person.",
    trust: 1,
  },
  ai_inferred: {
    label: "AI-inferred",
    description: "Proposed by an AI from text and approved by the person.",
    trust: 1,
  },
  unknown: {
    label: "Unknown",
    description: "Provenance not recorded.",
    trust: 1,
  },
};

export const UTILITY_DIMENSION_META: Record<
  UtilityDimension,
  { label: string; higherIsBetter: boolean }
> = {
  financialImprovement: { label: "Financial improvement", higherIsBetter: true },
  stability: { label: "Stability", higherIsBetter: true },
  upside: { label: "Upside", higherIsBetter: true },
  physicalFit: { label: "Physical fit", higherIsBetter: true },
  personalityFit: { label: "Personality fit", higherIsBetter: true },
  valuesFit: { label: "Values fit", higherIsBetter: true },
  autonomy: { label: "Autonomy", higherIsBetter: true },
  scheduleFit: { label: "Schedule fit", higherIsBetter: true },
  stress: { label: "Stress", higherIsBetter: false },
  timeRequirement: { label: "Time requirement", higherIsBetter: false },
  risk: { label: "Risk", higherIsBetter: false },
  reversibility: { label: "Reversibility", higherIsBetter: true },
  careerCompounding: { label: "Career compounding", higherIsBetter: true },
  assetCompounding: { label: "Asset compounding", higherIsBetter: true },
};

export const UTILITY_DIMENSIONS = Object.keys(UTILITY_DIMENSION_META) as UtilityDimension[];

/** Wording helpers for confidence, so the UI never invents its own. */
export function confidenceLabel(c: number): string {
  if (c >= 0.85) return "high confidence";
  if (c >= 0.6) return "moderate confidence";
  if (c >= 0.35) return "low confidence";
  return "very low confidence";
}
