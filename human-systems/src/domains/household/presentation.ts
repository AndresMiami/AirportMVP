/**
 * Household presentation configuration for the generic screens: dashboard
 * headline keys and scenario presets. Exactly the keys and presets the
 * screens used to hard-code; configuration only, no behaviour.
 */
import type { DomainPresentation } from "@/model/domain";
import { DERIVED_IDS, INPUT_IDS, OTHER_KEYS } from "./keys";

export const HOUSEHOLD_PRESENTATION: DomainPresentation = {
  headlineKeys: [
    { key: DERIVED_IDS.floorRatio, scope: "system" },
    { key: DERIVED_IDS.bufferMonths, scope: "system" },
    { key: DERIVED_IDS.reliableFloor, scope: "system" },
    { key: DERIVED_IDS.monthlySurplus, scope: "system" },
    { key: DERIVED_IDS.incomeConcentration, scope: "system" },
    { key: DERIVED_IDS.failureCorrelation, scope: "system" },
    { key: OTHER_KEYS.financialPressure, scope: "system" },
    { key: INPUT_IDS.protectedHours, scope: "member" },
    { key: INPUT_IDS.careerCapital, scope: "member" },
    { key: INPUT_IDS.majorPaths, scope: "member" },
  ],
  scenarioPresets: [
    {
      name: "Reserves +$10,000",
      description: "A one-off addition to liquid reserves.",
      deltas: [{ key: INPUT_IDS.liquidReserves, scope: "system", delta: 10000 }],
    },
    {
      name: "Protected time +15 h/week",
      description: "More hours reliably reserved for compounding, for the chosen person.",
      deltas: [{ key: INPUT_IDS.protectedHours, scope: "member", delta: 15 }],
    },
    {
      name: "One path instead of three",
      description: "Major paths −2, switching frequency −1.5/yr, for the chosen person.",
      deltas: [
        { key: INPUT_IDS.majorPaths, scope: "member", delta: -2 },
        { key: INPUT_IDS.switchingFrequency, scope: "member", delta: -1.5 },
      ],
    },
  ],
};
