/**
 * Household domain: option-evaluation dimensions. These fourteen keys were
 * once universal; they are household/career vocabulary and live here now.
 * The engine knows only "a named dimension with a signed judgment".
 */
import type { CategoryDefinition, EvaluationDimension } from "@/model/domain";

export const HOUSEHOLD_EVALUATION_DIMENSIONS: EvaluationDimension[] = [
  { key: "financialImprovement", label: "Financial improvement", higherIsBetter: true },
  { key: "stability", label: "Stability", higherIsBetter: true },
  { key: "upside", label: "Upside", higherIsBetter: true },
  { key: "physicalFit", label: "Physical fit", higherIsBetter: true },
  { key: "personalityFit", label: "Personality fit", higherIsBetter: true },
  { key: "valuesFit", label: "Values fit", higherIsBetter: true },
  { key: "autonomy", label: "Autonomy", higherIsBetter: true },
  { key: "scheduleFit", label: "Schedule fit", higherIsBetter: true },
  { key: "stress", label: "Stress", higherIsBetter: false },
  { key: "timeRequirement", label: "Time requirement", higherIsBetter: false },
  { key: "risk", label: "Risk", higherIsBetter: false },
  { key: "reversibility", label: "Reversibility", higherIsBetter: true },
  { key: "careerCompounding", label: "Career compounding", higherIsBetter: true },
  { key: "assetCompounding", label: "Asset compounding", higherIsBetter: true },
];

/** Categories the household pack adds to the generic vocabulary. */
export const HOUSEHOLD_CATEGORIES: CategoryDefinition[] = [
  { id: "person_fit", label: "Person fit", description: "Values, preferences, physical feasibility, work style, risk tolerance." },
  { id: "agency", label: "Agency / readiness", description: "Execution, persistence, willingness and readiness to change." },
];
